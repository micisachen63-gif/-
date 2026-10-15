// Shared deterministic pet rules. No I/O or Telegram state in this module.
import crypto from 'node:crypto';

export const PRODUCTS = Object.freeze({
  yingma: { name: '贏麻了', wagerPerPoint: 1_000, theme: 'sparrow' },
  shuangbao: { name: '爽爆', wagerPerPoint: 100_000, theme: 'pixel' },
  qiezi: { name: '茄子', wagerPerPoint: 100_000, theme: 'eggplant' },
});
export const STONE_COSTS = Object.freeze([3, 5, 10]);
export const ITEM_COSTS = Object.freeze({ training: 2, food: 1, clean: 1, soap: 1, weapon_scroll: 3, armor_scroll: 2, reroll_scroll: 2, unbind_scroll: 3 });
export const MAX_GROWTH_PER_DAY = 100;
export const COMPLETE_GROWTH = 1_400;
export const REVIVE_COST = 10;
export const BOSS_DURATION_MS = 30 * 60_000;
export const ATTACK_COOLDOWN_MS = 5 * 60_000;

export const COMPLETE_VARIANTS = Object.freeze({
  yingma: [
    { title: '雷霆聖裁', attr: 'thunder', color: '#fbbf24', trait: '⚡【神聖暴擊】對戰與討伐傷害額外 +15%', bonusAtk: 15, desc: '掌控奧林匹斯狂暴雷霆的執法雀鳥，羽翼翻騰金芒雷暴！' },
    { title: '太陽輝耀', attr: 'solar', color: '#f59e0b', trait: '☀️【太陽庇護】每日飽食與清潔消耗速度減半', bonusAtk: 12, desc: '披掛阿波羅純金桂冠的烈陽聖鳥，光芒普照全服！' },
    { title: '疾風狂嵐', attr: 'wind', color: '#34d399', trait: '🌪️【疾風連擊】BOSS 討伐冷卻時間縮短為 3 分鐘', bonusAtk: 10, desc: '穿梭狂風峽谷的敏捷雀鳥，身形神速難以捉摸！' },
    { title: '幽冥冥凰', attr: 'void', color: '#a855f7', trait: '🌌【暗黑涅槃】戰力爆發上限提升，對戰有 20% 機率直接制勝', bonusAtk: 18, desc: '汲取冥府幽光的涅槃神鳥，雙眸散發威嚴紫炎！' },
    { title: '星界熾天使', attr: 'seraph', color: '#e0e7ff', trait: '✨【星芒聖歌】群組玩耍時雙方額外獲贈 1 顆進化石', bonusAtk: 14, desc: '星界六翼熾天使，流星光雨伴隨左右！' },
    { title: '大地泰坦', attr: 'terra', color: '#d97706', trait: '🗿【蓋亞磐石】基礎防禦大幅提升，PVP對決平局直接判定獲勝', bonusAtk: 11, desc: '蓋亞大地神力結晶，玄黃岩鎧堅不可摧！' },
    { title: '海神狂濤', attr: 'ocean', color: '#06b6d4', trait: '🌊【怒濤海嘯】攻擊時有機率引發狂濤，連續攻擊 2 次', bonusAtk: 16, desc: '碧藍深海潮汐神力，掀起千丈滔天巨浪！' },
    { title: '戰神阿瑞斯', attr: 'ares', color: '#ef4444', trait: '⚔️【戰意沸騰】生命越低時攻擊力越強，狂化傷害最高 +50%', bonusAtk: 17, desc: '嗜血狂暴戰狂之羽，戰意沸騰破甲千鈞！' },
    { title: '智慧雅典娜', attr: 'aegis', color: '#38bdf8', trait: '🛡️【聖盾守護】討伐 BOSS 時免受反震，每次攻擊必得最高傷害', bonusAtk: 13, desc: '勝利女神聖盾守護，神聖防壁無懈可擊！' },
    { title: '命運織天', attr: 'fate', color: '#ec4899', trait: '🔮【命運之線】洞悉命運軌跡，戰鬥力 +14', bonusAtk: 14, desc: '執掌命運金線的裁決神鳥，洞悉萬物興衰！' },
  ],
  shuangbao: [
    { title: '量子超頻', attr: 'cyber', color: '#10b981', trait: '💻【極速超頻】對戰與討伐傷害額外 +15%', bonusAtk: 16, desc: '運算核心突破光速的超頻數碼獸，全身流淌量子代碼！' },
    { title: '重裝泰坦', attr: 'armor', color: '#60a5fa', trait: '🛡️【奈米裝甲】對戰受到傷害減免 30%，堅不可摧', bonusAtk: 10, desc: '覆蓋高分子合金重裝甲的巨壁數碼獸，防禦冠絕全服！' },
    { title: '電漿離子', attr: 'plasma', color: '#38bdf8', trait: '⚡【離子風暴】討伐 BOSS 每回合額外附帶電漿濺射傷害', bonusAtk: 14, desc: '蓄積百萬伏特高能離子的電子怪獸，隨時引爆粒子風暴！' },
    { title: '暗網零號', attr: 'virus', color: '#f43f5e', trait: '👾【毀滅代碼】攻擊力隨機波動最高可達 200% 暴擊', bonusAtk: 18, desc: '自深層暗網覺醒的神秘代碼實體，充斥禁忌破壞能量！' },
    { title: '矩陣先鋒', attr: 'matrix', color: '#22c55e', trait: '🌐【代碼洪流】每日第一次訓練獲得雙倍成長值 (+200)', bonusAtk: 12, desc: '綠色代碼流瀑布護體，穿梭數位虛擬空間！' },
    { title: '光子超光速', attr: 'photon', color: '#facc15', trait: '🚀【光速打擊】PVP 必定先手發動攻擊', bonusAtk: 15, desc: '聚變推進光子引擎，突破次元的光速突襲！' },
    { title: '神經網絡', attr: 'neural', color: '#c084fc', trait: '🧠【深度預判】預測對手行動，對戰勝率大幅提升', bonusAtk: 13, desc: '自我進化超級 AI 矩陣，預判千步之外！' },
    { title: '電磁脈衝', attr: 'emp', color: '#0ea5e9', trait: '🧲【脈衝癱瘓】攻擊有 25% 機率直接癱瘓對手該回合動作', bonusAtk: 14, desc: '強力電磁脈衝震波，癱瘓敵方一切護盾！' },
    { title: '全息幻影', attr: 'mirage', color: '#e879f9', trait: '🔮【量子分身】受到致命攻擊時有一次金蟬脫殼免死效果', bonusAtk: 12, desc: '高解析立體全息投影，千重分身難辨真偽！' },
    { title: '超弦重力', attr: 'gravity', color: '#6366f1', trait: '🕳️【微型黑洞】吸附周圍能量，每日自動產出 1 點寵物點數', bonusAtk: 17, desc: '引力奇點壓縮空間，釋放黑洞引力波！' },
  ],
  qiezi: [
    { title: '至尊骰王', attr: 'casino', color: '#fbbf24', trait: '🎲【黃金六點】對戰與討伐必定擲出最大傷害加成', bonusAtk: 15, desc: '掌管命運骰盤的至尊骰王茄子，金光骰子百戰百勝！' },
    { title: '極光帝皇', attr: 'royal', color: '#c084fc', trait: '👑【帝王福澤】玩耍與互動獲得點數雙倍機率', bonusAtk: 12, desc: '頭戴繁星極光帝冠的茄子大帝，尊貴無比，福運綿長！' },
    { title: '星象占星', attr: 'mystic', color: '#818cf8', trait: '🔮【逆天改命】洞察星辰命運，戰鬥力 +14', bonusAtk: 14, desc: '洞察星辰命運的占星茄子，水晶球中浮現未來勝利！' },
    { title: '混沌小丑', attr: 'joker', color: '#f43f5e', trait: '🃏【戲謔萬象】隨機觸發戲劇性效果，爆發力無人能測', bonusAtk: 18, desc: '以歡笑與混沌為食的神秘魔術茄子，總在絕境翻盤！' },
    { title: '招財聚寶', attr: 'wealth', color: '#eab308', trait: '💰【聚寶金庫】每日首次登入額外贈送 1 顆飼料與 1 清潔用品', bonusAtk: 11, desc: '肚內乾坤滿載元寶金幣，聚寶金光照耀四方！' },
    { title: '幸運錦鯉', attr: 'koi', color: '#fb923c', trait: '🎏【錦鯉附體】打碼換點滿額時有 10% 機率直接雙倍返點', bonusAtk: 13, desc: '氣運沖天的錦鯉附體，百倍好運連環爆發！' },
    { title: '時間沙漏', attr: 'chronos', color: '#a78bfa', trait: '⏳【時光逆流】即使多日未打理，瀕危安全期延長 3 天', bonusAtk: 12, desc: '掌控時間沙漏的秘術茄子，扭轉戰局時光！' },
    { title: '皇家同花順', attr: 'cards', color: '#f43f5e', trait: '♠️【皇家通殺】對戰第 3 回合必定造成雙倍暴擊打擊', bonusAtk: 16, desc: '雙手飛舞撲克同花順，出牌即是通殺絕殺！' },
    { title: '深淵魔術', attr: 'magic', color: '#475569', trait: '🎩【幻影移形】BOSS 討伐傷害額外增加 15%', bonusAtk: 15, desc: '神秘黑禮帽與白鴿幻術，變幻莫測無影蹤！' },
    { title: '豐饒之神', attr: 'abundance', color: '#10b981', trait: '🍇【豐收賜福】心情值永久維持在 90% 以上', bonusAtk: 13, desc: '大地豐收與富饒象徵，生機盎然福澤無限！' },
  ],
});

