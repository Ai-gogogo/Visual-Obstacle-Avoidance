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
      <p>
        Open the camera site on the phone and enter the code for the camera
        slot you want.
      </p>
      <p id="phone-address" className="address"></p>
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
    </dialog>
  );
}
