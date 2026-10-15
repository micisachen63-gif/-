// 社群派獎 live form filler, used by mail-sender.js when payout is live (2026-10-06 autopay).
// Errors thrown before 送出 carry notSubmitted=true (safe to retry; loginRequired=true when the page is the login page);
// errors after 送出 (no 寄信成功) carry uncertain=true and must never be retried automatically.
// Fills the same backend /gm/mail form as the 新手禮包 automation (daily_gift/src/mail-gift.cjs, same selectors):
// 指定a_id → targetList, 生效時間, 信件圖案 → iconTitle, mailTitle, body, 金幣(1) 數量, and on 贏麻 the
// 金幣綁洗碼量 field (= 打碼倍數; 爽爆 has no such field). Clicks 送出 only when submit === true.
export const taipeiMinute = (ms) => new Date(ms + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);

async function choose(page, index, label) {
  const select = page.locator('[role="button"][aria-haspopup="listbox"]').nth(index);
  await select.click(); await page.getByRole('option', { name: label, exact: true }).click();
  if ((await select.innerText()).trim() !== label) throw new Error(`選項未選成功：${label}`);
}

export async function fillCommunityMail(page, { uiBase, brandKey, aids, iconTitle, title, body, amount, multiplier = 0, effective = taipeiMinute(Date.now()), submit = false }) {
  try {
    if (!aids?.length) throw new Error('沒有收件 AID');
    await page.goto(`${uiBase}/gm/mail`, { waitUntil: 'domcontentloaded' });
    const ready = await page.locator('[role="tab"]').first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (page.url().includes('/login')) throw Object.assign(new Error(`${brandKey} 後台登入已失效；獎金尚未送出。`), { loginRequired: true });
    if (!ready) throw new Error(`${brandKey} 派獎頁面沒有載入；獎金尚未送出。`);
    await choose(page, 0, '指定a_id');
    await page.locator('textarea[name="targetList"]').fill(aids.join(','));
    await page.locator('input[type="tel"]').first().fill(effective);
    await choose(page, 3, '信件圖案');
    await page.locator('input[name="iconTitle"]').fill(iconTitle || title);
    await page.locator('input[name="mailTitle"]').fill(title);
    await page.locator('textarea:not([aria-hidden="true"]):not([name="targetList"])').first().fill(body);
    await choose(page, 4, '金幣(1)');
    if (brandKey === 'winmalo' && Number(multiplier) > 0) {
      const wash = page.getByText('金幣綁洗碼量', { exact: true }).locator('..').locator('input[type="number"]');
      if (await wash.count() !== 1) throw new Error('找不到贏麻了的金幣綁洗碼量欄位。');
      await wash.fill(String(multiplier));
      if (await wash.inputValue() !== String(multiplier)) throw new Error('金幣綁洗碼量驗證失敗。');
    }
    await page.locator('input[placeholder="數量"]').nth(0).fill(String(amount));
    const ids = (await page.locator('textarea[name="targetList"]').inputValue()).split(',').filter(Boolean);
    if (ids.length !== aids.length || ids.some((x, i) => x !== String(aids[i])) || await page.locator('input[placeholder="數量"]').nth(0).inputValue() !== String(amount)) throw new Error('派獎表單驗證失敗。');
  } catch (error) { error.notSubmitted = true; throw error; }
  if (!submit) return { filled: true, submitted: false, effective };
  try {
    await page.getByRole('button', { name: '送出', exact: true }).click();
  } catch (error) { error.uncertain = true; throw error; } // a failed click may still have fired
  try {
    await page.getByText('寄信成功', { exact: true }).waitFor({ timeout: 30000 });
  } catch (error) { error.uncertain = true; throw error; }
  return { filled: true, submitted: true, effective };
}
