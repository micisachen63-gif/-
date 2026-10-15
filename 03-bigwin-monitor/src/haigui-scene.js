// 🐢 海龜湯 情境圖: one picture of the 湯面, made through the flat-rate web subscriptions in the dedicated Chrome (CDP 19386 only).
// Grok web first (≈90 s), then ChatGPT web (≈150 s). Each try uses its OWN new tab (never the tab/conversation that judges the game),
// and always cleans up in finally: the tab is closed, and the temporary ChatGPT conversation is deleted. Failure → null (caller skips silently).
import { chromium } from 'playwright-core';
import { withBrowserJob } from './browser-activity.js';
import { activeComposer } from './chatgpt-web.js';
import { assertDedicatedEndpoint } from './dedicated-window.js';

const GROK_URL = 'https://grok.com/';
const GROK_EDITOR = '[contenteditable="true"][role="combobox"][aria-label="Ask Grok anything"]';
const GROK_ANSWER = '[data-testid="assistant-message"]';
const GPT_URL = 'https://chatgpt.com/';
const GPT_SEND = 'button[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="傳送"]';
const STOP = 'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]';

/** Reject after ms (the generator itself also honours the same deadline, and its finally still cleans up). */
export function withCap(promise, ms, label) {
  let timer; promise.catch(() => {});
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超過 ${Math.round(ms / 1000)} 秒`)), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

/** sceneImage(prompt) → { buffer, mimeType, fileName, source } | null. grok / gpt: async (prompt, { deadline }) → image | null. */
export function createSceneImager({ grok = null, gpt = null, log, grokMs = 90e3, gptMs = 150e3 } = {}) {
  return async function sceneImage(prompt) {
    for (const [name, fn, ms] of [['grok', grok, grokMs], ['gpt', gpt, gptMs]]) {
      if (typeof fn !== 'function') continue;
      const t0 = Date.now();
      try {
        const img = await withCap(Promise.resolve().then(() => fn(prompt, { deadline: t0 + ms })), ms, `${name} 情境圖`);
        if (img?.buffer?.length) { log?.info?.(`scene image via ${name} ok (${Math.round((Date.now() - t0) / 1000)} s, ${img.buffer.length} bytes)`); return { ...img, source: name }; }
        log?.warn?.(`scene image via ${name}: no image`);
      } catch (error) { log?.warn?.(`scene image via ${name} failed: ${String(error?.message || error).split('\n')[0]}`); }
    }
    return null;
  };
}

const extOf = (mime) => (/png/i.test(mime) ? 'png' : /webp/i.test(mime) ? 'webp' : 'jpg');
/** Newest finished generated image in the page (not one that was there before). */
async function newestImage(page, scope, before, minWidth) {
  return page.evaluate(({ scope, before, minWidth }) => {
    const roots = scope ? [...document.querySelectorAll(scope)] : [document];
    const imgs = roots.flatMap((r) => [...r.querySelectorAll('img')]).filter((e) => e.complete && e.naturalWidth >= minWidth && e.clientWidth >= 120 && !before.includes(e.currentSrc || e.src));
    const last = imgs.at(-1); return last ? (last.currentSrc || last.src) : null;
  }, { scope, before, minWidth }).catch(() => null);
}
const allSrcs = (page) => page.evaluate(() => [...document.querySelectorAll('img')].map((e) => e.currentSrc || e.src)).catch(() => []);
/** Original bytes: in-page fetch (keeps the site's cookies) → context request → element screenshot as the last resort. */
async function download(page, src) {
  const viaFetch = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = await r.blob(); const bytes = new Uint8Array(await b.arrayBuffer()); let bin = '';
    for (let j = 0; j < bytes.length; j += 0x8000) bin += String.fromCharCode(...bytes.subarray(j, j + 0x8000));
    return { base64: btoa(bin), mimeType: b.type || r.headers.get('content-type') || 'image/jpeg' };
  }, src).catch(() => null);
  if (viaFetch?.base64) return { buffer: Buffer.from(viaFetch.base64, 'base64'), mimeType: viaFetch.mimeType };
  const res = await page.context().request.get(src, { timeout: 20000 }).catch(() => null);
  if (res?.ok()) { const buffer = await res.body(); if (buffer?.length) return { buffer, mimeType: res.headers()['content-type'] || 'image/jpeg' }; }
  const buffer = await page.locator(`img[src="${src.replace(/"/g, '\\"')}"]`).first().screenshot({ type: 'jpeg', quality: 92, timeout: 10000 });
  return { buffer, mimeType: 'image/jpeg' };
}
/** Wait until the newest image stops changing and nothing is generating (progressive previews are skipped). */
async function waitImage(page, { scope, before, deadline, minWidth }) {
  let last = null, since = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    const src = await newestImage(page, scope, before, minWidth);
    const busy = await page.locator(STOP).first().isVisible().catch(() => false);
    if (src && !busy && src === last) { if (Date.now() - since >= 3000) return src; } else { last = src; since = Date.now(); }
  }
  return null;
}

