// 🐢 海龜湯 group game flow: 報名 lobby (edit-in-place) → GPT 出題 → 是非題 / 我猜 (GPT judges, queued in order) → 揭曉.
// One game per group, persisted in tgStore (survives a restart). Timers run from tick() (service interval), all based on now().
import fs from 'node:fs';
import { HG_BANK } from './haiguitang-bank.js';
import { HG_BATCH, HG_CLUE_EVERY, HG_GAME_MS, HG_GRACE_MS, HG_HINT_IDLE_MS, HG_LOBBY_AUTOSTART_MS, HG_LOBBY_CANCEL_MS, HG_MAX_HINTS, HG_HINT_COOLDOWN_MS, HG_ASK_PLACEHOLDER, askPromptText, buildScenePrompt, answerCardText, answerKeyboard, HG_MAX_PENDING_PER_USER,
  HG_MAX_PLAYERS, HG_MIN_PLAYERS, HG_PICKING_TEXT, HG_ANSWERS, HG_VERDICTS, buildJudgePrompt, buildPuzzlePrompt, cluesText, endingText, isGuessText, isHaiguiStart, lobbyKeyboard, lobbyText,
  parseJudge, parsePuzzle, pickTheme, puzzleText, stripGuess, surrenderKeyboard, userName } from './haiguitang.js';

export const HG_CALLBACK_RE = /^hg:([njsgha])(?::([a-z0-9]{1,24}))?$/;
export const HG_IMAGE_KINDS = ['open', 'cancel', 'puzzle', 'hint', 'reveal'];
const GROUP_ONLY = '🐢 海龜湯是群組遊戲，請到群組裡輸入 /haiguitang 或按選單的「🐢 海龜湯」開局。';
const MAX_MSG_IDS = 300;
/** 出題 timing: GPT (GPT-5.6 Sol, reasoning effort locked at 「高」) usually needs 35–140 s but sometimes thinks for 3–4 min.
 *  So a slow attempt is never thrown away: after pickHedgeMs a 2nd attempt starts in a fresh tab while the 1st keeps going,
 *  the first valid puzzle wins, and only after pickTimeoutMs in total the built-in bank is used. */
const PICK_HEDGE_MS = 150e3, PICK_TOTAL_MS = 300e3;

