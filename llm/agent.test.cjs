const test = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const http = require('node:http');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {createAgent} = require('./agent.cjs');
const {createServer} = require('../web/server.cjs');
const echoOcr = async messages => JSON.parse(messages.at(-1).content).ocr_text;

test('fixed OCR demo is opt-in and its labeled reply reaches speech synthesis', async () => {
  const previous = process.env.VISIONASSIST_OCR_DEMO;
  const worker = async (mode, data) => {
    assert.equal(mode,'tts');
    assert.deepEqual(data,{text:'Text recognition demo. Study Room G17',language:'en'});
    return {audio:Buffer.from('RIFF mocked WAV').toString('base64')};
  };
  let enabled, disabled;
  try {
    process.env.VISIONASSIST_OCR_DEMO = '1';
    enabled = createAgent({worker});
    delete process.env.VISIONASSIST_OCR_DEMO;
    disabled = createAgent({worker});
  } finally {
    if (previous === undefined) delete process.env.VISIONASSIST_OCR_DEMO;
    else process.env.VISIONASSIST_OCR_DEMO = previous;
  }
  const session = {slots:{A:{frame:Buffer.from([255,216,255,217]),etag:'"sample"',stamp:Date.now()}}};
  const input = {text:'Help me identify the text.'};
  const noCamera = {slots:{A:{}}};
  assert.equal((await disabled.chat(noCamera,input)).source,'unavailable');
  assert.equal((await enabled.chat(noCamera,input)).source,'unavailable');
  const reply = await enabled.chat(session,input);
  assert.equal(reply.source,'ocr_demo');
  assert.match((await enabled.synthesize(reply.reply_text)).toString(),/^RIFF/);
});

test('spoken variations and the Quick Actions mode route directly to OCR', async () => {
  const session = {slots:{A:{frame:Buffer.from('image'),etag:'"sign"',stamp:Date.now()}}};
  let ocrModelCalls = 0;
  let failModel = false;
  const agent = createAgent({filename:':memory:', recognizeText:async () => ({text:'Library'}), generate:async messages => {
    if (!messages[0].content.includes('verified OCR')) return 'General reply';
    assert.equal(await echoOcr(messages),'Library');
    ocrModelCalls++;
    if (failModel) throw new Error('Ollama offline');
    return 'Wrong sign';
  }});
  try {
    const phrases = ['帮我读一下文字', '嗯，帮我读一下文字好吗？', '能不能帮我看看上面写了什么？',
      '请念一下画面里的字。', 'Can you tell me what is written on this sign?', '那么我识别一下文字',
      '那么，我想识别一下画面里的文字。'];
    for (const text of phrases) {
      assert.equal((await agent.chat(session,{text})).reply_text,'Library',text);
    }
    assert.equal((await agent.chat(session,{text:'Read camera text',mode:'read_text'})).source,'ocr');
    assert.equal((await agent.chat(session,{text:'Please read my last reply.'})).source,'llm');
    assert.equal((await agent.chat(session,{text:'我想了解怎么识别文字。'})).source,'llm');
    assert.equal(ocrModelCalls,phrases.length+1);
    failModel = true;
    assert.equal((await agent.chat(session,{text:'帮我读文字'})).ocr_status,'model_unavailable');
  } finally { agent.close(); }
});

test('Ollama maps indirect chat to the camera OCR action and leaves how-to questions in chat', async () => {
  const session = {slots:{A:{frame:Buffer.from('image'),etag:'"sign"',stamp:Date.now()}}};
  let recognitionCalls = 0;
  const agent = createAgent({filename:':memory:', recognizeText:async () => { recognitionCalls++; return {text:'Library G17'}; },
    generate:async (messages,image,format) => {
      if (format?.properties?.intent) {
        assert.equal(image,null);
        const {utterance} = JSON.parse(messages.at(-1).content);
        return JSON.stringify({intent:utterance.includes('门口') ? 'read_room_number' : 'none'});
      }
      if (messages[0].content.includes('verified OCR')) return echoOcr(messages);
      return 'General reply';
    }});
  try {
    assert.equal((await agent.chat(session,{text:'门口牌子写啥'})).reply_text,'Library G17');
    assert.equal((await agent.chat(session,{text:'OCR 怎么识别文字？'})).source,'llm');
    session.slots.A = {};
    assert.equal((await agent.chat(session,{text:'门口牌子写啥'})).ocr_status,'no_frame');
    assert.equal(recognitionCalls,1);
  } finally { agent.close(); }
});

