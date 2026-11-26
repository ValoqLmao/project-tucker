// Cloudflare Workers host for the session server.
// The Worker answers the small HTTP endpoints; each voice conversation runs in its own Durable
// Object, which holds the browser's WebSocket and the outbound ones to the speech providers.
import { startSession } from './src/session.js';
import { personaList } from './src/personas.js';
import { FISH_OFFICIAL, usableVoice, publicVoice } from './src/voices.js';
import { issueToken, checkToken, sameString, tokenSecret, makeLimiter, clientKey } from './src/auth.js';

const SESSION_LIMIT_MS = 45 * 60 * 1000;
const MAX_SESSIONS_PER_CLIENT = 2;
const allowGuess = makeLimiter();
const voiceCache = new Map(); // search term -> { at, body }

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get('origin');
    if (!origin || !allowed.includes(origin)) return json({ error: 'forbidden' }, 403);
    const cors = { 'access-control-allow-origin': origin, vary: 'origin' };
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET,HEAD,POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } });
    }

    // A public deployment without a gate lets anyone spend the owner's API credit, so that has to be asked for.
    const gated = !!env.ACCESS_CODE;
    if (!gated && env.OPEN_ACCESS !== 'yes') return json({ error: 'Server is not configured: set the ACCESS_CODE secret.' }, 503, cors);
    const authed = async () => !gated || checkToken(tokenSecret(env), url.searchParams.get('t'));

    if (url.pathname === '/config') return json({ gate: gated }, 200, cors);

    if (url.pathname === '/auth' && req.method === 'POST') {
      if (!gated) return json({ token: '' }, 200, cors);
      if (!allowGuess(req.headers.get('cf-connecting-ip') || 'unknown')) return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429, cors);
      const body = await req.json().catch(() => ({}));
      if (!sameString(String(body.code ?? ''), env.ACCESS_CODE)) return json({ error: 'That code is not right.' }, 401, cors);
      return json({ token: await issueToken(tokenSecret(env)) }, 200, cors);
    }

    if (url.pathname === '/personas') return json(personaList(), 200, cors);

    // Character models and animation clips live in R2 (they are far too big for Pages) and are
    // only handed to visitors who have entered the access code.
    if (url.pathname.startsWith('/assets/')) {
      if (!env.ASSETS) return json({ error: 'no asset store configured' }, 404, cors);
      if (!(await authed())) return json({ error: 'unauthorized' }, 401, cors);
      let key = '';
      try { key = decodeURIComponent(url.pathname.slice('/assets/'.length)); } catch {}
      if (key.replace(/^\/+/, '').toLowerCase().startsWith('recordings')) return json({ error: 'not found' }, 404, cors); // recordings are never served
      if (key === 'index.json') {
        const list = await env.ASSETS.list({ prefix: 'models/', limit: 200 });
        const models = list.objects.map((o) => o.key.slice('models/'.length)).filter((n) => /\.vrm$/i.test(n)).sort();
        return json(models, 200, { ...cors, 'cache-control': 'private, max-age=60' });
      }
      if (!/^(models|animations)\/[\w .()-]+\.(vrm|vrma)$/i.test(key)) return json({ error: 'not found' }, 404, cors);
      const headers = { ...cors, 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=604800' };
      if (req.method === 'HEAD') {
        const head = await env.ASSETS.head(key);
        return head ? new Response(null, { status: 200, headers: { ...headers, 'content-length': String(head.size) } }) : json({ error: 'not found' }, 404, cors);
      }
      const obj = await env.ASSETS.get(key);
      if (!obj) return json({ error: 'not found' }, 404, cors);
      return new Response(obj.body, { status: 200, headers: { ...headers, 'content-length': String(obj.size), etag: obj.httpEtag } });
    }

    if (url.pathname === '/voices') {
      if (!(await authed())) return json({ error: 'unauthorized' }, 401, cors);
      const term = (url.searchParams.get('q') || '').trim().slice(0, 60);
      const hit = voiceCache.get(term);
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) return json(hit.body, 200, cors);
      const q = new URLSearchParams({ page_size: '100', sort_by: 'task_count', language: 'en' });
      if (term) { q.set('title', term); q.set('page_size', '40'); } else q.set('author_id', FISH_OFFICIAL);
      const r = await fetch('https://api.fish.audio/model?' + q, { headers: { Authorization: 'Bearer ' + env.FISH_API_KEY } }).catch(() => null);
      if (!r?.ok) return json({ error: 'voice library unavailable' }, 502, cors);
      const { items = [] } = await r.json();
      const body = items.filter(usableVoice).filter((v) => term || v.tags?.includes('female')).map(publicVoice);
      if (voiceCache.size > 200) voiceCache.clear();
      voiceCache.set(term, { at: Date.now(), body });
      return json(body, 200, cors);
    }

    if (url.pathname === '/session') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected a WebSocket' }, 426, cors);
      if (!(await authed())) return json({ error: 'unauthorized' }, 401, cors);
      // One Durable Object per client address hosts that client's conversations, which is what lets
      // it count them and refuse more than a couple at once.
      const who = clientKey(req.headers.get('cf-connecting-ip'));
      return env.SESSION.get(env.SESSION.idFromName('client:' + who)).fetch(req);
    }

    return json({ error: 'not found' }, 404, cors);
  },
};

