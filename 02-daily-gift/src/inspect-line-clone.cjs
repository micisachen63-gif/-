const {chromium}=require('playwright');const brand=process.argv[2]||'songyy';const ids={qiezi:'@334ojgrp',songyy:'@270zjale',winmalo:'@502osqfx'};
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto(`https://manager.line.biz/account/${ids[brand]}/broadcast`,{waitUntil:'domcontentloaded'});await p.bringToFront();await p.getByText('已傳送',{exact:true}).last().click();
 const row=p.locator('tbody tr').first();await row.waitFor();await row.locator('.fa-ellipsis-h').click();await row.getByText('複製',{exact:true}).click();
 await p.waitForTimeout(800);
 console.log(JSON.stringify({url:p.url(),text:(await p.locator('body').innerText()).slice(-2400),buttons:await p.locator('button').evaluateAll(xs=>xs.map(x=>({text:x.textContent?.trim().slice(0,60),title:x.title,aria:x.getAttribute('aria-label')})).filter(x=>x.text||x.title||x.aria).slice(-35)),inputs:await p.locator('input').evaluateAll(xs=>xs.map(x=>({type:x.type,placeholder:x.placeholder,name:x.name,checked:x.checked})).slice(-20)),audienceMarkup:await p.getByText('受眾・傳送記錄',{exact:false}).first().evaluate(e=>e.parentElement?.parentElement?.outerHTML.slice(0,1200))}));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
