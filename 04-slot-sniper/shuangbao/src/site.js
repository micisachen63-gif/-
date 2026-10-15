import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { gameDefinitions } from './config.js';

const FRAME_SELECTOR = [
  'iframe[src*="play.godeebxp.com/egames/"]',
  'iframe[src*="/egames/"]',
  'iframe[src*="godeebxp"]',
  'iframe.game-iframe',
  'iframe[src*="slot"]',
].join(', ');

function releaseChromeProfile(profilePath) {
  // Only touch Chrome that uses THIS project's --user-data-dir. Never kill the user's normal browser.
  if (process.platform === 'win32') {
    const marker = profilePath.replace(/\//g, '\\');
    const ps = `
$marker = ${JSON.stringify(marker)}
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $cmd = $_.CommandLine
  if (-not $cmd) { return }
  # Require the profile path AND user-data-dir so we never match a normal Chrome window.
  if ($cmd.Contains('--user-data-dir=') -and $cmd.Contains($marker)) {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Milliseconds 500
`;
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
        stdio: 'ignore',
        timeout: 20000,
        windowsHide: true,
      });
    } catch {
      // Best-effort; launch retry still follows.
    }
  }
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
    const lockPath = path.join(profilePath, name);
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

async function browserContext(config, headless, interactiveLogin = false) {
  fs.mkdirSync(config.profilePath, { recursive: true });
  // Headed runs must use normal Chrome display args. SwiftShader is only for headless.
  const headed = interactiveLogin || !headless;
  // Fixed mobile viewport — maximized wide window made lobby a skinny center column
  // and clicks/scroll felt like they "ran to the right".
  const launchOptions = {
    channel: 'chrome',
    headless: !headed,
    viewport: { width: 430, height: 900 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    args: headed
      ? ['--disable-blink-features=AutomationControlled']
      : ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: headed
      ? ['--enable-unsafe-swiftshader', '--enable-automation']
      : ['--enable-automation'],
  };
  console.log(`啟動 Chrome（${headed ? '有畫面' : '無畫面'}）…`);
  releaseChromeProfile(config.profilePath);
  try {
    return await chromium.launchPersistentContext(config.profilePath, launchOptions);
  } catch (error) {
    console.log(`Chrome 啟動失敗，清 profile 鎖後重試：${error.message.split('\n')[0]}`);
    releaseChromeProfile(config.profilePath);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return chromium.launchPersistentContext(config.profilePath, launchOptions);
  }
}

async function waitForLobbyIdle(page, timeout = 60000) {
  // Wait for lobby loading overlay to clear — do NOT hide it via DOM hacks
  // (that was causing 資料錯誤(-1) on game enter while manual clicks still worked).
  const loading = page.locator('div.loading');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const visible = await loading.isVisible().catch(() => false);
    if (!visible) {
      await page.waitForTimeout(250);
      if (!(await loading.isVisible().catch(() => false))) return;
    }
    await page.waitForTimeout(300);
  }
  console.log('大廳 loading 等待逾時，繼續嘗試（不強制隱藏 DOM）。');
}

