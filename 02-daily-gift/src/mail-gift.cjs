const fs=require('node:fs');const path=require('node:path');
const {chromium}=require('playwright');
const {adminLogin}=require('./ensure-logins.cjs');
let giftContext=null;
const {downloadTemplates}=require('./mail-template.cjs');
const root=path.resolve(__dirname,'..');
const [brand,date,...flags]=process.argv.slice(2);
const hosts={qiezi:'admin.qzplays.com',songyy:'admin.song-yy.com',winmalo:'admin.winmalo.com'};
if(!hosts[brand]||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw new Error('用法：node src/mail-gift.cjs BRAND YYYY-MM-DD [--verify-only] [--send]');
const verifyOnly=flags.includes('--verify-only'),send=flags.includes('--send');
const requestedGroup=flags.find(x=>x.startsWith('--group='))?.slice('--group='.length);
if(send&&verifyOnly)throw new Error('測試批次禁止寄送。');
const outDir=path.join(root,verifyOnly?'work/flow-check':'staging',date,brand);
const resultPath=path.join(outDir,'sheet-result.json');
if(!fs.existsSync(resultPath))throw new Error('缺少 Apps Script 分組結果。');
const result=JSON.parse(fs.readFileSync(resultPath,'utf8'));
if(result.brand!==brand||result.date!==date)throw new Error('分組批次不符。');
const statePath=path.join(root,'state','runs.json');
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
if(send&&state.runs?.[`${date}/${brand}`]?.status==='completed')throw new Error('此批次已完成，禁止再次寄送。');
if(send&&state.runs?.[`${date}/${brand}`]?.status!=='in_progress')throw new Error('正式寄送前必須先把批次鎖定為 in_progress。');
const rewardGroups=brand==='winmalo'?[['oneToOne',result.groups.oneToOne,58]]:[['atLeast150',result.groups.atLeast150,1000],['below150',result.groups.below150,250]];
if(requestedGroup&&!rewardGroups.some(([name])=>name===requestedGroup))throw new Error('指定的派送分組無效。');
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const effective=`${today} 18:00`;

async function choose(page,index,label){
 const select=page.locator('[role="button"][aria-haspopup="listbox"]').nth(index);
 await select.click();await page.getByRole('option',{name:label,exact:true}).click();
 if((await select.innerText()).trim()!==label)throw new Error(`選項未選成功：${label}`);
}
async function fillMail(page,ids,coins,template){
 await page.goto(`https://${hosts[brand]}:9955/gm/mail`,{waitUntil:'domcontentloaded',timeout:60000});
 await page.bringToFront();
 let ready=await Promise.race([
  page.locator('[role="tab"]').first().waitFor({timeout:20000}).then(()=>'ready',()=>'timeout'),
  page.waitForURL(/\/login(?:\?|$)/,{timeout:20000}).then(()=>'login',()=>'timeout'),
 ]);
 if(page.url().includes('/login')&&page.context()===giftContext){
  // 填表前（尚未送出）發現登出：本視窗自動登回後重開一次。另一個視窗不代登入。
  const relogin=await adminLogin(giftContext,brand).catch(e=>`error: ${e.message.split('\n')[0]}`);
  console.log(`${brand}: 填表前發現後台登出，自動重新登入結果 ${relogin}。`);
  await page.goto(`https://${hosts[brand]}:9955/gm/mail`,{waitUntil:'domcontentloaded',timeout:60000});
  ready=await page.locator('[role="tab"]').first().waitFor({timeout:20000}).then(()=>'ready',()=>'timeout');
 }
 if(page.url().includes('/login'))throw new Error(`${brand} 後台登入已失效；禮包尚未送出。`);
 if(ready!=='ready')await page.locator('[role="tab"]').first().waitFor({timeout:10000});
 await choose(page,0,'指定a_id');
 await page.locator('textarea[name="targetList"]').fill(ids.join(','));
 await page.locator('input[type="tel"]').first().fill(effective);
 await choose(page,3,'信件圖案');
 await page.locator('input[name="iconTitle"]').fill(template.iconTitle);
 await page.locator('input[name="mailTitle"]').fill(template.mailTitle);
 await page.locator('textarea:not([aria-hidden="true"]):not([name="targetList"])').first().fill(template.body);
 await choose(page,4,'金幣(1)');
 if(brand==='winmalo'){
   const wash=page.getByText('金幣綁洗碼量',{exact:true}).locator('..').locator('input[type="number"]');
   if(await wash.count()!==1)throw new Error('找不到贏麻了的金幣綁洗碼量欄位。');
   await wash.fill('20');
 }
 await page.locator('input[placeholder="數量"]').nth(0).fill(String(coins));
 if(brand!=='winmalo'){
   await choose(page,5,'儲值優惠券(101)');
   await choose(page,6,'儲值優惠券20%');
   await page.locator('input[placeholder="數量"]').nth(1).fill('1');
 }
 const actualIds=(await page.locator('textarea[name="targetList"]').inputValue()).split(',').filter(Boolean);
 if(actualIds.length!==ids.length||await page.locator('input[placeholder="數量"]').nth(0).inputValue()!==String(coins))throw new Error('禮包表單驗證失敗。');
 return {count:ids.length,coins,effective};
}

async function backendLoggedIn(context){
 const probe=await context.newPage();
 try{
  await probe.goto(`https://${hosts[brand]}:9955/gm/mail`,{waitUntil:'domcontentloaded',timeout:60000});
  await Promise.race([
   probe.waitForURL(/\/login(?:\?|$)/,{timeout:12000}).catch(()=>{}),
   probe.locator('[role="tab"]').first().waitFor({state:'visible',timeout:12000}).catch(()=>{}),
  ]);
  return !probe.url().includes('/login')&&await probe.locator('[role="tab"]').first().isVisible();
 }finally{await probe.close();}
}

(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
 giftContext=browser.contexts()[0];let backendBrowser=browser,context=giftContext;
 try{
   const templates=await downloadTemplates(giftContext,outDir);
   const template=templates[brand];
   if(!await backendLoggedIn(context)){
     const relogin=await adminLogin(giftContext,brand).catch(e=>`error: ${e.message.split('\n')[0]}`);
     console.log(`${brand}: 後台登入失效，自動重新登入結果 ${relogin}。`);
   }
   if(!await backendLoggedIn(context)){
     try{backendBrowser=await chromium.connectOverCDP('http://127.0.0.1:19385',{timeout:10000});}
     catch{throw new Error(`${brand} 後台兩個既有工作階段均不可用；禮包尚未送出。`);}
     context=backendBrowser.contexts()[0];
     if(!await backendLoggedIn(context))throw new Error(`${brand} 兩個既有工作階段皆需重新登入；禮包尚未送出。`);
     console.log(`${brand}: 改用另一個已登入的專用 Chrome 寄送禮包。`);
   }
   for(const [group,ids,coins] of rewardGroups.filter(([name])=>!requestedGroup||name===requestedGroup)){
     if(!Array.isArray(ids))throw new Error(`${group} 名單無效。`);
     if(!ids.length){console.log(`${brand}/${group}: 0 位，略過。`);continue;}
     const page=await context.newPage();
     try{
       const summary=await fillMail(page,ids,coins,template);
       if(send){
         await page.getByRole('button',{name:'送出',exact:true}).click();
         await page.getByText('寄信成功',{exact:true}).waitFor({timeout:30000});
         console.log(`${brand}/${group}: 已提交 ${summary.count} 位、${coins} 金幣禮包，生效 ${effective}。`);
       }else console.log(`${brand}/${group}: 表單驗證成功 ${summary.count} 位、${coins} 金幣，預計生效 ${effective}；未送出。`);
     }finally{await page.close();}
   }
 }finally{if(backendBrowser!==browser)await backendBrowser.close();await browser.close();}
})().catch(e=>{console.error(`ERROR: ${e.message}`);process.exitCode=1});
