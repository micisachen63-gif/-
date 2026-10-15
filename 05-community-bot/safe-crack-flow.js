// 🔐 千鎖秘藏 on 小精靈: thin Telegram adapter over the pure core (src/games/safe-crack.js).
// One game per group, persisted in tgStore.data.safeCrack (survives a restart); timers run from tick() (service interval, ~5 s).
// Guessing (same pattern as 密室逃脫's answer input): the latest round message has 「🔢 輸入密碼」 → a force-reply prompt that mentions the player →
// the player replies 4 digits → a NEW round message (guess + xAyB + remaining seconds + the button again); the previous round message is deleted
// (or loses its buttons), and the prompt / the player's answer are deleted when allowed. Too soon / already won → popup alert on the button.
import fs from 'node:fs';
import path from 'node:path';
import * as SC from './games/safe-crack.js';

export const SC_CALLBACK_RE = /^sc:([a-z])(?::([a-z0-9]{1,16}))?(?::(\d{1,2}))?$/;
const GROUP_ONLY = `🔐 ${SC.SC_NAME}是群組遊戲，請到群組裡輸入 /baoxianxiang 或按選單的「🔐 ${SC.SC_NAME}」開局。`;
const START_TEXTS = new Set([`🔐 ${SC.SC_NAME}`, SC.SC_NAME, '全民破解保險箱', '🔐 保險箱']);

/** /baoxianxiang [輪數] (alias /qiansuo) or the panel / keyboard text → { rounds } | null */
export function parseSafeStart(text, botUsername = '') {
  const t = String(text || '').trim();
  const m = /^\/(?:baoxianxiang|qiansuo)(?:@([A-Za-z0-9_]+))?(?:\s+(\d{1,3}))?\s*$/i.exec(t);
  if (m && (!m[1] || m[1].toLowerCase() === String(botUsername).toLowerCase())) return { rounds: m[2] ? Number(m[2]) : null };
  return START_TEXTS.has(t) ? { rounds: null } : null;
}

