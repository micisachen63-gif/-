import { AuthError } from './errors.js';
import { escapeHtml as esc, fmtMoney, toNumber, TAIPEI_OFFSET_MS } from './util.js';

/**
 * 出金通知: players selling coins to a brand's coin dealer (平台報表 → 收贈禮統計 → 贈禮排行).
 * Each scan reads today's gift ranking, keeps rows "player → dealer", and notifies the private
 * group when a (date, 贈禮AID, 對象AID) record is new or its amounts changed since the last scan.
 */

const HOUR = 3600e3;
const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' in Asia/Taipei. */
export function taipeiDate(ms = Date.now()) {
  const d = new Date(ms + TAIPEI_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 'HH:MM' in Asia/Taipei. */
export function taipeiHHMM(ms = Date.now()) {
  const d = new Date(ms + TAIPEI_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export const cashoutEnabled = (cfg, brand) => cfg.cashout?.enabled !== false && Boolean(brand.cashout?.dealers?.length);

const name = (v) => String(v ?? '').trim();
export const recordKey = (row) => `${row.from}:${row.to}`;
export const cashoutKey = (date, row) => `${date}|${recordKey(row)}`;

/** Rows where a player (not a dealer) gave coins to one of the brand's dealers. */
export function filterCashouts(rows, dealers) {
  const set = new Set(dealers.map(name));
  return rows.filter((r) => set.has(name(r.to_nickname)) && !set.has(name(r.from_nickname)));
}

/** dealer name -> sorted AIDs seen in the rows (either side). */
export function collectDealerAids(rows, dealers) {
  const set = new Set(dealers.map(name));
  const out = {};
  const add = (n, aid) => { if (set.has(name(n)) && aid != null) (out[name(n)] ||= new Set()).add(String(aid)); };
  for (const r of rows) { add(r.to_nickname, r.to); add(r.from_nickname, r.from); }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, [...out[k]].sort()]));
}

const same = (a, b) => toNumber(a) === toNumber(b);

/** New records, or records whose 差額 / 贈禮總金額 changed vs. the day's saved state (儲值 / 餘額 changes alone never trigger). */
export function diffCashouts(rows, dayState = {}) {
  const out = [];
  for (const row of rows) {
    const prev = dayState[recordKey(row)];
    if (!prev) out.push({ row, status: 'new', prev: null });
    else if (!same(prev.rang, row.rang_money) || !same(prev.give, row.give_money)) out.push({ row, status: 'changed', prev });
  }
  return out;
}

const MINUS = '−';

/** NT$ amount rounded to an integer; sign: '+' only when requested, '−' for negatives. */
export function fmtNtd(value, { plus = false } = {}) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? MINUS : (plus && n > 0 ? '+' : '');
  return `${sign}NT$${Math.abs(n).toLocaleString('en-US')}`;
}

/** Colored marks before the 今日輸贏 amount; override via config.json cashout.winMark / lossMark / evenMark ("" = no mark). */
export const DEFAULT_MARKS = Object.freeze({ win: '🟢▲', loss: '🔴▼', even: '⚪' });
export function cashoutMarks(cfg) {
  const co = cfg?.cashout || {};
  const pick = (v, d) => (typeof v === 'string' ? v.trim() : d);
  return { win: pick(co.winMark, DEFAULT_MARKS.win), loss: pick(co.lossMark, DEFAULT_MARKS.loss), even: pick(co.evenMark, DEFAULT_MARKS.even) };
}

