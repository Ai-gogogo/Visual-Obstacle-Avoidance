const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const ip = process.env.PHONE_HOST, port = Number(process.env.PHONE_PORT || 8776);
if (!ip) throw new Error('Set PHONE_HOST to the LAN address in the phone certificate.');
const origin = 'https://' + ip + ':' + port;
const routes = new Set(['GET /camera','POST /api/join','PUT /api/frame','DELETE /api/frame',
  'GET /api/webrtc/status','GET /api/webrtc/clock','POST /api/webrtc/clock','DELETE /api/webrtc/offer']);
function phoneRoute(method, path) {
  return routes.has(method+' '+path) || (method === 'POST' &&
    /^\/api\/webrtc\/offer(?:\?quality=(?:portrait-low|portrait-full|standard|hd))?$/.test(path));
}
https.createServer({cert:fs.readFileSync('server.pem'),key:fs.readFileSync('server.key')},(req,res)=>{
  if (process.env.PHONE_DIAGNOSTICS === '1' && (req.url === '/api/join' ||
      req.url.startsWith('/api/webrtc/offer') || req.url === '/api/webrtc/status')) {
    const client = /iPhone/i.test(req.headers['user-agent'] || '') ? 'iPhone' : 'other';
    res.once('finish', () => console.log(new Date().toISOString(), client, req.method,
      req.url.split('?')[0], res.statusCode));
  }
  // Next serves the production camera bundle and styles as immutable build assets.
  const nextAsset = req.method === 'GET' && /^\/_next\/static\/(?:[A-Za-z0-9_~-][\w.~-]*\/)*[A-Za-z0-9_~-][\w.~-]*\.(?:js|css|woff2)(?:\?[^#]*)?$/.test(req.url);
  if(req.headers.host !== ip+':'+port || (req.headers.origin && req.headers.origin!==origin) || req.headers['sec-fetch-site']==='cross-site' || !(nextAsset || phoneRoute(req.method,req.url))) return res.writeHead(404).end();
  const headers={host:req.headers.host};
  for(const name of ['content-type','authorization','origin','sec-fetch-site','content-length','x-sample-ms','x-clock-error-ms','x-capture-stream']) if(req.headers[name]) headers[name]=req.headers[name];
  const upstream=http.request({host:'127.0.0.1',port:Number(process.env.DESKTOP_PORT || 8775),path:req.url,method:req.method,headers},response=>{
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
  req.on('aborted',()=>upstream.destroy());
  req.pipe(upstream);
}).listen(port,ip,()=>console.log(origin+'/camera'));
