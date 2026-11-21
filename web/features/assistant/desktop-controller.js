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
  const pairing = connectPairing({$, root, scope, session, accessibility, isMonitor, onPaired:perception.paired});
  connectCalibration({$, scope, session, accessibility});
  let voiceSession;
  let recoveryTimer;
  let voiceIdleTimer;
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
  let warningActive = false;
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
    clearTimeout(voiceIdleTimer);
    if (!voiceSession) return;
    discardVisualTurn(voiceSession.segment?.visualTurn);
    voiceSession.listening = false;
    voiceSession.segment = null;
    voiceSession.stream?.getAudioTracks().forEach(track => { track.enabled = false; });
  }

  function resumeListening() {
    const active = voiceSession;
    if (!active?.capture || active.listening || pendingTurn || speech) return;
    active.segment = {lead:[], chunks:[], onset:0, voiced:0, quiet:0, floor:0.002};
    active.stream.getAudioTracks().forEach(track => { track.enabled = true; });
    active.listening = true;
    if (active.waitingForWakeWord) {
      setVoiceState('Wake word','Say “Hey VisionAssist” or “你好，视觉助手”','Stop wake-word listening');
    } else {
      setVoiceState(reviewing ? 'Review' : 'Listening',reviewing
        ? 'Say “send the transcript” or “discard the transcript”' : 'Speak, then pause for a reply','End conversation');
      armVoiceIdle(active);
    }
  }

  function listenForInterrupt(owner, purpose) {
    if (!voiceSession?.capture || voiceSession.waitingForWakeWord) return;
    owner.interruptInput = {purpose,lead:[],chunks:[],voiced:0,quiet:0,busy:false};
    voiceSession.stream.getAudioTracks().forEach(track => { track.enabled = true; });
  }

  function armVoiceIdle(active) {
    if (active.waitingForWakeWord) return;
    clearTimeout(voiceIdleTimer);
    voiceIdleTimer = setTimeout(() => {
      if (voiceSession === active && active.listening) endConversation();
    },confirmation || reviewing ? 45_000 : 15_000);
  }

  function updateWakeControl(enabled) {
    $('#wake-voice').setAttribute('aria-pressed',String(enabled));
    $('#wake-voice').textContent = enabled ? 'Disable hands-free wake word' : 'Enable wake word';
  }

  function interruptTurn() {
    pendingTurn?.controller.abort();
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
    updateWakeControl(false);
    active?.stream?.getTracks().forEach(track => track.stop());
    active?.capture?.port.close();
    if (active && active.context.state !== 'closed') active.context.close().catch(() => {});
    ready();
  }

  function stopPlayback(message = '') {
    if (!speech) return;
    const restoreFocus = document.activeElement === $('#stop');
    clearTimeout(recoveryTimer);
    pauseListening();
    releaseSpeech();
    if (!voiceSession) ready();
    else if (!voiceSession.capture) setVoiceState('Starting','Waiting for the microphone','End conversation');
    else if (pendingTurn) setVoiceState('Processing','Waiting for the local assistant…','Cancel request');
    else resumeListening();
    if (restoreFocus) $('#mic').focus();
    if (message) $('#voice-message').textContent = message;
  }

  async function speakLocal(text, warning = false, turn) {
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
      if (!warning && speech === output) listenForInterrupt(output,'stop');
      if (turn && speech === output) {
        turn.audioMs = Math.round(performance.now()-turn.startedAt);
        renderTiming(turn);
      }
      if (!warning && speech === output) setVoiceState('Speaking',
        voiceSession ? 'Say “stop playback” to interrupt the reply' : 'Playing reply. Tap to stop playback.',label);
    } catch (error) {
      if (warning && speech === output) {
        $('#warning-audio-status').textContent = error.name === 'NotAllowedError'
          ? 'Browser blocked warning audio. Select Test warning audio to try again.' :
          'Warning audio unavailable. Alerts remain visible.';
      }
      finish(error.name === 'NotAllowedError' ? 'Playback was blocked by the browser. Use Read aloud to enable audio.' : error.message);
    }
  }

  function renderWarningTiming(event) {
    if (event !== latestWarning || !Number.isFinite(event.judged_ms)) return;
    const timing = $('#warning-timing');
    const capture = Number.isFinite(event.capture_ms);
    const origin = capture ? event.capture_ms : event.stamp;
    const source = capture ? 'Estimated capture' : 'Server receipt';
    const uncertainty = capture ? ' (±'+event.capture_error_ms+' ms)' : '';
    timing.hidden = false;
    timing.textContent = source + ' to judgment ' + Math.max(0,event.judged_ms-origin) + ' ms' + uncertainty +
      ' · judgment to dashboard ' + Math.max(0,event.received-event.judged_ms) + ' ms';
  }

  listen($('#warning-audio'),'click',() => {
    if (speech || pendingTurn) return;
    $('#warning-audio-status').textContent = '';
    const chinese = transcriptionLanguage() === 'zh';
    void speakLocal(chinese ? '这是告警音频测试。' : 'This is a warning audio test.',true);
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

  function setContrast(enabled) {
    document.documentElement.toggleAttribute('data-contrast',enabled);
    $('#contrast').setAttribute('aria-pressed',String(enabled));
  }

  async function applyVoiceCommand(turn, question, command, speak) {
    const isChinese = /[\u3400-\u9fff]/u.test(question);
    if (command.kind === 'confirm' && confirmation) {
      return finishConfirmation(command.value,turn,question,speak);
    }
    if (command.kind === 'sendReview' || command.kind === 'discardReview' || (command.kind === 'confirm' && reviewing)) {
      if (!reviewing) return;
      const draft = $('#question').value.trim();
      const send = command.kind === 'sendReview' || command.value === true;
      setReview(false);
      $('#question').value = '';
      turn.visualId = undefined;
      if (send && draft) return sendQuestion(turn,draft,speak);
      $('#voice-message').textContent = isChinese ? '已丢弃转写。' : 'Transcript discarded.';
      return;
    }
    if (command.kind === 'replay') {
      const last = latestReply();
      if (last) await speakLocal(last.text);
      else $('#voice-message').textContent = isChinese ? '还没有可以重播的回答。' : 'There is no reply to replay.';
      return;
    }
    if (command.kind === 'stopPlayback') return;
    if (command.kind === 'readPair') {
      const code = pairing.currentCode();
      if (code && speak) await speakLocal([...code].map(digit => isChinese ? '零一二三四五六七八九'[Number(digit)] : digit)
        .join(isChinese ? '，' : ', '),false,turn);
      else $('#voice-message').textContent = isChinese ? '当前没有配对码。' : 'There is no current pairing code.';
      return;
    }
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
    } else if (command.kind === 'pair') {
      if (!command.value) {
        pairing.open();
        reply = isChinese ? '请说「生成相机 A 的配对码」或「生成相机 B 的配对码」。'
          : 'Say generate a pairing code for Camera A or Camera B.';
      } else {
        const code = await pairing.generate(command.value);
        const digits = code && (isChinese ? [...code].map(digit => '零一二三四五六七八九'[Number(digit)]).join('，') : [...code].join(', '));
        reply = code ? (isChinese ? '相机 '+command.value+' 的配对码是 '+digits+'。五分钟内有效。'
          : 'Camera '+command.value+' pairing code is '+digits+'. It expires in five minutes.') :
          (isChinese ? '暂时无法生成配对码。' : 'Could not make a pairing code.');
        if (pendingTurn === turn && speak) await speakLocal(reply,false,turn);
        return;
      }
    } else if (command.kind === 'closePair') {
      pairing.close();
      reply = isChinese ? '已关闭配对窗口。' : 'Pairing closed.';
    } else if (command.kind === 'copyPair') {
      reply = await pairing.copy() ? (isChinese ? '已复制配对码。' : 'Pairing code copied.') :
        (isChinese ? '未能复制配对码。可以请我再读一次。' : 'Could not copy the code.');
    } else if (command.kind === 'usb' || command.kind === 'usbSlot') {
      const result = await pairing.usb(command);
      reply = typeof result === 'string' && result ? result : result ?
        (isChinese ? '有线相机设置已选定。' : 'USB camera setting selected.') :
        (isChinese ? '当前没有可用的有线相机选项。' : 'That USB camera option is unavailable.');
    } else if (command.kind === 'preference' || command.kind === 'savePreferences') {
      reply = await applyReplyPreference(command,isChinese);
    } else if (command.kind === 'panel') {
      $('#'+command.value).open = command.open;
      reply = isChinese ? (command.open ? '已打开。' : '已关闭。') : (command.open ? 'Opened.' : 'Closed.');
    } else if (command.kind === 'wakeSetting') {
      if (voiceSession) {
        voiceSession.handsFree = command.value;
        updateWakeControl(command.value);
      }
      reply = voiceSession
        ? (isChinese ? (command.value ? '已开启免提唤醒。' : '已关闭免提唤醒。') : (command.value ? 'Hands-free wake enabled.' : 'Hands-free wake disabled.'))
        : (isChinese ? '请先开启麦克风。' : 'First enable your microphone.');
    } else if (command.kind === 'motion') {
      accessibility.setReducedMotion(command.value);
      reply = isChinese ? (command.value ? '已开启减少动画。' : '已恢复动画设置。') : 'Motion preference updated.';
    } else if (command.kind === 'help') {
      reply = isChinese ? '你可以说播报附近、比较两路画面、登记物品、确认、查已保存记忆、生成相机配对码、导出对话、再读一遍，或者结束对话。' :
        'Say describe surroundings, compare cameras, register an item, confirm, list saved memory, generate a pairing code, export, repeat the answer, or end conversation.';
    } else if (command.kind === 'confirm') {
      reply = isChinese ? '现在没有待确认的操作。' : 'There is no action to confirm.';
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

  function beginTurn(prompt, startedAt = performance.now(), showProgress = true) {
    interruptTurn();
    pendingTurn = {controller:new AbortController(),startedAt};
    latestTiming = pendingTurn;
    $('#response-timing').hidden = true;
    if (showProgress) {
      setVoiceState('Processing',prompt,'Cancel request');
      $('#voice-message').textContent = '';
    }
    return pendingTurn;
  }

  function completeTurn(turn) {
    if (pendingTurn !== turn) return;
    pendingTurn = undefined;
    if (voiceSession) resumeListening();
    else if (!speech) ready();
  }

  async function sendQuestion(turn, question, speak, mode, cameraId = $('#agent-camera').value) {
    const command = mode ? null : matchVoiceCommand(question);
    if (command) return applyVoiceCommand(turn,question,command,speak);
    addMessage('user',question);
    listenForInterrupt(turn,'cancel');
    let response;
    try {
      response = await agentRequest('/api/agent/chat','POST',JSON.stringify({
        text:question, mode, camera_id:cameraId, voice_turn:turn.visualId
      }),'application/json',turn.controller.signal);
    } finally {
      if (pendingTurn === turn && turn.interruptInput) pauseListening();
      delete turn.interruptInput;
    }
    if (pendingTurn !== turn || currentPage !== 'assist') return;
    renderReply(response,turn);
    if (speak) speakLocal(response.reply_text+(response.confirmation
      ? (/[\u3400-\u9fff]/u.test(response.reply_text) ? '。请说确认或取消。' : ' Say confirm or cancel.')
      : ''),false,turn);
  }

  async function answer(question, speak = false, mode, cameraId) {
    if (pendingTurn) return;
    setReview(false);
    const turn = beginTurn('Waiting for the local assistant…');
    try { await sendQuestion(turn,question,speak,mode,cameraId); }
    catch (error) {
      if (pendingTurn === turn) showServiceError(error);
    } finally { completeTurn(turn); }
  }

  function captureVisualTurn() {
    const id = crypto.randomUUID();
    const path = '/api/agent/voice-frames?id='+id;
    const ready = agentRequest(path,'POST',undefined,undefined,AbortSignal.timeout(1800))
      .then(() => true,() => false);
    return {id,path,ready};
  }

  function discardVisualTurn(visual) {
    if (visual) void visual.ready.then(ready => {
      if (ready) return agentRequest(visual.path,'DELETE',undefined,undefined,AbortSignal.timeout(1800));
    }).catch(() => {});
  }

  async function transcribeTurn(active, chunks, sampleRate, startedAt, visual) {
    const waitingForWakeWord = active.waitingForWakeWord;
    const turn = beginTurn('Transcribing locally…',startedAt,!waitingForWakeWord);
    try {
      const audio = wavRecording(chunks,sampleRate);
      let language = transcriptionLanguage();
      if (waitingForWakeWord) {
        language = language === 'auto' ? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en') : language;
        const {matched} = await agentRequest('/api/agent/wake?language='+language,'POST',audio,audio.type,turn.controller.signal);
        if (pendingTurn !== turn || !matched) return;
        active.waitingForWakeWord = false;
        visual = captureVisualTurn();
        $('#voice-message').textContent = '';
        setVoiceState('Processing','Transcribing locally…','End conversation');
      }
      if (visual) void visual.ready.then(ready => {
        if (ready) return agentRequest(visual.path,'PUT',undefined,undefined,AbortSignal.timeout(1800));
      }).catch(() => {});
      let {text,ignored} = await agentRequest('/api/agent/transcribe?language='+language,'POST',audio,audio.type,turn.controller.signal);
      if (pendingTurn !== turn || ignored) return;
      if (waitingForWakeWord) {
        text = wakeCommand(text || '');
        if (!text) return;
      }
      if (!text?.trim()) {
        $('#voice-message').textContent = 'No speech recognized. Try again.';
        return;
      }
      const command = matchVoiceCommand(text);
      if (reviewing && !command) {
        $('#voice-message').textContent = language === 'zh' ? '请说发送转写或丢弃转写。' : 'Say send or discard the transcript.';
        return;
      }
      if (!reviewing) $('#question').value = text;
      if ($('#review-voice').checked && !command) {
        setReview(true);
        setVoiceState('Review','Review the transcription before sending','End conversation');
        $('#voice-message').textContent = '';
        $('#question').focus();
        speakLocal(language === 'zh' || /[\u3400-\u9fff]/u.test(text)
          ? '听到：'+text.slice(0,200)+'。请说发送转写或丢弃转写。'
          : 'I heard: '+text.slice(0,200)+'. Say send the transcript or discard the transcript.');
        return;
      }
      setVoiceState('Processing','Waiting for the local assistant…','End conversation');
      $('#voice-message').textContent = '';
      if (visual && await visual.ready) turn.visualId = visual.id;
      if (pendingTurn !== turn) return;
      await sendQuestion(turn,text,true);
    } catch (error) {
      if (pendingTurn === turn) showServiceError(error);
    } finally { discardVisualTurn(visual); completeTurn(turn); }
  }

  function readInterrupt(owner, active, samples, rms) {
    const input = owner.interruptInput;
    if (!input || input.busy) return;
    const voiced = rms >= .012;
    if (!input.chunks.length) {
      input.lead.push(samples);
      if (input.lead.length > 6) input.lead.shift();
      if (!voiced) return;
      input.chunks = input.lead;
    } else input.chunks.push(samples);
    if (voiced) {input.voiced++;input.quiet=0;}
    else input.quiet++;
    if (input.quiet < 8 && input.chunks.length < 70) return;
    const chunks = input.chunks;
    const enoughSpeech = input.voiced >= 6;
    input.lead = [];
    input.chunks = [];
    input.voiced = input.quiet = 0;
    if (!enoughSpeech) return;
    input.busy = true;
    const language = transcriptionLanguage();
    const selected = language === 'auto' ? (navigator.language.startsWith('zh') ? 'zh' : 'en') : language;
    const audio = wavRecording(chunks,active.context.sampleRate);
    agentRequest('/api/agent/wake?purpose='+input.purpose+'&language='+selected,'POST',audio,audio.type,owner.controller.signal)
      .then(({matched}) => {
        if (!matched || owner.interruptInput !== input) return;
        if (input.purpose === 'stop' && speech === owner) stopPlayback('Playback stopped.');
        if (input.purpose === 'cancel' && pendingTurn === owner) cancelRequest();
      }).catch(() => {}).finally(() => {input.busy=false;});
  }

  function readMicrophone(active, {samples,rms}) {
    if (voiceSession !== active) return;
    if (speech?.interruptInput) return readInterrupt(speech,active,samples,rms);
    if (pendingTurn?.interruptInput) return readInterrupt(pendingTurn,active,samples,rms);
    if (!active.listening) return;
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
      clearTimeout(voiceIdleTimer);
      segment.chunks = segment.lead;
      segment.voiced = segment.onset;
      if (!active.waitingForWakeWord) segment.visualTurn = captureVisualTurn();
      return;
    }
    segment.chunks.push(samples);
    if (speaking) { segment.voiced += 1; segment.quiet = 0; }
    else segment.quiet += 1;
    const maxChunks = active.waitingForWakeWord ? 250 : 780;
    if (segment.quiet < 30 && segment.chunks.length < maxChunks) return;
    if (segment.voiced < 5) {
      discardVisualTurn(segment.visualTurn);
      active.segment = {lead:[],chunks:[],onset:0,voiced:0,quiet:0,floor:segment.floor};
      armVoiceIdle(active);
      return;
    }
    const visual = segment.visualTurn;
    segment.visualTurn = undefined;
    transcribeTurn(active, segment.chunks, active.context.sampleRate, segment.lastVoiceAt,visual);
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
    const active = voiceSession;
    if (active?.handsFree && !active.waitingForWakeWord) {
      interruptTurn();
      setReview(false);
      active.waitingForWakeWord = true;
      resumeListening();
      $('#voice-message').textContent = 'Conversation ended. Waiting for the wake word.';
    } else {
      stopAudio();
      $('#voice-message').textContent = 'Conversation ended.';
    }
  }

  async function startVoice(waitingForWakeWord = false) {
    if (waitingForWakeWord && voiceSession?.handsFree) {
      stopAudio();
      return;
    }
    if (!waitingForWakeWord && voiceSession?.waitingForWakeWord) {
      const active = voiceSession;
      interruptTurn();
      active.waitingForWakeWord = false;
      resumeListening();
      return;
    }
    if (voiceSession && !waitingForWakeWord) {
      endConversation();
      return;
    }
    if (!waitingForWakeWord && pendingTurn) { cancelRequest(); return; }
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
      active = {context:new AudioContext({sampleRate:16000}),waitingForWakeWord,handsFree:waitingForWakeWord};
      voiceSession = active;
      updateWakeControl(waitingForWakeWord);
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

  async function finishConfirmation(accepted, existingTurn, question, speak = Boolean(voiceSession)) {
    if (!confirmation || (pendingTurn && pendingTurn !== existingTurn)) return;
    const selected = confirmation;
    const turn = existingTurn ?? beginTurn('Updating saved memory…');
    const buttons = [...$('#confirm-memory').querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    try {
      const result = await agentRequest('/api/agent/confirm','POST',JSON.stringify({
        id:selected.id,accepted,language:/[\u3400-\u9fff]/u.test(selected.summary) ? 'zh' : 'en'
      }),'application/json',turn.controller.signal);
      if (confirmation !== selected || pendingTurn !== turn) return;
      addMessage('user',question ?? (accepted ? 'Confirmed' : 'Cancelled'));
      renderReply(result,turn);
      if (speak) speakLocal(result.reply_text,false,turn);
      if (!existingTurn) $('#replay').focus();
      if ($('#memory-panel').open) refreshMemory();
      if ($('#preferences-panel').open) loadPreferences().catch(error => { $('#preferences-status').textContent = error.message; });
    } catch (error) {
      if (pendingTurn === turn) $('#voice-message').textContent = error.message;
    } finally {
      if (!existingTurn) completeTurn(turn);
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

  function preferenceFields() {
    return {concise:$('#reply-length').value === 'short',habit:Number($('#reminder-habit').value) || null,
      interval_minutes:Number($('#reminder-interval').value)};
  }

  function saveReplyPreferences(values) {
    return agentRequest('/api/agent/preferences','PUT',JSON.stringify(values));
  }

  async function applyReplyPreference(command,isChinese) {
    const pickForm = command.kind === 'savePreferences' && $('#preferences-panel').open;
    let values = pickForm ? preferenceFields() : await agentRequest('/api/agent/preferences','GET');
    if (command.kind === 'preference') {
      let value = command.value;
      if (command.field === 'habit' && value !== null) {
        const {records} = await agentRequest('/api/memory/habits','GET');
        const match = records.find(row => row.name.normalize('NFKC').toLowerCase() === value.normalize('NFKC').toLowerCase());
        if (!match) return isChinese ? '没有这条已保存的习惯。' : 'That habit has not been saved.';
        value = match.id;
      }
      values = {...values,[command.field]:value};
    }
    await saveReplyPreferences(values);
    if ($('#preferences-panel').open) await loadPreferences();
    return isChinese ? '已保存回答和提醒设置。' : 'Reply and reminder preferences saved.';
  }

  listen($('#contrast'), 'click', () => setContrast(!document.documentElement.hasAttribute('data-contrast')));
  listen($('#mic'), 'click',() => startVoice());
  listen($('#wake-voice'), 'click',() => startVoice(true));
  listen($('#describe'), 'click', () => {
    const zh = transcriptionLanguage() === 'zh';
    answer(zh ? '我前面有什么？' : 'What is in front of me?',true,'scene');
  });
  listen($('#compare-cameras'), 'click', () => {
    if (pendingTurn) return;
    const zh = transcriptionLanguage() === 'zh';
    answer(zh ? '比较相机 A 和相机 B 的画面。' : 'Compare the views from Camera A and Camera B.',true,'image','both');
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
      await saveReplyPreferences(preferenceFields());
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
    showWarningTiming(warning) {
      const received = Date.now();
      latestWarning = {...warning,received};
      renderWarningTiming(latestWarning);
    }
  });
  return () => {
    scope.dispose();
    perception.stopPolling();
    stopAudio();
  };
}
