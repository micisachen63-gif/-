const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {chromium}=require('playwright');
const {gotoWithRelogin}=require('./ensure-logins.cjs');
const root=path.resolve(__dirname,'..');
const [brand,date,...flags]=process.argv.slice(2);
const accounts={qiezi:{id:'@334ojgrp',name:'茄子'},songyy:{id:'@270zjale',name:'爽爆'},winmalo:{id:'@502osqfx',name:'贏麻了'}};
if(!accounts[brand]||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw new Error('用法：node src/line-audience.cjs BRAND YYYY-MM-DD [--verify-only] [--update|--replace]');
const verifyOnly=flags.includes('--verify-only'),update=flags.includes('--update'),replace=flags.includes('--replace');
if([verifyOnly,update,replace].filter(Boolean).length>1)throw new Error('LINE 受眾測試、建立與重傳模式不得併用。');
const outDir=path.join(root,verifyOnly?'work/flow-check':'staging',date,brand);
const sheetResult=JSON.parse(fs.readFileSync(path.join(outDir,'sheet-result.json'),'utf8'));
if(sheetResult.brand!==brand||sheetResult.date!==date)throw new Error('分組批次不符。');
const lineFile=path.join(root,sheetResult.lineFile);
const uids=fs.readFileSync(lineFile,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
if(uids.length!==sheetResult.lineCount||new Set(uids).size!==uids.length)throw new Error('LINE UID 檔與試算表結果不一致。');
if(uids.some(id=>!/^U[0-9a-f]{32}$/i.test(id)))throw new Error('LINE UID 檔含格式不正確的識別碼。');
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const audienceName=`${accounts[brand].name}新手2025-${today.replaceAll('-','')}`;
const uploadFile=path.join(outDir,`${audienceName}.csv`);
fs.writeFileSync(uploadFile,uids.join('\r\n')+'\r\n','utf8');
if(update||replace){
 const runs=JSON.parse(fs.readFileSync(path.join(root,'state','runs.json'),'utf8')).runs||{};
 const run=runs[`${date}/${brand}`];
 if(run?.status!=='in_progress'||(replace&&run.pendingAction!=='lineAudienceReplace'))throw new Error('正式更新前必須先把批次鎖定為對應的 in_progress 動作。');
 if(replace&&(run.actions?.lineAudience?.retryCount||0)>0)throw new Error('LINE 受眾已重傳過一次，禁止再次自動刪除。');
}

function audienceId(href){const id=href?.match(/\/broadcast\/audience\/edit\/(\d+)$/)?.[1];if(!id)throw new Error('LINE 受眾 ID 無法辨識。');return id;}
async function uniqueLink(page,required){
 const links=page.getByRole('link',{name:audienceName,exact:true});
 if(required)await links.first().waitFor({timeout:15000});
 const count=await links.count();
 if(count>1)throw new Error(`LINE 有 ${count} 筆同名受眾，須先人工核對，禁止自動修改。`);
 if(required&&count!==1)throw new Error('找不到本批次 LINE 受眾。');
 return count?links.first():null;
}
async function create(page){
 await page.getByRole('button',{name:'建立',exact:true}).click();
 await page.getByRole('button',{name:'選擇',exact:true}).click();
 await page.getByText('使用者識別碼UID上傳',{exact:true}).last().click();
 await page.locator('input[type="text"]').last().fill(audienceName);
 await page.getByRole('button',{name:'下一步',exact:true}).click();
 // 「下一步」會先建立空受眾；等待編輯頁載入後才上傳檔案。
 await page.waitForURL(/\/broadcast\/audience\/edit\/\d+$/,{timeout:20000});
 return audienceId(page.url());
}
async function uploadAndVerify(page,base,id){
 await page.locator('input[type="file"]').waitFor({timeout:15000});
 await page.locator('input[type="file"]').setInputFiles(uploadFile);
 await page.getByText(path.basename(uploadFile),{exact:true}).last().waitFor({state:'visible',timeout:20000});
 await page.getByRole('button',{name:'更新',exact:true}).last().click();
 await page.waitForURL(base,{timeout:30000});
 await page.getByRole('button',{name:'建立',exact:true}).waitFor({timeout:15000});
 const link=await uniqueLink(page,true);
 if(audienceId(await link.getAttribute('href'))!==id)throw new Error('LINE 上傳後受眾 ID 改變，須人工核對。');
 const status=(await link.locator('xpath=ancestor::tr').locator('td').last().innerText()).trim();
 await link.click();
 await page.getByText('已登錄的檔案',{exact:true}).waitFor({timeout:15000});
 await page.getByText(path.basename(uploadFile),{exact:true}).last().waitFor({state:'visible',timeout:15000});
 return status;
}
async function deletePending(page,base,link){
 const row=link.locator('xpath=ancestor::tr');
 if((await row.locator('td').last().innerText()).trim()!=='準備中')throw new Error('LINE 受眾已非準備中，禁止自動刪除。');
 const id=audienceId(await link.getAttribute('href'));
 await link.click();
 await page.getByText(`受眾ID : ${id}`,{exact:false}).waitFor({timeout:15000});
 await page.getByRole('button',{name:'刪除',exact:true}).first().click();
 await page.getByText('確定要刪除嗎？',{exact:true}).waitFor({timeout:10000});
 await page.getByRole('button',{name:'刪除',exact:true}).last().click();
 await page.waitForURL(base,{timeout:20000});
 await page.getByRole('button',{name:'建立',exact:true}).waitFor({timeout:15000});
 if(await page.getByRole('link',{name:audienceName,exact:true}).count())throw new Error('原 LINE 受眾刪除後仍存在，停止重傳。');
 return id;
}

(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');const page=await browser.contexts()[0].newPage();
 try{
  const base=`https://manager.line.biz/account/${accounts[brand].id}/broadcast/audience`;
  await gotoWithRelogin(page,base,{kind:'line',brand,ready:page.getByRole('button',{name:'建立',exact:true}),timeout:60000});await page.bringToFront();
  await page.getByRole('button',{name:'建立',exact:true}).waitFor({timeout:45000});
  const link=await uniqueLink(page,false);
  if(!update&&!replace){console.log(`${brand}: LINE 受眾 ${audienceName} ${link?'已存在':'需建立'}，UID ${uids.length} 筆；未上傳。`);return;}
  if(!uids.length)throw new Error('沒有 LINE UID，無法建立或更新受眾。');
  if(replace){
   if(!link)throw new Error('準備中的 LINE 受眾已消失，禁止盲目重傳。');
   const check=spawnSync(process.execPath,[path.join(__dirname,'line-broadcast.cjs'),brand,date,'--check-scheduled'],{cwd:root,encoding:'utf8',timeout:45000});
   if(check.status!==3||check.error)throw new Error('已有 LINE 預約或無法確認是否已有預約，禁止刪除受眾。');
   await deletePending(page,base,link);
  }else if(link){await link.click();await page.waitForURL(/\/broadcast\/audience\/edit\/\d+$/,{timeout:30000});}
  const id=replace||!link?await create(page):audienceId(page.url());
  const status=await uploadAndVerify(page,base,id);
  console.log(`${brand}: LINE 受眾已${replace?'刪除舊筆並重傳':link?'更新':'建立'}，${uids.length} UID；ID ${id}，檔案已登錄，狀態 ${status}。`);
 }finally{await page.close();await browser.close();}
})().catch(e=>{console.error(`ERROR: ${e.message}`);process.exitCode=1});
