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

/** One key per client: the address itself for IPv4, the /64 network for IPv6 (a single user owns the whole /64). */
export function clientKey(ip) {
  const s = String(ip || 'unknown').toLowerCase();
  return s.includes(':') ? s.split(':').slice(0, 4).join(':') : s;
}

/**
 * Small in-memory limiter for code guesses: `max` tries per `windowMs` per client. Best effort
 * (memory is per process or isolate), so the access code itself must be long and random.
 */
export function makeLimiter(max = 8, windowMs = 10 * 60 * 1000, capacity = 5000) {
  const seen = new Map();
  return (ip) => {
    const key = clientKey(ip), now = Date.now();
    const e = seen.get(key);
    if (e && now - e.start <= windowMs) return ++e.n <= max;
    if (seen.size >= capacity) {
      // Make room by dropping expired entries only; never forget a client still inside its window.
      for (const [k, v] of seen) if (now - v.start > windowMs) seen.delete(k);
      if (seen.size >= capacity) return false; // full of live entries: refuse rather than reset
    }
    seen.set(key, { start: now, n: 1 });
    return true;
  };
}
