// 觀音求籤 Telegram flow: 請神 → 問事 → 選籤 → 確認 → 解籤. All buttons carry session id + seq, so stale presses are rejected.
import fs from 'node:fs';
import { JIAO, QIUQIAN_TTL_MS, applyQiuqianThrow, buildQiuqianPrompt, createQiuqianSession, drawSign, getSign, jiaoImageUrl,
  qiuqianAskKeyboard, qiuqianAskText, qiuqianConfirmKeyboard, qiuqianDrawnText, qiuqianIntroKeyboard, qiuqianIntroText,
  qiuqianDeityArrivedText, qiuqianQuestionPrompt, qiuqianRetryKeyboard, qiuqianShakeKeyboard, qiuqianShakeText, qiuqianSignText, throwJiao,
  QQ_FOLLOWUP_END, QQ_FOLLOWUP_EXPIRED, QQ_FOLLOWUP_LABEL, buildQiuqianFollowupPrompt, qiuqianFollowupAskText, qiuqianFollowupKeyboard } from './qiuqian.js';

export const QQ_CALLBACK_RE = /^qq:([stygprqxf])(?::([a-z0-9]{1,24}):([0-9]{1,5})(?::([0-9]{1,3}))?)?$/;
const FOLLOWUP_STAGES = ['done', 'followup', 'followupReading'];
const TEMPLE_IMAGES = ['temple.jpg', 'temple.png'].map((f) => new URL('../assets/qiuqian/' + f, import.meta.url));
const DEITY_IMAGES = ['guanyin.jpg', 'guanyin.png'].map((f) => new URL(`../assets/qiuqian/${f}`, import.meta.url));

