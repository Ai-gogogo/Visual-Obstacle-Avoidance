const {execFile} = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

function inspect(images) {
  return new Promise((resolve, reject) => {
    const local = path.join(__dirname,'../cv/.venv/bin/python');
    const python = process.env.VISIONASSIST_CV_PYTHON || (require('node:fs').existsSync(local) ? local : 'python3');
    const child = execFile(python,
      [path.join(__dirname,'../cv/inspect_checkerboard.py')], {timeout:8000}, (error, stdout) => {
        if (error) return reject(new Error('Checkerboard detector unavailable. Set VISIONASSIST_CV_PYTHON to the Python with OpenCV.'));
        try { resolve(JSON.parse(stdout)); } catch (err) { reject(err); }
      });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(images));
  });
}

function similar(pose, prior) {
  return pose.every((points, side) => {
    const other = prior[side];
    const distance = reverse => points.reduce((sum,[x,y],i) => {
      const [u,v] = other[reverse ? points.length-1-i : i];
      return sum + (x-u)**2 + (y-v)**2;
    },0) / points.length;
    return Math.min(distance(false),distance(true)) < .034**2;
  });
}

async function calibration(session, action, id) {
  const {A,B} = session.slots;
  const now = Date.now();
  const streams = [A.streamID,B.streamID].join('/');
  if (session.calibration?.streams !== streams)
    session.calibration = {streams, poses:[], batch:require('node:crypto').randomUUID()};
  const state = session.calibration;
  const count = state.poses.length;
  const tip = ['Center the board.', 'Move it left.', 'Move it right.', 'Move it higher.',
    'Move it lower.', 'Tilt the top toward the cameras.', 'Tilt the left edge toward the cameras.', 'Change the distance.'][count % 8];
  if (state.busy) return {message:'Please wait.', count};
  state.busy = true;
  try {
    const current = () => session.slots.A === A && session.slots.B === B;
    if (action === 'capture') {
      const pair = state.pair;
      if (!pair || id !== pair.id || now-pair.stamp > 5000 || !current())
        return {count,message:'Preview expired. Wait for a fresh pair.'};
      if (state.poses.some(p => similar(pair.pose,p))) return {count,message:'Pose already saved. '+tip};
      const root = path.join(__dirname,'../.visionassist/calibration',state.batch);
      await fs.mkdir(root,{recursive:true});
      const tmp = await fs.mkdtemp(path.join(root,'.saving-'));
      try {
        const extension = type => type === 'image/png' ? 'png' : 'jpg';
        await fs.writeFile(path.join(tmp,'A.'+extension(pair.types[0])),pair.left);
        await fs.writeFile(path.join(tmp,'B.'+extension(pair.types[1])),pair.right);
        if (!current()) throw new Error('Camera changed. Try again.');
        await fs.rename(tmp,path.join(root,pair.id));
      } finally { await fs.rm(tmp,{force:true,recursive:true}); }
      state.poses.push(pair.pose);
      state.pair = null;
      return {count:count+1,message:'Saved stereo pair '+(count+1)+'.'};
    }
    state.pair = null;
    if (![A,B].every(slot => slot.frame && now-slot.stamp < 5000))
      return {count,message:'Waiting for both cameras. Pair them and keep their camera pages open.'};
    const left = A.frame, frameID = A.etag.slice(1,-1), stamp = A.stamp;
    const candidates = (B.history || []).filter(p => now-p.stamp < 5000 && A.sample)
      .map(p => ({p,skew:Math.abs(A.sample.ms-p.sample.ms)+A.sample.error+p.sample.error}))
      .sort((a,b) => a.skew-b.skew);
    const matched = candidates[0]?.skew <= 65;
    const rightFrame = matched ? candidates[0].p : B;
    const right = rightFrame.frame;
    const types = [A.frameType,rightFrame.frameType];
    const images = [left,right].map(b => b.toString('base64'));
    const boards = await inspect(images);
    if (!current()) return {count,message:'Camera changed. Waiting for a fresh pair.'};
    const missing = boards.findIndex(b => !b.corners.length);
    let message = tip;
    if (missing >= 0) message = 'Show the full checkerboard to Camera '+ 'AB'[missing]+'.';
    else if (String(boards[0].size) !== String(boards[1].size)) message = 'Match both camera orientations and frame sizes.';
    else if (!matched) message = 'Waiting for synchronized frames.';
    else {
      const pose = boards.map(b => b.corners.map(pt => pt.map(x => x/Math.max(...b.size))));
      if (state.poses.some(p => similar(pose,p))) message = 'Pose already saved. '+tip;
      else state.pair = {id:frameID,left,right,types,pose,stamp};
    }
    return {images,types,boards,count,message,id:state.pair?.id};
  } finally { state.busy = false; }
}
module.exports = {calibration};
