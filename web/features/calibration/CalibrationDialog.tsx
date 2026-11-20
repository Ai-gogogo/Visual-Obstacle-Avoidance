export function CalibrationDialog() {
  return (
    <dialog id="calibration-dialog" aria-labelledby="cal-title">
      <h2 id="cal-title" tabIndex={-1} data-initial-focus>
        Stereo calibration
      </h2>
      <p>
        Keep both cameras fixed. Hold the board still, then capture with the
        button or Space.
      </p>
      <div className="feed-grid">
        <div>
          Camera A<canvas aria-label="Camera A checkerboard"></canvas>
        </div>
        <div>
          Camera B<canvas aria-label="Camera B checkerboard"></canvas>
        </div>
      </div>
      <p id="cal-status" role="status"></p>
      <p id="cal-count"></p>
      <button className="primary" id="cal-save" disabled>
        Capture Stereo Pair
      </button>
      <button className="quiet" id="cal-close">
        Close
      </button>
    </dialog>
  );
}
