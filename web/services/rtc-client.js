function waitForCandidates(peer, signal) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    function done(error) {
      peer.removeEventListener('icegatheringstatechange', check);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    }
    function check() {
      if (peer.iceGatheringState === 'complete') done();
    }
    function abort() { done(signal.reason); }
    peer.addEventListener('icegatheringstatechange', check);
    signal.addEventListener('abort', abort, {once:true});
    if (signal.aborted) abort(); else check();
  });
}

export async function exchangeVideoOffer(peer, path, token, signal) {
  const timeout = AbortSignal.any([signal,AbortSignal.timeout(7000)]);
  await peer.setLocalDescription(await peer.createOffer());
  await waitForCandidates(peer,timeout);
  const response = await fetch(path, {
    method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(peer.localDescription), signal:timeout
  });
  if (!response.ok) throw new Error('WebRTC signaling unavailable.');
  await peer.setRemoteDescription(await response.json());
}
