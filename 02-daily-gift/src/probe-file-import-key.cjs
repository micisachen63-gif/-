const {chromium}=require('playwright');
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{waitUntil:'domcontentloaded'});await p.bringToFront();
 await p.locator('#docs-file-menu').click({force:true});
 await p.keyboard.press('i');await p.waitForTimeout(1500);
 console.log(JSON.stringify({fileExpanded:await p.locator('#docs-file-menu').getAttribute('aria-expanded'),pickerFrames:p.frames().map(f=>f.url()).filter(x=>x.includes('picker')),bodyEnd:(await p.locator('body').innerText()).slice(-300)}));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
