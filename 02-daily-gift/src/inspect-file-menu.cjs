const {chromium}=require('playwright');
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{waitUntil:'domcontentloaded'});await p.bringToFront();
 const fm=p.locator('#docs-file-menu');await fm.click({force:true});
 console.log(JSON.stringify({expanded:await fm.getAttribute('aria-expanded'),menus:await p.locator('[role="menu"]').evaluateAll(xs=>xs.filter(x=>getComputedStyle(x).visibility!=='hidden').map(x=>({text:x.textContent?.trim().slice(0,600),html:x.outerHTML.slice(0,250)}))),items:await p.locator('[role="menuitem"]').evaluateAll(xs=>xs.filter(x=>x.textContent?.trim().startsWith('匯入')).map(x=>({text:x.textContent,rect:x.getBoundingClientRect().toJSON(),visible:getComputedStyle(x).visibility,html:x.outerHTML.slice(0,350)})))}));
 await p.keyboard.press('Escape');
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
