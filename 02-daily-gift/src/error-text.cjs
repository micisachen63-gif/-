// 把程式內部錯誤（Playwright、Node）轉成看得懂的中文，給 TG 通知與紀錄使用。中文錯誤原樣保留。
const METHOD_LABELS = {
  goto: '開啟網頁', reload: '重新整理網頁', waitForEvent: '等待下載檔案', waitForURL: '等待網頁跳轉',
  click: '點擊網頁按鈕', check: '勾選網頁選項', fill: '填寫網頁欄位', waitFor: '等待網頁元素出現',
  innerText: '讀取網頁文字', inputValue: '讀取網頁欄位', setInputFiles: '上傳檔案', connectOverCDP: '連線自動化專用 Chrome',
};

function humanizeError(input) {
  let text = String(input || '').replace(/\u001b\[[0-9;]*m/gu, '').split(/\r?\n/u)[0].trim();
  text = text.replace(/ERROR:\s*/gu, '');
  text = text.replace(/\b(?:locator|page|frame|elementHandle)\.\w+: Error: /gu, '');
  if (!text) return '';
  const timeout = text.match(/\b(?:locator|page|frame|browserType|elementHandle)\.(\w+): Timeout (\d+)ms exceeded[^。]*?\.?$/u);
  if (timeout) {
    const label = METHOD_LABELS[timeout[1]] || '等待網頁';
    const hint = timeout[1] === 'goto' || timeout[1] === 'connectOverCDP' ? '（網路或網站太慢）' : '（網頁載入慢、登入失效或版面改了）';
    return text.slice(0, timeout.index) + `${label}逾時 ${Math.round(Number(timeout[2]) / 1000)} 秒${hint}`;
  }
  const rules = [
    [/strict mode violation[\s\S]*?resolved to (\d+) elements[\s\S]*/u, (_m, n) => `頁面上同時出現 ${n} 個相同項目，無法判斷要點哪一個`],
    [/spawnSync \S[^\n]*? ETIMEDOUT|\bETIMEDOUT\b/u, () => '執行時間過長被中止'],
    [/connect ECONNREFUSED 127\.0\.0\.1:9222[\s\S]*|browserType\.connectOverCDP[\s\S]*/u, () => '連不上自動化專用 Chrome（9222），可能 Chrome 被關閉'],
    [/Target (?:page, context or browser )?(?:has been )?closed[\s\S]*/iu, () => '瀏覽器分頁或 Chrome 意外關閉'],
    [/net::(ERR_[A-Z_]+)[\s\S]*/u, (_m, code) => `網路連線錯誤（${code}）`],
    [/fetch failed|ENOTFOUND|ECONNRESET/u, () => '網路連線失敗'],
  ];
  for (const [pattern, replace] of rules) {
    const match = text.match(pattern);
    if (match) return text.slice(0, match.index) + replace(...match);
  }
  return text;
}

module.exports = { humanizeError };
