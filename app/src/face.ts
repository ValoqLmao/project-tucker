import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

/**
 * The expressive layer of the face.
 *
 * VRM's five emotion presets are too blunt on their own (on MMD-converted models "happy" is
 * literally just the closed-eye morph), so this drives the model's individual facial morphs:
 * brows, eyelids, mouth corners, blush. Expressions are recipes over those channels, and they
 * are played with dynamics (quick onset, a peak, settling, slow release) plus a constant trickle
 * of small involuntary movements, because a face holding any fixed pose reads as a mask.
 *
 * Models without such morphs fall back to the VRM presets.
 */

// Channel -> morph names to look for, in order of preference (MMD names first, then VRoid).
const CHANNELS = {
  browUp: ['上', 'Fcl_BRW_Surprised'],
  browUpOne: ['上右', '上左'], // a single raised eyebrow, when the model has split brows
  browDown: ['真面目', '下'],
  browSad: ['困る', 'Fcl_BRW_Sorrow'],
  browAngry: ['怒り', 'Fcl_BRW_Angry'],
  browHappy: ['にこり', 'Fcl_BRW_Joy', 'Fcl_BRW_Fun'],
  eyeSmile: ['笑い', 'Fcl_EYE_Joy'], // eyes curved shut in a smile
  eyeSoft: ['なごみ', 'Fcl_EYE_Fun'], // gently narrowed, content
  eyeWide: ['びっくり', 'Fcl_EYE_Surprised'],
  eyeHalf: ['じと目', 'ジト目', 'Fcl_EYE_Angry'], // half-lidded, unimpressed
  wink: ['ウィンク', 'Fcl_EYE_Close_L'],
  pupilSmall: ['瞳小'],
  mouthSmile: ['口角上げ', 'にやり２', 'Fcl_MTH_Fun'],
  smirk: ['にやり', 'にやり２', 'Fcl_MTH_Joy'],
  mouthFrown: ['口角下げ', 'Fcl_MTH_Sorrow', 'Fcl_MTH_Angry'],
  mouthOpenSmile: ['ワ', 'Fcl_MTH_Joy'],
  mouthPout: ['ω', '∧', 'ん'],
  tongue: ['ぺろっ', 'てへぺろ'],
  blush: ['照れ', '脸红', 'Fcl_ALL_Blush'],
} as const;
type Channel = keyof typeof CHANNELS;
type Recipe = Partial<Record<Channel, number>>;

/** Named expressions. Weights are for full strength; most cues play well below that. */
export const EXPRESSIONS: Record<string, Recipe> = {
  neutral: {},
  warm: { browHappy: 0.4, eyeSoft: 0.2, mouthSmile: 0.55 },
  happy: { browHappy: 0.6, eyeSmile: 0.3, mouthSmile: 0.75 },
  laughing: { browHappy: 0.7, eyeSmile: 0.9, mouthOpenSmile: 0.55, mouthSmile: 0.5 },
  excited: { browUp: 0.6, eyeWide: 0.35, mouthOpenSmile: 0.4, mouthSmile: 0.5 },
  teasing: { browUpOne: 0.7, browUp: 0.15, eyeHalf: 0.3, smirk: 0.75 },
  smug: { browDown: 0.2, eyeHalf: 0.5, smirk: 0.85 },
  flirty: { browUp: 0.15, eyeHalf: 0.4, mouthSmile: 0.5, blush: 0.5 },
  shy: { browSad: 0.45, eyeSoft: 0.2, mouthSmile: 0.25, blush: 1 },
  playful: { browUp: 0.3, wink: 0.9, smirk: 0.6, tongue: 0.5 },
  curious: { browUp: 0.6, eyeWide: 0.2, mouthSmile: 0.1 },
  surprised: { browUp: 0.9, eyeWide: 0.8, pupilSmall: 0.4 },
  thinking: { browDown: 0.35, browUpOne: 0.3, eyeHalf: 0.15, mouthPout: 0.15 },
  concerned: { browSad: 0.7, eyeWide: 0.1, mouthFrown: 0.3 },
  sad: { browSad: 0.85, eyeHalf: 0.3, mouthFrown: 0.55 },
  sigh: { browSad: 0.5, eyeSoft: 0.5, mouthFrown: 0.25 },
  pout: { browSad: 0.35, browDown: 0.2, mouthPout: 0.7, blush: 0.25 },
  annoyed: { browAngry: 0.55, eyeHalf: 0.5, mouthFrown: 0.35 },
  angry: { browAngry: 0.9, eyeWide: 0.15, mouthFrown: 0.5 },
  deadpan: { browDown: 0.3, eyeHalf: 0.6 },
  soft: { browHappy: 0.2, eyeSoft: 0.3, mouthSmile: 0.3 },
  attentive: { browUp: 0.2, mouthSmile: 0.2 },
};

