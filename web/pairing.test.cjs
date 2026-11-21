const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const {createServer} = require('./server.cjs');

test('runtime shows reported YOLO devices and distinguishes model residency from idle', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const originalFetch = globalThis.fetch;
  const chat = process.env.VISIONASSIST_CHAT_MODEL || 'qwen3:4b-instruct-2507-q4_K_M';
  const vision = process.env.VISIONASSIST_VISION_MODEL || 'qwen3-vl:2b';
  let models = [
    {name:chat,size:100,size_vram:100},
    {name:vision,size:200,size_vram:50},
    {name:'unrelated:latest',size:100,size_vram:0}
  ];
  t.mock.method(globalThis,'fetch',(url,options) => url === 'http://127.0.0.1:11434/api/ps'
    ? Promise.resolve(Response.json({models})) : originalFetch(url,options));
  const server = createServer({agent:{filename:':memory:'}});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:'+server.address().port;
  const runtime = '/api/agent/runtime';
  assert.equal((await fetch(base+runtime)).status,401);
  const {token} = await (await fetch(base+'/api/session',{method:'POST'})).json();
  const readRuntime = async () => (await fetch(base+runtime,{headers:{Authorization:'Bearer '+token}})).json();
  const pulse = (camera,device,precision) => fetch(base+'/api/cv/sources',{headers:{
    'X-CV-Camera':camera,'X-CV-Device':device,'X-CV-Precision':precision
  }});
  await pulse('A','cuda:0','fp16');
  await pulse('B','cpu','fp32');
  const first = await readRuntime();
  assert.deepEqual(first.yolo.map(({device}) => device),['cuda:0','cpu']);
  assert.deepEqual(first.agent.loaded.map(({device,gpu_percent}) => [device,gpu_percent]),[['gpu',100],['mixed',25]]);
  models = [{name:chat,size:100,size_vram:0}];
  assert.equal((await readRuntime()).agent.loaded[0].device,'cpu');
  await pulse('A','mps','fp32');
  await pulse('A','mps','fp16');
  assert.deepEqual((await readRuntime()).yolo[0],{camera:'A',device:'mps',precision:'fp32'});
  t.mock.timers.tick(5100);
  models = [];
  const idle = await readRuntime();
  assert.deepEqual(idle.yolo,[]);
  assert.equal(idle.agent.reachable,true);
  assert.deepEqual(idle.agent.loaded,[]);
});

test('desktop and two phones pair independently and stale frames are withheld', async t => {
  t.mock.timers.enable({apis:['Date'], now:Date.now()});
  const server = createServer();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (route, method = 'GET', token, body, extra = {}) => fetch(base+route, {
    method, body, headers:{...(token ? {Authorization:'Bearer '+token} : {}), ...extra}
  });
  const read = async (response, status) => {
    assert.equal(response.status,status);
    return response.json();
  };
  assert.equal((await call('/api/frame/A')).status,401);
  assert.equal((await call('/api/session','POST',undefined,undefined,{Origin:'https://example.test'})).status,403);

  const {token:desk} = await read(await call('/api/session','POST'),201);
  const pair = async side => (await read(await call('/api/pair/'+side,'POST',desk),201)).code;
  const join = (code,expected = {}) => call('/api/join','POST',undefined,JSON.stringify({code,...expected}),{'Content-Type':'application/json'});
  const codeA = await pair('A');
  const codeB = await pair('B');
  assert.notEqual(codeA, codeB);
  assert.equal((await join(codeA,{expectedSlot:'B'})).status,409);
  const {token:a,slot,sourceID} = await read(await join(codeA,{expectedSlot:'A'}),200);
  assert.equal(slot,'A');
  assert.ok(sourceID);
  assert.equal((await join(codeA)).status,404);
  assert.equal((await join(codeB,{expectedSlot:'B',expectedSourceID:'other-session'})).status,409);
  const joinedB = await read(await join(codeB,{expectedSlot:'B',expectedSourceID:sourceID}),200);
  assert.equal(joinedB.slot,'B');
  assert.equal(joinedB.sourceID,sourceID);
  const b = joinedB.token;
  const jpegA = Buffer.from([255,216,11,255,217]);
  const jpegB = Buffer.from([255,216,22,255,217]);
  const push = (token, bytes) => call('/api/frame','PUT',token,bytes,{'Content-Type':'image/jpeg'});
  assert.equal((await push(a,jpegA)).status,204);
  assert.equal((await push(b,jpegB)).status,204);
  const frameA = await call('/api/frame/A','GET',desk);
  assert.deepEqual(Buffer.from(await frameA.arrayBuffer()),jpegA);
  assert.deepEqual(Buffer.from(await (await call('/api/frame/B','GET',desk)).arrayBuffer()),jpegB);
  assert.equal((await call('/api/frame/A','GET',desk,undefined,{'If-None-Match':frameA.headers.get('etag')})).status,304);
  assert.equal((await call('/api/frame/A','GET',a)).status,401);
  const readiness = async () => (await read(await call('/api/agent/alerts','GET',desk),200)).cameras;
  assert.deepEqual(await readiness(),{A:'live',B:'live'});
  const {sources} = await read(await call('/api/cv/sources'),200);
  const source = sources.find(entry => entry.camera_id === 'A');
  const query = '?camera_id=A&source_id='+source.source_id;
  const publishFrame = async () => {
    const frame = await call('/api/cv/frame'+query);
    assert.equal(frame.status,200);
    const result = await call('/api/cv/detections'+query,'POST',undefined,
      JSON.stringify({frame_id:frame.headers.get('etag').slice(1,-1),objects:[]}),
      {'Content-Type':'application/json'});
    assert.equal(result.status,204);
  };
  await publishFrame();
  const measured = await read(await call('/api/preview/A','GET',desk),200);
  assert.deepEqual(measured.objects,[]);
  assert.deepEqual(await readiness(),{A:'detecting',B:'live'});
  const nextA = Buffer.from([255,216,33,255,217]);
  t.mock.timers.tick(100);
  assert.equal((await push(a,nextA)).status,204);
  t.mock.timers.tick(700);
  const delayed = await read(await call('/api/preview/A','GET',desk),200);
  assert.equal(delayed.analysis_delayed,true);
  assert.notEqual(delayed.frame_id,measured.frame_id);
  assert.deepEqual(Buffer.from(delayed.jpeg,'base64'),nextA);
  assert.equal(delayed.objects,null);
  assert.equal(delayed.depth_preview,undefined);
  assert.equal((await readiness()).A,'live');
  const staleReply = await read(await call('/api/agent/chat','POST',desk,
    JSON.stringify({text:'What is in front of me?',mode:'scene',camera_id:'A'}),
    {'Content-Type':'application/json'}),200);
  assert.equal(staleReply.source,'unavailable');
  await publishFrame();
  const current = await read(await call('/api/preview/A','GET',desk),200);
  assert.equal(current.analysis_delayed,undefined);
  assert.equal(current.frame_id,delayed.frame_id);
  assert.deepEqual(current.objects,[]);
  const {token:a2} = await read(await join(await pair('A')),200);
  assert.equal((await push(a,jpegA)).status,401);
  assert.equal((await call('/api/frame/A','GET',desk)).status,204);
  assert.equal((await push(a2,jpegA)).status,204);
  assert.equal((await call('/api/frame','DELETE',a2)).status,204);
  assert.equal((await call('/api/frame/A','GET',desk)).status,204);
  t.mock.timers.tick(5100);
  assert.equal((await call('/api/frame/B','GET',desk,undefined,{'If-None-Match':'"unknown"'})).status,204);
});

