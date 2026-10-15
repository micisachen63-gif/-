import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { gameDefinitions } from './config.js';

function fileLog(config, message) {
  try {
    const line = `${new Date().toISOString()} ${message}\n`;
    fs.mkdirSync(path.dirname(config.logPath), { recursive: true });
    fs.appendFileSync(config.logPath, line);
  } catch { /* ignore */ }
  console.log(message);
}


const FRAME_SELECTOR = 'iframe[src*="play.godeebxp.com/egames/"]';

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
  const launchOptions = {
    channel: 'chrome',
    headless: !headed,
    viewport: headed ? null : { width: 1440, height: 900 },
    args: headed
      ? ['--start-maximized']
      : ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'],
    ignoreDefaultArgs: headed ? ['--enable-unsafe-swiftshader'] : [],
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
  const src = (await page.locator('#page-modal0 iframe').first().getAttribute('src').catch(() => '')) || '';
  const name = src.split('?')[0].split('/').pop() || '未知';
  const closeButtons = [
    page.frameLocator('#page-modal0 iframe').locator('.page-modal-close').first(),
    modal.locator('.page-modal-close').first(),
  ];
  // Ad iframe content can appear before its close control finishes rendering.
  await closeButtons[0].waitFor({ state: 'visible', timeout: src.includes('ActivityLottery') ? 500 : 10000 }).catch(() => {});
  for (const button of closeButtons) {
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: 5000 }).catch(() => {});
    if (await modal.waitFor({ state: 'hidden', timeout: 2500 }).then(() => true).catch(() => false)) return;
  }
  if (src.includes('AdNormal.html') && await modal.isVisible().catch(() => false)) {
    // The current AdNormal artwork draws its round X at the bottom centre without
    // exposing a usable .page-modal-close element (confirmed in failure screenshots).
    const viewport = page.viewportSize();
    if (viewport) {
      // The round X is below the ad iframe, outside #page-modal0's box.
      // All failure screenshots (1440x900) place it at page centre, 90% height.
      await page.mouse.click(viewport.width * 0.5, viewport.height * 0.9);
      if (await modal.waitFor({ state: 'hidden', timeout: 2500 }).then(() => true).catch(() => false)) {
        console.log('[site] AdNormal 圖像關閉鈕已關閉彈窗');
        return;
      }
    }
    // This is an advertisement overlay. Some artwork versions have no working
    // close control; dismiss the ad DOM so it cannot block the game selector.
    await page.evaluate(() => {
      document.querySelector('#page-modal0')?.remove();
      document.querySelectorAll('.mask-transparent').forEach((element) => element.remove());
    });
    if (!(await modal.isVisible().catch(() => false))) {
      console.log('[site] AdNormal 廣告遮罩已移除');
      return;
    }
  }
  if (src.includes('ActivityLottery')) {
    const box = await modal.boundingBox();
    if (!box) return;
    // 上排中間那張卡（畫面置中，約在高度 39% 的位置）。
    const x = box.x + box.width * 0.5;
    const y = box.y + box.height * 0.39;
    console.log('[site] 偵測到「每日抽抽樂」，點一張卡並連點同一位置結束活動頁');
    for (let i = 0; i < 25; i++) {
      if (!(await modal.isVisible().catch(() => false))) {
        console.log(`[site] 「每日抽抽樂」已結束（點了 ${i} 下）`);
        return;
      }
      await page.mouse.click(x, y);
      await page.waitForTimeout(800);
    }
    if (await modal.isVisible().catch(() => false)) throw new Error('「每日抽抽樂」點了 25 下仍未結束');
    return;
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  if (await modal.isVisible().catch(() => false)) {
    const diagnostic = path.join(process.cwd(), 'logs', `lobby-modal-${Date.now()}.png`);
    await page.screenshot({ path: diagnostic, timeout: 5000 }).catch(() => {});
    throw new Error(`大廳彈窗沒有可用的關閉鈕，關不掉（${name}）`);
  }
}

