// Count distinct steady poses from the normalized corners of recorded stereo frames.
const calibrationQuality = (() => {
  function similar(pose, prior, tolerance = .034) {
    // Three-face detections can contain different subsets of the numbered corners.
    const previous = new Map(prior.ids.map((id,i) => [id,i]));
    const common = pose.ids.flatMap((id,i) => previous.has(id) ? [[i,previous.get(id)]] : []);
    if (common.length < .7*Math.max(pose.ids.length,prior.ids.length)) return false;
    return pose.points.every((points, side) => {
      const other = prior.points[side];
      const distance = reverse => common.reduce((sum,[i,j]) => {
        const [x,y] = points[i];
        const [u,v] = other[reverse ? other.length-1-j : j];
        return sum + (x-u)**2 + (y-v)**2;
      },0) / common.length;
      return distance(false) < tolerance**2 || (pose.mode === 'single' && distance(true) < tolerance**2);
    });
  }

  function poseFromBoards(boards, mode) {
    if (!boards.every(b => b.corners.length) || String(boards[0].size) !== String(boards[1].size)) return null;
    if (mode === 'three' && boards[0].faces.length < 2) return null;
    return {
      mode, faces: boards[0].faces || [],
      ids: boards[0].ids ?? boards[0].corners.map((_,i) => i),
      points: boards.map(b => b.corners.map(pt => pt.map(x => x/Math.max(...b.size))))
    };
  }

  class RecordingCounts {
    constructor(mode) {
      this.mode = mode;
      this.checked = 0;
      this.valid = 0;
      this.poses = [];
      this.faces = new Set();
    }

    observe(pose, frame, ms, maxGapMs = 1000) {
      this.checked++;
      if (frame !== this.lastFrame + 1 || ms <= this.lastMs || ms - this.lastMs > maxGapMs) this.anchor = null;
      this.lastFrame = frame;
      this.lastMs = ms;
      if (!pose) {
        this.anchor = null;
        return;
      }
      this.valid++;
      if (!this.anchor || !similar(pose, this.anchor.pose, .01)) {
        this.anchor = {pose, ms, counted:false};
        return;
      }
      if (this.anchor.counted || ms - this.anchor.ms < 300) return;
      this.anchor.counted = true;
      pose.faces.forEach(face => this.faces.add(face));
      if (!this.poses.some(prior => similar(pose, prior))) this.poses.push(pose);
    }

    get ready() {
      return this.valid >= 60 && this.poses.length >= 20 && (this.mode === 'single' || this.faces.size === 3);
    }
  }

  return {similar, poseFromBoards, RecordingCounts};
})();
if (typeof module !== 'undefined') module.exports = calibrationQuality;
