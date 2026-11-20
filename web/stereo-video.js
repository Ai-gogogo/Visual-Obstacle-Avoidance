// Encode clean A/B pixels side by side. Checkerboard overlays are display-only.
(() => {
  const record = document.querySelector('#cal-record');
  const upload = document.querySelector('#cal-upload');
  const status = document.querySelector('#video-status');
  const dialog = document.querySelector('#calibration-dialog');
  const mode = document.querySelector('#cal-mode');
  const quality = document.querySelector('#video-quality');
  const discard = document.querySelector('#cal-discard');
  const download = document.querySelector('#cal-download');
  const maxUploadBytes = 64 * 1024 * 1024;
  // Leave room for the final chunk when stopping the encoder.
  const stopAtBytes = 60 * 1024 * 1024;
  const saved = document.querySelector('#cal-saved');
  const takes = document.querySelector('#cal-takes');
  const remove = document.querySelector('#cal-delete');
  let active, clip, displayedRun, listVersion = 0;

  async function refreshSaved() {
    const version = ++listVersion;
    const target = mode.value;
    saved.hidden = true;
    if (active || clip || (record.disabled && !remove.disabled)) return;
    try {
      const response = await fetch('/api/calibration/video',{headers:{
        Authorization:'Bearer '+await getSession(),'X-Calibration-Mode':target}});
      if (response.status === 405) return; // Older running servers support upload only.
      if (!response.ok) throw new Error('Could not load saved recordings.');
      const {recordings} = await response.json();
      if (version !== listVersion) return;
      takes.replaceChildren(...recordings.map(({name,savedAt}) =>
        new Option(new Date(savedAt).toLocaleString()+' · '+name.slice(0,8),name)));
      saved.hidden = !recordings.length;
      if (!active && !record.disabled)
        record.textContent = recordings.length ? 'Record Again' : 'Record Stereo Video';
    } catch (error) {
      if (version === listVersion && !active && !clip) status.textContent = error.message;
    }
  }
  document.querySelector('#open-calibration').addEventListener('click',refreshSaved);
  mode.addEventListener('change',refreshSaved);

  remove.onclick = async () => {
    const name = takes.value;
    const selected = takes.selectedOptions[0];
    if (!name || remove.disabled || !confirm('Delete the saved recording '+selected.text+' from this computer?')) return;
    remove.disabled = record.disabled = mode.disabled = takes.disabled = true;
    try {
      const response = await fetch('/api/calibration/video',{method:'DELETE',headers:{
        Authorization:'Bearer '+await getSession(),'X-Calibration-Mode':mode.value,'Content-Type':'application/json'},
        body:JSON.stringify({name})});
      if (!response.ok) throw new Error((await response.json()).error || 'Could not delete recording.');
      status.textContent = 'Recording deleted.';
      await refreshSaved();
    } catch (error) { status.textContent = error.message; }
    finally {
      remove.disabled = record.disabled = mode.disabled = takes.disabled = false;
      record.textContent = saved.hidden ? 'Record Stereo Video' : 'Record Again';
    }
  };
  discard.onclick = () => {
    if (!clip || upload.disabled || !confirm('Discard this unsaved recording and prepare for a retake?')) return;
    if (clip.url) {
      URL.revokeObjectURL(clip.url);
      download.removeAttribute('href');
      download.hidden = true;
    }
    clip = displayedRun = null;
    quality.hidden = discard.hidden = upload.hidden = true;
    mode.disabled = record.disabled = false;
    record.textContent = 'Record Again';
    status.textContent = 'Ready to retake. Start when the board is in position.';
    void refreshSaved();
  };

  function showCounts(run) {
    if (displayedRun !== run) return;
    const counts = run.counts;
    const pending = run.frames - counts.checked - run.unchecked;
    let message = 'Valid pairs: '+counts.valid+' / '+counts.checked+' checked (goal: 60 valid) · Distinct steady poses: '+counts.poses.length+' / 20';
    if (run.mode === 'three') message += ' · Faces: '+counts.faces.size+' / 3';
    if (pending) message += ' · Checking: '+pending;
    if (run.unchecked) message += ' · Unchecked: '+run.unchecked;
    if (run.checkError) message += ' · '+run.checkError;
    if (counts.ready) message += ' · Suggested target reached. You can stop.';
    quality.textContent = message;
  }

  async function checkFrames(run) {
    if (run.checking) return;
    run.checking = true;
    try {
      while (run.queue.length) {
        const batch = run.queue.splice(0,run.original ? 1 : 4);
        try {
          const response = await fetch('/api/calibration/video-check',{method:'POST',
            headers:{Authorization:'Bearer '+run.token,'Content-Type':'application/json','X-Frame-Format':run.original ? 'png' : 'jpeg'},
            body:JSON.stringify({mode:run.mode,pairs:batch.map(frame => frame.images)}),
            signal:AbortSignal.timeout(run.original ? 20000 : 10000)});
          if (!response.ok) throw new Error('Detector unavailable');
          const {poses} = await response.json();
          if (poses.length !== batch.length) throw new Error('Incomplete detection');
          poses.forEach((pose,i) => run.counts.observe(pose,batch[i].number,batch[i].ms,run.original ? 2200 : 1000));
          run.checkError = '';
        } catch {
          run.unchecked += batch.length;
          run.checkError = 'Detection unavailable for some pairs.';
        }
        showCounts(run);
      }
    } finally { run.checking = false; }
  }

  mode.addEventListener('change',() => {
    displayedRun = null;
    quality.hidden = true;
  });
  function stop(reason) {
    if (!active) return;
    const run = active;
    active = null;
    run.controller.abort();
    clearTimeout(run.timer);
    if (run.recorder?.state === 'recording') {
      record.disabled = true;
      run.reason = reason;
      run.recorder.stop();
    } else {
      record.textContent = 'Record Stereo Video';
      status.textContent = reason;
      mode.disabled = false;
      void refreshSaved();
    }
  }

  async function sample(run) {
    try {
      const response = await fetch('/api/calibration/video-frame',{headers:{
        Authorization:'Bearer '+run.token,'If-None-Match':run.etag || ''},signal:run.controller.signal});
      if (active !== run) return;
      const camerasOffline = response.status === 409;
      if (!response.ok && !camerasOffline) throw new Error((await response.json()).error);
      if (response.status === 200) {
        const pair = await response.json();
        if (run.rig && pair.rig !== run.rig) throw new Error('Camera pairing changed.');
        run.etag = response.headers.get('ETag');
        if (!run.seenPartners.has(pair.partner)) {
          if (pair.types[0] !== pair.types[1]) throw new Error('Choose the same upload quality on both phones.');
          run.original = pair.types[0] === 'image/png';
          const images = await Promise.all(pair.images.map(async (pixels,i) => {
            const image = new Image();
            image.src = 'data:'+pair.types[i]+';base64,'+pixels;
            await image.decode();
            return image;
          }));
          if (active !== run) return;
          const [left,right] = images;
          if (left.width !== right.width || left.height !== right.height)
            throw new Error('Match camera orientations and resolutions.');
          if (!run.recorder) {
            run.canvas.width = left.width*2;
            run.canvas.height = left.height;
            const stream = run.canvas.captureStream(12);
            try {
              run.recorder = new MediaRecorder(stream,{mimeType:'video/webm',videoBitsPerSecond:4000000});
            } catch (error) { stream.getTracks().forEach(t=>t.stop()); throw error; }
            const chunks = [];
            let encodedBytes = 0;
            run.recorder.ondataavailable = ({data}) => {
              if (!data.size) return;
              chunks.push(data);
              encodedBytes += data.size;
              if (active === run && encodedBytes >= stopAtBytes)
                stop('This clip has reached the upload size threshold.');
            };
            run.recorder.onstop = () => {
              stream.getTracks().forEach(t=>t.stop());
              const blob = new Blob(chunks,{type:'video/webm'});
              clip = blob.size ? {blob,mode:run.mode} : null;
              mode.disabled = Boolean(clip);
              record.textContent = 'Record Stereo Video';
              discard.hidden = upload.hidden = !clip;
              record.disabled = Boolean(clip);
              let nextStep = clip ? 'Ready to upload.' : 'No video captured.';
              if (blob.size > maxUploadBytes) {
                // Browsers can deliver a delayed, oversized final chunk. Keep the full video.
                clip.url = URL.createObjectURL(blob);
                download.href = clip.url;
                download.download = 'stereo-'+run.mode+'-'+run.start+'.webm';
                download.hidden = false;
                upload.hidden = true;
                nextStep = 'This clip exceeds the upload limit. Download the full WebM before retaking.';
              }
              if (!clip) void refreshSaved();
              status.textContent = run.reason+' '+run.frames+' synchronized pairs. '+nextStep;
            };
            run.recorder.start(500);
            run.start = Date.now();
            record.textContent = 'Stop Recording';
            run.rig = pair.rig;
          }
          if (left.width*2 !== run.canvas.width || left.height !== run.canvas.height)
            throw new Error('Camera resolution changed.');
          const ctx = run.canvas.getContext('2d');
          ctx.drawImage(left,0,0);
          ctx.drawImage(right,left.width,0);
          run.seenPartners.add(pair.partner);
          run.frames++;
          run.last = Date.now();
          // Inspect the original images just drawn, independently of preview and encoder speed.
          if (run.queue.length < (run.original ? 2 : 24)) {
            run.queue.push({number:run.frames,ms:pair.sampleMs,images:pair.images});
            void checkFrames(run);
          } else {
            run.unchecked++;
          }
          showCounts(run);
          const seconds = Math.floor((run.last-run.start)/1000);
          const elapsed = Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
          status.textContent = 'Recording · '+elapsed+' · '+run.frames+' synchronized pairs';
        }
      }
      const waitMs = Date.now()-run.last;
      if (camerasOffline || waitMs > 2000) {
        const waitingFor = camerasOffline ? 'both camera feeds' : 'a synchronized pair';
        status.textContent = 'Waiting for '+waitingFor+' · '+Math.floor(waitMs/1000)+' s · '+
          (run.frames ? run.frames+' pairs captured. Recording will resume automatically.'
            : 'Recording starts automatically when the first pair arrives.');
      }
      run.timer = setTimeout(()=>sample(run),camerasOffline ? 600 : 95);
    } catch (error) { if (active === run) stop(error.message); }
  }
  record.onclick = async () => {
    if (active) return stop(active.recorder ? 'Recording stopped.' : 'Waiting canceled. No video captured.');
    if (!window.MediaRecorder?.isTypeSupported('video/webm')) {
      status.textContent = 'Open the desktop dashboard in Chrome to record WebM.'; return;
    }
    listVersion++;
    saved.hidden = true;
    mode.disabled = true;
    const run = {mode:mode.value,canvas:document.createElement('canvas'),frames:0,last:Date.now(),
      start:Date.now(),controller:new AbortController(),seenPartners:new Set(),queue:[],unchecked:0,
      counts:new calibrationQuality.RecordingCounts(mode.value)};
    displayedRun = run;
    quality.hidden = false;
    showCounts(run);
    active = run;
    record.textContent = 'Cancel Waiting';
    status.textContent = 'Waiting for synchronized camera frames…';
    try {
      run.token = await getSession();
      if (active === run) await sample(run);
    } catch (error) { if (active === run) stop(error.message); }
  };
  upload.onclick = async () => {
    if (!clip || upload.disabled) return;
    discard.disabled = upload.disabled = true;
    status.textContent = 'Uploading to this computer…';
    try {
      const token = await getSession();
      const response = await fetch('/api/calibration/video',{method:'POST',headers:{
        Authorization:'Bearer '+token,'Content-Type':'video/webm','X-Calibration-Mode':clip.mode},body:clip.blob});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      status.textContent = 'Saved on this computer: '+data.file;
      clip = null;
      mode.disabled = false;
      discard.hidden = upload.hidden = true;
      record.disabled = false;
      record.textContent = 'Record Again';
      await refreshSaved();
    } catch (error) { status.textContent = error.message+' Retry Upload Recording.'; }
    finally { discard.disabled = upload.disabled = false; }
  };
  dialog.addEventListener('close',()=>stop('Recording stopped.'));
})();
