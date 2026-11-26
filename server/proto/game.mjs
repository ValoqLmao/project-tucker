// Game mode check against a running session server: a screenshot, voice-chat chatter that is not
// for him, a line that calls him by name, then a second screenshot he may react to on his own.
//   node --env-file=../.env proto/game.mjs <first.jpg> <second.jpg>
import fs from 'node:fs';
import WebSocket from 'ws';
import { encode, decode } from '@msgpack/msgpack';

function fishPcm16k(text) {
  return new Promise((res, rej) => {
    const chunks = [];
    const ws = new WebSocket('wss://api.fish.audio/v1/tts/live', { headers: { Authorization: 'Bearer ' + process.env.FISH_API_KEY, model: 's2.1-pro' } });
    ws.on('open', () => { ws.send(encode({ event: 'start', request: { text: '', format: 'pcm', sample_rate: 16000, latency: 'balanced' } })); ws.send(encode({ event: 'text', text })); ws.send(encode({ event: 'stop' })); });
    ws.on('message', (m) => { const d = decode(m); if (d.event === 'audio') chunks.push(Buffer.from(d.audio)); if (d.event === 'finish') { ws.close(); res(Buffer.concat(chunks)); } });
    ws.on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8787';
const [first, second] = process.argv.slice(2);
const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/session', { origin: 'http://localhost:5173' });
const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
let text = '', audio = 0;
ws.on('message', (d, bin) => {
  if (bin) { audio += d.length; return; }
  const m = JSON.parse(d.toString());
  if (m.type === 'reply_text') { text += m.delta; return; }
  if (m.type === 'reply_end' || m.type === 'interrupt') { console.log(at(), m.type, text ? `"${text.trim()}" (${(audio / 48000).toFixed(1)} s of voice)` : '(said nothing)'); text = ''; audio = 0; return; }
  console.log(at(), m.type, m.text || m.value || m.message || '');
});
/** Speak a line into a channel: 0 = the host's mic, 1 = the team's voice chat. */
async function say(channel, pcm) {
  const frame = 2560, tag = Buffer.from([1]);
  const out = (b) => ws.send(channel ? Buffer.concat([tag, b]) : b);
  for (let i = 0; i + frame <= pcm.length; i += frame) { out(pcm.subarray(i, i + frame)); await sleep(80); }
  for (let i = 0; i < 45; i++) { out(Buffer.alloc(frame)); await sleep(80); }
}
const screen = (file) => ws.send(JSON.stringify({ type: 'screen', jpeg: fs.readFileSync(file).toString('base64') }));
ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'config', persona: 'goblin' }));
  ws.send(JSON.stringify({ type: 'game', on: true, mode: 'name', react: true }));
  screen(first);
  const [chatter, call] = await Promise.all([fishPcm16k('Nice shot man, rotate to B site, they are all going B.'), fishPcm16k('Hey Rudi, what do you think about how this round is going?')]);
  console.log(at(), '-- a teammate talks, not to him');
  await say(1, chatter);
  console.log(at(), '-- a teammate calls him by name');
  await say(1, call);
  await sleep(9000);
  console.log(at(), '-- the screen changes: the player died');
  screen(second);
  await sleep(30000);
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => { console.log('client error', e.message); process.exit(1); });
