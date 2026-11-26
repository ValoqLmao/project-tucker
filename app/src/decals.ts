import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

/**
 * Two things painted onto the face that most models cannot do on their own:
 * a cheek blush, and a small catchlight in each eye that shimmers so the eyes look wet and alive.
 * They are soft sprites attached to the head, placed from the eye bones.
 */

function radialTexture(stops: [number, string][]) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [at, colour] of stops) grad.addColorStop(at, colour);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class FaceDecals {
  private root = new THREE.Group();
  private blush: THREE.Mesh[] = [];
  private glints: THREE.Mesh[] = [];
  private blushLevel = 0;
  private t = Math.random() * 10;
  private textures: THREE.Texture[] = [];

  constructor(vrm: VRM) {
    const h = vrm.humanoid;
    const head = h.getRawBoneNode('head');
    if (!head) return;
    head.add(this.root);
    head.updateWorldMatrix(true, true);

    // Where the eyes are, in the head's own space. Without eye bones, fall back to typical proportions.
    const local = (name: 'leftEye' | 'rightEye', fallback: THREE.Vector3) => {
      const b = h.getRawBoneNode(name);
      return b ? head.worldToLocal(b.getWorldPosition(new THREE.Vector3())) : fallback;
    };
    // Directions of "the model's left", "up" and "forward" expressed in head space, so the layout
    // works whatever orientation the head bone happens to have (MMD rigs differ from VRoid ones).
    const inv = head.getWorldQuaternion(new THREE.Quaternion()).invert();
    const sceneQ = vrm.scene.getWorldQuaternion(new THREE.Quaternion());
    const forwardSign = vrm.meta?.metaVersion === '0' ? -1 : 1;
    const dir = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(sceneQ).applyQuaternion(inv).normalize();
    const left = dir(forwardSign, 0, 0), up = dir(0, 1, 0), forward = dir(0, 0, forwardSign);
    const scale = 1 / head.getWorldScale(new THREE.Vector3()).x;
    const at = (base: THREE.Vector3, l: number, u: number, f: number) =>
      base.clone().addScaledVector(left, l * scale).addScaledVector(up, u * scale).addScaledVector(forward, f * scale);
    const guess = (side: number) => at(new THREE.Vector3(), 0.03 * side, 0.06, 0.07);
    const eyeL = local('leftEye', guess(1)), eyeR = local('rightEye', guess(-1));
    const facing = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, forward));

    const blushTex = radialTexture([[0, 'rgba(255,105,125,0.9)'], [0.45, 'rgba(255,105,125,0.45)'], [1, 'rgba(255,105,125,0)']]);
    const glintTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.85)'], [1, 'rgba(255,255,255,0)']]);
    this.textures.push(blushTex, glintTex);

    const sprite = (tex: THREE.Texture, pos: THREE.Vector3, w: number, hgt: number, order: number, blending: THREE.Blending) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w * scale, hgt * scale),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false, blending, toneMapped: false }),
      );
      m.position.copy(pos);
      m.quaternion.copy(facing);
      m.renderOrder = order;
      this.root.add(m);
      return m;
    };
    for (const [eye, side] of [[eyeL, 1], [eyeR, -1]] as const) {
      // Cheeks sit below and slightly outside the eyes.
      this.blush.push(sprite(blushTex, at(eye, 0.012 * side, -0.034, 0.03), 0.052, 0.03, 10, THREE.NormalBlending));
      // The catchlight goes up and to one side of the pupil: the same side in both eyes, as from one light.
      this.glints.push(sprite(glintTex, at(eye, 0.0045, 0.006, 0.03), 0.0075, 0.0075, 11, THREE.AdditiveBlending));
    }
  }

  /**
   * @param blush      0..1 how flushed she should be
   * @param eyesOpen   0..1, so the catchlights vanish when her eyes close
   * @param bright     0..1 extra sparkle for delighted moments
   */
  update(dt: number, blush: number, eyesOpen: number, bright: number) {
    this.t += dt;
    // A flush comes on over about half a second and takes a few seconds to fade.
    this.blushLevel += (blush - this.blushLevel) * (1 - Math.exp(-dt * (blush > this.blushLevel ? 4 : 0.6)));
    for (const m of this.blush) (m.material as THREE.MeshBasicMaterial).opacity = this.blushLevel * 0.6;
    const shimmer = 0.5 + 0.12 * Math.sin(this.t * 2.6) + 0.08 * Math.sin(this.t * 6.1 + 1) + bright * 0.3;
    this.glints.forEach((m, i) => {
      (m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, shimmer) * eyesOpen;
      m.scale.setScalar(1 + 0.08 * Math.sin(this.t * 3.1 + i) + bright * 0.25);
    });
  }

  dispose() {
    this.root.removeFromParent();
    for (const m of [...this.blush, ...this.glints]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    for (const t of this.textures) t.dispose();
  }
}
