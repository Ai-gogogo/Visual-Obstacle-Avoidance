const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

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
  const planeToggle = html.match(/<input[^>]*id="depth-plane-overlay"[^>]*>/)?.[0];
  assert.ok(planeToggle);
  assert.match(html,/<article[^>]*id="scene-view"/);
  assert.match(html,/<canvas[^>]*id="scene-mask"[^>]*hidden/);
  assert.match(html,/Waiting for Camera A segmentation/);
  const labels = await call('/ade20k-labels.json');
  assert.equal(labels.status,200);
  assert.equal((await labels.json()).length,150);
  assert.doesNotMatch(planeToggle,/checked/);
  assert.match(html,/id="plane-status"[^>]*hidden/);
  assert.match(html,/RAFT-Stereo/);
  assert.match(html,/Record A \+ B/);
  assert.match(html,/Generate depth comparison/);
  assert.match(html,/Code for Camera A/);
  assert.match(html,/Code for Camera B/);
  assert.match(html,/<button[^>]*aria-pressed="true"[^>]*aria-controls="camera-b-feed"[^>]*>Show Camera B<\/button>/);
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

test('plane status, overlay and box height follow the display controls', async () => {
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
  const snapshot = {frame_id:'sample',plane:{validated:true,pitch_deg:12.8,holdout_p90_m:.011}};
  view.showDepth(snapshot,depth,false,overlay);
  assert.deepEqual(calls.splice(0),[[depth,0,0]]);
  assert.equal($('#plane-status').textContent,'Plane OK · Pitch 12.8° · P90 11.0 mm');
  $('#depth-plane-overlay').checked = true;
  view.repaintDepth();
  assert.deepEqual(calls.splice(0),[[depth,0,0],[overlay,0,0,180,240]]);
  view.showDepth({plane:{validated:false}},null,false);
  assert.equal($('#plane-status').textContent,'Plane Rejected');
  const canvas = {getContext:() => ctx,dataset:{}};
  const frame = {...snapshot,objects:[{label:'cup',position:'center',confidence:.9,bbox:[.4,.4,.6,.65],
    depth_m:1.2,height_above_plane_m:.14}]};
  view.paintCamera(canvas,depth,frame);
  assert.doesNotMatch(calls.pop(),/H 0\.14/);
  $('#depth-meters').checked = true;
  view.paintCamera(canvas,depth,frame);
  assert.match(calls.pop(),/1\.20 m · H 0\.14 m/);
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
