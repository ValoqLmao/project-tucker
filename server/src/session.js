// One voice conversation. Runtime-agnostic: the host (Node, Cloudflare) supplies the sockets.
//
// Browser -> server:  binary = mic audio (PCM16 mono 16 kHz, ~80 ms frames). A frame of odd length
//                              starts with a channel byte: 1 = the game's voice chat (game mode).
//                     JSON   = {type:'config', persona, voice} | {type:'text', text} | {type:'interrupt'} |
//                              {type:'game', on, mode, react} | {type:'screen', jpeg} | {type:'ptt', down}
// Server -> browser:  binary = voice audio for the current reply (PCM16 mono 24 kHz)
//                     JSON   = user_start | user_partial | user_final | reply_start | reply_text |
//                              emotion | reply_end | interrupt | error | heard | saw
import { encode, decode } from '@msgpack/msgpack';
import { PERSONAS, GAME_MODE } from './personas.js';
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
// Game mode: the model that looks at the screen and says what is on it. The persona's own model
// only ever reads that description, so it does not have to be one that accepts images.
const visionConfig = (env) => env.OPENROUTER_API_KEY
  ? { url: 'https://openrouter.ai/api/v1/chat/completions', key: env.OPENROUTER_API_KEY, model: env.VISION_MODEL || 'anthropic/claude-haiku-5.5',
      extra: { reasoning: { enabled: false } } } // thinking first would use up the whole answer on a two-sentence job
  : env.VISION_MODEL ? { url: 'https://api.venice.ai/api/v1/chat/completions', key: env.VENICE_API_KEY, model: env.VISION_MODEL, extra: {} } : null;
const EYES = `You are the eyes of a voice companion who is sitting in on someone's game. You get a screenshot of the player's screen and what you said about the previous one.
Write one or two plain sentences, 45 words at most, saying what is on screen right now for someone who cannot see it: which game or app, what the player is doing, and whatever is readable of the score, round, health, kill feed, who just died or won, and any text chat. No guessing at what is not visible, no advice.
Then finish with a last line that is exactly "NOTABLE: yes" or "NOTABLE: no". Say yes only when something has happened since the previous look that a friend watching would blurt out about: a kill, a death, a clutch, a bad miss, a round or match won or lost, something funny or embarrassing. A screen that looks much the same is no.`;
const MAX_SCREEN_CHARS = 700_000; // base64 JPEG, about half a megabyte
const LOOK_EVERY_MS = 12_000; // how often he glances at the screen unprompted
const QUIET_AFTER_SPEAKING_MS = 8_000; // no unprompted reaction this soon after he last spoke
const FOLLOW_UP_MS = 12_000; // after he speaks, the next thing said may be an answer to him
const SILENT_NOTE = '[You may stay quiet here. If that was not said to you, or you have nothing to add, answer with exactly [silent] and nothing else.]';
const REACT_NOTE = '[Nobody is talking to you. If what just happened deserves a reaction, say one short line out loud. Otherwise answer with exactly [silent].]';
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

/** The 44-byte header of a PCM16 mono WAV file holding `size` bytes of audio. */
export function wavHeader(size, sampleRate) {
  const out = new Uint8Array(44);
  const v = new DataView(out.buffer);
  const tag = (at, t) => { for (let i = 0; i < 4; i++) out[at + i] = t.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + size, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, size, true);
  return out;
}