test('weak same-frame boxes are visual only and fresh hazards wake the waiting dashboard', async t => {
  const server = createServer({agent:{filename:':memory:'}});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (path, method, token, body, extra = {}, signal) => fetch(base+path,{
    method,body,headers:{...(token ? {Authorization:'Bearer '+token} : {}),...extra},signal
  });
  const json = {'Content-Type':'application/json'};
  const {token:desk} = await (await call('/api/session','POST')).json();
  const {code} = await (await call('/api/pair/A','POST',desk)).json();
  const {token:phone} = await (await call('/api/join','POST',undefined,JSON.stringify({code}),json)).json();
  await call('/api/agent/alerts','GET',desk);
  const jpeg = Buffer.from([255,216,42,255,217]);
  const box = {label:'chair',bbox:[.2,.2,.6,.8],position:'center',track_id:'A-1',risk:'urgent'};
  async function upload() {
    const sample = Date.now()-40;
    assert.equal((await call('/api/frame','PUT',phone,jpeg,{
      'Content-Type':'image/jpeg','X-Sample-Ms':sample,'X-Clock-Error-Ms':4
    })).status,204);
    const {sources:[source]} = await (await call('/api/cv/sources')).json();
    const query = '?camera_id=A&source_id='+source.source_id;
    const frame = await call('/api/cv/frame'+query);
    return {sample,query,frame_id:frame.headers.get('etag').slice(1,-1)};
  }
  async function publish(input, objects, preview_objects = []) {
    const response = await call('/api/cv/detections'+input.query,'POST',undefined,
      JSON.stringify({frame_id:input.frame_id,objects,preview_objects}),json);
    assert.equal(response.status,204);
    return response;
  }
  const weak = await upload();
  await publish(weak,[],[{...box,confidence:.32}]);
  const preview = await (await call('/api/preview/A','GET',desk)).json();
  assert.equal(preview.frame_id,weak.frame_id);
  assert.equal(preview.preview_objects[0].track_id,'A-1');
  assert.deepEqual(preview.objects,[]);
  assert.equal((await (await call('/api/agent/alerts','GET',desk)).json()).alerts.length,0);
  const pending = call('/api/agent/alerts?wait=1&after=0','GET',desk,undefined,{},AbortSignal.timeout(850));
  const strong = await upload();
  const result = await publish(strong,[{...box,confidence:.78}]);
  assert.ok(result.headers.has('x-cv-capture-latency-ms'));
  const {alerts:[alert]} = await (await pending).json();
  assert.equal(alert.capture_ms,strong.sample);
  assert.equal(alert.capture_error_ms,4);
  assert.ok(alert.judged_ms >= alert.capture_ms);
});
