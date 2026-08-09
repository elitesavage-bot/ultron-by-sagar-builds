import type { OrbSceneApi } from "./orbScene";
import type { ChatMessage } from "@/app/api/chat/route";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────
export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

export interface VoiceCallbacks {
  onStateChange(state: VoiceState): void;
  /** Raw transcript of what the user said */
  onTranscript(text: string): void;
  /** Called repeatedly as the LLM streams tokens */
  onReplyChunk(chunk: string): void;
  /** Called once the full reply is complete */
  onReplyDone(fullReply: string): void;
  onError(message: string): void;
}

// ACTION tags the LLM can embed in its reply
const ACTION_MAP: Record<string, (api: OrbSceneApi) => void> = {
  "ACTION:ZOOM_IN": (api) => api.zoomIn(),
  "ACTION:ZOOM_OUT": (api) => api.zoomOut(),
  "ACTION:RESET": (api) => api.resetView(),
  "ACTION:SPIN_LEFT": (api) => api.rotateBy(-1.2, 0),
  "ACTION:SPIN_RIGHT": (api) => api.rotateBy(1.2, 0),
};
const ACTION_PATTERN = /ACTION:[A-Z_]+/g;

// ──────────────────────────────────────────────
// VoiceEngine
// ──────────────────────────────────────────────
export class VoiceEngine {
  private sceneApi: OrbSceneApi;
  private callbacks: VoiceCallbacks;

  private mediaRecorder: MediaRecorder | null = null;
  private micStream: MediaStream | null = null;
  private audioChunks: Blob[] = [];

  // AudioContext for mic level visualisation
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuf: Uint8Array<ArrayBuffer> | null = null;
  private levelRafId = 0;

  // Conversation history sent to the LLM
  private history: ChatMessage[] = [];

  // Web Speech TTS
  private currentUtterance: SpeechSynthesisUtterance | null = null;

  // Abort signal for in-flight fetch
  private abortController: AbortController | null = null;

  private state: VoiceState = "idle";
  private disposed = false;

  constructor(sceneApi: OrbSceneApi, callbacks: VoiceCallbacks) {
    this.sceneApi = sceneApi;
    this.callbacks = callbacks;
  }

  // ── Public API ──────────────────────────────

  /** Call on keydown / button mousedown — starts recording */
  async startListening(): Promise<void> {
    if (this.state !== "idle") return;

    // Stop any ongoing TTS
    this.stopSpeaking();

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.callbacks.onError("MICROPHONE ACCESS DENIED");
      return;
    }

    // Set up AudioContext analyser for live waveform
    this.audioCtx = new AudioContext();
    const source = this.audioCtx.createMediaStreamSource(this.micStream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 64;
    this.analyserBuf = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    source.connect(this.analyser);
    this.startLevelLoop();

    // Start recording
    this.audioChunks = [];
    this.mediaRecorder = new MediaRecorder(this.micStream, {
      mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm",
    });
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.audioChunks.push(e.data);
    };
    this.mediaRecorder.start(100); // collect in 100ms chunks

