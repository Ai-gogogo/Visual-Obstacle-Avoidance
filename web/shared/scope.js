export function createScope() {
  const controller = new AbortController();
  const timers = new Set();
  const signal = controller.signal;
  return {
    signal,
    listen(target, type, handler) {
      target.addEventListener(type, handler, {signal});
    },
    delay(handler, ms) {
      if (signal.aborted) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!signal.aborted) handler();
      }, ms);
      timers.add(timer);
      return timer;
    },
    cancelDelay(timer) {
      clearTimeout(timer);
      timers.delete(timer);
    },
    dispose() {
      controller.abort();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    }
  };
}
