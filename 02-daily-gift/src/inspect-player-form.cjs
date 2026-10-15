const { chromium } = require('playwright');
const url = process.argv[2];
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = await browser.contexts()[0].newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByRole('radio', { name: '創辦時間' }).check();
    const result = await page.evaluate(() => ({
      inputs: [...document.querySelectorAll('input')].filter(e => e.getClientRects().length).map(e => ({ outerHTML: e.outerHTML.slice(0, 400) })),
      buttons: [...document.querySelectorAll('button')].filter(e => e.getClientRects().length).map(e => ({ text: e.innerText.trim(), svg: e.querySelector('svg')?.getAttribute('data-testid'), outerHTML: e.outerHTML.slice(0, 400) })).filter(e => ['送出','', '近一小時在線'].includes(e.text)).slice(-10)
    }));
    console.log(JSON.stringify(result, null, 2));
  } finally { await page.close(); await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
