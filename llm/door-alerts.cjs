const CONFIRM_GAP_MS = 1200;
const SPEECH_MAX_AGE_MS = 1500;
const MAX_DISTANCE_M = 3;

function sameDoor(a, b) {
  const width = Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]));
  const height = Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
  const overlap = width*height;
  const area = box => (box[2]-box[0])*(box[3]-box[1]);
  return overlap >= .25*(area(a)+area(b)-overlap);
}

function acceptDoor(slot, observation, stamp, partnerStream) {
  const previous = slot.doorState;
  if (previous && stamp <= previous.stamp) return;
  const distance = partnerStream ? observation?.distance_m : undefined;
  if (!observation || distance > MAX_DISTANCE_M) {
    slot.doorState = {...previous,stamp,alertId:undefined};
    return;
  }

  const same = previous?.box && stamp-previous.seen <= CONFIRM_GAP_MS && sameDoor(previous.box,observation.bbox);
  const metric = distance !== undefined;
  const rank = metric ? 2 : 1;
  const consecutive = same && previous.stamp === previous.seen && previous.rank === rank &&
    previous.partnerStream === partnerStream &&
    (!metric || Math.abs(previous.distance-distance) <= Math.max(.25,.25*distance));
  const state = slot.doorState = {
    stamp, seen:stamp, box:observation.bbox, rank, distance, partnerStream,
    announced:same ? previous.announced : 0,
    alertId:consecutive ? previous.alertId : undefined
  };
  if (!consecutive || state.announced >= rank) return;
  state.announced = rank;
  const meters = metric ? ((previous.distance+distance)/2).toFixed(1) : null;
  return {
    kind:'door', camera_id:'A', risk:'caution', stamp, expires:stamp+SPEECH_MAX_AGE_MS,
    metric, partnerStream,
    text:metric ? 'Caution. There is a door about '+meters+' meters ahead.' : 'Caution. There may be a door ahead.',
    text_zh:metric ? '小心，前方约'+meters+'米有门。' : '请小心，前方可能有门。'
  };
}

module.exports = {acceptDoor, SPEECH_MAX_AGE_MS};
