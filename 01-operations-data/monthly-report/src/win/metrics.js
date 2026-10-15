import * as XLSX from 'xlsx';

// 贏麻了 page figures. Every definition below was checked against the August 2026 deck (see report):
//  渠道 (p3)      : 試算表 總表「新增會員分析」monthly block (the backend has no channel report)
//  淨贏 (p5/p6)   : 贈禮排行 rows sent TO a coin merchant: Σ差額 ÷ 幣價(1.2) − 當月儲值 (儲值 1:1)
//  R 分級 (p6)    : 當月儲值 > 0 and < 50,000 = 小R + 中R
//  VIP (p7/p8)   : 儲值排行 by month
//  付費 (p9/p10)  : 儲值排行 payers (price > 0); 新付費 = first login inside the month; 仍有操作 = 押碼排行 bet > 0

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** 總表 → 「{m}月」→ 新增會員分析 table (columns N..X). null when the month block is not there yet. */
export function channelBlock(wb, m) {
  const ws = wb.Sheets['總表'];
  if (!ws) throw new Error('贏麻了試算表找不到分頁「總表」');
  const rows = XLSX.utils.sheet_to_json(ws, {header: 1, raw: true, defval: null});
  const N = 13, s = (r, c) => String(rows[r]?.[c] ?? '').trim();
  let at = -1;
  for (let i = 0; i < rows.length; i++) if (s(i, N) === `${m}月`) at = i; // last block with that month
  if (at < 0) return null;
  let h = -1;
  for (let i = at + 1; i < Math.min(at + 4, rows.length); i++) if (s(i, N) === '渠道') { h = i; break; }
  if (h < 0) return null;
  const head = (rows[h] || []).map((x) => String(x ?? '').trim());
  const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`總表 ${m}月 渠道表缺少欄位「${name}」`); return i; };
  const C = {reg: col('註冊人數'), invalid: col('無效人數'), invalidRate: col('無效率'), payers: col('付費人數'), conv: col('新增付費轉化率'), amount: col('當月渠道儲值總額')};
  const pick = (r) => Object.fromEntries(Object.entries(C).map(([k, c]) => [k, num(rows[r][c])]));
  const channels = [];
  for (let i = h + 1; i < rows.length; i++) {
    const name = s(i, N);
    if (!name) continue;
    if (name === '加總') return {month: m, channels, total: pick(i)};
    if (/^\d+月$/.test(name)) break;
    channels.push({name, ...pick(i)});
  }
  return null; // block without 加總 row = still being filled in
}

/** Coin-merchant net win per player. giftRows: 贈禮排行; purchase: 儲值排行 of the same month. */
export function winnersFor(giftRows, purchase, bets, merchants, rate = 1.2) {
  const M = new Set(merchants.map(([id]) => String(id)));
  const names = merchants.map(([, n]) => n);
  const isM = (id, nick) => M.has(String(id)) || names.includes(String(nick || '').trim());
  const price = new Map(purchase.map((r) => [String(r.a_id), num(r.price)]));
  const hist = new Map(purchase.map((r) => [String(r.a_id), num(r.totalCharge)]));
  for (const b of bets) if (!hist.has(String(b.a_id))) hist.set(String(b.a_id), num(b.all_purchase));
  const agg = new Map();
  for (const r of giftRows) {
    if (!isM(r.to, r.to_nickname) || isM(r.from, r.from_nickname)) continue;
    const id = String(r.from), g = agg.get(id) || {aid: id, nick: String(r.from_nickname || id), rang: 0};
    g.rang += num(r.rang_money);
    agg.set(id, g);
  }
  const list = [...agg.values()].map((g) => ({...g, purchase: price.get(g.aid) || 0, hist: hist.has(g.aid) ? hist.get(g.aid) : null, net: g.rang / rate - (price.get(g.aid) || 0)}))
    .sort((a, b) => b.net - a.net);
  const sum = (a) => a.reduce((s, x) => s + x.net, 0);
  const top = list.slice(0, 10).map((x, i) => ({rank: i + 1, ...x}));
  const topIds = new Set(top.map((x) => x.aid));
  const rest = list.filter((x) => !topIds.has(x.aid));
  const smallMid = list.filter((x) => x.purchase > 0 && x.purchase < 50000);
  const smIn = smallMid.filter((x) => topIds.has(x.aid)), smOut = smallMid.filter((x) => !topIds.has(x.aid));
  const positive = list.filter((x) => x.net > 0).reduce((s, x) => s + x.net, 0);
  const lowCap = top.filter((x) => x.hist > 0).sort((a, b) => b.net / b.hist - a.net / a.hist)[0] || null;
  return {
    players: list.length, total: sum(list), top, top10: sum(top), restN: rest.length, rest: sum(rest),
    positive, top10ShareOfWins: positive ? sum(top) / positive : 0,
    smallMid: {n: smallMid.length, sum: sum(smallMid), inTopN: smIn.length, inTop: sum(smIn), outN: smOut.length, out: sum(smOut)},
    lowCap: lowCap && {...lowCap, ratio: lowCap.net / lowCap.hist},
  };
}

