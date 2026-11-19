const $ = selector => document.querySelector(selector);
const sample = [
  {label:'Chair', camera:'A', distance:1.4, position:'Center', box:[36,22,33,77]},
  {label:'Desk', camera:'A', distance:2.3, position:'Right', box:[78,32,22,65], align:'right'},
  {label:'Backpack', camera:'B', distance:1.8, position:'Left', box:[17,41,21,43]},
  {label:'Water bottle', camera:'B', distance:2.1, position:'Right', box:[65,36,7,24]}
];

const feeds = [...document.querySelectorAll('[data-camera]')].map(node => ({node, side:node.dataset.camera}));
let token;
let sessionRequest;
let sampleMode = true;
let pollVersion = 0;
let pairingVersion = 0;
let voiceSession;
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
  if (page === 'assist') scrollConversation();
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
  $('#voice-message').textContent = '';
  feeds.forEach(feed => setFeed(feed,false));
  refreshPolling();
}

let pendingTurn;
let reviewing = false;
let exporting = false;
const conversation = readConversation();
let confirmation;
let alertSequence = 0;
let warningUntil = 0;
let warningActive = false;

function setVoiceState(title, prompt, label) {
  $('#voice-state').textContent = title;
  $('#voice-prompt').textContent = prompt;
  const mic = $('#mic');
  mic.setAttribute('aria-label',label);
  mic.toggleAttribute('data-can-stop',label !== 'Start conversation');
  $('#stop').hidden = !(speech && voiceSession);
}

function ready() { setVoiceState('Ready','Tap to start a conversation','Start conversation'); }

function releaseSpeech() {
  if (!speech) return;
  const output = speech;
  speech = undefined;
  output.controller.abort();
  output.audio?.pause();
  if (output.url) URL.revokeObjectURL(output.url);
  warningActive = false;
}

function pauseListening() {
  if (!voiceSession) return;
  voiceSession.listening = false;
  voiceSession.segment = null;
  voiceSession.stream?.getAudioTracks().forEach(track => { track.enabled = false; });
}

function resumeListening() {
  const active = voiceSession;
  if (!active?.capture || active.listening || pendingTurn || speech || reviewing) return;
  active.segment = {lead:[], chunks:[], onset:0, voiced:0, quiet:0, floor:0.002};
  active.stream.getAudioTracks().forEach(track => { track.enabled = true; });
  active.listening = true;
  setVoiceState('Listening','Speak, then pause for a reply','End conversation');
}

function interruptTurn() {
  pendingTurn?.abort();
  pendingTurn = undefined;
  pauseListening();
  clearTimeout(recoveryTimer);
  releaseSpeech();
}

function stopAudio() {
  interruptTurn();
  setReview(false);
  const active = voiceSession;
  voiceSession = undefined;
  active?.stream?.getTracks().forEach(track => track.stop());
  active?.capture?.port.close();
  if (active && active.context.state !== 'closed') active.context.close().catch(() => {});
  ready();
}

function stopPlayback(message = '') {
  if (!speech) return;
  const restoreFocus = document.activeElement === $('#stop');
  clearTimeout(recoveryTimer);
  releaseSpeech();
  if (!voiceSession) ready();
  else if (reviewing) setVoiceState('Review','Review the transcription before sending','End conversation');
  else if (!voiceSession.capture) setVoiceState('Starting','Waiting for the microphone','End conversation');
  else resumeListening();
  $('#stop').hidden = true;
  if (restoreFocus) $('#mic').focus();
  if (message) $('#voice-message').textContent = message;
}

