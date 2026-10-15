import { doneKeyboard, formatCongrats, formatDoneText } from './format.js';
import { isNotModified, sendVerified, TelegramError } from './telegram.js';
import { sleep } from './util.js';

const HOUR = 3600e3;

/** Cached creator of the private group (getChatAdministrators → status 'creator'). */
export function createCreatorResolver({ api, chatId, tgStore, log, now = () => Date.now(), maxAgeMs = 6 * HOUR }) {
  async function refresh() {
    const admins = await api.call('getChatAdministrators', { chat_id: chatId });
    const creator = (admins || []).find((a) => a.status === 'creator');
    if (!creator) throw new Error('private group has no visible creator');
    tgStore.data.creatorId = creator.user.id;
    tgStore.data.creatorFetchedAt = now();
    tgStore.save();
    return creator.user.id;
  }
  return {
    async get({ force = false } = {}) {
      const cached = tgStore.data.creatorId;
      const fresh = cached && now() - (tgStore.data.creatorFetchedAt || 0) < maxAgeMs;
      if (fresh && !force) return cached;
      try {
        return await refresh();
      } catch (error) {
        log.warn(`creator lookup failed: ${error.message}`);
        return cached || null; // fall back to last known creator; null → nobody may act
      }
    },
  };
}

const STATUS_ANSWER = {
  published: '這則已發佈過了',
  skipped: '這則已忽略',
  publishing: '這則正在發佈或結果不明，為避免重複不會再發',
  unknown: '上次發佈結果不明，為避免重複不會再發；請到社群確認',
  error: '這則發佈時發生異常，請看紀錄',
};

/**
 * Handles 發佈 / 略過 presses. Idempotent: state is persisted BEFORE side effects, a bet can be
 * published at most once (alerts.published index), and an uncertain send is never retried.
 */
export function createCallbackHandler({ api, chatId, alerts, creator, publish, log }) {
  async function answer(cq, text) {
    try { await api.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: false }); } catch (error) { log.warn(`answerCallbackQuery failed: ${error.message}`); }
  }
  async function setButtons(rec, status) {
    if (!rec.messageId) return;
    const cur = alerts.get(rec.id) || rec;
    if (cur.text) {
      // Preferred: drop the buttons entirely and show the result inside the alert itself.
      try {
        await api.call('editMessageText', {
          chat_id: chatId, message_id: rec.messageId, text: formatDoneText(cur.text, status, cur.actedAt ?? Date.now()),
          parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [] },
        });
        return;
      } catch (error) {
        if (isNotModified(error)) return;
        log.warn(`editMessageText ${rec.id} failed, falling back to status button: ${error.message}`);
      }
    }
    try {
      await api.call('editMessageReplyMarkup', { chat_id: chatId, message_id: rec.messageId, reply_markup: doneKeyboard(rec.id, status) });
    } catch (error) {
      if (!isNotModified(error)) log.warn(`editMessageReplyMarkup ${rec.id} failed: ${error.message}`);
    }
  }

  return async function handleUpdate(update) {
    const cq = update?.callback_query;
    if (!cq) return { ignored: 'not a callback' };
    const m = /^([psd]):([0-9a-z]{1,12})$/.exec(String(cq.data || ''));
    if (String(cq.message?.chat?.id) !== String(chatId) || !m) {
      await answer(cq, '');
      return { ignored: 'foreign chat or data' };
    }
    const [, action, id] = m;
    let creatorId = await creator.get();
    if (creatorId && cq.from?.id !== creatorId) creatorId = await creator.get({ force: true }); // ownership may have changed
    if (!creatorId || cq.from?.id !== creatorId) {
      await answer(cq, '只有群主可以操作');
      log.info(`press by non-creator ${cq.from?.id} ignored (${action}:${id})`);
      return { denied: true };
    }
    const rec = alerts.get(id);
    if (!rec) { await answer(cq, '找不到這則提醒（可能已過期）'); return { missing: true }; }
    if (rec.messageId == null) { rec.messageId = cq.message?.message_id ?? null; }
    if (!rec.publishable) { await answer(cq, '這個品牌沒有社群發佈'); return { notPublishable: true }; }

    if (action === 'd' || rec.status !== 'pending') {
      const st = rec.status === 'pending' ? null : rec.status;
      await answer(cq, STATUS_ANSWER[st] || '已處理');
      if (st && ['published', 'skipped', 'unknown', 'error'].includes(st)) await setButtons(rec, st);
      return { already: rec.status };
    }
    const prior = alerts.getPublished(rec.brand, rec.betKey);
    if (prior) {
      alerts.update(id, { status: 'published', note: `already published via ${prior.id}` });
      await setButtons(rec, 'published');
      await answer(cq, STATUS_ANSWER.published);
      return { already: 'published' };
    }

    if (action === 's') {
      alerts.update(id, { status: 'skipped', actedBy: cq.from.id, actedAt: Date.now() });
      await setButtons(rec, 'skipped');
      await answer(cq, '已忽略');
      log.info(`alert ${id} (${rec.brand} ${rec.betKey}) skipped`);
      return { skipped: true };
    }

    // action === 'p': claim first (persisted), then send.
    alerts.update(id, { status: 'publishing', actedBy: cq.from.id, actedAt: Date.now() });
    alerts.markPublished(rec.brand, rec.betKey, { id, state: 'publishing' });
    await answer(cq, '發佈中…');
    try {
      const msg = await publish(rec);
      alerts.update(id, { status: 'published', communityMessageId: msg.message_id, communityChatId: msg.chat.id });
      alerts.markPublished(rec.brand, rec.betKey, { id, state: 'published', messageId: msg.message_id });
      await setButtons(rec, 'published');
      log.info(`alert ${id} (${rec.brand} ${rec.betKey}) published to community (message ${msg.message_id})`);
      return { published: true };
    } catch (error) {
      if (error instanceof TelegramError && error.definite && !error.chatMismatch) {
        // Telegram refused: nothing was posted, so the owner may try again.
        delete alerts.data.published[alerts.publishedKey(rec.brand, rec.betKey)];
        alerts.update(id, { status: 'pending', lastError: error.message });
        log.error(`alert ${id} publish refused: ${error.message}`);
        try { await api.call('sendMessage', { chat_id: chatId, text: `⚠️ 發佈失敗（${rec.brandName}）：${error.description || error.message}\n可再按一次「📣 發佈到社群」重試。`, reply_to_message_id: rec.messageId || undefined }); } catch { /* ignore */ }
        return { failed: true, retryable: true };
      }
      const status = error.chatMismatch ? 'error' : 'unknown';
      alerts.update(id, { status, lastError: error.message });
      alerts.markPublished(rec.brand, rec.betKey, { id, state: status });
      await setButtons(rec, status);
      log.error(`alert ${id} publish result ${status}: ${error.message}`);
      return { failed: true, retryable: false };
    }
  };
}

