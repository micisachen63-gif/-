// Serialized, persistent append queue for 小遊戲紀錄 rows + the "營運數據 is busy" guard.
// The CSV/JSONL written by records.js stay the backup; this queue (remote-queue.json) is the retry list.
import fs from 'node:fs';

export const OPS_ROOT = 'C:\\Users\\User\\Documents\\Codex\\2026-09-18\\new-chat\\outputs\\operations-program';
/** ThreePlatformOperations0800 starts 08:00 (Asia/Taipei) and may run up to its 40-min guard; keep a margin on both sides. */
export const DEFAULT_OPS_WINDOWS = [['07:55', '08:50']];

const taipeiMinutes = (now) => { const d = new Date(now + 8 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export function inWindows(now, windows = DEFAULT_OPS_WINDOWS) {
  const t = taipeiMinutes(now);
  return windows.some(([a, b]) => { const s = toMin(a), e = toMin(b); return s <= e ? t >= s && t < e : t >= s || t < e; });
}
export function processAlive(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
/** Returns a reason string when the 營運數據 job is (probably) using the 19385 Chrome, else null. */
export function opsBusy({ now = Date.now(), root = OPS_ROOT, windows = DEFAULT_OPS_WINDOWS, readFile = fs.readFileSync, kill = process.kill, staleMs = 45 * 60e3 } = {}) {
  if (inWindows(now, windows)) return 'ops-window';
  try { const lock = JSON.parse(readFile(`${root}\\private\\run.lock`, 'utf8') || '{}'); if (processAlive(Number(lock.pid), kill)) return 'ops-lock'; } catch { /* no lock */ }
  try {
    const s = JSON.parse(readFile(`${root}\\logs\\latest.json`, 'utf8'));
    const started = Date.parse(s.started);
    if (!s.finished && Number.isFinite(started) && now - started >= 0 && now - started < staleMs) return 'ops-running';
  } catch { /* none */ }
  return null;
}

/**
 * write(target, rows) appends rows to the target and resolves when verified; throw err.permanent=true for failures
 * that must not be retried automatically (e.g. read-back mismatch after a write, to avoid duplicate rows).
 */
export function createAppendQueue({ file, write, busy = () => null, log = console, now = () => Date.now(), backoffMs = (n) => Math.min(60, 2 ** n) * 60e3, maxAttempts = 50 }) {
  const read = () => { try { const q = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(q) ? q.map((x, i) => ({ attempts: 0, nextAt: 0, ...x, id: x.id || `legacy-${x.at || 0}-${i}` })) : []; } catch { return []; } };
  const save = (q) => { fs.writeFileSync(file + '.tmp', JSON.stringify(q, null, 1)); fs.renameSync(file + '.tmp', file); };
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

  function enqueue(groupKey, rows) {
    return serial(() => { const q = read(); q.push({ id: `${now()}-${Math.random().toString(36).slice(2, 8)}`, groupKey, rows, at: now(), attempts: 0, nextAt: 0 }); save(q); });
  }
  /** Sends due items in FIFO order per group; a failing group stops (keeps row order) until its next retry time. */
  function flush({ targetFor }) {
    return serial(async () => {
      const result = { sent: 0, deferred: null, failed: 0 };
      let q = read(); if (!q.length) return result;
      const blocked = new Set();
      for (const item of [...q]) {
        if (item.state === 'held' || blocked.has(item.groupKey)) continue;
        const target = targetFor(item.groupKey);
        if (!target) { blocked.add(item.groupKey); continue; }
        if (item.nextAt > now()) { blocked.add(item.groupKey); continue; }
        const reason = busy(target); if (reason) { result.deferred = reason; blocked.add(item.groupKey); continue; }
        try {
          await write(target, item.rows);
          q = read().filter((x) => x.id !== item.id); save(q); result.sent++;
        } catch (error) {
          result.failed++; blocked.add(item.groupKey);
          q = read(); const cur = q.find((x) => x.id === item.id);
          if (cur) {
            cur.attempts = (cur.attempts || 0) + 1; cur.lastError = String(error?.message || error).slice(0, 300);
            if (error?.permanent || cur.attempts >= maxAttempts) { cur.state = 'held'; log.warn?.(`records: ${item.groupKey} append held for manual check: ${cur.lastError}`); }
            else { cur.nextAt = now() + backoffMs(cur.attempts); log.warn?.(`records: ${item.groupKey} append failed (try ${cur.attempts}), retry later: ${cur.lastError}`); }
            save(q);
          }
        }
      }
      return result;
    });
  }

  function update(groupKey, match, updates, { targetFor } = {}) {
    return serial(async () => {
      let q = read();
      let updatedInQueue = false;
      for (const item of q) {
        if (item.groupKey !== groupKey) continue;
        for (const row of item.rows) {
          const isMatch = Object.entries(match).every(([k, v]) => String(row[k] ?? '') === String(v));
          if (isMatch) {
            Object.assign(row, updates);
            updatedInQueue = true;
          }
        }
      }
      if (updatedInQueue) {
        save(q);
        return { updatedInQueue: true };
      }
      if (targetFor && typeof write?.update === 'function') {
        const target = targetFor(groupKey);
        if (target) {
          try {
            const ok = await write.update(target, match, updates);
            return { updatedRemote: ok };
          } catch (e) {
            log.warn?.(`records: remote sheet update failed: ${e.message}`);
          }
        }
      }
      return { updated: false };
    });
  }

  return { enqueue, flush, update, pending: () => read() };
}
