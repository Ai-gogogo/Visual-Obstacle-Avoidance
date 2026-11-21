const minMeasuredGray = 32;
const maxInterquartileRange = 24;
const maxSceneAgeMs = 1500;
const maxFrameSkewMs = 350;
const labelPropagationRounds = 5;
const maxPlaneRmse = 6;
const maxPlaneResidualIqr = 10;
const residualRoundoff = 1e-9;
const planeExtrapolation = 32;
// ADE20K wall, floor, ceiling, windowpane, door.
const planarLabels = new Set([0, 3, 5, 8, 14]);
const maxLabelDepthDifference = 12;

function sceneDeadline(scene) {
  return Math.min(scene.expiresAt, scene.timestamp + maxSceneAgeMs);
}

export function segmentationSync(depth, scene, now, history = []) {
  if (!depth) return {reason: 'Waiting for stereo depth.'};
  if (!Number.isFinite(depth.expiresAt) || now >= depth.expiresAt) return {reason: 'Stereo depth expired.'};
  if (!scene) return {reason: 'Waiting for segmentation.'};
  const deadline = sceneDeadline(scene);
  if (!Number.isFinite(deadline) || now >= deadline) return {reason: 'Segmentation stale.'};

  // A delayed depth result can match an earlier mask while Camera A still publishes fresh masks.
  let closest;
  let closestLag = Infinity;
  for (const candidate of [scene, ...history]) {
    if (!Number.isFinite(candidate.timestamp) || now >= candidate.timestamp + maxSceneAgeMs) continue;
    if (depth.id && depth.id === candidate.id) {
      closest = candidate;
      closestLag = 0;
      break;
    }
    const lag = depth.timestamp - candidate.timestamp;
    if (Math.abs(lag) < Math.abs(closestLag)) {
      closest = candidate;
      closestLag = lag;
    }
  }
  return Math.abs(closestLag) <= maxFrameSkewMs
    ? {scene:closest, lag:closestLag, deadline:Math.min(deadline, closest.timestamp + maxSceneAgeMs)}
    : {reason:'Depth and segmentation out of sync.'};
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

function selectRank(values, count, rank) {
  let lo = 0, hi = count - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >>> 1];
    let left = lo, right = hi;
    while (left <= right) {
      while (values[left] < pivot) left++;
      while (values[right] > pivot) right--;
      if (left > right) break;
      const value = values[left];
      values[left++] = values[right];
      values[right--] = value;
    }
    if (rank <= right) hi = right;
    else if (rank >= left) lo = left;
    else break;
  }
  return values[rank];
}

function residualQuantile(values, count, fraction) {
  const rank = (count - 1) * fraction;
  const lower = Math.floor(rank);
  const low = selectRank(values, count, lower);
  if (rank === lower) return low;
  return low + (selectRank(values, count, lower + 1) - low) * (rank - lower);
}

function visitNeighbors(index, width, length, visit) {
  const x = index % width;
  if (x > 0) visit(index - 1);
  if (x + 1 < width) visit(index + 1);
  if (index >= width) visit(index - width);
  if (index + width < length) visit(index + width);
}

function restoreLabels(labels, gray, width) {
  let current = labels;
  let next = labels.slice();
  let labelFillCount = 0;
  let value, agreedLabel, agreeing;
  function vote(neighbor) {
    const label = current[neighbor];
    const depth = gray[neighbor];
    if (label >= 150 || depth < minMeasuredGray || Math.abs(depth - value) > maxLabelDepthDifference) return;
    if (agreeing === 0) agreedLabel = label;
    agreeing++;
    if (agreedLabel !== label) agreedLabel = 255;
  }

  for (let round = 0; round < labelPropagationRounds; round++) {
    let changed = 0;
    for (let i = 0; i < labels.length; i++) {
      value = gray[i];
      if (current[i] !== 255 || value < minMeasuredGray) continue;
      agreeing = 0;
      visitNeighbors(i, width, labels.length, vote);
      if (agreeing < 2 || agreedLabel === 255) continue;
      next[i] = agreedLabel;
      changed++;
    }
    if (!changed) break;
    labelFillCount += changed;
    if (current === labels) current = next.slice();
    else current.set(next);
  }

  // A zero-depth pixel can borrow a label only when fully enclosed by agreeing measured neighbors.
  for (let i = width; i < labels.length - width; i++) {
    if (current[i] !== 255 || gray[i] !== 0 || i % width === 0 || i % width === width - 1) continue;
    const label = current[i - 1];
    if (label >= 150 || planarLabels.has(label) || current[i + 1] !== label || current[i - width] !== label || current[i + width] !== label) continue;
    const left = gray[i - 1], right = gray[i + 1], above = gray[i - width], below = gray[i + width];
    const min = Math.min(left, right, above, below);
    const max = Math.max(left, right, above, below);
    if (min < minMeasuredGray || max - min > maxLabelDepthDifference) continue;
    next[i] = label;
    labelFillCount++;
  }
  return {labels:next, labelFillCount};
}

