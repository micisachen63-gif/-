import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chooseWords, countVotes, living, playerById, playerBySeat, publicWords, UC_DISCUSS_MS, UC_EMPTY_LOBBY_MS, UC_LOBBY_MS, UC_MAX_PLAYERS, UC_MIN_PLAYERS, UC_RUNOFF_MS, UC_TURN_MS, UC_VOTE_MS, undercoverCount, userName, winner, shuffle } from './undercover.js';

export const UC_CALLBACK_RE = /^uc:(?:open|(?:join|leave|start):[A-Za-z0-9_-]{1,16}|(?:clue|vote):[A-Za-z0-9_-]{1,16}:\d{1,2})$/;
const ACTIVE = new Set(['lobby', 'dealing', 'clue', 'discuss', 'vote', 'runoff']);
const hhmm = ms => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);

/** community (optional, 社群版): { maxPlayers, lobbyNote(g), keyboard(g), onEnd(g, { status, winners, reason }) } — see werewolf-flow.js. */
export function createUndercoverFlow({ api, chatId, tgStore, log, botUsername = () => '', isGroupMember, now = Date.now, random = Math.random, artDir = path.resolve(import.meta.dirname, '../../../assets/undercover'), community = null }) {
  const MAXP = community?.maxPlayers || UC_MAX_PLAYERS;
  const ended = async (g, summary) => { if (!g.community || !community?.onEnd || g.endReported) return; g.endReported = true; save(); try { await community.onEnd(g, summary); } catch (error) { log.warn(`undercover community end hook failed: ${error.message}`); } };
  tgStore.data.undercover ||= { game: null, recentPairs: [] };
  tgStore.data.undercover.recentPairs ||= [];
  let serial = Promise.resolve();
  let counter = Math.floor(Math.random() * 1296);
  const exclusive = fn => { const run = serial.then(fn); serial = run.catch(() => {}); return run; };
  const game = () => tgStore.data.undercover.game;
  const save = () => tgStore.save();
  const active = g => g && ACTIVE.has(g.stage);
  const group = () => String(chatId);
  const startLink = g => `https://t.me/${botUsername()}?start=uc_${g.id}`;
  const send = (target, text, replyMarkup) => api.call('sendMessage', { chat_id: target, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  const answer = (cq, text = '') => api.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: false }).catch(error => log.warn(`undercover callback failed: ${error.message}`));
  const say = async (target, text, replyMarkup) => send(target, text, replyMarkup);

  async function card(target, kind, caption, markup) {
    if (community && String(caption).length > 1024) { // 20 人局的線索彙整會超過圖片說明上限：圖片只放標題，全文另發文字訊息
      try { const buffer = fs.readFileSync(path.join(artDir, `${kind}.png`)); await api.sendPhoto({ chatId: target, buffer, mimeType: 'image/png', fileName: `undercover-${kind}.png`, caption: String(caption).split('\n')[0].slice(0, 1024) }); }
      catch (error) { log.warn(`undercover ${kind} art failed: ${error.message}`); }
      const message = await say(target, String(caption).slice(0, 4096), markup);
      return { messageId: message.message_id, photo: false };
    }
    try {
      const buffer = fs.readFileSync(path.join(artDir, `${kind}.png`));
      const message = await api.sendPhoto({ chatId: target, buffer, mimeType: 'image/png', fileName: `undercover-${kind}.png`, caption: String(caption).slice(0, 1024), replyMarkup: markup });
      return { messageId: message.message_id, photo: true };
    } catch (error) {
      log.warn(`undercover ${kind} art failed: ${error.message}`);
      const message = await say(target, caption, markup);
      return { messageId: message.message_id, photo: false };
    }
  }

  async function editCard(g, text, markup = { inline_keyboard: [] }) {
    if (!g.phaseMessageId) return;
    const common = { chat_id: group(), message_id: g.phaseMessageId, reply_markup: markup };
    try {
      if (g.phasePhoto) await api.call('editMessageCaption', { ...common, caption: String(text).slice(0, 1024) });
      else await api.call('editMessageText', { ...common, text: String(text).slice(0, 4096) });
    } catch (error) {
      if (!/message is not modified/i.test(String(error.message))) log.warn(`undercover group card edit failed: ${error.message}`);
    }
  }

  function lobbyKeyboard(g) {
    if (g.community) return { inline_keyboard: community.keyboard(g) };
    return { inline_keyboard: [
      [{ text: g.players.length >= UC_MAX_PLAYERS ? '🈵 已滿額' : '🎟 我要玩', callback_data: `uc:join:${g.id}` }, { text: '🚪 退出', callback_data: `uc:leave:${g.id}` }],
      [{ text: '🔐 第一次先開私訊', url: startLink(g) }],
      [{ text: `▶️ 發起人開始（至少 ${UC_MIN_PLAYERS} 人）`, callback_data: `uc:start:${g.id}` }],
    ] };
  }

  function lobbyText(g) {
    if (g.community) {
      const left = Math.max(1, Math.ceil((g.createdAt + UC_LOBBY_MS - now()) / 60_000));
      const roster = g.players.length ? g.players.map(p => `${p.seat}. ${p.name}`).join('\n') : '還沒有人報名';
      return `🕵️ 誰是臥底｜報名中\n${community.lobbyNote?.(g) || ''}\n🎭 每人私訊收到祕密詞，臥底拿到相近但不同的詞。輪到你時私訊提交一句線索，討論後按鈕投票。平民抓出所有臥底就贏；臥底人數追上平民就逆轉勝。\n${g.players.length >= 8 ? `本局會有 ${undercoverCount(g.players.length)} 位臥底。\n` : ''}\n👥 ${g.players.length}/${MAXP} 人（至少 ${UC_MIN_PLAYERS} 人）｜${left} 分鐘後自動關門\n${roster}\n\n按「🎟 報名」報名；第一次會請你到私訊綁定遊戲 AID。`.slice(0, 4000);
    }
    const others = g.players.filter(p => String(p.id) !== String(g.hostId)).length;
    const remaining = Math.max(1, Math.ceil((g.createdAt + UC_LOBBY_MS - now()) / 60_000));
    const roster = g.players.length ? g.players.map(p => `${p.seat}. ${p.name}${String(p.id) === String(g.hostId) ? '（發起人）' : ''}`).join('\n') : '發起人尚未完成私訊報到';
    const timeout = others === 0 ? '5 分鐘內沒有其他人加入就會流局' : `${remaining} 分鐘後自動關門並開始`;
    return `🕵️ 誰是臥底｜開局招募中\n${g.hostName} 把大家約到咖啡館，今晚有人拿到不同的詞……\n\n🎭 玩法：每人會收到一個祕密詞，臥底拿到相近但不同的詞。輪到你時，私訊小精靈提交一句線索；大家討論後按鈕投票抓臥底。不要直接說出答案喔！\n🏆 平民找出所有臥底就贏；臥底人數追上平民就逆轉勝。${g.players.length >= 8 ? `本局會有 ${undercoverCount(g.players.length)} 位臥底。` : ''}\n\n👥 ${g.players.length}/${UC_MAX_PLAYERS} 人｜${timeout}\n${roster}\n\n最多 ${UC_MAX_PLAYERS} 人，至少 ${UC_MIN_PLAYERS} 人（含發起人）。第一次請點「開私訊」並按 Start（會自動報名）；已開過私訊就直接按「我要玩」。`;
  }

  async function refreshLobby(g) {
    await editCard(g, lobbyText(g), lobbyKeyboard(g));
  }

  async function join(g, user, meta = null) {
    if (g.stage !== 'lobby') return '報名時間已過，這局已經開始囉。';
    if (now() >= g.createdAt + UC_LOBBY_MS) { await tickInner(); return '報名時間已過，下一局再來一起玩喔。'; }
    if (g.players.some(p => String(p.id) === String(user.id))) return '你已經入座啦，先把自己的詞收好，不要露餡喔 🤫';
    if (g.players.length >= MAXP) return `咖啡館座位都滿啦，最多只能 ${MAXP} 位玩家。`;
    if (!g.community && String(user.id) !== String(g.hostId) && !g.players.some(p => String(p.id) === String(g.hostId)) && g.players.length >= UC_MAX_PLAYERS - 1) return '最後一張椅子要留給發起人，等他私訊報到喔。';
    if (!await isGroupMember(user)) return '這場遊戲只開放群組成員參加。';
    try { await say(user.id, `🧚 報到成功！我會在開局時偷偷把你的祕密詞送到私訊。\n本局代號：${g.id}`); }
    catch { return '小精靈還沒辦法私訊你喔。先點群裡的「第一次先開私訊」並按 Start，再回來報名。'; }
    g.players.push({ id: user.id, name: meta?.name || userName(user), seat: g.players.length + 1, alive: true, role: null, word: null, roleMessageId: null, ...(meta ? { meta } : {}) });
    save(); await refreshLobby(g);
    return '入座成功！座位保留，等大家到齊就開局 🎭';
  }

  async function openLobby(user) {
    const previous = game();
    if (active(previous)) { await say(group(), `🕵️ 這間咖啡館已經有一局在玩囉（${previous.players.length} 人），等這局揭曉後再開下一局。`); return { busy: true }; }
    const id = randomBytes(5).toString('base64url').slice(0, 10) || (++counter).toString(36);
    const g = { id, chatId, hostId: user.id, hostName: userName(user), createdAt: now(), stage: 'lobby', players: [], round: 0, clues: [], votes: {}, events: [], lobbyMessageId: null, phaseMessageId: null, lastPairIndex: null };
    tgStore.data.undercover.game = g; save();
    const m = await card(group(), 'lobby', lobbyText(g) + '\n\n🌙 來吧，今晚誰的描述最可疑？', lobbyKeyboard(g));
    g.lobbyMessageId = m.messageId; g.lobbyPhoto = m.photo; g.phaseMessageId = m.messageId; g.phasePhoto = m.photo; g.phaseKind = 'lobby'; save();
    const result = await join(g, user);
    if (!g.players.some(p => String(p.id) === String(user.id))) await say(group(), `發起人 ${g.hostName}：${result}\n請先按「第一次先開私訊」完成報到。`);
    return { opened: true, gameId: g.id };
  }

  async function finishLobby(g, title, detail) {
    g.stage = 'cancelled'; g.deadlineAt = null; save();
    await editCard(g, `🌫 ${title}\n${detail}\n小精靈先把燈關上；想玩時再開下一局吧！`);
    await ended(g, { status: 'cancelled', reason: detail });
  }

  // ---------- 社群版 (community) entry points ----------
  async function openCommunity(round) {
    const previous = game();
    if (active(previous)) return { busy: true };
    const id = randomBytes(5).toString('base64url').slice(0, 10) || (++counter).toString(36);
    const g = { id, chatId, hostId: null, hostName: '管理員', community: true, roundId: round?.id || null, createdAt: now(), stage: 'lobby', players: [], round: 0, clues: [], votes: {}, events: [], lobbyMessageId: null, phaseMessageId: null, lastPairIndex: null };
    tgStore.data.undercover.game = g; save();
    try { const buffer = fs.readFileSync(path.join(artDir, 'lobby.png')); await api.sendPhoto({ chatId: group(), buffer, mimeType: 'image/png', fileName: 'undercover-lobby.png', caption: `🕵️ 誰是臥底開局囉！今晚有人拿到不同的詞……\n\n${community.lobbyNote?.(g) || ''}` }); }
    catch (error) { log.warn(`undercover lobby art failed: ${error.message}`); }
    const m = await say(group(), lobbyText(g), lobbyKeyboard(g)); // text (not a caption): a 20-player roster does not fit in 1024 characters
    g.lobbyMessageId = m.message_id; g.lobbyPhoto = false; g.phaseMessageId = m.message_id; g.phasePhoto = false; g.phaseKind = 'lobby'; save();
    return { opened: true, gameId: g.id };
  }
  async function abortCommunity(reason = '管理員臨時終止了這一局。') {
    const g = game();
    if (!active(g)) return { inactive: true };
    const inLobby = g.stage === 'lobby';
    g.stage = 'cancelled'; g.aborted = true; g.deadlineAt = null; g.cluePromptMessageId = null; save();
    const text = `⛔ 誰是臥底已臨時終止\n${reason}\n本局不列入參加紀錄，可以重新報名下一局。`;
    if (inLobby) await editCard(g, text); else { await editCard(g, '⛔ 本局已終止'); await say(group(), text); }
    await ended(g, { status: 'aborted', reason });
    return { aborted: true, gameId: g.id };
  }
  async function leaveCommunity(user) {
    const g = game();
    if (!g || g.stage !== 'lobby') return { text: '報名已經截止啦' };
    const index = g.players.findIndex(p => String(p.id) === String(user.id));
    if (index < 0) return { text: '你還沒入座喔' };
    g.players.splice(index, 1); g.players.forEach((player, i) => { player.seat = i + 1; }); save(); await refreshLobby(g);
    return { left: true, text: '座位已釋出，下次再來抓臥底！' };
  }
  async function startCommunity() {
    const g = game();
    if (!g || g.stage !== 'lobby') return { text: '這局不在報名階段' };
    if (g.players.length < UC_MIN_PLAYERS) return { tooFew: true, text: `至少要 ${UC_MIN_PLAYERS} 人，目前 ${g.players.length} 人。` };
    await begin(g); return { started: true, text: '祕密詞正在送往每個人的私訊 🎭' };
  }

  async function deal(g) {
    const deal = chooseWords(g.players.length, tgStore.data.undercover.recentPairs, random);
    g.pairIndex = deal.pairIndex; g.citizenWord = deal.citizenWord; g.undercoverWord = deal.undercoverWord;
    g.players.forEach(player => {
      player.role = deal.spySeats.includes(player.seat) ? 'undercover' : 'citizen';
      player.word = player.role === 'undercover' ? g.undercoverWord : g.citizenWord;
    });
    tgStore.data.undercover.recentPairs = [...tgStore.data.undercover.recentPairs, deal.pairIndex].slice(-20);
    g.stage = 'dealing'; g.deadlineAt = null; save();
  }

  async function sendRoleCards(g) {
    for (const player of g.players) {
      if (player.roleMessageId) continue;
      const secret = player.role === 'undercover'
        ? `🕵️ 你是【臥底】！你的祕密詞是：\n\n「${player.word}」\n\n其他大多數人拿到相近的詞。仔細聽線索，想辦法混過去；描述時不要直接說詞、諧音或字數。`
        : `🌿 你是【平民】！你的祕密詞是：\n\n「${player.word}」\n\n輪到你時，用一句話描述它但不要直接說出來。聽聽其他人的線索，找出拿到不同詞的臥底。`;
      const message = await card(player.id, 'clues', `🎭 你的祕密身分牌\n${secret}\n\n🔒 這張牌只有你看得到，請別截圖或轉傳喔。`);
      player.roleMessageId = message.messageId; save();
    }
  }

  async function begin(g) {
    if (g.stage !== 'lobby' || g.players.length < UC_MIN_PLAYERS || (!g.community && !g.players.some(p => String(p.id) === String(g.hostId)))) return false;
    await deal(g);
    await editCard(g, `🎬 咖啡館打烊，${g.players.length} 位玩家已就座！\n小精靈正在把祕密詞一張張送進私訊。收到詞以前，先別劇透喔。`);
    try { await sendRoleCards(g); }
    catch (error) { log.warn(`undercover role delivery paused: ${error.message}`); await say(group(), '📨 有人的祕密詞暫時送不出去，我會自動重試。發起人也能用 /ucancel 收局。'); return false; }
    await startRound(g); return true;
  }

  const introKeyboard = (g, player) => ({ inline_keyboard: [[{ text: '📝 重發我的線索提示', callback_data: `uc:clue:${g.id}:${player.seat}` }]] });
  const voteKeyboard = g => {
    const candidates = living(g).filter(p => g.stage !== 'runoff' || g.runoffSeats.includes(p.seat));
    const buttons = candidates.map(p => ({ text: `${p.seat}. ${p.name}`, callback_data: `uc:vote:${g.id}:${p.seat}` }));
    if (buttons.length <= 10) return { inline_keyboard: buttons.map(b => [b]) };
    const rows = []; for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2)); // 11–20 人：兩欄
    return { inline_keyboard: rows };
  };

  function turnText(g) {
    const player = playerBySeat(g, g.currentSeat);
    return `🎤 第 ${g.round} 輪線索時間\n現在輪到 ${player?.name || '下一位玩家'}。請到小精靈私訊回覆你的提示，用一句話形容祕密詞，不能直接說詞、諧音或字數。\n⏳ 每人 ${Math.round(UC_TURN_MS / 1000)} 秒；大家的線索會依序公布。`;
  }

  async function showPhase(g, kind, text, markup) {
    if (g.phaseMessageId && g.phaseKind === kind) { await editCard(g, text, markup); return; }
    const sent = await card(group(), kind, text, markup);
    g.phaseMessageId = sent.messageId; g.phasePhoto = sent.photo; g.phaseKind = kind; save();
  }

  async function promptCurrent(g) {
    const player = playerBySeat(g, g.currentSeat);
    if (!player || !player.alive) { await advanceTurn(g); return; }
    await showPhase(g, 'clues', turnText(g), introKeyboard(g, player));
    if (g.cluePromptMessageId) return;
    const prompt = await say(player.id,
      `🎤 第 ${g.round} 輪，輪到你提供線索！\n用一句話形容你的祕密詞，不要直接說詞、諧音或字數。你的詞仍是「${player.word}」。\n請直接回覆這則訊息。`,
      { force_reply: true, input_field_placeholder: '輸入一句線索…' });
    g.cluePromptMessageId = prompt.message_id; save();
  }

  async function startRound(g) {
    const players = living(g);
    if (players.length <= 1) { await finishGame(g, winner(g) || 'citizens'); return; }
    g.round += 1; g.clues = []; g.votes = {}; g.runoffSeats = null;
    g.turnOrder = shuffle(players.map(player => player.seat), random);
    g.turnIndex = 0; g.currentSeat = g.turnOrder[0]; g.cluePromptMessageId = null; g.currentTurnSubmitted = false; g.pendingClueBroadcast = null;
    g.stage = 'clue'; g.deadlineAt = now() + UC_TURN_MS; g.phaseMessageId = null; g.phaseKind = null; save();
    await promptCurrent(g);
  }

  async function advanceTurn(g) {
    g.cluePromptMessageId = null; g.currentTurnSubmitted = false; g.pendingClueBroadcast = null; g.turnIndex += 1;
    while (g.turnIndex < g.turnOrder.length && !playerBySeat(g, g.turnOrder[g.turnIndex])?.alive) g.turnIndex += 1;
    if (g.turnIndex >= g.turnOrder.length) { await startDiscussion(g); return; }
    g.currentSeat = g.turnOrder[g.turnIndex]; g.deadlineAt = now() + UC_TURN_MS; save(); await promptCurrent(g);
  }

  async function submitClue(g, player, text, message) {
    if (g.deadlineAt && now() >= g.deadlineAt) {
      await say(player.id, '這輪線索時間剛好結束了，小精靈幫你接到下一位囉。');
      if (g.stage === 'clue' && player.seat === g.currentSeat) {
        await say(group(), `⌛ ${player.name} 這輪先跳過，等會兒還有機會！`);
        await advanceTurn(g);
      }
      return { expired: true };
    }
    const clue = String(text || '').trim().slice(0, 120);
    if (clue.length < 2) { await say(player.id, '給大家一點線索嘛，至少寫兩個字，再回覆小精靈的提示喔。'); return { short: true }; }
    const normalize = value => String(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    if (clue.includes(player.word) || normalize(clue).includes(normalize(player.word))) { await say(player.id, '這樣要直接掀底牌啦！換一句含蓄一點的線索，再回覆小精靈提示。'); return { leaked: true }; }
    g.clues.push({ round: g.round, seat: player.seat, name: player.name, text: clue, at: now() });
    g.events.push({ type: 'clue', round: g.round, seat: player.seat });
    g.currentTurnSubmitted = true; g.pendingClueBroadcast = { round: g.round, seat: player.seat, name: player.name, text: clue }; g.cluePromptMessageId = null; g.deadlineAt = null; save();
    await say(group(), `🗣 第 ${g.round} 輪｜${player.name} 的線索：\n「${clue}」`);
    g.pendingClueBroadcast = null; save();
    await advanceTurn(g);
    return { clue: true };
  }

  async function startDiscussion(g) {
    g.stage = 'discuss'; g.deadlineAt = now() + UC_DISCUSS_MS; g.cluePromptMessageId = null; g.phaseMessageId = null; g.phaseKind = null; save();
    const clues = g.clues.map(item => `${item.seat}. ${item.name}：「${item.text}」`).join('\n');
    await showPhase(g, 'clues', `🕵️ 第 ${g.round} 輪線索全數到齊！\n\n${clues}\n\n🗣 討論 2 分鐘，猜猜誰拿到不一樣的詞。討論結束後，存活玩家都要投一票。`, { inline_keyboard: [] });
  }

  async function startVote(g, runoff = false) {
    g.stage = runoff ? 'runoff' : 'vote'; g.deadlineAt = now() + (runoff ? UC_RUNOFF_MS : UC_VOTE_MS); g.votes = {}; g.phaseMessageId = null; g.phaseKind = null; save();
    const text = runoff
      ? `⚖️ 平票加投｜候選人：${g.runoffSeats.map(seat => playerBySeat(g, seat)?.name).join('、')}\n存活玩家請選出最可疑的一位！⏳ 45 秒`
      : `🗳 第 ${g.round} 輪投票開始！每位存活玩家選一位最可疑的人，截止前可以改票。\n⏳ 60 秒後揭曉，票數不會顯示投票者姓名。`;
    await showPhase(g, 'vote', text, voteKeyboard(g));
  }

  async function finishGame(g, result) {
    g.stage = 'ended'; g.deadlineAt = null; g.result = result; g.cluePromptMessageId = null; save();
    const heading = result === 'citizens' ? '🌿 平民勝利！臥底全被揪出來啦。' : '🕵️ 臥底勝利！成功混到最後，這局演技滿分。';
    const roster = g.players.map(player => `${player.seat}. ${player.name}｜${player.role === 'undercover' ? '🕵️ 臥底' : '🌿 平民'}｜詞：${player.word}`).join('\n');
    await showPhase(g, 'reveal', `${heading}\n\n${publicWords(g)}\n\n🎭 身分揭曉\n${roster}\n\n🌙 謝謝大家今晚來玩${g.community ? '！' : '，想再開局就按「🕵️ 誰是臥底」！'}`, { inline_keyboard: [] });
    const winners = g.players.filter(player => (result === 'citizens') === (player.role !== 'undercover'));
    await ended(g, { status: 'completed', result, winners: winners.map(player => player.id) });
  }

  async function finishVote(g) {
    const eligible = living(g).map(player => player.seat);
    const result = countVotes(g.votes, g.stage === 'runoff' ? g.runoffSeats : eligible);
    if (g.stage === 'vote' && result.tied.length > 1) {
      g.runoffSeats = result.tied; save();
      await say(group(), `⚖️ ${result.tied.map(seat => playerBySeat(g, seat)?.name).join('、')} 票數打平！候選人進入加投。`);
      await startVote(g, true); return;
    }
    if (!result.seat) {
      await say(group(), g.stage === 'runoff' && result.tied.length > 1 ? '⚖️ 加投仍然平手，這輪沒有人出局。線索再多一輪！' : '🗳 這輪沒有人獲得有效票，大家再多觀察一輪。');
      await startRound(g); return;
    }
    const eliminated = playerBySeat(g, result.seat);
    if (eliminated) {
      eliminated.alive = false; g.events.push({ type: 'vote', round: g.round, seat: eliminated.seat, counts: result.counts }); save();
      await say(group(), `🚪 ${eliminated.name} 被請出咖啡館！身分是【${eliminated.role === 'undercover' ? '臥底' : '平民'}】。他的祕密詞先保留到最後揭曉。`);
    }
    const resultWinner = winner(g);
    if (resultWinner) await finishGame(g, resultWinner); else await startRound(g);
  }

  async function tickInner() {
    const g = game(); if (!active(g)) return null;
    if (g.stage === 'dealing') {
      try { await sendRoleCards(g); await startRound(g); return { resumed: true }; }
      catch (error) { log.warn(`undercover role retry failed: ${error.message}`); return { retry: true }; }
    }
    if (g.stage === 'lobby' && g.community) {
      if (now() >= g.createdAt + UC_LOBBY_MS) {
        if (g.players.length >= UC_MIN_PLAYERS) await begin(g);
        else await finishLobby(g, '誰是臥底流局', `招募時間到了，目前 ${g.players.length} 人，還不到 ${UC_MIN_PLAYERS} 人開局門檻。`);
        return { closed: true };
      }
      if (g.players.length >= MAXP) { await begin(g); return { started: true, full: true }; }
      const minute = Math.ceil((g.createdAt + UC_LOBBY_MS - now()) / 60_000);
      if (minute !== g.lastLobbyMinute) { g.lastLobbyMinute = minute; save(); await refreshLobby(g); }
      return null;
    }
    if (g.stage === 'lobby') {
      const others = g.players.filter(player => String(player.id) !== String(g.hostId));
      if (now() - g.createdAt >= UC_EMPTY_LOBBY_MS && !others.length) { await finishLobby(g, '誰是臥底流局', '五分鐘過去，還沒有人來陪發起人玩。'); return { cancelled: true }; }
      if (now() >= g.createdAt + UC_LOBBY_MS) {
        if (g.players.length >= UC_MIN_PLAYERS && g.players.some(player => String(player.id) === String(g.hostId))) await begin(g);
        else await finishLobby(g, '誰是臥底流局', `招募時間到了，目前 ${g.players.length} 人，還不到 ${UC_MIN_PLAYERS} 人開局門檻。`);
        return { closed: true };
      }
      if (g.players.length >= UC_MAX_PLAYERS && g.players.some(player => String(player.id) === String(g.hostId))) { await begin(g); return { started: true, full: true }; }
      const minute = Math.ceil((g.createdAt + UC_LOBBY_MS - now()) / 60_000);
      if (minute !== g.lastLobbyMinute) { g.lastLobbyMinute = minute; save(); await refreshLobby(g); }
      return null;
    }
    if (g.stage === 'clue' && g.currentTurnSubmitted) {
      if (g.pendingClueBroadcast) {
        const clue = g.pendingClueBroadcast;
        await say(group(), `🗣 第 ${clue.round} 輪｜${clue.name} 的線索：\n「${clue.text}」`);
        g.pendingClueBroadcast = null; save();
      }
      await advanceTurn(g); return { advanced: g.stage, resumedSubmittedClue: true };
    }
    if (!g.deadlineAt || now() < g.deadlineAt) {
      if (g.stage === 'clue' && !g.cluePromptMessageId) await promptCurrent(g);
      return null;
    }
    if (g.stage === 'clue') {
      const player = playerBySeat(g, g.currentSeat);
      if (player?.alive) await say(group(), `⌛ ${player.name} 這輪先跳過，等會兒還有機會！`);
      await advanceTurn(g); return { advanced: g.stage };
    }
    if (g.stage === 'discuss') await startVote(g);
    else if (g.stage === 'vote' || g.stage === 'runoff') await finishVote(g);
    return { advanced: g.stage };
  }

  async function onMessageInner(msg, text) {
    const inGroup = String(msg.chat?.id) === String(chatId);
    const start = /^\/start\s+uc_([A-Za-z0-9_-]{1,16})\s*$/i.exec(text);
    if (community && msg.chat?.type !== 'private') return null; // 社群版: no text commands in the group (admin + AID flow lives in the bot)
    if (community && start) return null;
    if (msg.chat?.type === 'private' && start) {
      const g = game();
      if (!g || g.id !== start[1] || g.stage !== 'lobby') { await say(msg.chat.id, '這局已經開玩或結束囉，回群裡看看最新一局吧。'); return { expired: true }; }
      const result = await join(g, msg.from); await say(msg.chat.id, result);
      if (g.stage === 'lobby' && g.players.length >= UC_MAX_PLAYERS) await begin(g);
      return { joined: true };
    }
    if (!community && inGroup && /^\/(?:ucancel|undercancel)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
      const cancelCommand = /^\/(?:ucancel|undercancel)(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(text);
      if (cancelCommand?.[1] && cancelCommand[1].toLowerCase() !== botUsername().toLowerCase()) return null;
      const g = game();
      if (!active(g)) { await say(group(), '現在沒有進行中的誰是臥底。'); return { inactive: true }; }
      if (String(msg.from?.id) !== String(g.hostId)) { await say(group(), '🧚 只有發起人能收起這一局喔。'); return { denied: true }; }
      await finishLobby(g, '遊戲已中止', '發起人決定先按下暫停鍵。'); return { cancelled: true };
    }
    const command = /^\/(?:undercover|spy)(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(text);
    if (!community && inGroup && ((command && (!command[1] || command[1].toLowerCase() === botUsername().toLowerCase())) || text === '🕵️ 誰是臥底' || text === '誰是臥底')) return openLobby(msg.from);
    if (!community && msg.chat?.type === 'private' && (command || text === '🕵️ 誰是臥底')) { await say(msg.chat.id, '🕵️ 誰是臥底是群組遊戲，回到群裡按「🕵️ 誰是臥底」就能開局。私訊是你的祕密線索室喔。'); return { groupOnly: true }; }

    const g = game();
    if (!g || g.stage !== 'clue' || msg.chat?.type !== 'private' || String(msg.chat.id) !== String(msg.from?.id)) return null;
    const player = playerById(g, msg.from?.id);
    if (!player || !player.alive || player.seat !== g.currentSeat) return null;
    if (String(msg.reply_to_message?.message_id) !== String(g.cluePromptMessageId)) return null;
    if (!text || text.startsWith('/')) { await say(player.id, '請用文字線索回覆提示訊息，至少兩個字喔。'); return { empty: true }; }
    return submitClue(g, player, text, msg);
  }

  async function onCallbackInner(cq) {
    const [prefix, action, id, detail] = String(cq.data || '').split(':');
    if (prefix !== 'uc') return null;
    const inGroup = String(cq.message?.chat?.id) === String(chatId);
    if (community && ['open', 'join', 'leave', 'start'].includes(action)) { await answer(cq, '請用報名訊息上的按鈕'); return { ignored: true }; }
    if (action === 'open') {
      if (!inGroup) { await answer(cq, '請回群組發起遊戲'); return { denied: true }; }
      await answer(cq, '咖啡館開門囉！'); return openLobby(cq.from);
    }
    const g = game();
    if (!g || g.id !== id || !active(g)) { await answer(cq, '這局已結束，請重新開局。'); return { expired: true }; }
    if (action === 'join' || action === 'leave' || action === 'start') {
      if (!inGroup || g.stage !== 'lobby') { await answer(cq, '報名已經截止啦'); return { denied: true }; }
      if (now() >= g.createdAt + UC_LOBBY_MS) { await tickInner(); await answer(cq, '報名時間已到'); return { expired: true }; }
      if (action === 'join') { const result = await join(g, cq.from); await answer(cq, result); if (g.stage === 'lobby' && g.players.length >= UC_MAX_PLAYERS) await begin(g); return { joined: true }; }
      if (action === 'leave') {
        const index = g.players.findIndex(p => String(p.id) === String(cq.from.id));
        if (index < 0) { await answer(cq, '你還沒入座喔'); return { ignored: true }; }
        if (String(cq.from.id) === String(g.hostId)) { await finishLobby(g, '誰是臥底流局', '發起人離開了咖啡館。'); await answer(cq, '已取消這局'); return { cancelled: true }; }
        g.players.splice(index, 1); g.players.forEach((player, i) => { player.seat = i + 1; }); save(); await refreshLobby(g);
        await answer(cq, '座位已釋出，下次再來抓臥底！'); return { left: true };
      }
      if (String(cq.from.id) !== String(g.hostId)) { await answer(cq, '只有發起人能按開始喔'); return { denied: true }; }
      if (!g.players.some(player => String(player.id) === String(g.hostId))) { await answer(cq, '發起人要先完成私訊報到'); return { hostNotJoined: true }; }
      if (g.players.length < UC_MIN_PLAYERS) { await answer(cq, `至少要 ${UC_MIN_PLAYERS} 人，目前 ${g.players.length} 人。`); return { tooFew: true }; }
      await answer(cq, '祕密詞正在送往每個人的私訊 🎭'); await begin(g); return { started: true };
    }
    if (!inGroup) { await answer(cq, '請在群組遊戲訊息操作'); return { denied: true }; }
    const actor = playerById(g, cq.from?.id);
    if (!actor || !actor.alive) { await answer(cq, '這局目前不能由你操作喔'); return { denied: true }; }
    if (action === 'clue') {
      if (g.stage !== 'clue' || actor.seat !== g.currentSeat || Number(detail) !== actor.seat) { await answer(cq, '還沒輪到你提供線索'); return { denied: true }; }
      g.cluePromptMessageId = null; save(); await promptCurrent(g); await answer(cq, '我把線索提示重新送到你的私訊囉'); return { promptSent: true };
    }
    if (action === 'vote') {
      if (!['vote', 'runoff'].includes(g.stage)) { await answer(cq, '投票時間已過'); return { denied: true }; }
      if (g.deadlineAt && now() >= g.deadlineAt) { await tickInner(); await answer(cq, '投票時間已截止'); return { expired: true }; }
      const target = playerBySeat(g, detail);
      if (!target?.alive || (g.stage === 'runoff' && !g.runoffSeats.includes(target.seat))) { await answer(cq, '這位不在投票名單裡'); return { denied: true }; }
      g.votes[actor.id] = target.seat; save();
      const total = living(g).length, cast = Object.keys(g.votes).length;
      await answer(cq, `已收到你的票（${cast}/${total}），截止前可以改票`);
      await editCard(g, g.stage === 'runoff' ? `⚖️ 平票加投｜已收到 ${cast}/${total} 票` : `🗳 投票進行中｜已收到 ${cast}/${total} 票\n投票者姓名不會顯示，請安心選擇。`, voteKeyboard(g));
      return { voted: true };
    }
    await answer(cq); return null;
  }

  return {
    onMessage: (msg, text) => exclusive(() => onMessageInner(msg, text)),
    onCallback: cq => exclusive(() => onCallbackInner(cq)),
    tick: () => exclusive(tickInner),
    getState: () => game(),
    openCommunity: round => exclusive(() => openCommunity(round)),
    joinCommunity: (user, meta) => exclusive(async () => { const g = game(); if (!g || g.stage !== 'lobby') return { ok: false, text: '報名已經截止啦' }; const text = await join(g, user, meta); const ok = g.players.some(p => String(p.id) === String(user.id)); if (ok && g.stage === 'lobby' && g.players.length >= MAXP) await begin(g); return { ok, text }; }),
    leaveCommunity: user => exclusive(() => leaveCommunity(user)),
    startCommunity: () => exclusive(startCommunity),
    abortCommunity: reason => exclusive(() => abortCommunity(reason)),
  };
}