async function speakLocal(text, warning = false) {
  if (!warning && warningActive) return;
  pauseListening();
  clearTimeout(recoveryTimer);
  const output = {controller:new AbortController()};
  speech = output;
  warningActive = warning;
  const label = voiceSession ? 'End conversation' : 'Stop playback';
  setVoiceState(warning ? 'Warning' : 'Reading',warning ? 'Playing an obstacle alert' : 'Preparing local audio',label);
  function finish(message = '') {
    if (speech !== output) return;
    stopPlayback(message);
  }
  recoveryTimer = setTimeout(() => finish('Local audio did not finish.'),30000);
  try {
    const result = await agentFetch('/api/agent/speech','POST',
      JSON.stringify({text:text.slice(0,650),priority:warning}),'application/json',output.controller.signal);
    const audio = await result.blob();
    if (speech !== output) return;
    output.url = URL.createObjectURL(audio);
    output.audio = new Audio(output.url);
    output.audio.onended = () => finish();
    output.audio.onerror = () => finish('Local playback failed. The text is still available.');
    await output.audio.play();
    if (!warning && speech === output) setVoiceState('Speaking',
      voiceSession ? 'Listening resumes after the reply' : 'Playing reply. Tap to stop playback.',label);
  } catch (error) {
    finish(error.name === 'NotAllowedError' ? 'Playback was blocked by the browser. Use Read aloud to enable audio.' : error.message);
  }
}

function readAnswer() {
  const last = conversation.findLast(message => message.role === 'assistant');
  if (!last || warningActive) return;
  interruptTurn();
  speakLocal(last.text);
}

async function agentFetch(path, method, body, contentType = 'application/json', signal) {
  if (location.protocol === 'file:') throw new Error('Start the local server to use the assistant.');
  const auth = await getSession();
  const timeout = AbortSignal.timeout(62000);
  const response = await fetch(path,{method,body,headers:{Authorization:'Bearer '+auth,
    ...(body ? {'Content-Type':contentType} : {})},signal:signal ? AbortSignal.any([signal,timeout]) : timeout});
  if (!response.ok) {
    const result = await response.json();
    if (response.status === 401 && token === auth) token = undefined;
    throw Object.assign(new Error(result.error),{status:response.status});
  }
  return response;
}

async function agentRequest(...args) {
  const response = await agentFetch(...args);
  return response.status === 204 ? null : response.json();
}

function renderReply(result) {
  confirmation = result.confirmation;
  $('#confirm-memory').hidden = !confirmation;
  $('#confirmation-summary').textContent = confirmation?.summary || '';
  $('#voice-message').textContent = '';
  addMessage('assistant',result.reply_text);
}

function readConversation() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('visionassist-conversation') || '[]');
    return Array.isArray(saved) ? saved.filter(entry => entry && ['user','assistant'].includes(entry.role) &&
      typeof entry.text === 'string').slice(-1000) : [];
  } catch { return []; }
}

function appendMessage(message) {
  const row = document.createElement('li');
  row.dataset.speaker = message.role;
  const speaker = document.createElement('strong');
  const body = document.createElement('p');
  speaker.textContent = message.role === 'user' ? 'You' : 'VisionAssist';
  body.textContent = message.text;
  row.append(speaker,body);
  $('#conversation-log').append(row);
}

function scrollConversation() {
  const log = $('#conversation-log');
  log.scrollTop = log.scrollHeight;
}

function addMessage(role,text) {
  const message = {role,text};
  conversation.push(message);
  appendMessage(message);
  const log = $('#conversation-log');
  if (conversation.length > 1000) {
    conversation.shift();
    log.firstElementChild.remove();
  }
  scrollConversation();
  $('#conversation-empty').hidden = true;
  $('#export-conversation').disabled = exporting;
  if (role === 'assistant') $('#replay').disabled = false;
  try { sessionStorage.setItem('visionassist-conversation',JSON.stringify(conversation)); } catch {}
}

async function exportConversation() {
  const button = $('#export-conversation');
  if (!conversation.length || exporting) return false;
  exporting = true;
  button.disabled = true;
  $('#export-status').textContent = 'Preparing Word document…';
  try {
    const response = await agentFetch('/api/agent/export','POST',JSON.stringify({messages:conversation}));
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = 'VisionAssist-conversation.docx';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url),30000);
    $('#export-status').textContent = 'Word document ready.';
    return true;
  } catch (error) {
    $('#export-status').textContent = error.message;
    return false;
  } finally {
    exporting = false;
    button.disabled = false;
  }
}

