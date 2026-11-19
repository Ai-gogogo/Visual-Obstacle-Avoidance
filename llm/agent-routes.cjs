const {createAgent, MAX_FRAME_AGE} = require('./agent.cjs');
const loopback = address => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
const recent = value => value && Date.now() - value.stamp <= MAX_FRAME_AGE;
const kinds = {items:'item', people:'person', habits:'habit'};
const positions = new Set(['left','center','right']);

function parseObjects(objects) {
  if (!Array.isArray(objects) || objects.length > 40) return null;
  const results = [];
  for (const entry of objects) {
    if (!entry || typeof entry.label !== 'string' || !/^[\p{L}\p{N} _-]{1,50}$/u.test(entry.label) ||
        !positions.has(entry.position) || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1 ||
        !Array.isArray(entry.bbox) || entry.bbox.length !== 4 ||
        !entry.bbox.every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
        entry.bbox[0] >= entry.bbox[2] || entry.bbox[1] >= entry.bbox[3]) return null;
    results.push({label:entry.label.toLowerCase(),position:entry.position,bbox:entry.bbox,confidence:entry.confidence,
      relative_depth:['near','far'].includes(entry.relative_depth) ? entry.relative_depth : 'unknown',
      track_id:typeof entry.track_id === 'string' || Number.isSafeInteger(entry.track_id) ? String(entry.track_id).slice(0,80) : null,
      ...(typeof entry.obstacle_candidate === 'boolean' ? {obstacle_candidate:entry.obstacle_candidate} : {}),
      risk:['caution','urgent'].includes(entry.risk) ? entry.risk : 'normal'});
  }
  return results;
}

