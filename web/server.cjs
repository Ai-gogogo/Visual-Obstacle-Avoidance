const http = require('node:http');
const https = require('node:https');
const { randomBytes, randomInt } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createAgentRoutes, DETECTION_SCHEMA_VERSION } = require('../llm/agent-routes.cjs');
const {PREVIEW_MAX_ANALYSIS_LAG_MS} = require('../llm/agent.cjs');

const files = {
  '/': ['index.html','text/html; charset=utf-8'],
  '/index.html': ['index.html','text/html; charset=utf-8'],
  '/camera': ['camera.html','text/html; charset=utf-8'],
  '/camera.html': ['camera.html','text/html; charset=utf-8'],
  '/ui.css': ['ui.css','text/css; charset=utf-8'],
  '/desktop.js': ['desktop.js','text/javascript; charset=utf-8'],
  '/voice-capture.js': ['voice-capture.js','text/javascript; charset=utf-8'],
  '/calibration.js': ['calibration.js','text/javascript; charset=utf-8'],
  '/camera.js': ['camera.js','text/javascript; charset=utf-8'],
  '/demo-lab.webp': ['demo-lab.webp','image/webp']
};
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
      if (route === '/api/calibration/preview' || route === '/api/calibration/capture') {
        const session = sessions.get(token);
        if (!session) return respond(res,401,{error:'Pair cameras from this dashboard first.'});
        if (method !== 'POST') return respond(res,405,{error:'Use POST.'});
        const {id} = JSON.parse((await read(req,1024)).toString() || '{}');
        try {
          return respond(res,200,await require('./calibration.cjs').calibration(session,route.split('/').pop(),id));
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
        session.alerts = session.alerts.filter(alert => alert.kind !== 'path_intrusion');
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
          session.alerts = session.alerts.filter(alert => alert.kind !== 'path_intrusion');
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
        if (!slot.frame || now - slot.stamp > FRESH) return res.writeHead(204).end();
        // CV pins the actual JPEG at inference time. The phone may already be ahead.
        const recentDetection = slot.detection && now - slot.detection.timestamp_ms <= FRESH ? slot.detection : null;
        const analysisDelayed = recentDetection && slot.frame !== recentDetection.frame &&
          now - recentDetection.timestamp_ms > PREVIEW_MAX_ANALYSIS_LAG_MS;
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
          timestamp_ms:detection?.timestamp_ms ?? slot.stamp,
          ...(format === 'image/png' ? {png:frame.toString('base64')} : {jpeg:frame.toString('base64')}), objects,
          ...(detection?.road_edge && (!lostPartner || detection.road_edge.distance_m === undefined) ? {road_edge:detection.road_edge} : {}),
          ...(analysisDelayed ? {analysis_delayed:true} : {}),
          ...(detection?.stereoStatus ? {stereo_status:lostPartner ? 'waiting_for_pair' : detection.stereoStatus} : {}),
          ...(!lostPartner && detection?.depthPreview ? {
            depth_preview:detection.depthPreview, depth_range_m:detection.depthRange,
            depth_valid_fraction:detection.depthValidFraction
          } : {})
        });
      }
      if (method === 'POST' && action === 'pair') {
        for (const [code, entry] of codes) if (entry.session === token && entry.slot === side) codes.delete(code);
        let code;
        do { code = String(randomInt(100000,1000000)); } while (codes.has(code));
        codes.set(code, {session:token, slot:side, until:now+CODE_TTL});
        return respond(res, 201, {code});
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
  createServer({tls}).listen(port, tls ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(tls ? 'Use the HTTPS hostname covered by your certificate, on port ' + port + ', for both entries.'
      : 'Desktop: http://localhost:' + port + '/   Camera: http://localhost:' + port + '/camera');
  });
}
module.exports = {createServer};
