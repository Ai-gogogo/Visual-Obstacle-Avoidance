const http = require('node:http');
const https = require('node:https');
const { randomBytes, randomInt } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const files = {
  '/': ['index.html','text/html; charset=utf-8'],
  '/index.html': ['index.html','text/html; charset=utf-8'],
  '/camera': ['camera.html','text/html; charset=utf-8'],
  '/camera.html': ['camera.html','text/html; charset=utf-8'],
  '/ui.css': ['ui.css','text/css; charset=utf-8'],
  '/desktop.js': ['desktop.js','text/javascript; charset=utf-8'],
  '/camera.js': ['camera.js','text/javascript; charset=utf-8'],
  '/demo-lab.webp': ['demo-lab.webp','image/webp']
};
const TTL = 4 * 60 * 60 * 1000;
const CODE_TTL = 5 * 60 * 1000;
const FRESH = 5000;
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
      if (method === 'POST' && route === '/api/session') {
        if (sessions.size >= 32) return respond(res, 503, {error:'Session limit reached. Restart the local demo server.'});
        const id = key();
        sessions.set(id, {until:now+TTL, slots:{A:{}, B:{}}});
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
        session.slots[entry.slot] = {phone, stamp:0};
        phones.set(phone, {session:entry.session, slot:entry.slot});
        attempts.delete(ip);
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
        const frame = await read(req, 350_000);
        if (session.slots[entry.slot] !== slot) return respond(res, 401, {error:'Camera was replaced. Pair again.'});
        if (req.headers['content-type'] !== 'image/jpeg' || frame.length < 4 || frame.readUInt16BE() !== 0xffd8 || frame.readUInt16BE(frame.length-2) !== 0xffd9) {
          return respond(res, 400, {error:'Expected a JPEG frame.'});
        }
        slot.frame = frame;
        slot.stamp = Date.now();
        slot.etag = '"' + key() + '"';
        return res.writeHead(204).end();
      }
      const match = /^\/api\/(pair|frame)\/([AB])$/.exec(route);
      if (!match) return respond(res, 404, {error:'Request not found.'});
      const [, action, side] = match;
      const session = sessions.get(token);
      if (!session) return respond(res, 401, {error:'Desktop session ended. Generate a new pairing code.'});
      const slot = session.slots[side];
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
        return res.writeHead(200, {'Content-Type':'image/jpeg', ETag:slot.etag}).end(slot.frame);
      }
      return respond(res, 405, {error:'Method unavailable.'});
    } catch (error) {
      if (!res.destroyed) respond(res, error.status || 400, {error:error.status === 413 ? 'Frame is too large.' : 'Could not process the request.'});
    }
  };
  return options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
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
