export function PairDialog() {
  return (
    <dialog id="pair-dialog" aria-labelledby="pair-title">
      <form method="dialog">
        <button
          className="quiet dialog-close"
          aria-label="Close pairing dialog"
        >
          Close
        </button>
      </form>
      <h2 id="pair-title" tabIndex={-1} data-initial-focus>
        Pair a phone
      </h2>
      <section id="usb-controls" hidden aria-labelledby="usb-title">
        <h3 id="usb-title">USB cameras</h3>
        <p>Plug both iPhones into this Mac and open WiredCamera on each phone.</p>
        <div className="pair-options">
          <label>Camera A · left <select id="usb-A" /></label>
          <label>Camera B · right <select id="usb-B" /></label>
        </div>
        <label>Camera output · both phones
          <select id="usb-resolution" defaultValue="1080x1920">
            <option value="1080x1920">1080 × 1920 · full frame</option>
            <option value="480x640">480 × 640 · centered crop</option>
          </select>
        </label>
        <p id="usb-status" role="status" aria-live="polite"></p>
        <div className="pair-options">
          <button type="button" className="primary" id="usb-connect" disabled>Connect USB cameras</button>
          <button type="button" className="quiet" id="usb-refresh">Refresh devices</button>
          <button type="button" className="quiet" id="usb-disconnect" hidden>Disconnect USB</button>
        </div>
      </section>
      <details id="wifi-pairing">
      <summary>Wi-Fi pairing</summary>
      <p id="phone-address" className="address" hidden></p>
      <div className="pair-options">
        <button type="button" className="primary" data-pair="A">
          Code for Camera A
        </button>
        <button type="button" className="primary" data-pair="B">
          Code for Camera B
        </button>
      </div>
      <div id="pair-result" role="status"></div>
      <button type="button" className="quiet" id="copy-code" hidden>
        Copy pairing code
      </button>
      <p id="copy-status" role="status"></p>
      </details>
    </dialog>
  );
}
