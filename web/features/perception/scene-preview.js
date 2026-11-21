export function createScenePreview($, getToken, signal, onScene) {
  const placeholder = $('#scene-placeholder');
  const canvas = $('#scene-mask');
  const stale = $('#scene-stale');
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
  let stream, expiry, labelRequest, advertisedId, rawFrame, publishedFrame;
  let loading = false, version = 0;

  function publish() {
    // The mask endpoint can advance between requests, including across a Camera A replacement.
    if (!rawFrame || rawFrame.id !== advertisedId || rawFrame === publishedFrame) return;
    publishedFrame = rawFrame;
    onScene?.(rawFrame);
  }

  function clear() {
    version++;
    clearTimeout(expiry);
    loading = false;
    stream = advertisedId = rawFrame = publishedFrame = undefined;
    canvas.hidden = true;
    placeholder.hidden = false;
    stale.hidden = true;
    legend.replaceChildren();
    delete canvas.dataset.frameId;
    onScene?.(null);
  }

  function paint(image, scene, labels) {
    ctx.drawImage(image,0,0);
    const pixels = ctx.getImageData(0,0,128,128);
    const counts = new Uint32Array(256);
    const rawLabels = onScene && new Uint8Array(128*128);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const id = pixels.data[i];
      counts[id]++;
      if (rawLabels) rawLabels[i/4] = id;
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
    return rawLabels;
  }

  signal.addEventListener('abort',clear,{once:true});

  async function update(id, cameraStream) {
    if (cameraStream && stream && cameraStream !== stream) clear();
    if (cameraStream) stream = cameraStream;
    const token = getToken();
    if (!token) { clear(); return; }
    advertisedId = id;
    publish();
    if (!id || canvas.dataset.frameId === id || loading) return;

    loading = true;
    const current = version;
    const started = performance.now();
    try {
      const headers = {Authorization:'Bearer '+token};
      const response = await fetch('/api/segmentation/A', {headers,
        signal:AbortSignal.any([signal,AbortSignal.timeout(1800)])});
      if (current !== version || response.status !== 200) return;
      const scene = await response.json();
      if (current !== version || canvas.dataset.frameId === scene.frame_id) return;
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
      clearTimeout(expiry);
      const expiresAt = Date.now() + Math.floor(remaining);
      const rawLabels = paint(image,scene,labels);
      stale.hidden = remaining > 0;
      const frame = rawFrame = {id:scene.frame_id, labels:rawLabels, width:128, height:128,
        timestamp:scene.timestamp_ms, expiresAt};
      if (remaining > 0) expiry = setTimeout(() => {
        stale.hidden = false;
        if (publishedFrame === frame) onScene?.({...frame, expiresAt:Date.now()});
      }, remaining);
      publish();
    } catch {
      // Keep the previous mask visible while a newer result is unavailable.
    } finally {
      if (current === version) loading = false;
    }
  }
  return {clear, update};
}