// LINE 已記住帳號時，登入頁只有一顆「登入」鈕：自動按下，不必人工登入。
async function waitForLobby(page, timeout = 60000) {
  const deadline = timeout > 0 ? Date.now() + timeout : Infinity;
  let clicks = 0;
  while (Date.now() < deadline) {
    if (await page.locator('.Lobby').isVisible().catch(() => false)) return;
    if (page.url().includes('access.line.me')) {
      const hasPassword = await page.locator('input[type="password"]').isVisible().catch(() => false);
      const loginButton = page.locator('button').filter({ hasText: /^\s*(登入|Log in|ログイン)\s*$/ }).first();
      if (!hasPassword && clicks < 3 && await loginButton.isVisible().catch(() => false)) {
        clicks += 1;
        console.log(`[site] 偵測到 LINE 登入頁（已記住帳號），自動按「登入」第 ${clicks} 次`);
        await loginButton.click().catch(() => {});
        await page.waitForTimeout(3000);
        continue;
      }
      if (hasPassword && timeout > 0) {
        throw new Error('LINE 要求重新輸入帳號密碼（記住的登入已失效）；請執行 npm run login 手動登入一次');
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`等不到遊戲大廳（${Math.round(timeout / 1000)} 秒）；目前網址：${page.url().slice(0, 100)}`);
}

// 大廳彈窗：一般廣告（AdNormal）有關閉鈕，直接按。
// 「每日抽抽樂」（ActivityLottery）沒有關閉鈕：照手動做法點一張卡，再一直點同一個位置直到活動頁結束（每天只出現一次）。
async function closeLobbyModal(page) {
  const modal = page.locator('#page-modal0');
  const closeBtn = page.frameLocator('#page-modal0 iframe').locator('.page-modal-close').first();
  // 不在 iframe 裡的彈窗（例如「首儲優惠」儲值廣告）：關閉鈕直接在頁面上，只按關閉鈕，絕不點儲值選項。
  const directClose = modal.locator(':scope > .page-modal-dialog .page-modal-close').first();
  if (await directClose.isVisible().catch(() => false)) {
    console.log('[site] 關閉大廳彈窗（頁面內關閉鈕）');
    await directClose.click({ timeout: 10000 }).catch(() => {});
    return;
  }
  const hasClose = await closeBtn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
  if (hasClose) {
    await closeBtn.click({ timeout: 10000 }).catch(() => {});
    return;
  }
  const src = (await page.locator('#page-modal0 iframe').first().getAttribute('src').catch(() => '')) || '';
  const name = src.split('?')[0].split('/').pop() || '未知';
  if (src.includes('ActivityLottery')) {
    const box = await modal.boundingBox();
    if (!box) return;
    // 上排中間那張卡（畫面置中，約在高度 39% 的位置）。
    const x = box.x + box.width * 0.5;
    const y = box.y + box.height * 0.39;
    console.log('[site] 偵測到「每日抽抽樂」，點一張卡並連點同一位置結束活動頁');
    const shot = async () => {
      const buf = await modal.screenshot({ timeout: 5000 }).catch(() => null);
      return buf ? crypto.createHash('sha1').update(buf).digest('hex') : null;
    };
    let lastShot = null;
    let same = 0;
    for (let i = 0; i < 25; i++) {
      if (!(await modal.isVisible().catch(() => false))) {
        console.log(`[site] 「每日抽抽樂」已結束（點了 ${i} 下）`);
        return;
      }
      await page.mouse.click(x, y);
      await page.waitForTimeout(800);
      // 畫面完全沒變（例如被別的對話框擋住）就提早放棄，不要每次都點滿 25 下
      const h = await shot();
      same = h && h === lastShot ? same + 1 : 0;
      lastShot = h;
      if (same >= 5) throw new Error(`「每日抽抽樂」點了 ${i + 1} 下畫面都沒變化，先略過`);
    }
    if (await modal.isVisible().catch(() => false)) throw new Error('「每日抽抽樂」點了 25 下仍未結束');
    return;
  }
  try {
    fs.mkdirSync('logs', { recursive: true });
    await page.screenshot({ path: 'logs/unknown-modal.png' }).catch(() => {});
    const html = await modal.evaluate((el) => el.outerHTML.slice(0, 20000)).catch((e) => String(e));
    const text = await modal.innerText().catch(() => '');
    fs.writeFileSync('logs/unknown-modal.txt', 'SRC=' + src + '\nTEXT=' + text + '\nHTML=' + html, 'utf8');
  } catch {}
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  if (await modal.isVisible().catch(() => false)) throw new Error(`大廳彈窗沒有關閉鈕，關不掉（${name}）`);
}

// 十月起大廳會疊很多層活動彈窗（#page-modal0、#page-modal1…）。由最上層開始，只按該彈窗自己的關閉 X；
// 絕不按儲值／購買／領取／前往等按鈕。只有沒有任何付款項目、且只能按「確認」的彈窗，才按它自己的「確認」。
const MODAL_SELECTOR = '[id^="page-modal"], .page-modal';
// 關閉 X 可能在彈窗下方（十月活動彈窗），所以只認 class／role／文字，不看位置。
const CLOSE_SELECTOR = [
  '.page-modal-close', '.btn-close', 'button.close', '.icon-close', '[class*="modal-close"]', '[class*="btn-close"]',
  '[aria-label="Close" i]', '[aria-label="關閉"]', '[title="關閉"]', 'img[alt*="close" i]', 'img[alt*="關閉"]',
].join(', ');
const PAY_SELECTOR = '.pay-item, .btn-cart';
const FORBIDDEN_TEXT = /儲值|購買|領取|前往|付款|結帳/;

async function visibleModals(page) {
  const all = page.locator(MODAL_SELECTOR).locator('visible=true');
  const n = await all.count().catch(() => 0);
  const list = [];
  for (let i = 0; i < n; i++) {
    const loc = all.nth(i);
    const meta = await loc.evaluate((el) => {
      const z = Number.parseInt(getComputedStyle(el).zIndex, 10);
      const outer = el.parentElement ? el.parentElement.closest('[id^="page-modal"], .page-modal') : null;
      return { id: el.id || '', z: Number.isNaN(z) ? 0 : z, nested: Boolean(outer) };
    }).catch(() => null);
    if (meta && !meta.nested) list.push({ loc, order: i, ...meta });
  }
  // 最上層：z-index 最大，同層取 DOM 中較後面的
  list.sort((a, b) => a.z - b.z || a.order - b.order);
  return list;
}

async function clickModalClose(top) {
  // 任何位置（含彈窗下方）的關閉元素；排除在付款項目裡、或文字含儲值／購買等的元素
  const candidates = top.loc.locator(CLOSE_SELECTOR)
    .or(top.loc.getByRole('button', { name: /^(×|✕|X|關閉)$/ }))
    .locator('visible=true');
  const n = await candidates.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const el = candidates.nth(i);
    const safe = await el.evaluate((node, forbidden) => !node.closest('.pay-item, .btn-cart')
      && !new RegExp(forbidden).test(node.textContent || ''), FORBIDDEN_TEXT.source).catch(() => false);
    if (!safe) continue;
    await el.click({ timeout: 5000 });
    return 'X';
  }
  const inFrame = top.loc.frameLocator('iframe').first().locator('.page-modal-close').locator('visible=true').first();
  if (await inFrame.count().catch(() => 0)) {
    await inFrame.click({ timeout: 5000 });
    return 'X(iframe)';
  }
  const hasPay = (await top.loc.locator(PAY_SELECTOR).count().catch(() => 0)) > 0;
  const text = await top.loc.innerText({ timeout: 3000 }).catch(() => '');
  if (!hasPay && !FORBIDDEN_TEXT.test(text)) {
    const ok = top.loc.getByRole('button', { name: '確認', exact: true }).locator('visible=true').last();
    if (await ok.count().catch(() => 0)) {
      await ok.click({ timeout: 5000 });
      return '確認';
    }
  }
  return null;
}

/** Closes stacked lobby popups from the top. Returns how many were closed. */
async function closeStackedModals(page, { max = 20 } = {}) {
  let closed = 0;
  let stale = 0;
  let lastSig = '';
  for (let i = 0; i < max; i++) {
    const modals = await visibleModals(page);
    if (!modals.length) break;
    const top = modals.at(-1);
    const topText = await top.loc.innerText({ timeout: 3000 }).catch(() => '');
    if (/快速轉點/.test(topText)) break; // 進遊戲用的轉點視窗，不在這裡處理
    const sig = `${modals.length}|${modals.map((m) => m.id).join(',')}`;
    let how = null;
    try { how = await clickModalClose(top); } catch (error) { how = null; }
    if (!how) {
      // 沒有關閉 X（例如每日抽抽樂、未知彈窗）：交給原本的單一彈窗處理，之後停止
      if (top.id === 'page-modal0') await closeLobbyModal(page).catch((error) => console.log(`大廳彈窗：${error.message}`));
      else console.log(`[site] 彈窗 #${top.id || '?'} 沒有可按的關閉鈕，停止自動關閉`);
      break;
    }
    await page.waitForTimeout(400);
    const after = await visibleModals(page);
    const afterSig = `${after.length}|${after.map((m) => m.id).join(',')}`;
    if (after.length < modals.length || afterSig !== sig) { closed++; stale = 0; } else { stale++; }
    lastSig = afterSig;
    if (stale >= 3) { console.log(`[site] 彈窗 #${top.id || '?'} 按了 3 次沒有變化，停止自動關閉`); break; }
  }
  const left = (await visibleModals(page)).length;
  if (closed || left) console.log(`[site] 大廳彈窗：關閉 ${closed} 個，剩 ${left} 個`);
  return closed;
}

async function dismissLobbyAds(page) {
  await page.locator('a.game-item').first().waitFor({ state: 'attached', timeout: 60000 });
  await waitForLobbyIdle(page, 60000);
  const ad = page.locator('#page-modal0');
  await ad.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
  if (await page.getByText('快速轉點', { exact: true }).isVisible().catch(() => false)) return;
  await closeStackedModals(page);
  await waitForLobbyIdle(page, 15000);
  for (let index = 0; index < 8 && await ad.isVisible().catch(() => false); index++) {
    const closeError = await closeLobbyModal(page).then(() => null, (error) => error);
    if (closeError) {
      console.log(`大廳彈窗：${closeError.message}`);
      // 抽抽樂關不掉時不要重複點 8 輪（之前每輪約 20 秒），改按 Escape 後繼續
      if (/抽抽樂/.test(closeError.message)) break;
    }
    await closeStackedModals(page);
    await page.waitForTimeout(400);
    await waitForLobbyIdle(page, 15000);
  }
  if (await ad.isVisible().catch(() => false)) {
    console.log('大廳廣告仍在，改按 Escape 後繼續（不強制改 DOM）。');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.locator('.mask-transparent').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  await waitForLobbyIdle(page, 20000);
}

/** Click through 快速轉點 with the default amount — do not edit the field. */
async function confirmTransferAndEnter(page) {
  const modal = page.locator('.page-modal, #page-modal0').filter({ hasText: '快速轉點' }).first();
  await modal.waitFor({ state: 'visible', timeout: 15000 });
  const confirm = modal.getByRole('button', { name: '確定並進入遊戲' });
  await confirm.waitFor({ state: 'visible', timeout: 10000 });
  console.log('快速轉點：直接按「確定並進入遊戲」。');
  await confirm.click();
  await modal.waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
}

/** Visible 「資料錯誤」 text only (hidden copies in other page-modals must not count). */
function visibleDataError(page) {
  return page.getByText('資料錯誤', { exact: false }).locator('visible=true').first();
}

/**
 * Closes the visible 「資料錯誤」 dialog(s): only the top-most visible page-modal that contains 資料錯誤,
 * only its own exact 「確認」 button, never a dialog with pay/cart/儲值 items. Up to 3 stacked dialogs.
 */
async function dismissDataErrorIfAny(page) {
  if (!(await visibleDataError(page).isVisible().catch(() => false))) return false;
  console.log('偵測到「資料錯誤」彈窗，按該對話框的確認後重試。');
  for (let i = 0; i < 3; i++) {
    const dialogs = page.locator('[id^="page-modal"], .page-modal, [role="dialog"]')
      .locator('visible=true')
      .filter({ hasText: '資料錯誤' })
      .filter({ hasNot: page.locator('.pay-item, .btn-cart') })
      .filter({ hasNotText: '儲值' });
    const count = await dialogs.count().catch(() => 0);
    if (!count) break;
    const top = dialogs.last();
    const button = top.getByRole('button', { name: '確認', exact: true }).locator('visible=true').last();
    if (!(await button.count().catch(() => 0))) {
      throw new Error('資料錯誤彈窗找不到可見的「確認」鈕');
    }
    await button.click({ timeout: 10000 });
    await page.waitForTimeout(800);
  }
  if (await visibleDataError(page).isVisible().catch(() => false)) {
    throw new Error('資料錯誤彈窗按了確認仍未關閉');
  }
  return true;
}

async function pinLobbyScroll(page) {
  // Only zero horizontal scroll — never change overflow/style (that caused 資料錯誤).
  await page.evaluate(() => {
    const zero = (el) => {
      try { if (el && 'scrollLeft' in el) el.scrollLeft = 0; } catch (_) {}
    };
    zero(document.scrollingElement);
    zero(document.documentElement);
    zero(document.body);
    zero(document.querySelector('.Lobby'));
    zero(document.querySelector('.lobby'));
    zero(document.querySelector('#app'));
    zero(document.querySelector('main'));
    for (const el of document.querySelectorAll('*')) {
      try { if (el.scrollLeft > 0) el.scrollLeft = 0; } catch (_) {}
    }
    window.scrollTo(0, window.scrollY || 0);
  }).catch(() => {});
}

async function disableHorizontalScrollIntoView(page) {
  // Playwright/browser scrollIntoView defaults can use inline centering and yank the
  // category tab strip left/right. Force inline:nearest for this page only.
  await page.evaluate(() => {
    if (window.__sbInlineNearest) return;
    window.__sbInlineNearest = true;
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function(opts) {
      if (opts === true) opts = { block: 'start', inline: 'nearest' };
      else if (!opts || opts === false) opts = { block: 'nearest', inline: 'nearest' };
      else if (typeof opts === 'object') opts = { ...opts, inline: 'nearest' };
      return orig.call(this, opts);
    };
  }).catch(() => {});
}

async function enterGameViaLobby(page, config, game) {
  // Manual flow: search keyword → click the large first result.
  // Force-refresh lobby once so layout is pristine, then never yank left/right.
  await page.goto(config.gameUrl, { waitUntil: 'domcontentloaded' });
  await waitForLobby(page, 60000);
  console.log('大廳已出現，強制重整一次回到原始畫面…');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForLobby(page, 60000);
  await disableHorizontalScrollIntoView(page);
  await pinLobbyScroll(page);
  await dismissLobbyAds(page);
  await waitForLobbyIdle(page, 45000);
  await pinLobbyScroll(page);

  const keyword = game.search || game.name || '';
  const searchBox = page.getByPlaceholder('請輸入遊戲名稱');
  await searchBox.waitFor({ state: 'visible', timeout: 20000 });
  // Focus without letting the page horizontally center the field.
  await searchBox.evaluate((el) => { el.focus(); });
  await pinLobbyScroll(page);
  await searchBox.fill('');
  await searchBox.fill(keyword);
  await pinLobbyScroll(page);
  console.log(`搜尋「${keyword}」…`);
  await page.waitForTimeout(1000);
  await waitForLobbyIdle(page, 20000);
  await pinLobbyScroll(page);

  await page.locator('a.game-item').first().waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(500);

  // Prefer a tile fully inside the viewport; else the largest that intersects it.
  // Partially-visible bottom tiles used to be picked and then fail Playwright clicks.
  const pickIndex = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('a.game-item'));
    const vh = window.innerHeight;
    const candidates = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) continue;
      if (r.bottom <= 0 || r.top >= vh) continue; // no intersection
      const area = r.width * r.height;
      const fullyIn = r.top >= 70 && r.bottom <= vh - 40;
      candidates.push({ i, area, fullyIn });
    }
    if (!candidates.length) return -1;
    const full = candidates.filter((c) => c.fullyIn);
    const pool = full.length ? full : candidates;
    pool.sort((a, b) => b.area - a.area);
    return pool[0].i;
  });
  if (pickIndex < 0) {
    throw new Error(`搜尋「${keyword}」後找不到可見的遊戲大圖`);
  }

  await pinLobbyScroll(page);
  const card = page.locator('a.game-item').nth(pickIndex);
  const label = ((await card.innerText().catch(() => '')) || '').split('\n')[0].trim();
  console.log(`點搜尋大圖「${game.name}」#${pickIndex}${label ? `（${label}）` : ''}`);

  const img = card.locator('img').first();
  async function clickResult() {
    await pinLobbyScroll(page);
    // Vertical center is OK; inline:nearest keeps the category strip from yanking sideways.
    await card.evaluate((el) => {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }).catch(() => {});
    await pinLobbyScroll(page);
    await page.waitForTimeout(200);

    // DOM click first — avoids Playwright "element is outside of the viewport" retries.
    const clicked = await card.evaluate((el) => {
      const target = el.querySelector('img') || el;
      try {
        target.click();
        return true;
      } catch (_) {
        return false;
      }
    }).catch(() => false);

    if (!clicked) {
      if (await img.count()) {
        await img.click({ timeout: 10000, force: true });
      } else {
        await card.click({ timeout: 10000, force: true });
      }
    }
    await pinLobbyScroll(page);
  }
  await clickResult();

  const frameLocator = page.locator(FRAME_SELECTOR).first();
  const transfer = page.getByText('快速轉點', { exact: true });
  let entered = false;
  for (let attempt = 1; attempt <= 3 && !entered; attempt++) {
    const next = await Promise.race([
      frameLocator.waitFor({ state: 'attached', timeout: 45000 }).then(() => 'game'),
      transfer.waitFor({ state: 'visible', timeout: 45000 }).then(() => 'transfer'),
      visibleDataError(page).waitFor({ state: 'visible', timeout: 45000 }).then(() => 'error'),
    ]).catch(() => 'timeout');

    if (next === 'game') {
      entered = true;
      break;
    }
    if (next === 'transfer') {
      await confirmTransferAndEnter(page);
      await frameLocator.waitFor({ state: 'attached', timeout: 60000 });
      entered = true;
      break;
    }
    if (next === 'error') {
      await dismissDataErrorIfAny(page);
      await closeStackedModals(page);
      console.log(`資料錯誤，再點同一張大圖（${attempt}/3）`);
      await waitForLobbyIdle(page, 10000);
      await clickResult();
      continue;
    }
    console.log(`進場逾時，再點同一張大圖（${attempt}/3）`);
    await clickResult();
  }

  if (!entered) {
    const srcs = await page.locator('iframe').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('src')));
    console.log(`未等到遊戲 iframe。目前頁上 iframe：${JSON.stringify(srcs)}`);
    throw new Error(`搜尋進「${game.name}」失敗`);
  }
  if (await dismissDataErrorIfAny(page)) {
    throw new Error('進入遊戲後仍出現資料錯誤(-1)；請確認手動搜尋進同一款是否正常');
  }

  const url = await frameLocator.getAttribute('src');
  if (!url) throw new Error('遊戲畫面沒有網址');
  const parsed = new URL(url, page.url());
  const gn = parsed.searchParams.get('gn');
  if (gn && game.key && gn !== game.key) {
    console.log(`提醒：遊戲參數 gn=${gn}（設定 key=${game.key}），爽爆端可能不同，繼續掃台。`);
  }
  return parsed.href;
}

