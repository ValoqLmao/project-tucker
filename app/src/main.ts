import * as THREE from 'three';
import { Avatar } from './avatar';
import { VoiceSession, type ServerEvent } from './voice';
import { setupVoicePicker } from './voicePicker';
import { Stage, SCENES } from './stage';

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
scene.add(new THREE.AmbientLight(0xffffff, 1.05));
const key = new THREE.DirectionalLight(0xfff1f6, 1.7);
key.position.set(0.6, 1.2, 1.5);
scene.add(key);

const stage = new Stage(renderer, scene, camera);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  stage.resize(innerWidth, innerHeight);
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
  token: () => token,
  dialog: $<HTMLDialogElement>('voices'),
  persona,
  onChange: (voice) => session?.configure(personaSel.value, voice),
});
$('voiceBtn').onclick = () => picker.open();
const BASELINE: Record<string, [string, number]> = { sweet: ['warm', 0.45], roast: ['smug', 0.3], mommy: ['soft', 0.6], spicy: ['flirty', 0.4], goblin: ['smug', 0.35] };
const applyBaseline = () => avatar?.setBaseline(...(BASELINE[personaSel.value] ?? ['soft', 0.3]));
let token = ''; // proof of the access code, when the server asks for one
let userTalking = false;
let thinking = false; // between the end of their turn and the first sound of her reply
const focus = new THREE.Vector3(0, 1.4, 0); // smoothed head position the camera frames

const BASE = import.meta.env.BASE_URL;
const PLACEHOLDER = `${BASE}models/placeholder.vrm`;
const modelSel = $<HTMLSelectElement>('model');
let loading = 0;

async function loadAvatar(url: string) {
  const mine = ++loading;
  let next: Avatar;
  try {
    next = await Avatar.load(url, (f) => { if (mine === loading) note.textContent = `Loading avatar… ${Math.round(f * 100)}%`; });
  } catch (e) {
    if (mine === loading) note.textContent = 'That model failed to load.';
    throw e;
  }
  if (mine !== loading) return next.dispose(); // a newer choice won
  if (avatar) { scene.remove(avatar.vrm.scene, avatar.lookTarget); avatar.dispose(); }
  avatar = next;
  scene.add(avatar.vrm.scene, avatar.lookTarget);
  avatar.vrm.scene.updateMatrixWorld(true);
  const head = avatar.headPosition;
  camera.position.set(0, head.y - 0.04, head.z + 1.5);
  camera.lookAt(0, head.y - 0.1, head.z);
  avatar.lookTarget.position.copy(camera.position);
  focus.copy(head);
  applyBaseline();
  // Motion clips. The richer set lives in public/local (not published); the bundled loop is the fallback.
  // Only the calm loops: the livelier ones swing the arms and turn the head far more than a person in conversation does.
  const local = ['idle_5', 'idle'].map((n) => `${BASE}local/animations/${n}.vrma`);
  const a = avatar;
  a.loadAnimations(local).then((n) => n || a.loadAnimations([`${BASE}animations/idle_loop.vrma`]));
  note.textContent = API ? '' : 'Preview build: the avatar is live, voice chat is not connected on this page yet.';
}

/** Offer any models found in public/local/models (dev only) next to the bundled placeholder. */
async function setupModels() {
  let files: string[] = [];
  try {
    const r = await fetch(`${BASE}local/models/index.json`);
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) files = await r.json();
  } catch {}
  const pretty = (f: string) => f.replace(/.vrm$/i, '').replace(/[_-]+/g, ' ').replace(/w/g, (c) => c.toUpperCase());
  modelSel.replaceChildren(new Option('Placeholder', PLACEHOLDER), ...files.map((f) => new Option(pretty(f), `${BASE}local/models/${encodeURIComponent(f)}`)));
  modelSel.hidden = files.length === 0;
  let saved: string | null = null;
  try { saved = localStorage.getItem('tucker.model'); } catch {}
  if (saved && [...modelSel.options].some((o) => o.value === saved)) modelSel.value = saved;
  else if (files.length) modelSel.selectedIndex = 1;
  modelSel.onchange = () => {
    try { localStorage.setItem('tucker.model', modelSel.value); } catch {}
    loadAvatar(modelSel.value).catch(() => {});
  };
  await loadAvatar(modelSel.value);
}

