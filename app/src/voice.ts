// Browser side of a voice session: mic up, voice down, over one WebSocket to the session server.

import { createWLipSyncNode, parseBinaryProfile, type WLipSyncAudioNode } from 'wlipsync';
import type { Visemes } from './avatar';

export type ServerEvent =
  | { type: 'user_start' }
  | { type: 'user_partial' | 'user_final'; text: string }
  | { type: 'reply_start' | 'reply_end' | 'interrupt'; id: number }
  | { type: 'reply_text'; id: number; delta: string }
  | { type: 'emotion'; value: string; strength?: number }
  | { type: 'heard' | 'saw'; text: string }
  | { type: 'error'; where: string; message: string };

export type GameConfig = { on: boolean; mode: 'name' | 'auto' | 'always'; react: boolean };

// A clock that keeps its pace when the tab is in the background (behind a fullscreen game, say),
// where the browser slows ordinary timers down to as little as one a minute.
let clock: Worker | null = null;
const tickers = new Set<() => void>();
export function onTick(fn: () => void): () => void {
  if (!clock) {
    clock = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 200)'], { type: 'text/javascript' })));
    clock.onmessage = () => tickers.forEach((f) => f());
  }
  tickers.add(fn);
  return () => tickers.delete(fn);
}

const VOICE_RATE = 24000; // what the server sends
const MIC_RATE = 16000; // what the server expects
const MIC_FRAME = 1280; // 80 ms

const micWorklet = `
class Mic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${MIC_FRAME}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        const pcm = new Int16Array(this.n);
        for (let j = 0; j < this.n; j++) pcm[j] = Math.max(-1, Math.min(1, this.buf[j])) * 32767;
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('mic', Mic);`;

export class VoiceSession {
  onEvent: (e: ServerEvent) => void = () => {};
  onClose: () => void = () => {};
  private ws!: WebSocket;
  private out = new AudioContext();
  private analyser = this.out.createAnalyser();
  private samples = new Float32Array(1024);
  private playing = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private lip: WLipSyncAudioNode | null = null;
  private micCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  // Game mode
  private teamCtx: AudioContext | null = null;
  private vcDest: MediaStreamAudioDestinationNode | null = null;
  private vcAudio: HTMLAudioElement | null = null;
  private passMic: MediaStream | null = null;
  private passSource: MediaStreamAudioSourceNode | null = null;
  /** Hold the push-to-talk key (through the server) for as long as the voice is playing. */
  ptt = false;
  private held = false;
  private lastSound = 0;
  private stopTick: (() => void) | null = null;

  constructor(private url: string) {
    this.analyser.fftSize = 1024;
    this.analyser.connect(this.out.destination);
  }

  /** Vowel-shape analysis of the outgoing voice. Optional: without it the mouth falls back to loudness. */
  private async initLipSync() {
    const bin = await (await fetch(`${import.meta.env.BASE_URL}lipsync/profile.bin`)).arrayBuffer();
    const node = await createWLipSyncNode(this.out, parseBinaryProfile(bin));
    this.analyser.connect(node);
    this.lip = node;
  }

