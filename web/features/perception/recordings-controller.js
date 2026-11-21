export function connectRecordings({$,scope,session}) {
  const select = $('#record-select');
  const video = $('#record-video');
  const toggle = $('#record-toggle');
  const library = $('#record-library');
  const detail = $('#record-detail');
  let takes = [], active, timer, busy = false, revision = 0, playback = 0, objectURL, pendingPlay;
  const selected = () => takes.find(take => take.id===select.value);
  const processing = take => ['recording','saving','comparing'].includes(take.status);
  const name = take => new Date(take.startedAt).toLocaleString()+' · '+take.pairs+' pairs';

  function closeVideo() {
    ++playback;
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = undefined;
    $('#record-player').hidden = true;
  }
  function selection() {
    const take = selected();
    $('#record-actions').hidden = !take;
    $('#record-empty').hidden = Boolean(take);
    if (!take) { detail.textContent = ''; return; }
    $('#record-play').disabled = !take.video;
    $('#record-export').hidden = take.video || !take.pairs || processing(take);
    $('#record-compare').hidden = take.comparisonSegmentation === true;
    $('#record-compare').textContent = take.comparison ? 'Regenerate with segmentation' : 'Generate depth comparison';
    $('#record-compare').disabled = busy || processing(take) || !take.pairs || !take.calibration;
    $('#record-play-depth').hidden = !take.comparison;
    const message = {recording:'Recording synchronized pairs…',saving:'Saving A/B video…',
      comparing:'Generating depth and segmentation comparison…',saved:'Saved on this Mac.'}[take.status];
    const requiresCalibration = !take.calibration && take.pairs ? ' Depth comparison needs a calibration for this camera mode.' : '';
    detail.textContent = [message,take.message].filter(Boolean).join(' ')+requiresCalibration;
  }
  async function showVideo(kind) {
    const take = selected();
    if (!take) return;
    closeVideo();
    const version = playback;
    try {
      const response = await session.agentFetch('/api/recordings/'+take.id+'/'+kind,'GET');
      const blob = await response.blob();
      if (version!==playback || scope.signal.aborted || selected()?.id!==take.id) return;
      objectURL = URL.createObjectURL(blob);
      video.src = objectURL;
      $('#record-player').hidden = false;
      $('#record-prev').hidden = $('#record-next').hidden = kind!=='comparison';
      const link = $('#record-download');
      link.href = objectURL;
      link.download = take.id+'-'+kind+'.mp4';
      await video.play().catch(()=>{});
    } catch (error) { if (version===playback) detail.textContent=error.message; }
  }
  async function refresh(preferred) {
    const version = ++revision;
    scope.cancelDelay(timer);
    try {
      const result = await session.agentRequest('/api/recordings','GET');
      if (version!==revision || scope.signal.aborted) return;
      takes = result.takes;
      active = takes.find(take=>take.status==='recording');
      toggle.textContent = active ? 'Stop and save' : 'Record A + B';
      $('#record-progress').textContent = active ? (active.pairs ? active.pairs+' synchronized pairs · '+active.duration.toFixed(1)+' s' : 'Waiting for the first synchronized A/B pair…')
        : takes[0]?.status==='saving' ? 'Saving recording…' : '';
      const current = preferred || select.value;
      const signature = takes.map(take=>take.id+'/'+take.pairs).join(',');
      if (select.dataset.signature!==signature) {
        select.replaceChildren(...takes.map(take=>new Option(name(take),take.id)));
        select.dataset.signature=signature;
      }
      if (takes.some(take=>take.id===current)) select.value=current;
      selection();
      const take = selected();
      if (pendingPlay && take?.id===pendingPlay && !processing(take)) {
        pendingPlay=undefined;
        if (take.comparisonSegmentation) void showVideo('comparison');
      }
      if (takes.some(processing)) timer=scope.delay(refresh,750);
    } catch (error) {
      if (version!==revision || scope.signal.aborted) return;
      $('#record-progress').textContent=error.message;
      timer=scope.delay(refresh,2500);
    }
  }
  async function action(path) {
    if (busy) return;
    busy=true;
    toggle.disabled=true;
    scope.cancelDelay(timer);
    ++revision;
    try {
      const take=await session.agentRequest('/api/recordings/'+path,'POST');
      if (path.endsWith('/compare')) pendingPlay=take.id;
      if (path==='start') closeVideo();
      library.open=true;
      await refresh(take.id);
    } catch (error) {
      await refresh();
      $('#record-progress').textContent=error.message;
    } finally { busy=false; toggle.disabled=false; selection(); }
  }
  scope.listen(toggle,'click',()=>action(active ? active.id+'/stop' : 'start'));
  scope.listen(library,'toggle',()=>{ if (library.open && !busy) void refresh(); });
  scope.listen(select,'change',()=>{ pendingPlay=undefined; closeVideo(); selection(); });
  scope.listen($('#record-play'),'click',()=>showVideo('video'));
  scope.listen($('#record-play-depth'),'click',()=>showVideo('comparison'));
  scope.listen($('#record-export'),'click',()=>action(select.value+'/export'));
  scope.listen($('#record-compare'),'click',()=>action(select.value+'/compare'));
  for (const [id,step] of [['#record-prev',-1],['#record-next',1]]) {
    scope.listen($(id),'click',()=>{
      if (!Number.isFinite(video.duration)) return;
      video.pause();
      const last = Math.max(0, Math.round(video.duration*4)-1);
      const target = Math.max(0, Math.min(last, Math.floor(video.currentTime*4)+step));
      video.currentTime=(target+.25)/4;
    });
  }
  scope.signal.addEventListener('abort',closeVideo,{once:true});
  void refresh();
}
