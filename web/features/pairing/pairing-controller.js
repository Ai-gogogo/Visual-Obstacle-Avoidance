export function connectPairing({$, root, scope, session, accessibility, isMonitor, onPaired}) {
  const {listen} = scope;
  let pairingVersion = 0;
  const dialog = $('#pair-dialog');
  const pairButtons = [...root.querySelectorAll('[data-pair]')];
  const copyCode = $('#copy-code');
  function openPairDialog(event) {
    $('#phone-address').hidden = true;
    $('#pair-result').textContent = '';
    $('#copy-status').textContent = '';
    copyCode.hidden = true;
    accessibility.openDialog(dialog,event);
  }
  listen($('#pair'), 'click',openPairDialog);
  listen($('#assist-pair'), 'click',openPairDialog);
  pairButtons.forEach(button => listen(button, 'click', async () => {
    const version = ++pairingVersion;
    const result = $('#pair-result');
    pairButtons.forEach(control => { control.disabled = true; });
    copyCode.hidden = true;
    $('#copy-status').textContent = '';
    result.textContent = 'Generating code…';
    $('#phone-address').hidden = true;
    try {
      if (location.protocol === 'file:') throw new Error('Start the local server before generating a pairing code.');
      const side = button.dataset.pair;
      let codeResponse;
      try { codeResponse = await session.api('/api/pair/'+side,'POST',await session.getSession()); }
      catch (error) {
        if (error.status !== 401) throw error;
        session.invalidate();
        codeResponse = await session.api('/api/pair/'+side,'POST',await session.getSession());
      }
      if (scope.signal.aborted || version !== pairingVersion || !dialog.open) return;
      const code = document.createElement('div');
      code.className = 'pair-code';
      code.textContent = codeResponse.code.replace(/^(...)/,'$1 ');
      result.replaceChildren('Camera '+side+' · expires in five minutes',code);
      const address = $('#phone-address');
      if (codeResponse.qrImage) {
        const qr = document.createElement('img');
        qr.className = 'pair-qr';
        qr.alt = 'Scan to pair Camera '+side;
        qr.src = codeResponse.qrImage;
        result.prepend(qr);
      }
      address.textContent = codeResponse.cameraUrl
        ? 'Manual entry: '+codeResponse.cameraUrl
        : 'Enter this code on the phone’s camera page. For QR pairing, configure the phone HTTPS address.';
      address.hidden = false;
      copyCode.dataset.code = codeResponse.code;
      copyCode.hidden = !navigator.clipboard?.writeText;
      if (isMonitor()) onPaired();
    } catch (error) {
      if (version === pairingVersion) result.textContent = accessibility.requestError(error,'Could not reach the pairing service.');
    } finally {
      pairButtons.forEach(control => { control.disabled = false; });
      if (version === pairingVersion && dialog.open) button.focus();
    }
  }));
  listen(copyCode, 'click', async () => {
    try {
      await navigator.clipboard.writeText(copyCode.dataset.code);
      $('#copy-status').textContent = 'Pairing code copied.';
    } catch {
      $('#copy-status').textContent = 'Could not copy. Enter the displayed code on the phone.';
    }
  });
  listen(dialog, 'close', () => {
    pairingVersion += 1;
    delete copyCode.dataset.code;
  });
}