async function dismissLobbyAds(page) {
  await page.locator('a.game-item').first().waitFor({ state: 'attached', timeout: 60000 });
  const ad = page.locator('#page-modal0');
  await ad.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
  // Ads only — skip if this modal is the transfer dialog.
  if (await page.getByText('快速轉點', { exact: true }).isVisible().catch(() => false)) return;
  for (let index = 0; index < 12 && await ad.isVisible(); index++) {
    await closeLobbyModal(page);
    await page.waitForTimeout(400);
  }
  if (await ad.isVisible() && !(await page.getByText('快速轉點', { exact: true }).isVisible().catch(() => false))) {
    throw new Error('大廳廣告未能關閉');
  }
  await page.locator('.mask-transparent').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
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

async function enterGameViaLobby(page, config, game) {
  await page.goto(config.gameUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForLobby(page, 60000);
  await dismissLobbyAds(page);
  const electronic = page.getByRole('button', { name: '電子' });
  for (let attempt = 0; ; attempt++) {
    try { await electronic.click({ timeout: 15000 }); break; }
    catch (error) {
      if (attempt >= 2 || !/intercepts pointer events|Timeout/i.test(error.message)) throw error;
      await dismissLobbyAds(page);
      await page.locator('.loading:visible').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    }
  }
  await page.getByPlaceholder('請輸入遊戲名稱').fill(game.search);
  const card = page.locator(`a.game-item:has(img[src*="/${game.lobbyId}/"])`);
  await card.waitFor({ state: 'visible', timeout: 15000 });
  console.log(`已找到「${game.name}」，正在進入遊戲。`);
  await card.click();
  const frameLocator = page.locator(FRAME_SELECTOR).first();
  const transfer = page.getByText('快速轉點', { exact: true });
  const next = await Promise.race([
    frameLocator.waitFor({ state: 'attached', timeout: 60000 }).then(() => 'game'),
    transfer.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'transfer'),
  ]);
  if (next === 'transfer') {
    await confirmTransferAndEnter(page);
    await frameLocator.waitFor({ state: 'attached', timeout: 60000 });
  }
  const url = await frameLocator.getAttribute('src');
  if (!url) throw new Error('遊戲畫面沒有網址');
  const parsed = new URL(url, page.url());
  if (parsed.searchParams.get('gn') !== game.key) {
    throw new Error(`目前開啟的遊戲不是「${game.name}」`);
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
  const canvas = frame.locator('#GameCanvas');
  await canvas.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  let box = await canvas.boundingBox({ timeout: 5000 }).catch(() => null);
  if (!box) {
    box = await Promise.race([
      frame.evaluate(() => {
        const rect = document.querySelector('#GameCanvas')?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return null;
        const host = window.frameElement?.getBoundingClientRect();
        return { x: (host?.left || 0) + rect.left, y: (host?.top || 0) + rect.top, width: rect.width, height: rect.height };
      }).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
  }
  if (!box) return false;
  // Splash 「開始遊戲」 is canvas-drawn; position varies by title (Seth vs 虎小妹).
  const spots = [
    [0.5, 0.92], [0.5, 0.88], [0.5, 0.85], [0.5, 0.8], [0.5, 0.75],
    [0.5, 0.7], [0.5, 0.65], [0.5, 0.55], [0.45, 0.9], [0.55, 0.9],
    [0.5, 0.95], [0.5, 0.5],
  ];
  const [xr, yr] = spots[attempt % spots.length];
  const localX = box.width * xr;
  const localY = box.height * yr;
  const absX = box.x + localX;
  const absY = box.y + localY;
  console.log(`遊戲載入完成，點擊開場進入選房（x=${xr.toFixed(2)}, y=${yr.toFixed(2)}）。`);
  await canvas.click({ position: { x: localX, y: localY }, force: true, timeout: 5000 }).catch(() => {});
  await frame.page().mouse.click(absX, absY, { delay: 40 }).catch(() => {});
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
  console.log('[site] 選房就緒檢查 v7：先連線穩定，再掃空桌（避免 spinId 閃退）');
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
        `[site] 連線狀態 connected=${state.connected} key=${state.connectedKey ?? '-'} keys=[${state.keys.join(',')}] clicks=${clickAttempts} loadingBar=${state.loadingBar}`,
      );
      lastHeartbeat = Date.now();
    }

    // Never call getSlotTables until the socket has stayed connected — that call is what
    // triggered spinId null crashes on 古神巴風特 while still on the splash.
    const stable = state.connected && connectedSince && Date.now() - connectedSince >= 3000;
    if (clickAttempts >= 2 && stable) {
      console.log(`已點過開場且連線穩定（${state.connectedKey}），開始掃空桌。`);
      return;
    }

    const splashLikely = state.hasCanvas && !state.loadingBar && barGoneAt
      && Date.now() - barGoneAt >= 2500;
    if (splashLikely && clickAttempts < 12) {
      await clickStartGame(frame, clickAttempts);
      clickAttempts += 1;
      if (!firstClickAt) firstClickAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
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

export async function collectRooms(config, games = gameDefinitions) {
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
    for (const game of games) {
      fileLog(config, `開始掃描「${game.name}」機台…（本款目標 ${maxRoomsPerGame} 台 ≥${minSpins} 轉）`);
      const maxAttempts = 3;
      let gameDone = false;
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts && !gameDone; attempt++) {
      const page = await context.newPage();
      try {
        if (attempt > 1) {
          fileLog(config, `「${game.name}」第 ${attempt}/${maxAttempts} 次重試進場…`);
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
        fileLog(config, `「${game.name}」掃描完成，符合 ${gameQualified} 台。`);
        gameDone = true;
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error);
        fileLog(config, `「${game.name}」第 ${attempt}/${maxAttempts} 次失敗：${message}`);
        if (attempt >= maxAttempts) {
          fileLog(config, `「${game.name}」掃描失敗，略過此款：${message}`);
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
