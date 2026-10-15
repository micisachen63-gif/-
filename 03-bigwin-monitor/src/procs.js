import { spawnSync } from 'node:child_process';

/** List processes by image name with command lines (Windows, via CIM). Returns [] elsewhere. */
export function listProcesses(imageName) {
  if (process.platform !== 'win32') return [];
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter "Name='${imageName}'" | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.status !== 0) throw new Error(`process query failed: ${String(r.stderr || '').slice(0, 200)}`);
  const text = String(r.stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, cmd: String(p.CommandLine || '') }));
}

const norm = (s) => String(s).replace(/\//g, '\\').toLowerCase();

/** True when a command line uses exactly this --user-data-dir (not a sibling dir with the same prefix). */
export function usesProfile(cmd, profileDir) {
  const c = norm(cmd);
  const p = norm(profileDir).replace(/\\+$/, '');
  for (const variant of [`--user-data-dir="${p}"`, `--user-data-dir=${p}`]) {
    const i = c.indexOf(variant);
    if (i === -1) continue;
    const next = c[i + variant.length];
    if (variant.endsWith('"') || next === undefined || next === ' ' || next === '"' || next === '\\') return true;
  }
  return false;
}

/** Top-level Chrome browser processes (not renderers/GPU helpers) that use the given profile. */
export function findProfileChromes(profileDir) {
  return listProcesses('chrome.exe')
    .filter((p) => !/\s--type=/.test(p.cmd) && usesProfile(p.cmd, profileDir))
    .map((p) => ({ pid: p.pid, headless: /\s--headless(=|\s|$)/.test(p.cmd), cdpPort: (/--remote-debugging-port=(\d+)/.exec(p.cmd) || [])[1] || null }));
}

export function killTree(pid) {
  if (process.platform !== 'win32') { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } return; }
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 });
}