export const EVOLUTION_POOLS = Object.freeze({
  1: [
    { title: '★【破曉】', trait: '🌅 破曉初生：晨曦初芒，戰鬥力 +8', bonusAtk: 8 },
    { title: '★【真·覺醒】', trait: '✨ 本源覺醒：徹底激發潛在天賦，戰鬥力 +10', bonusAtk: 10 },
    { title: '★【狂暴】', trait: '🔥 怒氣爆發：狂怒戰意，暴擊傷害 +15%，戰鬥力 +12', bonusAtk: 12 },
    { title: '★【靈動】', trait: '🍃 疾速身法：身法如風，戰鬥力 +7', bonusAtk: 7 },
    { title: '★【聖光】', trait: '🕊️ 聖光賜福：受到神性照耀，戰鬥力 +9', bonusAtk: 9 },
    { title: '★【鐵壁】', trait: '🛡️ 銅牆鐵壁：飽食與清潔損耗速度減緩，戰鬥力 +8', bonusAtk: 8 },
    { title: '★【聚能】', trait: '⚡ 能量聚焦：核心能量充盈，戰鬥力 +10', bonusAtk: 10 },
    { title: '★【幸運】', trait: '🍀 幸運微光：玩耍額外收穫好心情，戰鬥力 +8', bonusAtk: 8 },
    { title: '★【熾熱】', trait: '🌋 烈火灼燒：攻擊附帶真傷灼燒，戰鬥力 +11', bonusAtk: 11 },
    { title: '★【幻影】', trait: '👥 虛幻幻象：對戰有一定機率閃避攻擊，戰鬥力 +9', bonusAtk: 9 },
  ],
  2: [
    { title: '★★【極·超凡】', trait: '🌟 超凡入聖：境界超脫凡俗，戰鬥力 +16', bonusAtk: 16 },
    { title: '★★【霸者】', trait: '👑 霸氣凌霄：威壓全場震撼對手，戰鬥力 +18', bonusAtk: 18 },
    { title: '★★【天尊】', trait: '☯️ 乾坤天尊：大道至簡攻防兼備，戰鬥力 +15', bonusAtk: 15 },
    { title: '★★【弒神】', trait: '⚔️ 弒神之刃：突破極限的毀滅輸出，戰鬥力 +20', bonusAtk: 20 },
    { title: '★★【不滅】', trait: '💖 永恆生機：生命力大幅增強，戰鬥力 +15', bonusAtk: 15 },
    { title: '★★【星辰】', trait: '🌠 九天星辰：引導九天星河神力，戰鬥力 +17', bonusAtk: 17 },
    { title: '★★【混沌】', trait: '🌀 混沌原力：隨機爆發驚人混亂傷害，戰鬥力 +19', bonusAtk: 19 },
    { title: '★★【神威】', trait: '⚡ 天地神威：震懾群魔傷害倍增，戰鬥力 +17', bonusAtk: 17 },
    { title: '★★【輝夜】', trait: '🌙 幽月冷輝：夜幕降臨暗殺暴擊倍增，戰鬥力 +16', bonusAtk: 16 },
    { title: '★★【傲世】', trait: '🦁 傲視群雄：PVP對決傷害額外加深，戰鬥力 +18', bonusAtk: 18 },
  ],
  3: [
    { title: '★★★【究極神話】', trait: '🌌 萬界之巔：登峰造極的究極神話，戰鬥力 +26', bonusAtk: 26 },
    { title: '★★★【創世之柱】', trait: '🪐 開天闢地：創世神明無上本源，戰鬥力 +28', bonusAtk: 28 },
    { title: '★★★【湮滅終焉】', trait: '💥 宇宙終焉：終結一切的湮滅之力，戰鬥力 +30', bonusAtk: 30 },
    { title: '★★★【永恆至尊】', trait: '💎 亙古不朽：跨越時間長河的至尊，戰鬥力 +26', bonusAtk: 26 },
    { title: '★★★【全知全能】', trait: '👁️ 全知真理：洞徹宇宙一切奧秘法則，戰鬥力 +27', bonusAtk: 27 },
    { title: '★★★【萬法無上】', trait: '🔯 萬法歸宗：諸神退避萬法不侵，戰鬥力 +28', bonusAtk: 28 },
    { title: '★★★【虛空帝主】', trait: '🕳️ 次元主宰：執掌虛無維度的主宰，戰鬥力 +30', bonusAtk: 30 },
    { title: '★★★【天命主宰】', trait: '🔮 乾坤號令：乾坤律令唯我獨尊，戰鬥力 +29', bonusAtk: 29 },
    { title: '★★★【無限超神】', trait: '⚡ 破格降維：超越維度界限的無極超神，戰鬥力 +32', bonusAtk: 32 },
    { title: '★★★【宇宙奇點】', trait: '🌟 奇點重生：凝縮千億超新星的宇宙奇點，戰鬥力 +30', bonusAtk: 30 },
  ],
});

