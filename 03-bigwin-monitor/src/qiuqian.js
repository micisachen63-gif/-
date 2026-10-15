// 觀音求籤: pure logic (擲筊 odds, flow transitions, texts, keyboards). No Telegram / AI here.
import fs from 'node:fs';

export const QIUQIAN_TTL_MS = 30 * 60e3;
export const QIUQIAN_DEITY = '觀世音菩薩';
export const QQ_SIGNS = 100;
export const QQ_FAIL_HINT_AT = 3; // 習俗：連續三次未得聖筊，建議改日再來（仍可再擲）

export const JIAO = {
  sheng: { name: '聖筊', faces: '一平一凸', file: 'sheng.jpg' },
  xiao: { name: '笑筊', faces: '兩面皆平', file: 'xiao.jpg' },
  yin: { name: '陰筊', faces: '兩面皆凸', file: 'yin.jpg' },
};
export const JIAO_ODDS = { sheng: 0.25, xiao: 0.25, yin: 0.5 };

/** Zero-AI throw. 聖筊 1/4, 笑筊 1/4, 陰筊 1/2. */
export function throwJiao(rng = Math.random) {
  const r = rng();
  if (r < JIAO_ODDS.sheng) return 'sheng';
  if (r < JIAO_ODDS.sheng + JIAO_ODDS.xiao) return 'xiao';
  return 'yin';
}

/** Zero-AI uniform draw from the 籤筒: 1..100. */
export function drawSign(rng = Math.random) {
  const n = Math.floor(rng() * QQ_SIGNS) + 1;
  return Math.min(QQ_SIGNS, Math.max(1, n));
}

export const jiaoImageUrl = (kind) => new URL(`../assets/jiaobei/${JIAO[kind].file}`, import.meta.url);

const CN = '零一二三四五六七八九';
export function signNumberZh(n) {
  if (n === 100) return '一百';
  const t = Math.floor(n / 10), o = n % 10;
  return (t > 1 ? CN[t] : '') + (t ? '十' : '') + (o ? CN[o] : '');
}

export function validateQiuqianData(data) {
  const signs = data?.signs;
  if (!Array.isArray(signs) || signs.length !== QQ_SIGNS) throw new Error('籤詩資料必須剛好 100 支');
  signs.forEach((s, i) => {
    if (s.number !== i + 1) throw new Error(`籤號不連續：第 ${i + 1} 支`);
    if (!['上籤', '中籤', '下籤'].includes(s.grade)) throw new Error(`第 ${s.number} 籤等第不明`);
    if (!Array.isArray(s.poem) || s.poem.length !== 4 || s.poem.some((l) => !/^\p{Script=Han}{7}$/u.test(l))) throw new Error(`第 ${s.number} 籤籤詩格式不符（須為四句七言）`);
    if (!s.title && !(Array.isArray(s.titleVariants) && s.titleVariants.length)) throw new Error(`第 ${s.number} 籤缺典故`);
    if (!s.jieyue || !s.shiyi) throw new Error(`第 ${s.number} 籤缺詩意或解曰`);
  });
  return data;
}

let cached = null;
export function loadQiuqianData(file = new URL('../assets/qiuqian/guanyin100.json', import.meta.url)) {
  if (cached && cached.file === String(file)) return cached.data;
  const data = validateQiuqianData(JSON.parse(fs.readFileSync(file, 'utf8')));
  cached = { file: String(file), data };
  return data;
}
export const getSign = (n, data = loadQiuqianData()) => data.signs[Number(n) - 1] || null;
export const signTitle = (s) => s.title || `${s.titleVariants.join('／')}（傳本不一）`;

export function createQiuqianSession({ id, userId, chatId, userName = '', now = Date.now() }) {
  return { id: String(id), userId, chatId, userName: String(userName || ''), stage: 'invite', seq: 1, question: '', pick: null, draws: [],
    fails: { invite: 0, ask: 0, confirm: 0 }, throws: [], createdAt: now, updatedAt: now, messageId: null, promptId: null, signMessageId: null };
}

