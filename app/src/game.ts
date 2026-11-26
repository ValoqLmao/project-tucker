// Game mode: he watches a shared screen, listens to a game's voice chat, and can talk back into it.
// This file owns the settings dialog and the captured streams; VoiceSession does the audio plumbing.

import { onTick, type VoiceSession } from './voice';

type Settings = {
  mode: 'name' | 'auto' | 'always'; // when he answers what he hears
  react: boolean; // speak up unprompted about what happens on screen
  hear: string; // '' = nobody, 'system' = the audio shared with the screen, otherwise an input device id
  speak: string; // '' = only the normal speakers, otherwise an output device id (the game's microphone)
  passMic: boolean; // also send the real microphone to that device
  ptt: boolean; // hold the push-to-talk key while he speaks
};
const KEY = 'tucker.game';
const DEFAULTS: Settings = { mode: 'name', react: true, hear: 'system', speak: '', passMic: true, ptt: true };
const SHOT_EVERY_TICKS = 15; // a screenshot every 3 s
const SHOT_WIDTH = 1280;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function setupGame(opts: {
  dialog: HTMLDialogElement;
  button: HTMLButtonElement;
  /** The key the server will hold while he speaks, or null where it cannot. */
  pttKey: () => string | null;
  name: () => string;
  ensureSession: () => Promise<VoiceSession>;
  session: () => VoiceSession | null;
}) {
  const { dialog, button } = opts;
  let cfg: Settings = { ...DEFAULTS };
  try { cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {} };

  let on = false;
  let screen: MediaStream | null = null, team: MediaStream | null = null, stopTicks: (() => void) | null = null;

  // ---- the dialog -------------------------------------------------------------
  const title = el('h2', '', 'Game mode');
  const intro = el('p', 'vhint');
  const row = (label: string, control: HTMLElement) => { const l = el('label', 'grow', label); l.append(control); return l; };
  const check = (label: string) => { const l = el('label', 'gcheck'), box = el('input'); box.type = 'checkbox'; const span = el('span', '', label); l.append(box, span); return { l, box, span }; };

  const mode = el('select');
  const react = check('Reacts to what happens on screen without being asked');
  const hear = el('select'), speak = el('select');
  const passMic = check('Send my own microphone there too, so I can still talk');
  const ptt = check('');
  const status = el('p', 'gstatus');
  status.setAttribute('role', 'status');
  const help = el('details');
  help.append(el('summary', '', 'Setting it up for a game with push-to-talk voice chat'));
  const steps = el('ol');
  for (const t of [
    'Install a virtual audio cable (VB-CABLE is free). It adds a playback device called "CABLE Input" and a microphone called "CABLE Output".',
    'In the game\'s voice chat settings, set the input device (microphone) to "CABLE Output". Here, set "Speaks into" to "CABLE Input" and keep "Send my own microphone there too" ticked.',
    'Set the game\'s team voice to push to talk on the key shown above, and tick the box to hold it while he speaks.',
    'Run the game in windowed fullscreen. When you press Start, choose "Entire screen" and tick "Also share system audio" so he hears what you hear.',
    'For cleaner hearing, give the game\'s voice chat its own output device (a second cable) and pick that under "Hears voice chat from" instead: then he hears only voices, not gunfire.',
  ]) steps.append(el('li', '', t));
  help.append(steps);
  const foot = el('div', 'vfoot');
  const start = el('button', 'gstart'), done = el('button', '', 'Done');
  start.type = done.type = 'button';
  foot.append(start, done);
  dialog.append(title, intro, row('Answers', mode), react.l, row('Hears voice chat from', hear), row('Speaks into', speak), passMic.l, ptt.l, status, help, foot);

  function fill(sel: HTMLSelectElement, options: [string, string][], value: string) {
    sel.replaceChildren(...options.map(([v, label]) => new Option(label, v)));
    if (options.some(([v]) => v === value)) sel.value = value;
    else { sel.add(new Option('(the device chosen before, not connected right now)', value)); sel.value = value; }
  }

  /** Audio devices by kind. Their names are only readable once the microphone has been allowed. */
  async function devices(kind: MediaDeviceKind): Promise<[string, string][]> {
    let list = await navigator.mediaDevices.enumerateDevices();
    if (!list.some((d) => d.label)) {
      try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch {}
      list = await navigator.mediaDevices.enumerateDevices();
    }
    return list.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => [d.deviceId, d.label || 'Unnamed device']);
  }

  function render() {
    const name = opts.name(), key = opts.pttKey();
    intro.textContent = `${name} watches your screen, listens to the game's voice chat, and talks back into it. Nothing is recorded while this is on. Press Start talking as well if you want ${name} to hear you.`;
    fill(mode, [['name', `When someone says "${name}"`], ['auto', 'When it seems meant for them (chattier)'], ['always', 'To everything they hear']], cfg.mode);
    const hears: [string, string][] = [['', 'Nobody'], ['system', 'Everything this PC plays (shared with the screen)']];
    const speaks: [string, string][] = [['', 'Only my own speakers']];
    fill(hear, hears, cfg.hear);
    fill(speak, speaks, cfg.speak);
    // Device names arrive after the microphone prompt has been answered, so they are added when ready.
    if (!on) Promise.all([devices('audioinput'), devices('audiooutput')]).then(([ins, outs]) => {
      if (on) return;
      fill(hear, [...hears, ...ins], cfg.hear);
      fill(speak, [...speaks, ...outs], cfg.speak);
      paint();
    }).catch(() => {});
    react.box.checked = cfg.react;
    passMic.box.checked = cfg.passMic;
    ptt.box.checked = cfg.ptt && !!key;
    ptt.box.disabled = !key;
    ptt.span.textContent = key ? `Hold ${key} on this PC while ${name} speaks (push to talk)` : 'Holding a push-to-talk key needs the session server running on this PC (Windows)';
    paint();
  }

  function paint() {
    start.textContent = on ? 'Stop game mode' : 'Start game mode';
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? 'Game: on' : 'Game';
    // What is captured and where it goes is fixed while running; how he behaves can change live.
    hear.disabled = speak.disabled = passMic.box.disabled = on;
    passMic.l.hidden = !speak.value;
  }

  function read() {
    cfg = { mode: mode.value as Settings['mode'], react: react.box.checked, hear: hear.value, speak: speak.value, passMic: passMic.box.checked, ptt: ptt.box.checked };
    save();
    paint();
    const s = opts.session();
    if (on && s) { s.ptt = cfg.ptt && !!opts.pttKey(); s.setGame({ on: true, mode: cfg.mode, react: cfg.react }); }
  }
  for (const c of [mode, hear, speak, react.box, passMic.box, ptt.box]) c.onchange = read;

  // ---- the screen ---------------------------------------------------------------
  let shooting = false;
  async function shoot(track: MediaStreamTrack, grabber: { grabFrame(): Promise<ImageBitmap> } | null, video: HTMLVideoElement) {
    const s = opts.session();
    if (shooting || !s || track.readyState !== 'live') return;
    shooting = true;
    try {
      // ImageCapture keeps working while this tab is behind a fullscreen game; a <video> may not.
      const frame = grabber ? await grabber.grabFrame() : await createImageBitmap(video);
      const scale = Math.min(1, SHOT_WIDTH / frame.width);
      const canvas = new OffscreenCanvas(Math.round(frame.width * scale), Math.round(frame.height * scale));
      canvas.getContext('2d')!.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      s.sendScreen(await base64(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 })));
    } catch { /* a frame that could not be grabbed is simply skipped */ } finally { shooting = false; }
  }

  // ---- start / stop ---------------------------------------------------------------
  async function begin() {
    status.textContent = 'Choose the screen to share…';
    const wantSystem = cfg.hear === 'system';
    // Asked for first, while the click that started this still counts as a user gesture.
    screen = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: wantSystem ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      ...(wantSystem ? { systemAudio: 'include' } : {}),
    } as DisplayMediaStreamOptions);
    const s = await opts.ensureSession();
    const notes: string[] = [];

    if (wantSystem) {
      if (screen.getAudioTracks().length) await s.startTeam(new MediaStream(screen.getAudioTracks()), true);
      else notes.push('No sound was shared, so voice chat is not being heard: start again, pick "Entire screen" and tick "Also share system audio".');
    } else if (cfg.hear) {
      team = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: cfg.hear }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      await s.startTeam(team, false);
    }
    await s.routeToVoiceChat(cfg.speak || null, cfg.passMic);
    s.ptt = cfg.ptt && !!opts.pttKey();
    s.setGame({ on: true, mode: cfg.mode, react: cfg.react });

    const track = screen.getVideoTracks()[0];
    const ImageCapture = (window as any).ImageCapture;
    const grabber = ImageCapture ? new ImageCapture(track) : null;
    const video = el('video');
    if (!grabber) { video.muted = true; video.srcObject = screen; video.play().catch(() => {}); }
    track.addEventListener('ended', () => end('Screen sharing stopped, so game mode is off.'));
    // Driven by a worker clock: ordinary page timers all but stop once the game covers this window.
    let ticks = SHOT_EVERY_TICKS - 2;
    stopTicks = onTick(() => { if (++ticks >= SHOT_EVERY_TICKS) { ticks = 0; shoot(track, grabber, video); } });
    on = true;
    status.textContent = ['Game mode is on.', ...notes].join(' ');
    paint();
  }

  function end(message = '') {
    stopTicks?.();
    stopTicks = null;
    for (const m of [screen, team]) m?.getTracks().forEach((t) => t.stop());
    screen = team = null;
    const s = opts.session();
    if (s) { s.stopTeam(); s.routeToVoiceChat(null, false).catch(() => {}); s.ptt = false; s.setGame({ on: false, mode: cfg.mode, react: cfg.react }); }
    on = false;
    status.textContent = message;
    paint();
  }

  start.onclick = async () => {
    if (on) return end();
    start.disabled = true;
    try { await begin(); }
    catch (e) {
      end(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Screen sharing was cancelled or blocked.' : `Could not start: ${(e as Error).message}`);
    } finally { start.disabled = false; }
  };
  done.onclick = () => dialog.close();
  dialog.onclick = (e) => { if (e.target === dialog) dialog.close(); };
  button.onclick = () => { render(); dialog.showModal(); };
  paint();

  return {
    get on() { return on; },
    /** The voice session went away underneath us: everything captured for it stops too. */
    sessionClosed() { if (on) end('The session ended, so game mode is off.'); },
    refresh: render,
  };
}