    this.setState("listening");
  }

  /** Call on keyup / button mouseup — stops recording, triggers the pipeline */
  async stopListening(): Promise<void> {
    if (this.state !== "listening" || !this.mediaRecorder) return;

    // Stop mic stream
    this.stopLevelLoop();
    this.sceneApi.setVoiceLevel(0);

    await new Promise<void>((resolve) => {
      this.mediaRecorder!.onstop = () => resolve();
      this.mediaRecorder!.stop();
    });

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;

    if (this.disposed) return;

    const audioBlob = new Blob(this.audioChunks, { type: "audio/webm" });
    this.audioChunks = [];

    await this.runPipeline(audioBlob);
  }

  /** Cancel any in-flight transcription/chat/TTS */
  abort(): void {
    this.abortController?.abort();
    this.stopSpeaking();
    this.stopLevelLoop();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.sceneApi.setVoiceLevel(0);
    this.sceneApi.setTalking(false);
    this.setState("idle");
  }

  dispose(): void {
    this.disposed = true;
    this.abort();
    this.audioCtx?.close();
  }

  // ── Private: Pipeline ────────────────────────

  private async runPipeline(audioBlob: Blob): Promise<void> {
    if (this.disposed) return;

    // ── Step 1: Transcribe ──
    this.setState("thinking");
    this.sceneApi.setTalking(true);

    let transcript = "";
    try {
      transcript = await this.transcribe(audioBlob);
    } catch {
      this.callbacks.onError("TRANSCRIPTION FAILED");
      this.sceneApi.setTalking(false);
      this.setState("idle");
      return;
    }

    if (!transcript.trim()) {
      this.callbacks.onError("NO SPEECH DETECTED");
      this.sceneApi.setTalking(false);
      this.setState("idle");
      return;
    }

    this.callbacks.onTranscript(transcript);

    // ── Step 2: Send to LLM ──
    this.history.push({ role: "user", content: transcript });

    let fullReply = "";
    try {
      fullReply = await this.streamChat();
    } catch {
      this.callbacks.onError("NEURAL LINK FAILURE");
      this.sceneApi.setTalking(false);
      this.setState("idle");
      this.history.pop(); // remove the user message on failure
      return;
    }

    this.history.push({ role: "assistant", content: fullReply });

    // ── Step 3: Parse ACTION tags, strip them for TTS ──
    const actions = fullReply.match(ACTION_PATTERN) ?? [];
    const cleanReply = fullReply.replace(ACTION_PATTERN, "").trim();

    for (const action of actions) {
      const fn = ACTION_MAP[action];
      if (fn) fn(this.sceneApi);
    }

    this.callbacks.onReplyDone(cleanReply);

    // ── Step 4: TTS ──
    this.setState("speaking");
    await this.speak(cleanReply);

    this.sceneApi.setTalking(false);
    this.setState("idle");
  }

  private async transcribe(blob: Blob): Promise<string> {
    const form = new FormData();
    form.append("audio", blob, "recording.webm");

    this.abortController = new AbortController();
    const res = await fetch("/api/transcribe", {
      method: "POST",
      body: form,
      signal: this.abortController.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { text?: string; error?: string };
    if (data.error) throw new Error(data.error);
    return data.text ?? "";
  }

  private async streamChat(): Promise<string> {
    this.abortController = new AbortController();
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: this.history }),
      signal: this.abortController.signal,
    });

    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      full += chunk;
      // Only stream clean text to the UI (strip action tags)
      const cleanChunk = chunk.replace(ACTION_PATTERN, "");
      if (cleanChunk) this.callbacks.onReplyChunk(cleanChunk);
    }

    return full;
  }

  // ── Private: TTS ────────────────────────────

  private speak(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!text || typeof speechSynthesis === "undefined") {
        resolve();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      this.currentUtterance = utterance;

      // Choose a robotic-sounding voice — prefer "Google UK English Male"
      // or fall back to the first available voice
      const voices = speechSynthesis.getVoices();
      const preferred = voices.find((v) =>
        v.name.toLowerCase().includes("uk english male") ||
        v.name.toLowerCase().includes("microsoft david") ||
        v.name.toLowerCase().includes("english (uk)")
      );
      if (preferred) utterance.voice = preferred;

      // Robotic tuning
      utterance.pitch = 0.65;
      utterance.rate = 0.92;
      utterance.volume = 1.0;

      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();

      speechSynthesis.speak(utterance);
    });
  }

  private stopSpeaking() {
    if (typeof speechSynthesis !== "undefined") {
      speechSynthesis.cancel();
    }
    this.currentUtterance = null;
  }

  // ── Private: Audio Level Loop ─────────────

  private startLevelLoop() {
    const tick = () => {
      if (!this.analyser || !this.analyserBuf) return;
      this.analyser.getByteFrequencyData(this.analyserBuf);
      const avg =
        this.analyserBuf.reduce((s, v) => s + v, 0) / this.analyserBuf.length;
      const level = Math.min(1, avg / 128);
      this.sceneApi.setVoiceLevel(level);
      this.levelRafId = requestAnimationFrame(tick);
    };
    this.levelRafId = requestAnimationFrame(tick);
  }

  private stopLevelLoop() {
    cancelAnimationFrame(this.levelRafId);
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.analyser = null;
    this.analyserBuf = null;
  }

  // ── Helpers ──────────────────────────────────

  private setState(s: VoiceState) {
    this.state = s;
    this.callbacks.onStateChange(s);
  }
}
