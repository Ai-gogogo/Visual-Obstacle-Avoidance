import assert from 'node:assert/strict';
import test from 'node:test';
import { fuseDepth, paintFusedDepth, segmentationSync } from './depth-fusion.js';

test('reconstructs a continuous tilted surface and preserves original depths', () => {
  const width = 12, height = 12;
  const gray = Uint8Array.from({length:width*height}, (_, i) => {
    const x = i % width, y = Math.floor(i / width);
    return y < 3 || y >= 9 ? 75 + x + y : 0;
  });
  const result = fuseDepth(gray, width, height, {labels:Uint8Array.of(3), width:1, height:1});
  assert.equal(result.filledCount,72);
  for (let i = 0; i < gray.length; i++) {
    assert.equal(result.depth[i],75 + i % width + Math.floor(i / width));
  }
  assert.equal(gray[50],0);
});

test('clamps plane predictions and falls back to the measured median for singular or noisy fits', () => {
  const scene = {labels:Uint8Array.of(3), width:1, height:1};
  const slope = Uint8Array.from({length:64}, (_,i) => i < 24 ? 80 + 2*Math.floor(i / 8) : 0);
  assert.equal(fuseDepth(slope,8,8,scene).depth[63],84);
  const line = Uint8Array.from({length:64}, (_,i) => i < 16 ? 80 + i : 0);
  assert.equal(fuseDepth(line,16,4,scene).depth[63],88);
  const noisy = Uint8Array.from({length:64}, (_,i) => i < 32 ? (i + Math.floor(i / 8)) % 2 ? 105 : 85 : 0);
  assert.equal(fuseDepth(noisy,8,8,scene).depth[63],95);
});

test('measured depth supports uncertain labels only when nearby measured labels agree', () => {
  const labels = Uint8Array.of(
    1, 1, 1, 1, 2,
    1, 255, 1, 255, 2,
    1, 1, 1, 255, 2
  );
  const gray = new Uint8Array(labels.length).fill(80);
  gray[13] = 0;
  const result = fuseDepth(gray, 5, 3, {labels, width: 5, height: 3});
  assert.equal(result.labelFillCount, 1);
  assert.equal(result.labels[6], 1);
  assert.equal(result.labels[8], 255);
  assert.equal(result.labels[13], 255);
  assert.equal(result.depth[6], 80);
  assert.equal(labels[6], 255);

  gray[9] = gray[14] = 140;
  const acrossEdge = fuseDepth(gray, 5, 3, {labels, width: 5, height: 3});
  assert.equal(acrossEdge.labels[8], 1);
  assert.equal(acrossEdge.boundary[9], 1);
});

test('keeps separate same-class regions independent without outlining unknown depth', () => {
  const gray = new Uint8Array(16 * 8);
  for (let y = 0; y < 8; y++) {
    gray.fill(60, y * 16, y * 16 + 2);
    gray.fill(200, y * 16 + 14, y * 16 + 16);
  }
  const result = fuseDepth(gray, 16, 8, {labels: Uint8Array.of(1, 2, 1, 255), width: 4, height: 1});
  // Put the right wall's support inside its own nearest-neighbor label.
  assert.equal(result.depth[3], 60);
  assert.equal(result.depth[7], 0);
  assert.equal(result.depth[8], 0);
  assert.equal(result.depth[13], 0);
  assert.equal(result.boundary.includes(1),false);
  for (let y = 0; y < 8; y++) gray.fill(200, y * 16 + 10, y * 16 + 12);
  const supported = fuseDepth(gray, 16, 8, {labels: Uint8Array.of(1, 2, 1, 255), width: 4, height: 1});
  assert.equal(supported.depth[3], 60);
  assert.equal(supported.depth[9], 200);
  assert.equal(supported.depth[13], 0);
});

test('does not join same-class pixels that only touch diagonally', () => {
  const gray = new Uint8Array(64);
  for (let y = 0; y < 4; y++) gray.fill(70, y * 8, y * 8 + 4);
  const result = fuseDepth(gray, 8, 8, {labels: Uint8Array.of(1, 255, 255, 1), width: 2, height: 2});
  assert.equal(result.depth[63], 0);
});

test('leaves unsupported or depth-mixed regions black', () => {
  for (const [side, count, mixed] of [[8, 0, false], [8, 15, false], [11, 16, false], [8, 16, true]]) {
    const gray = new Uint8Array(side * side);
    gray.fill(100, 0, count);
    if (mixed) gray.fill(200, count / 2, count);
    const result = fuseDepth(gray, side, side, {labels: Uint8Array.of(149), width: 1, height: 1});
    assert.equal(result.filledCount, 0);
    assert.equal(result.depth.at(-1), 0);
  }
});

