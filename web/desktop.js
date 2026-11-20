const $ = selector => document.querySelector(selector);
const feeds = [...document.querySelectorAll('[data-camera]')].map(node => ({node, side:node.dataset.camera}));
const replySources = new Map([
  ['history','Historical observation'], ['memory','Saved memory'],
  ['yolo','Current detection'], ['camera','Recent camera frame'],
  ['unavailable','Unavailable']
]);
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
  const frame = image.parentElement;
  const size = node.querySelector('.frame-size');
  size.hidden = sampleMode || !connected;
  frame.toggleAttribute('data-has-pixels', !size.hidden);
  frame.tabIndex = !size.hidden && $('#camera-feeds').hasAttribute('data-actual-pixels') ? 0 : -1;
  if (!connected) {
    if (sampleMode) frame.style.removeProperty('--camera-aspect');
    if (feed.side === 'A') {
      if (sampleMode) $('#stereo-map').parentElement.style.removeProperty('--camera-aspect');
      VisionPerceptionView.showDepth(null, null, sampleMode);
    }
    feed.etag = undefined;
    image.getContext('2d').clearRect(0,0,image.width,image.height);
    delete image.dataset.frameId;
    const hadObjects = feed.objects != null;
    feed.objects = null;
    if (feed.side === 'A' || hadObjects) VisionPerceptionView.renderDetections(sampleMode, feeds);
  } else {
    const aspect = image.width + ' / ' + image.height;
    frame.style.setProperty('--camera-aspect', aspect);
    if (feed.side === 'A') $('#stereo-map').parentElement.style.setProperty('--camera-aspect', aspect);
    size.textContent = image.width + ' × ' + image.height + ' px';
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
    const path = '/api/preview/' + feed.side;
    const response = await fetch(path, {headers, signal:AbortSignal.timeout(3000)});
    if (version !== pollVersion || response.status === 304) return;
    if (response.status !== 200) {
      if (response.status === 401) token = undefined;
      setFeed(feed,false,response.status === 401 ? 'Session expired. Pair the phone again.' : undefined);
      return;
    }
    const snapshot = await response.json();
    if (snapshot.camera_id !== undefined && snapshot.camera_id !== feed.side) {
      throw new Error('Preview camera does not match the requested feed.');
    }
    const image = new Image();
    image.src = snapshot.png ? 'data:image/png;base64,' + snapshot.png : 'data:image/jpeg;base64,' + snapshot.jpeg;
    const depth = snapshot.depth_preview ? new Image() : null;
    if (depth) depth.src = 'data:image/png;base64,' + snapshot.depth_preview;
    await Promise.all([image.decode(), depth?.decode()]);
    if (version !== pollVersion) return;
    VisionPerceptionView.paintCamera(feed.node.querySelector('canvas'), image, snapshot);
    feed.etag = response.headers.get('etag');
    const hasDetections = feed.objects != null || snapshot.objects != null;
    feed.objects = snapshot.objects;
    if (feed.side === 'A') VisionPerceptionView.showDepth(snapshot, depth, sampleMode);
    setFeed(feed,true);
    if (snapshot.png) feed.node.querySelector('.frame-size').textContent += ' · Lossless PNG';
    if (snapshot.analysis_delayed) {
      feed.node.querySelector('.feed-summary').textContent = 'Live preview · analysis catching up';
    } else if (snapshot.road_edge?.point) {
      const meters = snapshot.road_edge.distance_m;
      feed.node.querySelector('.feed-summary').textContent = Number.isFinite(meters)
        ? 'Road edge ahead · '+meters.toFixed(1)+' m' : 'Possible road ahead · distance unavailable';
    }
    if (feed.side === 'A' || hasDetections) VisionPerceptionView.renderDetections(sampleMode, feeds);
  } catch {
    if (version !== pollVersion) return;
    setFeed(feed,false,'Connection interrupted');
  }
}

function refreshPolling() {
  const version = ++pollVersion;
  if (sampleMode || currentPage !== 'monitor') return;
  feeds.forEach(feed => setFeed(feed,false));
  if (!token) return;
  async function poll(feed) {
    if (version !== pollVersion) return;
    if (!token) { setFeed(feed,false,'Pair the phone again.'); return; }
    await readFrame(feed,version);
    if (version === pollVersion) setTimeout(() => poll(feed),feed.side === 'A' ? 150 : 220);
  }
  feeds.forEach(poll);
}