  connect(): Promise<void> {
    this.initLipSync().catch((e) => console.warn('lip sync unavailable, using loudness only', e));
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(this.url));
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        // Let go of push-to-talk shortly after the last of the voice has played.
        this.stopTick = onTick(() => { if (this.held && !this.playing.size && performance.now() - this.lastSound > 450) this.release(); });
        resolve();
      };
      ws.onerror = () => reject(new Error('Could not reach the session server.'));
      ws.onclose = () => { this.stopTick?.(); this.stopMic(); this.stopTeam(); this.routeToVoiceChat(null, false).catch(() => {}); this.onClose(); };
      ws.onmessage = (m) => {
        if (typeof m.data !== 'string') return this.play(m.data as ArrayBuffer);
        const e = JSON.parse(m.data) as ServerEvent;
        // Anything already queued belongs to a reply that was just cut off.
        if (e.type === 'interrupt' || e.type === 'user_start') this.flush();
        this.onEvent(e);
      };
    });
  }

  configure(persona: string, voice?: string | null) {
    this.sendJson({ type: 'config', persona, ...(voice !== undefined ? { voice } : {}) });
  }
  sendText(text: string) { this.out.resume(); this.sendJson({ type: 'text', text }); }
  interrupt() { this.flush(); this.sendJson({ type: 'interrupt' }); }

  get micOn() { return !!this.micCtx; }

  async startMic() {
    if (this.micCtx) return;
    await this.out.resume();
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.micCtx = await this.capture(this.micStream, (pcm) => { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm); });
  }

  /** Feed a stream to `onFrame` as 80 ms frames of PCM16 mono 16 kHz. */
  private async capture(stream: MediaStream, onFrame: (pcm: ArrayBuffer) => void): Promise<AudioContext> {
    const ctx = new AudioContext({ sampleRate: MIC_RATE });
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([micWorklet], { type: 'text/javascript' })));
    const node = new AudioWorkletNode(ctx, 'mic', { channelCount: 1, channelCountMode: 'explicit' }); // stereo sources are mixed down
    node.port.onmessage = (m) => onFrame(m.data);
    ctx.createMediaStreamSource(stream).connect(node);
    return ctx;
  }

  // ---- game mode ------------------------------------------------------------
  setGame(cfg: GameConfig) { this.sendJson({ type: 'game', ...cfg }); }

  /** A screenshot (base64 JPEG) for him to look at. Skipped if the last ones are still queued. */
  sendScreen(jpeg: string) { if (this.ws?.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 1_000_000) this.sendJson({ type: 'screen', jpeg }); }

  /**
   * Listen to a game's voice chat. `hearsItself` is for sources that include this page's own
   * sound (system audio): they are muted while he speaks, so he never answers himself.
   */
  async startTeam(stream: MediaStream, hearsItself: boolean) {
    this.stopTeam();
    this.teamCtx = await this.capture(stream, (pcm) => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      if (hearsItself && (this.playing.size || performance.now() - this.lastSound < 400)) return;
      const tagged = new Uint8Array(pcm.byteLength + 1);
      tagged[0] = 1; // channel 1: voice chat
      tagged.set(new Uint8Array(pcm), 1);
      this.ws.send(tagged);
    });
  }
  stopTeam() { this.teamCtx?.close(); this.teamCtx = null; }

  /**
   * Also play the voice into another output device: a virtual cable that a game uses as its
   * microphone. With `withMic` the real microphone goes there too, so the person can still talk.
   */
  async routeToVoiceChat(deviceId: string | null, withMic: boolean) {
    this.vcAudio?.pause();
    this.vcAudio = null;
    this.passSource?.disconnect();
    this.passSource = null;
    this.passMic?.getTracks().forEach((t) => t.stop());
    this.passMic = null;
    if (this.vcDest) { try { this.analyser.disconnect(this.vcDest); } catch {} this.vcDest = null; }
    if (!deviceId) return;
    await this.out.resume();
    const dest = (this.vcDest = this.out.createMediaStreamDestination());
    this.analyser.connect(dest);
    if (withMic) {
      this.passMic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
      this.passSource = this.out.createMediaStreamSource(this.passMic);
      this.passSource.connect(dest); // to the cable only, never to the speakers
    }
    const a = (this.vcAudio = new Audio());
    a.srcObject = dest.stream;
    await a.setSinkId(deviceId);
    await a.play();
  }

  private release() {
    if (!this.held) return;
    this.held = false;
    this.sendJson({ type: 'ptt', down: false });
  }

  stopMic() {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micCtx?.close();
    this.micStream = null;
    this.micCtx = null;
  }

  close() { this.flush(); this.ws?.close(); }

  /** Loudness of the voice currently coming out of the speakers, 0..1, for the avatar's mouth. */
  level(): number {
    if (!this.playing.size) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    const rms = Math.sqrt(sum / this.samples.length);
    return rms < 0.01 ? 0 : Math.min(1, rms * 7);
  }

  /** Mouth shapes for the sound playing right now. */
  visemes(): Visemes {
    if (!this.playing.size) return { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    const lip = this.lip;
    if (!lip) return { aa: this.level(), ih: 0, ou: 0, ee: 0, oh: 0 };
    const w = lip.weights, g = Math.min(1, lip.volume * 1.5);
    // 'S' (sibilants) has no vowel shape of its own: show it as nearly closed teeth.
    return { aa: (w.A ?? 0) * g, ih: ((w.I ?? 0) + (w.S ?? 0) * 0.5) * g, ou: (w.U ?? 0) * g, ee: (w.E ?? 0) * g, oh: (w.O ?? 0) * g };
  }

  get speaking() { return this.playing.size > 0; }

  private play(data: ArrayBuffer) {
    const pcm = new Int16Array(data, 0, data.byteLength >> 1);
    if (!pcm.length) return;
    const buf = this.out.createBuffer(1, pcm.length, VOICE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = this.out.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser);
    // Chunks are scheduled back to back; a small lead absorbs network jitter at the start.
    let lead = 0.04;
    if (this.ptt && !this.held) {
      this.held = true;
      this.sendJson({ type: 'ptt', down: true });
      lead = 0.25; // give the game a moment to open the microphone before the first word
    }
    this.lastSound = performance.now();
    this.nextAt = Math.max(this.nextAt, this.out.currentTime + lead);
    src.start(this.nextAt);
    this.nextAt += buf.duration;
    this.playing.add(src);
    src.onended = () => { this.playing.delete(src); this.lastSound = performance.now(); };
  }

  private flush() {
    for (const s of this.playing) { s.onended = null; try { s.stop(); } catch {} }
    this.playing.clear();
    this.nextAt = 0;
    this.release();
  }

  private sendJson(o: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }
}
