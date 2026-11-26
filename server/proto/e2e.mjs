// End-to-end check of the session server, with a synthetic "user" voice made by the TTS itself.
import WebSocket from 'ws';
import { encode, decode } from '@msgpack/msgpack';
const mode = process.argv[2] || 'text';

function fishPcm16k(text) {
  return new Promise((res, rej) => {
    const chunks = [];
    const ws = new WebSocket('wss://api.fish.audio/v1/tts/live', { headers: { Authorization: 'Bearer ' + process.env.FISH_API_KEY, model: 's2.1-pro' } });
    ws.on('open', () => { ws.send(encode({ event: 'start', request: { text: '', format: 'pcm', sample_rate: 16000, latency: 'balanced' } })); ws.send(encode({ event: 'text', text })); ws.send(encode({ event: 'stop' })); });
    ws.on('message', (m) => { const d = decode(m); if (d.event === 'audio') chunks.push(Buffer.from(d.audio)); if (d.event === 'finish') { ws.close(); res(Buffer.concat(chunks)); } });
    ws.on('error', rej);
  });
}

const ws = new WebSocket('ws://127.0.0.1:8787/session', { origin: 'http://localhost:5173' });
let t0 = 0, audio = 0, firstAudio = 0, text = '';
ws.on('message', (d, bin) => {
  if (bin) { if (!firstAudio) { firstAudio = Date.now() - t0; console.log(`  first audio ${firstAudio} ms after end of input`); } audio += d.length; return; }
  const m = JSON.parse(d.toString());
  if (m.type === 'reply_text') { text += m.delta; return; }
  if (m.type === 'user_partial') return;
  console.log(' ', m.type, m.text || m.value || m.message || '');
  if (m.type === 'user_final' && mode !== 'text') console.log(`  (end-of-turn detected ${Date.now() - t0} ms after speech ended)`);
  if (m.type === 'reply_end' || m.type === 'error') { console.log(`  reply: ${text}\n  audio: ${(audio / 48000).toFixed(1)} s`); ws.close(); setTimeout(() => process.exit(0), 200); }
});
ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'config', persona: process.argv[3] || 'sweet' }));
  if (mode === 'text') { t0 = Date.now(); return ws.send(JSON.stringify({ type: 'text', text: 'Hey, how was your day?' })); }
  const pcm = await fishPcm16k('Hey, what is your favorite color, and why?');
  console.log(`  synthetic user speech: ${(pcm.length / 32000).toFixed(1)} s`);
  const frame = 2560, silence = Buffer.alloc(frame);
  for (let i = 0; i < pcm.length; i += frame) { ws.send(pcm.subarray(i, i + frame)); await new Promise((r) => setTimeout(r, 80)); }
  t0 = Date.now();
  for (let i = 0; i < 100 && ws.readyState === 1; i++) { ws.send(silence); await new Promise((r) => setTimeout(r, 80)); }
});
ws.on('error', (e) => console.log('client error', e.message));
setTimeout(() => { console.log('timeout'); process.exit(1); }, 40000);
