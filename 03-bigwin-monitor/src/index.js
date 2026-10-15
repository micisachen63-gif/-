import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, paths, projectRoot, runtimeRoot, serviceRole } from './config.js';
import { holderAlive, readLock } from './locks.js';
import { describeRelayConfig } from './relay.js';
import { createLogger } from './log.js';
import { fmtStamp, readJson, sleep } from './util.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dry' || a === '--dry-run') args.dry = true;
    else if (a === '--min-pay') args.minPay = Number(next());
    else if (a === '--minutes') args.minutes = Number(next());
    else if (a === '--max-alerts') args.maxAlerts = Number(next());
    else if (a === '--brands') args.brands = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--cdp') args.cdp = Number(next());
    else if (a === '--cashout-only') args.cashoutOnly = true;
    else if (a === '--no-cashout') args.noCashout = true;
    else args._.push(a);
  }
  for (const k of ['minPay', 'minutes', 'maxAlerts', 'cdp']) {
    if (args[k] !== undefined && !(Number.isFinite(args[k]) && args[k] > 0)) throw new Error(`--${k} 必須是正數`);
  }
  return args;
}

function serviceAlive() {
  const lock = readLock(paths.serviceLock);
  return lock && holderAlive(lock.pid) ? lock.pid : null;
}

function startServiceDetached() {
  const child = spawn(process.execPath, [serviceRole === 'operations' ? path.join(runtimeRoot, 'service.mjs') : path.join(projectRoot, 'src', 'index.js'), 'service'], {
    cwd: runtimeRoot, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function installProcessGuards(log) {
  process.on('unhandledRejection', (error) => log.error(`unhandledRejection: ${error?.stack || error}`));
  process.on('uncaughtException', (error) => { log.error(`uncaughtException: ${error?.stack || error}`); process.exit(1); });
}

function printStatus(cfg) {
  const out = [];
  const pid = serviceAlive();
  const hb = readJson(paths.heartbeat, null);
  out.push(`常駐服務：${pid ? `執行中（pid ${pid}）` : '未執行'}${fs.existsSync(paths.disabledFlag) ? '（已用 stop 停用，watchdog 不會自動啟動）' : ''}`);
  if (hb) {
    out.push(`心跳：${hb.updatedAt ? fmtStamp(Date.parse(hb.updatedAt)) : '-'}${hb.pausedForLogin ? '（登入中，掃描暫停）' : ''}`);
    out.push(`Telegram 按鈕監聽：${hb.listener?.state}，最後輪詢 ${hb.listener?.lastLoopAt ? fmtStamp(Date.parse(hb.listener.lastLoopAt)) : '-'}`);
  }
  const bs = readJson(paths.brandsState, { brands: {} });
  for (const b of cfg.brands) {
    const s = bs.brands[b.key] || {};
    const h = hb?.brands?.[b.key];
    out.push(`- ${b.name}（門檻 ${b.threshold}）：已查到 ${s.lastSuccessStop ? fmtStamp(s.lastSuccessStop) : '尚未成功'}；連續失敗 ${s.consecutiveFailures || 0}；連續登入失敗 ${s.loginFailures || 0}${s.lastError ? `；最後錯誤 ${s.lastError}` : ''}`);
    if (h?.last) out.push(`    上一輪：${h.last.ok ? `OK ${h.last.window} ${h.last.rows} 筆，新提醒 ${h.last.newAlerts}` : `失敗 ${h.last.error}`}（結束 ${h.lastCycleEnd ? fmtStamp(Date.parse(h.lastCycleEnd)) : '-'}）`);
    if (h?.cashout) out.push(`    出金通知：${h.cashout.ok ? `OK ${h.cashout.date} 轉給幣商 ${h.cashout.matched} 筆，新/變動 ${h.cashout.changes}，已發 ${h.cashout.sent}` : `失敗 ${h.cashout.error}`}（${fmtStamp(Date.parse(h.cashout.at))}）`);
  }
  const al = readJson(paths.alertsState, { alerts: {} });
  const counts = {};
  for (const a of Object.values(al.alerts)) counts[a.status] = (counts[a.status] || 0) + 1;
  out.push(`提醒紀錄：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('、') || '無'}`);
  out.push(`轉話：${cfg.relay?.mode === 'life' ? '生活模式：GPT、塔羅、狼人殺；營運已移交神殿守望者' : describeRelayConfig(paths.relayConfig)}`);
  if (cfg.relay?.mode === 'life') {
    const games = readJson(paths.tgState, {});
    const game = games?.werewolf?.game;
    out.push(`狼人殺：${game && !['ended', 'cancelled'].includes(game.stage) ? `${game.stage}，${game.players?.length || 0} 人` : '等待發起'}`);
    const undercover = games?.undercover?.game;
    out.push(`誰是臥底：${undercover && !['ended', 'cancelled'].includes(undercover.stage) ? `${undercover.stage}，${undercover.players?.length || 0} 人` : '等待發起'}`);
  }
  if (cfg.hiphop?.enabled) {
    const h = readJson(path.join(paths.stateDir, 'hiphop.json'), {});
    const latest = h.lastDate && h.recommendations?.[h.lastDate];
    out.push(`嘻哈歌單：每日台灣時間 13:30；最近推薦 ${h.lastDate || '尚未執行'} ${latest ? `${latest.items?.length || 0} 首（${latest.status}）` : ''}；歌單 ${h.playlistId ? '已建立' : '尚未建立'}`);
  }
  const af = readJson(paths.autofillCheck, null);
  out.push(`自動填入檢查：${af ? `${fmtStamp(Date.parse(af.at))} ${af.works ? '可用' : '不可用'}` : '尚未檢查'}`);
  process.stdout.write(out.join('\n') + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  const cfg = loadConfig(paths.config, { runtime: ['service','start','stop','status'].includes(command) });

  if (command === 'service') {
    const log = createLogger(paths.serviceLog, { echo: process.stdout.isTTY });
    installProcessGuards(log);
    const { runService } = await import('./service.js');
    return runService({ cfg, log });
  }
  if (command === 'run-once') {
    const log = createLogger(path.join(paths.logsDir, 'run-once.log'));
    installProcessGuards(log);
    setTimeout(() => { log.error('run-once hard timeout (20 min)'); process.exit(2); }, 20 * 60e3).unref();
    const { runOnce } = await import('./runonce.js');
    return runOnce({ cfg, log, args });
  }
  if (command === 'login') {
    const log = createLogger(path.join(paths.logsDir, 'login.log'), { echo: false });
    installProcessGuards(log);
    setTimeout(() => { log.error('login hard timeout (35 min)'); process.exit(2); }, 35 * 60e3).unref();
    const { runLogin } = await import('./login.js');
    const code = await runLogin({ cfg, log });
    if (!serviceAlive() && !fs.existsSync(paths.disabledFlag)) {
      process.stdout.write(`常駐服務未執行，已在背景啟動（pid ${startServiceDetached()}）。\n`);
    }
    return code;
  }
  if (command === 'check-autofill') {
    const log = createLogger(path.join(paths.logsDir, 'login.log'));
    const { checkAutofill, describeAutofill, withProfile } = await import('./login.js');
    const r = await withProfile(() => checkAutofill({ cfg, log }), { onWait: () => process.stdout.write('暫時向常駐服務借用瀏覽器…\n') });
    process.stdout.write(describeAutofill(cfg, r) + '\n');
    return r.works ? 0 : 1;
  }
  if (command === 'status') { printStatus(cfg); return 0; }
  if (command === 'stop') {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(paths.disabledFlag, new Date().toISOString());
    const pid = serviceAlive();
    if (!pid) { process.stdout.write('常駐服務沒有在執行；已停用自動啟動（start 可恢復）。\n'); return 0; }
    fs.writeFileSync(paths.stopRequest, new Date().toISOString());
    for (let i = 0; i < 90 && serviceAlive(); i++) await sleep(1000);
    process.stdout.write(serviceAlive() ? '⚠️ 服務尚未停止（可能正在查詢中），稍後再看 status。\n' : '已停止常駐服務，並停用自動啟動（start 可恢復）。\n');
    return 0;
  }
  if (command === 'start') {
    try { fs.unlinkSync(paths.disabledFlag); } catch { /* none */ }
    const pid = serviceAlive();
    if (pid) { process.stdout.write(`常駐服務已在執行（pid ${pid}）。\n`); return 0; }
    process.stdout.write(`已在背景啟動常駐服務（pid ${startServiceDetached()}）。\n`);
    return 0;
  }
  process.stdout.write([
    '用法：node src/index.js <command>',
    '  service                       常駐模式（排程/看門狗使用）：每 5 分鐘掃描 + Telegram 按鈕監聽',
    '  run-once [--dry]              跑一次；--dry 只把訊息寫到 logs\\dry-*.txt，不發 Telegram',
    '       [--min-pay N] [--minutes N] [--max-alerts N] [--brands winmalo,songyy,qiezi] [--cdp PORT]',
    '       [--cashout-only | --no-cashout]  只跑／不跑出金通知（--dry 時出金狀態只在記憶體，今天的紀錄都會當成新紀錄列出）',
    '  login                         開啟有畫面的 Chrome 讓你登入三個後台（會暫停常駐服務的瀏覽器）',
    '  check-autofill                檢查無畫面模式能否自動填入已儲存的密碼',
    '  status | stop | start',
  ].join('\n') + '\n');
  return command === 'help' ? 0 : 1;
}

main().then((code) => process.exit(code ?? 0), (error) => {
  process.stderr.write(`錯誤：${error?.stack || error}\n`);
  process.exit(1);
});
