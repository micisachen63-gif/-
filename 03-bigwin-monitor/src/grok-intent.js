// Zero-AI intent routing for the GROK button: 'qa' (ask/lookup/advice → grok.com chat),
// 'dev' (build/fix/change/schedule → Grok Build CLI) or 'ambiguous' (ask the owner with two buttons).
const PREFIX = /^(?:\s*(?:\/ask(?:@\w+)?|開新任務|新任務|另一個任務|我要\s*(?:GPT|GROK|grok|gpt)\s*處理|交給\s*(?:GPT|GROK|grok|gpt))\s*[:：,，]?)+/i;
// Explicit request to act ("幫我加…", "能不能改…", "可以做…嗎") — wins over question marks.
const DEV_REQUEST = /(幫我|幫忙|請你?|麻煩|能不能|可不可以|可以|能否|能)\s*(?:幫我|幫忙)?\s*.{0,6}?(做|弄|改|加|新增|建立|建|修|寫|開發|排程|設定排程|部署|裝)/;
const DEV = /(新增|加入|加上|建立|創建|開發|實作|寫(?:一|個)?(?:支|個)?(?:程式|腳本|功能|script)|修正|修復|修好|修一下|修掉|改程式|改檔|改成|改為|改掉|重構|排程|定時|每天.{0,12}(?:發|跑|執行|提醒|通知|推播)|部署|安裝|上線|按鈕|功能|bug|報錯|錯誤訊息|跑不動|壞掉|程式碼|測試|\bcode\b|\bscript\b|\bfeature\b|\bfix\b|\bimplement\b|\brefactor\b|\bdeploy\b|\.js\b|\.ps1\b|\.py\b)/i;
const QA = /(\?|？|嗎|呢|什麼|甚麼|為什麼|為何|怎麼|如何|哪裡|哪個|哪些|哪家|多少|幾點|幾個|是否|是不是|有沒有|請問|查一下|查詢|查查|搜尋|找一下|推薦|建議|意見|解釋|說明|比較|翻譯|總結|摘要|介紹|分析|天氣|新聞|行情|股價|意思|差別|差異)/;

// Opens like a question to Grok and is not an explicit build request: treat as Q&A.
const QA_LEAD = /^(請問|想問|問一下|問問|請教|想請教|好奇)/;

export function stripTaskPrefix(text) { return String(text || '').replace(PREFIX, '').trim(); }

export function classifyGrokIntent(text) {
  const s = stripTaskPrefix(text);
  if (!s) return 'ambiguous';
  if (DEV_REQUEST.test(s) && DEV.test(s)) return 'dev';
  if (QA_LEAD.test(s)) return 'qa';
  const dev = DEV.test(s), qa = QA.test(s);
  if (dev && !qa) return 'dev';
  if (qa && !dev) return 'qa';
  return 'ambiguous';
}

export function grokQaPrompt(text, conversationTitle) {
  return `請以親切、俐落的繁體中文「小精靈助手」口吻回答，不必說明這項口吻要求；若使用者指定語言、格式或只回覆特定內容，優先完全遵照。本對話只服務 Telegram 使用者「${conversationTitle}」，只根據目前這個對話的訊息作答。這是一般提問，不需要也不要輸出任何工具指令或 JSON。\n\n使用者問題：\n${stripTaskPrefix(text) || text}`;
}

// Decide and, for Q&A, answer. Returns {kind:'choose'} | {kind:'qa',text} | {kind:'dev'}.
// intent comes from a ❓/🛠 button click and always wins over the keyword rules.
export async function grokTaskRoute({ text, intent, conversationTitle, askGrokWeb }) {
  const kind = intent === 'qa' || intent === 'dev' ? intent : classifyGrokIntent(text);
  if (kind === 'ambiguous') return { kind: 'choose' };
  if (kind === 'dev') return { kind: 'dev' };
  const answer = await askGrokWeb(grokQaPrompt(text, conversationTitle));
  const reply = String(typeof answer === 'string' ? answer : answer?.text ?? '').trim();
  if (!reply) throw new Error('GROK 網頁沒有回傳內容');
  return { kind: 'qa', text: reply };
}