test('OCR speaks distinct retry messages and suppresses results from replaced or expired frames', async () => {
  const frame = (id,stamp=Date.now()) => ({frame:Buffer.from(id),etag:`"${id}"`,stamp});
  const session = {slots:{A:{},B:frame('b')}};
  const input = {text:'Help me identify the text.'};
  let recognize;
  const agent = createAgent({recognizeText:request => recognize(request),generate:echoOcr});
  const ask = () => agent.chat(session,input);
  try {
    assert.equal((await ask()).ocr_status,'no_frame');
    session.slots.A = frame('expired',Date.now()-6000);
    assert.equal((await ask()).ocr_status,'stale_frame');
    session.slots.A = frame('live');
    for (const [result,status] of [
      [{text:''},'no_text'], [{text:'',uncertain:true},'uncertain'], [{text:'',invalid_frame:true},'invalid_frame']
    ]) {
      recognize = async () => result;
      assert.equal((await ask()).ocr_status,status);
    }
    recognize = async () => ({text:'Exit',uncertain:true});
    const partial = await ask();
    assert.equal(partial.ocr_status,'partial');
    assert.match(partial.reply_text,/unclear.*Exit/);
    recognize = async () => { throw Object.assign(new Error('test timeout'),{code:'ETIMEDOUT'}); };
    assert.equal((await ask()).ocr_status,'timeout');
    recognize = async () => { throw new Error('test crash'); };
    assert.equal((await ask()).ocr_status,'worker_error');
    recognize = async () => {
      session.slots.A = frame('reconnected');
      return {text:'Old sign text'};
    };
    const replaced = await ask();
    assert.equal(replaced.ocr_status,'camera_changed');
    assert.doesNotMatch(replaced.reply_text,/Old sign text/);
    session.slots.A = frame('aging',Date.now()-4990);
    recognize = async () => {
      await new Promise(resolve => setTimeout(resolve,30));
      Object.assign(session.slots.A,frame('newer'));
      return {text:'Previous sign'};
    };
    assert.equal((await ask()).ocr_status,'stale_frame');
  } finally { agent.close(); }
});

test('Gxx room-number requests require agreement from two recent frames of the same camera', async () => {
  const frame = (id,stamp) => ({frame:Buffer.from(id),etag:`"${id}"`,stamp});
  const session = {slots:{}};
  let nextCode, gap;
  const agent = createAgent({generate:echoOcr,recognizeText:async ({frame_id,camera_id,timestamp_ms}) => {
    assert.equal(camera_id,'A');
    if (frame_id === 'first') {
      Object.assign(session.slots.A,frame('second',timestamp_ms+gap));
      return {text:'G17'};
    }
    return {text:nextCode};
  }});
  try {
    for (const [code,interval,status] of [
      ['G17',200,'room_confirmed'], ['G18',200,'uncertain'], ['G17',2200,'uncertain']
    ]) {
      nextCode = code;
      gap = interval;
      session.slots.A = frame('first',Date.now()-2500);
      const result = await agent.chat(session,{text:'请帮我读一下门牌号。'});
      assert.equal(result.ocr_status,status);
      if (status === 'room_confirmed') assert.equal(result.reply_text,'G17');
      else assert.doesNotMatch(result.reply_text,/G1[78]/);
    }
  } finally { agent.close(); }
});

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
    const [habit] = agent.records('habit');
    assert.deepEqual(agent.savePreferences({concise:false,habit:habit.id,interval_minutes:0}),{concise:false,habit:habit.id,interval_minutes:0});
    agent.close();
    agent = createAgent({filename});
    assert.match((await agent.chat({slots:{}},{text:'出门前要记得做什么？'})).reply_text,/检查钥匙/);
    const [row] = agent.records('habit');
    assert.deepEqual(agent.preferences(),{concise:false,habit:row.id,interval_minutes:0});
    const live = {slots:{A:{stamp:Date.now(),frame:Buffer.from('live')}}};
    assert.match(agent.cameraReminder(live),/检查钥匙/);
    assert.equal(agent.cameraReminder(live),null);
    live.slots.A = {};
    assert.equal(agent.cameraReminder(live),null);
    live.slots.A = {stamp:Date.now(),frame:Buffer.from('new frame')};
    assert.match(agent.cameraReminder(live),/检查钥匙/);
    assert.equal(agent.remove('habit',row.id),true);
    assert.deepEqual(agent.preferences(),{concise:false,habit:null,interval_minutes:0});
    assert.deepEqual(agent.records('habit'),[]);
  } finally { agent.close(); rmSync(directory,{recursive:true,force:true}); }
});

