const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  try {
    await page.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '【茄子】新手禮包' }).click();
    await page.getByRole('button', { name: '【省時小精靈】' }).click({ force: true });
    const items = await page.locator('[role="menuitem"]').allTextContents();
    console.log(JSON.stringify({ url: page.url(), items }, null, 2));
  } finally { await page.close(); await browser.close(); }
})().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