async function captureLaunchUrlForGame(page, config, game) {
  return enterGameViaLobby(page, config, game);
}

function saveLaunchUrl(config, captured, gameName, href) {
  captured[gameName] = href;
  fs.mkdirSync(path.dirname(config.launchUrlsPath), { recursive: true });
  fs.writeFileSync(config.launchUrlsPath, JSON.stringify(captured, null, 2), { mode: 0o600 });
}

export async function captureGameUrls(config) {
  const context = await browserContext(config, false, true);
  const captured = fs.existsSync(config.launchUrlsPath)
    ? JSON.parse(fs.readFileSync(config.launchUrlsPath, 'utf8')) : {};
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(config.gameUrl, { waitUntil: 'domcontentloaded' });
    console.log('如需 LINE 登入，請在開啟的 Chrome 視窗完成；程式會自動接續。');
    await waitForLobby(page, 0);
    for (const game of gameDefinitions) {
      const href = await captureLaunchUrlForGame(page, config, game);
      saveLaunchUrl(config, captured, game.name, href);
      console.log(`已記錄「${game.name}」登入網址。`);
    }
    console.log('三款遊戲的登入資料已儲存在本機 .auth 目錄。');
  } finally {
    await context.close();
  }
}

async function gameFrame(page) {
  const element = await page.waitForSelector(FRAME_SELECTOR, { timeout: 60000 });
  const frame = await element.contentFrame();
  if (!frame) throw new Error('遊戲 iframe 尚未就緒');
  return frame;
}

