const {chromium}=require('playwright');
const brand=process.argv[2]||'qiezi';const hosts={qiezi:'admin.qzplays.com',songyy:'admin.song-yy.com',winmalo:'admin.winmalo.com'};
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto(`https://${hosts[brand]}:9955/gm/mail`,{waitUntil:'domcontentloaded'});await p.bringToFront();
 const selects=p.locator('[role="button"][aria-haspopup="listbox"]');
 await selects.first().waitFor({timeout:15000});
 console.log('before',JSON.stringify(await selects.evaluateAll(xs=>xs.map((x,i)=>({i,text:x.textContent?.trim(),id:x.id})).slice(0,20))));
 try{await selects.nth(4).click({timeout:5000});}catch(e){console.log('dialog',JSON.stringify(await p.locator('[role="dialog"]').allInnerTexts()));throw e;}
 await p.getByRole('option',{name:'金幣(1)'}).click();
 console.log('afterCoin',JSON.stringify(await selects.evaluateAll(xs=>xs.map((x,i)=>({i,text:x.textContent?.trim(),id:x.id})).slice(0,20))));
 if(brand!=='winmalo'){
  await selects.nth(5).click();await p.getByRole('option',{name:'儲值優惠券(101)'}).click();
  console.log('afterCoupon',JSON.stringify(await selects.evaluateAll(xs=>xs.map((x,i)=>({i,text:x.textContent?.trim(),id:x.id})).slice(0,20))));
  const sub=selects.nth(6);await sub.click();console.log('couponOptions',JSON.stringify(await p.getByRole('option').allInnerTexts()));
 }
 console.log('inputs',JSON.stringify(await p.locator('input[type="number"]').evaluateAll(xs=>xs.map(x=>({placeholder:x.placeholder,name:x.name,html:x.parentElement?.parentElement?.outerHTML.slice(0,200)})).slice(0,15))));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
