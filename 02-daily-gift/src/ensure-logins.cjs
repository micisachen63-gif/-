// 登入失效時自動用瀏覽器已記住的帳密／LINE 帳號／Google 帳號重新登入。只處理登入，不做任何寄送。
// 用法：node src/ensure-logins.cjs <brand|all> [--admin] [--line] [--google] [--check]
// 不帶 --admin/--line/--google 時三種都檢查（Google 試算表只檢查一次，與品牌無關）。
const { chromium } = require('playwright');
const HOSTS = { qiezi: 'admin.qzplays.com', songyy: 'admin.song-yy.com', winmalo: 'admin.winmalo.com' };
const LINE_IDS = { qiezi: '@334ojgrp', songyy: '@270zjale', winmalo: '@502osqfx' };
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit';
const OK = ['ok', 'relogged-in'];
// 登入頁判斷一律只看網域＋路徑（where）：LINE／Google 的登入網址查詢字串裡會夾帶其他網域與 code_challenge 等字樣。
const where = url => { try { const u = new URL(url); return `${u.host}${u.pathname}${u.hash.startsWith('#/') ? u.hash.split('?')[0] : ''}`; } catch { return String(url); } };
const isAdminLogin = url => /(?:\/|#\/?)login(?:\/|$)/u.test(where(url));
const isLineLogin = url => /^(?:account\.line\.biz\/login|access\.line\.me\/)|\/login$/u.test(where(url));
const lineReady = url => where(url).startsWith('manager.line.biz/') && !isLineLogin(url);
const isGoogleLogin = url => where(url).startsWith('accounts.google.com');
const host = url => { try { return new URL(url).host; } catch { return String(url).slice(0, 60); } };
const needsVerification = url => /verify|otp|pincode|2fa|captcha|challenge/iu.test(where(url));
const errText = e => `error: ${String(e?.message || e).split('\n')[0]}`;

const visible = (locator, timeout = 0) => timeout
  ? locator.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false)
  : locator.first().isVisible().catch(() => false);

// 等「已就緒的元素」或「被導到登入頁」兩者先發生者。回傳 ready / login / timeout。
async function readyOrLogin(page, ready, isLogin, timeout = 20000) {
  if (isLogin(page.url())) return 'login';
  return Promise.any([
    ready.first().waitFor({ state: 'visible', timeout }).then(() => 'ready'),
    page.waitForURL(u => isLogin(u.toString()), { timeout }).then(() => 'login'),
  ]).catch(() => (isLogin(page.url()) ? 'login' : 'timeout'));
}

// Chrome 已記住的帳密：點欄位→方向鍵下→Enter 選第一筆。
// Chrome 在使用者操作前會對 JS 隱藏自動填入的值，所以欄位看起來是空的也照樣點選；
// 若沒有下拉選單，Enter 會直接送出表單（等同按登入），不會造成傷害。回傳是否已離開原網址。
async function pickSaved(page, field) {
  if (!(await visible(field))) return false;
  if (await field.first().inputValue().catch(() => '')) return false;
  const before = page.url();
  await field.first().click();
  await page.waitForTimeout(500);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  return page.url() !== before;
}

// 營運數據用 Windows DPAPI（目前使用者）加密保存的後台帳密；只留在記憶體，不寫檔、不寫 log。
const CRED_SCRIPT = 'C:\\Users\\User\\Documents\\Codex\\2026-09-18\\new-chat\\outputs\\operations-program\\backend-credentials.ps1';
const CRED_PLATFORM = { qiezi: 'qz', songyy: 'song', winmalo: 'win' };
function readBackendCred(brand) {
  try {
    const out = require('child_process').execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CRED_SCRIPT, '-Decrypt', '-Platform', CRED_PLATFORM[brand]], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(Buffer.from(out.trim(), 'base64').toString('utf8'));
    return j && j.username && j.password ? { username: String(j.username), password: String(j.password) } : null;
  } catch { return null; }
}
async function typeInto(page, field, text) {
  await field.first().click({ timeout: 5000 });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text, { delay: 40 });
}

async function clickNamed(page, patterns) {
  for (const name of patterns) {
    const target = page.getByRole('button', { name }).or(page.getByRole('link', { name })).filter({ visible: true }).first();
    if (await target.isVisible().catch(() => false)) { await target.click({ timeout: 5000 }).catch(() => {}); return true; }
  }
  return false;
}

