import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const brandArg = args.find(a => a.startsWith('--brand='))?.split('=')[1];
const isAuto = args.includes('--auto');
const brandKeys = {
  shuangbao: 'SHUANGBAO',
  qiezi: 'QIEZI',
  yingma: 'YINGMA',
};

// Calculate Taipei hour (UTC+8)
const now = new Date();
const utcHour = now.getUTCHours();
const scheduledUtcHour = /^0 (\d{1,2}) /.exec(process.env.SCHEDULE_CRON || '')?.[1];
const taipeiHour = ((scheduledUtcHour === undefined ? utcHour : Number(scheduledUtcHour)) + 8) % 24;

console.log('============================================================');
console.log('🎰 雲端機台狙擊手 (Cloud Slot Sniper) 統一排程器');
console.log(`目前時間: UTC ${now.toISOString()} | 台北時間: ${String(taipeiHour).padStart(2, '0')}:00`);
console.log('============================================================\n');

// 官方排程時段定義 (台北時間)
const SCHEDULES = {
  shuangbao: [2, 7, 15, 20],              // 爽爆: 02:00, 07:00, 15:00, 20:00
  qiezi: [0, 8, 10, 12, 14, 18, 20, 22],  // 茄子: 00:00, 08:00, 10:00, 12:00, 14:00, 18:00, 20:00, 22:00
  yingma: [0, 12, 18, 22]                 // 贏麻: 00:00, 12:00, 18:00, 22:00
};

function runBrand(brandName, brandKey, cwd) {
  return new Promise((resolve) => {
    console.log(`\n▶️ 開始執行「${brandName}」機台掃描...`);
    const prefix = brandKeys[brandKey];
    const token = process.env[`${prefix}_TELEGRAM_BOT_TOKEN`];
    const chatId = process.env[`${prefix}_TELEGRAM_CHAT_ID`];
    if (!token || !chatId) {
      console.error(`缺少「${brandName}」的 Telegram 憑證`);
      resolve(1);
      return;
    }
    const p = spawn('node', ['src/index.js', 'run'], {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        HEADLESS: 'true',
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_CHAT_ID: chatId,
      }
    });
    p.on('error', (error) => {
      console.error(error);
      resolve(1);
    });
    p.on('close', (code) => {
      console.log(`⏹️「${brandName}」執行結束，結束碼: ${code}`);
      resolve(code);
    });
  });
}

async function main() {
  const brandsToRun = [];

  if (isAuto) {
    console.log(`🕒 依據當前台北時間 ${taipeiHour}:00 比對應執行之品牌:`);
    if (SCHEDULES.shuangbao.includes(taipeiHour)) {
      console.log('  ✅ 命中 爽爆機台狙擊手 排程');
      brandsToRun.push({ name: '爽爆機台狙擊手', key: 'shuangbao', dir: path.join(__dirname, 'shuangbao') });
    }
    if (SCHEDULES.qiezi.includes(taipeiHour)) {
      console.log('  ✅ 命中 茄子機台狙擊手 排程');
      brandsToRun.push({ name: '茄子機台狙擊手', key: 'qiezi', dir: path.join(__dirname, 'qiezi') });
    }
    if (SCHEDULES.yingma.includes(taipeiHour)) {
      console.log('  ✅ 命中 贏麻選台 排程');
      brandsToRun.push({ name: '贏麻選台', key: 'yingma', dir: path.join(__dirname, 'yingma') });
    }

    if (brandsToRun.length === 0) {
      console.log('  ℹ️ 當前時段無預定排程品牌需執行。');
      return;
    }
  } else {
    const target = brandArg || 'all';
    if (target === 'all' || target === 'shuangbao' || target === 'sb') {
      brandsToRun.push({ name: '爽爆機台狙擊手', key: 'shuangbao', dir: path.join(__dirname, 'shuangbao') });
    }
    if (target === 'all' || target === 'qiezi' || target === 'qz') {
      brandsToRun.push({ name: '茄子機台狙擊手', key: 'qiezi', dir: path.join(__dirname, 'qiezi') });
    }
    if (target === 'all' || target === 'yingma' || target === 'ym') {
      brandsToRun.push({ name: '贏麻選台', key: 'yingma', dir: path.join(__dirname, 'yingma') });
    }
  }

  if (brandsToRun.length === 0) throw new Error(`未知品牌：${brandArg}`);
  let failures = 0;
  for (const b of brandsToRun) {
    if (await runBrand(b.name, b.key, b.dir) !== 0) failures += 1;
  }
  if (failures) throw new Error(`${failures} 個品牌執行失敗`);

  console.log('\n============================================================');
  console.log('🎉 雲端機台狙擊手本次任務執行完畢！');
  console.log('============================================================\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
