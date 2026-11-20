(() => {
  const dialog = document.querySelector('#calibration-dialog');
  const save = document.querySelector('#cal-save');
  const status = document.querySelector('#cal-status');
  const count = document.querySelector('#cal-count');
  const canvases = [...dialog.querySelectorAll('canvas')];
  let timer, generation = 0, pairID;
  async function update(action, version) {
    clearTimeout(timer);
    save.disabled = true;
    try {
      const token = await getSession();
      const response = await fetch('/api/calibration/'+action,{method:'POST',
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({id:pairID})});
      const data = await response.json();
      if (version !== generation) return;
      if (!response.ok) throw new Error(data.error || 'Calibration unavailable.');
      if (data.images) {
        const images = await Promise.all(data.images.map(async jpeg => {
          const image = new Image();
          image.src = 'data:image/jpeg;base64,'+jpeg;
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
      } else if (action === 'preview') canvases.forEach(c => c.getContext('2d').clearRect(0,0,c.width,c.height));
      status.textContent = data.message;
      count.textContent = 'Saved pairs: '+data.count;
      pairID = data.id;
      save.disabled = !pairID;
    } catch (error) {
      if (version !== generation) return;
      pairID = null;
      status.textContent = error.message;
    }
    if (version === generation) timer = setTimeout(() => update('preview',version),action === 'capture' ? 1100 : 650);
  }
  document.querySelector('#open-calibration').onclick = () => {
    dialog.showModal();
    status.textContent = 'Checking cameras…';
    update('preview',++generation);
  };
  save.onclick = () => update('capture',generation);
  dialog.addEventListener('keydown',event => {
    if (event.code === 'Space' && event.target.id !== 'cal-close') {
      event.preventDefault();
      if (!event.repeat && !save.disabled) save.click();
    }
  });
  document.querySelector('#cal-close').onclick = () => dialog.close();
  dialog.addEventListener('close',() => {
    generation++;
    clearTimeout(timer);
    save.disabled = true;
    pairID = null;
    canvases.forEach(c => c.getContext('2d').clearRect(0,0,c.width,c.height));
  });
})();
