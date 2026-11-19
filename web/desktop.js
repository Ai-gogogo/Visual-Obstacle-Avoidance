const $ = selector => document.querySelector(selector);
const sample = [
  {label:'Chair', camera:'A', distance:1.4, position:'Center', box:[36,22,33,77]},
  {label:'Desk', camera:'A', distance:2.3, position:'Right', box:[78,32,22,65], align:'right'},
  {label:'Backpack', camera:'B', distance:1.8, position:'Left', box:[17,41,21,43]},
  {label:'Water bottle', camera:'B', distance:2.1, position:'Right', box:[65,36,7,24]}
];
const defaultAnswer = 'A chair is centered in Camera A. The sample distance is 1.4 meters.';
const feeds = [...document.querySelectorAll('[data-camera]')].map(node => ({node, side:node.dataset.camera}));
let token;
let sessionRequest;
let sampleMode = true;
let pollVersion = 0;
let pairingVersion = 0;
let recognition;
let recoveryTimer;
let speech;
let currentPage;

function showPage() {
  const hash = location.hash;
  if (hash === '#main') return;
  const page = hash === '#assist' ? 'assist' : 'monitor';
  document.querySelectorAll('[data-page]').forEach(node => { node.hidden = node.id !== page; });
  document.querySelectorAll('[data-route]').forEach(node => {
    if (node.dataset.route === page) node.setAttribute('aria-current','page');
    else node.removeAttribute('aria-current');
  });
  if (currentPage && currentPage !== page) {
    stopAudio();
    $('#' + page + ' h1').focus();
  }
  currentPage = page;
  document.title = (page === 'monitor' ? 'Judge view' : 'Voice assistant') + ' · VisionAssist';
  refreshPolling();
}

function makeAnnotations() {
  const rows = sample.map(object => {
    const overlay = document.createElement('div');
    overlay.className = 'box';
    overlay.dataset.kind = object.camera === 'A' ? 'obstacle' : 'object';
    overlay.dataset.align = object.align || 'left';
    ['left','top','width','height'].forEach((key,index) => { overlay.style[key] = object.box[index] + '%'; });
    const label = document.createElement('span');
    label.textContent = object.label + ' · ' + object.distance + ' m';
    overlay.append(label);
    feeds.find(feed => feed.side === object.camera).node.querySelector('.overlays').append(overlay);
    const row = document.createElement('tr');
    [object.label, 'Camera ' + object.camera, object.distance + ' m', object.position].forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    });
    return row;
  });
  $('#detection-rows').replaceChildren(...rows);
}

async function api(path, method, auth) {
  const response = await fetch(path, {method, headers:auth ? {Authorization:'Bearer '+auth} : {}, signal:AbortSignal.timeout(3500)});
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error), {status:response.status});
  return body;
}

function getSession() {
  if (token) return Promise.resolve(token);
  sessionRequest ||= api('/api/session','POST').then(result => {
    token = result.token;
    return token;
  }).finally(() => { sessionRequest = undefined; });
  return sessionRequest;
}

function setFeed(feed, connected, message) {
  const {node} = feed;
  node.querySelector('.sample-image').hidden = !sampleMode;
  node.querySelector('.overlays').hidden = !sampleMode;
  const status = node.querySelector('.feed-status');
  status.textContent = sampleMode ? 'Sample feed' : connected ? 'Receiving' : 'Offline';
  status.classList.toggle('live', !sampleMode && connected);
  const image = node.querySelector('.live-frame');
  image.hidden = sampleMode || !connected;
  if (!connected && feed.url) {
    URL.revokeObjectURL(feed.url);
    image.removeAttribute('src');
    feed.url = undefined;
    feed.etag = undefined;
  }
  const empty = node.querySelector('.no-feed');
  empty.hidden = sampleMode || connected;
  empty.textContent = message || 'Waiting for Camera ' + feed.side;
  node.querySelector('.feed-summary').textContent = sampleMode ? '2 sample detections' : connected ? 'Live preview' : 'No incoming video';
}