const cb = (session, action, arg) => `qq:${action}:${session.id}:${session.seq}${arg == null ? '' : `:${arg}`}`;
export const qqThrowButton = (session, text = '🥢 擲筊') => ({ text, callback_data: cb(session, 't') });

export function qiuqianIntroText(session, group = false) {
  const who = group && session.userName ? `${session.userName}，` : '';
  return `🙏 觀音靈籤\n\n${who}求籤前請先靜心、雙手合十，在心中默念：\n「弟子誠心向${QIUQIAN_DEITY}請示，懇請菩薩降臨指點。」\n\n準備好後按「擲筊請神」，請示菩薩是否已到。`;
}
export const qiuqianIntroKeyboard = (session) => [[qqThrowButton(session, '🥢 擲筊請神')]];
/** Caption of the deity image, sent only after the invite sheng-jiao. */
export const qiuqianDeityArrivedText = (session, group = false) => '\ud83d\ude4f ' + QIUQIAN_DEITY + '\u5df2\u964d\u81e8\u2026\n\n' + (group && session.userName ? session.userName + '\uff0c' : '') + '\u8acb\u8f38\u5165\u4f60\u60f3\u8acb\u793a\u7684\u554f\u984c\u3002';
export const qiuqianQuestionPrompt = (session, group = false) => `${group && session.userName ? session.userName + '，' : ''}請回覆這則訊息，寫下想向${QIUQIAN_DEITY}請示的事 🙏\n（建議寫清楚：什麼人、什麼事、想知道什麼）`;
export const qiuqianAskText = (session) => `🙏 你要請示的事：\n「${session.question}」\n\n請擲筊請示菩薩：此事是否可以求籤指點？`;
export const qiuqianAskKeyboard = (session) => [[qqThrowButton(session, '🥢 擲筊請示'), { text: '✏️ 換個問法', callback_data: cb(session, 'q') }]];

export const qiuqianShakeKeyboard = (session, again = false) => [[{ text: again ? '🎋 再搖籤筒' : '🎋 搖籤筒', callback_data: cb(session, 'y') }]];
export const qiuqianShakeText = (session) => `🎋 觀音靈籤・搖籤筒\n\n請示：「${session.question}」\n\n請靜心默念所求之事，按下「搖籤筒」，由菩薩指引落下的那一支籤。`;
export const qiuqianDrawnText = (session) => `🎋 搖出第 ${session.pick} 籤（第${signNumberZh(session.pick)}籤）\n\n請擲筊向菩薩確認：是不是這一支？`;
export const qiuqianConfirmKeyboard = (session) => [[qqThrowButton(session, '🥢 擲筊確認')]];
export const qiuqianRetryKeyboard = (session) => [[{ text: '🔄 重新解籤', callback_data: cb(session, 'r') }]];
// ---- 解籤後追問廟公（same session, same 30-min idle TTL） ----
export const QQ_FOLLOWUP_LABEL = '我想問廟公籤詩問題';
/** Under the 解籤 and under every 廟公 answer: keep asking about this 籤, or end the session. */
export const qiuqianFollowupKeyboard = (session) => [[{ text: QQ_FOLLOWUP_LABEL, callback_data: cb(session, 'f') }, { text: '🙏 結束', callback_data: cb(session, 'x') }]];
export const qiuqianFollowupAskText = (session, group = false) => `${group && session.userName ? session.userName + '，' : ''}請回覆這則訊息，寫下想問廟公的問題（第 ${session.pick} 籤）🙏\n例如：籤詩某一句是什麼意思、這件事該注意什麼、什麼時候比較適合行動。`;
export const QQ_FOLLOWUP_EXPIRED = '這次求籤已超過 30 分鐘沒有動靜，廟公先去忙了 🙏\n想再請示，請重新按「🙏 觀音求籤」。';
export const QQ_FOLLOWUP_END = '🙏 感謝請示。心誠則靈，願菩薩保佑，平安順心。';
const againRow = (session, extra = []) => [[qqThrowButton(session, '🥢 再擲一次'), ...extra]];
const endButton = (session) => ({ text: '🙏 改日再來', callback_data: cb(session, 'x') });

