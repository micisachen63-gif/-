const {chromium}=require('playwright');
const brand=process.argv[2]||'qiezi';const hosts={qiezi:'admin.qzplays.com',songyy:'admin.song-yy.com',winmalo:'admin.winmalo.com'};
(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:9222');const p=await b.contexts()[0].newPage();try{
 await p.goto(`https://${hosts[brand]}:9955/gm/mail`,{waitUntil:'domcontentloaded'});await p.bringToFront();await p.waitForTimeout(1500);
 if(!p.url().includes('/login')){console.log(`${brand}: already logged in`);return;}
 const user=p.locator('input[name="login_account"]'),pass=p.locator('input[name="login_password"]');
 await user.click();await p.keyboard.press('ArrowDown');await p.keyboard.press('Enter');await p.waitForTimeout(400);
 let filled={user:!!(await user.inputValue()),password:!!(await pass.inputValue())};
 if(!filled.user||!filled.password){await pass.click();await p.keyboard.press('ArrowDown');await p.keyboard.press('Enter');await p.waitForTimeout(400);filled={user:!!(await user.inputValue()),password:!!(await pass.inputValue())};}
 if(filled.user&&filled.password){await p.getByRole('button',{name:'登入'}).click();await p.waitForTimeout(1200);}
 console.log(JSON.stringify({brand,filled,loggedIn:!p.url().includes('/login')}));
}finally{await p.close();await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
