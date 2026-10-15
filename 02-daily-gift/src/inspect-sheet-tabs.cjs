const {chromium}=require('playwright');
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{waitUntil:'domcontentloaded'});await p.bringToFront();
 console.log(JSON.stringify(await p.locator('[role="button"]').evaluateAll(xs=>xs.map(x=>x.textContent?.trim()).filter(x=>x&&/禮包|文案|範本|LINE/.test(x)).slice(0,50))));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