export const ELEMENTS = Object.freeze({
  earth: { key: 'earth', name: '地', icon: '🌍', color: '#d97706' },
  water: { key: 'water', name: '水', icon: '🌊', color: '#0ea5e9' },
  fire: { key: 'fire', name: '火', icon: '🔥', color: '#ef4444' },
  wind: { key: 'wind', name: '風', icon: '🌪️', color: '#10b981' },
  light: { key: 'light', name: '光', icon: '☀️', color: '#f59e0b' },
  dark: { key: 'dark', name: '暗', icon: '🌑', color: '#8b5cf6' },
});

export const ELEMENT_KEYS = Object.freeze(['earth', 'water', 'fire', 'wind', 'light', 'dark']);

export const ELEMENT_TIERS = Object.freeze({
  common: { key: 'common', name: '一般', color: '#9ca3af', multiplier: 1.0, weight: 50 },
  advanced: { key: 'advanced', name: '高級', color: '#22c55e', multiplier: 1.25, weight: 30 },
  epic: { key: 'epic', name: '極品', color: '#3b82f6', multiplier: 1.5, weight: 13 },
  legendary: { key: 'legendary', name: '傳說', color: '#a855f7', multiplier: 1.85, weight: 5 },
  supreme: { key: 'supreme', name: '霸主', color: '#f59e0b', multiplier: 2.3, weight: 2 },
});

export const SAFE_LEVELS = Object.freeze({
  weapon: 6,
  helmet: 4,
  armor: 4,
  gloves: 4,
  boots: 4,
});

export const EQUIP_TYPES = Object.freeze({
  weapon: { name: '武器', slotName: '武器', statName: '攻擊力', safe: 6 },
  helmet: { name: '頭盔', slotName: '防具', statName: '防禦力', safe: 4 },
  armor: { name: '盔甲', slotName: '防具', statName: '防禦力', safe: 4 },
  gloves: { name: '手套', slotName: '防具', statName: '防禦力', safe: 4 },
  boots: { name: '靴子', slotName: '防具', statName: '防禦力', safe: 4 },
});

export const EQUIP_TEMPLATES = Object.freeze({
  weapon: { name: '武士刀', baseStatFixed: 10, baseStatMin: 8, baseStatMax: 15, cost: 5 },
  helmet: { name: '精鋼頭盔', baseStatFixed: 4, baseStatMin: 3, baseStatMax: 6, cost: 3 },
  armor: { name: '龍麟盔甲', baseStatFixed: 7, baseStatMin: 5, baseStatMax: 10, cost: 4 },
  gloves: { name: '神威手套', baseStatFixed: 3, baseStatMin: 2, baseStatMax: 5, cost: 2 },
  boots: { name: '疾風戰靴', baseStatFixed: 3, baseStatMin: 2, baseStatMax: 5, cost: 2 },
});

export const DUNGEON_EQUIP_NAMES = Object.freeze({
  yingma: {
    weapon: ['破曉光耀神劍', '雅典娜聖光劍', '太陽神金輝巨劍', '宙斯雷霆神刃'],
    helmet: ['泰坦金耀戰盔', '眾神之目光冕', '奧林帕斯神冕'],
    armor: ['阿波羅光耀重鎧', '宙斯庇護胸甲', '泰坦神聖金甲'],
    gloves: ['赫拉克勒斯神拳手套', '勝利女神護腕', '光輝審判手套'],
    boots: ['赫爾墨斯逐日戰靴', '曙光神速戰靴', '奧林帕斯飛羽履'],
  },
  shuangbao: {
    weapon: ['離子脈衝光刃', '超頻雷射巨劍', '賽博高頻震盪刀', '量子撕裂者'],
    helmet: ['霓虹全息戰術盔', '神經網絡光學鏡', '賽博矩陣面罩'],
    armor: ['奈米碳纖維外骨骼甲', '零式量子防護服', '電漿護盾動力甲'],
    gloves: ['狂暴超導戰鬥手套', '電磁力場指虎', '賽博脈衝握爪'],
    boots: ['光速躍遷反重力靴', '賽博朋克超導靴', '磁浮噴射行者'],
  },
  qiezi: {
    weapon: ['紫晶王權誓約劍', '翡翠帝國權杖', '秘銀皇家刺劍', '曜石斬魂刃'],
    helmet: ['翡翠璀璨皇冠', '皇家紫羅蘭冠冕', '秘銀鑲寶頭飾'],
    armor: ['帝國皇家秘銀重鎧', '紫晶守護戰甲', '貴族寶石戰袍'],
    gloves: ['翡翠絲絨魔導手套', '皇家紫金護腕', '璀璨寶石護手'],
    boots: ['疾影紫晶長靴', '帝王金邊巡遊靴', '皇家秘銀行靴'],
  },
});

