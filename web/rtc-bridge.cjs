const {spawn} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {createInterface} = require('node:readline');
const {join} = require('node:path');

function createRtcBridge(python) {
  const secret = randomBytes(32).toString('hex');
  const sources = new Map();
  let port;
  let startup;
  const ready = new Promise(resolve => { startup = resolve; });
  const child = spawn(python, ['-B', '-u', join(__dirname,'../cv/rtc_receiver.py')], {
    env:{...process.env, VISIONASSIST_RTC_BRIDGE_KEY:secret},
    stdio:['pipe','pipe','inherit'],
    windowsHide:true
  });

  function offline() {
    port = undefined;
    startup();
    for (const source of sources.values()) source.closed();
    sources.clear();
  }

  child.once('error', offline);
  child.once('exit', offline);
  child.stdin.on('error', () => {});
  createInterface({input:child.stdout}).on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.kind === 'ready') {
      port = event.port;
      startup();
      return;
    }
    const source = sources.get(event.id);
    if (!source) return;
    if (event.kind === 'frame') source.frame(event);
    if (event.kind === 'size') source.size(event);
    if (event.kind === 'closed') {
      sources.delete(event.id);
      source.closed();
    }
  });

  async function request(path, method, offer) {
    if (!port) return null;
    try {
      const response = await fetch('http://127.0.0.1:'+port+path, {
        method, headers:{'X-Bridge-Key':secret,'Content-Type':'application/json'},
        signal:AbortSignal.timeout(5500), body:offer && JSON.stringify(offer)
      });
      return response.ok && method === 'POST' ? await response.json() : null;
    } catch {
      return null;
    }
  }

  return {
    get ready() { return Boolean(port); },
    async waitForStartup() {
      let timeout;
      try {
        await Promise.race([ready,new Promise(resolve => { timeout = setTimeout(resolve,8000); })]);
      } finally { clearTimeout(timeout); }
    },
    async offer(id, offer, source) {
      sources.set(id,source);
      return request('/camera/'+id,'POST',offer);
    },
    view(id, viewer, offer) { return request('/view/'+id+'?viewer='+viewer,'POST',offer); },
    closeView(id, viewer) { return request('/view/'+id+'?viewer='+viewer,'DELETE'); },
    drop(id) {
      if (sources.delete(id)) void request('/camera/'+id,'DELETE');
    },
    close() {
      offline();
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(),2500);
      timeout.unref();
      child.once('exit',() => clearTimeout(timeout));
    }
  };
}

module.exports = {createRtcBridge};
