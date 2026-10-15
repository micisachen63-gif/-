const {chromium}=require('playwright');const fs=require('node:fs');const path=require('node:path');
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{waitUntil:'domcontentloaded'});await p.bringToFront();
 await p.getByRole('button',{name:'新手禮包-信件文案',exact:true}).click();
 console.log('templateUrl',p.url());
 const box=p.locator('#t-name-box'),out={};
 for(let row=1;row<=27;row++)for(const col of ['A','B']){await box.fill(`${col}${row}`);await box.press('Enter');await p.waitForTimeout(120);out[`${col}${row}`]=await p.locator('#t-formula-bar-input').textContent();}
 fs.writeFileSync(path.join(__dirname,'..','work','mail-template-inspection.json'),JSON.stringify(out,null,2),'utf8');
 console.log(JSON.stringify(Object.fromEntries(Object.entries(out).filter(([k,v])=>v).map(([k,v])=>[k,{length:v?.length,preview:v?.slice(0,45)}]))));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
