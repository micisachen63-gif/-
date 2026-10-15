// 🔐 千鎖秘藏 (safe-crack) core: pure game logic + Traditional Chinese texts, no I/O, no AI.
// Shared by 小精靈 (src/safe-crack-flow.js) and, later, 小遊戲精靈 (src/community/). State is a plain JSON object (persistable).
// Each round: a random 4-digit code with no repeated digits (leading 0 allowed); players guess, get xAyB; first exact guess wins the round.
// A round winner cannot guess in later rounds of the same game; the optional daily ledger (Asia/Taipei day) extends that to the whole day.

export const SC_NAME = '千鎖秘藏';
export const SC_CODE_LEN = 4;
export const SC_COOLDOWN_MS = 15e3; // one guess per player every 15 s
export const SC_ROUND_MS = 10 * 60e3; // nobody cracks it in 10 min → reveal, next round
export const SC_RECENT = 10; // recent guesses shown on the round message
export const SC_LOBBY_MS = 3 * 60e3; // short signup: auto start (or 流局 when the starter is alone)
export const SC_MAX_ROUNDS = 20;
export const SC_DEFAULT_ROUNDS = 3;
export const SC_ROUND_CHOICES = [1, 3, 5, 10];
export const SC_MAX_PLAYERS = 200;
export const SC_COVER = 'assets/safe/cover.jpg'; // relative to the project root (both bots)
const KEEP_GUESSES = 30;

