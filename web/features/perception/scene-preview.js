export function createScenePreview($, getToken, signal) {
  const placeholder = $('#scene-placeholder');
  const canvas = $('#scene-mask');
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  const legend = $('#scene-legend');
  const palette = document.createElement('canvas');
  palette.width = 256;
  palette.height = 1;
  const swatches = palette.getContext('2d');
  swatches.fillStyle = '#28313a';
  swatches.fillRect(0,0,256,1);
  for (let id = 0; id < 150; id++) {
    swatches.fillStyle = 'hsl(' + (id * 137.508 % 360) + ' 65% 57%)';
    swatches.fillRect(id,0,1,1);
  }
  const colors = swatches.getImageData(0,0,256,1).data;
  let currentId, expiry, labelRequest, version = 0;

  function clear() {
    version++;
    clearTimeout(expiry);
    canvas.hidden = true;
    placeholder.hidden = false;
    legend.replaceChildren();
    delete canvas.dataset.frameId;
    currentId = null;
  }

  function paint(image, scene, labels) {
    ctx.drawImage(image,0,0);
    const pixels = ctx.getImageData(0,0,128,128);
    const counts = new Uint32Array(256);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const id = pixels.data[i];
      counts[id]++;
      pixels.data[i] = colors[id*4];
      pixels.data[i+1] = colors[id*4+1];
      pixels.data[i+2] = colors[id*4+2];
    }
    ctx.putImageData(pixels,0,0);
    canvas.dataset.frameId = scene.frame_id;
    canvas.style.aspectRatio = scene.width + ' / ' + scene.height;
    const present = Array.from(counts.keys()).filter(id => counts[id]);
    present.sort((a,b) => counts[b]-counts[a]);
    legend.replaceChildren(...present.slice(0,8).map(id => {
      const item = document.createElement('li');
      const dot = document.createElement('span');
      dot.style.backgroundColor = 'rgb(' + colors.slice(id*4,id*4+3).join(' ') + ')';
      item.append(dot, labels[id] ?? 'Uncertain');
      return item;
    }));
    canvas.hidden = false;
    placeholder.hidden = true;
  }

  signal.addEventListener('abort',clear,{once:true});

  async function update(id) {
    if (currentId === id) return;
    const token = getToken();
    if (!id || !token) { clear(); return; }
    currentId = id;
    const current = ++version;
    const started = performance.now();
    try {
      const headers = {Authorization:'Bearer '+token};
      const response = await fetch('/api/segmentation/A', {headers,
        signal:AbortSignal.any([signal,AbortSignal.timeout(1800)])});
      if (current !== version) return;
      if (response.status !== 200) { clear(); return; }
      const scene = await response.json();
      const image = new Image();
      image.src = 'data:image/png;base64,' + scene.mask;
      labelRequest ??= fetch('/ade20k-labels.json', {signal:AbortSignal.any([signal,AbortSignal.timeout(1800)])})
        .then(response => {
          if (!response.ok) throw new Error('Could not load segmentation labels.');
          return response.json();
        }).catch(error => {
          labelRequest = undefined;
          throw error;
        });
      const [, labels] = await Promise.all([image.decode(), labelRequest]);
      if (current !== version) return;
      const remaining = scene.remaining_ms - (performance.now() - started);
      if (remaining <= 0) { clear(); return; }
      clearTimeout(expiry);
      currentId = scene.frame_id;
      paint(image,scene,labels);
      expiry = setTimeout(() => {
        if (current === version) clear();
      },remaining);
    } catch {
      if (current === version) clear();
    }
  }
  return {clear, update};
}
