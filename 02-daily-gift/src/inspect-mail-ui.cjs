const {chromium}=require('playwright');
const brand=process.argv[2]||'qiezi';
const hosts={qiezi:'admin.qzplays.com',songyy:'admin.song-yy.com',winmalo:'admin.winmalo.com'};
(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
 const page=await browser.contexts()[0].newPage();
 try{
  await page.goto(`https://${hosts[brand]}:9955/gm/mail`,{waitUntil:'domcontentloaded'});
  await page.bringToFront();await page.waitForTimeout(1800);
  console.log(JSON.stringify({url:page.url(),title:await page.title(),
   buttons:await page.locator('button').evaluateAll(xs=>xs.map(x=>({text:x.textContent?.trim().slice(0,50),title:x.title,aria:x.getAttribute('aria-label')})).filter(x=>x.text||x.title||x.aria).slice(0,50)),
   inputs:await page.locator('input,textarea,[contenteditable="true"]').evaluateAll(xs=>xs.map(x=>({tag:x.tagName,type:x.getAttribute('type'),placeholder:x.getAttribute('placeholder'),aria:x.getAttribute('aria-label')})).slice(0,50)),
   headings:await page.locator('h1,h2,h3,h4,[role="heading"]').allInnerTexts(),
   tabs:await page.locator('[role="tab"]').allInnerTexts(),
   formText:(await page.locator('body').innerText()).slice(0,2500),
   selectRoles:await page.locator('[role="combobox"]').evaluateAll(xs=>xs.map(x=>({text:x.textContent?.trim().slice(0,80),html:x.outerHTML.slice(0,250)})).slice(0,25)),
   labels:await page.locator('label').evaluateAll(xs=>xs.map(x=>({text:x.textContent?.trim().slice(0,70),for:x.htmlFor,html:x.parentElement?.outerHTML.slice(0,550)})).filter(x=>/對象|Icon|信件標題|內容|類型/.test(x.text)).slice(0,20)),
   selects:await page.locator('select').evaluateAll(xs=>xs.map(x=>x.outerHTML.slice(0,900)).slice(0,15)),
   controlMarkup:await page.locator('input,textarea').evaluateAll(xs=>xs.slice(0,13).map(x=>x.parentElement?.outerHTML.slice(0,420)))
  }));
 }finally{await page.close();await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
