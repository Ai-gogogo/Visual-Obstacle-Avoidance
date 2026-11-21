const CONFIRM_GAP_MS = 1200;
const SPEECH_MAX_AGE_MS = 1500;
const sceneAlerts = {
  door:{name_zh:'门', distance:3},
  wall:{name_zh:'墙', distance:1.5, rearmDistance:1.8}
};
const SCENE_ALERT_KINDS = Object.keys(sceneAlerts);

function sameRegion(a, b) {
  const width = Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]));
  const height = Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
  const overlap = width*height;
  const area = box => (box[2]-box[0])*(box[3]-box[1]);
  return overlap >= .25*(area(a)+area(b)-overlap);
}

function acceptSceneAlert(slot, kind, observation, stamp, partnerStream) {
  const states = slot.sceneAlertStates ??= {};
  const previous = states[kind];
  if (previous && stamp <= previous.stamp) return;
  const distance = partnerStream ? observation?.distance_m : undefined;
  const metric = distance !== undefined;
  const rules = sceneAlerts[kind];
  const same = observation && previous?.box && stamp-previous.seen <= CONFIRM_GAP_MS &&
    sameRegion(previous.box,observation.bbox);
  if (!observation || distance > rules.distance || (kind === 'wall' && !metric)) {
    const holdingWall = same && distance > rules.distance && distance <= rules.rearmDistance;
    states[kind] = {...previous,stamp,seen:holdingWall ? stamp : previous?.seen,rank:0,alertId:undefined};
    return;
  }

  const rank = metric ? 2 : 1;
  const consecutive = same && previous.stamp === previous.seen && previous.rank === rank &&
    previous.partnerStream === partnerStream &&
    (!metric || Math.abs(previous.distance-distance) <= Math.max(.25,.25*distance));
  const state = states[kind] = {
    stamp, seen:stamp, box:observation.bbox, rank, distance, partnerStream,
    announced:same ? previous.announced : 0,
    alertId:consecutive ? previous.alertId : undefined
  };
  if (!consecutive || state.announced >= rank) return;
  state.announced = rank;
  const meters = metric ? ((previous.distance+distance)/2).toFixed(1) : null;
  return {
    kind, camera_id:'A', risk:'caution', stamp, expires:stamp+SPEECH_MAX_AGE_MS,
    metric, partnerStream,
    text:metric ? 'Caution. There is a '+kind+' about '+meters+' meters ahead.' : 'Caution. There may be a door ahead.',
    text_zh:metric ? '小心，前方约'+meters+'米有'+rules.name_zh+'。' : '请小心，前方可能有门。'
  };
}

module.exports = {acceptSceneAlert, SCENE_ALERT_KINDS, SPEECH_MAX_AGE_MS};