async function readFrame(feed, version) {
  if (!token) return;
  try {
    const headers = {Authorization:'Bearer '+token};
    if (feed.etag) headers['If-None-Match'] = feed.etag;
    const response = await fetch('/api/frame/'+feed.side, {headers, signal:AbortSignal.timeout(3000)});
    if (version !== pollVersion || response.status === 304) return;
    if (response.status !== 200) {
      if (response.status === 401) token = undefined;
      setFeed(feed,false,response.status === 401 ? 'Session expired. Pair the phone again.' : undefined);
      return;
    }
    const frame = await response.blob();
    if (version !== pollVersion) return;
    if (feed.url) URL.revokeObjectURL(feed.url);
    feed.url = URL.createObjectURL(frame);
    feed.etag = response.headers.get('etag');
    feed.node.querySelector('.live-frame').src = feed.url;
    setFeed(feed,true);
  } catch {
    if (version !== pollVersion) return;
    setFeed(feed,false,'Connection interrupted');
  }
}

function refreshPolling() {
  const version = ++pollVersion;
  if (sampleMode || currentPage !== 'monitor' || !token) return;
  async function poll() {
    if (version !== pollVersion) return;
    if (!token) { feeds.forEach(feed => setFeed(feed,false,'Pair the phone again.')); return; }
    await Promise.all(feeds.map(feed => readFrame(feed,version)));
    if (version === pollVersion) setTimeout(poll,260);
  }
  poll();
}

function renderMode(demo) {
  stopAudio();
  sampleMode = demo;
  $('#mode').textContent = demo ? 'Show live cameras' : 'Show sample feeds';
  $('#assist-mode').textContent = demo ? 'Sample scene' : 'Live preview mode';
  $('#detection-note').textContent = demo ? 'Sample annotations · distances are illustrative.' : 'Live camera mode';
  $('#detection-count').textContent = demo ? '4 objects' : 'Unavailable';
  const table = $('.table-wrap');
  table.hidden = !demo;
  $('#empty-detections').hidden = demo;
  $('#response-tag').textContent = demo ? 'Sample' : 'Unavailable';
  $('#response').textContent = demo ? defaultAnswer : 'Live scene analysis is unavailable. The monitor can show paired camera previews.';
  $('#voice-message').textContent = '';
  feeds.forEach(feed => setFeed(feed,false));
  refreshPolling();
}

function setVoiceState(title, prompt, label) {
  $('#voice-state').textContent = title;
  $('#voice-prompt').textContent = prompt;
  $('#mic').setAttribute('aria-label',label);
}
function ready() { setVoiceState('Ready','Tap to speak','Start voice input'); }
function stopAudio() {
  clearTimeout(recoveryTimer);
  if (recognition) {
    const input = recognition;
    recognition = undefined;
    input.abort();
  }
  if (speech) { speech = undefined; window.speechSynthesis.cancel(); }
  ready();
}
function readAnswer() {
  stopAudio();
  $('#voice-message').textContent = '';
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
    $('#voice-message').textContent = 'Read aloud is unavailable in this browser.';
    return;
  }
  const output = new SpeechSynthesisUtterance($('#response').textContent);
  output.lang = 'en-US';
  speech = output;
  setVoiceState('Reading','Reading the response','Stop audio');
  const finish = (message = '') => {
    if (speech !== output) return;
    clearTimeout(recoveryTimer);
    speech = undefined;
    ready();
    if (message) $('#voice-message').textContent = message;
  };
  output.onend = () => finish();
  output.onerror = () => finish('Read aloud is unavailable. You can read the answer above.');
  recoveryTimer = setTimeout(() => { stopAudio(); $('#voice-message').textContent = 'Read aloud did not finish.'; },25000);
  window.speechSynthesis.speak(output);
}
function answer(question, speak = false) {
  stopAudio();
  const match = sample.find(object => question.toLowerCase().includes(object.label.toLowerCase().split(' ').at(-1)));
  $('#response').textContent = !sampleMode
    ? 'Live scene analysis is unavailable. The monitor can show paired camera previews.'
    : match ? match.label + ' appears ' + (match.position === 'Center' ? 'at the center' : 'on the ' + match.position.toLowerCase()) +
      ' of the Camera ' + match.camera + ' frame. The sample distance is ' + match.distance + ' meters.'
      : 'In the sample scene, Camera A shows a chair and desk. Camera B shows a backpack and water bottle.';
  if (speak) readAnswer();
  else $('#voice-message').textContent = 'Response updated. ' + $('#response').textContent;
}
function startVoice() {
  if (recognition || speech) { stopAudio(); $('#voice-message').textContent = 'Audio stopped.'; return; }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $('#voice-message').textContent = 'Voice input is unavailable in this browser. Type your question below.';
    $('#question').focus();
    return;
  }
  const input = new SpeechRecognition();
  recognition = input;
  input.lang = 'en-US';
  $('#voice-message').textContent = '';
  setVoiceState('Starting','Waiting for the microphone','Stop voice input');
  input.onstart = () => {
    if (recognition !== input) return;
    $('#voice-message').textContent = 'Listening.';
    setVoiceState('Listening','Listening to your question','Stop voice input');
  };
  input.onresult = event => {
    if (recognition !== input) return;
    const question = event.results[0][0].transcript;
    $('#question').value = question;
    answer(question,true);
  };
  input.onerror = () => {
    if (recognition !== input) return;
    recognition = undefined;
    ready();
    $('#voice-message').textContent = 'Could not hear a question. Try again or type it below.';
  };
  input.onend = () => {
    if (recognition !== input) return;
    recognition = undefined;
    ready();
    $('#voice-message').textContent = 'Listening ended.';
  };
  try { input.start(); }
  catch { recognition = undefined; ready(); $('#voice-message').textContent = 'Voice input could not start. Type your question below.'; }
}

