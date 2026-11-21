import { CameraFeeds } from "./CameraFeeds";
import { StereoRecordings } from "./StereoRecordings";
import { DetectionTable } from "./DetectionTable";

export function MonitorPanel() {
  return (
    <section id="monitor" data-page>
      <div className="page-head">
        <div>
          <h1 tabIndex={-1}>Live perception</h1>
          <p>Compare both camera feeds and depth aligned to Camera A.</p>
        </div>
        <div className="toolbar">
          <button className="quiet" id="warning-audio" type="button" aria-describedby="warning-audio-status">
            Enable warning audio
          </button>
          <button
            className="quiet"
            id="pixel-preview"
            type="button"
            aria-pressed="false"
            aria-controls="camera-feeds"
            hidden
          >
            Actual pixels
          </button>
          <button
            className="quiet"
            id="show-camera-b"
            type="button"
            aria-pressed="true"
            aria-controls="camera-b-feed"
          >
            Show Camera B
          </button>
          <button className="quiet" id="open-calibration">
            Stereo calibration
          </button>
          <button className="quiet" id="mode">
            Show live cameras
          </button>
          <button className="primary" id="pair">
            Pair a phone
          </button>
        </div>
      </div>
      <StereoRecordings />
      <CameraFeeds />
      <article className="feed" id="scene-view">
        <header><h2>Camera A segmentation</h2></header>
        <div id="scene-stage">
          <canvas id="scene-mask" width={128} height={128} role="img"
                  aria-label="Semantic classes in the sampled Camera A frame" hidden />
          <p id="scene-placeholder" className="no-feed">Waiting for Camera A segmentation.</p>
        </div>
        <ul id="scene-legend" aria-label="Most visible classes"></ul>
      </article>
      <DetectionTable />
    </section>
  );
}
