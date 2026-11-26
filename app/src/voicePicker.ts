// Voice picker: browse Fish Audio voices, preview them, and remember one per persona.

type Voice = { id: string; title: string; tags: string[]; uses: number; about: string; sample?: string; author?: string; official: boolean };

const KEY = 'tucker.voices';
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Persona id -> chosen voice id. Kept in this browser only. */
export function loadChoices(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function saveChoices(c: Record<string, string>) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {}
}

export function setupVoicePicker(opts: {
  api: string;
  dialog: HTMLDialogElement;
  persona: () => { id: string; name: string; voice?: string };
  onChange: (voice: string | null) => void;
}) {
  const { dialog } = opts;
  const choices = loadChoices();
  const player = new Audio();
  let playingBtn: HTMLButtonElement | null = null;
  let request = 0;

  const title = el('h2');
  const form = el('form', 'vsearch');
  const search = el('input');
  search.placeholder = 'Search voices (asmr, sultry, british…) or paste a voice ID';
  search.setAttribute('aria-label', 'Search voices');
  form.append(search, el('button', '', 'Search'));
  const hint = el('p', 'vhint');
  const list = el('div', 'vlist');
  const foot = el('div', 'vfoot');
  const reset = el('button', '', 'Use her default voice');
  reset.type = 'button';
  const close = el('button', '', 'Done');
  close.type = 'button';
  foot.append(reset, close);
  dialog.append(title, form, hint, list, foot);

  const stop = () => { player.pause(); if (playingBtn) playingBtn.textContent = '▶ Preview'; playingBtn = null; };
  player.onended = stop;
  close.onclick = () => dialog.close();
  dialog.onclose = stop;
  dialog.onclick = (e) => { if (e.target === dialog) dialog.close(); }; // click on the backdrop

  const current = () => choices[opts.persona().id] ?? opts.persona().voice ?? null;

  function choose(id: string | null) {
    const p = opts.persona().id;
    if (id) choices[p] = id; else delete choices[p];
    saveChoices(choices);
    opts.onChange(id);
    for (const row of list.children) row.classList.toggle('on', (row as HTMLElement).dataset.id === current());
  }
  reset.onclick = () => choose(null);

  async function load(term: string) {
    const mine = ++request;
    list.replaceChildren(el('p', 'vhint', 'Loading voices…'));
    hint.textContent = term
      ? 'Community voices. Many imitate real people or characters; fine for private fun, risky on a public site.'
      : 'Original voices made by Fish Audio. Search above to browse the community library.';
    let voices: Voice[];
    try {
      const r = await fetch(`${opts.api}/voices?q=${encodeURIComponent(term)}`);
      if (!r.ok) throw new Error();
      voices = await r.json();
    } catch {
      if (mine === request) list.replaceChildren(el('p', 'vhint', 'The voice library did not respond. Try again in a moment.'));
      return;
    }
    if (mine !== request) return;
    if (!voices.length) return list.replaceChildren(el('p', 'vhint', `No voices found for "${term}".`));
    list.replaceChildren(...voices.map((v) => {
      const row = el('div', 'vrow' + (v.id === current() ? ' on' : ''));
      row.dataset.id = v.id;
      const info = el('div', 'vinfo');
      const name = el('div', 'vname', v.title);
      if (v.official) name.append(el('span', 'vbadge', 'original'));
      const meta = [v.author && !v.official ? `by ${v.author}` : '', ...v.tags.filter((t) => t !== 'female')].filter(Boolean).join(' · ');
      info.append(name, el('div', 'vtags', meta));
      if (v.about) info.append(el('div', 'vabout', v.about));
      const actions = el('div', 'vact');
      if (v.sample) {
        const play = el('button', '', '▶ Preview');
        play.type = 'button';
        play.onclick = () => {
          const was = playingBtn === play;
          stop();
          if (was) return;
          player.src = v.sample!;
          player.play().catch(() => { play.textContent = 'No preview'; });
          play.textContent = '■ Stop';
          playingBtn = play;
        };
        actions.append(play);
      }
      const use = el('button', 'vuse', 'Use');
      use.type = 'button';
      use.onclick = () => choose(v.id);
      actions.append(use);
      row.append(info, actions);
      return row;
    }));
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    const term = search.value.trim();
    // A Fish Audio voice ID can be pasted directly; the server checks it before using it.
    if (/^[a-f0-9]{32}$/i.test(term)) {
      choose(term.toLowerCase());
      hint.textContent = `Voice ${term.slice(0, 8)}… set for ${opts.persona().name}. If it is not allowed here, she keeps her current voice.`;
      return;
    }
    load(term);
  };

  return {
    choices,
    open() {
      title.textContent = `${opts.persona().name}'s voice`;
      search.value = '';
      dialog.showModal();
      load('');
    },
  };
}
