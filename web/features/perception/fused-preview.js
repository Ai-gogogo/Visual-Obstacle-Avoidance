import {fuseDepth, paintFusedDepth, sceneDeadline, segmentationSync} from './depth-fusion.js';
import {depthPalettes} from './perception-view.js';

export function createFusedPreview($, signal) {
  const canvas = $('#fused-map');
  const placeholder = $('#fused-placeholder');
  const status = $('#fused-status');
  const ctx = canvas.getContext('2d');
  let depth, scene, partner, timer, frame, computed;
  let replay = false;

  function repaint() {
    clearTimeout(timer);
    if (signal.aborted) return;
    const now = Date.now();
    const sync = segmentationSync(depth, scene, now);
    const reason = replay ? 'Saved depth selected · fusion requires live stereo depth.'
      : partner === null ? 'Camera B offline.' : sync.reason;
    const depthReady = !replay && depth && partner && partner === depth.partner && now < depth.expiresAt;
    canvas.hidden = !depthReady;
    placeholder.hidden = Boolean(depthReady);
    if (!depthReady) {
      const message = reason ?? 'Waiting for matching stereo cameras.';
      placeholder.textContent = reason === 'Waiting for stereo depth.' && !scene
        ? 'Waiting for depth and segmentation.' : message;
      status.textContent = message;
      return;
    }

    const alignedScene = sync.reason ? null : scene;
    if (computed?.depth !== depth || computed.scene !== alignedScene) {
      computed = {depth, scene:alignedScene, result:fuseDepth(depth.gray, depth.width, depth.height, alignedScene)};
    }
    if (canvas.width !== depth.width || canvas.height !== depth.height) {
      canvas.width = depth.width;
      canvas.height = depth.height;
      frame = undefined;
    }
    frame ??= ctx.createImageData(depth.width, depth.height);
    paintFusedDepth(computed.result, frame.data, depthPalettes[$('#depth-palette').value]);
    ctx.putImageData(frame, 0, 0);

    const filled = computed.result.filledCount;
    const gain = (100 * filled / depth.gray.length).toFixed(1);
    const lag = (Math.abs(sync.lag) / 1000).toFixed(1);
    const coverage = filled ? 'Filled +' + gain + '%' : depth.gray.includes(0) ? 'No eligible regions' : 'No depth holes';
    status.textContent = reason ?? coverage +
      ' · Seg ' + (sync.lag < 0 ? 'lead ' : 'lag ') + lag + 's';
    const deadline = alignedScene ? Math.min(depth.expiresAt, sceneDeadline(scene)) : depth.expiresAt;
    timer = setTimeout(repaint, Math.max(0, deadline - Date.now()));
  }

  signal.addEventListener('abort', () => clearTimeout(timer), {once:true});
  return {
    repaint,
    setDepth(value) {
      depth = replay ? null : value;
      repaint();
    },
    setScene(value) {
      scene = value;
      repaint();
    },
    setPartner(value) {
      if (partner === value) return;
      if (partner && value !== depth?.partner) depth = null;
      partner = value;
      repaint();
    },
    setReplay(value) {
      replay = value;
      depth = null;
      repaint();
    }
  };
}
