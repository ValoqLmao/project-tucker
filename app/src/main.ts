import * as THREE from 'three';
import { Avatar, type Emotion } from './avatar';
import { VoiceSession, type ServerEvent } from './voice';
import { setupVoicePicker } from './voicePicker';

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
type Persona = { id: string; name: string; blurb: string; voice?: string };
let personas: Persona[] = [];
const persona = () => personas.find((p) => p.id === personaSel.value) ?? { id: personaSel.value, name: 'Her' };
const picker = setupVoicePicker({
  api: API,
  dialog: $<HTMLDialogElement>('voices'),
  persona,
  onChange: (voice) => session?.configure(personaSel.value, voice),
});
$('voiceBtn').onclick = () => picker.open();
const BASELINE: Record<string, [Emotion, number]> = { sweet: ['happy', 0.16], roast: ['angry', 0.14], mommy: ['relaxed', 0.22], spicy: ['relaxed', 0.18] };
const applyBaseline = () => avatar?.setBaseline(...(BASELINE[personaSel.value] ?? ['relaxed', 0.25]));
let userTalking = false;
const focus = new THREE.Vector3(0, 1.4, 0); // smoothed head position the camera frames

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
  focus.copy(head);
  applyBaseline();
  // Motion clips. The richer set lives in public/local (not published); the bundled loop is the fallback.
  const base = import.meta.env.BASE_URL;
  const local = ['idle', 'idle_2', 'idle_3', 'idle_4', 'idle_5'].map((n) => `${base}local/animations/${n}.vrma`);
  avatar.loadAnimations(local, `${base}local/animations/talking.vrma`).then((n) => n || avatar!.loadAnimations([`${base}animations/idle_loop.vrma`]));
  note.textContent = API ? '' : 'Preview build: the avatar is live, voice chat is not connected on this page yet.';
}

async function loadPersonas() {
  if (!API) return;
  try {
    const list: Persona[] = (personas = await (await fetch(`${API}/personas`)).json());
    personaSel.replaceChildren(...list.map((p) => new Option(`${p.name} — ${p.blurb}`, p.id)));
    document.body.classList.add('connected');
    applyBaseline();
  } catch {
    note.textContent = 'The session server is not reachable, so she cannot talk right now.';
  }
}

function onEvent(e: ServerEvent) {
  switch (e.type) {
    case 'user_start': you.textContent = '…'; userTalking = true; break;
    case 'user_partial':
    case 'user_final': you.textContent = e.text; userTalking = e.type === 'user_partial'; break;
    case 'reply_start': her.textContent = ''; break;
    case 'reply_text': her.textContent = (her.textContent + e.delta).replace(/\[[a-z ,']+\]\s*|["“”*]/gi, ''); break;
    case 'emotion': avatar?.setEmotion(e.value as Emotion); break;
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
  s.configure(personaSel.value, picker.choices[personaSel.value] ?? null);
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

personaSel.onchange = () => { applyBaseline(); session?.configure(personaSel.value, picker.choices[personaSel.value] ?? null); her.textContent = ''; you.textContent = ''; };

const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  if (avatar) {
    avatar.setVisemes(session?.visemes() ?? { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });
    avatar.setActivity(session?.speaking ? 'speaking' : userTalking ? 'listening' : 'idle');
    avatar.update(dt, camera);
    // The clips move her around a little; the camera follows her head loosely so she stays framed.
    const head = avatar.headPosition;
    focus.lerp(head, 1 - Math.exp(-dt * 2.5));
    camera.position.set(focus.x * 0.85, focus.y - 0.04, focus.z + 1.9);
    camera.lookAt(focus.x, focus.y - 0.1, focus.z);
  }
  renderer.render(scene, camera);
});

loadAvatar();
loadPersonas();

// Development aid: sample what the lip sync and face are doing from the console.
if (import.meta.env.DEV) {
  (window as any).__probe = (ms = 4000) =>
    new Promise((resolve) => {
      const rows: string[] = [];
      const t0 = performance.now();
      const id = setInterval(() => {
        const v = session?.visemes();
        const ex = avatar?.vrm.expressionManager;
        rows.push(
          `${Math.round(performance.now() - t0)}ms spk=${session?.speaking ? 1 : 0} ` +
            (v ? Object.entries(v).map(([k, x]) => `${k}=${x.toFixed(2)}`).join(' ') : 'no-session') +
            ` | happy=${ex?.getValue('happy')?.toFixed(2)} relaxed=${ex?.getValue('relaxed')?.toFixed(2)} aa=${ex?.getValue('aa')?.toFixed(2)}`,
        );
        if (performance.now() - t0 > ms) { clearInterval(id); resolve(rows.join('\n')); }
      }, 150);
    });
}
