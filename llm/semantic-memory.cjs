const DEFAULT_MODEL = 'embeddinggemma';

async function embedLocally(model, input) {
  if (/cloud/i.test(model)) throw new Error('Choose a local embedding model.');
  const response = await fetch('http://127.0.0.1:11434/api/embed', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model,input}),
    signal:AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Local embedding model unavailable.');
  return (await response.json()).embeddings;
}

function unitVector(vector) {
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) {
    throw new Error('Invalid memory embedding.');
  }
  const magnitude = Math.hypot(...vector);
  if (!Number.isFinite(magnitude) || !magnitude) throw new Error('Invalid memory embedding.');
  return vector.map(value => value / magnitude);
}

async function semanticMatches(db, embed, query) {
  const model = process.env.VISIONASSIST_EMBED_MODEL || DEFAULT_MODEL;
  const rows = db.prepare(`SELECT memory.id, memory.kind, memory.name, memory.label, embedding.vector
    FROM memory LEFT JOIN embedding ON embedding.owner=memory.id AND embedding.model=?
    WHERE memory.kind IN ('habit','item') ORDER BY memory.id`).all(model);
  if (!rows.length) return [];

  const stale = rows.filter(row => row.vector === null);
  const write = db.prepare(`INSERT INTO embedding(owner,model,vector)
    SELECT id,?,? FROM memory WHERE id=? AND name=? AND kind=? AND label IS ?
    ON CONFLICT(owner) DO UPDATE SET model=excluded.model, vector=excluded.vector`);
  let needle;
  for (let offset = 0; offset < Math.max(1, stale.length); offset += 32) {
    const batch = stale.slice(offset,offset+32);
    const inputs = batch.map(row => row.label ? row.name + ' (' + row.label + ')' : row.name);
    if (offset === 0) inputs.unshift(query);
    const result = await embed(model,inputs);
    if (!Array.isArray(result) || result.length !== inputs.length) throw new Error('Incomplete embeddings.');
    const vectors = result.map(unitVector);
    if (offset === 0) needle = vectors.shift();
    for (const [index,row] of batch.entries()) {
      const vector = vectors[index];
      if (vector.length !== needle.length) throw new Error('Inconsistent embeddings.');
      row.vector = JSON.stringify(vector);
      write.run(model,row.vector,row.id,row.name,row.kind,row.label);
    }
  }

  const stillSaved = db.prepare('SELECT 1 FROM memory WHERE id=? AND name=? AND kind=? AND label IS ?');
  return rows.flatMap(row => {
    if (!stillSaved.get(row.id,row.name,row.kind,row.label)) return [];
    const vector = JSON.parse(row.vector);
    if (vector.length !== needle.length) return [];
    const score = vector.reduce((sum,value,index) => sum + value * needle[index],0);
    return score >= 0.55 ? [{kind:row.kind,name:row.name,score}] : [];
  }).sort((a,b) => b.score-a.score).slice(0,3);
}

module.exports = {embedLocally,semanticMatches};
