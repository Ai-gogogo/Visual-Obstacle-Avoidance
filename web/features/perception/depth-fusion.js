const minMeasuredGray = 32;
const maxInterquartileRange = 24;
const maxSceneLagMs = 1500;

export function sceneDeadline(scene) {
  return Math.min(scene.expiresAt, scene.timestamp + maxSceneLagMs);
}

export function segmentationSync(depth, scene, now) {
  if (!depth) return {reason: 'Waiting for stereo depth.'};
  if (!Number.isFinite(depth.expiresAt) || now >= depth.expiresAt) return {reason: 'Stereo depth expired.'};
  if (!scene) return {reason: 'Waiting for segmentation.'};
  const deadline = sceneDeadline(scene);
  if (!Number.isFinite(deadline) || now >= deadline) return {reason: 'Segmentation stale.'};
  const lag = depth.id && depth.id === scene.id ? 0 : depth.timestamp - scene.timestamp;
  if (!Number.isFinite(lag) || Math.abs(lag) > maxSceneLagMs) {
    return {reason: 'Depth and segmentation out of sync.'};
  }
  return {lag};
}

function alignLabels(scene, width, height) {
  const labels = new Uint8Array(width * height);
  const columns = Int32Array.from({length: width}, (_, x) => Math.floor((x + 0.5) * scene.width / width));
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y + 0.5) * scene.height / height) * scene.width;
    for (let x = 0; x < width; x++) labels[y * width + x] = scene.labels[row + columns[x]];
  }
  return labels;
}

function quantile(histogram, count, fraction) {
  const rank = (count - 1) * fraction;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  let seen = 0;
  let low = -1;
  for (let gray = minMeasuredGray; gray < histogram.length; gray++) {
    seen += histogram[gray];
    if (low === -1 && seen > lower) low = gray;
    if (seen > upper) return low + (gray - low) * (rank - lower);
  }
}

export function fuseDepth(gray, width, height, scene) {
  const result = {depth: gray, filled: null, boundary: null, filledCount: 0};
  if (!scene) return result;

  const depth = result.depth = gray.slice();
  const filled = result.filled = new Uint8Array(gray.length);
  const boundary = result.boundary = new Uint8Array(gray.length);
  const labels = alignLabels(scene, width, height);
  const visited = new Uint8Array(gray.length);
  const queue = new Int32Array(gray.length);
  const histogram = new Uint32Array(256);

  // Mark only the right/bottom side of each boundary, keeping the contour one pixel thick.
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label >= 150) continue;
    const left = i % width ? labels[i - 1] : label;
    const above = i >= width ? labels[i - width] : label;
    boundary[i] = (left < 150 && left !== label) || (above < 150 && above !== label);
  }

  let tail = 0;
  function enqueue(index, label) {
    if (labels[index] === label && !visited[index]) {
      visited[index] = 1;
      queue[tail++] = index;
    }
  }

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label >= 150 || visited[i]) continue;
    histogram.fill(0);
    let measured = 0;
    let holes = 0;
    tail = 0;
    enqueue(i, label);
    for (let head = 0; head < tail; head++) {
      const index = queue[head];
      const value = gray[index];
      if (value >= minMeasuredGray) {
        histogram[value]++;
        measured++;
      } else if (value === 0) {
        holes++;
      }
      const x = index % width;
      if (x > 0) enqueue(index - 1, label);
      if (x + 1 < width) enqueue(index + 1, label);
      if (index >= width) enqueue(index - width, label);
      if (index + width < gray.length) enqueue(index + width, label);
    }
    if (!holes || measured < 16 || measured * 100 < tail * 15) continue;
    if (quantile(histogram, measured, 0.75) - quantile(histogram, measured, 0.25) > maxInterquartileRange) continue;
    const median = Math.round(quantile(histogram, measured, 0.5));
    for (let pixel = 0; pixel < tail; pixel++) {
      const index = queue[pixel];
      if (gray[index] !== 0) continue;
      depth[index] = median;
      filled[index] = 1;
    }
    result.filledCount += holes;
  }
  return result;
}

export function paintFusedDepth({depth, filled, boundary}, rgba, palette) {
  for (let i = 0; i < depth.length; i++) {
    const gray = depth[i];
    const color = gray * 3;
    const target = i * 4;
    const brightness = (filled?.[i] ? 0.7 : 1) * (boundary?.[i] ? 0.82 : 1);
    rgba[target] = (palette ? palette[color] : gray) * brightness;
    rgba[target + 1] = (palette ? palette[color + 1] : gray) * brightness;
    rgba[target + 2] = (palette ? palette[color + 2] : gray) * brightness;
    rgba[target + 3] = 255;
  }
}