function setReview(active) {
  if (active) $('#keyboard-input').open = true;
  else if (reviewing) {
    const keyboard = $('#keyboard-input');
    if (keyboard.contains(document.activeElement)) $('#mic').focus();
    keyboard.open = false;
  }
  reviewing = active;
  $('#discard-voice').hidden = !active;
}

function transcriptionLanguage() {
  const selected = $('#voice-language').value;
  if (selected !== 'system') return selected;
  const locale = navigator.language.toLowerCase().split('-')[0];
  return ['zh','en'].includes(locale) ? locale : 'auto';
}

function syncVoiceSettings(save = true) {
  const camera = $('#agent-camera');
  const language = $('#voice-language');
  const review = $('#review-voice');
  $('#describe').textContent = camera.value === 'both' ? 'Compare cameras' : 'Describe surroundings';
  const resolved = {zh:'Mandarin Chinese',en:'English',auto:'Auto detect'}[transcriptionLanguage()];
  $('#active-options').textContent = camera.selectedOptions[0].textContent + ' · ' +
    (language.value === 'system' ? 'System: ' : '') + resolved;
  if (!save) return;
  try {
    sessionStorage.setItem('visionassist-voice-settings',JSON.stringify({
      camera:camera.value,language:language.value,review:review.checked
    }));
  } catch {}
}

function restoreVoiceSettings() {
  let settings;
  try { settings = JSON.parse(sessionStorage.getItem('visionassist-voice-settings') || '{}'); }
  catch { settings = {}; }
  $('#agent-camera').value = ['both','A','B'].includes(settings?.camera) ? settings.camera : 'both';
  $('#voice-language').value = ['system','zh','en','auto'].includes(settings?.language) ? settings.language : 'system';
  $('#review-voice').checked = settings?.review === true;
  syncVoiceSettings(false);
}

function matchVoiceCommand(text) {
  const phrase = text.normalize('NFKC').toLowerCase().trim().replace(/[.!?。！？]+$/u,'');
  const chinese = phrase.replace(/[\s,，]/gu,'').replace(/^(?:请|請|帮我|幫我)/u,'');
  const camera = /^(?:只(?:看|用|开)|(?:(?:把)?(?:相机|相機|摄像头))?(?:切换|切換|换|換|调|調|改|设)(?:为|成|到)?)(?:只(?:看|用))?(左(?:边|邊|侧|側)?|右(?:边|邊|侧|側)?|a|b)(?:的)?(?:相机|相機|摄像头|画面|畫面)?$/iu.exec(chinese);
  if (camera) return {kind:'camera',value:/^[左a]/iu.test(camera[1]) ? 'A' : 'B'};
  const englishCamera = /^(?:please )?(?:only look|look only|only use|use only|use|switch to) (?:the )?(left|right|camera a|camera b)(?: (?:camera|feed|only))?$/iu.exec(phrase);
  if (englishCamera) return {kind:'camera',value:['left','camera a'].includes(englishCamera[1]) ? 'A' : 'B'};
  if (/^(?:(?:(?:切换|切換|换|換)(?:到|成)?|恢复|恢復|看|用|开启|打开)?(?:双相机|雙相機|双路|雙路|两个相机|兩個相機|两台相机|兩台相機|两路画面|雙畫面)(?:模式)?|两个都看|兩個都看|两边都看|兩邊都看)$/u.test(chinese) ||
      /^(?:please )?(?:use|show|look at|switch to) both (?:cameras|feeds)$/iu.test(phrase)) return {kind:'camera',value:'both'};

  const language = [
    ['zh',/^(?:(?:语音|語音|识别|識別)?语言|語言)?(?:切换|切換|设|改|换|換|用)(?:到|为|成)?(?:普通话|普通話|中文|汉语|漢語)(?:识别|識別)?$/u, /^(?:switch to|use) (?:mandarin(?: chinese)?|chinese)$/iu],
    ['en',/^(?:(?:语音|語音|识别|識別)?语言|語言)?(?:切换|切換|设|改|换|換|用)(?:到|为|成)?(?:英语|英語|英文)(?:识别|識別)?$/u, /^(?:switch to|use) english$/iu],
    ['system',/^(?:(?:语音|語音|识别|識別)?(?:语言|語言))?(?:恢复|恢復|使用|切换到)?(?:跟随|跟隨|跟着)?(?:系统|系統)(?:语言|語言)?$/u, /^(?:follow|use|switch to) (?:the )?system language$/iu],
    ['auto',/^(?:语言|語言)?(?:切换到|改成|开启|使用)?自动(?:识别|检测)(?:语言)?$/u, /^(?:use|enable|switch to) auto(?:matic)? (?:language )?detect(?:ion)?$/iu]
  ].find(([,zh,en]) => zh.test(chinese) || en.test(phrase));
  if (language) return {kind:'language',value:language[0]};

  const toggles = [
    ['review',true,/^(?:开启|打开|啟用|启用)(?:转写|轉寫)(?:确认|確認|审核|審核)$/u,/^(?:enable|turn on) transcription review$/iu],
    ['review',false,/^(?:关闭|關閉|取消)(?:转写|轉寫)(?:确认|確認|审核|審核)$/u,/^(?:disable|turn off) transcription review$/iu],
    ['contrast',true,/^(?:开启|打开|啟用|启用)高对比度$/u,/^(?:enable|turn on) high contrast$/iu],
    ['contrast',false,/^(?:关闭|關閉|取消)高对比度$/u,/^(?:disable|turn off) high contrast$/iu]
  ].find(([, ,zh,en]) => zh.test(chinese) || en.test(phrase));
  if (toggles) return {kind:toggles[0],value:toggles[1]};
  if (/^导出(?:这次|这段|本次)?对话(?:记录)?(?:为word)?$/iu.test(chinese) ||
      /^export (?:the |this )?conversation(?: to word)?$/iu.test(phrase)) return {kind:'export'};
  if (/^(?:结束|結束|停止)(?:这次|這次|语音|語音)?(?:对话|對話)$/u.test(chinese) ||
      /^(?:end|stop) (?:this |the )?(?:voice )?conversation$/iu.test(phrase)) return {kind:'stop'};
  return null;
}

