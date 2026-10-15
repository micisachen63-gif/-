// Google Sheets UI driver for the 營運數據 dedicated Chrome (CDP 19385), modelled on operations-program/sheets.mjs.
// Rules: only ever opens OUR OWN tab (context.newPage) and closes only pages we opened; never navigates, closes or
// activates existing tabs, never closes the browser (disconnect only) and never shows/moves its window.
// Writes avoid the system clipboard: rows go in through a synthetic paste event (fallback: typed cell by cell).
export const OPS_CDP = 'http://127.0.0.1:19385';

export async function connectOwnTabs({ endpoint = OPS_CDP, chromium } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:19385$/.test(endpoint)) throw new Error('sheet-cdp only drives the 營運 Chrome on 127.0.0.1:19385');
  if (!chromium) ({ chromium } = await import('playwright-core'));
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  const context = browser.contexts()[0];
  if (!context) { await browser.close().catch(() => {}); throw new Error('19385: no browser context'); }
  const owned = new Set();
  return {
    context,
    async newPage() { const p = await context.newPage(); owned.add(p); return p; },
    async close() { for (const p of owned) if (!p.isClosed()) await p.close().catch(() => {}); owned.clear(); await browser.close().catch(() => {}); },
  };
}

export async function openSheet(page, id, gid = null) {
  page.setDefaultTimeout(60000);
  await page.goto('https://docs.google.com/spreadsheets/d/' + id + '/edit' + (gid != null && gid !== '' ? '#gid=' + gid : ''), { waitUntil: 'domcontentloaded' });
  await page.locator('#t-name-box').waitFor({ state: 'visible' });
  await page.waitForTimeout(2500);
}
export async function saved(page, timeout = 90000) {
  await page.getByRole('button', { name: /文件狀態：已儲存到雲端硬碟|Document status: Saved to Drive/ }).waitFor({ state: 'visible', timeout });
}
const colIndex = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
export function selectionMatches(requested, actual) {
  const wanted = String(requested).toUpperCase(), shown = String(actual).toUpperCase();
  if (shown === wanted) return true;
  const single = /^([A-Z]+)(\d+)$/.exec(wanted), merged = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(shown);
  return !!(single && merged && merged[1] === single[1] && merged[2] === single[2] && Number(merged[4]) >= Number(single[2]) && colIndex(merged[3]) >= colIndex(single[1]));
}
export async function select(page, range) {
  const box = page.locator('#t-name-box');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await box.click({ timeout: 5000 }).catch(() => {});
      await box.fill(range);
      await box.press('Enter');
      await page.waitForFunction(() => document.activeElement?.id === 'waffle-rich-text-editor', null, { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
      const actual = await box.inputValue();
      if (selectionMatches(range, actual)) return actual;
    } catch { /* retry */ }
    await page.waitForTimeout(400);
  }
  const finalActual = await box.inputValue();
  if (!selectionMatches(range, finalActual)) throw new Error('選區不符 ' + range + '；實際 ' + finalActual);
  return finalActual;
}
/** Current selection's raw content as shown in the formula bar. */
export async function formulaBar(page) { return (await page.locator('#t-formula-bar-input').innerText()).replace(/\n$/, '').replace(/\u200b/g, ''); }
export async function readCell(page, a1) { await select(page, a1); await page.waitForTimeout(150); return formulaBar(page); }
export async function tabNames(page) { return page.$$eval('.docs-sheet-tab', (els) => els.map((e) => e.querySelector('.docs-sheet-tab-name')?.textContent || '')); }
export async function activeTab(page) { return page.$eval('.docs-sheet-active-tab .docs-sheet-tab-name', (e) => e.textContent).catch(() => null); }
export async function activateTab(page, name) {
  if (await activeTab(page) === name) return;
  const tab = page.locator('.docs-sheet-tab').filter({ has: page.locator('.docs-sheet-tab-name', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
  if (await tab.count() !== 1) throw new Error('找不到分頁 ' + name);
  try { await tab.click({ timeout: 8000 }); } catch {
    await page.locator('.docs-sheet-all-button').click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  }
  await page.waitForFunction((n) => document.querySelector('.docs-sheet-active-tab .docs-sheet-tab-name')?.textContent === n, name, { timeout: 15000 });
  await page.waitForTimeout(800);
}
/** Keep values literal: number-, date-, boolean- or formula-looking text gets a leading apostrophe (Sheets stores it as text). */
export function sheetText(v) {
  if (v == null) return '';
  const s = String(v).replace(/[\t\r\n]+/g, ' ');
  if (s === '') return '';
  return /^[=+\-@']/.test(s) || /^[\d\s.,:\/%$()-]+$/.test(s) || /^(true|false)$/i.test(s) ? "'" + s : s;
}
/** Rows as TSV (values escaped by sheetText). */
export function toTsv(rows) { return rows.map((r) => r.map(sheetText).join('\t')).join('\n'); }
/** Paste TSV at the current selection without touching the system clipboard (synthetic paste event into Sheets' text target). */
export async function syntheticPaste(page, tsv) {
  const ok = await page.evaluate((text) => {
    // Sheets' grid keyboard target; must be focused so the paste lands on the selected range (never the formula bar / name box).
    const el = document.getElementById('waffle-rich-text-editor');
    if (!el) return false;
    if (document.activeElement !== el) el.focus();
    if (document.activeElement !== el) return false;
    const dt = new DataTransfer(); dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  }, tsv).catch(() => false);
  if (ok) await page.waitForTimeout(800);
  return ok;
}
/** Find the first empty row after the last non-empty cell of column A (row 1 = header). */
export async function nextEmptyRow(page) {
  // jump to the physical bottom of column A, then Ctrl+Up to the last value.
  await select(page, 'A1');
  let last = 'A1';
  for (let i = 0; i < 50; i++) { await page.keyboard.press('Control+ArrowDown'); await page.waitForTimeout(200); const now = (await page.locator('#t-name-box').inputValue()).toUpperCase(); if (now === last) break; last = now; }
  const bottom = Number(/^A(\d+)/.exec(last)?.[1]);
  if (!bottom) throw new Error('無法定位 A 欄底部 ' + last);
  if (await formulaBar(page) !== '') return { row: bottom + 1, bottom, full: true };
  await page.keyboard.press('Control+ArrowUp'); await page.waitForTimeout(250);
  const top = Number(/^A(\d+)/.exec((await page.locator('#t-name-box').inputValue()).toUpperCase())?.[1]);
  if (!top) throw new Error('無法定位最後資料列');
  if (top === 1 && await formulaBar(page) === '') return { row: 1, bottom, full: false }; // column A completely empty
  return { row: top + 1, bottom, full: false };
}
