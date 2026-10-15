const {chromium}=require('playwright');
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto('https://manager.line.biz/account/@270zjale/broadcast',{waitUntil:'domcontentloaded'});await p.bringToFront();await p.getByText('已傳送',{exact:true}).last().click();const row=p.locator('tbody tr').first();await row.waitFor();await row.locator('.fa-ellipsis-h').click();await row.getByText('複製',{exact:true}).click();
 await p.getByText('受眾・傳送記錄',{exact:false}).first().locator('..').locator('..').locator('button:has(.la-pen)').click();
 await p.waitForTimeout(2000);
 console.log(JSON.stringify({url:p.url(),text:(await p.locator('body').innerText()).slice(-1800),dialogs:await p.locator('[role="dialog"]').allInnerTexts(),buttons:await p.locator('button').evaluateAll(xs=>xs.map(x=>x.textContent?.trim()).filter(Boolean).slice(-25)),inputs:await p.locator('input').evaluateAll(xs=>xs.map(x=>({type:x.type,placeholder:x.placeholder,checked:x.checked})).slice(-15)),rowHtml:await p.getByText('爽爆新手2025-20260923',{exact:true}).last().evaluate(e=>e.closest('tr')?.outerHTML.slice(0,1500))}));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
