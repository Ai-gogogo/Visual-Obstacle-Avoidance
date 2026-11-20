const VisionVoiceView = (() => {
  const mic = document.querySelector('#mic');
  const state = document.querySelector('#voice-state');
  const prompt = document.querySelector('#voice-prompt');
  const stop = document.querySelector('#stop');
  const bars = [...mic.querySelectorAll('.voice-wave span')];
  const icons = {
    Ready:'mic', Starting:'wait', 'Wake word':'wave', Listening:'wave',
    Processing:'wait', Review:'wait', Reading:'stop', Speaking:'stop',
    Warning:'warning', Error:'warning'
  };
  let level = 0;

  function resetWave() {
    level = 0;
    bars.forEach(bar => { bar.style.transform = ''; });
  }

  function render(title, text, label, canStop) {
    if (state.textContent !== title) state.textContent = title;
    if (prompt.textContent !== text) prompt.textContent = text;
    mic.dataset.icon = icons[title] ?? 'mic';
    state.dataset.state = mic.dataset.state = title.toLowerCase().replaceAll(' ', '-');
    mic.setAttribute('aria-label', label);
    state.toggleAttribute('data-active', title !== 'Ready');
    if (mic.dataset.icon !== 'wave') resetWave();
    stop.disabled = !canStop;
  }

  function updateWave(rms) {
    if (VisionAccessibility.reducedMotion()) {
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

  return {render, updateWave};
})();
