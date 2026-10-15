const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));

async function ready(context, url, kind) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const selector = kind === 'admin' ? page.locator('[role="tab"]').first()
      : kind === 'sheet' ? page.getByRole('button', { name: '【省時小精靈】' })
        : page.getByRole('button', { name: '建立', exact: true });
    const outcome = await Promise.any([
      selector.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'ready'),
      page.waitForURL(/\/login(?:\?|$)|accounts\.google\.com|access\.line\.me/u,
        { timeout: 15000 }).then(() => 'login'),
    ]).catch(() => 'unavailable');
    return outcome === 'ready' && !/\/login(?:\?|$)/u.test(page.url());
  } finally { await page.close(); }
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 10000 });
  let alternate;
  try {
    const primary = browser.contexts()[0];
    for (const [brand, value] of Object.entries(config.brands)) {
      let ok = await ready(primary, value.mailUrl, 'admin').catch(() => false);
      if (!ok) {
        try {
          alternate ||= await chromium.connectOverCDP('http://127.0.0.1:19385', { timeout: 10000 });
          ok = await ready(alternate.contexts()[0], value.mailUrl, 'admin');
        } catch { ok = false; }
      }
      console.log(`${brand}/admin: ${ok ? 'OK' : 'LOGIN_REQUIRED'}`);
      if (!ok) process.exitCode = 1;
    }
    const sheetOk = await ready(primary, config.spreadsheet.url, 'sheet').catch(() => false);
    console.log(`google/sheet: ${sheetOk ? 'OK' : 'LOGIN_REQUIRED'}`);
    if (!sheetOk) process.exitCode = 1;
    for (const [brand, value] of Object.entries(config.line.accounts)) {
      const ok = await ready(primary, `${value.url}/audience`, 'line').catch(() => false);
      console.log(`${brand}/line: ${ok ? 'OK' : 'LOGIN_REQUIRED'}`);
      if (!ok) process.exitCode = 1;
    }
  } finally {
    if (alternate) await alternate.close();
    await browser.close();
  }
})().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
