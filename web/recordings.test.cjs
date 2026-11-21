const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {once} = require('node:events');
const {createServer} = require('./server.cjs');

test('saved stereo takes contain unique time-matched original frames and survive a dropped phone', async t => {
  const root = await fs.mkdtemp(join(tmpdir(),'visionassist-takes-'));
  const server = createServer({recordingRoot:root,agent:{filename:':memory:'}});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root,{recursive:true,force:true});
  });
  const base = 'http://127.0.0.1:'+server.address().port;
  async function call(path,method='GET',token,body,extra={}) {
    return fetch(base+path,{method,body,headers:{...(token && {Authorization:'Bearer '+token}),...extra}});
  }
  const desk = (await (await call('/api/session','POST')).json()).token;
  const api = '/api/recordings';
  assert.equal((await call(api)).status,401);
  assert.equal((await call(api+'/start','POST',desk)).status,409);
  const tokens = {};
  for (const side of ['A','B']) {
    const invitation = await (await call('/api/pair/'+side,'POST',desk)).json();
    tokens[side] = (await (await call('/api/join','POST',null,JSON.stringify({code:invitation.code}))).json()).token;
  }
  const original = await fs.readFile(join(__dirname,'../cv/examples/bus/annotated.jpg'));
  async function push(side,stamp) {
    const r = await call('/api/frame','PUT',tokens[side],original,{'Content-Type':'image/jpeg',
      'X-Sample-Ms':String(stamp),'X-Clock-Error-Ms':'2'});
    assert.equal(r.status,204);
  }
  const start = Date.now();
  await push('A',start-170); await push('B',start);
  const created = await call(api+'/start','POST',desk);
  assert.equal(created.status,201);
  const {id} = await created.json();
  assert.equal((await call(api,'GET',tokens.A)).status,401);
  assert.equal((await call(api+'/start','POST',desk)).status,409);
  async function state() {
    return (await (await call(api,'GET',desk)).json()).takes.find(take => take.id===id);
  }
  async function until(predicate) {
    for (let i=0;i<100;i++) {
      const take = await state();
      if (predicate(take)) return take;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.fail('Timed out waiting for recorder');
  }
  assert.equal((await state()).pairs,0);
  const stamp = Date.now();
  await push('B',stamp); await push('A',stamp+8);
  await until(take => take.pairs===1);
  await push('A',stamp+12);
  await new Promise(r=>setTimeout(r,120));
  assert.equal((await state()).pairs,1);
  await call('/api/frame','DELETE',tokens.B);
  await until(take => !['recording','saving'].includes(take.status));
  assert.deepEqual(await fs.readFile(join(root,id,'0000-A.jpg')),original);
  assert.deepEqual(await fs.readFile(join(root,id,'0000-B.jpg')),original);
  const rows = (await fs.readFile(join(root,id,'timestamps.csv'),'utf8')).trim().split('\n');
  assert.equal(rows.length,2);
  const cols = Object.fromEntries(rows[0].split(',').map((key,i)=>[key,rows[1].split(',')[i]]));
  assert.equal(Number(cols.skew_bound_ms),12);
  assert.equal(Number(cols.a_sample_ms),stamp+8);
  const newDesk = (await (await call('/api/session','POST')).json()).token;
  const library = await (await call(api,'GET',newDesk)).json();
  assert.ok(library.takes.some(take=>take.id===id && take.pairs===1));
});
