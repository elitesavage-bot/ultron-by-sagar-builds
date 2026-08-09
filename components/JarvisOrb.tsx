"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import { VoiceEngine, type VoiceState } from "@/lib/voiceEngine";
import VoicePanel from "./VoicePanel";

type CameraState = "off" | "starting" | "on" | "error";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

// Number of waveform bars to sample from the audio analyser
const WAVEFORM_BARS = 28;

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const voiceRef = useRef<VoiceEngine | null>(null);

  // Hand tracking state
  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [handError, setHandError] = useState<string | null>(null);

  // Voice assistant state
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceReply, setVoiceReply] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [waveformData, setWaveformData] = useState<number[]>(
    Array(WAVEFORM_BARS).fill(0),
  );

  // Whether the V key is currently held (for hold-to-talk)
  const vHeldRef = useRef(false);

  // ── Init Three.js scene ──────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;

    // Init voice engine
    const engine = new VoiceEngine(scene, {
      onStateChange: setVoiceState,
      onTranscript: (text) => {
        setVoiceTranscript(text);
        setVoiceReply(""); // clear previous reply when new query arrives
        setVoiceError(null);
      },
      onReplyChunk: (chunk) => {
        setVoiceReply((prev) => prev + chunk);
      },
      onReplyDone: (full) => {
        setVoiceReply(full);
      },
      onError: (msg) => {
        setVoiceError(msg);
      },
    });
    voiceRef.current = engine;

    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      engine.dispose();
      voiceRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // ── Waveform animation driven by voice level ──
  // We poll the waveform by overriding setVoiceLevel via a wrapper in the engine
  // Instead, we sample a fake bar-graph from the voice state + a RAF loop
  useEffect(() => {
    if (voiceState !== "listening") {
      setWaveformData(Array(WAVEFORM_BARS).fill(0));
      return;
    }
    let rafId = 0;
    const tick = () => {
      // Generate synthetic waveform driven by time for visual fidelity
      // Real amplitude is fed to the orb via setVoiceLevel inside VoiceEngine
      const t = performance.now() / 1000;
      const bars = Array.from({ length: WAVEFORM_BARS }, (_, i) => {
        const base = Math.sin(t * 6 + i * 0.6) * 0.5 + 0.5;
        const detail = Math.sin(t * 14 + i * 1.2) * 0.2;
        return Math.max(0.05, Math.min(1, base * 0.6 + detail));
      });
      setWaveformData(bars);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [voiceState]);

  // ── Hold-to-talk handlers ────────────────────
  const handleMicDown = useCallback(() => {
    const engine = voiceRef.current;
    if (!engine) return;
    void engine.startListening();
  }, []);

  const handleMicUp = useCallback(() => {
    const engine = voiceRef.current;
    if (!engine) return;
    void engine.stopListening();
  }, []);

  // ── Hand gesture controls ────────────────────
  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setHandError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setHandError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  // ── Keyboard controls ────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore repeats (key held)
      if (e.repeat) return;

      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "v":
        case "V":
          if (!vHeldRef.current) {
            vHeldRef.current = true;
            handleMicDown();
          }
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "v" || e.key === "V") {
        if (vHeldRef.current) {
          vHeldRef.current = false;
          handleMicUp();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [toggleGestures, handleMicDown, handleMicUp]);

  const cameraOn = camera === "on";

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">U.L.T.R.O.N.</div>

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom
          </div>
        ) : (
          <div>
            <span className="key">G</span> hand gestures&nbsp;&nbsp;
            <span className="key">R</span> reset&nbsp;&nbsp;
            <span className="key">+/−</span> zoom&nbsp;&nbsp;
            <span className="key">V</span> voice
          </div>
        )}
      </div>

      {/* ── Voice Panel (left side) ── */}
      <div className="hud voice-hud">
        <VoicePanel
          state={voiceState}
          transcript={voiceTranscript}
          reply={voiceReply}
          error={voiceError}
          waveformData={waveformData}
          onMicDown={handleMicDown}
          onMicUp={handleMicUp}
        />
      </div>

      {/* ── Hand tracking controls (right side) ── */}
      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          {/* Mirrored preview so it behaves like a mirror */}
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
              : "SHOW HANDS"}
          </div>
        </div>

        {handError && <div className="hud-error">{handError}</div>}

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET
          </button>
        </div>
      </div>
    </>
  );
}
