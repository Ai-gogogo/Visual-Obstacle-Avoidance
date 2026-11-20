const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');
const {join} = require('node:path');
const {readFile} = require('node:fs/promises');
const run = promisify(execFile);
const script = join(__dirname, '../wired/capture.py');
const sides = ['A','B'];
const local = hostname => ['localhost','127.0.0.1','[::1]'].includes(hostname);

function usbCameras({sessions, phones, key, read, respond}) {
  let current;
  let connecting = false;
  let failure = '';
  function stop(job) {
    if (!job) return;
    job.child.kill('SIGTERM');
    for (const side of sides) {
      phones.delete(job.tokens[side]);
      if (job.session.slots[side].phone === job.tokens[side]) job.session.slots[side] = {};
    }
    if (current === job) current = undefined;
  }
  async function devices() {
    const {stdout} = await run('python3',[script,'list'],{timeout:4500});
    return stdout.split(/\s+/).filter(id => /^[a-f\d-]{20,64}$/i.test(id));
  }
  return {
    close: () => stop(current),
    async handle(req,res,token) {
      const session = sessions.get(token);
      if (!session) return respond(res,401,{error:'Open the desktop dashboard again.'});
      const host = new URL('http://'+req.headers.host);
      if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
          !local(host.hostname) || req.headers['x-visionassist-usb'] !== 'desktop' ||
          (req.method !== 'GET' && req.headers.origin !== host.origin))
        return respond(res,403,{error:'Open the dashboard on localhost to connect USB cameras.'});
      if (req.method === 'DELETE') {
        if (current && current.session !== session) return respond(res,409,{error:'Disconnect from the dashboard that connected these phones.'});
        stop(current);
        failure = '';
        return respond(res,200,{});
      }
      if (!['GET','POST'].includes(req.method)) return respond(res,405,{error:'Unsupported USB action.'});
      let ids;
      try { ids = await devices(); }
      catch { return respond(res,503,{error:'Mac could not list USB devices. Unlock the phones and trust this Mac.'}); }
      if (req.method === 'GET') {
        let names = {};
        try { names = JSON.parse(await readFile(join(__dirname,'../.visionassist/usb-phones.json'),'utf8')); } catch {}
        return respond(res,200,{devices:ids.map(id => ({id,label:names[id]?.name || 'iPhone · '+id.slice(-6),side:names[id]?.side})),
          selected:current?.selection, own:current?.session === session,
          live:!!current && sides.every(s => Date.now()-current.session.slots[s].stamp < 5000),
          message:failure});
      }
      const selection = JSON.parse(await read(req,512));
      if (!selection || !sides.every(s => ids.includes(selection[s])) || selection.A === selection.B)
        return respond(res,400,{error:'Select two different connected phones.'});
      selection.resolution ??= '1080x1920';
      if (!['480x640','1080x1920'].includes(selection.resolution))
        return respond(res,400,{error:'Unsupported camera resolution.'});
      if (connecting) return respond(res,409,{error:'A connection is starting. Try again shortly.'});
      connecting = true;
      try {
        if (current?.session === session && current.selection.resolution === selection.resolution && sides.every(s => current.selection[s] === selection[s])) return respond(res,200,{});
        const tokens = {A:key(),B:key()};
        const child = spawn('python3',['-u',script,'capture','--managed','--a',selection.A,'--b',selection.B,
          '--resolution',selection.resolution,'--dashboard-port',String(req.socket.localPort),'--publish-interval',selection.resolution === '480x640' ? '0.35' : '0.75'],{stdio:['pipe','ignore','pipe']});
        child.stdin.on('error',()=>{});
        await new Promise((resolve,reject) => { child.once('error',reject); child.once('spawn',resolve); });
        stop(current);
        failure = '';
        for (const side of sides) {
          phones.delete(session.slots[side].phone);
          session.slots[side] = {phone:tokens[side],streamID:key(),stamp:0,usbResolution:selection.resolution};
          phones.set(tokens[side],{session:token,slot:side});
        }
        session.alerts = session.alerts.filter(a => a.kind !== 'path_intrusion');
        const job = current = {child,session,selection,tokens};
        child.stderr.on('data',()=>{});
        child.once('exit',()=>{ if (current === job) {stop(job); failure='USB capture ended. Check the cables and reconnect.';} });
        child.stdin.end(JSON.stringify(tokens)+'\n');
        return respond(res,201,{});
      } finally { connecting = false; }
    }
  };
}
module.exports = {usbCameras};
