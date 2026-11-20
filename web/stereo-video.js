// Encode clean A/B pixels side by side. Checkerboard overlays are display-only.
import { RecordingCounts } from './calibration-quality.js';

export function connectStereoVideo({$, scope, session}) {
  const {listen, signal} = scope;
  const record = $('#cal-record');
  const upload = $('#cal-upload');
  const status = $('#video-status');
  const dialog = $('#calibration-dialog');
  const mode = $('#cal-mode');
  const quality = $('#video-quality');
  const discard = $('#cal-discard');
  const download = $('#cal-download');
  const maxUploadBytes = 64 * 1024 * 1024;
  // Leave room for the final chunk when stopping the encoder.
  const stopAtBytes = 60 * 1024 * 1024;
  const saved = $('#cal-saved');
  const takes = $('#cal-takes');
  const remove = $('#cal-delete');
  let active, clip, displayedRun, listVersion = 0;

  async function refreshSaved() {
    const version = ++listVersion;
    const target = mode.value;
    saved.hidden = true;
    if (signal.aborted || !dialog.open || active || clip || (record.disabled && !remove.disabled)) return;
    try {
      const response = await fetch('/api/calibration/video',{signal, headers:{
        Authorization:'Bearer '+await session.getSession(),'X-Calibration-Mode':target}});
      if (response.status === 405) return; // Older running servers support upload only.
      if (!response.ok) throw new Error('Could not load saved recordings.');
      const {recordings} = await response.json();
      if (signal.aborted || version !== listVersion) return;
      takes.replaceChildren(...recordings.map(({name,savedAt}) =>
        new Option(new Date(savedAt).toLocaleString()+' · '+name.slice(0,8),name)));
      saved.hidden = !recordings.length;
      if (!active && !record.disabled)
        record.textContent = recordings.length ? 'Record Again' : 'Record Stereo Video';
    } catch (error) {
      if (!signal.aborted && version === listVersion && !active && !clip) status.textContent = error.message;
    }
  }
  listen($('#open-calibration'), 'click', refreshSaved);
  listen(mode, 'change', refreshSaved);

  listen(remove, 'click', async () => {
    const name = takes.value;
    const selected = takes.selectedOptions[0];
    if (!name || remove.disabled || !confirm('Delete the saved recording '+selected.text+' from this computer?')) return;
    remove.disabled = record.disabled = mode.disabled = takes.disabled = true;
    try {
      const response = await fetch('/api/calibration/video',{method:'DELETE',signal,headers:{
        Authorization:'Bearer '+await session.getSession(),'X-Calibration-Mode':mode.value,'Content-Type':'application/json'},
        body:JSON.stringify({name})});
      if (!response.ok) throw new Error((await response.json()).error || 'Could not delete recording.');
      if (signal.aborted) return;
      status.textContent = 'Recording deleted.';
      await refreshSaved();
    } catch (error) { if (!signal.aborted) status.textContent = error.message; }
    finally {
      if (!signal.aborted) {
        remove.disabled = record.disabled = mode.disabled = takes.disabled = false;
        record.textContent = saved.hidden ? 'Record Stereo Video' : 'Record Again';
      }
    }
  });
  listen(discard, 'click', () => {
    if (!clip || upload.disabled || !confirm('Discard this unsaved recording and prepare for a retake?')) return;
    if (clip.url) {
      URL.revokeObjectURL(clip.url);
      download.removeAttribute('href');
      download.hidden = true;
    }
    cancelChecks();
    clip = displayedRun = null;
    quality.hidden = discard.hidden = upload.hidden = true;
    mode.disabled = record.disabled = false;
    record.textContent = 'Record Again';
    status.textContent = 'Ready to retake. Start when the board is in position.';
    void refreshSaved();
  });

  function showCounts(run) {
    if (signal.aborted || displayedRun !== run) return;
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
            signal:AbortSignal.any([signal, run.checkController.signal, AbortSignal.timeout(run.original ? 20000 : 10000)])});
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

  function cancelChecks() {
    if (!displayedRun) return;
    displayedRun.checkController.abort();
    displayedRun.unchecked += displayedRun.queue.length;
    displayedRun.queue.length = 0;
    showCounts(displayedRun);
  }

  listen(mode, 'change', () => {
    cancelChecks();
    displayedRun = null;
    quality.hidden = true;
  });
  function stop(reason) {
    if (!active) return;
    const run = active;
    active = null;
    run.controller.abort();
    scope.cancelDelay(run.timer);
    if (run.recorder?.state === 'recording') {
      record.disabled = true;
      run.reason = reason;
      run.recorder.stop();
    } else {
      run.stream?.getTracks().forEach(track => track.stop());
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
            run.stream = stream;
            try {
              run.recorder = new MediaRecorder(stream,{mimeType:'video/webm',videoBitsPerSecond:4000000});
            } catch (error) { stream.getTracks().forEach(t=>t.stop()); throw error; }
            const chunks = [];
            let encodedBytes = 0;
            run.recorder.ondataavailable = ({data}) => {
              if (signal.aborted || !data.size) return;
              chunks.push(data);
              encodedBytes += data.size;
              if (active === run && encodedBytes >= stopAtBytes)
                stop('This clip has reached the upload size threshold.');
            };
            run.recorder.onstop = () => {
              stream.getTracks().forEach(t=>t.stop());
              if (signal.aborted) return;
              // An encoder can also stop without a button click.
              if (active === run) {
                active = null;
                run.controller.abort();
                scope.cancelDelay(run.timer);
              }
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
              status.textContent = (run.reason || 'Recording stopped.')+' '+run.frames+' synchronized pairs. '+nextStep;
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
      run.timer = scope.delay(()=>sample(run),camerasOffline ? 600 : 95);
    } catch (error) { if (active === run) stop(error.message); }
  }
  listen(record, 'click', async () => {
    if (active) return stop(active.recorder ? 'Recording stopped.' : 'Waiting canceled. No video captured.');
    if (!window.MediaRecorder?.isTypeSupported('video/webm')) {
      status.textContent = 'Open the desktop dashboard in Chrome to record WebM.'; return;
    }
    listVersion++;
    cancelChecks();
    saved.hidden = true;
    mode.disabled = true;
    const run = {mode:mode.value,canvas:document.createElement('canvas'),frames:0,last:Date.now(),
      start:Date.now(),controller:new AbortController(),checkController:new AbortController(),seenPartners:new Set(),queue:[],unchecked:0,
      counts:new RecordingCounts(mode.value)};
    displayedRun = run;
    quality.hidden = false;
    showCounts(run);
    active = run;
    record.textContent = 'Cancel Waiting';
    status.textContent = 'Waiting for synchronized camera frames…';
    try {
      run.token = await session.getSession();
      if (active === run) await sample(run);
    } catch (error) { if (active === run) stop(error.message); }
  });
  listen(upload, 'click', async () => {
    if (!clip || upload.disabled) return;
    discard.disabled = upload.disabled = true;
    status.textContent = 'Uploading to this computer…';
    try {
      const token = await session.getSession();
      const response = await fetch('/api/calibration/video',{method:'POST',signal,headers:{
        Authorization:'Bearer '+token,'Content-Type':'video/webm','X-Calibration-Mode':clip.mode},body:clip.blob});
      const data = await response.json();
      if (signal.aborted) return;
      if (!response.ok) throw new Error(data.error);
      status.textContent = 'Saved on this computer: '+data.file;
      clip = null;
      mode.disabled = false;
      discard.hidden = upload.hidden = true;
      record.disabled = false;
      record.textContent = 'Record Again';
      await refreshSaved();
    } catch (error) {
      if (!signal.aborted) status.textContent = error.message+' Retry Upload Recording.';
    } finally {
      if (!signal.aborted) discard.disabled = upload.disabled = false;
    }
  });
  listen(dialog, 'close', () => {
    listVersion++;
    stop('Recording stopped.');
    cancelChecks();
  });
  signal.addEventListener('abort', () => {
    const run = active;
    active = null;
    run?.controller.abort();
    if (run?.recorder?.state === 'recording') run.recorder.stop();
    displayedRun?.stream?.getTracks().forEach(track => track.stop());
    cancelChecks();
    if (clip?.url) URL.revokeObjectURL(clip.url);
  }, {once:true});
}
