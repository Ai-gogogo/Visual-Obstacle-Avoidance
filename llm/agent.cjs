const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const MAX_FRAME_AGE = 5000;
const cn = text => /[\u3400-\u9fff]/u.test(text);
const clean = text => typeof text === 'string' ? text.trim().slice(0, 200) : '';
const fresh = stamp => stamp && Date.now() - stamp <= MAX_FRAME_AGE;
const normal = name => name.normalize('NFKC').trim().toLowerCase();

function localWorker(mode, data) {
  const envPython = path.join(__dirname,'.venv',...(process.platform === 'win32' ? ['Scripts','python.exe'] : ['bin','python']));
  const python = process.env.VISIONASSIST_PYTHON || (existsSync(envPython) ? envPython : 'python');
  return new Promise((resolve, reject) => {
    const proc = spawn(python, ['-X', 'utf8', path.join(__dirname, 'agent_worker.py'), mode],
      { windowsHide:true, timeout:mode === 'stt' ? 55000 : 15000 });
    let output = '';
    proc.stderr.resume();
    proc.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    proc.stdin.on('error', reject);
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('Local Python worker failed.'));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
    proc.stdin.end(JSON.stringify(data));
  });
}

async function ollama(messages, image) {
  const model = image ? process.env.VISIONASSIST_VISION_MODEL || 'qwen3-vl:2b' :
    process.env.VISIONASSIST_CHAT_MODEL || 'qwen3:4b-instruct-2507-q4_K_M';
  if (/cloud/i.test(model)) throw new Error('Choose a local Ollama model.');
  const input = messages.map(message => ({...message}));
  if (image) input.at(-1).images = (Array.isArray(image) ? image : [image]).map(frame => frame.toString('base64'));
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model, messages:input, stream:false, think:false,
      keep_alive:image ? 0 : '2m', options:{num_ctx:4096,num_predict:140}}),
    signal:AbortSignal.timeout(55000)
  });
  if (!response.ok) throw new Error('Ollama could not run the requested local model.');
  const {message} = await response.json();
  if (!clean(message?.content)) throw new Error('Ollama returned no answer.');
  return message.content.trim();
}

