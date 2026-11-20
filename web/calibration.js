(() => {
  const dialog = document.querySelector('#calibration-dialog');
  const mode = document.querySelector('#cal-mode');
  const status = document.querySelector('#cal-status');
  const canvases = [...dialog.querySelectorAll('canvas')];
  let timer, generation = 0;
  async function update(version) {
    clearTimeout(timer);
    try {
      const token = await getSession();
      const response = await fetch('/api/calibration/preview',{method:'POST',
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({mode:mode.value})});
      const data = await response.json();
      if (version !== generation) return;
      if (!response.ok) throw new Error(data.error || 'Calibration unavailable.');
      if (data.images) {
        const images = await Promise.all(data.images.map(async (pixels,i) => {
          const image = new Image();
          image.src = 'data:'+data.types[i]+';base64,'+pixels;
          await image.decode();
          return image;
        }));
        if (version !== generation) return;
        images.forEach((image,i) => {
          const canvas = canvases[i];
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(image,0,0);
          ctx.fillStyle = '#49ff78';
          for (const [x,y] of data.boards[i].corners) {
            ctx.beginPath(); ctx.arc(x,y,3,0,2*Math.PI); ctx.fill();
          }
        });
      } else canvases.forEach(c => c.getContext('2d').clearRect(0,0,c.width,c.height));
      status.textContent = data.message;
    } catch (error) {
      if (version !== generation) return;
      status.textContent = error.message;
    }
    if (version === generation) timer = setTimeout(() => update(version),650);
  }
  document.querySelector('#open-calibration').onclick = () => {
    dialog.showModal();
    status.textContent = 'Checking cameras…';
    update(++generation);
  };
  mode.onchange = () => {
    const three = mode.value === 'three';
    document.querySelector('#cal-target-tip').textContent = three
      ? 'Keep at least two coded faces visible to both cameras. Include front, right and top over the recording.'
      : 'Show the complete 10 × 7 checkerboard to both cameras.';
    document.querySelector('#cal-box-print').hidden = !three;
    document.querySelector('#video-status').textContent = '';
    status.textContent = 'Checking target…';
    canvases.forEach(c => c.getContext('2d').clearRect(0,0,c.width,c.height));
    update(++generation);
  };
  document.querySelector('#cal-close').onclick = () => dialog.close();
  dialog.addEventListener('close',() => {
    generation++;
    clearTimeout(timer);
    canvases.forEach(c => c.getContext('2d').clearRect(0,0,c.width,c.height));
  });
})();
