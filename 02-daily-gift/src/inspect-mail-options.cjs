const {chromium}=require('playwright');
const brand=process.argv[2]||'qiezi';
const hosts={qiezi:'admin.qzplays.com',songyy:'admin.song-yy.com',winmalo:'admin.winmalo.com'};
(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');const page=await browser.contexts()[0].newPage();
 try{
  await page.goto(`https://${hosts[brand]}:9955/gm/mail`,{waitUntil:'domcontentloaded'});await page.bringToFront();
  for(const n of [0,3,4]){
   const b=page.locator('[role="button"][aria-haspopup="listbox"]').nth(n);
   await b.click();
   console.log(JSON.stringify({index:n,current:(await b.innerText()).slice(0,80),options:await page.locator('[role="option"]').allInnerTexts()}));
   await page.keyboard.press('Escape');
  }
 }finally{await page.close();await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
