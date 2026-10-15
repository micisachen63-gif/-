export const UC_MIN_PLAYERS = 5;
export const UC_MAX_PLAYERS = 10;
export const UC_EMPTY_LOBBY_MS = 5 * 60_000;
export const UC_LOBBY_MS = 10 * 60_000;
export const UC_TURN_MS = 45_000;
export const UC_DISCUSS_MS = 2 * 60_000;
export const UC_VOTE_MS = 60_000;
export const UC_RUNOFF_MS = 45_000;

export const WORD_PAIRS = Object.freeze([
  ['咖啡', '奶茶'], ['火鍋', '麻辣燙'], ['蛋餅', '蔥油餅'], ['燒肉', '烤肉'], ['鍋貼', '水餃'],
  ['可樂', '雪碧'], ['滷肉飯', '雞肉飯'], ['珍珠奶茶', '椰果奶茶'], ['薯條', '洋芋片'], ['冰淇淋', '雪花冰'],
  ['夜市', '市集'], ['捷運', '高鐵'], ['計程車', '叫車'], ['公車', '客運'], ['機車', '電動車'],
  ['海邊', '河濱'], ['山屋', '民宿'], ['電影', '影集'], ['演唱會', '音樂祭'], ['牙刷', '電動牙刷'],
  ['梳子', '髮刷'], ['鯨魚', '海豚'], ['獅子', '老虎'], ['貓', '狐狸'], ['松鼠', '倉鼠'],
  ['企鵝', '海豹'], ['蜜蜂', '蝴蝶'], ['雨傘', '雨衣'], ['眼鏡', '隱形眼鏡'], ['相機', '手機'],
  ['筆電', '平板'], ['耳機', '喇叭'], ['微波爐', '氣炸鍋'], ['洗衣機', '烘衣機'], ['冰箱', '冷凍庫'],
  ['抱枕', '靠墊'], ['戒指', '手環'], ['洗髮精', '沐浴乳'], ['牙膏', '洗面乳'], ['鉛筆', '原子筆'],
  ['棒球', '籃球'], ['羽球', '網球'], ['麻將', '撲克牌'], ['溫泉', '三溫暖'], ['餐廳', '咖啡廳'],
  ['口罩', '面膜'], ['行李箱', '旅行袋'], ['電風扇', '冷氣'], ['生日蛋糕', '婚禮蛋糕'], ['月亮', '路燈'],
]);

export const userName = (user = {}) => String([user.first_name, user.last_name].filter(Boolean).join(' ') || (user.username ? `@${user.username}` : '') || `玩家${String(user.id ?? '').slice(-4)}`).slice(0, 24);
export const undercoverCount = count => count >= 8 ? 2 : 1;
export const living = game => game.players.filter(player => player.alive);
export const playerById = (game, id) => game.players.find(player => String(player.id) === String(id));
export const playerBySeat = (game, seat) => game.players.find(player => player.seat === Number(seat));

export function shuffle(items, random = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.max(0, Math.min(i, Math.floor(random() * (i + 1))));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function chooseWords(playerCount, recentPairIndexes = [], random = Math.random) {
  const excluded = new Set(recentPairIndexes.slice(-10));
  const choices = WORD_PAIRS.map((_, index) => index).filter(index => !excluded.has(index));
  const pairIndex = choices[Math.floor(random() * choices.length)] ?? 0;
  const pair = WORD_PAIRS[pairIndex];
  const spySeats = shuffle(Array.from({ length: playerCount }, (_, index) => index + 1), random).slice(0, undercoverCount(playerCount));
  const reverse = random() >= 0.5;
  const citizenWord = pair[reverse ? 1 : 0];
  const undercoverWord = pair[reverse ? 0 : 1];
  return { pairIndex, citizenWord, undercoverWord, spySeats };
}

export function winner(game) {
  const alive = living(game);
  const spies = alive.filter(player => player.role === 'undercover').length;
  const citizens = alive.length - spies;
  if (!spies) return 'citizens';
  if (spies >= citizens) return 'undercover';
  return null;
}

export function countVotes(votes, eligibleSeats) {
  const eligible = new Set(eligibleSeats.map(Number));
  const counts = new Map();
  for (const seat of Object.values(votes || {})) {
    const value = Number(seat);
    if (eligible.has(value)) counts.set(value, (counts.get(value) || 0) + 1);
  }
  if (!counts.size) return { seat: null, tied: [], counts: {} };
  const top = Math.max(...counts.values());
  const tied = [...counts].filter(([, amount]) => amount === top).map(([seat]) => seat);
  return { seat: tied.length === 1 ? tied[0] : null, tied, counts: Object.fromEntries(counts) };
}

export function publicWords(game) {
  return `🔑 平民詞：${game.citizenWord}　｜　🕵️ 臥底詞：${game.undercoverWord}`;
}
