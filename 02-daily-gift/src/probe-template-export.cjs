const {chromium}=require('playwright');const fs=require('node:fs');const path=require('node:path');
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 const wait=p.waitForEvent('download',{timeout:15000});
 await p.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/export?format=csv&gid=930631666',{waitUntil:'domcontentloaded'}).catch(()=>{});
 const dl=await wait;const out=path.join(__dirname,'..','work','mail-template-export.csv');await dl.saveAs(out);
 console.log(JSON.stringify({name:dl.suggestedFilename(),size:fs.statSync(out).size,failure:await dl.failure()}));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
