import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils, type VRMHumanBoneName } from '@pixiv/three-vrm';

export type Emotion = 'neutral' | 'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised';
export type Visemes = { aa: number; ih: number; ou: number; ee: number; oh: number };
export type Activity = 'idle' | 'listening' | 'speaking';

const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;
const VOWELS = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Smooth pseudo-random wander in -1..1; different seeds give unrelated motion. */
const wander = (t: number, seed: number) =>
  (Math.sin(t * 0.73 + seed * 12.9) + Math.sin(t * 1.31 + seed * 4.1) * 0.6 + Math.sin(t * 2.17 + seed * 7.7) * 0.3) / 1.9;

/**
 * A VRM character that keeps itself alive. Everything here is procedural: breathing, weight shifts,
 * blinking, glances, relaxed hands, and on top of that body language for listening and speaking.
 */
export class Avatar {
  readonly lookTarget = new THREE.Object3D();
  private t = 0;
  private blinkIn = 2;
  private blinkPhase = -1; // <0: eyes open, otherwise seconds into the current blink
  private glance = new THREE.Vector2();
  private glanceIn = 3;

  private emotion: Emotion = 'neutral';
  private intensity = 0;
  private emotionHold = 0;
  private baseline: { emotion: Emotion; weight: number } = { emotion: 'relaxed', weight: 0.25 };
  private weights: Record<string, number> = {};

  private mouth: Visemes = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  private mouthTarget: Visemes = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  private energy = 0; // smoothed loudness of her own voice
  private activity: Activity = 'idle';
  private speak = 0; // 0..1 blend into the speaking posture
  private listen = 0; // 0..1 blend into the listening posture
  private gesture = 0; // 0..1 how far the gesturing hand is raised
  private gestureIn = 1;
  private gestureSide = 1;
  private nod = 0; // seconds left of a nod

  private constructor(readonly vrm: VRM) {
    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;
  }

