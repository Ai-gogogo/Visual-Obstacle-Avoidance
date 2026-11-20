const {MAX_FRAME_AGE} = require('./agent.cjs');

// As in cv/tracking.py and cv/risk.py, two observations must fall within 1.2 s.
const MAX_GAP_MS = 1200;

// Run on accepted Camera A frames only. The alert latch belongs to this phone pairing.
function acceptRoadEdge(slot, raw, stamp, rightStream, paired) {
  if (!raw || !['unseen','visual','hold','clear','caution','urgent'].includes(raw.level)) {
    delete slot.roadState;
    return;
  }
  const level = raw.level;
  const edge = {level};
  if (level !== 'unseen') {
    if (!Array.isArray(raw.point) || raw.point.length !== 2 ||
        !raw.point.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return;
    edge.point = raw.point;
    if (level !== 'visual') {
      // A replaced or expired B frame cannot supply a metric road observation.
      if (!paired || !Number.isFinite(raw.distance_m) || raw.distance_m <= 0) {
        delete slot.roadState;
        return;
      }
      edge.distance_m = raw.distance_m;
    }
  }
  slot.detection.road_edge = edge;
  let state = slot.roadState;
  if (!state || state.right !== rightStream || stamp-state.last > MAX_FRAME_AGE) {
    state = slot.roadState = {right:rightStream, announced:0};
  }
  const consecutive = stamp > state.last && stamp-state.last <= MAX_GAP_MS;
  if (state.level !== level || !consecutive) {
    state.since = stamp;
    state.count = 0;
  }
  state.last = stamp;
  state.level = level;
  state.count++;
  state.closeCount = (level === 'urgent' || level === 'caution')
    ? (consecutive ? state.closeCount : 0) + 1 : 0;
  if ((level === 'clear' || level === 'unseen') && state.count >= 2 && stamp-state.since >= 1000) {
    state.announced = 0;
  }
  let rank = 0;
  if (level === 'urgent' && state.count >= 2) rank = 3;
  else if (state.closeCount >= 2) rank = 2;
  else if (level === 'visual' && state.count >= 2) rank = 1;
  if (rank <= state.announced) return;
  state.announced = rank;
  const meters = edge.distance_m?.toFixed(1);
  return {
    kind:'road_edge', camera_id:'A', risk:rank === 3 ? 'urgent' : 'caution', stamp,
    text:meters ? 'Caution. Road edge about '+meters+' meters ahead.' : 'Caution. There may be a road ahead.',
    text_zh:meters ? '小心，前方约'+meters+'米是车行道边缘。' : '请小心，前方可能是车行道。'
  };
}

module.exports = {acceptRoadEdge};
