import path from 'node:path';
import { paths } from './config.js';
import { acquireLock, holderAlive, readLock, releaseLock } from './locks.js';
import { createDryWriter } from './notifier.js';
import { cashoutEnabled, runCashoutCycle } from './cashout.js';
import { runBrandCycle } from './scan.js';
import { AlertStore, BrandStateStore, CashoutStore } from './store.js';
import { createTelegramApi } from './telegram.js';
import { fileStamp, fmtStamp } from './util.js';
import { BackendClientFactory } from './wiring.js';

export async function runOnce({ cfg, log, args }) {
  const dry = Boolean(args.dry);
  const svc = readLock(paths.serviceLock);
  const svcAlive = svc && holderAlive(svc.pid);
  if (svcAlive && (!dry || !args.cdp)) {
    log.error(`常駐服務正在執行（pid ${svc.pid}），它持有瀏覽器與狀態檔。請先執行 stop.cmd，${dry ? '或加 --cdp <port> 連到另一個 Chrome，' : ''}再重試。`);
    return 2;
  }
  let ownBrowserLock = false;
  if (!args.cdp) {
    if (!acquireLock(paths.browserLock, 'run-once')) {
      log.error(`瀏覽器設定檔正被 pid ${readLock(paths.browserLock)?.pid}（${readLock(paths.browserLock)?.role}）使用中。`);
      return 2;
    }
    ownBrowserLock = true;
  }
  const w = new BackendClientFactory({ cfg, log, headless: true, cdpPort: args.cdp || null });
  const brands = args.brands ? cfg.brands.filter((b) => args.brands.includes(b.key)) : cfg.brands;
  let brandStore;
  let alerts;
  let cashout;
  let notifier;
  let dryWriter = null;
  try {
    if (dry) {
      brandStore = new BrandStateStore(null);
      alerts = new AlertStore(null);
      cashout = new CashoutStore(null);
      dryWriter = createDryWriter(path.join(paths.logsDir, `dry-${fileStamp()}.txt`));
      notifier = w.notifier({ dry: true, dryWriter });
      dryWriter.write([
        `爆分監控 DRY RUN @ ${fmtStamp()}（台北時間）— 不會發送任何 Telegram 訊息`,
        `查詢範圍：最近 ${args.minutes ?? cfg.firstRunMinutes} 分鐘；門檻：${args.minPay != null ? `測試用暫時門檻 ${args.minPay}（正式：${brands.map((b) => `${b.name} ${b.threshold}`).join('、')}）` : brands.map((b) => `${b.name} ${b.threshold}`).join('、')}${args.maxAlerts ? `；每站最多產生 ${args.maxAlerts} 則（依出分高低）` : ''}`,
      ].join('\n'));
    } else {
      brandStore = new BrandStateStore(paths.brandsState);
      alerts = new AlertStore(paths.alertsState);
      cashout = new CashoutStore(paths.cashoutState);
      const fairy = w.alertBot();
      notifier = w.notifier({ dry: false, api: createTelegramApi(fairy.token), chatId: fairy.chatId });
    }
    const opts = { dry, minPay: args.minPay, windowMinutes: args.minutes ?? (dry ? cfg.firstRunMinutes : undefined), maxAlerts: args.maxAlerts };
    const results = await Promise.all(brands.map(async (brand) => {
      const t0 = Date.now();
      const r = args.cashoutOnly ? { brand: brand.key, ok: true, skipped: true } : await runBrandCycle({
        brand, client: w.client(brand), brandState: brandStore.brand(brand.key), saveBrandState: () => brandStore.save(),
        alerts, notifier, cfg, now: Date.now(), log: log.child(brand.key), opts,
      });
      if (cashoutEnabled(cfg, brand) && !args.noCashout && !r.auth) {
        r.cashout = await runCashoutCycle({ brand, client: w.client(brand), store: cashout, notifier, cfg, now: Date.now(), log: log.child(brand.key), opts: { dry } });
      }
      r.seconds = Math.round((Date.now() - t0) / 1000);
      return r;
    }));
    const summary = results.map((r) => {
      const b = brands.find((x) => x.key === r.brand);
      const co = !r.cashout ? '' : r.cashout.ok
        ? `；出金通知 ${r.cashout.date}：贈禮排行 ${r.cashout.rows} 筆，轉給幣商 ${r.cashout.matched} 筆，新/變動 ${r.cashout.changes}，${dry ? '產生' : '已發'} ${r.cashout.sent} 則`
        : `；出金通知失敗 ${r.cashout.error}`;
      if (r.skipped) return `${b.name}: 爆分掃描略過（--cashout-only）${co}，${r.seconds}s`;
      return (r.ok
        ? `${b.name}: OK 查詢 ${fmtStamp(r.window.start)} ~ ${fmtStamp(r.window.stop)}，${r.fetched} 筆（${r.pages} 頁），≥${r.threshold} 共 ${r.bigWins} 筆，產生 ${r.newAlerts} 則${r.cappedOut ? `（另 ${r.cappedOut} 則因 --max-alerts 未產生）` : ''}，${r.seconds}s`
        : `${b.name}: 失敗 ${r.error}${r.auth ? `（連續登入失敗 ${r.loginFailures} 次）` : ''}，${r.seconds}s`) + (r.skipped ? '' : co);
    });
    for (const line of summary) log.info(line);
    if (dryWriter) {
      dryWriter.write(['', '===== 摘要 =====', ...summary].join('\n'));
      log.info(`dry-run output: ${dryWriter.file}`);
    }
    return results.every((r) => r.ok && (!r.cashout || r.cashout.ok)) ? 0 : 1;
  } finally {
    await w.closeBrowser();
    if (ownBrowserLock) releaseLock(paths.browserLock);
  }
}
