import { requestError } from "../../shared/accessibility.js";
import { exchangeVideoOffer } from "../../services/rtc-client.js";

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
  let retryDelayMs = 500;
  let rtcPeer;
  let rtcAbort;

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
    retryDelayMs = 500;
    clearTimeout(timer);
    rtcAbort?.abort();
    rtcPeer?.close();
    rtcAbort = rtcPeer = undefined;
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

  function retryFrame(currentRun, message) {
    if (run !== currentRun) return;
    lastDetails = '';
    report({phase:'connected', lens:message + ' Retrying automatically…'});
    // Capture a fresh frame after the delay so an old frame cannot enter a stereo pair.
    timer = setTimeout(() => nextFrame(currentRun), retryDelayMs);
    retryDelayMs = Math.min(5000, retryDelayMs * 2);
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
        let response;
        try {
          response = await fetch('/api/frame', {method:'PUT', headers:{Authorization:'Bearer '+token,'Content-Type':type, ...timing}, body:frame, signal:AbortSignal.timeout(4500)});
        } catch {
          return retryFrame(currentRun, 'Frame upload interrupted.');
        }
        if (run !== currentRun) return;
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          return retryFrame(currentRun, 'Frame upload temporarily unavailable.');
        }
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error || 'Camera connection ended. Enter a new code to reconnect.');
        }
        if (originalPixels && (!clock || sent-clock.at > 60000)) {
          // Use a small clock request to avoid timing the entire PNG upload.
          const start = performance.now();
          let reply;
          try {
            reply = await fetch('/camera',{cache:'no-store',signal:AbortSignal.timeout(2500)});
          } catch {
            return retryFrame(currentRun, 'Camera clock check interrupted.');
          }
          if (!reply.ok) return retryFrame(currentRun, 'Camera clock check unavailable.');
          if (run !== currentRun) return;
          updateClock(reply,start,performance.now());
        } else if (!originalPixels) updateClock(response, sent, performance.now());
        retryDelayMs = 500;
        if (details !== lastDetails) {
          lastDetails = details;
          report({phase:'connected', lens:details});
        }
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
  async function openWideCamera(devices, rtcMode) {
    const resolution = originalPixels ? {width:{ideal:1920},height:{ideal:1080}} :
      rtcMode ? {width:{exact:rtcMode === 'portrait-full' ? 1080 : 480},
        height:{exact:rtcMode === 'portrait-full' ? 1920 : 640},frameRate:{ideal:24,max:30}} : {};
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
        try { await track.applyConstraints({...resolution,zoom:{exact:0.5}}); } catch { /* report actual settings below */ }
        if (settings().zoom === 0.5) return {media,description:label+' · 0.5× zoom'};
      }
      return {media,description:label+' · 0.5× unavailable or unconfirmed'};
    } catch (error) {
      media.getTracks().forEach(t => t.stop());
      throw error;
    }
  }

  async function streamVideo(currentRun, rtcMode) {
    const controller = rtcAbort = new AbortController();
    const peer = rtcPeer = new RTCPeerConnection({iceServers:[]});
    const auth = {Authorization:'Bearer '+token};
    const offerPath = '/api/webrtc/offer?quality='+rtcMode;
    let negotiatedAt;
    let triedSensorOrientation = false;
    let received = false;
    let clockRefreshAt = 0;

    async function syncRtcClock() {
      const options = {headers:auth,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(1200)])};
      let best;
      for (let i=0; i<4; i++) {
        const start = performance.now();
        const sent = Date.now();
        const response = await fetch('/api/webrtc/clock',options);
        const received = Date.now();
        const elapsed = performance.now()-start;
        if (!response.ok) return;
        const {server_ms} = await response.json();
        if (Math.abs(received-sent-elapsed) <= 5 && received >= sent && (!best || elapsed < best.elapsed)) {
          best = {server_ms,sent_ms:sent,received_ms:received,elapsed};
        }
      }
      if (best) await fetch('/api/webrtc/clock',{
        ...options,method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(best)
      });
    }

    async function endRtc(reason) {
      if (rtcPeer !== peer || run !== currentRun) return;
      rtcPeer = undefined;
      controller.abort();
      peer.close();
      try {
        const response = await fetch('/api/webrtc/offer',{method:'DELETE',headers:auth,signal:AbortSignal.timeout(3000)});
        if (!response.ok) throw new Error('Camera session ended.');
        if (run !== currentRun) return;
        stop(reason || 'WebRTC interrupted. Check Wi-Fi and reconnect with the same resolution.');
      } catch {
        if (run === currentRun) stop('Camera connection interrupted. Pair again to reconnect.');
      }
    }

    async function readReceiverStatus() {
      let response;
      try {
        response = await fetch('/api/webrtc/status',{headers:auth,
          signal:AbortSignal.any([controller.signal,AbortSignal.timeout(2500)])});
        if (response.ok) return await response.json();
      } catch (error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError) return null;
        throw error;
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) return null;
      throw new Error('Receiver unavailable.');
    }

    async function checkReceiver() {
      if (rtcPeer !== peer || run !== currentRun) return;
      try {
        const state = await readReceiverStatus();
        if (rtcPeer !== peer || run !== currentRun) return;
        if (state === null) {
          // The video track sends independently of this HTTP status request.
          report({phase:'connected',lens:lensDescription+' · Retrying receiver status…'});
          timer = setTimeout(checkReceiver,1000);
          return;
        }
        const width = rtcMode === 'portrait-full' ? 1080 : 480;
        const height = rtcMode === 'portrait-full' ? 1920 : 640;
        if (!received && state.size_mismatch && state.width === height && state.height === width &&
            !triedSensorOrientation) {
          triedSensorOrientation = true;
          const track = stream.getVideoTracks()[0];
          // Some phone cameras interpret constraints in sensor orientation.
          // Retry on the same physical track and verify the decoded result on the Mac.
          await track.applyConstraints({...track.getConstraints(),width:{exact:height},height:{exact:width}})
            .catch(() => {});
        }
        if (!state.receiving && (received || performance.now()-negotiatedAt > 20000)) {
          const target = rtcMode === 'portrait-full' ? '1080 × 1920' : '480 × 640';
          return endRtc(state.size_mismatch
            ? 'Mac received '+state.width+' × '+state.height+' px. Calibration requires '+target+' px.'
            : 'Mac has no usable video frames. WebRTC ICE state: '+peer.iceConnectionState+'.');
        }
        if (state.receiving) {
          received = true;
          if (performance.now() >= clockRefreshAt) {
            clockRefreshAt = performance.now()+5000;
            void syncRtcClock().catch(() => {});
          }
          const fps = state.decoded_fps ? ' · '+state.decoded_fps+' FPS at receiver' : '';
          const size = state.width && state.height ? ' · '+state.width+' × '+state.height+' px' : '';
          const timing = state.capture_timing_available ? ' · Stereo timing ready' : ' · Waiting for stereo timing';
          report({phase:'connected',lens:lensDescription+' · WebRTC'+size+fps+timing});
        }
        timer = setTimeout(checkReceiver,1000);
      } catch {
        await endRtc();
      }
    }

    try {
      const {sender} = peer.addTransceiver(stream.getVideoTracks()[0],{
        direction:'sendrecv',sendEncodings:[{maxBitrate:rtcMode === 'portrait-full' ? 8_000_000 : 2_000_000,scaleResolutionDownBy:1}]
      });
      const parameters = sender.getParameters();
      parameters.degradationPreference = 'maintain-resolution';
      await sender.setParameters(parameters).catch(() => {});
      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'failed') void endRtc();
      });
      await exchangeVideoOffer(peer,offerPath,token,controller.signal);
      negotiatedAt = performance.now();
      await checkReceiver();
    } catch {
      await endRtc();
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
      const requestedRtc = format === 'webrtc-hd' ? 'portrait-full' : format === 'webrtc' ? 'portrait-low' : null;
      const rtcMode = typeof RTCPeerConnection === 'undefined' ? null : requestedRtc;
      if (requestedRtc && !rtcMode) throw new Error('WebRTC is unavailable in this browser.');
      const {media,description} = await openWideCamera(navigator.mediaDevices,rtcMode);
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
      if (run !== currentRun) return;
      if (rtcMode && result.webrtc) {
        report({phase:'connected',lens:description+' · Connecting WebRTC'});
        void streamVideo(currentRun,rtcMode);
        return;
      }
      if (requestedRtc) { stop('WebRTC receiver unavailable. Check the Mac receiver and reconnect.'); return; }
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
    if (token) {
      lastDetails = '';
      report({phase:'connected', lens:'Network connection lost. Waiting to resume camera uploads…'});
    }
  }};
}
