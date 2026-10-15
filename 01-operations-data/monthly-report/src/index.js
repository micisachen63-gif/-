import fs from 'node:fs';
import path from 'node:path';
import {root, loadConfig, parseArgs, parseMonth, prevMonth, monthKey, defaultMonth, period, writeJson, readJson, makeLogger} from './util.js';
import {kpiFor, kpiCompare, tiersFor, machinesFor, dailyFromBackend, missingDays} from './metrics.js';
import {buildWin} from './win/build.js';
import {buildFacts} from './facts.js';
import {getInsights} from './insights.js';
import {Renderer, ensureBackgrounds, renderSlide, iconLookup, fetchIcons} from './render.js';
import {writePptx} from './pptx.js';
import {openProfile, BrandApi, formatDate} from './backend.js';
import {LAYOUTS} from './themes.js';

const SLIDE_NO = {cover: 20, kpi: 21, tiers: 22, machines: 23, rtp: 24, strategy: 25};

/** Cache backend answers in output\<月份>\data. keep(v) === false → not cached (e.g. the last day is not in yet). */
export async function cached(file, refresh, fn, keep = () => true) {
  if (!refresh && fs.existsSync(file)) return readJson(file);
  const v = await fn();
  if (keep(v)) writeJson(file, v);
  return v;
}