test('uses the selected color for measurements and 86% brightness for fills', () => {
  const gray = new Uint8Array(64).fill(100, 0, 16);
  const result = fuseDepth(gray, 8, 8, {labels: Uint8Array.of(3), width: 1, height: 1});
  const rgba = new Uint8ClampedArray(64 * 4);
  paintFusedDepth(result, rgba);
  assert.deepEqual([...rgba.slice(0, 4)], [100, 100, 100, 255]);
  assert.deepEqual([...rgba.slice(64, 68)], [86, 86, 86, 255]);

  const palette = new Uint8ClampedArray(256 * 3);
  palette.set([200, 50, 110], 300);
  paintFusedDepth(result, rgba, palette);
  assert.deepEqual([...rgba.slice(0, 4)], [200, 50, 110, 255]);
  assert.deepEqual([...rgba.slice(64, 68)], [172, 43, 95, 255]);
});

test('missing, stale or out-of-sync inputs stop filling', () => {
  const depth = {timestamp: 10_000, expiresAt: 13_000};
  const scene = {timestamp: 9_700, expiresAt: 12_500};
  assert.equal(segmentationSync(depth, scene, 10_100).lag, 300);
  assert.equal(segmentationSync({...depth, id: 'a'}, {...scene, id: 'a'}, 10_100).lag, 0);
  assert.equal(segmentationSync(depth, {...scene, timestamp: 10_300}, 10_400).lag, -300);
  assert.equal(segmentationSync(depth, scene, 11_200).reason, 'Segmentation stale.');
  assert.equal(segmentationSync(depth, {...scene, expiresAt: 10_075}, 10_100).reason, 'Segmentation stale.');
  assert.equal(segmentationSync(depth, null, 10_100).reason, 'Waiting for segmentation.');
  assert.equal(segmentationSync(null, scene, 10_100).reason, 'Waiting for stereo depth.');
  assert.equal(segmentationSync(depth, scene, 13_000).reason, 'Stereo depth expired.');
  assert.equal(segmentationSync({...depth, timestamp: 8_700}, scene, 10_100).reason, 'Depth and segmentation out of sync.');
  const gray = new Uint8Array(64).fill(100, 0, 16);
  const result = fuseDepth(gray, 8, 8, null);
  assert.equal(result.filledCount, 0);
  assert.equal(result.depth[16], 0);
});

test('uses the buffered closest mask while the segmentation stream is fresh', () => {
  const depth = {id:'same', timestamp:9_000, expiresAt:12_000};
  const exact = {id:'same', timestamp:9_000, expiresAt:9_750};
  const close = {id:'close', timestamp:9_075, expiresAt:9_825};
  const newest = {id:'later', timestamp:10_000, expiresAt:10_750};
  assert.equal(segmentationSync(depth, newest, 10_100, [exact, close, newest]).scene, exact);
  assert.equal(segmentationSync(depth, newest, 10_100, [close, newest]).scene, close);
  assert.equal(segmentationSync(depth, newest, 10_100).reason, 'Depth and segmentation out of sync.');
  assert.equal(segmentationSync(depth, newest, 10_750, [exact, newest]).reason, 'Segmentation stale.');
  assert.equal(segmentationSync(depth, {...newest, expiresAt:11_000}, 10_500, [exact, newest]).reason, 'Depth and segmentation out of sync.');
});

test('propagates labels into a depth-continuous patch and fills an enclosed one-pixel hole', () => {
  const width = 9;
  const gray = new Uint8Array(width * width).fill(90);
  const labels = new Uint8Array(gray.length).fill(3);
  for (let y = 2; y <= 6; y++) labels.fill(255,y*width+2,y*width+7);
  const middle = 4*width+4;
  const scene = {labels, width, height:width};
  const restored = fuseDepth(gray,width,width,scene);
  assert.equal(restored.labels[middle],3);
  assert.equal(restored.labelFillCount,25);
  gray[middle] = 0;
  const withHole = fuseDepth(gray,width,width,scene);
  assert.equal(withHole.labels[middle],3);
  assert.equal(withHole.depth[middle],90);
  assert.equal(gray[middle],0);
});

test('draws a subtle one-pixel edge only at class changes with a depth jump', () => {
  const scene = {labels:Uint8Array.of(3,4,5), width:3, height:1};
  const result = fuseDepth(Uint8Array.of(100,105,150),3,1,scene);
  assert.deepEqual([...result.boundary],[0,0,1]);
  const rgba = new Uint8ClampedArray(12);
  paintFusedDepth(result,rgba);
  assert.deepEqual([rgba[0],rgba[4],rgba[8]],[100,105,135]);
});