function setContrast(enabled) {
  document.documentElement.toggleAttribute('data-contrast',enabled);
  $('#contrast').setAttribute('aria-pressed',String(enabled));
}

async function applyVoiceCommand(turn, question, command, speak) {
  const isChinese = /[\u3400-\u9fff]/u.test(question);
  const hadConversation = conversation.length > 0;
  addMessage('user',question);
  let reply;
  if (command.kind === 'export') {
    const ok = hadConversation && await exportConversation();
    reply = ok ? (isChinese ? '对话的 Word 文档已生成。' : 'Your Word document is ready.') :
      (isChinese ? '暂时没有可导出的对话，或导出未能完成。' : 'There is no earlier conversation to export, or the export could not finish.');
  } else if (command.kind === 'camera') {
    $('#agent-camera').value = command.value;
    syncVoiceSettings();
    const zh = {A:'已切换为只看左边相机 A。',B:'已切换为只看右边相机 B。',both:'已切换为同时看两台相机。'};
    const en = {A:'Now using only the left camera A.',B:'Now using only the right camera B.',both:'Now using both cameras.'};
    reply = (isChinese ? zh : en)[command.value];
  } else if (command.kind === 'language') {
    $('#voice-language').value = command.value;
    syncVoiceSettings();
    const zh = {system:'语音识别已切换为跟随系统语言。',auto:'语音识别已切换为自动检测语言。',zh:'语音识别已切换为普通话。',en:'语音识别已切换为英语。'};
    const en = {system:'Speech recognition now follows the system language.',auto:'Speech recognition now detects the language automatically.',zh:'Speech recognition is set to Mandarin Chinese.',en:'Speech recognition is set to English.'};
    reply = (isChinese ? zh : en)[command.value];
  } else if (command.kind === 'review' || command.kind === 'contrast') {
    if (command.kind === 'review') {
      $('#review-voice').checked = command.value;
      syncVoiceSettings();
    } else setContrast(command.value);
    const name = isChinese ? (command.kind === 'review' ? '转写确认' : '高对比度') :
      (command.kind === 'review' ? 'Transcription review' : 'High contrast');
    reply = isChinese ? (command.value ? '已开启' : '已关闭') + name + '。' :
      name + (command.value ? ' is on.' : ' is off.');
  } else if (command.kind === 'stop') {
    addMessage('assistant',isChinese ? '语音对话已结束。' : 'Voice conversation ended.');
    endConversation();
    return;
  }
  if (pendingTurn !== turn) return;
  // Voice controls should not dismiss a pending memory confirmation.
  $('#voice-message').textContent = '';
  addMessage('assistant',reply);
  if (speak) speakLocal(reply);
}

