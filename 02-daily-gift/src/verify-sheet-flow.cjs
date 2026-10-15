const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const brand = process.argv[2] || 'qiezi';
const date = process.argv[3] || '2026-09-22';
const tabs = { qiezi: '【茄子】新手禮包', songyy: '【爽爆】新手禮包', winmalo: '【贏麻了】新手禮包' };
if (!tabs[brand]) throw new Error('品牌代碼無效。');
const csvPath = path.join(root, 'work', 'export-check', `${brand}-${date}-verify.csv`);

function parseCsv(text) {
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));if(row.some(v=>v!==''))rows.push(row);row=[];cell='';}else cell+=c;}
  if(cell||row.length){row.push(cell.replace(/\r$/,''));if(row.some(v=>v!==''))rows.push(row);}
  return rows;
}

async function gotoCell(page, address) {
  const box = page.locator('#t-name-box');
  await box.fill(address);
  await box.press('Enter');
}

async function tool(page, name) {
  await page.getByRole('button', { name: '【省時小精靈】' }).click({ force: true });
  await page.getByRole('menuitem', { name, exact: true }).click({ force: true });
}

(async () => {
  if(!fs.existsSync(csvPath)) throw new Error(`找不到驗證 CSV：${csvPath}`);
  const rows=parseCsv(fs.readFileSync(csvPath,'utf8').replace(/^\uFEFF/,''));
  const width=brand==='winmalo'?16:15;
  const tsv=rows.map(row=>row.slice(0,width).map(value=>String(value).replaceAll('\t',' ').replaceAll('\r',' ').replaceAll('\n',' ')).join('\t')).join('\n');
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context=browser.contexts()[0];
  const page=await context.newPage();
  try {
    await context.grantPermissions(['clipboard-read','clipboard-write'], { origin: 'https://docs.google.com' });
    await page.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button',{name:tabs[brand]}).click();
    await gotoCell(page,'A1');
    await page.evaluate(text=>navigator.clipboard.writeText(text),tsv);
    await page.keyboard.press('Control+V');
    await gotoCell(page,'A2');
    await page.keyboard.press('Control+C');
    const copied=await page.evaluate(()=>navigator.clipboard.readText());
    if(copied.trim()!==rows[1][0].trim()) throw new Error(`A2 驗證失敗：預期 ${rows[1][0]}，實際 ${copied}`);
    console.log(`${brand}: 已貼上 ${rows.length-1} 筆，A2 驗證成功。`);
    if(brand==='winmalo') await tool(page,'【生成1:1派送名單】');
    else {
      await tool(page,'【找出充值150以上用戶】');
      await tool(page,'【找出充值未達150用戶】');
    }
    await tool(page,'【使用完畢，清理表格】');
    await page.getByText(/已清理：保護 Q 欄標籤，清除其餘資料/).waitFor({timeout:30000});
    await gotoCell(page,'A2');
    await page.keyboard.press('Control+C');
    const after=await page.evaluate(()=>navigator.clipboard.readText());
    if(after.trim()) throw new Error(`清理後 A2 仍有資料：${after.slice(0,40)}`);
    console.log(`${brand}: 已執行既有 Apps Script，並確認清理後 A2 為空。`);
  } finally { await page.close(); await browser.close(); }
})().catch(error=>{console.error(`ERROR: ${error.message}`);process.exitCode=1;});
