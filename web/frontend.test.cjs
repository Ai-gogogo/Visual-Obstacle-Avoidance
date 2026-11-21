const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const liveCalibration = require('../cv/results/stereo-calibration-2026-11-20/webrtc-480x640.json');

test('the production frontend and device API share one origin', {timeout:25_000}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visionassist-next-'));
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: __dirname,
    env: {...process.env, VISIONASSIST_PORT:'0', VISIONASSIST_DB:join(directory,'test.sqlite'), NEXT_TELEMETRY_DISABLED:'1'},
    stdio: ['ignore','pipe','pipe'],
  });
  const exited = once(child,'exit');
  t.after(async () => {
    child.kill();
    await exited;
    rmSync(directory,{recursive:true,force:true});
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const base = await new Promise((resolve,reject) => {
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/Desktop: http:\/\/localhost:(\d+)\//);
      if (match) resolve('http://127.0.0.1:' + match[1]);
    });
    child.once('error',reject);
    child.once('exit',() => reject(new Error('Frontend failed to start. ' + stderr)));
  });
  const call = (path, options) => fetch(base + path,options);
  const monitor = await call('/');
  assert.equal(monitor.status,200);
  const html = await monitor.text();
  assert.match(html,/Live perception/);
  assert.match(html,/Voice assistant/);
  assert.match(html,/Reduce motion/);
  assert.match(html,/Stereo calibration/);
  assert.match(html,/Depth algorithm/);
  assert.ok(html.includes(`<option value="live" selected="">Live · ${liveCalibration.name ?? 'current calibration'}</option>`));
  const planeToggle = html.match(/<input[^>]*id="depth-plane-overlay"[^>]*>/)?.[0];
  assert.ok(planeToggle);
  const obstacleToggle = html.match(/<input[^>]*id="depth-obstacle-labels"[^>]*>/)?.[0];
  assert.ok(obstacleToggle);
  assert.doesNotMatch(obstacleToggle,/checked/);
  assert.match(html,/<article[^>]*id="scene-view"/);
  const position = marker => html.indexOf(marker);
  assert.ok(position('data-camera="A"') < position('id="stereo-view"'));
  assert.ok(position('id="stereo-view"') < position('id="scene-view"'));
  assert.ok(position('id="scene-view"') < position('id="fused-view"'));
  assert.ok(position('id="fused-view"') < position('id="camera-b-feed"'));
  assert.match(html,/<article[^>]*id="fused-view"/);
  assert.match(html,/Fused depth \+ segmentation/);
  assert.match(html,/<canvas[^>]*id="fused-map"[^>]*hidden/);
  assert.match(html,/id="fused-placeholder"[^>]*>Waiting for depth and segmentation\./);
  assert.match(html,/id="fused-status"[^>]*role="status"/);
  const fusedPalette = html.match(/<select[^>]*id="fused-palette"[^>]*>(.*?)<\/select>/)?.[1] ?? '';
  assert.match(fusedPalette,/<option value="gray" selected="">Grayscale<\/option>/);
  assert.match(fusedPalette,/<option value="turbo">Turbo<\/option>/);
  assert.match(fusedPalette,/<option value="viridis">Viridis<\/option>/);
  assert.match(html,/<article[^>]*id="camera-b-feed"[^>]*hidden/);
  assert.match(html,/<canvas[^>]*id="scene-mask"[^>]*hidden/);
  assert.match(html,/Waiting for Camera A segmentation/);
  const labels = await call('/ade20k-labels.json');
  assert.equal(labels.status,200);
  assert.equal((await labels.json()).length,150);
  assert.doesNotMatch(planeToggle,/checked/);
  assert.match(html,/id="plane-status"[^>]*hidden/);
  assert.match(html,/id="protrusion-status"[^>]*hidden/);
  assert.match(html,/RAFT-Stereo/);
  assert.match(html,/Record A \+ B/);
  assert.match(html,/Generate depth comparison/);
  assert.match(html,/Code for Camera A/);
  assert.match(html,/Code for Camera B/);
  assert.match(html,/<button[^>]*aria-pressed="false"[^>]*aria-controls="camera-b-feed"[^>]*>Show Camera B<\/button>/);
  const stylesheet = /<link[^>]+href="([^"]+\.css)"[^>]*>/.exec(html);
  assert.ok(stylesheet,'The server rendered a stylesheet link');
  assert.equal((await call(stylesheet[1])).status,200);
  const camera = await call('/camera');
  assert.equal(camera.status,200);
  assert.ok(Number(camera.headers.get('x-server-ms')) > 0,'Phone clock synchronization header is present');
  const phone = await camera.text();
  assert.match(phone,/Enter pairing code/);
  assert.match(phone,/lossless PNG/);
  assert.ok(!phone.includes('Live perception'));
  assert.equal((await call('/camera.html',{redirect:'manual'})).headers.get('location'),'/camera');
  assert.equal((await call('/demo-lab.webp')).headers.get('content-type'),'image/webp');
  assert.match(await (await call('/voice-capture.js')).text(),/registerProcessor\('voice-capture'/);

  const session = await call('/api/session',{method:'POST',headers:{Origin:base}});
  assert.equal(session.status,201);
  assert.equal(session.headers.get('cache-control'),'no-store');
  const {token} = await session.json();
  const pair = await call('/api/pair/A',{method:'POST',headers:{Origin:base,Authorization:'Bearer '+token}});
  assert.equal(pair.status,201);
  assert.match((await pair.json()).code,/^\d{6}$/);
});

