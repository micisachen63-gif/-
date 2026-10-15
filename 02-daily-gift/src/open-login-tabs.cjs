const {chromium}=require('playwright');
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const c=b.contexts()[0];
 const win=await c.newPage();await win.goto('https://admin.winmalo.com:9955/login',{waitUntil:'domcontentloaded'});
 const qz=await c.newPage();await qz.goto('https://admin.qzplays.com:9955/login',{waitUntil:'domcontentloaded'});await qz.bringToFront();
 console.log('茄子與贏麻了登入分頁已留在專用 Chrome，茄子分頁在前。');
 await b.close();
})().catch(e=>{console.error(e.message);process.exitCode=1});