function renderMode(demo) {
  stopAudio();
  sampleMode = demo;
  $('#camera-feeds').toggleAttribute('data-live', !demo);
  $('#pixel-preview').hidden = demo;
  $('#mode').textContent = demo ? 'Show live cameras' : 'Show sample feeds';
  $('#detection-note').textContent = demo ? 'Sample annotations · distances are illustrative.' : 'Relative depth compares ground contacts. Forward depth is measured from Camera A using both phones.';
  $('#voice-message').textContent = '';
  feeds.forEach(feed => setFeed(feed,false));
  refreshPolling();
}

let pendingTurn;
let latestTiming;
let reviewing = false;
let exporting = false;
const conversation = readConversation();
let confirmation;
let alertSequence = 0;
let warningUntil = 0;
let deferredReply;
let warningActive = false;
let pendingReminder;

function setVoiceState(title, prompt, label) {
  VisionVoiceView.render(title, prompt, label, Boolean(speech || pendingTurn));
  $('#stop').textContent = speech ? 'Stop playback' : pendingTurn ? 'Cancel request' : 'Stop playback';
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
  if (active.waitingForWakeWord) {
    setVoiceState('Wake word','Say “Hey VisionAssist” or “你好，视觉助手”','Stop wake-word listening');
  } else {
    setVoiceState('Listening','Speak, then pause for a reply','End conversation');
  }
}

function interruptTurn() {
  pendingTurn?.controller.abort();
  pendingTurn = undefined;
  deferredReply = undefined;
  pauseListening();
  clearTimeout(recoveryTimer);
  releaseSpeech();
}

function stopAudio() {
  interruptTurn();
  setReview(false);
  const active = voiceSession;
  voiceSession = undefined;
  $('#wake-voice').setAttribute('aria-pressed','false');
  $('#wake-voice').textContent = 'Enable wake word';
  active?.stream?.getTracks().forEach(track => track.stop());
  active?.capture?.port.close();
  if (active && active.context.state !== 'closed') active.context.close().catch(() => {});
  ready();
}

function stopPlayback(message = '') {
  if (!speech) return;
  const restoreFocus = document.activeElement === $('#stop');
  const reply = warningActive && !message ? deferredReply : undefined;
  deferredReply = undefined;
  clearTimeout(recoveryTimer);
  releaseSpeech();
  if (reply) {
    speakLocal(reply.text,false,reply.turn);
    return;
  }
  if (!voiceSession) ready();
  else if (reviewing) setVoiceState('Review','Review the transcription before sending','End conversation');
  else if (!voiceSession.capture) setVoiceState('Starting','Waiting for the microphone','End conversation');
  else if (pendingTurn) setVoiceState('Processing','Waiting for the local assistant…','Cancel request');
  else resumeListening();
  if (restoreFocus) $('#mic').focus();
  if (message) $('#voice-message').textContent = message;
}

async function speakLocal(text, warning = false, turn) {
  if (!warning && warningActive) {
    deferredReply = {text,turn};
    return;
  }
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
    if (turn && speech === output) {
      turn.audioMs = Math.round(performance.now()-turn.startedAt);
      renderTiming(turn);
    }
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
    const result = await response.json().catch(() => ({}));
    if (response.status === 401 && token === auth) token = undefined;
    throw Object.assign(new Error(result.error || 'Local assistant unavailable. Try again.'),{status:response.status});
  }
  return response;
}

async function agentRequest(...args) {
  const response = await agentFetch(...args);
  return response.status === 204 ? null : response.json();
}

function renderTiming(turn) {
  if (turn !== latestTiming || turn.textMs == null) return;
  const timing = $('#response-timing');
  timing.hidden = false;
  timing.textContent = 'Text ready in '+turn.textMs+' ms' +
    (turn.audioMs == null ? '' : ' · Audio started in '+turn.audioMs+' ms');
}

