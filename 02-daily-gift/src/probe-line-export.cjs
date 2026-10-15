const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');const page=await browser.contexts()[0].newPage();
 try{
  await page.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{waitUntil:'domcontentloaded'});await page.bringToFront();
  await page.getByRole('button',{name:'【茄子】新手禮包'}).click();
  await page.getByRole('button',{name:'【省時小精靈】'}).click({force:true});
  await page.getByRole('menuitem',{name:'【LINE推送名單下載】'}).click();
  const alert=page.getByRole('dialog');await alert.waitFor({timeout:30000});
  const msg=await alert.innerText();
  console.log(JSON.stringify({alertPreview:msg.slice(0,130),links:await alert.locator('a').evaluateAll(xs=>xs.map(x=>x.href)),containsUrl:/https:\/\//.test(msg)}));
  await alert.getByRole('button',{name:/確定|OK/}).click();
  await page.getByRole('button',{name:'【省時小精靈】'}).click({force:true});
  await page.getByRole('menuitem',{name:'【使用完畢，清理表格】'}).click();
  await page.getByText(/已清理：保護 Q 欄標籤，清除其餘資料/).waitFor({timeout:30000});
  console.log('cleanup: ok');
 }finally{await page.close();await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
