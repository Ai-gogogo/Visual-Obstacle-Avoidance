export function requestError(error, fallback) {
  if (navigator.onLine === false) return 'Network connection lost. Reconnect and try again.';
  if (error.name === 'TimeoutError') return 'The local service timed out. Try again.';
  if (error instanceof TypeError) return fallback;
  return error.message || fallback;
}

export function createAccessibility(element, scope) {
  const root = document.documentElement;
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const toggle = element.querySelector('#reduce-motion');
  const storageKey = 'visionassist-reduce-motion';
  let reduced = false;
  let toastFrame;
  try { reduced = localStorage.getItem(storageKey) === 'true'; } catch {}
  const reducedMotion = () => reduced || preference.matches;

  function applyMotionPreference() {
    root.toggleAttribute('data-reduced-motion', reducedMotion());
    toggle?.setAttribute('aria-pressed', String(reduced));
  }
  scope.listen(preference, 'change', applyMotionPreference);
  function setReducedMotion(enabled) {
    reduced = enabled;
    try { localStorage.setItem(storageKey, String(reduced)); } catch {}
    applyMotionPreference();
  }
  if (toggle) scope.listen(toggle, 'click', () => setReducedMotion(!reduced));
  for (const summary of element.querySelectorAll('summary')) {
    scope.listen(summary, 'click', event => {
      summary.parentElement.toggleAttribute('data-animate', Boolean(event.detail));
    });
  }
  applyMotionPreference();
  scope.signal.addEventListener('abort', () => cancelAnimationFrame(toastFrame), {once:true});

  function openDialog(dialog, opener) {
    dialog.toggleAttribute('data-animate', Boolean(opener?.detail));
    dialog.showModal();
    dialog.querySelector('[data-initial-focus]')?.focus();
  }

  function toast(message) {
    const node = element.querySelector('#ui-feedback');
    cancelAnimationFrame(toastFrame);
    node.classList.remove('toast-visible');
    node.textContent = message;
    if (message) toastFrame = requestAnimationFrame(() => node.classList.add('toast-visible'));
  }
  return {openDialog, toast, requestError, reducedMotion, setReducedMotion};
}
