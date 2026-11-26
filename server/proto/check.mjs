// Provider smoke tests: prints timings only, never key material.
import WebSocket from 'ws';
import { encode, decode } from '@msgpack/msgpack';
const E = process.env;

async function deepgram() {
  const d = await fetch('https://api.deepgram.com/v1/auth/grant', { method: 'POST', headers: { Authorization: 'Token ' + E.DEEPGRAM_API_KEY, 'content-type': 'application/json' }, body: '{}' });
  const j = await d.json();
  console.log('deepgram grant', d.status, j.err_code || '', j.err_msg || '');
  await new Promise((res) => {
    const t0 = Date.now();
    const ws = new WebSocket('wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000', { headers: { Authorization: 'Token ' + E.DEEPGRAM_API_KEY } });
    ws.on('message', (m) => { console.log('deepgram ws', Date.now() - t0, 'ms', m.toString().slice(0, 120)); ws.close(); });
    ws.on('unexpected-response', (_r, r) => { console.log('deepgram ws http', r.statusCode, r.headers['dg-error'] || ''); res(); });
    ws.on('error', (e) => { console.log('deepgram ws error', e.message); res(); });
    ws.on('close', res);
  });
}

async function venice(model) {
  const t0 = Date.now();
  const r = await fetch('https://api.venice.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + E.VENICE_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, max_completion_tokens: 80, messages: [{ role: 'system', content: 'You are a playful companion. Reply in one or two short spoken sentences.' }, { role: 'user', content: 'hey, how was your day?' }], venice_parameters: { include_venice_system_prompt: false, disable_thinking: true, strip_thinking_response: true } }),
  });
  if (!r.ok) return console.log('venice', model, r.status, (await r.text()).slice(0, 200));
  let first = 0, text = '', buf = '';
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      const c = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content;
      if (c) { if (!first) first = Date.now() - t0; text += c; }
    }
  }
  console.log(`venice ${model}: first token ${first} ms, total ${Date.now() - t0} ms :: ${text.replace(/\s+/g, ' ').slice(0, 110)}`);
}

async function fish(model, latency) {
  await new Promise((res) => {
    const t0 = Date.now(); let open = 0, first = 0, bytes = 0, n = 0;
    const ws = new WebSocket('wss://api.fish.audio/v1/tts/live', { headers: { Authorization: 'Bearer ' + E.FISH_API_KEY, model } });
    setTimeout(() => ws.terminate(), 20000);
    ws.on('open', () => {
      open = Date.now() - t0;
      ws.send(encode({ event: 'start', request: { text: '', format: 'pcm', sample_rate: 24000, latency, chunk_length: 100 } }));
      ws.send(encode({ event: 'text', text: '[soft tone] Hey you. I was just thinking about you, how was your day? ' }));
      ws.send(encode({ event: 'flush' }));
      setTimeout(() => ws.send(encode({ event: 'stop' })), 300);
    });
    ws.on('message', (m) => {
      const d = decode(m);
      if (d.event === 'audio') { if (!first) first = Date.now() - t0 - open; bytes += d.audio.length; n++; }
      else { console.log('fish event', JSON.stringify(d).slice(0, 200)); if (d.event === 'finish') ws.close(); }
    });
    ws.on('unexpected-response', (_r, r) => { console.log('fish http', r.statusCode); res(); });
    ws.on('error', (e) => { console.log('fish error', e.message); res(); });
    ws.on('close', (c) => { console.log(`fish ${model}/${latency}: connect ${open} ms, first audio ${first} ms after connect, ${n} chunks, ${bytes} bytes = ${(bytes / 48000).toFixed(2)} s if 16-bit mono 24k, done ${Date.now() - t0} ms, close ${c}`); res(); });
  });
}

const which = process.argv[2];
if (!which || which === 'dg') await deepgram();
if (!which || which === 'venice') for (const m of (process.argv[3] || 'venice-uncensored-role-play,venice-uncensored-1-2,glm-5-3-flash-uncensored,deepseek-v4-1-flash-uncensored').split(',')) await venice(m);
if (!which || which === 'fish') { await fish('s2.1-pro', 'balanced'); await fish('s2.1-pro', 'low'); await fish('s2.1-pro-free', 'low'); }
