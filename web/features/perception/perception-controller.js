import { createPerceptionView } from "./perception-view";
import { createRtcPreview } from "./rtc-preview";
import { createScenePreview } from "./scene-preview";

export function createPerceptionController({$, scope, root, session, isMonitor, onModeChange}) {
  const {listen} = scope;
  const VisionPerceptionView = createPerceptionView($, scope.signal);
  const scene = createScenePreview($, () => session.token, scope.signal);
  const feeds = [...root.querySelectorAll('[data-camera]')].map(node => ({
    node,side:node.dataset.camera,rtc:createRtcPreview(node,node.dataset.camera,scope,session)
  }));
  let sampleMode = true;
  let pollVersion = 0;

  function setFeed(feed, connected, message) {
    const {node} = feed;
    node.querySelector('.sample-image').hidden = !sampleMode;
    node.querySelector('.overlays').hidden = !sampleMode;
    const status = node.querySelector('.feed-status');
    status.textContent = sampleMode ? 'Sample feed' : connected ? 'Receiving' : 'Offline';
    status.classList.toggle('live', !sampleMode && connected);
    if (sampleMode || !connected) feed.rtc.update(false);
    const image = node.querySelector('.live-frame');
    if (!feed.rtc.playing) image.hidden = sampleMode || !connected;
    const frame = image.parentElement;
    const size = node.querySelector('.frame-size');
    size.hidden = sampleMode || !connected;
    frame.toggleAttribute('data-has-pixels', !size.hidden);
    frame.tabIndex = !size.hidden && $('#camera-feeds').hasAttribute('data-actual-pixels') ? 0 : -1;
    if (!connected) {
      if (feed.side === 'A') {
        VisionPerceptionView.showDepth(null, null, sampleMode);
      }
      feed.etag = undefined;
      scope.cancelDelay(feed.expiry);
      feed.rtc.updateAnalysis(false);
      image.getContext('2d').clearRect(0,0,image.width,image.height);
      delete image.dataset.frameId;
      const hadObjects = feed.objects != null;
      feed.objects = null;
      if (feed.side === 'A' || hadObjects) VisionPerceptionView.renderDetections(sampleMode, feeds);
    } else {
      const video = feed.rtc.playing && node.querySelector('.rtc-preview');
      const width = video?.videoWidth || image.width;
      const height = video?.videoHeight || image.height;
      size.textContent = width + ' × ' + height + ' px';
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
      if (version !== pollVersion) return;
      const sceneId = response.headers.get('X-Segmentation-Frame');
      if (response.status === 304) {
        if (feed.side === 'A') scene.update(sceneId);
        return;
      }
      if (response.status !== 200) {
        if (feed.side === 'A' && (response.status === 204 || response.status === 401)) scene.clear();
        if (response.status === 401) session.invalidate(requestToken);
        setFeed(feed,false,response.status === 401 ? 'Session expired. Pair the phone again.' : undefined);
        return;
      }
      const snapshot = await response.json();
      if (version !== pollVersion) return;
      if (snapshot.camera_id !== undefined && snapshot.camera_id !== feed.side) {
        throw new Error('Preview camera does not match the requested feed.');
      }
      if (feed.side === 'A') scene.update(sceneId, snapshot.depth_rig?.split('/')[0]);
      const image = new Image();
      image.src = snapshot.png ? 'data:image/png;base64,' + snapshot.png : 'data:image/jpeg;base64,' + snapshot.jpeg;
      let depth = snapshot.depth_preview ? new Image() : null;
      if (depth) depth.src = 'data:image/png;base64,' + snapshot.depth_preview;
      let overlay = depth && snapshot.plane_overlay && VisionPerceptionView.depthOptions().planeOverlay ? new Image() : null;
      if (overlay) overlay.src = 'data:image/png;base64,' + snapshot.plane_overlay;
      await Promise.all([image.decode(), depth?.decode(), overlay?.decode().catch(() => { overlay = null; })]);
      if (version !== pollVersion) return;
      if (snapshot.depth_options && Object.entries(VisionPerceptionView.depthOptions()).some(
        ([key, value]) => key !== 'planeOverlay' && snapshot.depth_options[key] !== value
      )) {
        depth = overlay = null;
        delete snapshot.plane;
        delete snapshot.unclassified_obstacles;
        snapshot.stereo_status = 'waiting_for_a';
        delete snapshot.depth_range_m;
        delete snapshot.center_m;
        for (const object of snapshot.objects ?? []) {
          delete object.depth_m;
          delete object.nearest_depth_m;
          delete object.height_above_plane_m;
        }
      }
      const canvas = feed.node.querySelector('canvas');
      scope.cancelDelay(feed.expiry);
      const expires = snapshot.analysis_expires_ms;
      const hasBoxes = Boolean(snapshot.objects?.length || snapshot.preview_objects?.length || snapshot.road_edge);
      const hasAnalysis = Number.isFinite(expires) && expires > Date.now();
      const unannotated = {frame_id:snapshot.frame_id};
      VisionPerceptionView.paintCamera(canvas,image,hasAnalysis ? snapshot : unannotated);
      feed.etag = response.headers.get('etag');
      const hasDetections = feed.objects != null || snapshot.objects != null;
      feed.objects = hasAnalysis ? snapshot.objects : null;
      if (feed.side === 'A') VisionPerceptionView.showDepth(
        snapshot,hasAnalysis || snapshot.depth_expires_ms > Date.now() ? depth : null,sampleMode,overlay);
      feed.rtc.update(Boolean(snapshot.webrtc));
      feed.rtc.updateAnalysis(hasAnalysis && hasBoxes);
      setFeed(feed,true);
      if (hasAnalysis) feed.expiry = scope.delay(() => {
        if (version !== pollVersion) return;
        VisionPerceptionView.paintCamera(canvas,image,unannotated);
        feed.rtc.updateAnalysis(false);
        feed.objects = null;
        if (feed.side === 'A') VisionPerceptionView.showDepth({depth_rig:snapshot.depth_rig},null,sampleMode);
        VisionPerceptionView.renderDetections(sampleMode,feeds);
      },Math.max(0,expires-Date.now()));
      if (snapshot.png) feed.node.querySelector('.frame-size').textContent += ' · Lossless PNG';
      if (snapshot.webrtc?.decoded_fps) {
        feed.node.querySelector('.frame-size').textContent += ' · '+snapshot.webrtc.decoded_fps+' FPS at receiver';
      }
      if (snapshot.analysis_delayed) {
        feed.node.querySelector('.feed-summary').textContent = hasAnalysis
          ? 'Matched analysis frame · '+(Math.max(0,Date.now()-snapshot.analysis_capture_ms)/1000).toFixed(1)+' s ago'
          : 'Live preview · analysis catching up';
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
    if (!session.token) { scene.clear(); return; }
    async function poll(feed) {
      if (version !== pollVersion) return;
      if (!session.token) {
        if (feed.side === 'A') scene.clear();
        setFeed(feed,false,'Pair the phone again.');
        return;
      }
      await readFrame(feed,version);
      if (version === pollVersion) scope.delay(() => poll(feed),feed.side === 'A' ? 100 : feed.rtc.playing ? 450 : 220);
    }
    feeds.forEach(poll);
  }

  function renderMode(demo) {
    onModeChange();
    sampleMode = demo;
    if (demo) scene.clear();
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
    $('#live-depth-frame').hidden = saved;
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
  for (const id of ['depth-algorithm','depth-spatial','depth-temporal','depth-meters','depth-plane-overlay']) {
    listen($('#'+id), 'change', () => {
      refreshPolling();
      VisionPerceptionView.renderDetections(sampleMode, feeds);
    });
  }
  listen($('#mode'), 'click', () => renderMode(!sampleMode));
  const cameraB = $('#camera-b-feed');
  const cameraBToggle = $('#show-camera-b');
  const visibilityKey = 'visionassist-hide-camera-b';
  function setCameraBHidden(hidden) {
    cameraB.hidden = hidden;
    cameraBToggle.setAttribute('aria-pressed', String(!hidden));
  }
  try { setCameraBHidden(localStorage.getItem(visibilityKey) === 'true'); } catch {}
  listen(cameraBToggle, 'click', () => {
    const hidden = !cameraB.hidden;
    setCameraBHidden(hidden);
    try { localStorage.setItem(visibilityKey, String(hidden)); } catch {}
  });
  listen($('#pixel-preview'), 'click', event => {
    const active = $('#camera-feeds').toggleAttribute('data-actual-pixels');
    event.currentTarget.setAttribute('aria-pressed', String(active));
    root.querySelectorAll('.camera-frame[data-has-pixels]').forEach(frame => {
      frame.tabIndex = active ? 0 : -1;
    });
  });
  VisionPerceptionView.makeAnnotations(feeds);
  VisionPerceptionView.renderDetections(sampleMode, feeds);
  return {refreshPolling, stopPolling() {
    ++pollVersion;
    scene.clear();
    feeds.forEach(feed => feed.rtc.update(false));
  }, paired() { if (sampleMode) renderMode(false); else refreshPolling(); }};
}