function renderReply(result, turn) {
  confirmation = result.confirmation;
  $('#confirm-memory').hidden = !confirmation;
  $('#confirmation-summary').textContent = confirmation?.summary || '';
  $('#voice-message').textContent = '';
  addMessage('assistant',result.reply_text,result.source);
  if (turn) {
    turn.textMs = Math.round(performance.now()-turn.startedAt);
    renderTiming(turn);
  }
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
  row.append(speaker);
  const source = replySources.get(message.source);
  if (message.role === 'assistant' && source) {
    const label = document.createElement('span');
    label.className = 'status message-source';
    label.textContent = source;
    row.append(label);
  }
  row.append(body);
  $('#conversation-log').append(row);
}

function scrollConversation() {
  const log = $('#conversation-log');
  log.scrollTop = log.scrollHeight;
}

function addMessage(role,text,source) {
  const message = {role,text,source};
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
  $('#agent-camera').value = ['both','A','B'].includes(settings?.camera) ? settings.camera : 'A';
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

function beginTurn(prompt, startedAt = performance.now()) {
  if (warningActive) pauseListening();
  else interruptTurn();
  pendingTurn = {controller:new AbortController(),startedAt};
  latestTiming = pendingTurn;
  $('#response-timing').hidden = true;
  if (!warningActive) setVoiceState('Processing',prompt,'Cancel request');
  $('#voice-message').textContent = warningActive ? prompt : '';
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
  }),'application/json',turn.controller.signal);
  if (pendingTurn !== turn || currentPage !== 'assist') return;
  renderReply(response,turn);
  if (speak) speakLocal(response.reply_text,false,turn);
}

