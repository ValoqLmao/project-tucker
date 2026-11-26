// One voice conversation. Runtime-agnostic: the host (Node, Cloudflare) supplies the sockets.
//
// Browser -> server:  binary = mic audio (PCM16 mono 16 kHz, ~80 ms frames)
//                     JSON   = {type:'config', persona, voice} | {type:'text', text} | {type:'interrupt'}
// Server -> browser:  binary = voice audio for the current reply (PCM16 mono 24 kHz)
//                     JSON   = user_start | user_partial | user_final | reply_start | reply_text |
//                              emotion | reply_end | interrupt | error
import { encode, decode } from '@msgpack/msgpack';
import { PERSONAS } from './personas.js';

const STT_URL =
  'wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.7&eot_timeout_ms=3000';
const TTS_URL = 'wss://api.fish.audio/v1/tts/live';
// Any OpenAI-compatible chat API works. OpenRouter is used when its key is present, otherwise Venice.
const llmConfig = (env) => env.OPENROUTER_API_KEY
  ? { url: 'https://openrouter.ai/api/v1/chat/completions', key: env.OPENROUTER_API_KEY, model: env.LLM_MODEL || 'thedrummer/unslopnemo-12b',
      // OpenRouter moves down this list when a model is rate-limited or unavailable.
      extra: { models: [env.LLM_MODEL || 'thedrummer/unslopnemo-12b', 'thedrummer/cydonia-24b-v4.1', 'sao10k/l3.1-euryale-70b'] } }
  : { url: 'https://api.venice.ai/api/v1/chat/completions', key: env.VENICE_API_KEY, model: env.LLM_MODEL || env.VENICE_MODEL || 'venice-uncensored-role-play',
      extra: { venice_parameters: { include_venice_system_prompt: false, disable_thinking: true, strip_thinking_response: true } } };
export const TTS_SAMPLE_RATE = 24000;
const MAX_TURNS = 40; // messages of history sent to the model

// Voice cues the model may write -> the face the avatar should make.
const CUE_EMOTION = {
  laughing: 'happy', chuckling: 'happy', excited: 'happy', happy: 'happy', delighted: 'happy', proud: 'happy',
  sad: 'sad', sobbing: 'sad', sighing: 'sad', disappointed: 'sad', worried: 'sad',
  angry: 'angry', shouting: 'angry', frustrated: 'angry', sarcastic: 'angry', disdainful: 'angry',
  surprised: 'surprised', gasping: 'surprised', confused: 'surprised',
  whispering: 'relaxed', 'soft tone': 'relaxed', calm: 'relaxed', relaxed: 'relaxed',
};

// Models also invent their own cues ([smiling], [winking]), so fall back to keywords.
const CUE_KEYWORDS = [
  [/laugh|chuckl|giggl|smil|grin|cheer|excit|happy|delight|playful|teas|wink|proud|bright/, 'happy'],
  [/sad|sob|cry|sigh|disappoint|worr|lonely|pout/, 'sad'],
  [/angr|shout|scream|frustrat|sarcas|disdain|annoy|scoff|growl|mock|deadpan/, 'angry'],
  [/surpris|gasp|shock|confus/, 'surprised'],
  [/whisper|soft|calm|relax|gentl|warm|purr|breath|sultry|husky/, 'relaxed'],
];
function emotionFor(cue) {
  const c = cue.toLowerCase();
  return CUE_EMOTION[c] || CUE_KEYWORDS.find(([re]) => re.test(c))?.[1];
}

/**
 * @param client      {send(data), close()} plus assignable onmessage(data, isBinary) / onclose()
 * @param openUpstream (url, headers) => Promise<same socket shape>
 * @param env          {DEEPGRAM_API_KEY, FISH_API_KEY, VENICE_API_KEY, VENICE_MODEL?, FISH_MODEL?, LLM_STUB?}
 */
