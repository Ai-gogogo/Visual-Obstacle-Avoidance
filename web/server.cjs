const http = require('node:http');
const https = require('node:https');
const { randomBytes, randomInt } = require('node:crypto');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const { createAgentRoutes, DETECTION_SCHEMA_VERSION } = require('../llm/agent-routes.cjs');
const {PREVIEW_MAX_ANALYSIS_LAG_MS} = require('../llm/agent.cjs');
const {createRtcBridge} = require('./rtc-bridge.cjs');

const qrcode = require('./vendor/qrcode-generator-2.0.4/qrcode.cjs');

function phonePairingInfo(origin, side, code) {
  if (!origin || !URL.canParse(origin)) return {};
  const camera = new URL('/camera',origin);
  if (camera.protocol !== 'https:' || camera.username || camera.password ||
      /^(localhost|127\..*|\[::1\])$|\.localhost$/i.test(camera.hostname)) return {};
  const cameraUrl = camera.href;
  camera.hash = new URLSearchParams({code,side}).toString();
  const qr = qrcode(0,'M');
  qr.addData(camera.href,'Byte');
  qr.make();
  return {cameraUrl,qrImage:qr.createDataURL(6,24)};
}

const TTL = 4 * 60 * 60 * 1000;
const CODE_TTL = 5 * 60 * 1000;
const FRESH = 5000;
const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
const PNG_END = Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]);
const key = () => randomBytes(24).toString('hex');

