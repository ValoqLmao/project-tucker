// Access gate: one shared access code, exchanged for a short-lived signed token.
// Uses only WebCrypto, so the same code runs in Node and in Cloudflare Workers.

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hmacKey = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sign = async (secret, text) => b64(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(text)));

/** Compare two strings without leaking where they differ. */
export function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The key tokens are signed with. A dedicated secret if set, otherwise derived from what is there. */
export const tokenSecret = (env) => env.TOKEN_SECRET || `${env.ACCESS_CODE}:${env.FISH_API_KEY}`;

export async function issueToken(secret, ttlSeconds = 12 * 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${exp}.${await sign(secret, String(exp))}`;
}

export async function checkToken(secret, token) {
  if (typeof token !== 'string') return false;
  const [exp, sig] = token.split('.');
  if (!/^\d+$/.test(exp || '') || !sig || Number(exp) < Date.now() / 1000) return false;
  return sameString(sig, await sign(secret, exp));
}

/**
 * One key per client: the address itself for IPv4, the /64 network for IPv6 (a single user owns
 * the whole /64). The address is expanded first, so "2001:db8::1" and its long form give one key.
 */
export function clientKey(ip) {
  let s = String(ip || 'unknown').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!s.includes(':')) return s;
  // IPv4 carried inside IPv6 (::ffff:1.2.3.4) is really an IPv4 client.
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    if (/^(::ffff:|0{0,4}(:0{0,4}){4}:ffff:)/.test(s)) return v4[1];
    const [p, q, r, t] = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((p << 8) | q).toString(16) + ':' + ((r << 8) | t).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [], t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return 'invalid:' + s.slice(0, 45);
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':');
}

/**
 * In-memory limiter for code guesses: `max` tries per `windowMs` per client, plus a ceiling on
 * guesses from everyone combined, so spreading attempts across many addresses does not help.
 * Best effort (memory is per process or isolate): the access code itself must be long and random.
 */
export function makeLimiter(max = 8, windowMs = 10 * 60 * 1000, capacity = 5000, globalMax = 300) {
  const seen = new Map(); // insertion-ordered, oldest first
  let globalStart = 0, globalCount = 0;
  return (ip) => {
    const key = clientKey(ip), now = Date.now();
    if (now - globalStart > windowMs) { globalStart = now; globalCount = 0; }
    const e = seen.get(key);
    // A client that is already over its own limit is turned away before it can touch the shared
    // budget, so one throttled client cannot use that budget up for everyone else.
    if (e && now - e.start <= windowMs) return ++e.n <= max && ++globalCount <= globalMax;
    if (++globalCount > globalMax) return false;
    seen.delete(key);
    // Full: drop the oldest entry. New clients are never locked out, and the global ceiling
    // above still bounds what an attacker gains by cycling addresses to push entries out.
    if (seen.size >= capacity) seen.delete(seen.keys().next().value);
    seen.set(key, { start: now, n: 1 });
    return true;
  };
}