// What each expression means in VRM-preset terms, for models without detailed morphs.
const PRESET_FALLBACK: Record<string, [string, number]> = {
  warm: ['relaxed', 0.3], happy: ['happy', 0.45], laughing: ['happy', 0.7], excited: ['happy', 0.5],
  teasing: ['happy', 0.25], smug: ['relaxed', 0.35], flirty: ['relaxed', 0.35], shy: ['sad', 0.2],
  playful: ['happy', 0.35], curious: ['surprised', 0.25], surprised: ['surprised', 0.7], thinking: ['relaxed', 0.1],
  concerned: ['sad', 0.4], sad: ['sad', 0.6], sigh: ['sad', 0.35], pout: ['sad', 0.3], annoyed: ['angry', 0.4],
  angry: ['angry', 0.65], deadpan: ['relaxed', 0.15], soft: ['relaxed', 0.3], attentive: ['happy', 0.1],
};
const PRESETS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];

const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

type Target = { influences: number[]; index: number };

export class FaceRig {
  /** True when the model has its own brow/eye/mouth morphs to drive. */
  readonly detailed: boolean;
  private targets = new Map<Channel, Target[]>();
  private value: Partial<Record<Channel, number>> = {};
  private presetValue: Record<string, number> = {};

  // The expression being shown, and the one she rests on.
  private name = 'neutral';
  private strength = 0;
  private age = 0;
  private hold = 0;
  private resting: { name: string; strength: number } = { name: 'neutral', strength: 0 };

  // Involuntary movement.
  private micro: { recipe: Recipe; t: number; dur: number } | null = null;
  private microIn = 2;
  private browFlash = 0;