export function createHaiguitangFlow({ api, send, answer, log, now = () => Date.now(), tgStore = null, inGroup, inUserPrivate, splitText = (t) => [t], menuMarkup = () => null,
  interpreter = null, release = null, mode = 'all', random = Math.random, botUsername = () => '', imageDir = new URL('../assets/haiguitang/', import.meta.url),
  readFile = (u) => fs.readFileSync(u), statFile = (u) => fs.statSync(u), pickAttempts = 2, judgeAttempts = 2, pickHedgeMs = PICK_HEDGE_MS, pickTimeoutMs = PICK_TOTAL_MS, bank = HG_BANK, sceneImage = null }) {
  const saved = tgStore?.data.haiguitang || {};
  const games = new Map(Object.entries(saved.games || {}));
  let recentTitles = Array.isArray(saved.recentTitles) ? saved.recentTitles : [];
  const processing = new Map(); // game id -> pump promise (in memory)
  const picking = new Map(); // game id -> pick promise (in memory)
  const images = new Map(); let lastPhoto = false; let counter = Math.floor(Math.random() * 1296);
  const save = () => { if (!tgStore) return; tgStore.data.haiguitang = { games: Object.fromEntries(games), recentTitles }; tgStore.save(); };
  const current = (g) => games.get(String(g.chatId))?.id === g.id;
  const warn = (what, error) => log.warn(`haiguitang ${what}: ${error?.message || error}`);
  const quiet = (error) => /not modified|not found|can't be edited|message to edit/i.test(String(error?.description || error?.message));

  // images: assets/haiguitang/<kind>.jpg; bytes cached on path + mtime + size (replacing a file takes effect without a restart); missing → text only
  function image(kind) {
    const u = new URL(`${kind}.jpg`, imageDir);
    try {
      const st = statFile(u); const sig = `${st.mtimeMs}:${st.size}`; const key = String(u);
      const hit = images.get(key); if (hit && hit.sig === sig) return hit.img;
      const img = { buffer: readFile(u), mimeType: 'image/jpeg', fileName: `haiguitang-${kind}.jpg` }; images.set(key, { sig, img }); return img;
    } catch (error) { if (error?.code !== 'ENOENT') warn(`${kind} image unreadable`, error); return null; }
  }
  const track = (g, m) => { if (m?.message_id == null) return m; g.msgIds = [...(g.msgIds || []), m.message_id].slice(-MAX_MSG_IDS); return m; };
  const markup = (kb) => (kb?.length ? { reply_markup: { inline_keyboard: kb } } : {});
  /** Photo card with caption (falls back to text when the image is missing or the upload fails). Long text → photo + text messages. */
  async function card(g, kind, text, keyboard = [], extra = {}) {
    const img = image(kind);
    if (img && typeof api.sendPhoto === 'function') {
      try {
        lastPhoto = true;
        if (text.length <= 1024) return track(g, await api.sendPhoto({ chatId: g.chatId, ...img, caption: text, replyMarkup: keyboard.length ? { inline_keyboard: keyboard } : (extra.menu || undefined), replyToMessageId: extra.reply_to_message_id }));
        track(g, await api.sendPhoto({ chatId: g.chatId, ...img, caption: text.split('\n')[0], replyMarkup: extra.menu || undefined, replyToMessageId: extra.reply_to_message_id }));
        lastPhoto = false; return texts(g, text, keyboard, {});
      } catch (error) { warn(`${kind} photo failed, sending text instead`, error); }
    }
    lastPhoto = false;
    const { menu, ...rest } = extra;
    return texts(g, text, keyboard, menu ? { ...rest, reply_markup: menu } : rest);
  }
  async function texts(g, text, keyboard = [], extra = {}) {
    const chunks = splitText(text); let last = null;
    for (const [i, c] of chunks.entries()) last = track(g, await send(c, { ...(i === 0 ? extra : {}), ...(i === chunks.length - 1 ? markup(keyboard) : {}) }, g.chatId));
    return last;
  }
  const replyTo = (g, messageId, text, kb = []) => texts(g, text, kb, messageId ? { reply_to_message_id: messageId, allow_sending_without_reply: true } : {});
  async function editLobby(g, text, keyboard = []) {
    const body = { chat_id: g.chatId, message_id: g.lobbyMsgId, reply_markup: { inline_keyboard: keyboard } };
    try { await api.call(g.lobbyPhoto ? 'editMessageCaption' : 'editMessageText', g.lobbyPhoto ? { ...body, caption: text } : { ...body, text }); }
    catch (error) { if (!quiet(error)) warn('lobby edit failed', error); }
  }
  async function stripButtons(chatId, messageId) {
    if (messageId == null) return;
    try { await api.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }); }
    catch (error) { if (!quiet(error)) warn('strip buttons failed', error); }
  }

  /** Only the latest answer card stays: the new one is sent first, then the previous one is deleted (buttons stripped if it cannot be deleted). */
  async function rotateCard(g, m) {
    const prev = g.answerMsgId;
    if (m?.message_id == null) return;
    g.answerMsgId = m.message_id; save();
    if (prev == null || prev === m.message_id) return;
    try { await api.call('deleteMessage', { chat_id: g.chatId, message_id: prev }); }
    catch (error) { if (!quiet(error)) warn('old answer card delete failed', error); await stripButtons(g.chatId, prev); }
  }

  const alert = async (cq, text) => { try { await api.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: true }); } catch (error) { warn('callback alert failed', error); } };
  const dropMsg = async (chatId, messageId) => { if (messageId == null) return; try { await api.call('deleteMessage', { chat_id: chatId, message_id: messageId }); } catch (error) { if (!quiet(error)) warn('delete failed', error); } };

  // ---------- 情境圖 (scene image from the 湯面 only; never blocks or delays the game) ----------
  const scenes = new Map(); // game id -> promise (tests / shutdown only)
  async function postScene(g) {
    const t0 = Date.now();
    try {
      const img = await sceneImage(buildScenePrompt(g.puzzle), g);
      if (!img?.buffer) { log.info(`haiguitang ${g.id}: scene image skipped (no image)`); return null; }
      if (!current(g) || g.stage !== 'playing' || typeof api.sendPhoto !== 'function') return null;
      const m = track(g, await api.sendPhoto({ chatId: g.chatId, buffer: img.buffer, mimeType: img.mimeType || 'image/jpeg', fileName: img.fileName || 'haiguitang-scene.jpg', caption: '🖼 湯面情境圖', replyToMessageId: g.puzzleMsgId }));
      save(); log.info(`haiguitang ${g.id}: scene image posted after ${Math.round((Date.now() - t0) / 1000)} s${img.source ? ` (${img.source})` : ''}`);
      return m;
    } catch (error) { log.warn(`haiguitang ${g.id}: scene image skipped: ${error?.message || error}`); return null; }
  }

  // ---------- ❓ 繼續提問／猜答案: force-reply prompt for the clicker ----------
  async function askPrompt(g, from) {
    const uid = String(from.id); const old = g.askPrompts?.[uid];
    const { text, entities } = askPromptText(from);
    let m = null;
    try { m = track(g, await send(text, { ...(entities.length ? { entities } : {}), reply_markup: { force_reply: true, selective: true, input_field_placeholder: HG_ASK_PLACEHOLDER } }, g.chatId)); }
    catch (error) { warn('ask prompt failed', error); return { haiguiAskPromptFailed: true }; }
    if (m?.message_id != null) { g.askPrompts = { ...(g.askPrompts || {}), [uid]: m.message_id }; save(); }
    if (old != null && old !== m?.message_id) await dropMsg(g.chatId, old); // superseded by the new prompt
    return { haiguiAskPrompt: m?.message_id ?? null };
  }
  /** The clicker answered (or moved on): their prompt is no longer needed. */
  async function clearAskPrompt(g, userId, replyToId) {
    const prompts = g.askPrompts || {}; const ids = new Set();
    if (prompts[String(userId)] != null) ids.add(prompts[String(userId)]);
    if (replyToId != null && Object.values(prompts).includes(replyToId)) ids.add(replyToId);
    if (!ids.size) return;
    g.askPrompts = Object.fromEntries(Object.entries(prompts).filter(([, v]) => !ids.has(v))); save();
    for (const id of ids) await dropMsg(g.chatId, id);
  }

  // ---------- lobby ----------
  async function start(user, chat) {
    if (mode === 'operations') return { ignored: 'life feature' };
    if (inUserPrivate(chat, user)) { await send(GROUP_ONLY, {}, chat.id); return { haiguiGroupOnly: true }; }
    if (!inGroup(chat)) return { ignored: 'chat' };
    const existing = games.get(String(chat.id));
    if (existing) {
      const ref = existing.puzzleMsgId || existing.lobbyMsgId;
      await send(existing.stage === 'lobby' ? '🐢 已經有一局海龜湯在報名中，按上面的「🐢 我也要玩」加入吧！' : '🐢 這個群組已經有一局海龜湯在進行中，等這局結束再開新局喔。',
        ref ? { reply_to_message_id: ref, allow_sending_without_reply: true } : {}, chat.id);
      return { haiguiBusy: existing.id };
    }
    if (typeof interpreter !== 'function') { await send('⚠️ 海龜湯需要小精靈的 GPT 出題服務，目前沒有啟用。', {}, chat.id); return { haiguiUnavailable: true }; }
    const t = now();
    const id = `${t.toString(36)}${(++counter).toString(36)}`.slice(-16);
    const g = { id, chatId: chat.id, stage: 'lobby', createdAt: t, updatedAt: t, players: [{ id: user.id, name: userName(user) }], msgIds: [], queue: [], qa: [], guesses: [],
      hintsUsed: 0, surrender: [], seqNo: 0, theme: pickTheme(random) };
    games.set(String(chat.id), g); save();
    const m = await card(g, 'open', lobbyText(g, t), lobbyKeyboard(g));
    g.lobbyMsgId = m?.message_id ?? null; g.lobbyPhoto = lastPhoto; g.countdown = lobbyText(g, t); save();
    log.info(`haiguitang lobby opened ${id} by user ${user.id}`);
    return { haiguiLobby: id };
  }

  async function cancelLobby(g) {
    g.stage = 'ended'; games.delete(String(g.chatId)); save();
    const text = '🌫 海龜湯流局\n5 分鐘內沒有人按開始，也沒有其他人加入，這鍋湯先收起來了。\n想玩再輸入 /haiguitang 開一局 🐢';
    const img = image('cancel'); let done = false;
    if (g.lobbyPhoto && img && typeof api.editMessageMedia === 'function') {
      try { await api.editMessageMedia({ chatId: g.chatId, messageId: g.lobbyMsgId, ...img, caption: text, replyMarkup: { inline_keyboard: [] } }); done = true; }
      catch (error) { warn('cancel image edit failed', error); }
    }
    if (!done) await editLobby(g, text, []);
    log.info(`haiguitang lobby ${g.id} cancelled (not started, nobody joined)`);
    return { haiguiCancelled: g.id };
  }

  async function begin(g, how) {
    if (g.stage !== 'lobby') return { invalid: true };
    g.stage = 'picking'; g.updatedAt = now(); save();
    const names = g.players.map((p) => p.name).join('、');
    await editLobby(g, `🐢 海龜湯報名截止${how === 'auto' ? '（10 分鐘到，自動開始）' : ''}\n👥 共 ${g.players.length} 人：${names}`, []);
    const m = await texts(g, HG_PICKING_TEXT);
    g.pickingMsgId = m?.message_id ?? null; save();
    return { haiguiStarted: g.id, how, completion: schedulePick(g) };
  }

  // ---------- 出題 ----------
  function schedulePick(g) {
    if (picking.has(g.id)) return picking.get(g.id);
    const p = pick(g).catch((error) => { warn('pick crashed', error); return { haiguiPickFailed: true }; }).finally(() => picking.delete(g.id));
    picking.set(g.id, p); return p;
  }
  /** Built-in puzzle (not one of the recent titles) for when GPT cannot 出題 — a game is never cancelled just because GPT is slow. */
  function bankPuzzle() {
    const pool = (bank || []).filter((p) => !recentTitles.includes(p.title)); const list = pool.length ? pool : (bank || []);
    if (!list.length) return null;
    return structuredClone(list[Math.min(list.length - 1, Math.floor(random() * list.length))]);
  }
  /** Run up to pickAttempts GPT 出題 attempts, overlapping (see PICK_HEDGE_MS); resolves the first valid puzzle or null. */
  function racePuzzle(g, prompt) {
    return new Promise((resolve) => {
      let started = 0, running = 0, done = false, lastError = null; const timers = [];
      const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); timers.push(t); };
      const finish = (puzzle, attempt) => {
        if (done) return; done = true; timers.forEach(clearTimeout);
        // the client of this game now belongs to the newest attempt: if it is still busy (lost the race / total cap), drop it so judging starts on a fresh tab
        if (running > 0 && (!puzzle || attempt < started)) { try { release?.(g); } catch (e) { warn('release failed', e); } }
        resolve({ puzzle, attempt, lastError });
      };
      const launch = (why) => {
        if (done || started >= pickAttempts || !current(g)) return;
        const n = ++started; running++;
        if (n > 1) {
          try { release?.(g); } catch (e) { warn('release failed', e); } // detach the busy/failed client → this attempt gets a fresh GPT tab; a slow one keeps running on its own
          void api.call('editMessageText', { chat_id: g.chatId, message_id: g.pickingMsgId, text: why === 'slow' ? '🐢 小精靈這題想得比較久，正在同時重新挑題，請再稍等一下...' : '🐢 小精靈第一次出題卡住了，正在重新挑題，請再稍等一下...' })
            .catch((e) => { if (!quiet(e)) warn('picking edit failed', e); });
        }
        const t0 = Date.now();
        Promise.resolve().then(() => interpreter(prompt, g)).then(parsePuzzle).then(
          (p) => { running--; const secs = Math.round((Date.now() - t0) / 1000);
            if (done) log.info(`haiguitang ${g.id}: puzzle attempt ${n} finished late (${secs} s), ignored`);
            else { if (n > 1 || Date.now() - t0 > pickHedgeMs) log.info(`haiguitang ${g.id}: puzzle attempt ${n} ok after ${secs} s`); finish(p, n); } },
          (e) => { running--; if (done) return; lastError = e; warn(`puzzle attempt ${n} failed`, e); if (started < pickAttempts) launch('failed'); else if (!running) finish(null, n); });
        later(() => { if (!done && started === n && started < pickAttempts) { log.warn(`haiguitang ${g.id}: puzzle attempt ${n} still running after ${Math.round(pickHedgeMs / 1000)} s; starting attempt ${n + 1} in a fresh tab (attempt ${n} keeps going)`); launch('slow'); } }, pickHedgeMs);
      };
      later(() => { lastError = new Error(`GPT 出題超過 ${Math.round(pickTimeoutMs / 1000)} 秒沒有完成`); log.warn(`haiguitang ${g.id}: ${lastError.message}`); finish(null, started); }, pickTimeoutMs);
      launch('first');
    });
  }
  async function pick(g) {
    let fromBank = false;
    const { puzzle, lastError } = await racePuzzle(g, buildPuzzlePrompt({ theme: g.theme, avoidTitles: recentTitles.slice(-10) }));
    if (puzzle) g.puzzle = puzzle;
    if (!current(g)) return { stale: true };
    if (!g.puzzle) {
      g.puzzle = bankPuzzle(); fromBank = Boolean(g.puzzle);
      if (fromBank) log.warn(`haiguitang ${g.id}: GPT puzzle failed (${lastError?.message}); using built-in puzzle 「${g.puzzle.title}」`);
    }
    if (!g.puzzle) {
      g.stage = 'ended'; games.delete(String(g.chatId)); save(); release?.(g);
      await texts(g, '⚠️ 小精靈這次出不了題（GPT 暫時沒有回應），這局先取消。\n請稍後再輸入 /haiguitang 開一局 🙏');
      log.warn(`haiguitang ${g.id} cancelled: puzzle failed (${lastError?.message})`);
      return { haiguiPickFailed: true };
    }
    const t = now();
    g.stage = 'playing'; g.startedAt = t; g.deadline = t + HG_GAME_MS; g.lastActivityAt = t; g.updatedAt = t;
    recentTitles = [...recentTitles, g.puzzle.title].slice(-20); save();
    try { await api.call('editMessageText', { chat_id: g.chatId, message_id: g.pickingMsgId, text: fromBank ? `🐢 GPT 這次出題太慢，小精靈改從題庫挑了一題：「${g.puzzle.title}」，開始推理吧！` : `🐢 題目選好了：「${g.puzzle.title}」，開始推理吧！` }); } catch (e) { if (!quiet(e)) warn('picking edit failed', e); }
    const m = await card(g, 'puzzle', puzzleText(g), surrenderKeyboard(g));
    g.puzzleMsgId = m?.message_id ?? null; save();
    if (typeof sceneImage === 'function') scenes.set(g.id, postScene(g).finally(() => scenes.delete(g.id))); // never awaited: the game goes on without it
    log.info(`haiguitang ${g.id} playing: ${g.players.length} players${fromBank ? ' (built-in puzzle)' : ''}`);
    return { haiguiPlaying: g.id, ...(fromBank ? { fromBank: true } : {}) };
  }

  // ---------- 提問 / 我猜 ----------
  async function onMessage(msg, text) {
    if (isHaiguiStart(text, botUsername())) return start(msg.from, msg.chat);
    if (mode === 'operations' || !inGroup(msg.chat)) return null;
    const g = games.get(String(msg.chat.id));
    if (!g || g.stage === 'lobby' || g.stage === 'ended') return null;
    const rt = msg.reply_to_message;
    const engaged = (rt && (g.msgIds || []).includes(rt.message_id)) || isGuessText(text);
    if (!engaged) return null;
    if (!g.players.some((p) => String(p.id) === String(msg.from?.id))) return { ignored: 'not haiguitang player' };
    if (!text) return { ignored: 'empty' };
    await clearAskPrompt(g, msg.from.id, rt?.message_id);
    if (g.stage === 'picking') { await replyTo(g, msg.message_id, '🐢 題目還在準備中，請稍等一下再問 🙏'); return { haiguiNotReady: true }; }
    const t = now();
    if (t >= g.deadline) { await replyTo(g, msg.message_id, '⏰ 時間到了，小精靈正在揭曉湯底…'); return { haiguiTimeUp: true }; }
    const guess = isGuessText(text); const body = (guess ? stripGuess(text) : text).slice(0, 200);
    if (!body) { await replyTo(g, msg.message_id, '請在「我猜：」後面寫下你的推理 🐢'); return { ignored: 'empty guess' }; }
    if (g.queue.filter((x) => String(x.userId) === String(msg.from.id)).length >= HG_MAX_PENDING_PER_USER) {
      await replyTo(g, msg.message_id, '🐢 你還有問題在排隊，等小精靈回答完再問喔'); return { haiguiRateLimited: true };
    }
    const item = { id: ++g.seqNo, kind: guess ? 'g' : 'q', text: body, userId: msg.from.id, name: userName(msg.from), msgId: msg.message_id, at: t };
    g.queue.push(item); g.lastActivityAt = t; g.updatedAt = t; save();
    try { await api.call('setMessageReaction', { chat_id: g.chatId, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '👀' }] }); } catch { /* reactions are optional */ }
    return { haiguiQueued: item.id, kind: item.kind, completion: pump(g) };
  }

  function pump(g) {
    if (processing.has(g.id)) return processing.get(g.id);
    const p = (async () => {
      while (current(g) && g.stage === 'playing' && g.queue.length) await judgeBatch(g, g.queue.slice(0, HG_BATCH));
      if (current(g) && g.stage === 'playing' && now() >= g.deadline) await endGame(g, 'timeout');
    })().catch((error) => warn('judge loop crashed', error)).finally(() => processing.delete(g.id));
    processing.set(g.id, p); return p;
  }
  async function judgeBatch(g, items) {
    let results = null; let lastError = null;
    try { await api.call('sendChatAction', { chat_id: g.chatId, action: 'typing' }); } catch { /* optional */ }
    for (let attempt = 1; attempt <= judgeAttempts && !results; attempt++) {
      try { results = parseJudge(await interpreter(buildJudgePrompt(g, items), g), items); }
      catch (error) { lastError = error; warn(`judge attempt ${attempt} failed`, error); }
      if (!current(g) || g.stage !== 'playing') return;
    }
    const done = new Set(items.map((x) => x.id));
    g.queue = g.queue.filter((x) => !done.has(x.id)); save();
    if (!results) {
      log.warn(`haiguitang ${g.id}: ${items.length} item(s) not judged (${lastError?.message})`);
      for (const x of items) await replyTo(g, x.msgId, `⚠️ ${x.name}，小精靈剛剛沒聽清楚（GPT 暫時沒有回應），這題請再問一次 🙏`);
      return;
    }
    for (const [i, x] of items.entries()) {
      if (!current(g) || g.stage !== 'playing') return;
      const r = results[i];
      if (!r) { await replyTo(g, x.msgId, `⚠️ ${x.name}，小精靈沒判斷出來，請換個說法再問一次 🙏`); continue; }
      if (x.kind === 'g') {
        g.guesses.push({ userId: x.userId, name: x.name, text: x.text, verdict: r.verdict, ...(r.feedback ? { feedback: r.feedback } : {}), at: now() }); save();
        if (r.verdict === '猜中') { g.solvedBy = { id: x.userId, name: x.name, text: x.text }; await replyTo(g, x.msgId, `🎯 ${x.name} 猜：${x.text}\n${HG_VERDICTS['猜中']}`); await endGame(g, 'solved'); return; }
        await rotateCard(g, await replyTo(g, x.msgId, answerCardText(g, { kind: 'g', name: x.name, text: x.text, verdict: r.verdict, feedback: r.feedback }, now()), answerKeyboard(g)));
        continue;
      }
      const n = g.qa.length + 1;
      g.qa.push({ n, userId: x.userId, name: x.name, q: x.text, a: r.answer, key: r.key }); save();
      await rotateCard(g, await replyTo(g, x.msgId, answerCardText(g, { kind: 'q', n, name: x.name, q: x.text, a: r.answer }, now()), answerKeyboard(g)));
      if (g.qa.length % HG_CLUE_EVERY === 0) await texts(g, cluesText(g, now()));
    }
  }

  // ---------- 提示 / 結束 ----------
  async function giveHint(g) {
    const hint = g.puzzle.hints[g.hintsUsed]; if (!hint) return;
    g.hintsUsed++; g.lastActivityAt = now(); g.lastHintAt = g.lastActivityAt; save();
    await card(g, 'hint', `💡 提示 ${g.hintsUsed}/${HG_MAX_HINTS}\n${hint}\n\n（回覆這則訊息繼續提問，或以「我猜：」猜答案）`);
    return { haiguiHint: g.hintsUsed };
  }
  async function endGame(g, reason) {
    if (g.stage !== 'playing') return { invalid: true };
    const t = now(); g.stage = 'ended'; g.endedAt = t; games.delete(String(g.chatId)); save();
    await stripButtons(g.chatId, g.puzzleMsgId);
    await stripButtons(g.chatId, g.answerMsgId);
    for (const id of Object.values(g.askPrompts || {})) await dropMsg(g.chatId, id);
    g.askPrompts = {};
    // the ❓ force-reply prompts replace players' reply keyboard (下方按鈕); the reveal card (sent anyway) brings it back — no extra message
    let menu = null; try { menu = menuMarkup(g.chatId) || null; } catch (error) { warn('menu keyboard unavailable', error); }
    await card(g, 'reveal', endingText(g, reason, t), [], menu ? { menu } : {});
    try { release?.(g); } catch (error) { warn('release failed', error); }
    log.info(`haiguitang ${g.id} ended: ${reason}, ${g.qa.length} questions, ${g.guesses.length} guesses, hints ${g.hintsUsed}`);
    return { haiguiEnded: reason };
  }

  async function onCallback(cq, action, gid) {
    const chat = cq.message?.chat;
    if (mode === 'operations') { await answer(cq, '海龜湯請找小精靈。'); return { denied: true }; }
    if (action === 'n') {
      if (inUserPrivate(chat, cq.from)) { await answer(cq, '海龜湯是群組遊戲'); await send(GROUP_ONLY, {}, chat.id); return { haiguiGroupOnly: true }; }
      if (!inGroup(chat)) { await answer(cq); return { ignored: 'chat' }; }
      await answer(cq); return start(cq.from, chat);
    }
    if (!inGroup(chat)) { await answer(cq); return { ignored: 'chat' }; }
    const g = games.get(String(chat.id));
    if (!g || g.id !== gid) { await answer(cq, '這局海龜湯已經結束了'); await stripButtons(chat.id, cq.message?.message_id); return { stale: true }; }
    const isPlayer = g.players.some((p) => String(p.id) === String(cq.from.id));
    if (action === 'j') {
      if (g.stage !== 'lobby') { await answer(cq, '這局已經開始了，下一局早點報名喔 🐢'); return { invalid: true }; }
      if (isPlayer) { await answer(cq, '你已經報名了 🐢'); return { haiguiAlreadyJoined: true }; }
      if (g.players.length >= HG_MAX_PLAYERS) { await answer(cq, '已額滿（最多 10 人）'); return { haiguiFull: true }; }
      g.players.push({ id: cq.from.id, name: userName(cq.from) }); g.updatedAt = now(); save();
      await answer(cq, `報名成功！目前 ${g.players.length}/${HG_MAX_PLAYERS} 人`);
      g.countdown = lobbyText(g, now()); await editLobby(g, g.countdown, lobbyKeyboard(g));
      return { haiguiJoined: g.players.length };
    }
    if (action === 's') {
      if (g.stage !== 'lobby') { await answer(cq, '遊戲已經開始了'); return { invalid: true }; }
      if (String(g.players[0].id) !== String(cq.from.id)) { await answer(cq, '只有發起人可以開始遊戲'); return { denied: true }; }
      if (g.players.length < HG_MIN_PLAYERS) { await answer(cq, '還沒有玩家報名喔'); return { haiguiNeedPlayers: true }; }
      await answer(cq, '開始囉！'); return begin(g, 'manual');
    }
    if (action === 'g') {
      if (g.stage !== 'playing') { await answer(cq, '現在還不能投降'); return { invalid: true }; }
      if (!isPlayer) { await answer(cq, '你沒有報名這一局喔'); return { denied: true }; }
      const me = String(cq.from.id); const had = g.surrender.includes(me);
      g.surrender = had ? g.surrender.filter((x) => x !== me) : [...g.surrender, me]; save();
      if (g.surrender.length >= g.players.length) { await answer(cq, '全員投降，揭曉湯底！'); return endGame(g, 'surrender'); }
      await answer(cq, had ? '已取消投降' : `已投降（${g.surrender.length}/${g.players.length}），全員投降才會揭曉`);
      try { await api.call('editMessageReplyMarkup', { chat_id: g.chatId, message_id: g.puzzleMsgId, reply_markup: { inline_keyboard: surrenderKeyboard(g) } }); } catch (error) { if (!quiet(error)) warn('surrender button edit failed', error); }
      return { haiguiSurrender: g.surrender.length };
    }
    if (action === 'h' || action === 'a') {
      if (!isPlayer) { await answer(cq, '你沒有報名這一局喔'); return { denied: true }; }
      if (g.stage !== 'playing') { await answer(cq, '題目還在準備中，請稍等一下'); return { invalid: true }; }
      const t = now();
      if (t >= g.deadline) { await answer(cq, '⏰ 時間到了，小精靈正在揭曉湯底…'); return { haiguiTimeUp: true }; }
      if (action === 'a') {
        await answer(cq); // quietly: the force-reply prompt below opens the reply box on the clicker's Telegram
        return askPrompt(g, cq.from);
      }
      if (g.hintsUsed >= HG_MAX_HINTS || !g.puzzle?.hints?.[g.hintsUsed]) { await alert(cq, `💡 提示已用完（${g.hintsUsed}/${HG_MAX_HINTS}）`); return { haiguiNoHint: true }; }
      const wait = (g.lastHintAt || 0) + HG_HINT_COOLDOWN_MS - t;
      if (wait > 0) { await alert(cq, `⏳ 提示冷卻中，請 ${Math.ceil(wait / 1000)} 秒後再按`); return { haiguiHintCooldown: Math.ceil(wait / 1000) }; }
      const p = giveHint(g); // counts the hint synchronously, so a double tap cannot take two
      await answer(cq, `💡 第 ${g.hintsUsed}/${HG_MAX_HINTS} 個提示來了`);
      return p;
    }
    await answer(cq); return { ignored: 'haiguitang action' };
  }

  /** Timers: 5-min 流局 (initiator alone, never pressed start), 10-min auto start, lobby countdown, 3-min idle hints, 20-min timeout. Call periodically (and after a restart). */
  async function tick() {
    const out = [];
    for (const g of [...games.values()]) {
      try {
        const t = now();
        if (g.stage === 'lobby') {
          const others = g.players.length - 1;
          if (others === 0 && t - g.createdAt >= HG_LOBBY_CANCEL_MS) out.push(await cancelLobby(g));
          else if (others > 0 && t - g.createdAt >= HG_LOBBY_AUTOSTART_MS) out.push(await begin(g, 'auto'));
          else { const text = lobbyText(g, t); if (text !== g.countdown) { g.countdown = text; save(); await editLobby(g, text, lobbyKeyboard(g)); } }
        } else if (g.stage === 'playing') {
          const busy = processing.has(g.id) || g.queue.length > 0;
          if (t >= g.deadline && (!busy || t >= g.deadline + HG_GRACE_MS)) out.push(await endGame(g, 'timeout'));
          else if (!busy && t < g.deadline && g.hintsUsed < HG_MAX_HINTS && t - (g.lastActivityAt || g.startedAt) >= HG_HINT_IDLE_MS) out.push(await giveHint(g));
        }
      } catch (error) { warn('tick failed', error); }
    }
    return out;
  }
  /** After a restart: resume 出題 / queued questions; timers catch up on the next tick. */
  async function recover() {
    const jobs = [];
    for (const g of games.values()) {
      if (g.stage === 'picking') { log.info(`haiguitang ${g.id}: resuming puzzle pick after restart`); jobs.push(schedulePick(g)); }
      else if (g.stage === 'playing' && g.queue.length) { log.info(`haiguitang ${g.id}: resuming ${g.queue.length} queued item(s) after restart`); jobs.push(pump(g)); }
    }
    await Promise.all(jobs);
    return tick();
  }
  return { start, onMessage, onCallback, tick, recover, game: (chatId) => games.get(String(chatId)) || null, sceneDone: (id) => scenes.get(id) ?? Promise.resolve(null) };
}