export const SCROLL_METADATA = Object.freeze({
  weapon_scroll: {
    key: 'weapon_scroll',
    name: '武器強化卷軸',
    desc: '大幅提升武器攻擊力與元素傷害',
    attr: '破壞之力',
    rating: {
      score: 70,
      grade: 'A',
      title: '【A 珍品卷軸】⚔️',
      badge: 'A級珍品',
      color: '#10b981',
    },
  },
  armor_scroll: {
    key: 'armor_scroll',
    name: '防具強化卷軸',
    desc: '顯著提升防具防禦力與元素抗性',
    attr: '守護之壁',
    rating: {
      score: 60,
      grade: 'B',
      title: '【B 實用卷軸】🛡️',
      badge: 'B級實用',
      color: '#06b6d4',
    },
  },
  reroll_scroll: {
    key: 'reroll_scroll',
    name: '屬性洗練卷軸',
    desc: '重置裝備之元素屬性與數值加成',
    attr: '秘術共鳴',
    rating: {
      score: 88,
      grade: 'S',
      title: '【S 稀世秘卷】💎',
      badge: 'S級秘卷',
      color: '#3b82f6',
    },
  },
});

export const SCROLL_COSTS = Object.freeze({
  weapon_scroll: 3,
  armor_scroll: 2,
  reroll_scroll: 2,
});

export const BOSS_ELEMENT_DATA = Object.freeze({
  earth: { name: '遠古地脈魔靈', title: '🌍【地】遠古地脈魔靈', desc: '撼動大地的深層岩魔，堅如磐石！', image: 'boss/boss-earth.png' },
  water: { name: '九幽滄浪海皇', title: '🌊【水】九幽滄浪海皇', desc: '操縱無盡怒濤的深淵巨獸，浪潮滔天！', image: 'boss/boss-water.png' },
  fire: { name: '煉獄烈焰巨蜥', title: '🔥【火】煉獄烈焰巨蜥', desc: '自深淵熔岩甦醒的火魔，焚盡萬物！', image: 'boss/boss-fire.png' },
  wind: { name: '疾風狂嵐天鵬', title: '🌪️【風】疾風狂嵐天鵬', desc: '撕裂長空的狂暴風靈，神速莫測！', image: 'boss/boss-wind.png' },
  light: { name: '破曉聖芒巨像', title: '☀️【光】破曉聖芒巨像', desc: '神聖熾光的古老守衛，聖芒普照！', image: 'boss/boss-light.png' },
  dark: { name: '虛空暗夜領主', title: '🌑【暗】虛空暗夜領主', desc: '吞噬一切光明的虛空主宰，暗夜降臨！', image: 'boss/boss-dark.png' },
});

export function randomBossElement(random = Math.random) {
  const elements = ['earth', 'water', 'fire', 'wind', 'light', 'dark'];
  return elements[Math.floor(random() * elements.length)];
}

export function elementMultiplier(atkElement, defElement) {
  if (!atkElement || !defElement) return 1.0;
  if (atkElement === defElement) return 1.0;
  const cycleCounters = {
    water: 'fire',
    fire: 'wind',
    wind: 'earth',
    earth: 'water',
  };
  if (cycleCounters[atkElement] === defElement) return 1.25;
  if (cycleCounters[defElement] === atkElement) return 0.85;
  if ((atkElement === 'light' && defElement === 'dark') || (atkElement === 'dark' && defElement === 'light')) {
    return 1.20;
  }
  return 1.0;
}

/** Combine elemental defense from every armor slot, weighted by each piece's effective elemental stat. */
export function armorElementMultiplier(atkElement, armors = []) {
  const weighted = (armors || [])
    .filter((item) => item && item.equip_type !== 'weapon' && item.element)
    .map((item) => ({
      multiplier: elementMultiplier(atkElement, item.element),
      weight: Math.max(0, calcEquipmentStat(item).totalElem),
    }))
    .filter((item) => item.weight > 0);
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (!totalWeight) return 1;
  return weighted.reduce((sum, item) => sum + item.multiplier * item.weight, 0) / totalWeight;
}

export function rollEquipmentTier(random = Math.random) {
  const r = random() * 100;
  if (r < 50) return 'common';
  if (r < 80) return 'advanced';
  if (r < 93) return 'epic';
  if (r < 98) return 'legendary';
  return 'supreme';
}

export function formatEquipmentName(equip) {
  const tierName = ELEMENT_TIERS[equip.element_tier]?.name || '一般';
  const plus = equip.enhance_level > 0 ? `+${equip.enhance_level} ` : '';
  return `${plus}${equip.name} (${tierName})`;
}

export function getEquipmentEnhanceBonus(type, level) {
  if (level <= 0) return 0;
  const isWeapon = type === 'weapon';
  const safe = isWeapon ? 6 : 4;
  let bonus = 0;
  const safeStep = isWeapon ? 2 : 1;
  const inSafe = Math.min(level, safe);
  bonus += inSafe * safeStep;

  if (level > safe) {
    const extra = level - safe;
    for (let i = 1; i <= extra; i++) {
      if (isWeapon) {
        if (i === 1) bonus += 5;
        else if (i === 2) bonus += 8;
        else if (i === 3) bonus += 12;
        else if (i === 4) bonus += 18;
        else bonus += 25;
      } else {
        if (i === 1) bonus += 3;
        else if (i === 2) bonus += 5;
        else if (i === 3) bonus += 8;
        else if (i === 4) bonus += 12;
        else bonus += 18;
      }
    }
  }
  return bonus;
}

export function calcEquipmentStat(equip) {
  const mult = ELEMENT_TIERS[equip.element_tier]?.multiplier || 1.0;
  const enhanceBonus = getEquipmentEnhanceBonus(equip.equip_type, equip.enhance_level);
  const totalBase = Math.round((equip.base_stat + enhanceBonus) * mult);
  const totalElem = Math.round((equip.element_stat + Math.floor(enhanceBonus * 0.5)) * mult);
  return { totalBase, totalElem };
}

