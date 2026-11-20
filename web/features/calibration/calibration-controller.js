export function connectCalibration({$, scope, session, accessibility}) {
  const {listen} = scope;
  const dialog = $('#calibration-dialog');
  const save = $('#cal-save');
  const status = $('#cal-status');
  const count = $('#cal-count');
  const canvases = [...dialog.querySelectorAll('canvas')];
  let timer, generation = 0, pairID;
  async function update(action, version) {
    scope.cancelDelay(timer);
    save.disabled = true;
    try {
      const token = await session.getSession();
      const response = await fetch('/api/calibration/'+action,{method:'POST',
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({id:pairID}),signal:scope.signal});
      const data = await response.json();
      if (scope.signal.aborted || version !== generation) return;
      if (!response.ok) throw new Error(data.error || 'Calibration unavailable.');
      if (data.images) {
        const images = await Promise.all(data.images.map(async (bytes,i) => {
          const image = new Image();
          const type = data.types?.[i] === 'image/png' ? 'image/png' : 'image/jpeg';
          image.src = 'data:'+type+';base64,'+bytes;
          await image.decode();
          return image;
        }));
        if (scope.signal.aborted || version !== generation) return;
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
      if (scope.signal.aborted || version !== generation) return;
      pairID = null;
      status.textContent = error.message;
    }
    if (version === generation) timer = scope.delay(() => update('preview',version),action === 'capture' ? 1100 : 650);
  }
  listen($('#open-calibration'), 'click', event => {
    accessibility.openDialog(dialog,event);
    status.textContent = 'Checking cameras…';
    update('preview',++generation);
  });
  listen(save,'click',() => update('capture',generation));
  listen(dialog, 'keydown',event => {
    if (event.code === 'Space' && !event.target.closest('button,input,select,a')) {
      event.preventDefault();
      if (!event.repeat && !save.disabled) save.click();
    }
  });
  listen($('#cal-close'),'click',() => dialog.close());
  listen(dialog, 'close',() => {
    generation++;
    scope.cancelDelay(timer);
    save.disabled = true;
    pairID = null;
    canvases.forEach(c => c.getContext('2d').clearRect(0,0,c.width,c.height));
  });
}
