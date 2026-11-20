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
      <article className="feed" id="stereo-view" hidden>
        <header>
          <h2>Stereo depth map</h2>
        </header>
        <div className="frame">
          <canvas
            id="stereo-map"
            className="live-frame"
            role="img"
            aria-label="Stereo depth aligned to Camera A"
            hidden
          ></canvas>
          <p id="stereo-caption" className="no-feed"></p>
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
