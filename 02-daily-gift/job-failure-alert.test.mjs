import test from 'node:test';
import assert from 'node:assert/strict';
import {failureText} from './job-failure-alert.mjs';

test('a failed job names the affected notice and points to the local log',()=>{
  const fortune=failureText('fortune','2026-09-24');
  const digest=failureText('digest','2026-09-24');
  assert.match(fortune,/澄的運勢通知/);
  assert.match(fortune,/daily_fortune\/logs\/2026-09-24\.log/);
  assert.match(digest,/小精靈八卦通知/);
  assert.match(digest,/daily_digest\/logs\/2026-09-24\.log/);
});

test('unknown jobs cannot send a failure notice',()=>{
  assert.throws(()=>failureText('other','2026-09-24'));
});
