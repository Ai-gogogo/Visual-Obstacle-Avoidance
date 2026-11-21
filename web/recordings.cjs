const fs = require('node:fs/promises');
const {existsSync,createReadStream} = require('node:fs');
const {pipeline} = require('node:stream/promises');
const {randomUUID} = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {join} = require('node:path');
const {stereoPartner} = require('./calibration.cjs');

const run = promisify(execFile);
const cv = join(__dirname,'../cv');
const localPython = join(__dirname,'../.visionassist/rtc-env/bin/python');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const header = 'pair,elapsed_s,skew_bound_ms,a_id,b_id,skew_ms,a_sample_ms,b_sample_ms,a_file,b_file\n';

function stereoRecordings(root,respond) {
  const jobs = new Map();

  async function persist(take) {
    const path = join(root,take.id,'take.json');
    await fs.writeFile(path+'.tmp',JSON.stringify(take));
    await fs.rename(path+'.tmp',path);
  }

  async function lookup(id) {
    if (!uuid.test(id)) return null;
    if (jobs.has(id)) return jobs.get(id).take;
    const dir = join(root,id);
    let take;
    try { take = JSON.parse(await fs.readFile(join(dir,'take.json'),'utf8')); }
    catch (error) { if (error.code==='ENOENT') return null; throw error; }
    // Frame rows are committed after both original files, even if the server exits early.
    if (['recording','saving','comparing'].includes(take.status)) {
      const manifest = await fs.readFile(join(dir,'timestamps.csv'),'utf8');
      const rows = manifest.trimEnd().split('\n').slice(1);
      take.pairs = rows.length;
      take.duration = rows.length ? Number(rows.at(-1).split(',')[1]) : 0;
      take.status = 'interrupted';
      take.message = 'Server restarted. Completed pairs are available.';
      take.video = existsSync(join(dir,'stereo.mp4'));
      take.comparison = existsSync(join(dir,'stereo-depth-comparison.mp4'));
    }
    return take;
  }

  async function library() {
    await fs.mkdir(root,{recursive:true});
    const entries = await fs.readdir(root);
    const takes = await Promise.all(entries.filter(id=>uuid.test(id)).map(lookup));
    return takes.filter(Boolean).sort((a,b)=>b.startedAt-a.startedAt);
  }

  async function render(take,comparison) {
    const dir = join(root,take.id);
    const python = process.env.VISIONASSIST_CV_PYTHON || (existsSync(localPython) ? localPython : 'python3');
    const args = comparison
      ? [join(cv,'results/stereo-depth-comparison-2026-11-20/compare.py'),'--take',dir,'--calibration',join(dir,'calibration.json')]
      : [join(cv,'export_stereo_recording.py'),dir];
    try {
      await run(python,['-u',...args],{maxBuffer:4*1024*1024});
      if (comparison) {
        take.comparison = true;
        take.comparisonSegmentation = true;
      } else take.video = true;
      take.status = 'saved';
    } catch (error) {
      take.status = 'error';
      const detail = error.stderr?.trim().split('\n').at(-1) || error.code || 'unknown error';
      take.message = 'Original frames retained. Video export failed. '+String(detail).slice(0,250);
    }
  }

  async function record(job,session,left,right) {
    const {take} = job, dir = join(root,take.id);
    let lastA, lastB, firstSample;
    try {
      while (!job.stop) {
        const now = Date.now();
        if (session.slots.A!==left || session.slots.B!==right ||
            now-left.stamp>5000 || now-right.stamp>5000 || now>=session.until) {
          take.message = 'Camera disconnected or pairing changed.';
          break;
        }
        const a = left.sample;
        const partner = a && left.stamp>=take.startedAt && (lastA===undefined || a.ms>lastA)
          && stereoPartner(left,right,now,frame=>frame.stamp>=take.startedAt && (lastB===undefined || frame.sample.ms>lastB));
        if (partner) {
          const id = left.etag.slice(1,-1);
          const prefix = String(take.pairs).padStart(4,'0');
          const names = [left.frameType,partner.frameType].map((type,i)=>prefix+'-'+'AB'[i]+(type==='image/png'?'.png':'.jpg'));
          const skew = Math.abs(a.ms-partner.sample.ms);
          firstSample ??= a.ms;
          const elapsed = (a.ms-firstSample)/1000;
          const row = [take.pairs,elapsed,skew+a.error+partner.sample.error,id,partner.id,skew,a.ms,partner.sample.ms,...names];
          await Promise.all([fs.writeFile(join(dir,names[0]),left.frame),fs.writeFile(join(dir,names[1]),partner.frame)]);
          await fs.appendFile(join(dir,'timestamps.csv'),row.join(',')+'\n');
          lastA = a.ms; lastB = partner.sample.ms;
          take.pairs++;
          take.duration = elapsed;
        }
        await pause(40);
      }
      if (take.pairs) {
        take.status = 'saving';
        await render(take,false);
      } else {
        take.status = 'empty';
        take.message = 'No synchronized pairs were captured.';
      }
    } catch (error) {
      take.status = 'error';
      take.message = 'Recording stopped. '+error.message;
    } finally {
      try { await persist(take); }
      finally { jobs.delete(take.id); }
    }
  }

  async function start(session) {
    const {A,B} = session.slots;
    if ([...jobs.values()].some(job=>job.take.status==='recording'))
      return {error:'A stereo recording is already active.'};
    if (![A,B].every(s=>s.frame && Date.now()-s.stamp<5000))
      return {error:'Both cameras must be sending frames from this dashboard.'};
    const calibration = A.rtcQuality==='portrait-low' && B.rtcQuality==='portrait-low' ? 'webrtc-480x640'
      : A.usbResolution && A.usbResolution===B.usbResolution ? 'usb-'+A.usbResolution : null;
    const take = {id:randomUUID(),startedAt:Date.now(),pairs:0,duration:0,status:'recording',calibration,video:false,comparison:false,message:''};
    const job = {take,stop:false};
    jobs.set(take.id,job);
    const dir = join(root,take.id);
    try {
      await fs.mkdir(dir,{recursive:true});
      if (calibration) await fs.copyFile(join(cv,'results/stereo-calibration-2026-11-20',calibration+'.json'),join(dir,'calibration.json'));
      await fs.writeFile(join(dir,'timestamps.csv'),header);
      await persist(take);
      void record(job,session,A,B).catch(console.error);
      return take;
    } catch (error) { jobs.delete(take.id); throw error; }
  }

  async function handle(req,res,route,session) {
    const host = new URL('http://'+req.headers.host).hostname;
    if (!['localhost','127.0.0.1','[::1]'].includes(host) ||
        !['::1','127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))
      return respond(res,403,{error:'Open recordings on the local Mac.'});
    if (!session) return respond(res,401,{error:'Open the desktop dashboard.'});
    const [, , ,id,action] = route.split('/');
    if (route==='/api/recordings' && req.method==='GET') return respond(res,200,{takes:await library()});
    if (id==='start' && !action && req.method==='POST') {
      const take = await start(session);
      return respond(res,take.error ? 409 : 201,take);
    }
    const take = id && await lookup(id);
    if (!take) return respond(res,404,{error:'Recording not found.'});
    if (req.method==='POST' && action==='stop') {
      const job = jobs.get(id);
      if (job) job.stop = true;
      return respond(res,202,take);
    }
    if (req.method==='GET' && ['video','comparison'].includes(action)) {
      if (!take[action]) return respond(res,404,{error:'Video is not available yet.'});
      const path = join(root,id,action==='video'?'stereo.mp4':'stereo-depth-comparison.mp4');
      res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':(await fs.stat(path)).size});
      await pipeline(createReadStream(path),res);
      return;
    }
    if (req.method==='POST' && ['compare','export'].includes(action)) {
      const comparison = action==='compare';
      if (jobs.has(id) || !take.pairs || (comparison && !take.calibration))
        return respond(res,409,{error:'Select a finished take with synchronized frames and the required calibration.'});
      const job = {take};
      jobs.set(id,job);
      take.status = comparison?'comparing':'saving';
      take.message = '';
      void render(take,comparison).then(()=>persist(take)).catch(console.error).finally(()=>jobs.delete(id));
      return respond(res,202,take);
    }
    return respond(res,405,{error:'Unsupported recording action.'});
  }

  return {handle,close() { for (const job of jobs.values()) job.stop = true; }};
}
module.exports = {stereoRecordings};