async function build(args, cfg) {
  const month = args.month ? parseMonth(args.month) : defaultMonth();
  const prev = prevMonth(month);
  const per = period(month, args.through || null), prevPer = period(prev);
  const brands = String(args.brands || cfg.build.brands.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const monthDir = path.join(root, 'output', per.full ? monthKey(month) : `${monthKey(month)}_to-${per.end.slice(5).replace('-', '')}`);
  const dataDir = path.join(monthDir, 'data');
  const log = makeLogger(path.join(monthDir, 'build.log'));
  log(`開始產生 ${per.key}（${per.start} ~ ${per.end}，比較 ${prevPer.start} ~ ${prevPer.end}）品牌：${brands.join(',')}`);

  let context = null;
  const apis = {};
  const api = async (key) => {
    if (!context) context = await openProfile(cfg, {headed: !!args.headed});
    if (!apis[key]) { apis[key] = new BrandApi(context, key, cfg.brands[key], cfg, log); log(`${cfg.brands[key].name}：${await apis[key].ensureSession()}`); }
    return apis[key];
  };
  const renderer = new Renderer(cfg);
  const manifest = {month: per.key, start: per.start, end: per.end, created: new Date().toISOString(), slides: []};
  try {
    await renderer.start();
    await ensureBackgrounds(renderer, [...new Set(brands.map((b) => cfg.brands[b].theme))], null, {log});
    for (const key of brands) {
      const brand = cfg.brands[key];
      if (!brand) throw new Error(`config.json 沒有品牌 ${key}`);
      const opt = {allowPartial: !!args['allow-partial'], label: `${brand.name} `};
      const q = async (kind, p, fn, keep) => cached(path.join(dataDir, `${key}-${kind}-${p.start}_${p.end}.json`), !!args.refresh, async () => { log(`${brand.name}：查詢 ${kind} ${p.start}~${p.end}`); return fn(await api(key), p); }, keep);
      const daily = async (p) => dailyFromBackend(await q('daily', p, async (a, x) => ({purchase: await a.dailyPurchase(x.start, x.end), xlogin: await a.xLogin(x.start, x.end)}),
        (v) => !missingDays(dailyFromBackend(v), p).length));
      if (key === 'win') {
        const r = await buildWin({args, cfg, key, brand, per, prevPer, monthDir, dataDir, log, q, daily, opt, renderer});
        manifest.slides.push(...r.slides);
        log(`${brand.name}：${r.slides.length} 頁完成`);
        continue;
      }
      const kCur = kpiFor(await daily(per), per, opt), kPrev = kpiFor(await daily(prevPer), prevPer, opt);
      for (const [p, k] of [[per, kCur], [prevPer, kPrev]]) if (k.missing.length) log(`⚠ ${brand.name} ${p.key} 缺 ${k.missing.length} 天資料：${k.missing.join(', ')}`);
      const pr = {prev: await q('purchaseRank', prevPer, (a, p) => a.purchaseRank(p.start, p.end)), cur: await q('purchaseRank', per, (a, p) => a.purchaseRank(p.start, p.end))};
      const mo = {prev: await q('machineOverview', prevPer, (a, p) => a.machineOverview(p.start, p.end)), cur: await q('machineOverview', per, (a, p) => a.machineOverview(p.start, p.end))};
      const tiers = {prev: tiersFor(pr.prev, cfg.tiers), cur: tiersFor(pr.cur, cfg.tiers)};
      const machines = {prev: machinesFor(mo.prev), cur: machinesFor(mo.cur)};
      const facts = buildFacts({key, brand, per, prevPer, kpi: kpiCompare(kPrev, kCur), tiers, machines, tiersCfg: cfg.tiers,
        sources: {api: ['platformSTMT/playerStatsPurchase', 'platformSTMT/xLoginData', 'platformSTMT/purchaseRank', 'gameSTMT/vendorGameSTMT'],
          rows: {purchaseRank: {prev: pr.prev.length, cur: pr.cur.length}, machineOverview: {prev: mo.prev.length, cur: mo.cur.length}},
          checks: {purchaseRankVsDailyRevenue: {prev: [tiers.prev.total.amount, kPrev.revenue], cur: [tiers.cur.total.amount, kCur.revenue]}}}});
      const games = await q('gameList', {start: 'all', end: 'games'}, (a) => a.gameList());
      if (games[0]) log(`${brand.name}：遊戲清單 ${games.length} 筆，圖示範例 ${String(games[0].pic_small || games[0].pic_large || '（無）').slice(0, 120)}`);
      const shown = [...machines.prev.topBet, ...machines.cur.topBet, ...machines.prev.topLoss, ...machines.cur.topLoss];
      const icons = iconLookup(await fetchIcons(shown, games, brand.staticBase, path.join(dataDir, 'icons', key), log));
      const ins = await getInsights(monthDir, key, facts);
      for (const layout of LAYOUTS) {
        const out = path.join(monthDir, key, `${SLIDE_NO[layout]}-${layout}.png`);
        await renderSlide(renderer, brand.theme, layout, facts, ins, out, icons);
        manifest.slides.push({brand: key, layout, no: SLIDE_NO[layout], png: out});
      }
      log(`${brand.name}：6 頁完成`);
      for (const [n, a, b] of [['玩家儲值', tiers.prev.total.amount, kPrev.revenue], ['玩家儲值', tiers.cur.total.amount, kCur.revenue]]) if (Math.round(a) !== Math.round(b)) log(`⚠ ${brand.name} 儲值排行合計 ${a} ≠ 每日儲值合計 ${b}`);
    }
    const pptx = path.join(monthDir, `月報-${path.basename(monthDir)}.pptx`);
    // keep the other brands' pages from an earlier run (e.g. build --brands win only)
    const old = readJson(path.join(monthDir, 'manifest.json'), null);
    for (const sl of old?.slides || []) if (!brands.includes(sl.brand) && fs.existsSync(sl.png)) manifest.slides.push(sl);
    const order = (s) => ({win: 0, song: 1, qz: 2}[s.brand] ?? 9) * 100 + (s.no ?? 0);
    manifest.slides.sort((a, b) => order(a) - order(b));
    await writePptx(manifest.slides.map((s) => s.png), pptx, `營運月報 ${per.key}`);
    manifest.pptx = pptx;
    writeJson(path.join(monthDir, 'manifest.json'), manifest);
    log(`完成：${path.relative(root, pptx)}（${manifest.slides.length} 頁）`);
  } finally {
    await renderer.close();
    for (const a of Object.values(apis)) await a.close();
    if (context) await context.close().catch(() => {});
  }
}

/** Read-only API confirmation: date format for vendorGameSTMT and response fields. */
async function probe(args, cfg) {
  const log = makeLogger(path.join(root, 'output', 'probe.log'));
  const day = args.day || '2026-08-01';
  const brands = String(args.brands || 'song,qz').split(',');
  const formats = ['YYYY-MM-DD HH:mm:ss', 'YYYY/MM/DD HH:mm:ss', 'YYYY-MM-DD', 'YYYY/MM/DD'];
  const context = await openProfile(cfg, {headed: !!args.headed});
  const result = {day, brands: {}};
  try {
    for (const key of brands) {
      const a = new BrandApi(context, key, cfg.brands[key], cfg, log);
      const r = result.brands[key] = {session: await a.ensureSession(), vendorGameSTMT: []};
      for (const f of formats) {
        const body = {advertiserId: null, start: formatDate(day, '00:00:00', f), stop: formatDate(day, '23:59:59', f)};
        const {http, json} = await a.raw('/gameSTMT/vendorGameSTMT', body);
        const rows = Array.isArray(json?.data) ? json.data : null;
        r.vendorGameSTMT.push({format: f, body, http, status: json?.status, msg: String(json?.msg || '').slice(0, 80), rows: rows?.length ?? null,
          fields: rows?.[0] ? Object.keys(rows[0]) : null, sumValidBet: rows ? Math.round(rows.reduce((s, x) => s + Number(x.validBet || 0), 0)) : null});
      }
      const pr = await a.raw('/platformSTMT/purchaseRank', {start: day.replace(/-/g, '/'), stop: day.replace(/-/g, '/'), vip: 0});
      const prRows = pr.json?.data && typeof pr.json.data === 'object' ? Object.values(pr.json.data) : [];
      r.purchaseRank = {http: pr.http, status: pr.json?.status, rows: prRows.length, fields: prRows[0] ? Object.keys(prRows[0]) : null, sum: prRows.reduce((s, x) => s + Number(x.price || 0), 0)};
      const gl = await a.raw('/gameSTMT/gameList', {});
      const glRows = Array.isArray(gl.json?.data) ? gl.json.data : Array.isArray(gl.json?.data?.data) ? gl.json.data.data : [];
      r.gameList = {http: gl.http, status: gl.json?.status, msg: String(gl.json?.msg || '').slice(0, 80), rows: glRows.length, fields: glRows[0] ? Object.keys(glRows[0]) : null};
      await a.close();
    }
  } finally { await context.close().catch(() => {}); }
  writeJson(path.join(root, 'output', 'probe.json'), result);
  log('probe 完成：output\\probe.json');
}

async function makeBg(args, cfg) {
  const r = new Renderer(cfg);
  await r.start();
  try { await ensureBackgrounds(r, String(args.themes || 'win,song,qz').split(','), null, {force: !!args.force, log: console.log}); }
  finally { await r.close(); }
}

const HELP = `用法：
  node src/index.js build [--month 2026-08] [--brands win,song,qz] [--through 2026-08-30] [--refresh] [--allow-partial]
  node src/index.js make-bg [--force]            重新產生背景圖（assets\\bg）
  node src/index.js probe [--day 2026-08-01]      API 唯讀檢查
  node src/index.js deck-check [--month 2026-08] [--which test|real|original] [--slides 2,21,26]   唯讀：下載雲端簡報縮圖檢查
  node src/index.js webapp-setup --file <暫存檔>    一次性：加密儲存上傳用網頁應用程式的網址與密鑰（讀完即刪暫存檔）
  node src/index.js push [--month 2026-08] [--dry-run] [--test] [--source "來源簡報名稱"]   複製雲端簡報並換圖（--test 寫到「[測試] 」開頭的副本）`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const cfg = loadConfig();
  if (cmd === 'build') return build(args, cfg);
  if (cmd === 'probe') return probe(args, cfg);
  if (cmd === 'make-bg') return makeBg(args, cfg);
  if (cmd === 'deck-check') {
    const month = args.month ? parseMonth(args.month) : defaultMonth();
    const slides = typeof args.slides === 'string' ? args.slides.split(',').map(Number).filter(Boolean) : null;
    return (await import('./push.js')).deckCheck({cfg, month, monthDir: path.join(root, 'output', monthKey(month)), which: args.which || 'test', slides, size: args.size || 'MEDIUM'});
  }
  if (cmd === 'webapp-setup') return (await import('./webapp.js')).setupWebapp(args.file, {keep: !!args.keep});
  if (cmd === 'push') {
    const month = args.month ? parseMonth(args.month) : defaultMonth();
    return (await import('./push.js')).push({cfg, month, monthDir: path.join(root, 'output', monthKey(month)), dryRun: !!args['dry-run'], test: !!args.test, sourceTitle: typeof args.source === 'string' ? args.source : null});
  }
  console.log(HELP);
}

main().catch((e) => { console.error(`錯誤：${e?.message || e}`); process.exit(1); });
