import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (process.env.MD_CHROME) cfg.chrome = process.env.MD_CHROME; // test override (not needed on the PC)
  return cfg;
}

export function parseArgs(argv) {
  const out = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// ---- months / dates (all dates are Asia/Taipei calendar dates, kept as 'YYYY-MM-DD') ----
export function parseMonth(s) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(s || ''));
  if (!m || +m[2] < 1 || +m[2] > 12) throw new Error(`月份格式需為 YYYY-MM（收到：${s}）`);
  return {y: +m[1], m: +m[2]};
}
export const prevMonth = ({y, m}) => (m === 1 ? {y: y - 1, m: 12} : {y, m: m - 1});
export const pad = (n) => String(n).padStart(2, '0');
export const monthKey = ({y, m}) => `${y}-${pad(m)}`;
export const daysIn = ({y, m}) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function taipeiToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}
export function defaultMonth() {
  const [y, m] = taipeiToday().split('-').map(Number);
  return prevMonth({y, m});
}
/** Period inside one month: whole month, or 1st..through (inclusive). */
export function period(month, through = null) {
  const key = monthKey(month);
  const last = daysIn(month);
  let endDay = last;
  if (through) {
    if (!String(through).startsWith(key + '-')) throw new Error(`--through 必須在 ${key} 月內`);
    endDay = +String(through).slice(8, 10);
    if (!(endDay >= 1 && endDay <= last)) throw new Error(`--through 日期不正確：${through}`);
  }
  const days = [];
  for (let d = 1; d <= endDay; d++) days.push(`${key}-${pad(d)}`);
  return {month, key, start: days[0], end: days[days.length - 1], days, full: endDay === last,
    label: `${month.m}月`, range: `${month.m}/1-${month.m}/${endDay}`};
}

// ---- formatting ----
export const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
/** Deck style: plain digits below 10,000 (e.g. 1137), separators from 10,000 up. */
export const fmtKpi = (n) => (Math.abs(n) >= 10000 ? fmtInt(n) : String(Math.round(n)));
export const fmtWan = (n) => (n / 1e4).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1});
export const fmtPct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
export const change = (cur, prev) => (prev ? (cur - prev) / prev : null);
const ZH = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
export const zhMonth = (m) => ZH[m - 1];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
export function readJson(file, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

export function makeLogger(file) {
  if (file) fs.mkdirSync(path.dirname(file), {recursive: true});
  return (...parts) => {
    const line = `[${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')}] ${parts.join(' ')}`;
    console.log(line);
    if (file) fs.appendFileSync(file, line + '\n', 'utf8');
  };
}
