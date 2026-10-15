// 🔐 千鎖秘藏 社群版 (小遊戲精靈): community adapter over the pure core (src/games/safe-crack.js, shared with 小精靈 — unchanged).
// The admin opens it from the DM setup (bot.js); players sign up with 🎟 報名 (AID + conditions, checked by bot.js) and only signed-up players may guess.
// Lobby = cover photo + story + this round's conditions / prize (community.lobbyNote). Gameplay is the 小精靈 one: the latest round message carries
// 「🔢 輸入密碼」 → force-reply prompt → the player replies 4 digits → a NEW round message (xAyB + remaining seconds + the button again); 15 s per player,
// 10 minutes per lock (自毀), winners sit out the later locks (and, through the daily ledger, the rest of the Taipei day).
// State (games + ledger) lives in tgStore.data.safeCrack (the group's own store) and survives a restart; timers run from tick().
import fs from 'node:fs';
import path from 'node:path';
import * as SC from '../../games/safe-crack.js';

export const SCC_CALLBACK_RE = /^sc:([a-z])(?::([a-z0-9]{1,16}))?(?::(\d{1,2}))?$/;
export const SCC_LOBBY_MS = 30 * 60e3; // community lobby: auto start after 30 min (2026-10-06, was 10) (at least 1 player), else 流局
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CAPTION_MAX = 1024;

