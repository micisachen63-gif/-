const {chromium}=require('playwright');
const brand=process.argv[2];
const tabs={qiezi:{name:'【茄子】新手禮包',gid:'800545005'},songyy:{name:'【爽爆】新手禮包',gid:'0'},winmalo:{name:'【贏麻了】新手禮包',gid:'565202922'}};
if(!tabs[brand])throw new Error('品牌代碼無效。');
async function clickTool(page,name,successPattern){
  await page.locator('.jfk-butterBar-shown').waitFor({state:'hidden',timeout:30000});
  const menu=page.getByRole('button',{name:'【省時小精靈】'});
  await menu.click({force:true});
  if((await menu.getAttribute('aria-expanded'))!=='true')throw new Error(`無法開啟 Apps Script 選單：${name}`);
  const item=page.getByRole('menuitem',{name,exact:true});
  await item.waitFor({state:'visible',timeout:5000});
  await item.click();
  const result=page.getByText(successPattern).last();
  try{await result.waitFor({timeout:30000});}
  catch(error){const body=await page.locator('body').innerText();throw new Error(`${name} 無成功提示；頁面訊息：${body.split('\n').filter(x=>/錯誤|失敗|R2|R3|執行/.test(x)).slice(-6).join(' | ')}`);}
  console.log(`${brand}: ${name} → ${(await result.innerText()).trim()}`);
  await page.locator('.jfk-butterBar-shown').waitFor({state:'hidden',timeout:30000});
}
(async()=>{
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page=await browser.contexts()[0].newPage();
  try{
    await page.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{waitUntil:'domcontentloaded'});
    await page.bringToFront();
    await page.getByRole('button',{name:tabs[brand].name}).click();
    if(!page.url().includes(`gid=${tabs[brand].gid}`))throw new Error('所選工作表不符。');
    if(brand==='winmalo')await clickTool(page,'【生成1:1派送名單】',/1:1派送：\d+ 筆 A_ID 已寫入 R5 & S5/);
    else{await clickTool(page,'【找出充值150以上用戶】',/已寫入 R2/);await clickTool(page,'【找出充值未達150用戶】',/已寫入 R3/);}
  }finally{
    try{
      if(page.url().includes(`gid=${tabs[brand].gid}`)){
        await clickTool(page,'【使用完畢，清理表格】',/已清理：保護 Q 欄標籤/);
        await page.getByText(/已清理：保護 Q 欄標籤，清除其餘資料/).waitFor({timeout:30000});
        console.log(`${brand}: 清理成功。`);
      }
    }finally{await page.close();await browser.close();}
  }
})().catch(error=>{console.error(`ERROR: ${error.message}`);process.exitCode=1;});