  static async load(url: string, onProgress?: (fraction: number) => void): Promise<Avatar> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
    const vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // no-op for VRM 1.0, turns VRM 0.x models to face the camera
    vrm.scene.traverse((o) => (o.frustumCulled = false));
    return new Avatar(vrm);
  }

  get headPosition(): THREE.Vector3 {
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    return head ? head.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 1.4, 0);
  }

  /** The face she wears when nothing in particular is happening. */
  setBaseline(emotion: Emotion, weight: number) { this.baseline = { emotion, weight }; }

  /** Flash an emotion; it fades back to the baseline after `hold` seconds. */
  setEmotion(e: Emotion, intensity = 0.85, hold = 5) {
    this.emotion = e;
    this.intensity = e === 'neutral' ? 0 : intensity;
    this.emotionHold = hold;
    if (e === 'surprised') this.blinkIn = 0.6; // wide eyes first, then a blink
  }

  setActivity(a: Activity) {
    if (a === this.activity) return;
    if (a === 'listening') this.nod = 0; else if (this.activity === 'listening') this.nod = 0.5; // small "got it" nod
    this.activity = a;
  }

  /** Mouth shapes for the sound currently playing, each 0..1. */
  setVisemes(v: Visemes) { this.mouthTarget = v; }

  update(dt: number, camera: THREE.Camera) {
    this.t += dt;
    const t = this.t;
    const { humanoid, expressionManager: ex } = this.vrm;
    const set = (n: VRMHumanBoneName, x: number, y: number, z: number) => humanoid.getNormalizedBoneNode(n)?.rotation.set(x, y, z);

    const loud = Math.max(this.mouthTarget.aa, this.mouthTarget.oh, this.mouthTarget.ee, this.mouthTarget.ih, this.mouthTarget.ou);
    this.energy = damp(this.energy, loud, loud > this.energy ? 18 : 6, dt);
    this.speak = damp(this.speak, this.activity === 'speaking' ? 1 : 0, 5, dt);
    this.listen = damp(this.listen, this.activity === 'listening' ? 1 : 0, 4, dt);
    const sp = this.speak, li = this.listen, en = this.energy;

    // --- body ---------------------------------------------------------------
    const breath = Math.sin(t * 1.5);
    const sway = wander(t * 0.35, 1);
    const shift = wander(t * 0.22, 2); // slow weight shift from hip to hip
    set('hips', 0, sway * 0.05 + shift * 0.03, shift * 0.035);
    set('spine', breath * 0.012 + li * 0.05 + sp * 0.02, -sway * 0.02, -shift * 0.03);
    set('chest', breath * 0.02 + en * 0.02, wander(t * 0.5, 3) * 0.03 * (1 + sp), -shift * 0.012);
    set('leftShoulder', 0, 0, -breath * 0.012 - 0.03);
    set('rightShoulder', 0, 0, breath * 0.012 + 0.03);

    // Head: drifts when idle, tilts while listening, moves with her words while speaking.
    this.nod = Math.max(0, this.nod - dt);
    const nodding = Math.sin((0.5 - this.nod) * Math.PI * 4) * (this.nod > 0 ? 0.07 : 0);
    const emphasis = en * 0.06 * Math.sin(t * 7.3) + en * 0.05;
    set('neck', li * 0.04 + nodding * 0.4, wander(t * 0.4, 4) * 0.06 * (1 + sp * 0.8), li * 0.05);
    set(
      'head',
      wander(t * 0.6, 5) * 0.035 + nodding + sp * emphasis - li * 0.03,
      wander(t * 0.45, 6) * 0.07 * (1 + sp * 0.9),
      wander(t * 0.3, 7) * 0.04 + li * 0.09 + sp * wander(t * 1.1, 8) * 0.05,
    );

    // Arms rest at her sides; while she talks, one forearm comes up now and then and moves with the voice.
    this.gestureIn -= dt;
    if (this.gestureIn <= 0) {
      const raise = this.activity === 'speaking' && Math.random() < 0.7;
      if (raise && this.gesture < 0.1) this.gestureSide = Math.random() < 0.5 ? 1 : -1;
      this.gestureTarget = raise ? 0.6 + Math.random() * 0.4 : 0;
      this.gestureIn = raise ? 1.2 + Math.random() * 2 : 0.6 + Math.random() * 1.5;
    }
    if (this.activity !== 'speaking') this.gestureTarget = 0;
    this.gesture = damp(this.gesture, this.gestureTarget, 4, dt);
    const g = this.gesture, beat = en * 0.25 * Math.sin(t * 6.1) + wander(t * 1.7, 9) * 0.12;
    const gl = this.gestureSide > 0 ? g : 0, gr = this.gestureSide < 0 ? g : 0;
    const armSway = wander(t * 0.5, 10) * 0.03;
    set('leftUpperArm', 0.08 + gl * 0.35, gl * 0.25, -1.2 - breath * 0.012 + armSway + gl * 0.12);
    set('rightUpperArm', 0.08 + gr * 0.35, -gr * 0.25, 1.2 + breath * 0.012 + armSway - gr * 0.12);
    set('leftLowerArm', 0, -0.22 - gl * (1.5 + beat), -0.06);
    set('rightLowerArm', 0, 0.22 + gr * (1.5 + beat), 0.06);
    set('leftHand', gl * 0.3, 0, -0.08 + gl * (0.25 + beat * 0.5));
    set('rightHand', gr * 0.3, 0, 0.08 - gr * (0.25 + beat * 0.5));
    // Straight fingers read as a mannequin; a soft curl reads as a person.
    for (const side of ['left', 'right'] as const) {
      const s = side === 'left' ? -1 : 1;
      const open = (side === 'left' ? gl : gr) * 0.12;
      FINGERS.forEach((f, i) => {
        const curl = 0.22 + i * 0.05 - open + wander(t * 0.3, 11 + i) * 0.03;
        set(`${side}${f}Proximal` as VRMHumanBoneName, 0, 0, s * curl);
        set(`${side}${f}Intermediate` as VRMHumanBoneName, 0, 0, s * curl * 1.2);
        set(`${side}${f}Distal` as VRMHumanBoneName, 0, 0, s * curl * 0.8);
      });
      set(`${side}ThumbMetacarpal` as VRMHumanBoneName, 0, s * -0.25, 0);
    }

    // --- eyes ---------------------------------------------------------------
    // Hold the viewer's gaze most of the time; glance away more when thinking of what to say.
    this.glanceIn -= dt;
    if (this.glanceIn <= 0) {
      const away = Math.random() < (this.activity === 'listening' ? 0.12 : 0.35);
      this.glance.set(away ? (Math.random() - 0.5) * 0.8 : 0, away ? (Math.random() - 0.3) * 0.35 : 0);
      this.glanceIn = away ? 0.4 + Math.random() : 1.5 + Math.random() * 4;
    }
    const want = camera.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(this.glance.x, this.glance.y, 0));
    this.lookTarget.position.lerp(want, 1 - Math.exp(-dt * 10));

    if (!ex) return this.vrm.update(dt);

    // --- face ---------------------------------------------------------------
    if (this.emotionHold > 0 && this.activity !== 'speaking' && (this.emotionHold -= dt) <= 0) this.intensity = 0;
    let smile = 0;
    for (const e of EMOTIONS) {
      let target = this.emotion === e ? this.intensity : 0;
      if (this.baseline.emotion === e) target = Math.max(target, this.baseline.weight * (this.intensity > 0.3 && this.emotion !== e ? 0.2 : 1));
      if (e === 'happy') target = Math.max(target, li * 0.2); // attentive half-smile while listening
      const w = (this.weights[e] = damp(this.weights[e] ?? 0, target, 5, dt));
      // While talking, big expressions give way a little so the mouth shapes stay readable.
      ex.setValue(e, w * (1 - 0.35 * sp * Math.min(1, en * 2)));
      if (e === 'happy' || e === 'surprised') smile = Math.max(smile, w);
    }

    // Blink at irregular intervals, sometimes twice in a row; a little more often while talking.
    let blink = 0;
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt;
      const p = this.blinkPhase / 0.15;
      blink = p < 1 ? Math.sin(p * Math.PI) : 0;
      if (p >= 1) { this.blinkPhase = -1; this.blinkIn = Math.random() < 0.2 ? 0.12 : (1.2 + Math.random() * 3.8) * (1 - sp * 0.3); }
    } else if ((this.blinkIn -= dt) <= 0) {
      this.blinkPhase = 0;
    }
    // Smiling and surprise already reshape the eyes; a full blink on top looks broken.
    ex.setValue('blink', blink * (1 - 0.7 * smile));

    // Mouth: opens fast, closes a little slower. Shapes are scaled down as the smile grows,
    // because the smile preset already opens the mouth on most models.
    const room = 1 - 0.45 * (this.weights.happy ?? 0);
    for (const v of VOWELS) {
      const target = this.mouthTarget[v];
      this.mouth[v] = damp(this.mouth[v], target, target > this.mouth[v] ? 32 : 18, dt);
      ex.setValue(v, Math.min(1, this.mouth[v]) * room);
    }

    this.vrm.update(dt);
  }

  private gestureTarget = 0;
}
