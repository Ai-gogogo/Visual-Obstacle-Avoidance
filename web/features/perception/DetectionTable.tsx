export function DetectionTable() {
  return (
    <section className="detections" aria-labelledby="detections-title">
      <div className="section-head">
        <div>
          <h2 id="detections-title">Detected objects</h2>
          <p id="detection-note">
            Sample annotations · distances are illustrative.
          </p>
        </div>
        <span className="status" id="detection-count">
          4 objects
        </span>
      </div>
      <div
        className="table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Detected objects table"
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Camera</th>
              <th id="detection-measure" scope="col">
                Distance
              </th>
              <th scope="col">Position in frame</th>
              <th id="depth-heading" scope="col" hidden>
                Relative depth
              </th>
              <th id="metric-heading" scope="col" hidden>
                Forward depth (A)
              </th>
            </tr>
          </thead>
          <tbody id="detection-rows"></tbody>
        </table>
        <p className="empty" id="empty-detections" hidden>
          Waiting for camera detections.
        </p>
      </div>
    </section>
  );
}