function respond(res, status, payload) {
  res.writeHead(status, {'Content-Type':'application/json'});
  res.end(JSON.stringify(payload));
}
async function read(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('Request too large.'), {status:413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function createServer(options = {}) {
  const sessions = new Map();
  const codes = new Map();
  const phones = new Map();
  const attempts = new Map();
  const assistant = createAgentRoutes(options.agent, sessions, read, respond);
  const usb = require("./usb-cameras.cjs").usbCameras({sessions, phones, key, read, respond});
  const rtc = options.rtc ?? (options.rtcPython && createRtcBridge(options.rtcPython));

  function resetSource(session, side) {
    const slot = session.slots[side];
    if (slot.rtcID) rtc.drop(slot.rtcID);
    session.alerts = session.alerts.filter(alert => alert.kind !== 'path_intrusion');
    return session.slots[side] = {phone:slot.phone, streamID:key(), stamp:0};
  }

  function rememberRight(slot) {
    if (!slot.sample) return;
    slot.history ||= [];
    slot.history.push({id:slot.etag.slice(1,-1),frame:slot.frame,frameType:slot.frameType,
      stamp:slot.stamp,sample:slot.sample,transport:slot.rtcID ? 'webrtc' : 'image',quality:slot.rtcQuality});
    const limit = slot.rtcID ? 16 : slot.frameType === 'image/png' ? 3 : 6;
    slot.history.splice(0, Math.max(0,slot.history.length-limit));
  }

  async function readOffer(req) {
    const offer = JSON.parse((await read(req,65536)).toString());
    if (offer?.type !== 'offer' || typeof offer.sdp !== 'string' || !offer.sdp.startsWith('v=0')) {
      throw Object.assign(new Error('Invalid video offer.'),{status:400, publicMessage:'Invalid video offer.'});
    }
    return {type:'offer',sdp:offer.sdp};
  }
  const handler = async (req, res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const method = req.method;
    const now = Date.now();
    if (!route.startsWith('/api/')) {
      if (!options.frontend) return respond(res, 404, {error:'Page not found.'});
      // Original-pixel uploads refresh their stereo clock from GET /camera.
      if (route === '/camera') res.setHeader('X-Server-Ms', Date.now());
      try {
        return await options.frontend(req,res);
      } catch {
        if (!res.headersSent) return respond(res, 500, {error:'Frontend unavailable.'});
        return res.destroy();
      }
    }
    res.setHeader('Cache-Control','no-store');
    try {
      const origin = req.headers.origin;
      if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== req.headers.host)) {
        return respond(res, 403, {error:'Cross-site requests are unavailable.'});
      }
      for (const [id, session] of sessions) {
        if (session.until > now) continue;
        for (const slot of Object.values(session.slots)) {
          phones.delete(slot.phone);
          if (slot.rtcID) rtc.drop(slot.rtcID);
        }
        sessions.delete(id);
      }
      for (const [code, entry] of codes) if (entry.until <= now) codes.delete(code);
      for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
      const token = (req.headers.authorization || '').replace(/^Bearer /,'');
      const archive = /^\/api\/depth-replay\/(d8be72ae|4317d705|36ad570e)$/.exec(route);
      if (archive && method === 'GET') {
        if (!sessions.has(token)) return respond(res,401,{error:'Open the desktop dashboard.'});
        if (!['localhost','127.0.0.1','[::1]'].includes(new URL('http://' + req.headers.host).hostname) ||
            !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))
          return respond(res,403,{error:'Open saved recordings on the Mac.'});
        const file = join(__dirname,'../.visionassist/depth-replays',archive[1]+'.mp4');
        try {
          const bytes = await require('node:fs/promises').readFile(file);
          return res.writeHead(200,{'Content-Type':'video/mp4'}).end(bytes);
        } catch { return respond(res,404,{error:'This saved depth replay is unavailable on this Mac.'}); }
      }
      if (route === '/api/usb') return await usb.handle(req,res,token);
      if (route === '/api/calibration/video-check') {
        if (!sessions.has(token)) return respond(res,401,{error:'Camera session ended.'});
        if (method !== 'POST') return respond(res,405,{error:'Use POST.'});
        const activeA = sessions.get(token).slots.A;
        const original = req.headers['x-frame-format'] === 'png' || activeA.rtcQuality === 'portrait-full';
        const maxFrames = original ? 1 : 4;
        const maxLength = original ? 16*1024*1024 : 470000;
        const {mode,pairs} = JSON.parse(await read(req,maxFrames*2*maxLength+1024));
        if (!['single','three'].includes(mode) || !Array.isArray(pairs) || !pairs.length || pairs.length > maxFrames ||
            !pairs.every(p => Array.isArray(p) && p.length === 2 && p.every(x => typeof x === 'string' && x.length <= maxLength)))
          return respond(res,400,{error:'Invalid stereo image batch or target mode.'});
        try {
          const boards = await require('./calibration.cjs').inspect(pairs,mode,true);
          const {poseFromBoards} = require('./calibration-quality.js');
          return respond(res,200,{poses:boards.map(b => poseFromBoards(b,mode))});
        } catch (error) { return respond(res,503,{error:error.message}); }
      }
      if (route === '/api/calibration/video-frame' || route === '/api/calibration/video') {
        const session = sessions.get(token);
        if (!session) return respond(res,401,{error:'Pair cameras from this dashboard first.'});
        if (route.endsWith('video-frame') && method === 'GET') {
          const {A,B} = session.slots;
          if (!A.phone || !B.phone || !A.frame || !B.frame || now-B.stamp >= FRESH || now-A.stamp >= FRESH)
            return respond(res,409,{error:'Both cameras must be online.'});
          const partner = require('./calibration.cjs').stereoPartner(A,B,now);
          if (!partner || req.headers['if-none-match'] === A.etag) return res.writeHead(204).end();
          res.setHeader('ETag',A.etag);
          return respond(res,200,{rig:[A.streamID,B.streamID].join('/'),partner:partner.id,sampleMs:A.sample.ms,types:[A.frameType,partner.frameType],fullSize:A.rtcQuality === "portrait-full",
            images:[A.frame,partner.frame].map(frame=>frame.toString('base64'))});
        }
        if (route.endsWith('/video')) {
          const mode = req.headers['x-calibration-mode'] ?? 'single';
          if (!['single','three'].includes(mode)) return respond(res,400,{error:'Unknown calibration target.'});
          const fs = require('node:fs/promises');
          const root = join(options.calibrationVideoRoot ?? join(__dirname,'../.visionassist/calibration-videos'),session.sourceID,mode);
          const validName = /^[a-f0-9]{64}\.webm$/;
          if (method === 'GET') {
            let entries;
            try { entries = await fs.readdir(root,{withFileTypes:true}); }
            catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
            const recordings = await Promise.all(entries.filter(e => e.isFile() && validName.test(e.name)).map(async e => {
              try { return {name:e.name,savedAt:(await fs.stat(join(root,e.name))).mtimeMs}; }
              catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
            }));
            return respond(res,200,{recordings:recordings.filter(Boolean).sort((a,b) => b.savedAt-a.savedAt)});
          }
          if (method === 'DELETE') {
            const {name} = JSON.parse(await read(req,512));
            if (typeof name !== 'string' || !validName.test(name)) return respond(res,400,{error:'Invalid recording name.'});
            await fs.rm(join(root,name),{force:true});
            return res.writeHead(204).end();
          }
          if (method !== 'POST') return respond(res,405,{error:'Method unavailable.'});
          if (req.headers['content-type'] !== 'video/webm') return respond(res,415,{error:'Expected WebM video.'});
          const bytes = await read(req,64*1024*1024);
          if (bytes.length < 4 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return respond(res,400,{error:'Invalid WebM video.'});
          await fs.mkdir(root,{recursive:true});
          const name = require('node:crypto').createHash('sha256').update(bytes).digest('hex')+'.webm';
          const temp = join(root,key()+'.part');
          try {
            await fs.writeFile(temp,bytes);
            await fs.rename(temp,join(root,name));
          } finally { await fs.rm(temp,{force:true}); }
          return respond(res,201,{file:'.visionassist/calibration-videos/'+session.sourceID+'/'+mode+'/'+name});
        }
        return respond(res,405,{error:'Method unavailable.'});
      }
      if (route === '/api/calibration/preview') {
        const session = sessions.get(token);
        if (!session) return respond(res,401,{error:'Pair cameras from this dashboard first.'});
        if (method !== 'POST') return respond(res,405,{error:'Use POST.'});
        const {mode = 'single'} = JSON.parse((await read(req,1024)).toString() || '{}');
        if (!['single','three'].includes(mode)) return respond(res,400,{error:'Unknown calibration target.'});
        try {
          const preview = await require('./calibration.cjs').previewCalibration(session,mode);
          return respond(res,200,{...preview,mode});
        } catch (error) {
          return respond(res,503,{error:error.message});
        }
      }
      if (/^\/api\/(agent|memory|cv)\//.test(route)) {
        return await assistant.handle(req,res,route,token);
      }
      if (method === 'POST' && route === '/api/session') {
        if (sessions.size >= 32) return respond(res, 503, {error:'Session limit reached. Restart the local demo server.'});
        const id = key();
        sessions.set(id, {until:now+TTL, slots:{A:{}, B:{}}, sourceID:key(),
          alerts:[], alertSeq:0, alertCooldown:new Map()});
        return respond(res, 201, {token:id});
      }
      if (method === 'POST' && route === '/api/join') {
        const ip = req.socket.remoteAddress;
        const attempt = attempts.get(ip) || {count:0,until:now+60_000};
        if (attempt.count >= 15) return respond(res, 429, {error:'Too many attempts. Wait a minute and retry.'});
        attempt.count += 1;
        attempts.set(ip, attempt);
        const {code,expectedSlot,expectedSourceID} = JSON.parse((await read(req,1024)).toString());
        const entry = codes.get(code);
        const session = entry && sessions.get(entry.session);
        if (!session || entry.until <= now) return respond(res, 404, {error:'Code expired or invalid. Generate a new code on the computer.'});
        if (expectedSlot !== undefined && expectedSlot !== entry.slot)
          return respond(res,409,{error:'Use the pairing code for Camera '+entry.slot+' in its matching slot.'});
        if (expectedSourceID !== undefined && expectedSourceID !== session.sourceID)
          return respond(res,409,{error:'Generate both camera codes in the same dashboard tab.'});
        codes.delete(code);
        const slot = resetSource(session,entry.slot);
        phones.delete(slot.phone);
        const phone = key();
        session.slots[entry.slot] = {phone, streamID:key(), stamp:0};
        phones.set(phone, {session:entry.session, slot:entry.slot});
        attempts.delete(ip);
        res.setHeader('X-Server-Ms', Date.now());
        return respond(res, 200, {token:phone,slot:entry.slot,sourceID:session.sourceID,webrtc:Boolean(rtc?.ready)});
      }
      if (['/api/webrtc/offer','/api/webrtc/status','/api/webrtc/clock'].includes(route)) {
        const entry = phones.get(token);
        const session = entry && sessions.get(entry.session);
        if (!session) return respond(res,401,{error:'Camera session ended. Pair again.'});
        const side = entry.slot;
        const original = session.slots[side];
        if (route.endsWith('/clock')) {
          if (!original.rtcID) return respond(res,409,{error:'Start WebRTC before synchronizing clocks.'});
          if (method === 'GET') return respond(res,200,{server_ms:Date.now()});
          if (method !== 'POST') return respond(res,405,{error:'Method unavailable.'});
          const {server_ms:server, sent_ms:sent, received_ms:received} = JSON.parse((await read(req,512)).toString());
          if (session.slots[side] !== original) return respond(res,409,{error:'Camera connection changed.'});
          const updated = Date.now();
          if (![server,sent,received].every(Number.isSafeInteger) || server > updated || updated-server > 2500 ||
              received < sent || received-sent > 100 || Math.abs(server-(sent+received)/2) > 86_400_000) {
            return respond(res,422,{error:'Clock sample unavailable.'});
          }
          const clock = {offset:server-(sent+received)/2,error:Math.ceil((received-sent)/2)+2,at:updated};
          const previous = original.rtcClock;
          if (!previous || updated-previous.at > 10000 || clock.error <= previous.error ||
              Math.abs(clock.offset-previous.offset) > clock.error+previous.error) original.rtcClock = clock;
          return res.writeHead(204).end();
        }
        if (route.endsWith('/status') && method === 'GET') {
          return respond(res,200,{available:Boolean(rtc?.ready),receiving:Boolean(original.rtcID && original.frame),
            ...original.rtcStats});
        }
        if (route.endsWith('/offer') && method === 'DELETE') {
          if (original.rtcID) resetSource(session,side);
          return res.writeHead(204).end();
        }
        if (route.endsWith('/status') || method !== 'POST') return respond(res,405,{error:'Method unavailable.'});
        if (!rtc?.ready) return respond(res,503,{error:'WebRTC is unavailable.'});
        const quality = url.searchParams.get('quality') ?? 'standard';
        if (!['standard','hd','portrait-low','portrait-full'].includes(quality)) return respond(res,400,{error:'Unknown WebRTC quality.'});
        const offer = await readOffer(req);
        if (session.slots[side] !== original) return respond(res,409,{error:'Camera connection changed.'});
        const slot = resetSource(session,side);
        slot.rtcQuality = quality;
        const id = slot.rtcID = key();
        const answer = await rtc.offer(id,{...offer,quality},{
          size(event) {
            if (session.slots[side] === slot) slot.rtcStats = {size_mismatch:true,width:event.width,height:event.height};
          },
          frame(event) {
            if (session.slots[side] !== slot) return;
            const frame = Buffer.from(event.jpeg,'base64');
            if (!frame.length || frame.length > (quality === "portrait-full" ? 4*1024*1024 : 600000)) return;
            slot.frame = frame;
            slot.frameType = 'image/jpeg';
            slot.stamp = Date.now();
            slot.etag = '"' + key() + '"';
            const clock = slot.rtcClock;
            const [captureMs, rtpError] = event.capture ?? [];
            const corrected = Math.round(captureMs + (clock?.offset ?? 0));
            const uncertainty = (clock?.error ?? 0) + rtpError + 1;
            slot.sample = clock && slot.stamp-clock.at <= 18000 && Number.isSafeInteger(captureMs) &&
              Number.isSafeInteger(rtpError) && rtpError >= 0 && uncertainty <= 32 &&
              corrected >= slot.stamp-750 && corrected <= slot.stamp+uncertainty
              ? {ms:corrected,error:uncertainty} : null;
            if (side === 'B') rememberRight(slot);
            slot.rtcStats = {decoded_fps:event.fps, decoded_frames:event.decoded_frames,
              width:event.width,height:event.height,
              receiver_bridge_ms:Math.max(0,slot.stamp-event.decoded_at),
              capture_timing_available:Boolean(slot.sample)};
          },
          closed() {
            if (session.slots[side] === slot) resetSource(session,side);
          }
        });
        if (session.slots[side] !== slot || !answer) {
          if (session.slots[side] === slot) resetSource(session,side);
          return respond(res,503,{error:'WebRTC connection could not be established.'});
        }
        return respond(res,200,answer);
      }
      const rtcView = /^\/api\/webrtc\/view\/([AB])$/.exec(route);
      if (rtcView) {
        const session = sessions.get(token);
        if (!session) return respond(res,401,{error:'Dashboard session ended.'});
        if (method !== 'POST' && method !== 'DELETE') return respond(res,405,{error:'Method unavailable.'});
        const side = rtcView[1];
        const slot = session.slots[side];
        const viewer = url.searchParams.get('viewer');
        if (!viewer || !/^[a-f0-9-]{36}$/.test(viewer)) return respond(res,400,{error:'Invalid viewer.'});
        if (method === 'DELETE') {
          if (slot.rtcID && slot.viewer === viewer) {
            slot.viewer = undefined;
            await rtc.closeView(slot.rtcID,viewer);
          }
          return res.writeHead(204).end();
        }
        if (!slot.rtcID || !slot.frame || now-slot.stamp > FRESH) {
          return respond(res,404,{error:'Pair a WebRTC camera first.'});
        }
        const offer = await readOffer(req);
        if (session.slots[side] !== slot || slot.viewOffer) {
          return respond(res,409,{error:'Camera connection changed.'});
        }
        slot.viewOffer = true;
        slot.viewer = viewer;
        const answer = await rtc.view(slot.rtcID,viewer,offer).finally(() => { slot.viewOffer = false; });
        if (answer && session.slots[side] === slot && slot.viewer === viewer) return respond(res,200,answer);
        if (session.slots[side] === slot && slot.viewer === viewer) {
          slot.viewer = undefined;
          await rtc.closeView(slot.rtcID,viewer);
        }
        return respond(res,503,{error:'Live video is unavailable.'});
      }
      if (route === '/api/frame' && ['PUT','DELETE'].includes(method)) {
        const entry = phones.get(token);
        const session = entry && sessions.get(entry.session);
        if (!session) return respond(res, 401, {error:'Camera session ended. Pair again.'});
        const slot = session.slots[entry.slot];
        if (method === 'DELETE') {
          resetSource(session,entry.slot);
          session.slots[entry.slot] = {};
          phones.delete(token);
          return res.writeHead(204).end();
        }
        const type = req.headers['content-type'];
        if (type !== 'image/jpeg' && type !== 'image/png') return respond(res, 400, {error:'Expected a JPEG or PNG frame.'});
        const frame = await read(req, type === 'image/png' ? 12 * 1024 * 1024 : 350_000);
        if (session.slots[entry.slot] !== slot) return respond(res, 401, {error:'Camera was replaced. Pair again.'});
        if (slot.rtcID) return respond(res,409,{error:'Close WebRTC before uploading images.'});
        if (type === 'image/png') {
          if (frame.length < 45 || !frame.subarray(0,8).equals(PNG_SIGNATURE) ||
              frame.readUInt32BE(8) !== 13 || frame.toString('ascii',12,16) !== 'IHDR' ||
              !frame.subarray(-12).equals(PNG_END)) {
            return respond(res, 400, {error:'Expected a valid PNG frame.'});
          }
          const width = frame.readUInt32BE(16), height = frame.readUInt32BE(20);
          if (!width || !height || Math.max(width,height) > 4096 || width*height > 3840*2160) {
            return respond(res, 400, {error:'Original PNG is too large. Reconnect using Standard mode.'});
          }
        } else if (frame.length < 4 || frame.readUInt16BE() !== 0xffd8 || frame.readUInt16BE(frame.length-2) !== 0xffd9) {
          return respond(res, 400, {error:'Expected a JPEG frame.'});
        }
        slot.frame = frame;
        slot.frameType = type;
        slot.stamp = Date.now();
        slot.etag = '"' + key() + '"';
        const sample = Number(req.headers['x-sample-ms']);
        const uncertainty = Number(req.headers['x-clock-error-ms']);
        slot.sample = Number.isSafeInteger(sample) && Math.abs(slot.stamp-sample) < FRESH &&
          Number.isSafeInteger(uncertainty) && uncertainty >= 0 && uncertainty <= 250
          ? {ms:sample, error:uncertainty} : null;
        if (entry.slot === 'B') rememberRight(slot);
        res.setHeader('X-Server-Ms', slot.stamp);
        return res.writeHead(204).end();
      }
      const match = /^\/api\/(pair|frame|preview)\/([AB])$/.exec(route);
      if (!match) return respond(res, 404, {error:'Request not found.'});
      const [, action, side] = match;
      const session = sessions.get(token);
      if (!session) return respond(res, 401, {error:'Desktop session ended. Generate a new pairing code.'});
      const slot = session.slots[side];
      if (method === 'GET' && action === 'preview') {
        if (side === 'A' && req.headers['x-depth-options'] !== undefined) {
          const opt = JSON.parse(req.headers['x-depth-options']);
          const mm = Number(opt.fiveMm);
          session.depthOptions = {...(typeof opt.low === 'boolean' ? {low:opt.low} : {}), spatial:opt.spatial === true, temporal:opt.temporal === true,
            meters:opt.meters === true, fiveMm:Number.isFinite(mm) && mm>0 ? mm : 0};
        }
        if (!slot.frame || now - slot.stamp > FRESH) return res.writeHead(204).end();
        // CV pins the actual JPEG at inference time. The phone may already be ahead.
        const recentDetection = slot.detection && now - slot.detection.timestamp_ms <= FRESH ? slot.detection : null;
        const expires = (recentDetection?.capture_ms ?? recentDetection?.timestamp_ms) + PREVIEW_MAX_ANALYSIS_LAG_MS;
        const analysisDelayed = recentDetection && now >= expires;
        const detection = analysisDelayed ? null : recentDetection;
        const partner = detection?.stereoPartner;
        const lostPartner = partner && (session.slots.B.streamID !== partner.stream || now - partner.stamp > FRESH);
        const frame = detection?.frame ?? slot.frame;
        const format = detection?.frameType ?? slot.frameType;
        const frame_id = detection?.frame_id ?? slot.etag.slice(1,-1);
        // A raw preview can acquire boxes without the camera uploading a new JPEG.
        const activeForecasts = [];
        const objects = detection?.objects.map(({item_feature, intrusion, ...object}, i) => {
          if (lostPartner) delete object.depth_m;
          if (!lostPartner && intrusion && intrusion.expires > now && detection.partnerStream === session.slots.B.streamID) {
            object.intrusion = intrusion;
            activeForecasts.push(i);
          }
          return object;
        }) ?? null;
        const forecastTag = activeForecasts.length ? '-cross-' + activeForecasts.join('-') : '';
        const etag = '"' + (detection ? 'yolo-' : 'raw-') + frame_id + forecastTag +
          (lostPartner ? '-unpaired' : '') + (analysisDelayed ? '-analysis-delayed' : '') + '"';
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) return res.writeHead(304).end();
        return respond(res,200,{
          schema_version:DETECTION_SCHEMA_VERSION, camera_id:side, frame_id,
          depth_rig:[session.slots.A.streamID,session.slots.B.streamID].join("/"),
          timestamp_ms:detection?.timestamp_ms ?? slot.stamp,
          ...(detection ? {analysis_expires_ms:expires, preview_objects:detection.previewObjects} : {}),
          ...(slot.rtcStats ? {webrtc:slot.rtcStats} : {}),
          ...(format === 'image/png' ? {png:frame.toString('base64')} : {jpeg:frame.toString('base64')}), objects,
          ...(detection?.road_edge && (!lostPartner || detection.road_edge.distance_m === undefined) ? {road_edge:detection.road_edge} : {}),
          ...(analysisDelayed ? {analysis_delayed:true} : {}),
          ...(detection?.stereoStatus ? {stereo_status:lostPartner ? 'waiting_for_pair' : detection.stereoStatus} : {}),
          ...(!lostPartner && detection?.depthPreview ? {
            depth_preview:detection.depthPreview, depth_range_m:detection.depthRange,
            depth_valid_fraction:detection.depthValidFraction, center_m:detection.centerM, depth_options:partner?.depthOptions
          } : {})
        });
      }
      if (method === 'POST' && action === 'pair') {
        for (const [code, entry] of codes) if (entry.session === token && entry.slot === side) codes.delete(code);
        let code;
        do { code = String(randomInt(100000,1000000)); } while (codes.has(code));
        codes.set(code, {session:token, slot:side, until:now+CODE_TTL});
        const origin = options.phoneOrigin || (req.socket.encrypted ? 'https://'+req.headers.host : null);
        return respond(res, 201, {code,...phonePairingInfo(origin,side,code)});
      }
      if (method === 'GET' && action === 'frame') {
        if (!slot.frame || now-slot.stamp > FRESH) {
          delete slot.frame;
          return res.writeHead(204).end();
        }
        if (req.headers['if-none-match'] === slot.etag) return res.writeHead(304).end();
        return res.writeHead(200, {'Content-Type':slot.frameType, ETag:slot.etag}).end(slot.frame);
      }
      return respond(res, 405, {error:'Method unavailable.'});
    } catch (error) {
      if (!res.destroyed && !res.headersSent) respond(res, error.status || (error instanceof SyntaxError ? 400 : 500),
        {error:error.publicMessage || (error.status === 413 ? 'Request is too large.' : 'Could not process the request.')});
    }
  };
  const server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
  server.once('close', assistant.close);
  server.once('close', usb.close);
  if (rtc) server.once('close', () => rtc.close());
  return server;
}

