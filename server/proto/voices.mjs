// Explore Fish Audio's public voice library. Usage: node proto/voices.mjs "term1,term2" [extra query string]
const terms = (process.argv[2] || '').split(',');
const extra = process.argv[3] || '';
for (const term of terms) {
  const q = new URLSearchParams({ page_size: '12', sort_by: 'task_count', language: 'en', ...(term ? { title: term } : {}) });
  const r = await fetch(`https://api.fish.audio/model?${q}${extra ? '&' + extra : ''}`, { headers: { Authorization: 'Bearer ' + process.env.FISH_API_KEY } });
  if (!r.ok) { console.log(term, 'HTTP', r.status, (await r.text()).slice(0, 200)); continue; }
  const j = await r.json();
  console.log(`\n=== "${term}" total ${j.total}`);
  if (process.argv[4] === 'raw') { console.log(JSON.stringify(j.items[0], null, 1).slice(0, 1800)); continue; }
  for (const v of j.items) console.log(`${v._id} | ${String(v.title).slice(0, 44).padEnd(44)} | uses ${String(v.task_count).padStart(8)} | likes ${String(v.like_count).padStart(6)} | ${v.type}/${v.train_mode} | ${(v.tags || []).slice(0, 7).join(',')} | ${(v.description || '').replace(/\s+/g, ' ').slice(0, 70)}`);
}
