const placement = model => model.device === 'cpu' ? 'CPU' :
  model.device === 'gpu' ? 'GPU (100% in VRAM)' : 'CPU + GPU ('+model.gpu_percent+'% in VRAM)';

export function connectModelCompute({$, scope, agentRequest}) {
  const yoloLabel = $('#yolo-compute');
  const agentLabel = $('#agent-compute');

  function render(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  async function update() {
    try {
      const {yolo,agent} = await agentRequest('/api/agent/runtime','GET',undefined,
        'application/json',AbortSignal.timeout(2800));
      if (scope.signal.aborted) return;
      render(yoloLabel,yolo.length ? yolo.map(worker => {
        const device = worker.device === 'cpu' ? 'CPU' : 'GPU '+worker.device.split(':')[1];
        return 'Camera '+worker.camera+' · '+device+' · '+worker.precision.toUpperCase();
      }).join(' / ') : 'No worker reporting');
      const live = agent.loaded.map(model => model.name+' · '+placement(model)).join(' / ');
      const last = agent.last_observed;
      const history = last ? ' · Last observed '+last.name+' on '+placement(last)+
        ' at '+new Date(last.observed_ms).toLocaleTimeString() : '';
      render(agentLabel,agent.reachable ? (live ? 'Loaded '+live : 'Idle (no Agent model loaded)'+history) :
        'Ollama unavailable'+history);
    } catch (error) {
      if (scope.signal.aborted) return;
      render(yoloLabel,'Status unavailable');
      render(agentLabel,'Status unavailable');
      if (error.status === 403 || location.protocol === 'file:') return;
    }
    scope.delay(update,1800);
  }

  void update();
}