export function createSafeCrackFlow({ api, send, answer, log, now = () => Date.now(), tgStore = null, inGroup, inUserPrivate, isAdmin = async () => false, mode = 'all',
  botUsername = () => '', random = Math.random, coverFile = path.resolve(import.meta.dirname, '..', SC.SC_COVER), storyFile = path.resolve(import.meta.dirname, '..', SC.SC_STORY_FILE), readFile = (f) => fs.readFileSync(f), statFile = (f) => fs.statSync(f),
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, ephemeralMs = 6000, autoJoin = true,
  menuMarkup = () => null }) { // menuMarkup(chatId): the chat's persistent reply keyboard (小精靈's 下方按鈕), re-attached to the summary card
  const games = new Map(Object.entries(tgStore?.data.safeCrack?.games || {}));
  const chains = new Map(); let cover; let counter = Math.floor(Math.random() * 1296); // not the injected random: other flows' tests count its calls
  const save = () => { if (!tgStore) return; tgStore.data.safeCrack = { games: Object.fromEntries(games) }; tgStore.save(); };
  const warn = (what, error) => log.warn(`safe-crack ${what}: ${error?.message || error}`);
  const quiet = (error) => /not modified|not found|can't be edited|message to edit/i.test(String(error?.description || error?.message));
  const serial = (key, fn) => { const prev = chains.get(key) || Promise.resolve(); const p = prev.then(fn, fn); const tail = p.catch(() => {}); chains.set(key, tail); tail.then(() => { if (chains.get(key) === tail) chains.delete(key); }); return p; };
  const isHost = (g, user) => String(g.hostId) === String(user?.id);
  const ABORT_CONFIRM_MS = 15e3; const abortAsks = new Map(); // 🛑 during play needs a 2nd tap (a stray tap used to end the whole game)

  function coverImage() {
    if (cover !== undefined) return cover;
    try { cover = { buffer: readFile(coverFile), mimeType: 'image/jpeg', fileName: 'qiansuo-cover.jpg' }; } catch (error) { if (error?.code !== 'ENOENT') warn('cover unreadable', error); cover = null; }
    return cover;
  }
  /** photo card with the cover (text fallback) → { id, photo } */
  async function card(chatId, text, keyboard = [], markup = null) {
    const img = coverImage();
    if (img && typeof api.sendPhoto === 'function' && text.length <= 1024) {
      try { const m = await api.sendPhoto({ chatId, ...img, caption: text, replyMarkup: keyboard.length ? { inline_keyboard: keyboard } : (markup || undefined) }); return { id: m?.message_id ?? null, photo: true }; }
      catch (error) { warn('cover photo failed, sending text', error); }
    }
    const m = await send(text, keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : markup ? { reply_markup: markup } : {}, chatId);
    return { id: m?.message_id ?? null, photo: false };
  }
  async function edit(chatId, messageId, photo, text, keyboard = []) {
    if (messageId == null) return;
    const body = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } };
    try { await api.call(photo ? 'editMessageCaption' : 'editMessageText', photo ? { ...body, caption: text.slice(0, 1024) } : { ...body, text: text.slice(0, 4096) }); }
    catch (error) { if (!quiet(error)) warn('edit failed', error); }
  }
  async function del(g, messageId) {
    if (messageId == null || g?.noDelete) return false;
    try { await api.call('deleteMessage', { chat_id: g.chatId, message_id: messageId }); return true; }
    catch (error) {
      if (/rights|can't be deleted|admin|forbidden/i.test(String(error?.description || error?.message))) { g.noDelete = true; save(); log.info('safe-crack: bot cannot delete guesses here (not admin); guesses stay in the chat'); }
      return false;
    }
  }
  async function ephemeral(g, text, replyTo) {
    try {
      const m = await send(text, replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}, g.chatId);
      if (m?.message_id != null) schedule(() => { api.call('deleteMessage', { chat_id: g.chatId, message_id: m.message_id }).catch(() => {}); }, ephemeralMs);
    } catch (error) { warn('notice failed', error); }
  }

  // ---------- lobby ----------
  let storyCache = null;
  function story() {
    try { const st = statFile(storyFile); const sig = `${st.mtimeMs}:${st.size}`; if (storyCache?.sig !== sig) storyCache = { sig, text: String(readFile(storyFile)).replace(/^\uFEFF/, '') }; return storyCache.text; }
    catch (error) { if (error?.code !== 'ENOENT') warn('story unreadable', error); return SC.SC_STORY; }
  }
  const lobby = (g) => SC.lobbyText(g, now(), { story: story() });
  const refreshLobby = (g) => { g.shownLobby = lobby(g); return edit(g.chatId, g.lobbyMsgId, g.lobbyPhoto, g.shownLobby, SC.lobbyKeyboard(g)); };
  async function open(user, chat, rounds) {
    if (mode === 'operations') return { ignored: 'life feature' };
    if (inUserPrivate(chat, user)) { await send(GROUP_ONLY, {}, chat.id); return { safeGroupOnly: true }; }
    if (!inGroup(chat)) return null;
    return serial(String(chat.id), async () => {
      const existing = games.get(String(chat.id));
      if (existing && existing.stage !== 'ended') {
        const ref = existing.stage === 'lobby' ? existing.lobbyMsgId : existing.current?.msgId;
        await send(existing.stage === 'lobby' ? `🔐 ${SC.SC_NAME}正在招募，按上面的「🙋 我要參加」加入吧！` : `🔐 這個群組已經有一局${SC.SC_NAME}在進行，等這局結束再開新局喔。`,
          ref ? { reply_to_message_id: ref, allow_sending_without_reply: true } : {}, chat.id);
        return { safeBusy: existing.id };
      }
      const t = now(); const id = `${t.toString(36)}${(++counter).toString(36)}`.slice(-16);
      const g = SC.newGame({ id, chatId: chat.id, host: user, rounds: rounds ?? SC.SC_DEFAULT_ROUNDS, now: t });
      games.set(String(chat.id), g); save();
      const text = lobby(g); const m = await card(chat.id, text, SC.lobbyKeyboard(g));
      g.lobbyMsgId = m.id; g.lobbyPhoto = m.photo; g.shownLobby = text; save();
      log.info(`safe-crack lobby opened ${id} by user ${user.id} (${g.rounds} rounds)`);
      return { safeLobby: id };
    });
  }
  async function cancelLobby(g, why) {
    SC.abort(g, now()); games.delete(String(g.chatId)); save();
    await edit(g.chatId, g.lobbyMsgId, g.lobbyPhoto, SC.lobbyCancelledText(g, why), []);
    log.info(`safe-crack lobby ${g.id} cancelled`);
    return { safeCancelled: g.id };
  }
  async function begin(g, auto = false) {
    if (!SC.startGame(g, now(), random)) return { invalid: true };
    save();
    await edit(g.chatId, g.lobbyMsgId, g.lobbyPhoto, SC.lobbyClosedText(g, auto), []);
    await postRound(g);
    log.info(`safe-crack ${g.id} started: ${g.rounds} rounds, ${g.players.length} players`);
    return { safeStarted: g.id };
  }

  // ---------- rounds ----------
  const roundView = (g) => SC.roundText(g, now(), { last: g.current?.last || null });
  /** send a fresh round message (with 🔢) and retire the previous one: delete it, or at least strip its buttons.
   *  A failed send never throws: the previous message keeps its buttons (refreshed), or — for a new lock — msgId stays null and tick() re-posts within ~5 s. */
  async function postRound(g) {
    const c = g.current; const previous = c.msgId;
    let m = null;
    try { m = await send(roundView(g), { reply_markup: { inline_keyboard: SC.roundKeyboard(g) } }, g.chatId); }
    catch (error) { warn(`round message (lock ${c.no}) failed, will retry`, error); }
    if (m?.message_id == null) { if (previous != null) await renderRound(g); return false; }
    c.msgId = m.message_id; c.shownMinute = Math.ceil((c.deadline - now()) / 60e3); save();
    if (previous != null && previous !== c.msgId) {
      try { await api.call('deleteMessage', { chat_id: g.chatId, message_id: previous }); }
      catch { try { await api.call('editMessageReplyMarkup', { chat_id: g.chatId, message_id: previous, reply_markup: { inline_keyboard: [] } }); } catch { /* gone */ } }
    }
    return true;
  }
  const renderRound = (g) => edit(g.chatId, g.current?.msgId, false, roundView(g), SC.roundKeyboard(g));
  async function dropPrompts(g, c = g.current) {
    for (const id of Object.keys(c?.prompts || {})) { try { await api.call('deleteMessage', { chat_id: g.chatId, message_id: Number(id) }); } catch { /* gone */ } }
    if (c) c.prompts = {};
  }
  async function afterClose(g, record, closed) {
    await dropPrompts(g, closed);
    await edit(g.chatId, record.msgId, false, SC.roundClosedText(g, record), []);
    if (record.how !== 'aborted') await send(record.cracked ? SC.crackedAnnounce(g, record) : SC.timeoutAnnounce(g, record), {}, g.chatId);
    save();
    if (g.stage !== 'playing') return finishGame(g);
    const step = SC.advance(g, now(), random); save();
    if (step.round) { await postRound(g); return { safeRound: g.round, closed: record.no, cracked: record.cracked }; }
    return finishGame(g);
  }
  async function finishGame(g) {
    games.delete(String(g.chatId)); save();
    // the 🔢 force-reply prompts replace the players' reply keyboard; the summary card (sent anyway) brings it back — no extra message
    let kb = null; try { kb = menuMarkup(g.chatId) || null; } catch (error) { warn('menu keyboard unavailable', error); }
    await card(g.chatId, SC.summaryText(g), [], kb);
    log.info(`safe-crack ${g.id} ended (${g.endReason}): ${SC.crackedRounds(g).length}/${g.history.length} cracked`);
    return { safeEnded: g.endReason, cracked: SC.crackedRounds(g).map((r) => ({ no: r.no, winner: r.winnerName })) };
  }
  /** force-reply prompt that @mentions the player (selective: only their keyboard pops up) */
  async function prompt(g, user, error = null) {
    const c = g.current; const name = SC.userName(user); const text = SC.promptText(g, name, now(), error);
    const offset = text.indexOf(`🔢 ${name}`) + 3;
    const m = await send(text, { entities: [{ type: 'text_mention', offset, length: name.length, user: { id: user.id, is_bot: false, first_name: user.first_name || name } }],
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: `${SC.SC_CODE_LEN} 位數字，例如 0123` } }, g.chatId);
    if (m?.message_id != null) { c.prompts = { ...(c.prompts || {}), [m.message_id]: { userId: user.id, at: now() } }; save(); }
    return m;
  }
  const alert = (cq, text) => api.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: true }).catch((error) => warn('alert failed', error));

  // ---------- inbound ----------
  async function onMessage(msg, text) {
    const start = parseSafeStart(text, botUsername());
    if (start) return open(msg.from, msg.chat, start.rounds);
    if (mode === 'operations' || !inGroup(msg.chat) || !msg.from || msg.from.is_bot) return null;
    const g0 = games.get(String(msg.chat.id)); const rt = msg.reply_to_message?.message_id;
    if (!g0 || g0.stage !== 'playing' || rt == null || !g0.current?.prompts?.[rt]) return null;
    return serial(String(msg.chat.id), async () => {
      const g = games.get(String(msg.chat.id)); const c = g?.current; const p = c?.prompts?.[rt];
      if (!g || g.id !== g0.id || g.stage !== 'playing' || !p) return { stale: true };
      if (String(p.userId) !== String(msg.from.id)) return { ignored: 'not prompt owner' };
      const closed = c; const late = SC.checkTimeout(g, now());
      if (late) { await del(g, msg.message_id); save(); return { safeLate: true, ...(await afterClose(g, late, closed)) }; }
      const r = SC.submitGuess(g, msg.from, text, now(), { autoJoin, strict: true });
      if (!r) return null;
      const cleanup = async () => { delete c.prompts[rt]; save(); try { await api.call('deleteMessage', { chat_id: g.chatId, message_id: rt }); } catch { /* gone */ } await del(g, msg.message_id); };
      switch (r.kind) {
        case 'invalid': await cleanup(); await prompt(g, msg.from, r.error); break;
        case 'cooldown': await cleanup(); await ephemeral(g, `${r.player.name}：${SC.cooldownText(r.waitMs)}`); break;
        case 'lockedOut': case 'dailyLockedOut': case 'notPlayer': await cleanup(); await ephemeral(g, `${SC.userName(msg.from)}：${r.kind === 'notPlayer' ? SC.notPlayerText() : SC.lockedText(r.kind === 'dailyLockedOut')}`); break;
        case 'scored': c.last = r.entry; await cleanup(); await postRound(g); break;
        case 'cracked': await cleanup(); return { safeGuess: 'cracked', ...(await afterClose(g, r.record, closed)) };
        default: break;
      }
      return { safeGuess: r.kind, ...(r.entry ? { ab: SC.abText(r.entry) } : {}), ...(r.error ? { error: r.error } : {}) };
    });
  }

  async function onCallback(cq, action, gid, arg) {
    const chat = cq.message?.chat;
    if (mode === 'operations') { await answer(cq, `${SC.SC_NAME}請找小精靈。`); return { denied: true }; }
    if (action === 'n') {
      if (inUserPrivate(chat, cq.from)) { await answer(cq, '這是群組遊戲'); await send(GROUP_ONLY, {}, chat.id); return { safeGroupOnly: true }; }
      if (!inGroup(chat)) { await answer(cq); return { ignored: 'chat' }; }
      await answer(cq); return open(cq.from, chat, null);
    }
    if (!inGroup(chat)) { await answer(cq); return { ignored: 'chat' }; }
    return serial(String(chat.id), async () => {
      const g = games.get(String(chat.id));
      if (!g || g.id !== gid || g.stage === 'ended') {
        await answer(cq, '這局已經結束了');
        try { await api.call('editMessageReplyMarkup', { chat_id: chat.id, message_id: cq.message?.message_id, reply_markup: { inline_keyboard: [] } }); } catch { /* gone */ }
        return { stale: true };
      }
      if (action === 'x') {
        if (!isHost(g, cq.from) && !(await isAdmin(cq.from))) { await answer(cq, '只有發起人或管理員可以中止'); return { denied: true }; }
        if (g.stage === 'lobby') { await answer(cq, '已中止'); return cancelLobby(g, `${SC.userName(cq.from)} 取消了這局`); }
        if (g.lobbyMsgId != null && String(cq.message?.message_id) === String(g.lobbyMsgId)) { // stale 🛑 取消 on the closed signup card
          await answer(cq, '報名已截止，遊戲進行中；要中止請按題目訊息上的「🛑 中止遊戲」');
          try { await api.call('editMessageReplyMarkup', { chat_id: chat.id, message_id: g.lobbyMsgId, reply_markup: { inline_keyboard: [] } }); } catch { /* gone */ }
          return { stale: 'lobby' };
        }
        const ask = abortAsks.get(g.id); const t = now();
        if (!ask || String(ask.userId) !== String(cq.from.id) || t - ask.at > ABORT_CONFIRM_MS) {
          abortAsks.set(g.id, { userId: cq.from.id, at: t });
          await alert(cq, `⚠️ 確定要中止整局${SC.SC_NAME}嗎？${ABORT_CONFIRM_MS / 1000} 秒內再按一次「🛑 中止遊戲」才會中止。`);
          return { safeAbortConfirm: true };
        }
        abortAsks.delete(g.id); await answer(cq, '已中止');
        const closed = g.current; const record = SC.abort(g, now()); save();
        if (record) await afterClose(g, record, closed); else await finishGame(g);
        return { safeAborted: g.id };
      }
      if (action === 'g') {
        if (g.stage !== 'playing' || !g.current) { await answer(cq, '遊戲還沒開始喔'); return { invalid: true }; }
        const closed = g.current; const late = SC.checkTimeout(g, now());
        if (late) { await answer(cq, '💥 寶箱已自毀'); save(); return afterClose(g, late, closed); }
        const r = SC.canGuess(g, cq.from, now(), { autoJoin });
        if (r.kind === 'cooldown') { await alert(cq, SC.cooldownText(r.waitMs)); return { safeCooldown: Math.ceil(r.waitMs / 1000) }; }
        if (r.kind === 'lockedOut' || r.kind === 'dailyLockedOut') { await alert(cq, SC.lockedText(r.kind === 'dailyLockedOut')); return { safeLockedOut: true }; }
        if (!r.ok) { await alert(cq, SC.notPlayerText()); return { safeNotPlayer: true }; }
        if (r.joined) save();
        for (const [id, p] of Object.entries(g.current.prompts || {})) if (String(p.userId) === String(cq.from.id)) { delete g.current.prompts[id]; try { await api.call('deleteMessage', { chat_id: g.chatId, message_id: Number(id) }); } catch { /* gone */ } }
        await answer(cq, `回覆小精靈的提示，輸入 ${SC.SC_CODE_LEN} 位數字`);
        const m = await prompt(g, cq.from);
        return { safePrompt: m?.message_id ?? null, joined: r.joined };
      }
      if (g.stage !== 'lobby') { await answer(cq, '遊戲進行中，按「🔢 輸入密碼」就能猜！'); return { invalid: true }; }
      if (action === 'j') {
        const r = SC.addPlayer(g, cq.from, now());
        if (r.already) { await answer(cq, '你已經報名了 🔐'); return { safeAlreadyJoined: true }; }
        if (r.full) { await answer(cq, '人數已滿'); return { safeFull: true }; }
        save(); await answer(cq, `報名成功！目前 ${g.players.length} 人`); await refreshLobby(g); return { safeJoined: g.players.length };
      }
      if (action === 'l') {
        const r = SC.removePlayer(g, cq.from.id);
        if (r.host) { await answer(cq, '發起人要離開請按「🛑 取消」'); return { denied: true }; }
        if (r.notJoined) { await answer(cq, '你還沒報名喔'); return { ignored: true }; }
        save(); await answer(cq, '已退出，下次再來破鎖！'); await refreshLobby(g); return { safeLeft: true };
      }
      if (!isHost(g, cq.from)) { await answer(cq, '只有發起人可以設定輪數、開始遊戲'); return { denied: true }; }
      if (action === 'r') { SC.setRounds(g, Number(arg)); save(); await answer(cq, `本局 ${g.rounds} 輪`); await refreshLobby(g); return { safeRounds: g.rounds }; }
      if (action === 's') { await answer(cq, '寶匣甦醒了！'); return begin(g); }
      await answer(cq); return { ignored: 'safe action' };
    });
  }

  /** lobby countdown / auto start / 流局, 10-min round timeout, per-minute refresh of the round message. Also catches up after a restart. */
  async function tick() {
    const out = [];
    for (const [key, g0] of [...games.entries()]) {
      try {
        out.push(await serial(key, async () => {
          const g = games.get(key); if (!g || g.id !== g0.id) return null; const t = now();
          if (g.stage === 'ended') { games.delete(key); save(); return null; }
          if (g.stage === 'lobby') {
            if (t >= g.createdAt + SC.SC_LOBBY_MS) return g.players.length > 1 ? begin(g, true) : cancelLobby(g);
            if (lobby(g) !== g.shownLobby) await refreshLobby(g);
            return null;
          }
          if (!g.current) { const step = SC.advance(g, t, random); save(); if (step.round) { await postRound(g); return { safeRound: g.round }; } return finishGame(g); }
          const closed = g.current; const record = SC.checkTimeout(g, t);
          if (record) { save(); return afterClose(g, record, closed); }
          if (g.current.msgId == null) { await postRound(g); return null; }
          const minute = Math.ceil((g.current.deadline - t) / 60e3);
          if (minute !== g.current.shownMinute) { g.current.shownMinute = minute; save(); await renderRound(g); }
          return null;
        }));
      } catch (error) { warn('tick failed', error); }
    }
    return out.filter(Boolean);
  }

  return { open, onMessage, onCallback, tick, recover: () => tick(), game: (chatId) => games.get(String(chatId)) || null };
}
