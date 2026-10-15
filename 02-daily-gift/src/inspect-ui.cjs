const { chromium } = require('playwright');
const url = process.argv[2];
if (!url || !/^https:\/\//.test(url)) throw new Error('請提供完整 HTTPS 頁面網址。');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const ui = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      controls: [...document.querySelectorAll('button, input, select, [role="button"], [role="tab"], a')]
        .filter(element => element.getClientRects().length)
        .map(element => ({ tag: element.tagName.toLowerCase(), role: element.getAttribute('role'),
          text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim().slice(0, 80),
          type: element.getAttribute('type'), placeholder: element.getAttribute('placeholder'), href: element.getAttribute('href') }))
        .filter(item => item.text || item.type || item.href)
        .slice(0, 160)
    }));
    console.log(JSON.stringify(ui, null, 2));
  } finally { await page.close(); await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
