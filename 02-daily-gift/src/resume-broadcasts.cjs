const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lockIsActive, prepRerunBrands } = require('./runner-policy.cjs');
const { humanizeError } = require('./error-text.cjs');

const root = path.resolve(__dirname, '..');
const statePath = path.join(root, 'state', 'runs.json');
const lockPath = path.join(root, 'state', 'daily-runner.lock');
const rerunPath = path.join(root, 'state', 'prep-reruns.json');
const DAILY_TASK = '每日三平台新手禮包執行器';
const MAX_BROADCAST_ATTEMPTS = 3;
const brands = ['qiezi', 'songyy', 'winmalo'];
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
});
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function yesterdayTaipei(now = new Date()) {
  const today = dateFormat.format(now);
  return dateFormat.format(new Date(new Date(`${today}T12:00:00+08:00`).getTime() - 86400000));
}

function saveState(state) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, statePath);
}

// LINE 步驟前先確認 LINE OA 登入（每個品牌每輪只檢查一次），失效就自動登回；失敗不擋流程。
const lineChecked = new Set();
function child(script, args, timeout = 5 * 60 * 1000) {
  if (/^line-/u.test(script) && args[0] && !lineChecked.has(args[0])) {
    lineChecked.add(args[0]);
    const login = spawnSync(process.execPath, [path.join(root, 'src', 'ensure-logins.cjs'), args[0], '--line'], {
      cwd: root, encoding: 'utf8', timeout: 3 * 60 * 1000, maxBuffer: 1024 * 1024,
    });
    for (const line of `${login.stdout || ''}\n${login.stderr || ''}`.split(/\r?\n/u)) {
      if (line.trim() && !/: ok$/u.test(line.trim())) console.log(line.trim());
    }
  }
  const result = spawnSync(process.execPath, [path.join(root, 'src', script), ...args], {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
  });
  return { code: result.status, error: result.error?.message || '',
    output: `${result.stdout || ''}\n${result.stderr || ''}`.trim() };
}

function verifyPrepared(run) {
  if (!run.sheetProcessed || !run.cleanupVerified || !run.actions?.lineAudience?.confirmedAt
    || !Number.isInteger(run.mailCount) || run.mailCount < 1
    || run.pendingAction !== 'lineBroadcast' || run.actions?.lineBroadcast) {
    throw new Error('批次缺少禮包、工作表清理或 LINE 受眾的確認紀錄。');
  }
}

function shouldReplaceAudience(run, now = new Date()) {
  const audience = run.actions?.lineAudience || {};
  const uploadedAt = Date.parse(audience.lastUploadedAt || audience.confirmedAt || '');
  if (!Number.isFinite(uploadedAt)) throw new Error('LINE 受眾上傳時間缺失，無法判斷五分鐘重傳時點。');
  return (audience.retryCount || 0) === 0 && now.getTime() - uploadedAt >= 5 * 60 * 1000;
}

function reportError(result) {
  if (result.error) return /ETIMEDOUT/u.test(result.error) ? '子程式執行過久被中止' : humanizeError(result.error).slice(0, 240);
  const line = result.output.split(/\r?\n/u).find(item => item.includes('ERROR:'));
  return (line ? humanizeError(line) : `子程式 exit ${result.code}`).slice(0, 240);
}