test('natural water-bottle enrollment uses the sole live camera and stays out of habits', async () => {
  const feature = {version:'spatial-hsv-v1',vector:[1,...Array(539).fill(0)]};
  const bottle = {label:'bottle',position:'center',confidence:.95,bbox:[.2,.1,.8,.9],item_feature:feature};
  const agent = createAgent({filename:':memory:',generate:async () => 'Unexpected general response'});
  const session = {slots:{A:{detection:{timestamp_ms:Date.now(),camera_id:'A',objects:[bottle]}},B:{}}};
  try {
    for (const text of ['这是我的水杯','记住，这是我的水杯，以后帮我找']) {
      const proposal = await agent.chat(session,{text,camera_id:'both'});
      assert.equal(proposal.source,'confirmation');
      assert.match(proposal.confirmation.summary,/物品/);
      assert.deepEqual(agent.records('habit'),[]);
      assert.deepEqual(agent.records('item'),[]);
      if (text.startsWith('这是')) await agent.chat(session,{text:'取消'});
    }
    await agent.chat(session,{text:'确认'});
    assert.equal(agent.records('item')[0].name,'水杯');
    assert.equal((await agent.chat(session,{text:'我的水杯在哪里？',camera_id:'both'})).source,'camera');
  } finally { agent.close(); }
});

