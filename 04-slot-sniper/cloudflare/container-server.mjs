import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const brand = process.env.BRAND;
if (!['shuangbao', 'qiezi', 'yingma'].includes(brand)) throw new Error('Invalid BRAND');
const root = `/app/04-slot-sniper/${brand}`;
const statePath = path.join(root, 'logs', 'last-run.json');
let current = null;
let last = null;

function start(command, dryRun = false) {
  if (current) return false;
  const startedAt = new Date().toISOString();
  const args = ['src/index.js', command];
  if (dryRun) args.push('--dry-run');
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, DISPLAY: ':99', HEADLESS: command === 'login' ? 'false' : 'true' },
    stdio: 'inherit',
  });
  current = { command, dryRun, startedAt, pid: child.pid };
  child.once('error', error => {
    last = { ...current, finishedAt: new Date().toISOString(), ok: false, error: error.message };
    current = null;
  });
  child.once('close', code => {
    if (!current) return;
    last = { ...current, finishedAt: new Date().toISOString(), ok: code === 0, exitCode: code };
    current = null;
  });
  return true;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://container');
  const json = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  if (request.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, brand });
  if (request.method === 'GET' && url.pathname === '/status') {
    let summary = null;
    try { summary = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* no result yet */ }
    return json(200, { current, last, summary });
  }
  if (request.method === 'POST' && url.pathname === '/login') {
    const accepted = start('login');
    return json(accepted ? 202 : 409, { accepted, current });
  }
  if (request.method === 'POST' && url.pathname === '/run') {
    const dryRun = url.searchParams.get('dry') === '1';
    const accepted = start('run', dryRun);
    return json(accepted ? 202 : 409, { accepted, current });
  }
  return json(404, { error: 'Not found' });
});
server.listen(8080, '0.0.0.0');