function createAgentRoutes(options, sessions, read, respond) {
  const agent = createAgent(options);
  const asJSON = async (req, max) => JSON.parse((await read(req,max)).toString('utf8'));
  const error = (res, status, message) => respond(res,status,{error:message});

  function cvResponse(req,res,route,requestURL) {
    if (!loopback(req.socket.remoteAddress) || req.headers.origin || req.headers['sec-fetch-site']) {
      return error(res,403,'The CV adapter is available to local processes.');
    }
    if (route === '/api/cv/sources' && req.method === 'GET') {
      const sources = [...sessions.values()].filter(session => session.assistant).flatMap(session =>
        Object.entries(session.slots).filter(([,slot]) => slot.frame && recent(slot))
          .map(([camera_id,slot]) => ({source_id:session.sourceID,camera_id,frame_id:slot.etag.slice(1,-1)}))
      );
      return respond(res,200,{sources});
    }

    const camera = requestURL.searchParams.get('camera_id');
    const source = requestURL.searchParams.get('source_id');
    const session = [...sessions.values()].find(candidate => candidate.assistant && candidate.sourceID === source);
    const slot = ['A','B'].includes(camera) && session?.slots[camera];
    if (!slot) return error(res,404,'Unknown camera or source.');
    if (route === '/api/cv/frame' && req.method === 'GET') {
      if (!slot.frame || !recent(slot)) return res.writeHead(204).end();
      if (req.headers['if-none-match'] === slot.etag) return res.writeHead(304).end();
      slot.cvFrames ||= new Map();
      for (const [id, item] of slot.cvFrames) if (!recent(item)) slot.cvFrames.delete(id);
      slot.cvFrames.set(slot.etag.slice(1,-1),{frame:slot.frame,stamp:slot.stamp});
      while (slot.cvFrames.size > 8) slot.cvFrames.delete(slot.cvFrames.keys().next().value);
      return res.writeHead(200,{'Content-Type':'image/jpeg',ETag:slot.etag,
        'X-CV-Stream-Id':slot.streamID, 'X-CV-Frame-Ms':slot.stamp}).end(slot.frame);
    }
    if (route === '/api/cv/detections' && req.method === 'POST') return publish();
    return error(res,404,'Unknown CV route.');

    async function publish() {
      const payload = await asJSON(req,24_000);
      const objects = parseObjects(payload?.objects);
      if (!objects || typeof payload.frame_id !== 'string') return error(res,400,'Invalid detections.');
      const captured = slot.cvFrames?.get(payload.frame_id);
      if (session.slots[camera] !== slot || !recent(captured) ||
          (slot.detection && slot.detection.stamp > captured.stamp)) {
        return error(res,409,'Frame expired or replaced.');
      }
      if (slot.detection?.frame_id === payload.frame_id) return res.writeHead(204).end();
      slot.detection = {...captured,frame_id:payload.frame_id,objects};
      const now = Date.now();
      for (const [id,stamp] of session.alertCooldown) if (now-stamp > 5000) session.alertCooldown.delete(id);
      const hazards = objects.filter(object => object.risk !== 'normal' && object.confidence >= 0.5)
        .sort((a,b) => Number(b.risk === 'urgent')-Number(a.risk === 'urgent'));
      for (const obstacle of hazards.slice(0,3)) {
        const id = [camera,obstacle.track_id || obstacle.label,obstacle.risk].join(':');
        if (session.alertCooldown.has(id)) continue;
        session.alertCooldown.set(id,now);
        session.alerts.push({id:++session.alertSeq,camera_id:camera,risk:obstacle.risk,
          text:'Caution. ' + obstacle.label + ', Camera ' + camera + ', ' + obstacle.position + '.', stamp:captured.stamp});
      }
      session.alerts = session.alerts.slice(-20);
      // Measured on one clock, from server receipt of the JPEG to acceptance of CV results.
      return res.writeHead(204, {'X-CV-Accepted-Ms':now, 'X-CV-Latency-Ms':now-captured.stamp}).end();
    }
  }

  async function handle(req,res,route,token) {
    const requestURL = new URL(req.url,'http://localhost');
    const host = new URL('http://' + req.headers.host).hostname;
    const localHost = req.socket.localAddress?.replace(/^::ffff:/,'');
    if (!['localhost','127.0.0.1','[::1]',localHost,process.env.VISIONASSIST_DASHBOARD_HOST].includes(host)) {
      return error(res,403,'Use localhost or the configured Dashboard hostname.');
    }
    if (route.startsWith('/api/cv/')) return cvResponse(req,res,route,requestURL);
    const local = loopback(req.socket.remoteAddress) || req.socket.remoteAddress === req.socket.localAddress;
    if (!local) return error(res,403,'Open the assistant on the computer running VisionAssist.');
    const session = sessions.get(token);
    if (!session) return error(res,401,'Desktop session ended. Reload the dashboard.');
    if (session.pending?.until < Date.now()) delete session.pending;
    session.assistant = true;
    const method = req.method;
    if (route === '/api/agent/alerts' && method === 'GET') {
      const after = Number(requestURL.searchParams.get('after') || 0);
      return respond(res,200,{sequence:session.alertSeq, alerts:session.alerts.filter(alert => alert.id > after && recent(alert))});
    }
    if (route === '/api/agent/transcribe' && method === 'POST') {
      if (!/^(audio\/(webm|mp4|ogg|wav))(\s*;|$)/i.test(req.headers['content-type'] || '')) {
        return error(res,415,'Expected a browser audio recording.');
      }
      const language = requestURL.searchParams.get('language');
      if (language && !['auto','zh','en'].includes(language)) return error(res,400,'Unknown transcription language.');
      return respond(res,200,await agent.transcribe(await read(req,5_000_000),language === 'auto' ? null : language));
    }
    if (route === '/api/agent/export' && method === 'POST') {
      const {messages} = await asJSON(req,5_000_000);
      if (!Array.isArray(messages) || !messages.length || messages.length > 1000 || !messages.every(message =>
        message && ['user','assistant'].includes(message.role) && typeof message.text === 'string' &&
        message.text.trim() && message.text.length <= 12000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(message.text))) {
        return error(res,400,'Expected a valid conversation to export.');
      }
      const document = await agent.exportConversation(messages);
      return res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition':'attachment; filename="VisionAssist-conversation.docx"','Content-Length':document.length}).end(document);
    }
    if (route === '/api/agent/speech' && method === 'POST') {
      const input = await asJSON(req,3000);
      const audio = await agent.synthesize(input?.text,input?.priority === true);
      return res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':audio.length}).end(audio);
    }
    const memory = /^\/api\/memory\/(items|people|habits)(?:\/(\d+))?$/.exec(route);
    if (memory) {
      const kind = kinds[memory[1]];
      if (method === 'GET' && !memory[2]) return respond(res,200,{records:agent.records(kind)});
      if (method === 'DELETE' && memory[2]) {
        if (!agent.remove(kind,Number(memory[2]))) return error(res,404,'Memory not found.');
        return res.writeHead(204).end();
      }
    }
    if (method !== 'POST') return error(res,404,'Unknown assistant route.');
    const input = await asJSON(req,3000);
    if (!input || typeof input !== 'object') return error(res,400,'Expected a JSON object.');
    if (session.chatBusy) return error(res,429,'Wait for the current question to finish.');
    session.chatBusy = true;
    try {
      if (route === '/api/agent/chat') return respond(res,200,await agent.chat(session,input));
      if (route === '/api/agent/confirm') {
        if (typeof input.accepted !== 'boolean') return error(res,400,'Choose confirm or cancel.');
        return respond(res,200,agent.confirm(session,input.id,input.accepted,input.language === 'zh'));
      }
      return error(res,404,'Unknown assistant route.');
    } finally { session.chatBusy = false; }
  }

  return {handle, close:agent.close};
}

module.exports = {createAgentRoutes};
