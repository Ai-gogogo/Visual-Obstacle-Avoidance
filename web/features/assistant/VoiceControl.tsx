"use client";

import { useVoicePresentation } from "./voice-presentation";

const icons: Record<string, string> = {
  Ready: "mic",
  Starting: "wait",
  "Wake word": "wave",
  Listening: "wave",
  Processing: "wait",
  Review: "wait",
  Reading: "stop",
  Speaking: "stop",
  Warning: "warning",
  Error: "warning",
};

export function VoiceControl() {
  const voice = useVoicePresentation();
  const state = voice.title.toLowerCase().replaceAll(" ", "-");
  return (
    <>
      <div className="voice-head">
        <h2 id="voice-title">Ask a question</h2>
        <span
          className="status"
          id="voice-state"
          data-active={state !== "ready" ? "" : undefined}
          data-state={state}
        >
          {voice.title}
        </span>
      </div>
      <div className="voice-core">
        <div className="rings">
          <button
            id="mic"
            className="mic"
            type="button"
            data-icon={icons[voice.title] ?? "mic"}
            data-state={state}
            aria-label={voice.label}
            aria-describedby="voice-help mic-error"
          >
            <svg
              className="voice-icon"
              data-icon="mic"
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <rect x="9" y="2" width="6" height="13" rx="3" />
              <path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-3 0h6" />
            </svg>
            <span
              className="voice-icon voice-wave"
              data-icon="wave"
              aria-hidden="true"
            >
              <span></span>
              <span></span>
              <span></span>
              <span></span>
              <span></span>
              <span></span>
              <span></span>
            </span>
            <svg
              className="voice-icon"
              data-icon="wait"
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
            <svg
              className="voice-icon"
              data-icon="stop"
              aria-hidden="true"
              viewBox="0 0 24 24"
            >
              <rect
                x="5"
                y="5"
                width="14"
                height="14"
                rx="2"
                fill="currentColor"
              />
            </svg>
            <svg
              className="voice-icon"
              data-icon="warning"
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M12 5v9m0 5h.01" />
            </svg>
          </button>
        </div>
        <p className="voice-prompt" id="voice-prompt" role="status">
          {voice.prompt}
        </p>
        <p id="mic-error" role="alert"></p>
        <p className="voice-help" id="voice-help">
          Pause after each question. The assistant replies and listens again.
          Tap to end the conversation.
        </p>
      </div>
    </>
  );
}
