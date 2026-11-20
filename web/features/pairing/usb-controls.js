export function connectUsbControls({$,scope,session,dialog,onPaired}) {
  const local = ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  $('#usb-controls').hidden = !local;
  $('#wifi-pairing').open = !local;
  if (!local) return () => {};
  const sides = ['A','B'];
  const selects = sides.map(side => $('#usb-'+side));
  const connect = $('#usb-connect'), disconnect = $('#usb-disconnect'), refresh = $('#usb-refresh');
  const status = $('#usb-status');
  let timer, version = 0, active, busy = false;
  const resolution = $('#usb-resolution');
  let initialized = false;
  const selection = () => ({A:selects[0].value,B:selects[1].value,resolution:resolution.value});
  function buttons() {
    const {A,B} = selection();
    connect.disabled = busy || !A || !B || A === B || (active?.own && active.selected?.A === A && active.selected?.B === B && active.selected?.resolution === resolution.value);
    connect.textContent = active?.own ? "Apply camera settings" : "Connect USB cameras";
    disconnect.hidden = !active?.own;
    disconnect.disabled = refresh.disabled = busy;
  }
  async function api(method,body) {
    for (let attempt=0; attempt<2; attempt++) {
      const token = await session.getSession();
      const response = await fetch('/api/usb',{method,headers:{'Authorization':'Bearer '+token,
        'X-VisionAssist-USB':'desktop','Content-Type':'application/json'},body:body && JSON.stringify(body),
        signal:AbortSignal.any([scope.signal,AbortSignal.timeout(8000)])});
      if (response.status === 401 && !attempt) { session.invalidate(token); continue; }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'USB connection failed.');
      return data;
    }
  }
  async function update(method='GET') {
    clearTimeout(timer);
    const id = ++version;
    const previous = selection();
    busy = true;
    buttons();
    try {
      if (method !== 'GET') {
        status.textContent = method === 'POST' ? 'Connecting cameras…' : 'Disconnecting…';
        await api(method,method === 'POST' ? previous : undefined);
        if (method === 'POST') onPaired();
      }
      const data = await api('GET');
      if (id !== version || !dialog.open) return;
      active = data;
      if (!initialized) { resolution.value = data.selected?.resolution || resolution.value; initialized = true; }
      sides.forEach((side,i) => {
        const options = data.devices.map(d => new Option(d.label,d.id));
        const value = previous[side] || data.selected?.[side] || data.devices.find(d => d.side === side)?.id;
        selects[i].replaceChildren(new Option('Choose iPhone',''),...options);
        selects[i].value = data.devices.some(d => d.id === value) ? value : '';
      });
      status.textContent = data.message || (data.own ? (data.live ? 'Both USB cameras are live.' :
        'Waiting for both cameras. Keep WiredCamera open on both phones.') : data.selected ?
        'These cameras are connected to another dashboard. Connect to use them here.' :
        data.devices.length < 2 ? 'Found '+data.devices.length+' USB devices. Unlock both phones, trust this Mac, then refresh.' :
        'Check the left and right cameras, then connect.');
      if (data.own) timer = setTimeout(() => update(),3000);
    } catch (err) {
      if (id === version && dialog.open) status.textContent = err.message;
    } finally {
      if (id === version) {busy=false; buttons();}
    }
  }
  for (const select of [...selects,resolution]) scope.listen(select,'change',buttons);
  scope.listen(connect,'click',()=>update('POST'));
  scope.listen(disconnect,'click',()=>update('DELETE'));
  scope.listen(refresh,'click',()=>update());
  scope.listen(dialog,'close',()=>{clearTimeout(timer); version++; busy=false;});
  scope.signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});
  return () => {status.textContent='Finding USB cameras…'; void update();};
}