export function startSession({ client, openUpstream, env, log = () => {} }) {
  let persona = PERSONAS.sweet;
  let voice = null;
  const history = [];
  let stt = null, sttOpening = null, sttBacklog = [];
  let reply = null, replySeq = 0, warmTts = null, closed = false;

  const send = (o) => { if (!closed) try { client.send(JSON.stringify(o)); } catch {} };
  const fail = (where, e) => { log(where, e?.message || e); send({ type: 'error', where, message: String(e?.message || e).slice(0, 200) }); };

  // ---- speech to text -------------------------------------------------------
  function onMicAudio(frame) {
    if (stt) return stt.send(frame);
    if (sttBacklog.length < 100) sttBacklog.push(frame);
    sttOpening ??= openUpstream(STT_URL, { Authorization: 'Token ' + env.DEEPGRAM_API_KEY }).then((s) => {
      if (closed) return s.close();
      stt = s;
      s.onmessage = (data, isBinary) => { if (!isBinary) onStt(JSON.parse(data.toString())); };
      s.onclose = () => { stt = null; sttOpening = null; };
      for (const f of sttBacklog) s.send(f);
      sttBacklog = [];
    }).catch((e) => { sttOpening = null; sttBacklog = []; fail('stt', e); });
  }

  function onStt(m) {
    if (m.type === 'Error') return fail('stt', m.description || m.code);
    if (m.type !== 'TurnInfo') return;
    if (m.event === 'StartOfTurn') {
      interrupt(); // they started talking: stop talking over them
      send({ type: 'user_start' });
      warmTts ??= openTts(); // connecting takes ~300 ms, so do it while they speak
    } else if (m.event === 'Update' || m.event === 'TurnResumed') {
      send({ type: 'user_partial', text: m.transcript });
    } else if (m.event === 'EndOfTurn' && m.transcript.trim()) {
      respond(m.transcript.trim());
    }
  }

  // ---- text to speech -------------------------------------------------------
  function openTts() {
    const p = openUpstream(TTS_URL, { Authorization: 'Bearer ' + env.FISH_API_KEY, model: env.FISH_MODEL || 's2.1-pro' });
    p.catch(() => {});
    return p;
  }

  // ---- language model -------------------------------------------------------
  async function* llmStream(signal) {
    if (env.LLM_STUB) {
      for (const w of '[chuckling] This is a canned line, because the language model is switched off. But hey, at least you can hear me.'.split(/(?<= )/)) {
        await new Promise((r) => setTimeout(r, 25));
        yield w;
      }
      return;
    }
    const llm = llmConfig(env);
    const res = await fetch(llm.url, {
      method: 'POST',
      signal,
      headers: { Authorization: 'Bearer ' + llm.key, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: llm.model,
        stream: true,
        max_tokens: 220,
        temperature: 0.9,
        messages: [{ role: 'system', content: persona.prompt }, ...history.slice(-MAX_TURNS)],
        ...llm.extra,
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:') || line.endsWith('[DONE]')) continue;
        let delta;
        try { delta = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content; } catch {}
        if (delta) yield delta;
      }
    }
  }

  // ---- one reply ------------------------------------------------------------
  async function respond(userText) {
    interrupt();
    const r = (reply = { id: ++replySeq, ac: new AbortController(), tts: null, text: '', done: false });
    const live = () => reply === r && !closed;
    history.push({ role: 'user', content: userText });
    send({ type: 'user_final', text: userText });
    send({ type: 'reply_start', id: r.id });
    const t0 = Date.now();
    let firstAudio = 0;

    const ttsReady = (warmTts || openTts()).then((tts) => {
      if (!live()) return tts.close();
      r.tts = tts;
      let carry = null; // keep 16-bit samples whole across chunk boundaries
      tts.onmessage = (data) => {
        const m = decode(data);
        if (m.event === 'audio' && live()) {
          let pcm = m.audio;
          if (carry) { const j = new Uint8Array(pcm.length + 1); j[0] = carry[0]; j.set(pcm, 1); pcm = j; carry = null; }
          if (pcm.length % 2) { carry = pcm.slice(-1); pcm = pcm.subarray(0, pcm.length - 1); }
          if (!firstAudio) { firstAudio = Date.now() - t0; log('first audio after', firstAudio, 'ms'); }
          if (pcm.length) client.send(pcm);
        } else if (m.event === 'finish') {
          tts.close();
          if (m.reason === 'error') fail('tts', 'voice engine reported an error');
          finish(r);
        }
      };
      tts.onclose = () => finish(r);
      tts.send(encode({
        event: 'start',
        request: { text: '', format: 'pcm', sample_rate: TTS_SAMPLE_RATE, latency: 'balanced', chunk_length: 100, ...(voice || persona.voice ? { reference_id: voice || persona.voice } : {}) },
      }));
      return tts;
    });
    warmTts = null;

    // Text goes to the voice engine sentence by sentence, so it can start speaking early.
    let pending = '';
    const speak = async (final) => {
      // Hold back a half-written [cue] so it is never split across two sends.
      const open = pending.lastIndexOf('[');
      const cut = !final && open > pending.lastIndexOf(']') && pending.length - open < 40 ? open : pending.length;
      const out = pending.slice(0, cut);
      pending = pending.slice(cut);
      if (!out) return;
      for (const [, cue] of out.matchAll(/\[([a-z ,']+)\]/gi)) {
        const emotion = emotionFor(cue);
        if (emotion) send({ type: 'emotion', value: emotion });
      }
      const tts = await ttsReady;
      if (!live()) return;
      // Models like to wrap spoken lines in quotes or asterisks; the voice engine should not see them.
      tts.send(encode({ event: 'text', text: out.replace(/["“”*]/g, '') }));
      if (/[.!?…]["')\]]?\s*$/.test(out)) tts.send(encode({ event: 'flush' }));
    };

    try {
      for await (const delta of llmStream(r.ac.signal)) {
        if (!live()) return;
        r.text += delta;
        pending += delta;
        send({ type: 'reply_text', id: r.id, delta });
        if (/[.!?…,;:\n]\s*$/.test(pending) || pending.length > 80) await speak(false);
      }
      await speak(true);
      if (live()) (await ttsReady).send(encode({ event: 'stop' }));
    } catch (e) {
      if (!live()) return;
      fail('reply', e);
      interrupt();
    }
  }

  function finish(r) {
    if (reply !== r || r.done) return;
    r.done = true;
    reply = null;
    if (r.text.trim()) history.push({ role: 'assistant', content: r.text.trim() });
    send({ type: 'reply_end', id: r.id });
  }

  /** Stop the current reply at once: the person spoke, pressed stop, or something failed. */
  function interrupt() {
    const r = reply;
    if (!r) return;
    reply = null;
    r.ac.abort();
    try { r.tts?.close(); } catch {}
    // The model should know it was cut off, roughly where.
    if (r.text.trim()) history.push({ role: 'assistant', content: r.text.trim() + ' [cut off by the user]' });
    send({ type: 'interrupt', id: r.id });
  }

  // ---- browser messages -----------------------------------------------------
  client.onmessage = (data, isBinary) => {
    if (isBinary) return onMicAudio(data);
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'config') {
      if (PERSONAS[m.persona] && PERSONAS[m.persona] !== persona) { persona = PERSONAS[m.persona]; history.length = 0; voice = null; interrupt(); }
      if (typeof m.voice === 'string' && /^[a-f0-9]{16,64}$/i.test(m.voice)) voice = m.voice;
      else if (m.voice === null) voice = null;
    } else if (m.type === 'text' && typeof m.text === 'string' && m.text.trim()) {
      respond(m.text.trim().slice(0, 2000));
    } else if (m.type === 'interrupt') {
      interrupt();
    }
  };
  client.onclose = () => {
    closed = true;
    reply?.ac.abort();
    try { reply?.tts?.close(); } catch {}
    try { stt?.send(JSON.stringify({ type: 'CloseStream' })); stt?.close(); } catch {}
    warmTts?.then((t) => t.close()).catch(() => {});
  };
}