export const userName = (u = {}) => String([u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : '') || `玩家${String(u.id ?? '').slice(-4)}`).slice(0, 24);
export const hhmm = (ms) => { const d = new Date(ms + 8 * 3600e3); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
export const dayKey = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10); // Asia/Taipei calendar day
export const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`; };
export const clampRounds = (n) => Math.min(SC_MAX_ROUNDS, Math.max(1, Math.floor(Number(n)) || SC_DEFAULT_ROUNDS));
const same = (a, b) => String(a) === String(b);

/** 4 distinct digits, leading 0 allowed (Fisher–Yates over 0-9). */
export function generateCode(random = Math.random) {
  const d = [...'0123456789'];
  for (let i = d.length - 1; i > 0; i--) { const j = Math.min(i, Math.floor(random() * (i + 1))); [d[i], d[j]] = [d[j], d[i]]; }
  return d.slice(0, SC_CODE_LEN).join('');
}

/** null = not a guess attempt (chatter); { guess } = valid; { error: 'length' | 'repeat' } = looks like an attempt but invalid. */
export function parseGuess(text, { strict = false } = {}) {
  const raw = String(text ?? '').trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!/^[\d\s-]+$/.test(raw)) return strict ? { error: 'length', text: raw.slice(0, 20) } : null;
  const t = raw.replace(/[\s-]/g, '');
  if (!strict && (t.length < 4 || t.length > 10)) return null;
  if (t.length !== SC_CODE_LEN) return { error: 'length', text: t };
  if (new Set(t).size !== SC_CODE_LEN) return { error: 'repeat', text: t };
  return { guess: t };
}

export function score(code, guess) {
  let a = 0, b = 0;
  for (let i = 0; i < guess.length; i++) { if (guess[i] === code[i]) a++; else if (code.includes(guess[i])) b++; }
  return { a, b };
}
export const abText = ({ a, b }) => `${a}A${b}B`;

// ---------- daily winners ledger (community port: a round winner sits out for the rest of the Taipei day) ----------
export const createLedger = () => ({ day: null, winners: [] });
export const ledgerHas = (ledger, userId, now) => Boolean(ledger && ledger.day === dayKey(now) && ledger.winners.some((id) => same(id, userId)));
export function ledgerAdd(ledger, userId, now) {
  const day = dayKey(now);
  if (ledger.day !== day) { ledger.day = day; ledger.winners = []; }
  if (!ledger.winners.some((id) => same(id, userId))) ledger.winners.push(userId);
  return ledger;
}

// ---------- game state ----------
export function newGame({ id, chatId, host, rounds = SC_DEFAULT_ROUNDS, now }) {
  return { id, chatId, hostId: host.id, hostName: userName(host), stage: 'lobby', rounds: clampRounds(rounds), createdAt: now, updatedAt: now,
    players: [{ id: host.id, name: userName(host), joinedAt: now, lastGuessAt: 0, guesses: 0 }], round: 0, current: null, history: [], winners: [], endedAt: null, endReason: null };
}
export const playerOf = (g, userId) => g.players.find((p) => same(p.id, userId)) || null;
export const isWinner = (g, userId) => g.winners.some((id) => same(id, userId));
export const setRounds = (g, n) => { if (g.stage === 'lobby') g.rounds = clampRounds(n); return g.rounds; };

export function addPlayer(g, user, now) {
  if (g.stage !== 'lobby' && g.stage !== 'playing') return { closed: true };
  const p = playerOf(g, user.id); if (p) return { already: true, player: p };
  if (g.players.length >= SC_MAX_PLAYERS) return { full: true };
  const player = { id: user.id, name: userName(user), joinedAt: now, lastGuessAt: 0, guesses: 0 };
  g.players.push(player); g.updatedAt = now;
  return { joined: true, player };
}
export function removePlayer(g, userId) {
  if (g.stage !== 'lobby') return { closed: true };
  if (same(userId, g.hostId)) return { host: true };
  const i = g.players.findIndex((p) => same(p.id, userId)); if (i < 0) return { notJoined: true };
  g.players.splice(i, 1); return { left: true };
}
/** players that may still guess (not a winner of this game, nor of today when a ledger is given) */
export const eligible = (g, { ledger = null, now = 0 } = {}) => g.players.filter((p) => !isWinner(g, p.id) && !ledgerHas(ledger, p.id, now));

export function startRound(g, now, random = Math.random) {
  g.round += 1;
  g.current = { no: g.round, code: generateCode(random), startedAt: now, deadline: now + SC_ROUND_MS, guesses: [], total: 0, msgId: null };
  g.updatedAt = now; return g.current;
}
export function startGame(g, now, random = Math.random) {
  if (g.stage !== 'lobby') return null;
  g.stage = 'playing'; g.startedAt = now; return startRound(g, now, random);
}

/** May this user guess right now? (checked when the 🔢 button is tapped) → { ok, player, joined } | { kind: notPlayer | lockedOut | dailyLockedOut | cooldown, waitMs? } */
export function canGuess(g, user, now, { autoJoin = false, ledger = null } = {}) {
  if (g.stage !== 'playing' || !g.current) return { kind: 'closed' };
  let player = playerOf(g, user.id), joined = false;
  if (!player && autoJoin) { const r = addPlayer(g, user, now); player = r.player || null; joined = Boolean(r.joined); }
  if (!player) return { kind: 'notPlayer', name: userName(user) };
  if (isWinner(g, player.id)) return { kind: 'lockedOut', player };
  if (ledgerHas(ledger, player.id, now)) return { kind: 'dailyLockedOut', player };
  const wait = player.lastGuessAt + SC_COOLDOWN_MS - now;
  if (wait > 0) return { kind: 'cooldown', waitMs: wait, player };
  return { ok: true, player, joined };
}

/** Returns null when the text is not a guess attempt (or no round is running). kind: notPlayer | lockedOut | dailyLockedOut | invalid | cooldown | scored | cracked */
export function submitGuess(g, user, text, now, { autoJoin = false, ledger = null, strict = false } = {}) {
  if (g.stage !== 'playing' || !g.current) return null;
  const parsed = parseGuess(text, { strict }); if (!parsed) return null;
  let player = playerOf(g, user.id), joined = false;
  if (!player && autoJoin) { const r = addPlayer(g, user, now); player = r.player || null; joined = Boolean(r.joined); }
  if (!player) return { kind: 'notPlayer', name: userName(user) };
  if (isWinner(g, player.id)) return { kind: 'lockedOut', player };
  if (ledgerHas(ledger, player.id, now)) return { kind: 'dailyLockedOut', player };
  if (parsed.error) return { kind: 'invalid', error: parsed.error, player, joined };
  const wait = player.lastGuessAt + SC_COOLDOWN_MS - now;
  if (wait > 0) return { kind: 'cooldown', waitMs: wait, player };
  player.lastGuessAt = now; player.guesses += 1;
  const c = g.current; const s = score(c.code, parsed.guess);
  const entry = { userId: player.id, name: player.name, guess: parsed.guess, a: s.a, b: s.b, at: now };
  c.guesses = [...c.guesses, entry].slice(-KEEP_GUESSES); c.total += 1; g.updatedAt = now;
  if (s.a === SC_CODE_LEN) {
    const record = closeRound(g, now, entry);
    if (ledger) ledgerAdd(ledger, player.id, now);
    return { kind: 'cracked', entry, record, player, joined };
  }
  return { kind: 'scored', entry, player, joined };
}

export function closeRound(g, now, winnerEntry = null, how = winnerEntry ? 'cracked' : 'timeout') {
  const c = g.current; if (!c) return null;
  const record = { no: c.no, code: c.code, cracked: Boolean(winnerEntry), how, winnerId: winnerEntry?.userId ?? null, winnerName: winnerEntry?.name ?? null, guesses: c.total, ms: now - c.startedAt, msgId: c.msgId };
  g.history.push(record); if (winnerEntry) g.winners.push(winnerEntry.userId);
  g.current = null; g.updatedAt = now; return record;
}
/** round time is up → the closed (timeout) record, else null */
export const checkTimeout = (g, now) => (g.stage === 'playing' && g.current && now >= g.current.deadline ? closeRound(g, now) : null);

/** after a round closed: start the next one, or end the game ('done' after the last round, 'noPlayers' when everyone has already won) */
export function advance(g, now, random = Math.random, { ledger = null } = {}) {
  if (g.stage !== 'playing') return { end: g.endReason };
  if (g.round >= g.rounds) { finish(g, 'done', now); return { end: 'done' }; }
  if (!eligible(g, { ledger, now }).length) { finish(g, 'noPlayers', now); return { end: 'noPlayers' }; }
  return { round: startRound(g, now, random) };
}
export function finish(g, reason, now) { g.stage = 'ended'; g.endReason = reason; g.endedAt = now; g.updatedAt = now; return g; }
export function abort(g, now) {
  const record = g.current ? closeRound(g, now, null, 'aborted') : null;
  finish(g, g.stage === 'lobby' ? 'cancelled' : 'aborted', now); return record;
}
export const crackedRounds = (g) => g.history.filter((r) => r.cracked);

// ---------- texts (callback prefix is a parameter so each bot keeps its own namespace) ----------
export const secondsLeft = (g, now) => Math.max(0, Math.ceil(((g.current?.deadline ?? now) - now) / 1000));
export const timerLine = (g, now) => `⏳ 剩餘 ${secondsLeft(g, now)} 秒可破解，否則寶箱將自毀！`;
export const RULES = `📜 玩法\n• 每輪寶箱會鎖上一組 ${SC_CODE_LEN} 位數密碼，數字不重複（可以 0 開頭）\n• 按「🔢 輸入密碼」→ 回覆小精靈的提示輸入 ${SC_CODE_LEN} 位數字，每人 ${SC_COOLDOWN_MS / 1000} 秒只能猜一次\n• 小精靈用「幾A幾B」回應：A＝數字和位置都對，B＝數字對但位置不對\n• 最先猜中的人破解這一輪 🏆，之後的輪次就把機會讓給別人\n• ${SC_ROUND_MS / 60e3} 分鐘沒人破解，寶箱就會自毀 💥 公布密碼、進下一輪（沒有提示）`;

export const SC_STORY_FILE = 'assets/safe/story.txt'; // editable opening story; {rounds} is replaced with the round count
export const SC_STORY = '🔐【千鎖秘藏】\n\n傳說千年前，一位工匠用畢生心血打造了一只寶匣，將連城的財寶封進其中。他在臨終前留下一句話：「唯有智者，配開此鎖。」\n\n今夜，寶匣在古堡地窖深處重見天日。燭光搖曳，四個銅輪靜靜等待著正確的數字——每個數字只出現一次。\n\n但工匠也設下了機關：鎖一旦被喚醒，十分鐘內無人破解，寶匣便會自毀，財寶永遠沉入黑暗。\n\n今夜共有 {rounds} 只寶匣等待喚醒。每次嘗試，鎖匠的亡靈都會低語提示：\nA＝數字和位置都對\nB＝數字對、位置不對\n\n探險者們，報上名來吧。第一個讓鎖匠點頭的人，寶匣就是你的。';
export const storyText = (g, story = SC_STORY) => String(story || SC_STORY).trim().replaceAll('{rounds}', String(g.rounds));
const CAPTION_MAX = 1024;
/** signup card (photo caption, kept ≤ 1024 chars: the roster shrinks first) */
export function lobbyText(g, now, { story = SC_STORY, extra = '' } = {}) {
  const left = Math.max(1, Math.ceil((g.createdAt + SC_LOBBY_MS - now) / 60e3));
  const timer = g.players.length > 1 ? `⏳ ${left} 分鐘後自動開始` : `⏳ ${left} 分鐘內沒人加入、發起人也沒按開始就流局`;
  const how = `🎯 本局 ${g.rounds} 輪｜開局後按「🔢 輸入密碼」回覆 ${SC_CODE_LEN} 位數字，每人 ${SC_COOLDOWN_MS / 1000} 秒一次（開局後也能直接加入）`;
  const build = (roster) => [storyText(g, story), how, extra, `👥 已報名 ${g.players.length} 人：${roster}`, `${timer}；一個人也能開始。`].filter(Boolean).join('\n\n');
  const names = g.players.map((p) => `${p.name}${same(p.id, g.hostId) ? '（發起人）' : ''}`);
  for (let n = names.length; n >= 0; n--) {
    const text = build(n === names.length ? names.join('、') : `${names.slice(0, n).join('、')}${n ? '…' : ''}等 ${names.length} 人`);
    if (text.length <= CAPTION_MAX) return text;
  }
  return build('').slice(0, CAPTION_MAX);
}
export function lobbyKeyboard(g, prefix = 'sc') {
  return [
    [{ text: '🙋 我要參加', callback_data: `${prefix}:j:${g.id}` }, { text: '🚪 退出', callback_data: `${prefix}:l:${g.id}` }],
    SC_ROUND_CHOICES.map((n) => ({ text: `${g.rounds === n ? '✅ ' : ''}${n} 輪`, callback_data: `${prefix}:r:${g.id}:${n}` })),
    [{ text: '▶️ 開始破解（發起人）', callback_data: `${prefix}:s:${g.id}` }],
    [{ text: '🛑 取消', callback_data: `${prefix}:x:${g.id}` }],
  ];
}
export const lobbyClosedText = (g, auto = false) => `🔐 ${SC_NAME}｜報名截止${auto ? '（時間到，自動開始）' : ''}\n🎯 共 ${g.rounds} 輪｜👥 ${g.players.length} 人：${g.players.map((p) => p.name).join('、')}\n\n寶箱的封印緩緩鬆動……第 1 道鎖出現了 👇`;
export const lobbyCancelledText = (g, why = '沒有人加入，發起人也沒有按開始') => `🌫 ${SC_NAME}流局\n${why}，寶箱又沉回了地底。\n想玩再輸入 /baoxianxiang 開一局 🔐`;

/** the round message: re-sent after every guess (latest one carries the 🔢 button); `last` = the guess this message answers */
export function roundText(g, now, { last = null, ledger = null } = {}) {
  const c = g.current; if (!c) return '';
  const locked = g.players.filter((p) => isWinner(g, p.id) || ledgerHas(ledger, p.id, now)).map((p) => p.name);
  const recent = c.guesses.slice(-SC_RECENT).reverse().map((e) => `${e.name}｜${e.guess}｜${abText(e)}`);
  const head = last ? `🙋 ${last.name} 輸入 ${last.guess} → ${last.a}A${last.b}B${last.a >= SC_CODE_LEN - 2 ? ' 🔥 快開了！' : ''}` : `🆕 新的一道鎖出現了！${SC_CODE_LEN} 位數字、不重複（可 0 開頭）`;
  return [`🔐 ${SC_NAME}｜第 ${c.no}/${g.rounds} 道鎖`, head, timerLine(g, now),
    `📜 最近猜測（共 ${c.total} 次）\n${recent.length ? recent.join('\n') : '（還沒有人出手，搶頭香吧！）'}`,
    `👉 按「🔢 輸入密碼」來猜，每人 ${SC_COOLDOWN_MS / 1000} 秒一次｜A＝數字位置都對，B＝數字對位置錯${locked.length ? `\n🏆 已破解過（本局不能再猜）：${locked.join('、')}` : ''}`].join('\n\n');
}
export const roundKeyboard = (g, prefix = 'sc') => [[{ text: '🔢 輸入密碼', callback_data: `${prefix}:g:${g.id}` }], [{ text: '🛑 中止遊戲（發起人／管理員）', callback_data: `${prefix}:x:${g.id}` }]];
/** force-reply prompt after 🔢 (the name is mentioned so only that player's keyboard pops up) */
export function promptText(g, name, now, error = null) {
  const fix = error ? `${invalidText(name, error)}\n` : '';
  return `${fix}🔢 ${name}，請「回覆」這則訊息輸入 ${SC_CODE_LEN} 位數字（數字不重複，可 0 開頭）\n${timerLine(g, now)}`;
}
export function roundClosedText(g, record) {
  if (record.cracked) return `🔓 ${SC_NAME}｜第 ${record.no}/${g.rounds} 道鎖已破解！\n🏆 ${record.winnerName} 猜中密碼 ${record.code}`;
  if (record.how === 'aborted') return `🛑 ${SC_NAME}｜第 ${record.no}/${g.rounds} 道鎖：遊戲中止\n🔑 密碼是 ${record.code}`;
  return `💥 ${SC_NAME}｜第 ${record.no}/${g.rounds} 道鎖：寶箱已自毀\n🔑 密碼是 ${record.code}`;
}
export function crackedAnnounce(g, record) {
  const next = g.round < g.rounds ? `\n\n下一道鎖馬上出現，${record.winnerName} 這局先休息，其他人加油！` : '';
  return `🎉🔓 第 ${record.no}/${g.rounds} 道鎖被破解了！\n🏆 ${record.winnerName} 猜中 ${record.code}（用時 ${mmss(record.ms)}，全場第 ${record.guesses} 次猜測）${next}`;
}
export const timeoutAnnounce = (g, record) => `💥 寶箱已自毀！第 ${record.no}/${g.rounds} 道鎖 ${SC_ROUND_MS / 60e3} 分鐘無人破解\n🔑 密碼是 ${record.code}（全場共猜 ${record.guesses} 次）${g.round < g.rounds ? '\n下一只寶箱來了 👇' : ''}`;

export function summaryText(g, { prizeLine = null } = {}) {
  const cracked = crackedRounds(g);
  const head = g.endReason === 'aborted' ? `🛑 ${SC_NAME}｜遊戲中止` : `🏁 ${SC_NAME}｜寶箱探險結束！`;
  const why = g.endReason === 'noPlayers' ? '（所有破鎖者都已經破解過，提前收工）' : '';
  const stats = `🎯 共 ${g.history.length}/${g.rounds} 輪，破解 ${cracked.length} 輪${why}`;
  const list = cracked.length ? `🏆 破解名單\n${cracked.map((r) => `🔓 第 ${r.no} 道鎖｜${r.winnerName}｜${r.code}｜${mmss(r.ms)}`).join('\n')}` : '😢 這次沒有人破解任何一道鎖，寶藏繼續沉睡……';
  return [head, stats, list, prizeLine, `🔐 想再挑戰就按「🔐 ${SC_NAME}」或輸入 /baoxianxiang！`].filter(Boolean).join('\n\n');
}

export function invalidText(name, error) {
  return error === 'repeat' ? `⚠️ ${name}：密碼的 ${SC_CODE_LEN} 個數字不會重複，換一組試試` : `⚠️ ${name}：請輸入剛好 ${SC_CODE_LEN} 位數字（例如 0123）`;
}
export const cooldownText = (waitMs) => `⏳ 每 ${SC_COOLDOWN_MS / 1000} 秒只能猜一次，再等 ${Math.ceil(waitMs / 1000)} 秒`;
export const lockedText = (daily = false) => `🏆 你已經破解過${daily ? '今天的' : '這局的'}一道鎖，把機會留給其他人吧！`;
export const notPlayerText = () => '🙋 這局報名已截止，下一局記得早點報名喔';
