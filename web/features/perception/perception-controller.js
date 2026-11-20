import { createPerceptionView } from "./perception-view";

export function createPerceptionController({$, scope, root, session, isMonitor, onModeChange}) {
  const {listen} = scope;
  const VisionPerceptionView = createPerceptionView($, scope.signal);
  const feeds = [...root.querySelectorAll('[data-camera]')].map(node => ({node, side:node.dataset.camera}));
  let sampleMode = true;
  let pollVersion = 0;

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
    if (!session.token) return;
    try {
      const requestToken = session.token;
      const headers = {Authorization:'Bearer '+requestToken};
      if (feed.side === 'A') headers['X-Depth-Options'] = JSON.stringify(VisionPerceptionView.depthOptions());
      if (feed.etag) headers['If-None-Match'] = feed.etag;
      const path = '/api/preview/' + feed.side;
      const response = await fetch(path, {headers, signal:AbortSignal.any([scope.signal, AbortSignal.timeout(3000)])});
      if (version !== pollVersion || response.status === 304) return;
      if (response.status !== 200) {
        if (response.status === 401) session.invalidate(requestToken);
        setFeed(feed,false,response.status === 401 ? 'Session expired. Pair the phone again.' : undefined);
        return;
      }
      const snapshot = await response.json();
      if (snapshot.camera_id !== undefined && snapshot.camera_id !== feed.side) {
        throw new Error('Preview camera does not match the requested feed.');
      }
      const image = new Image();
      image.src = snapshot.png ? 'data:image/png;base64,' + snapshot.png : 'data:image/jpeg;base64,' + snapshot.jpeg;
      let depth = snapshot.depth_preview ? new Image() : null;
      if (depth) depth.src = 'data:image/png;base64,' + snapshot.depth_preview;
      await Promise.all([image.decode(), depth?.decode()]);
      if (version !== pollVersion) return;
      if (snapshot.depth_options && Object.entries(VisionPerceptionView.depthOptions()).some(
        ([key, value]) => snapshot.depth_options[key] !== value
      )) {
        depth = null;
        snapshot.stereo_status = 'waiting_for_a';
        delete snapshot.depth_range_m;
        delete snapshot.center_m;
        for (const object of snapshot.objects ?? []) delete object.depth_m;
      }
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
    if (sampleMode || !isMonitor()) return;
    feeds.forEach(feed => setFeed(feed,false));
    if (!session.token) return;
    async function poll(feed) {
      if (version !== pollVersion) return;
      if (!session.token) { setFeed(feed,false,'Pair the phone again.'); return; }
      await readFrame(feed,version);
      if (version === pollVersion) scope.delay(() => poll(feed),feed.side === 'A' ? 150 : 220);
    }
    feeds.forEach(poll);
  }

  function renderMode(demo) {
    onModeChange();
    sampleMode = demo;
    $('#camera-feeds').toggleAttribute('data-live', !demo);
    $('#pixel-preview').hidden = demo;
    $('#mode').textContent = demo ? 'Show live cameras' : 'Show sample feeds';
    $('#detection-note').textContent = demo ? 'Sample annotations · distances are illustrative.' : 'Relative depth compares ground contacts. Forward depth is measured from Camera A using both phones.';
    $('#voice-message').textContent = '';
    feeds.forEach(feed => setFeed(feed,false));
    refreshPolling();
  }

  let replayURL, replayVersion = 0;
  const source = $('#depth-source'), video = $('#saved-depth-video');
  function clearReplay() {
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (replayURL) URL.revokeObjectURL(replayURL);
    replayURL = undefined;
  }
  listen(source,'change', async () => {
    const version = ++replayVersion;
    const saved = !['live','low'].includes(source.value);
    clearReplay();
    $('#saved-depth').hidden = !saved;
    $('#live-depth-controls').hidden = saved;
    if (!saved) { VisionPerceptionView.showDepth(null,null,sampleMode); refreshPolling(); return; }
    $('#saved-depth-status').textContent = 'Loading saved depth…';
    try {
      const response = await session.agentFetch('/api/depth-replay/'+source.value,'GET');
      const blob = await response.blob();
      if (version !== replayVersion || scope.signal.aborted) return;
      replayURL = URL.createObjectURL(blob);
      video.src = replayURL;
      $('#saved-depth-status').textContent = 'Recorded relative depth · near is warm, far is cool.';
      await video.play().catch(() => {});
    } catch (err) {
      if (version === replayVersion) $('#saved-depth-status').textContent = err.message;
    }
  });
  scope.signal.addEventListener('abort',clearReplay,{once:true});
  listen($('#depth-palette'), 'change', VisionPerceptionView.repaintDepth);
  for (const id of ['depth-spatial','depth-temporal','depth-meters','depth-five-mm']) {
    listen($('#'+id), 'change', () => {
      $('#depth-length-label').hidden = !$('#depth-meters').checked;
      refreshPolling();
      VisionPerceptionView.renderDetections(sampleMode, feeds);
    });
  }
  listen($('#mode'), 'click', () => renderMode(!sampleMode));
  listen($('#pixel-preview'), 'click', event => {
    const active = $('#camera-feeds').toggleAttribute('data-actual-pixels');
    event.currentTarget.setAttribute('aria-pressed', String(active));
    root.querySelectorAll('.camera-frame[data-has-pixels]').forEach(frame => {
      frame.tabIndex = active ? 0 : -1;
    });
  });
  VisionPerceptionView.makeAnnotations(feeds);
  VisionPerceptionView.renderDetections(sampleMode, feeds);
  return {refreshPolling, stopPolling() { ++pollVersion; }, paired() { if (sampleMode) renderMode(false); else refreshPolling(); }};
}