test('paired camera, exact-frame YOLO, alerts, assisted vision and local model adapters', async t => {
  const generated = [];
  const ocrRequests = [];
  const recognizeText = async request => {
    ocrRequests.push(request);
    return {text:'Study Room G17'};
  };
  const itemFeature = index => ({
    version:'spatial-hsv-v1', vector:Array.from({length:540},(_,i) => Number(i === index))
  });
  let itemExtractions = 0;
  const worker = async (mode,data) => {
    if (mode === 'stt') {
      assert.equal(data.language,'en');
      return {text:'Help me identify the text.'};
    }
    if (mode === 'docx') {
      assert.deepEqual(data.messages.map(message => message.role),['user','assistant']);
      return {document:Buffer.from('PK mocked DOCX').toString('base64')};
    }
    if (mode === 'tts') {
      assert.deepEqual(data,{text:'Study Room G17',language:'en'});
      return {audio:Buffer.from('RIFF mocked WAV').toString('base64')};
    }
    const byte = Buffer.from(data.image,'base64')[2];
    const unknown = byte === 9;
    if (mode === 'item') {
      itemExtractions++;
      const feature = itemFeature(unknown ? 1 : 0);
      if (byte === 8) {
        feature.vector[0] = 0.9;
        feature.vector[1] = Math.sqrt(1-0.9**2);
      }
      return {features:data.boxes.map(() => feature)};
    }
    return {features:[{version:'test',vector:unknown ? [0,1] : [1,0]}]};
  };
  const generate = async (messages,image) => {
    generated.push({messages,image});
    if (messages[0].content.includes('verified OCR')) return echoOcr(messages);
    return image ? 'The box looks blue.' : 'Hello.';
  };
  const server = createServer({agent:{filename:':memory:',worker,generate,recognizeText}});
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
  assert.match((await chat('Help me identify the text.')).reply_text,/no recent frame/);
  assert.equal(ocrRequests.length,0);
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
  const pinnedStamp = Number(pinned.headers.get('x-cv-frame-ms'));
  assert.ok(pinnedStamp > 0);
  assert.deepEqual(Buffer.from(await pinned.arrayBuffer()),frame(3));
  const rawPreview = await json(await call('/api/preview/A',{token:desk}),200);
  assert.equal(rawPreview.objects,null);
  assert.equal(rawPreview.timestamp_ms,pinnedStamp);
  await push(phone,3);
  const objects = [{label:'bottle',position:'center',confidence:.95,bbox:[.3,.2,.7,.8],risk:'caution',track_id:1}];
  const publish = (id,value=objects,metadata={}) => call('/api/cv/detections'+query,
    {method:'POST',body:{frame_id:id,objects:value,...metadata}});
  assert.equal((await publish('unknown')).status,409);
  assert.equal((await publish(frame_id,[{...objects[0],bbox:[.7,.2,.3,.8]}])).status,400);
  const latestFrame = (await call('/api/cv/frame'+query)).headers.get('etag').slice(1,-1);
  assert.notEqual(latestFrame,frame_id);
  const metadata = {schema_version:1,camera_id:'A',timestamp_ms:pinnedStamp};
  for (const invalid of [{schema_version:2},{camera_id:'B'},{timestamp_ms:pinnedStamp+1}]) {
    assert.equal((await publish(frame_id,objects,{...metadata,...invalid})).status,400);
  }
  assert.equal((await publish(frame_id, [{...objects[0],risk:undefined,obstacle_candidate:true}],metadata)).status,204);
  const candidatePreview = await json(await call('/api/preview/A',{token:desk}),200);
  assert.equal(candidatePreview.frame_id,frame_id);
  assert.equal(candidatePreview.schema_version,1);
  assert.equal(candidatePreview.camera_id,'A');
  assert.equal(candidatePreview.timestamp_ms,pinnedStamp);
  assert.equal(candidatePreview.objects[0].obstacle_candidate,true);
  assert.equal(candidatePreview.objects[0].risk,'normal');
  assert.deepEqual((await json(await call('/api/agent/alerts?after=0',{token:desk}),200)).alerts,[]);

  assert.equal((await publish(latestFrame)).status,204);
  assert.equal((await publish(latestFrame)).status,204);
  assert.match((await chat('我前面有什么')).reply_text,/bottle/);
  assert.equal(ocrRequests.length,0);
  assert.match((await chat('哪个物体更近？')).reply_text,/无法判断/);
  assert.match((await chat('哪个物体更远？', {camera_id:'B'})).reply_text,/没有可用/);
  const alert = await json(await call('/api/agent/alerts?after=0',{token:desk}),200);
  assert.equal(alert.alerts.length,1);
  const item = await chat('这个水杯是我的');
  assert.ok(item.confirmation);
  assert.match((await chat('确认')).reply_text,/保存/);
  assert.equal(itemExtractions,1);
  await push(phone,3);
  const featureFrame = (await call('/api/cv/frame'+query)).headers.get('etag').slice(1,-1);
  const featured = {...objects[0],item_feature:itemFeature(0)};
  assert.equal((await publish(featureFrame,[featured])).status,204);
  const featuredPreview = await json(await call('/api/preview/A',{token:desk}),200);
  assert.equal(featuredPreview.objects[0].item_feature,undefined);
  const live = await chat('我的水杯在哪里？');
  assert.equal(live.source,'camera');
  assert.equal(live.observation.position,'center');
  assert.equal(live.observation.camera,featuredPreview.camera_id);
  assert.equal(Date.parse(live.observation.time),featuredPreview.timestamp_ms);
  assert.equal(itemExtractions,1);
  const cvEnrollment = await chat('这个蓝杯是我的');
  assert.ok(cvEnrollment.confirmation);
  assert.equal(itemExtractions,1);
  await chat('取消');
  const {records:[saved]} = await json(await call('/api/memory/items',{token:desk}),200);
  await chat('我的水杯在哪里？');
  const {observations} = await json(await call('/api/memory/items/'+saved.id+'/history',{token:desk}),200);
  assert.deepEqual(observations,[live.observation]);
  assert.equal((await chat('上次在哪里看到我的水杯？',{camera_id:'both'})).source,'history');
  assert.equal((await chat('Is it safe to walk forward?')).source,'unavailable');
  assert.equal((await call('/api/memory/items/'+saved.id,{method:'PATCH',token:desk,body:{name:'蓝水杯'}})).status,204);
  assert.equal((await chat('我的蓝水杯在哪里？')).source,'camera');
  await push(phone,8);
  const uncertainFrame = (await call('/api/cv/frame'+query)).headers.get('etag').slice(1,-1);
  assert.equal((await publish(uncertainFrame,[{...objects[0],risk:'urgent'}])).status,204);
  const candidate = await chat('我的蓝水杯在哪里？');
  assert.match(candidate.confirmation.summary,/确认这是你的物品/);
  assert.equal((await chat('确认')).source,'history');
  const updated = await json(await call('/api/memory/items/'+saved.id+'/history',{token:desk}),200);
  assert.equal(updated.observations.length,2);
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
  assert.match(generated.at(-1).messages[0].content,/Never identify people or provide walking directions/);
  assert.deepEqual(await json(await call('/api/agent/preferences',{
    method:'PUT',token:desk,body:{concise:false,habit:null,interval_minutes:0}
  }),200),{concise:false,habit:null,interval_minutes:0});
  assert.equal((await chat('Hello')).source,'llm');
  assert.equal((await chat('Can you repeat that?')).source,'llm');
  assert.ok(generated.at(-1).messages.some(message => message.role === 'assistant'));
  assert.match(generated.at(-1).messages[0].content,/up to four short sentences/);
  const modelCalls = generated.length;
  assert.match((await chat('你是誰？')).reply_text,/^我是 VisionAssist/);
  assert.match((await chat('Who are you?')).reply_text,/VisionAssist/);
  assert.equal(generated.length,modelCalls);
  const speech = await json(await call('/api/agent/transcribe?language=en',{method:'POST',token:desk,
    type:'audio/webm',body:Buffer.from('mock audio')}),200);
  assert.equal(speech.text,'Help me identify the text.');
  const ocrReply = await chat(speech.text);
  assert.equal(ocrReply.reply_text,'Study Room G17');
  assert.equal((await chat('请帮我读一下门牌。',{camera_id:'B'})).source,'ocr');
  assert.equal((await chat('What does this sign say?',{camera_id:'both'})).source,'unavailable');
  assert.equal(ocrRequests.length,2);
  const previewB = await json(await call('/api/preview/B',{token:desk}),200);
  assert.deepEqual(ocrRequests[1],{
    image:frame(3), camera_id:'B', frame_id:previewB.frame_id, timestamp_ms:previewB.timestamp_ms
  });
  assert.deepEqual(ocrRequests[0].image,frame(9));
  assert.equal(generated.length,modelCalls+2);
  assert.equal(generated.at(-1).image,null);
  assert.equal(await echoOcr(generated.at(-1).messages),'Study Room G17');
  const exported = await call('/api/agent/export',{method:'POST',token:desk,body:{
    messages:[{role:'user',text:'你好'},{role:'assistant',text:'我是 VisionAssist'}]
  }});
  assert.equal(exported.status,200);
  assert.match(exported.headers.get('content-disposition'),/\.docx/);
  const spoken = await call('/api/agent/speech',{method:'POST',token:desk,body:{text:ocrReply.reply_text}});
  assert.equal(spoken.headers.get('content-type'),'audio/wav');
  assert.match(await spoken.text(),/^RIFF/);
  await pair();
  assert.equal((await publish(frame_id)).status,409);
  const afterPair = await json(await call('/api/agent/alerts?after=0',{token:desk}),200);
  assert.deepEqual(afterPair.alerts,[]);
  assert.equal((await chat('我的蓝水杯在哪里？')).source,'history');
});

