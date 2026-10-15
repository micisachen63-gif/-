const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const {gotoWithRelogin}=require('./ensure-logins.cjs');
const root=path.resolve(__dirname,'..');
const [brand,date,...flags]=process.argv.slice(2);
const tabs={qiezi:'【茄子】新手禮包',songyy:'【爽爆】新手禮包',winmalo:'【贏麻了】新手禮包'};
if(!tabs[brand]||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw new Error('用法：node src/import-members.cjs BRAND YYYY-MM-DD [--verify-only]');
const verifyOnly=flags.includes('--verify-only');
const csv=verifyOnly?path.join(root,'work','export-check',`${brand}-${date}-verify.csv`):path.join(root,'inbox',brand,`${brand}-${date}.csv`);
if(!fs.existsSync(csv))throw new Error(`找不到 CSV：${csv}`);
const firstAid=fs.readFileSync(csv,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)[1]?.split(',')[0]?.replaceAll('"','').trim();
if(!/^\d+$/.test(firstAid||''))throw new Error('CSV 第一位會員 AID 無效。');

async function importOnce(attempt){
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page=await browser.contexts()[0].newPage();
  try{
    await gotoWithRelogin(page,'https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{kind:'google',ready:page.getByRole('button',{name:'【省時小精靈】'}),timeout:30000});
    await page.bringToFront();
    await page.getByRole('button',{name:'【省時小精靈】'}).waitFor({state:'visible',timeout:15000});
    await page.getByRole('button',{name:tabs[brand]}).click();
    const expectedGid={qiezi:'800545005',songyy:'0',winmalo:'565202922'}[brand];
    if(!page.url().includes(`gid=${expectedGid}`))throw new Error('選取的 Google 工作表不是指定品牌。');
    const box=page.locator('#t-name-box');await box.fill('A1');await box.press('Enter');
    await page.locator('.jfk-butterBar-shown').waitFor({state:'hidden',timeout:30000});
    const fileMenu=page.locator('#docs-file-menu');
    const importItem=page.getByRole('menuitem',{name:/^匯入/});
    let opened=false;
    for(let attempt=0;attempt<3&&!opened;attempt++){
      if(attempt)await page.keyboard.press('Escape');
      await fileMenu.click();
      try {
        await importItem.click({timeout:7000});
        await page.frameLocator('iframe[src*="/picker?"]').getByRole('tab',{name:'上傳'}).waitFor({state:'visible',timeout:12000});
        opened=true;
      } catch { await page.keyboard.press('Escape'); }
    }
    if(!opened)throw new Error('無法穩定開啟 Google 試算表的匯入視窗。');
    const picker=page.frameLocator('iframe[src*="/picker?"]');
    await picker.getByRole('tab',{name:'上傳'}).waitFor({state:'visible',timeout:45000});
    await picker.getByRole('tab',{name:'上傳'}).click();
    const chooser=page.waitForEvent('filechooser');
    await picker.getByRole('button',{name:'瀏覽'}).click();
    await (await chooser).setFiles(csv);
    try{await page.getByText('匯入位置',{exact:true}).waitFor({timeout:60000});}
    catch(error){
      const dialogs=await page.locator('[role="dialog"]').allInnerTexts().catch(()=>[]);
      const screenshot=path.join(root,'logs',`import-${brand}-${date}-attempt-${attempt}.png`);
      await page.screenshot({path:screenshot,fullPage:false}).catch(()=>{});
      const pickerState=await page.frameLocator('iframe[src*="/picker?"]').locator('body').innerText({timeout:3000}).catch(()=>'(選檔視窗已關閉)');
      throw new Error(`CSV 上傳後沒有顯示匯入設定；視窗狀態：${dialogs.map(x=>x.slice(0,300)).join(' | ')||'(無對話框)'}；選檔視窗：${pickerState.slice(0,180)}；截圖：${screenshot}`);
    }
    await page.getByText('建立新試算表',{exact:true}).click();
    await page.getByText('取代所選儲存格中的資料',{exact:true}).click();
    const selected=await page.locator('[role="dialog"]').last().innerText();
    if(!selected.includes('取代所選儲存格中的資料'))throw new Error('匯入模式未選成取代所選儲存格。');
    await page.getByRole('button',{name:'匯入資料'}).click();
    if(!page.url().includes(`gid=${expectedGid}`))throw new Error('匯入後切換到非目標品牌工作表。');
    await box.fill('A2');await box.press('Enter');
    await page.waitForFunction(expected=>document.querySelector('#t-formula-bar-input')?.textContent?.trim()===expected,firstAid,{timeout:15000});
    console.log(`${brand}: CSV 已匯入到 ${tabs[brand]}，首筆 AID 驗證成功。`);
  }finally{await page.close();await browser.close();}
}
(async()=>{
  let lastError;
  for(let attempt=1;attempt<=3;attempt++){
    try{await importOnce(attempt);return;}
    catch(error){lastError=error;if(attempt<3){console.warn(`${brand}: 匯入第 ${attempt} 次未完成，重新開啟試算表重試。`);await new Promise(resolve=>setTimeout(resolve,3000*attempt));}}
  }
  throw lastError;
})().catch(error=>{console.error(`ERROR: ${error.message}`);process.exitCode=1;});
