// Node host for the session server: local development, or any plain VM/container host.
//   node --env-file=../.env node.mjs
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { startSession } from './src/session.js';
import { personaList } from './src/personas.js';

const PORT = Number(process.env.PORT || 8787);
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:4173').split(',');
const env = process.env;

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

  if (url.pathname === '/personas') return json(200, personaList());

  // Search Fish Audio's public voice library.
  if (url.pathname === '/voices') {
    const q = new URLSearchParams({ page_size: '24', sort_by: 'task_count', language: 'en' });
    const term = (url.searchParams.get('q') || '').slice(0, 60);
    if (term) q.set('title', term);
    try {
      const r = await fetch('https://api.fish.audio/model?' + q, { headers: { Authorization: 'Bearer ' + env.FISH_API_KEY } });
      if (!r.ok) return json(502, { error: `voice library returned ${r.status}` });
      const { items = [] } = await r.json();
      return json(200, items.map((v) => ({
        id: v._id, title: v.title, tags: v.tags, uses: v.task_count, cover: v.cover_image,
        sample: v.samples?.[0]?.audio, author: v.author?.nickname,
      })));
    } catch (e) {
      return json(502, { error: 'voice library unreachable' });
    }
  }
  json(404, { error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (new URL(req.url, 'http://x').pathname !== '/session' || (origin && !ALLOWED.includes(origin))) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    startSession({ client: wrap(ws), openUpstream, env, log: (...a) => console.log(new Date().toISOString().slice(11, 23), ...a) });
  });
});

server.listen(PORT, () => console.log(`session server on http://localhost:${PORT}`));
