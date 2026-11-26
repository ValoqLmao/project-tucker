// One voice conversation. Runtime-agnostic: the host (Node, Cloudflare) supplies the sockets.
//
// Browser -> server:  binary = mic audio (PCM16 mono 16 kHz, ~80 ms frames)
//                     JSON   = {type:'config', persona, voice} | {type:'text', text} | {type:'interrupt'}
// Server -> browser:  binary = voice audio for the current reply (PCM16 mono 24 kHz)
//                     JSON   = user_start | user_partial | user_final | reply_start | reply_text |
//                              emotion | reply_end | interrupt | error
import { encode, decode } from '@msgpack/msgpack';
import { PERSONAS } from './personas.js';
import { voiceAllowed } from './voices.js';

const STT_URL =
  'wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.7&eot_timeout_ms=3000';
const TTS_URL = 'wss://api.fish.audio/v1/tts/live';
// Any OpenAI-compatible chat API works. OpenRouter is used when its key is present, otherwise Venice.
const llmConfig = (env) => env.OPENROUTER_API_KEY
  ? { url: 'https://openrouter.ai/api/v1/chat/completions', key: env.OPENROUTER_API_KEY, model: env.LLM_MODEL || 'thedrummer/unslopnemo-12b',
      // Tried in order when the one before is rate-limited or down. (OpenRouter's own `models`
      // fallback did not catch upstream rate limits on streamed requests, so this is done here.)
      fallbacks: ['thedrummer/cydonia-24b-v4.1', 'sao10k/l3.1-euryale-70b'], extra: {} }
  : { url: 'https://api.venice.ai/api/v1/chat/completions', key: env.VENICE_API_KEY, model: env.LLM_MODEL || env.VENICE_MODEL || 'venice-uncensored-role-play',
      fallbacks: [], extra: { venice_parameters: { include_venice_system_prompt: false, disable_thinking: true, strip_thinking_response: true } } };
export const TTS_SAMPLE_RATE = 24000;
const MAX_TURNS = 40; // messages of history sent to the model

// Delivery cues the model writes -> the expression the avatar should make (names from the app's
// face.ts) and how strongly. Models also invent cues, so this matches on keywords, first hit wins.
const CUE_EXPRESSION = [
  [/laugh|giggl|cackl|snort|crack/, 'laughing', 0.9],
  [/chuckl|amus|grin/, 'happy', 0.7],
  [/excit|thrill|eager|delight|cheer|bright/, 'excited', 0.75],
  [/teas|playful|mischie|wink|cheeky/, 'teasing', 0.8],
  [/smug|smirk|sarcas|mock|sly|snark|scoff|dry|wry/, 'smug', 0.75],
  [/flirt|sultry|seduc|purr|husky|breath|whisper|low voice/, 'flirty', 0.75],
  [/shy|blush|fluster|embarrass|bashful/, 'shy', 0.85],
  [/curious|intrigu|interest|wonder/, 'curious', 0.7],
  [/surpris|gasp|shock|startl|wide/, 'surprised', 0.85],
  [/think|ponder|hmm|consider|hesitat/, 'thinking', 0.7],
  [/concern|worr|gentle|sympath|tender|care/, 'concerned', 0.65],
  [/sob|cry|sad|heartbr|lonely|melanch/, 'sad', 0.8],
  [/sigh|tired|weary|resign|exasper/, 'sigh', 0.7],
  [/pout|sulk|whin/, 'pout', 0.8],
  [/annoy|irritat|grump|grumbl|bitter|unimpress|eye ?roll/, 'annoyed', 0.75],
  [/angr|furious|shout|scream|rage|growl|snap/, 'angry', 0.85],
  [/deadpan|flat|bored|monotone|blank/, 'deadpan', 0.7],
  [/happy|smil|glad|proud|pleased/, 'happy', 0.6],
  [/warm|fond|affection|loving|sweet/, 'warm', 0.7],
  [/soft|calm|relax|sooth|quiet|content/, 'soft', 0.6],
];
function emotionFor(cue) {
  const c = cue.toLowerCase();
  const hit = CUE_EXPRESSION.find(([re]) => re.test(c));
  return hit && { value: hit[1], strength: hit[2] };
}

/** PCM16 mono chunks -> one WAV file. */
function wav(chunks, sampleRate) {
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(44 + size);
  const v = new DataView(out.buffer);
  const tag = (at, s) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + size, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, size, true);
  let at = 44;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const MIC_RATE = 16000;
const PREROLL_FRAMES = 15; // ~1.2 s kept from before speech is detected, so the first word is not clipped
const MAX_TURN_FRAMES = 1125; // ~90 s of microphone audio per turn
const MAX_REPLY_BYTES = 6 * 1024 * 1024; // ~2 minutes of voice per reply

