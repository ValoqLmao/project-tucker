// Which voices from Fish Audio's library the app is willing to offer.

export const FISH_OFFICIAL = 'd8b0991f96b44e489422ca2ddf0bd31d'; // the "Fish Official" author account

// This is an adults-only companion: never offer a voice presented as a child or teenager.
const MINOR_WORDS =
  /\b(child|children|childlike|kids?|kiddo|teens?|teenager|teenaged?|preteen|tween|toddler|baby|infant|minor|underage|juvenile|adolescent|loli|lolita|shota|school[- ]?(girl|boy|kid)|(elementary|middle|high)[- ]?school(er)?|student|little (girl|boy|sister|brother|one)|young (girl|boy)|girl's voice|boy's voice|daughter|son|imouto|kawaii kid)\b/i;
// "9 years old", "nine-year-old", "16yo", "14 y.o.", "aged 15", "age 12"
const AGE = /\b([a-z]+(?:-[a-z]+)?|\d{1,2})\s*-?\s*(?:years?[- ]?old|yrs?[- ]?old|y\.?\s?o\.?(?![a-z]))|\baged?\s*:?\s*(\d{1,2})\b/gi;
const ADULT_AGE = /^(1[89]|[2-9]\d|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)/i;

export function usableVoice(v) {
  if (v.type !== 'tts' || v.state !== 'trained' || v.dmca_taken_down) return false;
  const text = [v.title, v.description, ...(Array.isArray(v.tags) ? v.tags : [])].join(' ');
  if (MINOR_WORDS.test(text)) return false;
  // Any stated age must be an adult one ("twenty-four years old" passes, "nine years old" does not).
  for (const [, a, b] of text.matchAll(AGE)) if (!ADULT_AGE.test(a ?? b)) return false;
  return true;
}

// A browser can send any voice id, so ids are checked against the same rules before use.
const checked = new Map(); // id -> boolean
export async function voiceAllowed(id, apiKey) {
  if (checked.has(id)) return checked.get(id);
  let ok = false;
  try {
    const r = await fetch('https://api.fish.audio/model/' + id, { headers: { Authorization: 'Bearer ' + apiKey } });
    if (r.ok) ok = usableVoice(await r.json());
    else if (r.status >= 500) return false; // library trouble: refuse now, but do not remember it
  } catch { return false; }
  if (checked.size > 2000) checked.clear();
  checked.set(id, ok);
  return ok;
}

export const publicVoice = (v) => ({
  id: v._id,
  title: v.title,
  tags: (v.tags || []).slice(0, 8),
  uses: v.task_count,
  about: (v.description || '').replace(/\s+/g, ' ').slice(0, 160),
  sample: v.samples?.[0]?.audio,
  author: v.author?.nickname,
  official: v.author?._id === FISH_OFFICIAL,
});
