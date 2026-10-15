import path from 'node:path';
import util from 'node:util';
import {spawn} from 'node:child_process';
import {root} from './util.js';

// Backend logins come from the DPAPI file that 設定後台帳密.cmd (operations-program) maintains.
// Values are decrypted per platform at login time, kept in memory only, never logged.
const HELPER = path.join(root, 'src', 'dpapi.ps1');
const HIDDEN = '[帳密已隱藏]';
const REASONS = {2: '找不到加密帳密檔', 3: '此後台尚未設定帳密', 4: '帳密檔無法解開（換了 Windows 帳號或檔案損壞）', 5: '參數錯誤'};

function powershell() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function runHelper(args, stdin = '') {
  return new Promise((resolve) => {
    const p = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, ...args], {windowsHide: true});
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', () => {}); // ignored on purpose
    const timer = setTimeout(() => p.kill(), 30000);
    p.on('close', (code) => { clearTimeout(timer); resolve({code, stdout: out.trim()}); });
    p.on('error', () => { clearTimeout(timer); resolve({code: -1, stdout: ''}); });
    p.stdin.end(stdin);
  });
}

export function secretPair(username, password) {
  const pair = {};
  Object.defineProperties(pair, {
    username: {value: String(username)}, password: {value: String(password)},
    toJSON: {value: () => HIDDEN}, toString: {value: () => HIDDEN}, [util.inspect.custom]: {value: () => HIDDEN},
  });
  return Object.freeze(pair);
}

export function redact(text, pair) {
  let s = String(text ?? '');
  if (pair?.password) s = s.split(pair.password).join('***');
  if (pair?.username && pair.username.length >= 3) s = s.split(pair.username).join('***');
  return s;
}

export async function backendCredentials(platformKey, file) {
  const r = await runHelper(['-Backend', '-Platform', platformKey, '-Path', file]);
  if (r.code !== 0) throw new Error(`無法取得 ${platformKey} 後台帳密：${REASONS[r.code] || '解密程式未成功結束'}（請確認 營運數據 的 設定後台帳密.cmd 已設定）`);
  let d;
  try { d = JSON.parse(Buffer.from(r.stdout, 'base64').toString('utf8')); } catch { throw new Error('帳密解密結果格式錯誤'); }
  if (!d?.username || !d?.password) throw new Error(`此後台尚未設定帳密：${platformKey}`);
  return secretPair(d.username, d.password);
}

export async function protect(text) {
  const r = await runHelper(['-Protect'], Buffer.from(String(text), 'utf8').toString('base64'));
  if (r.code !== 0 || !r.stdout) throw new Error('DPAPI 加密失敗');
  return r.stdout;
}
export async function unprotect(cipher) {
  const r = await runHelper(['-Unprotect'], String(cipher).trim());
  if (r.code !== 0) throw new Error('DPAPI 解密失敗（是否換了 Windows 帳號？請重新執行 webapp-setup）');
  return Buffer.from(r.stdout, 'base64').toString('utf8');
}