/** Grok web (grok.com chat): a fresh tab, ask for the picture, download it, close the tab. */
export function createGrokSceneImage({ endpoint = 'http://127.0.0.1:19386', chromiumImpl = chromium, log } = {}) {
  assertDedicatedEndpoint(endpoint);
  return (prompt, { deadline = Date.now() + 90e3 } = {}) => withBrowserJob(async () => {
    let browser = null, page = null;
    try {
      browser = await chromiumImpl.connectOverCDP(endpoint, { timeout: 10000 });
      page = await browser.contexts()[0].newPage();
      await page.goto(GROK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const editor = page.locator(GROK_EDITOR); await editor.waitFor({ timeout: 20000 });
      const before = await allSrcs(page);
      await editor.fill(prompt); await editor.press('Enter');
      const src = await waitImage(page, { scope: GROK_ANSWER, before, deadline, minWidth: 400 });
      if (!src) throw new Error('Grok 沒有在時限內產生圖片');
      const img = await download(page, src);
      return { ...img, fileName: `haiguitang-scene.${extOf(img.mimeType)}` };
    } finally {
      await page?.close().catch((e) => log?.warn?.(`grok scene tab close failed: ${e.message}`));
      await browser?.close().catch(() => {}); // disconnect only; the dedicated Chrome keeps running
    }
  });
}

/** Delete one ChatGPT conversation through the UI (header ⋯ menu, else the sidebar row menu). true when it is gone. */
export async function deleteGptConversation(page, id) {
  // ChatGPT leaves /c/<id> right after deleting the open conversation (the sidebar entry may linger until its cache refreshes)
  const gone = async () => !page.url().includes(`/c/${id}`);
  const confirm = async () => {
    // confirm dialog (seen 2026-10: 「取消」「刪除對話」)
    const btn = page.locator('button[data-testid="delete-conversation-confirm-button"]')
      .or(page.locator('[role="dialog"] button, [role="alertdialog"] button').filter({ hasText: /^\s*(刪除對話|刪除|Delete chat|Delete)\s*$/ })).first();
    await btn.click({ timeout: 8000 });
    await page.waitForFunction((cid) => !location.pathname.includes(`/c/${cid}`), id, { timeout: 10000 }).catch(() => {});
  };
  const menuDelete = () => page.getByRole('menuitem', { name: /^(刪除|Delete)$/ }).first().click({ timeout: 5000 });
  try {
    const header = page.locator('button[data-testid="conversation-options-button"]').filter({ visible: true }).first();
    if (await header.count()) { await header.click({ timeout: 5000 }); await menuDelete(); await confirm(); if (await gone()) return 'header'; }
  } catch { await page.keyboard.press('Escape').catch(() => {}); }
  try {
    const link = page.locator(`a[href*="/c/${id}"]`).first(); await link.waitFor({ state: 'visible', timeout: 10000 }); await link.hover();
    await link.locator('xpath=ancestor-or-self::*[.//button[@aria-label="對話動作" or @aria-label="Conversation options" or contains(@data-testid,"options")]][1]')
      .locator('button[aria-label="對話動作"], button[aria-label="Conversation options"], button[data-testid*="options"]').first().click({ timeout: 5000 });
    await menuDelete(); await confirm(); if (await gone()) return 'sidebar';
  } catch { await page.keyboard.press('Escape').catch(() => {}); }
  return false;
}

/** ChatGPT web fallback: a NEW tab with a NEW conversation used only for this picture; deleted and closed afterwards, even on failure. */
export function createGptSceneImage({ endpoint = 'http://127.0.0.1:19386', url = GPT_URL, chromiumImpl = chromium, deleteConversation = deleteGptConversation, log } = {}) {
  assertDedicatedEndpoint(endpoint);
  return (prompt, { deadline = Date.now() + 150e3 } = {}) => withBrowserJob(async () => {
    let browser = null, page = null;
    try {
      browser = await chromiumImpl.connectOverCDP(endpoint, { timeout: 10000 });
      page = await browser.contexts()[0].newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      let composer = null; for (let i = 0; i < 40 && !composer; i++) { composer = await activeComposer(page); if (!composer) await page.waitForTimeout(500); }
      if (!composer) throw new Error('ChatGPT 新分頁找不到輸入框');
      const before = await allSrcs(page);
      await composer.fill(prompt);
      await page.waitForTimeout(300);
      const form = composer.locator('xpath=ancestor::form[1]');
      const send = (await form.count().catch(() => 0) ? form : page).locator(GPT_SEND).filter({ visible: true }).first();
      await send.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (await send.isVisible().catch(() => false)) await send.click({ timeout: 10000 }).catch(() => composer.press('Enter')); else await composer.press('Enter');
      await page.waitForURL(/\/c\//, { timeout: 20000 }).catch(() => {});
      const src = await waitImage(page, { scope: null, before, deadline, minWidth: 512 });
      if (!src) throw new Error('ChatGPT 沒有在時限內產生圖片');
      const img = await download(page, src);
      return { ...img, fileName: `haiguitang-scene.${extOf(img.mimeType)}` };
    } finally {
      const id = page && !page.isClosed() ? /\/c\/([^/?#]+)/.exec(page.url())?.[1] : null;
      if (id) {
        const how = await deleteConversation(page, id).catch((e) => { log?.warn?.(`gpt scene conversation delete failed: ${e.message}`); return false; });
        if (how) log?.info?.(`gpt scene conversation ${id} deleted (${how})`); else log?.warn?.(`gpt scene conversation ${id} NOT deleted`);
      }
      await page?.close().catch((e) => log?.warn?.(`gpt scene tab close failed: ${e.message}`));
      await browser?.close().catch(() => {});
    }
  });
}
