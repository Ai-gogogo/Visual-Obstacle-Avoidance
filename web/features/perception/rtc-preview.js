import { exchangeVideoOffer } from "../../services/rtc-client";

export function createRtcPreview(node, side, scope, session) {
  const video = node.querySelector('.rtc-preview');
  const canvas = node.querySelector('canvas');
  const frame = canvas.parentElement;
  const caption = node.querySelector('.analysis-frame-label');
  const button = node.querySelector('.rtc-toggle');
  const status = node.querySelector('.rtc-status');
  let active;
  let analyzed = false;

  function layout() {
    const playing = !video.hidden;
    frame.toggleAttribute('data-rtc-live',playing);
    canvas.classList.toggle('analysis-inset',playing && analyzed && !!caption);
    if (playing) canvas.hidden = !(analyzed && caption);
    if (caption) caption.hidden = !(playing && analyzed);
  }

  function stop(message = '') {
    const previous = active;
    active = undefined;
    if (previous) {
      previous.abort.abort();
      previous.peer.close();
      void fetch(previous.path,{method:'DELETE',headers:{Authorization:'Bearer '+previous.token},
        keepalive:true,signal:AbortSignal.timeout(3500)}).catch(() => {});
    }
    video.srcObject = null;
    video.hidden = true;
    if (previous) canvas.hidden = false;
    layout();
    button.setAttribute('aria-pressed','false');
    status.textContent = message;
  }

  async function start() {
    const token = session.token;
    if (!token || button.hidden) return;
    const peer = new RTCPeerConnection({iceServers:[]});
    const abort = new AbortController();
    const path = '/api/webrtc/view/'+side+'?viewer='+crypto.randomUUID();
    const attempt = active = {peer,abort,path,token};
    const unavailable = 'Live video unavailable. Showing the analysis image.';
    status.textContent = 'Connecting live video';
    button.setAttribute('aria-pressed','true');
    peer.addTransceiver('video',{direction:'recvonly'});
    peer.addEventListener('track', event => {
      if (active !== attempt) return;
      video.srcObject = new MediaStream([event.track]);
      event.track.addEventListener('ended', () => {
        if (active === attempt) stop(unavailable);
      },{once:true});
      void video.play().catch(() => {
        if (active === attempt) stop(unavailable);
      });
    });
    peer.addEventListener('connectionstatechange', () => {
      if (active === attempt && peer.connectionState === 'failed') stop(unavailable);
    });
    try {
      await exchangeVideoOffer(peer,path,token,abort.signal);
      scope.delay(() => {
        if (active === attempt && video.hidden) stop(unavailable);
      },5000);
    } catch {
      if (active === attempt) stop(unavailable);
    }
  }

  scope.listen(video,'playing', () => {
    if (!active) return;
    video.hidden = false;
    layout();
    status.textContent = 'Live video';
  });
  scope.listen(button,'click', () => {
    if (active) stop(); else void start();
  });
  scope.signal.addEventListener('abort', () => stop(),{once:true});
  return {
    get playing() { return !video.hidden; },
    updateAnalysis(value) {
      analyzed = value;
      layout();
    },
    update(available) {
      button.hidden = !available || typeof RTCPeerConnection === 'undefined';
      if (button.hidden) stop();
    }
  };
}
