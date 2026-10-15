// 🚪 密室逃脫 group game flow: 報名 lobby (edit-in-place; 選劇本 / 繼續存檔) → rooms (🔍 調查 / 🎒 道具 / 🔢 密碼 / 💡 求救 / 💾 存檔) → ending.
// One game + one save slot per group, both persisted in tgStore (survive a restart). Timers run from tick() (service interval), all based on now().
// Scripts are data: assets/escape/scripts/<id>.json (validated at startup), images in assets/escape/<id>/ (missing → text only; picked up without a restart).
// 💡 求救: always on the level menu and usable any time while uses remain (shows 剩 N / 本關已給完 / 用完); hints are progress-aware: a hint whose `done` ids the team already has is skipped,
// and the hints given on this level stay readable (📒 線索簿, or press 💡 again once they are used up).
// Shared card: the room message's buttons are pressed by everyone, so a player's own result (spot text, 打不開, 沒反應, 封住了) goes out as a separate group message
// (「🔍 <name> 調查了：<spot>」, a reply to the room card); the card only says who acted (「👆 <name> 剛查看了 <spot>」) and keeps its menu. One such message per player
// (the previous one is deleted when a new one is sent), all deleted when the game ends / is saved / aborted. Discoveries (clues / items) stay as before.
// 社群版 (小遊戲精靈) uses this same engine through src/community/games/escape-flow.js with the `community` hooks: admin-opened rounds, AID signup, no 存檔, results via onEnd.
import fs from 'node:fs';
import { ES_CAPTION_MAX, ES_GAME_MS, ES_HINT_TAP_MS, ES_IDLE_SAVE_MS, ES_LOBBY_AUTOSTART_MS, ES_LOBBY_CANCEL_MS, ES_MAX_CODE_LEN, ES_MAX_HINTS, ES_MAX_PLAYERS, ES_MIN_PLAYERS,
  ES_TEXT_MAX, ES_WARN_AT, checkAnswer, normalizeAnswer, hhmm, introText, isCodeText, isEscapeStart, loadAllScripts, lobbyKeyboard, lobbyText, minutesLeft, mmss, saveLabel, stripCode, userName,
  ES_PENALTY_COOLDOWN_MS, ES_PENALTY_FLOOR_MS, fillScript, gameMs, isV2, levelNo, levelsOf, maxHintsOf, nextRooms, rollVars, unitOf } from './escape.js';

export const ES_CALLBACK_RE = /^es:([a-z])(?::([a-z0-9]{1,16}))?(?::([a-z0-9_]{1,16}))?(?::([a-z0-9_]{1,12}))?$/;
const GROUP_ONLY = '🚪 密室逃脫是群組遊戲，請到群組裡輸入 /escape 或按選單的「🚪 密室逃脫」開局。';
const MAX_MSG_IDS = 300;
const ROOM_MOVE_AFTER = 6;
const WRONG = ['鎖頭紋絲不動。門的另一邊，有人輕輕地笑了一聲。', '你們身後的燈閃了一下。剛才那個位置，好像多站了一個人。', '答錯的瞬間，所有人的耳邊同時響起一句：「再試一次嘛。」',
  '鎖孔裡慢慢滲出一滴黑色的血。', '牆壁裡傳來指甲刮過的聲音，從左邊，一路刮到右邊。', '有一隻冰冷的手，替你們把錯的答案擦掉了。'];
const NO_EFFECT = ['什麼事都沒有發生。只是你們覺得，有什麼東西在暗處看著。', '沒有反應。手上的東西突然變得很冰。', '試了半天，沒用。背後傳來一聲嘆氣，不是你們任何一個人的。'];
const WARN = { 10: '⏳ 剩 10 分鐘。走廊盡頭傳來拖行的聲音，越來越近。', 5: '⏳ 剩 5 分鐘。燈開始一盞一盞地熄滅。', 1: '⏳ 最後 1 分鐘。它已經在門外了。' };

