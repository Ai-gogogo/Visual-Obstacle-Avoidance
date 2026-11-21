const {createAgent, currentDetection, MAX_FRAME_AGE} = require('./agent.cjs');
const {acceptRoadEdge} = require('./road-alerts.cjs');
const voiceFrames = require('./voice-frames.cjs');
const loopback = address => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
const recent = value => value && Date.now() - value.stamp <= MAX_FRAME_AGE;
const kinds = {items:'item', people:'person', habits:'habit'};
const positions = new Set(['left','center','right']);
const DETECTION_SCHEMA_VERSION = 1;
const movingLabels = new Map(Object.entries({
  person:'行人', bicycle:'自行车', motorcycle:'摩托车', car:'汽车', bus:'公交车', truck:'卡车', dog:'狗'
}));


function validItemFeature(feature) {
  if (!feature || !Array.isArray(feature.vector)) {
    return false;
  }

  const specs = {
    "spatial-hsv-v1": {
      dimensions: 540,
      nonnegative: true
    },
    "siglip2-base-patch16-224-v1": {
      dimensions: 768,
      nonnegative: false
    }
  };

  const spec = specs[feature.version];

  if (!spec || feature.vector.length !== spec.dimensions) {
    return false;
  }

  const vector = feature.vector;

  if (!vector.every(value =>
    Number.isFinite(value) &&
    (!spec.nonnegative || (value >= 0 && value <= 1))
  )) {
    return false;
  }

  const normSquared = vector.reduce(
    (sum, value) => sum + value * value, 0
  );

  return Math.abs(normSquared - 1) <= 0.001;
}


function parseObjects(objects) {
  if (!Array.isArray(objects) || objects.length > 40) return null;
  const results = [];
  for (const entry of objects) {
    if (!entry || typeof entry.label !== 'string' || !/^[\p{L}\p{N} _-]{1,50}$/u.test(entry.label) ||
        !positions.has(entry.position) || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1 ||
        !Array.isArray(entry.bbox) || entry.bbox.length !== 4 ||
        !entry.bbox.every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
        entry.bbox[0] >= entry.bbox[2] || entry.bbox[1] >= entry.bbox[3]) return null;
    const label = entry.label.toLowerCase();
    const itemFeature = label !== 'person' && entry.confidence >= 0.5 && validItemFeature(entry.item_feature)
      ? {version:entry.item_feature.version,vector:entry.item_feature.vector} : null;
    results.push({label,position:entry.position,bbox:entry.bbox,confidence:entry.confidence,
      relative_depth:['near','far'].includes(entry.relative_depth) ? entry.relative_depth : 'unknown',
      track_id:typeof entry.track_id === 'string' || Number.isSafeInteger(entry.track_id) ? String(entry.track_id).slice(0,80) : null,
      ...(typeof entry.obstacle_candidate === 'boolean' ? {obstacle_candidate:entry.obstacle_candidate} : {}),
      ...(itemFeature ? {item_feature:itemFeature} : {}),
      risk:['caution','urgent'].includes(entry.risk) ? entry.risk : 'normal'});
  }
  return results;
}