/**
 * Apply one 擲筊 result to the session. Mutates the session (stage, fails, seq) and returns what to show:
 * { caption, keyboard, next } where next is 'question' | 'shake' | 'reading' | 'again'.
 */
export function applyQiuqianThrow(session, kind, now = Date.now()) {
  if (!JIAO[kind]) throw new Error('未知的筊象');
  const stage = session.stage;
  if (!['invite', 'asking', 'confirm'].includes(stage)) throw new Error(`此階段不能擲筊：${stage}`);
  const j = JIAO[kind];
  session.throws.push({ stage, kind, at: now, ...(stage === 'confirm' ? { pick: session.pick } : {}) });
  session.updatedAt = now;
  const caption = qiuqianThrowCaption(session, stage, kind);
  const resultCaption = JIAO_EMOJI[kind] + ' ' + JIAO[kind].name + '\uff08' + JIAO[kind].faces + '\uff09';
  const failKey = stage === 'invite' ? 'invite' : stage === 'asking' ? 'ask' : 'confirm';
  if (kind === 'sheng') {
    session.fails[failKey] = 0; session.seq++;
    if (stage === 'invite') { session.stage = 'question'; return { next: 'question', caption, resultCaption, keyboard: [] }; }
    if (stage === 'asking') { session.stage = 'shake'; return { next: 'shake', caption, resultCaption, keyboard: qiuqianShakeKeyboard(session) }; }
    session.stage = 'reading'; return { next: 'reading', caption, resultCaption, keyboard: [] };
  }
  const fails = ++session.fails[failKey]; session.seq++;
  if (stage === 'confirm') {
    session.stage = 'shake'; session.pick = null;
    const keyboard = qiuqianShakeKeyboard(session, true); if (fails >= QQ_FAIL_HINT_AT) keyboard.push([endButton(session)]);
    return { next: 'shake', caption, resultCaption, keyboard };
  }
  const extra = stage === 'asking' ? [{ text: '\u270f\ufe0f \u63db\u500b\u554f\u6cd5', callback_data: cb(session, 'q') }] : [];
  const keyboard = againRow(session, extra);
  if (fails >= QQ_FAIL_HINT_AT) keyboard.push([endButton(session)]);
  return { next: 'again', caption, resultCaption, keyboard };
}

