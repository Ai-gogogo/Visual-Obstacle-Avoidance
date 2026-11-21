export function connectConversation({$, scope, agentFetch}) {
  const {listen} = scope;
  let exporting = false;
  const conversation = readConversation();
  const replySources = new Map([
    ['history','Historical observation'], ['memory','Saved memory'],
    ['yolo','Current detection'], ['scene','Detection + depth · local LLM'], ['camera','Recent camera frame'],
    ['unavailable','Unavailable']
  ]);
  function readConversation() {
    try {
      const saved = JSON.parse(sessionStorage.getItem('visionassist-conversation') || '[]');
      return Array.isArray(saved) ? saved.filter(entry => entry && ['user','assistant'].includes(entry.role) &&
        typeof entry.text === 'string').slice(-1000) : [];
    } catch { return []; }
  }

  function appendMessage(message) {
    const row = document.createElement('li');
    row.dataset.speaker = message.role;
    const speaker = document.createElement('strong');
    const body = document.createElement('p');
    speaker.textContent = message.role === 'user' ? 'You' : 'VisionAssist';
    body.textContent = message.text;
    row.append(speaker);
    const source = replySources.get(message.source);
    if (message.role === 'assistant' && source) {
      const label = document.createElement('span');
      label.className = 'status message-source';
      label.textContent = source;
      row.append(label);
    }
    row.append(body);
    $('#conversation-log').append(row);
  }

  function scrollConversation() {
    const log = $('#conversation-log');
    log.scrollTop = log.scrollHeight;
  }

  function addMessage(role,text,source) {
    const message = {role,text,source};
    conversation.push(message);
    appendMessage(message);
    const log = $('#conversation-log');
    if (conversation.length > 1000) {
      conversation.shift();
      log.firstElementChild.remove();
    }
    scrollConversation();
    $('#conversation-empty').hidden = true;
    $('#export-conversation').disabled = exporting;
    if (role === 'assistant') $('#replay').disabled = false;
    try { sessionStorage.setItem('visionassist-conversation',JSON.stringify(conversation)); } catch {}
  }

  async function exportConversation() {
    const button = $('#export-conversation');
    if (!conversation.length || exporting) return false;
    exporting = true;
    button.disabled = true;
    $('#export-status').textContent = 'Preparing Word document…';
    try {
      const response = await agentFetch('/api/agent/export','POST',JSON.stringify({messages:conversation}));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'VisionAssist-conversation.docx';
      document.body.append(link);
      link.click();
      link.remove();
      const timer = scope.delay(release,30000);
      scope.signal.addEventListener('abort',release,{once:true});
      function release() {
        scope.cancelDelay(timer);
        scope.signal.removeEventListener('abort',release);
        URL.revokeObjectURL(url);
      }
      $('#export-status').textContent = 'Word document ready.';
      return true;
    } catch (error) {
      $('#export-status').textContent = error.message;
      return false;
    } finally {
      exporting = false;
      button.disabled = false;
    }
  }

  listen($('#export-conversation'), 'click',exportConversation);
  $('#conversation-log').replaceChildren();
  conversation.forEach(appendMessage);
  $('#conversation-empty').hidden = Boolean(conversation.length);
  $('#export-conversation').disabled = !conversation.length;
  $('#replay').disabled = !conversation.some(message => message.role === 'assistant');
  return { addMessage, scrollConversation, exportConversation, hasMessages:() => conversation.length > 0,
    latestReply:() => conversation.findLast(message => message.role === 'assistant') };
}
