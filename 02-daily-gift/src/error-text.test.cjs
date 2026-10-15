const test=require('node:test');
const assert=require('node:assert/strict');
const {humanizeError}=require('./error-text.cjs');

test('Playwright and Node errors become plain Chinese; Chinese errors stay unchanged',()=>{
  assert.equal(humanizeError('LINE 預約結果不明：ERROR: locator.waitFor: Timeout 20000ms exceeded.'),'LINE 預約結果不明：等待網頁元素出現逾時 20 秒（網頁載入慢、登入失效或版面改了）');
  assert.match(humanizeError('ERROR: locator.check: Timeout 30000ms exceeded.'),/^勾選網頁選項逾時 30 秒/u);
  assert.match(humanizeError("qiezi: LINE 受眾檢查失敗：ERROR: locator.waitFor: Error: strict mode violation: getByText('x').locator('xpath=ancestor::tr') resolved to 2 elements:"),/^qiezi: LINE 受眾檢查失敗：頁面上同時出現 2 個相同項目/u);
  assert.equal(humanizeError('spawnSync C:\\Program Files\\nodejs\\node.exe ETIMEDOUT'),'執行時間過長被中止');
  assert.equal(humanizeError('清理後工作表仍有會員或派送資料。'),'清理後工作表仍有會員或派送資料。');
  assert.equal(humanizeError(''),'');
});