function beginTurn(prompt) {
  interruptTurn();
  pendingTurn = new AbortController();
  if (voiceSession) setVoiceState('Processing',prompt,'End conversation');
  $('#voice-message').textContent = prompt;
  return pendingTurn;
}

function completeTurn(turn) {
  if (pendingTurn !== turn) return;
  pendingTurn = undefined;
  if (voiceSession) resumeListening();
  else if (!speech) ready();
}

async function sendQuestion(turn, question, speak, mode) {
  const command = mode ? null : matchVoiceCommand(question);
  if (command) return applyVoiceCommand(turn,question,command,speak);
  addMessage('user',question);
  const response = await agentRequest('/api/agent/chat','POST',JSON.stringify({
    text:question, mode, camera_id:$('#agent-camera').value
  }),'application/json',turn.signal);
  if (pendingTurn !== turn || currentPage !== 'assist') return;
  renderReply(response);
  if (speak) speakLocal(response.reply_text);
  if ($('#memory-panel').open) refreshMemory();
}

async function answer(question, speak = false, mode) {
  if (warningActive) return;
  setReview(false);
  const turn = beginTurn('Waiting for the local assistant…');
  try { await sendQuestion(turn,question,speak,mode); }
  catch (error) {
    if (pendingTurn === turn) $('#voice-message').textContent = error.message;
  } finally { completeTurn(turn); }
}

function wavRecording(chunks, sampleRate) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength,0);
  const header = new DataView(new ArrayBuffer(44));
  header.setUint32(0,0x52494646);
  header.setUint32(4,36+length,true);
  header.setUint32(8,0x57415645);
  header.setUint32(12,0x666d7420);
  header.setUint32(16,16,true);
  header.setUint16(20,1,true);
  header.setUint16(22,1,true);
  header.setUint32(24,sampleRate,true);
  header.setUint32(28,sampleRate*2,true);
  header.setUint16(32,2,true);
  header.setUint16(34,16,true);
  header.setUint32(36,0x64617461);
  header.setUint32(40,length,true);
  return new Blob([header,...chunks],{type:'audio/wav'});
}

async function transcribeTurn(chunks, sampleRate) {
  const turn = beginTurn('Transcribing locally…');
  try {
    const audio = wavRecording(chunks,sampleRate);
    const language = transcriptionLanguage();
    const {text} = await agentRequest('/api/agent/transcribe?language='+language,'POST',audio,audio.type,turn.signal);
    if (pendingTurn !== turn) return;
    if (!text?.trim()) {
      $('#voice-message').textContent = 'No speech recognized. Try again.';
      return;
    }
    $('#question').value = text;
    if ($('#review-voice').checked && !matchVoiceCommand(text)) {
      setReview(true);
      setVoiceState('Review','Review the transcription before sending','End conversation');
      $('#voice-message').textContent = '';
      $('#question').focus();
      return;
    }
    setVoiceState('Processing','Waiting for the local assistant…','End conversation');
    $('#voice-message').textContent = '';
    await sendQuestion(turn,text,true);
  } catch (error) {
    if (pendingTurn === turn) $('#voice-message').textContent = error.message;
  } finally { completeTurn(turn); }
}

