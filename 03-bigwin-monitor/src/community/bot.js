import path from 'node:path';
import { createWerewolfFlow } from './games/werewolf-flow.js';
import { STANDARD_9 } from './games/werewolf-rules.js';
import { createUndercoverFlow } from './games/undercover-flow.js';
import { createHaiguitangFlow, HG_CALLBACK_RE } from './games/haiguitang-flow.js';
import { createEscapeFlow, ES_CALLBACK_RE } from './games/escape-flow.js';
import { createCommunitySafeCrackFlow, SCC_LOBBY_MS } from './games/safe-crack-flow.js';
import { SC_DEFAULT_ROUNDS, SC_MAX_ROUNDS, SC_ROUND_CHOICES } from '../games/safe-crack.js';
import { GAMES, gameLabel, taipeiDate, md, fmtNum, parseAmount, parsePeriod, periodLabel, describeConditions, needsBackend, evaluateConditions, statusLine, prizeLabel } from './conditions.js';
import { buildRows, stamp } from './records.js';
import { splitByCap, OVER_CAP_NOTE, PAY_PENDING, PAY_SENT, PAY_FAILED, AUTO_STAFF } from './payout.js';
import { createPetStore } from './pet/store.js';
import { petAppButton, petAppLink, petMiniAppUrl } from './pet/app-link.js';
import { createBossManager } from './pet/boss-manager.js';
import { createPetFlow } from './pet/pet-flow.js';