/** Build the publish(rec) function for community posts. */
export function createPublisher({ brands, loadCommunityBot, createApi }) {
  return async function publish(rec) {
    const brand = brands.find((b) => b.key === rec.brand);
    if (!brand?.community) throw new Error(`brand ${rec.brand} has no community publishing`);
    const bot = loadCommunityBot(brand);
    const api = createApi(bot.token);
    return sendVerified(api, bot.chatId, {
      text: formatCongrats(rec),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: bot.buttonText, url: bot.buttonUrl }]] },
    });
  };
}

/** Long-poll loop for 小精靈. Offset is persisted after each handled update. */
export async function pollLoop({ api, tgStore, handleUpdate, log, shouldStop, onPoll = () => {}, allowedUpdates = ['callback_query', 'message'], dispatchAsync = () => false }) {
  let backoff = 5000;
  while (!shouldStop()) {
    onPoll();
    try {
      const updates = await api.call('getUpdates', { offset: tgStore.data.offset || undefined, timeout: 50, allowed_updates: allowedUpdates }, { timeoutMs: 70000 });
      backoff = 5000;
      for (const u of updates) {
        try {
          if (dispatchAsync(u)) {
            // Keep polling while a private GPT task waits, so its owner can answer or stop it.
            Promise.resolve().then(() => handleUpdate(u)).catch((error) => log.error(`update ${u.update_id} handling failed: ${error.message}`));
          } else await handleUpdate(u);
        } catch (error) {
          log.error(`update ${u.update_id} handling failed: ${error.message}`);
        }
        tgStore.data.offset = u.update_id + 1;
        tgStore.save();
      }
    } catch (error) {
      const conflict = error instanceof TelegramError && error.errorCode === 409;
      log.error(`getUpdates failed${conflict ? ' (CONFLICT: another getUpdates consumer or webhook exists)' : ''}: ${error.message}`);
      await sleep(conflict ? 60000 : backoff);
      backoff = Math.min(60000, backoff * 2);
    }
  }
}