export function createQiuqianFlow({ api, send, edit, answer, log, now = () => Date.now(), tgStore = null, inGroup, inUserPrivate, isGroupMember,
  flowKey, splitText, interpreter = null, random = Math.random, mode = 'all', refreshKeyboard = async () => {}, menuMarkup = () => null, readFile = (u) => fs.readFileSync(u), statFile = (u) => fs.statSync(u),
  deityImage = undefined, templeImage = undefined, maxConcurrent = 2 }) {
  const saved = tgStore?.data.qiuqian || {};
  const sessions = new Map(Object.entries(saved.sessions || {}));
  // sessions saved by the old 100-button picker: the 選籤 step is now 搖籤筒
  for (const s of sessions.values()) if (s.stage === 'pick') { s.stage = 'shake'; s.seq++; s.pick = null; }
  const prompts = new Map(Object.entries(saved.prompts || {}).map(([k, v]) => [k.includes(':') ? k : Number(k), v]));
  const busy = new Set(), readingPending = new Set(), jobs = new Map(), queue = []; let active = 0;
  const images = new Map(); let counter = Math.floor(Math.random() * 1296);
  const save = () => { if (!tgStore) return; tgStore.data.qiuqian = { sessions: Object.fromEntries(sessions), prompts: Object.fromEntries(prompts) }; tgStore.save(); };
  const expired = (s) => now() - s.updatedAt > QIUQIAN_TTL_MS;
  // prompt keys of sessions that prune() expired (in memory, 24 h): a late reply still gets a friendly note instead of silence
  const ended = new Map();
  // Photos are uploaded as bytes (no Telegram file_id reuse). The bytes cache is keyed on path + mtime + size,
  // so replacing an image on disk takes effect on the next send without a restart.
  const cachedFile = (u) => {
    const st = statFile(u); const key = String(u); const sig = `${st.mtimeMs}:${st.size}`;
    const hit = images.get(key); if (hit && hit.sig === sig) return hit.buffer;
    const buffer = readFile(u); images.set(key, { sig, buffer }); return buffer;
  };
  const image = (kind) => cachedFile(jiaoImageUrl(kind));
  const assetImage = (urls, label) => {
    for (const u of urls) { try { if (fs.existsSync(u)) return { buffer: cachedFile(u), mimeType: String(u).endsWith('.png') ? 'image/png' : 'image/jpeg', fileName: String(u).split('/').pop() }; } catch (error) { log.warn('qiuqian ' + label + ' image unreadable: ' + error.message); } }
    return null;
  };
  // the invite step (opening and retries) shows the temple; the deity image appears only after a sheng-jiao says she has arrived
  const deity = () => (deityImage !== undefined ? deityImage : assetImage(DEITY_IMAGES, 'deity'));
  const temple = () => (templeImage !== undefined ? templeImage : assetImage(TEMPLE_IMAGES, 'temple'));
  const stripButtons = async (chatId, messageId) => {
    if (!messageId) return;
    try { await api.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }); }
    catch (error) { if (!/not modified|not found/i.test(String(error?.description || error?.message))) log.warn(`qiuqian strip buttons failed: ${error.message}`); }
  };
  // Old failed-throw / draw messages are replaced by the newest one, which carries the history. If Telegram refuses a delete (e.g. >48 h old), that message just loses its buttons.
  const dropMessages = async (chatId, ids) => {
    for (const id of [...new Set((ids || []).filter((x) => x != null))]) {
      try { await api.call('deleteMessage', { chat_id: chatId, message_id: id }); }
      catch (error) { if (!/not found|can't be deleted|message to delete/i.test(String(error?.description || error?.message))) log.warn(`qiuqian delete message failed: ${error.message}`); await stripButtons(chatId, id); }
    }
  };
  const markup = (keyboard) => (keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {});
  async function sendPhotoOr(chatId, { buffer, mimeType, fileName }, caption, keyboard) {
    if (typeof api.sendPhoto === 'function' && buffer) {
      try { return await api.sendPhoto({ chatId, buffer, mimeType, fileName, caption, replyMarkup: keyboard?.length ? { inline_keyboard: keyboard } : undefined }); }
      catch (error) { log.warn(`qiuqian photo failed, sending text instead: ${error.message}`); }
    }
    return send(caption, markup(keyboard), chatId);
  }
  const mention = (user, text, group) => (group && user?.first_name && text.startsWith(user.first_name) ? { entities: [{ type: 'text_mention', offset: 0, length: user.first_name.length, user: { id: Number(user.id) } }] } : {});

  async function start(user, chat) {
    if (mode === 'operations') return { ignored: 'life feature' };
    for (const [id, s] of sessions) if (String(s.chatId) === String(chat.id) && String(s.userId) === String(user.id)) sessions.delete(id);
    for (const [k, id] of prompts) if (!sessions.has(id)) prompts.delete(k);
    const sid = `${now().toString(36)}${Math.abs(Number(user.id)).toString(36)}${(++counter).toString(36)}`.slice(-24);
    const session = createQiuqianSession({ id: sid, userId: user.id, chatId: chat.id, userName: user.first_name || '', now: now() });
    sessions.set(sid, session);
    const text = qiuqianIntroText(session, inGroup(chat)); const img = temple();
    const msg = img ? await sendPhotoOr(chat.id, { fileName: 'temple.jpg', ...img }, text, qiuqianIntroKeyboard(session))
      : await send(text, markup(qiuqianIntroKeyboard(session)), chat.id);
    session.messageId = msg?.message_id ?? null; save();
    return { qiuqianStarted: sid };
  }

  async function askQuestion(session, user, chat) {
    const group = inGroup(chat);
    const text = qiuqianQuestionPrompt(session, group);
    const prompt = await send(text, { reply_markup: { force_reply: true, selective: group, input_field_placeholder: '寫下想請示的事…' }, ...mention(user, text, group) }, chat.id);
    session.promptId = prompt?.message_id ?? null;
    if (session.promptId != null) prompts.set(flowKey(chat.id, session.promptId), session.id);
  }
  async function onCallback(cq, action, sid, seq, arg) {
    const chat = cq.message?.chat;
    if (mode === 'operations') { await answer(cq, '求籤之事，請找小精靈。'); return { denied: true }; }
    if (!inGroup(chat) && !inUserPrivate(chat, cq.from)) { await answer(cq); return { ignored: 'chat' }; }
    if (inUserPrivate(chat, cq.from) && !await isGroupMember(cq.from)) { await answer(cq, '🚫⛔ 這一切已與你無關！👋'); return { denied: true }; }
    if (action === 's') { await answer(cq); return start(cq.from, chat); }
    const session = sessions.get(String(sid || ''));
    if (!session || expired(session)) {
      const afterReading = action === 'f' || Boolean(session && FOLLOWUP_STAGES.includes(session.stage));
      if (session) { sessions.delete(session.id); for (const [k, id] of prompts) if (id === session.id) prompts.delete(k); save(); }
      await answer(cq, afterReading ? '這次求籤已結束（超過 30 分鐘沒有動靜）' : '這次求籤已結束，請重新按「🙏 觀音求籤」');
      await stripButtons(chat.id, cq.message?.message_id);
      if (afterReading) await send(QQ_FOLLOWUP_EXPIRED, {}, chat.id);
      return { expired: true };
    }
    if (String(session.userId) !== String(cq.from.id)) { await answer(cq, '這不是你的籤喔 🙏'); return { denied: true }; }
    if (action === 'g' || action === 'p') { // buttons of the retired 100-number picker
      await answer(cq, '選籤已改為搖籤筒 🎋');
      if (session.stage !== 'shake') { await stripButtons(chat.id, cq.message?.message_id); return { stale: true }; }
      await edit(cq.message?.message_id, qiuqianShakeText(session), qiuqianShakeKeyboard(session), chat.id);
      session.messageId = cq.message?.message_id ?? session.messageId; save();
      return { qiuqianLegacyPicker: true };
    }
    if (Number(seq) !== session.seq) { await answer(cq, '這個按鈕已過期，請使用最新的訊息 🙏'); return { stale: true }; }
    if (busy.has(session.id)) { await answer(cq, '處理中，請稍候…'); return { busy: true }; }
    busy.add(session.id);
    try {
      session.updatedAt = now();
      if (action === 't') {
        if (!['invite', 'asking', 'confirm'].includes(session.stage)) { await answer(cq, '現在不是擲筊的時候'); return { invalid: true }; }
        const kind = throwJiao(random);
        await answer(cq, `擲出${JIAO[kind].name}`);
        const pressed = cq.message?.message_id; const oldFailed = session.failedMsgs || [];
        if (oldFailed.length) await dropMessages(chat.id, oldFailed);
        if (!oldFailed.includes(pressed)) await stripButtons(chat.id, pressed);
        session.failedMsgs = [];
        const stageBefore = session.stage; const out = applyQiuqianThrow(session, kind, now()); const reinvite = stageBefore === 'invite' && out.next === 'again';
        save();
        const photo = await sendPhotoOr(chat.id, { buffer: image(kind), mimeType: 'image/jpeg', fileName: `jiaobei-${kind}.jpg` }, reinvite ? out.resultCaption : out.caption, reinvite ? [] : out.keyboard);
        session.messageId = photo?.message_id ?? session.messageId;
        if (reinvite) { const t = temple(); const text = out.caption; const m = t ? await sendPhotoOr(chat.id, { fileName: 'temple.jpg', ...t }, text, out.keyboard) : await send(text, markup(out.keyboard), chat.id); session.messageId = m?.message_id ?? session.messageId; }
        if (out.next === 'again' || (stageBefore === 'confirm' && out.next === 'shake')) session.failedMsgs = [...new Set([photo?.message_id, reinvite ? session.messageId : null].filter((x) => x != null))];
        if (out.next === 'question') { const d = deity(); const text = qiuqianDeityArrivedText(session, inGroup(chat)); if (d) await sendPhotoOr(chat.id, { fileName: 'guanyin.jpg', ...d }, text, []); else await send(text, {}, chat.id); await askQuestion(session, cq.from, chat); }
        save();
        if (out.next === 'reading') return { qiuqianThrow: kind, stage: session.stage, completion: scheduleReading(session) };
        return { qiuqianThrow: kind, stage: session.stage };
      }
      if (action === 'q') {
        if (session.stage !== 'asking') { await answer(cq, '現在不能改問題'); return { invalid: true }; }
        session.stage = 'question'; session.seq++; save(); await answer(cq, '請重新寫下想請示的事');
        await stripButtons(chat.id, cq.message?.message_id); await askQuestion(session, cq.from, chat); save();
        return { qiuqianRephrase: true };
      }
      if (action === 'y') {
        if (session.stage !== 'shake') { await answer(cq, '現在不是搖籤的時候'); return { invalid: true }; }
        const n = drawSign(random);
        session.pick = n; session.draws = [...(session.draws || []), { n, at: now() }]; session.stage = 'confirm'; session.seq++; save();
        await answer(cq, `搖出第 ${n} 籤`); await stripButtons(chat.id, cq.message?.message_id);
        if (session.drawMsgId != null) { await dropMessages(chat.id, [session.drawMsgId, ...(session.failedMsgs || [])]); session.failedMsgs = []; } // re-shake: replace the earlier draw + failed confirm
        const m = await send(qiuqianDrawnText(session), markup(qiuqianConfirmKeyboard(session)), chat.id);
        session.messageId = m?.message_id ?? session.messageId; save();
        session.drawMsgId = m?.message_id ?? null; save();
        return { qiuqianDrawn: n };
      }
      if (action === 'r') {
        if (session.stage !== 'error') { await answer(cq, session.stage === 'reading' ? '小精靈正在解籤…' : '這支籤已解完'); return { busy: true }; }
        session.stage = 'reading'; session.seq++; save(); await answer(cq, '重新解籤中 🙏'); await stripButtons(chat.id, cq.message?.message_id);
        return { qiuqianRetry: true, completion: scheduleReading(session) };
      }
      if (action === 'f') {
        if (session.stage !== 'done') { await answer(cq, session.stage === 'followupReading' ? '廟公正在回覆，請稍候…' : '現在還不能追問'); return { invalid: true }; }
        session.stage = 'followup'; session.seq++; save();
        await answer(cq, '請寫下想問廟公的問題'); await stripButtons(chat.id, cq.message?.message_id);
        const group = inGroup(chat); const text = qiuqianFollowupAskText(session, group);
        const p = await send(text, { reply_markup: { force_reply: true, selective: group, input_field_placeholder: '想問廟公什麼…' }, ...mention(cq.from, text, group) }, chat.id);
        session.promptId = p?.message_id ?? null; if (session.promptId != null) prompts.set(flowKey(chat.id, session.promptId), session.id); save();
        return { qiuqianFollowupAsk: true };
      }
      if (action === 'x') {
        const afterReading = FOLLOWUP_STAGES.includes(session.stage);
        sessions.delete(session.id); for (const [k, id] of prompts) if (id === session.id) prompts.delete(k); save();
        await answer(cq); await stripButtons(chat.id, cq.message?.message_id);
        let menu = null; try { menu = menuMarkup(chat.id) || null; } catch { /* no keyboard */ } // 追問 force-reply prompts hid the 下方按鈕; this goodbye brings it back
        await send(afterReading ? QQ_FOLLOWUP_END : '好的，改日再來。心誠則靈，菩薩保佑 🙏', menu ? { reply_markup: menu } : {}, chat.id);
        return { qiuqianEnded: true };
      }
      await answer(cq); return { ignored: 'qiuqian action' };
    } finally { busy.delete(session.id); }
  }

  /** Returns null when the message is not part of a 求籤 flow. */
  async function onMessage(msg, text) {
    if (mode === 'operations') return null;
    const rt = msg.reply_to_message; const key = rt ? flowKey(msg.chat.id, rt.message_id) : null;
    const sid = key != null ? prompts.get(key) : null;
    let session = sid ? sessions.get(sid) : null;
    const reply = (t, extra = {}) => send(t, { reply_to_message_id: msg.message_id, allow_sending_without_reply: true, ...extra }, msg.chat.id);
    if (sid && !session) { prompts.delete(key); save(); await reply('這次求籤已結束，請重新按「🙏 觀音求籤」。'); return { expired: true }; }
    if (!sid && key != null && ended.has(key)) {
      const e = ended.get(key); if (String(e.userId) !== String(msg.from.id)) return { ignored: 'not qiuqian owner' };
      ended.delete(key); await reply(e.followup ? QQ_FOLLOWUP_EXPIRED : '這次求籤已過期，請重新按「🙏 觀音求籤」。'); return { expired: true };
    }
    if (!session && inUserPrivate(msg.chat, msg.from) && text && !text.startsWith('/'))
      session = [...sessions.values()].find((s) => (s.stage === 'question' || s.stage === 'followup') && String(s.chatId) === String(msg.chat.id) && String(s.userId) === String(msg.from.id)) || null;
    if (!session) return null;
    if (String(session.userId) !== String(msg.from.id)) return { ignored: 'not qiuqian owner' };
    if (expired(session)) { const after = FOLLOWUP_STAGES.includes(session.stage); sessions.delete(session.id); if (key != null) prompts.delete(key); save(); await reply(after ? QQ_FOLLOWUP_EXPIRED : '這次求籤已過期，請重新按「🙏 觀音求籤」。'); return { expired: true }; }
    if (session.stage === 'followup') {
      if (!text) { await reply('請用文字寫下想問廟公的問題 🙏'); return { ignored: 'empty qiuqian followup' }; }
      session.followups = [...(session.followups || []), { q: text.slice(0, 500), a: null, at: now() }].slice(-10);
      session.followupMsgId = msg.message_id; session.stage = 'followupReading'; session.seq++; session.updatedAt = now();
      for (const [k, id] of prompts) if (id === session.id) prompts.delete(k);
      save();
      return { qiuqianFollowup: true, sessionId: session.id, completion: scheduleReading(session, 'followup') };
    }
    if (session.stage === 'followupReading') { await reply('廟公正在回覆上一個問題，請稍候 🙏'); return { busy: true }; }
    if (session.stage !== 'question') { await reply('問題已記下，請按最新訊息上的按鈕繼續 🙏'); return { ignored: 'qiuqian stage' }; }
    if (!text) { await reply('請用文字寫下想請示的事 🙏'); return { ignored: 'empty qiuqian question' }; }
    session.question = text.slice(0, 300); session.stage = 'asking'; session.seq++; session.updatedAt = now();
    for (const [k, id] of prompts) if (id === session.id) prompts.delete(k);
    const m = await reply(qiuqianAskText(session), markup(qiuqianAskKeyboard(session)));
    session.messageId = m?.message_id ?? null; save();
    return { qiuqianQuestion: true, sessionId: session.id };
  }

  async function finishReading(session) {
    if (readingPending.has(session.id)) return { busy: true };
    readingPending.add(session.id);
    try {
      const sign = getSign(session.pick);
      if (!sign) throw new Error('找不到籤詩資料');
      if (!session.signMessageId) {
        const m = await send(qiuqianSignText(sign), { reply_to_message_id: session.messageId, allow_sending_without_reply: true }, session.chatId);
        session.signMessageId = m?.message_id ?? null; save();
      }
      if (typeof interpreter !== 'function') throw new Error('解籤服務目前未啟用');
      const raw = await interpreter(buildQiuqianPrompt(session, sign), session);
      const reading = typeof raw === 'string' ? raw.trim() : String(raw?.text ?? '').trim();
      if (!reading) throw new Error('小精靈沒有回傳解籤內容');
      session.reading = reading.slice(0, 4000); session.followups = []; session.stage = 'done'; session.seq++; session.updatedAt = now(); save();
      const chunks = splitText(`🙏 小精靈解籤｜第 ${sign.number} 籤（${sign.grade}）\n\n${reading}`);
      for (const [i, chunk] of chunks.entries()) await send(chunk, { ...(i === 0 ? { reply_to_message_id: session.signMessageId, allow_sending_without_reply: true } : {}), ...(i === chunks.length - 1 ? markup(qiuqianFollowupKeyboard(session)) : {}) }, session.chatId);
      await refreshKeyboard(session.chatId).catch((error) => log.warn(`qiuqian keyboard refresh failed: ${error.message}`));
      return { qiuqianDone: true };
    } catch (error) {
      session.stage = 'error'; session.seq++; session.updatedAt = now(); save(); log.warn(`qiuqian reading failed: ${error.message}`);
      const head = session.signMessageId ? '⚠️ 籤詩如上，但小精靈暫時無法完成白話解籤。' : '⚠️ 小精靈暫時無法取出籤詩與解籤。';
      try { await send(`${head}\n可以稍後按「重新解籤」再試一次 🙏`, { reply_to_message_id: session.signMessageId || session.messageId, allow_sending_without_reply: true, ...markup(qiuqianRetryKeyboard(session)) }, session.chatId); }
      catch (sendError) { log.warn(`qiuqian failure notice failed: ${sendError.message}`); }
      return { qiuqianFailed: true };
    } finally { readingPending.delete(session.id); }
  }
  /** Follow-up question about the same 籤 → 廟公 answer with the same two buttons (keep asking / end). */
  async function finishFollowup(session) {
    const item = (session.followups || []).at(-1); const sign = getSign(session.pick);
    const replyTo = { reply_to_message_id: session.followupMsgId, allow_sending_without_reply: true };
    try {
      if (!sign || !item) throw new Error('找不到這支籤或追問內容');
      if (typeof interpreter !== 'function') throw new Error('解籤服務目前未啟用');
      const raw = await interpreter(buildQiuqianFollowupPrompt(session, sign, item.q), session);
      const ans = typeof raw === 'string' ? raw.trim() : String(raw?.text ?? '').trim();
      if (!ans) throw new Error('廟公沒有回傳內容');
      item.a = ans.slice(0, 2000); session.stage = 'done'; session.seq++; session.updatedAt = now(); save();
      const chunks = splitText(`🧓 廟公回覆｜第 ${sign.number} 籤\n\n${ans}`);
      for (const [i, chunk] of chunks.entries()) await send(chunk, { ...(i === 0 ? replyTo : {}), ...(i === chunks.length - 1 ? markup(qiuqianFollowupKeyboard(session)) : {}) }, session.chatId);
      return { qiuqianFollowupDone: true };
    } catch (error) {
      session.stage = 'done'; session.seq++; session.updatedAt = now(); save(); log.warn(`qiuqian follow-up failed: ${error.message}`);
      try { await send(`⚠️ 廟公暫時無法回覆，請稍後再按「${QQ_FOLLOWUP_LABEL}」問一次 🙏`, { ...replyTo, ...markup(qiuqianFollowupKeyboard(session)) }, session.chatId); }
      catch (sendError) { log.warn(`qiuqian follow-up notice failed: ${sendError.message}`); }
      return { qiuqianFollowupFailed: true };
    }
  }
  function scheduleReading(session, kind = 'reading') {
    if (jobs.has(session.id)) return jobs.get(session.id);
    let resolve; const completion = new Promise((r) => { resolve = r; });
    jobs.set(session.id, completion); queue.push({ session, resolve, kind }); pump();
    return completion;
  }
  function pump() {
    while (active < maxConcurrent && queue.length) {
      const { session, resolve, kind } = queue.shift(); active++;
      setImmediate(() => { void (kind === 'followup' ? finishFollowup(session) : finishReading(session)).then(resolve, (error) => { log.warn(`qiuqian background reading failed: ${error.message}`); resolve({ qiuqianFailed: true }); })
        .finally(() => { active--; jobs.delete(session.id); pump(); }); });
    }
  }

  return {
    start, onCallback, onMessage,
    prune() {
    let changed = false; const t0 = now();
    for (const [k, e] of ended) if (t0 - e.at > 86400000) ended.delete(k);
    for (const [id, s] of sessions) if (expired(s)) { for (const [k, pid] of prompts) if (pid === id) ended.set(k, { userId: s.userId, followup: FOLLOWUP_STAGES.includes(s.stage), at: t0 }); sessions.delete(id); changed = true; }
    while (ended.size > 500) ended.delete(ended.keys().next().value);
    for (const [k, id] of prompts) if (!sessions.has(id)) { prompts.delete(k); changed = true; } if (changed) save(); },
    recover() { return Promise.all([...sessions.values()].filter((s) => (s.stage === 'reading' || s.stage === 'followupReading') && !expired(s)).map((s) => scheduleReading(s, s.stage === 'followupReading' ? 'followup' : 'reading'))); },
    session: (id) => sessions.get(String(id)) || null,
  };
}
