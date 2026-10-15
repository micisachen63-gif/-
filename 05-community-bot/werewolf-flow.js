import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { dealRoles, living, MAX_PLAYERS, MIN_PLAYERS, playerById, playerBySeat, resolveNight, ROLE_NAMES, voteResult, winner } from './werewolf-rules.js';

const LOBBY_MS = 10 * 60_000;
const EMPTY_LOBBY_MS = 5 * 60_000;
const DAY_MS = 3 * 60_000;
const VOTE_MS = 60_000;
const PHASE_MS = { night_guard: 30_000, night_wolf: 45_000, night_witch: 45_000, night_seer: 30_000, runoff: 45_000, hunter: 30_000 };
const ACTIVE = new Set(['lobby', 'dealing', 'night_guard', 'night_wolf', 'night_witch', 'night_seer', 'day', 'vote', 'runoff', 'hunter']);
const SHORT_ROLE = { wolf: '🐺', seer: '🔮', witch: '🧪', guard: '🛡', hunter: '🏹', villager: '🏡' };
const clock = ms => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
const nameOf = user => [user?.first_name, user?.last_name].filter(Boolean).join(' ') || (user?.username ? `@${user.username}` : `玩家 ${user?.id}`);
const bySeat = players => players.map(player => `${player.seat}. ${player.name}`).join('\n');