async function main(args) {
  const dev = args.includes('--dev');
  const [cert, privateKey] = args.filter(value => value !== '--dev');
  if (Boolean(cert) !== Boolean(privateKey)) throw new Error('Provide both the certificate and private-key paths, or neither.');
  const tls = cert ? {cert:readFileSync(cert), key:readFileSync(privateKey)} : undefined;
  const port = Number(process.env.VISIONASSIST_PORT || 8765);
  let phoneOrigin = process.env.VISIONASSIST_PHONE_ORIGIN;
  if (!phoneOrigin) {
    try { phoneOrigin = readFileSync(join(__dirname,'../.visionassist','phone-origin-'+port+'.txt'),'utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const host = tls ? '0.0.0.0' : '127.0.0.1';
  process.env.NODE_ENV = dev ? 'development' : 'production';
  const next = require('next');
  const app = next({dev, dir:__dirname, hostname:host, port});
  await app.prepare();
  const rtcPython = process.env.VISIONASSIST_RTC_PYTHON;
  const rtc = rtcPython && createRtcBridge(rtcPython);
  if (rtc) {
    await rtc.waitForStartup();
    if (!rtc.ready) console.warn('WebRTC receiver unavailable. Camera uploads will use JPEG.');
  }
  const server = createServer({tls,phoneOrigin,frontend:app.getRequestHandler(),rtc});
  server.listen(port, host, () => {
    const actualPort = server.address().port;
    console.log(tls ? 'Use the HTTPS hostname covered by your certificate, on port ' + actualPort + ', for both entries.'
      : 'Desktop: http://localhost:' + actualPort + '/   Camera: http://localhost:' + actualPort + '/camera');
  });
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = {createServer};
