export function createDesktopSession(scope) {
  let token;
  let sessionRequest;
  async function api(path, method, auth) {
    const response = await fetch(path, {method, headers:auth ? {Authorization:'Bearer '+auth} : {}, signal:AbortSignal.any([scope.signal, AbortSignal.timeout(3500)])});
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error), {status:response.status});
    return body;
  }

  function getSession() {
    scope.signal.throwIfAborted();
    if (token) return Promise.resolve(token);
    sessionRequest ||= api('/api/session','POST').then(result => {
      token = result.token;
      return token;
    }).finally(() => { sessionRequest = undefined; });
    return sessionRequest;
  }

  async function agentFetch(path, method, body, contentType = 'application/json', signal) {
    if (location.protocol === 'file:') throw new Error('Start the local server to use the assistant.');
    const auth = await getSession();
    const timeout = AbortSignal.timeout(62000);
    const response = await fetch(path,{method,body,headers:{Authorization:'Bearer '+auth,
      ...(body ? {'Content-Type':contentType} : {})},signal:AbortSignal.any([scope.signal,timeout,...(signal ? [signal] : [])])});
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (response.status === 401 && token === auth) token = undefined;
      throw Object.assign(new Error(result.error || 'Local assistant unavailable. Try again.'),{status:response.status});
    }
    return response;
  }

  async function agentRequest(...args) {
    const response = await agentFetch(...args);
    return response.status === 204 ? null : response.json();
  }
  return {getSession, api, agentFetch, agentRequest, get token() { return token; }, invalidate(expected = token) { if (token === expected) token = undefined; }};
}
