import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

export type Emotion = 'neutral' | 'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised';
const EMOTIONS: Emotion[] = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];

/** A VRM character that keeps itself alive: blinking, breathing, swaying, glancing, emoting, lip sync. */
export class Avatar {
  readonly lookTarget = new THREE.Object3D();
  private t = 0;
  private blinkIn = 2;
  private blinkPhase = -1; // <0: eyes open, otherwise seconds into the current blink
  private emotion: Emotion = 'neutral';
  private weights: Record<string, number> = {};
  private mouth = 0;
  private mouthTarget = 0;
  private glance = new THREE.Vector2();
  private glanceIn = 3;

  private constructor(readonly vrm: VRM) {
    vrm.lookAt && (vrm.lookAt.target = this.lookTarget);
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

  setEmotion(e: Emotion) { this.emotion = e; }

  /** Mouth openness 0..1, normally fed from the loudness of the voice being played. */
  setMouth(v: number) { this.mouthTarget = THREE.MathUtils.clamp(v, 0, 1); }

  update(dt: number, camera: THREE.Camera) {
    this.t += dt;
    const { humanoid, expressionManager: ex } = this.vrm;
    const bone = (n: Parameters<typeof humanoid.getNormalizedBoneNode>[0]) => humanoid.getNormalizedBoneNode(n);
    const t = this.t;

    // Idle body: arms down from the T-pose, breathing, slow weight shift, small head drift.
    const breath = Math.sin(t * 1.6);
    const sway = Math.sin(t * 0.45);
    const set = (n: Parameters<typeof bone>[0], x: number, y: number, z: number) => bone(n)?.rotation.set(x, y, z);
    set('leftUpperArm', 0.05, 0, -1.22 - breath * 0.012);
    set('rightUpperArm', 0.05, 0, 1.22 + breath * 0.012);
    set('leftLowerArm', 0, -0.18, -0.08);
    set('rightLowerArm', 0, 0.18, 0.08);
    set('hips', 0, sway * 0.03, sway * 0.012);
    set('spine', breath * 0.012, 0, -sway * 0.012);
    set('chest', breath * 0.018, 0, 0);
    set('neck', 0, Math.sin(t * 0.31) * 0.04, 0);
    set('head', Math.sin(t * 0.53) * 0.025 - this.mouth * 0.03, Math.sin(t * 0.37) * 0.05, Math.sin(t * 0.23) * 0.025);

    // Eyes: mostly hold the viewer's gaze, with the occasional glance away.
    this.glanceIn -= dt;
    if (this.glanceIn <= 0) {
      const away = Math.random() < 0.35;
      this.glance.set(away ? (Math.random() - 0.5) * 0.7 : 0, away ? (Math.random() - 0.3) * 0.3 : 0);
      this.glanceIn = away ? 0.5 + Math.random() : 2 + Math.random() * 4;
    }
    const want = camera.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(this.glance.x, this.glance.y, 0));
    this.lookTarget.position.lerp(want, 1 - Math.exp(-dt * 10));

    if (ex) {
      // Emotions cross-fade rather than snap.
      const k = 1 - Math.exp(-dt * 6);
      for (const e of EMOTIONS) {
        const w = (this.weights[e] ?? 0) + ((this.emotion === e ? 1 : 0) - (this.weights[e] ?? 0)) * k;
        this.weights[e] = w;
        ex.setValue(e, w);
      }

      // Blink at irregular intervals, sometimes twice in a row.
      let blink = 0;
      if (this.blinkPhase >= 0) {
        this.blinkPhase += dt;
        const p = this.blinkPhase / 0.14;
        blink = p < 1 ? Math.sin(p * Math.PI) : 0;
        if (p >= 1) { this.blinkPhase = -1; this.blinkIn = Math.random() < 0.2 ? 0.12 : 1.5 + Math.random() * 4; }
      } else if ((this.blinkIn -= dt) <= 0) {
        this.blinkPhase = 0;
      }
      // Smiling and surprise already reshape the eyes; a full blink on top looks broken.
      ex.setValue('blink', blink * (1 - 0.6 * Math.max(this.weights.happy ?? 0, this.weights.surprised ?? 0)));

      // Mouth opens fast and closes a little slower, like speech.
      this.mouth += (this.mouthTarget - this.mouth) * (1 - Math.exp(-dt * (this.mouthTarget > this.mouth ? 30 : 16)));
      ex.setValue('aa', this.mouth);
    }

    this.vrm.update(dt);
  }
}
