import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const date = '2026-09-22';

function fixture(t, csv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-gift-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'inbox', 'qiezi'), { recursive: true });
  fs.copyFileSync(path.join(here, 'cli.js'), path.join(root, 'src', 'cli.js'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(root, 'config.example.json'), JSON.stringify({
    timezone: 'Asia/Taipei',
    brands: { qiezi: { name: '茄子', inbox: './inbox/qiezi', memberIdColumn: 'AID', registeredAtColumn: '創帳時間' } }
  }));
  if (csv !== null) fs.writeFileSync(path.join(root, 'inbox', 'qiezi', `qiezi-${date}.csv`), csv);
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'src', 'cli.js'), ...args], { cwd: root, encoding: 'utf8' });
  const state = () => JSON.parse(fs.readFileSync(path.join(root, 'state', 'runs.json'), 'utf8')).runs[`${date}/qiezi`];
  return { root, run, state };
}

test('prepare accepts only the exact dated export and preserves it on repeat', t => {
  const { root, run, state } = fixture(t, '\uFEFFAID,創帳時間,備註,\r\n1001,2026-09-22 23:59:59,"a,b",\r\n');
  fs.writeFileSync(path.join(root, 'inbox', 'qiezi', 'qiezi-2026-09-21.csv'), 'AID,創帳時間\r\n9999,2026-09-21 12:00:00\r\n');
  assert.equal(run('prepare', '--date', date).status, 0);
  assert.equal(state().memberCount, 1);
  assert.equal(state().status, 'prepared');
  assert.equal(run('prepare', '--date', date).status, 0);
  assert.equal(state().memberCount, 1);
});

test('prepare rejects members outside the requested day and malformed rows', t => {
  const { root, run } = fixture(t, 'AID,創帳時間\r\n1001,2026-09-23 00:00:00\r\n');
  const outside = run('prepare', '--date', date);
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /日期以外/);
  assert.equal(fs.existsSync(path.join(root, 'state', 'runs.json')), false);
  fs.writeFileSync(path.join(root, 'inbox', 'qiezi', `qiezi-${date}.csv`), 'AID,創帳時間\r\n"1001,2026-09-22 08:00:00\r\n');
  const malformed = run('prepare', '--date', date);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /引號未關閉/);
});

test('header-only export produces a verified zero-member batch', t => {
  const { run, state } = fixture(t, 'AID,創帳時間\r\n');
  assert.equal(run('prepare', '--date', date).status, 0);
  assert.equal(state().memberCount, 0);
});

test('changed input cannot silently replace a prepared batch', t => {
  const { root, run, state } = fixture(t, 'AID,創帳時間\r\n1001,2026-09-22 08:00:00\r\n');
  assert.equal(run('prepare', '--date', date).status, 0);
  const initialHash = state().sourceHash;
  fs.writeFileSync(path.join(root, 'inbox', 'qiezi', `qiezi-${date}.csv`), 'AID,創帳時間\r\n1002,2026-09-22 08:00:00\r\n');
  const changed = run('prepare', '--date', date);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /名單與目前 CSV 不同/);
  assert.equal(state().sourceHash, initialHash);
});

test('begin locks dispatch, repeat begin fails, and completion requires all confirmations', t => {
  const { run, state } = fixture(t, 'AID,創帳時間\r\n1001,2026-09-22 08:00:00\r\n');
  assert.equal(run('prepare', '--date', date).status, 0);
  assert.equal(run('complete', '--date', date, '--brand', 'qiezi', '--mail-count', '1', '--line-count', '1', '--mail-verified', '--line-audience-verified', '--line-broadcast-verified', '--cleanup-verified').status === 0, false);
  assert.equal(run('begin', '--date', date, '--brand', 'qiezi').status, 0);
  assert.equal(state().status, 'in_progress');
  assert.notEqual(run('begin', '--date', date, '--brand', 'qiezi').status, 0);
  assert.notEqual(run('complete', '--date', date, '--brand', 'qiezi', '--mail-count', '1', '--line-count', '1', '--cleanup-verified').status, 0);
  assert.equal(run('complete', '--date', date, '--brand', 'qiezi', '--mail-count', '1', '--line-count', '1', '--mail-verified', '--line-audience-verified', '--line-broadcast-verified', '--cleanup-verified').status, 0);
  assert.equal(state().status, 'completed');
  assert.notEqual(run('begin', '--date', date, '--brand', 'qiezi').status, 0);
});

test('begin refuses a changed staging file and leaves the batch prepared', t => {
  const { root, run, state } = fixture(t, 'AID,創帳時間\r\n1001,2026-09-22 08:00:00\r\n');
  assert.equal(run('prepare', '--date', date).status, 0);
  fs.appendFileSync(path.join(root, state().stagingFile), 'tampered');
  const result = run('begin', '--date', date, '--brand', 'qiezi');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /派送檔不存在或已變更/);
  assert.equal(state().status, 'prepared');
});
