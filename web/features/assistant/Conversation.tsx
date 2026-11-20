import { StopPlayback } from "./StopPlayback";

export function Conversation() {
  return (
    <section className="response-card" aria-labelledby="response-title">
      <div className="section-head">
        <h2 id="response-title">Conversation</h2>
        <button
          id="export-conversation"
          type="button"
          className="quiet"
          disabled
        >
          Export Word
        </button>
      </div>
      <p id="conversation-empty">
        Start talking to see your conversation here.
      </p>
      <ol
        id="conversation-log"
        tabIndex={0}
        aria-label="Conversation messages"
        aria-live="polite"
        aria-relevant="additions"
      ></ol>
      <div id="voice-message" role="status"></div>
      <p id="response-timing" hidden></p>
      <p id="export-status" role="status"></p>
      <div id="confirm-memory" hidden>
        <p id="confirmation-summary"></p>
        <div className="toolbar">
          <button type="button" className="primary" id="confirm-save">
            Confirm and save
          </button>
          <button type="button" className="quiet" id="confirm-cancel">
            Cancel
          </button>
        </div>
      </div>
      <div className="response-actions">
        <button className="quiet" id="replay">
          Read aloud
        </button>
        <StopPlayback />
      </div>
    </section>
  );
}