/** Evaluate equipment overall power, rating, tier badge, and numerical gear score (0-100) */
export function evaluateGearRating(equip) {
  if (!equip) return { score: 0, grade: 'C', title: '【C 普通鍛造】', badge: '普通', color: '#94a3b8' };

  const slotMultiplier = {
    weapon: 2.2,
    armor: 3.2,
    helmet: 4.5,
    gloves: 5.5,
    boots: 5.5,
  }[equip.equip_type] || 3.0;

  const tierBonus = {
    common: 5,
    advanced: 15,
    epic: 30,
    legendary: 50,
    supreme: 75,
  }[equip.element_tier] || 5;

  const rawScore = (equip.base_stat * slotMultiplier * 0.7) + (equip.element_stat * 3.0) + (tierBonus * 0.5);
  const score = Math.min(100, Math.max(10, Math.round(rawScore)));

  let grade = 'C';
  let title = '【C 普通鍛造】';
  let badge = 'C級普通';
  let color = '#94a3b8';

  if (score >= 88 || equip.element_tier === 'supreme') {
    grade = 'SSS';
    title = '【SSS 神話極品】🌟';
    badge = 'SSS神話';
    color = '#f59e0b';
  } else if (score >= 75 || equip.element_tier === 'legendary') {
    grade = 'SS';
    title = '【SS 傳說神裝】👑';
    badge = 'SS傳說';
    color = '#a855f7';
  } else if (score >= 60 || equip.element_tier === 'epic') {
    grade = 'S';
    title = '【S 稀世極品】💎';
    badge = 'S級極品';
    color = '#3b82f6';
  } else if (score >= 45 || equip.element_tier === 'advanced') {
    grade = 'A';
    title = '【A 卓越稀有】🔮';
    badge = 'A級卓越';
    color = '#10b981';
  } else if (score >= 30) {
    grade = 'B';
    title = '【B 精良精鋼】⚔️';
    badge = 'B級精良';
    color = '#06b6d4';
  }

  return { score, grade, title, badge, color };
}

/** Generate a dungeon exploration drop (50% randomized equipment, 50% scroll) */
export function generateDungeonDrop({ product = 'yingma', random = Math.random } = {}) {
  const isScroll = random() < 0.50;
  if (isScroll) {
    const scrollRoll = random();
    let scrollKey = 'armor_scroll';
    if (scrollRoll < 0.40) scrollKey = 'weapon_scroll';
    else if (scrollRoll < 0.80) scrollKey = 'armor_scroll';
    else scrollKey = 'reroll_scroll';
    const meta = SCROLL_METADATA[scrollKey];
    return {
      dropType: 'scroll',
      itemKey: scrollKey,
      itemName: meta.name,
      statDesc: meta.desc,
      elementDesc: meta.attr,
      gearRating: meta.rating,
      product,
    };
  }

  // Equipment Drop (Random stats & element & tier)
  const types = ['weapon', 'helmet', 'armor', 'gloves', 'boots'];
  const equipType = types[Math.floor(random() * types.length)];
  const prodNames = DUNGEON_EQUIP_NAMES[product] || DUNGEON_EQUIP_NAMES.yingma;
  const nameList = prodNames[equipType] || [EQUIP_TEMPLATES[equipType].name];
  const name = nameList[Math.floor(random() * nameList.length)];

  let baseStatMin = 2, baseStatMax = 10;
  if (equipType === 'weapon') { baseStatMin = 8; baseStatMax = 25; }
  else if (equipType === 'armor') { baseStatMin = 5; baseStatMax = 18; }
  else if (equipType === 'helmet') { baseStatMin = 3; baseStatMax = 12; }
  else if (equipType === 'gloves') { baseStatMin = 2; baseStatMax = 10; }
  else if (equipType === 'boots') { baseStatMin = 2; baseStatMax = 10; }

  const baseStat = baseStatMin + Math.floor(random() * (baseStatMax - baseStatMin + 1));
  const elementKeys = ['earth', 'water', 'fire', 'wind', 'light', 'dark'];
  const element = elementKeys[Math.floor(random() * elementKeys.length)];
  const elementTier = rollEquipmentTier(random);
  const tierMult = ELEMENT_TIERS[elementTier]?.multiplier || 1.0;
  const elementStat = Math.max(1, Math.round(baseStat * 0.35 * tierMult));

  const equip = {
    equip_type: equipType,
    name,
    enhance_level: 0,
    element,
    element_tier: elementTier,
    base_stat: baseStat,
    element_stat: elementStat,
  };

  const gearRating = evaluateGearRating(equip);
  const statName = equipType === 'weapon' ? '攻擊力' : '防禦力';
  const elemName = ELEMENTS[element]?.name || element;
  const tierName = ELEMENT_TIERS[elementTier]?.name || '一般';

  return {
    dropType: 'equipment',
    itemKey: equipType,
    itemName: name,
    equipType,
    baseStat,
    statName,
    statDesc: `基礎${statName} +${baseStat}`,
    element,
    elementTier,
    elementStat,
    elementDesc: `${elemName}屬性 (加成 +${elementStat}，${tierName})`,
    gearRating,
    equip,
    product,
  };
}

export function tryEnhanceEquipment(equip, roll = Math.random()) {
  const safe = SAFE_LEVELS[equip.equip_type] || 4;
  if (equip.enhance_level < safe) {
    if (roll < 0.5) return { success: true, broken: false, level: equip.enhance_level + 1 };
    return { success: false, broken: false, level: equip.enhance_level };
  }
  if (roll < 0.33) return { success: true, broken: false, level: equip.enhance_level + 1 };
  if (roll < 0.67) return { success: false, broken: false, level: equip.enhance_level };
  return { success: false, broken: true, level: equip.enhance_level };
}

export function formatPetName(product, pet, defaultPlayerName = '') {
  const baseNames = { yingma: '神鳥麻雀', shuangbao: '電子數碼獸', qiezi: '皇冠茄子' };
  const icons = { yingma: '🦅', shuangbao: '👾', qiezi: '🍆' };
  const baseName = baseNames[product] || '專屬精靈';
  const icon = icons[product] || '🐾';
  const nick = pet?.platformNickname || pet?.platform_nickname || pet?.nickname || defaultPlayerName || '';
  if (!pet) return `${icon} ${baseName}`;

  if (pet.stage === 'complete') {
    const evoStr = pet.evoTitle ? `${pet.evoTitle} ` : (pet.evolution > 0 ? '★'.repeat(pet.evolution) + ' ' : '');
    const variantStr = pet.variantTitle ? `【${pet.variantTitle}】` : '【完全體】';
    return nick ? `${icon} ${nick} 的 ${evoStr}${variantStr}${baseName}` : `${icon} ${evoStr}${variantStr}${baseName}`;
  }
  return nick ? `${icon} ${nick} 的 ${baseName}` : `${icon} ${baseName}`;
}

