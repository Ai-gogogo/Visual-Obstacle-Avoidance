const http = require('node:http');
const https = require('node:https');
const { randomBytes, randomInt } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createAgentRoutes, DETECTION_SCHEMA_VERSION } = require('../llm/agent-routes.cjs');

const files = {
  '/': ['index.html','text/html; charset=utf-8'],
  '/index.html': ['index.html','text/html; charset=utf-8'],
  '/camera': ['camera.html','text/html; charset=utf-8'],
  '/camera.html': ['camera.html','text/html; charset=utf-8'],
  '/ui.css': ['ui.css','text/css; charset=utf-8'],
  '/desktop.js': ['desktop.js','text/javascript; charset=utf-8'],
  '/voice-capture.js': ['voice-capture.js','text/javascript; charset=utf-8'],
  '/calibration-quality.js': ['calibration-quality.js','text/javascript; charset=utf-8'],
  '/stereo-video.js': ['stereo-video.js','text/javascript; charset=utf-8'],
  '/box-targets.pdf': ['box-targets.pdf','application/pdf'],
  '/calibration.js': ['calibration.js','text/javascript; charset=utf-8'],
  '/camera.js': ['camera.js','text/javascript; charset=utf-8'],
  '/demo-lab.webp': ['demo-lab.webp','image/webp']
};
const qrcode = require('./vendor/qrcode-generator-2.0.4/qrcode.js');

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
  const handler = async (req, res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const route = new URL(req.url, 'http://localhost').pathname;
    const method = req.method;
    const now = Date.now();
    if (!route.startsWith('/api/')) {
      if (!Object.hasOwn(files, route) || method !== 'GET') return respond(res, 404, {error:'Page not found.'});
      const [filename, type] = files[route];
      try {
        const content = readFileSync(join(__dirname,filename));
        if (filename === 'camera.html') res.setHeader('X-Server-Ms', Date.now());
        res.writeHead(200, {'Content-Type':type});
        return res.end(content);
      } catch { return respond(res, 404, {error:'File not found.'}); }
    }
    try {
      const origin = req.headers.origin;
      if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== req.headers.host)) {
        return respond(res, 403, {error:'Cross-site requests are unavailable.'});
      }
      for (const [id, session] of sessions) {
        if (session.until > now) continue;
        for (const slot of Object.values(session.slots)) phones.delete(slot.phone);
        sessions.delete(id);
      }
      for (const [code, entry] of codes) if (entry.until <= now) codes.delete(code);
      for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
      const token = (req.headers.authorization || '').replace(/^Bearer /,'');
      if (route === '/api/calibration/video-check') {
        if (!sessions.has(token)) return respond(res,401,{error:'Camera session ended.'});
        if (method !== 'POST') return respond(res,405,{error:'Use POST.'});
        const original = req.headers['x-frame-format'] === 'png';
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
          return respond(res,200,{rig:[A.streamID,B.streamID].join('/'),partner:partner.id,sampleMs:A.sample.ms,types:[A.frameType,partner.frameType],
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
        const {code} = JSON.parse((await read(req,1024)).toString());
        const entry = codes.get(code);
        const session = entry && sessions.get(entry.session);
        if (!session || entry.until <= now) return respond(res, 404, {error:'Code expired or invalid. Generate a new code on the computer.'});
        codes.delete(code);
        const slot = session.slots[entry.slot];
        phones.delete(slot.phone);
        const phone = key();
        session.slots[entry.slot] = {phone, streamID:key(), stamp:0};
        phones.set(phone, {session:entry.session, slot:entry.slot});
        attempts.delete(ip);
        res.setHeader('X-Server-Ms', Date.now());
        return respond(res, 200, {token:phone});
      }
      if (route === '/api/frame' && ['PUT','DELETE'].includes(method)) {
        const entry = phones.get(token);
        const session = entry && sessions.get(entry.session);
        if (!session) return respond(res, 401, {error:'Camera session ended. Pair again.'});
        const slot = session.slots[entry.slot];
        if (method === 'DELETE') {
          session.slots[entry.slot] = {};
          phones.delete(token);
          return res.writeHead(204).end();
        }
        const type = req.headers['content-type'];
        if (type !== 'image/jpeg' && type !== 'image/png') return respond(res, 400, {error:'Expected a JPEG or PNG frame.'});
        const frame = await read(req, type === 'image/png' ? 12 * 1024 * 1024 : 350_000);
        if (session.slots[entry.slot] !== slot) return respond(res, 401, {error:'Camera was replaced. Pair again.'});
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
        if (entry.slot === 'B' && slot.sample) {
          slot.history ||= [];
          slot.history.push({id:slot.etag.slice(1,-1), frame, frameType:type, stamp:slot.stamp, sample:slot.sample});
          slot.history.splice(0, Math.max(0,slot.history.length - (type === 'image/png' ? 3 : 6)));
        }
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
          session.depthOptions = {spatial:opt.spatial === true, temporal:opt.temporal === true,
            meters:opt.meters === true, fiveMm:Number.isFinite(mm) && mm>0 ? mm : 0};
        }
        if (!slot.frame || now - slot.stamp > FRESH) return res.writeHead(204).end();
        // CV pins the actual JPEG at inference time. The phone may already be ahead.
        const detection = slot.detection && now - slot.detection.timestamp_ms <= FRESH ? slot.detection : null;
        const partner = detection?.stereoPartner;
        const lostPartner = partner && (session.slots.B.streamID !== partner.stream || now - partner.stamp > FRESH);
        const frame = detection?.frame ?? slot.frame;
        const format = detection?.frameType ?? slot.frameType;
        const frame_id = detection?.frame_id ?? slot.etag.slice(1,-1);
        // A raw preview can acquire boxes without the camera uploading a new JPEG.
        const etag = '"' + (detection ? 'yolo-' : 'raw-') + frame_id + (lostPartner ? '-unpaired' : '') + '"';
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) return res.writeHead(304).end();
        const objects = detection?.objects.map(({item_feature, ...object}) => {
          if (lostPartner) delete object.depth_m;
          return object;
        }) ?? null;
        return respond(res,200,{
          schema_version:DETECTION_SCHEMA_VERSION, camera_id:side, frame_id,
          timestamp_ms:detection?.timestamp_ms ?? slot.stamp,
          ...(format === 'image/png' ? {png:frame.toString('base64')} : {jpeg:frame.toString('base64')}), objects,
          ...(detection?.stereoStatus ? {stereo_status:lostPartner ? 'waiting_for_pair' : detection.stereoStatus} : {}),
          ...(!lostPartner && detection?.depthPreview ? {depth_preview:detection.depthPreview, depth_range_m:detection.depthRange, center_m:detection.centerM, depth_options:partner.depthOptions} : {})
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
  return server;
}

if (require.main === module) {
  const [cert, privateKey] = process.argv.slice(2);
  if (Boolean(cert) !== Boolean(privateKey)) throw new Error('Provide both the certificate and private-key paths, or neither.');
  const tls = cert ? {cert:readFileSync(cert), key:readFileSync(privateKey)} : undefined;
  const port = Number(process.env.VISIONASSIST_PORT || 8765);
  let phoneOrigin = process.env.VISIONASSIST_PHONE_ORIGIN;
  if (!phoneOrigin) {
    try { phoneOrigin = readFileSync(join(__dirname,'../.visionassist','phone-origin-'+port+'.txt'),'utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  createServer({tls,phoneOrigin}).listen(port, tls ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(tls ? 'Use the HTTPS hostname covered by your certificate, on port ' + port + ', for both entries.'
      : 'Desktop: http://localhost:' + port + '/   Camera: http://localhost:' + port + '/camera');
  });
}
module.exports = {createServer};
