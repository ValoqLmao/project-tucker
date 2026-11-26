// Turns the Claude Code session transcripts for this project into a sanitized
// public feed (data.json) and pushes it to the `live` branch.
//   node tracker/sync.mjs           one sync
//   node tracker/sync.mjs --watch   sync every 15s
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = path.join(ROOT, '.live');
const OUT = path.join(LIVE, 'data.json');
const STATUS = path.join(ROOT, 'tracker', 'status.json');
const SESSIONS = path.join(os.homedir(), '.claude', 'projects', ROOT.replace(/[^A-Za-z0-9]/g, '-'));

const MAX_TEXT = 8000, MAX_INPUT = 600;
const homeUser = path.basename(os.homedir());

// Extra private terms to scrub, kept out of git (tracker/redact.local.json).
let extra = [];
try { extra = JSON.parse(fs.readFileSync(path.join(ROOT, 'tracker', 'redact.local.json'), 'utf8')); } catch {}
const extraRe = extra.length
  ? new RegExp(extra.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
  : null;

function redact(s) {
  if (typeof s !== 'string') return '';
  if (extraRe) s = s.replace(extraRe, '***');
  return s
    .replace(/[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|anthropic\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(?:sk|pk|rk|xai|gsk|ghp|gho|ghs|vcp|key|sess|tok)[-_][A-Za-z0-9_\-]{16,}/g, '[secret]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[secret]')
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{10,}/g, '[secret]')
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, '[secret]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s\/@:]+:[^\s\/@]+@/gi, '$1[credentials]@')
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"']{6,}["']?/g, '$1=[secret]')
    .replace(/\b((?:pass(?:word|wd)?|secret|token|api[_-]?key|auth)[a-z_]*)\s*[=:]\s*["']?[^\s"'|)]{6,}["']?/gi, '$1=[secret]')
    .replace(/\bBasic\s+[A-Za-z0-9+\/=]{8,}/g, 'Basic [secret]')
    .replace(/(\s-u\s+)["']?[^\s"':]+:[^\s"']+["']?/g, '$1[credentials]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{12,}/g, 'Bearer [secret]')
    .replace(/\b(?=[A-Za-z0-9_\-]*[a-z])(?=[A-Za-z0-9_\-]*[A-Z])(?=[A-Za-z0-9_\-]*\d)[A-Za-z0-9_\-]{32,}\b/g, '[redacted]')
    .replace(/\b[a-f0-9]{40,}\b/g, '[redacted]')
    .replace(/C:\\\\?Users\\\\?[^\\\/\s"']+/gi, '~')
    .replace(/\/c\/Users\/[^\/\s"']+/gi, '~')
    .replace(new RegExp(`\\b${homeUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), 'user');
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + ` … [+${s.length - n} chars]` : s);

function cleanUserText(s) {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, '')
    .replace(/<(bash-stdout|bash-stderr|bash-input)>[\s\S]*?(?:<\/\1>|$)/g, '')
    .replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim();
}

function summarizeInput(name, input = {}) {
  if (name === 'Bash' || name === 'PowerShell') return input.command || '';
  if (name === 'Agent') return input.prompt || '';
  if (name === 'Write') return `${input.file_path} (${(input.content || '').length} chars)`;
  if (name === 'Edit') return `${input.file_path}`;
  if (name === 'Read') return `${input.file_path}`;
  return ''; // any other tool: name and description only
}

function build() {
  const files = fs.existsSync(SESSIONS)
    ? fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(SESSIONS, f))
    : [];
  const events = [];
  const calls = new Map();
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta) continue;
      // Compaction summaries can restate tool output, so they are never published.
      if (o.isCompactSummary || o.isVisibleInTranscriptOnly) continue;
      const t = o.timestamp;
      const content = o.message?.content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];
      for (const b of blocks) {
        if (o.type === 'user' && b.type === 'text') {
          const raw = cleanUserText(b.text || '');
          if (!raw) continue;
          const isNote = /^<task-notification>|^\[Request interrupted/.test(raw);
          events.push({ t, kind: isNote ? 'note' : 'prompt', text: clip(redact(raw.replace(/<[^>]+>/g, isNote ? ' ' : '$&')), isNote ? 3000 : MAX_TEXT) });
        } else if (o.type === 'user' && b.type === 'tool_result') {
          const ev = calls.get(b.tool_use_id);
          if (!ev) continue;
          // Tool output is never published: it can hold file contents or command stdout.
          if (b.is_error) ev.error = true;
        } else if (o.type === 'assistant' && b.type === 'text') {
          if (b.text?.trim()) events.push({ t, kind: 'claude', text: clip(redact(b.text.trim()), MAX_TEXT) });
        } else if (o.type === 'assistant' && b.type === 'tool_use') {
          const ev = {
            t, kind: 'tool', tool: b.name,
            title: redact(b.input?.description || ''),
            input: clip(redact(summarizeInput(b.name, b.input)), b.name === 'Agent' ? 2500 : MAX_INPUT),
          };
          calls.set(b.id, ev);
          events.push(ev);
        }
      }
    }
  }
  events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  let status = {};
  try { status = JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch {}
  return { status, lastActivity: events.at(-1)?.t || null, count: events.length, events };
}

const git = (...a) => execFileSync('git', ['-C', LIVE, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function syncOnce() {
  if (process.env.DRY) return fs.writeFileSync(process.env.DRY, JSON.stringify(build(), null, 1));
  if (!fs.existsSync(path.join(LIVE, '.git'))) return console.error('no .live worktree; skipping');
  const body = JSON.stringify(build());
  if (fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === body) return;
  fs.writeFileSync(OUT, body);
  try {
    git('add', 'data.json');
    let hasCommit = true;
    try { git('rev-parse', 'HEAD'); } catch { hasCommit = false; }
    git('commit', '-q', ...(hasCommit ? ['--amend'] : []), '-m', 'live feed');
    git('push', '-q', '-f', 'origin', 'HEAD:live');
    console.log(new Date().toISOString(), 'pushed', body.length, 'bytes');
  } catch (e) {
    console.error('push failed:', String(e.stderr || e.message).slice(0, 300));
    try { fs.unlinkSync(OUT); } catch {} // force a retry next tick
  }
}

if (process.argv.includes('--watch')) {
  for (;;) {
    try { syncOnce(); } catch (e) { console.error(e.message); }
    await new Promise((r) => setTimeout(r, 15000));
  }
} else {
  syncOnce();
}
