import {connectUsbControls} from './usb-controls.js';
export function connectPairing({$, root, scope, session, accessibility, isMonitor, onPaired}) {
  const {listen} = scope;
  let pairingVersion = 0;
  const dialog = $('#pair-dialog');
  const pairButtons = [...root.querySelectorAll('[data-pair]')];
  const copyCode = $('#copy-code');
  const usb = connectUsbControls({$, scope, session, dialog, onPaired});
  function openPairDialog(event) {
    if (dialog.open) return;
    $('#phone-address').hidden = true;
    $('#pair-result').textContent = '';
    $('#copy-status').textContent = '';
    copyCode.hidden = true;
    accessibility.openDialog(dialog,event);
    usb();
  }
  listen($('#pair'), 'click',openPairDialog);
  listen($('#assist-pair'), 'click',openPairDialog);
  async function generateCode(button) {
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
      return codeResponse.code;
    } catch (error) {
      if (version === pairingVersion) result.textContent = accessibility.requestError(error,'Could not reach the pairing service.');
    } finally {
      pairButtons.forEach(control => { control.disabled = false; });
      if (version === pairingVersion && dialog.open) button.focus();
    }
  }
  pairButtons.forEach(button => listen(button, 'click', () => generateCode(button)));
  async function copyPairCode() {
    if (!copyCode.dataset.code || !navigator.clipboard) return false;
    try {
      await navigator.clipboard.writeText(copyCode.dataset.code);
      $('#copy-status').textContent = 'Pairing code copied.';
      return true;
    } catch {
      $('#copy-status').textContent = 'Could not copy. Enter the displayed code on the phone.';
      return false;
    }
  }
  listen(copyCode, 'click',copyPairCode);
  listen(dialog, 'close', () => {
    pairingVersion += 1;
    delete copyCode.dataset.code;
  });
  return {
    open:openPairDialog,
    close() { dialog.close(); },
    copy:copyPairCode,
    currentCode() { return copyCode.dataset.code; },
    async generate(side) {
      openPairDialog();
      const button = pairButtons.find(candidate => candidate.dataset.pair === side);
      return button && generateCode(button);
    },
    async usb(command) {
      openPairDialog();
      if (!usb.update || $('#usb-controls').hidden) return false;
      $('#usb-controls').open = true;
      if (command.kind === 'usbSlot') {
        await usb.update();
        const select = $('#usb-'+command.side);
        if (!select.options[command.value]?.value) return false;
        select.selectedIndex = command.value;
        select.dispatchEvent(new Event('change'));
        return true;
      }
      if (/^(1080|480)$/.test(command.value)) {
        const field = $('#usb-resolution');
        field.value = command.value === '1080' ? '1080x1920' : '480x640';
        field.dispatchEvent(new Event('change'));
        return true;
      }
      if (command.value === 'connect' && $('#usb-connect').disabled) {
        await usb.update();
        if ($('#usb-connect').disabled) return $('#usb-status').textContent || false;
      }
      await usb.update(command.value === 'connect' ? 'POST' : command.value === 'disconnect' ? 'DELETE' : 'GET');
      if (command.value === 'refresh') {
        const devices = Array.from($('#usb-A').options).filter(option => option.value).map((option,index) => (index+1)+'. '+option.text);
        if (devices.length) return devices.join('，');
      }
      return $('#usb-status').textContent;
    }
  };
}