test('optional routines, semantic memory, planning and reminder API work together', async t => {
  const directory = mkdtempSync(join(tmpdir(),'visionassist-optional-'));
  const filename = join(directory,'memory.sqlite');
  const embeddingCalls = [];
  let clock = Date.now();
  const options = {
    filename,
    now:() => clock,
    embed:async (_model,inputs) => {
      embeddingCalls.push(inputs);
      return inputs.map(input => /keys|leav/i.test(input) ? [1,0,0] : /dishes|洗碗/iu.test(input) ? [0,1,0] : [0,0,1]);
    },
    generate:async (messages,_image,format) => {
      if (format) {
        assert.equal(format.properties.steps.type,'array');
        return messages.at(-1).content === 'pack a backpack'
          ? JSON.stringify({steps:['Put the empty bag on a table.','Pack your notebook.']})
          : '{"steps":[]}';
      }
      return messages[0].content;
    }
  };
  const server = createServer({agent:options});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    rmSync(directory,{recursive:true,force:true});
  });
  const root = 'http://127.0.0.1:'+server.address().port;
  async function request(path,{method='GET',body,token,status=200,type='application/json'}={}) {
    const response = await fetch(root+path,{
      method,
      body:body && (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
      headers:{...(token && {Authorization:'Bearer '+token}),...(body && {'Content-Type':type})}
    });
    assert.equal(response.status,status);
    return status === 204 ? undefined : response.json();
  }
  const createSession = async () => (await request('/api/session',{method:'POST',status:201})).token;
  const desk = await createSession();
  const chat = (text,token=desk) => request('/api/agent/chat',{method:'POST',token,body:{text}});
  const habits = () => request('/api/memory/habits',{token:desk}).then(result => result.records);
  const pair = async token => {
    const {code} = await request('/api/pair/A',{method:'POST',token,status:201});
    return (await request('/api/join',{method:'POST',body:{code}})).token;
  };
  const publish = token => request('/api/frame',{
    method:'PUT',token,type:'image/jpeg',body:Buffer.from([255,216,4,255,217]),status:204
  });
  const alerts = token => request('/api/agent/alerts?reminders=1',{token});

  assert.match((await chat('I usually check my keys')).confirmation.summary,/routine/);
  assert.deepEqual(await habits(),[]);
  await chat('cancel');
  assert.deepEqual(await habits(),[]);
  assert.equal((await chat('我今天出门前检查了钥匙')).confirmation,null);
  assert.equal((await chat('我今天出门前检查了钥匙')).confirmation,null);
  clock += 60_000;
  assert.match((await chat('我刚才出门前检查了钥匙')).confirmation.summary,/日常习惯/);
  assert.deepEqual(await habits(),[]);
  await chat('取消');
  await chat('I usually check my keys');
  await chat('confirm');
  await chat('我每天洗碗');
  await chat('确认');
  const [keys] = await habits();
  assert.match((await chat('Search memory leaving home')).reply_text,/check my keys/);
  assert.equal(embeddingCalls[0].length,3);
  assert.match((await chat('Search memory leaving home')).reply_text,/check my keys/);
  assert.deepEqual(embeddingCalls[1],['leaving home']);
  assert.match((await chat('Search memory weather')).reply_text,/no related/);

  const saved = {concise:false,habit:keys.id,interval_minutes:15};
  assert.deepEqual(await request('/api/agent/preferences',{method:'PUT',token:desk,body:saved}),saved);
  await request('/api/agent/preferences',{method:'PUT',token:desk,body:{...saved,habit:true},status:400});
  assert.match((await chat('Hello')).reply_text,/up to four short sentences/);
  const phone = await pair(desk);
  assert.equal((await alerts(desk)).reminder,null);
  await publish(phone);
  assert.equal((await alerts(desk)).reminder,keys.name);
  assert.equal((await alerts(desk)).reminder,null);
  const other = await createSession();
  const otherPhone = await pair(other);
  await publish(otherPhone);
  assert.equal((await alerts(other)).reminder,null);
  clock += 15*60_000;
  const later = await createSession();
  await publish(await pair(later));
  assert.equal((await alerts(later)).reminder,keys.name);

  assert.match((await chat('Plan pack a backpack')).reply_text,/Step 1 of 2/);
  assert.match((await chat('repeat step')).reply_text,/Step 1 of 2/);
  assert.match((await chat('next step',other)).reply_text,/no active plan/);
  assert.match((await chat('next step')).reply_text,/Pack your notebook/);
  assert.match((await chat('next step')).reply_text,/end of the plan/);
  await chat('Plan pack a backpack');
  assert.match((await chat('cancel plan')).reply_text,/cancelled/);
  assert.equal((await chat('Plan cross a street')).source,'unavailable');

  await new Promise(resolve => server.close(resolve));
  const reopened = createAgent(options);
  try {
    assert.deepEqual(reopened.preferences(),saved);
    const session = {slots:{}};
    assert.match((await reopened.chat(session,{text:'Search memory leaving home'})).reply_text,/check my keys/);
    assert.deepEqual(embeddingCalls.at(-1),['leaving home']);
    assert.equal(reopened.remove('habit',keys.id),true);
    assert.equal(reopened.preferences().habit,null);
    assert.match((await reopened.chat(session,{text:'Search memory leaving home'})).reply_text,/no related/);
  } finally {
    reopened.close();
  }
});