export const ANON_ADMIN_ID = 1087968824; // @GroupAnonymousBot
const GAME_KEYS = Object.keys(GAMES);
const CODE = { ww: 'WW', uc: 'UC', hg: 'HG', es: 'ES', sc: 'SC' };
const pairs = (list) => { const rows = []; for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2)); return rows; };
const SCHED_WINDOW_MIN = 30; // a schedule still fires up to 30 min late (bot restarted around the time)
const taipeiHm = (ms) => { const d = new Date(ms + 8 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const SIGNUP_WAIT_MS = 7000;
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const tgName = (u) => [[u?.first_name, u?.last_name].filter(Boolean).join(' '), u?.username ? `@${u.username}` : ''].filter(Boolean).join(' ') || String(u?.id || '');
const cmdOf = (text) => { const m = /^\/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim()); return m ? { name: m[1].toLowerCase(), at: m[2] || null, args: (m[3] || '').trim() } : null; };
const AID_RE = /^\d{4,15}$/;
export const ADMIN_ONLY = '只有管理員可以用此功能';

export function buildCommunityIntro(round) {
  if (!round) return '';
  const admin = round.adminCanJoin === false ? '\uFF5C\u7BA1\u7406\u54E1\u4E0D\u53C3\u52A0' : '';
  return [
    '\u{1F4C5} ' + md(round.date) + ' ' + round.roundNo + ' \u8F2A',
    '\u{1F3AF} \u672C\u8F2A\u53C3\u8207\u689D\u4EF6\uFF1A' + describeConditions(round.conditions),
    '\u{1F381} \u734E\u91D1\uFF1A' + prizeLabel(round) + admin,
  ].join('\n');
}

export function splitText(text, limit = 4000) {
  const out = []; let s = String(text || '');
  while (s.length > limit) { let i = s.lastIndexOf('\n', limit); if (i < limit / 2) i = limit; out.push(s.slice(0, i)); s = s.slice(i).replace(/^\n/, ''); }
  if (s) out.push(s); return out.length ? out : [''];
}

export function createCommunityBot({ api, cfg, groupStore, globalStore, backendFor, records, payout, log, now = Date.now, botUsername = () => cfg.botUsername || '', haigui = {}, saveGroupChatId = null, random = Math.random, petStore = null, wagerSync = null, pvpAnimationGenerator, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), dungeonManager = null, sendPhoto = null }) {
  let dm = dungeonManager;
  const G = globalStore.data; G.setups ||= {}; G.pending ||= {}; G.adminMenus ||= {};
  const flows = new Map(); // key -> { ww, uc, hg, es, chatId }
  const adminCache = new Map();
  const confirmAbort = new Map();
  let lock = Promise.resolve();
  const serial = (fn) => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };
  const groups = () => Object.entries(cfg.groups || {});
  const keyByChat = (chatId) => groups().find(([, g]) => g.chatId != null && String(g.chatId) === String(chatId))?.[0] || null;
  const gname = (key) => cfg.groups[key]?.name || key;
  const S = (key) => { const st = groupStore(key); const d = st.data; d.bindings ||= {}; d.aidOwner ||= {}; d.rounds ||= {}; d.daily ||= {}; d.seq ||= {}; return st; };
  const deep = (payload) => `https://t.me/${botUsername()}?start=${payload}`;
  const call = (method, body) => api.call(method, body);
  const send = (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, ...extra });
  const sendLong = async (chatId, text, extra = {}) => { let m = null; const parts = splitText(text); for (const [i, p] of parts.entries()) m = await send(chatId, p, i === parts.length - 1 ? extra : {}); return m; };
  const answer = (cq, text = '', alert = false) => call('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text: String(text).slice(0, 190), show_alert: alert } : {}) }).catch(() => {});
  const answerUrl = (cq, url) => call('answerCallbackQuery', { callback_query_id: cq.id, url }).catch(() => {});
  const del = (chatId, messageId) => call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
  const delLater = (m, ms = 60000) => { if (m?.message_id) setTimeout(() => void del(m.chat.id, m.message_id), ms).unref?.(); };
  const stripButtons = (m) => m?.message_id && call('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});

  const pStore = petStore || createPetStore({
    filePath: path.join(process.env.FAIRY_MINIGAME_STATE_DIR || 'state-minigame', 'pet.json'),
    log: log.child ? log.child('pet') : log,
    now,
    random,
  });

  async function postPetEntry(key, { moveToBottom = false, removeOldPanel = false } = {}) {
    const chatId = cfg.groups[key]?.chatId;
    if (chatId == null) return null;
    G.petEntryMessages ||= {};
    const previous = G.petEntryMessages[key];
    const text = '🐾 小遊戲精靈｜點下方常駐按鈕，來看看你的寵物 ✨';
    const markup = { reply_markup: {
      keyboard: [[{ text: '🐣✨ 我的寵物' }]],
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: '點 🐣✨ 我的寵物 開啟 Mini App',
    } };

    if (previous?.messageId) await call('deleteMessage', { chat_id: chatId, message_id: previous.messageId }).catch(() => {});

    // Replace only the old bot-owned pinned control panel from this feature.
    if (removeOldPanel && cfg.botId) {
      try {
        const chatInfo = await call('getChat', { chat_id: chatId });
        const pinned = chatInfo?.pinned_message;
        if (pinned?.from?.id === cfg.botId && String(pinned.text || '').startsWith('🎮 小遊戲精靈｜社群互動面板')) {
          await call('deleteMessage', { chat_id: chatId, message_id: pinned.message_id });
        }
      } catch (error) {
        log.info?.(`could not inspect previous pet panel in ${key}: ${error.message}`);
      }
    }

    const message = await send(chatId, text, markup);
    if (message?.message_id) {
      G.petEntryMessages[key] = { messageId: message.message_id };
      globalStore.save();
    }
    return message;
  }
  async function sendPetDmLink(key, chatId) {
    const username = String(botUsername() || '').replace(/^@/, '').trim();
    if (!username) {
      const m = await send(chatId, '🐾 請私訊「小遊戲精靈」並輸入 /pet 開啟寵物 Mini App。');
      if (m) delLater(m, 15000);
      return m;
    }
    const url = `https://t.me/${username}?start=pet_${encodeURIComponent(key)}`;
    const m = await send(chatId, '🐾 點下方按鈕前往小遊戲精靈私訊，再按「開啟寵物」進入 Mini App。', kb([[{ text: '💬 前往機器人私訊', url }]]));
    if (m) delLater(m, 15000);
    return m;
  }
  const bossManager = createBossManager({
    store: pStore,
    cfg,
    send: (chatId, text, extra) => send(chatId, text, extra),
    sendPhoto,
    editMessage: (chatId, messageId, text, extra, { isPhoto = false } = {}) => call(isPhoto ? 'editMessageCaption' : 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      [isPhoto ? 'caption' : 'text']: text,
      ...extra,
    }),
    answer: (cq, text, alert) => answer(cq, text, alert),
    del,
    now,
    log: log.child ? log.child('boss') : log,
    random,
  });
  const petFlow = createPetFlow({
    store: pStore,
    bossManager,
    cfg,
    send: (chatId, text, extra) => send(chatId, text, extra),
    sendAnimation: api.sendAnimation ? (payload) => api.sendAnimation(payload) : null,
    ...(pvpAnimationGenerator ? { createAnimation: pvpAnimationGenerator } : {}),
    edit: (chatId, messageId, text, extra) => call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra }),
    answer: (cq, text, alert) => answer(cq, text, alert),
    del,
    now,
    sleep,
    log: log.child ? log.child('petflow') : log,
    botUsername,
    isGroupAdmin: async (key, userId) => isAdmin(cfg.groups[key]?.chatId, userId, true),
  });

  async function isAdmin(chatId, userId, fresh = false) {
    if (chatId == null || userId == null) return false;
    const k = `${chatId}:${userId}`; const hit = adminCache.get(k);
    if (!fresh && hit && now() - hit.at < 5 * 60e3) return hit.ok;
    let ok = false;
    try { const m = await call('getChatMember', { chat_id: chatId, user_id: userId }); ok = ['creator', 'administrator'].includes(m?.status); } catch (error) { log.warn(`getChatMember ${userId} failed: ${error.message}`); }
    adminCache.set(k, { ok, at: now() }); return ok;
  }
  async function isPetGroupMember(key, userId) {
    const chatId = cfg.groups[key]?.chatId;
    if (chatId == null || userId == null) return false;
    try {
      const member = await call('getChatMember', { chat_id: chatId, user_id: userId });
      return ['creator', 'administrator', 'member'].includes(member?.status)
        || (member?.status === 'restricted' && member?.is_member === true);
    } catch (error) {
      log.warn(`pet group membership check failed for ${key}: ${error.message}`);
      return false;
    }
  }
  const requirePetGroupMember = async (cq, key) => {
    if (await isPetGroupMember(key, cq.from?.id)) return true;
    await answer(cq, `請回【${gname(key)}】社群後再操作寵物。`, true);
    return false;
  };
  /** A group message is from an admin when it is sent anonymously as the group itself, or the sender is an admin. */
  const msgFromAdmin = async (msg) => (msg.sender_chat && String(msg.sender_chat.id) === String(msg.chat.id)) || (msg.from && msg.from.id !== ANON_ADMIN_ID && await isAdmin(msg.chat.id, msg.from.id));
  async function adminGroupsOf(userId) { const out = []; for (const [key, g] of groups()) if (g.chatId != null && await isAdmin(g.chatId, userId, true)) out.push(key); return out; }

  // ---------- flows ----------
  const activeRound = (key, game) => { const r = Object.values(S(key).data.rounds).find((x) => x.game === game && x.status === 'open'); return r || null; };
  const lobbyNote = (key, g) => { const r = S(key).data.rounds[g.roundId]; return r ? buildCommunityIntro(r) : ''; };
  // Group game cards are for players. Admin start/stop controls are in the DM console.
  const lobbyKeyboard = (game) => [[{ text: '🎟 報名', callback_data: `mg:j:${game}` }, { text: '🚪 退出報名', callback_data: `mg:l:${game}` }]];
  function ensureFlows(key) {
    const gc = cfg.groups[key]; if (!gc || gc.chatId == null) return null;
    const cur = flows.get(key); if (cur && String(cur.chatId) === String(gc.chatId)) return cur;
    const chatId = gc.chatId; const tgStore = S(key); const flog = log.child ? log.child(key) : log;
    const hooks = (game) => ({ maxPlayers: GAMES[game].max, layouts: game === 'ww' ? { 9: STANDARD_9 } : undefined, lobbyNote: (g) => lobbyNote(key, g), keyboard: () => lobbyKeyboard(game), onEnd: (g, s) => onEnd(key, game, g, s) });
    const isGroupMember = async (user) => { try { const m = await call('getChatMember', { chat_id: chatId, user_id: user.id }); return ['member', 'administrator', 'creator', 'restricted'].includes(m?.status); } catch { return false; } };
    const inGroup = (chat) => String(chat?.id) === String(chatId);
    const inUserPrivate = (chat, user) => chat?.type === 'private' && String(chat?.id) === String(user?.id);
    const fsend = (text, extra = {}, target = chatId) => send(target, text, extra);
    const fanswer = (cq, text = '') => answer(cq, text);
    const common = { api, log: flog, now, tgStore, botUsername };
    const f = {
      chatId,
      ww: createWerewolfFlow({ ...common, chatId, isGroupMember, community: hooks('ww') }),
      uc: createUndercoverFlow({ ...common, chatId, isGroupMember, community: hooks('uc') }),
      hg: createHaiguitangFlow({ ...common, send: fsend, answer: fanswer, inGroup, inUserPrivate, splitText, interpreter: haigui.interpreter || null, release: haigui.release || null, sceneImage: haigui.sceneImage || null, random, community: hooks('hg') }),
      es: createEscapeFlow({ ...common, send: fsend, answer: fanswer, inGroup, inUserPrivate, splitText, random, community: hooks('es') }),
      sc: createCommunitySafeCrackFlow({ api, log: flog, now, tgStore, send: fsend, answer: (cq, text = '', alert = false) => answer(cq, text, alert), inGroup, random, community: { ...hooks('sc'), onCrack: (g, record) => onCrack(key, g, record) } }),
    };
    flows.set(key, f); return f;
  }
  const chatObj = (key) => ({ id: cfg.groups[key].chatId, type: 'supergroup' });
  const adapter = (key, game) => {
    const f = ensureFlows(key); if (!f) return null; const chatId = f.chatId;
    if (game === 'ww' || game === 'uc') {
      const fl = f[game];
      return { open: (round) => fl.openCommunity(round), join: (u, m) => fl.joinCommunity(u, m), leave: (u) => fl.leaveCommunity(u), start: () => fl.startCommunity(), abort: (r) => fl.abortCommunity(r), state: () => { const g = fl.getState(); return g && !['ended', 'cancelled', 'finished'].includes(g.stage) ? g : null; }, isEnding: () => { const g = fl.getState(); return Boolean(g && !g.endReported && ['ended', 'cancelled', 'finished'].includes(g.stage)); } };
    }
    const fl = f[game];
    return { open: (round) => (game === 'es' ? fl.openCommunity(chatObj(key), round, { scriptId: round.scriptId }) : game === 'sc' ? fl.openCommunity(chatObj(key), round, { rounds: round.rounds || SC_DEFAULT_ROUNDS }) : fl.openCommunity(chatObj(key), round)), join: (u, m) => fl.joinCommunity(chatId, u, m), leave: (u) => fl.leaveCommunity(chatId, u), start: () => fl.startCommunity(chatId), abort: (r) => fl.abortCommunity(chatId, r), state: () => { const g = fl.game(chatId); return g && g.stage !== 'ended' ? g : null; }, isEnding: () => { const g = fl.game(chatId); return Boolean(g && !g.endReported && g.stage === 'ended'); } };
  };

  // ---------- AID binding + eligibility ----------
  const binding = (key, uid) => S(key).data.bindings[String(uid)] || null;
  function bindAid(key, uid, aid, { nickname = null, by = 'self' } = {}) {
    const st = S(key); const d = st.data; const owner = d.aidOwner[aid];
    if (owner && String(owner) !== String(uid)) return { ok: false, text: `AID ${aid} 已綁定在其他 TG 帳號` };
    const b = d.bindings[String(uid)] ||= { aids: [], nicknames: {}, boundAt: now() };
    if (!b.aids.includes(aid)) b.aids.push(aid);
    if (nickname) b.nicknames[aid] = nickname;
    b.updatedAt = now(); b.by = by; d.aidOwner[aid] = String(uid); st.save();
    return { ok: true, binding: b };
  }
  function unbindAid(key, aid) {
    const st = S(key); const d = st.data; const owner = d.aidOwner[aid]; if (!owner) return { ok: false, text: `AID ${aid} 沒有綁定` };
    const b = d.bindings[owner]; if (b) { b.aids = b.aids.filter((x) => x !== aid); delete b.nicknames?.[aid]; if (!b.aids.length) delete d.bindings[owner]; }
    delete d.aidOwner[aid]; st.save(); return { ok: true, owner };
  }
  const usedToday = (key, game, aid, date) => S(key).data.daily[date]?.[game]?.[aid] || null;

  /** Full eligibility check + join. Returns { ok, text (short, for a popup), detail (DM text, failures only), needDm }. */
  async function checkAndJoin(key, game, user, aid) {
    const round = activeRound(key, game); const ad = adapter(key, game);
    const st = ad?.state();
    if (!round || !st || st.stage !== 'lobby' || st.roundId !== round.id) return { ok: false, text: '目前沒有開放報名的場次' };
    const label = `${gameLabel(game)} 第 ${round.roundNo} 輪`;
    if (round.participants[String(user.id)]) return { ok: true, already: true, text: '你已經報名了' };
    if (String(S(key).data.aidOwner[aid]) !== String(user.id)) return { ok: false, text: '這個 AID 不屬於你的帳號' };
    const used = usedToday(key, game, aid, round.date);
    if (used) return { ok: false, text: `AID ${aid} 今天已參加過${GAMES[game].name}，每個 AID 同類遊戲一天限一次`, detail: `❌ 無法報名「${label}」\n👤 AID ${aid}\n❗ 今天已經參加過${GAMES[game].name}（${used}），每個 AID 同類型遊戲一天只能參加一次。` };
    if (Object.values(round.participants).some((p) => p.aid === aid)) return { ok: false, text: '這個 AID 已在本輪報名' };
    let status;
    try { status = await backendFor(key).status(aid, round.conditions); } catch (error) {
      log.warn(`${key} eligibility lookup failed for ${aid}: ${error.message}`);
      return { ok: false, text: '小精靈查詢暫時失敗，請稍後再按一次報名', detail: `⚠️ 小精靈查詢暫時失敗，請稍後再報名一次。` };
    }
    if (!status.exists) return { ok: false, text: `小精靈查無 AID ${aid}`, detail: `❌ 無法報名「${label}」\n小精靈查無 AID ${aid}，請聯絡管理員確認。` };
    const ev = evaluateConditions(status, round.conditions);
    const nickname = status.nickname || S(key).data.bindings[String(user.id)]?.nicknames?.[aid] || null;
    if (!ev.ok) {
      return { ok: false, text: `不符合報名資格：${ev.shortfalls[0]}`, detail: [`❌ 不符合「${label}」報名資格`, `👤 AID ${aid}${nickname ? `（${nickname}）` : ''}`, `📊 目前狀態：${statusLine(status, round.conditions)}`, `📋 活動條件：${describeConditions(round.conditions)}`, '❗ 不符合原因：', ...ev.shortfalls.map((s) => `• ${s}`)].join('\n') };
    }
    const meta = { aid, nickname, tgName: tgName(user), name: nickname || tgName(user), vip: status.vip ?? null };
    const r = await ad.join(user, meta);
    if (!r?.ok) return { ok: false, text: r?.text || '報名失敗', needDm: /私訊|DM|start/i.test(r?.text || '') };
    const fresh = activeRound(key, game);
    if (fresh?.id === round.id) { fresh.participants[String(user.id)] = meta; S(key).save(); }
    return { ok: true, text: `✅ 報名成功（AID ${aid}）`, round };
  }

  /** 管理員報名：跳過 AID 綁定、參加條件、後台查詢與每日次數，直接用設定的暱稱（贏麻＝詩詩、爽爆＝沐沐，所有管理員同名，不加編號）加入。 */
  async function adminJoin(key, game, user) {
    const round = activeRound(key, game); const ad = adapter(key, game); const st = ad?.state();
    if (!round || !st || st.stage !== 'lobby' || st.roundId !== round.id) return { ok: false, text: '目前沒有開放報名的場次' };
    if (round.participants[String(user.id)]) return { ok: true, already: true, text: '你已經報名了' };
    if (!round.adminCanJoin) return { ok: false, text: '本輪設定為管理員不參加' };
    const base = cfg.groups[key]?.adminName || '管理員';
    const name = base; // every admin shows as the same name (詩詩 / 沐沐); the flows still track each one by TG id
    const meta = { admin: true, aid: null, nickname: name, tgName: tgName(user), name, vip: null };
    const r = await ad.join(user, meta);
    if (!r?.ok) return { ok: false, text: r?.text || '報名失敗', needDm: /私訊|DM|start/i.test(r?.text || '') };
    const fresh = activeRound(key, game);
    if (fresh?.id === round.id) { fresh.participants[String(user.id)] = meta; S(key).save(); }
    return { ok: true, admin: true, text: `✅ 已用「${name}」加入（管理員免驗證）`, round };
  }

  async function dmSignupResult(user, key, game, res) {
    if (res.ok) return send(user.id, `${res.text}\n${gameLabel(game)}｜${gname(key)}，開局後請留意群組${game === 'ww' || game === 'uc' ? '和私訊（身分 / 詞語會私訊給你）' : ''}。`).catch(() => {});
    return send(user.id, res.detail || `❌ ${res.text}`).catch(() => {});
  }

  /** Signup from the group button. */
  async function onSignupButton(cq, key, game) {
    const user = cq.from; const round = activeRound(key, game); const st = adapter(key, game)?.state();
    if (!round || !st || st.stage !== 'lobby') return answer(cq, '目前沒有開放報名的場次');
    if (round.participants[String(user.id)]) return answer(cq, '你已經報名了 👍');
    if (await isAdmin(cfg.groups[key].chatId, user.id)) {
      const res = await adminJoin(key, game, user);
      if (res.needDm) return answerUrl(cq, deep(`su_${key}_${game}`));
      return answer(cq, res.text, !res.ok);
    }
    const b = binding(key, user.id);
    if (!b?.aids?.length || b.aids.length > 1) return answerUrl(cq, deep(`su_${key}_${game}`)); // DM: bind an AID / choose which AID
    const job = checkAndJoin(key, game, user, b.aids[0]);
    let timer; const quick = await Promise.race([job, new Promise((r) => { timer = setTimeout(() => r(null), SIGNUP_WAIT_MS); })]); clearTimeout(timer);
    if (quick) {
      if (quick.needDm) return answerUrl(cq, deep(`su_${key}_${game}`));
      await answer(cq, quick.text, !quick.ok);
      if (!quick.ok && quick.detail) await dmSignupResult(user, key, game, quick);
      return null;
    }
    await answer(cq, '資格查詢中，結果會私訊通知你 ⏳');
    const res = await job; await dmSignupResult(user, key, game, res); return null;
  }

  /** Signup continued in DM (deep link su_<key>_<game>). */
  async function dmSignup(user, key, game) {
    const round = activeRound(key, game);
    if (!round) return send(user.id, `${gameLabel(game)}｜${gname(key)} 目前沒有開放報名的場次。`);
    if (await isAdmin(cfg.groups[key].chatId, user.id)) { const res = await adminJoin(key, game, user); return send(user.id, res.ok ? `${res.text}\n${gameLabel(game)}｜${gname(key)}，開局後請留意群組。` : `❌ ${res.text}`); }
    const b = binding(key, user.id);
    if (!b?.aids?.length) {
      G.pending[String(user.id)] = { kind: 'aid', key, game, at: now() }; globalStore.save();
      return send(user.id, `🎮 ${gname(key)}｜${gameLabel(game)} 報名\n第一次報名請先綁定你的遊戲 AID（一個 TG 帳號對應一個 AID，綁定後所有遊戲共用）。\n\n請直接輸入你的 AID：`);
    }
    if (b.aids.length > 1) return send(user.id, `請選擇要用哪個 AID 報名 ${gameLabel(game)}：`, kb(b.aids.map((a) => [{ text: `${a}${b.nicknames?.[a] ? `（${b.nicknames[a]}）` : ''}`, callback_data: `mg:pa:${key}:${game}:${a}` }])));
    await send(user.id, '⏳ 小精靈正在確認報名資格…');
    return dmSignupResult(user, key, game, await checkAndJoin(key, game, user, b.aids[0]));
  }

  async function onAidInput(msg, pend) {
    const uid = String(msg.from.id); const aid = String(msg.text || '').trim();
    if (!AID_RE.test(aid)) return send(msg.chat.id, 'AID 應該是一串數字，請重新輸入（或輸入 /cancel 取消）：');
    const d = S(pend.key).data; const owner = d.aidOwner[aid];
    if (owner && owner !== uid) return send(msg.chat.id, `AID ${aid} 已經綁定在其他 TG 帳號。如有疑問請聯絡管理員。`);
    await send(msg.chat.id, '⏳ 小精靈正在查詢這個 AID…');
    let p = null;
    try { p = await backendFor(pend.key).lookup(aid); } catch (error) { log.warn(`aid lookup failed: ${error.message}`); return send(msg.chat.id, '⚠️ 小精靈查詢暫時失敗，請稍後再輸入一次 AID。'); }
    if (!p) return send(msg.chat.id, `小精靈查無 AID ${aid}，請確認後重新輸入：`);
    G.pending[uid] = { ...pend, aid, nickname: p.nickname || null, at: now() }; globalStore.save();
    return send(msg.chat.id, `請確認要綁定這個 AID：\n👤 AID ${aid}${p.nickname ? `（暱稱：${p.nickname}）` : ''}\n\n⚠️ 綁定後不能自行更改，所有遊戲都會用這個 AID。`, kb([[{ text: '✅ 確認綁定', callback_data: `mg:ba:${pend.key}:${aid}` }, { text: '✏️ 重新輸入', callback_data: 'mg:br' }]]));
  }

  // ---------- results ----------
  async function onCrack(key, g, record) {
    const st = S(key); const d = st.data; const round = d.rounds[g.roundId];
    if (!round || round.status !== 'open') return;
    const winnerId = String(record.winnerId);
    const p = (g.players || []).find((x) => String(x.id) === winnerId) || {};
    const meta = round.participants[winnerId] || p.meta || {};
    const player = { id: winnerId, name: p.name, ...meta, ...p };
    const aid = meta.aid || player.aid;
    if (player.admin || !aid || !(round.prize > 0)) return;
    player.aid = aid;

    ((d.daily[round.date] ||= {})[round.game] ||= {})[player.aid] = round.id;
    round.crackedWinners ||= [];
    const maxWinners = (round.maxPayout > 0 && round.prize > 0) ? Math.floor(round.maxPayout / round.prize) : Infinity;
    const isOverCap = round.crackedWinners.length >= maxWinners;
    round.crackedWinners.push({ winnerId, aid: player.aid, no: record.no, overCap: isOverCap });
    st.save();

    const multText = round.multiplier > 0 ? `（${round.multiplier} 倍打碼）` : '';
    const prizeStr = `${round.prize}${multText}`;
    const noteParts = [`破解第 ${record.no} 道鎖`];
    if (isOverCap) noteParts.push(OVER_CAP_NOTE);
    const winnerRow = {
      日期時間: stamp(now()),
      社群: gname(key),
      遊戲: GAMES[round.game].name,
      當日輪次: `第 ${round.roundNo} 輪`,
      場次ID: round.id,
      參與條件: describeConditions(round.conditions),
      AID: player.aid,
      遊戲暱稱: player.nickname || player.name || '',
      TG名稱: player.tgName || '',
      結果: '優勝',
      獎金: prizeStr,
      是否派獎: PAY_PENDING,
      派獎人員: '',
      派獎時間: '',
      備註: noteParts.join('；'),
    };

    // ① 先填表格（記待派）
    try {
      await records.append(key, [winnerRow]);
    } catch (e) {
      log.warn(`onCrack records append failed: ${e.message}`);
    }

    // ② 後寄信
    let payResult = null;
    const item = { aid: player.aid, nickname: player.nickname, round: record.no, overCap: isOverCap };
    if (payout && typeof payout.sendOneWinner === 'function') {
      try {
        payResult = await payout.sendOneWinner({ round, groupName: gname(key), item });
      } catch (e) {
        log.warn(`onCrack sendOneWinner failed: ${e.message}`);
      }
    }

    // ③ 更新表格
    if (payResult?.status === PAY_SENT) {
      try {
        await records.update(key,
          { 場次ID: round.id, AID: player.aid, 備註: winnerRow.備註 },
          { 是否派獎: PAY_SENT, 派獎人員: AUTO_STAFF, 派獎時間: stamp(payResult.sentAt || now()) }
        );
      } catch (e) {
        log.warn(`onCrack records update failed: ${e.message}`);
      }
    } else if (payResult?.status === PAY_FAILED) {
      try {
        await records.update(key,
          { 場次ID: round.id, AID: player.aid, 備註: winnerRow.備註 },
          { 是否派獎: PAY_FAILED, 備註: [winnerRow.備註, payResult.note].filter(Boolean).join('；') }
        );
      } catch (e) {
        log.warn(`onCrack records update failed: ${e.message}`);
      }
    }

    // ④ 群組 @Tag 通知得獎者 ＋ 底部掛「🎁 登入遊戲領獎」按鈕
    const un = player.username || player.tgName?.match(/@([A-Za-z0-9_]+)/)?.[1];
    const tag = un ? `@${un}` : (player.nickname || player.name || '玩家');
    const claimUrl = cfg.groups[key]?.claimUrl;
    const claimMarkup = claimUrl ? kb([[{ text: '🎁 登入遊戲領獎', url: claimUrl }]]) : {};
    const multNotice = round.multiplier > 0 ? `（打碼倍數：${round.multiplier} 倍）` : '';
    const notifyLines = [
      `🎉 恭喜 ${tag} 成功破解第 ${record.no} 道鎖！`,
      `🔐 獲得破解獎勵：${fmtNum(round.prize)} 金幣${multNotice}`,
      payResult?.status === PAY_SENT
        ? '🎁 獎勵已自動派發至你的遊戲信箱，請登入遊戲查收！'
        : (payout?.live ? '🎁 獎金已登記，稍後將派發至你的遊戲信箱！' : '🎁 獎金已登記待審核！'),
    ];
    await send(cfg.groups[key].chatId, notifyLines.join('\n'), claimMarkup).catch((e) => log.warn(`onCrack notify failed: ${e.message}`));
  }

  async function onEnd(key, game, g, summary) {
    const st = S(key); const d = st.data; const round = d.rounds[g.roundId];
    if (!round || round.status !== 'open') return;
    const outcome = summary.status === 'completed' ? 'completed' : summary.status === 'aborted' ? 'aborted' : 'cancelled';
    const players = (g.players || []).map((p) => ({ id: p.id, name: p.name, ...(round.participants[String(p.id)] || p.meta || {}) }));
    const winners = new Set((summary.winners || []).map(String));
    Object.assign(round, { status: outcome, endedAt: now(), winners: [...winners], result: summary.result || null, reason: summary.reason || null, players: players.map((p) => p.id) });
    // daily one-play limit: only players queued for payout use it up (winners of a prize round, over-cap 待審核 included; 密室逃脫: everyone on a successful escape, nobody on a fail); 0-prize rounds never count
    const escFailed = game === 'es' && summary.result != null && summary.result !== 'good';
    const wonRound = (p) => (game === 'es' ? !escFailed : winners.has(String(p.id)));
    if (outcome === 'completed' && round.prize > 0) for (const p of players) if (p.aid && !p.admin && wonRound(p)) { ((d.daily[round.date] ||= {})[game] ||= {})[p.aid] = round.id; }
    prune(d); st.save();
    // result order (flow's winner order) → paid up to 本輪最多贈送總金額, full prizes only; the rest stay 待審核
    const rank = new Map((summary.winners || []).map((w, i) => [String(w), i]));
    const lockOf = new Map((summary.cracked || []).map((c) => [String(c.winnerId), c.no])); // 千鎖秘藏: winner → cracked lock no
    // 密室逃脫: only a successful escape (ending 'good') wins; time out / trap / bad ending → everyone listed, nobody paid
    const escFail = game === 'es' && summary.result != null && summary.result !== 'good';
    const winList = game === 'es' ? (escFail ? [] : players) : players.filter((p) => winners.has(String(p.id))).sort((a, b) => rank.get(String(a.id)) - rank.get(String(b.id)));
    const payable = outcome === 'completed' && round.prize > 0 ? winList.filter((p) => p.aid && !p.admin) : [];
    const overCap = new Set(splitByCap(round, payable).over.map((p) => String(p.id)));
    if (overCap.size) log.info(`round ${round.id}: ${overCap.size} winner(s) over cap ${round.maxPayout} → 待審核`);

    if (game === 'sc') {
      // 千鎖秘藏: 破解者已在 onCrack 即時登記並派獎；未破解者（未中獎）整批回填表格
      const crackedIds = new Set((summary.cracked || []).map((c) => String(c.winnerId)));
      const uncrackedPlayers = players.filter((p) => !crackedIds.has(String(p.id)));
      const uncrackedRows = uncrackedPlayers.map((p) => ({
        日期時間: stamp(round.endedAt), 社群: gname(key), 遊戲: GAMES[round.game].name, 當日輪次: `第 ${round.roundNo} 輪`, 場次ID: round.id,
        參與條件: describeConditions(round.conditions), AID: p.admin ? '管理員' : (p.aid || ''), 遊戲暱稱: p.admin ? (p.nickname || p.name || '') : (p.nickname || ''), TG名稱: p.tgName || '',
        結果: outcome === 'cancelled' ? '流局' : outcome === 'aborted' ? '終止' : '未中獎', 獎金: '', 是否派獎: '無', 派獎人員: '', 派獎時間: '', 備註: '',
      }));
      if (uncrackedRows.length) {
        try { await records.append(key, uncrackedRows); } catch (e) { log.warn(`sc uncracked records append failed: ${e.message}`); }
      }
    } else {
      // 其他遊戲 (狼人殺、誰是臥底、海龜湯、密室逃脫):
      let rows = [];
      try {
        rows = buildRows({ round, groupName: gname(key), outcome, winners, players, endedAt: round.endedAt, overCap });
        // ① 先填表格（中獎記待派，未中獎記無）
        await records.append(key, rows);
      } catch (error) { log.warn(`records append failed: ${error.message}`); }

      // ② 後寄信 ＋ ③ 更新表格
      if (payout && payable.length && outcome === 'completed') {
        if (!payout.live) {
          try { await payout.process({ round, groupName: gname(key), items: payable }); }
          catch (e) { log.warn(`payout process failed: ${e.message}`); }
        } else {
          payout.submit({ round, groupName: gname(key), groupKey: key, items: payable, rows, notify: notifyTargets(round) });
        }
      }
    }

    if (outcome !== 'completed') return;
    const line = (p, i) => (p.admin ? `${i + 1}. ${p.nickname || p.name || ''}` : `${i + 1}. ${p.aid || '-'}｜${p.nickname || p.name || ''}`);
    const side = { village: '（好人陣營）', wolves: '（狼人陣營）', citizens: '（平民陣營）', undercover: '（臥底陣營）' }[summary.result] || '';
    const parts = [`🏆 ${gameLabel(game)}｜${md(round.date)} 第 ${round.roundNo} 輪結果`, `🎯 條件：${describeConditions(round.conditions)}｜🎁 獎金：${prizeLabel(round)}`, ''];
    if (game === 'sc') {
      const cracked = summary.cracked || []; const byId = new Map(players.map((p) => [String(p.id), p]));
      parts[0] = `🏆 ${gameLabel(game)}｜${md(round.date)} 第 ${round.roundNo} 場結果`;
      parts.push(`🔐 共 ${summary.played ?? cracked.length}/${summary.locks ?? round.rounds ?? cracked.length} 道鎖，破解 ${cracked.length} 道${summary.result === 'noPlayers' ? '（所有破鎖者都已經破解過，提前收工）' : ''}`, '');
      if (cracked.length) parts.push('🔓 破解名單：', ...cracked.map((c) => { const p = byId.get(String(c.winnerId)) || {}; return p.admin ? `第 ${c.no} 道鎖｜${p.nickname || p.name || ''}` : `第 ${c.no} 道鎖｜${p.aid || '-'}｜${p.nickname || p.name || ''}`; }));
      else parts.push('😢 這次沒有人破解任何一道鎖，寶藏繼續沉睡……');
    } else if (game === 'es') {
      parts.push(`🚪 全員名單（${players.length} 人）：`, ...players.map(line));
      if (escFail) parts.push('', '🔒 未逃出，本輪無獎勵。');
    } else {
      const tagOf = (p) => {
        const un = p.username || p.tgName?.match(/@([A-Za-z0-9_]+)/)?.[1];
        return un ? `@${un}` : (p.nickname || p.name || '玩家');
      };
      if (winList.length) {
        const winnerTags = winList.map(tagOf).join(' ');
        parts.push(`🎉 恭喜優勝得主：${winnerTags}`);
        parts.push(`🥇 優勝名單${side}：`, ...winList.map(line));
      } else {
        parts.push(game === 'hg' ? '🐢 這局沒有人猜中湯底。' : '本局沒有優勝者。');
      }
      parts.push('', `👥 參與名單（${players.length} 人）：`, ...players.map(line));
    }
    if (round.prize > 0 && winList.some((p) => !p.admin)) parts.push('', payout?.live ? `🎁 獎金會自動寄到得獎者的遊戲信箱${overCap.size ? '（超過本輪贈送上限的部分由管理員審核）' : ''}。` : '🎁 獎金將於審核後派發。');
    const claimUrl = cfg.groups[key]?.claimUrl;
    const claimMarkup = claimUrl && !escFail ? kb([[{ text: '🎁 登入遊戲領獎', url: claimUrl }]]) : {};
    await sendLong(cfg.groups[key].chatId, parts.join('\n'), claimMarkup).catch((error) => log.warn(`result post failed: ${error.message}`));
  }
  /** 自動派獎 failure notices go to payout.notifyChatIds (minigame.local.json) or, by default, the admin who launched the round */
  const notifyTargets = (round) => { const ids = Array.isArray(cfg.payout?.notifyChatIds) && cfg.payout.notifyChatIds.length ? cfg.payout.notifyChatIds : [round.launchedBy?.id]; return [...new Set(ids.filter((x) => x != null).map(String))]; };
  /** a round's payout is final: rows get 是否派獎 / 派獎人員 / 派獎時間, then go to the records (sheet queue respects the 營運數據 window);
   *  failures → ONE notice per round to the admin(s) */
  async function settlePayout(job, items) {
    const byAid = new Map(items.filter((o) => !o.overCap).map((o) => [String(o.aid), o]));
    for (const row of job.rows || []) {
      const o = byAid.get(String(row.AID)); if (!o || row.是否派獎 !== PAY_PENDING) continue;
      if (o.status === PAY_SENT) {
        const time = stamp(o.sentAt || now());
        Object.assign(row, { 是否派獎: PAY_SENT, 派獎人員: AUTO_STAFF, 派獎時間: time });
        await records.update(job.groupKey, { 場次ID: job.round.id, AID: row.AID }, { 是否派獎: PAY_SENT, 派獎人員: AUTO_STAFF, 派獎時間: time }).catch((e) => log.warn(`records update failed: ${e.message}`));
      } else if (o.status === PAY_FAILED) {
        const note = [row.備註, o.note].filter(Boolean).join('；');
        Object.assign(row, { 是否派獎: PAY_FAILED, 備註: note });
        await records.update(job.groupKey, { 場次ID: job.round.id, AID: row.AID }, { 是否派獎: PAY_FAILED, 備註: note }).catch((e) => log.warn(`records update failed: ${e.message}`));
      }
    }
    const failed = items.filter((o) => !o.overCap && o.status === PAY_FAILED);
    if (!failed.length) return;
    const r = job.round;
    const text = [`⚠️ 自動派獎失敗｜${job.groupName}｜${gameLabel(r.game)}｜${r.id}`, `每位 ${fmtNum(r.prize)}${r.multiplier > 0 ? `（${r.multiplier} 倍打碼）` : ''}，以下 ${failed.length} 位沒有確認寄出：`, '',
      ...failed.map((o) => `• AID ${o.aid}${o.nickname ? `｜${o.nickname}` : ''}${o.lock != null ? `｜第 ${o.lock} 道鎖` : ''}\n　${o.note || PAY_FAILED}`), '',
      '請先核對後台有沒有寄出，沒有再手動補寄；紀錄表這幾列已標「派獎失敗」，補寄後請改成已派獎。系統不會自動重寄。'].join('\n');
    for (const chatId of job.notify?.length ? job.notify : notifyTargets(r)) await sendLong(chatId, text).catch((error) => log.warn(`payout notice to ${chatId} failed: ${error.message}`));
  }
  payout?.onSettled?.(settlePayout);
  function prune(d) {
    const cutoff = taipeiDate(now() - 7 * 864e5); for (const k of Object.keys(d.daily)) if (k < cutoff) delete d.daily[k];
    const old = now() - 30 * 864e5; for (const [id, r] of Object.entries(d.rounds)) if (r.status !== 'open' && (r.endedAt || r.createdAt) < old) delete d.rounds[id];
    for (const k of Object.keys(d.seq)) if (k < cutoff) delete d.seq[k];
  }

  // ---------- admin DM setup ----------
  const steps = (s) => ['game', 'vip', 'recharge', s.cond.recharge && 'rechargePeriod', 'wager', s.cond.wager && 'wagerPeriod', 'prize', s.prize > 0 && cfg.groups[s.key]?.multiplier && 'multiplier', s.prize > 0 && 'cap', s.game === 'es' && 'script', s.game === 'sc' && 'rounds', 'confirm'].filter(Boolean);
  const nextStep = (s) => { const list = steps(s); const i = list.indexOf(s.step); return list[Math.min(list.length - 1, i + 1)]; };
  const opt = (step, label, value) => ({ text: label, callback_data: `mg:su:${step}:${value}` });
  const custom = (step) => opt(step, '✏️ 自訂', 'in');
  const cancelRow = [opt('x', '✖️ 取消設定', 'x')];
  function setupSummary(s) {
    return [`🎮 ${gname(s.key)}｜${s.game ? gameLabel(s.game) : '（未選遊戲）'}`, `🎯 參與條件：${describeConditions(s.cond)}`, `🎁 獲勝獎金：${s.prize > 0 ? `每位 ${fmtNum(s.prize)}` : '不設'}${s.prize > 0 && cfg.groups[s.key]?.multiplier ? `｜打碼倍數：${s.multiplier > 0 ? `${s.multiplier} 倍` : '不設'}` : ''}`,
      ...(s.prize > 0 ? [`💰 本輪最多贈送總金額：${s.maxPayout > 0 ? `${fmtNum(s.maxPayout)}（最多 ${Math.floor(s.maxPayout / s.prize)} 位全額，超過列待審核）` : '未設定'}`] : []),
      ...(s.game === 'es' ? [`📖 劇本：${s.scriptId ? scriptTitle(s.key, s.scriptId) : '隨機'}`] : []), ...(s.game === 'sc' ? [`🔐 寶匣數：共 ${s.rounds || SC_DEFAULT_ROUNDS} 道鎖（每道鎖 10 分鐘，一道鎖一位破解者）`] : []), `👑 管理員可參加：${s.adminCanJoin ? '是' : '否'}`].join('\n');
  }
  const scriptTitle = (key, id) => { const sc = ensureFlows(key)?.es.scripts().find((x) => x.id === id); return sc ? `${sc.emoji} ${sc.title}` : id; };
  async function renderStep(uid, s) {
    const u = String(uid); const head = `⚙️ 發起遊戲（第 ${steps(s).indexOf(s.step) + 1}/${steps(s).length} 步）\n`;
    let text; let rows;
    switch (s.step) {
      case 'game': text = `${head}要在「${gname(s.key)}」發起哪個遊戲？`; rows = pairs(GAME_KEYS.map((g) => opt('game', gameLabel(g), g))); break;
      case 'vip': text = `${head}VIP 等級條件（達到幾級以上才能報名）`; rows = [[opt('vip', '不限', 'none')], [1, 2, 3, 4, 5].map((n) => opt('vip', `VIP ${n}`, n)), [6, 7, 8, 9, 10].map((n) => opt('vip', `VIP ${n}`, n))]; break;
      case 'recharge': text = `${head}儲值條件（期間內儲值滿多少）`; rows = [[opt('recharge', '不限', 'none')], [500, 1000, 3000].map((n) => opt('recharge', fmtNum(n), n)), [5000, 10000].map((n) => opt('recharge', fmtNum(n), n)).concat(custom('recharge'))]; break;
      case 'rechargePeriod': text = `${head}儲值計算期間`; rows = [[opt('rechargePeriod', '今日', 'today'), opt('rechargePeriod', '✏️ 指定期間', 'in')]]; break;
      case 'wager': text = `${head}打碼條件（期間內有效投注滿多少）`; rows = [[opt('wager', '不限', 'none')], [10000, 50000, 100000].map((n) => opt('wager', fmtNum(n), n)), [500000, 1000000].map((n) => opt('wager', fmtNum(n), n)).concat(custom('wager'))]; break;
      case 'wagerPeriod': text = `${head}打碼計算期間`; rows = [[opt('wagerPeriod', '今日', 'today'), opt('wagerPeriod', '✏️ 指定期間', 'in')]]; break;
      case 'prize': text = `${head}每位優勝的獎金${s.game === 'es' ? '（密室逃脫＝每位參與者）' : s.game === 'sc' ? '（千鎖秘藏＝每破解一道鎖的人）' : ''}`; rows = [[opt('prize', '不設', 0)], [100, 300, 500].map((n) => opt('prize', fmtNum(n), n)), [1000, 3000].map((n) => opt('prize', fmtNum(n), n)).concat(custom('prize'))]; break;
      case 'cap': text = `${head}本輪最多贈送總金額（必填）\n每位 ${fmtNum(s.prize)}，依結果順序派到上限為止（不拆分），超過的優勝者列為待審核`; rows = [[1, 2, 3].map((n) => opt('cap', `${fmtNum(s.prize * n)}（${n} 位）`, s.prize * n)), [5, 10].map((n) => opt('cap', `${fmtNum(s.prize * n)}（${n} 位）`, s.prize * n)).concat(custom('cap'))]; break;
      case 'multiplier': text = `${head}獎金打碼倍數`; rows = [[opt('multiplier', '不設', 0), ...[1, 3, 5, 10].map((n) => opt('multiplier', `${n} 倍`, n))], [custom('multiplier')]]; break;
      case 'script': { const list = ensureFlows(s.key)?.es.scripts() || []; text = `${head}選擇密室逃脫劇本`; rows = [[opt('script', '🎲 隨機（避開最近玩過的）', 'rand')]]; for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((x) => opt('script', `${x.emoji} ${x.title}`.slice(0, 30), x.id))); break; }
      case 'rounds': text = `${head}總共幾道鎖（輪數）？每道鎖 10 分鐘，破解過的人之後的鎖不能再猜`; rows = [SC_ROUND_CHOICES.map((n) => opt('rounds', `${n} 道鎖`, n)), [custom('rounds')]]; break;
      default: text = `✅ 請確認設定\n\n${setupSummary(s)}`; rows = [[opt('ok', '🚀 確認發起', 'go')], ...(s.game === 'sc' ? [[opt('sched', '⏰ 存成每日排程（到時間自動開局）', 'in')]] : []), [opt('aj', `👑 管理員可參加：${s.adminCanJoin ? '是' : '否'}（點此切換）`, 't')], [opt('reset', '🔁 重新設定', 'r')]];
    }
    if (s.step !== 'confirm' && s.step !== 'game') text += `\n\n目前設定：${describeConditions(s.cond)}`;
    if (s.lastMsg) await stripButtons(s.lastMsg);
    const m = await send(u, text, kb([...rows, cancelRow]));
    s.lastMsg = { message_id: m.message_id, chat: { id: m.chat.id } }; s.updatedAt = now(); G.setups[u] = s; globalStore.save();
  }
  async function beginSetup(user, key, game = null) {
    const gc = cfg.groups[key];
    if (!gc || gc.chatId == null || !(await isAdmin(gc.chatId, user.id))) return send(user.id, '你不是這個社群的管理員，無法發起遊戲。');
    const s = { key, game: game && GAMES[game] ? game : null, step: 'game', cond: { vip: null, recharge: null, wager: null }, prize: 0, multiplier: 0, maxPayout: 0, scriptId: null, rounds: SC_DEFAULT_ROUNDS, adminCanJoin: true, awaiting: null, createdAt: now() };
    if (s.game) s.step = 'vip';
    return renderStep(user.id, s);
  }
  async function onSetupCallback(cq, step, value) {
    const uid = String(cq.from.id); const s = G.setups[uid];
    if (!s) return answer(cq, '設定已過期，請重新發起');
    if (step === 'x') { delete G.setups[uid]; globalStore.save(); await stripButtons(cq.message); await answer(cq, '已取消'); return send(uid, '已取消這次設定。'); }
    if (step === 'reset') { await answer(cq); return beginSetup(cq.from, s.key, null); }
    if (step === 'aj') { s.adminCanJoin = !s.adminCanJoin; await answer(cq, `管理員可參加：${s.adminCanJoin ? '是' : '否'}`); return renderStep(uid, s); }
    if (step === 'ok' && s.prize > 0 && !(s.maxPayout >= s.prize)) { await answer(cq, '請先設定本輪最多贈送總金額'); s.step = 'cap'; return renderStep(uid, s); }
    if (step === 'sched' && s.prize > 0 && !(s.maxPayout >= s.prize)) { await answer(cq, '請先設定本輪最多贈送總金額'); s.step = 'cap'; return renderStep(uid, s); }
    if (step === 'ok') { await answer(cq, '發起中…'); await stripButtons(cq.message); return launch(cq.from, s); }
    if (step === 'sched') { if (s.step !== 'confirm') return answer(cq, '這個按鈕已過期，請用最新的設定訊息'); s.awaiting = 'schedTime'; G.setups[uid] = s; globalStore.save(); await answer(cq); return send(uid, `⏰ 每天幾點自動在「${gname(s.key)}」開局？（台北時間，例：20:00）\n開局後一樣有 ${SCC_LOBBY_MS / 60e3} 分鐘報名，時間到自動開始。`); }
    if (step !== s.step) return answer(cq, '這個按鈕已過期，請用最新的設定訊息');
    if (value === 'in') {
      s.awaiting = step; G.setups[uid] = s; globalStore.save(); await answer(cq);
      const hint = { recharge: '請輸入儲值門檻金額（例：2000、1.5萬）：', wager: '請輸入打碼門檻（例：30000、5萬）：', prize: '請輸入每位優勝的獎金：', multiplier: '請輸入打碼倍數（例：3）：', cap: `請輸入本輪最多贈送總金額（例：3000、1萬；不可低於每位獎金 ${fmtNum(s.prize)}）：`, rounds: `請輸入總共幾道鎖（1–${SC_MAX_ROUNDS}）：`, rechargePeriod: '請輸入儲值計算期間（例：10/01-10/03，或單日 10/02）：', wagerPeriod: '請輸入打碼計算期間（例：10/01-10/03，或單日 10/02）：' }[step];
      return send(uid, hint);
    }
    if (step === 'cap' && !(Number(value) >= s.prize)) return answer(cq, '上限不能低於每位獎金');
    await answer(cq);
    applySetup(s, step, value);
    s.step = nextStep(s); return renderStep(uid, s);
  }
  function applySetup(s, step, value) {
    const n = Number(value);
    if (step === 'game') s.game = value;
    if (step === 'vip') s.cond.vip = value === 'none' ? null : n;
    if (step === 'recharge') s.cond.recharge = value === 'none' || !(n > 0) ? null : { min: n, period: { type: 'today' } };
    if (step === 'wager') s.cond.wager = value === 'none' || !(n > 0) ? null : { min: n, period: { type: 'today' } };
    if (step === 'rechargePeriod' && s.cond.recharge) s.cond.recharge.period = typeof value === 'object' ? value : { type: 'today' };
    if (step === 'wagerPeriod' && s.cond.wager) s.cond.wager.period = typeof value === 'object' ? value : { type: 'today' };
    if (step === 'prize') { s.prize = n > 0 ? n : 0; if (!s.prize) { s.multiplier = 0; s.maxPayout = 0; } }
    if (step === 'cap') s.maxPayout = n > 0 ? n : 0;
    if (step === 'multiplier') s.multiplier = n > 0 ? n : 0;
    if (step === 'script') s.scriptId = value === 'rand' ? null : value;
    if (step === 'rounds') s.rounds = Math.min(SC_MAX_ROUNDS, Math.max(1, Math.floor(n) || SC_DEFAULT_ROUNDS));
  }
  async function onSetupText(msg, s) {
    const uid = String(msg.from.id); const step = s.awaiting; const t = String(msg.text || '').trim();
    let value = null;
    if (step === 'rechargePeriod' || step === 'wagerPeriod') { const p = parsePeriod(t, now()); if (p) value = { type: 'range', ...p }; }
    else if (step === 'multiplier') { const n = Number(t.replace(/倍/, '')); if (n > 0 && n <= 100) value = n; }
    else if (step === 'rounds') { const n = Number(t.replace(/道鎖|道|輪/g, '').trim()); if (Number.isInteger(n) && n >= 1 && n <= SC_MAX_ROUNDS) value = n; }
    else if (step === 'schedTime') { const m = /^(\d{1,2})[:：](\d{2})$/.exec(t); if (m && Number(m[1]) < 24 && Number(m[2]) < 60) value = `${m[1].padStart(2, '0')}:${m[2]}`; }
    else { const n = parseAmount(t); if (n != null && n > 0) value = n; }
    if (value == null) return send(uid, '格式不對，請再輸入一次（或按上一則的「✖️ 取消設定」）：');
    if (step === 'cap' && value < s.prize) return send(uid, `上限不能低於每位獎金 ${fmtNum(s.prize)}，請再輸入一次：`);
    if (step === 'schedTime') { s.awaiting = null; return createSchedule(msg.from, s, value); }
    s.awaiting = null; applySetup(s, step, value); s.step = nextStep(s); return renderStep(uid, s);
  }
  async function launch(user, s, { scheduled = null } = {}) {
    const uid = String(user.id); const key = s.key; const gc = cfg.groups[key]; const tag = scheduled ? `⏰ 排程 #${scheduled.id}：` : '';
    if (!gc?.chatId || !(await isAdmin(gc.chatId, user.id))) return send(uid, '你不是這個社群的管理員，無法發起遊戲。');
    return serial(async () => {
      const ad = adapter(key, s.game);
      if (ad.state() || activeRound(key, s.game)) return send(uid, `${tag}${gameLabel(s.game)} 在 ${gname(key)} 已經有一局進行中，${scheduled ? '這次自動開局跳過。' : '請等這局結束或先臨時終止。'}`);
      const st = S(key); const d = st.data; const date = taipeiDate(now());
      const roundNo = ((d.seq[date] ||= {})[s.game] = (d.seq[date][s.game] || 0) + 1);
      const id = `${gc.short || key.slice(0, 2).toUpperCase()}${date.slice(5, 7)}${date.slice(8, 10)}-${CODE[s.game]}${roundNo}`;
      const round = { id, key, game: s.game, date, roundNo, createdAt: now(), launchedBy: { id: user.id, name: tgName(user) }, conditions: s.cond, prize: s.prize || 0, multiplier: s.prize > 0 ? (s.multiplier || 0) : 0, maxPayout: s.prize > 0 ? (s.maxPayout || 0) : 0, adminCanJoin: s.adminCanJoin, scriptId: s.scriptId || null, ...(s.game === 'sc' ? { rounds: s.rounds || SC_DEFAULT_ROUNDS } : {}), ...(scheduled ? { scheduleId: scheduled.id } : {}), status: 'open', participants: {} };
      d.rounds[id] = round; st.save();
      let r;
      try { r = await ad.open(round); } catch (error) { r = { error: error.message }; }
      if (!r?.opened) { delete d.rounds[id]; d.seq[date][s.game] -= 1; st.save(); log.warn(`open ${id} failed: ${JSON.stringify(r)}`); return send(uid, `${tag}⚠️ 發起失敗：${r?.busy ? '這個遊戲已經有一局進行中' : r?.unavailable ? '這個遊戲目前無法使用（海龜湯出題服務暫時無法連線）' : r?.error || '未知錯誤'}`); }
      round.gameId = r.gameId || null; st.save(); if (!scheduled) { delete G.setups[uid]; globalStore.save(); }
      log.info(`round ${id} opened by ${user.id} in ${key}${scheduled ? ` (schedule ${scheduled.id})` : ''}`);
      return send(uid, `${tag}✅ 已在「${gname(key)}」發起 ${gameLabel(s.game)} 第 ${roundNo} 輪（${id}）\n${setupSummary(s)}\n\n報名期間群組的報名訊息上也有 ▶️ 開始／⛔ 臨時終止（只有管理員按得動）。`, kb([[{ text: '▶️ 立即開始', callback_data: `mg:s:${s.game}:${key}` }, { text: '⛔ 臨時終止', callback_data: `mg:x:${s.game}:${key}` }]]));
    });
  }

  // ---------- 自動開局排程 (DM; G.schedules persists in global.json) ----------
  G.schedules ||= {};
  const SETUP_FIELDS = ['key', 'game', 'cond', 'prize', 'multiplier', 'maxPayout', 'scriptId', 'rounds', 'adminCanJoin'];
  async function createSchedule(user, s, time) {
    const uid = String(user.id); const gc = cfg.groups[s.key];
    if (!gc?.chatId || !(await isAdmin(gc.chatId, user.id))) return send(uid, '你不是這個社群的管理員，無法建立排程。');
    let seq = Object.keys(G.schedules).length + 1; let id; do { id = `s${seq++}`; } while (G.schedules[id]);
    const today = taipeiDate(now()); const [hh, mm] = time.split(':').map(Number);
    const setup = structuredClone(Object.fromEntries(SETUP_FIELDS.map((k) => [k, s[k] ?? null])));
    G.schedules[id] = { id, key: s.key, game: s.game, time, setup, createdBy: { id: user.id, name: tgName(user) }, createdAt: now(), lastRun: taipeiHm(now()) >= hh * 60 + mm ? today : null };
    if (s.lastMsg) await stripButtons(s.lastMsg);
    delete G.setups[uid]; globalStore.save();
    log.info(`schedule ${id} created by ${user.id}: ${s.key} ${s.game} daily ${time}`);
    return send(uid, `✅ 已建立排程 #${id}：每天 ${time}（台北時間）自動在「${gname(s.key)}」開 ${gameLabel(s.game)}${G.schedules[id].lastRun === today ? '\n（今天的時間已過，明天開始）' : ''}\n\n${setupSummary({ ...setup })}\n\n查看／刪除排程：/schedules 或控制台的「⏰ 自動開局排程」。`);
  }
  function scheduleLine(sc) {
    const s = sc.setup || {};
    return [`#${sc.id}｜${gname(sc.key)}｜${gameLabel(sc.game)}｜每天 ${sc.time}`, `　🎯 ${describeConditions(s.cond || {})}｜🎁 ${prizeLabel(s)}${s.prize > 0 && s.maxPayout > 0 ? `｜上限 ${fmtNum(s.maxPayout)}` : ''}${sc.game === 'sc' ? `｜${s.rounds || SC_DEFAULT_ROUNDS} 道鎖` : ''}｜👑 管理員${s.adminCanJoin ? '可' : '不'}參加`, `　建立：${sc.createdBy?.name || sc.createdBy?.id || '-'}${sc.lastRun ? `｜上次執行：${md(sc.lastRun)}` : ''}`].join('\n');
  }
  async function listSchedules(user) {
    const keys = await adminGroupsOf(user.id);
    if (!keys.length) return send(user.id, ADMIN_ONLY);
    const list = Object.values(G.schedules).filter((x) => keys.includes(x.key)).sort((a, b) => a.time.localeCompare(b.time));
    const text = list.length ? ['⏰ 自動開局排程（台北時間）', '', ...list.map(scheduleLine)].join('\n') : '⏰ 目前沒有自動開局排程。\n建立方式：控制台「➕ 發起遊戲」→ 選 🔐 千鎖秘藏 → 設定完在確認頁按「⏰ 存成每日排程」。';
    return send(user.id, text, kb(list.map((x) => [{ text: `🗑 刪除 #${x.id}（${gname(x.key)} ${x.time}）`, callback_data: `mg:sd:${x.id}` }])));
  }
  async function deleteSchedule(cq, id) {
    const sc = G.schedules[id]; if (!sc) return answer(cq, '這個排程已經不存在');
    const gc = cfg.groups[sc.key]; if (!gc?.chatId || !(await isAdmin(gc.chatId, cq.from.id))) return answer(cq, ADMIN_ONLY, true);
    delete G.schedules[id]; globalStore.save(); log.info(`schedule ${id} deleted by ${cq.from.id}`);
    await answer(cq, `已刪除排程 #${id}`); await stripButtons(cq.message);
    return listSchedules(cq.from);
  }
  async function runSchedules() {
    const today = taipeiDate(now()); const cur = taipeiHm(now());
    for (const sc of Object.values(G.schedules)) {
      const [hh, mm] = String(sc.time).split(':').map(Number); const due = hh * 60 + mm;
      if (sc.lastRun === today || cur < due || cur - due > SCHED_WINDOW_MIN || !cfg.groups[sc.key]?.chatId) continue;
      sc.lastRun = today; globalStore.save();
      log.info(`schedule ${sc.id}: auto launch ${sc.game} in ${sc.key}`);
      try { await launch({ id: sc.createdBy.id, first_name: sc.createdBy.name || String(sc.createdBy.id) }, { ...structuredClone(sc.setup), key: sc.key, game: sc.game }, { scheduled: sc }); }
      catch (error) { log.warn(`schedule ${sc.id} launch failed: ${error.message}`); }
    }
  }

  // ---------- admin console (DM) ----------
  async function showAdminMenu(user, key = null, message = null) {
    const keys = await adminGroupsOf(user.id);
    if (!keys.length) return send(user.id, '目前查不到你管理的社群。請確認 Bot 在該社群內，且你的 Telegram 帳號具管理員身分。');
    if (key && !keys.includes(key)) return send(user.id, ADMIN_ONLY);
    const rows = []; const lines = key
      ? [`🎛 小遊戲精靈｜${gname(key)}`, '請選擇要管理的功能：']
      : ['🎛 小遊戲精靈｜管理員控制台', '請先選擇社群：'];
    if (key) {
      const active = GAME_KEYS.filter((game) => activeRound(key, game));
      lines.push('');
      if (!active.length) lines.push('• 目前沒有進行中的小遊戲');
      for (const game of active) {
        const round = activeRound(key, game);
        lines.push(`• ${gameLabel(game)} 第 ${round.roundNo} 輪｜${adapter(key, game).state()?.stage === 'lobby' ? '報名中' : '進行中'}｜${Object.keys(round.participants).length} 人`);
        rows.push([{ text: `▶️ 開始 ${GAMES[game].name}`, callback_data: `mg:s:${game}:${key}` }, { text: `⛔ 終止 ${GAMES[game].name}`, callback_data: `mg:x:${game}:${key}` }]);
      }
      rows.push([{ text: '🎮 發起小遊戲', callback_data: `mg:new:${key}` }, { text: '👹 BOSS 設定', callback_data: `mg:pet:boss:${key}` }]);
      rows.push([{ text: '🏆 季賽天梯', callback_data: `mg:pet:season:${key}` }, { text: '👤 AID 綁定管理', callback_data: `mg:aid:${key}` }]);
      rows.push([{ text: '🐾 寵物綁定與玩家狀態', callback_data: `mg:players:${key}:1` }]);
      rows.push([{ text: '↩️ 返回社群選單', callback_data: 'mg:menu' }]);
    } else {
      for (const groupKey of keys) rows.push([{ text: `📁 ${gname(groupKey)}`, callback_data: `mg:menu:${groupKey}` }]);
      const nSched = Object.values(G.schedules).filter((x) => keys.includes(x.key)).length;
      rows.push([{ text: `⏰ 自動開局排程（${nSched}）`, callback_data: 'mg:sl' }]);
    }
    if (message?.message_id) {
      try {
        const edited = await call('editMessageText', { chat_id: user.id, message_id: message.message_id, text: lines.join('\n'), ...kb(rows) });
        G.adminMenus[String(user.id)] = { message_id: message.message_id }; globalStore.save();
        return edited;
      } catch (error) {
        if (/message is not modified/i.test(error.message)) return message;
        log.warn(`admin menu edit failed: ${error.message}`);
      }
    }
    const previous = G.adminMenus[String(user.id)];
    if (previous?.message_id) await stripButtons({ message_id: previous.message_id, chat: { id: user.id } });
    const sent = await send(user.id, lines.join('\n'), kb(rows));
    if (sent?.message_id) { G.adminMenus[String(user.id)] = { message_id: sent.message_id }; globalStore.save(); }
    return sent;
  }
  const adminConsole = (user) => showAdminMenu(user);
  async function showPetPlayers(cq, key, rawPage) {
    const gc = cfg.groups[key];
    if (!gc?.chatId || !(await isAdmin(gc.chatId, cq.from.id, true))) return answer(cq, ADMIN_ONLY, true);
    const page = Number(rawPage);
    if (!Number.isSafeInteger(page) || page < 1) return answer(cq, '頁碼無效', true);
    const bindings = Object.entries(S(key).data.bindings).flatMap(([tgId, binding]) =>
      (binding.aids || []).map((aid) => ({ tgId, aid: String(aid), nickname: binding.nicknames?.[aid] || null, updatedAt: binding.updatedAt || binding.boundAt || 0 })));
    bindings.sort((a, b) => b.updatedAt - a.updatedAt || a.tgId.localeCompare(b.tgId));
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(bindings.length / pageSize));
    if (page > totalPages) return answer(cq, '這一頁沒有資料', true);
    await answer(cq);
    const players = bindings.slice((page - 1) * pageSize, page * pageSize);
    const accounts = await Promise.allSettled(players.map((player) => pStore.refreshAccount(key, player.tgId)));
    const stages = { young: '幼體', growing: '成長體', mature: '成熟體', complete: '完全體' };
    const lines = [`🐾 ${gname(key)}｜寵物綁定與玩家狀態`, `已綁定 ${bindings.length} 筆 AID｜第 ${page}/${totalPages} 頁`, ''];
    if (!players.length) lines.push('目前沒有綁定資料。');
    for (const [index, player] of players.entries()) {
      const name = player.nickname || '未提供暱稱';
      const lookup = accounts[index];
      const account = lookup.status === 'fulfilled' && String(lookup.value?.aid) === player.aid ? lookup.value : null;
      const pet = account?.pet;
      const state = lookup.status === 'rejected' ? '雲端狀態暫時無法讀取' : !pet ? '尚未領養此 AID' : pet.life === 'dead' ? '已死亡' : `存活・${stages[pet.stage] || pet.stage || '未知階段'}`;
      lines.push(`• ${name}｜AID ${player.aid}`);
      lines.push(`  TG ${player.tgId}｜${state}`);
      if (pet) {
        const lastActivity = [pet.lastCareDay, pet.lastStatusDay, pet.lastTrainingDay, pet.lastPlayDay, pet.lastLoginBonusDay].filter(Boolean).sort().at(-1) || '—';
        lines.push(`  最近紀錄 ${lastActivity}｜點數 ${account.points ?? 0}・進化石 ${account.stones ?? 0}`);
        lines.push(`  照顧 ${pet.lastCareDay || '—'}・玩耍 ${pet.lastPlayDay || '—'}｜PVP ${account.pvp?.wins ?? 0}勝/${account.pvp?.losses ?? 0}敗`);
      }
    }
    const nav = [];
    if (page > 1) nav.push({ text: '⬅️ 上一頁', callback_data: `mg:players:${key}:${page - 1}` });
    if (page < totalPages) nav.push({ text: '下一頁 ➡️', callback_data: `mg:players:${key}:${page + 1}` });
    const rows = [...(nav.length ? [nav] : []), [{ text: '🔄 更新', callback_data: `mg:players:${key}:${page}` }, { text: '↩️ 返回平台管理', callback_data: `mg:menu:${key}` }]];
    try { return await call('editMessageText', { chat_id: cq.from.id, message_id: cq.message.message_id, text: lines.join('\n'), ...kb(rows) }); }
    catch (error) { if (/message is not modified/i.test(error.message)) return null; return send(cq.from.id, lines.join('\n'), kb(rows)); }
  }

  async function adminAction(cq, act, game, key) {
    const gc = cfg.groups[key]; if (!gc?.chatId || !GAMES[game]) return answer(cq);
    if (!(await isAdmin(gc.chatId, cq.from.id))) return answer(cq, ADMIN_ONLY, true);
    const ad = adapter(key, game);
    if (act === 's') { const r = await ad.start(); return answer(cq, r?.text || (r?.started ? '開始！' : '目前無法開始'), !r?.started); }
    const ck = `${cq.from.id}:${key}:${game}`; const pend = confirmAbort.get(ck);
    if (!pend || now() - pend > 10000) { confirmAbort.set(ck, now()); return answer(cq, `確定要臨時終止 ${GAMES[game].name}？10 秒內再按一次 ⛔ 確認。`, true); }
    confirmAbort.delete(ck);
    const r = await ad.abort('管理員臨時終止了這一局。');
    const round = activeRound(key, game); if (round && r?.inactive) { round.status = 'aborted'; round.endedAt = now(); S(key).save(); } // flow already gone: close the stale round
    return answer(cq, r?.aborted ? '已終止本局' : '目前沒有進行中的這個遊戲');
  }

  // ---------- AID admin commands ----------
  async function addAid(replyTo, key, uid, aid, user) {
    if (!AID_RE.test(String(aid))) return send(replyTo, 'AID 格式不對');
    let p = null; try { p = await backendFor(key).lookup(aid); } catch (error) { return send(replyTo, `小精靈查詢失敗：${error.message.slice(0, 100)}`); }
    if (!p) return send(replyTo, `小精靈查無 AID ${aid}`);
    const r = bindAid(key, uid, String(aid), { nickname: p.nickname, by: `admin:${user.id}` });
    if (r.ok) void wagerSync?.syncOneBinding?.(key, uid, String(aid), p.nickname);
    return send(replyTo, r.ok ? `✅ 已為 TG ${uid} 加綁 AID ${aid}${p.nickname ? `（${p.nickname}）` : ''}；目前：${r.binding.aids.join('、')}` : `❌ ${r.text}`);
  }
  async function dmAdminCommand(msg, c) {
    const uid = msg.from.id; const [key, a, b] = c.args.split(/\s+/);
    const gc = cfg.groups[key]; if (!gc?.chatId || !(await isAdmin(gc.chatId, uid))) return send(uid, `請指定你管理的社群代號（${Object.keys(cfg.groups).join(' / ')}）`);
    if (c.name === 'addaid') return a && b ? addAid(uid, key, a, b, msg.from) : send(uid, '用法：/addaid 社群 TG數字ID AID');
    if (c.name === 'delaid') { if (!a) return send(uid, '用法：/delaid 社群 AID'); const r = unbindAid(key, a); return send(uid, r.ok ? `✅ 已解除 AID ${a}（原 TG ${r.owner}）` : `❌ ${r.text}`); }
    if (c.name === 'aidinfo') {
      const d = S(key).data; const owner = d.aidOwner[a] || (d.bindings[a] ? a : null); const bd = owner && d.bindings[owner];
      return send(uid, bd ? `TG ${owner}：AID ${bd.aids.map((x) => `${x}${bd.nicknames?.[x] ? `（${bd.nicknames[x]}）` : ''}`).join('、')}` : '查無綁定');
    }
    return null;
  }

  // ---------- update routing ----------
  async function onMessage(msg) {
    const text = msg.text || ''; const chat = msg.chat || {};
    if (chat.type === 'private') return onPrivate(msg, text);
    const key = keyByChat(chat.id); const c = cmdOf(text);
    if (c && c.at && botUsername() && c.at.toLowerCase() !== botUsername().toLowerCase()) return null;
    if (c?.name === 'bindgroup') return bindGroup(msg, c.args);
    if (!key) return null;
    const ADMIN_CMDS = ['admin', 'panel', 'setup', 'game', 'stop', 'addaid', 'delaid', 'aidinfo', 'schedules', 'boss', 'season'];
    if (c && ADMIN_CMDS.includes(c.name)) {
      await del(chat.id, msg.message_id); // commands never stay in the group
      if (!(await msgFromAdmin(msg))) return { ignored: 'non-admin command' };
      const m = await send(chat.id, '🔒 管理員功能已集中到私訊，這裡不會顯示管理按鈕。請開啟「小遊戲精靈」私訊並輸入 /admin。');
      delLater(m, 15000);
      return m;
    }
    if (c?.name === 'rank' || c?.name === 'leaderboard') {
      return petFlow.showSeasonRankings(null, key, chat.id);
    }
    if (['🐾 我的寵物', '🐣✨ 我的寵物'].includes(text.trim()) || c?.name === 'pet' || c?.name === 'mypet') {
      await del(chat.id, msg.message_id);
      return sendPetDmLink(key, chat.id);
    }
    if (c?.name === 'play') return petFlow.startPlayInvite({ from: msg.from }, key);
    if (c?.name === 'pvp') return petFlow.startPvPChallenge({ from: msg.from }, key);
    const f = ensureFlows(key); if (!f) return null;
    for (const fl of [f.sc, f.hg, f.es, f.uc, f.ww]) { const r = await fl.onMessage(msg, text); if (r) return r; }
    return null;
  }
  async function ensurePetEntryMessages() {
    for (const [key, group] of groups()) {
      if (!group?.chatId) continue;
      try { await postPetEntry(key, { removeOldPanel: true }); }
      catch (error) { log.warn(`pet Mini App entry post failed for ${key}: ${error.message}`); }
    }
  }
  async function bindGroup(msg, arg) {
    await del(msg.chat.id, msg.message_id);
    if (!(await msgFromAdmin(msg))) return { ignored: 'non-admin bindgroup' };
    const m = await send(msg.chat.id, '🔒 社群綁定設定已移至私訊。請私訊 Bot 輸入：/bindgroup 社群代號 群組Chat ID');
    delLater(m, 15000);
    return null;
  }
  async function bindGroupInPrivate(user, args) {
    const [key, rawChatId] = String(args || '').trim().split(/\s+/);
    const chatId = rawChatId && /^-\d{5,20}$/.test(rawChatId) ? rawChatId : null;
    if (!cfg.groups[key] || !chatId) return send(user.id, `用法：/bindgroup 社群代號 群組Chat ID\n社群代號：${Object.keys(cfg.groups).join(' / ')}\nChat ID 通常以 -100 開頭。`);
    if (!(await isAdmin(chatId, user.id, true))) return send(user.id, `無法確認你是 Chat ID ${chatId} 的管理員，並確認 Bot 已加入該群。`);
    const clash = keyByChat(chatId);
    if (clash && clash !== key) return send(user.id, `這個群已綁定為 ${clash}，請先確認社群設定。`);
    cfg.groups[key].chatId = chatId;
    flows.delete(key); ensureFlows(key);
    try { await saveGroupChatId?.(key, chatId); } catch (error) { log.warn(`save chat id failed: ${error.message}`); }
    log.info(`group ${key} bound to chat ${chatId}`);
    return send(user.id, `✅ 已將「${gname(key)}」綁定至群組 ${chatId}。`);
  }
  async function onPrivate(msg, text) {
    const user = msg.from; const uid = String(user.id); const c = cmdOf(text);
    if (await petFlow.handleAdminText(msg, text)) return null;
    if (c?.name === 'bindgroup') return bindGroupInPrivate(user, c.args);
    if (c?.name === 'pet') {
      const boundKeys = groups()
        .map(([k]) => k)
        .filter((k) => binding(k, uid)?.aids?.length > 0);
      const rows = [];
      if (boundKeys.length > 1) {
        for (const k of boundKeys) {
          rows.push([petAppButton(`🐾 開啟【${gname(k)}】寵物 (Mini App)`, cfg, { product: k, chatId: user.id })]);
        }
      } else {
        const target = boundKeys[0] || 'yingma';
        rows.push([petAppButton(`🐾 開啟【${gname(target)}】寵物 (Mini App)`, cfg, { product: target, chatId: user.id })]);
      }
      return send(uid, '🐾 【小遊戲精靈 寵物養成系統】\n點擊下方按鈕即可開啟 Telegram Mini App，隨時照顧、餵養、訓練你的寵物！\n在各社群群組中輸入 /play 或 /pvp 可發起互動，並於每日首領降臨時討伐 BOSS 獲取進化石！', kb(rows));
    }
    if (c?.name === 'start') {
      delete G.pending[uid]; globalStore.save();
      const p = c.args;
      const petStart = /^pet_([a-z0-9]+)$/.exec(p);
      if (petStart && cfg.groups[petStart[1]]) {
        const key = petStart[1];
        const appUrl = new URL(petMiniAppUrl(cfg));
        appUrl.searchParams.set('product', key);
        return send(uid, `🐾【${gname(key)}寵物 Mini App】\n點擊下方按鈕開啟；如果尚未領養，進入後就能開始建立專屬寵物。`, kb([[petAppButton('✨ 開啟寵物', { ...cfg, petMiniAppUrl: appUrl.toString() }, { product: key, chatId: user.id })]]));
      }
      let m = /^su_([a-z0-9]+)_(ww|uc|hg|es|sc)$/.exec(p); if (m && cfg.groups[m[1]]) return dmSignup(user, m[1], m[2]);
      m = /^st_([a-z0-9]+)(?:_(ww|uc|hg|es|sc))?$/.exec(p); if (m && cfg.groups[m[1]]) { const gc = cfg.groups[m[1]]; if (!(await isAdmin(gc.chatId, user.id))) return send(uid, '這裡是小遊戲精靈 🎮 請到社群的報名訊息按「🎟 報名」參加遊戲。'); return beginSetup(user, m[1], m[2] || null); }
      let mb = /^boss_([a-z0-9]+)$/.exec(p); if (mb && cfg.groups[mb[1]]) { const gc = cfg.groups[mb[1]]; if (!(await isAdmin(gc.chatId, user.id, true))) return send(uid, '你不是這個社群的管理員，無法設定 BOSS。'); return petFlow.showAdminBossPanel({ from: user }, mb[1], uid); }
      let ms = /^season_([a-z0-9]+)$/.exec(p); if (ms && cfg.groups[ms[1]]) { const gc = cfg.groups[ms[1]]; if (!(await isAdmin(gc.chatId, user.id, true))) return send(uid, '你不是這個社群的管理員，無法設定季賽天梯。'); return petFlow.showAdminSeasonPanel({ from: user }, ms[1], uid); }
      let mBind = /^bind_([a-z0-9]+)$/.exec(p);
      if (mBind && cfg.groups[mBind[1]]) {
        const targetKey = mBind[1];
        G.pending[uid] = { kind: 'aid', key: targetKey, direct: true, at: now() };
        globalStore.save();
        return send(uid, `🔗【綁定社群遊戲 AID】\n您正在為「${gname(targetKey)}」綁定遊戲會員 AID！\n\n請直接在下方輸入您在「${gname(targetKey)}」的遊戲 AID（純數字）：\n（若需取消請輸入 /cancel）`);
      }
      if (p === 'adm') return adminConsole(user);
      const isAdm = (await adminGroupsOf(user.id)).length > 0;
      if (isAdm) return adminConsole(user);
      const boundKeys = groups()
        .map(([k]) => k)
        .filter((k) => binding(k, uid)?.aids?.length > 0);
      const rows = [];
      if (boundKeys.length > 1) {
        for (const k of boundKeys) {
          rows.push([petAppButton(`🐾 開啟【${gname(k)}】寵物 (Mini App)`, cfg, { product: k, chatId: user.id })]);
        }
      } else {
        const target = boundKeys[0] || 'yingma';
        rows.push([petAppButton(`🐾 開啟【${gname(target)}】寵物 (Mini App)`, cfg, { product: target, chatId: user.id })]);
      }
      return send(uid, '這裡是小遊戲精靈 🎮\n• 到社群的報名訊息按「🎟 報名」可參加團體小遊戲\n• 點擊下方按鈕即可開啟「寵物養成 Mini App」！', kb(rows));
    }
    if (c?.name === 'cancel') { delete G.pending[uid]; if (G.setups[uid]) { await stripButtons(G.setups[uid].lastMsg); delete G.setups[uid]; } globalStore.save(); return send(uid, '已取消。'); }
    if (c?.name === 'myaid') {
      const lines = groups().map(([key]) => { const b = binding(key, uid); return b?.aids?.length ? `${gname(key)}：${b.aids.map((a) => `${a}${b.nicknames?.[a] ? `（${b.nicknames[a]}）` : ''}`).join('、')}` : null; }).filter(Boolean);
      return send(uid, lines.length ? `你綁定的 AID：\n${lines.join('\n')}\n如需綁定其他社群請輸入 /bind。` : '你還沒有綁定 AID，請輸入 /bind 進行綁定，或到社群報名遊戲時進行綁定。');
    }
    if (c?.name === 'bind') {
      const argKey = c.args ? c.args.trim().toLowerCase() : '';
      if (argKey && cfg.groups[argKey]) {
        G.pending[uid] = { kind: 'aid', key: argKey, direct: true, at: now() };
        globalStore.save();
        return send(uid, `🔗【綁定社群遊戲 AID】\n您正在為「${gname(argKey)}」綁定遊戲會員 AID！\n\n請直接在下方輸入您在「${gname(argKey)}」的遊戲 AID（純數字）：\n（若需取消請輸入 /cancel）`);
      }
      const rows = [
        [{ text: '🦅 綁定【贏麻了】AID', callback_data: 'mg:pbind:yingma' }],
        [{ text: '👾 綁定【爽爆】AID', callback_data: 'mg:pbind:shuangbao' }],
        [{ text: '🍆 綁定【茄子】AID', callback_data: 'mg:pbind:qiezi' }],
      ];
      return send(uid, '🔗【綁定社群遊戲 AID】\n請選擇您要綁定 AID 的遊戲社群：\n（綁定後即可在該社群領養寵物並自動累計打碼換點）', kb(rows));
    }
    if (['admin', 'panel', 'setup', 'game', 'stop'].includes(c?.name)) return adminConsole(user);
    if (c?.name === 'boss') {
      const keys = await adminGroupsOf(user.id);
      if (!keys.length) return send(uid, '你不是任何社群的管理員，無法設定 BOSS。');
      if (keys.length === 1) return petFlow.showAdminBossPanel({ from: user }, keys[0], uid);
      return send(uid, '👹 請選擇要設定 BOSS 的社群：', kb(keys.map((k) => [{ text: `👹 【${gname(k)}】BOSS 出現設定`, callback_data: `mg:pet:boss:${k}` }])));
    }
    if (c?.name === 'schedules') return listSchedules(user);
    if (c?.name === 'season') {
      const keys = await adminGroupsOf(user.id);
      if (!keys.length) return send(uid, '你不是任何社群的管理員，無法設定季賽天梯。');
      if (keys.length === 1) return petFlow.showAdminSeasonPanel({ from: user }, keys[0], uid);
      return send(uid, '🏆 請選擇要設定季賽天梯的社群：', kb(keys.map((k) => [{ text: `🏆 ${gname(k)}`, callback_data: `mg:pet:season:${k}` }])));
    }
    if (c && ['addaid', 'delaid', 'aidinfo'].includes(c.name)) { const r = await dmAdminCommand(msg, c); if (r !== null) return r; }
    const s = G.setups[uid]; if (s?.awaiting && !c) return onSetupText(msg, s);
    const pend = G.pending[uid]; if (pend?.kind === 'aid' && !c && !pend.aid) return onAidInput(msg, pend);
    for (const [key] of groups()) { const f = ensureFlows(key); if (!f) continue; const r = await f.uc.onMessage(msg, text); if (r) return r; }
    return null;
  }

  async function onCallback(cq) {
    const data = String(cq.data || ''); const chat = cq.message?.chat || {};
    if (!data.startsWith('mg:')) {
      // game buttons: in the group → that group's flow; in a DM (werewolf night actions / undercover votes) → the group whose game id matches
      const key = chat.type === 'private' ? findGameOwner(data) : keyByChat(chat.id);
      const f = key && ensureFlows(key);
      if (!f) return answer(cq, '這局已經結束了');
      const pre = data.slice(0, 2); const fl = { ww: f.ww, uc: f.uc, hg: f.hg, es: f.es, sc: f.sc }[pre];
      if (!fl) return answer(cq);
      if (pre === 'es' || pre === 'hg') { const m = (pre === 'es' ? ES_CALLBACK_RE : HG_CALLBACK_RE).exec(data); return m ? fl.onCallback(cq, ...m.slice(1)) : answer(cq); } // these flows take the parsed (action, id, …)
      return fl.onCallback(cq);
    }
    if (data.startsWith('mg:pet:')) {
      const parts = data.split(':');
      const pact = parts[2];
      const pa = parts[3];
      const pb = parts[4];
      if (pact === 'dtr') {
        if (dm?.handleTradeCallback) {
          return dm.handleTradeCallback(cq);
        }
        return answer(cq, '找不到此筆地牢掉落資訊');
      }
      const key = keyByChat(chat.id) || (cfg.groups[pa] ? pa : null);
      const privateOnlyAdminAction = pact === 'boss' || (pact.startsWith('boss_') && pact !== 'boss_atk') || pact === 'season' || pact.startsWith('season_');
      if (privateOnlyAdminAction && chat.type !== 'private') return answer(cq, '管理員功能已移至私訊，請私訊 Bot 輸入 /admin。', true);
      if (['play', 'play_acc', 'pvp', 'pvp_acc', 'like', 'boss_atk', 'boss_ended', 'my_status', 'rank', 'forge_react'].includes(pact)) {
        if (!key || !await requirePetGroupMember(cq, key)) return null;
      }
      if (pact === 'play') return petFlow.startPlayInvite(cq, key);
      if (pact === 'play_acc') return petFlow.acceptPlayInvite(cq, key, pa);
      if (pact === 'pvp') return petFlow.startPvPChallenge(cq, key);
      if (pact === 'pvp_acc') return petFlow.acceptPvPChallenge(cq, key, pa);
      if (pact === 'like') {
        if (!pa || !pb || !cq.inline_message_id) return answer(cq, '這個寵物分享無法按讚，請重新分享');
        try {
          const result = await pStore.shareLike({ product: pa, shareId: pb, tgId: cq.from.id });
          const markup = { inline_keyboard: [
            [
              { text: '🐾 玩耍', callback_data: `mg:pet:play:${pa}` },
              { text: '⚔️ 決鬥', callback_data: `mg:pet:pvp:${pa}` },
            ],
            [{ text: `🤩 超讚 ${result.count || 0}`, callback_data: `mg:pet:like:${pa}:${pb}` }],
          ] };
          await call('editMessageReplyMarkup', { inline_message_id: cq.inline_message_id, reply_markup: markup }).catch((error) => log.warn(`pet share like keyboard update failed: ${error.message}`));
          return answer(cq, result.liked ? `🤩 超讚！目前 ${result.count} 個` : `你已經按過囉！目前 ${result.count} 個`);
        } catch (error) {
          return answer(cq, error.message || '按讚暫時失敗，請稍後重試', true);
        }
      }
      if (pact === 'forge_react') {
        const reaction = parts[5];
        if (!['lucky', 'awesome'].includes(reaction) || key !== pa || chat.type === 'private') {
          return answer(cq, '這個強化互動按鈕無效');
        }
        try {
          const counts = await pStore.castForgeReaction({ product: pa, eventId: pb, tgId: cq.from.id, reaction });
          const markup = { inline_keyboard: [[
            { text: `🍀 運氣超賽 ${counts.lucky}`, callback_data: `mg:pet:forge_react:${pa}:${pb}:lucky` },
            { text: `🤩 超讚 ${counts.awesome}`, callback_data: `mg:pet:forge_react:${pa}:${pb}:awesome` },
          ]] };
          await call('editMessageReplyMarkup', { chat_id: chat.id, message_id: cq.message.message_id, reply_markup: markup });
          return answer(cq, counts.changed ? '已送出你的祝福！' : '你已經按過這個按鈕囉！');
        } catch (error) {
          return answer(cq, error.message || '互動暫時失敗，請稍後重試', true);
        }
      }
      if (pact === 'boss_atk') return bossManager.handleAttack(cq, key, pa);
      if (pact === 'boss_ended') return answer(cq, '🏁 本場 BOSS 討伐已結束囉！', false);
      if (pact === 'my_status') {
        return answerUrl(cq, petAppLink(cfg, key));
      }
      if (pact === 'boss') {
        const targetKey = pa || key;
        const gc = cfg.groups[targetKey];
        if (!gc?.chatId || !(await isAdmin(gc.chatId, cq.from.id, true))) return answer(cq, ADMIN_ONLY, true);
        return petFlow.showAdminBossPanel(cq, targetKey, cq.from.id);
      }
      if (pact.startsWith('boss_')) {
        const subAct = pact.slice(5);
        const targetKey = pa || key;
        const gc = cfg.groups[targetKey];
        if (!gc?.chatId || !(await isAdmin(gc.chatId, cq.from.id, true))) return answer(cq, ADMIN_ONLY, true);
        return petFlow.handleAdminBossCallback(cq, subAct, targetKey, pb);
      }
      if (pact === 'season') {
        const targetKey = pa || key;
        const gc = cfg.groups[targetKey];
        if (!gc?.chatId || !(await isAdmin(gc.chatId, cq.from.id, true))) return answer(cq, ADMIN_ONLY, true);
        return petFlow.showAdminSeasonPanel(cq, targetKey, cq.from.id);
      }
      if (pact.startsWith('season_')) {
        const subAct = pact.slice(7);
        const targetKey = pa || key;
        const gc = cfg.groups[targetKey];
        if (!gc?.chatId || !(await isAdmin(gc.chatId, cq.from.id, true))) return answer(cq, ADMIN_ONLY, true);
        return petFlow.handleAdminSeasonCallback(cq, subAct, targetKey);
      }
      if (pact === 'rank') {
        const targetKey = pa || key;
        return petFlow.showSeasonRankings(cq, targetKey);
      }
      return answer(cq);
    }
    const [, act, a, b, c2] = data.split(':');
    if (['su', 's', 'x', 'p', 'new', 'sl', 'sd', 'aid', 'menu', 'players'].includes(act) && chat.type !== 'private') {
      return answer(cq, '管理員操作已移至私訊，請私訊 Bot 輸入 /admin。', true);
    }
    if (act === 'su') return onSetupCallback(cq, a, b);
    if (act === 'pa') { await answer(cq); await stripButtons(cq.message); await send(cq.from.id, '⏳ 小精靈正在確認報名資格…'); return dmSignupResult(cq.from, a, b, await checkAndJoin(a, b, cq.from, c2)); }
    if (act === 'pbind') {
      const targetKey = a;
      if (!cfg.groups[targetKey]) return answer(cq, '未知社群');
      await answer(cq);
      await stripButtons(cq.message);
      G.pending[String(cq.from.id)] = { kind: 'aid', key: targetKey, direct: true, at: now() };
      globalStore.save();
      return send(cq.from.id, `🔗【綁定社群遊戲 AID】\n您正在為「${gname(targetKey)}」綁定遊戲會員 AID！\n\n請直接在下方輸入您在「${gname(targetKey)}」的遊戲 AID（純數字）：\n（若需取消請輸入 /cancel）`);
    }
    if (act === 'ba') {
      const pend = G.pending[String(cq.from.id)];
      if (!pend || pend.key !== a || pend.aid !== b) return answer(cq, '已過期，請重新從社群報名');
      const r = bindAid(a, cq.from.id, b, { nickname: pend.nickname });
      delete G.pending[String(cq.from.id)]; globalStore.save(); await stripButtons(cq.message);
      if (!r.ok) { await answer(cq, r.text, true); return send(cq.from.id, `❌ ${r.text}`); }
      const cloudSync = await wagerSync?.syncOneBinding?.(a, cq.from.id, b, pend.nickname);
      await answer(cq, '綁定成功');
      if (cloudSync && !cloudSync.ok) {
        return send(cq.from.id, `✅【${gname(a)}】AID ${b} 已綁定到小遊戲精靈。雲端寵物資料尚在同步，請稍後重新開啟 Mini App；若仍未顯示，請聯絡管理員。`);
      }
      if (pend.direct) {
        return send(cq.from.id, `✅ 已成功為【${gname(a)}】綁定 AID ${b}${pend.nickname ? `（${pend.nickname}）` : ''}！\n\n現在您可以開啟 Mini App 領養並照顧您的專屬寵物囉！`, kb([[petAppButton(`🐾 開啟【${gname(a)}】寵物 (Mini App)`, cfg, { product: a, chatId: cq.from.id })]]));
      }
      await send(cq.from.id, `✅ 已綁定 AID ${b}${pend.nickname ? `（${pend.nickname}）` : ''}\n⏳ 正在確認報名資格…`);
      return dmSignupResult(cq.from, a, pend.game, await checkAndJoin(a, pend.game, cq.from, b));
    }
    if (act === 'br') { const pend = G.pending[String(cq.from.id)]; if (pend) { delete pend.aid; globalStore.save(); } await stripButtons(cq.message); await answer(cq); return send(cq.from.id, '請重新輸入你的 AID：'); }
    if (act === 'menu') { await answer(cq); return showAdminMenu(cq.from, a || null, cq.message); }
    if (act === 'players') return showPetPlayers(cq, a, b);
    if (act === 'sl') { await answer(cq); return listSchedules(cq.from); }
    if (act === 'sd') return deleteSchedule(cq, a);
    if (act === 'aid') {
      const gc = cfg.groups[a];
      if (!gc?.chatId || !(await isAdmin(gc.chatId, cq.from.id, true))) return answer(cq, ADMIN_ONLY, true);
      await answer(cq);
      return send(cq.from.id, `👤【${gname(a)}｜AID 綁定管理】\n\n新增綁定：/addaid ${a} TG數字ID AID\n解除綁定：/delaid ${a} AID\n查詢綁定：/aidinfo ${a} AID或TG數字ID`);
    }
    if (act === 'new') { const gc = cfg.groups[a]; if (!gc || !(await isAdmin(gc.chatId, cq.from.id))) return answer(cq, ADMIN_ONLY, true); await answer(cq); return beginSetup(cq.from, a); }
    const key = b || keyByChat(chat.id); const gc = key && cfg.groups[key];
    if (!gc?.chatId) return answer(cq);
    if (act === 'j') return onSignupButton(cq, key, a);
    if (act === 'l') { const r = await adapter(key, a).leave(cq.from); const round = activeRound(key, a); if (r?.left && round) { delete round.participants[String(cq.from.id)]; S(key).save(); } return answer(cq, r?.text || ''); }
    if (act === 's' || act === 'x') return adminAction(cq, act, a, key);
    if (act === 'p') {
      if (!(await isAdmin(gc.chatId, cq.from.id))) return answer(cq, ADMIN_ONLY, true);
      return answerUrl(cq, deep(a === 'adm' ? 'adm' : `st_${key}_${a}`));
    }
    return answer(cq);
  }
  function findGameOwner(data) {
    const id = data.split(':')[2];
    for (const [key] of groups()) { const f = ensureFlows(key); if (!f) continue; const g = data.startsWith('ww:') ? f.ww.getState() : data.startsWith('uc:') ? f.uc.getState() : null; if (g && (!id || g.id === id)) return key; }
    return null;
  }

  async function tick() {
    for (const [key] of groups()) {
      const f = ensureFlows(key); if (!f) continue;
      for (const fl of [f.ww, f.uc, f.hg, f.es, f.sc]) { try { await fl.tick(); } catch (error) { log.warn(`${key} tick failed: ${error.message}`); } }
      // a round whose flow is gone (crash / manual state edit) is closed as cancelled so it never blocks a new one
      for (const game of GAME_KEYS) { const r = activeRound(key, game); const ad = adapter(key, game); if (r && !ad?.state() && !ad?.isEnding?.() && now() - r.createdAt > 60e3) { r.status = 'cancelled'; r.endedAt = now(); r.reason = 'flow missing'; S(key).save(); log.warn(`${key} round ${r.id} closed: flow missing`); } }
    }
    try { await runSchedules(); } catch (error) { log.warn(`schedules failed: ${error.message}`); }
    try { await bossManager.tick(); } catch (error) { log.warn(`bossManager tick failed: ${error.message}`); }
    petFlow.pruneInvites();
    if (payout?.live && payout.pending?.().length) void payout.drain().catch((error) => log.warn(`payout drain failed: ${error.message}`)); // queued / retried / after a restart
    for (const [uid, s] of Object.entries(G.setups)) if (now() - (s.updatedAt || s.createdAt) > 60 * 60e3) { delete G.setups[uid]; globalStore.save(); }
    for (const [uid, p] of Object.entries(G.pending)) if (now() - p.at > 60 * 60e3) { delete G.pending[uid]; globalStore.save(); }
  }

  async function handleUpdate(u) {
    try {
      if (u.callback_query) return await onCallback(u.callback_query);
      if (u.message) return await onMessage(u.message);
      if (u.my_chat_member) { const m = u.my_chat_member; log.info(`bot membership in chat ${m.chat.id} (${m.chat.title || m.chat.type}): ${m.new_chat_member?.status}`); }
    } catch (error) {
      log.error(`update ${u.update_id} failed: ${error.stack || error.message}`);
      if (u.callback_query) await answer(u.callback_query, '出了點問題，請再試一次');
    }
    return null;
  }

  return { handleUpdate, tick, ensureFlows, ensurePetEntryMessages, adapter, activeRound, checkAndJoin, onEnd, bindAid, isAdmin, _setups: G.setups, schedules: () => G.schedules, runSchedules, flows, petStore: pStore, bossManager, petFlow, dungeonManager: dm, setDungeonManager: (m) => { dm = m; } };
}
