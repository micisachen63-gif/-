import fs from 'node:fs';
import path from 'node:path';
import {root} from '../util.js';
import {loadWorkbook} from '../sheets.js';
import {kpiFor, kpiCompare, machinesFor} from '../metrics.js';
import {iconLookup, fetchIcons, dataUri, bgFile} from '../render.js';
import {getInsights} from '../insights.js';
import {channelBlock, winnersFor, vipFor, payersFor} from './metrics.js';
import {PAGES} from './templates.js';
import {WIN_SCHEMA, winDraft} from './insights.js';

const pct = (c, p) => (p ? (c - p) / p : null);
const deco = (name) => {
  const dir = path.join(root, 'assets', 'deco', 'win');
  const f = ['png', 'jpg', 'webp'].map((e) => path.join(dir, `${name}.${e}`)).find((x) => fs.existsSync(x));
  return f ? dataUri(f) : '';
};

/** 贏麻了: slides 1-10, 12-14, 19 (11 and 15-18 are filled by hand and stay as last month's pictures). */
export async function buildWin({args, cfg, key, brand, per, prevPer, monthDir, dataDir, log, q, daily, opt, renderer}) {
  const kCur = kpiFor(await daily(per), per, opt), kPrev = kpiFor(await daily(prevPer), prevPer, opt);
  for (const [p, k] of [[per, kCur], [prevPer, kPrev]]) if (k.missing.length) log(`⚠ ${brand.name} ${p.key} 缺 ${k.missing.length} 天資料：${k.missing.join(', ')}`);
  const both = async (kind, fn) => ({prev: await q(kind, prevPer, fn), cur: await q(kind, per, fn)});
  const pr = await both('purchaseRank', (a, p) => a.purchaseRank(p.start, p.end));
  const mo = await both('machineOverview', (a, p) => a.machineOverview(p.start, p.end));
  const gifts = await q('giftRank', per, (a, p) => a.giftRank(p.start, p.end));
  const bets = await q('betRank', per, (a, p) => a.betRank(p.start, p.end));
  const field = brand.machineBetField || 'validBet';
  // 贏麻了 deck ranks machine rows as they are (per vendor version), song/qz decks merge same-name games
  const byGame = brand.machineByName ?? false;
  const machines = {field, prev: machinesFor(mo.prev, 5, {field, byGame}), cur: machinesFor(mo.cur, 5, {field, byGame})};

  // channel tables: the only figures still read from the sheet
  const sheetFile = path.join(dataDir, `${key}-sheet.xlsx`);
  const wb = await loadWorkbook(key, brand, dataDir, {refresh: !!args.refresh, log});
  const block = {prev: channelBlock(wb, prevPer.month.m), cur: channelBlock(wb, per.month.m)};
  const warn = [];
  for (const [w, k, p] of [['prev', kPrev, prevPer], ['cur', kCur, per]]) {
    const b = block[w];
    if (!b) warn.push(`試算表「總表」${p.label}渠道表尚未完成`);
    else if (Math.round(b.total.reg) !== Math.round(k.nuSum)) warn.push(`${p.label}渠道表註冊人數 ${b.total.reg} ≠ 後台新增 ${k.nuSum}（試算表可能尚未更新完）`);
  }
  if (warn.length) { warn.forEach((x) => log(`⚠ ${brand.name}：${x}`)); fs.rmSync(sheetFile, {force: true}); } // re-download next run
  const sorted = (block.cur?.channels || []).filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);
  const cards = sorted.slice(0, 6);
  const channel = {prev: block.prev, cur: block.cur, cards, low: (block.cur?.channels || []).filter((c) => !cards.includes(c)), warn: warn.join('；')};

  const w = winnersFor(gifts, pr.cur, bets, brand.merchants || [], brand.coinRate || 1.2);
  const vip = vipFor(pr.prev, pr.cur, 8);
  const payers = payersFor(pr.prev, pr.cur, bets, prevPer);
  const days = (p) => p.days.length;
  const betTotal = {prev: machines.prev.totals.validBet, cur: machines.cur.totals.validBet}; // 壓碼量 = Σ 有效投注 (= 試算表 總表 壓碼總額)
  // featured machines (slide 14): current #1, previous #1, current #2, previous #2 ... (unique names)
  const featured = [];
  const order = [];
  for (let i = 0; i < 5; i++) order.push([machines.cur.topBet[i], `${per.label} Top${i + 1}`], [machines.prev.topBet[i], `${prevPer.label} Top${i + 1}`]);
  for (const [r, tag] of order) if (r && !featured.some((x) => x.game === r.game) && featured.length < 4) {
    const inBoth = machines.cur.topBet.some((x) => x.game === r.game) && machines.prev.topBet.some((x) => x.game === r.game);
    featured.push({...r, tag: inBoth ? '雙月 Top5' : tag});
  }
  const facts = {
    brand: {key, name: brand.name},
    month: {key: per.key, m: per.month.m, y: per.month.y, label: per.label, start: per.start, end: per.end, full: per.full, range: per.range},
    prev: {key: prevPer.key, m: prevPer.month.m, y: prevPer.month.y, label: prevPer.label, start: prevPer.start, end: prevPer.end, range: prevPer.range},
    quarter: `Y${String(per.month.y).slice(2)}-Q${Math.ceil(per.month.m / 3)}`,
    kpi: kpiCompare(kPrev, kCur), nu: {prev: kPrev.nuExact, cur: kCur.nuExact}, nuSum: {prev: kPrev.nuSum, cur: kCur.nuSum},
    dailyRevenue: {prev: kPrev.revenue / days(prevPer), cur: kCur.revenue / days(per), pct: pct(kCur.revenue / days(per), kPrev.revenue / days(prevPer))},
    bet: {...betTotal, pct: pct(betTotal.cur, betTotal.prev)},
    dauDaily: {prev: kPrev.daily.map((d) => d.dau), cur: kCur.daily.map((d) => d.dau)},
    channel, winners: w, vip, payers, machines, featured,
    merchantShort: (brand.merchants || []).map(([, n]) => n.replace(/(金庫|財庫|金控)$/, '')).join('、'), coinRate: brand.coinRate || 1.2,
    sources: {api: ['platformSTMT/playerStatsPurchase', 'platformSTMT/xLoginData', 'platformSTMT/purchaseRank', 'platformSTMT/txnRank', 'platformSTMT/betRank', 'gameSTMT/vendorGameSTMT'],
      sheet: `https://docs.google.com/spreadsheets/d/${brand.sheetId}（總表 渠道表）`},
  };
  const games = await q('gameList', {start: 'all', end: 'games'}, (a) => a.gameList());
  const shown = [...machines.prev.topBet, ...machines.cur.topBet, ...machines.prev.topLoss, ...machines.cur.topLoss];
  const icons = iconLookup(await fetchIcons(shown, games, brand.staticBase, path.join(dataDir, 'icons', key), log));
  const ins = await getInsights(monthDir, key, facts, {schema: WIN_SCHEMA, draft: winDraft});
  const d = {a: deco('mascot-a'), b: deco('mascot-b')};
  const slides = [];
  for (const pg of PAGES) {
    const out = path.join(monthDir, key, `${String(pg.no).padStart(2, '0')}-${pg.key}.png`);
    await renderer.png(pg.fn({bg: dataUri(bgFile('win', pg.bg)), f: facts, ins, icons, deco: d}), out);
    slides.push({brand: key, layout: pg.key, no: pg.no, png: out});
  }
  return {slides};
}