test('obstacle labels, plane colors and box height follow independent display controls', async () => {
  const {createPerceptionView} = await import('./features/perception/perception-view.js');
  const nodes = new Map();
  function $(selector) {
    if (!nodes.has(selector)) nodes.set(selector,{dataset:{}});
    return nodes.get(selector);
  }
  $('#depth-palette').value = 'gray';
  const calls = [];
  const ctx = {
    drawImage: (...args) => calls.push(args),
    setLineDash() {}, strokeRect() {}, fillRect() {},
    measureText: () => ({width:30}),
    fillText: caption => calls.push(caption),
  };
  $('#stereo-map').getContext = () => ctx;
  const view = createPerceptionView($);
  const depth = {naturalWidth:180,naturalHeight:240};
  const overlay = {};
  const snapshot = {frame_id:'sample',depth_frame_id:'sample',
    depth_timestamp_ms:Date.now(),depth_expires_ms:Date.now()+3500,
    plane:{validated:true,pitch_deg:12.8,holdout_p90_m:.011},
    unclassified_obstacles:[
      {semantic_label:'wall',depth_m:1.4}, {semantic_label:'pole',depth_m:1.1},
      {semantic_label:'unknown',depth_m:.9}, {depth_m:.7}
    ]};
  view.showDepth(snapshot,depth,false,overlay);
  assert.deepEqual(calls.splice(0),[[depth,0,0]]);
  assert.equal($('#plane-status').textContent,'Plane OK · Pitch 12.8° · P90 11.0 mm');
  assert.equal($('#protrusion-status').hidden,true);
  $('#depth-plane-overlay').checked = true;
  view.repaintDepth();
  assert.deepEqual(calls.splice(0),[[depth,0,0],[overlay,0,0,180,240]]);
  assert.equal($('#protrusion-status').hidden,true);
  $('#depth-plane-overlay').checked = false;
  $('#depth-obstacle-labels').checked = true;
  view.repaintDepth();
  assert.deepEqual(calls.splice(0),[[depth,0,0]]);
  assert.equal(view.depthOptions().planeOverlay,undefined);
  assert.equal($('#protrusion-status').textContent,'pole 1.1m · wall 1.4m');
  assert.equal($('#protrusion-status').hidden,false);
  view.showDepth({...snapshot,depth_frame_id:'different'},depth,false,overlay);
  assert.equal($('#protrusion-status').textContent,'');
  assert.equal($('#protrusion-status').hidden,true);
  view.showDepth(snapshot,null,false);
  assert.equal($('#protrusion-status').hidden,true);
  view.repaintDepth();
  assert.equal($('#protrusion-status').hidden,true);
  $('#depth-obstacle-labels').checked = false;
  view.showDepth(snapshot,depth,false,overlay);
  assert.equal($('#protrusion-status').hidden,true);
  view.showDepth({plane:{validated:false},stereo_status:'no_matches'},null,false);
  assert.equal($('#plane-status').textContent,'Plane Rejected');
  const canvas = {getContext:() => ctx,dataset:{}};
  const frame = {...snapshot,objects:[{label:'cup',position:'center',confidence:.9,bbox:[.4,.4,.6,.65],
    depth_m:1.5,nearest_depth_m:1.2,height_above_plane_m:.14}]};
  view.paintCamera(canvas,depth,frame);
  assert.doesNotMatch(calls.pop(),/H 0\.14|min/);
  $('#depth-meters').checked = true;
  view.paintCamera(canvas,depth,frame);
  assert.match(calls.pop(),/1\.50 m · H 0\.14 m · min 1\.20m/);
  view.paintCamera(canvas,depth,{...frame,depth_frame_id:'different'});
  assert.doesNotMatch(calls.pop(),/min/);
  frame.objects[0].nearest_depth_m = 1.45;
  view.paintCamera(canvas,depth,frame);
  assert.equal(calls.pop(),'cup · 90% · center · 1.50 m · H 0.14 m');
});

