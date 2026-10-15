import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserManager, launchOptions } from './browser.js';
import { paths } from './config.js';
import { acquireLock, holderAlive, readLock, releaseLock } from './locks.js';
import { readJson, sleep, writeJsonAtomic } from './util.js';

const say = (text) => process.stdout.write(text + '\n');

/** Session check from inside an existing tab of that origin (no extra tabs for the user). */
async function sessionStatus(ctx, brand) {
  const host = new URL(brand.uiBase).host;
  const page = ctx.pages().find((p) => { try { return new URL(p.url()).host === host; } catch { return false; } });
  if (!page) return 'no-tab';
  try {
    const r = await page.evaluate(async (url) => {
      const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ searchBy: '0', searchContent: '0', limit: 1, page: 1 }), signal: AbortSignal.timeout(20000) });
      const j = await res.json().catch(() => null);
      return j?.status;
    }, brand.apiBase + '/api/player/list');
    return r === 2 ? 'ok' : 'logged-out';
  } catch {
    return 'unknown';
  }
}

const LOOKALIKE_FORM = `<!doctype html><html><head><meta charset="utf-8"><title>login</title></head><body>
<form onsubmit="return false"><input type="text" name="login_account" id="login_account" autocomplete="off">
<input type="password" name="login_password" id="login_password"><button type="submit">登入</button></form></body></html>`;

function countSavedLogins(cfg, log) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigwin-logins-'));
  const counts = {};
  return import('node:sqlite').then(({ DatabaseSync }) => {
    for (const f of ['Login Data', 'Login Data For Account']) {
      const from = path.join(cfg.chrome.profileDir, 'Default', f);
      if (!fs.existsSync(from)) continue;
      const copy = path.join(tmpDir, f.replace(/ /g, '_'));
      fs.copyFileSync(from, copy);
      const db = new DatabaseSync(copy, { readOnly: true });
      for (const row of db.prepare('SELECT origin_url FROM logins WHERE blacklisted_by_user = 0').all()) {
        for (const b of cfg.brands) if (String(row.origin_url).startsWith(b.uiBase)) counts[b.key] = (counts[b.key] || 0) + 1;
      }
      db.close();
    }
    return counts;
  }).catch((error) => { log.warn(`saved-login count unavailable: ${error.message}`); return null; })
    .finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });
}

/**
 * Checks whether HEADLESS Chrome on the real project profile autofills the saved credentials on each
 * backend login origin. The login document is replaced by a local look-alike form and every other
 * request is aborted, so nothing reaches the server and the session is untouched. Caller must hold
 * state\browser.lock. Reports only booleans / counts, never the credentials.
 */
export async function checkAutofill({ cfg, log }) {
  const result = { at: new Date().toISOString(), method: 'real profile, headless, look-alike form, network blocked', brands: {} };
  const saved = await countSavedLogins(cfg, log);
  const ctx = await chromium.launchPersistentContext(cfg.chrome.profileDir, launchOptions(cfg, { headless: true }));
  try {
    for (const b of cfg.brands) {
      const page = await ctx.newPage();
      const entry = { savedLogins: saved ? (saved[b.key] || 0) : null, userFilled: false, passFilled: false };
      try {
        await page.route('**/*', (route) => (route.request().url().startsWith(b.uiBase + '/login')
          ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: LOOKALIKE_FORM })
          : route.abort()));
        await page.goto(b.uiBase + '/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(2000);
        await page.click('#login_account');
        await sleep(1500);
        const v = await page.evaluate(() => ({
          u: (document.querySelector('#login_account')?.value || '').length > 0,
          p: (document.querySelector('#login_password')?.value || '').length > 0,
        }));
        entry.userFilled = v.u;
        entry.passFilled = v.p;
      } catch (error) {
        entry.error = error.message;
      } finally {
        await page.close().catch(() => {});
      }
      result.brands[b.key] = entry;
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  result.works = Object.values(result.brands).every((e) => e.userFilled && e.passFilled);
  writeJsonAtomic(paths.autofillCheck, result);
  log.info(`autofill check: ${JSON.stringify(result)}`);
  return result;
}

/** Borrow the profile from the resident service (if running): request → wait release → fn → hand back. */
export async function withProfile(fn, { onWait = () => {} } = {}) {
  const svc = readLock(paths.serviceLock);
  let requested = false;
  if (svc && holderAlive(svc.pid)) {
    onWait();
    writeJsonAtomic(paths.loginRequest, { pid: process.pid, state: 'requested', at: new Date().toISOString() });
    requested = true;
    if (!(await waitForRelease(11 * 60e3))) {
      try { fs.unlinkSync(paths.loginRequest); } catch { /* ignore */ }
      throw new Error('服務沒有在時限內釋放瀏覽器，請稍後再試。');
    }
  }
  if (!acquireLock(paths.browserLock, 'login')) {
    const cur = readLock(paths.browserLock);
    if (requested) { try { fs.unlinkSync(paths.loginRequest); } catch { /* ignore */ } }
    throw new Error(`瀏覽器設定檔正被 pid ${cur?.pid}（${cur?.role}）使用中，請稍後再試。`);
  }
  try {
    return await fn();
  } finally {
    releaseLock(paths.browserLock);
    if (requested) { try { fs.unlinkSync(paths.loginRequest); } catch { /* ignore */ } }
  }
}

export function describeAutofill(cfg, r) {
  return cfg.brands.map((b) => {
    const e = r.brands[b.key] || {};
    const ok = e.userFilled && e.passFilled;
    return `  ${ok ? '✅' : '❌'} ${b.name}：已存密碼 ${e.savedLogins ?? '?'} 組；無畫面模式自動填入 ${ok ? '成功' : '失敗'}${e.error ? `（${e.error}）` : ''}`;
  }).join('\n');
}

async function waitForRelease(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const req = readJson(paths.loginRequest, null);
    if (req?.state === 'released') return true;
    await sleep(1000);
  }
  return false;
}