async function adminLogin(context, brand, checkOnly = false) {
  const page = await context.newPage();
  try {
    const url = `https://${HOSTS[brand]}:9955/gm/mail`;
    const user = page.locator('input[name="login_account"]'), pass = page.locator('input[name="login_password"]');
    const loginShown = u => isAdminLogin(u);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const first = await Promise.any([
      page.locator('[role="tab"]').first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'ready'),
      pass.first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'login'),
      page.waitForURL(u => loginShown(u.toString()), { timeout: 20000 }).then(() => 'login'),
    ]).catch(() => 'timeout');
    if (first === 'ready' && !isAdminLogin(page.url())) return 'ok';
    if (first === 'timeout' && !isAdminLogin(page.url())) return `page-not-ready(${host(page.url())})`;
    if (checkOnly) return 'login-required';
    // Chrome 記住的密碼不會因程式點擊而填入，改用營運數據共用的 DPAPI 加密帳密逐字輸入；最多兩輪避免鎖帳。
    const cred = readBackendCred(brand);
    let loggedIn = false;
    for (let attempt = 0; attempt < 2 && !loggedIn; attempt += 1) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      if (!(await visible(pass, 15000))) { loggedIn = !isAdminLogin(page.url()); if (loggedIn) break; continue; }
      await page.waitForTimeout(800);
      if (cred) {
        await typeInto(page, user, cred.username);
        await typeInto(page, pass, cred.password);
        const filled = (await user.first().inputValue().catch(() => '')) && (await pass.first().inputValue().catch(() => ''));
        if (!filled) continue;
        if (!(await clickNamed(page, [/^登\s*入$/u, '登入', /^Log\s*in$/iu, /^Sign in$/iu]))) await pass.first().press('Enter').catch(() => {});
      } else {
        let submitted = await pickSaved(page, user);
        if (!submitted && isAdminLogin(page.url())) submitted = await pickSaved(page, pass);
        if (!submitted && isAdminLogin(page.url())) await clickNamed(page, [/^登\s*入$/u, '登入', /^Log\s*in$/iu, /^Sign in$/iu]);
      }
      await page.waitForURL(u => !isAdminLogin(u.toString()), { timeout: 20000 }).catch(() => {});
      loggedIn = !isAdminLogin(page.url());
    }
    if (!loggedIn) {
      await user.first().fill('').catch(() => {}); await pass.first().fill('').catch(() => {});
      return cred ? 'relogin-failed' : 'relogin-failed(no-credentials)';
    }
    // 登入後重新開一次目標頁，確認真的能用。
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return (await readyOrLogin(page, page.locator('[role="tab"]'), isAdminLogin)) === 'ready' ? 'relogged-in' : 'relogin-failed';
  } finally { await page.close().catch(() => {}); }
}