async function dismissBalanceError(frame) {
  const error = frame.getByText('查詢用戶及餘額錯誤');
  if (!(await error.isVisible().catch(() => false))) return false;
  await frame.getByRole('button', { name: '確定' }).click().catch(() => {});
  return true;
}

async function clickStartGame(frame, attempt = 0) {
  const page = frame.page();
  const canvas = frame.locator('#GameCanvas');
  await canvas.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const box = await canvas.boundingBox();
  if (!box) return false;
  // Mid-lower orange-brown 「開始遊戲」 (~ lower third). Spots cover 虎小妹 / 巴風特 / 賽特.
  // Cocos under mobile canvas often ignores a single input path — fire tap + touch + click + DOM events.
  const spots = [
    [0.50, 0.86], [0.50, 0.82], [0.50, 0.78], [0.50, 0.90],
    [0.50, 0.74], [0.50, 0.70], [0.50, 0.68], [0.48, 0.86],
    [0.52, 0.86], [0.50, 0.88], [0.45, 0.84], [0.55, 0.84],
  ];
  const [xr, yr] = spots[attempt % spots.length];
  const localX = box.width * xr;
  const localY = box.height * yr;
  const absX = box.x + localX;
  const absY = box.y + localY;
  console.log(`點「開始遊戲」（x=${xr.toFixed(2)}, y=${yr.toFixed(2)}）`);

  await canvas.tap({ position: { x: localX, y: localY }, force: true }).catch(() => {});
  await page.touchscreen.tap(absX, absY).catch(() => {});
  await canvas.click({ position: { x: localX, y: localY }, force: true }).catch(() => {});
  await page.mouse.click(absX, absY, { delay: 40 }).catch(() => {});
  await frame.evaluate(({ xr, yr }) => {
    const el = document.querySelector('#GameCanvas');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width * xr;
    const clientY = rect.top + rect.height * yr;
    const opts = { bubbles: true, cancelable: true, clientX, clientY, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'touch', buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'touch', buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', opts));
    if (typeof Touch !== 'undefined' && typeof TouchEvent !== 'undefined') {
      try {
        const touch = new Touch({
          identifier: 1,
          target: el,
          clientX,
          clientY,
          pageX: clientX + window.scrollX,
          pageY: clientY + window.scrollY,
          radiusX: 2.5,
          radiusY: 2.5,
          rotationAngle: 0,
          force: 0.5,
        });
        const tOpts = {
          bubbles: true,
          cancelable: true,
          touches: [touch],
          targetTouches: [touch],
          changedTouches: [touch],
          view: window,
        };
        el.dispatchEvent(new TouchEvent('touchstart', tOpts));
        el.dispatchEvent(new TouchEvent('touchend', { ...tOpts, touches: [], targetTouches: [] }));
      } catch (_) {}
    }
  }, { xr, yr }).catch(() => {});
  return true;
}

async function readGameLink(frame) {
  return frame.evaluate(() => {
    const datas = window.App?.senderManager?._datas;
    const keys = [];
    let connectedKey = null;
    if (datas && typeof datas.forEach === 'function') {
      datas.forEach((value, key) => {
        keys.push(String(key));
        if (value?.service?.isConnected === true && !connectedKey) connectedKey = String(key);
      });
    }
    const loadingNode = window.App?.gameLoading?.node?.active === true;
    const loadingBar = window.App?.gameLoading?.bar?.node?.active === true;
    return {
      keys,
      connectedKey,
      connected: Boolean(connectedKey),
      readyToEnter: loadingNode && !loadingBar,
      loadingDone: window.App?.gameLoading?.node?.active === false,
      loadingNode,
      loadingBar,
      hasCanvas: Boolean(document.querySelector('#GameCanvas')),
    };
  }).catch(() => ({
    keys: [], connectedKey: null, connected: false,
    readyToEnter: false, loadingDone: false, loadingNode: false, loadingBar: false,
    hasCanvas: false,
  }));
}

async function probeRoomApi(frame, senderKey = 'g1007') {
  return frame.evaluate(async (key) => {
    const datas = window.App?.senderManager?._datas;
    let sender = datas?.get?.(key);
    if (!sender?.service?.isConnected && datas && typeof datas.forEach === 'function') {
      datas.forEach((value) => {
        if (!sender?.service?.isConnected && value?.service?.isConnected === true) sender = value;
      });
    }
    if (!sender?.service?.isConnected) return { ok: false, reason: 'not-connected' };
    try {
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 8000);
        sender.send('getSlotTables', { request: 'getSlotTables', page: 1 }, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
      if (response?.status === 200 && Array.isArray(response?.data?.tables)) {
        return { ok: true, tables: response.data.tables.length };
      }
      return { ok: false, reason: `status-${response?.status ?? 'none'}` };
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) };
    }
  }, senderKey).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
}

