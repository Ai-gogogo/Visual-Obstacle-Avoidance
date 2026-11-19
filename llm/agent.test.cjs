const test = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const http = require('node:http');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {createAgent} = require('./agent.cjs');
const {createServer} = require('../web/server.cjs');

test('a habit is private until confirmation, persists after restart and can be deleted', async () => {
  const directory = mkdtempSync(join(tmpdir(),'visionassist-memory-'));
  const filename = join(directory,'memory.sqlite');
  const session = {slots:{A:{},B:{}}};
  let agent = createAgent({filename});
  try {
    const {confirmation} = await agent.chat(session,{text:'记住，我出门前要检查钥匙'});
    assert.deepEqual(agent.records('habit'),[]);
    assert.throws(() => agent.confirm({slots:{}},confirmation.id,true,true),{status:409});
    assert.match((await agent.chat(session,{text:'確認。'})).reply_text,/已保存/);
    agent.close();
    agent = createAgent({filename});
    assert.match((await agent.chat({slots:{}},{text:'出门前要记得做什么？'})).reply_text,/检查钥匙/);
    const [row] = agent.records('habit');
    assert.equal(agent.remove('habit',row.id),true);
    assert.deepEqual(agent.records('habit'),[]);
  } finally { agent.close(); rmSync(directory,{recursive:true,force:true}); }
});

