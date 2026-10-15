const {chromium}=require('playwright');
const id=process.argv[2];if(!/^[A-Za-z0-9_-]{20,}$/.test(id||''))throw new Error('file ID required');
(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');const page=await browser.contexts()[0].newPage();
 try{
  const wait=page.waitForEvent('download',{timeout:15000});
  await page.goto(`https://drive.google.com/uc?export=download&id=${id}`,{waitUntil:'domcontentloaded'}).catch(()=>{});
  const download=await wait;
  console.log(JSON.stringify({name:download.suggestedFilename(),failure:await download.failure()}));
 }finally{await page.close();await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
