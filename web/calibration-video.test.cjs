const test = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {mkdtemp, readFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join, basename} = require('node:path');
const {createServer} = require('./server.cjs');

test('deleting a saved take is scoped to the session, mode and exact recording', async t => {
  const root = await mkdtemp(join(tmpdir(),'calibration-test-'));
  const server = createServer({calibrationVideoRoot:root});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root,{recursive:true,force:true});
  });
  const base = 'http://127.0.0.1:'+server.address().port;
  const session = async () => (await (await fetch(base+'/api/session',{method:'POST'})).json()).token;
  const owner = await session(), other = await session();
  const call = (method, token, mode, body) => fetch(base+'/api/calibration/video',{
    method, headers:{Authorization:'Bearer '+token,'X-Calibration-Mode':mode,
      'Content-Type':method === 'POST' ? 'video/webm' : 'application/json'}, body
  });
  const remove = (token,mode,name) => call('DELETE',token,mode,JSON.stringify({name}));
  assert.equal((await remove(owner,'single','../bad')).status,400);
  const save = async (mode, byte) => {
    const bytes = Buffer.from([0x1a,0x45,0xdf,0xa3,byte]);
    const res = await call('POST',owner,mode,bytes);
    assert.equal(res.status,201);
    const {file} = await res.json();
    return {path:join(root,file.split('/').slice(-3).join('/')), name:basename(file), bytes};
  };
  const bad = await save('single',1), good = await save('single',2), three = await save('three',1);
  const list = async (token,mode) => {
    const res = await call('GET',token,mode);
    assert.equal(res.status,200);
    return (await res.json()).recordings.map(take => take.name);
  };
  assert.deepEqual(new Set(await list(owner,'single')),new Set([bad.name,good.name]));
  assert.deepEqual(await list(other,'single'),[]);
  await remove(other,'single',bad.name);
  assert.deepEqual(await readFile(bad.path),bad.bytes);
  assert.equal((await remove(owner,'single',bad.name)).status,204);
  assert.equal((await remove(owner,'single',bad.name)).status,204);
  await assert.rejects(readFile(bad.path),{code:'ENOENT'});
  assert.deepEqual(await list(owner,'single'),[good.name]);
  for (const kept of [good,three]) assert.deepEqual(await readFile(kept.path),kept.bytes);
});
