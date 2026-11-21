const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

test('the production frontend and device API share one origin', {timeout:25_000}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'visionassist-next-'));
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: __dirname,
    env: {...process.env, VISIONASSIST_PORT:'0', VISIONASSIST_DB:join(directory,'test.sqlite'), NEXT_TELEMETRY_DISABLED:'1'},
    stdio: ['ignore','pipe','pipe'],
  });
  const exited = once(child,'exit');
  t.after(async () => {
    child.kill();
    await exited;
    rmSync(directory,{recursive:true,force:true});
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const base = await new Promise((resolve,reject) => {
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/Desktop: http:\/\/localhost:(\d+)\//);
      if (match) resolve('http://127.0.0.1:' + match[1]);
    });
    child.once('error',reject);
    child.once('exit',() => reject(new Error('Frontend failed to start. ' + stderr)));
  });
  const call = (path, options) => fetch(base + path,options);
  const monitor = await call('/');
  assert.equal(monitor.status,200);
  const html = await monitor.text();
  assert.match(html,/Live perception/);
  assert.match(html,/Voice assistant/);
  assert.match(html,/Reduce motion/);
  assert.match(html,/Stereo calibration/);
  assert.match(html,/Depth algorithm/);
  assert.match(html,/RAFT-Stereo/);
  assert.match(html,/Record A \+ B/);
  assert.match(html,/Generate depth comparison/);
  assert.match(html,/Code for Camera A/);
  assert.match(html,/Code for Camera B/);
  const stylesheet = /<link[^>]+href="([^"]+\.css)"[^>]*>/.exec(html);
  assert.ok(stylesheet,'The server rendered a stylesheet link');
  assert.equal((await call(stylesheet[1])).status,200);
  const camera = await call('/camera');
  assert.equal(camera.status,200);
  assert.ok(Number(camera.headers.get('x-server-ms')) > 0,'Phone clock synchronization header is present');
  const phone = await camera.text();
  assert.match(phone,/Enter pairing code/);
  assert.match(phone,/lossless PNG/);
  assert.ok(!phone.includes('Live perception'));
  assert.equal((await call('/camera.html',{redirect:'manual'})).headers.get('location'),'/camera');
  assert.equal((await call('/demo-lab.webp')).headers.get('content-type'),'image/webp');
  assert.match(await (await call('/voice-capture.js')).text(),/registerProcessor\('voice-capture'/);

  const session = await call('/api/session',{method:'POST',headers:{Origin:base}});
  assert.equal(session.status,201);
  assert.equal(session.headers.get('cache-control'),'no-store');
  const {token} = await session.json();
  const pair = await call('/api/pair/A',{method:'POST',headers:{Origin:base,Authorization:'Bearer '+token}});
  assert.equal(pair.status,201);
  assert.match((await pair.json()).code,/^\d{6}$/);
});
