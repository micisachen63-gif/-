import path from 'node:path';
import { chromium } from 'playwright';
import { config } from './config.js';

const context = await chromium.launchPersistentContext(config.profilePath, {
  channel: 'chrome', headless: true, viewport: { width: 1440, height: 900 },
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.gameUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('a.game-item').first().waitFor({ state: 'attached', timeout: 60000 });
  const before = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 90);
    return { hit: el?.outerHTML.slice(0, 600) || '', closeCount: document.querySelectorAll('.page-modal-close').length, modalCount: document.querySelectorAll('[id^="page-modal"], .page-modal').length };
  });
  console.log('彈窗診斷前：' + JSON.stringify(before));
  let quiet = 0;
  for (let attempt = 0; attempt < 25 && quiet < 4; attempt++) {
    const close = page.frameLocator('#page-modal0 iframe').locator('.page-modal-close').locator('visible=true').first();
    if (await close.count()) {
      await close.click({ timeout: 5000 });
      quiet = 0;
    } else {
      quiet++;
    }
    await page.waitForTimeout(1000);
  }
  const after = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 90);
    return { hit: el?.outerHTML.slice(0, 600) || '', closeCount: document.querySelectorAll('.page-modal-close').length, modalCount: document.querySelectorAll('[id^="page-modal"], .page-modal').length };
  });
  console.log('彈窗診斷後：' + JSON.stringify(after));
  const box = page.getByPlaceholder('請輸入遊戲名稱');
  await box.waitFor({ state: 'visible', timeout: 60000 });
  const keyword = process.argv[2] || '賽特';
  await box.fill(keyword);
  await page.waitForTimeout(2500);
  quiet = 0;
  for (let attempt = 0; attempt < 15 && quiet < 3; attempt++) {
    const close = page.frameLocator('#page-modal0 iframe').locator('.page-modal-close').locator('visible=true').first();
    if (await close.count()) { await close.click({ timeout: 5000 }); quiet = 0; }
    else quiet++;
    await page.waitForTimeout(1000);
  }
  const data = await page.locator('a.game-item').evaluateAll((nodes) => nodes.map((el, index) => {
    const image = el.querySelector('img');
    const rect = el.getBoundingClientRect();
    return { index, label: (el.innerText || '').slice(0, 50), title: el.title || '', imageAlt: image?.alt || '', imagePath: image ? new URL(image.src).pathname : '', visible: rect.width > 0 && rect.height > 0, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
  }));
  console.log(JSON.stringify({ keyword, cards: data.filter((item) => item.visible && item.w >= 130) }, null, 2));
  if (process.argv.includes('--probe')) {
    const targetCard = data.find((item) => item.visible && item.w >= 130);
    if (!targetCard) throw new Error('搜尋結果沒有可探測的大圖');
    const target = page.locator('a.game-item').nth(targetCard.index);
    await target.evaluate((el) => (el.querySelector('img') || el).click());
    await page.waitForTimeout(3500);
    const probe = await page.evaluate(() => ({
      frameCount: document.querySelectorAll('iframe[src*="egames"], iframe[src*="godeebxp"]').length,
      visibleDialogs: Array.from(document.querySelectorAll('[id^="page-modal"], .page-modal'))
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map((el) => (el.innerText || '').slice(0, 150)),
    }));
    console.log('進場探測：' + JSON.stringify(probe));
  }
  const screenshot = path.join(config.projectRoot, '.auth', 'search-diagnostic.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`截圖：${screenshot}`);
} finally {
  await context.close();
}
