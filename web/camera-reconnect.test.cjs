const test = require('node:test');
const assert = require('node:assert/strict');

for (const format of ['png','jpeg']) {
  test(format + ' camera resumes with fresh frames and the same pairing after interruptions', async t => {
    const {createCameraUpload} = await import('./features/camera/camera-upload.js');
    let next, timer, clockFailure, failure, state;
    let puts = 0, stops = 0, deletes = 0, captures = 0, joins = 0, clockChecks = 0;
    const video = {videoWidth:1080, videoHeight:1920, readyState:2, play:async () => {},
      requestVideoFrameCallback(fn) { next = fn; }};
    const track = {label:'Ultra wide', getSettings:() => ({}), addEventListener(){}, stop(){ stops++; }};
    const stream = {getVideoTracks:() => [track], getTracks:() => [track]};
    const canvas = {
      getContext:() => ({drawImage(){ captures++; }}),
      toBlob:(done,type) => done({size:100,type, capture:captures})
    };
    function install(target, key, value) {
      const old = Object.getOwnPropertyDescriptor(target,key);
      Object.defineProperty(target,key,{configurable:true, value});
      t.after(() => old ? Object.defineProperty(target,key,old) : delete target[key]);
    }
    install(globalThis,'document',{createElement:() => canvas});
    install(navigator,'mediaDevices',{getUserMedia:async () => stream});
    install(globalThis,'setTimeout',(fn,ms) => { timer = {fn,ms}; return timer; });
    install(globalThis,'clearTimeout',() => { timer = null; });
    install(globalThis,'fetch',async (url,options) => {
      if (url === '/api/join') {
        joins++;
        return Response.json({token:'phone'});
      }
      if (url === '/camera') {
        clockChecks++;
        if (clockFailure) throw new DOMException('Clock timeout','TimeoutError');
        return new Response(null,{headers:{'X-Server-Ms':String(Date.now())}});
      }
      assert.equal(options.headers.Authorization,'Bearer phone');
      if (options.method === 'DELETE') {
        deletes++;
        return new Response(null,{status:204});
      }
      puts++;
      assert.equal(options.headers['Content-Type'],'image/'+format);
      assert.equal(options.body.capture,puts);
      if (failure === 'network') throw new TypeError('Failed to fetch');
      if (failure === 'timeout') throw new DOMException('Upload timeout','TimeoutError');
      return failure ? Response.json({error:'Pair again.'},{status:failure}) : new Response(null,{status:204});
    });
    const upload = createCameraUpload(video, nextState => { state = nextState; });
    await upload.start('123456',format);
    async function capture(result) {
      failure = result;
      if (timer) { timer.fn(); timer = null; }
      await next(0,{presentationTime:performance.now()});
    }
    upload.networkLost();
    assert.equal(state.phase,'connected');
    for (const [response, expectedDelay] of [['timeout',500],['network',1000],[408,2000],[429,4000],[503,5000]]) {
      await capture(response);
      assert.equal(timer.ms,expectedDelay);
      assert.match(state.lens,/Retrying/);
      assert.equal(video.srcObject,stream);
      assert.equal(stops,0);
      assert.equal(deletes,0);
    }
    if (format === 'png') {
      clockFailure = true;
      await capture(null);
      assert.match(state.lens,/clock check interrupted/);
      assert.equal(timer.ms,5000);
      clockFailure = false;
    }
    await capture(null);
    assert.match(state.lens,format === 'png' ? /1080 × 1920 px lossless PNG/ : /360 × 640 px JPEG upload/);
    assert.equal(clockChecks,format === 'png' ? 2 : 0);
    assert.equal(joins,1);
    await capture(503);
    assert.equal(timer.ms,500);
    await capture(401);
    assert.equal(stops,1);
    assert.equal(deletes,1);
    assert.equal(state.phase,'idle');
    assert.equal(state.message,'Pair again.');
    assert.equal(video.srcObject,null);
    assert.equal(timer,null);
  });
}
