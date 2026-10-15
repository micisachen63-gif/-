import fs from 'node:fs';
import path from 'node:path';
import { TelegramError, TelegramNetworkError, sendVerified } from './telegram.js';
import { readJson, writeJsonAtomic } from './util.js';

const DESTINATIONS = {
  atg: { brand: 'winmalo', name: '贏麻了' },
  shuangbao: { brand: 'songyy', name: '爽爆' },
  qiezi: { brand: 'qiezi', name: '茄子' },
};
const PROJECT_ROOTS = {
  atg: 'C:\\Users\\User\\Documents\\ChatGPT\\營運自動化',
  shuangbao: 'C:\\Users\\User\\Documents\\ChatGPT\\03-機台與風控\\爽爆機台狙擊手',
  qiezi: 'C:\\Users\\User\\Documents\\ChatGPT\\03-機台與風控\\茄子機台狙擊手',
};
const CALLBACK = /^ps:(atg|shuangbao|qiezi):([a-f0-9]{12})$/;
const MAX_AGE_MS = 3 * 86400000;

function stateFile(stateDir, project) {
  return path.join(stateDir, 'ops-shares', `${project}.json`);
}

function readShareState(file) {
  const data = readJson(file, { shares: [] });
  if (!Array.isArray(data.shares)) data.shares = [];
  return data;
}

function keyboardFor(state, sourceMessageId) {
  const records = state.shares.filter((item) => Number(item.sourceMessageId) === Number(sourceMessageId));
  if (!records.length) return { inline_keyboard: [] };
  return {
    inline_keyboard: records.map((item) => {
      const status = item.status;
      const text = status === 'published' ? `✅ ${item.game} 已分享到${DESTINATIONS[item.project]?.name || '社群'}`
        : status === 'publishing' ? `⏳ ${item.game} 分享中`
          : status === 'unknown' ? `❔ ${item.game} 結果待確認`
            : status === 'error' ? `⚠️ ${item.game} 請檢查群組`
              : `📣 分享 ${item.game} 撿台`;
      return [{ text, callback_data: `ps:${item.project}:${item.id}` }];
    }),
  };
}

function safePhotoPath(project, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const root = PROJECT_ROOTS[project];
  if (!root) return null;
  const candidate = path.resolve(value);
  const relative = path.relative(path.resolve(root), candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  return candidate;
}

/**
 * Shares a previously sent pick-table message from the operations group to that brand's
 * configured community. The group creator is the only person allowed to publish.
 */
export function createOpsShareHandler({ api, chatId, stateDir, creator, brands, loadCommunityBot, createApi, log, now = () => Date.now() }) {
  async function answer(cq, text = '') {
    try { await api.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: false }); }
    catch (error) { log.warn(`ops-share answerCallbackQuery failed: ${error.message}`); }
  }

  async function updateKeyboard(project, sourceMessageId) {
    if (!sourceMessageId) return;
    const file = stateFile(stateDir, project);
    const state = readShareState(file);
    try {
      await api.call('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: sourceMessageId,
        reply_markup: keyboardFor(state, sourceMessageId),
      });
    } catch (error) {
      if (!/message is not modified|message to edit not found/i.test(String(error.description || error.message))) {
        log.warn(`ops-share keyboard update failed (${project}): ${error.message}`);
      }
    }
  }

  return async function handleOpsShare(update) {
    const cq = update?.callback_query;
    const match = CALLBACK.exec(String(cq?.data || ''));
    if (!cq || !match) return false;
    const [, project, id] = match;
    if (String(cq.message?.chat?.id) !== String(chatId)) {
      await answer(cq);
      return true;
    }

    let ownerId = await creator.get();
    if (ownerId && String(cq.from?.id) !== String(ownerId)) ownerId = await creator.get({ force: true });
    if (!ownerId || String(cq.from?.id) !== String(ownerId)) {
      await answer(cq, '只有群主可以操作');
      log.info(`ops-share press by non-creator ${cq.from?.id} ignored (${project}:${id})`);
      return true;
    }

    const file = stateFile(stateDir, project);
    const state = readShareState(file);
    const record = state.shares.find((item) => item.id === id && item.project === project);
    if (!record) {
      await answer(cq, '這則撿台分享已過期');
      return true;
    }
    record.sourceMessageId ||= cq.message?.message_id ?? null;
    if (record.status !== 'pending') {
      const status = record.status === 'published' ? '已分享過了' : record.status === 'publishing' ? '正在分享中' : record.status === 'unknown' ? '結果不明，請先到社群確認' : '請檢查群組與紀錄';
      await answer(cq, status);
      await updateKeyboard(project, record.sourceMessageId);
      return true;
    }

    const destination = DESTINATIONS[project];
    const brand = brands.find((item) => item.key === destination?.brand);
    if (!destination || !brand?.community) {
      await answer(cq, '這個品牌尚未設定社群');
      return true;
    }
    record.status = 'publishing';
    record.actedAt = now();
    record.actedBy = cq.from.id;
    writeJsonAtomic(file, state);
    await answer(cq, '正在分享到社群…');

    try {
      const bot = loadCommunityBot(brand);
      const communityApi = createApi(bot.token);
      const replyMarkup = { inline_keyboard: [[{ text: bot.buttonText, url: bot.buttonUrl }]] };
      let message;
      const photoPath = safePhotoPath(project, record.photoPath);
      if (record.photoPath && !photoPath) throw new Error('撿台原圖不存在或路徑不在專案內');
      if (photoPath) {
        const ext = path.extname(photoPath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        message = await communityApi.sendPhoto({
          chatId: bot.chatId,
          buffer: fs.readFileSync(photoPath),
          mimeType,
          fileName: path.basename(photoPath),
          caption: record.text,
          parseMode: 'HTML',
          replyMarkup,
        });
      } else {
        message = await sendVerified(communityApi, bot.chatId, {
          text: record.text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: replyMarkup,
        });
      }
      if (String(message?.chat?.id) !== String(bot.chatId)) {
        const error = new Error('Telegram 回傳的撿台社群 chat ID 與設定不符');
        error.chatMismatch = true;
        throw error;
      }
      record.status = 'published';
      record.communityChatId = String(message.chat.id);
      record.communityMessageId = message.message_id;
      record.publishedAt = now();
      writeJsonAtomic(file, state);
      await updateKeyboard(project, record.sourceMessageId);
      log.info(`pick-table post shared (${project}/${record.game}) to configured community`);
      return true;
    } catch (error) {
      const uncertain = error.chatMismatch || error instanceof TelegramNetworkError;
      record.status = error.chatMismatch ? 'error' : uncertain ? 'unknown' : 'pending';
      record.lastError = String(error.message || error).slice(0, 300);
      writeJsonAtomic(file, state);
      await updateKeyboard(project, record.sourceMessageId);
      log.error(`pick-table share failed (${project}/${record.game}): ${error.message}`);
      try {
        await api.call('sendMessage', {
          chat_id: chatId,
          reply_to_message_id: record.sourceMessageId || undefined,
          text: error.chatMismatch
            ? `⚠️ 撿台分享目的地核對不符，已停止重試；請核對社群設定。`
            : uncertain
              ? `❔ 撿台分享結果不明，為避免重複發文，請先到${destination.name}社群確認。`
              : `⚠️ 撿台分享失敗（${destination.name}）：${error.description || error.message}\n可再按一次按鈕重試。`,
          allow_sending_without_reply: true,
        });
      } catch { /* keep the original failure as the source of truth */ }
      return true;
    }
  };
}
