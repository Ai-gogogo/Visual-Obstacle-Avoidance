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
          <video className="live-frame rtc-preview" aria-label="Live video from Camera A" autoPlay muted playsInline hidden />
          <span className="analysis-frame-label" hidden>Matched analysis frame</span>
          <p className="no-feed" hidden>
            Waiting for Camera A
          </p>
          <div className="overlays" aria-hidden="true"></div>
        </div>
        <footer>
          <span className="frame-size" hidden></span>
          <span className="feed-summary">2 sample detections</span>
          <button className="quiet rtc-toggle" type="button" aria-pressed="false" hidden>Live video</button>
          <span className="rtc-status" role="status"></span>
        </footer>
      </article>
      <article className="feed" id="stereo-view">
        <header>
          <h2>Stereo depth map</h2>
        </header>
        <div id="saved-depth" hidden>
          <video id="saved-depth-video" controls playsInline style={{width:"100%",maxHeight:"55vh"}} />
          <p id="saved-depth-status" role="status"></p>
        </div>
        <div className="frame" id="live-depth-frame">
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
        <label className="depth-source-control">Depth source
          <select id="depth-source" defaultValue="live">
            <option value="live">Live · current calibration</option>
            <option value="low">Live · 480 × 640 crop</option>
            <option value="d8be72ae">Saved · cup and table · 480 × 640</option>
            <option value="4317d705">Saved · checkerboard 4317d705 · 480 × 640</option>
            <option value="36ad570e">Saved · checkerboard 36ad570e · 480 × 640</option>
          </select>
        </label>
        <div id="live-depth-controls">
        <header>
          <label>Depth algorithm{" "}
            <select id="depth-algorithm" defaultValue="sgbm">
              <option value="sgbm">StereoSGBM</option>
              <option value="raft">RAFT-Stereo</option>
            </select>
          </label>
          <label>
            Palette{" "}
            <select id="depth-palette" defaultValue="turbo">
              <option value="turbo">Turbo</option>
              <option value="gray">Grayscale</option>
              <option value="viridis">Viridis</option>
            </select>
          </label>
        </header>
        <p id="depth-hold-status" role="status" hidden></p>
        <div className="depth-controls">
          <label><input type="checkbox" id="depth-spatial" /> Edge-aware filter (WLS)</label>
          <label><input type="checkbox" id="depth-temporal" /> Temporal median</label>
          <label><input type="checkbox" id="depth-meters" /> Show meters</label>
          <label><input type="checkbox" id="depth-plane-overlay" /> Show plane overlay</label>
          <span id="depth-reading" role="status"></span>
        </div>
        <footer>
          <span className="frame-size" id="depth-preview-size" hidden></span>
          <span className="frame-size" id="depth-coverage" hidden></span>
          <span className="frame-size" id="plane-status" role="status" hidden></span>
          <p className="frame-size" id="protrusion-status" role="status" hidden></p>
          <span id="depth-scale"></span>
        </footer>
        </div>
      </article>
      <article className="feed" id="scene-view">
        <header><h2>Camera A segmentation</h2></header>
        <div className="frame" id="scene-stage">
          <canvas id="scene-mask" width={128} height={128} role="img"
                  aria-label="Semantic classes in the sampled Camera A frame" hidden />
          <p id="scene-placeholder" className="no-feed">Waiting for Camera A segmentation.</p>
          <span id="scene-stale" className="analysis-frame-label" role="status" hidden>
            Last result · waiting for update
          </span>
        </div>
        <ul id="scene-legend" aria-label="Most visible classes"></ul>
      </article>
      <article className="feed" id="camera-b-feed" data-camera="B">
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
          <video className="live-frame rtc-preview" aria-label="Live video from Camera B" autoPlay muted playsInline hidden />
          <p className="no-feed" hidden>
            Waiting for Camera B
          </p>
          <div className="overlays" aria-hidden="true"></div>
        </div>
        <footer>
          <span className="frame-size" hidden></span>
          <span className="feed-summary">2 sample detections</span>
          <button className="quiet rtc-toggle" type="button" aria-pressed="false" hidden>Live video</button>
          <span className="rtc-status" role="status"></span>
        </footer>
      </article>
    </div>
  );
}