function readMicrophone(active, {samples,rms}) {
  if (voiceSession !== active || !active.listening) return;
  const segment = active.segment;
  const speaking = rms >= Math.max(0.006,segment.floor*2.7);
  if (!segment.chunks.length) {
    segment.lead.push(samples);
    if (segment.lead.length > 9) segment.lead.shift();
    if (!speaking) {
      segment.floor = Math.min(0.025, segment.floor*0.95 + rms*0.05);
      segment.onset = 0;
      return;
    }
    if (++segment.onset < 3) return;
    segment.chunks = segment.lead;
    segment.voiced = segment.onset;
    return;
  }
  segment.chunks.push(samples);
  if (speaking) { segment.voiced += 1; segment.quiet = 0; }
  else segment.quiet += 1;
  if (segment.quiet < 30 && segment.chunks.length < 780) return;
  if (segment.voiced < 5) {
    active.segment = {lead:[],chunks:[],onset:0,voiced:0,quiet:0,floor:segment.floor};
    return;
  }
  transcribeTurn(segment.chunks, active.context.sampleRate);
}

function showMicrophoneError(english, chinese) {
  stopAudio();
  $('#mic-error').textContent = transcriptionLanguage() === 'zh' ? chinese : english;
  $('#keyboard-input').open = true;
  $('#question').focus();
}

function endConversation() {
  stopAudio();
  $('#voice-message').textContent = 'Conversation ended.';
}

async function startVoice() {
  if (voiceSession) {
    endConversation();
    return;
  }
  if (speech) {
    stopPlayback('Playback stopped.');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
    showMicrophoneError('Microphone capture is unavailable in this browser. You can type your question.',
      '此浏览器无法录音。你可以打字提问。');
    return;
  }
  interruptTurn();
  let active;
  try {
    active = {context:new AudioContext({sampleRate:16000})};
    voiceSession = active;
    setVoiceState('Starting','Waiting for the microphone','End conversation');
    $('#mic-error').textContent = '';
    $('#voice-message').textContent = '';
    const audioReady = active.context.resume().then(() => true, () => false);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}
    });
    if (voiceSession !== active) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    active.stream = stream;
    pauseListening();
    if (!await audioReady) throw new Error('Audio capture did not start.');
    await active.context.audioWorklet.addModule('/voice-capture.js');
    if (voiceSession !== active) return;
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      if (voiceSession !== active) return;
      showMicrophoneError('Microphone disconnected. Reconnect it or type your question.',
        '麦克风已断开。你可以重新连接或打字提问。');
    });
    const capture = new AudioWorkletNode(active.context,'voice-capture');
    active.capture = capture;
    capture.port.onmessage = event => readMicrophone(active,event.data);
    active.source = active.context.createMediaStreamSource(stream);
    active.source.connect(capture).connect(active.context.destination);
    resumeListening();
  } catch (error) {
    if (active && voiceSession !== active) return;
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      showMicrophoneError('Microphone permission was denied. Allow it in your browser or type your question.',
        '浏览器未允许使用麦克风。你可以在浏览器中授权，或直接打字提问。');
    } else {
      showMicrophoneError('Microphone unavailable. Check that it is connected, or type your question.',
        '麦克风暂时不可用。请检查连接，或直接打字提问。');
    }
  }
}

async function finishConfirmation(accepted) {
  if (!confirmation) return;
  const selected = confirmation;
  const buttons = [...$('#confirm-memory').querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const result = await agentRequest('/api/agent/confirm','POST',JSON.stringify({
      id:selected.id,accepted,language:/[\u3400-\u9fff]/u.test(selected.summary) ? 'zh' : 'en'
    }));
    if (confirmation !== selected) return;
    addMessage('user',accepted ? 'Confirmed' : 'Cancelled');
    renderReply(result);
    $('#replay').focus();
    if ($('#memory-panel').open) refreshMemory();
  } catch (error) {
    $('#voice-message').textContent = error.message;
  } finally { buttons.forEach(button => { button.disabled = false; }); }
}

