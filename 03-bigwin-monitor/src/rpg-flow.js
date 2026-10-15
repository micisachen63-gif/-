import {createPartyFlow} from './rpg-party-flow.js';
import {createPkAnimationFlow} from './rpg-pk-animation-flow.js';
// ⚔️ 星穹旅誌 — Telegram adapter for 小精靈 (life role). All game rules/state live in the elf-rpg-api Worker;
// this module only renders menus, forwards button presses (X-Service-Secret), and delivers the Worker's outbox
// (group boss cards, +7 enhancement news, private notices). Long-polling bot: never calls setWebhook.
// Private chat: /rpg, /start rpg, 「⚔️ 冒險」 → a 🎮 Mini App button (web_app; the primary UI) + the text menu as fallback.
//   No character yet → 小精靈 issues a 24h create pass (/rpg/app/grant, after relay's group-membership gate) and offers
//   「🎮 建立角色」 (Mini App) or 「✍️ 用文字建立」 (name → class → gender wizard).
// Group: /rpg → t.me deep link (private chat, or ?startapp= when rpg.local.json mainMiniApp:true); boss cards keep the
//   「⚔️ 攻擊」 callback (web_app buttons are not allowed in groups) + a 🎮 link to the boss screen; Mini App attacks
//   come back through the outbox as boss_update → throttled card refresh.
// v0.5: 分享至群組 / 遺物 / 決鬥戰利品 → group PHOTO post (composed item card from the Worker's art/cards, caption = full stats)
//   with 「🤝 我要交易」(request → owner DM, owner 確認 in the Mini App) and 「👍 超讚」(toggle, count on the button); posts are
//   queued (≤1 per 6 s, bursts collapse). 「/決鬥 @人」 → PK card (⚔️ 接受 / ✕). The old group 「/交易」 card flow is gone:
//   /交易 and /trade now just explain the long-press → 分享至群組 flow. The trade window itself lives in the Mini App.
// Callback prefix is "rpg:" (NOT "rp:": relay.js already uses rp:網頁版GPT and its /^r([ascgpm]):/ catch-all would also swallow rp:*).
import path from 'node:path';
import { createRpgApi, loadRpgConfig } from './rpg-api.js';
import { bossCardBytes } from './rpg-boss-card.js';

export const RPG_CALLBACK_RE = /^rpg:([a-zA-Z]{2})(?::([A-Za-z0-9_.-]{1,48}))?$/;
const START_RE = /^(?:\/rpg(?:@([A-Za-z0-9_]+))?|\/start\s+rpg(?:boss|guardian|bag|shop)?|⚔️ 冒險|⚔️ RPG 冒險)$/i;
const BOSS_START_RE = /^\/start\s+rpgboss$/i;
const TRADE_START_RE = /^\/start\s+rpg(trade|req|pk)_([tqp][0-9a-f]{11})$/i;
const TRADE_RE = /^\/(?:交易|trade)(?:@([A-Za-z0-9_]+))?(?:\s+[\s\S]*)?$/i;
const PK_RE = /^\/(?:決鬥|pk|duel)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]+))?$/i;
const TRADE_HINT = '🤝 交易改成從裝備開始：打開遊戲 →「🎒 背包」→ 長按（電腦版按「⋯」）一件沒綁定的裝備 →「📣 分享至群組」。群組裡想要的人按「🤝 我要交易」，你在遊戲裡確認後就會打開交易視窗（雙方放好 → 🔒 鎖定 → OK）。';
const NAME_RE = /^[\p{L}\p{N}_]{2,12}$/u;
const BOSS_SLOTS = [0, ...Array.from({length:16},(_,i)=>i+8)];
const TPE = 8 * 3600e3;
const CLASS_INFO = {
  sword: { e: '⚔️', n: '劍士', d: '血厚耐打、近戰穩定。30 級可轉 狂戰士（範圍輸出）或 騎士（減傷坦克）' },
  archer: { e: '🧝', n: '妖精', d: '森林精靈族，擅長自然與遠程弓術。30 級可轉 風語妖精（範圍清怪）或 靈獸妖精（獵鷹省魔）' },
  mage: { e: '🔥', n: '法師', d: '單發傷害最高、吃藍水。30 級可轉 元素術士（連鎖範圍）或 秘法師（省魔單體）' },
};
const STATE_TEXT = { fighting: '🗡️ 掛機打怪中', no_mp: '💤 沒藍水：只能普攻（效率 35%）', town_no_red: '🏙️ 沒紅水，回城休息（EXP 停止）', reviving: '💀 復活中', gate: '🚪 經驗已滿，等待轉職' };
const ELEM = { earth: '🌍地', water: '🌊水', fire: '🔥火', wind: '🌪️風', light: '☀️光', dark: '🌑暗' };
const ITEM_NAME = { red_1: '紅色藥水', red_2: '橙色藥水', red_3: '白色藥水', red_4: '濃縮藥水', blue_1: '藍色藥水', blue_2: '精神藥水', blue_3: '高級精神藥水', blue_4: '濃縮精神藥水', mat_3: '巨像之核', mat_4: '冰晶之心', ward: '守護符', scroll_w: '武器強化捲', scroll_a: '防具強化捲', scroll_r: '洗屬性捲', reselect_1: '命運轉職書 I', mat_1: '酋長之證', mat_2: '樹王之心' };
const AFFIX = { atk: 'ATK', def: 'DEF', hp: 'HP', mp: 'MP', critPct: '爆擊', takenPct: '受傷', maxHpPct: 'MaxHP', maxMpPct: 'MaxMP', expPct: 'EXP', atkPct: 'ATK', mpCostPct: '耗魔', defFromWeaponPct: '武器轉DEF', elemStatMult: '元素×', elemPct: '相剋', extraTargets: '目標' };
const fmtBonus = (k, v) => (k === 'extraTargets' ? `目標 +${v}` : k === 'elemStatMult' ? `元素 ×${v}` : `${AFFIX[k] || k} ${v > 0 ? '+' : '−'}${/Pct$/.test(k) ? `${Math.round(Math.abs(v) * 1000) / 10}%` : Number(Math.abs(v)).toLocaleString('en-US')}`);
export const itemTitle = (it) => `${it.enhance ? `+${it.enhance} ` : ''}${it.name}`;
/** first caption line (who / where) per post kind */
export function shareHead(sh, short = false) {
  if(sh.item?.kind==='sigil')return `✦ ${sh.ownerName} 分享守護羽毛`;
  const c = sh.context || {};
  const it = sh.item || {};
  if (sh.kind === 'enhance') return `✨ 恭喜 ${sh.ownerName} 把「${c.itemName || sh.item?.name || '裝備'}」強化到 +${c.to}！`;
  if (sh.kind === 'relic') return c.source === 'boss' ? `👑【神話遺物 傲視群倫】${sh.ownerName} 從首領「${c.boss}」的戰利品獲得！` : `👑【神話遺物 傲視群倫】${sh.ownerName} 在${c.map ? `「${c.map}」` : ''}擊敗「${c.elite}」獲得！`;
  if (c.source === 'boss') return `🐉 首領戰利品！${sh.ownerName} 從「${c.boss || '首領'}」獲得`;
  if (c.source === 'elite') {
    const isRed = it.rarity === 'supreme';
    return isRed
      ? `🔥【遠古紅裝 震盪現世】${sh.ownerName} 在「${c.map || '冒險地圖'}」擊敗「${c.elite || '菁英怪'}」獲得！`
      : `⚔️ 菁英掉落！${sh.ownerName} 在「${c.map || '冒險地圖'}」擊退「${c.elite || '菁英怪'}」後獲得`;
  }
  if (sh.kind === 'pk') return `⚔️ 決鬥戰利品！${c.winner || sh.ownerName} 擊敗 ${c.loser || '?'}，奪得`;
  return short ? `📣 ${sh.ownerName} 分享` : `📣 ${sh.ownerName} 分享了一件裝備`;
}
/** full-stat caption for the group photo (≤ 1024 chars) */
export function shareCaption(sh) {
  if(sh.item?.kind==='sigil'){const it=sh.item;return [shareHead(sh),'【'+it.name+'】',it.type==='loot'?'隨機掉寶率 +'+Math.round(it.lootBonus*100)+'%':it.typeName+'傷害 +'+Math.round(it.damageBonus*100)+'%',sh.status==='traded'?'✅ 已成交':sh.showcase?'✧ 守護展示・歡迎喝采':sh.tradeable?'🔓 未綁定・可交易':'🔒 目前不可交易','👤 持有者：'+sh.ownerName,'📋 能力為分享當下快照'].join('\n');}
  const it = sh.item || {}; const extras = [...Object.entries(it.extras || {}).filter(([, v]) => v).map(([k, v]) => fmtBonus(k, v)), ...Object.entries(it.pct || {}).filter(([, v]) => v).map(([k, v]) => fmtBonus(k, v))];
  const aff = it.affix ? Object.entries(it.affix).map(([k, v]) => fmtBonus(k, v)) : [];
  const grade = it.grade === 'relic' ? `👑 神話・${it.rarityName}` : it.rarity === 'supreme' ? `🔥 遠古・${it.rarityName}` : it.rarityName;
  const clsName = it.classReq === 'any' ? '💎 全職業通用' : it.classReq === 'sword' ? '⚔️ 劍士專用' : it.classReq === 'archer' ? '🧝 妖精專用' : it.classReq === 'mage' ? '🔮 法師專用' : `${it.className}專用`;
  const lines = [shareHead(sh), `【${itemTitle(it)}】`,
    `品階 ${grade}｜${it.slotName}${it.type && it.type !== it.slotName ? `・${it.type}` : ''}｜${clsName}${it.branchReq ? `（${it.branchReq} 線）` : ''}｜T${it.tier}・Lv${it.levelReq}${it.enhance ? `｜強化 +${it.enhance}` : ''}`,
    `${SLOT_ICON[it.slot] || '⚔️'} ${it.statName} ${fmt(it.stat)}${it.classReq === 'any' && ['belt', 'undershirt'].includes(it.slot) ? `（${CLASS_INFO[it.statClass]?.n || '持有者職業'} DEF；跨職業數值不同）` : ''}${it.element ? `　${ELEM[it.element] || ''} +${fmt(it.elemStat)}` : ''}`,
    it.affixes?.lines?.length ? `能力詞條（${it.affixes.quality}）：${it.affixes.lines.map(x=>`${x.name} +${(x.value*100).toFixed(2)}%【${x.quality}】`).join('・')}` : null,extras.length ? `附加：${extras.join('・')}` : null, aff.length ? `✦ 詞條：${aff.join('・')}` : null,
    sh.status === 'traded' ? '✅ 已成交' : sh.showcase ? '✨ 裝備展示・歡迎喝采！穿戴與綁定狀態保留，這張卡不開放交易。' : it.bound || it.equipped || it.inTrade ? '🔒 目前不能直接交易；可先按「我要交易」表達意願，主人處理裝備後再確認' : sh.tradeable ? '🔓 未綁定・可交易' : '🔓 目前不可交易；可向主人提出交易意願',
    `👤 持有者：${sh.ownerName}`, '📋 屬性為分享當下快照；按鈕依目前狀態更新'];
  return lines.filter(Boolean).join('\n');
}
export function shareKeyboard(sh, { guardianLink = null } = {}) {
  if(sh.context?.source==='guardian'&&sh.context?.announcement===true){
    const rows=[];
    if(sh.status!=='traded')rows.push(btn('🤝 我要交易',`sq:${sh.id}`));
    if(guardianLink)rows.push({text:'✦ 我也來抽',url:guardianLink});
    return rows.length?[rows]:[];
  }
  const like = btn(`👍 超讚${sh.likes ? ` ${sh.likes}` : ''}`, `sl:${sh.id}`);
  if (sh.status === 'traded') return [[like]];
  return (sh.requestable ?? sh.tradeable) ? [[btn('🤝 我要交易', `sq:${sh.id}`), like]] : [[like]];
}
const GUARDIAN_TYPES={melee:'近戰傷害',ranged:'遠程傷害',magic:'魔法傷害',loot:'隨機掉寶率'};
const GUARDIAN_COLORS=['white','green','blue','purple','red','gold','pink','cyan'],GUARDIAN_COLOR_NAMES=['白','綠','藍','紫','紅','金','粉','青'];
const html=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function guardianNoticeCaption(payload,share=null){
  const item=share?.item||payload,type=item.type,ability=GUARDIAN_TYPES[type],bonus=type==='loot'?item.lootBonus:item.damageBonus;
  const count=[1,5,10].includes(payload.count)?payload.count:1,quality=GUARDIAN_COLORS.indexOf(item.quality),qualityName=quality>=0?GUARDIAN_COLOR_NAMES[quality]:String(item.qualityName||'').slice(0,4);
  const name=html(String(payload.name||share?.ownerName||'冒險者').slice(0,64));
  const lines=[payload.source==='fuse'?'✦ <b>神羽蛻變・天使降臨</b>':'✦ <b>星光回應了祈願</b>',
    payload.source==='fuse'?`${name} 凝聚神羽，迎來了新的守護天使。`:`${name} 召喚了 ${count} 位天使。`,
    `${count>1?'本次最高品質':'獲得'}：<b>${html(qualityName)}色・${html(String(item.typeName||'守護天使').slice(0,40))}</b>`];
  if(ability&&Number.isFinite(bonus)&&bonus>=0)lines.push(`✧ ${ability} +${Number((bonus*100).toFixed(2))}%`,type==='loot'?'全職業適用；提升隨機掉落機會，固定獎勵不變。':'對應攻擊類型的 PvE 傷害提升；決鬥不套用。');
  if(count>1&&payload.qualityCounts){const summary=GUARDIAN_COLORS.map((key,i)=>Number.isSafeInteger(payload.qualityCounts[key])&&payload.qualityCounts[key]>0?GUARDIAN_COLOR_NAMES[i]+' ×'+payload.qualityCounts[key]:null).filter(Boolean).join('・');if(summary)lines.push('本批神羽：'+summary);}
  lines.push(share?.tradeBlockReason?html(share.tradeBlockReason):share?.showcase||item.bound?'🔒 已綁定的天使可展示；取消啟用並解綁後，請另行分享交易卡。':share&&!share.tradeable?'此天使目前無法交易，按「我要交易」可確認狀態。':'🔓 未綁定；按「我要交易」向主人表達意願。',
    '✦ 也把你的願望，交給世界樹。');
  return lines.join('\n');
}
const PKS = { pending: '等待接受', done: '已結束', declined: '✕ 對方拒絕了', cancelled: '✕ 挑戰已取消', expired: '⌛ 沒人回應，挑戰過期' };
export function pkText(p) {
  const tag = (x) => `${x.name}（${x.className || ''} Lv${x.level}）`;
  if (p.status === 'done') {
    const w = p.winner === 'a' ? p.a : p.b, l = p.winner === 'a' ? p.b : p.a; const lg = p.log || {};
    return [`⚔️ 決鬥結果｜${tag(p.a)} vs ${tag(p.b)}`, `🏆 ${w.name} 勝！${lg.ko ? `${p.rounds} 回合擊倒` : `${p.rounds} 回合判定勝`}${lg.hp ? `（剩 HP ${fmt(lg.hp[p.winner])}/${fmt(lg.max[p.winner])}）` : ''}`,
      p.drop ? `💥 ${l.name} 掉落了【${itemTitle(p.drop)}】→ ${w.name} 的背包（已解除綁定，可以交易買回）` : p.wardUsed ? `🧿 ${l.name} 的守護符擋下了掉裝` : `${l.name} 沒有掉裝備`].join('\n');
  }
  const head = `⚔️ ${p.a.name} 向 ${p.b.name} 發起決鬥！`;
  if (p.status !== 'pending') return `${head}\n${PKS[p.status] || p.status}`;
  return [head, `${tag(p.a)} vs ${tag(p.b)}`, `${p.b.name} 按「⚔️ 接受決鬥」就開打（${Math.max(1, Math.ceil(p.secondsLeft / 60))} 分鐘內）。`, '規則：輸的人有 20% 機率掉 1 件身上的裝備給贏家（武器也會掉；背包有守護符會自動擋下並消耗 1 張）。'].join('\n');
}
const SLOT_ICON = { weapon: '🗡️', helmet: '⛑️', armor: '🛡️', gloves: '🧤', boots: '👢', belt: '🎗️', undershirt: '👕', earring: '💎', ring: '💍' };
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const hm = (t) => new Date(t + TPE).toISOString().slice(11, 16);
export const bossLootText=b=>`掉落：◆ 首領精華 ×${4+Math.max(1,Math.min(12,Number(b.mapId)||1))}（每帳號每日前四隻，需實際參戰）＋金幣＋首領裝備${b.material?`\n🏅 ${b.material}：需要的人每人 1 個`:''}\n✦ 額外機會：祝福卷軸、神話遺物`;
const bar = (v, max, n = 10) => { const k = max > 0 ? Math.max(0, Math.min(n, Math.round((v / max) * n))) : 0; return '█'.repeat(k) + '░'.repeat(n - k); };
const btn = (text, data) => ({ text, callback_data: `rpg:${data}` });

