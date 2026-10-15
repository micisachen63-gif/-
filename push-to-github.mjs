import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const GIT_EXE = 'C:/Users/User/Documents/ChatGPT/tools/git/cmd/git.exe';
const REPO_DIR = 'C:/Users/User/Documents/ChatGPT/ops-automation';
const DEFAULT_URL = 'https://github.com/micisachen63-gif/-.git';

console.log('============================================================');
console.log('  🚀 營運自動化全套組 (Ops Automation) - GitHub 推送工具');
console.log('============================================================\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  console.log('📌 預設遠端倉庫: ' + DEFAULT_URL);
  let url = await rl.question('👉 按 Enter 直接推送至預設倉庫，或貼上其他倉庫網址：\n> ');
  url = url.trim() || DEFAULT_URL;

  console.log('\n[1/3] 設定遠端倉庫 origin -> ' + url);
  await execGit(['remote', 'remove', 'origin']).catch(() => {});
  await execGit(['remote', 'add', 'origin', url]);

  console.log('[2/3] 設定分支名稱為 main');
  await execGit(['branch', '-M', 'main']);

  console.log('[3/3] 開始推送至 GitHub...\n');
  try {
    await execGitInherit(['push', '-u', 'origin', 'main']);
    console.log('\n============================================================');
    console.log('  🎉 恭喜！營運自動化所有專案資料已成功上傳至 GitHub！');
    console.log('============================================================');
  } catch (err) {
    console.log('\n⚠️ 上傳提示：');
    console.log('若提示輸入帳號密碼：');
    console.log('1. Username: 您的 GitHub 使用者名稱');
    console.log('2. Password: 您的 GitHub Personal Access Token (PAT)');
  }
  rl.close();
}

function execGit(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(GIT_EXE, args, { cwd: REPO_DIR, stdio: 'pipe', windowsHide: true });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error('git exit ' + code)));
  });
}

function execGitInherit(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(GIT_EXE, args, { cwd: REPO_DIR, stdio: 'inherit' });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error('git exit ' + code)));
  });
}

main().catch(console.error);