export const JIAO_EMOJI = { sheng: '\u2728', xiao: '\ud83d\ude04', yin: '\ud83c\udf19' };
const QQ_STEP_NAME = { invite: '\u8acb\u795e', asking: '\u554f\u4e8b', confirm: '\u78ba\u8a8d\u7c64' };
const QQ_HISTORY_MAX = 10;
const QQ_RULE = '\u2501'.repeat(10);
const QQ_MEANING = {
  invite: { sheng: () => '\u83e9\u85a9\u61c9\u5141\u964d\u81e8\u3002', xiao: () => '\u83e9\u85a9\u7b11\u800c\u672a\u7b54\uff0c\u53ef\u80fd\u5fc3\u610f\u5c1a\u672a\u6c89\u6fb1\uff0c\u6216\u83e9\u85a9\u9084\u672a\u5230\u3002', yin: () => '\u83e9\u85a9\u66ab\u672a\u61c9\u5141\uff0c\u6642\u6a5f\u6216\u5fc3\u610f\u672a\u5230\u3002' },
  asking: { sheng: () => '\u83e9\u85a9\u5141\u8a31\u70ba\u6b64\u4e8b\u8cdc\u7c64\u3002', xiao: () => '\u83e9\u85a9\u7b11\u800c\u4e0d\u7b54\uff0c\u53ef\u80fd\u554f\u984c\u4e0d\u5920\u660e\u78ba\uff0c\u6216\u7b54\u6848\u5176\u5be6\u5df2\u5728\u4f60\u5fc3\u4e2d\u3002', yin: () => '\u83e9\u85a9\u4e0d\u8a8d\u540c\u9019\u6a23\u554f\uff0c\u6216\u6b64\u4e8b\u66ab\u4e0d\u5b9c\u6c42\u7c64\u3002' },
  confirm: { sheng: (p) => '\u83e9\u85a9\u78ba\u8a8d\uff0c\u5c31\u662f\u7b2c ' + p + ' \u7c64\u3002', xiao: (p) => '\u83e9\u85a9\u7b11\u800c\u4e0d\u7b54\uff0c\u7b2c ' + p + ' \u7c64\u4e0d\u662f\u8981\u7d66\u4f60\u7684\u90a3\u4e00\u652f\u3002', yin: (p) => '\u83e9\u85a9\u8868\u793a\u4e0d\u662f\u9019\u4e00\u652f\uff08\u7b2c ' + p + ' \u7c64\uff09\u3002' },
};
const QQ_NEXT = { invite: () => '\ud83d\ude4f \u606d\u8acb' + QIUQIAN_DEITY + '\u964d\u81e8\u2026', asking: () => '\u8acb\u975c\u5fc3\u9ed8\u5ff5\u6240\u6c42\u4e4b\u4e8b\uff0c\u6309\u4e0b\u300c\u6416\u7c64\u7b52\u300d\u3002', confirm: () => '\u5c0f\u7cbe\u9748\u6b63\u5728\u70ba\u4f60\u53d6\u7c64\u8a69\u2026' };
const QQ_CLOSING = { invite: '\u975c\u4e0b\u5fc3\u3001\u8aa0\u5fc3\u518d\u8acb\u4e00\u6b21\uff0c\u8981\u518d\u64f2\u55ce\uff1f\ud83d\ude4f', asking: '\u4e5f\u8a31\u63db\u500b\u554f\u6cd5\u6703\u66f4\u6e05\u695a\uff0c\u8981\u518d\u64f2\u4e00\u6b21\uff0c\u9084\u662f\u63db\u500b\u554f\u6cd5\uff1f', confirm: '\u9019\u652f\u7c64\u83e9\u85a9\u6c92\u6709\u9ede\u982d\uff0c\u628a\u7c64\u653e\u56de\u7c64\u7b52\u518d\u6416\u4e00\u6b21\u5427\uff1f' };
const QQ_TIP = '\u82e5\u9023\u7e8c\u591a\u6b21\u672a\u5f97\u8056\u7b4a\uff0c\u4e5f\u53ef\u4ee5\u6539\u65e5\u518d\u4f86 \ud83c\udf38';
/** This step's throws: the trailing run of throws made at the same stage, oldest first. */
export function stepThrows(session, stage) { const out = []; for (let i = session.throws.length - 1; i >= 0 && session.throws[i].stage === stage; i--) out.unshift(session.throws[i]); return out; }
/** Caption after a throw: this step's history (newest marked), what the result means, then a closing prompt per step. Always under Telegram's 1024-char caption limit. */
export function qiuqianThrowCaption(session, stage, kind) {
  const hist = stepThrows(session, stage); const n = hist.length; const shown = hist.slice(-QQ_HISTORY_MAX); const skipped = n - shown.length;
  const lines = ['\ud83e\udd62 擲筊\u7d00\u9304\uff5c' + QQ_STEP_NAME[stage], QQ_RULE];
  if (skipped) lines.push('\uff08\u524d ' + skipped + ' \u64f2\u7565\uff09');
  shown.forEach((t, i) => lines.push('\u7b2c ' + (skipped + i + 1) + ' \u64f2\u3000' + JIAO_EMOJI[t.kind] + ' ' + JIAO[t.kind].name + (t.pick ? '\uff08\u7b2c ' + t.pick + ' \u7c64\uff09' : '') + (i === shown.length - 1 ? ' \u2190 \u9019\u6b21' : '')));
  const pick = hist.at(-1)?.pick ?? session.pick;
  lines.push(QQ_RULE, JIAO_EMOJI[kind] + ' ' + JIAO[kind].name + '\uff1a' + JIAO[kind].faces + '\uff0c' + QQ_MEANING[stage][kind](pick), '');
  if (kind === 'sheng') lines.push(QQ_NEXT[stage]());
  else {
    lines.push(n === 1 ? '\u9019\u662f\u7b2c 1 \u64f2\uff0c\u5225\u7070\u5fc3\uff5e' : '\u5df2\u7d93\u64f2\u4e86 ' + n + ' \u6b21\u56c9\uff5e');
    lines.push(QQ_CLOSING[stage]);
    if (n >= QQ_FAIL_HINT_AT) lines.push(QQ_TIP);
  }
  const text = lines.join('\n'); return text.length > 1024 ? text.slice(0, 1023) + '\u2026' : text;
}

