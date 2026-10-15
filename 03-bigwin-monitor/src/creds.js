import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Shared backend credentials (贏麻了/爽爆/茄子), DPAPI-encrypted by the operations-program helper.
 * The helper prints base64(UTF-8 JSON {"username","password"}). Values stay in memory only:
 * never written, logged, or included in error messages.
 */
export const DEFAULT_CRED_SCRIPT = 'C:\\Users\\User\\Documents\\Codex\\2026-09-18\\new-chat\\outputs\\operations-program\\backend-credentials.ps1';
const PLATFORM = { winmalo: 'win', songyy: 'song', qiezi: 'qz' };
const EXIT_REASON = { 2: '憑證檔不存在', 3: '此平台未設定帳密', 4: '無法解密（DPAPI）' };

export function credPlatform(brand) {
  return brand.credPlatform || PLATFORM[brand.key] || new URL(brand.uiBase).hostname;
}

function runPowershell(args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); resolve({ code: 'timeout', stdout: '' }); } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve({ code: 'spawn', stdout: '' }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout: out }); } });
  });
}

export async function decryptBackendCreds(brand, { script = DEFAULT_CRED_SCRIPT, run = runPowershell, timeoutMs = 30000, exists = fs.existsSync } = {}) {
  const platform = credPlatform(brand);
  if (!exists(script)) throw new Error(`帳密解密失敗（${platform}：找不到解密腳本 ${script}）`);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Decrypt', '-Platform', platform];
  const { code, stdout } = await run(args, timeoutMs);
  if (code !== 0) throw new Error(`帳密解密失敗（${platform}：${EXIT_REASON[code] || (code === 'timeout' ? '逾時' : `exit ${code}`)}）`);
  let j = null;
  try { j = JSON.parse(Buffer.from(String(stdout).trim(), 'base64').toString('utf8')); } catch { /* handled below */ }
  if (!j || typeof j.username !== 'string' || typeof j.password !== 'string' || !j.username || !j.password) {
    throw new Error(`帳密解密失敗（${platform}：輸出格式不符）`);
  }
  return { username: j.username, password: j.password };
}

/** Removes any credential value from a message before it is logged or returned. */
export function scrubCreds(message, creds) {
  let s = String(message ?? '');
  for (const v of [creds?.password, creds?.username]) if (v) s = s.split(v).join('***');
  return s;
}