async function lineLogin(context, brand, checkOnly = false) {
  const page = await context.newPage();
  try {
    const target = `https://manager.line.biz/account/${LINE_IDS[brand]}/broadcast`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    if (lineReady(page.url())) return 'ok';
    if (checkOnly) return 'login-required';
    for (let step = 0; step < 8 && !lineReady(page.url()); step += 1) {
      const url = page.url();
      if (needsVerification(url)) return 'needs-device-verification';
      if (where(url).startsWith('account.line.biz')) {
        // 登入方式選擇頁：「LINE帳號」／「商用帳號」→ 選 LINE帳號。
        await clickNamed(page, [/^LINE\s?帳號$/u, /^LINE account$/iu, /^LINEアカウント$/u, /LINE\s?帳號/u, /LINE account/iu]);
      } else if (where(url).startsWith('access.line.me')) {
        // 已記住的帳號會直接顯示單一「登入」按鈕；否則是帳密表單（用 Chrome 記住的帳密）。不點 QR Code 登入。
        let submitted = false;
        const email = page.locator('input[name="tid"], input[type="email"]');
        const pwd = page.locator('input[name="tpasswd"], input[type="password"]');
        if (await visible(email)) submitted = await pickSaved(page, email);
        if (!submitted && where(page.url()).startsWith('access.line.me') && await visible(pwd)) submitted = await pickSaved(page, pwd);
        if (!submitted && where(page.url()).startsWith('access.line.me')) {
          await clickNamed(page, [/^登入$/u, /^Log in$/iu, /^ログイン$/u, /^以.{1,40}登入$/u, /^Continue as/iu, /^繼續$/u, /^Continue$/iu]);
        }
      } else if (where(url).startsWith('manager.line.biz')) {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(3500);
    }
    if (needsVerification(page.url())) return 'needs-device-verification';
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    return lineReady(page.url()) ? 'relogged-in' : `relogin-failed(${host(page.url())})`;
  } finally { await page.close().catch(() => {}); }
}

async function googleLogin(context, checkOnly = false) {
  const page = await context.newPage();
  try {
    const menu = page.getByRole('button', { name: '【省時小精靈】' });
    await page.goto(SHEET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const first = await readyOrLogin(page, menu, isGoogleLogin, 30000);
    if (first === 'ready') return 'ok';
    if (first === 'timeout') return `page-not-ready(${host(page.url())})`;
    if (checkOnly) return 'login-required';
    for (let step = 0; step < 6 && isGoogleLogin(page.url()); step += 1) {
      const url = page.url();
      if (/challenge\/(?!pwd)|recaptcha/iu.test(where(url))) return 'needs-device-verification';
      const accounts = page.locator('[data-identifier]').filter({ visible: true });
      const pwd = page.locator('input[type="password"][name="Passwd"], input[type="password"]').filter({ visible: true });
      if (await pwd.count()) {
        await pickSaved(page, pwd);
        if (isGoogleLogin(page.url())) await clickNamed(page, [/^下一步$/u, /^Next$/iu, /^繼續$/u]);
      } else if ((await accounts.count()) === 1) {
        // 帳戶選擇頁只有一個記住的帳號：直接點它。
        await accounts.first().click({ timeout: 5000 }).catch(() => {});
      } else if ((await accounts.count()) > 1) {
        return 'google-account-choice-needed';
      } else {
        await clickNamed(page, [/^下一步$/u, /^Next$/iu, /^繼續$/u, /^Continue$/iu]);
      }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(3500);
    }
    await page.goto(SHEET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    return (await readyOrLogin(page, menu, isGoogleLogin, 30000)) === 'ready' ? 'relogged-in' : `relogin-failed(${host(page.url())})`;
  } finally { await page.close().catch(() => {}); }
}

// 給各步驟程式用：開啟網址；若被導到登入頁，就自動登回並重開一次網址（只試一次，失敗就交回原程式判斷）。
async function gotoWithRelogin(page, url, { kind, brand, ready, timeout = 20000, log = console.log } = {}) {
  const isLogin = kind === 'google' ? isGoogleLogin : kind === 'line' ? isLineLogin : isAdminLogin;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if ((await readyOrLogin(page, ready, isLogin, timeout)) !== 'login') return 'ok';
  const context = page.context();
  const status = await (kind === 'google' ? googleLogin(context) : kind === 'line' ? lineLogin(context, brand) : adminLogin(context, brand)).catch(errText);
  log(`${brand || 'google'}: ${kind === 'google' ? 'Google' : kind === 'line' ? 'LINE' : '後台'} 登入失效，自動重新登入結果 ${status}。`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await readyOrLogin(page, ready, isLogin, timeout);
  return status;
}

async function ensureLogins({ brands, admin = true, line = true, google = false, checkOnly = false }) {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 15000 });
  const results = [];
  try {
    const context = browser.contexts()[0];
    if (google) results.push({ brand: 'google', kind: 'sheet', status: await googleLogin(context, checkOnly).catch(errText) });
    for (const brand of brands) {
      if (admin) results.push({ brand, kind: 'admin', status: await adminLogin(context, brand, checkOnly).catch(errText) });
      if (line) results.push({ brand, kind: 'line', status: await lineLogin(context, brand, checkOnly).catch(errText) });
    }
  } finally { await browser.close().catch(() => {}); }
  return results;
}

module.exports = { where, ensureLogins, adminLogin, lineLogin, googleLogin, gotoWithRelogin, readyOrLogin, isAdminLogin, isLineLogin, isGoogleLogin, OK };

if (require.main === module) {
  const args = process.argv.slice(2);
  const which = args.find(a => !a.startsWith('--')) || 'all';
  const brands = which === 'all' ? Object.keys(HOSTS) : [which];
  if (!brands.every(b => HOSTS[b])) { console.error(`未知品牌：${which}`); process.exit(2); }
  const want = { admin: args.includes('--admin'), line: args.includes('--line'), google: args.includes('--google') };
  const none = !want.admin && !want.line && !want.google;
  ensureLogins({ brands, admin: none || want.admin, line: none || want.line, google: none || want.google, checkOnly: args.includes('--check') })
    .then(results => {
      for (const r of results) console.log(`登入檢查 ${r.brand}/${r.kind}: ${r.status}`);
      if (results.some(r => !OK.includes(r.status))) process.exitCode = 1;
    })
    .catch(e => { console.error(`登入檢查失敗：${e.message}`); process.exitCode = 1; });
}
