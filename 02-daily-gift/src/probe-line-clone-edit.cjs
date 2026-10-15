const {chromium}=require('playwright');
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto('https://manager.line.biz/account/@270zjale/broadcast',{waitUntil:'domcontentloaded'});await p.bringToFront();await p.getByText('已傳送',{exact:true}).last().click();
 const first=p.locator('tbody tr').first();await first.waitFor();await first.locator('.fa-ellipsis-h').click();await first.getByText('複製',{exact:true}).click();
 await p.getByText('爽爆新手2025-20260922',{exact:false}).first().locator('..').locator('i.la-times').click();
 await p.getByText('受眾・傳送記錄',{exact:false}).first().locator('..').locator('..').locator('button:has(.la-pen)').click();
 await p.getByText('爽爆新手2025-20260923',{exact:true}).last().waitFor({timeout:15000});
 await p.getByText('爽爆新手2025-20260923',{exact:true}).last().locator('xpath=ancestor::tr').getByText('包含',{exact:true}).click();
 await p.getByRole('button',{name:'新增',exact:true}).last().click();
 await p.locator('input[name="datepicker"]').fill('2026/09/23');
 await p.locator('input[name="timepicker"]').fill('18:00');await p.locator('input[name="timepicker"]').press('Tab');
 console.log(JSON.stringify({audienceText:await p.getByText('受眾・傳送記錄',{exact:false}).first().locator('..').locator('..').innerText(),dateInputs:await p.locator('input[name="datepicker"],input[name="timepicker"]').evaluateAll(xs=>xs.map(x=>({name:x.name,value:x.value,placeholder:x.placeholder}))),timeMarkup:await p.getByText('傳送時間',{exact:true}).first().locator('..').evaluate(x=>x.outerHTML.slice(0,1300))}));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
