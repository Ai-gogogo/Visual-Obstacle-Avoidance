export function QuickActions() {
  return (
    <section
      className="assist-details quick-actions"
      aria-labelledby="quick-actions-title"
    >
      <div className="voice-head">
        <h2 id="quick-actions-title">Quick actions</h2>
        <button type="button" className="quiet" id="assist-pair">
          Pair a camera
        </button>
      </div>
      <p id="camera-readiness" role="status">
        Checking camera connections…
      </p>
      <div className="toolbar">
        <button type="button" className="quiet" id="describe">
          Describe surroundings
        </button>
        <button type="button" className="quiet" id="read-camera-text">
          Help me identify the text.
        </button>
        <button type="button" className="quiet" data-question="find">
          Find my item
        </button>
        <button type="button" className="quiet" data-question="register">
          Register this item
        </button>
        <button type="button" className="quiet" data-question="remember">
          Remember a habit
        </button>
        <button type="button" className="quiet" id="recall-habits">
          Recall saved habits
        </button>
      </div>
    </section>
  );
}
