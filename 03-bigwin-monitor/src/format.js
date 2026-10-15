import { escapeHtml as esc, fmtMoney, shortTime, toNumber } from './util.js';

/** Multiplier = payout / stake (the backend xpay field is truncated, e.g. 1.65 → "1"); xpay only as fallback. */
export function fmtMultiplier(bet) {
  const pay = toNumber(bet.payMoney);
  const stake = toNumber(bet.betMoney);
  let x = stake > 0 && Number.isFinite(pay) ? pay / stake : toNumber(bet.xpay);
  if (!Number.isFinite(x) || x < 0) return '—';
  return `${Math.round(x * 100) / 100}x`;
}

function gameLabel(bet) {
  const game = String(bet.gameName ?? '').trim() || '（未知遊戲）';
  const vendor = String(bet.description ?? '').trim();
  return vendor ? `${esc(game)}（${esc(vendor)}）` : esc(game);
}

/** Private risk-control alert (HTML). player may be null when lookup failed / not found. */
export function formatAlert(brand, bet, player, { lookupError = false } = {}) {
  const nickname = player?.nickname ? esc(player.nickname) : (lookupError ? '（查詢失敗）' : '（查無）');
  const lines = [
    `🚨 <b>爆分提醒｜${esc(brand.name)}</b>`,
    `時間 ${esc(shortTime(bet.time))}`,
    `AID <code>${esc(bet.a_id)}</code>｜暱稱 ${nickname}`,
    `遊戲 ${gameLabel(bet)}`,
    `出分 <b>${fmtMoney(bet.payMoney)}</b>｜投注 ${fmtMoney(bet.betMoney)}｜倍率 ${fmtMultiplier(bet)}`,
    player
      ? `目前餘額 ${fmtMoney(player.money)}｜累積儲值 ${fmtMoney(player.totalCharge)}`
      : `目前餘額 —｜累積儲值 —（玩家資料${lookupError ? '查詢失敗' : '查無'}）`,
    `單號 <code>${esc(bet.docNo)}</code>`,
  ];
  return lines.join('\n');
}

/** Community congrats (HTML). No AID / stake; real nickname / game / payout. */
const CONGRATS_TEMPLATES = [
  ({ n, g, p }) => ['🎰🔥 <b>爆分快報</b> 🔥🎰', `恭喜 <b>${n}</b> 大神！`, `在《${g}》一把轟出 <b>${p}</b> 💰`, '這手氣不去買樂透太可惜了 😎'],
  ({ n, g, p }) => ['💥 <b>手氣炸裂！</b> 💥', `<b>${n}</b> 在《${g}》狂噴 <b>${p}</b> 🤑`, '下一個爆分的會不會就是你？👀'],
  ({ n, g, p }) => ['🎉🎉 <b>恭喜恭喜</b> 🎉🎉', `<b>${n}</b> 在《${g}》喜提 <b>${p}</b>！`, '財神爺今天親自顧台 🧧'],
  ({ n, g, p }) => ['👑 <b>全場起立！</b> 👑', `<b>${n}</b> 在《${g}》爆出 <b>${p}</b> 大獎 🏆`, '掌聲鼓勵鼓勵 👏👏👏'],
  // Only when the multiplier is impressive (>= 20x); otherwise the next template is used.
  ({ n, g, p, x }) => (x ? [`🚀 <b>${x} 倍直接起飛！</b>`, `<b>${n}</b> 在《${g}》轟出 <b>${p}</b> 💎`, '天選之人本人出現了 ✨'] : null),
];
export const CONGRATS_TEMPLATE_COUNT = CONGRATS_TEMPLATES.length;
const BRAND_TAGLINE = {
  winmalo: '今天也是贏麻了的一天 🙌',
  songyy: '投資理財一場空，賭博贏了住皇宮!! 🏰',
};

function stableHash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

/** Template is picked from the bet key, so a retried publish always produces the same text. */
export function formatCongrats({ nickname, gameName, payMoney, betMoney, brand, betKey, docNo, id }) {
  const n = esc(String(nickname ?? '').trim() || '幸運玩家');
  const g = esc(String(gameName ?? '').trim() || '神秘遊戲');
  const p = fmtMoney(payMoney);
  const pay = toNumber(payMoney);
  const stake = toNumber(betMoney);
  const ratio = stake > 0 && Number.isFinite(pay) ? pay / stake : NaN;
  const x = Number.isFinite(ratio) && ratio >= 20 ? Math.round(ratio).toLocaleString('en-US') : null;
  const start = stableHash(betKey ?? docNo ?? id ?? `${nickname}|${payMoney}`) % CONGRATS_TEMPLATES.length;
  let lines = null;
  for (let i = 0; i < CONGRATS_TEMPLATES.length && !lines; i++) {
    lines = CONGRATS_TEMPLATES[(start + i) % CONGRATS_TEMPLATES.length]({ n, g, p, x });
  }
  const tagline = BRAND_TAGLINE[brand];
  return (tagline ? [...lines, '', tagline] : lines).join('\n');
}

export function formatLoginAlert(brand) {
  return [
    `⚠️ 登入失效，請登入 ${esc(brand.name)} 後台`,
    '自動重新登入已連續失敗；在這段期間爆分監控無法查詢該站。',
    '請在電腦上執行「爆分監控」資料夾中的 login.cmd，登入後關閉視窗即可。',
  ].join('\n');
}

export function formatScanFailureAlert(brand, count, error) {
  return [
    `⚠️ 爆分監控：${esc(brand.name)} 已連續 ${count} 次查詢失敗`,
    `最後錯誤：${esc(String(error ?? '').slice(0, 200))}`,
    '系統會持續自動重試；恢復後會自動補查漏掉的時段。',
  ].join('\n');
}

export const BUTTON_TEXT = {
  publish: '📣 發佈到社群',
  skip: '略過',
  published: '✅ 已發佈',
  skipped: '⏭ 已忽略',
  unknown: '⚠️ 發佈狀態不明（請到社群確認）',
  error: '⚠️ 發佈異常（請看紀錄）',
};

/** Status line appended to a handled alert (buttons are removed). */
export const STATUS_LINE = {
  published: '✅ 已發佈到社群',
  skipped: '⏭ 已忽略',
  unknown: '⚠️ 發佈狀態不明（請到社群確認）',
  error: '⚠️ 發佈異常（請看紀錄）',
};

function hhmm(ms) {
  if (!Number.isFinite(Number(ms))) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Number(ms)));
}

/** Original alert HTML + a status line, e.g. "⏭ 已忽略（11:06）". */
export function formatDoneText(text, status, atMs) {
  const t = hhmm(atMs);
  return `${text}\n\n<b>${STATUS_LINE[status] || STATUS_LINE.error}</b>${t ? `（${t}）` : ''}`;
}

export function pendingKeyboard(id) {
  return { inline_keyboard: [[
    { text: BUTTON_TEXT.publish, callback_data: `p:${id}` },
    { text: BUTTON_TEXT.skip, callback_data: `s:${id}` },
  ]] };
}

export function doneKeyboard(id, status) {
  const text = BUTTON_TEXT[status] || BUTTON_TEXT.error;
  return { inline_keyboard: [[{ text, callback_data: `d:${id}` }]] };
}

export function describeKeyboard(markup) {
  if (!markup?.inline_keyboard) return '';
  return markup.inline_keyboard.map((row) => row.map((b) => `[${b.text}${b.url ? ' → ' + b.url : ''}]`).join(' ')).join('\n');
}
