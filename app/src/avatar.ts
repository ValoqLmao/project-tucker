import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy, createVRMAnimationClip, type VRMAnimation } from '@pixiv/three-vrm-animation';

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

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

/**
 * A VRM character that keeps itself alive.
 *
 * Body motion comes from animation clips (idle loops, a talking loop) when they are available,
 * cross-faded as she changes activity. On top of that, and on its own when no clips are loaded,
 * a procedural layer adds what clips cannot know: where she is looking, blinking, her mood,
 * head movement in time with her own voice, and attentiveness while the person speaks.
 */
export class Avatar {
  readonly lookTarget = new THREE.Object3D();
  private t = 0;
  private blinkIn = 2;
  private blinkPhase = -1; // <0: eyes open, otherwise seconds into the current blink
  private glance = new THREE.Vector3();
  private glanceIn = 3;
  private saccade = new THREE.Vector3();
  private saccadeIn = 0.5;

  private emotion: Emotion = 'neutral';
  private intensity = 0;
  private emotionHold = 0;
  private baseline: { emotion: Emotion; weight: number } = { emotion: 'relaxed', weight: 0.15 };
  private weights: Record<string, number> = {};

  private mouth: Visemes = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  private mouthTarget: Visemes = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  private energy = 0; // smoothed loudness of her own voice
  private activity: Activity = 'idle';
  private speak = 0; // 0..1 blend into the speaking posture
  private listen = 0; // 0..1 blend into the listening posture
  private gesture = 0;
  private gestureTarget = 0;
  private gestureIn = 1;
  private gestureSide = 1;
  private nodT = 0;
  private nodDur = 0;
  private nodAmp = 0;
  private sinceNod = 9;
  private loudAvg = 0;
  private wasSpeaking = false;
  private brow = 0; // 1 -> 0 eyebrow flash
  private averted = false;
  private emotionAge = 0;

  // Clip playback
  private mixer: THREE.AnimationMixer;
  private idles: THREE.AnimationAction[] = [];
  private talking: THREE.AnimationAction | null = null;
  private current: THREE.AnimationAction | null = null;
  private nextIdleIn = 0;
  private animated = new Set<string>(); // names of bone nodes the current clips drive

