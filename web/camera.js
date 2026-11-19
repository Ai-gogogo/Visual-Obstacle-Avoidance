const form = document.querySelector('#phone-form');
const card = document.querySelector('#phone-pair');
const video = document.querySelector('#local-camera');
const codeField = document.querySelector('#code');
const status = document.querySelector('#phone-status');
const connect = document.querySelector('#connect');
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d');
let stream;
let token;
let timer;
let run = 0;

function stop(message = '') {
  run += 1;
  clearTimeout(timer);
  const previousToken = token;
  token = undefined;
  stream?.getTracks().forEach(track => track.stop());
  stream = undefined;
  video.srcObject = null;
  video.hidden = true;
  card.hidden = false;
  connect.disabled = false;
  status.textContent = message;
  if (previousToken) fetch('/api/frame', {method:'DELETE', headers:{Authorization:'Bearer '+previousToken}, keepalive:true}).catch(() => {});
}

async function upload(currentRun) {
  if (run !== currentRun) return;
  try {
    if (video.videoWidth && video.readyState >= 2) {
      const scale = Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));
      canvas.width = Math.max(1,Math.round(video.videoWidth*scale));
      canvas.height = Math.max(1,Math.round(video.videoHeight*scale));
      context.drawImage(video,0,0,canvas.width,canvas.height);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',.7));
      if (run !== currentRun) return;
      if (!jpeg) throw new Error('Unable to read the camera frame.');
      const response = await fetch('/api/frame', {method:'PUT', headers:{Authorization:'Bearer '+token,'Content-Type':'image/jpeg'}, body:jpeg, signal:AbortSignal.timeout(4500)});
      if (!response.ok) throw new Error('Camera connection ended. Enter a new code to reconnect.');
    }
    if (run === currentRun) timer = setTimeout(() => upload(currentRun),220);
  } catch (error) {
    if (run === currentRun) stop(error.name === 'TimeoutError' ? 'Connection timed out. Pair again to reconnect.' : error.message);
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const code = codeField.value.replace(/[\s-]/g,'');
  if (!/^\d{6}$/.test(code)) { status.textContent = 'Enter the six-digit code.'; codeField.focus(); return; }
  if (!navigator.mediaDevices?.getUserMedia || location.protocol === 'file:') {
    status.textContent = 'Open the camera site from the local server. A phone on the network needs HTTPS.';
    return;
  }
  if (connect.disabled) return;
  const currentRun = ++run;
  connect.disabled = true;
  status.textContent = 'Allow camera access to connect.';
  try {
    const media = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    if (run !== currentRun) { media.getTracks().forEach(track => track.stop()); return; }
    stream = media;
    const response = await fetch('/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:AbortSignal.timeout(4500)});
    const result = await response.json();
    if (run !== currentRun) {
      if (result.token) fetch('/api/frame',{method:'DELETE',headers:{Authorization:'Bearer '+result.token}}).catch(() => {});
      return;
    }
    if (!response.ok) throw new Error(result.error);
    token = result.token;
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => stop('Camera stopped. Enter a new code to reconnect.')));
    video.srcObject = stream;
    video.hidden = false;
    card.hidden = true;
    await video.play();
    upload(currentRun);
  } catch (error) {
    if (run === currentRun) stop(error.name === 'NotAllowedError' ? 'Camera access was denied. Allow it in your browser and try again.' : error.message);
  }
});
window.addEventListener('pagehide', () => stop());
