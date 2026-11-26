// Several long typed turns in one session, to push the combined recording past one upload part.
import WebSocket from 'ws';
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8787', ORIGIN = { origin: 'http://localhost:5173' };
let token = '';
if (process.env.E2E_CODE) token = (await (await fetch(BASE + '/auth', { method: 'POST', headers: { ...ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ code: process.env.E2E_CODE }) })).json()).token;
const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/session?t=' + encodeURIComponent(token), ORIGIN);
const turns = Number(process.argv[2] || 4);
let n = 0, audio = 0, done;
const ask = () => ws.send(JSON.stringify({ type: 'text', text: `Tell me a long story, at least twelve sentences, about day ${n + 1} of your week.` }));
ws.on('message', (d, bin) => {
  if (bin) { audio += d.length; return; }
  const m = JSON.parse(d.toString());
  if (m.type === 'error') console.log('  error', m.where, m.message);
  if (m.type === 'reply_end') { n++; console.log(`  turn ${n} done, ${(audio / 48000).toFixed(0)} s of voice so far`); if (n >= turns) { ws.close(); setTimeout(done, 4000); } else ask(); }
});
ws.on('open', () => { ws.send(JSON.stringify({ type: 'config', persona: 'mommy' })); ask(); });
await Promise.race([new Promise((r) => (done = r)), new Promise((r) => setTimeout(() => { console.log('  TIMEOUT'); r(); }, 240000))]);
process.exit(0);
