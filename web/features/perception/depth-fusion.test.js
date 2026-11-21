import assert from 'node:assert/strict';
import test from 'node:test';
import { fuseDepth, paintFusedDepth, segmentationSync } from './depth-fusion.js';

test('fills a supported region with the measured median after nearest-neighbor alignment', () => {
  const gray = new Uint8Array(64);
  gray.fill(80, 0, 8);
  gray.fill(100, 8, 16);
  gray[16] = 16;
  const result = fuseDepth(gray, 8, 8, {labels: Uint8Array.of(3), width: 1, height: 1});
  assert.equal(result.filledCount, 47);
  assert.equal(result.depth[15], 100);
  assert.equal(result.depth[16], 16);
  assert.equal(result.depth[17], 90);
  assert.equal(result.filled[17], 1);
  assert.equal(gray[17], 0);
});

test('keeps separate same-class regions independent and draws a one-pixel semantic boundary', () => {
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
  assert.deepEqual([...result.boundary.slice(0, 16)], [0,0,0,0,1,0,0,0,1,0,0,0,0,0,0,0]);
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

test('uses the selected color for measurements and 70% brightness for fills', () => {
  const gray = new Uint8Array(64).fill(100, 0, 16);
  const result = fuseDepth(gray, 8, 8, {labels: Uint8Array.of(3), width: 1, height: 1});
  const rgba = new Uint8ClampedArray(64 * 4);
  paintFusedDepth(result, rgba);
  assert.deepEqual([...rgba.slice(0, 4)], [100, 100, 100, 255]);
  assert.deepEqual([...rgba.slice(64, 68)], [70, 70, 70, 255]);

  const palette = new Uint8ClampedArray(256 * 3);
  palette.set([200, 50, 110], 300);
  paintFusedDepth(result, rgba, palette);
  assert.deepEqual([...rgba.slice(0, 4)], [200, 50, 110, 255]);
  assert.deepEqual([...rgba.slice(64, 68)], [140, 35, 77, 255]);
});

test('missing, stale or out-of-sync inputs stop filling', () => {
  const depth = {timestamp: 10_000, expiresAt: 13_000};
  const scene = {timestamp: 9_700, expiresAt: 12_500};
  assert.deepEqual(segmentationSync(depth, scene, 10_100), {lag: 300});
  assert.deepEqual(segmentationSync({...depth, id: 'a'}, {...scene, id: 'a'}, 10_100), {lag: 0});
  assert.deepEqual(segmentationSync(depth, {...scene, timestamp: 10_300}, 10_400), {lag: -300});
  assert.equal(segmentationSync(depth, scene, 11_200).reason, 'Segmentation stale.');
  assert.equal(segmentationSync(depth, {...scene, expiresAt: 10_075}, 10_100).reason, 'Segmentation stale.');
  assert.equal(segmentationSync(depth, null, 10_100).reason, 'Waiting for segmentation.');
  assert.equal(segmentationSync(null, scene, 10_100).reason, 'Waiting for stereo depth.');
  assert.equal(segmentationSync(depth, scene, 13_000).reason, 'Stereo depth expired.');
  assert.equal(segmentationSync({...depth, timestamp: 8_000}, scene, 10_100).reason, 'Depth and segmentation out of sync.');
  const gray = new Uint8Array(64).fill(100, 0, 16);
  const result = fuseDepth(gray, 8, 8, null);
  assert.equal(result.filledCount, 0);
  assert.equal(result.depth[16], 0);
});