/** Headed login for the user; hands the profile back to the service afterwards. */
export async function runLogin({ cfg, log }) {
  say('=== 爆分監控：登入三個後台 ===');
  let allOk = false;
  try {
    await withProfile(async () => {
      const bm = new BrowserManager({ cfg, log, headless: false });
      let ctx;
      try {
        ctx = await bm.getContext();
      } catch (error) {
        say(`❌ 無法開啟登入視窗：${error.message}`);
        say('   若有一個舊的「爆分監控」Chrome 視窗還開著，請先把它關掉再執行 login.cmd。');
        return;
      }
      let closed = false;
      ctx.on('close', () => { closed = true; });
      const existing = ctx.pages();
      for (let i = 0; i < cfg.brands.length; i++) {
        const page = existing[i] || await ctx.newPage();
        await page.goto(cfg.brands[i].uiBase + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      }
      say('已開啟 Chrome 視窗（贏麻、爽爆、茄子 三個分頁）。');
      say('請在每個分頁登入後台（點帳號欄位，Chrome 會自動帶入已存的帳密，再按登入）。');
      say('全部登入後，直接關閉這個 Chrome 視窗即可（或在這裡按 Enter）。');
      let enter = false;
      if (process.stdin.isTTY) {
        process.stdin.resume();
        process.stdin.on('data', () => { enter = true; });
      }
      const last = {};
      let announcedAll = false;
      const deadline = Date.now() + 20 * 60e3;
      while (!closed && !enter && Date.now() < deadline) {
        for (const b of cfg.brands) {
          const s = await sessionStatus(ctx, b);
          if (s !== last[b.key] && (s === 'ok' || s === 'logged-out')) say(`  ${s === 'ok' ? '✅' : '⏳'} ${b.name}：${s === 'ok' ? '已登入' : '尚未登入'}`);
          if (s === 'ok' || s === 'logged-out') last[b.key] = s;
        }
        if (!announcedAll && cfg.brands.every((b) => last[b.key] === 'ok')) {
          announcedAll = true;
          say('🎉 三個後台都已登入，可以關閉 Chrome 視窗了。');
        }
        for (let i = 0; i < 5 && !closed && !enter; i++) await sleep(1000);
      }
      if (!closed) {
        for (const b of cfg.brands) { const s = await sessionStatus(ctx, b); if (s === 'ok' || s === 'logged-out') last[b.key] = s; }
        await bm.close();
      }
      process.stdin.pause();
      allOk = cfg.brands.every((b) => last[b.key] === 'ok');
      say(allOk ? '✅ 三個後台登入狀態正常。' : `⚠️ 登入狀態：${cfg.brands.map((b) => `${b.name} ${last[b.key] === 'ok' ? '已登入' : '未確認'}`).join('、')}`);
      await sleep(1500);
      say('檢查「無畫面模式能否自動填入密碼」（不會連到後台、不會送出表單）…');
      try {
        const r = await checkAutofill({ cfg, log });
        say(describeAutofill(cfg, r));
        if (!r.works) say('  → 自動重新登入需要 Chrome 已儲存該站密碼；登入過期且自動登入失敗時，系統會在私人群組通知你。');
      } catch (error) {
        say(`  自動填入檢查失敗：${error.message}`);
      }
    }, { onWait: () => say('常駐服務正在執行，請它先暫停並釋放瀏覽器（最多約 1 分鐘）…') });
  } catch (error) {
    say(`❌ ${error.message}`);
    return 2;
  }
  say('完成；常駐服務會自動繼續監控。');
  return allOk ? 0 : 1;
}