  private constructor(readonly vrm: VRM) {
    if (vrm.lookAt) {
      vrm.lookAt.target = this.lookTarget;
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt); // expected by the animation loader
      proxy.name = 'VRMLookAtQuaternionProxy';
      vrm.scene.add(proxy);
    }
    this.mixer = new THREE.AnimationMixer(vrm.scene);
  }

  static async load(url: string, onProgress?: (fraction: number) => void): Promise<Avatar> {
    const gltf = await loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
    const vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    // VRMUtils.combineSkeletons is deliberately not used: it is only a draw-call optimisation, and it
    // scrambles models converted from MMD (the head ends up rotated with the hair streaming sideways).
    VRMUtils.rotateVRM0(vrm); // no-op for VRM 1.0, turns VRM 0.x models to face the camera
    vrm.scene.traverse((o) => (o.frustumCulled = false));
    return new Avatar(vrm);
  }

  /**
   * Load animation clips. Missing files are skipped, so optional clips can simply not exist.
   * @param idles   loops she cycles through while idle or listening
   * @param talking loop she moves to while speaking
   */
  async loadAnimations(idles: string[], talking?: string) {
    const load = async (url: string) => {
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) return null;
        const gltf = await loader.loadAsync(url);
        const anim = gltf.userData.vrmAnimations?.[0] as VRMAnimation | undefined;
        if (!anim) return null;
        const clip = createVRMAnimationClip(anim, this.vrm);
        // Body only: her face and eyes are driven live, not by the clip.
        clip.tracks = clip.tracks.filter((tr) => /\.(quaternion|position)$/.test(tr.name) && !tr.name.includes('LookAt'));
        for (const tr of clip.tracks) this.animated.add(tr.name.replace(/\.(quaternion|position)$/, ''));
        return this.mixer.clipAction(clip);
      } catch {
        return null;
      }
    };
    const [talk, ...loops] = await Promise.all([talking ? load(talking) : null, ...idles.map(load)]);
    this.idles = loops.filter((a): a is THREE.AnimationAction => !!a);
    this.talking = talk;
    if (this.idles.length) this.play(this.idles[0], 0);
    return this.idles.length;
  }

  private play(action: THREE.AnimationAction, fade = 0.6) {
    if (action === this.current) return;
    action.reset().setEffectiveWeight(1).play();
    if (this.current) this.current.crossFadeTo(action, fade, false);
    this.current = action;
    this.nextIdleIn = action.getClip().duration * (1 + Math.floor(Math.random() * 2)) - fade;
  }

  /** Free GPU memory when this character is swapped out. */
  dispose() {
    this.mixer.stopAllAction();
    VRMUtils.deepDispose(this.vrm.scene);
  }

  get headPosition(): THREE.Vector3 {
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    return head ? head.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 1.4, 0);
  }

  /** The face she wears when nothing in particular is happening. */
  setBaseline(emotion: Emotion, weight: number) { this.baseline = { emotion, weight }; }

  /** Flash an emotion; it fades back to the baseline `hold` seconds after she stops speaking. */
  setEmotion(e: Emotion, intensity = 0.4, hold = 3) {
    this.emotion = e;
    this.intensity = e === 'neutral' ? 0 : intensity;
    this.emotionHold = hold;
    this.emotionAge = 0;
    if (e === 'surprised') this.blinkIn = 0.7; // wide eyes first, then a blink
  }

  setActivity(a: Activity) {
    if (a === this.activity) return;
    if (this.activity === 'listening') this.startNod(0.06, 0.45); // small "got it" nod when they finish
    if (a !== 'speaking') { this.averted = false; this.glance.set(0, 0, 0); this.glanceIn = 2 + Math.random() * 3; } // back to eye contact
    this.activity = a;
  }

  private startNod(amp: number, dur: number) {
    this.nodAmp = amp;
    this.nodDur = dur;
    this.nodT = 0;
    this.sinceNod = 0;
  }

  /** Mouth shapes for the sound currently playing, each 0..1. */
  setVisemes(v: Visemes) { this.mouthTarget = v; }

  update(dt: number, camera: THREE.Camera) {
    this.t += dt;
    const t = this.t;
    const { humanoid, expressionManager: ex } = this.vrm;
    const node = (n: VRMHumanBoneName) => humanoid.getNormalizedBoneNode(n);
    const set = (n: VRMHumanBoneName, x: number, y: number, z: number) => node(n)?.rotation.set(x, y, z);
    /** Rotate on top of whatever the clip did this frame (or from rest, if the clip leaves this bone alone). */
    const add = (n: VRMHumanBoneName, x: number, y: number, z: number) => {
      const b = node(n);
      if (!b) return;
      if (this.animated.has(b.name)) b.quaternion.multiply(_q.setFromEuler(_e.set(x, y, z)));
      else b.rotation.set(x, y, z);
    };

    const loud = Math.max(this.mouthTarget.aa, this.mouthTarget.oh, this.mouthTarget.ee, this.mouthTarget.ih, this.mouthTarget.ou);
    this.energy = damp(this.energy, loud, loud > this.energy ? 18 : 6, dt);
    this.speak = damp(this.speak, this.activity === 'speaking' ? 1 : 0, 5, dt);
    this.listen = damp(this.listen, this.activity === 'listening' ? 1 : 0, 4, dt);
    const sp = this.speak, li = this.listen, en = this.energy;
    const clips = this.idles.length > 0;

    // --- body: clips ---------------------------------------------------------
    if (clips) {
      this.nextIdleIn -= dt;
      if (this.activity === 'speaking' && this.talking) this.play(this.talking, 0.45);
      else if (this.nextIdleIn <= 0 || this.current === this.talking) {
        const others = this.idles.filter((a) => a !== this.current);
        this.play(others.length ? others[Math.floor(Math.random() * others.length)] : this.idles[0], this.current === this.talking ? 0.6 : 1.2);
      }
      this.mixer.update(dt);
    }

    // --- body: procedural layer ---------------------------------------------
    // Breathing cycle: in 1.2 s, hold 0.5 s, out 1.0 s, rest 1.5 s.
    const bp = t % 4.2;
    const breath01 = bp < 1.2 ? 0.5 - 0.5 * Math.cos((bp / 1.2) * Math.PI) : bp < 1.7 ? 1 : bp < 2.7 ? 0.5 + 0.5 * Math.cos((bp - 1.7) * Math.PI) : 0;
    const breath = breath01 * 2 - 1;
    const f = this.vrm.meta?.metaVersion === '0' ? -1 : 1; // VRM 0.x rigs face the other way in their own space

    // Speech-driven head. People nod on stressed syllables and dip their head as they start talking;
    // random sway reads as eerie, so the motion is tied to her actual voice.
    this.loudAvg = damp(this.loudAvg, loud, 2, dt);
    this.sinceNod += dt;
    if (this.activity === 'speaking') {
      if (!this.wasSpeaking) this.startNod(0.045, 0.45);
      else if (this.sinceNod > 1 && loud > 0.35 && loud > this.loudAvg * 1.3) {
        if (Math.random() < 0.5) {
          this.startNod(0.035 + Math.random() * 0.035, 0.25 + Math.random() * 0.15);
          if (loud > 0.6 && Math.random() < 0.4) this.brow = 1; // eyebrow flash on the strongest stresses
        } else this.sinceNod = 0.5;
      }
    }
    this.wasSpeaking = this.activity === 'speaking';
    let nodding = 0;
    if (this.nodDur > 0) {
      this.nodT += dt;
      const p = this.nodT / this.nodDur;
      if (p >= 1) this.nodDur = 0;
      else nodding = this.nodAmp * Math.sin(Math.PI * p) * (1.15 - 0.4 * p); // quick down, softer return
    }

    if (!clips) {
      const sway = wander(t * 0.35, 1), shift = wander(t * 0.22, 2);
      set('hips', 0, sway * 0.05 + shift * 0.03, shift * 0.03);
      set('spine', f * (breath * 0.012 + li * 0.04), -sway * 0.025, -shift * 0.03);
      set('leftShoulder', 0, 0, -breath * 0.012 - 0.03);
      set('rightShoulder', 0, 0, breath * 0.012 + 0.03);
      this.proceduralArms(dt, set, breath, en);
      add('chest', f * breath * 0.012, wander(t * 0.5, 3) * 0.012, 0);
    } else {
      add('spine', f * li * 0.04, 0, 0); // lean in a touch while listening
      this.faceViewer(camera, 0.75); // clips turn her head wherever they like; she should be talking to you
    }
    // Slow drift of a degree or two, plus the nods. Sideways gaze shifts bring the head along a little.
    const follow = this.glance.x * 0.35;
    add('neck', f * (li * 0.02 + nodding * 0.35), wander(t * 0.25, 4) * 0.015 + follow * 0.4, f * li * 0.02);
    add(
      'head',
      f * (wander(t * 0.3, 5) * 0.012 + nodding - li * 0.015),
      wander(t * 0.22, 6) * (0.02 + sp * 0.015) + follow * 0.6,
      f * (wander(t * 0.17, 7) * 0.012 + li * 0.045),
    );
    if (clips && !this.fingersAnimated) this.relaxFingers(set, 0, 0);

    // --- eyes ---------------------------------------------------------------
    // Eye contact with short looks away. Timings follow conversational gaze studies, biased toward
    // more contact because on a screen "away" quickly reads as bored: while speaking, a few seconds
    // of contact then about a second away; while listening, long contact and brief flicks.
    this.glanceIn -= dt;
    if (this.glanceIn <= 0) {
      const speaking = this.activity === 'speaking';
      if (this.averted) {
        this.averted = false;
        this.glance.set(0, 0, 0);
        this.glanceIn = speaking ? 2 + Math.random() * 4 : 6 + Math.random() * 4;
      } else {
        this.averted = true;
        const mag = 0.17 + Math.random() * 0.2; // roughly 5 to 11 degrees at this distance
        const r = Math.random();
        if (r < 0.4) this.glance.set(mag, 0, 0);
        else if (r < 0.8) this.glance.set(-mag, 0, 0);
        else this.glance.set((Math.random() - 0.5) * 0.12, -mag * 0.7, 0);
        this.glanceIn = speaking ? 0.5 + Math.random() * 0.7 : 0.3 + Math.random() * 0.3;
        if (Math.random() < 0.6) this.blinkIn = Math.min(this.blinkIn, 0.04); // people usually blink as they shift gaze
      }
    }
    // Even during eye contact the eyes are never perfectly still: tiny jumps of a degree or two.
    this.saccadeIn -= dt;
    if (this.saccadeIn <= 0) {
      const horizontal = Math.random() < 0.6;
      const m = (0.03 + Math.random() * 0.035) * (Math.random() < 0.5 ? -1 : 1);
      this.saccade.set(horizontal ? m : 0, horizontal ? 0 : m * 0.7, 0);
      this.saccadeIn = 0.8 + Math.random() * 2;
    }
    const want = camera.getWorldPosition(new THREE.Vector3()).add(this.glance).add(this.saccade);
    this.lookTarget.position.lerp(want, 1 - Math.exp(-dt * 24)); // eyes jump, they do not pan

    if (!ex) return this.vrm.update(Math.min(dt, 1 / 30));

    // --- face ---------------------------------------------------------------
    // A mood is a flash, not a mask: it holds while she is saying the line (8 s at most), lingers
    // briefly, then gives way to her resting face. Only one preset leads at a time.
    this.emotionAge += dt;
    if (this.intensity > 0) {
      if (this.activity !== 'speaking') this.emotionHold -= dt;
      if (this.emotionHold <= 0 || this.emotionAge > 8) this.intensity = 0;
    }
    this.brow = Math.max(0, this.brow - dt / 0.3);
    let lead = 0, eyeClosing = 0;
    for (const e of EMOTIONS) {
      let target = this.emotion === e ? this.intensity : 0;
      if (this.baseline.emotion === e) target = Math.max(target, this.baseline.weight * (this.intensity > 0.2 && this.emotion !== e ? 0 : 1));
      if (e === 'happy') target = Math.min(0.6, Math.max(target, li * 0.06)); // full "happy" is a closed-eye grin
      if (e === 'surprised') target = Math.max(target, this.brow * 0.13);
      // Rise quickly, fall slowly.
      const cur = this.weights[e] ?? 0;
      const w = (this.weights[e] = damp(cur, Math.max(0, target), target > cur ? 6 : 1.6, dt));
      ex.setValue(e, w);
      lead = Math.max(lead, w);
      if (e === 'happy' || e === 'relaxed') eyeClosing = Math.max(eyeClosing, w);
    }

    // Blinking: fast close, slower open; about 15 a minute at rest and more while talking,
    // with the occasional double blink. Skipped while a smile is already narrowing the eyes.
    let blink = 0;
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt;
      const p = this.blinkPhase / 0.17;
      blink = p < 0.35 ? p / 0.35 : p < 1 ? 1 - (p - 0.35) / 0.65 : 0;
      if (p >= 1) {
        this.blinkPhase = -1;
        this.blinkIn = Math.random() < 0.12 ? 0.1 : this.activity === 'speaking' ? 1.5 + Math.random() * 2.5 : 2 + Math.random() * 4;
      }
    } else if ((this.blinkIn -= dt) <= 0) {
      if (eyeClosing > 0.4) this.blinkIn = 0.5;
      else this.blinkPhase = 0;
    }
    ex.setValue('blink', blink * (1 - eyeClosing));

    // Mouth shapes give way when an expression already owns the mouth.
    const room = lead > 0.3 ? 0.5 : 0.8;
    for (const v of VOWELS) {
      const target = this.mouthTarget[v];
      this.mouth[v] = damp(this.mouth[v], target, target > this.mouth[v] ? 24 : 13, dt);
      ex.setValue(v, Math.min(1, this.mouth[v]) * room);
    }

    this.vrm.update(Math.min(dt, 1 / 30)); // hair and cloth springs misbehave on long frames
  }

  private get fingersAnimated() { return [...this.animated].some((n) => /Index/i.test(n)); }

  /** Turn the head most of the way toward the viewer, whatever the body clip is doing. */
  private faceViewer(camera: THREE.Camera, amount: number) {
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    if (!head?.parent) return;
    head.parent.updateWorldMatrix(true, false);
    head.updateWorldMatrix(false, false);
    const world = head.getWorldQuaternion(_q1);
    // VRM 0.x rigs face -Z in their own space (the whole scene is turned around on load).
    const forward = _v1.set(0, 0, this.vrm.meta?.metaVersion === '0' ? -1 : 1).applyQuaternion(world);
    const toViewer = camera.getWorldPosition(_v2).sub(head.getWorldPosition(_v3)).normalize();
    const turn = _q2.setFromUnitVectors(forward, toViewer);
    const target = _q3.identity().slerp(turn, amount).multiply(world);
    head.quaternion.copy(head.parent.getWorldQuaternion(_q2).invert().multiply(target));
  }

  private relaxFingers(set: (n: VRMHumanBoneName, x: number, y: number, z: number) => void, openLeft: number, openRight: number) {
    const t = this.t;
    for (const side of ['left', 'right'] as const) {
      const s = side === 'left' ? -1 : 1;
      const open = side === 'left' ? openLeft : openRight;
      FINGERS.forEach((f, i) => {
        const curl = 0.22 + i * 0.05 - open + wander(t * 0.3, 11 + i) * 0.03;
        set(`${side}${f}Proximal` as VRMHumanBoneName, 0, 0, s * curl);
        set(`${side}${f}Intermediate` as VRMHumanBoneName, 0, 0, s * curl * 1.2);
        set(`${side}${f}Distal` as VRMHumanBoneName, 0, 0, s * curl * 0.8);
      });
      set(`${side}ThumbMetacarpal` as VRMHumanBoneName, 0, s * -0.25, 0);
    }
  }

  /** Arms and hands when no animation clips are available. */
  private proceduralArms(dt: number, set: (n: VRMHumanBoneName, x: number, y: number, z: number) => void, breath: number, en: number) {
    const t = this.t;
    this.gestureIn -= dt;
    if (this.gestureIn <= 0) {
      const raise = this.activity === 'speaking' && Math.random() < 0.35;
      if (raise && this.gesture < 0.1) this.gestureSide = Math.random() < 0.5 ? 1 : -1;
      this.gestureTarget = raise ? 0.25 + Math.random() * 0.25 : 0;
      this.gestureIn = raise ? 1.2 + Math.random() * 2 : 0.6 + Math.random() * 1.5;
    }
    if (this.activity !== 'speaking') this.gestureTarget = 0;
    this.gesture = damp(this.gesture, this.gestureTarget, 4, dt);
    const g = this.gesture, beat = en * 0.25 * Math.sin(t * 6.1) + wander(t * 1.7, 9) * 0.12;
    const gl = this.gestureSide > 0 ? g : 0, gr = this.gestureSide < 0 ? g : 0;
    const armSway = wander(t * 0.5, 10) * 0.04;
    set('leftUpperArm', 0.08 + gl * 0.35, gl * 0.25, -1.2 - breath * 0.012 + armSway + gl * 0.12);
    set('rightUpperArm', 0.08 + gr * 0.35, -gr * 0.25, 1.2 + breath * 0.012 + armSway - gr * 0.12);
    set('leftLowerArm', 0, -0.22 - gl * (1.5 + beat), -0.06);
    set('rightLowerArm', 0, 0.22 + gr * (1.5 + beat), 0.06);
    set('leftHand', gl * 0.3, 0, -0.08 + gl * (0.25 + beat * 0.5));
    set('rightHand', gr * 0.3, 0, 0.08 - gr * (0.25 + beat * 0.5));
    this.relaxFingers(set, gl * 0.12, gr * 0.12);
  }
}
