const {chromium}=require('playwright');
const brand=process.argv[2]||'songyy';const route=process.argv[3]||'broadcast/audience';
const ids={qiezi:'@334ojgrp',songyy:'@270zjale',winmalo:'@502osqfx'};
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto(`https://manager.line.biz/account/${ids[brand]}/${route}`,{waitUntil:'domcontentloaded'});await p.bringToFront();await p.waitForTimeout(1800);
 console.log(JSON.stringify({url:p.url(),title:await p.title(),text:(await p.locator('body').innerText()).slice(0,2800),buttons:await p.locator('button').evaluateAll(xs=>xs.map(x=>({text:x.textContent?.trim().slice(0,55),aria:x.getAttribute('aria-label'),title:x.title})).filter(x=>x.text||x.aria||x.title).slice(0,40)),inputs:await p.locator('input').evaluateAll(xs=>xs.map(x=>({type:x.type,placeholder:x.placeholder,aria:x.getAttribute('aria-label')})).slice(0,20))}));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
