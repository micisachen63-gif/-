import { isBotVideoMessage } from './video-edit.js';
import { VB_CALLBACK_RE, createVideoButtons, videoEditKeyboard } from './video-buttons.js';
import fs from 'node:fs';
import { TAIPEI_OFFSET_MS } from './util.js';
import { buildTarotInterpretationPrompt, createTarotSession, TAROT_TTL_MS, tarotBoardText, tarotKeyboard, tarotReadyText } from './tarot.js';
import { renderTarotSpread } from './tarot-image.js';
import { QQ_CALLBACK_RE, createQiuqianFlow } from './qiuqian-flow.js';
import { DL_CALLBACK_RE, createDailuFlow } from './dailu-flow.js';
import { HG_CALLBACK_RE, createHaiguitangFlow } from './haiguitang-flow.js';
import { ES_CALLBACK_RE, createEscapeFlow } from './escape-flow.js';
import { createWerewolfFlow } from './werewolf-flow.js';
import { UC_CALLBACK_RE, createUndercoverFlow } from './undercover-flow.js';
import { SC_CALLBACK_RE, createSafeCrackFlow } from './safe-crack-flow.js';
import { RPG_CALLBACK_RE } from './rpg-flow.js';

/**
 * TG 轉話: the owner talks to the assistants from the private group through 小精靈.
 * Inbound: /ask, /menu (+ panel buttons → force-reply prompt → preview → ✅ 送出) → POST webhook.
 * Secrets (webhook url/key) live only in relay.local.json and are never logged or echoed.
 */

export const PANEL_AGENTS = [
  { name: '機台數據', emoji: '🎰' },
  { name: '新手禮包', emoji: '🎁' },
  { name: '營運數據', emoji: '📊' },
  { name: '網頁版GPT', label: '小精靈', emoji: '💬' },
];
export const DRAFT_TTL_MS = 10 * 60e3;
export const TG_TEXT_LIMIT = 4000;
const displayAgent = (name) => PANEL_AGENTS.find((a) => a.name === name)?.label || name;

/** relay.local.json → { agents: { name: {url, key} }, default } ; null when missing / nothing usable. Throws on bad JSON. */
export function loadRelayConfig(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const j = JSON.parse(raw);
  const agents = {};
  for (const [name, a] of Object.entries(j?.agents || {})) {
    const url = String(a?.url ?? '').trim();
    const key = String(a?.key ?? '').trim().replace(/^Bearer\s+/i, '').trim();
    if (name.trim() && /^https:\/\/\S+$/i.test(url) && key) agents[name.trim()] = { url, key };
  }
  const names = Object.keys(agents);
  if (!names.length) return null;
  return { agents, default: agents[j.default] ? j.default : names[0] };
}

/** Names only (safe for status/logs). */
export function describeRelayConfig(file) {
  try {
    const c = loadRelayConfig(file);
    if (!c) return '未設定';
    return `已設定 ${Object.keys(c.agents).map((n) => (n === c.default ? `${n}（預設）` : n)).join('、')}`;
  } catch {
    return '設定檔格式錯誤（請重新執行 設定轉話.cmd）';
  }
}

const pad = (n) => String(n).padStart(2, '0');
/** ISO timestamp in Asia/Taipei with explicit +08:00. */
export function isoTaipei(ms) {
  const d = new Date(ms + TAIPEI_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`;
}
const hhmm = (ms) => isoTaipei(ms).slice(11, 16);

/**
 * Parse /ask, /ask@bot, /menu, /menu@bot, and /問 (only when the bot can read all group messages).
 * A leading known assistant name selects the target. Returns null when it is not for us.
 */
export function parseCommand(text, { botUsername = '', canReadAll = false, agentNames = [] } = {}) {
  const t = String(text ?? '').trim();
  let cmd; let rest;
  const m = /^\/(ask|menu)(?:@([A-Za-z0-9_]+))?(?=\s|$)([\s\S]*)$/i.exec(t);
  if (m) {
    if (m[2] && botUsername && m[2].toLowerCase() !== String(botUsername).toLowerCase()) return null;
    cmd = m[1].toLowerCase();
    rest = m[3];
  } else {
    const q = /^\/問(?=\s|$)([\s\S]*)$/.exec(t);
    if (!q || !canReadAll) return null;
    cmd = 'ask';
    rest = q[1];
  }
  if (cmd === 'menu') return { cmd };
  rest = rest.trim();
  const first = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  if (first && agentNames.includes(first[1])) return { cmd, agent: first[1], text: (first[2] || '').trim() };
  return { cmd, agent: null, text: rest };
}

export function fromName(user = {}) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || (user.username ? `@${user.username}` : String(user.id ?? ''));
}

export function buildPayload({ agent, text, msg }) {
  return {
    source: 'telegram',
    agent,
    text,
    from_id: msg.from?.id ?? null,
    from_name: fromName(msg.from),
    chat_id: msg.chat?.id ?? null,
    message_id: msg.message_id ?? null,
    sent_at: isoTaipei((Number(msg.date) || Math.floor(Date.now() / 1000)) * 1000),
  };
}

/** Split long text into <= limit chunks, preferring line breaks. */
export function splitText(text, limit = TG_TEXT_LIMIT) {
  const out = [];
  let rest = String(text);
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length || !out.length) out.push(rest);
  return out;
}

export const PANEL_TEXT = '🧚 有事就問小精靈｜占卜、求籤、群組遊戲、帶路，按下方按鈕開始！';
/** Inline /menu panel. Life rows: 問小精靈 / 占卜 / 群組遊戲 / 帶路 (in the group, 帶路 is a deep link into the private chat). */
export function panelMarkup(extraNames = [], mode = 'all', { group = false, botUsername = '' } = {}) {
  const fixed = PANEL_AGENTS.filter(a => mode === 'all' || (mode === 'life' ? a.name === '網頁版GPT' : a.name !== '網頁版GPT')).map((a) => ({ text: a.name === '網頁版GPT' ? '💬 問小精靈' : `${a.emoji} ${a.label || a.name}`, callback_data: `ra:${a.name}` }));
  const extra = extraNames.filter((n) => !PANEL_AGENTS.some((a) => a.name === n)).map((n) => ({ text: `🤖 ${n}`, callback_data: `ra:${n}`.slice(0, 64) }));
  const rows = [fixed];
  if (mode !== 'operations') {
    rows.push([{ text: '🔮 塔羅占卜', callback_data: 'tt:start' }, { text: '🙏 觀音求籤', callback_data: 'qq:s' }]);
    rows.push([{ text: '🐺 狼人殺', callback_data: 'ww:open' }, { text: '🐢 海龜湯', callback_data: 'hg:n' }]);
    rows.push([{ text: '🕵️ 誰是臥底', callback_data: 'uc:open' }, { text: '🚪 密室逃脫', callback_data: 'es:n' }]);
    rows.push([{ text: '🔐 千鎖秘藏', callback_data: 'sc:n' }]);
    rows.push([group && botUsername ? { text: '🧚 小精靈帶路', url: `https://t.me/${botUsername}?start=dailu` } : { text: '🧚 小精靈帶路', callback_data: 'dl:m' }]);
    rows.push([group && botUsername ? { text: '🔞 紳士專區', url: `https://t.me/${botUsername}?start=gentleman` } : { text: '🔞 紳士專區', callback_data: 'theme:當日最新:today' }]);
  }
  for (let i = 0; i < extra.length; i += 3) rows.push(extra.slice(i, i + 3));
  return { inline_keyboard: rows };
}

/** Persistent reply keyboard: same rows as the inline panel (incl. 🔐 千鎖秘藏, 🧚 小精靈帶路, 🔞 紳士專區). */
export function tarotReplyMarkup() {
  return { keyboard: [[{ text: '💬 問小精靈' }], [{ text: '🔮 塔羅占卜' }, { text: '🙏 觀音求籤' }], [{ text: '🐺 狼人殺' }, { text: '🐢 海龜湯' }], [{ text: '🕵️ 誰是臥底' }, { text: '🚪 密室逃脫' }], [{ text: '🔐 千鎖秘藏' }], [{ text: '🧚 小精靈帶路' }], [{ text: '🔞 紳士專區' }]], resize_keyboard: true, is_persistent: true };
}