/** 今日輸贏 = 差額 ÷ rate − 今日儲值 (儲值 is already TWD). null when 儲值 is unknown. */
export function netTwd(row, rate, charge) {
  if (charge == null) return null;
  const n = toNumber(row.rang_money) / Number(rate) - toNumber(charge);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function fmtBalance(balance) {
  if (balance === 'missing') return '查無此玩家';
  const n = toNumber(balance);
  return balance == null || !Number.isFinite(n) ? '查詢失敗' : fmtMoney(n);
}

/**
 * Private-group message (HTML). charge: today's 儲值金額 in TWD, or null when the lookup failed.
 * balance: player's current coins (會員管理 money); null = lookup failed, 'missing' = no such AID.
 */
export function formatCashout(brand, { row, status, prev }, { charge, balance, at, marks = DEFAULT_MARKS }) {
  const rate = brand.cashout.twdRate;
  const net = netTwd(row, rate, charge);
  const mark = net > 0 ? marks.win : net < 0 ? marks.loss : marks.even;
  const verdict = net == null ? '—（今日儲值查詢失敗）' : `${mark ? `${mark} ` : ''}${fmtNtd(net, { plus: true })}${net > 0 ? '（玩家贏錢）' : net < 0 ? '（玩家輸錢）' : '（持平）'}`;
  let state = '🆕 新紀錄';
  if (status === 'changed') {
    state = `🔄 金額變動（原差額 ${fmtMoney(prev.rang)} → 新差額 ${fmtMoney(row.rang_money)}`;
    if (!same(prev.give, row.give_money)) state += `；原贈禮總金額 ${fmtMoney(prev.give)} → ${fmtMoney(row.give_money)}`;
    state += '）';
  }
  const player = name(row.from_nickname) || '（無暱稱）';
  return [
    `💸 <b>出金通知｜${esc(brand.name)}</b>`,
    `狀態：${state}`,
    `玩家：${esc(player)}（AID <code>${esc(row.from)}</code>）`,
    `幣商：${esc(name(row.to_nickname))}`,
    `贈禮總金額：${fmtMoney(row.give_money)}`,
    `差額：<b>${fmtMoney(row.rang_money)}</b>（約 ${fmtNtd(toNumber(row.rang_money) / Number(rate))}）`,
    `今日儲值：${charge == null ? '查詢失敗' : fmtNtd(toNumber(charge))}`,
    `今日輸贏：<b>${verdict}</b>`,
    `身上金幣剩餘：${fmtBalance(balance)}`,
    `時間：${taipeiHHMM(at)}`,
  ].join('\n');
}

/** All rows of today's 贈禮排行 (Laravel pagination). */
export async function fetchGiftRank(client, date, { limit = 5000, maxPages = 20 } = {}) {
  const rows = [];
  for (let page = 1; ; page++) {
    const r = await client.fetchGiftRank({ date, page, limit });
    rows.push(...r.rows);
    const perPage = Number(r.perPage) || limit;
    const lastPage = Math.max(1, Math.ceil((Number(r.total) || 0) / perPage));
    if (page >= lastPage || r.rows.length === 0) break;
    if (page >= maxPages) throw new Error(`txnRank: too many pages (${lastPage})`);
  }
  return rows;
}

/** State file layout: { days: { date: { brandKey: { "from:to": {give, rang, ...} } } }, brands: { brandKey: {...} } } */
export function pruneDays(data, today, keepDays = 3) {
  const cutoff = Date.parse(`${today}T00:00:00Z`) - keepDays * 24 * HOUR;
  for (const d of Object.keys(data.days)) if (!(Date.parse(`${d}T00:00:00Z`) >= cutoff)) delete data.days[d];
}

/** One 出金 scan of one brand. Records are saved only after a successful send, so failures retry next scan. */
export async function scanCashout({ brand, client, store, notifier, cfg, now, log, opts = {} }) {
  const co = cfg.cashout || {};
  const date = taipeiDate(now);
  const all = await fetchGiftRank(client, date, { limit: co.pageLimit ?? 5000, maxPages: co.maxPages ?? 20 });
  const bs = (store.data.brands[brand.key] ||= {});

  const seen = collectDealerAids(all, brand.cashout.dealers);
  const merged = { ...(bs.dealerAids || {}) };
  for (const [n, a] of Object.entries(seen)) merged[n] = [...new Set([...(merged[n] || []), ...a])].sort();
  if (JSON.stringify(merged) !== JSON.stringify(bs.dealerAids || {})) {
    log.info(`dealer AIDs seen: ${Object.entries(merged).map(([n, a]) => `${n}=${a.join('/')}`).join(', ')}`);
    bs.dealerAids = merged;
    store.save();
  }

  const matched = filterCashouts(all, brand.cashout.dealers);
  const day = ((store.data.days[date] ||= {})[brand.key] ||= {});
  const changes = diffCashouts(matched, day);
  changes.sort((a, b) => toNumber(b.row.rang_money) - toNumber(a.row.rang_money));

  let charges = null;
  if (changes.length) {
    try {
      charges = new Map((await client.fetchPurchaseRank({ date })).map((r) => [String(r.a_id), toNumber(r.price)]));
    } catch (error) {
      if (error instanceof AuthError) throw error;
      log.warn(`purchaseRank failed (${error.message}); 今日儲值 shown as 查詢失敗`);
    }
  }

  let sent = 0;
  for (const change of changes) {
    const { row } = change;
    const charge = charges ? (charges.get(String(row.from)) ?? 0) : null;
    let balance = null;
    try {
      const player = await client.lookupPlayer(row.from);
      balance = player ? player.money : 'missing';
    } catch (error) {
      if (error instanceof AuthError) throw error;
      log.warn(`player lookup failed for ${row.from} (${error.message}); 身上金幣剩餘 shown as 查詢失敗`);
    }
    const text = formatCashout(brand, change, { charge, balance, at: now, marks: cashoutMarks(cfg) });
    try {
      await notifier.sendText(text, { label: `出金通知 ${brand.name}` });
    } catch (error) {
      log.error(`cash-out notice ${cashoutKey(date, row)} send failed: ${error.message}`);
      continue;
    }
    day[recordKey(row)] = { give: toNumber(row.give_money), rang: toNumber(row.rang_money), fromName: name(row.from_nickname), dealer: name(row.to_nickname), notifiedAt: now };
    store.save();
    sent++;
    log.info(`cash-out notice ${change.status}: ${cashoutKey(date, row)} ${name(row.from_nickname)} → ${name(row.to_nickname)} 差額 ${row.rang_money}`);
    if (changes.length > 1) await notifier.pace?.();
  }
  pruneDays(store.data, date);
  store.save();
  return { date, rows: all.length, matched: matched.length, changes: changes.length, sent, dry: Boolean(opts.dry) };
}

/** Failure-isolated wrapper (never throws). Alerts after cfg.scanFailuresBeforeAlert consecutive failures. */
export async function runCashoutCycle(ctx) {
  const { brand, store, notifier, cfg, now, log } = ctx;
  const bs = (store.data.brands[brand.key] ||= {});
  try {
    const r = await scanCashout(ctx);
    bs.consecutiveFailures = 0;
    bs.lastError = null;
    bs.lastOkAt = now;
    store.save();
    return { ok: true, ...r };
  } catch (error) {
    bs.consecutiveFailures = (bs.consecutiveFailures || 0) + 1;
    bs.lastError = error.message;
    log.error(`cash-out scan failed (${bs.consecutiveFailures} in a row): ${error.message}`);
    const after = cfg.scanFailuresBeforeAlert ?? 6;
    const cooldown = (cfg.scanFailureAlertCooldownHours ?? 6) * HOUR;
    if (after > 0 && bs.consecutiveFailures >= after && (!bs.lastFailureAlertAt || now - bs.lastFailureAlertAt >= cooldown)) {
      try {
        await notifier.sendText([
          `⚠️ 出金通知：${esc(brand.name)} 已連續 ${bs.consecutiveFailures} 次查詢失敗`,
          `最後錯誤：${esc(String(error.message ?? '').slice(0, 200))}`,
          '系統會持續自動重試；恢復後會補發當天有變動的紀錄。',
        ].join('\n'));
        bs.lastFailureAlertAt = now;
      } catch (e) { log.error(`cash-out failure alert send failed: ${e.message}`); }
    }
    store.save();
    return { ok: false, error: error.message };
  }
}
