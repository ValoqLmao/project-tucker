// Which voices from Fish Audio's library the app is willing to offer.

export const FISH_OFFICIAL = 'd8b0991f96b44e489422ca2ddf0bd31d'; // the "Fish Official" author account

// This is an adults-only companion: never offer a voice presented as a child or teenager.
const MINOR_WORDS =
  /\b(child|children|kids?|teens?|teenager|teenage|toddler|baby|loli|shota|school ?girl|school ?boy|little (girl|boy|sister|brother)|young (girl|boy)|girl's voice|boy's voice)\b/i;
const AGE = /\b([a-z]+(?:-[a-z]+)?|\d{1,2})[- ](?:years?[- ]old|yo|y\/o)\b/gi;
const ADULT_AGE = /^(1[89]|[2-9]\d|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)/i;

export function usableVoice(v) {
  if (v.type !== 'tts' || v.state !== 'trained' || v.dmca_taken_down) return false;
  const text = [v.title, v.description, ...(v.tags || [])].join(' ');
  if (MINOR_WORDS.test(text)) return false;
  // Any stated age must be an adult one ("twenty-four years old" passes, "nine years old" does not).
  for (const [, age] of text.matchAll(AGE)) if (!ADULT_AGE.test(age)) return false;
  return true;
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