function createAgent({ filename, worker = localWorker, generate = ollama } = {}) {
  let db;
  const busy = new Set();
  function database() {
    if (db) return db;
    const target = filename || process.env.VISIONASSIST_DB || path.join(__dirname, '.visionassist', 'memory.sqlite');
    if (target !== ':memory:') mkdirSync(path.dirname(target), {recursive:true});
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(target);
    db.exec('PRAGMA foreign_keys=ON');
    db.exec("CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, normalized TEXT, label TEXT, last_seen TEXT, UNIQUE(kind, normalized));" +
      "CREATE TABLE IF NOT EXISTS sample (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES memory(id) ON DELETE CASCADE, feature TEXT);");
    return db;
  }

  const records = kind => database().prepare('SELECT id, kind, name, label, last_seen FROM memory WHERE kind=? ORDER BY id').all(kind);
  const find = (kind, name) => database().prepare('SELECT * FROM memory WHERE kind=? AND normalized=?').get(kind, normal(name));
  const samples = id => database().prepare('SELECT feature FROM sample WHERE owner=?').all(id).map(row => JSON.parse(row.feature));
  const failure = (status, message) => Object.assign(new Error(message), {status, publicMessage:message});
  const output = (text, source = 'memory', extra = {}) => ({reply_text:text, source, confirmation:null, ...extra});
  const copyFrame = slot => fresh(slot?.stamp) && slot.frame;
  const detections = slot => fresh(slot?.detection?.stamp) ? slot.detection : null;

  async function runResource(kind, operation) {
    if (busy.has(kind)) {
      throw failure(429, 'The local assistant is busy. Try again shortly.');
    }
    busy.add(kind);
    try { return await operation(); }
    finally { busy.delete(kind); }
  }

  async function extract(kind, frame, boxes) {
    try {
      return await runResource('vision', () => worker(kind, {image:frame.toString('base64'), boxes}));
    } catch (error) {
      if (error.publicMessage) throw error;
      throw failure(503, 'Local visual matching is unavailable. Check the Python requirements and face model files.');
    }
  }

  function stage(session, data, isChinese) {
    const pending = {...data, id:randomUUID(), until:Date.now()+60_000};
    session.pending = pending;
    const summary = data.kind === 'person'
      ? (isChinese ? '确认已获本人同意，并登记' : 'Confirm the person consented and enroll ') + data.name
      : (isChinese ? '保存：' : 'Save: ') + data.name;
    return output(summary, 'confirmation', {confirmation:{id:pending.id, summary}});
  }

  function confirm(session, id, accepted, isChinese) {
    const pending = session.pending;
    if (!pending || pending.id !== id || pending.until < Date.now()) {
      throw failure(409, 'This confirmation has expired. Start the request again.');
    }
    if (!accepted) {
      delete session.pending;
      return output(isChinese ? '已取消。' : 'Cancelled.');
    }
    const store = database();
    store.exec('BEGIN IMMEDIATE');
    try {
      store.prepare('INSERT INTO memory(kind,name,normalized,label) VALUES(?,?,?,?) ON CONFLICT(kind,normalized) DO NOTHING')
        .run(pending.kind,pending.name,normal(pending.name),pending.label || null);
      const row = find(pending.kind, pending.name);
      if (pending.kind === 'item' && row.label !== pending.label) {
        throw failure(409, 'This item name is already registered with a different detected category.');
      }
      if (pending.kind === 'person' && pending.label) {
        store.prepare('UPDATE memory SET label=? WHERE id=?').run(pending.label,row.id);
      }
      if (pending.feature) {
        store.prepare('INSERT INTO sample(owner,feature) VALUES(?,?)').run(row.id,JSON.stringify(pending.feature));
        store.prepare('DELETE FROM sample WHERE owner=? AND id NOT IN (SELECT id FROM sample WHERE owner=? ORDER BY id DESC LIMIT 8)').run(row.id,row.id);
      }
      store.exec('COMMIT');
    } catch (error) {
      store.exec('ROLLBACK');
      throw error;
    }
    delete session.pending;
    return output(isChinese ? '已保存：' + pending.name : 'Saved: ' + pending.name);
  }

  function rank(feature, options) {
    const scored = options.map(row => ({
      row,
      score:Math.max(-1, ...samples(row.id).filter(item => item.version === feature.version && item.vector.length === feature.vector.length)
        .map(item => item.vector.reduce((sum, value, index) => sum + value * feature.vector[index], 0)))
    })).sort((a,b) => b.score-a.score);
    return scored;
  }

  async function enroll(session, side, kind, name, isChinese, relationship) {
    if (!name) throw failure(400, 'Give this person or item a name.');
    const slot = session.slots[side];
    if (kind === 'person') {
      const frame = copyFrame(slot);
      if (!frame) return output(isChinese ? '相机当前没有画面。' : 'The camera has no recent frame.', 'unavailable');
      const {features} = await extract('face', frame);
      if (features.length !== 1 || !features[0]) {
        return output(isChinese ? '请对准一位同意登记且脸部清晰的亲友。' : 'Point the camera at one consenting person with a clear face.', 'unavailable');
      }
      return stage(session, {kind, name, label:relationship, feature:features[0]}, isChinese);
    }
    const scene = detections(slot);
    if (!scene) return output(isChinese ? '当前没有可用的 YOLO 检测。' : 'There are no recent YOLO detections.', 'unavailable');
    const objects = scene.objects.filter(object => object.label !== 'person' && object.confidence >= 0.5);
    const centered = objects.filter(object => object.position === 'center');
    const target = objects.length === 1 ? objects[0] : centered.length === 1 ? centered[0] : null;
    if (!target) return output(isChinese ? '请把要登记的物品单独放在画面中央。' : 'Center one item to register it.', 'unavailable');
    const {features} = await extract('item', scene.frame, [target.bbox]);
    if (!features[0]) return output(isChinese ? '物品太小，请靠近一些。' : 'The item is too small. Move the camera closer.', 'unavailable');
    return stage(session, {kind,name,label:target.label,feature:features[0]}, isChinese);
  }

  async function identify(session, side, isChinese) {
    const slot = session.slots[side];
    const stamp = slot.stamp;
    const frame = copyFrame(slot);
    if (!frame) return output(isChinese ? '相机当前没有画面。' : 'The camera has no recent frame.', 'unavailable');
    const people = records('person');
    if (!people.length) return output(isChinese ? '还没有登记亲友。' : 'No people are enrolled.');
    const {features} = await extract('face', frame);
    if (session.slots[side] !== slot || !fresh(stamp)) {
      return output(isChinese ? '画面已变化，请再问一次。' : 'The camera frame expired. Ask again.', 'unavailable');
    }
    if (features.length !== 1 || !features[0]) {
      return output(isChinese ? '请对准一个清晰的人脸。' : 'Point the camera at one clear face.', 'unavailable');
    }
    const [best, second] = rank(features[0], people);
    if (best?.score >= 0.55 && (!second || best.score-second.score >= 0.10)) {
      return output(isChinese ? '看起来是' + best.row.name + '。' : 'This looks like ' + best.row.name + '.', 'camera');
    }
    return output(isChinese ? '我无法确认这个人的身份。' : 'I could not confirm who this is.', 'camera');
  }

  async function locate(session, side, item, isChinese) {
    const scene = detections(session.slots[side]);
    const objects = scene?.objects.filter(object => object.label === item.label && object.confidence >= 0.5) || [];
    if (objects.length) {
      const {features} = await extract('item', scene.frame, objects.map(object => object.bbox));
      const options = records('item').filter(row => row.label === item.label);
      const matches = features.flatMap((feature,index) => {
        if (!feature) return [];
        const [best,second] = rank(feature, options);
        return best?.row.id === item.id && best.score >= 0.92 && (!second || best.score-second.score >= 0.06)
          ? [{score:best.score,object:objects[index]}] : [];
      });
      if (matches.length === 1 && fresh(scene.stamp)) {
        const {position} = matches[0].object;
        const observed = {time:new Date(scene.stamp).toISOString(),camera:side,position};
        database().prepare('UPDATE memory SET last_seen=? WHERE id=?').run(JSON.stringify(observed),item.id);
        const positionText = {left:'左侧',center:'中央',right:'右侧'}[position];
        return output(isChinese ? '相机 ' + side + ' 画面' + positionText + '可能是你的' + item.name + '。' :
          'Your ' + item.name + ' may be in Camera ' + side + ', on the ' + position + ' of the frame.', 'camera', {observation:observed});
      }
    }
    const last = item.last_seen && JSON.parse(item.last_seen);
    const prefix = isChinese ? '当前无法确认' + item.name + '。' : 'I cannot confirm where your ' + item.name + ' is now.';
    if (!last) return output(prefix,'unavailable');
    const time = new Date(last.time).toLocaleString(isChinese ? 'zh-CN' : 'en-US');
    return output(prefix + (isChinese ? ' 上次可能在相机 ' + last.camera + ' 画面' +
      {left:'左侧',center:'中央',right:'右侧'}[last.position] + '看到，时间是' + time + '。' :
      ' Last possible match was in Camera ' + last.camera + ', ' + last.position + ', at ' + time + '.'), 'history', {observation:last});
  }

  async function chat(session, input) {
    const text = clean(input.text);
    const isChinese = cn(text);
    if (!text) throw failure(400, 'Enter a question.');
    const side = input.camera_id === 'B' ? 'B' : 'A';
    const twoCameras = input.camera_id === 'both';
    const oneCamera = () => output(isChinese ? '请先选定相机 A 或 B。' : 'Select Camera A or B first.', 'unavailable');
    if (/^([确確][认認](?:保存)?|取消|yes|confirm|cancel|no)[.!。！]?$/iu.test(text) && session.pending) {
      return confirm(session, session.pending.id, /^(?:[确確][认認]|yes|confirm)/iu.test(text), isChinese);
    }
    delete session.pending;
    const introduction = text.normalize('NFKC').replace(/[\s,.!?，。！？]+/gu,'');
    if (!input.mode && /^(?:(?:你好|您好)?(?:请|請)?(?:你是[谁誰]|你叫(?:什么|什麼)(?:名字)?|你能做(?:什么|什麼)|(?:用一句(?:话|話))?(?:自我介绍|自我介紹|介绍一下自己|介紹一下自己))|whoareyou|what['’]?syourname|whatcanyoudo|introduceyourself)$/iu.test(introduction)) {
      return output(isChinese
        ? '我是 VisionAssist，你的本地视觉助手。我可以听你提问、描述相机画面，也能记住你确认保存的物品、亲友和习惯。'
        : 'I’m VisionAssist, your local visual assistant. I can answer questions, describe camera views, and recall belongings, familiar people, and habits you choose to save.', 'assistant');
    }
    const person = /^(?:enroll person\s+|登记亲友[：:\s]*)(.+)$/iu.exec(text);
    if (person) {
      if (twoCameras) return oneCamera();
      const [name,relationship] = person[1].split(/[,，]/u,2).map(clean);
      return enroll(session,side,'person',name,isChinese,relationship);
    }
    const item = /^(?:register item\s+|登记物品[：:\s]*)(.+)$/iu.exec(text) ||
      /^(?:这个|这只|这把|这一)(.+?)是我的[。.!！]?$/u.exec(text);
    if (item) return twoCameras ? oneCamera() : enroll(session,side,'item',clean(item[1]),isChinese);
    const habit = /^(?:[记記]住[，,:：\s]*|remember[,:\s]+)(.+)$/iu.exec(text);
    if (habit) return stage(session,{kind:'habit',name:clean(habit[1])},isChinese);
    if (/这是谁|那是谁|who is (?:this|that|in (?:front|the frame))/iu.test(text)) return twoCameras ? oneCamera() : identify(session,side,isChinese);
    const knownPerson = /^(?:who is\s+(.+?)|(.+?)是谁)[?？。!.！]*$/iu.exec(text);
    if (knownPerson) {
      const row = find('person', knownPerson[1] || knownPerson[2]);
      if (row) return output(row.label ? row.name+' · '+row.label : row.name);
    }
    if (/登记了谁|亲友有谁|who have i enrolled|saved people/iu.test(text)) {
      const people = records('person').map(row => row.label ? row.name+' · '+row.label : row.name);
      return output(people.length ? people.join(isChinese ? '；' : '. ') : isChinese ? '还没有登记亲友。' : 'No people are enrolled.');
    }
    if (/where|哪儿|哪里|在哪|找(?:一下|找)?/iu.test(text)) {
      const name = normal(text);
      const matches = records('item').filter(row => {
        const itemName = normal(row.name);
        return cn(itemName) ? name.includes(itemName) : name.split(/[^\p{L}\p{N}]+/u).join(' ').includes(' ' + itemName + ' ') ||
          (' ' + name.replace(/[?？.!]+$/u,'') + ' ').includes(' ' + itemName + ' ');
      });
      if (matches.length === 1) return twoCameras ? oneCamera() : locate(session,side,matches[0],isChinese);
      if (matches.length > 1) return output(isChinese ? '你是在找哪一件物品？' : 'Which registered item are you looking for?');
      if (/\bmy\b|我的/iu.test(text)) return output(isChinese ? '没有找到这个名称的登记物品。' : 'No registered item matches that name.');
    }
    if (/习惯|習慣|出[门門]前|what should i remember|habits|before (?:going out|i leave)/iu.test(text)) {
      const habits = records('habit').map(row => row.name);
      return output(habits.length ? habits.join(isChinese ? '；' : '. ') : isChinese ? '还没有保存习惯。' : 'No habits are saved yet.');
    }
    const slot = session.slots[side];
    const wantsImage = input.mode === 'image' || /什么颜色|哪种颜色|看图|画面细节|what colou?r|look at (?:the|this) (?:picture|frame)/iu.test(text) ||
      (twoCameras && /画面|相机|有什么|看到|前方|周围|camera|compare|differences|in front|surroundings|what (?:can|do) you see/iu.test(text));
    if (input.mode === 'scene' || (!wantsImage && /前面有什么|前方|周围|看到什么|in front|surroundings|what (?:can|do) you see/iu.test(text))) {
      const scene = detections(slot);
      if (!scene) return output(isChinese ? '当前没有可用的 YOLO 检测。' : 'There are no recent YOLO detections.', 'unavailable');
      const visible = [...new Set(scene.objects.filter(x => x.confidence >= 0.5).map(x => x.label +
        (isChinese ? '（' + {left:'左侧',center:'中央',right:'右侧'}[x.position] + '）' : ' (' + x.position + ')')))].slice(0,8);
      return output(visible.length ? (isChinese ? '相机 ' + side + ' 检测到：' : 'Camera ' + side + ' detects: ') + visible.join(isChinese ? '、' : ', ') :
        isChinese ? '这一帧没有检测到明确的物体。' : 'No confident objects were detected in this frame.', 'yolo');
    }
    let frame = wantsImage ? copyFrame(slot) : null;
    if (wantsImage && twoCameras) {
      const missing = ['A','B'].filter(id => !copyFrame(session.slots[id]));
      if (missing.length) {
        return output(isChinese ? '相机 ' + missing.join('、') + ' 当前没有新画面。' :
          'Camera ' + missing.join(' and ') + ' has no recent frame.', 'unavailable');
      }
      const {A,B} = session.slots;
      if (Math.abs(A.stamp-B.stamp) > 1500) return output(isChinese
        ? '两路画面时间相差较大。请等两台相机恢复实时后再试。' : 'The camera frames are too far apart in time. Try again when both feeds are live.', 'unavailable');
      frame = [A.frame,B.frame];
    }
    if (wantsImage && !frame) return output(isChinese ? '相机当前没有画面。' : 'The camera has no recent frame.', 'unavailable');
    const persona = 'Your product identity is VisionAssist, an on-device visual and memory assistant for people with low vision. ' +
      'Speak calmly and naturally in one or two short sentences. Reply in the user’s language; use simplified Chinese for Chinese replies. ' +
      'Introduce yourself as VisionAssist. Only discuss the underlying model if explicitly asked about the technology. Avoid emoji and boilerplate.';
    const system = {role:'system',content:persona + (frame
      ? ' Use only the attached image for visual facts. State what is unclear. Never identify people or provide walking directions.'
      : ' Use recent messages to follow the conversation. You have no camera or saved memory access in this turn. Never invent observations, identities, distances, saved data or walking directions.')};
    const history = frame ? [] : session.dialog || [];
    const cameraPrompt = isChinese
      ? '第一张是相机 A，第二张是相机 B。只比较可见内容，分开注明相机，不推测身份或行走方向。请用简体中文简短回答：'
      : 'The first image is Camera A and the second image is Camera B. Label each and compare only visible details. Do not infer identity or walking directions. Answer briefly: ';
    const message = {role:'user',content:Array.isArray(frame) ? cameraPrompt + text : text};
    const messages = Array.isArray(frame) ? [message] : [system,...history,message];
    let reply;
    try { reply = await runResource('model', () => generate(messages,frame)); }
    catch (error) {
      if (error.publicMessage) throw error;
      throw failure(503, 'Local Ollama model unavailable. Check that Ollama is running and the model is installed.');
    }
    if (!frame) session.dialog = [...history,message,{role:'assistant',content:reply}].slice(-16);
    return output(reply,frame ? 'image' : 'llm');
  }

  return { chat, enroll, confirm, records, close:() => db?.close(),
    remove(kind,id) { return database().prepare('DELETE FROM memory WHERE kind=? AND id=?').run(kind,id).changes > 0; },
    async synthesize(text, priority) {
      if (typeof text !== 'string' || !text.trim() || text.length > 650) throw failure(400, 'Give a short reply to speak.');
      try {
        const {audio} = await runResource(priority ? 'alert-tts' : 'tts',
          () => worker('tts',{text,language:cn(text) ? 'zh' : 'en'}));
        return Buffer.from(audio,'base64');
      } catch (error) {
        if (error.publicMessage) throw error;
        throw failure(503, 'Local playback unavailable. Check Piper and its downloaded voices.');
      }
    },
    async exportConversation(messages) {
      const {document} = await runResource('export', () => worker('docx',{messages}));
      return Buffer.from(document,'base64');
    },
    async transcribe(bytes, language) {
      try {
        return await runResource('speech', () => worker('stt',{audio:bytes.toString('base64'),language}));
      } catch (error) {
        if (error.publicMessage) throw error;
        throw failure(503, 'Local transcription unavailable. Check faster-whisper and its downloaded model.');
      }
    }
  };
}

module.exports = {createAgent,MAX_FRAME_AGE};