test('segmentation stays visible across gaps and clears on Camera A replacement', async t => {
  const {createScenePreview} = await import('./features/perception/scene-preview.js');
  t.mock.timers.enable({apis:['setTimeout']});
  const ctx = {fillRect() {}, drawImage() {}, putImageData() {},
    getImageData: () => ({data:new Uint8ClampedArray(256*4)})};
  const canvas = {hidden:true,dataset:{},style:{},getContext:() => ctx};
  const placeholder = {hidden:false};
  const stale = {hidden:true};
  const legend = {items:[],replaceChildren(...items) { this.items = items; }};
  const elements = {'#scene-mask':canvas,'#scene-placeholder':placeholder,'#scene-stale':stale,'#scene-legend':legend};
  const fakeDocument = {createElement:() => ({style:{},append() {},getContext:() => ctx})};
  const saved = {document:globalThis.document,Image:globalThis.Image};
  globalThis.document = fakeDocument;
  globalThis.Image = class { async decode() {} };
  t.after(() => {
    for (const [name,value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });

  const reply = frame_id => Response.json({frame_id,mask:'AA==',remaining_ms:500,width:480,height:640});
  let next = Promise.resolve(reply('first'));
  let fetchCount = 0;
  t.mock.method(globalThis,'fetch',url => {
    if (url === '/ade20k-labels.json') return Promise.resolve(Response.json(['wall']));
    assert.equal(url,'/api/segmentation/A');
    fetchCount++;
    return next;
  });
  const controller = new AbortController();
  const view = createScenePreview(id => elements[id], () => 'desk', controller.signal);
  await view.update('first','camera-a');
  assert.equal(canvas.hidden,false);
  assert.equal(stale.hidden,true);
  assert.equal(legend.items.length,1);
  t.mock.timers.tick(501);
  await view.update(null,'camera-a');
  assert.equal(stale.hidden,false);
  assert.equal(canvas.dataset.frameId,'first');
  assert.equal(canvas.hidden,false);

  next = Promise.resolve(new Response(null,{status:204}));
  await view.update('expired','camera-a');
  assert.equal(canvas.dataset.frameId,'first');
  let finish;
  next = new Promise(resolve => { finish = resolve; });
  const loading = view.update('second','camera-a');
  await view.update(null,'camera-a');
  await view.update('newer','camera-a');
  assert.equal(fetchCount,3);
  assert.equal(canvas.dataset.frameId,'first');
  assert.equal(placeholder.hidden,true);
  finish(reply('second'));
  await loading;
  assert.equal(canvas.dataset.frameId,'second');
  assert.equal(stale.hidden,true);

  next = new Promise(resolve => { finish = resolve; });
  const old = view.update('old-stream','camera-a');
  await view.update(null,'replacement-camera');
  finish(reply('old-stream'));
  await old;
  assert.equal(canvas.hidden,true);
  assert.equal(placeholder.hidden,false);
  assert.equal(legend.items.length,0);
  controller.abort();
});

test('the fused canvas defaults to grayscale and has an independent palette', async t => {
  const {createFusedPreview} = await import('./features/perception/fused-preview.js');
  const {createPerceptionView} = await import('./features/perception/perception-view.js');
  const {createScenePreview} = await import('./features/perception/scene-preview.js');
  t.mock.timers.enable({apis:['setTimeout','Date'], now:10_000});
  const nodes = new Map();
  function $(selector) {
    if (!nodes.has(selector)) nodes.set(selector,{dataset:{},style:{},replaceChildren() {}});
    return nodes.get(selector);
  }
  const grayDepth = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < grayDepth.length; i += 4) {
    grayDepth.fill(i < 64 ? 100 : 0,i,i+3);
    grayDepth[i+3] = 255;
  }
  $('#stereo-map').getContext = () => ({
    drawImage() {},
    getImageData: () => ({data:grayDepth.slice()}),
    putImageData({data}) { assert.notEqual(data[0],100); }
  });
  let fusedPixels;
  $('#fused-map').getContext = () => ({
    createImageData: (width,height) => ({data:new Uint8ClampedArray(width*height*4)}),
    putImageData({data}) { fusedPixels = data.slice(); }
  });
  const maskPixels = new Uint8ClampedArray(128*128*4);
  $('#scene-mask').getContext = () => ({
    drawImage() {}, getImageData: () => ({data:maskPixels}), putImageData() {}
  });
  const saved = {document:globalThis.document,Image:globalThis.Image};
  globalThis.document = {createElement:() => ({
    style:{}, append() {},
    getContext:() => ({fillRect() {}, getImageData:() => ({data:new Uint8ClampedArray(256*4).fill(200)})})
  })};
  globalThis.Image = class { async decode() {} };
  t.after(() => {
    for (const [key,value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  let sceneFrame = 'seg';
  t.mock.method(globalThis,'fetch', async url => url === '/ade20k-labels.json'
    ? Response.json(['wall'])
    : Response.json({frame_id:sceneFrame, mask:'AA==', timestamp_ms:9_700, remaining_ms:750, width:480, height:640}));

  const scope = new AbortController();
  const fused = createFusedPreview($,scope.signal);
  const view = createPerceptionView($,scope.signal,fused.setDepth);
  const scene = createScenePreview($,() => 'desk',scope.signal,fused.setScene);
  $('#depth-palette').value = 'gray';
  $('#fused-palette').value = 'gray';
  fused.setPartner('right');
  const snapshot = {frame_id:'depth', depth_rig:'left/right', depth_timestamp_ms:10_000, analysis_expires_ms:13_000};
  const image = {naturalWidth:8,naturalHeight:8};
  view.showDepth(snapshot,image,false);
  assert.equal($('#fused-status').textContent,'Waiting for segmentation.');
  assert.equal(fusedPixels[64],0);
  await scene.update('seg','left');
  assert.equal($('#fused-map').width,8);
  assert.equal($('#fused-map').height,8);
  assert.equal($('#fused-status').textContent,'Filled +75.0% · Seg lag 0.3s');
  assert.equal(maskPixels[0],200);
  assert.deepEqual([...fusedPixels.slice(64,68)],[86,86,86,255]);

  const grayFusedFrame = fusedPixels.slice();
  for (const palette of ['turbo','viridis','gray']) {
    $('#depth-palette').value = palette;
    view.repaintDepth();
    view.showDepth(snapshot,image,false);
    assert.deepEqual(fusedPixels,grayFusedFrame);
  }

  let previousColor = [...fusedPixels.slice(0,3)];
  for (const palette of ['turbo','viridis','gray']) {
    $('#fused-palette').value = palette;
    fused.repaintPalette();
    assert.notDeepEqual([...fusedPixels.slice(0,3)],previousColor);
    assert.deepEqual([...fusedPixels.slice(64,67)],Array.from(fusedPixels.slice(0,3), color => Math.round(color*0.86)));
    previousColor = [...fusedPixels.slice(0,3)];
  }
  assert.deepEqual(fusedPixels,grayFusedFrame);
  assert.equal($('#depth-palette').value,'gray');

  t.mock.timers.tick(751);
  assert.equal($('#scene-stale').hidden,false);
  assert.equal($('#fused-map').hidden,false);
  assert.match($('#fused-status').textContent,/Holding last fused frame · segmentation stale/);
  assert.equal(fusedPixels[64],86);
  $('#fused-palette').value = 'turbo';
  fused.repaintPalette();
  assert.notDeepEqual(fusedPixels,grayFusedFrame);
  assert.match($('#fused-status').textContent,/Holding last fused frame · segmentation stale/);
  $('#fused-palette').value = 'gray';
  fused.repaintPalette();
  assert.deepEqual(fusedPixels,grayFusedFrame);
  sceneFrame = 'seg2';
  maskPixels.fill(0);
  await scene.update('seg2','left');
  assert.match($('#fused-status').textContent,/Filled \+75\.0%/);

  fused.setPartner(null);
  assert.match($('#fused-status').textContent,/Holding last fused frame · waiting for depth/);
  assert.equal($('#fused-map').hidden,false);
  fused.setPartner('right');
  assert.equal($('#fused-map').hidden,false);
  view.showDepth(snapshot,image,false);
  assert.equal(fusedPixels[64],86);
  fused.resetDepth();
  await scene.update(null,'replacement-camera');
  assert.equal($('#fused-map').hidden,true);
  view.showDepth({...snapshot,depth_rig:'replacement-camera/right'},image,false);
  assert.equal($('#fused-status').textContent,'Waiting for segmentation.');
  assert.equal(fusedPixels[64],0);

  sceneFrame = 'unconfirmed';
  maskPixels.fill(0);
  await scene.update('advertised','replacement-camera');
  assert.equal($('#scene-mask').dataset.frameId,'unconfirmed');
  assert.equal(fusedPixels[64],0);
  await scene.update('unconfirmed','replacement-camera');
  assert.equal(fusedPixels[64],86);

  const frozen = fusedPixels.slice();
  view.showDepth({stereo_status:'waiting_for_pair',depth_rig:'left/right'},null,false);
  assert.equal($('#fused-map').hidden,false);
  assert.match($('#fused-status').textContent,/Holding last fused frame · waiting for depth/);
  scene.clear();
  assert.deepEqual(fusedPixels,frozen);
  view.showDepth(snapshot,image,false);
  assert.equal($('#fused-map').hidden,false);
  assert.deepEqual(fusedPixels,frozen);

  fused.setReplay(true);
  assert.equal($('#fused-map').hidden,true);
  assert.match($('#fused-status').textContent,/saved depth/i);
  fused.setReplay(false);
  view.showDepth({...snapshot,analysis_expires_ms:Date.now()+25},image,false);
  t.mock.timers.tick(25);
  assert.equal($('#fused-map').hidden,false);
  assert.match($('#fused-status').textContent,/Holding last depth frame · waiting for depth/);
  fused.resetDepth();
  assert.equal($('#fused-map').hidden,true);
  assert.equal($('#fused-status').textContent,'Waiting for stereo depth.');
  scope.abort();
});
