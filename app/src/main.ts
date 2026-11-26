import * as THREE from 'three';
import { Avatar, type Emotion } from './avatar';
import { VoiceSession, type ServerEvent } from './voice';

// Where the session server lives. Empty in production builds until a backend is deployed.
const API = (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const note = $('note'), captions = $('captions'), you = $('you'), her = $('her');
const personaSel = $<HTMLSelectElement>('persona'), talk = $<HTMLButtonElement>('talk');
const form = $<HTMLFormElement>('say'), input = $<HTMLInputElement>('text');

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
let session: VoiceSession | null = null;
let calmDown = 0; // seconds until her face relaxes back to neutral

async function loadAvatar() {
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
  note.textContent = API ? '' : 'Preview build: the avatar is live, voice chat is not connected on this page yet.';
}

async function loadPersonas() {
  if (!API) return;
  try {
    const list: { id: string; name: string; blurb: string }[] = await (await fetch(`${API}/personas`)).json();
    personaSel.replaceChildren(...list.map((p) => new Option(`${p.name} — ${p.blurb}`, p.id)));
    document.body.classList.add('connected');
  } catch {
    note.textContent = 'The session server is not reachable, so she cannot talk right now.';
  }
}

function onEvent(e: ServerEvent) {
  switch (e.type) {
    case 'user_start': you.textContent = '…'; break;
    case 'user_partial':
    case 'user_final': you.textContent = e.text; break;
    case 'reply_start': her.textContent = ''; break;
    case 'reply_text': her.textContent = (her.textContent + e.delta).replace(/\[[a-z ]+\]\s*/gi, ''); break;
    case 'emotion': avatar?.setEmotion(e.value as Emotion); calmDown = 6; break;
    case 'error': note.textContent = `Something went wrong (${e.where}): ${e.message}`; break;
  }
  captions.hidden = false;
}

async function ensureSession(): Promise<VoiceSession> {
  if (session) return session;
  const s = new VoiceSession(API.replace(/^http/, 'ws') + '/session');
  s.onEvent = onEvent;
  s.onClose = () => { session = null; talk.setAttribute('aria-pressed', 'false'); talk.textContent = 'Start talking'; };
  await s.connect();
  s.configure(personaSel.value);
  note.textContent = '';
  return (session = s);
}

talk.onclick = async () => {
  try {
    const s = await ensureSession();
    if (s.micOn) { s.stopMic(); s.interrupt(); }
    else await s.startMic();
    talk.setAttribute('aria-pressed', String(s.micOn));
    talk.textContent = s.micOn ? 'Stop listening' : 'Start talking';
  } catch (e) {
    note.textContent = e instanceof DOMException ? 'Microphone access was blocked. Allow it in the address bar, or type instead.' : (e as Error).message;
  }
};

form.onsubmit = async (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  try {
    (await ensureSession()).sendText(text);
    you.textContent = text;
    input.value = '';
  } catch (e) {
    note.textContent = (e as Error).message;
  }
};

personaSel.onchange = () => { session?.configure(personaSel.value); her.textContent = ''; you.textContent = ''; };

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (avatar) {
    avatar.setMouth(session?.level() ?? 0);
    if (calmDown > 0 && !session?.speaking && (calmDown -= dt) <= 0) avatar.setEmotion('neutral');
    avatar.update(dt, camera);
  }
  renderer.render(scene, camera);
});

loadAvatar();
loadPersonas();
