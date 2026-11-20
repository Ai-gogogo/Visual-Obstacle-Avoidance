import { requestError } from "../../shared/accessibility";

export function createCameraUpload(video, report) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  let stream;
  let token;
  let timer;
  let run = 0;
  let clock;
  let lensDescription = '';
  let lastDetails = '';
  let originalPixels = false;

  // Estimate server time on the phone's monotonic clock. Retain the lowest RTT
  // sample for one minute, and account for uncertainty when pairing the views.
  function updateClock(response, sent, received) {
    if (!response.headers.has('X-Server-Ms')) return;
    const server = Number(response.headers.get('X-Server-Ms'));
    const error = Math.ceil((received - sent) / 2) + 1;
    if (Number.isFinite(server) && (!clock || received-clock.at > 60000 || error <= clock.error)) {
      clock = {offset:server-(sent+received)/2, error, at:received};
    }
  }

  function stop(message = '', invalid = false) {
    run += 1;
    lastDetails = '';
    clock = undefined;
    clearTimeout(timer);
    const previousToken = token;
    token = undefined;
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    video.srcObject = null;
    report({phase:'idle', message, invalid});
    if (previousToken) fetch('/api/frame', {method:'DELETE', headers:{Authorization:'Bearer '+previousToken}, keepalive:true}).catch(() => {});
  }

  function nextFrame(currentRun) {
    if (run !== currentRun) return;
    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback((_, meta) => upload(currentRun, meta.captureTime ?? meta.presentationTime));
    } else {
      upload(currentRun);
    }
  }

  async function upload(currentRun, sampleTime) {
    if (run !== currentRun) return;
    try {
      if (video.videoWidth && video.readyState >= 2) {
        const scale = originalPixels ? 1 : Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));
        const width = Math.max(1,Math.round(video.videoWidth*scale));
        const height = Math.max(1,Math.round(video.videoHeight*scale));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const details = lensDescription + ' · ' + video.videoWidth + ' × ' + video.videoHeight +
          ' px camera · ' + width + ' × ' + height + ' px ' + (originalPixels ? 'lossless PNG' : 'JPEG upload');
        if (details !== lastDetails) {
          lastDetails = details;
          report({phase:'connected', lens:details});
        }
        context.drawImage(video,0,0,canvas.width,canvas.height);
        const timing = {};
        if (clock && Number.isFinite(sampleTime)) {
          timing['X-Sample-Ms'] = String(Math.round(sampleTime + clock.offset));
          timing['X-Clock-Error-Ms'] = String(clock.error + Math.ceil(Math.abs(sampleTime-clock.at) * .0001));
        }
        const type = originalPixels ? 'image/png' : 'image/jpeg';
        const frame = await new Promise(resolve => canvas.toBlob(resolve,type,originalPixels ? undefined : .7));
        if (run !== currentRun) return;
        if (!frame || frame.type !== type) throw new Error('Unable to encode the camera frame.');
        if (originalPixels && frame.size > 12 * 1024 * 1024) throw new Error('PNG exceeds 12 MiB. Reconnect using Standard mode.');
        const sent = performance.now();
        const response = await fetch('/api/frame', {method:'PUT', headers:{Authorization:'Bearer '+token,'Content-Type':type, ...timing}, body:frame, signal:AbortSignal.timeout(4500)});
        if (run !== currentRun) return;
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || 'Camera connection ended. Enter a new code to reconnect.');
        }
        if (originalPixels && (!clock || sent-clock.at > 60000)) {
          // Use a small clock request to avoid timing the entire PNG upload.
          const start = performance.now();
          const reply = await fetch('/camera',{cache:'no-store',signal:AbortSignal.timeout(2500)});
          if (run !== currentRun) return;
          updateClock(reply,start,performance.now());
        } else if (!originalPixels) updateClock(response, sent, performance.now());
      }
      if (run === currentRun) {
        // Aim both phones at the same server-clock tick, then take the next video frame.
        const period = originalPixels ? 1000 : 220;
        const delay = clock && video.requestVideoFrameCallback
          ? period - ((performance.now()+clock.offset) % period) : period;
        timer = setTimeout(() => nextFrame(currentRun),delay);
      }
    } catch (error) {
      if (run === currentRun) stop(requestError(error,'Connection interrupted. Pair again to reconnect.'));
    }
  }

  // An ultrawide physical lens can report 1× relative to itself.
  async function openWideCamera(devices) {
    const resolution = originalPixels ? {width:{ideal:1920},height:{ideal:1080}} : {};
    const open = video => devices.getUserMedia({video:{...resolution,...video},audio:false});
    const rear = {facingMode:{ideal:'environment'}};
    const ultra = label => /ultra[ -]?wide|超广角|超廣角/i.test(label) &&
      !/front|user.facing|前置/i.test(label);
    let media = await open(rear);
    try {
      let track = media.getVideoTracks()[0];
      if (!ultra(track.label)) {
        const cameras = await devices.enumerateDevices().catch(() => []);
        const target = cameras.find(d => d.kind === 'videoinput' && d.deviceId && ultra(d.label));
        if (target && target.deviceId !== track.getSettings().deviceId) {
          media.getTracks().forEach(t => t.stop());
          try {
            media = await open({deviceId:{exact:target.deviceId}, facingMode:{exact:'environment'}});
          } catch (error) {
            if (error.name === 'NotAllowedError') throw error;
            media = await open(rear);
          }
          track = media.getVideoTracks()[0];
        }
      }
      const settings = () => track.getSettings();
      const label = track.label || 'Camera';
      if (ultra(label) && settings().facingMode !== 'user')
        return {media,description:label+' · Ultra wide lens'};
      const range = track.getCapabilities?.().zoom;
      if (settings().facingMode !== 'user' && range?.min <= 0.5 && range.max >= 0.5) {
        try { await track.applyConstraints({zoom:{exact:0.5}}); } catch { /* report actual settings below */ }
        if (settings().zoom === 0.5) return {media,description:label+' · 0.5× zoom'};
      }
      return {media,description:label+' · 0.5× unavailable or unconfirmed'};
    } catch (error) {
      media.getTracks().forEach(t => t.stop());
      throw error;
    }
  }


  async function start(code, format) {
    if (!navigator.mediaDevices?.getUserMedia) {
      report({phase:'idle', message:'Open the camera site from the local server. A phone on the network needs HTTPS.'});
      return;
    }
    const currentRun = ++run;
    originalPixels = format === 'png';
    report({phase:'connecting', message:'Allow camera access to connect.'});
    try {
      const {media,description} = await openWideCamera(navigator.mediaDevices);
      if (run !== currentRun) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media;
      const sent = performance.now();
      const response = await fetch('/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:AbortSignal.timeout(4500)});
      const received = performance.now();
      const result = await response.json();
      if (run !== currentRun) {
        if (result.token) fetch('/api/frame',{method:'DELETE',headers:{Authorization:'Bearer '+result.token}}).catch(() => {});
        return;
      }
      if (!response.ok) {
        stop(result.error || 'Could not pair the camera.', response.status === 404);
        return;
      }
      token = result.token;
      updateClock(response, sent, received);
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => stop('Camera stopped. Enter a new code to reconnect.')));
      video.srcObject = stream;
      lensDescription = description;
      report({phase:'connected', lens:description});
      await video.play();
      nextFrame(currentRun);
    } catch (error) {
      if (run === currentRun) {
        stop(error.name === 'NotAllowedError'
          ? 'Camera access was denied. Allow it in your browser and try again.'
          : requestError(error,'Could not reach the pairing service.'));
      }
    }
  }

  return {start, stop, networkLost() {
    if (stream) stop('Network connection lost. Reconnect, then enter a new code.');
  }};
}
