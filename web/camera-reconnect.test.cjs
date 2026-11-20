const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const script = readFileSync(join(__dirname,'camera.js'),'utf8');

test('phone keeps the same camera and pairing through upload and clock failures', async () => {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id,{addEventListener(type,fn){ this[type]=fn; }});
    return nodes.get(id);
  }
  let next, timer, failure, clockFailure, putCount = 0, stops = 0, deletes = 0;
  const video = Object.assign(node('#local-camera'),{videoWidth:1080,videoHeight:1920,readyState:2,
    play:async()=>{},requestVideoFrameCallback:fn=>{next=fn;}});
  const track = {label:'Ultra wide',getSettings:()=>({}),addEventListener(){},stop(){stops++;}};
  const stream = {getVideoTracks:()=>[track],getTracks:()=>[track]};
  const canvas = {getContext:()=>({drawImage(){}}),toBlob:(done,type)=>done({size:100,type})};
  const context = {document:{querySelector:node,createElement:()=>canvas},window:{addEventListener(){}},
    location:{hash:'',protocol:'https:'},URLSearchParams,performance:{now:()=>70000},AbortSignal,
    navigator:{mediaDevices:{getUserMedia:async()=>stream}},setTimeout(fn){timer=fn;},clearTimeout(){},
    fetch:async(url,options)=>{
      if(url==='/api/join') return Response.json({token:'phone'});
      if(url==='/camera'){
        if(clockFailure) throw new DOMException('Clock timeout','TimeoutError');
        return new Response(null,{headers:{'X-Server-Ms':String(Date.now())}});
      }
      if(options.method==='DELETE'){deletes++;return new Response(null,{status:204});}
      assert.equal(options.headers.Authorization,'Bearer phone');
      putCount++;
      if(failure==='network') throw new TypeError('Failed to fetch');
      if(failure==='timeout') throw new DOMException('Upload timeout','TimeoutError');
      return failure ? Response.json({error:'Pair again.'},{status:failure}) : new Response(null,{status:204});
    }};
  vm.runInNewContext(script,context);
  node('#code').value='123456'; node('#camera-quality').value='png';
  await node('#phone-form').submit({preventDefault(){}});
  for(const result of ['timeout','network',503,null,null]){
    failure=result;
    if(timer){timer();timer=null;}
    clockFailure=putCount===3;
    await next(0,{presentationTime:70000});
    assert.equal(stops,0);
    assert.equal(deletes,0);
    assert.equal(video.srcObject,stream);
    assert.equal(typeof timer,'function');
  }
  assert.equal(putCount,5);
  failure=401;
  timer(); await next(0,{presentationTime:70000});
  assert.equal(stops,1); assert.equal(node('#phone-pair').hidden,false);
});