/**
 * @param client       {send(data), close()} plus assignable onmessage(data, isBinary) / onclose()
 * @param openUpstream (url, headers) => Promise<same socket shape>
 * @param env          {DEEPGRAM_API_KEY, FISH_API_KEY, OPENROUTER_API_KEY | VENICE_API_KEY, LLM_MODEL?, FISH_MODEL?, LLM_STUB?}
 * @param store        optional {put(key, data, contentType)}: where conversations are recorded.
 *                     Each session gets a folder holding transcript.json plus one WAV per spoken turn.
 */
export function startSession({ client, openUpstream, env, store = null, log = () => {} }) {
  let persona = PERSONAS.mommy;
  let voice = null;
  const history = [];
  let stt = null, sttOpening = null, sttBacklog = [];
  let reply = null, replySeq = 0, warmTts = null, closed = false;

  const send = (o) => { if (!closed) try { client.send(JSON.stringify(o)); } catch {} };
  const fail = (where, e) => { log(where, e?.message || e); send({ type: 'error', where, message: String(e?.message || e).slice(0, 200) }); };

  // ---- recording --------------------------------------------------------------
  const startedAt = new Date();
  const sessionId = startedAt.toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
  const folder = `recordings/${sessionId.slice(0, 10)}/${sessionId}`;
  const record = { id: sessionId, startedAt: startedAt.toISOString(), llm: llmConfig(env).model, turns: [] };
  let turnSeq = 0;
  const putSafe = (key, data, type) => { try { Promise.resolve(store.put(key, data, type)).catch((e) => log('recording failed', e?.message || e)); } catch (e) { log('recording failed', e?.message || e); } };
  const saveAudio = (name, chunks, rate) => {
    if (!store || !chunks?.length) return null;
    putSafe(`${folder}/${name}`, wav(chunks, rate), 'audio/wav');
    return name;
  };
  const saveTranscript = () => { if (store && record.turns.length) putSafe(`${folder}/transcript.json`, JSON.stringify(record, null, 1), 'application/json'); };
  const pad = (n) => String(n).padStart(3, '0');
  let preroll = [], capturing = null;

  // ---- speech to text -------------------------------------------------------
  function onMicAudio(frame) {
    if (store) {
      if (capturing) { if (capturing.length < MAX_TURN_FRAMES) capturing.push(frame); }
      else { preroll.push(frame); if (preroll.length > PREROLL_FRAMES) preroll.shift(); }
    }
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
      if (store && !capturing) { capturing = preroll; preroll = []; }
      warmTts ??= openTts(); // connecting takes ~300 ms, so do it while they speak
    } else if (m.event === 'Update' || m.event === 'TurnResumed') {
      send({ type: 'user_partial', text: m.transcript });
    } else if (m.event === 'EndOfTurn') {
      const audio = capturing;
      capturing = null;
      if (m.transcript.trim()) respond(m.transcript.trim(), audio);
    }
  }

  // ---- text to speech -------------------------------------------------------
  function openTts() {
    const p = openUpstream(TTS_URL, { Authorization: 'Bearer ' + env.FISH_API_KEY, model: env.FISH_MODEL || 's2.1-pro' });
    p.catch(() => {});
    return p;
  }

  // ---- language model -------------------------------------------------------
  /** Yields text as it arrives. Sets info.truncated if the model ran into its length limit mid-thought. */
  async function* llmStream(signal, info) {
    if (env.LLM_STUB) {
      for (const w of '[chuckling] This is a canned line, because the language model is switched off. But hey, at least you can hear me.'.split(/(?<= )/)) {
        await new Promise((r) => setTimeout(r, 25));
        yield w;
      }
      return;
    }
    const llm = llmConfig(env);
    let res, problem = '';
    for (const model of [llm.model, ...llm.fallbacks.filter((m) => m !== llm.model)]) {
      res = await fetch(llm.url, {
        method: 'POST',
        signal,
        headers: { Authorization: 'Bearer ' + llm.key, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          max_tokens: 260,
          temperature: 0.9,
          messages: [{ role: 'system', content: persona.prompt }, ...history.slice(-MAX_TURNS)],
          ...llm.extra,
        }),
      });
      if (res.ok) break;
      problem = `LLM ${res.status}: ${(await res.text()).slice(0, 160)}`;
      log('model unavailable, trying the next one:', model, res.status);
      // Only a busy or missing model is worth retrying elsewhere; a bad key or no credit is not.
      if (![404, 408, 429, 500, 502, 503, 504, 529].includes(res.status)) break;
    }
    if (!res.ok) throw new Error(problem);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:') || line.endsWith('[DONE]')) continue;
        let choice;
        try { choice = JSON.parse(line.slice(5)).choices?.[0]; } catch {}
        if (choice?.finish_reason === 'length') info.truncated = true;
        if (choice?.delta?.content) yield choice.delta.content;
      }
    }
  }

  // ---- one reply ------------------------------------------------------------
  async function respond(userText, userAudio = null) {
    interrupt();
    const n = ++turnSeq;
    const r = (reply = { id: ++replySeq, n, ac: new AbortController(), tts: null, text: '', done: false, audio: [], audioBytes: 0, firstAudio: 0, truncated: false, at: '' });
    const live = () => reply === r && !closed;
    history.push({ role: 'user', content: userText });
    record.turns.push({ n, role: 'user', at: new Date().toISOString(), source: userAudio ? 'voice' : 'text', text: userText, audio: saveAudio(`${pad(n)}-user.wav`, userAudio, MIC_RATE) });
    send({ type: 'user_final', text: userText });
    send({ type: 'reply_start', id: r.id });
    const t0 = Date.now();
    r.at = new Date().toISOString();

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
          if (!r.firstAudio) { r.firstAudio = Date.now() - t0; log('first audio after', r.firstAudio, 'ms'); }
          if (!pcm.length) return;
          client.send(pcm);
          if (store && r.audioBytes < MAX_REPLY_BYTES) { r.audio.push(pcm); r.audioBytes += pcm.length; }
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

    // Text is released a whole sentence at a time, to the voice engine and to the captions together.
    // That lets her start speaking early, and means a reply that hits the model's length limit can
    // be ended at its last complete sentence instead of trailing off mid-word.
    let pending = '';
    const speak = async (final) => {
      // Hold back a half-written [cue] so it is never split across two sends.
      const open = pending.lastIndexOf('[');
      const cut = !final && open > pending.lastIndexOf(']') && pending.length - open < 40 ? open : pending.length;
      const out = pending.slice(0, cut);
      pending = pending.slice(cut);
      if (!out.trim()) return;
      for (const [, cue] of out.matchAll(/\[([a-z ,']+)\]/gi)) {
        const emotion = emotionFor(cue);
        if (emotion) send({ type: 'emotion', ...emotion });
      }
      const tts = await ttsReady;
      if (!live()) return;
      r.text += out;
      send({ type: 'reply_text', id: r.id, delta: out });
      // Models like to wrap spoken lines in quotes or asterisks; the voice engine should not see them.
      tts.send(encode({ event: 'text', text: out.replace(/["“”*]/g, '') }));
      tts.send(encode({ event: 'flush' }));
    };
    const SENTENCE_END = /[.!?…]["')\]]*\s*$/;

    try {
      const info = { truncated: false };
      for await (const delta of llmStream(r.ac.signal, info)) {
        if (!live()) return;
        pending += delta;
        if (SENTENCE_END.test(pending) || /\n\s*$/.test(pending) || pending.length > 220) await speak(false);
      }
      if (info.truncated) {
        // Out of room mid-sentence: keep only what ends cleanly.
        r.truncated = true;
        const whole = pending.match(/^[\s\S]*[.!?…]["')\]]*(?=\s|$)/);
        pending = whole ? whole[0] : '';
      }
      await speak(true);
      if (live()) (await ttsReady).send(encode({ event: 'stop' }));
    } catch (e) {
      if (!live()) return;
      fail('reply', e);
      interrupt();
    }
  }

  function logReply(r, interrupted) {
    if (!r.text.trim() && !r.audio.length) return saveTranscript();
    record.turns.push({
      n: r.n, role: 'assistant', at: r.at, persona: persona.name, voice: voice || persona.voice || null, text: r.text.trim(),
      firstAudioMs: r.firstAudio || null, interrupted, truncated: r.truncated, audio: saveAudio(`${pad(r.n)}-assistant.wav`, r.audio, TTS_SAMPLE_RATE),
    });
    r.audio = [];
    saveTranscript();
  }

  function finish(r) {
    if (reply !== r || r.done) return;
    r.done = true;
    reply = null;
    if (r.text.trim()) history.push({ role: 'assistant', content: r.text.trim() });
    logReply(r, false);
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
    logReply(r, true);
    send({ type: 'interrupt', id: r.id });
  }

  // ---- browser messages -----------------------------------------------------
  client.onmessage = (data, isBinary) => {
    if (isBinary) return onMicAudio(data);
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'config') {
      if (PERSONAS[m.persona] && PERSONAS[m.persona] !== persona) { persona = PERSONAS[m.persona]; history.length = 0; voice = null; interrupt(); }
      if (typeof m.voice === 'string' && /^[a-f0-9]{16,64}$/i.test(m.voice)) {
        const want = m.voice, forPersona = persona;
        voiceAllowed(want, env.FISH_API_KEY).then((ok) => {
          if (persona !== forPersona || closed) return;
          if (ok) voice = want;
          else send({ type: 'error', where: 'voice', message: 'That voice is not available here.' });
        });
      } else if (m.voice === null) voice = null;
    } else if (m.type === 'text' && typeof m.text === 'string' && m.text.trim()) {
      respond(m.text.trim().slice(0, 2000));
    } else if (m.type === 'interrupt') {
      interrupt();
    }
  };
  client.onclose = () => {
    const r = reply;
    if (r) { reply = null; r.ac.abort(); try { r.tts?.close(); } catch {} logReply(r, true); }
    closed = true;
    try { stt?.send(JSON.stringify({ type: 'CloseStream' })); stt?.close(); } catch {}
    warmTts?.then((t) => t.close()).catch(() => {});
  };
}
