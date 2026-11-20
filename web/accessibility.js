const VisionAccessibility = (() => {
  const root = document.documentElement;
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const toggle = document.querySelector('#reduce-motion');
  const storageKey = 'visionassist-reduce-motion';
  let reduced = false;
  let toastFrame;
  try { reduced = localStorage.getItem(storageKey) === 'true'; } catch {}

  function applyMotionPreference() {
    root.toggleAttribute('data-reduced-motion', reduced || preference.matches);
    toggle?.setAttribute('aria-pressed', String(reduced));
  }
  preference.addEventListener('change', applyMotionPreference);
  toggle?.addEventListener('click', () => {
    reduced = !reduced;
    try { localStorage.setItem(storageKey, String(reduced)); } catch {}
    applyMotionPreference();
  });
  document.querySelectorAll('summary').forEach(summary => {
    summary.addEventListener('click', event => {
      summary.parentElement.toggleAttribute('data-animate', Boolean(event.detail));
    });
  });
  applyMotionPreference();

  function openDialog(dialog, opener) {
    dialog.toggleAttribute('data-animate', Boolean(opener?.detail));
    dialog.showModal();
  }

  function toast(message) {
    const node = document.querySelector('#ui-feedback');
    if (!node) return;
    cancelAnimationFrame(toastFrame);
    node.classList.remove('toast-visible');
    node.textContent = message;
    if (message) toastFrame = requestAnimationFrame(() => node.classList.add('toast-visible'));
  }

  function requestError(error, fallback) {
    if (navigator.onLine === false) return 'Network connection lost. Reconnect and try again.';
    if (error.name === 'TimeoutError') return 'The local service timed out. Try again.';
    if (error instanceof TypeError) return fallback;
    return error.message || fallback;
  }

  return {openDialog, toast, requestError, reducedMotion:() => reduced || preference.matches};
})();