/**
 * The front door: confirm the visitor is an adult, and collect the access code if the server wants one.
 * Resolves once they are in. Both answers are remembered in this browser.
 */
async function enter() {
  if (!API) return;
  const read = (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const write = (k: string, val: string) => { try { localStorage.setItem(k, val); } catch {} };
  let gate = false;
  try { gate = !!(await (await fetch(`${API}/config`)).json()).gate; } catch { return; } // unreachable server: loadPersonas reports it
  token = read('tucker.token');
  if (Number(token.split('.')[0]) * 1000 < Date.now() + 60_000) token = ''; // expired or about to
  const adult = read('tucker.adult') === 'yes';
  if (adult && (!gate || token)) return;

  const box = $('gate'), form = $<HTMLFormElement>('gateForm'), code = $<HTMLInputElement>('gateCode'), err = $('gateError'), age = $<HTMLInputElement>('gateAge');
  $('gateCodeRow').hidden = !gate || !!token;
  age.checked = adult;
  box.hidden = false;
  await new Promise<void>((done) => {
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      if (!age.checked) { err.textContent = 'This is for adults only.'; return; }
      if (gate && !token) {
        try {
          const r = await fetch(`${API}/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.value.trim() }) });
          const j = await r.json();
          if (!r.ok) { err.textContent = j.error || 'That code is not right.'; return; }
          token = j.token;
          write('tucker.token', token);
        } catch { err.textContent = 'Could not reach the server. Try again.'; return; }
      }
      write('tucker.adult', 'yes');
      box.hidden = true;
      done();
    };
  });
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
    case 'user_final': you.textContent = e.text; userTalking = e.type === 'user_partial'; if (e.type === 'user_final') thinking = true; break;
    case 'reply_start': her.textContent = ''; break;
    case 'reply_text': her.textContent = (her.textContent + e.delta).replace(/\[[a-z ,']+\]\s*|["“”*]/gi, ''); break;
    case 'emotion': avatar?.setEmotion(e.value, e.strength ?? 0.6); break;
    case 'reply_end': case 'interrupt': thinking = false; break;
    case 'error': thinking = false; note.textContent = `Something went wrong (${e.where}): ${e.message}`; break;
  }
  captions.hidden = false;
}

async function ensureSession(): Promise<VoiceSession> {
  if (session) return session;
  const s = new VoiceSession(API.replace(/^http/, 'ws') + '/session?t=' + encodeURIComponent(token));
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
    if (session?.speaking) thinking = false;
    avatar.setActivity(session?.speaking ? 'speaking' : userTalking ? 'listening' : thinking ? 'thinking' : 'idle');
    avatar.update(dt, camera);
    // The clips move her around a little; the camera follows her head loosely so she stays framed.
    const head = avatar.headPosition;
    focus.lerp(head, 1 - Math.exp(-dt * 2.5));
    // A camera on a tripod looks dead; a centimetre of slow drift does not.
    const ct = timer.getElapsed();
    camera.position.set(focus.x * 0.85 + Math.sin(ct * 0.31) * 0.012, focus.y - 0.02 + Math.sin(ct * 0.23) * 0.008, focus.z + 1.5 * (1 - 0.08 * avatar.face.pose.lean)); // drifts closer on warm or intimate moments
    camera.lookAt(focus.x, focus.y - 0.1, focus.z);
  }
  stage.render(dt);
});

setupModels();
enter().then(loadPersonas);

// Scene picker
const sceneSel = $<HTMLSelectElement>('scene');
sceneSel.replaceChildren(...Object.entries(SCENES).map(([id, s]) => new Option(s.label, id)), new Option('Plain', ''));
try { const saved = localStorage.getItem('tucker.scene'); if (saved !== null && [...sceneSel.options].some((o) => o.value === saved)) sceneSel.value = saved; } catch {}
sceneSel.onchange = () => { try { localStorage.setItem('tucker.scene', sceneSel.value); } catch {} stage.setScene(sceneSel.value || null, BASE); };
stage.setScene(sceneSel.value || null, BASE);

// Development aid: sample what the lip sync and face are doing from the console.
if (import.meta.env.DEV) {
  Object.defineProperty(window, '__avatar', { get: () => avatar });
  (window as any).__camera = camera;
  (window as any).__scene = scene;
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
