export function DesktopHeader() {
  return (
    <header className="shell masthead">
      <a className="wordmark" href="#monitor">
        <span className="mark" aria-hidden="true">
          ◉
        </span>
        <span>VisionAssist</span>
      </a>
      <nav aria-label="Desktop pages">
        <a href="#monitor" data-route="monitor" aria-current="page">
          Judge view
        </a>
        <a href="#assist" data-route="assist">
          Voice assistant
        </a>
      </nav>
      <div
        className="toolbar display-controls"
        aria-label="Display preferences"
        role="group"
      >
        <button
          type="button"
          className="quiet"
          id="contrast"
          aria-pressed="false"
        >
          High contrast
        </button>
        <button
          type="button"
          className="quiet"
          id="reduce-motion"
          aria-pressed="false"
        >
          Reduce motion
        </button>
      </div>
    </header>
  );
}
