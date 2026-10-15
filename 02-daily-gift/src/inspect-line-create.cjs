const {chromium}=require('playwright');
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto('https://manager.line.biz/account/@270zjale/broadcast/audience',{waitUntil:'domcontentloaded'});await p.bringToFront();
 await p.getByRole('button',{name:'建立',exact:true}).click();
 await p.getByText('使用者識別碼UID上傳').first().waitFor({timeout:10000}).catch(()=>{});
 if(p.url().endsWith('/create')){await p.getByRole('button',{name:'選擇',exact:true}).click();await p.getByText('使用者識別碼UID上傳',{exact:true}).last().click();await p.waitForTimeout(300);}
 console.log(JSON.stringify({url:p.url(),text:(await p.locator('body').innerText()).slice(-1400),buttons:await p.locator('button').evaluateAll(xs=>xs.map(x=>x.textContent?.trim()).filter(Boolean).slice(-15)),links:await p.locator('a').evaluateAll(xs=>xs.map(x=>({text:x.textContent?.trim(),href:x.getAttribute('href')})).filter(x=>/UID|上傳/.test(x.text)).slice(0,10))}));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