async function answer(question, speak = false, mode) {
  if (pendingTurn) return;
  setReview(false);
  const turn = beginTurn('Waiting for the local assistant…');
  try { await sendQuestion(turn,question,speak,mode); }
  catch (error) {
    if (pendingTurn === turn) showServiceError(error);
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

function wakeCommand(transcript) {
  const phrase = /^(?:(?:hey|hi|hello)[,\s]+vision\s*assist\b|(?:你好|您好)[，,\s]*(?:视觉助手|視覺助手|vision\s*assist\b))/iu;
  const text = transcript.trim();
  const match = phrase.exec(text);
  return match ? text.slice(match[0].length).replace(/^[\s,.!?:，。！？：]+/u,'') : null;
}

async function transcribeTurn(active, chunks, sampleRate, startedAt) {
  const turn = beginTurn('Transcribing locally…',startedAt);
  try {
    const audio = wavRecording(chunks,sampleRate);
    const language = active.waitingForWakeWord ? 'auto' : transcriptionLanguage();
    let {text} = await agentRequest('/api/agent/transcribe?language='+language,'POST',audio,audio.type,turn.controller.signal);
    if (pendingTurn !== turn) return;
    if (active.waitingForWakeWord) {
      const command = wakeCommand(text || '');
      $('#voice-message').textContent = '';
      if (command === null) return;
      active.waitingForWakeWord = false;
      $('#wake-voice').setAttribute('aria-pressed','false');
      $('#wake-voice').textContent = 'Enable wake word';
      if (!command) return;
      text = command;
    }
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
    if (pendingTurn === turn) showServiceError(error);
  } finally { completeTurn(turn); }
}

function readMicrophone(active, {samples,rms}) {
  if (voiceSession !== active || !active.listening) return;
  VisionVoiceView.updateWave(rms);
  const segment = active.segment;
  const speaking = rms >= Math.max(0.006,segment.floor*2.7);
  if (speaking) segment.lastVoiceAt = performance.now();
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
  const maxChunks = active.waitingForWakeWord ? 250 : 780;
  if (segment.quiet < 30 && segment.chunks.length < maxChunks) return;
  if (segment.voiced < 5) {
    active.segment = {lead:[],chunks:[],onset:0,voiced:0,quiet:0,floor:segment.floor};
    return;
  }
  transcribeTurn(active, segment.chunks, active.context.sampleRate, segment.lastVoiceAt);
}

function showMicrophoneError(english, chinese) {
  stopAudio();
  setVoiceState('Error','Microphone unavailable. Try again or type your question.','Retry microphone');
  $('#mic-error').textContent = transcriptionLanguage() === 'zh' ? chinese : english;
  $('#keyboard-input').open = true;
  $('#question').focus();
}

function showServiceError(error) {
  stopAudio();
  const message = VisionAccessibility.requestError(error, 'Could not reach the local assistant. Check the server and try again.');
  $('#voice-message').textContent = message;
  setVoiceState('Error','The request did not finish','Start conversation');
}

function endConversation() {
  stopAudio();
  $('#voice-message').textContent = 'Conversation ended.';
}

async function startVoice(waitingForWakeWord = false) {
  if (!waitingForWakeWord && speech) { stopPlayback('Playback stopped.'); return; }
  if (!waitingForWakeWord && pendingTurn) { cancelRequest(); return; }
  if (voiceSession && (!waitingForWakeWord || voiceSession.waitingForWakeWord)) {
    endConversation();
    return;
  }
  if (voiceSession) stopAudio();
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
    active = {context:new AudioContext({sampleRate:16000}),waitingForWakeWord};
    voiceSession = active;
    if (waitingForWakeWord) {
      $('#wake-voice').setAttribute('aria-pressed','true');
      $('#wake-voice').textContent = 'Stop wake-word listening';
    }
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

function cancelRequest() {
  if (!pendingTurn) return;
  const restoreFocus = document.activeElement === $('#stop');
  interruptTurn();
  if (voiceSession) resumeListening();
  else ready();
  if (restoreFocus) $('#mic').focus();
  $('#voice-message').textContent = 'Request cancelled.';
}

async function finishConfirmation(accepted) {
  if (!confirmation || pendingTurn) return;
  const selected = confirmation;
  const turn = beginTurn('Updating saved memory…');
  const buttons = [...$('#confirm-memory').querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const result = await agentRequest('/api/agent/confirm','POST',JSON.stringify({
      id:selected.id,accepted,language:/[\u3400-\u9fff]/u.test(selected.summary) ? 'zh' : 'en'
    }),'application/json',turn.controller.signal);
    if (confirmation !== selected || pendingTurn !== turn) return;
    addMessage('user',accepted ? 'Confirmed' : 'Cancelled');
    renderReply(result,turn);
    if (voiceSession) speakLocal(result.reply_text,false,turn);
    $('#replay').focus();
    if ($('#memory-panel').open) refreshMemory();
    if ($('#preferences-panel').open) loadPreferences().catch(error => { $('#preferences-status').textContent = error.message; });
  } catch (error) {
    if (pendingTurn === turn) $('#voice-message').textContent = error.message;
  } finally {
    completeTurn(turn);
    buttons.forEach(button => { button.disabled = false; });
  }
}

const {refresh:refreshMemory} = createVisionMemoryView({agentRequest, loadPreferences});

async function loadPreferences() {
  const form = $('#preferences-form');
  form.querySelector('button').disabled = true;
  const [preferences,{records}] = await Promise.all([
    agentRequest('/api/agent/preferences','GET'),agentRequest('/api/memory/habits','GET')
  ]);
  const select = $('#reminder-habit');
  select.replaceChildren(new Option('Off',''),...records.map(row => new Option(row.name,row.id)));
  select.value = preferences.habit ?? '';
  $('#reply-length').value = preferences.concise ? 'short' : 'detail';
  $('#reminder-interval').value = preferences.interval_minutes;
  form.querySelector('button').disabled = false;
}

let pendingRoadAlert;
let activeWarningRisk;
let lastCameraStates;
const lostCameras = new Set();
const receivingCamera = value => value === 'live' || value === 'detecting';
function updateCameraReadiness(cameras) {
  const status = $('#camera-readiness');
  const labels = {offline:'offline',waiting:'waiting for video',live:'live',detecting:'detecting objects'};
  const text = cameras
    ? ['A','B'].map(side => 'Camera '+side+' · '+(labels[cameras[side]] || 'unknown')).join('  /  ')
    : 'Camera status unavailable';
  if (status.textContent !== text) status.textContent = text;
  let warning = '';
  if (cameras) {
    for (const side of ['A','B']) {
      if (receivingCamera(cameras[side])) lostCameras.delete(side);
      else if (receivingCamera(lastCameraStates?.[side])) lostCameras.add(side);
    }
    lastCameraStates = cameras;
    warning = [...lostCameras].map(side =>
      'Camera ' + side + (cameras[side] === 'offline' ? ' disconnected.' : ' lost its video feed.')).join(' ');
  } else if (lastCameraStates && Object.values(lastCameraStates).some(receivingCamera)) {
    warning = 'Camera connection could not be checked. Reconnect and check the feeds.';
  }
  const alert = $('#connection-alert');
  if (alert.textContent !== warning) alert.textContent = warning;
}

async function pollAlerts() {
  try {
    const allowReminder = currentPage === 'assist';
    const {sequence,alerts,reminder,cameras} = await agentRequest('/api/agent/alerts?after='+alertSequence+
      (allowReminder ? '&reminders=1' : ''),'GET');
    updateCameraReadiness(cameras);
    if (reminder && allowReminder) pendingReminder = {text:reminder,until:Date.now()+15_000};
    if (!allowReminder || pendingReminder?.until < Date.now()) pendingReminder = undefined;
    alertSequence = sequence;
    const road = alerts.filter(alert => alert.kind === 'road_edge').at(-1);
    if (road) pendingRoadAlert = road;
    if (pendingRoadAlert && Date.now()-pendingRoadAlert.stamp >= 5000) pendingRoadAlert = undefined;
    const intrusion = alerts.filter(alert => alert.kind === 'path_intrusion' && alert.expires > Date.now())
      .sort((a,b) => a.expires-b.expires)[0];
    const others = alerts.filter(alert => alert.kind !== 'road_edge' && alert.kind !== 'path_intrusion');
    const warning = pendingRoadAlert?.risk === 'urgent' ? pendingRoadAlert :
      others.findLast(alert => alert.risk === 'urgent') || intrusion || pendingRoadAlert || others.at(-1);
    if (warning && (Date.now() >= warningUntil ||
        ((warning.risk === 'urgent' || warning.kind === 'path_intrusion') && activeWarningRisk !== 'urgent'))) {
      activeWarningRisk = warning.risk;
      if (warning === pendingRoadAlert) pendingRoadAlert = undefined;
      const text = transcriptionLanguage() === 'zh' && warning.text_zh ? warning.text_zh : warning.text;
      warningUntil = Date.now()+3000;
      $('#obstacle-alert').textContent = text;
      const conversationInUse = pendingTurn || speech || reviewing || confirmation || voiceSession?.segment?.chunks.length;
      if (warning.risk === 'urgent' || !conversationInUse) {
        pauseListening();
        clearTimeout(recoveryTimer);
        releaseSpeech();
        speakLocal(text,true);
      }
      setTimeout(() => {
        if ($('#obstacle-alert').textContent === text && Date.now() >= warningUntil) $('#obstacle-alert').textContent = '';
      },3400);
    } else if (pendingReminder && currentPage === 'assist' && !pendingTurn &&
        !speech && !reviewing && !confirmation && !voiceSession?.segment?.onset && Date.now() >= warningUntil) {
      const prefix = transcriptionLanguage() === 'zh' ? '提醒：' : 'Reminder: ';
      const message = prefix + pendingReminder.text;
      pendingReminder = undefined;
      $('#voice-message').textContent = message;
      speakLocal(message);
    }
  } catch (error) {
    updateCameraReadiness();
    if (error.status === 403 || location.protocol === 'file:') return;
    if (error.status === 401) {
      alertSequence = 0;
      pendingReminder = undefined;
      pendingRoadAlert = undefined;
    }
  }
  setTimeout(pollAlerts,450);
}
const dialog = $('#pair-dialog');
const pairButtons = [...document.querySelectorAll('[data-pair]')];
const copyCode = $('#copy-code');
function openPairDialog(event) {
  $('#phone-address').textContent = location.protocol === 'file:'
    ? 'Start the local server to enable pairing. See README.md.'
    : new URL('/camera',location.href).href;
  $('#pair-result').textContent = '';
  $('#copy-status').textContent = '';
  copyCode.hidden = true;
  VisionAccessibility.openDialog(dialog,event);
}
$('#pair').addEventListener('click',openPairDialog);
$('#assist-pair').addEventListener('click',openPairDialog);
pairButtons.forEach(button => button.addEventListener('click', async () => {
  const version = ++pairingVersion;
  const result = $('#pair-result');
  pairButtons.forEach(control => { control.disabled = true; });
  copyCode.hidden = true;
  $('#copy-status').textContent = '';
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
    copyCode.dataset.code = codeResponse.code;
    copyCode.hidden = !navigator.clipboard?.writeText;
    if (currentPage === 'monitor') {
      if (sampleMode) renderMode(false);
      else refreshPolling();
    }
  } catch (error) {
    if (version === pairingVersion) result.textContent = VisionAccessibility.requestError(error,'Could not reach the pairing service.');
  } finally {
    pairButtons.forEach(control => { control.disabled = false; });
    if (version === pairingVersion && dialog.open) button.focus();
  }
}));
copyCode.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(copyCode.dataset.code);
    $('#copy-status').textContent = 'Pairing code copied.';
  } catch {
    $('#copy-status').textContent = 'Could not copy. Enter the displayed code on the phone.';
  }
});
dialog.addEventListener('close', () => {
  pairingVersion += 1;
  delete copyCode.dataset.code;
});
$('#mode').addEventListener('click', () => renderMode(!sampleMode));
$('#pixel-preview').addEventListener('click', event => {
  const active = $('#camera-feeds').toggleAttribute('data-actual-pixels');
  event.currentTarget.setAttribute('aria-pressed', String(active));
  document.querySelectorAll('.camera-frame[data-has-pixels]').forEach(frame => {
    frame.tabIndex = active ? 0 : -1;
  });
});
$('#contrast').addEventListener('click', () => setContrast(!document.documentElement.hasAttribute('data-contrast')));
$('#mic').addEventListener('click',() => startVoice());
$('#wake-voice').addEventListener('click',() => startVoice(true));
$('#describe').addEventListener('click', () => {
  const zh = transcriptionLanguage() === 'zh';
  if ($('#agent-camera').value === 'both') answer(zh ? '比较相机 A 和相机 B 的画面。' : 'Compare the views from Camera A and Camera B.',true,'image');
  else answer(zh ? '我前面有什么？' : 'What is in front of me?',true,'scene');
});
$('#recall-habits').addEventListener('click', () =>
  answer(transcriptionLanguage() === 'zh' ? '我保存了哪些习惯？' : 'What habits have I saved?',true));
