const {chromium}=require('playwright');const brand=process.argv[2]||'songyy';const ids={qiezi:'@334ojgrp',songyy:'@270zjale',winmalo:'@502osqfx'};
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto(`https://manager.line.biz/account/${ids[brand]}/broadcast`,{waitUntil:'domcontentloaded'});await p.bringToFront();
 await p.getByText('已傳送',{exact:true}).last().click();await p.waitForTimeout(600);
 console.log(JSON.stringify({url:p.url(),text:(await p.locator('body').innerText()).slice(-1100),rows:await p.locator('tbody tr').evaluateAll(xs=>xs.slice(0,5).map(x=>({text:x.textContent?.trim().slice(0,200),html:x.outerHTML.slice(0,450)}))),buttons:await p.locator('button').evaluateAll(xs=>xs.map(x=>({text:x.textContent?.trim().slice(0,40),aria:x.getAttribute('aria-label')})).filter(x=>x.text||x.aria).slice(-20))}));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