export function createCommunitySafeCrackFlow({ api, send, answer, log, now = () => Date.now(), tgStore = null, inGroup, random = Math.random, community,
  coverFile = path.join(ROOT, SC.SC_COVER), storyFile = path.join(ROOT, SC.SC_STORY_FILE), readFile = (f) => fs.readFileSync(f), statFile = (f) => fs.statSync(f),
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, ephemeralMs = 6000 }) {
  const MAXP = community?.maxPlayers || SC.SC_MAX_PLAYERS;
  const saved = tgStore?.data.safeCrack || {};
  const games = new Map(Object.entries(saved.games || {}));
  const ledger = saved.ledger || SC.createLedger(); // round winners of the current Taipei day (resets at midnight)
  const chains = new Map(); let cover; let counter = Math.floor(Math.random() * 1296);
  const save = () => { if (!tgStore) return; tgStore.data.safeCrack = { games: Object.fromEntries(games), ledger }; tgStore.save(); };
  const warn = (what, error) => log.warn(`safe-crack(community) ${what}: ${error?.message || error}`);
  const quiet = (error) => /not modified|not found|can't be edited|message to edit/i.test(String(error?.description || error?.message));
  const serial = (key, fn) => { const prev = chains.get(key) || Promise.resolve(); const p = prev.then(fn, fn); const tail = p.catch(() => {}); chains.set(key, tail); tail.then(() => { if (chains.get(key) === tail) chains.delete(key); }); return p; };
  const ended = async (g, summary) => { if (!community?.onEnd || g.endReported) return; g.endReported = true; save(); try { await community.onEnd(g, summary); } catch (error) { warn('community end hook failed', error); } };
  const opts = () => ({ ledger, now: now() });

  function coverImage() {
    if (cover !== undefined) return cover;
    try { cover = { buffer: readFile(coverFile), mimeType: 'image/jpeg', fileName: 'qiansuo-cover.jpg' }; } catch (error) { if (error?.code !== 'ENOENT') warn('cover unreadable', error); cover = null; }
    return cover;
  }
  async function card(chatId, text, keyboard = []) {
    const img = coverImage();
    if (img && typeof api.sendPhoto === 'function' && text.length <= CAPTION_MAX) {
      try { const m = await api.sendPhoto({ chatId, ...img, caption: text, replyMarkup: keyboard.length ? { inline_keyboard: keyboard } : undefined }); return { id: m?.message_id ?? null, photo: true }; }
      catch (error) { warn('cover photo failed, sending text', error); }
    }
    const m = await send(text, keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}, chatId);
    return { id: m?.message_id ?? null, photo: false };
  }
  async function edit(chatId, messageId, photo, text, keyboard = []) {
    if (messageId == null) return;
    const body = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } };
    try { await api.call(photo ? 'editMessageCaption' : 'editMessageText', photo ? { ...body, caption: text.slice(0, CAPTION_MAX) } : { ...body, text: text.slice(0, 4096) }); }
    catch (error) { if (!quiet(error)) warn('edit failed', error); }
  }
  const tryDelete = async (g, messageId) => { if (messageId == null) return false; try { await api.call('deleteMessage', { chat_id: g.chatId, message_id: messageId }); return true; } catch { return false; } };
  async function delGuess(g, messageId) {
    if (messageId == null || g?.noDelete) return false;
    try { await api.call('deleteMessage', { chat_id: g.chatId, message_id: messageId }); return true; }
    catch (error) {
      if (/rights|can't be deleted|admin|forbidden/i.test(String(error?.description || error?.message))) { g.noDelete = true; save(); log.info('safe-crack(community): bot cannot delete guesses here (not admin)'); }
      return false;
    }
  }
  async function ephemeral(g, text) {
    try { const m = await send(text, {}, g.chatId); if (m?.message_id != null) schedule(() => { api.call('deleteMessage', { chat_id: g.chatId, message_id: m.message_id }).catch(() => {}); }, ephemeralMs); }
    catch (error) { warn('notice failed', error); }
  }

  // ---------- lobby ----------
  let storyCache = null;
  function story() {
    try { const st = statFile(storyFile); const sig = `${st.mtimeMs}:${st.size}`; if (storyCache?.sig !== sig) storyCache = { sig, text: String(readFile(storyFile)).replace(/^\uFEFF/, '') }; return storyCache.text; }
    catch (error) { if (error?.code !== 'ENOENT') warn('story unreadable', error); return SC.SC_STORY; }
  }
  /** cover caption: story + 本輪條件／獎金 (shared intro) + roster; the roster shrinks first to stay within 1024 chars */
  function lobbyText(g) {
    const left = Math.max(1, Math.ceil((g.createdAt + SCC_LOBBY_MS - now()) / 60e3));
    const note = community?.lobbyNote?.(g) || '';
    const how = `🔐 本場共 ${g.rounds} 道鎖，每道鎖 ${SC.SC_ROUND_MS / 60e3} 分鐘｜開局後按「🔢 輸入密碼」回覆 ${SC.SC_CODE_LEN} 位數字，每人 ${SC.SC_COOLDOWN_MS / 1000} 秒一次；破解過的人之後的鎖不能再猜`;
    const foot = `⏳ ${left} 分鐘後自動開始（至少 1 人）；按「🎟 報名」報名，第一次會請你到私訊綁定遊戲 AID。`;
    const build = (roster) => [SC.storyText(g, story()), note, how, `👥 報名（${g.players.length}/${MAXP}）：${roster}`, foot].filter(Boolean).join('\n\n');
    const names = g.players.map((p) => p.name);
    for (let n = names.length; n >= 0; n--) {
      const text = build(!names.length ? '還沒有人報名' : n === names.length ? names.join('、') : `${names.slice(0, n).join('、')}${n ? '…' : ''}等 ${names.length} 人`);
      if (text.length <= CAPTION_MAX) return text;
    }
    return build('').slice(0, CAPTION_MAX);
  }
  const refreshLobby = (g) => { g.shownLobby = lobbyText(g); return edit(g.chatId, g.lobbyMsgId, g.lobbyPhoto, g.shownLobby, community.keyboard(g)); };

  async function openCommunity(chat, round, { rounds = SC.SC_DEFAULT_ROUNDS } = {}) {
    return serial(String(chat.id), async () => {
      const cur = games.get(String(chat.id)); if (cur && cur.stage !== 'ended') return { busy: true };
      const t = now(); const id = `${t.toString(36)}${(++counter).toString(36)}`.slice(-16);
      const g = SC.newGame({ id, chatId: chat.id, host: { id: 0, first_name: '小遊戲精靈' }, rounds, now: t });
      Object.assign(g, { players: [], hostId: null, hostName: null, community: true, roundId: round?.id || null });
      games.set(String(chat.id), g); save();
      const text = lobbyText(g); const m = await card(chat.id, text, community.keyboard(g));
      g.lobbyMsgId = m.id; g.lobbyPhoto = m.photo; g.shownLobby = text; save();
      log.info(`safe-crack community lobby opened ${id} (${g.rounds} locks, round ${g.roundId})`);
      return { opened: true, gameId: id };
    });
  }
  const joinCommunity = (chatId, user, meta = null) => serial(String(chatId), async () => {
    const g = games.get(String(chatId));
    if (!g || g.stage !== 'lobby') return { ok: false, text: '這局已經開始或結束了，下一局早點報名喔 🔐' };
    if (SC.playerOf(g, user.id)) return { ok: true, already: true, text: '你已經報名了 🔐' };
    if (g.players.length >= MAXP) return { ok: false, text: `已額滿（最多 ${MAXP} 人）` };
    const r = SC.addPlayer(g, user, now()); if (!r.joined) return { ok: false, text: '報名失敗' };
    if (meta?.name) r.player.name = String(meta.name).slice(0, 24);
    if (meta) r.player.meta = meta;
    save(); await refreshLobby(g); save();
    return { ok: true, text: `報名成功！目前 ${g.players.length} 人` };
  });
  const leaveCommunity = (chatId, user) => serial(String(chatId), async () => {
    const g = games.get(String(chatId));
    if (!g || g.stage !== 'lobby') return { text: '報名已經截止啦' };
    const r = SC.removePlayer(g, user.id); if (!r.left) return { text: '你還沒報名喔' };
    save(); await refreshLobby(g); save(); return { left: true, text: '已退出報名' };
  });
  async function begin(g, auto = false) {
    if (!SC.startGame(g, now(), random)) return { invalid: true };
    save();
    await edit(g.chatId, g.lobbyMsgId, g.lobbyPhoto, SC.lobbyClosedText(g, auto), []);
    await postRound(g);
    log.info(`safe-crack community ${g.id} started: ${g.rounds} locks, ${g.players.length} players`);
    return { started: true, gameId: g.id };
  }
  const startCommunity = (chatId) => serial(String(chatId), async () => {
    const g = games.get(String(chatId));
    if (!g || g.stage !== 'lobby') return { text: '這局不在報名階段' };
    if (!g.players.length) return { tooFew: true, text: '還沒有玩家報名喔' };
    const r = await begin(g); return { ...r, text: r.started ? '寶匣甦醒了！' : '目前無法開始' };
  });
  async function cancelLobby(g) {
    SC.abort(g, now()); games.delete(String(g.chatId)); save();
    await edit(g.chatId, g.lobbyMsgId, g.lobbyPhoto, `🌫 ${SC.SC_NAME}流局\n報名時間到了，還沒有人報名，寶箱又沉回了地底 🔐`, []);
    log.info(`safe-crack community lobby ${g.id} cancelled (nobody joined)`);
    await ended(g, { status: 'cancelled', reason: '沒有人報名' });
    return { cancelled: true, gameId: g.id };
  }
  const abortCommunity = (chatId, reason = '管理員臨時終止了這一局。') => serial(String(chatId), async () => {
    const g = games.get(String(chatId)); if (!g || g.stage === 'ended') return { inactive: true };
    const wasLobby = g.stage === 'lobby'; const closed = g.current; const record = SC.abort(g, now());
    games.delete(String(g.chatId)); save();
    const text = `⛔ ${SC.SC_NAME}已臨時終止\n${reason}\n本局不列入參加紀錄，可以重新報名下一局。`;
    if (wasLobby) await edit(g.chatId, g.lobbyMsgId, g.lobbyPhoto, text, []);
    else {
      if (record) { await dropPrompts(g, closed); await edit(g.chatId, record.msgId, false, SC.roundClosedText(g, record), []); }
      await send(text, {}, g.chatId);
    }
    log.info(`safe-crack community ${g.id} aborted: ${reason}`);
    await ended(g, { status: 'aborted', reason });
    return { aborted: true, gameId: g.id };
  });

  // ---------- rounds ----------
  const roundKeyboard = (g) => [[{ text: '🔢 輸入密碼', callback_data: `sc:g:${g.id}` }], [{ text: '⛔ 臨時終止（管理員）', callback_data: 'mg:x:sc' }]];
  const roundView = (g) => SC.roundText(g, now(), { last: g.current?.last || null, ledger });
  /** a failed send never throws: the previous message keeps its buttons (refreshed), or — for a new lock — msgId stays null and tick() re-posts */
  async function postRound(g) {
    const c = g.current; const previous = c.msgId;
    let m = null;
    try { m = await send(roundView(g), { reply_markup: { inline_keyboard: roundKeyboard(g) } }, g.chatId); }
    catch (error) { warn(`round message (lock ${c.no}) failed, will retry`, error); }
    if (m?.message_id == null) { if (previous != null) await renderRound(g); return false; }
    c.msgId = m.message_id; c.shownMinute = Math.ceil((c.deadline - now()) / 60e3); save();
    if (previous != null && previous !== c.msgId && !(await tryDelete(g, previous))) {
      try { await api.call('editMessageReplyMarkup', { chat_id: g.chatId, message_id: previous, reply_markup: { inline_keyboard: [] } }); } catch { /* gone */ }
    }
    return true;
  }
  const renderRound = (g) => edit(g.chatId, g.current?.msgId, false, roundView(g), roundKeyboard(g));
  async function dropPrompts(g, c = g.current) {
    for (const id of Object.keys(c?.prompts || {})) await tryDelete(g, Number(id));
    if (c) c.prompts = {};
  }
  async function afterClose(g, record, closed) {
    await dropPrompts(g, closed);
    await edit(g.chatId, record.msgId, false, SC.roundClosedText(g, record), []);
    await send(record.cracked ? SC.crackedAnnounce(g, record) : SC.timeoutAnnounce(g, record), {}, g.chatId);
    if (community?.onCrack && record.cracked) {
      try { await community.onCrack(g, record); } catch (e) { warn('community onCrack hook failed', e); }
    }
    save();
    const step = SC.advance(g, now(), random, { ledger }); save();
    if (step.round) { await postRound(g); return { safeRound: g.round, closed: record.no, cracked: record.cracked }; }
    return finishGame(g);
  }
  async function finishGame(g) {
    games.delete(String(g.chatId)); save();
    const cracked = SC.crackedRounds(g);
    log.info(`safe-crack community ${g.id} ended (${g.endReason}): ${cracked.length}/${g.history.length} cracked`);
    await ended(g, { status: 'completed', result: g.endReason, winners: cracked.map((r) => r.winnerId), cracked: cracked.map((r) => ({ no: r.no, winnerId: r.winnerId, code: r.code, ms: r.ms })), locks: g.rounds, played: g.history.length });
    return { safeEnded: g.endReason, cracked: cracked.map((r) => ({ no: r.no, winner: r.winnerName })) };
  }
  async function prompt(g, user, error = null) {
    const c = g.current; const name = SC.userName(user); const text = SC.promptText(g, name, now(), error);
    const offset = text.indexOf(`🔢 ${name}`) + 3;
    const m = await send(text, { entities: [{ type: 'text_mention', offset, length: name.length, user: { id: user.id, is_bot: false, first_name: user.first_name || name } }],
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: `${SC.SC_CODE_LEN} 位數字，例如 0123` } }, g.chatId);
    if (m?.message_id != null) { c.prompts = { ...(c.prompts || {}), [m.message_id]: { userId: user.id, at: now() } }; save(); }
    return m;
  }
  const alert = (cq, text) => answer(cq, text, true);

  // ---------- inbound ----------
  async function onMessage(msg, text) {
    if (!inGroup(msg.chat) || !msg.from || msg.from.is_bot) return null;
    const g0 = games.get(String(msg.chat.id)); const rt = msg.reply_to_message?.message_id;
    if (!g0 || g0.stage !== 'playing' || rt == null || !g0.current?.prompts?.[rt]) return null;
    return serial(String(msg.chat.id), async () => {
      const g = games.get(String(msg.chat.id)); const c = g?.current; const p = c?.prompts?.[rt];
      if (!g || g.id !== g0.id || g.stage !== 'playing' || !p) return { stale: true };
      if (String(p.userId) !== String(msg.from.id)) return { ignored: 'not prompt owner' };
      const closed = c; const late = SC.checkTimeout(g, now());
      if (late) { await delGuess(g, msg.message_id); save(); return { safeLate: true, ...(await afterClose(g, late, closed)) }; }
      const r = SC.submitGuess(g, msg.from, text, now(), { ledger, strict: true });
      if (!r) return null;
      const cleanup = async () => { delete c.prompts[rt]; save(); await tryDelete(g, rt); await delGuess(g, msg.message_id); };
      const who = r.player?.name || SC.userName(msg.from);
      switch (r.kind) {
        case 'invalid': await cleanup(); await prompt(g, msg.from, r.error); break;
        case 'cooldown': await cleanup(); await ephemeral(g, `${who}：${SC.cooldownText(r.waitMs)}`); break;
        case 'lockedOut': case 'dailyLockedOut': case 'notPlayer': await cleanup(); await ephemeral(g, `${who}：${r.kind === 'notPlayer' ? SC.notPlayerText() : SC.lockedText(r.kind === 'dailyLockedOut')}`); break;
        case 'scored': c.last = r.entry; await cleanup(); await postRound(g); break;
        case 'cracked': await cleanup(); return { safeGuess: 'cracked', ...(await afterClose(g, r.record, closed)) };
        default: break;
      }
      return { safeGuess: r.kind, ...(r.entry ? { ab: SC.abText(r.entry) } : {}), ...(r.error ? { error: r.error } : {}) };
    });
  }

  async function onCallback(cq) {
    const chat = cq.message?.chat; const m = SCC_CALLBACK_RE.exec(String(cq.data || ''));
    if (!m) { await answer(cq); return { ignored: 'safe data' }; }
    const [, action, gid] = m;
    if (action !== 'g') { await answer(cq, '請用報名訊息上的按鈕'); return { ignored: true }; }
    if (!inGroup(chat)) { await answer(cq); return { ignored: 'chat' }; }
    return serial(String(chat.id), async () => {
      const g = games.get(String(chat.id));
      if (!g || g.id !== gid || g.stage === 'ended') {
        await answer(cq, '這局已經結束了');
        try { await api.call('editMessageReplyMarkup', { chat_id: chat.id, message_id: cq.message?.message_id, reply_markup: { inline_keyboard: [] } }); } catch { /* gone */ }
        return { stale: true };
      }
      if (g.stage !== 'playing' || !g.current) { await answer(cq, '遊戲還沒開始喔'); return { invalid: true }; }
      const closed = g.current; const late = SC.checkTimeout(g, now());
      if (late) { await answer(cq, '💥 寶箱已自毀'); save(); return afterClose(g, late, closed); }
      const r = SC.canGuess(g, cq.from, now(), { ledger });
      if (r.kind === 'cooldown') { await alert(cq, SC.cooldownText(r.waitMs)); return { safeCooldown: Math.ceil(r.waitMs / 1000) }; }
      if (r.kind === 'lockedOut' || r.kind === 'dailyLockedOut') { await alert(cq, SC.lockedText(r.kind === 'dailyLockedOut')); return { safeLockedOut: true }; }
      if (!r.ok) { await alert(cq, SC.notPlayerText()); return { safeNotPlayer: true }; }
      for (const [id, p] of Object.entries(g.current.prompts || {})) if (String(p.userId) === String(cq.from.id)) { delete g.current.prompts[id]; await tryDelete(g, Number(id)); }
      await answer(cq, `回覆小遊戲精靈的提示，輸入 ${SC.SC_CODE_LEN} 位數字`);
      const pm = await prompt(g, cq.from);
      return { safePrompt: pm?.message_id ?? null };
    });
  }

  /** lobby countdown / auto start / 流局, 10-min lock timeout (自毀), per-minute refresh of the round message; catches up after a restart. */
  async function tick() {
    const out = [];
    for (const [key, g0] of [...games.entries()]) {
      try {
        out.push(await serial(key, async () => {
          const g = games.get(key); if (!g || g.id !== g0.id) return null; const t = now();
          if (g.stage === 'ended') { games.delete(key); save(); return null; }
          if (g.stage === 'lobby') {
            if (t >= g.createdAt + SCC_LOBBY_MS) return g.players.length ? begin(g, true) : cancelLobby(g);
            if (lobbyText(g) !== g.shownLobby) await refreshLobby(g);
            return null;
          }
          if (!g.current) { const step = SC.advance(g, t, random, { ledger }); save(); if (step.round) { await postRound(g); return { safeRound: g.round }; } return finishGame(g); }
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

  return { onMessage, onCallback, tick, recover: () => tick(), game: (chatId) => games.get(String(chatId)) || null, ledger: () => ledger,
    openCommunity, joinCommunity, leaveCommunity, startCommunity, abortCommunity };
}