document.querySelectorAll('[data-question]').forEach(button => {
  button.addEventListener('click', () => {
    if (pendingTurn || reviewing) return;
    const templates = transcriptionLanguage() === 'zh'
      ? {find:'帮我找我的',register:'登记物品：',remember:'记住，'}
      : {find:'Where is my ',register:'Register item ',remember:'Remember, '};
    $('#keyboard-input').open = true;
    const input = $('#question');
    input.value = templates[button.dataset.question];
    input.focus();
    input.setSelectionRange(input.value.length,input.value.length);
  });
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
$('#stop').addEventListener('click', () => {
  if (speech) stopPlayback('Playback stopped.');
  else cancelRequest();
});
$('#question-form').addEventListener('submit', event => {
  event.preventDefault();
  const question = $('#question').value.trim();
  if (question) answer(question,reviewing);
  else $('#question').focus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('dialog[open]')) return;
  if (speech) stopPlayback('Playback stopped.');
  else if (pendingTurn) cancelRequest();
  else if (voiceSession) endConversation();
});
window.addEventListener('offline', () => VisionAccessibility.toast('Network connection lost. The local server may still be reachable.'));
window.addEventListener('online', () => VisionAccessibility.toast('Network connection restored.'));
window.addEventListener('pagehide', () => { stopAudio(); pollVersion += 1; });
window.addEventListener('pageshow', event => { if (event.persisted) refreshPolling(); });
window.addEventListener('hashchange',showPage);
VisionPerceptionView.makeAnnotations(feeds);
VisionPerceptionView.renderDetections(sampleMode, feeds);
showPage();

$('#confirm-save').addEventListener('click',() => finishConfirmation(true));
$('#confirm-cancel').addEventListener('click',() => finishConfirmation(false));
$('#memory-kind').addEventListener('change',refreshMemory);
$('#memory-panel').addEventListener('toggle',event => { if (event.target.open) refreshMemory(); });
$('#preferences-panel').addEventListener('toggle',event => {
  if (!event.target.open) return;
  $('#preferences-status').textContent = '';
  loadPreferences().catch(error => { $('#preferences-status').textContent = error.message; });
});
$('#preferences-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    await agentRequest('/api/agent/preferences','PUT',JSON.stringify({
      concise:$('#reply-length').value === 'short',
      habit:Number($('#reminder-habit').value) || null,
      interval_minutes:Number($('#reminder-interval').value)
    }));
    $('#preferences-status').textContent = 'Preferences saved.';
  } catch (error) {
    $('#preferences-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
pollAlerts();