const payers = (rows) => new Map(rows.filter((r) => num(r.price) > 0).map((r) => [String(r.a_id), r]));

/** VIP Top N by monthly 儲值 + overlap of both months' Top 10. */
export function vipFor(prevRows, curRows, n = 8) {
  const P = payers(prevRows), C = payers(curRows);
  const rank = (m) => [...m.values()].sort((a, b) => num(b.price) - num(a.price));
  const pr = rank(P), cr = rank(C);
  const rev = (a) => a.reduce((s, r) => s + num(r.price), 0);
  const prevRank = new Map(pr.map((r, i) => [String(r.a_id), i + 1]));
  const top = cr.slice(0, n).map((r, i) => ({rank: i + 1, aid: String(r.a_id), nick: r.nickname || String(r.a_id), cur: num(r.price), prev: num(P.get(String(r.a_id))?.price), prevRank: prevRank.get(String(r.a_id)) || null}));
  const curTop10 = cr.slice(0, 10), prevTop10 = new Set(pr.slice(0, 10).map((r) => String(r.a_id)));
  const overlap = curTop10.map((r, i) => ({aid: String(r.a_id), nick: r.nickname, curRank: i + 1, prevRank: prevRank.get(String(r.a_id)), cur: num(r.price), prev: num(P.get(String(r.a_id))?.price)}))
    .filter((x) => prevTop10.has(x.aid));
  return {
    top, prevTop1: pr[0] ? {nick: pr[0].nickname, amount: num(pr[0].price)} : null,
    share: {prev: rev(pr) ? rev(pr.slice(0, n)) / rev(pr) : 0, cur: rev(cr) ? rev(cr.slice(0, n)) / rev(cr) : 0},
    topSum: {prev: rev(pr.slice(0, n)), cur: rev(cr.slice(0, n))}, overlap,
  };
}

/** Payer retention between two months. */
export function payersFor(prevRows, curRows, curBets, prevPer) {
  const P = payers(prevRows), C = payers(curRows);
  const amount = (m, ids) => ids.reduce((s, id) => s + num(m.get(id)?.price), 0);
  const both = [...P.keys()].filter((id) => C.has(id));
  const gone = [...P.keys()].filter((id) => !C.has(id));
  const active = new Set(curBets.filter((b) => num(b.bet) > 0).map((b) => String(b.a_id)));
  const t0 = Date.parse(`${prevPer.start}T00:00:00+08:00`), t1 = Date.parse(`${prevPer.end}T23:59:59.999+08:00`);
  const newIds = [...P.keys()].filter((id) => { const f = num(P.get(id).firstLogin); return f >= t0 && f <= t1; });
  const revP = amount(P, [...P.keys()]), revC = amount(C, [...C.keys()]);
  return {
    payers: {prev: P.size, cur: C.size}, revenue: {prev: revP, cur: revC},
    arppu: {prev: P.size ? revP / P.size : 0, cur: C.size ? revC / C.size : 0},
    both: {n: both.length, prev: amount(P, both), cur: amount(C, both)},
    gone: {n: gone.length, share: P.size ? gone.length / P.size : 0, active: gone.filter((id) => active.has(id)).length},
    newPayers: {n: newIds.length, renewed: newIds.filter((id) => C.has(id)).length},
  };
}
