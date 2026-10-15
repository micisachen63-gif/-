import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const brand = process.argv.find(a => a.startsWith('--brand='))?.split('=')[1] || 'all';

console.log('============================================================');
console.log(`🎰 雲端機台狙擊手 (Cloud Slot Sniper) 啟動 - 品牌: ${brand}`);
console.log('時間 (UTC):', new Date().toISOString());
console.log('============================================================\n');

function runBrand(brandName, cwd) {
  return new Promise((resolve) => {
    console.log(`\n▶️ 開始執行「${brandName}」機台掃描...`);
    const p = spawn('node', ['src/index.js', 'run'], {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        HEADLESS: 'true',
        NODE_ENV: 'production'
      }
    });
    p.on('close', (code) => {
      console.log(`⏹️「${brandName}」執行結束，結束碼: ${code}`);
      resolve(code);
    });
  });
}

async function main() {
  const brandsToRun = [];
  if (brand === 'all' || brand === 'shuangbao' || brand === 'sb') {
    brandsToRun.push({ name: '爽爆機台狙擊手', dir: path.join(__dirname, 'shuangbao') });
  }
  if (brand === 'all' || brand === 'qiezi' || brand === 'qz') {
    brandsToRun.push({ name: '茄子機台狙擊手', dir: path.join(__dirname, 'qiezi') });
  }
  if (brand === 'all' || brand === 'yingma' || brand === 'ym') {
    brandsToRun.push({ name: '贏麻選台', dir: path.join(__dirname, 'yingma') });
  }

  for (const b of brandsToRun) {
    await runBrand(b.name, b.dir);
  }

  console.log('\n============================================================');
  console.log('🎉 雲端機台狙擊手本次排程執行完畢！');
  console.log('============================================================\n');
}

main().catch(console.error);
