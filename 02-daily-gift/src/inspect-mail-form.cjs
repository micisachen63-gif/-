const {chromium}=require('playwright');
const brand=process.argv[2]||'qiezi';const hosts={qiezi:'admin.qzplays.com',songyy:'admin.song-yy.com',winmalo:'admin.winmalo.com'};
(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');const page=await browser.contexts()[0].newPage();
 try{
  await page.goto(`https://${hosts[brand]}:9955/gm/mail`,{waitUntil:'domcontentloaded'});await page.bringToFront();
  await page.locator('[role="button"][aria-haspopup="listbox"]').first().click();
  await page.getByRole('option',{name:'指定a_id'}).click();
  console.log(JSON.stringify({text:(await page.locator('body').innerText()).slice(-1600),controls:await page.locator('input,textarea').evaluateAll(xs=>xs.map(x=>({tag:x.tagName,name:x.name,placeholder:x.placeholder,type:x.type,parent:x.parentElement?.parentElement?.textContent?.trim().slice(0,70)})).slice(0,20))}));
 }finally{await page.close();await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
