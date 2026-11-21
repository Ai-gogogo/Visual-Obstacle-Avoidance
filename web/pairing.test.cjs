const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const {createServer} = require('./server.cjs');

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
  assert.match(await (await call('/')).text(),/Judge view/);
  assert.match(await (await call('/camera')).text(),/Enter pairing code/);
  assert.equal((await call('/demo-lab.webp')).headers.get('content-type'),'image/webp');
  assert.equal((await call('/api/frame/A')).status,401);
  assert.equal((await call('/api/session','POST',undefined,undefined,{Origin:'https://example.test'})).status,403);

  const {token:desk} = await read(await call('/api/session','POST'),201);
  const pair = async side => (await read(await call('/api/pair/'+side,'POST',desk),201)).code;
  const join = code => call('/api/join','POST',undefined,JSON.stringify({code}),{'Content-Type':'application/json'});
  const codeA = await pair('A');
  const codeB = await pair('B');
  assert.notEqual(codeA, codeB);
  const {token:a} = await read(await join(codeA),200);
  assert.equal((await join(codeA)).status,404);
  const {token:b} = await read(await join(codeB),200);
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
  assert.equal((await call('/api/agent/alerts','GET',desk)).status,200);
  const {sources} = await read(await call('/api/cv/sources'),200);
  const source = sources.find(entry => entry.camera_id === 'A');
  const query = '?camera_id=A&source_id='+source.source_id;
  const captured = await call('/api/cv/frame'+query);
  assert.equal(captured.status,200);
  const frameId = captured.headers.get('etag').slice(1,-1);
  const mask = 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAAAAADmVT4XAAAAW0lEQVR42u3OMQEAAAgDoKn9OxtjDyRgLl0bAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBsgdD7AED8nNciQAAAABJRU5ErkJggg==';
  const postScene = png => call('/api/cv/segmentation'+query,'POST',undefined,
    JSON.stringify({frame_id:frameId,width:480,height:640,mask:png}),{'Content-Type':'application/json'});
  assert.equal((await postScene('AA==')).status,400);
  assert.equal((await postScene(mask)).status,204);
  assert.equal((await call('/api/segmentation/A','GET',a)).status,401);
  const scene = await read(await call('/api/segmentation/A','GET',desk),200);
  assert.equal(scene.frame_id,frameId);
  assert.equal(scene.mask,mask);
  const previewTag = (await call('/api/preview/A','GET',desk)).headers.get('etag');
  const unchanged = await call('/api/preview/A','GET',desk,undefined,{'If-None-Match':previewTag});
  assert.equal(unchanged.status,304);
  assert.equal(unchanged.headers.get('X-Segmentation-Frame'),frameId);
  t.mock.timers.tick(751);
  assert.equal((await call('/api/segmentation/A','GET',desk)).status,204);
  assert.equal((await postScene(mask)).status,409);
  const {token:a2} = await read(await join(await pair('A')),200);
  assert.equal((await push(a,jpegA)).status,401);
  assert.equal((await call('/api/frame/A','GET',desk)).status,204);
  assert.equal((await push(a2,jpegA)).status,204);
  assert.equal((await call('/api/frame','DELETE',a2)).status,204);
  assert.equal((await call('/api/frame/A','GET',desk)).status,204);
  t.mock.timers.tick(5100);
  assert.equal((await call('/api/frame/B','GET',desk,undefined,{'If-None-Match':'"unknown"'})).status,204);
});
