import { connectAlerts } from "../alerts/alerts-controller";
import { connectModelCompute } from "./model-compute";
import { connectConversation } from "./conversation-controller";
import { createScope } from "../../shared/scope";
import { createAccessibility } from "../../shared/accessibility";
import { createDesktopSession } from "../../services/desktop-session";
import { createPerceptionController } from "../perception/perception-controller";
import { connectPairing } from "../pairing/pairing-controller";
import { connectCalibration } from "../calibration/calibration-controller";
import { createVisionMemoryView } from "./memory-view";
import { createVoiceMeter } from "./voice-meter";
import { matchVoiceCommand, wakeCommand } from "./commands";
import { wavRecording } from "./wav";

export function mountDesktop(root, voicePresentation) {
  const $ = selector => root.querySelector(selector);
  const scope = createScope();
  const {listen} = scope;
  const accessibility = createAccessibility(root, scope);
  const meter = createVoiceMeter($, accessibility);
  const session = createDesktopSession(scope);
  const {agentFetch, agentRequest} = session;
  const {addMessage, exportConversation, scrollConversation, latestReply, hasMessages} =
    connectConversation({$, scope, agentFetch});
  const isMonitor = () => currentPage === 'monitor';
  const perception = createPerceptionController({$, root, scope, session, isMonitor,
    onModeChange() { stopAudio(); $('#voice-message').textContent = ''; }});
  connectPairing({$, root, scope, session, accessibility, isMonitor, onPaired:perception.paired});
  connectCalibration({$, scope, session, accessibility});
  let voiceSession;
  let recoveryTimer;
  let speech;
  let currentPage;

  function showPage() {
    const hash = location.hash;
    if (hash === '#main') return;
    const page = hash === '#assist' ? 'assist' : 'monitor';
    root.querySelectorAll('[data-page]').forEach(node => { node.hidden = node.id !== page; });
    root.querySelectorAll('[data-route]').forEach(node => {
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
    perception.refreshPolling();
  }

  let pendingTurn;
  let latestTiming;
  let reviewing = false;
  let confirmation;
  let deferredReply;
  let warningActive = false;
  let warningAudioEnabled = false;
  let latestWarning;

  function setVoiceState(title, prompt, label) {
    voicePresentation.publish({title, prompt, label, stopLabel:speech ? 'Stop playback' : pendingTurn ? 'Cancel request' : 'Stop playback',
      canStop:Boolean(speech || pendingTurn)});
    if (!['Listening','Wake word'].includes(title)) meter.resetWave();
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

  async function speakLocal(text, warning = false, turn, event) {
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
      if (event && Date.now() >= event.deadline) {
        $('#warning-audio-status').textContent = 'The alert expired before speech was ready.';
        finish();
        return;
      }
      output.url = URL.createObjectURL(audio);
      output.audio = new Audio(output.url);
      output.audio.onended = () => finish();
      output.audio.onerror = () => finish('Local playback failed. The text is still available.');
      if (warning) output.audio.addEventListener('playing',() => {
        if (speech !== output) return;
        if (event && Date.now() >= event.deadline) {
          $('#warning-audio-status').textContent = 'The alert expired before speech was ready.';
          finish();
          return;
        }
        if (event) renderWarningTiming(event,Date.now());
        else {
          warningAudioEnabled = true;
          $('#warning-audio').textContent = 'Test warning audio';
        }
      },{once:true});
      await output.audio.play();
      if (turn && speech === output) {
        turn.audioMs = Math.round(performance.now()-turn.startedAt);
        renderTiming(turn);
      }
      if (!warning && speech === output) setVoiceState('Speaking',
        voiceSession ? 'Listening resumes after the reply' : 'Playing reply. Tap to stop playback.',label);
    } catch (error) {
      if (warning && speech === output) {
        $('#warning-audio-status').textContent = error.name === 'NotAllowedError'
          ? 'Browser blocked warning audio. Select Enable warning audio to try again.' :
          'Warning audio unavailable. Alerts remain visible.';
        if (error.name === 'NotAllowedError') {
          warningAudioEnabled = false;
          $('#warning-audio').textContent = 'Enable warning audio';
        }
      }
      finish(error.name === 'NotAllowedError' ? 'Playback was blocked by the browser. Use Read aloud to enable audio.' : error.message);
    }
  }

  function renderWarningTiming(event, started) {
    if (event !== latestWarning || !Number.isFinite(event.judged_ms)) return;
    const timing = $('#warning-timing');
    const capture = Number.isFinite(event.capture_ms);
    const origin = capture ? event.capture_ms : event.stamp;
    const source = capture ? 'Estimated capture' : 'Server receipt';
    const uncertainty = capture ? ' (±'+event.capture_error_ms+' ms)' : '';
    timing.hidden = false;
    timing.textContent = source + ' to judgment ' + Math.max(0,event.judged_ms-origin) + ' ms' + uncertainty +
      ' · judgment to dashboard ' + Math.max(0,event.received-event.judged_ms) + ' ms' +
      (started ? ' · ' + source.toLowerCase() + ' to speech start '+Math.max(0,started-origin)+' ms' : '');
  }

  listen($('#warning-audio'),'click',() => {
    if (speech) return;
    $('#warning-audio-status').textContent = '';
    const chinese = transcriptionLanguage() === 'zh';
    void speakLocal(chinese ? '语音提醒已就绪。' : 'Warning audio is ready.',true);
  });

  function readAnswer() {
    const last = latestReply();
    if (!last || warningActive) return;
    interruptTurn();
    speakLocal(last.text);
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

  function setContrast(enabled) {
    document.documentElement.toggleAttribute('data-contrast',enabled);
    $('#contrast').setAttribute('aria-pressed',String(enabled));
  }

  async function applyVoiceCommand(turn, question, command, speak) {
    const isChinese = /[\u3400-\u9fff]/u.test(question);
    const hadConversation = hasMessages();
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
    meter.updateWave(rms);
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
    const message = accessibility.requestError(error, 'Could not reach the local assistant. Check the server and try again.');
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
      listen(track, 'ended', () => {
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

  const {refresh:refreshMemory} = createVisionMemoryView({$, agentRequest, loadPreferences, accessibility, signal:scope.signal});

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

  listen($('#contrast'), 'click', () => setContrast(!document.documentElement.hasAttribute('data-contrast')));
  listen($('#mic'), 'click',() => startVoice());
  listen($('#wake-voice'), 'click',() => startVoice(true));
  listen($('#describe'), 'click', () => {
    const zh = transcriptionLanguage() === 'zh';
    if ($('#agent-camera').value === 'both') answer(zh ? '比较相机 A 和相机 B 的画面。' : 'Compare the views from Camera A and Camera B.',true,'image');
    else answer(zh ? '我前面有什么？' : 'What is in front of me?',true,'scene');
  });
  listen($('#recall-habits'), 'click', () =>
    answer(transcriptionLanguage() === 'zh' ? '我保存了哪些习惯？' : 'What habits have I saved?',true));
  root.querySelectorAll('[data-question]').forEach(button => {
    listen(button, 'click', () => {
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
    listen($(selector), 'change', () => syncVoiceSettings()));
  listen(window, 'languagechange', () => syncVoiceSettings(false));
  restoreVoiceSettings();
  listen($('#discard-voice'), 'click', () => {
    setReview(false);
    $('#question').value = '';
    $('#mic').focus();
    resumeListening();
  });
  listen($('#replay'), 'click',readAnswer);
  listen($('#stop'), 'click', () => {
    if (speech) stopPlayback('Playback stopped.');
    else cancelRequest();
  });
  listen($('#question-form'), 'submit', event => {
    event.preventDefault();
    const question = $('#question').value.trim();
    if (question) answer(question,reviewing);
    else $('#question').focus();
  });
  listen(document, 'keydown', event => {
    if (event.key !== 'Escape' || $('dialog[open]')) return;
    if (speech) stopPlayback('Playback stopped.');
    else if (pendingTurn) cancelRequest();
    else if (voiceSession) endConversation();
  });
  listen(window, 'offline', () => accessibility.toast('Network connection lost. The local server may still be reachable.'));
  listen(window, 'online', () => accessibility.toast('Network connection restored.'));
  listen(window, 'pagehide', () => { stopAudio(); perception.stopPolling(); });
  listen(window, 'pageshow', event => { if (event.persisted) perception.refreshPolling(); });
  listen(window, 'hashchange',showPage);
  showPage();

  listen($('#confirm-save'), 'click',() => finishConfirmation(true));
  listen($('#confirm-cancel'), 'click',() => finishConfirmation(false));
  listen($('#memory-kind'), 'change',refreshMemory);
  listen($('#memory-panel'), 'toggle',event => { if (event.target.open) refreshMemory(); });
  listen($('#preferences-panel'), 'toggle',event => {
    if (!event.target.open) return;
    $('#preferences-status').textContent = '';
    loadPreferences().catch(error => { $('#preferences-status').textContent = error.message; });
  });
  listen($('#preferences-form'), 'submit', async event => {
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
  connectModelCompute({$, scope, agentRequest});
  connectAlerts({$, scope, agentRequest, transcriptionLanguage, isAssist:() => currentPage === 'assist',
    isConversationBusy:segment => Boolean(pendingTurn || speech || reviewing || confirmation ||
      (segment === 'chunks' ? voiceSession?.segment?.chunks.length : voiceSession?.segment?.onset)),
    speakWarning(text,warning,canSpeak) {
      const received = Date.now();
      const event = latestWarning = {...warning,received,
        deadline:Math.min(warning.expires ?? Infinity,warning.judged_ms+1800,
          (warning.capture_ms ?? warning.stamp)+2500)};
      renderWarningTiming(event);
      if (!canSpeak || !warningAudioEnabled || received >= event.deadline) return;
      $('#warning-audio-status').textContent = '';
      pauseListening();
      clearTimeout(recoveryTimer);
      releaseSpeech();
      void speakLocal(text,true,undefined,event);
    },
    speakReminder:speakLocal
  });
  return () => {
    scope.dispose();
    perception.stopPolling();
    stopAudio();
  };
}
