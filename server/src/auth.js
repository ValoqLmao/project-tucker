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

/** Small in-memory limiter for code guesses: `max` tries per `windowMs` per key. Best effort only. */
export function makeLimiter(max = 8, windowMs = 10 * 60 * 1000) {
  const seen = new Map();
  return (key) => {
    const now = Date.now();
    const e = seen.get(key);
    if (!e || now - e.start > windowMs) { if (seen.size > 5000) seen.clear(); seen.set(key, { start: now, n: 1 }); return true; }
    return ++e.n <= max;
  };
}
