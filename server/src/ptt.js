// Push-to-talk: holds a keyboard key down on this machine while the voice is playing, so a game's
// voice chat transmits it. Windows only, Node host only. The key is chosen by the server's own
// configuration (PTT_KEY), never by the browser, and it is always let go again after MAX_HOLD_MS.
import { spawn, execFileSync } from 'node:child_process';

const MAX_HOLD_MS = 30_000;

/** 'v' -> its Windows virtual-key code. Letters, digits and F1..F24 only. */
function keyCode(key) {
  const k = String(key || '').trim().toUpperCase();
  if (/^[A-Z0-9]$/.test(k)) return k.charCodeAt(0);
  const f = /^F([1-9]|1\d|2[0-4])$/.exec(k);
  return f ? 0x6f + Number(f[1]) : 0;
}

// Reads "d <code>" / "u <code>" lines. Whatever is still held when the input closes is released.
const HELPER = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -Namespace Tucker -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra); [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);'
function Send-Key([byte]$vk, [uint32]$flags) { [Tucker.Keys]::keybd_event($vk, [byte][Tucker.Keys]::MapVirtualKey($vk, 0), $flags, [UIntPtr]::Zero) }
$held = @{}
try {
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Trim().Split(' ')
  if ($p.Length -ne 2) { continue }
  $vk = [byte]$p[1]
  if ($p[0] -eq 'd') { Send-Key $vk 0; $held[$vk] = 1 } else { Send-Key $vk 2; $held.Remove($vk) }
}
} finally { foreach ($vk in @($held.Keys)) { Send-Key $vk 2 } }
`;

/** Returns hold(down: boolean), or null where this cannot work. */
export function makePtt(key, log = () => {}) {
  const vk = keyCode(key);
  if (!vk || process.platform !== 'win32') return null;
  let ps = null, held = false, timer = null;
  const helper = () => {
    if (ps && ps.exitCode === null) return ps;
    ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(HELPER, 'utf16le').toString('base64')],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    ps.on('error', (e) => log('push-to-talk helper failed', e.message));
    ps.stdin.on('error', () => {});
    ps.stderr.on('data', (d) => { const s = d.toString(); if (!/CLIXML|^<Objs/.test(s)) log('push-to-talk helper:', s.trim().slice(0, 200)); });
    return ps;
  };
  // If this process stops mid-reply the helper usually dies with it, so the key is let go from here.
  process.on('exit', () => {
    if (!held) return;
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(HELPER.split('$held = @{}')[0] + `Send-Key ${vk} 2`, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true, timeout: 8000 }); } catch {}
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(0));
  helper(); // it takes a second to start, so have it ready before the first reply
  return function hold(down) {
    if (down === held) return;
    held = down;
    clearTimeout(timer);
    if (down) timer = setTimeout(() => hold(false), MAX_HOLD_MS);
    try { helper().stdin.write(`${down ? 'd' : 'u'} ${vk}\n`); } catch (e) { log('push-to-talk failed', e.message); }
  };
}