export function createRpgFlow({ api, send, answer, log, now = () => Date.now(), tgStore = null, inGroup, inUserPrivate, isGroupMember = async () => true,
  chatId, botUsername = () => '', rpgApi = null, configFile = path.resolve(import.meta.dirname, '..', 'rpg.local.json'), readFile, mode = 'all',
  editThrottleMs = 5000, outboxEveryMs = 30000, memberCacheMs = 10 * 60e3, appUrl = null, mainMiniApp = false, photoGapMs = 6000, likeThrottleMs = 3000, fetchImpl = globalThis.fetch }) {
  let client = rpgApi; const app = { url: appUrl, main: mainMiniApp };
  if (!client && mode !== 'operations') {
    try { const cfg = loadRpgConfig(configFile, readFile); if (cfg) { client = createRpgApi({...cfg,fetchImpl}); app.url = cfg.appUrl; app.main = cfg.mainMiniApp; } else log.info('rpg: rpg.local.json not set; ⚔️ 冒險 disabled'); }
    catch (error) { log.warn(`rpg: rpg.local.json unreadable (${error.message})`); }
  }
  if (mode === 'operations') { client = null; app.url = null; }
  const st = () => { const d = tgStore ? (tgStore.data.rpg ??= { drafts: {}, cards: {}, spawnChecked: null }) : (st.mem ??= { drafts: {}, cards: {}, spawnChecked: null });
    d.scards ??= {}; d.pcards ??= {}; d.pq ??= []; delete d.tcards; return d; };
  const save = () => tgStore?.save();
  const members = new Map(); const dirty = new Map(); const sdirty = new Map(); const photoCache = new Map(); let lastClaim = 0; let lastPhoto = 0; let ticking = false;
  const warn = (what, error) => log.warn(`rpg ${what}: ${error?.message || error}`);
  const deepLink = (screen = '') => (!botUsername() ? null : app.main && app.url ? `https://t.me/${botUsername()}?startapp=${screen || 'home'}` : `https://t.me/${botUsername()}?start=${screen === 'guardian'?'rpgguardian':screen === 'boss' ? 'rpgboss' : screen==='bag'?'rpgbag':screen==='shop'?'rpgshop': /^(trade|req|pk|party)_/.test(screen) ? `rpg${screen}` : 'rpg'}`);
  /** web_app button (private chats only — Telegram rejects web_app inline buttons in groups) */
  const appBtn = (text, screen = '') => (app.url ? { text, web_app: { url: screen ? `${app.url}?screen=${screen}` : app.url } } : null);
  const popup = async (cq, text, alert = true) => { try { await api.call('answerCallbackQuery', { callback_query_id: cq.id, text: String(text).slice(0, 190), show_alert: alert }); } catch (error) { warn('answer', error); } };
  const partyFlow=createPartyFlow({api,client,send,popup,st,save,chatId,deepLink,appBtn,now,warn});
  const editMsg = async (cid, mid, text, keyboard = []) => {
    try { await api.call('editMessageText', { chat_id: cid, message_id: mid, text: text.slice(0, 4096), reply_markup: { inline_keyboard: keyboard } }); }
    catch (error) { if (/not modified/i.test(String(error?.description || error?.message))) return; warn('edit', error); throw error; }
  };
  const isMember = async (user) => {
    const c = members.get(String(user.id)); if (c && now() - c.at < memberCacheMs) return c.ok;
    const ok = await isGroupMember(user); members.set(String(user.id), { ok, at: now() }); return ok;
  };

  // ---------- rendering ----------
  function mainText(v, note = '') {
    const c = v.character; const s = v.stats; const inv = v.inventory || {};
    const red = Object.entries(inv).filter(([k]) => k.startsWith('red_')).reduce((n, [, q]) => n + q, 0);
    const blue = Object.entries(inv).filter(([k]) => k.startsWith('blue_')).reduce((n, [, q]) => n + q, 0);
    let state = STATE_TEXT[c.state] || c.state;
    if (c.state === 'reviving' && c.stateUntil) state += `（約 ${Math.max(1, Math.ceil((c.stateUntil - now()) / 60e3))} 分鐘）`;
    const lines = [
      `${c.emoji} ${c.name}｜${c.className} Lv${c.level}｜${c.mapName}`,
      c.expNeed ? `EXP ${bar(c.exp, c.expNeed)} ${c.expPct}%（${fmt(c.exp)} / ${fmt(c.expNeed)}）` : 'EXP 已達上限',
      `❤️ ${fmt(c.hp)}/${fmt(c.maxHp)}　💙 ${fmt(c.mp)}/${fmt(c.maxMp)}　⚔️ ATK ${fmt(s.atk)}　🛡️ DEF ${fmt(s.def)}`,
      `技能：${s.skill.name}（耗魔 ${s.skill.cost}）${s.passive ? `｜${s.passive}` : ''}`,
      `狀態：${state}`,
      `💰 ${fmt(c.gold)}　🧪 紅水 ${fmt(red)}（約 ${v.supply.redHours} 小時）　💙 藍水 ${fmt(blue)}（約 ${v.supply.blueHours} 小時）`,
      `📜 武器捲 ${inv.scroll_w || 0}　防具捲 ${inv.scroll_a || 0}　🎲 洗屬捲 ${inv.scroll_r || 0}　🧿 守護符 ${inv.ward || 0}`,
    ];
    if (c.autoRedPct < 35) lines.push(`⚠️ 喝紅水門檻 ${c.autoRedPct}% 偏低，精英怪一擊可能打死你（建議 ≥ 40%）`);
    const r = v.report;
    if (r?.ticks >= 10) {
      const drops = Object.entries(r.drops || {}).map(([k, q]) => `${ITEM_NAME[k] || k}×${q}`).join('、');
      lines.push('', `📋 離線 ${Math.round(r.ticks / 6) / 10} 小時：EXP +${fmt(r.exp_gained)}、打倒 ${fmt(r.kills)} 隻、💰 金幣 +${fmt(r.gold_gained)}${r.gold_elites ? `（含菁英 ${fmt(r.gold_elites)}）` : ''}${r.levels_gained ? `、升 ${r.levels_gained} 級` : ''}`
        + `${drops ? `\n🎁 掉落：${drops}` : ''}${r.relics?.length ? `\n🏺 遺物：${r.relics.map((x) => x.name).join('、')}` : ''}${r.deaths ? `\n💀 陣亡 ${r.deaths} 次${r.exp_lost ? `（EXP −${fmt(r.exp_lost)}）` : ''}${r.wards_used ? `、守護符擋下 ${r.wards_used} 次` : ''}` : ''}${r.skipped_ticks ? '\n（超過 24 小時的部分不計，記得每天回來補水）' : ''}`);
    }
    if (v.gate?.atGate || v.gate?.canAdvance) lines.push('', v.gate.have ? `⬆️ 你有「${v.gate.materialName}」，可以轉職了！` : `🚪 轉職需要「${v.gate.materialName}」：群組首領每小時整點（01:00～07:59 休息）出現`);
    if (v.boss?.status === 'active') lines.push('', `🐉 群組首領【${v.boss.name}】出現中！剩 ${Math.ceil(v.boss.secondsLeft / 60)} 分鐘，快去群組按「⚔️ 攻擊」`);
    else if (v.nextBoss) lines.push(`🐉 下一隻群組首領：${hm(v.nextBoss.start)}`);
    if (note) lines.push('', note);
    return lines.join('\n');
  }
  function mainKeyboard(v) {
    const rows = [[btn(v.daily?.claimed ? '✅ 今日補給金已領' : `💰 領補給金 ${fmt(v.daily?.total)}`, 'dy'), btn('🧪 一鍵補水 24h', 'rf')], [btn('🛒 商店', 'sh'), btn('🎒 裝備／強化', 'eq')], [btn('⚙️ 設定', 'st'), btn('📒 紀錄', 'lg'), btn('🔄 刷新', 'me')]];
    if (v.gate?.canAdvance) rows.unshift([btn('⬆️ 轉職', 'ad')]);
    else if (v.character.classTier >= 1) rows.push([btn('📖 命運轉職書（換路線）', 'rs')]);
    const a = appBtn('🎮 打開冒險（遊戲畫面）'); if (a) rows.unshift([a]);
    return rows;
  }
  const back = [btn('↩️ 返回', 'me')];
  function equipText(v) {
    const lines = ['🎒 裝備（點選查看、穿上、強化、洗屬性）'];
    for (const e of v.equipment) lines.push(`${SLOT_ICON[e.slot]} ${e.equipped ? '✅' : '　'}${e.enhance ? `+${e.enhance} ` : ''}${e.name}［${e.rarityName}・${ELEM[e.element] || ''}］${e.statName} ${e.stat}${e.cannotEquip ? `（${e.cannotEquip}）` : ''}`);
    return lines.join('\n');
  }
  function equipKeyboard(v) {
    const rows = v.equipment.map((e) => [btn(`${SLOT_ICON[e.slot]} ${e.enhance ? `+${e.enhance} ` : ''}${e.name}`.slice(0, 40), `ei:${e.id}`)]);
    rows.push(back); return rows;
  }
  function itemText(e, inv) {
    const o = e.enhanceNext; const scroll = ITEM_NAME[e.scroll];
    return [`${SLOT_ICON[e.slot]} ${e.enhance ? `+${e.enhance} ` : ''}${e.name}（T${e.tier}・${e.type || ''}）`, `品階：${e.rarityName}　元素：${ELEM[e.element] || '-'} ${e.elemStat}　${e.statName} ${e.stat}`,
      `等級需求 Lv${e.levelReq}${e.branchReq ? `　限 ${e.branchReq} 線` : ''}${e.equipped ? '　✅ 穿戴中' : ''}${e.cannotEquip ? `　❌ ${e.cannotEquip}` : ''}`,
      o ? `強化 +${e.enhance}→+${e.enhance + 1}：${o.safe ? `安定值內 成功 ${o.success * 100}%／無事 ${o.nothing * 100}%` : `⚠️ 超過安定值 成功 33%／無事 34%／爆裝消失 33%`}，消耗「${scroll}」×${e.scrollCost}（你有 ${inv[e.scroll] || 0}）` : '強化已達上限',
      `能力詞條：${e.affixes?.quality||'未鑑定'} · ${e.affixes?.lines?.length||0}/${e.affixes?.slots||1} 條\n${(e.affixes?.lines||[]).map(x=>`${x.name} +${(x.value*100).toFixed(2)}%【${x.quality}】`).join('・')}\n重鑄保留品階、元素與強化；請在裝備畫面選擇鎖定並查看費用。`].join('\n');
  }
  function itemKeyboard(e) {
    const rows = []; if (!e.equipped && !e.cannotEquip) rows.push([btn('✅ 穿上', `eo:${e.id}`)]);
    rows.push([btn(e.enhanceNext && !e.enhanceNext.safe ? '⚠️ 強化（可能爆裝）' : '✨ 強化', `${e.enhanceNext && !e.enhanceNext.safe ? 'eX' : 'en'}:${e.id}`), btn('🎲 洗屬性', `${['legendary', 'supreme'].includes(e.rarity) ? 'rX' : 'rr'}:${e.id}`)]);
    if (e.convertible) rows.push([btn('🔁 免費轉換成另一條路線的武器', `cv:${e.id}`)]);
    rows.push([btn('↩️ 裝備列表', 'eq'), btn('🏠 主選單', 'me')]); return rows;
  }
  function shopText(v, shop) {
    const lines = ['🛒 商店（金幣 ' + fmt(v.character.gold) + '）'];
    for (const o of shop.items) lines.push(`• ${o.name} ${fmt(o.price)}：${o.desc}`);
    lines.push('', '裝備請按「⚔️ 裝備商店」（只會列出你的職業／路線能用的）');
    return lines.join('\n');
  }
  function shopKeyboard(shop) {
    const rows = []; const qty = (k) => (k.startsWith('red_') || k.startsWith('blue_') ? [100, 500] : k === 'ward' || k.startsWith('reselect') ? [1] : [1, 5]);
    for (const o of shop.items) rows.push(qty(o.item).map((q) => btn(`${o.name}×${q}（${fmt(o.price * q)}）`, `bi:${o.item}.${q}`)));
    rows.push([btn('⚔️ 裝備商店', 'sg')], back); return rows;
  }
  function bossText(b, rankLimit = 30) {
    const ranks=(b.top || []).slice(0,30);
    const top = [ranks.slice(0,rankLimit).map((a, i) => `${['🥇', '🥈', '🥉'][i] || (i+1)+'.'} ${a.name || a.tgId} ${fmt(a.damage)}`).join('　'),ranks.length>rankLimit?'完整前 30 名請見遊戲「神戰」':''].filter(Boolean).join('\n');
    if (b.status === 'killed') {
      const r = b.result || {}; const mats = (r.materials || []).map((m) => m.name).join('、');
      return [`🎉【${b.name}】被擊倒了！（${b.mapName}）`, top && `傷害榜：${top}`, mats && `🏅 ${r.materials[0]?.itemName}：${mats}`, r.gear && `⚔️ 首領裝備：${r.gear.name} 獲得「${r.gear.itemName}」`, r.essences?.length && `◆ 首領精華：${r.essences.map(x=>`${x.name} +${x.qty}`).join('、')}（每帳號每日前四次）`, r.relics?.length && `🏺 遺物：${r.relics.map((x) => `${x.name} 獲得「${x.itemName}」`).join('、')}`, r.blessedScrolls?.length && `✨ 祝福卷軸：${r.blessedScrolls.map((x) => `${x.name} 獲得「${x.itemName}」`).join('、')}`, `💰 金幣依傷害分配，已入帳${r.capped?.length ? '（今日已打滿 4 隻的人只拿 20%）' : ''}`].filter(Boolean).join('\n');
    }
    if (b.status === 'fled') return `💨【${b.name}】30 分鐘到，逃走了…（${b.mapName}）\n${top ? `傷害榜：${top}` : ''}`;
    if (b.status === 'vanished') return `🌫️ 沒有人攻擊，【${b.name}】消失了。下一隻首領 每小時整點（01:00～07:59 休息） 出現`;
    return [`🐉 群組首領出現！【${b.name}】${b.mapName}　屬性 ${b.elementEmoji}${b.elementName}`, `HP ${bar(b.hp, b.maxHp, 12)} ${fmt(b.hp)} / ${fmt(b.maxHp)}`,
      `參戰 ${b.participants} 人｜剩 ${Math.max(0, Math.ceil(b.secondsLeft / 60))} 分鐘｜每 ${b.attackWindowMinutes} 分鐘可攻擊 1 次（自動喝水放 5 次技能）`,
      top && `傷害榜：${top}`, bossLootText(b), '30 分鐘內沒打倒就會逃走；沒人攻擊也會消失。'].filter(Boolean).join('\n');
  }
  function bossCaption(b){for(let n=Math.min(30,(b.top||[]).length);n>=0;n--){const text=bossText(b,n);if(text.length<=1024)return text}return bossText(b,0).slice(0,1024)}
  function bossKeyboard(b) {
    if (b.status !== 'active') return [];
    const rows = [[btn('⚔️ 攻擊', `ba:${b.id}`), btn('🔄', `bs:${b.id}`)]]; const link = deepLink('boss'); if (link) rows.push([{ text: app.url ? '🎮 首領畫面／我的角色' : '👤 我的角色（私訊）', url: link }]);
    return rows;
  }

  // ---------- v0.5 分享 photo posts · 我要交易 · 超讚 · 決鬥 cards ----------
  const tradeSummary = (t) => {
    const side = (x) => `${x.name}${x.locked ? ' 🔒' : ''}${x.ok ? ' ✅' : ''}：${[...(x.lines || []).map((o) => (o.kind === 'item' ? `${o.emoji || ''}${o.name}×${o.qty}` : `${o.enhance ? `+${o.enhance} ` : ''}${o.name}`)), x.gold ? `💰 ${fmt(x.gold)}` : null].filter(Boolean).join('、') || '（空）'}`;
    const st8 = { open: '進行中', done: '✅ 交易完成', cancelled: '✕ 已取消（物品已退回）', expired: '⌛ 已過期（物品已退回）' }[t.status] || t.status;
    return [`🤝 交易｜${t.a.name} ⇄ ${t.b.name}（${st8}）`, side(t.a), side(t.b)].join('\n');
  };
  /** Telegram photo upload of the composed item card (art/cards JPG) served by the Worker; cached in memory */
  async function cardBytes(photo) {
    if (!photo || !app.url) return null; const url = new URL(photo, app.url).toString(); if (photoCache.has(url)) return photoCache.get(url);
    try { const r = await fetchImpl(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); const b = Buffer.from(await r.arrayBuffer()); if (photoCache.size > 80) photoCache.delete(photoCache.keys().next().value); photoCache.set(url, b); return b; }
    catch (error) { warn('card photo', error); return null; }
  }
  async function sendCardPhoto(input) {
    try { return await api.sendPhoto(input); }
    catch (error) {
      // A transient socket failure is the only retry case here. Telegram's explicit
      // HTTP errors are definite failures; network errors may be ambiguous, so cap
      // this at one retry to avoid duplicate group posts.
      if (error?.name !== 'TelegramNetworkError' || !/fetch failed/i.test(error.message || '')) throw error;
      warn('share photo retrying once after network failure', error);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return api.sendPhoto(input);
    }
  }
  async function postShare(sh) {
    const cards = st().scards; if (cards[sh.id] || sh.messageId) return { skipped: true };
    const caption = shareCaption(sh).slice(0, 1024); const kb = shareKeyboard(sh); let m = null; let photo = false;
    const buf = typeof api.sendPhoto === 'function' ? await cardBytes(sh.item?.photo) : null;
    if (buf) { try { m = await sendCardPhoto({ chatId, buffer: buf, photoUrl:sh.item.photo, mimeType: 'image/jpeg', fileName: (sh.item.photo.split('/').pop() || 'item.jpg'), caption, replyMarkup: { inline_keyboard: kb } }); photo = true; } catch (error) { warn('share photo', error); } }
    if (!m) m = await send(caption, { reply_markup: { inline_keyboard: kb } }, chatId);   // text fallback (no art URL / upload failed)
    const mid = m?.message_id ?? m?.result?.message_id;
    if (!mid) throw new Error(`Telegram did not confirm share message ${sh.id}`);
    cards[sh.id] = { chatId, messageId: mid, photo, lastEdit: 0, at: now() }; save();
    await client.call('/rpg/share/message', { shareId: sh.id, chatId, messageId: mid }).catch((e) => warn('share message', e));
    return { posted: sh.id, photo };
  }
  async function refreshShareCard(sh, force = false) {
    const cards = st().scards; let c = cards[sh.id]; if (!c && sh.messageId) c = cards[sh.id] = { chatId: sh.chatId || chatId, messageId: sh.messageId, photo: true, lastEdit: 0 };
    if (!c) return false;
    if (!force && now() - (c.lastEdit || 0) < likeThrottleMs) { sdirty.set(sh.id, true); return true; }
    try {
      await api.call('editMessageReplyMarkup', { chat_id: c.chatId, message_id: c.messageId, reply_markup: { inline_keyboard: shareKeyboard(sh,{guardianLink:deepLink('guardian')}) } });
      c.lastEdit = now(); sdirty.delete(sh.id); save();
      return true;
    } catch (error) {
      if (/not modified/i.test(String(error?.description || error?.message))) {
        c.lastEdit = now(); sdirty.delete(sh.id); save();
        return true;
      }
      sdirty.set(sh.id, true);
      warn('share edit', error);
      return false;
    }
  }
  /** group photo queue: preserve a photo card and its per-item actions for every queued item; rate-limit by photoGapMs */
  async function flushPhotos() {
    const q = st().pq; if (!q.length || now() - lastPhoto < photoGapMs) return 0;
    const sh = q[0];
    await postShare(sh);
    q.shift(); save(); lastPhoto = now();
    return 1;
  }
  async function shareCallback(cq, action, arg) {
    const tg = String(cq.from.id);
    if (action === 'sl') {
      const r = await client.call('/rpg/share/like', { tgId: tg, shareId: arg }).catch((e) => ({ error: e }));
      if (r.error) { await popup(cq, r.error.message || '發生錯誤'); return { rpg: 'like-failed' }; }
      await popup(cq, r.liked ? `👍 超讚！（${r.likes}）` : `已收回讚（${r.likes}）`, false); if (r.share) await refreshShareCard(r.share, false);
      return { rpg: 'like', liked: r.liked, likes: r.likes };
    }
    try {
      const r = await client.call('/rpg/trade/request', { tgId: tg, username: cq.from.username || null, shareId: arg });
      await popup(cq, `🤝 已送出交易請求！${r.request.owner.name} 會收到通知，在遊戲裡按「確認」後交易視窗就會打開（24 小時內）。`);
      return { rpg: 'trade-request', requestId: r.request.id };
    } catch (error) {
      const msg = error.code === 'no_character' ? `你還沒有角色，先私訊 @${botUsername()} 輸入 /rpg 創角` : error.message;
      await popup(cq, msg); if (error.code === 'untradeable') { const g = await client.call('/rpg/share/get', { shareId: arg }).catch(() => null); if (g?.share) await refreshShareCard(g.share, true); }
      return { rpg: 'trade-request-failed', error: error.code };
    }
  }
  // 決鬥 cards
  function pkKeyboard(p) {
    if (p.status !== 'pending') return [];
    const rows = [[btn('⚔️ 接受決鬥', `pa:${p.id}`), btn('✕ 拒絕／取消', `pd:${p.id}`)]]; const link = deepLink(`pk_${p.id}`); if (link) rows.push([{ text: app.main && app.url ? '🎮 決鬥畫面' : '👤 我的角色（私訊）', url: link }]);
    return rows;
  }
  const pkAnimations=createPkAnimationFlow({api,client,send,editText:editMsg,st,save,chatId,now,warn,text:pkText,keyboard:pkKeyboard});
  async function renderPkCard(p,options={}) {return pkAnimations.render(p,options);}

  async function groupPk(msg, argText) {
    const from = msg.from; const reply = msg.reply_to_message?.from; let target = null;
    if (reply && !reply.is_bot && String(reply.id) !== String(from.id)) target = { tgId: String(reply.id) };
    const tm = (msg.entities || []).find((e) => e.type === 'text_mention' && e.user && !e.user.is_bot); if (!target && tm) target = { tgId: String(tm.user.id) };
    const at = /@([A-Za-z0-9_]{4,32})/.exec(argText || ''); if (!target && at && at[1].toLowerCase() !== String(botUsername()).toLowerCase()) target = { username: at[1] };
    const name = String(argText || '').trim(); if (!target && name && !name.startsWith('@')) target = { name: name.slice(0, 12) };
    const replyOpt = { reply_to_message_id: msg.message_id, allow_sending_without_reply: true };
    if (!target) { await send('⚔️ 決鬥用法：回覆對方的訊息輸入「/決鬥」，或「/決鬥 @對方帳號」／「/決鬥 角色名」。雙方 Lv10 以上、等級差 ≤10；輸的人有 20% 機率掉 1 件身上的裝備（守護符可擋）。', replyOpt, msg.chat.id); return { rpg: 'pk-usage' }; }
    let r;
    try { r = await client.call('/rpg/pk/challenge', { tgId: String(from.id), username: from.username || null, target, origin: 'group', chatId: msg.chat.id }); }
    catch (error) { const text = error.code === 'no_character' ? `你還沒有角色，先私訊 @${botUsername()} 輸入 /rpg 創角` : error.message; await send(`⚔️ ${text}`, replyOpt, msg.chat.id); return { rpg: 'pk-failed', error: error.code }; }
    await renderPkCard(r.pk, { post: true }); return { rpg: 'pk-challenge', pkId: r.pk.id };
  }
  async function pkCallback(cq, action, arg) {
    const tg = String(cq.from.id);
    try {
      if (action === 'pa') {
        const r = await client.call('/rpg/pk/accept', { tgId: tg, pkId: arg }); const p = r.pk; const w = p.winner === 'a' ? p.a : p.b;
        await popup(cq, `${p.me === p.winner ? '🏆 你贏了！' : '💀 你輸了…'}（${w.name} 勝，${p.rounds} 回合）${p.drop ? `\n掉落：${p.drop.name}` : p.wardUsed ? '\n🧿 守護符擋下了掉裝' : ''}`);
        await renderPkCard(p); return { rpg: 'pk-done', winner: p.winner };
      }
      const r = await client.call('/rpg/pk/decline', { tgId: tg, pkId: arg }); await popup(cq, r.pk.status === 'cancelled' ? '已取消挑戰' : '已拒絕決鬥', false); await renderPkCard(r.pk); return { rpg: `pk-${r.pk.status}` };
    } catch (error) {
      const msg = error.code === 'not_party' ? '這場決鬥不是找你的' : error.code === 'self' ? '要等對方接受挑戰' : error.code === 'no_character' ? `你還沒有角色，先私訊 @${botUsername()} 輸入 /rpg 創角` : error.message;
      await popup(cq, msg); const g = await client.call('/rpg/pk/get', { pkId: arg }).catch(() => null); if (g?.pk && g.pk.status !== 'pending') await renderPkCard(g.pk);
      return { rpg: 'pk-failed', error: error.code };
    }
  }

  // ---------- API helpers ----------
  async function rpg(cq, pathName, body) {
    try { return await client.call(pathName, body); }
    catch (error) { if (cq) await popup(cq, error.message || '發生錯誤'); else warn(pathName, error); return null; }
  }
  async function showMain(cid, user, mid = null, note = '', screen = '') {
    let v;
    try { v = await client.call('/rpg/me', { tgId: String(user.id) }); }
    catch (error) {
      if (error.code === 'no_character') return app.url && !mid ? offerApp(cid, user) : startCreate(cid, user);
      const m = await send(`⚠️ ${error.message}`, {}, cid); return { rpgError: error.code, id: m?.message_id };
    }
    if (mid) { await editMsg(cid, mid, mainText(v, note), mainKeyboard(v)); return { rpg: 'main', edited: mid }; }
    if (app.url) {   // Mini App is the primary UI: short status + 🎮 button; the text menu stays one tap away
      const c = v.character; let state = STATE_TEXT[c.state] || c.state;
      if (c.state === 'gate') state += `（需要「${v.gate?.materialName}」）`;
      const text = [`${c.emoji} ${c.name}｜${c.className} Lv${c.level}｜${c.mapName}`, state, screen === 'boss' ? '👹 點下方按鈕打開首領畫面' : '🎮 點下方按鈕打開冒險'].join('\n');
      const m = await send(text, { reply_markup: { inline_keyboard: [[appBtn(screen === 'boss' ? '👹 打開首領畫面' : '🎮 打開冒險', screen)], [btn('📜 文字選單', 'me')]] } }, cid);
      return { rpg: 'app', screen: screen || 'home', id: m?.message_id };
    }
    const m = await send(mainText(v, note), { reply_markup: { inline_keyboard: mainKeyboard(v) } }, cid); return { rpg: 'main', id: m?.message_id };
  }
  async function offerApp(cid, user) {
    try { await client.call('/rpg/app/grant', { tgId: String(user.id) }); } catch (error) { warn('app grant', error); return startCreate(cid, user); }
    const m = await send('⚔️ 歡迎來到星穹旅誌！\n點「🎮 建立角色」在遊戲畫面裡取名、選職業和性別；也可以用文字一步步建立。', { reply_markup: { inline_keyboard: [[appBtn('🎮 建立角色')], [btn('✍️ 用文字建立', 'cn')]] } }, cid);
    return { rpg: 'app-create', id: m?.message_id };
  }
  async function startCreate(cid, user) {
    const d = st().drafts; const prompt = await send('⚔️ 歡迎來到星穹旅誌！\n先幫你的角色取個名字（2–12 個字，中文／英文／數字／底線）：', { reply_markup: { force_reply: true, input_field_placeholder: '角色名' } }, cid);
    d[String(user.id)] = { step: 'name', promptId: prompt?.message_id ?? null, at: now() }; save(); return { rpg: 'create-name' };
  }
  const classText = (name) => [`角色名：${name}`, '選擇職業：', ...Object.values(CLASS_INFO).map((c) => `${c.e} ${c.n}：${c.d}`)].join('\n');
  const classKeyboard = () => [Object.entries(CLASS_INFO).map(([k, c]) => btn(`${c.e} ${c.n}`, `cc:${k}`)), [btn('✏️ 重新取名', 'cn')]];

  // ---------- messages ----------
  async function onMessage(msg, text) {
    if (!client) return null;
    if (inGroup(msg.chat)) {
      const pk = PK_RE.exec(text);
      if (pk && (!pk[1] || pk[1].toLowerCase() === String(botUsername()).toLowerCase())) return groupPk(msg, pk[2] || '');
      const tm = TRADE_RE.exec(text);
      if (tm && (!tm[1] || tm[1].toLowerCase() === String(botUsername()).toLowerCase())) { await send(TRADE_HINT, { reply_to_message_id: msg.message_id, allow_sending_without_reply: true }, msg.chat.id); return { rpg: 'trade-hint' }; }
      const m = START_RE.exec(text); if (!m || (m[1] && m[1].toLowerCase() !== String(botUsername()).toLowerCase())) return null;
      const link = deepLink();
      await send('⚔️ 星穹旅誌：創角、補水、商店、裝備都在遊戲畫面（私訊小精靈打開）。群組首領每小時整點（01:00～07:59 休息）出現在這裡！', link ? { reply_markup: { inline_keyboard: [[{ text: app.main && app.url ? '🎮 打開冒險' : '⚔️ 開始冒險（私訊）', url: link }]] } } : {}, msg.chat.id);
      return { rpg: 'group-link' };
    }
    if (!inUserPrivate(msg.chat, msg.from)) return null;
    const d = st().drafts[String(msg.from.id)];
    if (d?.step === 'name' && d.promptId != null && msg.reply_to_message?.message_id === d.promptId) {   // only replies to our force-reply prompt
      if (!NAME_RE.test(text)) { const p = await send('名字要 2–12 個字，只能用中文、英文、數字或底線，請再輸入一次：', { reply_markup: { force_reply: true, input_field_placeholder: '角色名' } }, msg.chat.id); d.promptId = p?.message_id ?? d.promptId; save(); return { rpg: 'bad-name' }; }
      Object.assign(d, { step: 'class', name: text, at: now() }); save();
      await send(classText(text), { reply_markup: { inline_keyboard: classKeyboard() } }, msg.chat.id); return { rpg: 'create-class' };
    }
    if (TRADE_RE.test(text)) { await send(TRADE_HINT, {}, msg.chat.id); return { rpg: 'trade-hint' }; }
    const ts = TRADE_START_RE.exec(text);
    if (ts) {
      const kind = ts[1].toLowerCase(); const id = ts[2]; const a = appBtn(kind === 'pk' ? '🎮 決鬥畫面' : kind === 'req' ? '🎮 查看交易請求' : '🎮 打開交易', `${kind}_${id}`);
      let body = '';
      if (kind === 'trade') { const g = await client.call('/rpg/trade/get', { tradeId: id, tgId: String(msg.from.id) }).catch((e) => ({ error: e })); body = g?.trade ? tradeSummary(g.trade) : `🤝 ${g?.error?.message || '找不到這筆交易'}`; }
      else if (kind === 'pk') { const g = await client.call('/rpg/pk/get', { pkId: id, tgId: String(msg.from.id) }).catch((e) => ({ error: e })); body = g?.pk ? pkText(g.pk) : `⚔️ ${g?.error?.message || '找不到這場決鬥'}`; }
      else body = '🤝 交易請求在遊戲畫面的「🤝 交易」分頁確認或拒絕。';
      await send(body, a ? { reply_markup: { inline_keyboard: [[a]] } } : {}, msg.chat.id); return { rpg: 'trade-link', kind };
    }
    const partyStart=/^\/start\s+rpgparty_(p[\da-f]{15})$/i.exec(text);if(partyStart)return showMain(msg.chat.id,msg.from,null,'',`party_${partyStart[1]}`);
    if (START_RE.test(text)) return showMain(msg.chat.id, msg.from, null, '', /^\/start\s+rpgguardian$/i.test(text)?'guardian':/^\/start\s+rpgbag$/i.test(text)?'bag':/^\/start\s+rpgshop$/i.test(text)?'shop':BOSS_START_RE.test(text) ? 'boss' : '');
    return null;
  }

  // ---------- buttons ----------
  async function onCallback(cq, action, arg) {
    if (!client) { await popup(cq, '⚔️ 冒險尚未開放'); return { ignored: 'rpg disabled' }; }
    const chat = cq.message?.chat; const mid = cq.message?.message_id; const user = cq.from; const tg = String(user.id); const req = `cq${cq.id}`;
    if(action==='jc'||action==='jv'){
      if(!inGroup(chat)||!await isMember(user)){await popup(cq,'請在冒險者之庭的今日旅誌卡操作');return {ignored:'not group'};}
      const day=new Date(now()+8*3600e3).toISOString().slice(0,10);
      if(arg!==day){await popup(cq,'這一頁已封存，請找群組今天的旅誌卡。');return {rpg:'journal-old-day'};}
      const r=await rpg(cq,action==='jc'?'/rpg/journal/checkin':'/rpg/journal',action==='jc'?{tgId:tg,day:arg,chatId:String(chat.id),messageId:mid}:{tgId:tg});
      if(!r)return {rpg:'journal-failed'};
      const j=r.journal;await popup(cq,`${action==='jc'?'☀ 報到成功，今天也一起出發！':'📖 今日旅團日誌'}\n已領 ${j.claimed}／3，每份 ${j.tier} 張自選卷\n${j.quests.map(q=>`${q.name}：${q.claimed?'已領取':q.locked?`${q.min}級解鎖`:q.completed?'完成':`${q.progress}/${q.goal}`}`).join('\n')}\n到遊戲「神戰 → 旅團日誌」領獎。`);return {rpg:'journal',checked:action==='jc'};
    }
    if (action === 'ba' || action === 'bs') {
      if (!inGroup(chat)) { await popup(cq, '首領戰在群組裡打'); return { ignored: 'not group' }; }
      if (action === 'bs') { const r = await rpg(cq, '/rpg/boss/get', { bossId: arg }); if (r?.boss) { await answer(cq); await renderCard(r.boss, true); } return { rpg: 'boss-refresh' }; }
      let r;
      try { r = await client.call('/rpg/boss/attack', { tgId: tg, bossId: arg }); }
      catch (error) {
        await popup(cq, error.code === 'no_character' ? `你還沒有角色，先私訊 @${botUsername()} 輸入 /rpg 創角` : error.message);
        if (error.code === 'boss_over') { const b = await client.call('/rpg/boss/get', { bossId: arg }).catch(() => null); if (b?.boss) await renderCard(b.boss, true); }
        return { rpg: 'boss-attack-failed', error: error.code };
      }
      const x = r.result;
      await popup(cq, `⚔️ 造成 ${fmt(x.damage)} 傷害${x.crits ? `（爆擊 ${x.crits} 次）` : ''}${x.basics ? `｜沒藍水普攻 ${x.basics} 次` : ''}${x.helper ? '｜高等支援 ×0.5' : ''}\n首領反擊 −${fmt(x.counter)} HP${x.downed ? '，你倒地了（10 分鐘後才能再打）' : ''}\n${x.killed ? '🎉 首領倒下！' : `首領剩 ${fmt(x.bossHp)} HP`}`);
      await renderCard(r.boss, x.killed); return { rpg: 'boss-attack', damage: x.damage };
    }
    if (['pj','py','pg','pl','ps','pt','px','pz','pv','pr','bt'].includes(action)) {
      if(!await isMember(user)){await popup(cq,'只限群組成員');return {ignored:'not member'};}
      return partyFlow.handle(cq,action,arg);
    }
    if (action === 'sq' || action === 'sl') { if (!inGroup(chat)) { await popup(cq, '請在群組的分享貼文按'); return { ignored: 'not group' }; } return shareCallback(cq, action, arg); }
    if (action === 'pa' || action === 'pd') return pkCallback(cq, action, arg);
    if (action === 'tk' || action === 'tx' || action === 'tr') { await popup(cq, '這張舊的交易卡已停用，請改用遊戲裡的交易視窗'); return { ignored: 'v0.4 trade card' }; }
    if (action === 'qa' || action === 'qr') {   // no-Mini-App fallback for the owner's request DM
      try { const r = await client.call(action === 'qa' ? '/rpg/trade/accept' : '/rpg/trade/reject', { tgId: tg, reqId: arg }); await popup(cq, action === 'qa' ? '✅ 交易視窗已開啟，請打開遊戲放入物品' : '已婉拒', false); return { rpg: action === 'qa' ? 'request-accepted' : 'request-rejected', tradeId: r.trade?.id }; }
      catch (error) { await popup(cq, error.message); return { rpg: 'request-failed', error: error.code }; }
    }
    if (!inUserPrivate(chat, user)) { await popup(cq, '請在私訊操作'); return { ignored: 'chat' }; }
    if (!await isMember(user)) { await popup(cq, '🚫 只限內部群組成員'); return { ignored: 'not member' }; }
    const drafts = st().drafts; const d = drafts[tg];
    switch (action) {
      case 'cn': await answer(cq); await startCreate(chat.id, user); return { rpg: 'rename' };
      case 'cc': {
        if (!d?.name || !CLASS_INFO[arg]) { await popup(cq, '請重新輸入 /rpg'); return { rpg: 'stale' }; }
        Object.assign(d, { step: 'gender', baseClass: arg }); save(); await answer(cq);
        await editMsg(chat.id, mid, `角色名：${d.name}\n職業：${CLASS_INFO[arg].e} ${CLASS_INFO[arg].n}\n選擇性別：`, [[btn('♂️ 男', 'cg:m'), btn('♀️ 女', 'cg:f')], [btn('↩️ 重選職業', 'cb')]]); return { rpg: 'create-gender' };
      }
      case 'cb': if (!d?.name) { await popup(cq, '請重新輸入 /rpg'); return { rpg: 'stale' }; } await answer(cq); await editMsg(chat.id, mid, classText(d.name), classKeyboard()); return { rpg: 'create-class' };
      case 'cg': {
        if (!d?.baseClass || !['m', 'f'].includes(arg)) { await popup(cq, '請重新輸入 /rpg'); return { rpg: 'stale' }; }
        Object.assign(d, { step: 'confirm', gender: arg }); save(); await answer(cq);
        await editMsg(chat.id, mid, `確認建立角色？\n名字：${d.name}\n職業：${CLASS_INFO[d.baseClass].e} ${CLASS_INFO[d.baseClass].n}\n性別：${arg === 'm' ? '♂️ 男' : '♀️ 女'}\n\n新手禮包：金幣 1,000、紅水 150、藍水 150、新手武器與盔甲。建立後馬上開始自動掛機！`, [[btn('✅ 建立角色', 'ck')], [btn('↩️ 重選職業', 'cb')]]);
        return { rpg: 'create-confirm' };
      }
      case 'ck': {
        if (d?.step !== 'confirm') { await popup(cq, '請重新輸入 /rpg'); return { rpg: 'stale' }; }
        const r = await rpg(cq, '/rpg/create', { tgId: tg, tgName: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 64) || null, name: d.name, gender: d.gender, baseClass: d.baseClass });
        if (!r) { if (d) { d.step = 'name'; save(); } return { rpg: 'create-failed' }; }
        delete drafts[tg]; save(); await answer(cq, '角色建立完成！');
        await editMsg(chat.id, mid, mainText(r, '🎉 角色建立完成，已經出發掛機了！每天記得回來「💰 領補給金」和「🧪 一鍵補水」。'), mainKeyboard(r)); return { rpg: 'created' };
      }
      case 'me': await answer(cq); return showMain(chat.id, user, mid);
      case 'dy': { const r = await rpg(cq, '/rpg/daily', { tgId: tg, requestId: req }); if (!r) return { rpg: 'daily-failed' }; await answer(cq, `+${fmt(r.result.gold)} 金幣`); await editMsg(chat.id, mid, mainText(r, `💰 領到補給金 ${fmt(r.result.gold)}${r.result.bonus ? `（含新手首週 +${fmt(r.result.bonus)}）` : ''}。按「🧪 一鍵補水」把水補滿吧！`), mainKeyboard(r)); return { rpg: 'daily' }; }
      case 'rf': { const r = await rpg(cq, '/rpg/refill', { tgId: tg, requestId: req }); if (!r) return { rpg: 'refill-failed' }; const x = r.result; await answer(cq, '補水完成'); await editMsg(chat.id, mid, mainText(r, `🧪 買了紅水 ${fmt(x.red)}、藍水 ${fmt(x.blue)}，花 ${fmt(x.cost)} 金幣${x.partial ? '（金幣不夠，只買得起一部分）' : ''}`), mainKeyboard(r)); return { rpg: 'refill' }; }
      case 'sh': { const r = await rpg(cq, '/rpg/shop', { tgId: tg }); if (!r) return null; await answer(cq); await editMsg(chat.id, mid, shopText(r, r.shop), shopKeyboard(r.shop)); return { rpg: 'shop' }; }
      case 'sg': {
        const r = await rpg(cq, '/rpg/shop', { tgId: tg }); if (!r) return null; await answer(cq);
        const g = r.shop.gear; const lines = ['⚔️ 裝備商店（隨機元素與品階：一般50%／高級30%／極品13%／傳說5%／霸主2%）', ...g.map((o) => `• ${o.name}（${o.type}${o.branch ? `・${o.branch} 線專屬` : ''}）${fmt(o.price)}　Lv${o.levelReq}`)];
        await editMsg(chat.id, mid, lines.join('\n'), [...g.map((o) => [btn(`${o.name} ${fmt(o.price)}`, `bg:${o.code}`)]), [btn('↩️ 商店', 'sh'), btn('🏠 主選單', 'me')]]); return { rpg: 'shop-gear' };
      }
      case 'bi': {
        const [item, q] = String(arg || '').split('.'); const r = await rpg(cq, '/rpg/buy', { tgId: tg, item, qty: Number(q), requestId: req }); if (!r) return { rpg: 'buy-failed' };
        await popup(cq, `✅ 買了 ${ITEM_NAME[item] || item}×${q}，花 ${fmt(r.result.total)} 金幣`, false);
        const sh = await rpg(null, '/rpg/shop', { tgId: tg }); if (sh) await editMsg(chat.id, mid, shopText(sh, sh.shop), shopKeyboard(sh.shop)); return { rpg: 'buy' };
      }
      case 'bg': { const r = await rpg(cq, '/rpg/buy-gear', { tgId: tg, code: arg, requestId: req }); if (!r) return { rpg: 'buy-gear-failed' }; const it = r.equipment.find((e) => e.id === r.result.item.id); await answer(cq, '購買成功'); await editMsg(chat.id, mid, `🛍️ 買到「${it.name}」［${it.rarityName}・${ELEM[it.element]}］\n\n${itemText(it, r.inventory)}`, itemKeyboard(it)); return { rpg: 'buy-gear' }; }
      case 'eq': { const r = await rpg(cq, '/rpg/me', { tgId: tg }); if (!r) return null; await answer(cq); await editMsg(chat.id, mid, equipText(r), equipKeyboard(r)); return { rpg: 'equip-list' }; }
      case 'ei': { const r = await rpg(cq, '/rpg/me', { tgId: tg }); if (!r) return null; const it = r.equipment.find((e) => e.id === arg); if (!it) { await popup(cq, '找不到這件裝備'); return { rpg: 'gone' }; } await answer(cq); await editMsg(chat.id, mid, itemText(it, r.inventory), itemKeyboard(it)); return { rpg: 'item' }; }
      case 'eo': case 'cv': {
        const r = await rpg(cq, action === 'eo' ? '/rpg/equip' : '/rpg/convert', { tgId: tg, itemId: arg }); if (!r) return { rpg: 'equip-failed' };
        const id = action === 'cv' ? r.result.item.id : arg; const it = r.equipment.find((e) => e.id === id); await answer(cq, action === 'eo' ? '已穿上' : '已轉換');
        await editMsg(chat.id, mid, itemText(it, r.inventory), itemKeyboard(it)); return { rpg: action === 'eo' ? 'equipped' : 'converted' };
      }
      case 'eX': {
        await answer(cq); const warnText = action === 'eX' ? '⚠️ 超過安定值：33% 會爆裝（裝備消失、捲軸不退）。確定要強化？' : '⚠️ 這件是傳說／霸主品階，洗屬性可能變差。確定要洗？';
        await editMsg(chat.id, mid, warnText, [[btn('✅ 確定', `${action === 'eX' ? 'en' : 'rr'}:${arg}`)], [btn('↩️ 取消', `ei:${arg}`)]]); return { rpg: 'confirm' };
      }
      case 'en': {
        const r = await rpg(cq, '/rpg/enhance', { tgId: tg, itemId: arg, requestId: req }); if (!r) return { rpg: 'enhance-failed' }; const x = r.result;
        const head = x.result === 'success' ? `✨ 強化成功！${x.itemName} +${x.from} → +${x.to}` : x.result === 'break' ? `💥 強化失敗，${x.itemName}（+${x.from}）碎裂消失了…` : `😶 強化無事，${x.itemName} 維持 +${x.from}`;
        await popup(cq, head, false);
        if (x.result === 'break') { await editMsg(chat.id, mid, `${head}\n\n${equipText(r)}`, equipKeyboard(r)); return { rpg: 'enhance', result: x.result }; }
        const it = r.equipment.find((e) => e.id === arg); await editMsg(chat.id, mid, `${head}\n\n${itemText(it, r.inventory)}`, itemKeyboard(it)); return { rpg: 'enhance', result: x.result };
      }
      case 'rX': case 'rr': {
        await answer(cq);const open=appBtn('🎲 打開裝備：重鑄／鎖定','bag');
        await editMsg(chat.id,mid,'🎲 詞條重鑄已改版\n品階、元素與強化完整保留。請在裝備畫面勾選鎖定詞條，確認完整工費與捲軸費用後再重洗。',[[...(open?[open]:[])],[btn('↩️ 裝備詳情',`ei:${arg}`)]]);return {rpg:'reroll-ui'};
      }
      case 'st': case 'ar': case 'ab': {
        let r;
        if (action === 'ar') r = await rpg(cq, '/rpg/settings', { tgId: tg, autoRedPct: Number(arg) });
        else if (action === 'ab') { const cur = await rpg(cq, '/rpg/me', { tgId: tg }); r = cur && await rpg(cq, '/rpg/settings', { tgId: tg, autoBlue: !cur.character.autoBlue }); }
        else r = await rpg(cq, '/rpg/me', { tgId: tg });
        if (!r) return null; await answer(cq);
        const c = r.character;
        await editMsg(chat.id, mid, `⚙️ 設定\nHP 低於 ${c.autoRedPct}% 自動喝紅水（太低容易被精英怪秒殺，建議 40–60%）\n自動喝藍水放技能：${c.autoBlue ? '開' : '關（只普攻，省水但效率 35%）'}`,
          [[30, 40, 50, 60, 70].map((n) => btn(`${n === c.autoRedPct ? '✅' : ''}${n}%`, `ar:${n}`)), [btn(`💙 自動藍水：${c.autoBlue ? '開' : '關'}`, 'ab')], back]);
        return { rpg: 'settings' };
      }
      case 'ad': case 'rs': {
        const r = await rpg(cq, '/rpg/me', { tgId: tg }); if (!r) return null; await answer(cq);
        const lines = [action === 'ad' ? `⬆️ 第${['一', '二', '三'][r.character.classTier] || ''}次轉職（需要「${r.gate.materialName}」×1，你有 ${r.gate.have}）` : `📖 命運轉職書：改走另一條路線（需要「命運轉職書 I」，商店 6,000；7 天冷卻；路線專屬武器會自動卸下，可免費轉換一次）\n目前：${r.character.className}`];
        for (const b of r.branches) lines.push('', `${b.branch} 線｜${b.name}（${b.line}）`, `技能：${b.skill.name}（耗魔 ${b.skill.cost}、${b.skill.targets} 個目標）`, `被動：${b.passive}`, b.tier === 2 ? `（${b.line}）` : `專屬武器：${b.weapon}`, b.blurb || '');
        const pick = action === 'ad' ? 'av' : 'rv';
        await editMsg(chat.id, mid, lines.join('\n'), [r.branches.map((b) => btn(`${b.branch}：${b.name}`, `${pick}:${b.branch}`)), back]); return { rpg: action };
      }
      case 'av': case 'rv': {
        const r = await rpg(cq, action === 'av' ? '/rpg/advance' : '/rpg/reselect', { tgId: tg, branch: arg, tier: 1, requestId: req }); if (!r) return { rpg: 'class-failed' };
        await answer(cq, '轉職完成'); await editMsg(chat.id, mid, mainText(r, `🎊 你現在是「${r.character.className}」！新技能：${r.stats.skill.name}。商店已經開放這條路線的專屬武器。`), mainKeyboard(r)); return { rpg: action };
      }
      case 'lg': {
        const r = await rpg(cq, '/rpg/ledger', { tgId: tg }); if (!r) return null; await answer(cq);
        const lines = ['📒 最近紀錄', ...r.ledger.map((l) => `${hm(l.created_at)} ${l.type}${l.gold_delta ? ` ${l.gold_delta > 0 ? '+' : ''}${fmt(l.gold_delta)} 金幣` : ''}${l.item && !String(l.item).startsWith('equip:') ? ` ${ITEM_NAME[l.item] || l.item}${l.item_delta > 0 ? '+' : ''}${l.item_delta}` : ''}${l.note && !l.note.startsWith('{') ? `（${l.note}）` : ''}`)];
        await editMsg(chat.id, mid, lines.join('\n'), [back]); return { rpg: 'ledger' };
      }
      default: await answer(cq); return { ignored: 'rpg action' };
    }
  }

  // ---------- group boss cards + outbox ----------
  async function renderCard(boss, force = false) {
    const cards = st().cards; let card = cards[boss.id];
    if (!card && boss.messageId) card = cards[boss.id] = { chatId: boss.messageChatId || chatId, messageId: boss.messageId, lastEdit: 0 };
    if (!card) return;
    if (!force && now() - (card.lastEdit || 0) < editThrottleMs) { dirty.set(boss.id, true); return; }
    const editCaption = () => api.call('editMessageCaption', { chat_id: card.chatId, message_id: card.messageId, caption: bossCaption(boss), reply_markup: { inline_keyboard: bossKeyboard(boss) } });
    try {
      if (card.photo) await editCaption();
      else {
        try { await editMsg(card.chatId, card.messageId, bossText(boss), bossKeyboard(boss)); }
        catch (error) {
          if (!/no text in (?:the )?message/i.test(String(error?.description || error?.message))) throw error;
          await editCaption(); card.photo = true;
        }
      }
    } catch (error) { if (!/not modified/i.test(String(error?.description || error?.message))) throw error; }
    card.lastEdit = now(); dirty.delete(boss.id); save();
  }
  async function deliver(item) {
    const p = item.payload || {};
    if(item.kind==='journal_card'&&item.target==='group'){
      const day=new Date(now()+8*3600e3).toISOString().slice(0,10);if(p.day!==day)return;
      const existing=await client.call('/rpg/journal/card',{day});if(existing.card?.message_id)return;
      const saved=st().journalCard;if(saved?.day===day){await client.call('/rpg/journal/message',{day,chatId:String(chatId),messageId:saved.messageId});return;}
      const caption=`📖 旅團日誌｜${day.slice(5).replace('-','／')}\n\n今天的相逢，也值得寫進故事。\n報到、為夥伴喝采、並肩打王、結伴尋寶、組隊爬塔、分享收穫——每日任選三項。\n\n📜 每項自選普通武器／防具強化卷，張數依今日固定階級。三項領完且完成合作戰鬥，再送一份同行贈禮。\n\n台北時間 00:00 換頁；獎勵在遊戲「神戰 → 旅團日誌」領取。`;
      const keyboard=[[btn('☀ 今日報到',`jc:${day}`),btn('📖 我的進度',`jv:${day}`)]];const link=deepLink('boss');if(link)keyboard.push([{text:'🎮 開啟旅誌',url:link}]);
      const m=app.url?await api.call('sendPhoto',{chat_id:chatId,photo:new URL('telegram-media/journal-cover-20261013.jpg',app.url).href,caption,reply_markup:{inline_keyboard:keyboard}}):await send(caption,{reply_markup:{inline_keyboard:keyboard}},chatId);
      if(!m?.message_id)throw new Error('旅誌卡未取得訊息編號');
      st().journalCard={day,messageId:m.message_id};save();await client.call('/rpg/journal/message',{day,chatId:String(chatId),messageId:m.message_id});return;
    }
    if(item.kind==='auto_enhance_end'&&item.target==='dm'&&item.tgId){
      const why={target:'✨ 願望成真，已達強化目標！',break:'💔 裝備在淬鍊中破碎了。',resources:'📜 卷軸或金幣不足，神匠暫停了淬鍊。',stopped:'✋ 已依你的指示停止強化。',party:'⚔️ 角色進入組隊戰鬥，強化已停止。',busy:'🔒 裝備狀態改變，強化已停止。',missing:'找不到裝備，強化已停止。'}[p.reason]||'強化已停止。';
      await send(`🔨 命運淬鍊・結果\n\n${why}\n「${p.itemName}」${p.reason==='break'?'已破碎':`目前 +${p.level}`}／目標 +${p.target}\n共強化 ${p.attempts} 次，消耗卷軸 ${p.spentScrolls} 張、補購金幣 ${fmt(p.spentGold)}。`,{reply_markup:{inline_keyboard:[[appBtn('🎮 查看裝備','bag')||btn('打開冒險','me')]]}},item.tgId);return;
    }
    if(await partyFlow.deliver(item))return;
    if (item.target === 'group') {
      if (item.kind === 'boss_spawn' && p.boss) {
        if (st().cards[p.boss.id] || p.boss.messageId) return;
        const buffer = typeof api.sendPhoto === 'function' ? bossCardBytes(p.boss) : null;
        const photo = Boolean(buffer);
        const m = photo
          ? await sendCardPhoto({ chatId, buffer, mimeType: 'image/png', fileName: `boss-${p.boss.mapId}.png`, caption: bossCaption(p.boss), replyMarkup: { inline_keyboard: bossKeyboard(p.boss) } })
          : await send(bossText(p.boss), { reply_markup: { inline_keyboard: bossKeyboard(p.boss) } }, chatId);
        if (m?.message_id) { st().cards[p.boss.id] = { chatId, messageId: m.message_id, photo, lastEdit: now() }; save(); await client.call('/rpg/boss/message', { bossId: p.boss.id, chatId, messageId: m.message_id }).catch((e) => warn('boss message', e)); }
        return;
      }
      if (item.kind === 'boss_update' && p.boss) { if (p.boss.status === 'active') await renderCard(p.boss, false); return; }   // Mini App attack → throttled card edit
      if (item.kind === 'boss_end' && p.boss) {
        await renderCard(p.boss, true);
        if (p.boss.status === 'killed') {
          const gearShare = p.boss.result?.gear?.share;
          if (gearShare) {
            const caption = shareCaption(gearShare).slice(0, 1024); const keyboard = shareKeyboard(gearShare);
            const buf = typeof api.sendPhoto === 'function' ? await cardBytes(gearShare.item?.photo) : null;
            let m = null; let photo = false;
            if (buf) {
              try {
                m = await sendCardPhoto({ chatId, buffer: buf, photoUrl:gearShare.item.photo, mimeType: 'image/jpeg', fileName: gearShare.item.photo.split('/').pop() || 'boss-gear.jpg', caption, replyMarkup: { inline_keyboard: keyboard } });
                photo = true;
              } catch (error) { warn('boss gear photo', error); }
            }
            if (!m) m = await send(caption, { reply_markup: { inline_keyboard: keyboard } }, chatId);
            const messageId = m?.message_id ?? m?.result?.message_id;
            if (messageId) {
              st().scards[gearShare.id] = { chatId, messageId, photo, lastEdit: 0, at: now() }; save();
              await client.call('/rpg/share/message', { shareId: gearShare.id, chatId, messageId }).catch((e) => warn('boss gear share message', e));
            }
          } else await send(bossText(p.boss), {}, chatId);
        }
        delete st().cards[p.boss.id]; save(); return;
      }
      if(item.kind==='guardian_sigil_obtained'){
        const sh=p.share,key=sh?.id||'guardian_'+(p.operationId||String(item.id)),known=st().scards[key]||sh?.messageId;if(known)return;
        const link=deepLink('guardian'),keyboard=sh?shareKeyboard(sh,{guardianLink:link}):link?[[{text:'✦ 我也來抽',url:link}]]:[],caption=guardianNoticeCaption(p,sh),type=sh?.item?.type||p.type;
        const art=app.url&&Object.hasOwn(GUARDIAN_TYPES,type)?new URL(`/art/guardian-sigil-20261013/${type}-share.jpg`,app.url):null;
        let m=null,photo=false;
        if(art&&art.protocol==='https:'){
          try{m=await api.call('sendPhoto',{chat_id:chatId,photo:art.href,caption,parse_mode:'HTML',reply_markup:{inline_keyboard:keyboard}},{retries429:0,timeoutMs:45000});photo=true;}
          catch(error){const code=Number(error?.errorCode||error?.httpStatus),photoRejected=error?.definite===true&&[400,404].includes(code)&&/photo|image|file(?:[_ ]id)?|failed to get http url content|wrong type of (?:the )?web page content/i.test(error?.description||'');if(!photoRejected)throw error;warn('guardian photo',error);}
        }
        if(!m)m=await send(caption,{parse_mode:'HTML',reply_markup:{inline_keyboard:keyboard}},chatId);
        const messageId=m?.message_id??m?.result?.message_id;if(!messageId)throw new Error('Telegram did not confirm guardian announcement '+key);
        st().scards[key]={chatId,messageId,photo,lastEdit:0,at:now()};save();
        if(sh)await client.call('/rpg/share/message',{shareId:sh.id,chatId,messageId}).catch(e=>warn('guardian share message',e));
        return;
      }
      if (item.kind === 'blessed_scroll') {
        const key='blessed_'+item.id;if(st().scards[key])return;
        const source=p.source==='boss'?`群組首領「${p.boss||'首領'}」`:`「${p.map||'冒險地圖'}」的菁英怪「${p.elite||p.monster||'菁英怪'}」`;
        const caption=`✨【祝福卷軸掉落】\n\n${p.name||'冒險者'} 擊敗${source}，金色光芒落入行囊！\n獲得「${p.itemName||'祝福強化卷軸'}」\n\n⚒ 強化成功率 +10 個百分點；可與其他玩家交易。`.slice(0,1024);
        const keyboard=[];const forge=deepLink('bag'),market=deepLink('shop');if(forge)keyboard.push([{text:'⚒ 前往強化',url:forge},...(market?[{text:'🤝 前往交易所',url:market}]:[])]);
        const kind=p.item==='blessed_scroll_a'||/防具/.test(p.itemName||'')?'armor':'weapon';
        const art=app.url?new URL('/art/blessed-announcement-20261014/'+kind+'.png',app.url):null;let m=null,photo=false;
        if(art&&art.protocol==='https:'){try{m=await api.call('sendPhoto',{chat_id:chatId,photo:art.href,caption,reply_markup:{inline_keyboard:keyboard}},{retries429:0,timeoutMs:45000});photo=true;}
          catch(error){const code=Number(error?.errorCode||error?.httpStatus),rejected=error?.definite===true&&[400,404].includes(code)&&/photo|image|file|failed to get http url content/i.test(error?.description||'');if(!rejected)throw error;warn('blessed photo',error);}}
        if(!m)m=await send(caption,{reply_markup:{inline_keyboard:keyboard}},chatId);
        const messageId=m?.message_id??m?.result?.message_id;if(!messageId)throw Error('Telegram did not confirm blessed announcement '+key);
        st().scards[key]={chatId,messageId,photo,lastEdit:0,at:now()};save();return;
      }
    if (item.kind === 'relic') {   // v0.4 rows still in the outbox after the upgrade (v0.5 sends 'share' photo posts instead)
        await send(`🏺 遺物出土！${p.name} 從「${p.source === 'boss' ? p.boss : p.elite}」${p.source === 'boss' ? '的戰利品' : '身上'}得到【${p.item}】（${p.slot}・${p.className}・T${p.tier}）`, {}, chatId); return;
      }
      if (item.kind === 'share' && p.share) {
        const q = st().pq;
        if (!st().scards[p.share.id] && !p.share.messageId && !q.some((x) => x.id === p.share.id)) {
          q.push(p.share); save();
        }
        return;
      }   // persist only new share events; retries must not create duplicate queue entries
      if (item.kind === 'share_update' && p.share) { await refreshShareCard(p.share, true); return; }
      if (item.kind === 'pk_card' && p.pk) { if (p.pk.status === 'pending') await renderPkCard(p.pk, { post: true }); return; }
      if ((item.kind === 'pk_update' || item.kind === 'pk_result') && p.pk) { await renderPkCard(p.pk); return; }
      if (item.kind === 'trade_completed' && p.tradeId) {
        const r = await client.call('/rpg/trade/get', { tradeId: p.tradeId });
        const t = r?.trade; if (!t || t.status !== 'done') return;
        const sent = (from, to) => {
          const parts = (from.lines || []).map((x) => x.kind === 'item' ? `${x.name} ×${fmt(x.qty)}` : `${x.enhance ? `+${x.enhance} ` : ''}${x.name}`);
          if (from.gold) parts.push(`💰${fmt(from.gold)}（對方實收 ${fmt(from.goldNet)}）`);
          return `${from.name} → ${to.name}：${parts.join('、') || '（未提供物品或金幣）'}`;
        };
        const at = new Date((t.closedAt || p.completedAt || now()) + TPE).toISOString().slice(0, 16).replace('T', ' ');
        await send(`🤝【交易完成】\n${sent(t.a, t.b)}\n${sent(t.b, t.a)}\n🕒 台灣時間：${at}`, {}, chatId); return;
      }
      if (item.kind === 'trade_update' || item.kind === 'trade_end') return;   // v0.4 group trade cards (retired)
      if (item.kind === 'enhance') {
        const txt = p.result === 'success' ? `✨ 恭喜 ${p.name} 把「${p.item}」強化到 +${p.to}！` : `💥 ${p.name} 的「+${p.from} ${p.item}」挑戰 +${p.from + 1} 失敗，裝備碎裂了…`;
        await send(txt, {}, chatId); return;
      }
      return;
    }
    const screen = item.kind === 'material' ? 'class' : item.kind === 'relic' ? 'bag' : item.kind === 'trade_request' ? `req_${p.requestId}` : /^trade_/.test(item.kind) && p.tradeId ? `trade_${p.tradeId}` : /^pk_/.test(item.kind) ? `pk_${p.pkId}` : item.kind === 'trade_rejected' ? 'trade' : '';
    const label = { trade_request: '🎮 確認／拒絕', trade_open: '🎮 打開交易視窗', trade_locked: '🎮 打開交易視窗', trade_ready: '🎮 按 OK', trade_end: '🎮 查看背包', pk_challenge: '🎮 決鬥畫面', pk_result: '🎮 決鬥紀錄' }[item.kind] || '🎮 打開冒險';
    let link = [[appBtn(label, screen) || btn('⚔️ 打開冒險', 'me')]];
    if (item.kind === 'trade_request' && !app.url) link = [[btn('✅ 確認開啟交易', `qa:${p.requestId}`), btn('✕ 婉拒', `qr:${p.requestId}`)]];
    const recipient=p.recipientCharId||item.tgId;
    const T = p.trade; const other = T ? (String(T.a.tgId) === String(recipient) ? T.b : T.a) : null; const P = p.pk; const pkOther = P ? (String(P.a.tgId) === String(recipient) ? P.b : P.a) : null;
    const reason = { penalty: `損失 EXP ${fmt(p.penalty)}（今天第 ${p.penaltiesToday}/3 次扣 EXP）`, ward: '🧿 守護符替你擋下了 EXP 損失', newbie: '新手保護（Lv10 以下）不扣 EXP', daily_cap: '今天已經扣滿 3 次，這次不扣 EXP' };
    const text = {
      death: `💀 你的角色在${p.map}被「${p.elite}」打倒了（Lv${p.level}）。${reason[p.reason] || ''}\n10 分鐘後自動復活繼續掛機。把喝紅水門檻調高、換更好的防具，或買守護符可以減少損失。`,
      town_no_red: '🏙️ 紅水用完了，角色回城休息，EXP 停止。按「🧪 一鍵補水」補貨後會自動出發。',
      gate: `🚪 Lv${p.level} 經驗已滿，要轉職才能繼續升級。群組首領每小時整點（01:00～07:59 休息）出現，打倒它拿轉職材料！`,
      low_supply: `⚠️ 水快用完了：紅水約 ${Math.round(p.redHours * 10) / 10} 小時、藍水約 ${Math.round(p.blueHours * 10) / 10} 小時。`,
      material: `🏅 你從「${p.boss}」拿到「${p.item}」！打開冒險選單就能轉職。`,
      relic: `🏺 你從「${p.source === 'boss' ? p.boss : p.elite}」得到遺物【${p.item}】（${p.slot}・${p.className}）！遺物比同階商店裝強約 25%，還多一條詞條。穿上後會綁定；沒穿過的遺物可以拿去交易。`,
      trade_request: `🤝 ${p.from} 想跟你交易【${p.item}】！打開遊戲按「確認」就會開啟交易視窗（或婉拒）；24 小時沒回應會自動取消。`,
      trade_open: other ? `🤝 ${other.name} 確認了你的交易請求，交易視窗開好了！放入要給的物品／金幣 → 🔒 鎖定 → 雙方按 OK 成交（${T.idleMinutes || 30} 分鐘沒動作會自動取消並退回）。` : null,
      trade_rejected: p.request ? `🤝 ${p.request.owner.name} 婉拒了你對【${p.request.item?.name || '裝備'}】的交易請求。` : '🤝 對方婉拒了你的交易請求。',
      trade_locked: other ? `🔒 ${other.name} 已經鎖定交易內容了。放好你要給的東西後按「🔒 鎖定」，之後雙方按 OK 就成交。` : null,
      trade_ready: other ? `✅ 你和 ${other.name} 都鎖定了！打開交易視窗確認內容，按「OK」完成交易。` : null,
      trade_end: other ? `🤝 你與 ${other.name} 的交易${T.status === 'done' ? '完成了！物品已經送到背包' : T.status === 'expired' ? '因為太久沒動作過期了，物品與金幣已退回' : '已取消，物品與金幣已退回'}` : null,
      pk_challenge: P ? `⚔️ ${pkOther.name}（Lv${pkOther.level}）向你發起決鬥！在群組的決鬥卡按「⚔️ 接受決鬥」或在遊戲裡接受（${Math.max(1, Math.ceil(P.secondsLeft / 60))} 分鐘內）。輸的人有 20% 機率掉 1 件身上的裝備（守護符可擋）。` : null,
      pk_declined: P ? `⚔️ ${P.b.name} 拒絕了你的決鬥。` : null,
      pk_result: P ? pkText(P) : null,
    }[item.kind];
    if (!text || !item.tgId) return;
    await send(text, { reply_markup: { inline_keyboard: link } }, item.tgId);
  }
  function currentSlot(t) { const d = new Date(t + TPE); const h = d.getUTCHours(); return BOSS_SLOTS.includes(h) && d.getUTCMinutes() < 30 ? `${d.toISOString().slice(0, 10)}-${h}` : null; }
  async function tick() {
    if (!client || ticking) return null; ticking = true;
    try {
      const t = now(); const out = { delivered: 0 };
      if (t - lastClaim >= outboxEveryMs) {
        lastClaim = t; const slot = currentSlot(t);
        const journalDate=new Date(t+8*3600e3).toISOString(),journalDay=journalDate.slice(0,10);
        if(journalDate.slice(11,16)>='08:00'&&st().journalChecked!==journalDay){const r=await client.call('/rpg/journal/publish',{}).catch(e=>warn('journal publish',e));if(r?.ok){st().journalChecked=journalDay;save();}}
        if (slot && st().spawnChecked !== slot) { const r = await client.call('/rpg/boss/spawn-due', {}).catch((e) => warn('spawn-due', e)); if (r) { st().spawnChecked = slot; save(); out.spawn = r.spawn; } }
        await client.call('/rpg/party/tick',{}).catch(e=>warn('party tick',e));
        const ob = await client.call('/rpg/outbox/claim', { limit: 20 }).catch((e) => warn('outbox', e));
        const deliveredIds = [];
        for (const item of ob?.items || []) { try { await deliver(item); out.delivered += 1;
          if(item.claimToken){try{await client.call('/rpg/outbox/ack',{ids:[item.id],claimToken:item.claimToken});}catch(error){warn('outbox item ack',error);deliveredIds.push(item.id);}}
        } catch (error) {
          warn(`deliver ${item.kind}`, error);
          if(item.claimToken)await client.call('/rpg/outbox/fail',{ids:[item.id],claimToken:item.claimToken,errorCode:Number(error.errorCode||error.httpStatus)||0,error:String(error.description||error.message||'通知傳送失敗'),retryAfterSeconds:Number(error.parameters?.retry_after)||0}).catch(e=>warn('outbox failure report',e));
        } }
        if (deliveredIds.length && ob?.items?.[0]?.claimToken) {
          try { await client.call('/rpg/outbox/ack', { ids: deliveredIds, claimToken: ob.items[0].claimToken }); }
          catch (error) { warn('outbox ack', error); }
        }
        for (const [id, c] of Object.entries(st().cards)) if (t - (c.lastEdit || 0) > 2 * 3600e3) { delete st().cards[id]; save(); }
        for (const [uid, d] of Object.entries(st().drafts)) if (t - (d.at || 0) > 24 * 3600e3) { delete st().drafts[uid]; save(); }
        for (const [id, c] of Object.entries(st().scards)) if (t - (c.at || c.lastEdit || 0) > 7 * 24 * 3600e3) { delete st().scards[id]; save(); }
        for (const [id, c] of Object.entries(st().pcards)) if (t - (c.at || 0) > 3600e3) { delete st().pcards[id]; save(); }
      }
      for (const id of [...dirty.keys()]) {
        const c = st().cards[id]; if (!c || now() - (c.lastEdit || 0) < editThrottleMs) continue;
        const r = await client.call('/rpg/boss/get', { bossId: id }).catch((e) => warn('boss get', e)); if (r?.boss) await renderCard(r.boss, true); else dirty.delete(id);
      }
      for (const id of [...sdirty.keys()]) {
        const c = st().scards[id]; if (!c) { sdirty.delete(id); continue; } if (now() - (c.lastEdit || 0) < likeThrottleMs) continue;
        const r = await client.call('/rpg/share/get', { shareId: id }).catch((e) => warn('share get', e)); if (r?.share) await refreshShareCard(r.share, true); else sdirty.delete(id);
      }
      await partyFlow.flush();
      out.photos = await flushPhotos().catch((e) => { warn('photos', e); return 0; });
      return out;
    } finally { ticking = false; }
  }

  return { enabled: Boolean(client), onMessage, onCallback, tick };
}


