const test = require('node:test');
const assert = require('node:assert/strict');
const { yesterdayTaipei, verifyPrepared, shouldReplaceAudience } = require('./resume-broadcasts.cjs');

test('retry targets yesterday in Taipei across UTC midnight', () => {
  assert.equal(yesterdayTaipei(new Date('2026-09-23T23:30:00Z')), '2026-09-23');
});

test('retry only schedules after gifts, sheet cleanup and audience are confirmed', () => {
  const ready = { status: 'awaiting_audience', sheetProcessed: true, cleanupVerified: true,
    mailCount: 3, pendingAction: 'lineBroadcast', actions: { lineAudience: { confirmedAt: '2026-09-23T23:00:00Z' } } };
  assert.doesNotThrow(() => verifyPrepared(ready));
  assert.throws(() => verifyPrepared({ ...ready, cleanupVerified: false }), /確認紀錄/u);
  assert.throws(() => verifyPrepared({ ...ready, actions: { ...ready.actions, lineBroadcast: {} } }), /確認紀錄/u);
});

test('pending audience is replaced once after five minutes, never repeatedly', () => {
  const uploadedAt = '2026-09-24T00:00:00Z';
  const run = {actions:{lineAudience:{confirmedAt:uploadedAt,retryCount:0}}};
  assert.equal(shouldReplaceAudience(run,new Date('2026-09-24T00:04:59Z')),false);
  assert.equal(shouldReplaceAudience(run,new Date('2026-09-24T00:05:00Z')),true);
  run.actions.lineAudience.retryCount=1;
  assert.equal(shouldReplaceAudience(run,new Date('2026-09-24T00:30:00Z')),false);
  assert.throws(()=>shouldReplaceAudience({actions:{lineAudience:{}}}),/上傳時間缺失/u);
});

const { canRetryBroadcast, reportError } = require('./resume-broadcasts.cjs');

test('a booking that failed before submit is retried at most three times; uncertain results are not', () => {
  assert.equal(canRetryBroadcast({ code: 5, error: '' }, {}), true);
  assert.equal(canRetryBroadcast({ code: 5, error: '' }, { broadcastAttempts: 3 }), false);
  assert.equal(canRetryBroadcast({ code: 1, error: '' }, {}), false);
  assert.equal(canRetryBroadcast({ code: null, error: 'spawnSync node ETIMEDOUT' }, {}), false);
});

test('child errors are reported in plain Chinese', () => {
  assert.match(reportError({ code: 1, error: '', output: 'x\nERROR: locator.waitFor: Timeout 20000ms exceeded.' }), /逾時 20 秒/u);
  assert.equal(reportError({ code: null, error: 'spawnSync node ETIMEDOUT', output: '' }), '子程式執行過久被中止');
});