export function taipeiDay(at = Date.now()) {
  return new Date(at + 8 * 60 * 60_000).toISOString().slice(0, 10);
}
export function dayNumber(day) {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}
export function daysBetween(a, b) {
  return dayNumber(b) - dayNumber(a);
}
export function stageFor(growth) {
  if (growth >= COMPLETE_GROWTH) return 'complete';
  if (growth >= 700) return 'mature';
  if (growth >= 300) return 'growing';
  return 'young';
}
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(value)));

function ensureAccount(account) {
  if (!account || !PRODUCTS[account.product]) throw new Error('找不到寵物');
  return account;
}
function assertAlive(account) {
  if (account.pet.life !== 'alive') throw new Error('寵物已死亡，請先復活或重新養成');
}
function normalizeItem(item) {
  return item === 'soap' ? 'clean' : item;
}

export function openPet({ product, tgId, aid, baseline, at = Date.now() }) {
  if (!PRODUCTS[product]) throw new Error('未知產品');
  if (!/^\d{4,15}$/.test(String(aid))) throw new Error('AID 格式不正確');
  if (!Number.isFinite(Number(baseline)) || Number(baseline) < 0) throw new Error('無法取得有效打碼起點');
  const day = taipeiDay(at);
  return {
    product,
    tgId: String(tgId),
    aid: String(aid),
    openedAt: at,
    openedDay: day,
    points: 0,
    stones: 0,
    wagerRemainder: 0,
    wagerCheckpoints: { [day]: Number(baseline) },
    wagerPointTotal: 0,
    playPointTotal: 0,
    inventory: { training: 0, food: 0, clean: 0 },
    pet: {
      life: 'alive',
      growth: 0,
      stage: 'young',
      evolution: 0,
      attack: 10,
      food: 80,
      clean: 80,
      mood: 80,
      lastCareDay: day,
      lastStatusDay: day,
      lastTrainingDay: null,
      lastPlayDay: null,
      lastDailyBonusDay: null,
      lastLoginBonusDay: null,
      seasonPoints: 100,
      seasonBadges: 0,
      rebirths: 0,
      deaths: 0,
    },
    pvp: { wins: 0, losses: 0, pvpToday: {} },
  };
}

/** Credit only positive changes to each day's confirmed backend total. */
export function creditWager(account, { day, total }) {
  ensureAccount(account);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < account.openedDay) throw new Error('打碼日期早於寵物開啟日');
  const value = Number(total);
  if (!Number.isFinite(value) || value < 0) throw new Error('打碼資料無效');
  const old = account.wagerCheckpoints[day] ?? 0;
  if (value <= old) return { awarded: 0, delta: 0, checkpoint: old, remainder: account.wagerRemainder };
  const delta = value - old;
  const rate = PRODUCTS[account.product].wagerPerPoint;
  const combined = account.wagerRemainder + delta;
  const awarded = Math.floor((combined + 1e-9) / rate);
  account.wagerRemainder = Math.max(0, combined - awarded * rate);
  account.wagerCheckpoints[day] = value;
  account.points += awarded;
  account.wagerPointTotal += awarded;
  return { awarded, delta, checkpoint: value, remainder: account.wagerRemainder };
}

/** Lazy status decay and death. Seven *complete* missed Taipei days: last care Oct 7 -> death Oct 15. */
export function advancePet(account, day = taipeiDay()) {
  ensureAccount(account);
  const pet = account.pet;
  const elapsed = Math.max(0, daysBetween(pet.lastStatusDay, day));
  if (elapsed && pet.life === 'alive') {
    pet.food = clamp(pet.food - 8 * elapsed);
    pet.clean = clamp(pet.clean - 8 * elapsed);
    pet.mood = clamp(pet.mood - 5 * elapsed);
  }
  if (elapsed) pet.lastStatusDay = day;
  const careMissed = daysBetween(pet.lastCareDay, day);
  if (pet.life === 'alive' && careMissed >= 8) {
    pet.life = 'dead';
    pet.deaths += 1;
    pet.diedDay = day;
  }
  return { life: pet.life, elapsed, careMissed };
}

/** Calculate care safety metrics and endangered warning */
export function careStatus(account, day = taipeiDay()) {
  ensureAccount(account);
  const pet = account.pet;
  const missedDays = Math.max(0, daysBetween(pet.lastCareDay, day));
  const safeDaysRemaining = Math.max(0, 7 - missedDays);
  const isEndangered = pet.life === 'alive' && missedDays >= 5;
  const isDead = pet.life === 'dead' || missedDays >= 8;
  return {
    missedDays,
    safeDaysRemaining,
    isEndangered,
    isDead,
    lastCareDay: pet.lastCareDay,
    life: pet.life,
  };
}

export function buyItem(account, rawItem, quantity = 1, day = taipeiDay()) {
  ensureAccount(account);
  advancePet(account, day);
  assertAlive(account);
  const item = normalizeItem(rawItem);
  if (!Object.hasOwn(ITEM_COSTS, item)) throw new Error('未知道具');
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) throw new Error('數量需為 1–20');
  const cost = ITEM_COSTS[item] * quantity;
  if (account.points < cost) throw new Error('寵物點數不足');
  account.points -= cost;
  account.inventory[item] = (account.inventory[item] || 0) + quantity;
  return { cost, balance: account.points, item, quantity: account.inventory[item] };
}

export function useItem(account, rawItem, day = taipeiDay()) {
  ensureAccount(account);
  advancePet(account, day);
  assertAlive(account);
  const item = normalizeItem(rawItem);
  if (!Object.hasOwn(ITEM_COSTS, item)) throw new Error('未知道具');
  if (!account.inventory[item] || account.inventory[item] <= 0) throw new Error('沒有這個道具');
  const pet = account.pet;
  if (item === 'training') {
    if (pet.lastTrainingDay === day) throw new Error('今天已完成訓練');
    pet.lastTrainingDay = day;
    pet.growth += MAX_GROWTH_PER_DAY;
    pet.attack = Math.min(100, pet.attack + 2);
    pet.stage = stageFor(pet.growth);
    if (pet.growth >= COMPLETE_GROWTH && !pet.variantTitle) {
      const vars = COMPLETE_VARIANTS[account.product] || COMPLETE_VARIANTS.yingma;
      const chosen = vars[Math.floor(Math.random() * vars.length)];
      pet.variantTitle = chosen.title;
      pet.variantTrait = chosen.trait;
      pet.variantAttr = chosen.attr;
      pet.attack = Math.min(100, pet.attack + chosen.bonusAtk);
    }
  } else if (item === 'food') {
    if (pet.food >= 100) throw new Error('飽食已滿');
    pet.food = clamp(pet.food + 25);
    pet.lastCareDay = day;
  } else {
    if (pet.clean >= 100) throw new Error('清潔已滿');
    pet.clean = clamp(pet.clean + 25);
    pet.lastCareDay = day;
  }
  account.inventory[item] -= 1;
  return {
    item,
    stage: pet.stage,
    growth: pet.growth,
    food: pet.food,
    clean: pet.clean,
    mood: pet.mood,
    attack: pet.attack,
    inventoryCount: account.inventory[item],
    variantTitle: pet.variantTitle,
    variantTrait: pet.variantTrait,
  };
}

