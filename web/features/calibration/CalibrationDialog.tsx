export function CalibrationDialog() {
  return (
    <dialog id="calibration-dialog" aria-labelledby="cal-title">
      <h2 id="cal-title" tabIndex={-1} data-initial-focus>Stereo calibration</h2>
      <label htmlFor="cal-mode">Calibration target</label>
      <select id="cal-mode">
        <option value="single">Single face · ordinary checkerboard</option>
        <option value="three">Three faces · coded box</option>
      </select>
      <p id="cal-target-tip">Show the complete 10 × 7 checkerboard to both cameras.</p>
      <p id="cal-box-print" hidden>
        <a href="/box-targets.pdf" target="_blank" rel="noopener">Print the three coded faces (PDF)</a>
      </p>
      <p>Keep both cameras fixed. During recording, hold each board pose steady for about two seconds.</p>
      <div className="feed-grid">
        <div>Camera A<canvas aria-label="Camera A checkerboard" /></div>
        <div>Camera B<canvas aria-label="Camera B checkerboard" /></div>
      </div>
      <p id="cal-status" role="status" />
      <button className="primary" id="cal-record">Record Stereo Video</button>
      <button className="primary" id="cal-upload" hidden>Upload Recording</button>
      <a id="cal-download" download hidden>Download full WebM</a>
      <button className="quiet" id="cal-discard" hidden>Discard &amp; Retake</button>
      <div id="cal-saved" hidden>
        <label htmlFor="cal-takes">Saved recordings in this session</label>
        <select id="cal-takes" />
        <button className="quiet" id="cal-delete">Delete selected recording</button>
      </div>
      <p id="video-quality" hidden />
      <p id="video-status" role="status" />
      <button className="quiet" id="cal-close">Close</button>
    </dialog>
  );
}
