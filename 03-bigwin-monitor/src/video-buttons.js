// 「✏️ 繼續修改」 under each delivered Grok video. Not pressed within 10 minutes → the keyboard becomes a single inert 「✅ 製作完成」.
// Pressing it asks for the change (force reply); that reply is handled exactly like a reply to the video (7-day Grok post map).
// Pending expiries and prompts live in tgStore (telegram.json), so a restart neither forgets nor double-edits them; sweep() runs on
// startup, on a timer and on every update.
export const VB_CALLBACK_RE = /^ve:([ed])$/;
export const VIDEO_BUTTON_TTL_MS = 10 * 60e3;
export const VB_EDIT_LABEL = '✏️ 繼續修改';
export const VB_DONE_LABEL = '✅ 製作完成';
export const VB_TEXT = {
  ask: '請回覆這則訊息，寫下想怎麼修改這支影片（例如「讓她轉頭微笑」）✏️',
  done: '這支影片已製作完成；想再改，直接回覆影片寫下指示即可（7 天內）。',
  pressed: '請回覆提示訊息，寫下修改內容',
  gone: '這個按鈕已失效；想修改的話，直接回覆影片寫下指示即可（7 天內）。',
};
export const videoEditKeyboard = () => ({ inline_keyboard: [[{ text: VB_EDIT_LABEL, callback_data: 've:e' }]] });
export const videoDoneKeyboard = () => ({ inline_keyboard: [[{ text: VB_DONE_LABEL, callback_data: 've:d' }]] });
const KEEP_PRESSED_MS = 7 * 24 * 3600e3, PROMPT_TTL_MS = 24 * 3600e3, GIVE_UP_MS = 48 * 3600e3;
const permanent = (error) => /not found|not modified|can't be edited|message_id_invalid|MESSAGE_ID_INVALID|chat not found|bot was kicked|forbidden/i.test(String(error?.description || error?.message || ''));

export function createVideoButtons({ api, send, answer, log, now = () => Date.now(), tgStore = null, botUsername = () => '' }) {
  const data = tgStore?.data.videoButtons || {};
  const pending = data.pending || {}; const prompts = data.prompts || {};
  const save = () => { if (!tgStore) return; tgStore.data.videoButtons = { pending, prompts }; tgStore.save(); };
  const key = (chatId, messageId) => `${chatId}:${messageId}`;
  let sweeping = null;
  async function markDone(k, e) {
    try { await api.call('editMessageReplyMarkup', { chat_id: e.chatId, message_id: e.messageId, reply_markup: videoDoneKeyboard() }); delete pending[k]; return true; }
    catch (error) {
      if (permanent(error) || now() - e.at > GIVE_UP_MS) { delete pending[k]; return true; }
      log?.warn?.(`video button expiry ${k} failed (will retry): ${error.message}`); return false;
    }
  }
  async function runSweep() {
    const t = now(); let changed = false;
    for (const [k, e] of Object.entries(pending)) {
      if (e.pressedAt) { if (t - e.pressedAt > KEEP_PRESSED_MS) { delete pending[k]; changed = true; } continue; }
      if (t - e.at >= VIDEO_BUTTON_TTL_MS && await markDone(k, e)) changed = true;
    }
    for (const [k, p] of Object.entries(prompts)) if (t - p.at > PROMPT_TTL_MS) { delete prompts[k]; changed = true; }
    if (changed) save();
    return changed;
  }
  return {
    pending, prompts,
    /** A Grok video was just sent with videoEditKeyboard(). */
    delivered(chatId, messageId, userId = null) { pending[key(chatId, messageId)] = { chatId, messageId, userId, at: now() }; save(); },
    /** Expire unpressed buttons (idempotent; concurrent callers share one pass). */
    sweep() { if (!sweeping) sweeping = runSweep().catch((error) => { log?.warn?.(`video button sweep failed: ${error.message}`); return false; }).finally(() => { sweeping = null; }); return sweeping; },
    async onCallback(cq, action, { group = false } = {}) {
      const chat = cq.message?.chat; const k = key(chat?.id, cq.message?.message_id); const e = pending[k];
      if (action === 'd') { await answer(cq, VB_TEXT.done); return { videoDone: true }; }
      if (!e) { await answer(cq, VB_TEXT.gone); return { videoButtonGone: true }; }
      if (!e.pressedAt && now() - e.at >= VIDEO_BUTTON_TTL_MS) { await answer(cq, VB_TEXT.done); if (await markDone(k, e)) save(); return { videoButtonExpired: true }; }
      e.pressedAt ||= now(); // pressed: the button stays as it is; no expiry for this video any more
      await answer(cq, VB_TEXT.pressed);
      const name = String(cq.from?.first_name || '').slice(0, 32);
      const text = group && name ? `${name}，${VB_TEXT.ask}` : VB_TEXT.ask;
      const extra = { reply_to_message_id: e.messageId, allow_sending_without_reply: true, reply_markup: { force_reply: true, selective: group, input_field_placeholder: '想怎麼修改…' } };
      if (group && name) extra.entities = [{ type: 'text_mention', offset: 0, length: name.length, user: { id: cq.from.id, first_name: name, is_bot: false } }];
      const p = await send(text, extra, e.chatId);
      if (p?.message_id != null) prompts[key(e.chatId, p.message_id)] = { videoMessageId: e.messageId, userId: cq.from?.id ?? null, at: now(), videoAt: e.at };
      save();
      return { videoEditAsk: true, prompt: p?.message_id ?? null };
    },
    /** A reply to our 「請回覆…修改」 prompt → the same message as a reply to the video itself (null = not such a reply). */
    rewriteReply(msg) {
      const rt = msg?.reply_to_message; if (!rt) return null;
      const k = key(msg.chat?.id, rt.message_id); const p = prompts[k]; if (!p) return null;
      if (p.userId != null && String(p.userId) !== String(msg.from?.id)) return { ignored: 'not video prompt owner' };
      delete prompts[k]; save();
      const video = { message_id: p.videoMessageId, date: Math.floor((p.videoAt || p.at) / 1000), chat: msg.chat, from: { id: 0, is_bot: true, ...(botUsername() ? { username: botUsername() } : {}) }, video: {} };
      return { ...msg, reply_to_message: video };
    },
  };
}