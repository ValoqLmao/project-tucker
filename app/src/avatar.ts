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
  private eyesWide = 0;

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
  private nod = 0; // seconds left of a nod

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
    VRMUtils.combineSkeletons(gltf.scene);
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
    if (e === 'surprised') { this.blinkIn = 0.7; this.eyesWide = 1; }
  }

  setActivity(a: Activity) {
    if (a === this.activity) return;
    if (this.activity === 'listening') this.nod = 0.5; // small "got it" nod when they finish
    this.activity = a;
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
    const breath = Math.sin(t * 1.5);
    this.nod = Math.max(0, this.nod - dt);
    const nodding = this.nod > 0 ? Math.sin((0.5 - this.nod) * Math.PI * 4) * 0.08 : 0;
    const emphasis = en * 0.03 * Math.sin(t * 6.1) + en * 0.035; // slight dip and bob on stressed syllables

    if (!clips) {
      const sway = wander(t * 0.35, 1), shift = wander(t * 0.22, 2);
      set('hips', 0, sway * 0.06 + shift * 0.04, shift * 0.04);
      set('spine', breath * 0.014 + li * 0.05 + sp * 0.02, -sway * 0.03, -shift * 0.035);
      set('leftShoulder', 0, 0, -breath * 0.014 - 0.03);
      set('rightShoulder', 0, 0, breath * 0.014 + 0.03);
      this.proceduralArms(dt, set, breath, en);
    } else {
      add('spine', li * 0.05 + sp * 0.015, 0, 0);
    }
    add('chest', breath * 0.012 + en * 0.012, wander(t * 0.5, 3) * 0.015, 0);
    if (clips) this.faceViewer(camera, 0.75); // clips turn her head wherever they like; she should be talking to you
    add('neck', li * 0.03 + nodding * 0.4, wander(t * 0.4, 4) * 0.03, li * 0.03);
    add(
      'head',
      wander(t * 0.6, 5) * 0.02 + nodding + sp * emphasis - li * 0.02,
      wander(t * 0.45, 6) * 0.035 * (1 + sp * 0.5),
      wander(t * 0.3, 7) * 0.02 + li * 0.06 + sp * wander(t * 1.1, 8) * 0.025,
    );
    if (clips && !this.fingersAnimated) this.relaxFingers(set, 0, 0);

    // --- eyes ---------------------------------------------------------------
    // Hold the viewer's gaze most of the time, glance away now and then, and never sit perfectly
    // still: real eyes make small jumps every fraction of a second.
    this.glanceIn -= dt;
    if (this.glanceIn <= 0) {
      // Mostly eye contact: rare, short looks away, a little more often while she is the one talking.
      const away = Math.random() < (this.activity === 'speaking' ? 0.3 : 0.12);
      this.glance.set(away ? (Math.random() - 0.5) * 0.5 : 0, away ? (Math.random() - 0.4) * 0.25 : 0, 0);
      this.glanceIn = away ? 0.5 + Math.random() * 0.8 : 2.5 + Math.random() * 4;
      if (away && Math.random() < 0.5) this.blinkIn = Math.min(this.blinkIn, 0.05); // people often blink as they shift gaze
    }
    this.saccadeIn -= dt;
    if (this.saccadeIn <= 0) {
      this.saccade.set((Math.random() - 0.5) * 0.09, (Math.random() - 0.5) * 0.05, 0);
      this.saccadeIn = 0.25 + Math.random() * 1.1;
    }
    const want = camera.getWorldPosition(new THREE.Vector3()).add(this.glance).add(this.saccade);
    this.lookTarget.position.lerp(want, 1 - Math.exp(-dt * 22)); // fast, like an eye, not a camera pan

    if (!ex) return this.vrm.update(dt);

    // --- face ---------------------------------------------------------------
    if (this.emotionHold > 0 && this.activity !== 'speaking' && (this.emotionHold -= dt) <= 0) this.intensity = 0;
    this.eyesWide = damp(this.eyesWide, 0, 1.5, dt);
    let squint = 0;
    for (const e of EMOTIONS) {
      let target = this.emotion === e ? this.intensity : 0;
      if (this.baseline.emotion === e) target = Math.max(target, this.baseline.weight * (this.intensity > 0.3 && this.emotion !== e ? 0.2 : 1));
      if (e === 'happy') target = Math.max(target, li * 0.08); // hint of an attentive smile while listening
      // Moods breathe a little instead of holding a frozen mask.
      target *= 1 + wander(t * 0.9, 20 + EMOTIONS.indexOf(e)) * 0.12;
      const w = (this.weights[e] = damp(this.weights[e] ?? 0, Math.max(0, target), 5, dt));
      // While talking, big expressions give way a little so the mouth shapes stay readable.
      ex.setValue(e, Math.min(1, w * (1 - 0.35 * sp * Math.min(1, en * 2))));
      if (e === 'happy' || e === 'relaxed') squint = Math.max(squint, w);
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
    // Smiles already narrow the eyes; a full blink on top looks broken.
    ex.setValue('blink', blink * (1 - 0.7 * squint));

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
