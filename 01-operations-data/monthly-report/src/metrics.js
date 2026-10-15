import {change} from './util.js';

// Daily KPIs come from the backend (平台報表 → 儲值統計 + X日登). Checked day by day against the
// operations sheet for 2026-07..08 on all three brands (every column identical):
//  DAU   = floor(average of daily DAU)
//  NU    = round(sum of daily 0日登 / days)
//  玩家儲值 = sum of daily 總金額
//  ARPPU = round(average of daily ARPPU), daily ARPPU = round(金額 / DPU, 2) like the sheet
//  首儲總額 = sum of daily 首儲總額
// Month-over-month % is computed from the displayed (rounded) values, like the deck.

/** PHP serialises {"0":..,"1":..} with contiguous keys as a JSON array; read both shapes. */
export const asObj = (v) => (Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), x])) : v && typeof v === 'object' ? v : {});

export function dailyFromBackend({purchase, xlogin}) {
  const map = new Map();
  for (const [d, raw] of Object.entries(asObj(purchase))) {
    const o = asObj(raw), a = asObj(o._1), f = asObj(o._2), p = asObj(o._5);
    const dpu = num(p._4), amt = num(p._3);
    map.set(d, {DAU: num(a._3), DPU: dpu, 總筆數: num(p._2), 總金額: amt, ARPPU: dpu ? Math.round((amt / dpu) * 100) / 100 : 0,
      首儲人數: num(p._1), 首儲總額: num(f._15), '0日登': null});
  }
  for (const [d, raw] of Object.entries(asObj(xlogin))) {
    const r = map.get(d) || {DAU: null};
    r['0日登'] = num(asObj(raw)['0']);
    map.set(d, r);
  }
  return map;
}

export const missingDays = (daily, per) => per.days.filter((d) => !(daily.get(d)?.DAU > 0) || daily.get(d)['0日登'] == null);

export function kpiFor(daily, per, {allowPartial = false, label = ''} = {}) {
  const missing = missingDays(daily, per);
  if (missing.length && !allowPartial) {
    throw new Error(`${label}後台尚未有完整的每日數據：缺 ${missing.length} 天（${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}）。請稍後再跑，或加 --allow-partial`);
  }
  const days = per.days.filter((d) => !missing.includes(d));
  if (!days.length) throw new Error(`${per.key} 沒有任何資料`);
  const col = (k) => days.map((d) => daily.get(d)[k] ?? 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return {
    dau: Math.floor(sum(col('DAU')) / days.length),
    nu: Math.round(sum(col('0日登')) / days.length),
    nuExact: sum(col('0日登')) / days.length,
    nuSum: sum(col('0日登')),
    revenue: Math.round(sum(col('總金額'))),
    arppu: Math.round(sum(col('ARPPU')) / days.length),
    arppuExact: sum(col('ARPPU')) / days.length,
    firstDeposit: Math.round(sum(col('首儲總額'))),
    days: days.length,
    daily: days.map((d) => ({date: d, dau: daily.get(d).DAU, nu: daily.get(d)['0日登'], revenue: daily.get(d).總金額})),
    missing,
  };
}

export function kpiCompare(prev, cur) {
  const out = {};
  for (const k of ['dau', 'nu', 'revenue', 'arppu', 'firstDeposit']) out[k] = {prev: prev[k], cur: cur[k], pct: change(cur[k], prev[k])};
  return out;
}

/** 儲值排行 rows -> contribution tiers. */
export function tiersFor(rows, tiersCfg) {
  const byPlayer = new Map();
  for (const r of rows) {
    const id = String(r.a_id ?? r.aid ?? '');
    const v = Number(r.price ?? 0);
    if (!id || !Number.isFinite(v)) continue;
    byPlayer.set(id, (byPlayer.get(id) || 0) + v);
  }
  const sorted = [...tiersCfg].sort((a, b) => b.min - a.min);
  const res = Object.fromEntries(tiersCfg.map((t) => [t.key, {users: 0, amount: 0}]));
  let users = 0, amount = 0;
  for (const v of byPlayer.values()) {
    if (v <= 0) continue;
    const t = sorted.find((x) => v >= x.min);
    res[t.key].users++; res[t.key].amount += v; users++; amount += v;
  }
  for (const k in res) res[k].share = amount ? res[k].amount / amount : 0;
  return {tiers: res, total: {users, amount}};
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function normMachine(r) {
  return {gameId: r.game_id ?? null, vendorId: r.vendor_id ?? null, game: String(r.gameName ?? '').trim(), vendor: String(r.description ?? '').trim(), players: num(r.unduplicatedUser),
    betCount: num(r.betCount), bet: num(r.bet), validBet: num(r.validBet), pay: num(r.pay), netIncome: num(r.netIncome), rtp: num(r.RTP)};
}

/** Same game name under several vendors/versions (e.g. 月兔 on QT and QT2) counts as one machine. */
function byName(list) {
  const m = new Map();
  for (const r of list) {
    const g = m.get(r.game);
    if (!g) { m.set(r.game, {...r, vendors: [r.vendor], main: r.validBet}); continue; }
    for (const k of ['players', 'betCount', 'bet', 'validBet', 'pay', 'netIncome']) g[k] += r[k];
    if (!g.vendors.includes(r.vendor)) g.vendors.push(r.vendor);
    if (r.validBet > g.main) Object.assign(g, {main: r.validBet, gameId: r.gameId, vendorId: r.vendorId, vendor: r.vendor});
  }
  return [...m.values()].map((g) => ({...g, vendor: g.vendors.length > 1 ? `${g.vendor} 等 ${g.vendors.length} 個版本` : g.vendor, rtp: g.bet ? (g.pay / g.bet) * 100 : 0}));
}

/**
 * 機台總覽 rows -> Top5 by 有效投注額 (aggregated by game name, as in the deck) and
 * Top5 RTP 失分 = most negative 遊戲淨利 per machine row (as in the deck; concentration = Top5 / all losing rows).
 */
export function machinesFor(rows, n = 5, {field = 'validBet', byGame = true} = {}) {
  const list = rows.map(normMachine).filter((r) => r.game);
  const byBet = (byGame ? byName(list) : list).sort((a, b) => b[field] - a[field]).slice(0, n).map((r, i) => ({rank: i + 1, ...r}));
  const losers = list.filter((r) => r.netIncome < 0).sort((a, b) => a.netIncome - b.netIncome);
  const loss = losers.slice(0, n).map((r, i) => ({rank: i + 1, ...r, loss: -r.netIncome}));
  const top5Loss = loss.reduce((s, r) => s + r.loss, 0);
  const allLoss = losers.reduce((s, r) => s - r.netIncome, 0);
  return {
    topBet: byBet, topLoss: loss, top5Loss, allLoss,
    concentration: allLoss ? top5Loss / allLoss : 0,
    totals: {machines: list.length, bet: list.reduce((s, r) => s + r.bet, 0), validBet: list.reduce((s, r) => s + r.validBet, 0), netIncome: list.reduce((s, r) => s + r.netIncome, 0)},
  };
}