  constructor(private vrm: VRM) {
    const byName = new Map<string, Target[]>();
    vrm.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name)!.push({ influences: mesh.morphTargetInfluences, index });
      }
    });
    for (const [channel, names] of Object.entries(CHANNELS) as [Channel, readonly string[]][]) {
      const found = names.find((n) => byName.has(n));
      if (found) this.targets.set(channel, byName.get(found)!);
    }
    // Enough to build faces from: at least brows and a mouth-corner control.
    this.detailed = this.targets.has('browUp') && (this.targets.has('mouthSmile') || this.targets.has('smirk')) && this.targets.has('browSad');
  }

  /** The face she wears between reactions (usually a faint version of her persona's default mood). */
  setResting(name: string, strength: number) { this.resting = { name: EXPRESSIONS[name] ? name : 'neutral', strength }; }

  /** React with an expression. It peaks, settles while she is still talking, then fades. */
  show(name: string, strength = 0.6, hold = 2.5) {
    this.name = EXPRESSIONS[name] ? name : 'neutral';
    this.strength = strength;
    this.age = 0;
    this.hold = hold;
  }

  /** A quick eyebrow lift, for emphasis in her speech. */
  flashBrows() { this.browFlash = 1; }

  /** How closed the expression already makes her eyes (0..1), so blinking can make room. */
  get eyesNarrowed() { return Math.min(1, (this.value.eyeSmile ?? 0) + (this.value.eyeSoft ?? 0) * 0.5 + (this.value.wink ?? 0) * 0.5); }
  /** How much of the mouth the expression is using (0..1), so speech shapes can make room. */
  get mouthBusy() { return Math.min(1, (this.value.mouthOpenSmile ?? 0) + (this.value.mouthPout ?? 0) + (this.value.tongue ?? 0)); }

  /**
   * Advance the face. Call after vrm.update(), since that resets the morphs the presets own.
   * @param speaking whether her voice is playing; @param energy loudness of it, 0..1
   */
  update(dt: number, speaking: boolean, energy: number) {
    // Envelope of the current reaction: full for a beat, then it relaxes to a lived-in level while
    // she keeps talking, and lets go a couple of seconds after she stops.
    this.age += dt;
    if (!speaking) this.hold -= dt;
    let level = this.strength;
    if (this.age > 0.9) level *= 0.62 + 0.38 * Math.exp(-(this.age - 0.9) * 1.2);
    if (this.hold <= 0 || this.age > 10) level = 0;
    const active = level > 0.02 ? EXPRESSIONS[this.name] : null;

    // Small involuntary movements: a brow twitch, the hint of a smile, a slight squint.
    this.microIn -= dt;
    if (this.microIn <= 0 && !this.micro) {
      const pick: Recipe[] = [
        { browUp: 0.22 }, { browUpOne: 0.3 }, { mouthSmile: 0.18 }, { eyeSoft: 0.2 }, { browDown: 0.15 },
        { browHappy: 0.2, mouthSmile: 0.12 }, { eyeHalf: 0.15 }, { smirk: 0.15 },
      ];
      this.micro = { recipe: pick[Math.floor(Math.random() * pick.length)], t: 0, dur: 0.7 + Math.random() * 1.6 };
      this.microIn = (speaking ? 1.2 : 2.5) + Math.random() * 3.5;
    }
    let microLevel = 0;
    if (this.micro) {
      this.micro.t += dt;
      const p = this.micro.t / this.micro.dur;
      if (p >= 1) this.micro = null;
      else microLevel = Math.sin(Math.PI * p);
    }
    this.browFlash = Math.max(0, this.browFlash - dt / 0.35);

    const rest = EXPRESSIONS[this.resting.name];
    // The resting face steps back while a reaction is up, so two moods never fight.
    const restLevel = this.resting.strength * (1 - Math.min(1, level * 1.6));

    if (!this.detailed) return this.updatePresets(dt, level, restLevel);

    for (const channel of this.targets.keys()) {
      let target = (active?.[channel] ?? 0) * level + (rest[channel] ?? 0) * restLevel;
      if (this.micro) target += (this.micro.recipe[channel] ?? 0) * microLevel;
      if (channel === 'browUp') target += this.browFlash * 0.35;
      // While she is mid-word, mouth poses give way so the speech shapes stay readable.
      if (speaking && (channel === 'mouthOpenSmile' || channel === 'mouthPout' || channel === 'tongue')) target *= 1 - Math.min(1, energy * 1.5);
      if (speaking && (channel === 'mouthSmile' || channel === 'smirk' || channel === 'mouthFrown')) target *= 1 - 0.35 * Math.min(1, energy * 1.5);
      target = Math.min(1, target);
      const cur = this.value[channel] ?? 0;
      // Faces move into an expression faster than they leave it; blush is slow both ways.
      const rate = channel === 'blush' ? 1.2 : target > cur ? 9 : 2.8;
      const v = (this.value[channel] = damp(cur, target, rate, dt));
      for (const t of this.targets.get(channel)!) t.influences[t.index] = v;
    }
  }

  private updatePresets(dt: number, level: number, restLevel: number) {
    const ex = this.vrm.expressionManager;
    if (!ex) return;
    const want: Record<string, number> = {};
    const add = (name: string, k: number) => {
      const f = PRESET_FALLBACK[name];
      if (f) want[f[0]] = Math.max(want[f[0]] ?? 0, f[1] * k);
    };
    add(this.name, level);
    add(this.resting.name, restLevel);
    if (this.browFlash > 0) want.surprised = Math.max(want.surprised ?? 0, this.browFlash * 0.13);
    for (const p of PRESETS) {
      const cur = this.presetValue[p] ?? 0, target = want[p] ?? 0;
      ex.setValue(p, (this.presetValue[p] = damp(cur, target, target > cur ? 7 : 2, dt)));
    }
    this.value.eyeSmile = (this.presetValue.happy ?? 0) + (this.presetValue.relaxed ?? 0) * 0.5;
  }
}
