export function connectAlerts({$, scope, agentRequest, isAssist, isConversationBusy, transcriptionLanguage, showWarningTiming}) {
  let alertSequence = 0;
  let warningUntil = 0;
  let pendingReminder;
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
      const allowReminder = isAssist();
      const {sequence,alerts,reminder,cameras} = await agentRequest('/api/agent/alerts?after='+alertSequence+
        '&wait=1'+(allowReminder ? '&reminders=1' : ''),'GET');
      if (scope.signal.aborted) return;
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
