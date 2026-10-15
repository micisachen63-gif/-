const MAJOR = ['愚者','魔術師','女祭司','皇后','皇帝','教皇','戀人','戰車','力量','隱者','命運之輪','正義','吊人','死神','節制','惡魔','高塔','星星','月亮','太陽','審判','世界'];
const SUITS = ['權杖','聖杯','寶劍','錢幣'];
const RANKS = ['王牌','二','三','四','五','六','七','八','九','十','侍者','騎士','皇后','國王'];

export const TAROT_POSITIONS = ['目前處境','核心阻礙','過去的影響','內在動機','尚未看見的因素','近期發展','自身能量','外在環境','行動建議','可能走向'];
const LEGACY_POSITIONS = ['現況','主要阻礙','內在／潛意識','行動建議','近期走向'];
export const TAROT_TTL_MS = 30 * 60e3;

export const TAROT_DECK = [
  ...MAJOR.map((name) => `大阿爾克那・${name}`),
  ...SUITS.flatMap((suit) => RANKS.map((rank) => `${suit}・${rank}`)),
];

function shuffle(values, rng = Math.random) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function createTarotSession({ id, userId, chatId, question, now = Date.now(), rng = Math.random }) {
  const candidates = shuffle(TAROT_DECK, rng).slice(0, 20).map((name) => ({
    name,
    orientation: rng() < 0.5 ? '正位' : '逆位',
  }));
  return {
    id: String(id), userId, chatId, question: String(question).trim(), candidates,
    picks: [], positions: [...TAROT_POSITIONS], stage: 'ready', createdAt: now, updatedAt: now, messageId: null,
  };
}

export const tarotPositionsFor = (session) => session.positions || LEGACY_POSITIONS;

export const tarotCardLabel = (card) => `${card.name}｜${card.orientation}`;

export function tarotReadyText(session) {
  const positions=tarotPositionsFor(session);
  return `🔮 塔羅占卜\n\n你的問題：\n「${session.question}」\n\n本次使用${positions.length}張牌陣：\n${positions.map((name,i)=>`${i+1}. ${name}`).join('\n')}\n\n準備好後按「開始占卜」，接著由你親自翻出${positions.length}張牌。`;
}

export function tarotBoardText(session) {
  const positions=tarotPositionsFor(session);const target=positions.length;
  const picked=session.picks.length;
  const lines = ['🔮 小精靈塔羅｜親手翻牌', '', `「${session.question}」`, '', `${'🟣'.repeat(picked)}${'⚪'.repeat(target-picked)}  ${picked}/${target}`];
  if(picked<target)lines.push('', `下一張・${positions[picked]}`, `從下方 ${session.candidates.length} 張牌背選一張；✅ 是已翻過的牌。`);
  if(picked){
    lines.push('', '✦ 已翻開的牌');
    session.picks.forEach((index, order) => lines.push(`${String(order+1).padStart(2,'0')}  ${positions[order]}｜${tarotCardLabel(session.candidates[index])}`));
  }
  if(picked===target)lines.push('', '✨ 牌陣完成，小精靈正在解牌…');
  return lines.join('\n');
}

export function tarotKeyboard(session) {
  if (session.stage !== 'picking') return [];
  const buttons = session.candidates.map((_, index) => ({
    text: session.picks.includes(index) ? `✅ ${String(index+1).padStart(2,'0')}` : `🂠 ${String(index+1).padStart(2,'0')}`,
    callback_data: `tt:pick:${session.id}:${index}`,
  }));
  return Array.from({length:Math.ceil(buttons.length/4)},(_,row)=>buttons.slice(row*4,row*4+4));
}

export function buildTarotInterpretationPrompt(session) {
  const positions=tarotPositionsFor(session);
  const cards = session.picks.map((index, order) => `${order + 1}. ${positions[order]}：${tarotCardLabel(session.candidates[index])}`).join('\n');
  return `你是「小精靈塔羅解牌師」。請使用自然、親切、具體的繁體中文，針對使用者真正提出的問題解讀${positions.length}張塔羅牌。\n\n占卜問題：\n${session.question}\n\n${positions.length}張牌：\n${cards}\n\n請依序說明：\n- 每張牌放在該位置代表什麼\n- 所有牌彼此之間的關聯與整體故事，不要只是逐張列點\n- 直接回答使用者最在意的問題\n- 最後給 3～5 點可實際採取的建議\n\n不要把結果描述成百分之百必然發生；把塔羅作為象徵、趨勢與自我整理的工具即可。不要重複問題，不要輸出表格，完整但避免空泛重複。`;
}