async function waitUntilGameReady(frame) {
  console.log('[site] 選房就緒檢查 v8：等開場離開 splash，連線穩定後再掃空桌');
  const deadline = Date.now() + 150_000;
  let clickAttempts = 0;
  let canvasSeenAt = 0;
  let firstClickAt = 0;
  let lastHeartbeat = 0;
  let barGoneAt = 0;
  let connectedSince = 0;
  while (Date.now() < deadline) {
    if (await dismissBalanceError(frame)) {
      throw new Error('遊戲回報「查詢用戶及餘額錯誤」；可能是重複載入登入網址。請重跑 dry-run（已改為大廳進入後不重載）。');
    }
    if (await frame.getByText('找不到 Token 資料').isVisible().catch(() => false)) {
      throw new Error('遊戲登入 Token 已失效；請重新執行 npm run login');
    }
    const state = await readGameLink(frame);
    if (state.hasCanvas && !canvasSeenAt) canvasSeenAt = Date.now();
    if (state.hasCanvas && !state.loadingBar) {
      if (!barGoneAt) barGoneAt = Date.now();
    } else {
      barGoneAt = 0;
    }
    if (state.connected) {
      if (!connectedSince) connectedSince = Date.now();
    } else {
      connectedSince = 0;
    }

    if (Date.now() - lastHeartbeat > 8000) {
      console.log(
        `[site] 連線狀態 connected=${state.connected} key=${state.connectedKey ?? '-'}`
        + ` keys=[${state.keys.join(',')}] clicks=${clickAttempts}`
        + ` loadingBar=${state.loadingBar} loadingDone=${state.loadingDone} readyToEnter=${state.readyToEnter}`,
      );
      lastHeartbeat = Date.now();
    }

    const stable = state.connected && connectedSince && Date.now() - connectedSince >= 3000;

    // Primary success: splash actually left + socket stable a few seconds.
    if (state.loadingDone && stable) {
      console.log(
        `開場已離開（loadingDone）且連線穩定（${state.connectedKey}，點擊 ${clickAttempts} 次），開始掃台。`,
      );
      return;
    }

    // Start / keep tapping 「開始遊戲」 while splash is still up.
    // Prefer readyToEnter, or bar gone ≥2s; also prefer connected or canvas aged ≥3s.
    const barSettled = state.hasCanvas && !state.loadingBar && barGoneAt
      && Date.now() - barGoneAt >= 2000;
    const canvasAged = canvasSeenAt && Date.now() - canvasSeenAt >= 3000;
    const canClick = (state.readyToEnter || barSettled)
      && (state.connected || canvasAged)
      && !state.loadingDone
      && clickAttempts < 20;

    if (canClick) {
      await clickStartGame(frame, clickAttempts);
      clickAttempts += 1;
      if (!firstClickAt) firstClickAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 1300));
      continue;
    }

    // Fallback only: enough taps + stable + API works — do not hang if loadingDone never flips.
    // Keep v7 spirit: do not probe until connected has been stable a few seconds.
    if (clickAttempts >= 10 && stable) {
      const probe = await probeRoomApi(frame, state.connectedKey || 'g1007');
      if (probe.ok) {
        console.log(
          `警告：開場可能仍停在「開始遊戲」，但連線穩定（${state.connectedKey}）`
          + `且空桌 API 可用（${probe.tables} 台、點擊 ${clickAttempts} 次），改以 API 就緒繼續掃台。`,
        );
        return;
      }
      console.log(`連線穩定但空桌 API 尚未可用：${probe.reason}（繼續等候／點開場）`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('遊戲連線逾時（150 秒內未就緒；開場點擊或 ATG 連線失敗）');
}

async function openGameFresh(page, config, game, captured) {
  const href = await enterGameViaLobby(page, config, game);
  saveLaunchUrl(config, captured, game.name, href);
  const frame = await gameFrame(page);
  await waitUntilGameReady(frame);
  return frame;
}

async function requestRoomData(frame, request, data) {
  return frame.evaluate(async ({ request, data }) => {
    const datas = window.App?.senderManager?._datas;
    let sender = datas?.get?.('g1007');
    if (!sender?.service?.isConnected && datas && typeof datas.forEach === 'function') {
      datas.forEach((value) => {
        if (!sender?.service?.isConnected && value?.service?.isConnected === true) sender = value;
      });
    }
    if (!sender?.service?.isConnected) throw new Error('ATG 遊戲連線尚未建立');
    let response;
    try {
      response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${request} 回應逾時`)), 20000);
        try {
          sender.send(request, { request, ...data }, (result) => {
            clearTimeout(timer);
            resolve(result);
          });
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    } catch (error) {
      throw new Error(`${request} 失敗：${error?.message || error}`);
    }
    if (response?.status !== 200 || !response?.data) {
      throw new Error(`${request} 未回傳房間資料（status=${response?.status ?? 'unknown'}）`);
    }
    if (request === 'getSlotTables') {
      let initialPages = null;
      try {
        const model = await window.System.import('chunks:///_virtual/InitialModel.ts');
        initialPages = model.default?.getData()?.tableMeta?.totalPages ?? null;
      } catch { /* 回應本身可能已包含頁數。 */ }
      return {
        tables: (response.data.tables ?? []).map(({ roomId, number, status }) => ({ roomId, number, status })),
        totalPages: response.tableMeta?.totalPages ?? response.data.tableMeta?.totalPages ?? initialPages,
      };
    }
    const detail = response.data.detail;
    if (!detail) throw new Error('機台詳細資料缺少 detail');
    const { mgCounts, todayWin, todayBet, hourWin, hourBet, dayWin, dayBet } = detail;
    return { mgCounts, todayWin, todayBet, hourWin, hourBet, dayWin, dayBet };
  }, { request, data });
}

function rate(win, bet) {
  const w = Number(win);
  const b = Number(bet);
  if (!Number.isFinite(w) || !Number.isFinite(b) || b < 0) return null;
  return `${(b === 0 ? 0 : w / b * 100).toFixed(2)}%`;
}

function buildRoom(game, table, detail, pageNumber) {
  const counts = detail.mgCounts;
  if (!Array.isArray(counts) || counts.length < 3) {
    throw new Error(`${game.name} 機台 ${table.number} 的免費遊戲轉數資料不完整`);
  }
  const todayReturnRate = rate(detail.todayWin ?? detail.hourWin, detail.todayBet ?? detail.hourBet);
  const days30ReturnRate = rate(detail.dayWin, detail.dayBet);
  if (!todayReturnRate || !days30ReturnRate) {
    throw new Error(`${game.name} 機台 ${table.number} 的得分率資料不完整`);
  }
  return {
    game: game.name,
    tableId: String(table.number).padStart(3, '0'),
    isEmpty: true,
    spinsSinceBonus: counts[0],
    previousBonusSpins: counts[1],
    secondPreviousBonusSpins: counts[2],
    todayReturnRate,
    days30ReturnRate,
    roomId: table.roomId,
    page: pageNumber,
  };
}

// Per-game scan outcome of the latest collectRooms() call (read by the ops notifier).
export const scanStatus = [];

export async function collectRooms(config) {
  const captured = fs.existsSync(config.launchUrlsPath)
    ? JSON.parse(fs.readFileSync(config.launchUrlsPath, 'utf8')) : {};
  const context = await browserContext(config, config.headless);
  const rooms = [];
  scanStatus.length = 0;
  try {
    const minSpins = config.minSpins;
    const maxRoomsPerGame = config.maxRooms;
    // One page per game: closing the WebGL tab between titles avoids Chrome crashes.
    // Each game early-stops once it has maxRoomsPerGame qualifying tables.
    let gameOrdinal = 0;
    for (const game of gameDefinitions) {
      gameOrdinal += 1;
      console.log(`開始掃描「${game.name}」機台…（本款目標 ${maxRoomsPerGame} 台 ≥${minSpins} 轉）`);
      const maxAttempts = gameOrdinal === 1 || (game.key === 'golden-seth' || (game.name || '').includes('賽特'))
        ? 3
        : 2;
      let gameDone = false;
      let lastError = null;
      let gameAbort = false;
      for (let attempt = 1; attempt <= maxAttempts && !gameDone && !gameAbort; attempt++) {
      const page = await context.newPage();
      try {
        if (attempt > 1) {
          console.log(`「${game.name}」第 ${attempt}/${maxAttempts} 次重試進場…`);
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        const frame = await openGameFresh(page, config, game, captured);
        let previousPageSignature = null;
        let gameChecked = 0;
        let gameQualified = 0;
        for (let pageNumber = 1; pageNumber <= 30; pageNumber++) {
          let listing;
          try {
            listing = await requestRoomData(frame, 'getSlotTables', { page: pageNumber });
          } catch (error) {
            const message = String(error?.message || error);
            if (/spinId|has been closed|Target page/i.test(message)) {
              throw new Error(`${game.name} 遊戲連線不穩（${message}）`);
            }
            throw error;
          }
          if (!Array.isArray(listing.tables)) throw new Error(`${game.name} 第${pageNumber}頁機台清單格式錯誤`);
          if (listing.tables.length === 0) {
            if (pageNumber === 1) throw new Error(`${game.name} 沒有取得機台清單`);
            break;
          }
          if (listing.totalPages > 30) throw new Error(`${game.name} 超過可檢查的30頁，停止發送以免漏台`);
          const signature = listing.tables.map((table) => table.roomId).join(',');
          if (signature === previousPageSignature) {
            if (listing.totalPages && pageNumber <= listing.totalPages) {
              throw new Error(`${game.name} 第${pageNumber}頁機台資料重複，停止發送以免漏台`);
            }
            break;
          }
          previousPageSignature = signature;
          const empties = listing.tables.filter((table) => table.status === 'Empty');
          console.log(
            `「${game.name}」第${pageNumber}/${listing.totalPages ?? '?'}頁：${listing.tables.length} 台，空桌 ${empties.length}`,
          );
          for (const table of empties) {
            try {
              const detail = await requestRoomData(frame, 'getSlotTableDetail', { roomId: table.roomId });
              const room = buildRoom(game, table, detail, pageNumber);
              gameChecked += 1;
              if (room.spinsSinceBonus >= minSpins) {
                rooms.push(room);
                gameQualified += 1;
                console.log(
                  `「${game.name}」符合 ${gameQualified}/${maxRoomsPerGame}（總計 ${rooms.length}）：${room.tableId}號台（${room.spinsSinceBonus}轉未開）`,
                );
                if (gameQualified >= maxRoomsPerGame) {
                  console.log(`「${game.name}」已湊滿 ${maxRoomsPerGame} 台，提早結束此款。`);
                  break;
                }
              }
            } catch (error) {
              const message = String(error?.message || error);
              console.log(`「${game.name}」機台 ${table.number} 讀取失敗，略過：${message}`);
              if (/has been closed|Target page/i.test(message)) {
                throw new Error(`${game.name} 瀏覽器已關閉，中止此款`);
              }
              if (/spinId/i.test(message)) {
                throw new Error(`${game.name} 遊戲端異常（spinId），中止此款以免閃退`);
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
          console.log(
            `「${game.name}」第${pageNumber}頁完成（已查 ${gameChecked}、符合 ${gameQualified}/${maxRoomsPerGame}；總計 ${rooms.length}）。`,
          );
          if (gameQualified >= maxRoomsPerGame) break;
          if (listing.totalPages && pageNumber >= listing.totalPages) break;
          if (pageNumber === 30) throw new Error(`${game.name} 掃描已達30頁上限，停止發送以免漏台`);
        }
        console.log(`「${game.name}」掃描完成，符合 ${gameQualified} 台。`);
        gameDone = true;
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error);
        console.log(`「${game.name}」第 ${attempt}/${maxAttempts} 次失敗：${message}`);
        // 資料錯誤／確認鈕這類錯誤只重試一次，避免整輪拖到 20 幾分鐘
        const dataErrorStuck = /資料錯誤|strict mode violation/.test(message);
        if (attempt >= maxAttempts || (dataErrorStuck && attempt >= 2)) {
          console.log(`「${game.name}」掃描失敗，略過此款：${message}`);
          gameAbort = true;
        }
      } finally {
        await page.close().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
      } // attempts
      scanStatus.push({
        game: game.name,
        ok: gameDone,
        error: gameDone ? '' : String(lastError?.message || lastError || '未知錯誤').slice(0, 160),
      });
    }
  } finally {
    await context.close();
  }
  return rooms;
}

export async function revalidateRooms(config, candidates) {
  if (!candidates.length) return [];
  const captured = fs.existsSync(config.launchUrlsPath)
    ? JSON.parse(fs.readFileSync(config.launchUrlsPath, 'utf8')) : {};
  const context = await browserContext(config, config.headless);
  const valid = [];
  try {
    const browserPage = context.pages()[0] ?? await context.newPage();
    for (const game of gameDefinitions) {
      const gameCandidates = candidates.filter((room) => room.game === game.name);
      if (!gameCandidates.length) continue;
      const frame = await openGameFresh(browserPage, config, game, captured);
      const pages = [...new Set(gameCandidates.map((room) => room.page))];
      for (const pageNumber of pages) {
        const listing = await requestRoomData(frame, 'getSlotTables', { page: pageNumber });
        for (const candidate of gameCandidates.filter((room) => room.page === pageNumber)) {
          const table = listing.tables.find((item) => item.roomId === candidate.roomId);
          if (!table || table.status !== 'Empty') continue;
          const detail = await requestRoomData(frame, 'getSlotTableDetail', { roomId: table.roomId });
          valid.push(buildRoom(game, table, detail, pageNumber));
        }
      }
    }
  } finally {
    await context.close();
  }
  return valid;
}