export function createWerewolfFlow({ api, chatId, tgStore, log, botUsername = () => '', isGroupMember, now = Date.now, rand = randomInt, artDir = path.resolve(import.meta.dirname, '../assets/werewolf') }) {
  tgStore.data.werewolf ||= { game: null };
  let serial = Promise.resolve();
  const exclusive = fn => { const run = serial.then(fn); serial = run.catch(() => {}); return run; };
  const game = () => tgStore.data.werewolf.game;
  const save = () => tgStore.save();
  const group = () => String(chatId);
  const active = g => g && ACTIVE.has(g.stage);
  const link = g => `https://t.me/${botUsername()}?start=ww_${g.id}`;
  const say = (target, text, markup) => api.call('sendMessage', { chat_id: target, text, ...(markup ? { reply_markup: markup } : {}) });
  const answer = (cq, text) => api.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: false }).catch(error => log.warn(`werewolf callback answer failed: ${error.message}`));
  const art = async (target, key, caption, markup) => {
    try {
      const buffer = fs.readFileSync(path.join(artDir, `${key}.png`));
      return await api.sendPhoto({ chatId: target, buffer, mimeType: 'image/png', fileName: `werewolf-${key}.png`, caption, replyMarkup: markup });
    } catch (error) {
      log.warn(`werewolf art ${key} failed: ${error.message}`);
      return say(target, caption, markup);
    }
  };
  const editText = async (target, messageId, text, markup) => {
    if (!messageId) return;
    try { await api.call('editMessageText', { chat_id: target, message_id: messageId, text, reply_markup: markup || { inline_keyboard: [] } }); }
    catch (error) { if (!/message is not modified/i.test(String(error.message))) log.warn(`werewolf edit failed: ${error.message}`); }
  };
  const buttons = (g, action, targets, label = p => `${p.seat}. ${p.name}`) => ({ inline_keyboard: targets.map(p => [{ text: label(p), callback_data: `ww:${action}:${g.id}:${p.seat}` }]) });
  const lobbyMarkup = g => ({ inline_keyboard: [
    [{ text: '🎟 我要玩', callback_data: `ww:join:${g.id}` }, { text: '🚪 退出', callback_data: `ww:leave:${g.id}` }],
    [{ text: '🔐 第一次先開私訊', url: link(g) }],
    [{ text: `▶️ 發起人開始（至少 ${MIN_PLAYERS} 人）`, callback_data: `ww:start:${g.id}` }],
  ] });
  const lobbyText = g => {
    const remaining = Math.max(0, Math.ceil((g.createdAt + LOBBY_MS - now()) / 60_000));
    return `🐺 狼人殺・村民招募中\n🎟 ${g.players.length}/${MAX_PLAYERS} 人｜約 ${remaining} 分鐘後關門（${clock(g.createdAt + LOBBY_MS)}）\n至少 ${MIN_PLAYERS} 人才能開始；若 5 分鐘沒有其他人加入，就會流局。\n\n${g.players.length ? bySeat(g.players) : '還沒有人完成私訊報到'}\n\n初次玩請先點「第一次先開私訊」並按 Start；回群後點「我要玩」。角色和夜間操作都只送私訊。`;
  };
  const updateLobby = async g => { if (g.stage === 'lobby') await editText(group(), g.lobbyMessageId, lobbyText(g), lobbyMarkup(g)); };

  async function join(g, user) {
    if (g.players.some(p => String(p.id) === String(user.id))) return '你已經在名單裡啦，先別急著露出狼尾巴 🐾';
    if (g.players.length >= MAX_PLAYERS) return '村子的十張椅子都坐滿啦！';
    if (String(user.id) !== String(g.hostId) && !g.players.some(p => String(p.id) === String(g.hostId)) && g.players.length >= MAX_PLAYERS - 1) return '最後一張椅子要留給發起人，等他私訊報到喔。';
    if (!await isGroupMember(user)) return '只有群組成員能加入這場遊戲。';
    try { await say(user.id, `🧚 村門已替你打開！回群組等其他人集合，身分牌會在開局時悄悄送來。\n本局：${g.id}`); }
    catch { return '先點群裡的「第一次先開私訊」並按 Start，小精靈才送得到你的身分牌喔。'; }
    g.players.push({ id: user.id, name: nameOf(user), seat: g.players.length + 1, alive: true, role: null, roleMessageId: null });
    save(); await updateLobby(g);
    if (g.players.length === MAX_PLAYERS) await begin(g);
    return '報到成功！身分牌會在開局時私訊給你 🎭';
  }

  async function openLobby(user) {
    const previous = game();
    if (active(previous)) { await say(group(), '🧚 村裡已經有一場狼人殺在進行啦！先玩完這局，再開下一場。'); return { busy: true }; }
    const g = { id: randomBytes(5).toString('base64url'), chatId, hostId: user.id, createdAt: now(), deadlineAt: now() + LOBBY_MS,
      stage: 'lobby', players: [], night: 0, phaseVersion: 0, witchSaveUsed: false, witchPoisonUsed: false,
      guardLastTarget: null, events: [], lobbyMessageId: null, phaseMessageId: null, voteMessageId: null };
    tgStore.data.werewolf.game = g; save();
    await art(group(), 'lobby',
      `🧚 噓，月亮升起來了。今晚的村民之中，藏著會說謊的狼人……\n\n玩法很簡單：先報名，再到私訊領祕密身分。夜裡依私訊按鈕行動；天亮後在群裡推理，最後按鈕投票。找出全部狼人，村民就贏；狼人活到人數追上好人，就換他們慶祝！\n\n⏰ 招募 10 分鐘、最多 10 人；至少 5 人才能開局。夜晚約 2 分鐘，白天討論 3 分鐘，投票 1 分鐘。發起人若要中止，可在群裡輸入 /wolfcancel。\n\n來吧，別讓小精靈一個人守夜！`);
    const lobby = await say(group(), lobbyText(g), lobbyMarkup(g));
    g.lobbyMessageId = lobby.message_id; save();
    const result = await join(g, user);
    if (!g.players.some(p => String(p.id) === String(user.id))) await say(group(), `發起人 ${nameOf(user)}：${result}\n先按上方「第一次先開私訊」完成報到。`);
    return { opened: true, gameId: g.id };
  }

  async function cancel(g, reason) {
    const inLobby = g.stage === 'lobby';
    g.stage = 'cancelled'; g.deadlineAt = null; save();
    const text = `🌫 狼人殺流局\n${reason}\n小精靈把村門關好啦，下次再來抓狼！`;
    if (inLobby) await editText(group(), g.lobbyMessageId, text);
    else await say(group(), text);
  }

  async function deliverRoles(g) {
    for (const player of g.players) {
      if (player.roleMessageId) continue;
      const wolves = g.players.filter(p => p.role === 'wolf' && p.id !== player.id).map(p => p.name);
      const instructions = {
        wolf: `每晚私訊選一位非狼人襲擊。${wolves.length ? `你的狼隊友：${wolves.join('、')}。` : '你是唯一的狼人。'}`,
        seer: '每晚查驗一人，小精靈只會告訴你「狼人」或「不是狼人」。',
        witch: '你有一瓶解藥、一瓶毒藥，每晚最多使用一瓶；用過就沒囉。',
        guard: '每晚守護一人，可以守自己，但不能連續兩晚守同一人。',
        hunter: '如果被狼人襲擊或被投出局，你能在最後帶走一人；被女巫毒死則不能開槍。',
        villager: '沒有夜間技能。白天觀察說詞、找出破綻，投票揪出狼人。',
      };
      const message = await art(player.id, player.role, `${SHORT_ROLE[player.role]} 你的身分是【${ROLE_NAMES[player.role]}】\n${instructions[player.role]}\n\n🤫 這張牌只給你看，別讓隔壁那位偷瞄到！`);
      player.roleMessageId = message.message_id; save();
    }
  }

  async function begin(g) {
    if (g.stage !== 'lobby' || g.players.length < MIN_PLAYERS || !g.players.some(p => String(p.id) === String(g.hostId))) return false;
    g.stage = 'dealing'; g.deadlineAt = null;
    const roles = dealRoles(g.players.length, rand);
    g.players.forEach((p, index) => { p.role = roles[index]; p.alive = true; });
    save();
    await editText(group(), g.lobbyMessageId, `🎭 村門關上，${g.players.length} 位玩家已入座！\n小精靈正把祕密身分牌送進每個人的私訊……`);
    try { await deliverRoles(g); }
    catch (error) { log.warn(`werewolf role delivery paused: ${error.message}`); await say(group(), '⚠️ 身分牌發送遇到阻礙，小精靈會接著補送；請先別劇透。'); return false; }
    await startNight(g); return true;
  }

  const phaseRole = stage => ({ night_guard: 'guard', night_wolf: 'wolf', night_witch: 'witch', night_seer: 'seer' })[stage];
  const nightStages = ['night_guard', 'night_wolf', 'night_witch', 'night_seer'];
  const hasLivingRole = (g, role) => living(g).some(p => p.role === role);
  const firstNightStage = g => nightStages.find(stage => hasLivingRole(g, phaseRole(stage)));
  const nextNightStage = g => nightStages.slice(nightStages.indexOf(g.stage) + 1).find(stage => hasLivingRole(g, phaseRole(stage)));

  async function enter(g, stage, duration) {
    g.stage = stage; g.phaseVersion = (g.phaseVersion || 0) + 1;
    g.phaseMessageId = null; g.voteMessageId = null; g.actionPrompted = {}; g.hunterPrompted = false;
    g.deadlineAt = now() + duration; save();
    await announce(g);
  }
  async function startNight(g) {
    if (g.night >= 8) { await finishGame(g, 'draw'); return; }
    g.night += 1; g.nightActions = { wolves: {}, guard: null, seer: null, witch: null }; g.wolfTarget = null;
    save(); await enter(g, firstNightStage(g), PHASE_MS[firstNightStage(g)]);
  }

  async function announce(g) {
    if (g.stage.startsWith('night_')) {
      if (!g.nightPictureMessageId || g.nightPictureNight !== g.night) {
        const m = await art(group(), 'night', `🌙 第 ${g.night} 夜。燈一盞盞熄了，請把祕密行動留在小精靈私訊裡。\n天亮前，誰都別說自己看見了什麼……`);
        g.nightPictureMessageId = m.message_id; g.nightPictureNight = g.night; save();
      }
      await promptNight(g); return;
    }
    if (g.stage === 'day' && !g.phaseMessageId) {
      const deaths = g.lastNightDeaths || [];
      const text = deaths.length ? `昨夜 ${deaths.map(d => playerBySeat(g, d.seat)?.name).join('、')} 沒能迎來日出。` : '昨夜風聲很響，卻沒有人消失——平安夜！';
      const m = await art(group(), 'day', `☀️ 第 ${g.night} 天，晨光照進村莊。\n${text}\n\n還活著的村民，現在有 3 分鐘在群裡討論。出局者請別劇透喔。\n\n存活名單：${living(g).map(p => p.name).join('、')}`);
      g.phaseMessageId = m.message_id; save(); return;
    }
    if ((g.stage === 'vote' || g.stage === 'runoff') && !g.voteMessageId) {
      await art(group(), 'verdict', g.stage === 'vote' ? '⚖️ 討論時間到！請存活玩家投出最可疑的一票。票數到時才揭曉，現在先把表情藏好。' : '⚖️ 票數打平！請在兩位嫌疑人之間重新投票。');
      const m = await say(group(), voteText(g), voteMarkup(g)); g.voteMessageId = m.message_id; save(); return;
    }
    if (g.stage === 'hunter') {
      const hunter = playerBySeat(g, g.hunterSeat);
      if (!g.phaseMessageId) {
        const m = await art(group(), 'verdict', `🏹 ${hunter?.name || '獵人'} 的身分揭曉！獵人在離開前有 30 秒選擇是否開槍，請大家稍等。`);
        g.phaseMessageId = m.message_id; save();
      }
      const targets = living(g).filter(p => p.seat !== g.hunterSeat);
      if (!g.hunterPrompted && hunter && targets.length) {
        await say(hunter.id, '🏹 最後一箭握在你手裡。要帶走誰？30 秒內按下目標；不按就收起弓。', buttons(g, 'shot', targets));
        g.hunterPrompted = true; save();
      }
    }
  }

  async function promptNight(g) {
    const role = phaseRole(g.stage);
    for (const player of living(g).filter(p => p.role === role)) {
      if (g.actionPrompted?.[player.id]) continue;
      let text, markup;
      const others = living(g).filter(p => p.id !== player.id);
      if (role === 'wolf') { text = `🐺 第 ${g.night} 夜，狼群要襲擊誰？各狼人各選一人，票數相同由小精靈隨機決定。`; markup = buttons(g, 'wolf', others.filter(p => p.role !== 'wolf')); }
      if (role === 'guard') { text = '🛡 今晚你要守護誰？不能連續兩晚守同一人。'; markup = buttons(g, 'guard', living(g).filter(p => p.seat !== g.guardLastTarget)); }
      if (role === 'seer') { text = '🔮 水晶亮起來了。今晚想查驗誰？'; markup = buttons(g, 'seer', others); }
      if (role === 'witch') {
        const victim = playerBySeat(g, g.wolfTarget);
        text = `🧪 女巫，今夜狼群盯上了 ${victim?.name || '沒有人'}。你有 45 秒決定要不要用藥；每晚最多一瓶。`;
        markup = { inline_keyboard: [
          ...(!g.witchSaveUsed && victim ? [[{ text: `💚 救 ${victim.name}`, callback_data: `ww:witch:${g.id}:heal` }]] : []),
          ...(!g.witchPoisonUsed ? [[{ text: '🩸 選擇毒藥目標', callback_data: `ww:witch:${g.id}:poison` }]] : []),
          [{ text: '🌙 今晚不使用', callback_data: `ww:witch:${g.id}:skip` }],
        ] };
      }
      if (!markup?.inline_keyboard?.length) continue;
      const message = await say(player.id, text, markup);
      g.actionPrompted[player.id] = message.message_id; save();
    }
  }

  function voteMarkup(g) {
    const eligible = g.stage === 'runoff' ? living(g).filter(p => g.runoffSeats.includes(p.seat)) : living(g);
    return buttons(g, 'vote', eligible);
  }
  function voteText(g) {
    const total = living(g).length, cast = Object.keys(g.ballots || {}).length;
    return `🗳 ${g.stage === 'runoff' ? '平票加投' : '放逐投票'}｜已投 ${cast}/${total}\n在截止前可以改票，最後一票算數。小精靈只記存活玩家的票；暫時不公開誰選了誰。`;
  }

  async function advanceNight(g) {
    if (g.stage === 'night_wolf') {
      const { wolfTarget } = resolveNight(g, rand);
      g.wolfTarget = wolfTarget; save();
    }
    const next = nextNightStage(g);
    if (next) { await enter(g, next, PHASE_MS[next]); return; }
    if (g.nightActions?.seer) {
      const seer = living(g).find(p => p.role === 'seer');
      const target = playerBySeat(g, g.nightActions.seer);
      if (seer && target) await say(seer.id, `🔮 水晶的答案：${target.name} ${target.role === 'wolf' ? '是狼人 🐺' : '不是狼人 🌿'}。先把答案收好，天亮再決定怎麼說。`);
    }
    if (g.nightActions?.witch?.kind === 'heal') g.witchSaveUsed = true;
    if (g.nightActions?.witch?.kind === 'poison') g.witchPoisonUsed = true;
    if (g.nightActions?.guard) g.guardLastTarget = g.nightActions.guard;
    const result = resolveNight(g, rand);
    const deaths = result.deaths;
    deaths.forEach(item => { const p = playerBySeat(g, item.seat); if (p) p.alive = false; });
    g.lastNightDeaths = [...deaths];
    g.events.push({ night: g.night, type: 'night', deaths: [...deaths] }); save();
    await afterElimination(g, deaths, 'day');
  }

  async function afterElimination(g, deaths, next) {
    const hunter = deaths.find(item => playerBySeat(g, item.seat)?.role === 'hunter' && item.cause !== 'poison');
    if (hunter) { g.hunterSeat = hunter.seat; g.pendingNext = next; save(); await enter(g, 'hunter', PHASE_MS.hunter); return; }
    await proceed(g, next);
  }
  async function proceed(g, next) {
    const result = winner(g);
    if (result) { await finishGame(g, result); return; }
    if (next === 'day') await enter(g, 'day', DAY_MS);
    else await startNight(g);
  }

  async function finishVote(g) {
    const aliveSeats = living(g).map(p => p.seat);
    const result = voteResult(g.ballots, aliveSeats, g.stage === 'runoff' ? g.runoffSeats : null);
    if (g.stage === 'vote' && result.tied.length > 1) {
      g.runoffSeats = result.tied; g.ballots = {}; save();
      await say(group(), `⚖️ ${result.tied.map(seat => playerBySeat(g, seat)?.name).join('、')} 票數打平！再投一次，還是平票就沒人出局。`);
      await enter(g, 'runoff', PHASE_MS.runoff); return;
    }
    const seat = result.seat, player = playerBySeat(g, seat);
    if (!seat || !player) { await say(group(), '🧚 這輪沒有投出人。迷霧還在，夜色又要來了。'); await proceed(g, 'night'); return; }
    player.alive = false; g.events.push({ night: g.night, type: 'vote', seat, counts: result.counts }); save();
    await say(group(), `⚖️ 投票揭曉：${player.name} 被請離村莊。身分留到終局才公開；現在別急著下定論。`);
    await afterElimination(g, [{ seat, cause: 'vote' }], 'night');
  }

  async function finishHunter(g) {
    const target = playerBySeat(g, g.hunterShot);
    if (target?.alive) {
      target.alive = false; g.events.push({ night: g.night, type: 'hunter', seat: target.seat });
      if (g.pendingNext === 'day') (g.lastNightDeaths ||= []).push({ seat: target.seat, cause: 'hunter' });
      await say(group(), `🏹 最後一箭穿過迷霧，${target.name} 也離開了村莊。`);
    } else await say(group(), '🏹 獵人收起弓，沒有再帶走任何人。');
    const next = g.pendingNext; g.pendingNext = null; save(); await proceed(g, next);
  }

  async function finishGame(g, result) {
    g.stage = 'ended'; g.deadlineAt = null; g.result = result; save();
    const title = { village: '🌅 村民勝利！最後的狼影散去了。', wolves: '🌑 狼人勝利！月色終於屬於狼群。', draw: '🌫 迷霧未散，這一局平手。' }[result];
    const roles = g.players.map(p => `${p.seat}. ${p.name} — ${SHORT_ROLE[p.role]} ${ROLE_NAMES[p.role]}`).join('\n');
    await art(group(), result === 'village' ? 'day' : result === 'wolves' ? 'night' : 'verdict', `${title}\n\n🧚 謝謝大家陪我守住這個有點危險的夜晚。所有身分現在公開：\n${roles}\n\n還想玩？再按一次「🐺 狼人殺」就能開新村！`);
  }

  async function tickInner() {
    const g = game(); if (!active(g)) return null;
    if (g.stage === 'dealing') { await deliverRoles(g); await startNight(g); return { resumed: true }; }
    if (g.stage === 'lobby') {
      if (now() - g.createdAt >= EMPTY_LOBBY_MS && g.players.filter(p => String(p.id) !== String(g.hostId)).length === 0) {
        await cancel(g, '五分鐘過去，還沒有另一位村民報名。'); return { cancelled: true };
      }
      if (now() >= g.createdAt + LOBBY_MS) {
        if (g.players.length >= MIN_PLAYERS && g.players.some(p => String(p.id) === String(g.hostId))) await begin(g);
        else await cancel(g, g.players.some(p => String(p.id) === String(g.hostId)) ? `十分鐘招募結束，只有 ${g.players.length} 人，還不到 ${MIN_PLAYERS} 人開局門檻。` : '十分鐘招募結束，發起人尚未完成私訊報到。');
        return { closed: true };
      }
      const minute = Math.ceil((g.createdAt + LOBBY_MS - now()) / 60_000);
      if (minute !== g.lastLobbyMinute) { g.lastLobbyMinute = minute; save(); await updateLobby(g); }
      return null;
    }
    await announce(g);
    if (now() < g.deadlineAt) return null;
    if (g.stage.startsWith('night_')) await advanceNight(g);
    else if (g.stage === 'day') { g.ballots = {}; save(); await enter(g, 'vote', VOTE_MS); }
    else if (g.stage === 'vote' || g.stage === 'runoff') await finishVote(g);
    else if (g.stage === 'hunter') await finishHunter(g);
    return { advanced: true, stage: g.stage };
  }

  async function onMessageInner(msg, text) {
    const inGroup = String(msg.chat?.id) === String(chatId);
    if (inGroup && /^\/wolfcancel(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
      const g = game();
      if (!active(g)) { await say(group(), '現在沒有進行中的狼人殺。'); return { inactive: true }; }
      if (String(msg.from?.id) !== String(g.hostId)) { await say(group(), '🧚 只有發起人能收起這一局喔。'); return { denied: true }; }
      await cancel(g, '發起人決定取消這一局。'); return { cancelled: true };
    }
    const start = /^\/start\s+ww_([A-Za-z0-9_-]{1,16})\s*$/i.exec(text);
    if (msg.chat?.type === 'private' && start) {
      const g = game();
      if (!g || g.id !== start[1] || g.stage !== 'lobby') { await say(msg.chat.id, '這場狼人殺已經結束或開始了，回群裡看看最新一局吧。'); return { expired: true }; }
      await say(msg.chat.id, '🧚 連線成功！現在幫你報名這一局。');
      const result = await join(g, msg.from); await say(msg.chat.id, result); return { joined: true };
    }
    const command = /^\/(?:werewolf|wolf)(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(text);
    if (inGroup && ((command && (!command[1] || command[1].toLowerCase() === botUsername().toLowerCase())) || text === '🐺 狼人殺')) return openLobby(msg.from);
    if (msg.chat?.type === 'private' && command) { await say(msg.chat.id, '🐺 狼人殺要在群組裡發起喔！私訊是你的祕密身分牌與夜間行動室。'); return { groupOnly: true }; }
    return null;
  }

  async function onCallbackInner(cq) {
    const [prefix, action, id, detail] = String(cq.data || '').split(':');
    if (prefix !== 'ww') return null;
    const inGroup = String(cq.message?.chat?.id) === String(chatId);
    const inPrivate = cq.message?.chat?.type === 'private' && String(cq.message.chat.id) === String(cq.from?.id);
    if (action === 'open') {
      if (!inGroup) { await answer(cq, '請到群組裡發起遊戲'); return { denied: true }; }
      await answer(cq, '小精靈要講玩法囉！'); return openLobby(cq.from);
    }
    const g = game();
    if (!g || g.id !== id || !active(g)) { await answer(cq, '這局已經結束，請重新開村。'); return { expired: true }; }
    if (action === 'join' || action === 'leave' || action === 'start') {
      if (!inGroup || g.stage !== 'lobby') { await answer(cq, '報名已經截止啦'); return { denied: true }; }
      if (action === 'join') { const result = await join(g, cq.from); await answer(cq, result); return { joined: true }; }
      if (action === 'leave') {
        const index = g.players.findIndex(p => String(p.id) === String(cq.from.id));
        if (index < 0) { await answer(cq, '你還沒報名喔'); return { ignored: true }; }
        if (String(cq.from.id) === String(g.hostId)) { await cancel(g, '發起人離開了村子。'); await answer(cq, '已取消這場遊戲'); return { cancelled: true }; }
        g.players.splice(index, 1); g.players.forEach((p, i) => { p.seat = i + 1; }); save(); await updateLobby(g);
        await answer(cq, '已退出，下次再一起抓狼！'); return { left: true };
      }
      if (String(cq.from.id) !== String(g.hostId)) { await answer(cq, '開局要讓發起人按喔'); return { denied: true }; }
      if (!g.players.some(p => String(p.id) === String(g.hostId))) { await answer(cq, '發起人要先完成私訊報到喔'); return { denied: true }; }
      if (g.players.length < MIN_PLAYERS) { await answer(cq, `至少 ${MIN_PLAYERS} 人才能開局，目前 ${g.players.length} 人。`); return { tooFew: true }; }
      await answer(cq, '村門關上，開始發牌！'); await begin(g); return { started: true };
    }
    const actor = playerById(g, cq.from?.id);
    if (!actor || (!actor.alive && !(action === 'shot' && g.stage === 'hunter' && actor.seat === g.hunterSeat))) { await answer(cq, '這一局你現在不能操作喔'); return { denied: true }; }
    if (action === 'vote') {
      if (!inGroup || !['vote', 'runoff'].includes(g.stage)) { await answer(cq, '投票時間已過'); return { denied: true }; }
      const target = playerBySeat(g, detail);
      if (!target?.alive || (g.stage === 'runoff' && !g.runoffSeats.includes(target.seat))) { await answer(cq, '這個人不在候選名單'); return { denied: true }; }
      g.ballots[actor.id] = target.seat; save();
      await answer(cq, `已投 ${target.name}，截止前還能改票`);
      await editText(group(), g.voteMessageId, voteText(g), voteMarkup(g)); return { voted: true };
    }
    if (!inPrivate) { await answer(cq, '夜間行動只能在你的私訊操作'); return { denied: true }; }
    if (action === 'witch') {
      if (g.stage !== 'night_witch' || actor.role !== 'witch') { await answer(cq, '女巫行動時間已過'); return { denied: true }; }
      if (detail === 'heal' && !g.witchSaveUsed && g.wolfTarget) g.nightActions.witch = { kind: 'heal' };
      else if (detail === 'skip') g.nightActions.witch = { kind: 'skip' };
      else if (detail === 'poison' && !g.witchPoisonUsed) {
        await say(actor.id, '🩸 毒藥要交給誰？點選後，夜晚結束前還能改主意。', buttons(g, 'poison', living(g).filter(p => p.id !== actor.id)));
        await answer(cq, '選一位毒藥目標'); return { choosingPoison: true };
      } else { await answer(cq, '這瓶藥現在不能用了'); return { denied: true }; }
      save(); await answer(cq, detail === 'heal' ? '解藥已備好 💚' : '今晚不使用藥劑'); return { witch: detail };
    }
    if (action === 'shot') {
      if (g.stage !== 'hunter' || actor.role !== 'hunter' || actor.seat !== g.hunterSeat) { await answer(cq, '最後一箭的時間已過'); return { denied: true }; }
      const target = playerBySeat(g, detail);
      if (!target?.alive || target.id === actor.id) { await answer(cq, '目標不在場'); return { denied: true }; }
      g.hunterShot = target.seat; save(); await answer(cq, `最後一箭：${target.name}`); await finishHunter(g); return { shot: true };
    }
    const roles = { wolf: 'wolf', guard: 'guard', seer: 'seer', poison: 'witch' };
    if (!roles[action] || g.stage !== `night_${roles[action]}` || actor.role !== roles[action]) { await answer(cq, '這個夜間操作已經過期'); return { denied: true }; }
    const target = playerBySeat(g, detail);
    if (!target?.alive || (action !== 'guard' && target.id === actor.id) || (action === 'wolf' && target.role === 'wolf') || (action === 'guard' && target.seat === g.guardLastTarget)) {
      await answer(cq, '這個目標現在不能選'); return { denied: true };
    }
    if (action === 'wolf') g.nightActions.wolves[actor.id] = target.seat;
    if (action === 'guard') g.nightActions.guard = target.seat;
    if (action === 'seer') g.nightActions.seer = target.seat;
    if (action === 'poison') g.nightActions.witch = { kind: 'poison', seat: target.seat };
    save(); await answer(cq, `已選 ${target.name}，截止前還能改選`); return { acted: action };
  }

  return {
    onMessage: (msg, text) => exclusive(() => onMessageInner(msg, text)),
    onCallback: cq => exclusive(() => onCallbackInner(cq)),
    tick: () => exclusive(tickInner),
    getState: () => game(),
  };
}
