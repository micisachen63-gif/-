const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { humanizeError } = require('./error-text.cjs');

const root = path.resolve(__dirname, '..');
const brands = [
  ['qiezi', '茄子'],
  ['songyy', '爽爆'],
  ['winmalo', '贏麻了'],
];
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
});

function yesterdayTaipei(now = new Date()) {
  const today = dateFormat.format(now);
  return dateFormat.format(new Date(new Date(`${today}T12:00:00+08:00`).getTime() - 86400000));
}

function loadConfig() {
  const configPath = process.env.DAILY_GIFT_TG_CONFIG || 'C:\\Users\\User\\Documents\\ChatGPT\\神殿守望者\\telegram.local.json';
  const file = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const token = process.env.DAILY_GIFT_TG_BOT_TOKEN || file.botToken;
  const chatId = String(process.env.DAILY_GIFT_TG_CHAT_ID || file.chatId || '');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token || '') || !/^-?\d+$/.test(chatId)) {
    throw new Error('TG 尚未設定 bot token 與 chat ID；請執行 setup-telegram.ps1。');
  }
  return { token, chatId };
}

function readRuns() {
  const file = path.join(root, 'state', 'runs.json');
  // 狀態檔壞掉時照樣發通知（內容會顯示未開始＋啟動錯誤），不讓通知本身失敗而變成無聲。
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).runs || {} : {}; } catch { return {}; }
}

const statusLabels = {
  completed: '完成啦 ✅',
  needs_review: '送出結果待人工核對 ⚠️',
  failed_preparation: '準備時卡住了 ❌',
  preparing: '準備中',
  prepared: '名單已備妥',
  in_progress: '執行中，結果待確認 ⚠️',
  awaiting_audience: '禮包已送，LINE 受眾準備中 ⏳',
};
const actionLabels = {
  'gameMail/atLeast150': '遊戲禮包（150 以上）',
  'gameMail/below150': '遊戲禮包（未達 150）',
  'gameMail/oneToOne': '遊戲禮包（贏麻了 1:1）',
  lineAudience: 'LINE 受眾更新',
  lineAudienceReplace: 'LINE 受眾重傳',
  lineBroadcast: 'LINE 18:00 推播',
};

function buildReport(date, runs, fatalError = '') {
  const items = brands.map(([key, name]) => {
    const run = runs[`${date}/${key}`] || {};
    return {
      name,
      status: run.status || '未開始',
      memberCount: run.memberCount,
      mailCount: run.mailCount,
      lineCount: run.lineCount ?? run.lineUidCount,
      pendingAction: run.pendingAction || '',
      error: humanizeError(run.error || '').slice(0, 240),
    };
  });
  const complete = !fatalError && items.every(item => item.status === 'completed');
  const waiting = !fatalError && items.some(item => item.status === 'awaiting_audience')
    && items.every(item => ['awaiting_audience', 'completed'].includes(item.status));
  const heading = complete ? '🧙 神殿守望者：新手禮包已妥善安排。🎁'
    : waiting ? '🧙 神殿守望者：禮包已送，LINE 受眾尚待就緒。⏳'
      : '🧙 神殿守望者：此事尚有阻礙，請循紀錄查明。⚠️';
  const lines = [heading, `註冊日：${date}（台北時間）`];
  if (fatalError) lines.push(`🚨 啟動時卡住：${humanizeError(fatalError).slice(0, 240)}`);
  for (const item of items) {
    let line = `🎮 ${item.name}：${statusLabels[item.status] || item.status}`;
    if (Number.isInteger(item.memberCount)) line += `｜新會員 ${item.memberCount} 位`;
    if (Number.isInteger(item.mailCount)) line += `｜已確認禮包 ${item.mailCount} 份`;
    if (Number.isInteger(item.lineCount)) line += `｜LINE 名單 ${item.lineCount} 位`;
    if (item.pendingAction) line += `｜${item.status === 'awaiting_audience' ? '待安排' : '待核對'} ${actionLabels[item.pendingAction] || item.pendingAction}`;
    if (item.error) line += `｜原因：${item.error}`;
    lines.push(line);
  }
  if (complete && items.some(item => item.memberCount > 0)) lines.push('📣 有新會員的品牌已安排今天 18:00 LINE 推播。此事已核，請安心。');
  else if (complete) lines.push('🍃 昨日三站皆無新會員，今日無須派送。');
  else if (waiting) lines.push('⌛ LINE 受眾啟用尚需時間，守望者將自動檢查；就緒後預約 18:00 推播。');
  else lines.push('🔎 有些步驟可能已成功；補跑前請先核對後台與 LINE，別讓會員收到重複禮包喔。');
  return { complete, waiting, items, text: lines.join('\n') };
}

