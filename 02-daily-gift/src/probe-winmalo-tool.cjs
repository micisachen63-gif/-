const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page=await browser.contexts()[0].newPage();
  try{
    await page.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{waitUntil:'domcontentloaded'});
    await page.bringToFront();
    await page.getByRole('button',{name:'【贏麻了】新手禮包'}).click();
    await page.locator('.jfk-butterBar-shown').waitFor({state:'hidden',timeout:30000});
    await page.getByRole('button',{name:'【省時小精靈】'}).click({force:true});
    await page.getByRole('menuitem',{name:'【生成1:1派送名單】'}).click();
    await page.getByText(/1:1派送：\d+ 筆 A_ID 已寫入 R5/).waitFor({timeout:30000});
    const butter=await page.locator('.jfk-butterBar').allInnerTexts();
    const box=page.locator('#t-name-box');await box.fill('R5');await box.press('Enter');
    const raw=await page.locator('#t-formula-bar-input').textContent();
    console.log(JSON.stringify({toast:butter.map(x=>x.slice(0,160)),r5Length:raw?.length,r5Count:raw?.split(/[\s,，]+/).filter(Boolean).length}));
    await page.locator('.jfk-butterBar-shown').waitFor({state:'hidden',timeout:30000});
    await page.getByRole('button',{name:'【省時小精靈】'}).click({force:true});
    await page.getByRole('menuitem',{name:'【使用完畢，清理表格】'}).click();
    await page.getByText(/已清理：保護 Q 欄標籤，清除其餘資料/).waitFor({timeout:30000});
    console.log('cleanup: ok');
  }finally{await page.close();await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
