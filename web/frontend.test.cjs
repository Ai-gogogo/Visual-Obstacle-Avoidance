const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

test('spoken alerts are opt-in, use mode-specific evidence and pause on camera loss', async () => {
  const {connectAlerts} = await import('./features/alerts/alerts-controller.js');
  const controls = new Map();
  const $ = id => {
    if (!controls.has(id)) controls.set(id,Object.assign(new EventTarget(),{textContent:''}));
    return controls.get(id);
  };
  const controller = new AbortController();
  const played = [];
  let cancelled = 0;
  let respond;
  let sequence = 0;
  const cameras = {A:'detecting',B:'live'};
  connectAlerts({$, scope:{signal:controller.signal,delay() {},listen:(target,type,handler) => target.addEventListener(type,handler)},
    agentRequest:() => new Promise(resolve => { respond = resolve; }),
    isAssist:() => true,isConversationBusy:() => false,transcriptionLanguage:() => 'zh',
    showWarningTiming() {},prepareSpokenAlerts() {},playSpokenAlert:(text,urgent,canPlay) => played.push({text,urgent,canPlay}),
    cancelSpokenAlert:() => { cancelled++; }});

  function select(value) {
    $('#spoken-alert-mode').value = value;
    $('#spoken-alert-mode').dispatchEvent(new Event('change'));
  }
  async function event(fields, feeds = cameras) {
    const now = Date.now();
    const alert = {risk:'urgent',stamp:now,judged_ms:now,text:'Warning',...fields};
    respond({sequence:++sequence,alerts:[alert],cameras:feeds});
    await new Promise(resolve => setImmediate(resolve));
  }

  const crossing = () => ({kind:'path_intrusion',expires:Date.now()+1100});
  await event({...crossing(),stationary_zone:true});
  assert.equal(played.length,0);
  select('stationary');
  await event(crossing());
  await event({kind:'road_edge',metric:true});
  assert.equal(played.length,0);
  await event({...crossing(),stationary_zone:true});
  assert.match(played[0].text,/正在靠近/);
  assert.equal(played[0].canPlay(),true);

  const beforeLoss = cancelled;
  await event({...crossing(),stationary_zone:true},{A:'detecting',B:'offline'});
  assert.equal(played.length,1);
  assert.equal(played[0].canPlay(),false);
  assert.ok(cancelled > beforeLoss);
  select('walking');
  await event({kind:'road_edge',metric:false});
  await event({kind:'road_edge',metric:true,stamp:Date.now()-1600});
  await event({...crossing(),expires:Date.now()-1});
  assert.equal(played.length,1);
  await event(crossing());
  await event({kind:'road_edge',metric:true});
  assert.match(played[1].text,/横穿/);
  assert.match(played[2].text,/车行道/);
  const obstacle = fields => ({kind:'obstacle',track_id:'A-7',label:'chair',risk:'caution',
    text:'Caution. chair straight ahead.',text_zh:'小心，正前方约2米有椅子。',...fields});
  await event(obstacle());
  assert.equal(played[3].text,'小心，正前方约2米有椅子。');
  assert.equal(played[3].urgent,false);
  await event(obstacle());
  assert.equal(played.length,4);
  await event(obstacle({risk:'urgent',text_zh:'注意，正前方约1米有椅子。'}));
  assert.equal(played[4].text,'注意，正前方约1米有椅子。');
  assert.equal(played[4].urgent,true);
  await event(obstacle({risk:'urgent'}));
  assert.equal(played.length,5);
  select('stationary');
  await event(obstacle({track_id:'A-8'}));
  assert.equal(played.length,5);
  select('desk');
  assert.equal(played[2].canPlay(),false);
  controller.abort();
  respond({sequence,alerts:[],cameras});
});

test('assistant controls accept spoken confirmation and direct page actions', async () => {
  const {matchVoiceCommand} = await import('./features/assistant/commands.js');
  const valid = [
    ['确认',{kind:'confirm',value:true}],
    ['取消登记',{kind:'confirm',value:false}],
    ['发送转写',{kind:'sendReview'}],
    ['再读一遍',{kind:'replay'}],
    ['生成相机 A 的配对码',{kind:'pair',value:'A'}],
    ['生成右边相机的配对码',{kind:'pair',value:'B'}],
    ['提醒间隔设为十五分钟',{kind:'preference',field:'interval_minutes',value:15}],
    ['回答简短点',{kind:'preference',field:'concise',value:true}],
    ['把 USB 相机 A 选第一个',{kind:'usbSlot',side:'A',value:1}],
    ['切到左边',{kind:'camera',value:'A'}]
  ];
  for (const [phrase,command] of valid) assert.deepEqual(matchVoiceCommand(phrase),command,phrase);
  for (const phrase of ['确认一下这是哪种杯子','不要确认保存','确认可以吗']) assert.equal(matchVoiceCommand(phrase),null);
});

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
  assert.match(html,/Test warning audio/);
  assert.match(html,/Compare cameras/);
  assert.match(html,/Help me identify the text/);
  assert.match(html,/Reduce motion/);
  assert.match(html,/Stereo calibration/);
  assert.match(html,/Depth algorithm/);
  assert.match(html,/RAFT-Stereo/);
  assert.match(html,/Record A \+ B/);
  assert.match(html,/Generate depth comparison/);
  assert.match(html,/<button[^>]*aria-pressed="true"[^>]*aria-controls="camera-b-feed"[^>]*>Show Camera B<\/button>/);
  assert.match(html,/Code for Camera A/);
  assert.match(html,/Code for Camera B/);
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