const HINT_NOT_SET = '轉話尚未設定，請在電腦上執行「設定轉話.cmd」';
const HINT_BAD_FILE = '轉話設定檔格式錯誤，請在電腦上重新執行「設定轉話.cmd」';

export function createRelay({ api, chatId, ownerId, getConfig, onVideoDelivered = null, mode = 'all', localAgents = {}, ownerPrivateRoute = null, tarotInterpreter = null, qiuqianInterpreter = null, haiguiInterpreter = null, haiguiRelease = null, haiguiScene = null, dailuTdx = null, dailuWeather = null, random = Math.random, log, throttleMs = 15000, timeoutMs = 15000, fetchImpl = fetch, now = () => Date.now(), tgStore = null }) {
  const allowedAgent = name => mode === 'all' || (mode === 'life' ? name === '網頁版GPT' : name !== '網頁版GPT');
  const menuMarkup = (names, targetChatId = chatId) => panelMarkup(mode === 'life' ? [] : names, mode, { group: String(targetChatId) === String(chatId), botUsername: st.botUsername });
  const st = { botUsername: '', canReadAll: false, lastRelayAt: 0 };
  const lastRelayByUser=new Map();
  const seen = new Set();
  const seenOrder = [];
  const prompts = new Map(); // prompt message id -> { agent, at }
  const drafts = new Map(); // prompt message id -> { agent, text, at, previewId, msg, sending }
  const tarotPrompts = new Map(Object.entries(tgStore?.data.tarot?.prompts || {}).map(([key,value])=>[key.includes(':')?key:Number(key),value]));
  const tarotSessions = new Map(Object.entries(tgStore?.data.tarot?.sessions || {}));
  const tarotKeyboardPending = new Map();
  const tarotReadingPending = new Set();
  const tarotReadingJobs = new Map();
  const tarotReadingQueue = [];
  let activeTarotReadings = 0;
  const maxConcurrentTarotReadings = 2;
  const saveTarot = () => {
    if (!tgStore) return;
    tgStore.data.tarot = { prompts: Object.fromEntries(tarotPrompts), sessions: Object.fromEntries(tarotSessions) };
    tgStore.save();
  };
  const choices=tgStore?.data.maintenanceChoices||(tgStore?(tgStore.data.maintenanceChoices={}):{});

  const safeConfig = () => { try { return { conf: getConfig() }; } catch { return { bad: true }; } };
  const agentNames = () => {
    const { conf } = safeConfig();
    return [...new Set([...PANEL_AGENTS.map((a) => a.name), ...Object.keys(conf?.agents || {}), ...Object.keys(localAgents)])];
  };
  const send = (text, extra = {}, targetChatId = chatId) => api.call('sendMessage', { chat_id: targetChatId, text, ...extra });
  // the group's persistent reply keyboard (下方按鈕), re-attached to a message that is sent anyway after force-reply prompts hid it
  const homeMenu = (cid) => (mode !== 'operations' && String(cid) === String(chatId) ? tarotReplyMarkup() : null);
  const replyTo = (msg, text, extra = {}) => send(text, { reply_to_message_id: msg.message_id, allow_sending_without_reply: true, ...extra },msg.chat.id);
  const answer = async (cq, text = '') => {
    try { await api.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: false }); } catch (error) { log.warn(`answerCallbackQuery failed: ${error.message}`); }
  };
  const edit = async (messageId, text, keyboard = [],targetChatId=chatId) => {
    try { await api.call('editMessageText', { chat_id: targetChatId, message_id: messageId, text, reply_markup: { inline_keyboard: keyboard } }); } catch (error) { log.warn(`editMessageText ${messageId} failed: ${error.message}`); }
  };
  const isOwner = (user) => Number(user?.id) === Number(ownerId);
  const inGroup = (chat) => String(chat?.id) === String(chatId);
  const inUserPrivate = (chat,user) => chat?.type==='private'&&String(chat?.id)===String(user?.id);
  const isGroupMember=async user=>{if(isOwner(user))return true;try{const m=await api.call('getChatMember',{chat_id:chatId,user_id:user.id});return['member','administrator','creator','restricted'].includes(m?.status);}catch(error){log.warn(`getChatMember(user ${user?.id}) failed: ${error.message}`);return false;}};
  const werewolf=mode === 'operations' || !tgStore ? null : createWerewolfFlow({api,chatId,tgStore,log,botUsername:()=>st.botUsername,isGroupMember,now});
  const undercover=mode === 'operations' || !tgStore ? null : createUndercoverFlow({api,chatId,tgStore,log,botUsername:()=>st.botUsername,isGroupMember,now});
  const flowKey=(targetChatId,messageId)=>String(targetChatId)===String(chatId)?Number(messageId):`${targetChatId}:${messageId}`;
  const useOwnerPrivate=(agent,text,msg)=>{try{return Boolean(ownerId&&typeof ownerPrivateRoute==='function'&&ownerPrivateRoute({agent,text,msg}));}catch(error){log.warn(`owner private route failed: ${error.message}`);return false;}};
  const qiuqian=createQiuqianFlow({api,send,edit,answer,log,now,tgStore,inGroup,inUserPrivate,isGroupMember,flowKey,splitText,interpreter:qiuqianInterpreter,random,mode,refreshKeyboard:targetChatId=>ensureTarotKeyboard(targetChatId,true),menuMarkup:homeMenu});
  const dailu=createDailuFlow({api,send,answer,log,now,tgStore,inGroup,inUserPrivate,isGroupMember,botUsername:()=>st.botUsername,tdx:dailuTdx,getWeather:dailuWeather,mode});
  const haigui=createHaiguitangFlow({api,send,answer,log,now,tgStore,inGroup,inUserPrivate,splitText,interpreter:haiguiInterpreter,release:haiguiRelease,sceneImage:haiguiScene,mode,botUsername:()=>st.botUsername,menuMarkup:homeMenu});
  const isGroupAdmin=async user=>{if(isOwner(user))return true;try{const m=await api.call('getChatMember',{chat_id:chatId,user_id:user.id});return['administrator','creator'].includes(m?.status);}catch(error){log.warn(`getChatMember(admin ${user?.id}) failed: ${error.message}`);return false;}};
  const escape=createEscapeFlow({api,send,answer,log,now,tgStore,inGroup,inUserPrivate,isAdmin:isGroupAdmin,splitText,mode,botUsername:()=>st.botUsername});
  const safeCrack=mode === 'operations' || !tgStore ? null : createSafeCrackFlow({api,send,answer,log,now,tgStore,inGroup,inUserPrivate,isAdmin:isGroupAdmin,mode,random,botUsername:()=>st.botUsername,menuMarkup:homeMenu}); // 🔐 千鎖秘藏 (core: games/safe-crack.js)
  const rpg=null; // 星穹旅誌已移交 @StarJournalRpgBot；原小精靈不再消費遊戲通知。
  const videoButtons=createVideoButtons({api,send,answer,log,now,tgStore,botUsername:()=>st.botUsername});

  /** POST to the assistant's webhook. Never logs url/key; logs text length only. */
  async function relayText({ agent, text, msg, onProgress }) {
    const { conf, bad } = safeConfig();
    const name = agent || conf?.default;
    if (!allowedAgent(name)) return { ok: false, hint: '此職責已移交另一位守護者，請使用對應機器人。' };
    const local = localAgents[name];
    if (!local && bad) return { ok: false, hint: HINT_BAD_FILE };
    if (!local && !conf) return { ok: false, hint: HINT_NOT_SET };
    const target = conf?.agents?.[name];
    if (!local && !target) return { ok: false, hint: `「${name}」尚未設定轉話。已設定：${[...Object.keys(conf?.agents || {}), ...Object.keys(localAgents)].join('、')}` };
    const throttleKey=String(msg?.from?.id??'unknown');const lastRelayAt=lastRelayByUser.get(throttleKey)||0;const wait = lastRelayAt + throttleMs - now();
    if (wait > 0&&!msg.maintenanceProvider) return { ok: false, agent: name, throttled: Math.ceil(wait / 1000) };
    st.lastRelayAt = now();lastRelayByUser.set(throttleKey,st.lastRelayAt);
    const payload = buildPayload({ agent: name, text, msg });
    let reason = null;
    try {
      if (local) {
        const raw=await local(payload,msg,{onProgress});const response=typeof raw==='string'?raw.trim():String(raw?.text??'').trim();const images=Array.isArray(raw?.images)?raw.images:[];const videos=Array.isArray(raw?.videos)?raw.videos:[];const privateOwnerOnly=Boolean(raw?.privateOwnerOnly);
        if (!response&&!images.length&&!videos.length) throw new Error('小精靈沒有回傳內容');
        log.info(`relay → ${name}: ok; text ${text.length} chars; tg message ${msg.message_id}`);
        return { ok: true, agent: name, response, images, videos,providerChoice:Boolean(raw?.providerChoice),intentChoice:Boolean(raw?.intentChoice),incomplete:Boolean(raw?.incomplete),cancelled:Boolean(raw?.cancelled),privateOwnerOnly,requestText:text };
      }
      const res = await fetchImpl(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target.key}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) reason = `HTTP ${res.status}`;
    } catch (error) {
      reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? `逾時（${Math.round(timeoutMs / 1000)} 秒）` : `連線失敗（${String(error?.cause?.code || error?.message || error).slice(0, 120)}）`;
      if (local && error?.uncertain) return { ok: false, agent: name, reason, uncertain: true };
    }
    log.info(`relay → ${name}: ${reason ? `FAILED ${reason}` : 'ok'}; text ${text.length} chars; tg message ${msg.message_id}`);
    return reason ? { ok: false, agent: name, reason } : { ok: true, agent: name };
  }

  const resultText = (r) => {
    if (r.ok && (r.response || r.images?.length || r.videos?.length)) return null;
    if (r.ok) return `📨 已轉給${r.agent}，稍等回覆`;
    if (r.hint) return r.hint;
    if (r.throttled) return `⏳ 太快了，請 ${r.throttled} 秒後再試`;
    return `❌ 轉話失敗：${r.reason}`;
  };
  async function sendResponse(msg, r) {
    const targetChatId=r.privateOwnerOnly?ownerId:msg.chat.id;
    const sameChat=String(targetChatId)===String(msg.chat.id);
    if(r.providerChoice){const key=`${targetChatId}:${msg.message_id}`;choices[key]={msg,text:r.requestText||msg.text||msg.caption||'',at:now(),userId:msg.from.id};tgStore?.save();await send('🧚 這個任務要交給誰處理？',{...(sameChat?{reply_to_message_id:msg.message_id,allow_sending_without_reply:true}:{}),reply_markup:{inline_keyboard:[[{text:'GPT',callback_data:`rm:gpt:${msg.message_id}`},{text:'GROK',callback_data:`rm:grok:${msg.message_id}`}]]}},targetChatId);return;}
    if(r.intentChoice){const key=`${targetChatId}:${msg.message_id}`;choices[key]={msg,text:r.requestText||msg.text||msg.caption||'',at:now(),userId:msg.from.id};tgStore?.save();await send('🧚 GROK 要怎麼處理這個任務？',{...(sameChat?{reply_to_message_id:msg.message_id,allow_sending_without_reply:true}:{}),reply_markup:{inline_keyboard:[[{text:'❓問問題',callback_data:`rm:grokqa:${msg.message_id}`},{text:'🛠開發',callback_data:`rm:grokdev:${msg.message_id}`}]]}},targetChatId);return;}
    let replied=false;if(r.response){const chunks = splitText(`🧚 小精靈回報：\n${r.response}`);for (let i = 0; i < chunks.length; i++){await send(chunks[i], { ...(i === 0&&sameChat ? { reply_to_message_id: msg.message_id, allow_sending_without_reply: true } : {}), ...(i === chunks.length-1&&homeMenu(targetChatId) ? { reply_markup: homeMenu(targetChatId) } : {}) },targetChatId);replied=true;}}
    for(const image of r.images||[]){if(typeof api.sendDocument!=='function')throw Error('Telegram 原圖回傳功能不可用');await api.sendDocument({chatId:targetChatId,buffer:image.buffer,mimeType:image.mimeType,fileName:image.fileName,caption:'GPT 產生的原始圖片（未壓縮）',replyToMessageId:sameChat&&!replied?msg.message_id:undefined});replied=true;}
    for(const video of r.videos||[]){if(typeof api.sendVideo!=='function')throw Error('Telegram 影片回傳功能不可用');const sentVideo=await api.sendVideo({chatId:targetChatId,buffer:video.buffer,mimeType:video.mimeType,fileName:video.fileName,caption:'🎬 Grok Imagine 原始影片（720p／6 秒）',replyToMessageId:sameChat&&!replied?msg.message_id:undefined,replyMarkup:video.grok?videoEditKeyboard():undefined});replied=true;if(video.grok&&sentVideo?.message_id){videoButtons.delivered(targetChatId,sentVideo.message_id,msg.from?.id);try{await onVideoDelivered?.({chatId:targetChatId,messageId:sentVideo.message_id,grok:video.grok,userId:msg.from?.id});}catch(error){log.warn(`video map save failed: ${error.message}`);}}}if(r.videos?.length||r.images?.length)log.info(`relay delivered ${r.videos?.length||0} video(s), ${r.images?.length||0} image(s) to chat ${targetChatId}`);
  }
  async function handlePrivateChat(msg,text){const hasPhoto=Array.isArray(msg.photo)&&msg.photo.length>0;const hasDocument=Boolean(msg.document);const hasVideo=Boolean(msg.video);const question=text||(hasVideo?'請分析這段影片並摘要重要內容。':hasDocument?'請分析這份檔案並摘要重要發現。':'請查看這張圖片並回答。');const ownerPrivate=useOwnerPrivate('網頁版GPT',question,msg);const targetChatId=ownerPrivate?ownerId:msg.chat.id;const sameChat=String(targetChatId)===String(msg.chat.id);let progressText=hasVideo?'正在上傳影片':hasDocument?'正在上傳附件':hasPhoto?'正在上傳圖片':'小精靈正在思考';const status=await send(`⏳ ${progressText}…`,sameChat?{reply_to_message_id:msg.message_id,allow_sending_without_reply:true}:{},targetChatId);const started=Date.now();const updateProgress=async value=>{progressText=value;await edit(status.message_id,`⏳ ${value}…`,[],targetChatId);};const timer=setInterval(()=>{const seconds=Math.max(1,Math.round((Date.now()-started)/1000));void edit(status.message_id,`⏳ ${progressText}…（已等待 ${seconds} 秒）`,[],targetChatId);},20000);timer.unref?.();let r;try{r=await relayText({agent:'網頁版GPT',text:question,msg,onProgress:updateProgress});}finally{clearInterval(timer);}if(r.ok){await edit(status.message_id,r.providerChoice?'請選擇任務處理者':r.intentChoice?'請選擇 GROK 處理方式':r.cancelled?'🛑 任務已停止':r.incomplete?'⚠️ 任務中斷，進度已保存':`📨 小精靈已完成（${hhmm(now())}）`,[],targetChatId);if(r.response||r.images?.length||r.videos?.length||r.providerChoice||r.intentChoice)await sendResponse(msg,r);}else await edit(status.message_id,resultText(r),[],targetChatId);return{relay:r,privateDirect:true};}

  async function postPanel(targetChatId=chatId) {
    const { conf } = safeConfig();
    return send(mode === 'operations' ? '🧙 神殿守望者：諸事有序，方能行穩致遠。請選擇要查辦的營運事項。' : PANEL_TEXT, { reply_markup: menuMarkup(Object.keys(conf?.agents || {}), targetChatId) },targetChatId);
  }

  async function ensureTarotKeyboard(targetChatId=chatId,force=false) {
    if (mode === 'operations') return null;
    const group=String(targetChatId)===String(chatId);
    const key=String(targetChatId);
    if(!group){
      const existing=tgStore?.data.privateMenuInstalled?.[key];
      if(existing?.messageId)return existing;
      if(tarotKeyboardPending.has(key))return tarotKeyboardPending.get(key);
      const pending=(async()=>{
        await api.call('setChatMenuButton',{chat_id:targetChatId,menu_button:{type:'commands'}});
        const msg=await send('🔮 塔羅占卜、🙏 觀音求籤、🧚 小精靈帶路、🐺 狼人殺、🐢 海龜湯、🕵️ 誰是臥底、🚪 密室逃脫、🔐 千鎖秘藏已放進輸入框左側的「選單」；群組遊戲請回群組開局。',{reply_markup:{remove_keyboard:true}},targetChatId);
        const rec={messageId:msg.message_id,at:new Date(now()).toISOString()};
        if(tgStore){tgStore.data.privateMenuInstalled||={};tgStore.data.privateMenuInstalled[key]=rec;tgStore.save();}
        return rec;
      })();
      tarotKeyboardPending.set(key,pending);
      try{return await pending;}finally{tarotKeyboardPending.delete(key);}
    }
    const existing=group?tgStore?.data.tarotKeyboard:tgStore?.data.privateTarotKeyboards?.[key];
    if(existing?.messageId&&existing.version === 9&&!force)return existing;
    if(tarotKeyboardPending.has(key))return tarotKeyboardPending.get(key);
    const pending=(async()=>{
      const msg=await send('🧚 常用功能都在下方按鈕：問小精靈、占卜、求籤、狼人殺、海龜湯、誰是臥底、密室逃脫、千鎖秘藏、帶路、紳士專區',{reply_markup:tarotReplyMarkup()},targetChatId);
      // layout upgrade: the new keyboard replaces the old one; remove the old keyboard message so the chat stays tidy (best effort)
      if(existing?.messageId&&existing.version !== 9&&!force){try{await api.call('deleteMessage',{chat_id:targetChatId,message_id:existing.messageId});}catch{/* too old / already gone */}}
      const rec={messageId:msg.message_id,at:new Date(now()).toISOString(),version:9};
      if(tgStore){
        if(group)tgStore.data.tarotKeyboard=rec;
        else{tgStore.data.privateTarotKeyboards||={};tgStore.data.privateTarotKeyboards[key]=rec;}
        tgStore.save();
      }
      return rec;
    })();
    tarotKeyboardPending.set(key,pending);
    try{return await pending;}finally{tarotKeyboardPending.delete(key);}
  }

  function pruneExpired() {
    const t = now();
    for (const [id, p] of prompts) if (t - p.at > DRAFT_TTL_MS) prompts.delete(id);
    for (const [id, d] of drafts) if (t - d.at > DRAFT_TTL_MS && !d.sending) drafts.delete(id);
    let changed=false;
    for (const [id,p] of tarotPrompts) if(t-p.at>TAROT_TTL_MS){tarotPrompts.delete(id);changed=true;}
    for (const [id,s] of tarotSessions) if(t-s.updatedAt>TAROT_TTL_MS){tarotSessions.delete(id);changed=true;}
    if(changed)saveTarot();
    qiuqian.prune();
    dailu.prune();
    void videoButtons.sweep();
  }

  async function onMessage(msg) {
    if (!inGroup(msg.chat)&&!inUserPrivate(msg.chat,msg.from)) return { ignored: 'chat' };
    if(inUserPrivate(msg.chat,msg.from)&&!await isGroupMember(msg.from)){await replyTo(msg,'🚫⛔ 這一切已與你無關！👋');return{ignored:'not member'};}
    if(inUserPrivate(msg.chat,msg.from))await ensureTarotKeyboard(msg.chat.id);
    { const vr = videoButtons.rewriteReply(msg); if (vr?.ignored) return vr; if (vr) msg = vr; } // reply to 「✏️ 繼續修改」's prompt = reply to the video
    const text = typeof msg.text === 'string' ? msg.text.trim() : typeof msg.caption==='string'?msg.caption.trim():'';
    if(werewolf){const wr=await werewolf.onMessage(msg,text);if(wr)return wr;}
    if(undercover){const ur=await undercover.onMessage(msg,text);if(ur)return ur;}
    if(safeCrack){const sr=await safeCrack.onMessage(msg,text);if(sr)return sr;}
    if(mode!=='operations'&&/^(?:\/rpg(?:@\w+)?|\/start\s+rpg\S*|⚔️ 冒險|⚔️ RPG 冒險)$/i.test(text)){await send('🌌《星穹旅誌》已搬到專屬 BOT 與冒險者之庭。原角色與收藏都保留，請使用同一個 Telegram 帳號繼續冒險。',{reply_markup:{inline_keyboard:[[{text:'✨ 星穹旅誌',url:'https://t.me/StarJournalRpgBot'}],[{text:'🌌 加入新群組',url:'https://t.me/+5hDQa1rrBv4xMDhl'}]]}},msg.chat.id);return{rpg:'moved'};}
    if (mode === 'operations' && /^\/start(?:\s|$)/i.test(text)) { await postPanel(msg.chat.id); return { privateStarted: true }; }
    if (mode === 'operations' && /^(?:🔮 塔羅占卜|\/tarot|🙏 觀音求籤|\/qiuqian|求籤$)/.test(text)) return { ignored: 'life feature' };
    const dailuResult=await dailu.onMessage(msg,text);if(dailuResult)return dailuResult;
    const haiguiResult=await haigui.onMessage(msg,text);if(haiguiResult)return haiguiResult;
    const escapeResult=await escape.onMessage(msg,text);if(escapeResult)return escapeResult;
    if(mode!=='operations'&&text==='💬 問小精靈'){ // reply-keyboard twin of the panel's 「💬 問小精靈」
      if(!localAgents['網頁版GPT']&&!safeConfig().conf?.agents?.['網頁版GPT']){await replyTo(msg,'尚未設定轉話');return{notConfigured:'網頁版GPT'};}
      if(inGroup(msg.chat)){const choice=await send('想在哪裡跟小精靈對話？',{reply_markup:{inline_keyboard:[[{text:'👥 群組對話',callback_data:'rg:網頁版GPT'},{text:'🔒 私訊對話',callback_data:'rp:網頁版GPT'}]]}},msg.chat.id);return{modeChoice:choice.message_id};}
      const prompt=await send('請跟小精靈說需要甚麼幫忙？',{reply_markup:{force_reply:true,input_field_placeholder:'輸入問題…'}},msg.chat.id);prompts.set(flowKey(msg.chat.id,prompt.message_id),{agent:'網頁版GPT',at:now(),chatId:msg.chat.id,userId:msg.from.id});return{privateStarted:true,prompt:prompt.message_id};
    }
    if(mode!=='operations'&&inUserPrivate(msg.chat,msg.from)&&text==='🐺 狼人殺'){await send('🐺 狼人殺是群組遊戲，請到群組裡按「🐺 狼人殺」或輸入 /werewolf 發起。',{},msg.chat.id);return{groupOnly:true};}
    if(text==='🔮 塔羅占卜')return startTarotPrompt(msg.from,msg.chat);
    if(text==='🙏 觀音求籤'||text==='求籤'||text==='觀音求籤')return qiuqian.start(msg.from,msg.chat);
    const qiuqianCommand=/^\/qiuqian(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(text);
    if(qiuqianCommand&&(!qiuqianCommand[1]||qiuqianCommand[1].toLowerCase()===st.botUsername.toLowerCase()))return qiuqian.start(msg.from,msg.chat);
    const tarotCommand=/^\/tarot(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(text);
    if(tarotCommand&&(!tarotCommand[1]||tarotCommand[1].toLowerCase()===st.botUsername.toLowerCase()))return startTarotPrompt(msg.from,msg.chat);
    if(inUserPrivate(msg.chat,msg.from)&&/^\/start(?:\s|$)/i.test(text)){const prompt=await send('請跟小精靈說需要甚麼幫忙？',{reply_markup:{force_reply:true,input_field_placeholder:'輸入問題…'}},msg.chat.id);prompts.set(flowKey(msg.chat.id,prompt.message_id),{agent:'網頁版GPT',at:now(),chatId:msg.chat.id,userId:msg.from.id});return{privateStarted:true,prompt:prompt.message_id};}
    const tarotRt=msg.reply_to_message;const tarotKey=tarotRt?flowKey(msg.chat.id,tarotRt.message_id):null;const tarotPrompt=tarotKey?tarotPrompts.get(tarotKey):null;
    if(tarotRt&&tarotPrompt){
      if(String(tarotPrompt.userId)!==String(msg.from.id))return{ignored:'not tarot prompt owner'};
      if(now()-tarotPrompt.at>TAROT_TTL_MS){tarotPrompts.delete(tarotKey);saveTarot();await replyTo(msg,'這次占卜已過期，請重新按「🔮 塔羅占卜」。');return{expired:true};}
      if(!text){await replyTo(msg,'請輸入你真正想問的問題，再開始占卜。');return{ignored:'empty tarot question'};}
      const sid=`${now().toString(36)}${Number(msg.from.id).toString(36)}${Number(msg.message_id).toString(36)}`.slice(-24);
      const session=createTarotSession({id:sid,userId:msg.from.id,chatId:msg.chat.id,question:text,now:now()});
      tarotSessions.set(sid,session);tarotPrompts.delete(tarotKey);saveTarot();
      await ensureTarotKeyboard(msg.chat.id,true).catch(error=>log.warn(`tarot keyboard refresh failed: ${error.message}`));
      const preview=await replyTo(msg,tarotReadyText(session),{reply_markup:{inline_keyboard:[[{text:'🔮 開始占卜',callback_data:`tt:begin:${sid}`}]]}});session.messageId=preview.message_id;
      return{tarotReady:true,sessionId:sid};
    }
    const qiuqianResult=await qiuqian.onMessage(msg,text);if(qiuqianResult)return qiuqianResult;
    const hasPrivateAttachment=Array.isArray(msg.photo)&&msg.photo.length>0||Boolean(msg.document)||Boolean(msg.video);
    if(mode !== 'operations' && inUserPrivate(msg.chat,msg.from)&&(!text.startsWith('/')||/^\/chat(?:\s|$)/i.test(text)||hasPrivateAttachment))return handlePrivateChat({...msg,forceChat:/^\/chat(?:\s|$)/i.test(text)},text.replace(/^\/chat(?:\s|$)/i,'').trim());
    const rt = msg.reply_to_message;
    const rtKey=rt?flowKey(msg.chat.id,rt.message_id):null;
    // group: a reply to one of our videos becomes a draft for the video agent (same confirm-before-send flow and gating as the panel prompt)
    if(rt&&!prompts.has(rtKey)&&localAgents['網頁版GPT']&&!inUserPrivate(msg.chat,msg.from)&&isBotVideoMessage(rt,st.botUsername)&&(text||(Array.isArray(msg.photo)&&msg.photo.length)))prompts.set(rtKey,{agent:'網頁版GPT',at:now(),chatId:msg.chat.id,userId:msg.from.id,videoReply:true});
    if (rt && (prompts.has(rtKey) || (rt.from?.is_bot && (/^.{0,40}請輸入要問.+的問題$/s.test(rt.text || '')||rt.text==='請跟小精靈說需要甚麼幫忙？')))) {
      const p = prompts.get(rtKey);
      if(p&&String(p.userId)!==String(msg.from.id))return{ignored:'not prompt owner'};
      if (!p || now() - p.at > DRAFT_TTL_MS) {
        prompts.delete(rtKey);
        await replyTo(msg, '已過期，請重按選單按鈕（或輸入 /menu）');
        return { expired: true };
      }
      const hasPhoto=Array.isArray(msg.photo)&&msg.photo.length>0;const hasDocument=Boolean(msg.document);const hasVideo=Boolean(msg.video);const hasAttachment=hasPhoto||hasDocument||hasVideo;if (!text&&!hasAttachment) return { ignored: 'empty' };if(hasAttachment&&!localAgents[p.agent]){await replyTo(msg,'此助理目前不支援附件，請選「小精靈」。');return{ignored:'attachment unsupported'};}
      const question=text||(hasVideo?'請分析這段影片並摘要重要內容。':hasDocument?'請分析這份檔案並摘要重要發現。':'請查看這張圖片並回答。');const shown = question.length > 3500 ? `${question.slice(0, 3500)}…（共 ${question.length} 字）` : question;
      const preview = await replyTo(msg, `要傳給${displayAgent(p.agent)}${hasPhoto?'（附圖）':hasVideo?`（影片：${msg.video.file_name||'Telegram 影片'}）`:hasDocument?`（附件：${msg.document.file_name||'檔案'}）`:''}：\n${shown}`, {
        reply_markup: { inline_keyboard: [[{ text: '✅ 送出', callback_data: `rs:${rt.message_id}` }, { text: '❌ 取消', callback_data: `rc:${rt.message_id}` }]] },
      });
      prompts.delete(rtKey);
      drafts.set(flowKey(msg.chat.id,rt.message_id), { agent: p.agent, text:question, at: now(), previewId: preview?.message_id, msg, chatId:msg.chat.id,userId:msg.from.id,sending: false });
      return { draft: rt.message_id };
    }
    const cmd = parseCommand(text, { botUsername: st.botUsername, canReadAll: st.canReadAll, agentNames: agentNames() });
    if (!cmd) return { ignored: 'no command' };
    if (cmd.cmd === 'menu') { await postPanel(msg.chat.id); await ensureTarotKeyboard(msg.chat.id,true); return { menu: true }; }
    if(!isOwner(msg.from))return{ignored:'not owner'};
    if (!cmd.text) return { ignored: 'empty' };
    const r = await relayText({ agent: cmd.agent, text: cmd.text, msg });
    if (r.response || r.images?.length || r.videos?.length) await sendResponse(msg, r); else await replyTo(msg, resultText(r));
    return { relay: r };
  }

  async function startTarotPrompt(user, chat) {
    const name=user.first_name||'你';const targetChatId=chat.id;const group=inGroup(chat);
    const text=`${group?name+'，':''}請輸入你想占卜的問題 🔮`;
    const extra={reply_markup:{force_reply:true,selective:group,input_field_placeholder:'輸入想占卜的問題…'}};
    if(group)extra.entities=[{type:'text_mention',offset:0,length:name.length,user:{id:Number(user.id)}}];
    const prompt=await send(text,extra,targetChatId);
    tarotPrompts.set(flowKey(targetChatId,prompt.message_id),{userId:user.id,chatId:targetChatId,at:now()});saveTarot();
    return{tarotPrompt:prompt.message_id};
  }

  async function onTarotCallback(cq, action, sessionId, pickIndex) {
    if (mode === 'operations') { await answer(cq, '占卜之事，請找小精靈。'); return { denied: true }; }
    if (!inGroup(cq.message?.chat)&&!inUserPrivate(cq.message?.chat,cq.from)) { await answer(cq); return { ignored:'chat' }; }
    if(inUserPrivate(cq.message?.chat,cq.from)&&!await isGroupMember(cq.from)){await answer(cq,'🚫⛔ 這一切已與你無關！👋');return{denied:true};}
    if(action==='start'){
      await answer(cq);
      return startTarotPrompt(cq.from,cq.message.chat);
    }
    const session=tarotSessions.get(String(sessionId||''));
    if(!session||now()-session.updatedAt>TAROT_TTL_MS){if(session){tarotSessions.delete(session.id);saveTarot();}await answer(cq,'這次占卜已失效，請重新開始');return{expired:true};}
    if(String(session.userId)!==String(cq.from.id)){await answer(cq,'這不是你的牌局喔 🔮');return{denied:true};}
    session.updatedAt=now();
    if(action==='begin'){
      if(session.stage!=='ready'){await answer(cq,'已經開始翻牌了');return{busy:true};}
      session.stage='picking';session.messageId=cq.message.message_id;saveTarot();await answer(cq,`牌已洗好，憑直覺選 ${session.positions?.length||5} 張`);
      await edit(session.messageId,tarotBoardText(session),tarotKeyboard(session),session.chatId);
      return{tarotPicking:true,sessionId:session.id};
    }
    if(action==='pick'){
      if(session.stage!=='picking'){await answer(cq,session.stage==='reading'?'小精靈正在解牌…':'這個牌局已結束');return{busy:true};}
      const index=Number(pickIndex);if(!Number.isInteger(index)||index<0||index>=session.candidates.length){await answer(cq,'這張牌不存在');return{invalid:true};}
      if(session.picks.includes(index)){await answer(cq,'這張已經翻過了');return{duplicatePick:true};}
      session.picks.push(index);saveTarot();
      if(session.picks.length<(session.positions?.length||5)){await answer(cq,`已翻第 ${session.picks.length} 張`);await edit(session.messageId,tarotBoardText(session),tarotKeyboard(session),session.chatId);return{tarotPick:session.picks.length};}
      session.stage='reading';saveTarot();await answer(cq,'牌已翻完，小精靈開始解牌 🔮');await edit(session.messageId,tarotBoardText(session),[],session.chatId);
      return{tarotQueued:true,completion:scheduleTarotReading(session)};
    }
    await answer(cq);return{ignored:'tarot action'};
  }

  async function finishTarotReading(session) {
    if(tarotReadingPending.has(session.id))return{busy:true};
    tarotReadingPending.add(session.id);
    try{
      if(!session.spreadMessageId){
        if(typeof api.sendPhoto!=='function')throw new Error('Telegram 牌面圖片功能不可用');
        const photo=await api.sendPhoto({chatId:session.chatId,buffer:renderTarotSpread(session),mimeType:'image/png',fileName:'tarot-spread.png',caption:`🔮 本次抽到的 ${session.picks.length} 張牌（依抽牌順序與正逆位）`,replyToMessageId:session.messageId});
        session.spreadMessageId=photo.message_id;saveTarot();
      }
      if(typeof tarotInterpreter!=='function')throw new Error('解牌服務目前未啟用');
      const raw=await tarotInterpreter(buildTarotInterpretationPrompt(session),session);
      const reading=typeof raw==='string'?raw.trim():String(raw?.text??'').trim();
      if(!reading)throw new Error('小精靈沒有回傳解牌內容');
      const chunks=splitText(`🔮 小精靈解牌\n\n${reading}`);
      for(const [index,chunk] of chunks.entries())await send(chunk,index===0?{reply_to_message_id:session.messageId,allow_sending_without_reply:true}:{},session.chatId);
      session.stage='done';session.updatedAt=now();saveTarot();
      await ensureTarotKeyboard(session.chatId,true).catch(error=>log.warn(`tarot keyboard refresh failed: ${error.message}`));
      return{tarotDone:true};
    }catch(error){
      session.stage='error';session.updatedAt=now();saveTarot();log.warn(`tarot reading failed: ${error.message}`);
      await send('⚠️ 牌已翻完，但小精靈暫時無法完成解牌。請稍後重新開始一次。',{reply_to_message_id:session.messageId,allow_sending_without_reply:true},session.chatId);
      await ensureTarotKeyboard(session.chatId,true).catch(refreshError=>log.warn(`tarot keyboard refresh failed: ${refreshError.message}`));
      return{tarotFailed:true};
    }finally{tarotReadingPending.delete(session.id);}
  }

  function scheduleTarotReading(session) {
    if(tarotReadingJobs.has(session.id))return tarotReadingJobs.get(session.id);
    let resolve;
    const completion=new Promise(done=>{resolve=done;});
    tarotReadingJobs.set(session.id,completion);
    tarotReadingQueue.push({session,resolve});
    pumpTarotReadings();
    return completion;
  }

  function pumpTarotReadings() {
    while(activeTarotReadings<maxConcurrentTarotReadings&&tarotReadingQueue.length){
      const {session,resolve}=tarotReadingQueue.shift();
      activeTarotReadings++;
      setImmediate(()=>{
        void finishTarotReading(session)
          .then(resolve,error=>{log.warn(`tarot background reading failed: ${error.message}`);resolve({tarotFailed:true});})
          .finally(()=>{activeTarotReadings--;tarotReadingJobs.delete(session.id);pumpTarotReadings();});
      });
    }
  }

  async function onCallback(cq, kind, arg) {
    if (['a','g','p'].includes(kind) && !allowedAgent(arg)) { await answer(cq, '此職責已分流，請使用對應機器人。'); return { denied: true }; }
    if (!inGroup(cq.message?.chat)&&!inUserPrivate(cq.message?.chat,cq.from)) { await answer(cq); return { ignored: 'chat' }; }
    if(inUserPrivate(cq.message?.chat,cq.from)&&!await isGroupMember(cq.from)){await answer(cq,'🚫⛔ 這一切已與你無關！👋');return{denied:true};}
    if(kind==='m'){
      const [provider,messageId]=arg.split(':');const key=`${cq.message.chat.id}:${messageId}`,choice=choices[key];
      if(!choice||!['gpt','grok','grokqa','grokdev'].includes(provider)){await answer(cq,'選擇已失效，請重新提出任務');return{expired:true};}
      if(String(choice.userId)!==String(cq.from.id)||!isOwner(cq.from)){await answer(cq,'🚫🧚 我勸你少管閒事！🙅');return{denied:true};}
      if(choice.sending){await answer(cq,'任務已送出');return{busy:true};}
      const label={gpt:'GPT',grok:'GROK',grokqa:'GROK 問答',grokdev:'GROK Build 開發'}[provider];const extra=provider==='grokqa'?{maintenanceProvider:'grok',grokIntent:'qa'}:provider==='grokdev'?{maintenanceProvider:'grok',grokIntent:'dev'}:{maintenanceProvider:provider};
      choice.sending=true;tgStore?.save();await answer(cq,`交給 ${label} 處理`);
      try{const result=await handlePrivateChat({...choice.msg,...extra},choice.text);if(!result?.relay?.intentChoice)delete choices[key];tgStore?.save();await edit(cq.message.message_id,result?.relay?.intentChoice?`已交給 ${label}，請選擇處理方式`:`已交給 ${label}，進度見下方`,[],cq.message.chat.id);return result;}
      catch(error){choice.sending=false;tgStore?.save();throw error;}
    }
    if (kind === 'a') {
      const { conf } = safeConfig();
      if (!conf?.agents?.[arg] && !localAgents[arg]) { await answer(cq, '尚未設定轉話'); return { notConfigured: arg }; }
      if(!isOwner(cq.from)&&arg!=='網頁版GPT'){await answer(cq,'此功能僅限群主操作');return{denied:true};}
      if(arg==='網頁版GPT'&&inGroup(cq.message?.chat)){await answer(cq);const choice=await send('想在哪裡跟小精靈對話？',{reply_markup:{inline_keyboard:[[{text:'👥 群組對話',callback_data:'rg:網頁版GPT'},{text:'🔒 私訊對話',callback_data:'rp:網頁版GPT'}]]}},cq.message.chat.id);return{modeChoice:choice.message_id};}
      kind='g';
    }
    if(kind==='g'||kind==='p'){
      const { conf } = safeConfig();
      if (!conf?.agents?.[arg] && !localAgents[arg]) { await answer(cq, '尚未設定轉話'); return { notConfigured: arg }; }
      if(!isOwner(cq.from)&&arg!=='網頁版GPT'){await answer(cq,'此功能僅限群主操作');return{denied:true};}
      if(kind==='g')await answer(cq);
      const name = cq.from.first_name || '群組成員';
      const text = arg === '網頁版GPT' ? (kind==='p'?'請跟小精靈說需要甚麼幫忙？':`${name}，請跟小精靈說需要甚麼幫忙？`) : `${name}，請輸入要問${displayAgent(arg)}的問題`;
      const targetChatId=kind==='p'?cq.from.id:cq.message.chat.id;let prompt;
      try{prompt=await send(text, {
        ...(kind==='p'?{}:{entities: [{ type: 'text_mention', offset: 0, length: name.length, user: { id: Number(cq.from.id) } }]}),
        reply_markup: { force_reply: true, selective: kind!=='p', input_field_placeholder: '輸入問題…' },
      },targetChatId);}catch(error){if(kind==='p'){const url=st.botUsername?`https://t.me/${st.botUsername}?start=fairy`:undefined;await send('🔒 Telegram 規定機器人不能先私訊你。請先開啟小精靈私訊並按 Start，再回來選「私訊對話」。',url?{reply_markup:{inline_keyboard:[[{text:'開啟小精靈私訊',url}]]}}:{},cq.message.chat.id);await answer(cq,'請先在私訊按 Start');return{privateNotStarted:true};}throw error;}
      prompts.set(flowKey(targetChatId,prompt.message_id), { agent: arg, at: now(),chatId:targetChatId,userId:cq.from.id });
      if(kind==='p')await answer(cq,'已到私訊詢問你');
      return { prompt: prompt.message_id };
    }
    const id = Number(arg);
    const key=flowKey(cq.message.chat.id,id);const d = drafts.get(key);
    if(d&&String(d.userId)!==String(cq.from.id)){await answer(cq,'🚫🧚 我勸你少管閒事！🙅');return{denied:true};}
    if (!d || now() - d.at > DRAFT_TTL_MS) {
      if (d) { drafts.delete(key); await edit(d.previewId, '已過期',[],d.chatId); }
      await answer(cq, '已過期，請重按');
      return { expired: true };
    }
    if (d.sending) { await answer(cq, '處理中…'); return { busy: true }; }
    if (kind === 'c') {
      drafts.delete(key);
      await answer(cq, '已取消');
      await edit(d.previewId, '已取消',[],d.chatId);
      return { cancelled: true };
    }
    d.sending = true;
    const ownerPrivate=useOwnerPrivate(d.agent,d.text,d.msg);const progressChatId=ownerPrivate?ownerId:d.chatId;let progressMessageId=ownerPrivate?null:d.previewId;
    let progressTimer=null;let progressText='小精靈正在思考';const progressStarted=Date.now();
    const updateProgress=async text=>{progressText=text;if(ownerPrivate&&!progressMessageId){const m=await send(`⏳ ${text}…`,{},progressChatId);progressMessageId=m.message_id;return;}await edit(progressMessageId,`⏳ ${text}…`,[],progressChatId);};
    const finishProgress=async text=>{if(ownerPrivate&&!progressMessageId){const m=await send(text,{},progressChatId);progressMessageId=m.message_id;return;}await edit(progressMessageId,text,[],progressChatId);};
    if (localAgents[d.agent]) { await answer(cq, ownerPrivate?'維修進度改到私訊':'已送出，等待小精靈回覆');progressText=d.msg?.video?'正在上傳影片':d.msg?.document?'正在上傳附件':Array.isArray(d.msg?.photo)&&d.msg.photo.length?'正在上傳圖片':'小精靈正在思考';await updateProgress(progressText);progressTimer=setInterval(()=>{const seconds=Math.max(1,Math.round((Date.now()-progressStarted)/1000));void finishProgress(`⏳ ${progressText}…（已等待 ${seconds} 秒）`);},20000);progressTimer.unref?.(); }
    let r;
    try { r = await relayText({ agent: d.agent, text: d.text, msg: d.msg,onProgress:updateProgress }); } finally { d.sending = false;if(progressTimer)clearInterval(progressTimer); }
    if(ownerPrivate)r.privateOwnerOnly=true;
    if (r.ok) {
      drafts.delete(key);
      await answer(cq, ownerPrivate?'完成通知會私訊':'已送出');
      await finishProgress(`📨 已轉給${displayAgent(r.agent)}（${hhmm(now())}）`);
      if (r.response || r.images?.length || r.videos?.length || r.providerChoice || r.intentChoice) await sendResponse(d.msg, r);
      return { relay: r };
    }
    if (r.throttled) { await answer(cq, `太快了，請 ${r.throttled} 秒後再按`); return { relay: r }; }
    if (r.uncertain) {
      drafts.delete(key); await answer(cq, '回答狀態需確認');
      await finishProgress(`⚠️ ${r.reason}\n問題可能已送達，為避免重複，不提供重試按鈕；請查看 GPT 專用瀏覽器。`);
      return { relay: r };
    }
    if (r.hint) {
      drafts.delete(key);
      await answer(cq, r.hint.slice(0, 190));
      await finishProgress(r.hint);
      return { relay: r };
    }
    await answer(cq, '轉話失敗');
    const shown = d.text.length > 3500 ? `${d.text.slice(0, 3500)}…` : d.text;
    if(ownerPrivate)await finishProgress(`❌ 維修轉話失敗：${r.reason}`);
    else await edit(d.previewId, `要傳給${displayAgent(d.agent)}：\n${shown}\n\n❌ 轉話失敗：${r.reason}（可再按 ✅ 送出重試）`,
      [[{ text: '✅ 送出', callback_data: `rs:${id}` }, { text: '❌ 取消', callback_data: `rc:${id}` }]],d.chatId);
    return { relay: r };
  }

  return {
    state: st,
    prompts,
    drafts,
    async init() {
      try {
        const me = await api.call('getMe');
        st.botUsername = me?.username || '';
        st.privacyOff = Boolean(me?.can_read_all_group_messages);
        // Group admins receive every message even with privacy mode on.
        try {
          const m = await api.call('getChatMember', { chat_id: chatId, user_id: me.id });
          st.botIsAdmin = ['administrator', 'creator'].includes(m?.status);
        } catch (error) { log.warn(`getChatMember(bot) failed: ${error.message}`); }
        st.canReadAll = st.privacyOff || Boolean(st.botIsAdmin);
      } catch (error) { log.warn(`getMe failed: ${error.message}`); }
      const { conf, bad } = safeConfig();
      log.info(`relay ready: bot @${st.botUsername || '?'}, privacy mode ${st.privacyOff ? 'OFF' : 'ON'}, group admin ${st.botIsAdmin ? 'yes' : 'no'} (/問 ${st.canReadAll ? 'enabled' : 'disabled'}); config: ${bad ? 'INVALID' : conf ? Object.keys(conf.agents).join(', ') : 'not set'}`);
      return st;
    },
    postPanel,
    ensureOwnerPrivateMenu: () => ownerId ? ensureTarotKeyboard(ownerId) : null,
    async ensureBotCommands() {
      const additions=mode === 'operations' ? [{command:'menu',description:'🧙 神殿守望者營運選單'}] : [{command:'menu',description:'🧚 有事就問小精靈（群組、私訊皆可）'},{command:'tarot',description:'🔮 塔羅占卜（群組、私訊皆可）'},{command:'qiuqian',description:'🙏 觀音求籤（群組、私訊皆可）'},{command:'werewolf',description:'🐺 狼人殺（限群組）'},{command:'haiguitang',description:'🐢 海龜湯（限群組）'},{command:'undercover',description:'🕵️ 誰是臥底（限群組）'},{command:'escape',description:'🚪 密室逃脫（限群組）'},{command:'baoxianxiang',description:'🔐 千鎖秘藏（限群組）'},{command:'dailu',description:'🧚 小精靈帶路（限私訊）'},{command:'gentleman',description:'🔞 紳士專區（每日片單與主題查詢）'}];
      for(const scope of [{type:'all_private_chats'},{type:'all_group_chats'}]){
        const current=await api.call('getMyCommands',{scope});
        const commands=Array.isArray(current)?current.filter(x=>x.command!=='rpg'):[];
        let changed=Array.isArray(current)&&commands.length!==current.length;
        // add missing commands and overwrite our own descriptions when they changed (other commands are kept as-is)
        if(mode === 'operations'){for(const command of additions){const i=commands.findIndex(x=>x.command===command.command);if(i<0){commands.push(command);changed=true;}else if(commands[i].description!==command.description){commands[i]={...commands[i],description:command.description};changed=true;}}}
        else{const ours=new Set(additions.map(x=>x.command));const next=[...commands.filter(x=>!ours.has(x.command)),...additions];if(JSON.stringify(next)!==JSON.stringify(commands)){commands.splice(0,commands.length,...next);changed=true;}} // our commands in panel order; other bots' / manual commands kept in front
        if(changed)await api.call('setMyCommands',{scope,commands});
      }
      await api.call('setChatMenuButton',{menu_button:{type:'commands'}});
    },
    async recoverTarotReadings() {
      const pending=[...tarotSessions.values()].filter(session=>session.stage==='reading'&&now()-session.updatedAt<TAROT_TTL_MS);
      await Promise.all([...pending.map(scheduleTarotReading),qiuqian.recover()]);
    },
    /** Post the panel once (first start with this feature) and try to pin it. */
    async ensurePanel() {
      if (tgStore?.data.relayPanel?.messageId) {
        const { conf } = safeConfig();
        try { // the pinned panel is edited in place (text + buttons), never re-posted while it still exists
          if (mode === 'operations') await api.call('editMessageReplyMarkup', { chat_id: chatId, message_id: tgStore.data.relayPanel.messageId, reply_markup: menuMarkup(Object.keys(conf?.agents || {})) });
          else await api.call('editMessageText', { chat_id: chatId, message_id: tgStore.data.relayPanel.messageId, text: PANEL_TEXT, reply_markup: menuMarkup(Object.keys(conf?.agents || {}), chatId) });
        }
        catch (error) {
          const reason=String(error?.description || error?.message);
          if(/message to edit not found|message not found/i.test(reason)){log.warn('relay panel no longer exists; posting a replacement');tgStore.data.relayPanel=null;tgStore.save();}
          else if(!/message is not modified/i.test(reason))log.warn(`relay panel refresh failed: ${error.message}`);
        }
        if(tgStore.data.relayPanel){await ensureTarotKeyboard();return tgStore.data.relayPanel;}
      }
      const msg = await postPanel();
      const rec = { messageId: msg?.message_id ?? null, at: new Date(now()).toISOString(), pinned: false, pinError: null };
      try {
        await api.call('pinChatMessage', { chat_id: chatId, message_id: msg.message_id, disable_notification: true });
        rec.pinned = true;
      } catch (error) { rec.pinError = String(error.description || error.message).slice(0, 120); }
      tgStore.data.relayPanel = rec;
      tgStore.save();
      await ensureTarotKeyboard();
      log.info(`relay panel posted (message ${rec.messageId}); pinned: ${rec.pinned}${rec.pinError ? ` (${rec.pinError})` : ''}`);
      return rec;
    },
    /** Returns null when the update is not for the relay (alert buttons etc.). */
    async handleUpdate(update) {
      if (update?.update_id != null) {
        if (seen.has(update.update_id)) return { duplicate: true };
        seen.add(update.update_id);
        seenOrder.push(update.update_id);
        if (seenOrder.length > 500) seen.delete(seenOrder.shift());
      }
      pruneExpired();
      if (update?.message) return onMessage(update.message);
      const cq = update?.callback_query;
      if(werewolf && String(cq?.data || '').startsWith('ww:')) return werewolf.onCallback(cq);
      if(undercover && UC_CALLBACK_RE.test(String(cq?.data || ''))) return undercover.onCallback(cq);
      const sc = cq && SC_CALLBACK_RE.exec(String(cq.data || ''));
      if(sc){if(safeCrack)return safeCrack.onCallback(cq,sc[1],sc[2],sc[3]);await answer(cq);return{ignored:'safe-crack'};}
      const rpgm = cq && RPG_CALLBACK_RE.exec(String(cq.data || ''));
      if(rpgm){await answer(cq,'星穹旅誌已搬家，請開啟 @StarJournalRpgBot。');return{ignored:'rpg-moved'};}
      const tarot = cq && /^tt:(start|begin|pick)(?::([A-Za-z0-9_-]{1,32}))?(?::([0-9]{1,2}))?$/.exec(String(cq.data || ''));
      if(tarot)return onTarotCallback(cq,tarot[1],tarot[2],tarot[3]);
      const qq = cq && QQ_CALLBACK_RE.exec(String(cq.data || ''));
      if(qq)return qiuqian.onCallback(cq,qq[1],qq[2],qq[3],qq[4]);
      const dl = cq && DL_CALLBACK_RE.exec(String(cq.data || ''));
      if(dl)return dailu.onCallback(cq,dl[1],dl[2],dl[3],dl[4]);
      const hg = cq && HG_CALLBACK_RE.exec(String(cq.data || ''));
      if(hg)return haigui.onCallback(cq,hg[1],hg[2]);
      const es = cq && ES_CALLBACK_RE.exec(String(cq.data || ''));
      if(es)return escape.onCallback(cq,es[1],es[2],es[3],es[4]);
      const m = cq && /^r([ascgpm]):(.{1,60})$/s.exec(String(cq.data || ''));
      if (m) return onCallback(cq, m[1], m[2]);
      const ve = cq && VB_CALLBACK_RE.exec(String(cq.data || ''));
      if (ve) { const c = cq.message?.chat; if (!inGroup(c) && !(inUserPrivate(c, cq.from) && await isGroupMember(cq.from))) { await answer(cq); return { ignored: 'chat' }; } return videoButtons.onCallback(cq, ve[1], { group: inGroup(c) }); }
      return null;
    },
    /** 「✏️ 繼續修改」 not pressed within 10 min → 「✅ 製作完成」 (persisted; call on startup and periodically). */
    sweepVideoButtons: () => videoButtons.sweep(),
    /** 🐢 海龜湯 timers (流局 / 自動開始 / 提示 / 時間到); call every ~10 s. */
    tickHaiguitang: () => haigui.tick(),
    /** 🐢 海龜湯 after a restart: resume 出題 and queued questions. */
    recoverHaiguitang: () => haigui.recover(),
    /** 🚪 密室逃脫 timers (流局 / 自動開始 / 求救 / 警告 / 時間到 / 自動存檔); call every ~10 s; also catches up after a restart. */
    tickEscape: () => escape.tick(),
    recoverEscape: () => escape.recover(),
    tickWerewolf: () => werewolf?.tick() ?? null,
    tickUndercover: () => undercover?.tick() ?? null,
    /** 🔐 千鎖秘藏 timers (報名倒數 / 自動開始 / 10 分鐘換輪 / 每分鐘更新); call every ~5 s; also catches up after a restart. */
    tickSafeCrack: () => safeCrack?.tick() ?? null,
    /** ⚔️ RPG: boss spawn fallback + Worker outbox (boss cards, +7 news, DMs) + throttled card edits; call every ~5 s. */
    tickRpg: () => rpg?.tick() ?? null,
  };
}
