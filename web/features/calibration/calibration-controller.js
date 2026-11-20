import { connectStereoVideo } from '../../stereo-video.js';

export function connectCalibration({$, scope, session, accessibility}) {
  const dialog = $('#calibration-dialog');
  const mode = $('#cal-mode');
  const status = $('#cal-status');
  const canvases = [...dialog.querySelectorAll('canvas')];
  let timer, preview;

  function clearPreview() {
    preview?.abort();
    scope.cancelDelay(timer);
    canvases.forEach(canvas => canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height));
  }

  async function update(signal) {
    try {
      const token = await session.getSession();
      const response = await fetch('/api/calibration/preview', {
        method:'POST', signal,
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({mode:mode.value}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Calibration unavailable.');
      const images = await Promise.all((data.images || []).map(async (bytes, i) => {
        const image = new Image();
        image.src = 'data:'+data.types[i]+';base64,'+bytes;
        await image.decode();
        return image;
      }));
      if (signal.aborted) return;
      canvases.forEach((canvas, i) => {
        const ctx = canvas.getContext('2d');
        if (!images[i]) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          return;
        }
        canvas.width = images[i].width;
        canvas.height = images[i].height;
        ctx.drawImage(images[i], 0, 0);
        ctx.fillStyle = '#49ff78';
        for (const [x, y] of data.boards[i].corners) {
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, 2*Math.PI);
          ctx.fill();
        }
      });
      status.textContent = data.message;
    } catch (error) {
      if (signal.aborted) return;
      status.textContent = error.message;
    }
    timer = scope.delay(() => update(signal), 650);
  }

  function startPreview(message) {
    clearPreview();
    status.textContent = message;
    preview = new AbortController();
    void update(AbortSignal.any([scope.signal, preview.signal]));
  }

  scope.listen($('#open-calibration'), 'click', event => {
    accessibility.openDialog(dialog, event);
    startPreview('Checking cameras…');
  });
  scope.listen(mode, 'change', () => {
    const three = mode.value === 'three';
    $('#cal-target-tip').textContent = three
      ? 'Keep at least two coded faces visible to both cameras. Include front, right and top over the recording.'
      : 'Show the complete 10 × 7 checkerboard to both cameras.';
    $('#cal-box-print').hidden = !three;
    $('#video-status').textContent = '';
    startPreview('Checking target…');
  });
  scope.listen($('#cal-close'), 'click', () => dialog.close());
  scope.listen(dialog, 'close', clearPreview);
  connectStereoVideo({$, scope, session});
}
