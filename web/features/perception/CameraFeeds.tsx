export function CameraFeeds() {
  return (
    <div className="feed-grid" id="camera-feeds">
      <article className="feed" data-camera="A">
        <header>
          <div>
            <span className="camera-icon" aria-hidden="true">
              A
            </span>
            <h2>Camera A</h2>
          </div>
          <span className="status feed-status">Sample feed</span>
        </header>
        <div
          className="frame camera-frame"
          role="region"
          aria-label="Camera A image"
        >
          <div
            className="sample-image sample-a"
            role="img"
            aria-label="Sample lab view with a chair and a desk"
          ></div>
          <canvas
            className="live-frame"
            role="img"
            aria-label="Live camera A preview with YOLO detections"
            hidden
          ></canvas>
          <p className="no-feed" hidden>
            Waiting for Camera A
          </p>
          <div className="overlays" aria-hidden="true"></div>
        </div>
        <footer>
          <span className="frame-size" hidden></span>
          <span className="feed-summary">2 sample detections</span>
        </footer>
      </article>
      <article className="feed" data-camera="B">
        <header>
          <div>
            <span className="camera-icon" aria-hidden="true">
              B
            </span>
            <h2>Camera B</h2>
          </div>
          <span className="status feed-status">Sample feed</span>
        </header>
        <div
          className="frame camera-frame"
          role="region"
          aria-label="Camera B image"
        >
          <div
            className="sample-image sample-b"
            role="img"
            aria-label="Sample lab view with a backpack and water bottle"
          ></div>
          <canvas
            className="live-frame"
            role="img"
            aria-label="Live camera B preview"
            hidden
          ></canvas>
          <p className="no-feed" hidden>
            Waiting for Camera B
          </p>
          <div className="overlays" aria-hidden="true"></div>
        </div>
        <footer>
          <span className="frame-size" hidden></span>
          <span className="feed-summary">2 sample detections</span>
        </footer>
      </article>
      <article className="feed" id="stereo-view" hidden>
        <header>
          <h2>Stereo depth map</h2>
          <label>
            Palette{" "}
            <select id="depth-palette" defaultValue="turbo">
              <option value="turbo">Turbo</option>
              <option value="gray">Grayscale</option>
              <option value="viridis">Viridis</option>
            </select>
          </label>
        </header>
        <div className="frame">
          <canvas
            id="stereo-map"
            className="live-frame"
            role="img"
            aria-label="Stereo depth aligned to Camera A"
            hidden
          ></canvas>
          <span id="depth-reticle" aria-hidden="true" hidden></span>
          <p id="stereo-caption" className="no-feed"></p>
        </div>
        <div className="depth-controls">
          <label><input type="checkbox" id="depth-spatial" /> Edge-aware filter (WLS)</label>
          <label><input type="checkbox" id="depth-temporal" /> Temporal median</label>
          <label><input type="checkbox" id="depth-meters" /> Show meters</label>
          <label id="depth-length-label" hidden>
            Width of 5 printed squares (mm)
            <input type="number" id="depth-five-mm" min="0" step="any" inputMode="decimal" />
          </label>
          <span id="depth-reading" role="status"></span>
        </div>
        <footer>
          <span className="frame-size" id="depth-preview-size" hidden></span>
          <span className="frame-size" id="depth-coverage" hidden></span>
          <span id="depth-scale"></span>
        </footer>
      </article>
    </div>
  );
}
