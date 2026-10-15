const {chromium}=require('playwright');
const fs=require('node:fs');const path=require('node:path');
(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
 const page=await browser.contexts()[0].newPage();
 try{
  await page.goto('https://script.google.com/u/0/home/projects/1gaFiOGMDLKzTVos7FnbOni9dls2qG3_WxrbIsEUfAXgVjP2xVbc4EVv1/edit',{waitUntil:'domcontentloaded'});
  await page.bringToFront();await page.waitForTimeout(5000);
  console.log('title',await page.title());
  console.log('url',page.url());
  console.log('visible',JSON.stringify((await page.locator('body').innerText()).slice(0,2000)));
  console.log('editors',JSON.stringify(await page.locator('.monaco-editor,.CodeMirror,[role="textbox"]').evaluateAll(els=>els.map(e=>({cls:e.className,tag:e.tagName,text:e.textContent?.slice(0,100)}))).catch(()=>[])));
  const models=await page.evaluate(()=>window.monaco?.editor?.getModels().map(m=>({uri:String(m.uri),value:m.getValue()}))||[]);
  console.log('models',models.map(m=>({uri:m.uri,length:m.value.length})));
  if(models.length)fs.writeFileSync(path.join(__dirname,'..','work','appscript-inspection.txt'),models.map(m=>m.value).join('\n'),'utf8');
 }finally{await page.close();await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
