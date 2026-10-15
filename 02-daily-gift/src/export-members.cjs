const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { adminLogin } = require('./ensure-logins.cjs');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
const [brand, date] = process.argv.slice(2);
const verifyOnly = process.argv.includes('--verify-only');
if (!config.brands[brand]) throw new Error('品牌代碼無效。');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('請以 YYYY-MM-DD 指定註冊日期。');

async function onLoginPage(page) {
  await Promise.race([
    page.waitForURL(/\/login(?:\?|$)/u, { timeout: 12000 }).catch(() => {}),
    page.getByRole('radio', { name: '創辦時間' }).waitFor({ state: 'visible', timeout: 12000 }).catch(() => {}),
  ]);
  return page.url().includes('/login');
}

(async () => {
  let browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 10000 });
  let context = browser.contexts()[0];
  let page = await context.newPage();
  try {
    await page.goto(config.brands[brand].playerListUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (await onLoginPage(page)) {
      // 先用 Chrome 記住的帳密自動登回本視窗；不行才改用另一個既有登入視窗。
      const relogin = await adminLogin(context, brand).catch(e => `error: ${e.message.split('\n')[0]}`);
      console.log(`${brand}: 後台登入失效，自動重新登入結果 ${relogin}。`);
      await page.goto(config.brands[brand].playerListUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    if (await onLoginPage(page)) {
      await page.close();
      await browser.close();
      try {
        browser = await chromium.connectOverCDP('http://127.0.0.1:19385', { timeout: 10000 });
      } catch {
        throw new Error(`${brand} 後台登入已失效，且另一個既有登入視窗不可用。`);
      }
      context = browser.contexts()[0];
      page = await context.newPage();
      await page.goto(config.brands[brand].playerListUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (await onLoginPage(page)) throw new Error(`${brand} 兩個既有工作階段皆需重新登入。`);
      console.log(`${brand}: 原工作階段已登出，改用另一個已登入的專用 Chrome 匯出。`);
    }
    const filter = page.getByRole('radio', { name: '創辦時間' });
    // 會員列表偶爾載入慢或沒畫出篩選：重新整理一次再等；仍沒有就截圖留證。
    if (!(await filter.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false))) {
      console.log(`${brand}: 會員列表未出現「創辦時間」，重新整理後再試一次（${page.url()}）。`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      if (await onLoginPage(page)) throw new Error(`${brand} 後台在匯出途中登出。`);
      if (!(await filter.waitFor({ state: 'visible', timeout: 30000 }).then(() => true, () => false))) {
        const shot = path.join(root, 'logs', `export-${brand}-${new Date().toISOString().replace(/[:.]/g, '-')}-no-filter.png`);
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        throw new Error(`${brand} 會員列表找不到「創辦時間」篩選（${page.url()}），截圖：${path.relative(root, shot)}`);
      }
    }
    await filter.check();
    if (!(await filter.isChecked())) throw new Error('未成功選取創辦時間篩選。');
    const times = page.locator('input[type="tel"]');
    if ((await times.count()) !== 2) throw new Error('日期輸入欄位數量變更。');
    await times.nth(0).fill(`${date} 00:00:00`);
    await times.nth(1).fill(`${date} 23:59:59`);
    await page.getByRole('button', { name: '送出' }).click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const totalText = await page.getByText(/^Total Rows:/).first().innerText();
    const total = Number(totalText.match(/Total Rows:\s*(\d+)/)?.[1]);
    if (!Number.isInteger(total)) throw new Error(`無法確認篩選結果：${totalText}`);
    const downloadButton = page.locator('button:has(svg[data-testid="SaveAltIcon"])');
    if ((await downloadButton.count()) !== 1) throw new Error('後台匯出按鈕數量變更。');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), downloadButton.click()]);
    const outDir = verifyOnly ? path.join(root, 'work', 'export-check') : path.join(root, 'inbox', brand);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${brand}-${date}${verifyOnly ? '-verify' : ''}.csv`);
    if (fs.existsSync(outPath) && !verifyOnly) throw new Error(`匯出檔已存在，拒絕覆寫：${outPath}`);
    await download.saveAs(outPath);
    if (fs.statSync(outPath).size === 0) throw new Error('匯出檔案為空。');
    console.log(`${brand} ${date}: 後台顯示 ${total} 筆；CSV 已匯出至 ${outPath}`);
  } finally {
    await page.close();
    await browser.close();
  }
})().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