function fillEnclosedUncertain(originalLabels, owners, planes, width, visited, region, fill) {
  // Follow original Uncertain connectivity; measured label propagation cannot close an open gap.
  let regionSize, owner;
  function visit(index) {
    if (originalLabels[index] === 255) {
      if (visited[index]) return;
      visited[index] = 1;
      region[regionSize++] = index;
    } else if (owner === undefined) {
      owner = owners[index];
    } else if (owners[index] !== owner) {
      owner = 0;
    }
  }

  for (let i = 0; i < originalLabels.length; i++) {
    if (originalLabels[i] !== 255 || visited[i]) continue;
    regionSize = 0;
    owner = undefined;
    visit(i);
    for (let head = 0; head < regionSize; head++) {
      const index = region[head];
      const x = index % width;
      if (x === 0 || x === width - 1 || index < width || index >= originalLabels.length - width) owner = 0;
      visitNeighbors(index, width, originalLabels.length, visit);
    }
    const plane = planes[owner];
    if (!plane || regionSize * 100 > plane.size * 15) continue;
    for (let pixel = 0; pixel < regionSize; pixel++) fill(region[pixel], plane);
  }
}

export function fuseDepth(gray, width, height, scene) {
  if (!scene) return {depth:gray, filled:null, boundary:null, filledCount:0, labelFillCount:0};

  const depth = new Uint8Array(gray);
  const filled = new Uint8Array(gray.length);
  const boundary = new Uint8Array(gray.length);
  const originalLabels = alignLabels(scene, width, height);
  let {labels, labelFillCount} = restoreLabels(originalLabels, gray, width);
  const owners = originalLabels.includes(255) ? new Int32Array(gray.length) : null;
  const planes = [null];
  const visited = new Uint8Array(gray.length);
  const region = new Int32Array(gray.length);
  const histogram = new Uint32Array(256);
  let filledCount = 0;
  let residuals;
  let label, planar, regionSize;
  function enqueue(index) {
    if (labels[index] !== label || visited[index] || (planar && originalLabels[index] !== label)) return;
    visited[index] = 1;
    region[regionSize++] = index;
  }

  for (let i = 0; i < labels.length; i++) {
    label = labels[i];
    if (label >= 150 || visited[i]) continue;
    planar = planarLabels.has(label);
    // A depth-propagated label cannot bridge two independently fitted planar regions.
    if (planar && originalLabels[i] !== label) continue;
    if (!planar) histogram.fill(0);
    let holes = 0, count = 0, min = 255, max = 0;
    let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, szz = 0;
    regionSize = 0;
    enqueue(i);
    for (let head = 0; head < regionSize; head++) {
      const index = region[head];
      const z = gray[index];
      if (z >= minMeasuredGray) {
        if (!planar) histogram[z]++;
        count++;
        min = Math.min(min, z);
        max = Math.max(max, z);
        const x = index % width, y = Math.floor(index / width);
        sx += x; sy += y; sz += z;
        sxx += x * x; syy += y * y; sxy += x * y;
        sxz += x * z; syz += y * z; szz += z * z;
      } else if (z === 0) {
        holes++;
      }
      visitNeighbors(index, width, gray.length, enqueue);
    }
    if ((!holes && !(planar && owners)) || count < 16 || count * 100 < regionSize * 15) continue;
    if (!planar && quantile(histogram, count, 0.75) - quantile(histogram, count, 0.25) > maxInterquartileRange) continue;

    // Centering eliminates the intercept from the 3×3 normal equations.
    const meanX = sx / count, meanY = sy / count, meanZ = sz / count;
    const xx = sxx - sx * meanX, yy = syy - sy * meanY, xy = sxy - sx * meanY;
    const xz = sxz - sx * meanZ, yz = syz - sy * meanZ, zz = szz - sz * meanZ;
    const determinant = xx * yy - xy * xy;
    let a = 0, b = 0, c = meanZ;
    if (determinant > 1e-6) {
      a = (xz * yy - yz * xy) / determinant;
      b = (yz * xx - xz * xy) / determinant;
      c = meanZ - a * meanX - b * meanY;
    }
    if (planar) {
      if (determinant <= 1e-6) continue;
      residuals ??= new Float64Array(gray.length);
      let offset = 0, squaredError = 0, smallest = Infinity, largest = -Infinity;
      for (let pixel = 0; pixel < regionSize; pixel++) {
        const index = region[pixel];
        if (gray[index] < minMeasuredGray) continue;
        const residual = gray[index] - (a * (index % width) + b * Math.floor(index / width) + c);
        residuals[offset++] = residual;
        squaredError += residual * residual;
        smallest = Math.min(smallest, residual);
        largest = Math.max(largest, residual);
      }
      if (squaredError / count > maxPlaneRmse ** 2 + residualRoundoff) continue;
      const iqrLimit = maxPlaneResidualIqr + residualRoundoff;
      if (largest - smallest > iqrLimit &&
          residualQuantile(residuals, count, 0.75) - residualQuantile(residuals, count, 0.25) > iqrLimit) continue;
      min = Math.max(minMeasuredGray, min - planeExtrapolation);
      max = Math.min(255, max + planeExtrapolation);
      if (owners) {
        const owner = planes.length;
        planes.push({a, b, c, min, max, label, size:regionSize});
        for (let pixel = 0; pixel < regionSize; pixel++) owners[region[pixel]] = owner;
      }
    } else if (determinant <= 1e-6 || (zz - a * xz - b * yz) / count > maxPlaneRmse ** 2) {
      a = b = 0;
      c = quantile(histogram, count, 0.5);
    }
    for (let pixel = 0; pixel < regionSize; pixel++) {
      const index = region[pixel];
      if (gray[index] !== 0) continue;
      const value = a * (index % width) + b * Math.floor(index / width) + c;
      depth[index] = Math.round(Math.min(max, Math.max(min, value)));
      filled[index] = 1;
    }
    filledCount += holes;
  }

  if (planes.length > 1) {
    visited.fill(0);
    fillEnclosedUncertain(originalLabels, owners, planes, width, visited, region, (index, plane) => {
      if (gray[index] !== 0 || filled[index]) return;
      const value = plane.a * (index % width) + plane.b * Math.floor(index / width) + plane.c;
      depth[index] = Math.round(Math.min(plane.max, Math.max(plane.min, value)));
      filled[index] = 1;
      labels[index] = plane.label;
      filledCount++;
      labelFillCount++;
    });
  }

  function hasEdge(index, neighbor) {
    return labels[neighbor] < 150 && labels[neighbor] !== labels[index] &&
      depth[neighbor] >= minMeasuredGray && Math.abs(depth[index] - depth[neighbor]) > maxLabelDepthDifference;
  }
  // Mark only the right/bottom side of a confirmed depth edge.
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] >= 150 || depth[i] < minMeasuredGray) continue;
    boundary[i] = (i % width !== 0 && hasEdge(i, i - 1)) || (i >= width && hasEdge(i, i - width));
  }
  return {depth, filled, boundary, filledCount, labels, labelFillCount};
}

export function paintFusedDepth({depth, filled, boundary}, rgba, palette) {
  for (let i = 0; i < depth.length; i++) {
    const gray = depth[i];
    const color = gray * 3;
    const target = i * 4;
    const brightness = (filled?.[i] ? 0.86 : 1) * (boundary?.[i] ? 0.90 : 1);
    rgba[target] = (palette ? palette[color] : gray) * brightness;
    rgba[target + 1] = (palette ? palette[color + 1] : gray) * brightness;
    rgba[target + 2] = (palette ? palette[color + 2] : gray) * brightness;
    rgba[target + 3] = 255;
  }
}
