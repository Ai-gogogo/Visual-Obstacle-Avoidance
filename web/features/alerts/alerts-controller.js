const spokenMessages = {
  road: ['Caution. Road edge ahead.', '小心，前方有车行道边缘。'],
  stationary: ['Caution. Movement nearby.', '小心，有物体正在靠近。'],
  walking: ['Caution. Possible crossing ahead.', '小心，前方可能有横穿目标。']
};

export function connectAlerts({$, scope, agentRequest, isAssist, isConversationBusy, transcriptionLanguage,
  showWarningTiming, prepareSpokenAlerts, playSpokenAlert, cancelSpokenAlert}) {
  let alertSequence = 0;
  let warningUntil = 0;
  let pendingReminder;
  let pendingRoadAlert;
  let activeWarningRisk;
  let lastCameraStates;
  const modeControl = $('#spoken-alert-mode');
  const audioStatus = $('#spoken-alert-status');
  let mode = 'desk';
  let modeSince = 0;
  let stereoFeedsOnline = false;
  // Static obstacles come from Camera A detection alone; crossings and road edges need the stereo pair.
  let cameraADetecting = false;
  modeControl.value = mode;

  function updateAudioStatus(cameras) {
    const hadStereo = stereoFeedsOnline;
    cameraADetecting = cameras?.A === 'detecting';
    stereoFeedsOnline = cameraADetecting && receivingCamera(cameras?.B);
    if (!cameraADetecting || (hadStereo && !stereoFeedsOnline)) cancelSpokenAlert();
    const text = mode === 'desk' ? 'Automatic alert speech is off.' :
      mode === 'walking' && cameraADetecting && !stereoFeedsOnline ?
        'Walking alerts selected. Camera B is offline, so only obstacles in the walking path can trigger speech.' :
      !stereoFeedsOnline ? 'Spoken alerts paused. Waiting for both camera feeds and analysis on Camera A.' :
        mode === 'stationary' ? 'Stationary monitoring selected. Only verified nearby movement can trigger speech.' :
          'Walking alerts selected. Obstacles in the walking path, timely stereo crossings and measured road edges can trigger speech.';
    if (audioStatus.textContent !== text) audioStatus.textContent = text;
  }

  scope.listen(modeControl,'change',() => {
    mode = modeControl.value;
    modeSince = Date.now();
    cancelSpokenAlert();
    updateAudioStatus(lastCameraStates);
    if (mode !== 'desk') {
      const language = transcriptionLanguage() === 'zh' ? 1 : 0;
      prepareSpokenAlerts(mode === 'walking'
        ? [spokenMessages.walking[language],spokenMessages.road[language]]
        : [spokenMessages.stationary[language]]);
    }
  });

  function handleSpokenAlerts(alerts) {
    const selectedMode = mode;
    const canSpeak = alert => selectedMode !== 'desk' && mode === selectedMode &&
      (alert.kind === 'obstacle' ? cameraADetecting : stereoFeedsOnline) &&
      alert.stamp >= modeSince &&
      Date.now() < Math.min(alert.expires ?? Infinity, alert.stamp + 1500);
    const crossing = alerts.filter(alert => alert.kind === 'path_intrusion' && canSpeak(alert) &&
      (mode === 'walking' || alert.stationary_zone === true))
      .sort((a,b) => a.expires-b.expires)[0];
    const road = mode === 'walking' && alerts.findLast(alert => alert.kind === 'road_edge' &&
      alert.metric === true && canSpeak(alert));
    // Static obstacles in the walking corridor speak in walking mode, once per track and risk level.
    const obstacle = mode === 'walking' && alerts.filter(alert => alert.kind === 'obstacle' && canSpeak(alert) &&
      newObstacleLevel(alert)).sort((a,b) => Number(b.risk === 'urgent')-Number(a.risk === 'urgent'))[0];
    const alert = road?.risk === 'urgent' ? road : obstacle?.risk === 'urgent' ? obstacle : crossing || road || obstacle;
    if (!alert) return;
    const urgent = alert.risk === 'urgent' || (crossing === alert && alert.expires-Date.now() <= 1200);
    if (!urgent && isConversationBusy('chunks')) return;
    if (alert === obstacle) spokenObstacles.set(alert.track_id ?? alert.label,{risk:alert.risk,at:Date.now()});
    const chinese = transcriptionLanguage() === 'zh';
    const fallback = alert.kind === 'obstacle' ? [alert.text,alert.text] : spokenMessages[alert.kind === 'road_edge' ? 'road' : mode];
    const text = (chinese ? alert.text_zh : alert.text) || fallback[chinese ? 1 : 0];
    playSpokenAlert(text,urgent,() => canSpeak(alert));
  }
  const spokenObstacles = new Map();
  function newObstacleLevel(alert) {
    const previous = spokenObstacles.get(alert.track_id ?? alert.label);
    if (!previous || Date.now()-previous.at > 10_000) return true;
    return alert.risk === 'urgent' && previous.risk !== 'urgent';
  }
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
      warning = [...lostCameras].map(side =>
        'Camera ' + side + (cameras[side] === 'offline' ? ' disconnected.' : ' lost its video feed.')).join(' ');
    } else if (lastCameraStates && Object.values(lastCameraStates).some(receivingCamera)) {
      warning = 'Camera connection could not be checked. Reconnect and check the feeds.';
    }
    const alert = $('#connection-alert');
    if (alert.textContent !== warning) alert.textContent = warning;
    lastCameraStates = cameras;
    updateAudioStatus(cameras);
  }

  async function pollAlerts() {
    try {
      const allowReminder = isAssist();
      const {sequence,alerts,reminder,cameras} = await agentRequest('/api/agent/alerts?after='+alertSequence+
        '&wait=1'+(allowReminder ? '&reminders=1' : ''),'GET');
      if (scope.signal.aborted) return;
      updateCameraReadiness(cameras);
      handleSpokenAlerts(alerts);
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
        showWarningTiming(warning);
        scope.delay(() => {
          if ($('#obstacle-alert').textContent === text && Date.now() >= warningUntil) $('#obstacle-alert').textContent = '';
        },3400);
      } else if (pendingReminder && isAssist() && !isConversationBusy('onset') && Date.now() >= warningUntil) {
        const prefix = transcriptionLanguage() === 'zh' ? '提醒：' : 'Reminder: ';
        const message = prefix + pendingReminder.text;
        pendingReminder = undefined;
        $('#voice-message').textContent = message;
      }
    } catch (error) {
      if (scope.signal.aborted) return;
      updateCameraReadiness();
      if (error.status === 403 || location.protocol === 'file:') return;
      if (error.status === 401) {
        alertSequence = 0;
        pendingReminder = undefined;
        pendingRoadAlert = undefined;
      }
      scope.delay(pollAlerts,450);
      return;
    }
    void pollAlerts();
  }
  void pollAlerts();
}