/** Wrap a Workers WebSocket in the small shape session.js expects. */
function wrap(ws) {
  try { ws.binaryType = 'arraybuffer'; } catch {}
  const s = {
    send: (d) => { try { ws.send(d); } catch {} },
    close: () => { try { ws.close(1000, 'done'); } catch {} },
    onmessage: null,
    onclose: null,
  };
  let closed = false;
  const end = () => { if (!closed) { closed = true; s.onclose?.(); } };
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') s.onmessage?.(e.data, false);
    else s.onmessage?.(new Uint8Array(e.data), true);
  });
  ws.addEventListener('close', end);
  ws.addEventListener('error', end);
  return s;
}

const PART = 5 * 1024 * 1024; // R2 multipart: every part but the last must be this exact size

export class Session {
  constructor(state, env) { this.state = state; this.env = env; this.active = 0; }

  /** Where recordings go: the bucket, under recordings/. */
  recorder() {
    const bucket = this.env.ASSETS, keep = (p) => { this.state.waitUntil(p); return p; };
    return {
      put: (key, data, type) => keep(bucket.put(key, data, { httpMetadata: { contentType: type } })),
      // A file that grows as the conversation goes, sent as a multipart upload so it never has to
      // sit in memory whole. The first part carries the header, which needs the final length, so
      // that one part is held back and uploaded last.
      open: (key, type, headerFor) => {
        let buf = new Uint8Array(PART), used = 44, size = 0, first = null, n = 1, upload = null;
        const parts = [];
        let chain = Promise.resolve();
        const next = (fn) => { chain = chain.then(fn).catch((e) => console.log('recording failed', e?.message || e)); keep(chain); };
        const flushFull = () => {
          const full = buf, number = n++;
          buf = new Uint8Array(PART);
          used = 0;
          if (number === 1) { first = full; return; }
          next(async () => {
            upload ??= await bucket.createMultipartUpload(key, { httpMetadata: { contentType: type } });
            parts.push(await upload.uploadPart(number, full));
          });
        };
        return {
          write(bytes) {
            size += bytes.length;
            for (let at = 0; at < bytes.length;) {
              const take = Math.min(PART - used, bytes.length - at);
              buf.set(bytes.subarray(at, at + take), used);
              used += take;
              at += take;
              if (used === PART) flushFull();
            }
          },
          close() {
            const tail = buf.subarray(0, used), tailNumber = n;
            next(async () => {
              const header = headerFor(size);
              if (!first) { // short conversation: everything fits in one ordinary upload
                tail.set(header, 0);
                return bucket.put(key, tail, { httpMetadata: { contentType: type } });
              }
              first.set(header, 0);
              upload ??= await bucket.createMultipartUpload(key, { httpMetadata: { contentType: type } });
              parts.push(await upload.uploadPart(1, first));
              if (tail.length) parts.push(await upload.uploadPart(tailNumber, tail));
              await upload.complete(parts.sort((x, y) => x.partNumber - y.partNumber));
            });
          },
        };
      },
    };
  }

  async fetch() {
    if (this.active >= MAX_SESSIONS_PER_CLIENT) return json({ error: 'Too many conversations open from this connection.' }, 429);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.active++;
    let counted = true;
    const release = () => { if (counted) { counted = false; this.active--; } };
    server.addEventListener('close', release);
    server.addEventListener('error', release);

    // Outbound WebSockets from a Worker are opened with fetch + Upgrade, which is also the only
    // way to send the Authorization header the speech providers require.
    const openUpstream = async (url, headers) => {
      const res = await fetch(url.replace(/^wss:/, 'https:'), { headers: { ...headers, Upgrade: 'websocket' } });
      if (!res.webSocket) throw new Error(`upstream refused the connection (HTTP ${res.status})`);
      res.webSocket.accept();
      return wrap(res.webSocket);
    };

    // Conversations are recorded into the bucket under recordings/, which the /assets route never serves.
    const store = this.env.ASSETS && this.env.RECORD !== 'off' ? this.recorder() : null;
    startSession({ client: wrap(server), openUpstream, env: this.env, store, log: (...a) => console.log(...a) });
    // The slot is freed here too, in case the close event never arrives for a dead connection.
    setTimeout(() => { try { server.close(1000, 'session time limit'); } catch {} release(); }, SESSION_LIMIT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }
}