const dialog = $('#pair-dialog');
const pairButtons = [...document.querySelectorAll('[data-pair]')];
$('#pair').addEventListener('click', () => {
  $('#phone-address').textContent = location.protocol === 'file:'
    ? 'Start the local server to enable pairing. See README.md.'
    : new URL('/camera',location.href).href;
  $('#pair-result').textContent = '';
  dialog.showModal();
});
pairButtons.forEach(button => button.addEventListener('click', async () => {
  const version = ++pairingVersion;
  const result = $('#pair-result');
  pairButtons.forEach(control => { control.disabled = true; });
  result.textContent = 'Generating code…';
  try {
    if (location.protocol === 'file:') throw new Error('Start the local server before generating a pairing code.');
    const side = button.dataset.pair;
    let codeResponse;
    try { codeResponse = await api('/api/pair/'+side,'POST',await getSession()); }
    catch (error) {
      if (error.status !== 401) throw error;
      token = undefined;
      codeResponse = await api('/api/pair/'+side,'POST',await getSession());
    }
    if (version !== pairingVersion || !dialog.open) return;
    const code = document.createElement('div');
    code.className = 'pair-code';
    code.textContent = codeResponse.code.replace(/^(...)/,'$1 ');
    result.replaceChildren('Camera '+side+' · expires in five minutes',code);
    if (sampleMode) renderMode(false);
    else refreshPolling();
  } catch (error) {
    if (version === pairingVersion) result.textContent = error.message;
  } finally {
    pairButtons.forEach(control => { control.disabled = false; });
    if (version === pairingVersion && dialog.open) button.focus();
  }
}));
dialog.addEventListener('close', () => { pairingVersion += 1; });
$('#mode').addEventListener('click', () => renderMode(!sampleMode));
$('#contrast').addEventListener('click', event => {
  const selected = document.documentElement.toggleAttribute('data-contrast');
  event.currentTarget.setAttribute('aria-pressed',String(selected));
});
$('#mic').addEventListener('click',startVoice);
$('#describe').addEventListener('click', () => answer('Describe surroundings',true));
$('#replay').addEventListener('click',readAnswer);
$('#stop').addEventListener('click', () => { stopAudio(); $('#voice-message').textContent = 'Audio stopped.'; });
$('#question-form').addEventListener('submit', event => {
  event.preventDefault();
  const question = $('#question').value.trim();
  if (question) answer(question);
  else $('#question').focus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || dialog.open || (!recognition && !speech)) return;
  stopAudio();
  $('#voice-message').textContent = 'Audio stopped.';
});
window.addEventListener('pagehide', () => { stopAudio(); pollVersion += 1; });
window.addEventListener('pageshow', event => { if (event.persisted) refreshPolling(); });
window.addEventListener('hashchange',showPage);
makeAnnotations();
showPage();
