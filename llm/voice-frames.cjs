const CAPTURE_MS = 500;
const TURN_MS = 90_000;
const FRESH_MS = 1_500;
const MAX_BYTES = 4 * 1024 * 1024;

function collect(session, turn, now = Date.now()) {
  for (const side of ['A','B']) {
    const slot = session.slots[side];
    if (!slot?.frame?.length || slot.frame.length > MAX_BYTES || now-slot.stamp > FRESH_MS) continue;
    const frames = turn.frames[side] ??= {};
    if (frames.latest?.frame === slot.frame) continue;
    const sample = {frame:slot.frame,stamp:slot.stamp};
    frames.first ??= sample;
    frames.latest = sample;
  }
}

function discard(session, id) {
  const turn = session.voiceFrames;
  if (!turn || (id && id !== turn.id)) return;
  clearInterval(turn.timer);
  delete session.voiceFrames;
}

function begin(session, id) {
  discard(session);
  const turn = {id,frames:{},until:Date.now()+TURN_MS};
  collect(session,turn);
  turn.timer = setInterval(() => {
    if (Date.now() >= turn.until) return discard(session,id);
    collect(session,turn);
  },CAPTURE_MS);
  turn.timer.unref();
  session.voiceFrames = turn;
}

function markSpoken(session, id) {
  const turn = session.voiceFrames;
  if (turn?.id !== id || Date.now() >= turn.until) return;
  collect(session,turn);
  for (const frames of Object.values(turn.frames)) frames.spoken = frames.latest;
}

function take(session, id) {
  const turn = session.voiceFrames;
  if (!id || turn?.id !== id || Date.now() >= turn.until) return {};
  collect(session,turn);
  discard(session,id);
  return turn.frames;
}

module.exports = {begin,markSpoken,take,discard};
