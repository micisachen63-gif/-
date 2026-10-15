import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadAlertBot, paths, projectRoot } from './config.js';
import { BridgeState } from './bridge-state.js';
import { createChatGptWeb } from './chatgpt-web.js';
import { createLogger } from './log.js';
import { createTelegramApi, sendVerified } from './telegram.js';
import { fmtStamp, readJson, writeJsonAtomic } from './util.js';

const STATE_FILE = path.join(paths.stateDir, 'today-food.json');
const LOG_FILE = path.join(paths.logsDir, 'today-food.log');
const SESSION_KEY = 'daily:today-food';

export function taipeiDate(now = Date.now()) {
  return fmtStamp(now).slice(0, 10);
}

export function buildFoodPrompt(date) {
  return `你是「今天吃什麼」的每日餐廳情報員。今天是 ${date}（台灣時間）。請務必先實際搜尋目前網路上的最新公開資訊與近期討論，再整理結果；不要只靠既有記憶，也不要虛構 Google 評分、價格或店家資訊。\n\n搜尋範圍：只限新北市三重區、蘆洲區、中和區、永和區；不要推薦其他行政區。\n目標：從上述四區挑出最近網路討論熱度高、值得今天去吃的 5 家店，類型限小吃／小吃攤、日式、美式、港式，可混搭，不必平均。優先參考近期 Google 地圖公開資訊、近期社群／論壇／媒體討論、店家官方資訊。\n\n每家一定要包含：\n1. 店名\n2. 類型\n3. 所在區域（至少到行政區）\n4. 特色餐點 1～3 項\n5. Google 評價星數（請標示你查到的數值；若無法可靠確認就寫「未可靠確認」，禁止猜）\n6. 價位區間（每人約 NT$___～___；若資料不足可寫約略區間並標示「約」）\n7. 為什麼最近值得吃：用一句話摘要近期討論熱點或特色\n\n輸出要求：\n- 繁體中文。\n- 開頭固定為「🍜 今天吃什麼｜${date}」\n- 共 5 家，使用 1～5 編號。\n- 每家盡量精簡，總長控制在 3600 字內，適合直接貼到 Telegram。\n- 不要輸出 Markdown 表格。\n- 最後加一行「資料為當日網路公開資訊整理，Google 評分與營業資訊可能隨時變動。」\n- 不要附帶你無法驗證的精確地址、電話或營業時間。`;
}

export function sanitizeFoodAnswer(text, date) {
  let out = String(text || '').trim();
  if (!out) throw new Error('GPT 沒有回傳餐廳推薦內容');
  out = out.replace(/```(?:markdown|text)?/gi, '').replace(/```/g, '').trim();
  if (!out.startsWith('🍜 今天吃什麼｜')) out = `🍜 今天吃什麼｜${date}\n\n${out}`;
  if (out.length > 3900) out = out.slice(0, 3850).trimEnd() + '\n\n（內容過長，已自動截短）';
  return out;
}

export function shouldRunToday(state, date) {
  return state?.lastSentDate !== date && state?.pendingDate !== date;
}

export async function runTodayFood({ cfg = loadConfig(), now = Date.now(), dry = false, force = false, askImpl, telegramImpl, log } = {}) {
  const date = taipeiDate(now);
  const logger = log || createLogger(LOG_FILE, { echo: process.stdout.isTTY });
  const state = readJson(STATE_FILE, { lastSentDate: null, pendingDate: null, lastMessageId: null, lastRunAt: null, lastError: null });
  if (!force && !shouldRunToday(state, date)) {
    logger.info(`today-food skipped: ${date} already sent or pending`);
    return { skipped: true, date, reason: state.lastSentDate === date ? 'already-sent' : 'pending' };
  }
  const previousState = force ? { lastSentDate: state.lastSentDate ?? null, pendingDate: state.pendingDate ?? null, lastMessageId: state.lastMessageId ?? null, lastRunAt: state.lastRunAt ?? null, lastError: state.lastError ?? null } : null;

  const bridgeState = new BridgeState(path.join(paths.stateDir, 'bridge.json'));
  const ask = askImpl || createChatGptWeb({
    endpoint: cfg.chatgptWeb.endpoint,
    timeoutMs: Math.max(180000, (cfg.localMaintenance?.timeoutSeconds ?? 300) * 1000),
    executablePath: cfg.chatgptWeb.executablePath,
    profileDir: cfg.chatgptWeb.profileDir,
    background: cfg.chatgptWeb.background !== false,
    dedicatedPage: true,
    newChatUrl: cfg.chatgptWeb.projectUrl,
    log: logger,
    state: bridgeState,
    sessionKey: SESSION_KEY,
  }).ask;

  try {
    logger.info(`today-food researching for ${date}`);
    const raw = await ask(buildFoodPrompt(date), { conversationTitle: '今天吃什麼｜三重蘆洲中和永和' });
    const answer = sanitizeFoodAnswer(typeof raw === 'string' ? raw : raw?.text, date);
    if (dry) {
      logger.info(`today-food dry run complete (${answer.length} chars)`);
      return { dry: true, date, text: answer };
    }

    state.pendingDate = date;
    state.lastRunAt = new Date(now).toISOString();
    state.lastError = null;
    writeJsonAtomic(STATE_FILE, state);

    const bot = loadAlertBot(cfg);
    const api = telegramImpl || createTelegramApi(bot.token);
    const msg = await sendVerified(api, bot.chatId, { text: answer, disable_web_page_preview: true });
    state.lastSentDate = date;
    state.lastMessageId = msg.message_id;
    state.lastRunAt = new Date(now).toISOString();
    state.pendingDate = null;
    state.lastError = null;
    if (force) state.lastForcedSend = { messageId: msg.message_id, previousState, sentAt: new Date(now).toISOString() };
    writeJsonAtomic(STATE_FILE, state);
    logger.info(`today-food sent for ${date}, message ${msg.message_id}${force ? ' (forced)' : ''}`);
    return { sent: true, date, messageId: msg.message_id, text: answer };
  } catch (error) {
    state.lastRunAt = new Date(now).toISOString();
    state.lastError = String(error?.message || error).slice(0, 500);
    if (state.pendingDate !== date) state.pendingDate = null;
    writeJsonAtomic(STATE_FILE, state);
    logger.error(`today-food failed: ${error?.stack || error}`);
    throw error;
  }
}

export async function undoLastForcedSend({ cfg = loadConfig(), telegramImpl, log } = {}) {
  const logger = log || createLogger(LOG_FILE, { echo: process.stdout.isTTY });
  const state = readJson(STATE_FILE, {});
  const rec = state.lastForcedSend;
  if (!rec?.messageId || !rec?.previousState) return { skipped: true, reason: 'no-forced-send' };
  const bot = loadAlertBot(cfg);
  const api = telegramImpl || createTelegramApi(bot.token);
  await api.call('deleteMessage', { chat_id: bot.chatId, message_id: rec.messageId });
  const restored = { ...rec.previousState };
  writeJsonAtomic(STATE_FILE, restored);
  logger.info(`today-food forced send ${rec.messageId} rolled back`);
  return { undone: true, messageId: rec.messageId };
}

async function main() {
  const dry = process.argv.includes('--dry');
  const force = process.argv.includes('--force');
  if (process.argv.includes('--undo-last-force')) { await undoLastForcedSend(); return; }
  await runTodayFood({ dry, force });
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) main().then(() => process.exit(0), error => { process.stderr.write(`今天吃什麼失敗：${error?.message || error}\n`); process.exit(1); });
