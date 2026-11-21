import {fuseDepth, paintFusedDepth, segmentationSync} from './depth-fusion.js';
import {depthPalettes} from './perception-view.js';

export function createFusedPreview($, signal) {
  const canvas = $('#fused-map');
  const placeholder = $('#fused-placeholder');
  const status = $('#fused-status');
  const palette = $('#fused-palette');
  const ctx = canvas.getContext('2d');
  let depth, scene, partner, timer, frame, computed;
  let replay = false;
  let sceneHistory = [];

  function repaintPalette() {
    if (signal.aborted || !computed || !frame) return;
    paintFusedDepth(computed.result, frame.data, depthPalettes[palette.value]);
    ctx.putImageData(frame, 0, 0);
  }

  function repaint() {
    clearTimeout(timer);
    if (signal.aborted) return;
    const now = Date.now();
    const sync = segmentationSync(depth, scene, now, sceneHistory);
    const reason = replay ? 'Saved depth selected · fusion requires live stereo depth.'
      : partner === null ? 'Camera B offline.' : sync.reason;
    const depthReady = !replay && depth && partner && partner === depth.partner && now < depth.expiresAt;
    const frozen = !replay && computed && (!depthReady || (computed.scene && !sync.scene));
    canvas.hidden = !(depthReady || frozen);
    placeholder.hidden = !canvas.hidden;
    if (frozen) {
      const label = computed.scene ? 'Holding last fused frame' : 'Holding last depth frame';
      const waiting = depthReady ? sync.reason.toLowerCase().replace(/\.$/, '') : 'waiting for depth';
      status.textContent = label + ' · ' + waiting;
      if (depthReady) timer = setTimeout(repaint, Math.max(0, depth.expiresAt - Date.now()));
      return;
    }
    if (!depthReady) {
      const message = reason ?? 'Waiting for matching stereo cameras.';
      placeholder.textContent = reason === 'Waiting for stereo depth.' && !scene
        ? 'Waiting for depth and segmentation.' : message;
      status.textContent = message;
      return;
    }

    const alignedScene = sync.scene ?? null;
    if (computed?.depth !== depth || computed.scene !== alignedScene) {
      computed = {depth, scene:alignedScene, result:fuseDepth(depth.gray, depth.width, depth.height, alignedScene)};
    }
    if (canvas.width !== depth.width || canvas.height !== depth.height) {
      canvas.width = depth.width;
      canvas.height = depth.height;
      frame = undefined;
    }
    frame ??= ctx.createImageData(depth.width, depth.height);
    repaintPalette();

    const {filledCount, labelFillCount} = computed.result;
    const gain = (100 * filledCount / depth.gray.length).toFixed(1);
    const lag = (Math.abs(sync.lag) / 1000).toFixed(1);
    const coverage = filledCount ? 'Filled +' + gain + '%' : depth.gray.includes(0) ? 'No eligible depth holes' : 'No depth holes';
    const labelCoverage = labelFillCount ? ' · Labels +' + labelFillCount : '';
    status.textContent = reason ?? coverage + labelCoverage +
      ' · Seg ' + (sync.lag < 0 ? 'lead ' : 'lag ') + lag + 's';
    const deadline = Math.min(depth.expiresAt, sync.deadline ?? Infinity);
    timer = setTimeout(repaint, Math.max(0, deadline - Date.now()));
  }

  function resetDepth() {
    depth = computed = undefined;
    repaint();
  }

  signal.addEventListener('abort', () => clearTimeout(timer), {once:true});
  return {
    repaintPalette,
    resetDepth,
    setDepth(value) {
      depth = replay ? null : value;
      repaint();
    },
    setScene(value) {
      if (!value) sceneHistory = [];
      else if (value.id !== scene?.id && value.expiresAt > Date.now()) {
        // Only cache previously confirmed masks, excluding expiry-only notifications.
        sceneHistory = [value, ...sceneHistory].slice(0, 12);
      }
      scene = value;
      repaint();
    },
    setPartner(value) {
      if (partner === value) return;
      if (partner && (!value || value !== depth?.partner)) depth = null;
      partner = value;
      repaint();
    },
    setReplay(value) {
      if (replay === value) return;
      replay = value;
      if (replay) resetDepth();
      else repaint();
    }
  };
}