export function qiuqianSignText(sign) {
  const sy = Object.entries(sign.shengyi || {}).map(([k, v]) => `${k} ${v}`).join('｜');
  return [
    `📜 觀音靈籤　第${signNumberZh(sign.number)}籤（${sign.number}）`,
    '',
    `等第：${sign.grade}${sign.gradeAlt ? `（另本作${sign.gradeAlt}）` : ''}｜${sign.palace}`,
    `典故：${signTitle(sign)}`,
    '',
    ...sign.poem,
    '',
    `詩意：${sign.shiyi}`,
    `解曰：${sign.jieyue}`,
    ...(sy ? ['', `聖意：${sy}`] : sign.shengyiNote ? ['', `聖意：${sign.shengyiNote}`] : []),
  ].join('\n');
}

/** Follow-up question about the same 籤: full context is included even though the same GPT conversation is continued. */
export function buildQiuqianFollowupPrompt(session, sign, question) {
  const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const earlier = (session.followups || []).filter((f) => f.a).slice(-3).map((f) => `信眾追問：${clip(f.q, 200)}\n廟公回答：${clip(f.a, 600)}`).join('\n\n');
  return `（接續同一支籤）你是台灣廟裡熟悉「觀音靈籤（一百首）」的廟公，說話溫和、白話。信眾看完解籤後還有問題，請用繁體中文回答。

信眾原本向${QIUQIAN_DEITY}請示的事：
${session.question}

所抽的籤：觀音靈籤第${sign.number}籤（${sign.grade}，${sign.palace}）
籤詩（原文，請勿改動）：
${sign.poem.join('\n')}
詩意：${sign.shiyi}
解曰：${sign.jieyue}

先前的解籤：
${clip(session.reading, 2500) || '（無）'}
${earlier ? `\n先前的追問：\n${earlier}\n` : ''}
信眾現在的問題：
${question}

請只針對這個問題回答，以這支籤與先前的解籤為依據；不要更改籤號、等第或籤詩原文，也不要另外抽籤。若問題和這支籤關係不大，溫和說明並盡量從籤意給方向。不要把結果說成一定會發生；不要輸出表格或 Markdown 標題；簡潔，約 150～400 字。`;
}

export function buildQiuqianPrompt(session, sign) {
  const sy = Object.entries(sign.shengyi || {}).map(([k, v]) => `${k}：${v}`).join('；') || sign.shengyiNote || '（籤版未列）';
  return `你是台灣廟裡熟悉「觀音靈籤（一百首）」的解籤師父，說話溫和、白話、有台灣廟口解籤的味道。請用繁體中文為信眾解籤。

信眾向${QIUQIAN_DEITY}請示的事：
${session.question}

抽得並經擲筊確認：觀音靈籤第${sign.number}籤（${sign.grade}，${sign.palace}）
典故：${signTitle(sign)}
籤詩（原文，請勿改動）：
${sign.poem.join('\n')}
詩意：${sign.shiyi}
解曰：${sign.jieyue}
聖意（籤版原文）：${sy}

請依序說明：
1. 用白話逐句解釋這四句籤詩（以上面原文為準，不要改寫、增減或自創籤詩，不要更改籤號與等第）
2. 簡短說明典故與這支籤的關聯；若不確定典故內容，就直接略過，不要杜撰
3. 針對信眾請示的事，直接給出具體解讀
4. 給 3～5 點實際可行的建議
5. 最後一句溫暖的祝福

不要把結果說成一定會發生；不要輸出表格，也不要使用 Markdown 標題符號；完整但不要空泛重複。`;
}
