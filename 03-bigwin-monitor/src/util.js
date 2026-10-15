import fs from 'node:fs';
import path from 'node:path';

// Asia/Taipei has no DST: fixed UTC+8, independent of the host timezone setting.
export const TAIPEI_OFFSET_MS = 8 * 3600e3;
const pad = (n, w = 2) => String(n).padStart(w, '0');

function parts(ms) {
  const d = new Date(ms + TAIPEI_OFFSET_MS);
  return {
    Y: d.getUTCFullYear(), M: pad(d.getUTCMonth() + 1), D: pad(d.getUTCDate()),
    h: pad(d.getUTCHours()), m: pad(d.getUTCMinutes()), s: pad(d.getUTCSeconds()),
  };
}

/** Backend query format: 'YYYY/MM/DD HH:mm:ss' (Taipei local). */
export function fmtApiTime(ms) {
  const p = parts(ms);
  return `${p.Y}/${p.M}/${p.D} ${p.h}:${p.m}:${p.s}`;
}

/** Log format: 'YYYY-MM-DD HH:mm:ss' (Taipei local). */
export function fmtStamp(ms = Date.now()) {
  const p = parts(ms);
  return `${p.Y}-${p.M}-${p.D} ${p.h}:${p.m}:${p.s}`;
}

export function fileStamp(ms = Date.now()) {
  const p = parts(ms);
  return `${p.Y}${p.M}${p.D}-${p.h}${p.m}${p.s}`;
}

/** Parse a backend row time 'YYYY-MM-DD HH:mm:ss' (Taipei local) to epoch ms; NaN if invalid. */
export function parseRowTime(value) {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value ?? ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - TAIPEI_OFFSET_MS;
}

/** 'MM-DD HH:mm:ss' for alerts. */
export function shortTime(value) {
  const ms = parseRowTime(value);
  if (!Number.isFinite(ms)) return String(value ?? '');
  const p = parts(ms);
  return `${p.M}-${p.D} ${p.h}:${p.m}:${p.s}`;
}

export function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  const text = String(value).replace(/,/g, '').trim();
  if (text === '') return NaN;
  return Number(text);
}

export function fmtMoney(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw error;
  }
}

/** Atomic JSON write (tmp + rename) with retries for transient Windows EPERM/EBUSY locks. */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw error;
      }
      const until = Date.now() + 50 * (attempt + 1);
      while (Date.now() < until) { /* short sync backoff */ }
    }
  }
}

/** Minimal .env reader (BOM-safe). Returns key/value object; values are never logged. */
export function readEnvFile(file) {
  const out = {};
  for (const line of readText(file).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Remove anything that looks like a Telegram bot token from text before logging. */
export function redact(text) {
  return String(text)
    .replace(/\d{6,12}:[A-Za-z0-9_-]{25,}/g, '<redacted-token>')
    .replace(/Bearer\s+[^\s"',;]{6,}/gi, 'Bearer <redacted>')
    .replace(/https:\/\/[^\s"']*\/automations\/[^\s"']*/gi, '<relay-url>');
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
