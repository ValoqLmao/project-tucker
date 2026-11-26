// Node host for the session server: local development, or any plain VM/container host.
//   node --env-file=../.env node.mjs
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { startSession } from './src/session.js';
import { personaList } from './src/personas.js';
import { FISH_OFFICIAL, usableVoice, publicVoice } from './src/voices.js';
import { issueToken, checkToken, sameString, tokenSecret, makeLimiter } from './src/auth.js';

const PORT = Number(process.env.PORT || 8787);
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:4173').split(',');
const env = process.env;
// Local-only unless a host is given on purpose. Before this is exposed publicly it also needs
// a real access gate (signed session tokens); the origin check below only stops other websites.
const HOST = process.env.HOST || '127.0.0.1';
const MAX_SESSIONS_PER_IP = 2;
const sessionsByIp = new Map();
const voiceCache = new Map(); // search term -> { at, body }
const GATED = !!env.ACCESS_CODE; // optional locally; the Cloudflare deployment requires it
const allowGuess = makeLimiter();
const authed = async (url) => !GATED || checkToken(tokenSecret(env), url.searchParams.get('t'));

/** Wrap a `ws` socket in the small shape session.js expects. */
function wrap(ws) {
  const s = { send: (d) => ws.readyState === WebSocket.OPEN && ws.send(d), close: () => ws.close(), onmessage: null, onclose: null };
  ws.on('message', (d, isBinary) => s.onmessage?.(d, isBinary));
  ws.on('close', () => s.onclose?.());
  ws.on('error', () => {});
  return s;
}

const openUpstream = (url, headers) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const s = wrap(ws);
    ws.once('open', () => resolve(s));
    ws.once('error', reject);
    ws.once('unexpected-response', (_q, res) => reject(new Error(`upstream refused the connection (HTTP ${res.statusCode})`)));
  });

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) res.setHeader('access-control-allow-origin', origin);
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type' }); return res.end(); }
  if (url.pathname === '/config') return json(200, { gate: GATED });
  if (url.pathname === '/auth' && req.method === 'POST') {
    if (!GATED) return json(200, { token: '' });
    if (!allowGuess(req.socket.remoteAddress || '?')) return json(429, { error: 'Too many attempts. Try again in a few minutes.' });
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 2000) break; }
    let code = '';
    try { code = String(JSON.parse(raw).code ?? ''); } catch {}
    if (!sameString(code, env.ACCESS_CODE)) return json(401, { error: 'That code is not right.' });
    return json(200, { token: await issueToken(tokenSecret(env)) });
  }
  if (url.pathname === '/personas') return json(200, personaList());

  // Voices. With no search term: Fish Audio's own designed voices. With one: the community library.
  if (url.pathname === '/voices') {
    if (!origin || !ALLOWED.includes(origin)) return json(403, { error: 'forbidden' });
    if (!(await authed(url))) return json(401, { error: 'unauthorized' });
    const term = (url.searchParams.get('q') || '').trim().slice(0, 60);
    const hit = voiceCache.get(term);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return json(200, hit.body);
    const q = new URLSearchParams({ page_size: '100', sort_by: 'task_count', language: 'en' });
    if (term) { q.set('title', term); q.set('page_size', '40'); } else q.set('author_id', FISH_OFFICIAL);
    try {
      const r = await fetch('https://api.fish.audio/model?' + q, { headers: { Authorization: 'Bearer ' + env.FISH_API_KEY } });
      if (!r.ok) return json(502, { error: `voice library returned ${r.status}` });
      const { items = [] } = await r.json();
      const body = items.filter(usableVoice).filter((v) => term || v.tags?.includes('female')).map(publicVoice);
      if (voiceCache.size > 200) voiceCache.clear();
      voiceCache.set(term, { at: Date.now(), body });
      return json(200, body);
    } catch (e) {
      return json(502, { error: 'voice library unreachable' });
    }
  }
  json(404, { error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', async (req, socket, head) => {
  const origin = req.headers.origin;
  if (new URL(req.url, 'http://x').pathname !== '/session' || !origin || !ALLOWED.includes(origin)) return socket.destroy();
  if (!(await authed(new URL(req.url, 'http://x')))) return socket.destroy();
  const ip = req.socket.remoteAddress || '?';
  if ((sessionsByIp.get(ip) || 0) >= MAX_SESSIONS_PER_IP) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    sessionsByIp.set(ip, (sessionsByIp.get(ip) || 0) + 1);
    ws.on('close', () => sessionsByIp.set(ip, Math.max(0, (sessionsByIp.get(ip) || 1) - 1)));
    startSession({ client: wrap(ws), openUpstream, env, log: (...a) => console.log(new Date().toISOString().slice(11, 23), ...a) });
  });
});

server.listen(PORT, HOST, () => console.log(`session server on http://localhost:${PORT}`));