function createAgentRoutes(options, sessions, read, respond) {
  const agent = createAgent(options);
  const workerRuntime = new Map();
  const asJSON = async (req, max) => JSON.parse((await read(req,max)).toString('utf8'));
  const error = (res, status, message) => respond(res,status,{error:message});

  function waitForAlert(session, response) {
    session.alertWaiter?.();
    return new Promise(resolve => {
      const timeout = setTimeout(done,1000);
      function done() {
        clearTimeout(timeout);
        response.off('close',done);
        if (session.alertWaiter === done) delete session.alertWaiter;
        resolve();
      }
      session.alertWaiter = done;
      response.once('close',done);
      if (response.destroyed) done();
    });
  }

  function cvResponse(req,res,route,requestURL) {
    if (!loopback(req.socket.remoteAddress) || req.headers.origin || req.headers['sec-fetch-site']) {
      return error(res,403,'The CV adapter is available to local processes.');
    }
    if (route === '/api/cv/sources' && req.method === 'GET') {
      const camera = req.headers['x-cv-camera'];
      const device = req.headers['x-cv-device'];
      const precision = req.headers['x-cv-precision'];
      if (['A','B'].includes(camera) && typeof device === 'string' &&
          /^(cpu|mps|cuda:\d+)$/.test(device) && ['fp16','fp32'].includes(precision) &&
          (device.startsWith('cuda:') || precision === 'fp32')) {
        workerRuntime.set(camera,{camera,device,precision,seen:Date.now()});
      }
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
      const id = slot.etag.slice(1,-1);
      const frameType = slot.frameType ?? 'image/jpeg';
      const transport = slot.rtcID ? 'webrtc' : 'image';
      if (!slot.cvFrames.has(id)) slot.cvFrames.set(id,{
        frame:slot.frame,frameType,stamp:slot.stamp,sample:slot.sample,transport,quality:slot.rtcQuality
      });
      const retain = frameType === 'image/png' ? 3 : 8;
      while (slot.cvFrames.size > retain) slot.cvFrames.delete(slot.cvFrames.keys().next().value);
      return res.writeHead(200,{'Content-Type':frameType,ETag:slot.etag,
        ...(slot.usbResolution ? {'X-USB-Resolution':slot.usbResolution} : {}),
        'X-CV-Transport':transport, ...(slot.rtcQuality ? {'X-RTC-Profile':slot.rtcQuality} : {}),
        ...(slot.sample ? {'X-CV-Sample-Ms':slot.sample.ms} : {}),
        ...(slot.rtcStats?.timing_source ? {'X-RTC-Timing-Source':slot.rtcStats.timing_source,
          'X-RTC-Clock-Diagnostics':JSON.stringify(slot.rtcStats.clock_diagnostics ?? {}),
          'X-RTC-Timing-Lag-Ms':slot.rtcStats.timing_lag_ms ?? ''} : {}),
        'X-CV-Stream-Id':slot.streamID, 'X-CV-Frame-Ms':slot.stamp}).end(slot.frame);
    }
    if (route === '/api/cv/stereo-partner' && req.method === 'GET' && camera === 'A') {
      const left = slot.cvFrames?.get(requestURL.searchParams.get('frame_id'));
      const limit = Number(requestURL.searchParams.get('max_skew_ms'));
      if (!Number.isInteger(limit) || limit <= 0 || limit > 250) return error(res,400,'Invalid time tolerance.');
      if (!recent(left) || !left.sample) return res.writeHead(204).end();
      const pairLimit = left.transport === 'webrtc' ? Math.min(limit,65) : limit;
      const right = session.slots.B;
      let best;
      let smallest = Infinity;
      for (const candidate of right.history ?? []) {
        const difference = Math.abs(candidate.sample.ms - left.sample.ms) + candidate.sample.error + left.sample.error;
        if (candidate.transport === left.transport && candidate.quality === left.quality &&
            recent(candidate) && difference <= pairLimit && difference < smallest) {
          best = candidate;
          smallest = difference;
        }
      }
      if (!best) return res.writeHead(204).end();
      const opt = session.depthOptions;
      if (opt) {
        res.setHeader('X-Depth-Algorithm',opt.algorithm ?? 'sgbm');
        res.setHeader('X-Depth-Low',Number(opt.low === true));
        res.setHeader('X-Depth-Spatial',Number(opt.spatial));
        res.setHeader('X-Depth-Temporal',Number(opt.temporal));
        res.setHeader('X-Depth-Meters',Number(opt.meters));
        res.setHeader('X-Depth-Five-Mm',opt.fiveMm);
        res.setHeader('X-Depth-Rig',slot.streamID+'/'+right.streamID);
        res.setHeader('X-Depth-Stamp',left.stamp);
      }
      left.partner = {depthOptions:opt, id:best.id, stream:right.streamID, stamp:best.stamp};
      return res.writeHead(200,{'Content-Type':best.frameType ?? 'image/jpeg', 'X-Partner-Id':best.id,
        ...(right.usbResolution ? {'X-USB-Resolution':right.usbResolution} : {}),
        ...(right.rtcQuality ? {'X-RTC-Profile':right.rtcQuality} : {}), 'X-Partner-Stream':right.streamID,'X-Partner-Skew-Ms':Math.abs(best.sample.ms-left.sample.ms),
        'X-Partner-Skew-Bound-Ms':smallest}).end(best.frame);
    }
    if (route === '/api/cv/detections' && req.method === 'POST') return publish();
    return error(res,404,'Unknown CV route.');

    async function publish() {
      const payload = await asJSON(req,600_000 + 128_000);
      const objects = parseObjects(payload?.objects);
      const weak = parseObjects(payload?.preview_objects ?? []);
      if (!objects || !weak || typeof payload.frame_id !== 'string') return error(res,400,'Invalid detections.');
      const versioned = ['schema_version','camera_id','timestamp_ms'].some(key => Object.hasOwn(payload,key));
      if (versioned && (payload.schema_version !== DETECTION_SCHEMA_VERSION ||
          payload.camera_id !== camera || !Number.isSafeInteger(payload.timestamp_ms))) {
        return error(res,400,'Invalid detection frame metadata.');
      }
      const captured = slot.cvFrames?.get(payload.frame_id);
      if (session.slots[camera] !== slot || !recent(captured) ||
          (slot.detection && slot.detection.timestamp_ms > captured.stamp)) {
        return error(res,409,'Frame expired or replaced.');
      }
      if (versioned && payload.timestamp_ms !== captured.stamp) {
        return error(res,400,'Detection timestamp does not match the pinned frame.');
      }
      if (slot.detection?.frame_id === payload.frame_id) return res.writeHead(204).end();
      slot.detection = {
        schema_version:DETECTION_SCHEMA_VERSION, camera_id:camera, frame_id:payload.frame_id,
        timestamp_ms:captured.stamp, objects, frame:captured.frame, frameType:captured.frameType,
        previewObjects:weak.filter(obj => obj.track_id && obj.confidence >= .25 && obj.confidence < .4)
          .map(({label,position,bbox,confidence,track_id}) => ({label,position,bbox,confidence,track_id,weak:true})),
        capture_ms:captured.sample?.ms
      };
      const partner = captured.partner;
      if (camera === 'A' && payload.stereo) {
        slot.detection.stereoStatus = ['size_mismatch','no_matches','unavailable','raft_unavailable','transport_unvalidated'].includes(payload.stereo.status)
          ? payload.stereo.status : 'waiting_for_pair';
      }
      const paired = camera === 'A' && recent(partner) && partner.id === payload.stereo?.partner_id &&
          (partner.depthOptions?.algorithm ?? 'sgbm') === (payload.stereo?.algorithm ?? 'sgbm') &&
          partner.stream === session.slots.B.streamID;
      if (paired) {
        for (const [i, object] of objects.entries()) {
          const z = payload.objects[i].depth_m;
          const measured = Number.isFinite(z) && z > 0;
          if (measured && partner.depthOptions?.meters !== false) object.depth_m = z;
          const prediction = payload.objects[i].intrusion;
          if (measured && object.track_id && movingLabels.has(object.label) && object.confidence >= .5 &&
              ['left','right'].includes(prediction?.from_side) && Number.isFinite(prediction.eta_s) &&
              prediction.eta_s > 0 && prediction.eta_s <= 3 && captured.sample) {
            const expires = captured.sample.ms + Math.round(1000*prediction.eta_s) - captured.sample.error;
            if (expires > Date.now()) object.intrusion = {from_side:prediction.from_side, eta_s:prediction.eta_s, expires};
          }
        }
        const preview = payload.stereo.preview;
        if (typeof preview === 'string' && preview.length <= 128000 && /^[A-Za-z0-9+/]+={0,2}$/.test(preview)) {
          slot.detection.stereoPartner = partner;
          slot.detection.depthPreview = preview;
          const center = payload.stereo.center_m;
          if (Number.isFinite(center) && center>0) slot.detection.centerM = center;

          const fraction = payload.stereo.valid_fraction;
          if (Number.isFinite(fraction) && fraction >= 0 && fraction <= 1) {
            slot.detection.depthValidFraction = fraction;
          }
          const range = payload.stereo.range_m;
          if (Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) &&
              range[0] > 0 && range[0] < range[1]) slot.detection.depthRange = range;
          slot.detection.stereoStatus = 'ready';
        }
      }
      const now = Date.now();
      const previousSequence = session.alertSeq;
      for (const [id,stamp] of session.alertCooldown) if (now-stamp > 5000) session.alertCooldown.delete(id);
      const hazards = objects.filter(object => object.risk !== 'normal' && object.confidence >= 0.5)
        .sort((a,b) => Number(b.risk === 'urgent')-Number(a.risk === 'urgent'));
      for (const obstacle of hazards.slice(0,3)) {
        const id = [slot.streamID,obstacle.track_id || obstacle.label,obstacle.risk].join(':');
        if (session.alertCooldown.has(id)) continue;
        session.alertCooldown.set(id,now);
        session.alerts.push({id:++session.alertSeq,camera_id:camera,risk:obstacle.risk,streamID:slot.streamID,
          text:(obstacle.risk === 'urgent' ? 'Urgent. ' : 'Caution. ') + obstacle.label + ', Camera ' + camera + ', ' + obstacle.position + '.', stamp:captured.stamp});
      }
      if (camera === 'A') {
        const warning = acceptRoadEdge(slot, payload.road_edge, captured.stamp, session.slots.B.streamID, paired);
        if (warning) session.alerts.push({...warning,id:++session.alertSeq,streamID:slot.streamID,
          partnerStream:slot.detection.road_edge?.distance_m === undefined ? undefined : partner?.stream});
        for (const obj of objects.filter(o => o.intrusion).sort((a,b) => a.intrusion.expires-b.intrusion.expires)) {
          const side = obj.intrusion.from_side;
          const id = ['intrusion',slot.streamID,partner.stream,obj.track_id,side].join(':');
          if (session.alertCooldown.has(id)) continue;
          session.alertCooldown.set(id,now);
          session.alerts.push({kind:'path_intrusion', id:++session.alertSeq, camera_id:'A', risk:'caution',
            stamp:captured.stamp, streamID:slot.streamID, partnerStream:partner.stream, expires:obj.intrusion.expires, track_id:obj.track_id, from_side:side,
            text:'Caution. A '+obj.label+' may cross your path from the '+side+'.',
            text_zh:(side === 'left' ? '左侧' : '右侧')+movingLabels.get(obj.label)+'可能横穿前方，请小心。'});
        }
        if (paired) slot.detection.partnerStream = partner.stream;
      }
      session.alerts = session.alerts.slice(-20);
      if (session.alertSeq !== previousSequence) {
        for (const alert of session.alerts) {
          if (alert.id <= previousSequence) continue;
          alert.judged_ms = now;
          if (captured.sample) {
            alert.capture_ms = captured.sample.ms;
            alert.capture_error_ms = captured.sample.error;
          }
        }
        session.alertWaiter?.();
      }
      // Measured on one clock, from server receipt of the JPEG to acceptance of CV results.
      return res.writeHead(204, {'X-CV-Accepted-Ms':now, 'X-CV-Latency-Ms':now-captured.stamp,
        ...(captured.sample ? {'X-CV-Capture-Latency-Ms':Math.max(0,now-captured.sample.ms)} : {})}).end();
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
    if (route === '/api/agent/voice-frames' && ['POST','PUT','DELETE'].includes(method)) {
      const id = requestURL.searchParams.get('id');
      if (!id || !/^[\da-f-]{36}$/i.test(id)) return error(res,400,'Invalid voice turn.');
      if (method === 'POST') voiceFrames.begin(session,id);
      else if (method === 'PUT') voiceFrames.markSpoken(session,id);
      else voiceFrames.discard(session,id);
      return res.writeHead(204).end();
    }
    if (route === '/api/agent/runtime' && method === 'GET') {
      const agentRuntime = await agent.modelRuntime();
      const yolo = [...workerRuntime.values()]
        .filter(worker => Date.now()-worker.seen <= 5000)
        .sort((a,b) => a.camera.localeCompare(b.camera))
        .map(({camera,device,precision}) => ({camera,device,precision}));
      return respond(res,200,{yolo,agent:agentRuntime});
    }
    if (route === '/api/agent/alerts' && method === 'GET') {
      const after = Number(requestURL.searchParams.get('after') || 0);
      if (requestURL.searchParams.get('wait') === '1' && after === session.alertSeq) {
        await waitForAlert(session,res);
        if (res.destroyed) return;
      }
      const remindersEnabled = requestURL.searchParams.get('reminders') === '1';
      const reminder = remindersEnabled ? agent.cameraReminder(session) : null;
      const active = session.alerts.filter(alert => {
        if (alert.id <= after || !recent(alert) || session.slots[alert.camera_id].streamID !== alert.streamID ||
            (alert.partnerStream && session.slots.B.streamID !== alert.partnerStream)) return false;
        if (alert.kind !== 'path_intrusion') return true;
        const scene = session.slots.A.detection;
        return alert.expires > Date.now() && scene?.partnerStream === session.slots.B.streamID &&
          scene?.objects.some(obj => obj.track_id === alert.track_id && obj.intrusion?.from_side === alert.from_side);
      });
      const cameras = Object.fromEntries(Object.entries(session.slots).map(([side,slot]) => [
        side, !slot.phone ? 'offline' : !recent(slot) ? 'waiting' :
          currentDetection(slot) ? 'detecting' : 'live'
      ]));
      return respond(res,200,{sequence:session.alertSeq, alerts:active.map(({streamID, partnerStream, ...alert}) => alert), reminder,cameras});
    }
    if (route === '/api/agent/preferences') {
      if (method === 'GET') return respond(res,200,agent.preferences());
      if (method === 'PUT') return respond(res,200,agent.savePreferences(await asJSON(req,1024) || {}));
    }
    if (route === '/api/agent/wake' && method === 'POST') {
      if (!/^audio\/wav(\s*;|$)/i.test(req.headers['content-type'] || '')) {
        return error(res,415,'Expected a PCM WAV recording.');
      }
      const language = requestURL.searchParams.get('language');
      if (!['zh','en'].includes(language)) return error(res,400,'Unknown wake-word language.');
      const purpose = requestURL.searchParams.get('purpose');
      if (purpose !== null && !['stop','cancel'].includes(purpose)) return error(res,400,'Unknown voice command purpose.');
      return respond(res,200,await agent.detectWake(await read(req,purpose ? 300_000 : 900_000),language,purpose));
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
    const history = /^\/api\/memory\/items\/(\d+)\/history$/.exec(route);
    if (history && method === 'GET') {
      const observations = agent.observationHistory(Number(history[1]));
      if (!observations) return error(res,404,'Memory not found.');
      return respond(res,200,{observations});
    }
    const memory = /^\/api\/memory\/(items|people|habits)(?:\/(\d+))?$/.exec(route);
    if (memory) {
      const kind = kinds[memory[1]];
      if (method === 'GET' && !memory[2]) return respond(res,200,{records:agent.records(kind)});
      if (method === 'PATCH' && memory[2]) {
        const input = await asJSON(req,1024);
        if (!agent.rename(kind,Number(memory[2]),input?.name)) return error(res,404,'Memory not found.');
        return res.writeHead(204).end();
      }
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
      if (route === '/api/agent/chat') {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.once('close',cancel);
        try {
          const answer = await agent.chat(session,input,controller.signal,voiceFrames.take(session,input.voice_turn));
          if (!controller.signal.aborted) return respond(res,200,answer);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          res.off('close',cancel);
        }
        return;
      }
      if (route === '/api/agent/confirm') {
        if (typeof input.accepted !== 'boolean') return error(res,400,'Choose confirm or cancel.');
        return respond(res,200,agent.confirm(session,input.id,input.accepted,input.language === 'zh'));
      }
      return error(res,404,'Unknown assistant route.');
    } finally { session.chatBusy = false; }
  }

  return {handle, close() {
    for (const session of sessions.values()) voiceFrames.discard(session);
    agent.close();
  }};
}

module.exports = {createAgentRoutes, DETECTION_SCHEMA_VERSION};