// line-broadcast.cjs --schedule 結束碼 5 = 在按「預約傳送群發訊息」之前就失敗，LINE 上沒有預約，可安全再試。
function canRetryBroadcast(result, run) {
  return result.code === 5 && !result.error && (run.broadcastAttempts || 0) < MAX_BROADCAST_ATTEMPTS;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function dailyRunnerBusy() {
  return lockIsActive(readJson(lockPath, null));
}

async function main() {
  const reconcileOnly = process.argv.includes('--reconcile-only');
  const supplied = process.argv.find(arg => arg.startsWith('--date='))?.slice(7);
  const date = supplied || yesterdayTaipei();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || date !== yesterdayTaipei()) {
    throw new Error('候補預約只處理台北昨天註冊的會員。');
  }
  if (dailyRunnerBusy()) { console.log('每日禮包執行器正在執行，這輪先不處理。'); return; }
  const localTime = timeFormat.format(new Date());
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { runs: {} };
  if (!state?.runs || typeof state.runs !== 'object') throw new Error('新手禮包批次狀態格式錯誤。');

  // 早上的準備步驟沒完成（且尚未寄出任何東西）→ 自動重啟每日禮包排程，交給它獨自處理。
  if (!reconcileOnly) {
    const history = readJson(rerunPath, {});
    const pending = prepRerunBrands(state.runs, date, localTime, history);
    if (pending.length) {
      const count = (history[date]?.count || 0) + 1;
      history[date] = { count, lastAt: new Date().toISOString(), brands: pending };
      fs.writeFileSync(rerunPath, `${JSON.stringify(history, null, 2)}\n`);
      const started = spawnSync('schtasks.exe', ['/Run', '/TN', DAILY_TASK], { encoding: 'utf8', timeout: 30_000 });
      if (started.status === 0) console.log(`${pending.join('、')}: 早上準備步驟未完成（尚未寄出任何東西），已自動重新啟動每日禮包排程（第 ${count} 次）。`);
      else { console.error(`自動重新啟動每日禮包排程失敗（exit ${started.status}）。`); process.exitCode = 1; }
      return;
    }
  }

  let changed = false;
  for (const brand of brands) {
    const run = state.runs[`${date}/${brand}`];
    if (!['awaiting_audience', 'needs_review'].includes(run?.status) || run.pendingAction !== 'lineBroadcast') continue;
    try {
      verifyPrepared(run);
      const existing = child('line-broadcast.cjs', [brand, date, '--check-scheduled'], 90_000);
      if (existing.code === 0 && !existing.error) {
        const confirmed = JSON.parse(existing.output.split(/\r?\n/u).filter(line => line.trim().startsWith('{')).pop() || existing.output);
        if (confirmed.brand !== brand || !/^\d+$/.test(confirmed.broadcastId)) throw new Error('既有 LINE 預約回傳資料無效。');
        run.actions.lineBroadcast = {
          confirmedAt: new Date().toISOString(), scheduledLocalTime: confirmed.scheduledLocalTime,
          broadcastId: confirmed.broadcastId, verifiedExisting: true,
        };
        run.status = 'completed';
        run.pendingAction = null;
        run.completedAt = new Date().toISOString();
        run.updatedAt = run.completedAt;
        delete run.error;
        saveState(state);
        changed = true;
        console.log(`${brand}: 已核對既有 LINE 18:00 預約 ${confirmed.broadcastId}，不再建立新推播。`);
        continue;
      }
      if (existing.code !== 3 || existing.error) throw new Error(`既有 LINE 預約核對失敗：${reportError(existing)}`);
      if (reconcileOnly || run.status === 'needs_review') {
        console.log(`${brand}: 尚無可核對的 18:00 預約；保留原狀，不自動重做。`);
        continue;
      }
      if (localTime >= '17:15') throw new Error('LINE 受眾截至 17:15 仍未完成預約；今天 18:00 推播需人工核對。');
      const check = child('line-broadcast.cjs', [brand, date, '--check-ready'], 90_000);
      if (check.code === 3 && !check.error) {
        if (shouldReplaceAudience(run)) {
          run.status = 'in_progress';
          run.pendingAction = 'lineAudienceReplace';
          run.updatedAt = new Date().toISOString();
          saveState(state);
          const replaced = child('line-audience.cjs', [brand, date, '--replace']);
          if (replaced.code !== 0) throw new Error(`LINE 受眾重傳結果不明：${reportError(replaced)}`);
          run.actions.lineAudience.retryCount = 1;
          run.actions.lineAudience.lastUploadedAt = new Date().toISOString();
          run.actions.lineAudience.retriedAt = run.actions.lineAudience.lastUploadedAt;
          run.status = 'awaiting_audience';
          run.pendingAction = 'lineBroadcast';
          run.updatedAt = new Date().toISOString();
          saveState(state);
          changed = true;
          console.log(`${brand}: 準備超過五分鐘，已刪除原受眾並重傳一次；等待 LINE 啟用。`);
        } else console.log(`${brand}: LINE 受眾仍在準備中，稍後自動再檢查。`);
        continue;
      }
      if (check.code !== 0) {
        // 單次檢查失敗（網頁慢、連線不穩）不直接判人工，下一輪再檢查；連續失敗才停。
        run.checkFailures = (run.checkFailures || 0) + 1;
        if (run.checkFailures < 3) {
          run.updatedAt = new Date().toISOString();
          saveState(state);
          console.log(`${brand}: LINE 受眾檢查暫時失敗（${reportError(check)}），下一輪再試（第 ${run.checkFailures} 次）。`);
          continue;
        }
        throw new Error(`LINE 受眾檢查連續失敗：${reportError(check)}`);
      }
      delete run.checkFailures;

      run.status = 'in_progress';
      run.pendingAction = 'lineBroadcast';
      run.updatedAt = new Date().toISOString();
      saveState(state);
      const scheduled = child('line-broadcast.cjs', [brand, date, '--schedule', '--no-wait']);
      if (canRetryBroadcast(scheduled, run)) {
        run.broadcastAttempts = (run.broadcastAttempts || 0) + 1;
        run.lastBroadcastError = reportError(scheduled);
        run.status = 'awaiting_audience';
        run.pendingAction = 'lineBroadcast';
        run.updatedAt = new Date().toISOString();
        saveState(state);
        console.log(`${brand}: LINE 預約在送出前卡住（${run.lastBroadcastError}），LINE 上尚未預約；下一輪自動再試（第 ${run.broadcastAttempts} 次）。`);
        continue;
      }
      if (scheduled.code !== 0) throw new Error(`LINE 預約結果不明：${reportError(scheduled)}`);
      const broadcastId = /LINE 推播 (\d+) 已預約/u.exec(scheduled.output)?.[1];
      if (!broadcastId) throw new Error('LINE 預約已送出，但回傳缺少預約 ID；須讀回列表確認，禁止重複建立。');
      run.actions.lineBroadcast = {
        confirmedAt: new Date().toISOString(),
        scheduledLocalTime: `${dateFormat.format(new Date())} 18:00`,
        broadcastId,
      };
      run.status = 'completed';
      run.pendingAction = null;
      run.completedAt = new Date().toISOString();
      run.updatedAt = run.completedAt;
      delete run.error;
      saveState(state);
      changed = true;
      console.log(`${brand}: LINE 18:00 推播已確認預約，批次完成。`);
    } catch (error) {
      run.status = 'needs_review';
      run.error = error.message.slice(0, 240);
      run.updatedAt = new Date().toISOString();
      saveState(state);
      changed = true;
      console.error(`${brand}: ${run.error}`);
      process.exitCode = 1;
    }
  }

  if (changed) {
    const notice = child('telegram-notify.cjs', [date], 25_000);
    if (notice.code !== 0) {
      console.error(`TG 狀態通知失敗：${reportError(notice)}`);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`LINE 候補預約失敗：${error.message}`);
    process.exitCode = 1;
    // 整輪無法執行（例如狀態檔壞掉）也要發 TG，避免無聲失敗。
    spawnSync(process.execPath, [path.join(root, 'src', 'telegram-notify.cjs')], {
      cwd: root, encoding: 'utf8', timeout: 25_000,
      env: { ...process.env, DAILY_GIFT_FATAL_ERROR: `LINE 候補預約無法執行：${error.message}`.slice(0, 240) },
    });
  });
}

module.exports = { yesterdayTaipei, verifyPrepared, shouldReplaceAudience, canRetryBroadcast, reportError };