/** PCM16 mono chunks -> one WAV file. */
function wav(chunks, sampleRate) {
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(44 + size);
  out.set(wavHeader(size, sampleRate), 0);
  let at = 44;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Change the sample rate of a PCM16 mono chunk by linear interpolation (good enough for speech). */
function resample(chunk, from, to) {
  const src = new DataView(chunk.buffer, chunk.byteOffset, chunk.length - (chunk.length % 2));
  const n = src.byteLength >> 1;
  const m = Math.floor((n * to) / from);
  const out = new Uint8Array(m * 2);
  const dst = new DataView(out.buffer);
  for (let i = 0; i < m; i++) {
    const x = (i * from) / to, i0 = Math.floor(x), i1 = Math.min(n - 1, i0 + 1), f = x - i0;
    dst.setInt16(i * 2, Math.round(src.getInt16(i0 * 2, true) * (1 - f) + src.getInt16(i1 * 2, true) * f), true);
  }
  return out;
}

const MIC_RATE = 16000;
const PREROLL_FRAMES = 15; // ~1.2 s kept from before speech is detected, so the first word is not clipped
const MAX_FRAME_BYTES = 8192; // largest microphone frame accepted
const MAX_TURN_BYTES = 90 * MIC_RATE * 2; // ~90 s of microphone audio kept per turn
const MAX_REPLY_BYTES = 6 * 1024 * 1024; // ~2 minutes of voice per reply
const MAX_CONVERSATION_BYTES = 400 * 1024 * 1024; // ~2.3 hours of combined audio, far beyond the session limit

/**
 * @param client       {send(data), close()} plus assignable onmessage(data, isBinary) / onclose()
 * @param openUpstream (url, headers) => Promise<same socket shape>
 * @param env          {DEEPGRAM_API_KEY, FISH_API_KEY, OPENROUTER_API_KEY | VENICE_API_KEY, LLM_MODEL?, FISH_MODEL?, LLM_STUB?}
 * @param ptt          optional (down: boolean) => void: hold or release the push-to-talk key on this machine
 * @param store        optional {put(key, data, contentType), open?(key, contentType, headerFor)}: where
 *                     conversations are recorded. Each session gets a folder holding transcript.json,
 *                     one WAV per spoken turn, and conversation.wav: the whole exchange in order.
 */
export function startSession({ client, openUpstream, env, store = null, ptt = null, log = () => {} }) {
  let persona = PERSONAS.mommy;
  let voice = null;
  const history = [];
  // One ear per audio channel, each with its own speech-to-text connection.
  const ear = (who) => ({ who, stt: null, opening: null, backlog: [], preroll: [], capturing: null, capturedBytes: 0, talking: false });
  const ears = { mic: ear('mic'), team: ear('team') };
  const game = { on: false, mode: 'name', react: false };
  let reply = null, replySeq = 0, warmTts = null, closed = false;

  const send = (o) => { if (!closed) try { client.send(JSON.stringify(o)); } catch {} };
  const fail = (where, e) => { log(where, e?.message || e); send({ type: 'error', where, message: String(e?.message || e).slice(0, 200) }); };

  // ---- recording --------------------------------------------------------------
  const startedAt = new Date();
  // The folder name is unguessable (random UUID), on top of the bucket never being served publicly.
  const sessionId = startedAt.toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID();
  const folder = `recordings/${sessionId.slice(0, 10)}/${sessionId}`;
  const record = { id: sessionId, startedAt: startedAt.toISOString(), llm: llmConfig(env).model, turns: [] };
  let turnSeq = 0;
  // Game mode is never recorded: the other people in a voice channel have not agreed to it.
  const rec = () => (game.on ? null : store);
  const putSafe = (key, data, type) => { try { Promise.resolve(store.put(key, data, type)).catch((e) => log('recording failed', e?.message || e)); } catch (e) { log('recording failed', e?.message || e); } };
  const saveAudio = (name, chunks, rate) => {
    if (!rec() || !chunks?.length) return null;
    putSafe(`${folder}/${name}`, wav(chunks, rate), 'audio/wav');
    return name;
  };
  const saveTranscript = () => { if (rec() && record.turns.length) putSafe(`${folder}/transcript.json`, JSON.stringify(record, null, 1), 'application/json'); };
  const pad = (n) => String(n).padStart(3, '0');

  // conversation.wav: every spoken turn back to back, in the order it happened, as one file you can
  // simply play. It is written as the conversation goes, so a long session never sits in memory.
  let convo = null, convoBytes = 0;
  const GAP = new Uint8Array(Math.round(TTS_SAMPLE_RATE * 0.35) * 2); // a breath of silence between turns
  /** Append a turn to conversation.wav. Returns where it starts, in seconds, or null if not recorded. */
  function addToConversation(chunks, rate) {
    if (!rec()?.open || !chunks?.length || convoBytes > MAX_CONVERSATION_BYTES) return null;
    try {
      convo ??= store.open(`${folder}/conversation.wav`, 'audio/wav', (size) => wavHeader(size, TTS_SAMPLE_RATE));
      const at = convoBytes / (TTS_SAMPLE_RATE * 2);
      for (const c of chunks) {
        const pcm = rate === TTS_SAMPLE_RATE ? c : resample(c, rate, TTS_SAMPLE_RATE);
        convo.write(pcm);
        convoBytes += pcm.length;
      }
      convo.write(GAP);
      convoBytes += GAP.length;
      record.conversation = 'conversation.wav';
      return Math.round(at * 100) / 100;
    } catch (e) { log('recording failed', e?.message || e); return null; }
  }

  // ---- speech to text -------------------------------------------------------
  function onAudio(e, frame) {
    // The app sends 2,560-byte frames (80 ms). Anything much larger is not from the app: drop it
    // rather than forward it or hold it in memory.
    if (frame.length > MAX_FRAME_BYTES) return;
    if (rec() && e === ears.mic) {
      if (e.capturing) {
        if (e.capturedBytes + frame.length <= MAX_TURN_BYTES) { e.capturing.push(frame); e.capturedBytes += frame.length; }
      } else {
        e.preroll.push(frame);
        if (e.preroll.length > PREROLL_FRAMES) e.preroll.shift();
      }
    }
    if (e.stt) return e.stt.send(frame);
    if (e.backlog.length < 100) e.backlog.push(frame);
    // Telling the recogniser his name makes it far likelier to be heard right when someone calls him.
    const names = [persona.name, ...(persona.heardAs || [])].map((n) => '&keyterm=' + encodeURIComponent(n)).join('');
    e.opening ??= openUpstream(STT_URL + names, { Authorization: 'Token ' + env.DEEPGRAM_API_KEY }).then((s) => {
      if (closed) return s.close();
      e.stt = s;
      s.onmessage = (data, isBinary) => { if (!isBinary) onStt(e, JSON.parse(data.toString())); };
      s.onclose = () => { if (e.stt === s) { e.stt = null; e.opening = null; e.talking = false; } };
      for (const f of e.backlog) s.send(f);
      e.backlog = [];
    }).catch((err) => { e.opening = null; e.backlog = []; fail('stt', err); });
  }
  /** Drop the speech-to-text connections; they reopen, with the current name, on the next audio. */
  function resetEars() {
    for (const e of Object.values(ears)) { try { e.stt?.close(); } catch {} e.stt = null; e.opening = null; e.talking = false; e.capturing = null; e.preroll = []; }
  }

  function onStt(e, m) {
    if (m.type === 'Error') return fail('stt', m.description || m.code);
    if (m.type !== 'TurnInfo') return;
    if (m.event === 'StartOfTurn') {
      e.talking = true;
      // In a voice channel people talk to each other all the time: that must not cut him off.
      if (game.on) { if (game.mode !== 'name') lookAtScreen(); return; }
      interrupt(); // they started talking: stop talking over them
      send({ type: 'user_start' });
      if (rec() && !e.capturing) { e.capturing = e.preroll; e.capturedBytes = e.preroll.reduce((n, f) => n + f.length, 0); e.preroll = []; }
      warmTts ??= openTts(); // connecting takes ~300 ms, so do it while they speak
    } else if (m.event === 'Update' || m.event === 'TurnResumed') {
      if (!game.on) return send({ type: 'user_partial', text: m.transcript });
      // His name came up: get a fresh look at the screen and a voice connection while they finish.
      if (named(m.transcript)) { lookAtScreen(); warmTts ??= openTts(); }
    } else if (m.event === 'EndOfTurn') {
      e.talking = false;
      const audio = e.capturing;
      e.capturing = null;
      const text = m.transcript.trim();
      if (!text) return;
      if (game.on) heard(e, text);
      else respond(text, { audio });
    }
  }

  // ---- game mode ------------------------------------------------------------
  let overheard = []; // voice chat that was not for him, handed to the model with his next turn
  let lastSpokeAt = 0, lastLookAt = 0, screen = null, scene = { text: '', at: 0, of: 0 }, looking = null, visionWarned = false, watch = null;
  const named = (text) => new RegExp('\\b(' + [persona.name, ...(persona.heardAs || [])].join('|') + ')\\b', 'i').test(text);
  const anyoneTalking = () => ears.mic.talking || ears.team.talking;

  /** Something was said in the channel: answer it, maybe answer it, or just remember it. */
  function heard(e, text) {
    const line = (e === ears.mic ? 'Host: ' : 'Teammate: ') + text;
    send({ type: 'heard', text: line });
    const direct = game.mode === 'always' || named(text);
    const maybe = !direct && !reply && (game.mode === 'auto' || Date.now() - lastSpokeAt < FOLLOW_UP_MS);
    if (direct || maybe) return respond(line, { soft: maybe });
    overheard.push(line);
    if (overheard.length > 10) overheard.shift();
  }

  /** Have the vision model describe the newest screenshot. Resolves to whether something notable happened. */
  function lookAtScreen() {
    const v = visionConfig(env);
    if (looking || !v || !screen || screen.at === scene.of) return looking;
    const shot = screen;
    lastLookAt = Date.now();
    looking = (async () => {
      const res = await fetch(v.url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + v.key, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: v.model, max_tokens: 300, temperature: 0.2, ...v.extra,
          messages: [
            { role: 'system', content: EYES },
            { role: 'user', content: [
              { type: 'text', text: scene.text ? `Previous look, ${Math.round((shot.at - scene.at) / 1000)} seconds ago: ${scene.text}` : 'This is the first look.' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + shot.jpeg } },
            ] },
          ],
        }),
      });
      if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const said = String((await res.json()).choices?.[0]?.message?.content || '');
      const text = said.replace(/\s*NOTABLE:.*$/is, '').replace(/\s+/g, ' ').trim();
      if (!text) return false;
      const notable = /NOTABLE:\s*yes/i.test(said);
      scene = { text, at: Date.now(), of: shot.at };
      log('looked at the screen in', scene.at - lastLookAt, 'ms', notable ? '(notable)' : '');
      send({ type: 'saw', text });
      return notable;
    })().catch((err) => {
      if (!visionWarned) { visionWarned = true; fail('screen', err); } else log('screen', err?.message || err);
      return false;
    }).finally(() => { looking = null; });
    return looking;
  }

  /** What is on screen, for a reply that is about to be written. Waits briefly for a look in progress. */
  async function sceneNow() {
    const p = lookAtScreen();
    if (p) await Promise.race([p, new Promise((r) => setTimeout(r, 1500))]);
    return Date.now() - scene.at < 45_000 ? scene.text : '';
  }

  /** Every few seconds: glance at the screen, and speak up unprompted if something just happened. */
  async function glance() {
    if (!game.on || !game.react || closed || reply || anyoneTalking() || Date.now() - lastLookAt < LOOK_EVERY_MS) return;
    const notable = await lookAtScreen();
    if (notable && game.on && game.react && !closed && !reply && !anyoneTalking() && Date.now() - lastSpokeAt > QUIET_AFTER_SPEAKING_MS) respond('', { soft: true });
  }

  function setGame(m) {
    const was = game.on;
    // A reply in progress is ended under the mode it began in, so one from game mode is never recorded.
    if (!!m.on !== was) interrupt();
    game.on = !!m.on;
    game.mode = ['name', 'auto', 'always'].includes(m.mode) ? m.mode : 'name';
    game.react = !!m.react;
    if (game.on !== was) { resetEars(); overheard = []; if (!game.on) { screen = null; scene = { text: '', at: 0, of: 0 }; ptt?.(false); } }
    clearInterval(watch);
    watch = game.on ? setInterval(glance, 3000) : null;
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
          messages: [{ role: 'system', content: persona.prompt + (game.on ? GAME_MODE : '') }, ...history.slice(-MAX_TURNS)],
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
  /**
   * @param userText  what was said or typed; empty for an unprompted reaction to the screen
   * @param audio     the recording of it, when it was spoken into the mic
   * @param soft      he is allowed to answer [silent], and then nothing is said at all
   */
  async function respond(userText, { audio: userAudio = null, soft = false } = {}) {
    interrupt();
    const n = ++turnSeq;
    const r = (reply = { id: ++replySeq, n, ac: new AbortController(), tts: null, text: '', done: false, audio: [], audioBytes: 0, firstAudio: 0, truncated: false, at: '' });
    const live = () => reply === r && !closed;
    let content = userText;
    if (game.on) {
      const seen = await sceneNow();
      if (!live()) { if (userText) overheard.push(userText); return; }
      content = [
        overheard.length ? '[Said in voice chat just before this, not to you]\n' + overheard.join('\n') : '',
        seen ? '[On screen right now] ' + seen : '',
        userText,
        !soft ? '' : userText ? SILENT_NOTE : REACT_NOTE,
      ].filter(Boolean).join('\n\n');
      overheard = [];
    }
    const asked = { role: 'user', content };
    history.push(asked);
    if (rec()) record.turns.push({
      n, role: 'user', at: new Date().toISOString(), source: userAudio ? 'voice' : 'text', text: userText,
      audio: saveAudio(`${pad(n)}-user.wav`, userAudio, MIC_RATE), conversationAt: addToConversation(userAudio, MIC_RATE),
    });
    // A reply he may decline is only announced once he has actually started saying something.
    let announced = false;
    const announce = () => { if (!announced) { announced = true; send({ type: 'reply_start', id: r.id }); } };
    if (!game.on) send({ type: 'user_final', text: userText });
    if (!soft) announce();
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
          if (rec() && r.audioBytes < MAX_REPLY_BYTES) { r.audio.push(pcm); r.audioBytes += pcm.length; }
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
      const out = pending.slice(0, cut).replace(/\[\s*silen(?:t|ce)\s*\]/gi, ''); // the stay-quiet marker is never a spoken word
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
    /** He chose to say nothing: undo the turn as if it had never been put to him. */
    const stayQuiet = () => {
      reply = null;
      r.done = true;
      r.ac.abort();
      ttsReady.then((t) => t.close()).catch(() => {});
      const at = history.lastIndexOf(asked);
      if (at >= 0) history.splice(at, 1);
      if (userText) overheard.push(userText);
      send({ type: 'reply_end', id: r.id });
    };
    // On a soft turn nothing is spoken until the opening words show whether it is [silent].
    let decided = !soft;
    const decide = (final) => {
      const rest = pending.replace(/^\s*(\[(?!silent)[a-z ,']+\]\s*)*/i, '');
      if (/^[\[(*"]*\s*silent/i.test(rest) || (final && !rest.trim())) return stayQuiet();
      if (!final && rest.length < 10) return;
      decided = true;
      announce();
    };

    try {
      const info = { truncated: false };
      for await (const delta of llmStream(r.ac.signal, info)) {
        if (!live()) return;
        pending += delta;
        if (!decided) { decide(false); if (!live()) return; if (!decided) continue; }
        if (SENTENCE_END.test(pending) || /\n\s*$/.test(pending) || pending.length > 220) await speak(false);
      }
      if (info.truncated) {
        // Out of room mid-sentence: keep only what ends cleanly.
        r.truncated = true;
        const whole = pending.match(/^[\s\S]*[.!?…]["')\]]*(?=\s|$)/);
        pending = whole ? whole[0] : '';
      }
      if (!decided) { decide(true); if (!live()) return; }
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
    if (!rec()) { r.audio = []; return; }
    record.turns.push({
      n: r.n, role: 'assistant', at: r.at, persona: persona.name, voice: voice || persona.voice || null, text: r.text.trim(),
      firstAudioMs: r.firstAudio || null, interrupted, truncated: r.truncated, audio: saveAudio(`${pad(r.n)}-assistant.wav`, r.audio, TTS_SAMPLE_RATE),
      conversationAt: addToConversation(r.audio, TTS_SAMPLE_RATE),
    });
    r.audio = [];
    saveTranscript();
  }

  function finish(r) {
    if (reply !== r || r.done) return;
    r.done = true;
    reply = null;
    if (r.text.trim()) history.push({ role: 'assistant', content: r.text.trim() });
    lastSpokeAt = Date.now();
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
    if (isBinary) {
      if (data.length % 2 === 0) return onAudio(ears.mic, data);
      if (data[0] === 1 && game.on) onAudio(ears.team, data.subarray(1));
      return;
    }
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'config') {
      if (PERSONAS[m.persona] && PERSONAS[m.persona] !== persona) { persona = PERSONAS[m.persona]; history.length = 0; overheard = []; voice = null; interrupt(); resetEars(); }
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
    } else if (m.type === 'game') {
      setGame(m);
    } else if (m.type === 'screen' && game.on && typeof m.jpeg === 'string' && m.jpeg.length <= MAX_SCREEN_CHARS && /^[A-Za-z0-9+/]+=*$/.test(m.jpeg)) {
      screen = { jpeg: m.jpeg, at: Date.now() };
    } else if (m.type === 'ptt') {
      if (game.on || !m.down) ptt?.(!!m.down);
    }
  };
  client.onclose = () => {
    const r = reply;
    if (r) { reply = null; r.ac.abort(); try { r.tts?.close(); } catch {} logReply(r, true); }
    closed = true;
    clearInterval(watch);
    ptt?.(false);
    try { convo?.close(); } catch (e) { log('recording failed', e?.message || e); }
    for (const e of Object.values(ears)) { try { e.stt?.send(JSON.stringify({ type: 'CloseStream' })); e.stt?.close(); } catch {} }
    warmTts?.then((t) => t.close()).catch(() => {});
  };
}
