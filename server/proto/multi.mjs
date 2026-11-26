// Two spoken turns in one session: checks the speech-to-text link survives a full reply.
import WebSocket from 'ws';
import { encode, decode } from '@msgpack/msgpack';
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8787', ORIGIN = { origin: 'http://localhost:5173' };
const speech = (text) => new Promise((res, rej) => {
  const chunks = [];
  const ws = new WebSocket('wss://api.fish.audio/v1/tts/live', { headers: { Authorization: 'Bearer ' + process.env.FISH_API_KEY, model: 's2.1-pro' } });
  ws.on('open', () => { ws.send(encode({ event: 'start', request: { text: '', format: 'pcm', sample_rate: 16000, latency: 'balanced' } })); ws.send(encode({ event: 'text', text })); ws.send(encode({ event: 'stop' })); });
  ws.on('message', (m) => { const d = decode(m); if (d.event === 'audio') chunks.push(Buffer.from(d.audio)); if (d.event === 'finish') { ws.close(); res(Buffer.concat(chunks)); } });
  ws.on('error', rej);
});
let token = '';
if (process.env.E2E_CODE) token = (await (await fetch(BASE + '/auth', { method: 'POST', headers: { ...ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ code: process.env.E2E_CODE }) })).json()).token;
const lines = [await speech('Hey, what is your favorite color?'), await speech('Okay, and what about your favorite food?')];
const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/session?t=' + encodeURIComponent(token), ORIGIN);
let turn = 0, done;
const say = async (pcm) => {
  for (let i = 0; i < pcm.length; i += 2560) { ws.send(pcm.subarray(i, i + 2560)); await new Promise((r) => setTimeout(r, 80)); }
  const silence = Buffer.alloc(2560);
  const mine = turn;
  while (turn === mine && ws.readyState === 1) { ws.send(silence); await new Promise((r) => setTimeout(r, 80)); }
};
ws.on('message', (d, bin) => {
  if (bin) return;
  const m = JSON.parse(d.toString());
  if (m.type === 'user_final') console.log(`  turn ${turn + 1} heard: ${m.text}`);
  if (m.type === 'error') console.log('  error', m.where, m.message);
  if (m.type === 'reply_end') { turn++; console.log(`  turn ${turn} reply finished`); if (turn === 2) { ws.close(); done(); } }
});
ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'config', persona: 'sweet' }));
  await say(lines[0]);
  await new Promise((r) => setTimeout(r, 1500));
  await say(lines[1]);
});
await Promise.race([new Promise((r) => (done = r)), new Promise((r) => setTimeout(() => { console.log('  TIMEOUT at turn', turn + 1); r(); }, 60000))]);
process.exit(0);
