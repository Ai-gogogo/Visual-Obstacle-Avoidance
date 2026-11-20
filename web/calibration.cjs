const {execFile} = require('node:child_process');
const path = require('node:path');

function inspect(images,mode,batch = false) {
  return new Promise((resolve, reject) => {
    const local = path.join(__dirname,'../cv/.venv/bin/python');
    const python = process.env.VISIONASSIST_CV_PYTHON || (require('node:fs').existsSync(local) ? local : 'python3');
    const child = execFile(python,
      [path.join(__dirname,'../cv/inspect_checkerboard.py'),mode,...(batch ? ['--batch'] : [])], {timeout:8000}, (error, stdout) => {
        if (error) return reject(new Error('Checkerboard detector unavailable. Set VISIONASSIST_CV_PYTHON to the Python with OpenCV.'));
        try { resolve(JSON.parse(stdout)); } catch (err) { reject(err); }
      });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(images));
  });
}

function stereoPartner(A,B,now) {
  if (!A.sample || now-A.stamp >= 5000) return null;
  let best, limit = 65;
  for (const frame of B.history || []) {
    if ((frame.transport ?? 'image') !== (A.rtcID ? 'webrtc' : 'image') || frame.quality !== A.rtcQuality) continue;
    const skew = Math.abs(A.sample.ms-frame.sample.ms)+A.sample.error+frame.sample.error;
    if (now-frame.stamp < 5000 && skew <= limit) {
      best = frame;
      limit = skew;
    }
  }
  return best;
}

async function previewCalibration(session, mode) {
  const {A,B} = session.slots;
  const now = Date.now();
  if (![A,B].every(slot => slot.frame && now-slot.stamp < 5000))
    return {message:'Waiting for both cameras. Pair them and keep their camera pages open.'};
  const partner = stereoPartner(A,B,now);
  const types = [A.frameType,partner?.frameType ?? B.frameType];
  const images = [A.frame,partner?.frame ?? B.frame].map(frame => frame.toString('base64'));
  const boards = await inspect(images,mode);
  if (session.slots.A !== A || session.slots.B !== B)
    return {message:'Camera changed. Waiting for a fresh pair.'};
  const missing = boards.findIndex(board => !board.corners.length);
  let message;
  if (types[0] !== types[1]) message = 'Choose the same upload quality on both phones.';
  else if (mode === 'three' && boards[0].faces.length < 2) message = 'Show at least two of the same coded faces to both cameras.';
  else if (missing >= 0) message = 'Show the full checkerboard to Camera '+ 'AB'[missing]+'.';
  else if (String(boards[0].size) !== String(boards[1].size)) message = 'Match both camera orientations and frame sizes.';
  else if (!partner) message = 'Waiting for synchronized frames.';
  else if (mode === 'three') message = 'Matched '+boards[0].faces.join(' + ')+'.';
  else message = 'Both cameras see the complete checkerboard.';
  return {images,types,boards,message};
}
module.exports = {previewCalibration,stereoPartner,inspect};