async function callTelegram({ token, chatId }, text, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('TG 連線失敗或逾時。');
  }
  let result;
  try { result = await response.json(); } catch { throw new Error(`TG 回應無法解析（HTTP ${response.status}）。`); }
  if (!response.ok || result.ok !== true) {
    throw new Error(`TG 拒絕發送（HTTP ${response.status}，代碼 ${result.error_code || 'unknown'}）。請確認 Bot 仍在通知群組。`);
  }
  if (String(result.result?.chat?.id) !== chatId) throw new Error('TG 回傳的收件對話不符設定。');
  return result.result;
}

async function deleteTelegramMessage({ token, chatId }, messageId, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    signal: AbortSignal.timeout(15000),
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (result.ok === true) return true;
  const desc = String(result.description || '');
  if (/message to delete not found/i.test(desc)) return true;
  throw new Error(`deleteMessage HTTP ${response.status} ${result.error_code || ''} ${desc}`.trim());
}

function stateFile() { return path.join(root, 'state', 'telegram-notifications.json'); }
function readNotificationState() {
  const file = stateFile();
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { sent: {} };
}
function saveNotificationState(state) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temp, file);
}

async function notifyRun(date, options = {}) {
  const config = options.config || loadConfig();
  if (options.test) {
    await callTelegram(config, '🧙 神殿守望者：新手禮包通知通道已核對。此為連線驗證，未重新派送禮包。🎁', options.fetchImpl);
    return { sent: true, test: true };
  }
  const report = buildReport(date, options.runs || readRuns(), options.fatalError || '');
  const signature = crypto.createHash('sha256').update(JSON.stringify({ date, report })).digest('hex');
  const key = `${date}/${signature}`;
  const state = options.notificationState || readNotificationState();
  state.sent ||= {};
  if (state.sent[key]) return { sent: false, duplicate: true, complete: report.complete, waiting: report.waiting };
  const sentMessage = await callTelegram(config, report.text, options.fetchImpl);
  const messageId = sentMessage?.message_id;
  state.sent[key] = { date, chatId: config.chatId, complete: report.complete, sentAt: new Date().toISOString(), messageId };
  // Keep only the latest notice for this batch date: delete earlier notices this bot sent for the same date.
  for (const [oldKey, entry] of Object.entries(state.sent)) {
    if (entry?.chatId !== config.chatId) continue;
    if (oldKey === key || !entry || entry.date !== date || !Number.isInteger(entry.messageId) || entry.deleted) continue;
    try {
      await deleteTelegramMessage(config, entry.messageId, options.fetchImpl);
      entry.deleted = true;
      delete entry.deleteError;
    } catch (error) {
      entry.deleteError = String(error.message || error).slice(0, 200);
    }
  }
  if (!options.notificationState) saveNotificationState(state);
  return { sent: true, complete: report.complete, waiting: report.waiting };
}

async function main() {
  const args = process.argv.slice(2);
  const date = args.find(x => /^\d{4}-\d{2}-\d{2}$/.test(x)) || yesterdayTaipei();
  const result = await notifyRun(date, {
    test: args.includes('--test'),
    fatalError: process.env.DAILY_GIFT_FATAL_ERROR || '',
  });
  console.log(result.duplicate ? 'TG 通知已發送過，略過。' : result.test ? 'TG 測試訊息已送達。' : `TG ${result.complete ? '完成' : result.waiting ? '等待' : '異常'}通知已送達。`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`TG 通知失敗：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { yesterdayTaipei, buildReport, callTelegram, deleteTelegramMessage, notifyRun };
