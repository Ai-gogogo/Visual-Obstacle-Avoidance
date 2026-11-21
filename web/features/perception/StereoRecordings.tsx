export function StereoRecordings() {
  return (
    <section className="stereo-recordings" aria-labelledby="recordings-heading">
      <header>
        <h2 id="recordings-heading">Stereo recordings</h2>
        <button className="primary" id="record-toggle" type="button">Record A + B</button>
        <span id="record-progress" role="status" />
      </header>
      <details id="record-library">
        <summary>Saved recordings</summary>
        <p id="record-empty">No recordings yet.</p>
        <div id="record-actions" hidden>
          <label>Recording <select id="record-select" /></label>
          <button className="quiet" type="button" id="record-play">Play original A + B</button>
          <button className="quiet" type="button" id="record-export" hidden>Retry video export</button>
          <button className="quiet" type="button" id="record-compare">Generate depth comparison</button>
          <button className="quiet" type="button" id="record-play-depth" hidden>Play depth comparison</button>
        </div>
        <p id="record-detail" role="status" />
        <div id="record-player" hidden>
          <video id="record-video" controls playsInline preload="metadata" aria-label="Selected recording" />
          <div className="toolbar">
            <button className="quiet" type="button" id="record-prev" hidden>Previous frame</button>
            <button className="quiet" type="button" id="record-next" hidden>Next frame</button>
            <a id="record-download" download>Download MP4</a>
          </div>
        </div>
      </details>
    </section>
  );
}