async function refreshMemory() {
  const kind = $('#memory-kind').value;
  const list = $('#memory-list');
  try {
    const {records} = await agentRequest('/api/memory/'+kind,'GET');
    if (kind !== $('#memory-kind').value) return;
    const rows = records.map(record => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'quiet';
      button.type = 'button';
      button.textContent = 'Delete';
      button.setAttribute('aria-label','Delete '+record.name);
      button.onclick = async () => {
        if (!window.confirm('Delete '+record.name+'?')) return;
        button.disabled = true;
        try {
          await agentRequest('/api/memory/'+kind+'/'+record.id,'DELETE');
          $('#memory-status').textContent = 'Deleted '+record.name+'.';
          $('#memory-kind').focus();
          refreshMemory();
        } catch (error) { $('#memory-status').textContent = error.message; button.disabled = false; }
      };
      row.append(record.name+(kind === 'people' && record.label ? ' · '+record.label : '')+' ',button);
      return row;
    });
    list.replaceChildren(...rows);
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No saved records.';
      list.append(empty);
    }
  } catch (error) {
    if (kind === $('#memory-kind').value) $('#memory-status').textContent = error.message;
  }
}

async function pollAlerts() {
  try {
    const {sequence,alerts} = await agentRequest('/api/agent/alerts?after='+alertSequence,'GET');
    alertSequence = sequence;
    if (alerts.length && Date.now() >= warningUntil) {
      const warning = alerts.findLast(alert => alert.risk === 'urgent') || alerts.at(-1);
      interruptTurn();
      warningUntil = Date.now()+3000;
      $('#obstacle-alert').textContent = warning.text;
      speakLocal(warning.text,true);
      setTimeout(() => {
        if ($('#obstacle-alert').textContent === warning.text && Date.now() >= warningUntil) $('#obstacle-alert').textContent = '';
      },3400);
    }
  } catch (error) {
    if (error.status === 403 || location.protocol === 'file:') return;
    if (error.status === 401) alertSequence = 0;
  }
  setTimeout(pollAlerts,450);
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
$('#contrast').addEventListener('click', () => setContrast(!document.documentElement.hasAttribute('data-contrast')));
$('#mic').addEventListener('click',startVoice);
$('#describe').addEventListener('click', () => {
  if ($('#agent-camera').value === 'both') answer('Compare the views from Camera A and Camera B.',true,'image');
  else answer('Describe surroundings',true,'scene');
});
['#agent-camera','#voice-language','#review-voice'].forEach(selector =>
  $(selector).addEventListener('change', () => syncVoiceSettings()));
window.addEventListener('languagechange', () => syncVoiceSettings(false));
restoreVoiceSettings();
$('#discard-voice').addEventListener('click', () => {
  setReview(false);
  $('#question').value = '';
  $('#mic').focus();
  resumeListening();
});
$('#export-conversation').addEventListener('click',exportConversation);
conversation.forEach(appendMessage);
$('#conversation-empty').hidden = Boolean(conversation.length);
$('#export-conversation').disabled = !conversation.length;
$('#replay').disabled = !conversation.some(message => message.role === 'assistant');
$('#replay').addEventListener('click',readAnswer);
$('#stop').addEventListener('click', () => stopPlayback('Playback stopped.'));
$('#question-form').addEventListener('submit', event => {
  event.preventDefault();
  const question = $('#question').value.trim();
  if (question) answer(question,reviewing);
  else $('#question').focus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || dialog.open || (!voiceSession && !speech)) return;
  if (voiceSession) endConversation();
  else stopPlayback('Playback stopped.');
});
window.addEventListener('pagehide', () => { stopAudio(); pollVersion += 1; });
window.addEventListener('pageshow', event => { if (event.persisted) refreshPolling(); });
window.addEventListener('hashchange',showPage);
makeAnnotations();
showPage();

$('#confirm-save').addEventListener('click',() => finishConfirmation(true));
$('#confirm-cancel').addEventListener('click',() => finishConfirmation(false));
$('#memory-kind').addEventListener('change',refreshMemory);
$('#memory-panel').addEventListener('toggle',event => { if (event.target.open) refreshMemory(); });
pollAlerts();
