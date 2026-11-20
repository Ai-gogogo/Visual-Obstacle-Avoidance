export function createVisionMemoryView({$, agentRequest, loadPreferences, accessibility, signal}) {
  const timestamp = value => new Date(value).toLocaleString();
  const observationText = ({time,camera,position}) =>
    timestamp(time)+' · Camera '+camera+' · '+position;
  const showError = error => {
    $('#memory-status').textContent = accessibility.requestError(error,'Could not reach saved memory.');
  };
  let request = 0;
  async function refresh() {
    const version = ++request;
    const kind = $('#memory-kind').value;
    const list = $('#memory-list');
    list.setAttribute('aria-busy','true');
    list.replaceChildren();
    $('#memory-status').textContent = 'Loading saved records…';
    try {
      const {records} = await agentRequest('/api/memory/'+kind,'GET');
      if (signal.aborted || version !== request || kind !== $('#memory-kind').value) return;
      $('#memory-status').textContent = '';
      const rows = records.map(record => {
        const row = document.createElement('li');
        const name = document.createElement('strong');
        name.textContent = record.name+(kind === 'people' && record.label ? ' · '+record.label : '');
        row.append(name);
        const actions = document.createElement('div');
        actions.className = 'toolbar memory-actions';
        const button = document.createElement('button');
        button.className = 'quiet';
        button.type = 'button';
        button.textContent = 'Delete';
        button.setAttribute('aria-label','Delete '+record.name);
        button.onclick = async () => {
          if (!window.confirm('Delete '+record.name+'?')) return;
          button.disabled = true;
          try {
            await agentRequest('/api/memory/'+kind+'/'+record.id,'DELETE');
            $('#memory-kind').focus();
            await refresh();
            $('#memory-status').textContent = 'Deleted '+record.name+'.';
            await loadPreferences();
          } catch (error) { showError(error); button.disabled = false; }
        };
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'quiet';
        edit.textContent = 'Edit';
        edit.setAttribute('aria-label','Edit '+record.name);
        edit.onclick = async () => {
          const name = window.prompt('Edit saved record',record.name)?.trim();
          if (!name || name === record.name) return;
          try {
            await agentRequest('/api/memory/'+kind+'/'+record.id,'PATCH',JSON.stringify({name}));
            $('#memory-kind').focus();
            await refresh();
            await loadPreferences();
            $('#memory-status').textContent = 'Saved '+name+'.';
          } catch (error) { showError(error); }
        };
        actions.append(edit,button);
        row.append(actions);
        if (kind === 'items') {
          const summary = document.createElement('p');
          try {
            const observation = JSON.parse(record.last_seen);
            summary.textContent = observation
              ? 'Last possible match · '+observationText(observation)
              : 'No saved observation';
          } catch { summary.textContent = 'Saved observation unavailable'; }
          name.after(summary);
          const history = document.createElement('button');
          history.type = 'button';
          history.className = 'quiet';
          history.textContent = 'History';
          history.setAttribute('aria-label','History for '+record.name);
          history.onclick = async () => {
            try {
              const {observations} = await agentRequest('/api/memory/items/'+record.id+'/history','GET');
              if (signal.aborted || version !== request) return;
              const entries = observations.map(observationText);
              $('#memory-status').textContent = entries.length
                ? 'Past possible matches for '+record.name+'. '+entries.join(' / ') : 'No observations saved.';
            } catch (error) { if (version === request) showError(error); }
          };
          actions.prepend(history);
        }
        return row;
      });
      list.replaceChildren(...rows);
      if (!rows.length) {
        const empty = document.createElement('li');
        empty.textContent = 'No saved records.';
        list.append(empty);
      }
    } catch (error) {
      if (version === request) showError(error);
    } finally {
      if (version === request) list.setAttribute('aria-busy','false');
    }
  }

  return {refresh};
}
