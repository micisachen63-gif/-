import fs from 'node:fs';
import path from 'node:path';
import { listProcesses } from './procs.js';
import { isPidAlive, readJson } from './util.js';

/** A lock holder counts only if the pid is alive AND is a node process running this project. */
export function holderAlive(pid, { projectMarker = process.env.FAIRY_SERVICE_ROLE === 'operations' ? '神殿守望者\\service.mjs' : '爆分監控\\src\\index.js', verifyCommandLine = true } = {}) {
  if (!isPidAlive(pid)) return false;
  if (!verifyCommandLine || process.platform !== 'win32') return true;
  try {
    const p = listProcesses('node.exe').find((x) => x.pid === pid);
    if (!p) return false;
    const cmd = p.cmd.toLowerCase().replace(/\//g, '\\');
    return cmd.includes(projectMarker.toLowerCase()) || cmd.includes('\\src\\index.js') || cmd.includes(' src\\index.js') || cmd.includes('service.mjs');
  } catch {
    return true; // cannot verify: be conservative and respect the lock
  }
}

export function readLock(file) {
  try { return readJson(file); } catch { return null; }
}

/** Exclusive-create lock file; steals it only from a dead holder. */
export function acquireLock(file, role, opts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, role, at: new Date().toISOString() }), { flag: 'wx' });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const cur = readLock(file);
      if (cur?.pid === process.pid) return true;
      if (cur && holderAlive(cur.pid, opts)) return false;
      try { fs.unlinkSync(file); } catch { /* raced */ }
    }
  }
  return false;
}

export function releaseLock(file) {
  const cur = readLock(file);
  if (cur?.pid === process.pid) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
}

export function holdsLock(file) {
  return readLock(file)?.pid === process.pid;
}
