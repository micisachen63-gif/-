// 社群版 參與條件: pure helpers (no I/O). Dates are Taipei calendar dates 'YYYY-MM-DD'.
export const TAIPEI_MS = 8 * 3600e3;
export const taipeiDate = (ms = Date.now()) => new Date(ms + TAIPEI_MS).toISOString().slice(0, 10);
export const md = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
export const fmtNum = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
export const GAMES = Object.freeze({
  ww: { key: 'ww', name: '狼人殺', emoji: '🐺', max: 9 },
  uc: { key: 'uc', name: '誰是臥底', emoji: '🕵️', max: 20 },
  hg: { key: 'hg', name: '海龜湯', emoji: '🐢', max: 20 },
  es: { key: 'es', name: '密室逃脫', emoji: '🚪', max: 10 },
  sc: { key: 'sc', name: '千鎖秘藏', emoji: '🔐', max: 200 },
});
export const gameLabel = (g) => `${GAMES[g].emoji} ${GAMES[g].name}`;

/** Parse a typed amount: 「1000」「1,000」「1萬」「0.5萬」 → number; null when invalid. */
export function parseAmount(text) {
  const s = String(text || '').trim().replace(/[,，\s]/g, '').replace(/^NT\$?/i, '');
  const m = /^(\d+(?:\.\d+)?)(萬|w|W|k|K|千)?$/.exec(s);
  if (!m) return null;
  const mult = { 萬: 1e4, w: 1e4, W: 1e4, k: 1e3, K: 1e3, 千: 1e3 }[m[2]] || 1;
  const n = Math.round(Number(m[1]) * mult);
  return Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : null;
}

/** 「10/01-10/03」「2026/10/01~2026/10/03」「10/1」 → { start, stop } (Taipei dates). The year is the current Taipei year,
 *  or last year when the range would otherwise start more than 31 days in the future. null when invalid. */
export function parsePeriod(text, nowMs = Date.now()) {
  const today = taipeiDate(nowMs); const year = Number(today.slice(0, 4));
  const parts = String(text || '').trim().replace(/\s/g, '').split(/[-~～至到]/).filter(Boolean);
  if (!parts.length || parts.length > 2) return null;
  const one = (p, y) => {
    const m = /^(?:(\d{4})[/.-])?(\d{1,2})[/.-](\d{1,2})$/.exec(p); if (!m) return null;
    const yy = Number(m[1] || y), mm = Number(m[2]), dd = Number(m[3]);
    const d = new Date(Date.UTC(yy, mm - 1, dd));
    if (d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
    return { iso: d.toISOString().slice(0, 10), explicit: Boolean(m[1]) };
  };
  let a = one(parts[0], year); if (!a) return null;
  if (!a.explicit && Date.parse(a.iso) - Date.parse(today) > 31 * 864e5) a = one(parts[0], year - 1);
  let b = parts[1] ? one(parts[1], Number(a.iso.slice(0, 4))) : a; if (!b) return null;
  if (!parts[1]?.match(/^\d{4}/) && b.iso < a.iso) b = one(parts[1], Number(a.iso.slice(0, 4)) + 1);
  if (b.iso < a.iso || (Date.parse(b.iso) - Date.parse(a.iso)) > 92 * 864e5) return null; // at most ~3 months
  return { start: a.iso, stop: b.iso };
}

/** period: { type: 'today' } | { type: 'range', start, stop } → concrete dates now. */
export function resolvePeriod(period, nowMs = Date.now()) {
  if (period?.type === 'range') return { start: period.start, stop: period.stop };
  const d = taipeiDate(nowMs); return { start: d, stop: d };
}
export const periodLabel = (period) => (period?.type === 'range' ? (period.start === period.stop ? md(period.start) : `${md(period.start)}–${md(period.stop)}`) : '\u7576\u65E5');

/** conditions: { vip: number|null, recharge: { min, period }|null, wager: { min, period }|null } */
export function describeConditions(c = {}) {
  const parts = [];
  if (c.vip != null) parts.push(`VIP ${c.vip} 以上`);
  if (c.recharge) parts.push(`${periodLabel(c.recharge.period)}儲值滿 ${fmtNum(c.recharge.min)}`);
  if (c.wager) parts.push(`${periodLabel(c.wager.period)}打碼滿 ${fmtNum(c.wager.min)}`);
  return parts.length ? parts.join('、') : '\u7121\u9580\u6abb';
}
export const needsBackend = (c = {}) => c.vip != null || Boolean(c.recharge) || Boolean(c.wager);

/** status: { vip, recharge, wager } (numbers; recharge / wager already summed over each condition's period). */
export function evaluateConditions(status = {}, c = {}) {
  const shortfalls = [];
  if (c.vip != null && !(Number(status.vip) >= c.vip)) shortfalls.push(`VIP 目前 ${status.vip ?? 0}，活動條件 VIP ${c.vip} 以上，還差 ${c.vip - Number(status.vip || 0)} 級`);
  if (c.recharge && !(Number(status.recharge) >= c.recharge.min)) shortfalls.push(`${periodLabel(c.recharge.period)}儲值 ${fmtNum(status.recharge)}，活動條件 ${fmtNum(c.recharge.min)}，還差 ${fmtNum(c.recharge.min - Number(status.recharge || 0))}`);
  if (c.wager && !(Number(status.wager) >= c.wager.min)) shortfalls.push(`${periodLabel(c.wager.period)}打碼 ${fmtNum(status.wager)}，活動條件 ${fmtNum(c.wager.min)}，還差 ${fmtNum(c.wager.min - Number(status.wager || 0))}`);
  return { ok: shortfalls.length === 0, shortfalls };
}
export function statusLine(status = {}, c = {}) {
  const parts = [`VIP ${status.vip ?? '-'}`];
  if (c.recharge) parts.push(`${periodLabel(c.recharge.period)}儲值 ${fmtNum(status.recharge)}`);
  if (c.wager) parts.push(`${periodLabel(c.wager.period)}打碼 ${fmtNum(status.wager)}`);
  return parts.join('｜');
}
export function prizeLabel(round) {
  if (!(round?.prize > 0)) return '不設';
  return `每位優勝 ${fmtNum(round.prize)}${round.multiplier > 0 ? `（${round.multiplier} 倍打碼）` : ''}`;
}