test('paired camera, exact-frame YOLO, alerts, assisted vision and local model adapters', async t => {
  const generated = [];
  const worker = async (mode,data) => {
    if (mode === 'stt') {
      assert.equal(data.language,'en');
      return {text:'What can you see?'};
    }
    if (mode === 'docx') {
      assert.deepEqual(data.messages.map(message => message.role),['user','assistant']);
      return {document:Buffer.from('PK mocked DOCX').toString('base64')};
    }
    if (mode === 'tts') {
      assert.equal(data.language,'zh');
      return {audio:Buffer.from('RIFF mocked WAV').toString('base64')};
    }
    const unknown = Buffer.from(data.image,'base64')[2] === 9;
    return {features:[{version:'test',vector:unknown ? [0,1] : [1,0]}]};
  };
  const generate = async (messages,image) => {
    generated.push({messages,image});
    return image ? 'The box looks blue.' : 'Hello.';
  };
  const server = createServer({agent:{filename:':memory:',worker,generate}});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = 'http://127.0.0.1:'+server.address().port;
  const call = (route, {method='GET',token,body,type='application/json',headers={}} = {}) =>
    fetch(root+route,{method,body:body && (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
      headers:{...(token ? {Authorization:'Bearer '+token} : {}),...(body ? {'Content-Type':type} : {}),...headers}});
  async function json(response,status) {
    assert.equal(response.status,status);
    return response.json();
  }
  const desk = (await json(await call('/api/session',{method:'POST'}),201)).token;
  const chat = (text, fields={}) => call('/api/agent/chat',{method:'POST',token:desk,body:{text,...fields}}).then(response => json(response,200));
  const pair = async (side='A') => {
    const {code} = await json(await call('/api/pair/'+side,{method:'POST',token:desk}),201);
    return (await json(await call('/api/join',{method:'POST',body:{code}}),200)).token;
  };
  const phone = await pair();
  const frame = byte => Buffer.from([255,216,byte,255,217]);
  const push = (token,byte) => call('/api/frame',{method:'PUT',token,type:'image/jpeg',body:frame(byte)});
  assert.equal((await push(phone,3)).status,204);
  assert.equal((await call('/api/memory/people',{token:phone})).status,401);
  const foreignHost = await new Promise((resolve,reject) => {
    http.get(root+'/api/memory/people',{headers:{Host:'example.test',Authorization:'Bearer '+desk}}, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error',reject);
  });
  assert.equal(foreignHost,403);
  assert.equal((await call('/api/cv/sources',{headers:{Origin:root}})).status,403);
  assert.equal((await chat('我前面有什么？')).source,'unavailable');
  const {sources:[source]} = await json(await call('/api/cv/sources'),200);
  const query = '?source_id='+source.source_id+'&camera_id=A';
  const pinned = await call('/api/cv/frame'+query);
  const frame_id = pinned.headers.get('etag').slice(1,-1);
  assert.deepEqual(Buffer.from(await pinned.arrayBuffer()),frame(3));
  await push(phone,3);
  const objects = [{label:'bottle',position:'center',confidence:.95,bbox:[.3,.2,.7,.8],risk:'caution',track_id:1}];
  const publish = (id,value=objects) => call('/api/cv/detections'+query,{method:'POST',body:{frame_id:id,objects:value}});
  assert.equal((await publish('unknown')).status,409);
  assert.equal((await publish(frame_id,[{...objects[0],bbox:[.7,.2,.3,.8]}])).status,400);
  const latestFrame = (await call('/api/cv/frame'+query)).headers.get('etag').slice(1,-1);
  assert.notEqual(latestFrame,frame_id);
  assert.equal((await publish(frame_id, [{...objects[0],risk:undefined,obstacle_candidate:true}])).status,204);
  const candidatePreview = await json(await call('/api/preview/A',{token:desk}),200);
  assert.equal(candidatePreview.frame_id,frame_id);
  assert.equal(candidatePreview.objects[0].obstacle_candidate,true);
  assert.equal(candidatePreview.objects[0].risk,'normal');
  assert.deepEqual((await json(await call('/api/agent/alerts?after=0',{token:desk}),200)).alerts,[]);

  assert.equal((await publish(latestFrame)).status,204);
  assert.equal((await publish(latestFrame)).status,204);
  assert.match((await chat('我前面有什么')).reply_text,/bottle/);
  const alert = await json(await call('/api/agent/alerts?after=0',{token:desk}),200);
  assert.equal(alert.alerts.length,1);
  const item = await chat('这个水杯是我的');
  assert.ok(item.confirmation);
  assert.match((await chat('确认')).reply_text,/保存/);
  const live = await chat('我的水杯在哪里？');
  assert.equal(live.source,'camera');
  assert.equal(live.observation.position,'center');
  assert.equal((await chat('Who is this?')).reply_text,'No people are enrolled.');
  await push(phone,3);
  const person = await chat('登记亲友 小林，哥哥');
  assert.match(person.confirmation.summary,/本人同意/);
  assert.equal((await json(await call('/api/memory/people',{token:desk}),200)).records.length,0);
  await chat('确认');
  assert.match((await chat('这是谁？')).reply_text,/小林/);
  assert.match((await chat('小林是谁？')).reply_text,/哥哥/);
  await push(phone,9);
  assert.match((await chat('这是谁？')).reply_text,/无法确认/);
  const image = await chat('What color is the box?');
  assert.equal(image.source,'image');
  assert.deepEqual(generated.at(-1).image,frame(9));
  assert.match((await chat('Compare cameras',{camera_id:'both'})).reply_text,/Camera B has no recent frame/);
  assert.match((await chat('What is in front of me?', {camera_id:'both'})).reply_text,/Camera B has no recent frame/);
  await push(await pair('B'),3);
  assert.equal((await chat('Compare cameras',{camera_id:'both'})).source,'image');
  assert.deepEqual(generated.at(-1).image,[frame(9),frame(3)]);
  assert.match(generated.at(-1).messages.at(-1).content,/first image is Camera A/);
  assert.equal((await chat('Hello')).source,'llm');
  assert.equal((await chat('Can you repeat that?')).source,'llm');
  assert.ok(generated.at(-1).messages.some(message => message.role === 'assistant'));
  assert.match(generated.at(-1).messages[0].content,/Your product identity is VisionAssist/);
  const modelCalls = generated.length;
  assert.match((await chat('你是誰？')).reply_text,/^我是 VisionAssist/);
  assert.match((await chat('Who are you?')).reply_text,/VisionAssist/);
  assert.equal(generated.length,modelCalls);
  const speech = await json(await call('/api/agent/transcribe?language=en',{method:'POST',token:desk,
    type:'audio/webm',body:Buffer.from('mock audio')}),200);
  assert.equal(speech.text,'What can you see?');
  const exported = await call('/api/agent/export',{method:'POST',token:desk,body:{
    messages:[{role:'user',text:'你好'},{role:'assistant',text:'我是 VisionAssist'}]
  }});
  assert.equal(exported.status,200);
  assert.match(exported.headers.get('content-disposition'),/\.docx/);
  const spoken = await call('/api/agent/speech',{method:'POST',token:desk,body:{text:'你好'}});
  assert.equal(spoken.headers.get('content-type'),'audio/wav');
  assert.match(await spoken.text(),/^RIFF/);
  await pair();
  assert.equal((await publish(frame_id)).status,409);
  assert.equal((await chat('我的水杯在哪里？')).source,'history');
});