export function createEscapeFlow({ api, send, answer, log, now = () => Date.now(), tgStore = null, inGroup, inUserPrivate, isAdmin = async () => false, splitText = (t) => [t], mode = 'all', botUsername = () => '',
  assetDir = new URL('../assets/escape/', import.meta.url), scripts = null, random = Math.random, readFile = (u) => fs.readFileSync(u), statFile = (u) => fs.statSync(u), community = null }) {
  // community (optional, 社群版): { maxPlayers, lobbyNote(g), keyboard(g), onEnd(g, { status, winners, reason }) }. Admin picks the 劇本 in DM setup,
  // no 存檔 (a round is one sitting: 15 idle minutes = 散場, not counted), and every participant is listed at the end.
  const MAXP = community?.maxPlayers || ES_MAX_PLAYERS;
  const COMMUNITY_LOBBY_MS = community?.lobbyMs || 30 * 60e3; // 社群版報名 30 分鐘 (2026-10-06, was ES_LOBBY_AUTOSTART_MS = 10); 小精靈 unchanged
  const autoMs = (g) => (g.community ? COMMUNITY_LOBBY_MS : ES_LOBBY_AUTOSTART_MS);
  const ended = async (g, summary) => { if (!g.community || !community?.onEnd || g.endReported) return; g.endReported = true; try { await community.onEnd(g, summary); } catch (error) { warn('community end hook failed', error); } };
  if (!scripts) { const r = loadAllScripts(assetDir); scripts = r.scripts; for (const m of r.errors) log.warn(`escape script skipped: ${m}`); if (r.upgraded.length) log.info(`escape 10-level scripts: ${r.upgraded.join(', ')}`); }
  const byId = new Map(scripts.map((s) => [s.id, s]));
  const saved = tgStore?.data.escape || {};
  const games = new Map(Object.entries(saved.games || {}));
  const saves = new Map(Object.entries(saved.saves || {}));
  const played = new Map(Object.entries(saved.played || {}));
  const images = new Map(); const chains = new Map(); const endAsks = new Map(); // 結束所有遊戲: second tap within END_CONFIRM_MS when a save exists
  const END_CONFIRM_MS = 10e3; let lastPhoto = false; let counter = Math.floor(random() * 1296);
  const save = () => { if (!tgStore) return; tgStore.data.escape = { games: Object.fromEntries(games), saves: Object.fromEntries(saves), played: Object.fromEntries(played) }; tgStore.save(); };
  const warn = (what, error) => log.warn(`escape ${what}: ${error?.message || error}`);
  const quiet = (error) => /not modified|not found|can't be edited|can't be deleted|message to edit|message to delete/i.test(String(error?.description || error?.message));
  const pickOne = (list) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  /** one queue per group: button presses / answers / timers of the same game never interleave */
  const serial = (key, fn) => { const prev = chains.get(key) || Promise.resolve(); const p = prev.then(fn, fn); const tail = p.catch(() => {}); chains.set(key, tail); tail.then(() => { if (chains.get(key) === tail) chains.delete(key); }); return p; };

  // ---------- images: assets/escape/<script>/<file> or assets/escape/<shared>.jpg; cached on mtime + size ----------
  function image(script, key) {
    const file = script ? script.images?.[key] : `${key}.jpg`; if (!file) return null;
    const u = new URL(script ? `${script.id}/${file}` : file, assetDir);
    try {
      const st = statFile(u); const sig = `${st.mtimeMs}:${st.size}`; const k = String(u);
      const hit = images.get(k); if (hit && hit.sig === sig) return hit.img;
      const img = { buffer: readFile(u), mimeType: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg', fileName: `escape-${script ? script.id + '-' : ''}${file}` }; images.set(k, { sig, img }); return img;
    } catch (error) { if (error?.code !== 'ENOENT') warn(`${file} image unreadable`, error); return null; }
  }
  const track = (g, m) => { if (m?.message_id == null) return m; g.msgIds = [...(g.msgIds || []), m.message_id].slice(-MAX_MSG_IDS); g.sinceRoom = (g.sinceRoom || 0) + 1; return m; };
  const markup = (kb) => (kb?.length ? { reply_markup: { inline_keyboard: kb } } : {});
  async function texts(g, text, keyboard = [], extra = {}) {
    const chunks = splitText(text); let last = null;
    for (const [i, c] of chunks.entries()) last = track(g, await send(c, { ...(i === 0 ? extra : {}), ...(i === chunks.length - 1 ? markup(keyboard) : {}) }, g.chatId));
    return last;
  }
  /** Photo card with caption (text only when the image is missing or the upload fails). Over 1024 chars → photo + text. */
  async function card(g, img, text, keyboard = [], extra = {}) {
    if (img && typeof api.sendPhoto === 'function') {
      try {
        lastPhoto = true;
        if (text.length <= ES_CAPTION_MAX) return track(g, await api.sendPhoto({ chatId: g.chatId, ...img, caption: text, replyMarkup: keyboard.length ? { inline_keyboard: keyboard } : undefined, replyToMessageId: extra.reply_to_message_id }));
        track(g, await api.sendPhoto({ chatId: g.chatId, ...img, caption: text.split('\n')[0], replyToMessageId: extra.reply_to_message_id }));
        lastPhoto = false; return texts(g, text, keyboard, {});
      } catch (error) { warn('photo failed, sending text instead', error); }
    }
    lastPhoto = false;
    return texts(g, text, keyboard, extra);
  }
  const replyTo = (g, messageId, text, kb = []) => texts(g, text, kb, messageId ? { reply_to_message_id: messageId, allow_sending_without_reply: true } : {});
  async function editMsg(chatId, messageId, photo, text, keyboard = []) {
    if (messageId == null) return;
    const body = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } };
    try { await api.call(photo ? 'editMessageCaption' : 'editMessageText', photo ? { ...body, caption: text.slice(0, ES_CAPTION_MAX) } : { ...body, text: text.slice(0, ES_TEXT_MAX) }); }
    catch (error) { if (!quiet(error)) warn('edit failed', error); }
  }
  async function stripButtons(chatId, messageId) {
    if (messageId == null) return;
    try { await api.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }); }
    catch (error) { if (!quiet(error)) warn('strip buttons failed', error); }
  }

  // ---------- per-player result messages (the shared card never carries one player's clue text) ----------
  async function dropMsgs(g, ids) {
    for (const id of [].concat(ids ?? [])) {
      if (id == null) continue;
      try { await api.call('deleteMessage', { chat_id: g.chatId, message_id: id }); } catch (error) { if (!quiet(error)) warn('delete failed', error); }
      g.msgIds = (g.msgIds || []).filter((x) => x !== id); if (g.roomMsgId != null && id > g.roomMsgId && g.sinceRoom > 0) g.sinceRoom--;
    }
  }
  /** post this player's result as its own message (reply to the room card); their previous one is deleted, so each player keeps only the latest */
  async function playerNote(g, user, text) {
    const key = String(user?.id ?? '?'); const prev = g.clueMsgs?.[key]; const ids = [];
    const extra = g.roomMsgId != null ? { reply_to_message_id: g.roomMsgId, allow_sending_without_reply: true } : {};
    for (const [i, c] of splitText(text).entries()) { const m = track(g, await send(c, i === 0 ? extra : {}, g.chatId)); if (m?.message_id != null) ids.push(m.message_id); }
    g.clueMsgs = { ...(g.clueMsgs || {}), [key]: ids }; save();
    if (prev != null) await dropMsgs(g, [].concat(prev).filter((x) => !ids.includes(x)));
  }
  /** game over / saved / aborted: every player's result message goes */
  async function clearNotes(g) {
    const all = Object.values(g.clueMsgs || {}).flat(); g.clueMsgs = {};
    if (all.length) await dropMsgs(g, all);
  }

  // ---------- lobby ----------
  const verOf = (s) => s?.version || 1;
  const saveOf = (chatId) => { const sv = saves.get(String(chatId)); const s = sv && byId.get(sv.scriptId); return s?.rooms[sv.room] && (sv.ver || 1) === verOf(s) ? sv : null; }; // a save of the old 3–4 room version doesn't fit the 10-level one
  const lobbyCtx = (g) => ({ script: g.choice ? byId.get(g.choice) : null, save: saveOf(g.chatId), scripts, t: now() });
  const editLobby = (g, text, kb) => editMsg(g.chatId, g.lobbyMsgId, g.lobbyPhoto, text, kb);
  const communityLobbyText = (g) => {
    const s = byId.get(g.choice); const left = Math.max(1, minutesLeft(g.createdAt + COMMUNITY_LOBBY_MS - now()));
    const roster = g.players.length ? g.players.map((p, i) => `${i + 1}. ${p.name}`).join('\n') : '還沒有人報名';
    const how = `${isV2(s) ? `🆕 ${levelsOf(s)} 關進階版：` : ''}全隊一起調查、用道具、解密碼，${Math.round(gameMs(s) / 60e3)} 分鐘內逃出去！`;
    return `🚪 密室逃脫｜報名中\n${community.lobbyNote?.(g) || ''}\n📖 劇本：${s ? `${s.emoji} ${s.title}` : '開局時隨機'}\n${how}\n\n👥 報名（${g.players.length}/${MAXP}）${g.players.length >= MAXP ? '｜已額滿' : ''}\n${roster}\n\n⏳ ${left} 分鐘後自動開始（至少 ${ES_MIN_PLAYERS} 人）；按「🎟 報名」報名，第一次會請你到私訊綁定遊戲 AID。`.slice(0, 4000);
  };
  const refreshLobby = (g) => {
    if (g.community) { g.countdown = communityLobbyText(g); return editLobby(g, g.countdown, community.keyboard(g)); }
    const ctx = lobbyCtx(g); g.countdown = lobbyText(g, ctx); return editLobby(g, g.countdown, lobbyKeyboard(g, ctx));
  };

  async function start(user, chat) {
    if (mode === 'operations') return { ignored: 'life feature' };
    if (inUserPrivate(chat, user)) { await send(GROUP_ONLY, {}, chat.id); return { escapeGroupOnly: true }; }
    if (!inGroup(chat)) return { ignored: 'chat' };
    return serial(String(chat.id), async () => {
      const existing = games.get(String(chat.id));
      if (existing) {
        const ref = existing.stage === 'lobby' ? existing.lobbyMsgId : existing.roomMsgId;
        await send(existing.stage === 'lobby' ? '🚪 已經有一局密室逃脫在報名中，按上面的「🚪 我也要玩」加入吧！' : '🚪 這個群組已經有一局密室逃脫在進行中，等這局結束（或存檔）再開新局喔。',
          ref ? { reply_to_message_id: ref, allow_sending_without_reply: true } : {}, chat.id);
        return { escapeBusy: existing.id };
      }
      if (!scripts.length) { await send('⚠️ 密室逃脫目前沒有可用的劇本。', {}, chat.id); return { escapeUnavailable: true }; }
      const t = now();
      const id = `${t.toString(36)}${(++counter).toString(36)}`.slice(-16);
      const g = { id, chatId: chat.id, stage: 'lobby', createdAt: t, updatedAt: t, players: [{ id: user.id, name: userName(user) }], msgIds: [], view: 'lobby', choice: null };
      games.set(String(chat.id), g); save();
      const ctx = lobbyCtx(g);
      const m = await card(g, image(null, 'lobby'), lobbyText(g, ctx), lobbyKeyboard(g, ctx));
      g.lobbyMsgId = m?.message_id ?? null; g.lobbyPhoto = lastPhoto; g.countdown = lobbyText(g, ctx); save();
      log.info(`escape lobby opened ${id} by user ${user.id}`);
      return { escapeLobby: id };
    });
  }
  async function cancelLobby(g) {
    g.stage = 'ended'; games.delete(String(g.chatId)); save();
    const text = '🌫 密室逃脫流局\n5 分鐘內沒有人按開始，也沒有其他人加入，門又悄悄關上了。\n想玩再輸入 /escape 開一局 🚪';
    const img = image(null, 'cancel'); let done = false;
    if (g.lobbyPhoto && img && typeof api.editMessageMedia === 'function') {
      try { await api.editMessageMedia({ chatId: g.chatId, messageId: g.lobbyMsgId, ...img, caption: text, replyMarkup: { inline_keyboard: [] } }); done = true; }
      catch (error) { warn('cancel image edit failed', error); }
    }
    if (!done) await editLobby(g, g.community ? '🌫 密室逃脫流局\n報名時間到了，還沒有人報名，門又悄悄關上了 🚪' : text, []);
    log.info(`escape lobby ${g.id} cancelled (not started, nobody joined)`);
    await ended(g, { status: 'cancelled', reason: '沒有人報名' });
    return { escapeCancelled: g.id };
  }

  // ---------- 社群版 (community) entry points ----------
  async function openCommunity(chat, round, { scriptId = null } = {}) {
    return serial(String(chat.id), async () => {
      if (games.get(String(chat.id))) return { busy: true };
      if (!scripts.length) return { unavailable: true };
      const t = now(); const id = `${t.toString(36)}${(++counter).toString(36)}`.slice(-16);
      let choice = scriptId && byId.has(scriptId) ? scriptId : null;
      if (!choice) { const seen = played.get(String(chat.id)) || []; const fresh = scripts.filter((s) => !seen.includes(s.id)); choice = pickOne(fresh.length ? fresh : scripts).id; }
      const g = { id, chatId: chat.id, community: true, roundId: round?.id || null, hostId: null, stage: 'lobby', createdAt: t, updatedAt: t, players: [], msgIds: [], view: 'lobby', choice };
      games.set(String(chat.id), g); save();
      const img = image(null, 'lobby');
      if (img && typeof api.sendPhoto === 'function') { try { track(g, await api.sendPhoto({ chatId: g.chatId, ...img, caption: `🚪 密室逃脫開局囉！\n\n${community.lobbyNote?.(g) || ''}` })); } catch (error) { warn('lobby photo failed', error); } }
      const m = await texts(g, communityLobbyText(g), community.keyboard(g));
      g.lobbyMsgId = m?.message_id ?? null; g.lobbyPhoto = false; g.countdown = communityLobbyText(g); save();
      log.info(`escape community lobby opened ${id} (${choice}${isV2(byId.get(choice)) ? ', 10-level' : ''})`);
      return { opened: true, gameId: id, script: choice };
    });
  }
  const joinCommunity = (chatId, user, meta = null) => serial(String(chatId), async () => {
    const g = games.get(String(chatId));
    if (!g || g.stage !== 'lobby') return { ok: false, text: '這局已經開始或結束了，下一局早點報名喔 🚪' };
    if (g.players.some((p) => String(p.id) === String(user.id))) return { ok: true, already: true, text: '你已經報名了 🚪' };
    if (g.players.length >= MAXP) return { ok: false, text: `已額滿（最多 ${MAXP} 人）` };
    g.players.push({ id: user.id, name: meta?.name || userName(user), ...(meta ? { meta } : {}) }); g.updatedAt = now(); save(); await refreshLobby(g); save();
    return { ok: true, text: `報名成功！目前 ${g.players.length}/${MAXP} 人` };
  });
  const leaveCommunity = (chatId, user) => serial(String(chatId), async () => {
    const g = games.get(String(chatId));
    if (!g || g.stage !== 'lobby') return { text: '報名已經截止啦' };
    const before = g.players.length; g.players = g.players.filter((p) => String(p.id) !== String(user.id));
    if (g.players.length === before) return { text: '你還沒報名喔' };
    save(); await refreshLobby(g); save(); return { left: true, text: '已退出報名' };
  });
  const startCommunity = (chatId) => serial(String(chatId), async () => {
    const g = games.get(String(chatId));
    if (!g || g.stage !== 'lobby') return { text: '這局不在報名階段' };
    if (g.players.length < ES_MIN_PLAYERS) return { tooFew: true, text: '還沒有玩家報名喔' };
    const r = await begin(g, 'new'); return { ...r, started: true, text: '開始囉！' };
  });
  async function abortNow(g, reason, status = 'aborted') {
    const wasLobby = g.stage === 'lobby';
    g.stage = 'ended'; g.aborted = status === 'aborted'; g.endedAt = now(); games.delete(String(g.chatId)); saves.delete(String(g.chatId)); resolved.delete(g.id); save();
    const text = status === 'aborted' ? `⛔ 密室逃脫已臨時終止\n${reason}\n本局不列入參加紀錄，可以重新報名下一局。` : `💤 密室逃脫散場\n${reason}\n本局不列入參加紀錄，可以重新報名下一局。`;
    if (wasLobby) await editLobby(g, text, []);
    else { await stripButtons(g.chatId, g.roomMsgId); await texts(g, text); await clearNotes(g); }
    log.info(`escape ${g.id} ${status}: ${reason}`);
    await ended(g, { status: status === 'aborted' ? 'aborted' : 'cancelled', reason });
    return { aborted: true, gameId: g.id };
  }
  const abortCommunity = (chatId, reason = '管理員臨時終止了這一局。') => serial(String(chatId), async () => {
    const g = games.get(String(chatId)); if (!g) return { inactive: true };
    return abortNow(g, reason, 'aborted');
  });
  /** Lobby「結束所有遊戲」: drop signup + clear the group save. Confirm once when a save would be lost. */
  async function endAllNow(g, user) {
    const hadSave = Boolean(saveOf(g.chatId));
    const who = userName(user);
    g.stage = 'ended'; g.endedAt = now(); games.delete(String(g.chatId)); saves.delete(String(g.chatId)); endAsks.delete(g.id); resolved.delete(g.id); save();
    const text = `🛑 密室逃脫已結束\n${who} 結束了報名${hadSave ? '與存檔' : ''}。\n下次再輸入 /escape 或點「🚪 密室逃脫」開一局。`;
    await editLobby(g, text, []);
    await clearNotes(g);
    log.info(`escape ${g.id} ended-all by ${user?.id} (save=${hadSave})`);
    await ended(g, { status: 'aborted', reason: `${who} 結束所有遊戲` });
    return { escapeEndedAll: true, clearedSave: hadSave };
  }
  /** how: 'new' | 'resume'; auto = the 10-minute auto start */
  async function begin(g, how, auto = false) {
    if (g.stage !== 'lobby') return { invalid: true };
    const t = now(); const sv = how === 'resume' ? saveOf(g.chatId) : null;
    const base = byId.get(sv ? sv.scriptId : g.choice); if (!base) return { invalid: true };
    Object.assign(g, { stage: 'playing', scriptId: base.id, ver: verOf(base), startedAt: t, updatedAt: t, lastActivityAt: t, view: 'main', sel: null, note: '', log: [], warned: [], hintShown: false, penaltyAt: 0 });
    if (sv) Object.assign(g, { room: sv.room, inv: [...sv.inv], clues: [...sv.clues], spots: structuredClone(sv.spots || {}), hintsUsed: sv.hintsUsed, roomHints: sv.roomHints, hintIdx: Array.isArray(sv.hintIdx) ? [...sv.hintIdx] : undefined, got: [...(sv.got || [])], stats: structuredClone(sv.stats),
      elapsedBefore: sv.elapsedMs, deadline: t + Math.max(60e3, sv.remainingMs), roomAt: t, stuckAt: t, runs: (sv.runs || 1) + 1,
      vars: sv.vars ?? null, path: sv.path || Array.from({ length: sv.room + 1 }, (_, i) => i), combos: [...(sv.combos || [])], view: sv.branch ? 'branch' : 'main',
      hidden: Object.fromEntries(Object.entries(sv.hidden || {}).map(([k, ms]) => [k, t + ms])) }); // sealed spots keep their remaining time
    else Object.assign(g, { room: 0, inv: [], clues: [], spots: {}, hintsUsed: 0, roomHints: 0, hintIdx: [], got: [], stats: { locks: {}, acts: {}, looks: 0, uses: 0, wrong: 0 }, elapsedBefore: 0, deadline: t + gameMs(base), roomAt: t, stuckAt: t, runs: 1,
      vars: base.vars ? rollVars(base, random) : null, path: [0], combos: [], hidden: {} });
    const s = scriptOf(g);
    saves.delete(String(g.chatId)); save(); // the save slot now lives in the running game (a new script overwrites it)
    await editLobby(g, `🚪 密室逃脫報名截止${auto ? `（${autoMs(g) / 60e3} 分鐘到，自動開始）` : ''}\n👥 共 ${g.players.length} 人：${g.players.map((p) => p.name).join('、')}\n📖 ${s.emoji} ${s.title}${sv ? `・繼續第 ${sv.level ?? sv.room + 1} ${sv.unit || '房'}` : ''}`, []);
    await card(g, image(s, 'cover'), introText(s, g, { resumed: Boolean(sv), noSave: Boolean(g.community) }));
    await showRoom(g);
    log.info(`escape ${g.id} ${sv ? 'resumed' : 'started'}: ${s.id} room ${g.room + 1}, ${g.players.length} players`);
    return { escapeStarted: g.id, how, script: s.id };
  }

  // ---------- room message (one message per room, edited in place) ----------
  const resolved = new Map(); // game id → the script with this game's random values filled in
  const scriptOf = (g) => {
    const base = byId.get(g.scriptId); if (!base?.vars || !g.vars) return base;
    const sig = JSON.stringify(g.vars); const hit = resolved.get(g.id); if (hit && hit.base === base && hit.sig === sig) return hit.s;
    const s = fillScript(base, g.vars); resolved.set(g.id, { base, sig, s }); if (resolved.size > 50) resolved.delete(resolved.keys().next().value); return s;
  };
  const roomOf = (g) => scriptOf(g).rooms[g.room];
  const headOf = (g, s = scriptOf(g), r = roomOf(g)) => `${s.emoji} ${s.title}｜第 ${levelNo(g)}/${levelsOf(s)} ${unitOf(s)}：${r.name}`;
  const spotState = (g, id) => (g.spots[`${g.room}.${id}`] ||= { seen: false, open: false, used: [] });
  const hiddenLeft = (g, id, t = now()) => Math.max(0, (g.hidden?.[`${g.room}.${id}`] || 0) - t);
  const sealedText = (left) => `剛才觸發的機關把這裡封住了，暫時碰不到（還要 ${Math.max(1, minutesLeft(left))} 分鐘）。`;
  const looked = (name, sp, extra = '') => `👆 ${name} 剛查看了 ${sp.label}${extra}`;
  const lookNote = (g, user, name, sp, text, icon = '🔍') => playerNote(g, user, `${icon} ${name} 調查了：${sp.label}\n${text}`);
  // ---------- 💡 求救: progress-aware hints ----------
  const hintText = (h) => (typeof h === 'string' ? h : String(h?.text || ''));
  /** the team has (or had) this clue / item; "spot:<id>" = that spot of this level has been opened / searched */
  const hasGot = (g, id) => { const m = /^spot:(.+)$/.exec(id); if (m) { const st = g.spots[`${g.room}.${m[1]}`]; return Boolean(st && (st.open || st.seen)); } return g.clues.includes(id) || g.inv.includes(id) || (g.got || []).includes(id); };
  /** a hint about a step the team already did (all its `done` ids are in hand) is skipped */
  const hintDone = (g, h) => Boolean(h && typeof h === 'object' && Array.isArray(h.done) && h.done.length && h.done.every((id) => hasGot(g, id)));
  const shownHints = (g) => (Array.isArray(g.hintIdx) ? g.hintIdx : Array.from({ length: g.roomHints || 0 }, (_, i) => i)); // old saves only kept a count
  const nextHint = (g, r = roomOf(g)) => r.hints.findIndex((h, i) => !shownHints(g).includes(i) && !hintDone(g, h));
  /** ready | level (no new hint on this level) | none (this game's 求救 used up) — no waiting: 求救 works any time while uses remain */
  const hintState = (g) => (g.hintsUsed >= maxHintsOf(scriptOf(g)) ? 'none' : nextHint(g) < 0 ? 'level' : 'ready');
  const hintReady = (g, t) => hintState(g, t) === 'ready';
  const hintButton = (g, t) => {
    const left = maxHintsOf(scriptOf(g)) - g.hintsUsed; const st = hintState(g, t);
    const text = st === 'ready' ? `💡 求救（剩 ${left}）` : st === 'level' ? '💡 本關提示（已給完）' : '💡 求救（用完了）';
    return { text, callback_data: `es:h:${g.id}` };
  };
  /** spots of this level still worth a look: never searched, or still locked (traps / sealed ones don't count) */
  const spotsLeft = (g, r = roomOf(g)) => r.spots.filter((sp) => !sp.trap && (() => { const st = g.spots[`${g.room}.${sp.id}`]; return sp.locked ? !st?.open : !st?.seen; })());
  const itemName = (s, id) => `${s.items[id].emoji} ${s.items[id].name}`;
  const isInitiator = (g, u) => String(g.players[0]?.id) === String(u?.id);
  const canEndAll = async (g, u) => isInitiator(g, u) || Boolean(await isAdmin(u));
  /** in-game name: 社群場 uses the roster name (admins = 詩詩 / 沐沐, players = their nickname), never the TG profile name */
  const nameOf = (g, u) => (g.community && g.players.find((p) => String(p.id) === String(u?.id))?.name) || userName(u);
  function renderRoom(g, t = now()) {
    const s = scriptOf(g); const r = roomOf(g); const max = g.roomPhoto ? ES_CAPTION_MAX : ES_TEXT_MAX;
    const head = headOf(g, s, r);
    const total = r.spots.filter((sp) => !sp.trap).length;
    const status = `⏱ 剩 ${minutesLeft(g.deadline - t)} 分（${hhmm(g.deadline)} 前）｜🎒 ${g.inv.length}｜🧩 ${g.clues.length}｜💡 ${g.hintsUsed}/${maxHintsOf(s)}${isV2(s) ? `｜🔍 ${total - spotsLeft(g, r).length}/${total}` : ''}`;
    const pen = r.lock.penalty; const penaltyNote = pen ? `⚠️ 答錯有懲罰${pen.seconds ? `：扣 ${pen.seconds} 秒` : ''}${pen.hide?.length ? `${pen.seconds ? '，' : '：'}還會觸發機關` : ''}。` : '答錯沒有懲罰。';
    const logLines = (g.log || []).slice(-3).map((x) => `📝 ${x}`).join('\n');
    let body;
    if (g.view === 'spots') body = `🔍 要調查哪裡？（✔️＝查過）${g.note ? `\n\n${g.note}` : ''}`;
    else if (g.view === 'items') body = `🎒 全隊背包｜點道具 → 選擇要用在哪裡\n${g.inv.map((id) => `${itemName(s, id)}：${s.items[id].desc}`).join('\n')}${g.note ? `\n\n${g.note}` : ''}`;
    else if (g.view === 'target') body = `🎒 要把 ${itemName(s, g.sel)} 用在哪裡？${s.combos?.length && g.inv.length > 1 ? '（或點「🔗」跟另一樣道具組合）' : ''}\n${s.items[g.sel].desc}`;
    else if (g.view === 'code') body = `🔢 ${r.lock.prompt}\n格式：例如「${r.lock.example}」\n\n🧩 已找到的線索：\n${g.clues.length ? `${isV2(s) && g.clues.length > 8 ? `…（共 ${g.clues.length} 條，全文在「📒 線索簿」）\n` : ''}${(isV2(s) ? g.clues.slice(-8) : g.clues).map((c) => `• ${s.clues[c].title}`).join('\n')}` : '（還沒有，先去調查吧）'}\n\n✍️ 請「回覆」這則訊息輸入答案（或直接打「密碼：…」）。${penaltyNote}${isV2(s) && spotsLeft(g, r).length ? `\n⚠️ 這一關還有 ${spotsLeft(g, r).length} 個地方沒查過或還沒打開（${spotsLeft(g, r).map((sp) => sp.label).join('、')}）——過了這關就回不來了，後面可能用得到。` : ''}`;
    else if (g.view === 'trap') body = `⚠️ ${r.spots.find((x) => x.id === g.sel)?.trap.confirm}`;
    else if (g.view === 'branch') body = `✅ 這一關的鎖解開了。\n\n🔀 ${r.branch.prompt}\n${r.branch.options.map((o) => `• ${o.label}${o.desc ? `：${o.desc}` : ''}`).join('\n')}\n\n（任何一位玩家點選都算數）`;
    else body = null;
    if (body) return `${head}\n\n${body}\n\n${status}`.slice(0, max);
    const tail = `🔒 ${r.lock.prompt}\n${status}${logLines ? `\n${logLines}` : ''}`;
    const room = max - head.length - tail.length - 6; const desc = r.description.length > room ? `${r.description.slice(0, Math.max(0, room - 1))}…` : r.description;
    return `${head}\n\n${desc}\n\n${tail}`;
  }
  function roomKeyboard(g, t = now()) {
    const s = scriptOf(g); const r = roomOf(g); const id = g.id; const pairs = (btns) => { const rows = []; for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2)); return rows; };
    if (g.view === 'spots') return [...pairs(r.spots.map((sp) => ({ text: `${hiddenLeft(g, sp.id, t) ? '🚫 ' : spotState(g, sp.id).seen ? '✔️ ' : ''}${sp.label}`, callback_data: `es:v:${id}:${sp.id}` }))), [{ text: '⬅️ 返回', callback_data: `es:m:${id}` }]];
    if (g.view === 'branch') return [...r.branch.options.map((o) => [{ text: `🔀 ${o.label}`, callback_data: `es:w:${id}:${o.to}` }]), ...(g.community ? [] : [[{ text: '💾 存檔離開', callback_data: `es:q:${id}` }]])];
    if (g.view === 'items') return [...pairs(g.inv.map((it) => ({ text: itemName(s, it), callback_data: `es:x:${id}:${it}` }))), [{ text: '⬅️ 返回', callback_data: `es:m:${id}` }]];
    if (g.view === 'target') {
      const mix = s.combos?.length ? g.inv.filter((x) => x !== g.sel).map((it) => ({ text: `🔗＋${s.items[it].emoji}${s.items[it].name}`, callback_data: `es:z:${id}:${g.sel}:${it}` })) : [];
      return [...pairs(r.spots.map((sp) => ({ text: sp.label, callback_data: `es:u:${id}:${g.sel}:${sp.id}` }))), ...pairs(mix), [{ text: '⬅️ 返回道具', callback_data: `es:o:${id}` }]];
    }
    if (g.view === 'code') return [[{ text: '🔍 調查', callback_data: `es:i:${id}` }, { text: '⬅️ 返回', callback_data: `es:m:${id}` }]];
    if (g.view === 'trap') { const sp = r.spots.find((x) => x.id === g.sel); return [[{ text: sp.trap.yes, callback_data: `es:y:${id}:${sp.id}` }, { text: '⬅️ 不要', callback_data: `es:i:${id}` }]]; }
    g.hintShown = hintReady(g, t); // the button is always there; the tick re-renders it the moment it opens
    return [[{ text: '🔍 調查', callback_data: `es:i:${id}` }, { text: `🎒 道具（${g.inv.length}）`, callback_data: `es:o:${id}` }],
      [{ text: '🔢 輸入密碼', callback_data: `es:c:${id}` }, hintButton(g, t)],
      ...[[...(isV2(s) ? [{ text: `📒 線索簿（${g.clues.length}）`, callback_data: `es:l:${id}` }] : []), ...(g.community ? [] : [{ text: '💾 存檔離開', callback_data: `es:q:${id}` }])]].filter((row) => row.length)];
  }
  async function showRoom(g) {
    const s = scriptOf(g); const r = roomOf(g);
    const img = g.view === 'branch' ? null : image(s, r.image); // the route choice is a plain text message
    g.roomPhoto = Boolean(img && typeof api.sendPhoto === 'function'); // decides the caption budget before sending
    const m = await card(g, img, renderRoom(g), roomKeyboard(g));
    g.roomMsgId = m?.message_id ?? null; g.roomPhoto = lastPhoto; g.sinceRoom = 0; save();
  }
  /** edit the room message in place; once 6+ game messages have piled up below it, the menu moves down (re-posted) so nobody has to scroll for the buttons */
  async function rerender(g) {
    save();
    if ((g.sinceRoom || 0) < ROOM_MOVE_AFTER) return editMsg(g.chatId, g.roomMsgId, g.roomPhoto, renderRoom(g), roomKeyboard(g));
    await editMsg(g.chatId, g.roomMsgId, g.roomPhoto, `${headOf(g)}\n\n👇 ${isV2(scriptOf(g)) ? '關卡' : '房間'}選單已移到下方`, []);
    return showRoom(g);
  }
  const addLog = (g, line) => { g.log = [...(g.log || []), line].slice(-5); };
  const bump = (g, name) => { g.stats.acts[name] = (g.stats.acts[name] || 0) + 1; };
  /** apply an outcome's gains; returns the lines for the reveal message */
  function gain(g, o) {
    const s = scriptOf(g); const lines = [];
    for (const c of o.clues || []) { if (!g.clues.includes(c)) g.clues.push(c); lines.push(`📜 ${s.clues[c].title}\n${s.clues[c].text}`); }
    const got = (o.gives || []).filter((x) => !g.inv.includes(x)); g.inv.push(...got); g.got = [...new Set([...(g.got || []), ...got])];
    const tags = [...(o.clues || []).map((c) => `🧩 獲得線索：「${s.clues[c].title}」`), ...got.map((x) => `🎒 獲得道具：${itemName(s, x)}（放進全隊背包）`)];
    return { lines, tags, imageKey: o.image || (o.clues || []).map((c) => s.clues[c].image).find(Boolean) || null };
  }
  async function reveal(g, title, text, o, extraTag = '') {
    const s = scriptOf(g); const { lines, tags, imageKey } = gain(g, o);
    const body = [title, text, ...lines, [...tags, extraTag].filter(Boolean).join('\n')].filter(Boolean).join('\n\n');
    save(); await card(g, imageKey ? image(s, imageKey) : null, body);
  }

  async function investigate(g, sp, user) {
    const name = nameOf(g, user); const st = spotState(g, sp.id); g.stats.looks++; bump(g, name);
    if (sp.trap && st.sprung) { g.view = 'spots'; g.note = looked(name, sp); await lookNote(g, user, name, sp, sp.again || '機關已經觸發過了，這裡只剩一片狼藉。'); return { escapeAgain: sp.id }; }
    if (sp.trap) { g.view = 'trap'; g.sel = sp.id; addLog(g, `${name} 靠近了 ${sp.label}……`); return { escapeTrapAsk: sp.id }; }
    g.view = 'spots';
    const left = hiddenLeft(g, sp.id); if (left) { g.note = looked(name, sp, '（被封住了）'); await lookNote(g, user, name, sp, sealedText(left), '🚫'); return { escapeSealed: sp.id }; }
    if (sp.locked && !st.open) { g.note = looked(name, sp, '（打不開）'); addLog(g, `${name} 查看了 ${sp.label}（打不開）`); await lookNote(g, user, name, sp, sp.locked.text, '🔒'); return { escapeLocked: sp.id }; }
    if (!st.seen) {
      st.seen = true;
      if ((sp.gives || []).length || (sp.clues || []).length) {
        g.note = `✅ ${name} 在 ${sp.label} 有發現！（看下方新訊息）`; addLog(g, `${name} 調查 ${sp.label} → 有發現`);
        await reveal(g, `🔍 ${name} 調查了 ${sp.label}`, sp.text, sp);
        return { escapeFound: sp.id };
      }
      g.note = looked(name, sp); addLog(g, `${name} 調查了 ${sp.label}`); await lookNote(g, user, name, sp, sp.text);
      return { escapeLooked: sp.id };
    }
    const s = scriptOf(g); const found = [...(sp.clues || []).map((c) => `「${s.clues[c].title}」`), ...(sp.gives || []).map((x) => itemName(s, x))];
    g.note = looked(name, sp); await lookNote(g, user, name, sp, `${sp.again || (st.open ? '已經打開了，裡面沒有別的東西了。' : '這裡已經查過了。')}${found.length ? `\n（在這裡找到過：${found.join('、')}）` : ''}`);
    return { escapeAgain: sp.id };
  }
  async function useItem(g, itemId, sp, user) {
    const s = scriptOf(g); const name = nameOf(g, user); const st = spotState(g, sp.id); const o = sp.trap ? null : sp.uses?.[itemId];
    const left = hiddenLeft(g, sp.id); if (left) { g.view = 'items'; g.note = `👆 ${name} 剛想把 ${itemName(s, itemId)} 用在 ${sp.label}（被封住了）`; await playerNote(g, user, `🚫 ${name} 把 ${itemName(s, itemId)} 用在：${sp.label}\n${sealedText(left)}`); return { escapeSealed: sp.id }; }
    if (!o || st.used.includes(itemId)) {
      g.view = 'items'; g.note = `👆 ${name} 剛把 ${itemName(s, itemId)} 用在 ${sp.label}（沒反應）`; addLog(g, `${name} 把 ${s.items[itemId].name} 用在 ${sp.label}（沒反應）`);
      await playerNote(g, user, `🎒 ${name} 把 ${itemName(s, itemId)} 用在：${sp.label}\n${o ? '已經用過了。' : pickOne(NO_EFFECT)}`);
      return { escapeNoEffect: itemId };
    }
    st.used.push(itemId); st.seen = true; if (sp.locked) st.open = true; g.stats.uses++; bump(g, name);
    if (o.consume) g.inv = g.inv.filter((x) => x !== itemId);
    g.view = 'main'; g.note = ''; addLog(g, `${name} 把 ${s.items[itemId].name} 用在 ${sp.label} → 有發現`);
    await reveal(g, `🎒 ${name} 把 ${itemName(s, itemId)} 用在 ${sp.label}`, o.text, o, o.consume ? `（${itemName(s, itemId)} 用掉了）` : '');
    return { escapeUsed: itemId, spot: sp.id };
  }
  /** two held items → a new item and/or clues (combos[]); keep: true leaves both in the bag */
  async function combine(g, a, b, user) {
    const s = scriptOf(g); const name = nameOf(g, user);
    const ci = (s.combos || []).findIndex((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a)); const c = s.combos?.[ci];
    if (!c || (g.combos || []).includes(ci)) {
      g.view = 'items'; g.note = `👆 ${name} 剛試著組合 ${s.items[a].name}＋${s.items[b].name}（沒反應）`; addLog(g, `${name} 試著組合 ${s.items[a].name}＋${s.items[b].name}（沒反應）`);
      await playerNote(g, user, `🔗 ${name} 把 ${itemName(s, a)} 跟 ${itemName(s, b)} 湊在一起……\n${c ? '已經組合過了。' : pickOne(NO_EFFECT)}`);
      return { escapeNoCombo: true };
    }
    g.combos = [...(g.combos || []), ci]; g.stats.uses++; bump(g, name);
    if (!c.keep) g.inv = g.inv.filter((x) => x !== a && x !== b);
    g.view = 'main'; g.note = ''; addLog(g, `${name} 組合了 ${s.items[a].name}＋${s.items[b].name}`);
    await reveal(g, `🔗 ${name} 把 ${itemName(s, a)} 跟 ${itemName(s, b)} 組合在一起`, c.text, { gives: c.makes ? [c.makes] : [], clues: c.clues, image: c.image }, c.keep ? '' : `（${s.items[a].name}、${s.items[b].name} 合成後就不見了）`);
    return { escapeCombined: c.makes || ci };
  }
  /** wrong answer / penalty trap: time off the clock (never below 1 minute left) and spots sealed for a while; returns the lines to show */
  function applyPenalty(g, p, t, { cooldown = false } = {}) {
    if (!p || (cooldown && t - (g.penaltyAt || 0) < ES_PENALTY_COOLDOWN_MS)) return [];
    const r = roomOf(g); const lines = []; g.penaltyAt = t;
    if (p.text) lines.push(p.text);
    if (p.seconds) {
      const before = g.deadline; g.deadline = Math.max(Math.min(before, t + ES_PENALTY_FLOOR_MS), before - p.seconds * 1000);
      const lost = Math.round((before - g.deadline) / 1000); if (lost > 0) { g.stats.penalty = (g.stats.penalty || 0) + lost; lines.push(`⏱ 懲罰：時間 −${lost} 秒（剩 ${mmss(g.deadline - t)}）`); }
    }
    const secs = p.hideSeconds || 120;
    for (const id of p.hide || []) { const sp = r.spots.find((x) => x.id === id); g.hidden = { ...(g.hidden || {}), [`${g.room}.${id}`]: t + secs * 1000 }; lines.push(`🚫 ${sp?.label || id} 被封住了，${Math.ceil(secs / 60)} 分鐘內碰不到`); }
    return lines;
  }
  const moveTo = (g, idx, line) => { const t = now(); Object.assign(g, { room: idx, path: [...(g.path || Array.from({ length: g.room + 1 }, (_, i) => i)), idx], roomHints: 0, hintIdx: [], roomAt: t, stuckAt: t, view: 'main', sel: null, note: '', log: [line] }); };
  /** this level's hints already given, numbered (they stay readable after scrolling away) */
  const givenHints = (g, r = roomOf(g)) => shownHints(g).filter((i) => r.hints[i] != null).map((i, n) => `${n + 1}. ${hintText(r.hints[i])}`);
  async function giveHint(g, user) {
    const r = roomOf(g); const t = now(); const max = maxHintsOf(scriptOf(g)); const st = hintState(g, t); const given = givenHints(g, r);
    const unit = isV2(scriptOf(g)) ? '關' : '房';
    if (st === 'none' || st === 'level') {
      const head = st === 'none' ? `求救次數用完了（${g.hintsUsed}/${max}）` : `這一${unit}的提示都給過了`;
      if (given.length && t - (g.hintRepostAt || 0) >= 60e3) { // free re-post of what was already given here
        g.hintRepostAt = t; save();
        await texts(g, `💡 ${head}｜這一${unit}給過的提示（不扣次數）：\n${given.join('\n')}\n\n（「回覆」${isV2(scriptOf(g)) ? '關卡' : '房間'}訊息輸入答案）`);
        return { escapeNoHint: true, reposted: given.length, text: `${head}，再貼一次這${unit}給過的提示` };
      }
      return { escapeNoHint: true, text: given.length ? `${head}（給過的提示在📒 線索簿裡）` : head };
    }
    if (t - (g.lastHintAt || 0) < ES_HINT_TAP_MS) return { escapeNoHint: true, text: '剛剛才給過提示，往上看看～' }; // two people tapping at once never burns two
    const idx = nextHint(g, r); const hint = hintText(r.hints[idx]);
    g.hintIdx = [...shownHints(g), idx]; g.roomHints = g.hintIdx.length; g.hintsUsed++; g.stuckAt = t; g.lastHintAt = t; addLog(g, `${nameOf(g, user)} 求救了（${g.hintsUsed}/${max}）`); save();
    await texts(g, `💡 求救 ${g.hintsUsed}/${max}｜${nameOf(g, user)}\n${hint}\n\n（「回覆」${isV2(scriptOf(g)) ? '關卡' : '房間'}訊息輸入答案${g.hintsUsed < max ? `；還能求救 ${max - g.hintsUsed} 次` : '；求救次數用完了'}）`);
    return { escapeHint: g.hintsUsed };
  }
  /** a fair nudge after a wrong answer: the expected length, or "that came from a clue you shouldn't trust" (never the answer itself) */
  function wrongTip(g, s, lock, body) {
    const got = normalizeAnswer(body, lock.format); const want = lock.answers.map((a) => normalizeAnswer(a, lock.format)).filter(Boolean);
    const herring = g.clues.map((c) => s.clues[c]).find((c) => c?.herring && got && (lock.format === 'text' ? got.length >= 2 && normalizeAnswer(c.text, 'text').includes(got)
      : (String(c.text).normalize('NFKC').match(/\d+/g) || []).some((x) => normalizeAnswer(x, lock.format) === got) || (lock.format === 'numbers' && normalizeAnswer(c.text, 'numbers').includes(got))));
    if (herring) return `這個答案出自「${herring.title}」——那條線索可信嗎？`;
    if (lock.format === 'digits' && want.length && !want.some((w) => w.length === got.length)) return `這道鎖要輸入 ${[...new Set(want.map((w) => w.length))].join(' 或 ')} 位數字（你們輸入了 ${got.length} 位）。`;
    if (lock.format === 'numbers' && want.length && !want.some((w) => w.split('-').length === got.split('-').length)) return `要依序輸入 ${want[0].split('-').length} 個數字，用空格隔開。`;
    return '';
  }
  async function tryCode(g, msg, body) {
    const s = scriptOf(g); const r = roomOf(g); const name = nameOf(g, msg.from); g.lastActivityAt = now();
    if (!checkAnswer(r.lock, body)) {
      g.stats.wrong++; bump(g, name); addLog(g, `${name} 試了「${body.slice(0, 12)}」✖`);
      const pen = applyPenalty(g, r.lock.penalty, now(), { cooldown: true }); save(); const tip = wrongTip(g, s, r.lock, body);
      await replyTo(g, msg.message_id, `❌ ${name}：「${body}」不對。\n${pickOne([...(s.wrongTexts || []), ...WRONG])}${tip ? `\n💬 ${tip}` : ''}${pen.length ? `\n\n${pen.join('\n')}` : ''}`);
      await rerender(g);
      return { escapeWrong: true };
    }
    g.stats.locks[name] = (g.stats.locks[name] || 0) + 1; bump(g, name);
    await replyTo(g, msg.message_id, `🔓 ${name} 輸入「${body}」——答對了！\n\n${r.lock.solved}`);
    await editMsg(g.chatId, g.roomMsgId, g.roomPhoto, `${headOf(g, s, r)}\n\n✅ ${name} 解開了這裡的鎖。`, []);
    const next = nextRooms(s, g.room);
    if (!next.length) return endGame(g, 'good');
    if (r.branch) { Object.assign(g, { view: 'branch', sel: null, note: '', log: [`${name} 打開了門`] }); await showRoom(g); return { escapeBranch: r.id }; }
    moveTo(g, next[0], `${name} 打開了門`);
    await showRoom(g);
    return { escapeSolved: g.room };
  }

  // ---------- save / end ----------
  async function pause(g, how, user = null) {
    const s = scriptOf(g); const r = roomOf(g); const t = now();
    const remainingMs = Math.max(60e3, Math.min(gameMs(s), how === 'idle' ? g.deadline - g.lastActivityAt : g.deadline - t)); // idle: the 15 quiet minutes are given back
    const rec = { scriptId: s.id, title: s.title, emoji: s.emoji, room: g.room, roomName: r.name, inv: g.inv, clues: g.clues, spots: g.spots, hintsUsed: g.hintsUsed, roomHints: g.roomHints, hintIdx: shownHints(g), got: g.got || [], stats: g.stats,
      elapsedMs: g.elapsedBefore + ((how === 'idle' ? g.lastActivityAt : t) - g.startedAt), remainingMs, savedAt: t, runs: g.runs, players: g.players.map((p) => p.name) };
    if (isV2(s) || g.vars) Object.assign(rec, { ver: g.ver || 1, level: levelNo(g), unit: unitOf(s), vars: g.vars ?? null, path: g.path, combos: g.combos || [], branch: g.view === 'branch',
      hidden: Object.fromEntries(Object.entries(g.hidden || {}).map(([k, u]) => [k, u - t]).filter(([, ms]) => ms > 0)) });
    saves.set(String(g.chatId), rec); g.stage = 'ended'; games.delete(String(g.chatId)); save();
    await editMsg(g.chatId, g.roomMsgId, g.roomPhoto, `${headOf(g, s, r)}\n\n💾 已存檔（暫停中）`, []);
    const head = how === 'idle' ? '💤 15 分鐘沒有人行動，小精靈先幫你們存檔了（發呆的時間不算）。' : `💾 ${userName(user)} 存檔了。`;
    await texts(g, `${head}\n📼 ${s.emoji} ${saveLabel(rec)}「${r.name}」｜剩 ${mmss(remainingMs)}（暫停中，不會倒數）\n下次在群組輸入 /escape 或按「🚪 密室逃脫」，選「▶️ 繼續上次進度」就能接著玩。`);
    await clearNotes(g);
    log.info(`escape ${g.id} saved (${how}): ${s.id} room ${g.room + 1}, ${Math.round(remainingMs / 1000)}s left`);
    return { escapeSaved: how };
  }
  function statsText(g, t) {
    const s = scriptOf(g); const locks = Object.entries(g.stats.locks).sort((a, b) => b[1] - a[1]); const acts = Object.entries(g.stats.acts).sort((a, b) => b[1] - a[1]);
    return [`📊 戰績｜${s.emoji} ${s.title}`, `⏱ 用時 ${mmss(g.elapsedBefore + (t - g.startedAt))}｜到達第 ${levelNo(g)}/${levelsOf(s)} ${unitOf(s)}${g.runs > 1 ? `｜分 ${g.runs} 次玩` : ''}`,
      `🔓 解鎖王：${locks.length ? locks.map(([n, c]) => `${n}（${c} 道）`).join('、') : '（沒有人解開鎖）'}`, acts.length ? `🙋 最積極：${acts[0][0]}（${acts[0][1]} 次行動）` : null,
      `🔍 調查 ${g.stats.looks} 次・🎒 道具 ${g.stats.uses} 次・❌ 輸錯 ${g.stats.wrong} 次・💡 求救 ${g.hintsUsed}/${maxHintsOf(s)}${g.stats.penalty ? `・⏱ 被罰 ${mmss(g.stats.penalty * 1000)}` : ''}`].filter(Boolean).join('\n');
  }
  async function endGame(g, endingId) {
    if (g.stage !== 'playing') return { invalid: true };
    const s = scriptOf(g); const en = s.endings[endingId] || s.endings.bad; const t = now();
    g.stage = 'ended'; g.endedAt = t; games.delete(String(g.chatId)); saves.delete(String(g.chatId));
    played.set(String(g.chatId), [...new Set([...(played.get(String(g.chatId)) || []), s.id])]); save();
    if (endingId !== 'good') await stripButtons(g.chatId, g.roomMsgId);
    const head = endingId === 'bad' ? '⏰ 時間到……\n\n' : '';
    await card(g, image(s, en.image || (endingId === 'good' ? 'good_end' : 'bad_end')), `${head}${en.title}\n\n${en.text}\n\n${statsText(g, t)}`, g.community ? [] : [[{ text: '🚪 再玩一局', callback_data: 'es:n' }]]);
    await clearNotes(g);
    log.info(`escape ${g.id} ended: ${s.id} ${endingId}, room ${g.room + 1}, hints ${g.hintsUsed}`);
    resolved.delete(g.id); // this game's random answers are done; the next round rolls new ones
    await ended(g, { status: 'completed', result: endingId, script: s.id, winners: g.players.map((p) => p.id) });
    return { escapeEnded: endingId };
  }

  // ---------- inbound ----------
  async function onMessage(msg, text) {
    if (!community && isEscapeStart(text, botUsername())) return start(msg.from, msg.chat);
    if (mode === 'operations' || !inGroup(msg.chat)) return null;
    const g0 = games.get(String(msg.chat.id));
    if (!g0 || g0.stage !== 'playing') return null;
    const rt = msg.reply_to_message; const code = isCodeText(text);
    if (!(code || (rt && (g0.msgIds || []).includes(rt.message_id)))) return null;
    return serial(String(msg.chat.id), async () => {
      const g = games.get(String(msg.chat.id)); if (!g || g.id !== g0.id || g.stage !== 'playing') return { stale: true };
      if (!g.players.some((p) => String(p.id) === String(msg.from?.id))) return { ignored: 'not escape player' };
      if (g.view === 'branch') return { ignored: 'choose a route first' };
      const body = (code ? stripCode(text) : text).trim();
      const lock = scriptOf(g)?.rooms[g.room]?.lock; // discussion replies are not attempts: no digits for a number lock, or a long sentence
      if (!body || body.length > ES_MAX_CODE_LEN || !lock || (lock.format === 'text' ? body.length > 20 : !normalizeAnswer(body, lock.format))) return { ignored: 'chatter' };
      if (now() >= g.deadline) return endGame(g, 'bad');
      return tryCode(g, msg, body);
    });
  }

  async function onCallback(cq, action, gid, a, b) {
    const chat = cq.message?.chat;
    if (mode === 'operations') { await answer(cq, '密室逃脫請找小精靈。'); return { denied: true }; }
    if (community && ['n', 'j', 'p', 'k', 'b', 's', 'r', 'q', 'e'].includes(action)) { await answer(cq, action === 'q' ? '社群場不能存檔' : '請用報名訊息上的按鈕'); return { ignored: true }; }
    if (action === 'n') {
      if (inUserPrivate(chat, cq.from)) { await answer(cq, '密室逃脫是群組遊戲'); await send(GROUP_ONLY, {}, chat.id); return { escapeGroupOnly: true }; }
      if (!inGroup(chat)) { await answer(cq); return { ignored: 'chat' }; }
      await answer(cq); return start(cq.from, chat);
    }
    if (!inGroup(chat)) { await answer(cq); return { ignored: 'chat' }; }
    return serial(String(chat.id), () => handleCallback(cq, chat, action, gid, a, b));
  }
  async function handleCallback(cq, chat, action, gid, a, b) {
    const g = games.get(String(chat.id));
    if (!g || g.id !== gid) { await answer(cq, '這局密室逃脫已經結束了'); await stripButtons(chat.id, cq.message?.message_id); return { stale: true }; }
    const isPlayer = g.players.some((p) => String(p.id) === String(cq.from.id)); const t = now();
    if (g.stage === 'lobby') {
      if (action === 'j') {
        if (isPlayer) { await answer(cq, '你已經報名了 🚪'); return { escapeAlreadyJoined: true }; }
        if (g.players.length >= ES_MAX_PLAYERS) { await answer(cq, '已額滿（最多 10 人）'); return { escapeFull: true }; }
        g.players.push({ id: cq.from.id, name: userName(cq.from) }); g.updatedAt = t; save();
        await answer(cq, `報名成功！目前 ${g.players.length}/${ES_MAX_PLAYERS} 人`); await refreshLobby(g); save();
        return { escapeJoined: g.players.length };
      }
      if (action === 'e') {
        if (!(await canEndAll(g, cq.from))) { await answer(cq, '只有發起人或管理員可以結束'); return { denied: true }; }
        const hadSave = Boolean(saveOf(g.chatId));
        if (hadSave) {
          const ask = endAsks.get(g.id); const nowT = now();
          if (!ask || String(ask.userId) !== String(cq.from.id) || nowT - ask.at > END_CONFIRM_MS) {
            endAsks.set(g.id, { userId: cq.from.id, at: nowT });
            try { await api.call('answerCallbackQuery', { callback_query_id: cq.id, text: `確定結束？會清除報名與存檔。${END_CONFIRM_MS / 1000} 秒內再按一次「🛑 結束所有遊戲」確認。`, show_alert: true }); }
            catch (error) { warn('end-all alert failed', error); }
            return { escapeEndConfirm: true };
          }
        }
        endAsks.delete(g.id);
        await answer(cq, '已結束');
        return endAllNow(g, cq.from);
      }
      if (!['p', 'k', 'b', 's', 'r'].includes(action)) { await answer(cq, '遊戲還沒開始'); return { invalid: true }; }
      if (!isInitiator(g, cq.from)) { await answer(cq, '只有發起人可以選劇本、開始遊戲'); return { denied: true }; }
      if (action === 'p' || action === 'b') { g.view = action === 'p' ? 'pick' : 'lobby'; await answer(cq); await refreshLobby(g); save(); return { escapeView: g.view }; }
      if (action === 'k') {
        if (!byId.has(a)) { await answer(cq, '找不到這個劇本'); return { invalid: true }; }
        g.choice = a; g.view = 'lobby'; await answer(cq, `選好了：${byId.get(a).title}`); await refreshLobby(g); save(); return { escapeChosen: a };
      }
      if (g.players.length < ES_MIN_PLAYERS) { await answer(cq, '還沒有玩家報名喔'); return { escapeNeedPlayers: true }; }
      if (action === 'r') { if (!saveOf(g.chatId)) { await answer(cq, '這個群組沒有存檔'); return { invalid: true }; } await answer(cq, '繼續上次進度！'); return begin(g, 'resume'); }
      if (!g.choice) { await answer(cq, '請先選劇本'); return { escapeNeedScript: true }; }
      await answer(cq, '開始囉！'); return begin(g, 'new');
    }
    if (g.stage !== 'playing') { await answer(cq); return { invalid: true }; }
    if (action === 'j') { await answer(cq, '這局已經開始了，下一局早點報名喔 🚪'); return { invalid: true }; }
    if (cq.message?.message_id != null && g.roomMsgId != null && cq.message.message_id !== g.roomMsgId) { await answer(cq, '這是舊的選單了，請用最下面的房間訊息 👇'); await stripButtons(chat.id, cq.message.message_id); return { stale: true }; }
    if (!isPlayer) { await answer(cq, '你沒有報名這一局，可以在旁邊幫忙出主意 👀'); return { denied: true }; }
    if (t >= g.deadline) { await answer(cq, '時間到了……'); return endGame(g, 'bad'); }
    const s = scriptOf(g); const r = roomOf(g); const sp = b ? r.spots.find((x) => x.id === b) : r.spots.find((x) => x.id === a);
    if (g.view === 'branch' && !['w', 'q'].includes(action)) { await answer(cq, '先選一條路 🔀'); return { escapeChooseRoute: true }; }
    g.lastActivityAt = t; g.updatedAt = t;
    let out;
    switch (action) {
      case 'm': g.view = 'main'; g.note = ''; await answer(cq); out = { escapeView: 'main' }; break;
      case 'i': g.view = 'spots'; g.note = ''; await answer(cq); out = { escapeView: 'spots' }; break;
      case 'o':
        if (!g.inv.length) { await answer(cq, '背包是空的，先去調查看看'); return { escapeEmptyBag: true }; }
        g.view = 'items'; g.note = ''; await answer(cq); out = { escapeView: 'items' }; break;
      case 'c': g.view = 'code'; await answer(cq, '「回覆」這則房間訊息輸入答案'); out = { escapeView: 'code' }; break;
      case 'v': if (!sp) { await answer(cq, '這裡沒有這個地方'); return { invalid: true }; } await answer(cq); out = await investigate(g, sp, cq.from); break;
      case 'x': if (!g.inv.includes(a)) { await answer(cq, '背包裡沒有這個道具了'); g.view = 'items'; out = { invalid: true }; break; } g.view = 'target'; g.sel = a; await answer(cq); out = { escapeView: 'target' }; break;
      case 'u': if (!g.inv.includes(a) || !sp) { await answer(cq, '背包裡沒有這個道具了'); g.view = g.inv.length ? 'items' : 'main'; out = { invalid: true }; break; } await answer(cq); out = await useItem(g, a, sp, cq.from); break;
      case 'y': {
        if (!sp?.trap) { await answer(cq); return { invalid: true }; }
        await answer(cq, '……'); const name = nameOf(g, cq.from); addLog(g, `${name} ${sp.trap.yes.replace(/^\S+\s*/, '')}`);
        if (!sp.trap.penalty) return endGame(g, sp.trap.ending);
        const st = spotState(g, sp.id); // a non-fatal trap: springs once, costs time / seals a spot
        if (st.sprung) { g.view = 'spots'; g.note = looked(name, sp); await lookNote(g, cq.from, name, sp, sp.again || '機關已經觸發過了，這裡只剩一片狼藉。'); out = { escapeAgain: sp.id }; break; }
        st.sprung = true; st.seen = true; bump(g, name); const lines = applyPenalty(g, sp.trap.penalty, t); g.view = 'main'; g.note = ''; save();
        await card(g, sp.trap.image ? image(s, sp.trap.image) : null, [`⚠️ ${name} ${sp.trap.yes.replace(/^\S+\s*/, '')}……`, sp.trap.text, lines.join('\n')].filter(Boolean).join('\n\n'));
        out = { escapeTrapped: sp.id }; break;
      }
      case 'z':
        if (!g.inv.includes(a) || !g.inv.includes(b)) { await answer(cq, '背包裡沒有這個道具了'); g.view = g.inv.length ? 'items' : 'main'; out = { invalid: true }; break; }
        await answer(cq); out = await combine(g, a, b, cq.from); break;
      case 'l': {
        await answer(cq); const list = g.clues.map((c) => `📜 ${s.clues[c].title}\n${s.clues[c].text}`);
        const tips = givenHints(g, r);
        await texts(g, `📒 線索簿｜${nameOf(g, cq.from)} 翻開了（${g.clues.length} 條）\n\n${list.join('\n\n') || '（還沒有線索，先去調查吧）'}\n\n🎒 背包：${g.inv.map((it) => itemName(s, it)).join('、') || '（空的）'}${tips.length ? `\n\n💡 這一${isV2(s) ? '關' : '房'}給過的提示：\n${tips.join('\n')}` : ''}`);
        out = { escapeNotes: g.clues.length }; break;
      }
      case 'w': {
        const o = g.view === 'branch' ? r.branch?.options.find((x) => x.to === a) : null; const idx = o ? s.rooms.findIndex((x) => x.id === o.to) : -1;
        if (idx < 0) { await answer(cq, '這條路走不通'); return { invalid: true }; }
        await answer(cq, `走「${o.label}」！`); const name = nameOf(g, cq.from);
        await editMsg(g.chatId, g.roomMsgId, g.roomPhoto, `${headOf(g, s, r)}\n\n🔀 ${name} 選了「${o.label}」。`, []);
        moveTo(g, idx, `${name} 選了 ${o.label}`); await showRoom(g);
        return { escapeRoute: o.to };
      }
      case 'h': { const h = await giveHint(g, cq.from); await answer(cq, h.text || ''); out = h; break; }
      case 'q':
        if (!isInitiator(g, cq.from)) { await answer(cq, '只有發起人可以存檔離開'); return { denied: true }; }
        await answer(cq, '存檔了！'); return pause(g, 'manual', cq.from);
      default: await answer(cq); return { ignored: 'escape action' };
    }
    void s; await rerender(g);
    return out;
  }

  /** Timers: 5-min 流局 (initiator alone, never pressed start), 10-min auto start, lobby countdown, 💡 appears after 5 min stuck, 10/5/1-min warnings, 30-min timeout, 15-min idle auto save. Call periodically (and after a restart). */
  async function tick() {
    const out = [];
    for (const [key, g0] of [...games.entries()]) {
      try {
        out.push(await serial(key, async () => {
          const g = games.get(key); if (!g || g.id !== g0.id) return null; const t = now();
          if (g.stage === 'lobby' && g.community) {
            if (t - g.createdAt >= COMMUNITY_LOBBY_MS) return g.players.length ? begin(g, 'new', true) : cancelLobby(g);
            const text = communityLobbyText(g); if (text !== g.countdown) { g.countdown = text; save(); await editLobby(g, text, community.keyboard(g)); }
            return null;
          }
          if (g.stage === 'lobby') {
            const others = g.players.length - 1;
            if (others === 0 && t - g.createdAt >= ES_LOBBY_CANCEL_MS) return cancelLobby(g);
            if (others > 0 && t - g.createdAt >= ES_LOBBY_AUTOSTART_MS) {
              if (!g.choice && !saveOf(g.chatId)) { const seen = played.get(key) || []; const fresh = scripts.filter((s) => !seen.includes(s.id)); g.choice = pickOne(fresh.length ? fresh : scripts).id; }
              return begin(g, g.choice ? 'new' : 'resume', true);
            }
            const text = lobbyText(g, lobbyCtx(g)); if (text !== g.countdown) { g.countdown = text; save(); await editLobby(g, text, lobbyKeyboard(g, lobbyCtx(g))); }
            return null;
          }
          if (g.stage !== 'playing') return null;
          if (!scriptOf(g)) { if (g.community) return abortNow(g, '這套劇本暫時不能用，這局先散場了。', 'idle'); games.delete(key); save(); return { escapeDropped: g.id }; }
          if ((g.ver || 1) !== verOf(byId.get(g.scriptId))) { // the script was upgraded (e.g. 3–4 rooms → 10 levels) under a running game
            if (g.community) return abortNow(g, '這套劇本剛升級成 10 關新版，這局沒辦法接著玩了。', 'idle');
            games.delete(key); save(); await stripButtons(g.chatId, g.roomMsgId); await clearNotes(g);
            await send('🚪 這套劇本剛升級成新版，這局沒辦法接著玩了。輸入 /escape 或按「🚪 密室逃脫」重新開一局吧！', {}, g.chatId);
            return { escapeDropped: g.id, upgraded: true };
          }
          if (t >= g.deadline) return endGame(g, 'bad');
          if (t - g.lastActivityAt >= ES_IDLE_SAVE_MS) return g.community ? abortNow(g, '15 分鐘沒有人行動，這局先散場了。', 'idle') : pause(g, 'idle');
          const left = Math.ceil((g.deadline - t) / 60e3); const due = ES_WARN_AT.filter((m) => left <= m && !(g.warned || []).includes(m));
          if (due.length) { g.warned = [...(g.warned || []), ...due]; save(); await texts(g, WARN[Math.min(...due)]); await rerender(g); return { escapeWarned: Math.min(...due) }; }
          if (g.view === 'main' && hintReady(g, t) && !g.hintShown) { await rerender(g); return { escapeHintReady: true }; }
          return null;
        }));
      } catch (error) { warn('tick failed', error); }
    }
    return out.filter(Boolean);
  }
  return { start, onMessage, onCallback, tick, recover: () => tick(), game: (chatId) => games.get(String(chatId)) || null, savedGame: (chatId) => saves.get(String(chatId)) || null, scripts: () => scripts,
    openCommunity, joinCommunity, leaveCommunity, startCommunity, abortCommunity };
}
