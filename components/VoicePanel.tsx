"use client";

import { useEffect, useRef } from "react";
import type { VoiceState } from "@/lib/voiceEngine";

interface VoicePanelProps {
  state: VoiceState;
  transcript: string;
  reply: string;
  error: string | null;
  waveformData: number[];
  onMicDown: () => void;
  onMicUp: () => void;
}

const STATE_LABELS: Record<VoiceState, string> = {
  idle: "STANDBY",
  listening: "LISTENING",
  thinking: "PROCESSING",
  speaking: "TRANSMITTING",
};

const STATE_CLASS: Record<VoiceState, string> = {
  idle: "voice-badge--idle",
  listening: "voice-badge--listening",
  thinking: "voice-badge--thinking",
  speaking: "voice-badge--speaking",
};

export default function VoicePanel({
  state,
  transcript,
  reply,
  error,
  waveformData,
  onMicDown,
  onMicUp,
}: VoicePanelProps) {
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);

  // Draw waveform bars on canvas
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    if (state !== "listening" || waveformData.length === 0) return;

    const barW = width / waveformData.length - 1;
    waveformData.forEach((val, i) => {
      const barH = Math.max(2, val * height);
      const x = i * (barW + 1);
      const y = (height - barH) / 2;
      // gradient: dim at low amplitude, bright amber at high
      const intensity = Math.round(150 + val * 105);
      ctx.fillStyle = `rgba(255, ${intensity}, 48, ${0.3 + val * 0.7})`;
      ctx.fillRect(x, y, barW, barH);
    });
  }, [waveformData, state]);

  const isActive = state !== "idle";

  return (
    <div className={`voice-panel${isActive ? " voice-panel--active" : ""}`}>
      {/* Header row */}
      <div className="voice-panel-header">
        <span className="voice-panel-title">A.I. COMM LINK</span>
        <span className={`voice-badge ${STATE_CLASS[state]}`}>
          {STATE_LABELS[state]}
        </span>
      </div>

      {/* Waveform — visible only while listening */}
      <div className={`voice-waveform-wrap${state === "listening" ? " visible" : ""}`}>
        <canvas ref={waveCanvasRef} className="voice-waveform-canvas" width={220} height={36} />
      </div>

      {/* Transcript (what user said) */}
      {transcript && (
        <div className="voice-bubble voice-bubble--user">
          <span className="voice-bubble-label">YOU ›</span>
          <span className="voice-bubble-text">{transcript}</span>
        </div>
      )}

      {/* Reply (what ULTRON says) */}
      {reply && (
        <div className="voice-bubble voice-bubble--ai">
          <span className="voice-bubble-label">ULTRON ›</span>
          <span className="voice-bubble-text">
            {reply}
            {state === "thinking" && <span className="voice-cursor">▌</span>}
          </span>
        </div>
      )}

      {/* Error line */}
      {error && <div className="voice-error">{error}</div>}

      {/* Hold-to-talk button */}
      <div className="voice-btn-row">
        <button
          type="button"
          className={`voice-mic-btn${state === "listening" ? " voice-mic-btn--recording" : ""}`}
          onMouseDown={onMicDown}
          onMouseUp={onMicUp}
          onTouchStart={(e) => { e.preventDefault(); onMicDown(); }}
          onTouchEnd={(e) => { e.preventDefault(); onMicUp(); }}
          disabled={state === "thinking" || state === "speaking"}
          aria-label="Hold to talk"
        >
          <svg
            className="voice-mic-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="2" width="6" height="11" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="19" x2="12" y2="22" />
            <line x1="8" y1="22" x2="16" y2="22" />
          </svg>
          <span className="voice-mic-label">
            {state === "listening"
              ? "RECORDING…"
              : state === "thinking"
              ? "PROCESSING…"
              : state === "speaking"
              ? "SPEAKING…"
              : "HOLD TO TALK"}
          </span>
        </button>
        <span className="voice-hotkey-hint">or hold V</span>
      </div>
    </div>
  );
}
