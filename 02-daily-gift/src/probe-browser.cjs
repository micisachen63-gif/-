const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 10000 });
  const contexts = browser.contexts();
  const pages = contexts.flatMap(context => context.pages());
  const spreadsheet = pages.find(page => page.url().startsWith('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/'));
  if (!spreadsheet) throw new Error('未找到新手禮包試算表分頁。');
  const title = await spreadsheet.title();
  if (!title.includes('全產品新手禮包-發送工具')) throw new Error(`Google 登入可能已失效：${title}`);
  console.log('Google 試算表可由本機程式讀取，登入有效。');
  console.log(`目前可見分頁數：${pages.length}`);
  await browser.close();
})().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
