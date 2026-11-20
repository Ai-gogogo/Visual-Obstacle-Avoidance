export function createVoiceMeter($, accessibility) {
  const mic = $('#mic');
  const bars = [...mic.querySelectorAll('.voice-wave span')];
  let level = 0;

  function resetWave() {
    level = 0;
    bars.forEach(bar => { bar.style.transform = ''; });
  }

  function updateWave(rms) {
    if (accessibility.reducedMotion()) {
      if (level) resetWave();
      return;
    }
    const target = Math.min(1, Math.max(0, Number(rms) || 0) * 10);
    level = level * .42 + target * .58;
    bars.forEach((bar, index) => {
      const weight = [0.42, 0.72, 0.88, 1, 0.83, 0.69, 0.46][index];
      bar.style.transform = 'scaleY(' + (.24 + weight * level * .76).toFixed(2) + ')';
    });
  }

  return {resetWave, updateWave};
}
