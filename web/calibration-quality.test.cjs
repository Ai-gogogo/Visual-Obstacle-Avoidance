const test = require('node:test');
const assert = require('node:assert/strict');
const {RecordingCounts,poseFromBoards} = require('./calibration-quality.js');

function board(x) {
  return {size:[100,100],corners:[[x,10],[x+3,10],[x,13],[x+3,13]]};
}

test('requires both views, matching dimensions and shared coded faces',() => {
  const a = board(10), b = board(12);
  assert.equal(poseFromBoards([a,{...b,corners:[]}],'single'),null);
  assert.equal(poseFromBoards([a,{...b,size:[200,100]}],'single'),null);
  const coded = {...a,ids:[1,2,3,4],faces:['front']};
  assert.equal(poseFromBoards([coded,coded],'three'),null);
});

test('counts a held pose once despite repeated images or reversed corner ordering',() => {
  const counts = new RecordingCounts('single');
  const a = board(10), b = board(12);
  const pose = poseFromBoards([a,b],'single');
  const reverse = poseFromBoards([a,{...b,corners:b.corners.toReversed()}],'single');
  const moved = poseFromBoards([board(20),board(22)],'single');
  [pose,reverse,pose,reverse,moved,moved].forEach((p,i) => counts.observe(p,i+1,i*400));
  counts.observe(null,7,2400);
  assert.equal(counts.checked,7);
  assert.equal(counts.valid,6);
  assert.equal(counts.poses.length,2);
});

test('missing, invalid or distant frames interrupt a steady hold',() => {
  const counts = new RecordingCounts('single');
  const pose = poseFromBoards([board(10),board(12)],'single');
  counts.observe(pose,1,0);
  counts.observe(pose,3,320);
  counts.observe(null,4,420);
  counts.observe(pose,5,620);
  counts.observe(pose,6,2700);
  assert.equal(counts.poses.length,0);
  counts.observe(pose,7,3100);
  assert.equal(counts.poses.length,1);
});

test('recording target considers valid pairs, steady poses and all three faces',() => {
  const counts = new RecordingCounts('three');
  for (let i=0;i<20;i++) {
    const pose = poseFromBoards([board(i*5),board(i*5+1)],'single');
    Object.assign(pose,{mode:'three',faces:['front','right']});
    for (let j=0;j<3;j++) counts.observe(pose,3*i+j+1,1000*i+200*j);
  }
  assert.equal(counts.poses.length,20);
  assert.equal(counts.valid,60);
  assert.equal(counts.ready,false);
  const top = {...counts.poses[0],faces:['front','top']};
  counts.observe(top,61,21000);
  counts.observe(top,62,21400);
  assert.equal(counts.ready,true);
});

test('each new steady pose counts past the suggested target', () => {
  const counts = new RecordingCounts('single');
  let frame = 0;
  for (let i = 0; i < 25; i++) {
    const pose = poseFromBoards([board((i % 5) * 10), board(Math.floor(i / 5) * 10)], 'single');
    for (let j = 0; j < 3; j++) {
      frame++;
      counts.observe(pose, frame, frame * 400);
    }
    assert.equal(counts.poses.length, i + 1);
    assert.equal(counts.ready, i >= 19);
  }
  counts.observe(counts.poses[0], ++frame, frame * 400);
  counts.observe(counts.poses[0], ++frame, frame * 400);
  assert.equal(counts.poses.length, 25);
});
