const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
const profile = path.join(root, 'browser-profile');
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  if (!fs.existsSync(chrome)) throw new Error(`找不到 Chrome：${chrome}`);
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chrome,
    headless: false,
    acceptDownloads: true,
    downloadsPath: path.join(root, 'downloads'),
    args: ['--start-maximized', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222'],
    viewport: null
  });
  const pages = context.pages();
  const urls = [
    config.brands.qiezi.adminUrl,
    config.brands.songyy.adminUrl,
    config.brands.winmalo.adminUrl,
    ...Object.values(config.line.accounts).map(account => account.url)
  ];
  for (let i = 0; i < urls.length; i++) {
    const page = pages[i] || await context.newPage();
    await page.goto(urls[i]);
  }
  console.log('請在此專用 Chrome 視窗逐一登入三個後台與三個 LINE OA 帳號。Google 試算表請沿用既有登入的 Codex 瀏覽器，不在此自動化 Chrome 登入。');
  await new Promise(resolve => context.once('close', resolve));
})().catch(e => { console.error(e.message); process.exit(1); });
