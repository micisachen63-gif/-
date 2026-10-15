const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, notifyRun } = require('./telegram-notify.cjs');

const date = '2026-09-23';
const completed = Object.fromEntries(['qiezi', 'songyy', 'winmalo'].map(brand => [
  `${date}/${brand}`, { status: 'completed', memberCount: 3, mailCount: 3, lineUidCount: 2 },
]));

test('completed report names all three brands and the 18:00 LINE schedule', () => {
  const report = buildReport(date, completed);
  assert.equal(report.complete, true);
  for (const name of ['茄子', '爽爆', '贏麻了']) assert.match(report.text, new RegExp(name));
  assert.match(report.text, /神殿守望者/);
  assert.match(report.text, /18:00/);
});

test('uncertain delivery is reported as a failure, without claiming completion', () => {
  const report = buildReport(date, {
    ...completed,
    [`${date}/songyy`]: { status: 'needs_review', pendingAction: 'gameMail/below150', error: '未確認送出' },
  });
  assert.equal(report.complete, false);
  assert.match(report.text, /待核對 遊戲禮包（未達 150）/);
  assert.doesNotMatch(report.text, /小任務完成啦/);
});

test('failed preparation reports member count without claiming gifts were sent', () => {
  const report = buildReport(date, {
    ...completed,
    [`${date}/qiezi`]: { status: 'failed_preparation', memberCount: 8, error: '登入失效' },
  });
  assert.match(report.text, /茄子：準備時卡住了 ❌｜新會員 8 位/);
  assert.doesNotMatch(report.text, /茄子：[^\n]*已確認禮包/);
});

test('prepared LINE audience is reported as pending automatic scheduling', () => {
  const report = buildReport(date, {
    ...completed,
    [`${date}/qiezi`]: { status: 'awaiting_audience', memberCount: 3, mailCount: 3,
      lineUidCount: 2, pendingAction: 'lineBroadcast' },
  });
  assert.equal(report.complete, false);
  assert.match(report.text, /LINE 受眾尚待就緒/);
  assert.match(report.text, /待安排 LINE 18:00 推播/);
  assert.match(report.text, /自動檢查/);
  assert.doesNotMatch(report.text, /小精靈遇到卡關/);
});

test('same batch result sends once; a changed result sends a new alert', async () => {
  const notificationState = { sent: {} };
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { chat: { id: 123 } } }) };
  };
  const options = { config: { token: '1:example', chatId: '123' }, runs: completed, notificationState, fetchImpl };
  assert.equal((await notifyRun(date, options)).sent, true);
  assert.equal((await notifyRun(date, options)).duplicate, true);
  assert.equal(sent.length, 1);
  options.runs = { ...completed, [`${date}/qiezi`]: { status: 'needs_review', pendingAction: 'lineBroadcast' } };
  assert.equal((await notifyRun(date, options)).sent, true);
  assert.equal(sent.length, 2);
});

test('raw program errors are shown in Chinese in the TG notice', () => {
  const report = buildReport(date, {
    ...completed,
    [`${date}/qiezi`]: { status: 'failed_preparation', memberCount: 8, error: '後台會員匯出失敗：ERROR: locator.check: Timeout 30000ms exceeded.' },
  });
  assert.match(report.text, /後台會員匯出失敗：勾選網頁選項逾時 30 秒/u);
  assert.doesNotMatch(report.text, /locator|Timeout/u);
});