export function playTogether(a, b, day = taipeiDay()) {
  ensureAccount(a);
  ensureAccount(b);
  if (a.product !== b.product || a.tgId === b.tgId) throw new Error('玩耍對象不正確');
  advancePet(a, day);
  advancePet(b, day);
  assertAlive(a);
  assertAlive(b);
  if (a.pet.lastPlayDay === day || b.pet.lastPlayDay === day) throw new Error('其中一位今天已玩耍');
  for (const account of [a, b]) {
    account.pet.lastPlayDay = day;
    account.pet.mood = clamp(account.pet.mood + 8);
    account.points += 1;
    account.playPointTotal = (account.playPointTotal || 0) + 1;
  }
  return { pointEach: 1, moodEach: 8 };
}

/** Caller provides a uniform random number in [0, 1); it must be drawn server-side once per unique attempt. */
export function tryEvolve(account, roll, day = taipeiDay()) {
  ensureAccount(account);
  advancePet(account, day);
  assertAlive(account);
  if (account.pet.stage !== 'complete') throw new Error('寵物尚未到完全體');
  const step = account.pet.evolution;
  if (step >= 3) throw new Error('已完成三次進化');
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new Error('抽選值無效');
  const cost = STONE_COSTS[step];
  if (account.stones < cost) throw new Error('進化石不足');
  account.stones -= cost;
  const success = roll < 0.1;
  if (success) {
    account.pet.evolution += 1;
    const pool = EVOLUTION_POOLS[account.pet.evolution] || EVOLUTION_POOLS[1];
    const chosenEvo = pool[Math.floor(Math.random() * pool.length)];
    account.pet.evoTitle = chosenEvo.title;
    account.pet.evoTrait = chosenEvo.trait;
    account.pet.attack = Math.min(100, account.pet.attack + chosenEvo.bonusAtk);
  }
  return {
    success,
    cost,
    evolution: account.pet.evolution,
    evoTitle: account.pet.evoTitle,
    evoTrait: account.pet.evoTrait,
    stones: account.stones,
  };
}

export function reviveOrRebirth(account, day = taipeiDay(), { action = null } = {}) {
  ensureAccount(account);
  advancePet(account, day);
  const pet = account.pet;
  if (pet.life !== 'dead') throw new Error('寵物目前存活');

  if (action === 'reborn' || pet.evolution === 0) {
    pet.life = 'alive';
    pet.growth = 0;
    pet.stage = 'young';
    pet.attack = 10;
    pet.food = 80;
    pet.clean = 80;
    pet.mood = 80;
    pet.lastCareDay = day;
    pet.lastStatusDay = day;
    pet.lastTrainingDay = null;
    pet.lastPlayDay = null;
    pet.rebirths = (pet.rebirths || 0) + 1;
    pet.evolution = 0;
    delete pet.variantTitle;
    delete pet.variantTrait;
    delete pet.variantAttr;
    delete pet.evoTitle;
    delete pet.evoTrait;
    delete pet.diedDay;
    return { action: 'reborn', cost: 0 };
  }

  if (account.points < REVIVE_COST) throw new Error('復活需要 10 點');
  account.points -= REVIVE_COST;
  pet.food = 50;
  pet.clean = 50;
  pet.mood = 50;
  pet.life = 'alive';
  pet.lastCareDay = day;
  pet.lastStatusDay = day;
  delete pet.diedDay;
  return { action: 'revived', cost: REVIVE_COST };
}

export function damageFor(account, roll, day = taipeiDay(), { equippedItems = [], bossElement = null } = {}) {
  ensureAccount(account);
  advancePet(account, day);
  assertAlive(account);
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new Error('抽選值無效');
  const p = account.pet;
  const statusFactor = p.food < 20 || p.clean < 20 ? 0.8 : 1;
  const moodFactor = p.mood < 20 ? 0.9 : 1;
  const tier = { young: 0, growing: 2, mature: 4, complete: 8 }[p.stage] || 0;

  let equipAtk = 0;
  let equipElemAtk = 0;
  let weaponElement = null;

  for (const item of (equippedItems || [])) {
    if (item.equip_type === 'weapon') {
      const { totalBase, totalElem } = calcEquipmentStat(item);
      equipAtk += totalBase;
      equipElemAtk += totalElem;
      weaponElement = item.element;
    }
  }

  let power = (p.attack + tier + p.evolution * 6 + equipAtk) * statusFactor * moodFactor * (0.85 + roll * 0.3);
  if (weaponElement && bossElement) {
    const elemMult = elementMultiplier(weaponElement, bossElement);
    power = (power + equipElemAtk) * elemMult;
  }
  return Math.max(1, Math.round(power));
}

