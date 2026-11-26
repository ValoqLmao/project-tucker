import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** The backdrop behind her and the soft glow over the whole picture. */
export class Stage {
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private lights: { mesh: THREE.Mesh; base: THREE.Vector3; phase: number; speed: number }[] = [];
  private t = 0;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    // Backdrop: a dusk gradient, darker toward the top so her face has the contrast.
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 256;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#141022');
    grad.addColorStop(0.55, '#2a1c3a');
    grad.addColorStop(1, '#4a2a45');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    const bg = new THREE.CanvasTexture(c);
    bg.colorSpace = THREE.SRGBColorSpace;
    scene.background = bg;

    // Out-of-focus lights drifting far behind her, like a city at night through a window.
    const dot = document.createElement('canvas');
    dot.width = dot.height = 64;
    const d = dot.getContext('2d')!;
    const rg = d.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,255,255,0.9)');
    rg.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    d.fillStyle = rg;
    d.fillRect(0, 0, 64, 64);
    const dotTex = new THREE.CanvasTexture(dot);
    const colours = [0xff8ab8, 0xffc48a, 0x9fb4ff, 0xd59bff];
    for (let i = 0; i < 16; i++) {
      const size = 0.12 + Math.random() * 0.28;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          map: dotTex, color: colours[i % colours.length], transparent: true, opacity: 0.05 + Math.random() * 0.1,
          depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
        }),
      );
      const base = new THREE.Vector3((Math.random() - 0.5) * 5, 0.6 + Math.random() * 1.8, -2.5 - Math.random() * 2.5);
      mesh.position.copy(base);
      mesh.renderOrder = -1;
      scene.add(mesh);
      this.lights.push({ mesh, base, phase: Math.random() * 6.28, speed: 0.08 + Math.random() * 0.15 });
    }

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { samples: 4, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    // Gentle: only the brightest highlights bloom, enough to soften the image without washing it out.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.09, 0.5, 0.97);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  resize(width: number, height: number) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }

  render(dt: number) {
    this.t += dt;
    for (const l of this.lights) {
      l.mesh.position.x = l.base.x + Math.sin(this.t * l.speed + l.phase) * 0.25;
      l.mesh.position.y = l.base.y + Math.cos(this.t * l.speed * 0.7 + l.phase) * 0.12;
    }
    this.composer.render(dt);
  }
}
