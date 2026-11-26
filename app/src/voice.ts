// Browser side of a voice session: mic up, voice down, over one WebSocket to the session server.

import { createWLipSyncNode, parseBinaryProfile, type WLipSyncAudioNode } from 'wlipsync';
import type { Visemes } from './avatar';

export type ServerEvent =
  | { type: 'user_start' }
  | { type: 'user_partial' | 'user_final'; text: string }
  | { type: 'reply_start' | 'reply_end' | 'interrupt'; id: number }
  | { type: 'reply_text'; id: number; delta: string }
  | { type: 'emotion'; value: string; strength?: number }
  | { type: 'error'; where: string; message: string };

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
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not reach the session server.'));
      ws.onclose = () => { this.stopMic(); this.onClose(); };
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
    const ctx = (this.micCtx = new AudioContext({ sampleRate: MIC_RATE }));
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([micWorklet], { type: 'text/javascript' })));
    const node = new AudioWorkletNode(ctx, 'mic');
    node.port.onmessage = (m) => { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(m.data); };
    ctx.createMediaStreamSource(this.micStream).connect(node);
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
    this.nextAt = Math.max(this.nextAt, this.out.currentTime + 0.04);
    src.start(this.nextAt);
    this.nextAt += buf.duration;
    this.playing.add(src);
    src.onended = () => this.playing.delete(src);
  }

  private flush() {
    for (const s of this.playing) { s.onended = null; try { s.stop(); } catch {} }
    this.playing.clear();
    this.nextAt = 0;
  }

  private sendJson(o: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }
}