/** Largest-remainder allocation conserves the configured integer total. */
export function allocateStones(total, damageByUser, tieBreak = (a, b) => a.localeCompare(b)) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('掉落數量無效');
  const entries = Object.entries(damageByUser).filter(([, damage]) => Number.isFinite(damage) && damage > 0);
  const sum = entries.reduce((n, [, damage]) => n + damage, 0);
  if (!sum) return {};
  const shares = entries.map(([uid, damage]) => {
    const exact = (total * damage) / sum;
    return { uid, amount: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  const left = total - shares.reduce((n, share) => n + share.amount, 0);
  shares.sort((a, b) => b.fraction - a.fraction || tieBreak(a.uid, b.uid));
  for (let i = 0; i < left; i++) shares[i].amount += 1;
  return Object.fromEntries(shares.map(({ uid, amount }) => [uid, amount]));
}

/**
 * PvP match resolution.
 * Rules:
 * - Both alive, same product, distinct TG users.
 * - Simulates 3 battle rounds with status factor & controlled randomness.
 * - Takes equipment & elemental advantages into account.
 * - Records win/loss if first match between this pair today (anti-farming).
 */
export function resolvePvP(a, b, { day = taipeiDay(), rolls = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], aEquipment = [], bEquipment = [] } = {}) {
  ensureAccount(a);
  ensureAccount(b);
  if (a.product !== b.product || a.tgId === b.tgId) throw new Error('對戰對象不正確');
  advancePet(a, day);
  advancePet(b, day);
  assertAlive(a);
  assertAlive(b);

  const extractEquip = (items = []) => {
    let atk = 0, def = 0, wElem = null;
    const armors = [];
    for (const item of items) {
      const { totalBase, totalElem } = calcEquipmentStat(item);
      if (item.equip_type === 'weapon') {
        atk += totalBase + totalElem;
        wElem = item.element;
      } else {
        def += totalBase + totalElem;
        armors.push(item);
      }
    }
    return { atk, def, wElem, armors };
  };

  const eqA = extractEquip(aEquipment);
  const eqB = extractEquip(bEquipment);

  const getPower = (account, equip, oppEquip, roll) => {
    const p = account.pet;
    const statusFactor = p.food < 20 || p.clean < 20 ? 0.8 : 1;
    const moodFactor = p.mood < 20 ? 0.9 : 1;
    const tier = { young: 0, growing: 2, mature: 4, complete: 8 }[p.stage] || 0;
    const basePower = (p.attack + tier + p.evolution * 6 + equip.atk) * statusFactor * moodFactor * (0.85 + (roll ?? 0.5) * 0.3);
    const elemMult = equip.wElem ? armorElementMultiplier(equip.wElem, oppEquip.armors) : 1.0;
    const defReduction = Math.min(basePower * 0.4, oppEquip.def * 0.5);
    return Math.max(1, (basePower - defReduction) * elemMult);
  };

  let aWins = 0;
  let bWins = 0;
  const roundLogs = [];
  for (let r = 0; r < 3; r++) {
    const rA = rolls[r * 2] ?? 0.5;
    const rB = rolls[r * 2 + 1] ?? 0.5;
    const pA = Math.round(getPower(a, eqA, eqB, rA));
    const pB = Math.round(getPower(b, eqB, eqA, rB));
    let winner = 'draw';
    if (pA > pB) { aWins++; winner = 'a'; }
    else if (pB > pA) { bWins++; winner = 'b'; }
    roundLogs.push({ round: r + 1, pA, pB, winner });
  }

  let matchWinner = 'draw';
  if (aWins > bWins) matchWinner = 'a';
  else if (bWins > aWins) matchWinner = 'b';

  a.pvp ||= { wins: 0, losses: 0, pvpToday: {} };
  b.pvp ||= { wins: 0, losses: 0, pvpToday: {} };
  a.pvp.pvpToday ||= {};
  b.pvp.pvpToday ||= {};

  const alreadyRankedToday = a.pvp.pvpToday[b.tgId] === day || b.pvp.pvpToday[a.tgId] === day;
  const ranked = !alreadyRankedToday;

  let deltaA = 0;
  let deltaB = 0;

  if (ranked) {
    a.pvp.pvpToday[b.tgId] = day;
    b.pvp.pvpToday[a.tgId] = day;
    if (a.pet) a.pet.seasonPoints = a.pet.seasonPoints ?? 100;
    if (b.pet) b.pet.seasonPoints = b.pet.seasonPoints ?? 100;

    if (matchWinner === 'a') {
      a.pvp.wins += 1;
      b.pvp.losses += 1;
      deltaA = 10;
      deltaB = -8;
      if (a.pet) a.pet.seasonPoints += 10;
      if (b.pet) b.pet.seasonPoints = Math.max(0, b.pet.seasonPoints - 8);
    } else if (matchWinner === 'b') {
      b.pvp.wins += 1;
      a.pvp.losses += 1;
      deltaA = -8;
      deltaB = 10;
      if (b.pet) b.pet.seasonPoints += 10;
      if (a.pet) a.pet.seasonPoints = Math.max(0, a.pet.seasonPoints - 8);
    }
  }

  return {
    winner: matchWinner,
    winnerTgId: matchWinner === 'a' ? a.tgId : matchWinner === 'b' ? b.tgId : null,
    loserTgId: matchWinner === 'a' ? b.tgId : matchWinner === 'b' ? a.tgId : null,
    ranked,
    deltaA,
    deltaB,
    aPoints: a.pet?.seasonPoints ?? 100,
    bPoints: b.pet?.seasonPoints ?? 100,
    aScore: aWins,
    bScore: bWins,
    rounds: roundLogs,
  };
}

export const DEFAULT_SEASON_REWARDS = [100, 70, 50, 40, 30, 20, 15, 10, 8, 5];
export const INITIAL_SEASON_POINTS = 100;
export const WIN_SEASON_POINTS = 10;
export const LOSE_SEASON_POINTS = 8;

export function calcDailyBonusEligibility(account, day = taipeiDay()) {
  const openedDay = account?.openedDay || day;
  const daysDiff = Math.max(0, daysBetween(openedDay, day));
  const isFirstWeek = daysDiff < 7;
  const lastDaily = account?.pet?.lastDailyBonusDay;
  const lastLogin = account?.pet?.lastLoginBonusDay;
  const canClaimOpenBonus = isFirstWeek && lastDaily !== day;
  const canClaimLoginBonus = lastLogin !== day;
  return {
    daysDiff,
    dayNumber: daysDiff + 1,
    isFirstWeek,
    canClaimOpenBonus,
    openBonusPoints: canClaimOpenBonus ? 30 : 0,
    canClaimLoginBonus,
    loginBonusPoints: canClaimLoginBonus ? 5 : 0,
  };
}

/**
 * Server-side Telegram Mini App initData validation via HMAC-SHA256.
 * Returns the parsed user object if authentic, or null if invalid or tampered.
 */
export function verifyTelegramInitData(initDataString, botToken) {
  if (!initDataString || !botToken) return null;
  try {
    const params = new URLSearchParams(initDataString);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map((k) => `${k}=${params.get(k)}`).join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash.toLowerCase() !== hash.toLowerCase()) return null;

    const userRaw = params.get('user');
    const user = userRaw ? JSON.parse(userRaw) : null;
    return {
      user,
      authDate: Number(params.get('auth_date') || 0),
      queryId: params.get('query_id') || null,
      raw: Object.fromEntries(params.entries()),
    };
  } catch {
    return null;
  }
}
