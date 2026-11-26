import * as THREE from 'three';
import { Avatar, type Emotion } from './avatar';

const note = document.getElementById('note')!;
const hud = document.getElementById('hud')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 20);
scene.add(new THREE.AmbientLight(0xffffff, 1.3));
const key = new THREE.DirectionalLight(0xfff1f6, 2.2);
key.position.set(0.6, 1.2, 1.5);
scene.add(key);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let avatar: Avatar | null = null;
let analyser: AnalyserNode | null = null;
let samples: Float32Array<ArrayBuffer> | null = null;

function button(label: string, onClick: (b: HTMLButtonElement) => void) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => onClick(b);
  hud.append(b);
  return b;
}

async function start() {
  try {
    avatar = await Avatar.load(`${import.meta.env.BASE_URL}models/placeholder.vrm`, (f) => {
      note.textContent = `Loading avatar… ${Math.round(f * 100)}%`;
    });
  } catch (e) {
    note.textContent = 'The avatar failed to load. Reload the page to try again.';
    throw e;
  }
  scene.add(avatar.vrm.scene, avatar.lookTarget);
  avatar.vrm.scene.updateMatrixWorld(true);
  const head = avatar.headPosition;
  camera.position.set(0, head.y - 0.04, head.z + 1.9);
  camera.lookAt(0, head.y - 0.1, head.z);
  avatar.lookTarget.position.copy(camera.position);
  note.textContent = 'Placeholder model. Voice and chat are not wired up yet.';

  const emotions: Emotion[] = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
  const buttons = emotions.map((e) =>
    button(e, (b) => {
      avatar!.setEmotion(e);
      buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }),
  );
  buttons[0].setAttribute('aria-pressed', 'true');

  // Stand-in for the voice until speech is wired up: your own mic drives her mouth.
  button('lip sync from my mic', async (b) => {
    if (analyser) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      samples = new Float32Array(analyser.fftSize);
      ctx.createMediaStreamSource(stream).connect(analyser);
      b.setAttribute('aria-pressed', 'true');
    } catch {
      note.textContent = 'Microphone access was blocked, so lip sync has nothing to follow.';
    }
  });
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (avatar) {
    if (analyser && samples) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const rms = Math.sqrt(sum / samples.length);
      avatar.setMouth(rms < 0.015 ? 0 : Math.min(1, rms * 9));
    }
    avatar.update(dt, camera);
  }
  renderer.render(scene, camera);
});

start();
