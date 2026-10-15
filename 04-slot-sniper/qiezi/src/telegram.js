import fs from 'node:fs';
import path from 'node:path';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

const GAME_EMOJI = {
  '戰神賽特二': '⚔️',
  '虎小妹': '🐯',
  '古神巴風特': '😈',
};

const DIVIDER = '────────';

/** Opener line by Taipei hour (send time), [fromHour, text]; first match from the end wins. */
const GREETINGS = [
  [0, '🌙 別睡! 繼續凹蕊!!'],
  [5, '☀️ 早安! 先搶頭香再上班!'],
  [11, '🍜 午休偷開一把，下午更有勁!'],
  [14, '☕ 下午茶時間，來把手氣!'],
  [18, '🍗 吃飽開幹!'],
  [22, '🌃 睡前來一把，好夢帶大獎!'],
];

export function taipeiHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hourCycle: 'h23' }).format(now)) % 24;
}

export function greetingFor(now = new Date()) {
  const hour = taipeiHour(now);
  let text = GREETINGS[0][1];
  for (const [from, line] of GREETINGS) if (hour >= from) text = line;
  return text;
}
const CAPTION_LIMIT = 1024;

function formatRate(value) {
  if (value == null || value === '') return null;
  return escapeHtml(String(value).replace(/%$/, '')) + '%';
}

function formatRoomBlock(room) {
  const lines = [`🎰 <b>${escapeHtml(room.tableId)}</b>號台`];
  const spins = [`未開 <b>${room.spinsSinceBonus}</b>`];
  if (room.previousBonusSpins != null) spins.push(`前 ${room.previousBonusSpins}`);
  if (room.secondPreviousBonusSpins != null) spins.push(`再前 ${room.secondPreviousBonusSpins}`);
  lines.push(spins.join(' ｜ '));
  const rates = [];
  const today = formatRate(room.todayReturnRate);
  const days30 = formatRate(room.days30ReturnRate);
  if (today) rates.push(`今 ${today}`);
  if (days30) rates.push(`30天 ${days30}`);
  if (rates.length) lines.push(rates.join(' ｜ '));
  return lines.join('\n');
}

/** Telegram caption length uses UTF-16 code units. */
export function telegramLength(text) {
  return Buffer.byteLength(String(text), 'utf16le') / 2;
}

export function formatMessage(rooms, games, { now = new Date() } = {}) {
  const onlyGame = games.length === 1 ? games[0] : null;
  const titleEmoji = onlyGame ? (GAME_EMOJI[onlyGame] ?? '🎰') : '🎰';
  const title = onlyGame
    ? `${titleEmoji} <b>茄子撿台｜${escapeHtml(onlyGame)}</b>`
    : '🎰 <b>ATG撿台通知</b>';
  const sections = [`<b>${escapeHtml(greetingFor(now))}</b>\n${title}`];
  const gameBlocks = [];
  for (const game of games) {
    const group = rooms.filter((room) => room.game === game);
    if (!group.length) continue;
    // Single blank line between tables keeps caption under Telegram's 1024 limit.
    const tables = group.map(formatRoomBlock).join('\n\n');
    if (onlyGame) {
      gameBlocks.push(tables);
    } else {
      const emoji = GAME_EMOJI[game] ?? '🎲';
      gameBlocks.push(`${emoji} <b>${escapeHtml(game)}</b>\n\n${tables}`);
    }
  }
  if (gameBlocks.length) {
    sections.push(gameBlocks.join(`\n\n${DIVIDER}\n\n`));
  } else {
    sections.push('目前沒有符合條件的空桌。');
  }
  sections.push('✨ 勇敢的人先享受世界，猶豫的人只埋怨世界');
  return sections.join('\n\n');
}

function replyMarkup(buttonUrl) {
  return JSON.stringify({
    inline_keyboard: [[{ text: '馬上搶台試手氣', url: buttonUrl }]],
  });
}

export async function sendTelegram({
  token,
  chatId,
  text,
  buttonUrl,
  photoPath,
  fetchImpl = fetch,
}) {
  if (!token || !chatId) throw new Error('缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID');

  if (photoPath) {
    if (!fs.existsSync(photoPath)) throw new Error(`找不到遊戲圖片：${photoPath}`);
    const captionLen = telegramLength(text);
    if (captionLen > CAPTION_LIMIT) {
      throw new Error(
        `圖文同則的說明超過 Telegram 上限 ${CAPTION_LIMIT}（目前 ${captionLen}）。請減少台數或聯絡調整格式。`,
      );
    }
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', text);
    form.append('parse_mode', 'HTML');
    form.append('reply_markup', replyMarkup(buttonUrl));
    const buffer = fs.readFileSync(photoPath);
    form.append(
      'photo',
      new Blob([buffer], { type: 'image/jpeg' }),
      path.basename(photoPath),
    );
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(`Telegram 發送失敗：${response.status} ${result.description ?? '未知錯誤'}`);
    }
    return result.result;
  }

  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: '馬上搶台試手氣', url: buttonUrl }]],
    },
  };
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram 發送失敗：${response.status} ${result.description ?? '未知錯誤'}`);
  }
  return result.result;
}
