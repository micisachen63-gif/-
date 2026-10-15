import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {notifyOperations} from './telegram-notify.mjs';
import {AUTO_RETRY_DELAY_MS,canRetryStartupFailure,failedPlatformKeys,MAX_AUTO_RETRIES} from './auto-retry.mjs';
import {acquireRunLock} from './run-lock.mjs';
import {guardedRun,readTelegramConfigPath,DEFAULT_RUN_TIMEOUT_MS} from './run-guard.mjs';
import {validateDailySource} from './source-validation.mjs';
// Only crash-proof modules are imported statically. Everything that can fail at load time
// (config parsing, Playwright runtime) is imported inside the guarded run so that a failure
// still produces a status record, a Telegram failure notice (scheduled runs) and exit code 1.
const root=path.dirname(fileURLToPath(import.meta.url));
const args=new Set(process.argv.slice(2)),apply=args.has('--apply'),scheduled=args.has('--scheduled');
// --no-fallback: never read through the backup Chrome (9222), so a preview proves the self-login.
const noFallback=args.has('--no-fallback');
const keepOtherFailures=args.has('--keep-other-failures');
const resumeRun=process.argv.find(a=>a.startsWith('--resume-source-run='))?.slice('--resume-source-run='.length);
const onlyKeys=process.argv.find(a=>a.startsWith('--only-platforms='))?.slice('--only-platforms='.length)?.split(',');
const runId=new Date().toISOString().replace(/[:.]/g,'-'),folder=path.join(root,'private','runs',runId);
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const status={runId,mode:apply?'apply':'preview',date:today,through:null,weeklyPlanned:false,started:new Date().toISOString(),platforms:[],completed:false,...(noFallback?{noFallback:true}:{})};
const log=async()=>{await fs.mkdir(folder,{recursive:true});await fs.mkdir(path.join(root,'logs'),{recursive:true});await fs.writeFile(path.join(root,'logs','latest.json'),JSON.stringify(status,null,2));await fs.writeFile(path.join(folder,'status.json'),JSON.stringify(status,null,2));};
let context,lock,lockAttempted=false,telegramConfigPath=null;

async function work(){
 const raw=await fs.readFile(path.join(root,'config.json'),'utf8');
 telegramConfigPath=readTelegramConfigPath(raw);
 const config=JSON.parse(raw.replace(/^\uFEFF/,''));
 const [{browser,chromium},{dates,makePlan,revenuePlan},{collect,collectWeekly},{includeWeekly},{openSheet,snapshot,applyChanges,weeklyPlan,applyWeekly,applyRevenueMonthStructure,applyMemberAnalysis,applyCoinMonthStructure},{readWithFallback},{compactDailyPlan,mergeChanges,revenueMonthStructure,memberAnalysisPlan,weeklyClosingMerchantPlan,revenueClosingMerchantPlan,coinMonthStructure}]=await Promise.all([
  import('./runtime.mjs'),import('./core.mjs'),import('./backend.mjs'),import('./schedule-policy.mjs'),import('./sheets.mjs'),import('./login.mjs'),import('./month-rollover.mjs'),
 ]);
 const d=dates();d.monday=includeWeekly(d,{scheduled,dailyOnly:args.has('--daily-only'),weeklyEnabled:config.weeklyEnabled});
 Object.assign(status,{date:d.today,through:d.to,weeklyPlanned:d.monday});
 if(Boolean(resumeRun)!==Boolean(onlyKeys)||resumeRun&&!/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(resumeRun))throw Error('續跑來源與指定平台必須同時提供，且執行編號格式正確');
 if(keepOtherFailures&&(!resumeRun||scheduled))throw Error('保留其他失敗平台僅供手動續跑使用');
 let resumeFolder=null;
 if(resumeRun){
  if(!apply||(d.rollover?config.approvedMonth!==d.previousMonthKey:config.approvedMonth!==d.monthKey))throw Error('僅允許尚未完成、月份已核准的當日寫入續跑');
  const requested=new Set(onlyKeys);
  if(requested.size!==onlyKeys.length||!requested.size||onlyKeys.some(key=>!config.platforms.some(p=>p.key===key)))throw Error('續跑平台清單無效');
  resumeFolder=path.join(root,'private','runs',resumeRun);
  const prior=JSON.parse(await fs.readFile(path.join(resumeFolder,'status.json'),'utf8'));
  if(prior.mode!=='apply'||prior.date!==d.today||prior.through!==d.to||prior.completed)throw Error('續跑來源不是當日未完成的執行');
  for(const p of config.platforms){
   const old=prior.platforms.find(x=>x.platform===p.name);
   if(!old)throw Error('續跑來源缺少 '+p.name+' 狀態');
   if(requested.has(p.key)){if(old.state!=='failed')throw Error(p.name+' 並非待續跑狀態');}
   else {if((old.state!=='verified'&&!(keepOtherFailures&&old.state==='failed'))||old.warnings?.length)throw Error(p.name+' 先前未完整核對，不能沿用');status.platforms.push({...old,resumedFrom:resumeRun});}
  }
  status.resumedFrom=resumeRun;
 }
 await fs.mkdir(folder,{recursive:true});await fs.mkdir(path.join(root,'logs'),{recursive:true});
 const readBackend=(reader,ctx,platform,onLogin,...params)=>readWithFallback({reader,context:ctx,platform,params,folder,onLogin,connectBackup:noFallback?null:()=>chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:10000})});
 if(scheduled&&!config.enabled)throw Error('固定排程尚未啟用；不執行寫入');
 lockAttempted=true;lock=await acquireRunLock(root,{pid:process.pid,started:status.started});
 await lock.writeFile(JSON.stringify({pid:process.pid,started:status.started}));await log();
 if(scheduled&&config.browserMode==='attach'){
  const starter=spawnSync(process.execPath,[path.join(root,'start-resident.mjs')],{cwd:root,encoding:'utf8',timeout:120000,windowsHide:true});
  if(starter.error||starter.status!==0)throw Error(`常駐登入視窗啟動失敗：${(starter.stderr||starter.error?.message||`exit ${starter.status}`).trim()}`);
 }
 context=await browser(!args.has('--visible'));
 for(const p of config.platforms.filter(p=>!onlyKeys||onlyKeys.includes(p.key))){const result={platform:p.name,state:'reading',completedSteps:[],warnings:[]};status.platforms.push(result);await log();let page;
  try{
   let savedSource;
   if(resumeFolder){
    try{savedSource=JSON.parse(await fs.readFile(path.join(resumeFolder,p.key+'-source.json'),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
   }
   // A platform can fail before its source snapshot exists (for example, while opening
   // a backend tab). In that case, retry the read; if a snapshot exists, preserve it.
   const firstRead=savedSource===undefined?await readBackend(collect,context,p,login=>{result.login=login;},{...d,monday:false},config.approvedMonth):null;
   const source=savedSource===undefined?firstRead.data:savedSource;
   try { validateDailySource(source,d,config.approvedMonth,p.merchants.length); }
   catch(e) { throw Error(p.name+' '+e.message); }
   if(firstRead?.fallback)result.backendSession='giftChrome';
   await fs.writeFile(path.join(folder,p.key+'-source.json'),JSON.stringify(source));
   page=await openSheet(context,p.sheetId);let w=await snapshot(page,folder,p.key+'-before');
   const memberPlan=memberAnalysisPlan(w,p,source.monthClose?.members);if(apply&&memberPlan){result.state='writing-month-close-members';await log();w=await applyMemberAnalysis(page,w,memberPlan,folder,p.key+'-month-members-after');result.completedSteps.push('上月會員渠道分析已核對');}
   const weeklyCoinStructure=d.rollover?coinMonthStructure(w,p,d,false):null;if(apply&&weeklyCoinStructure){result.state='creating-weekly-coin-month';await log();w=await applyCoinMonthStructure(page,w,weeklyCoinStructure,folder,p.key+'-coin-month-after');result.completedSteps.push('週報幣商新月份結構已核對');}
   const compact=compactDailyPlan(w,p,d),daily=makePlan(compact.workbook,p,source,d),weeklyClose=weeklyClosingMerchantPlan(w,p,source.monthClose,d),combined=mergeChanges(w,compact.changes,daily.changes,weeklyClose),plan={changes:combined,warnings:daily.warnings};result.warnings.push(...plan.warnings);result.changes=plan.changes.length;
   let wp=null;await fs.writeFile(path.join(folder,p.key+'-plan.json'),JSON.stringify({daily:plan,weekly:wp},null,2));
   if(apply&&plan.changes.length){result.state='writing-weekly-workbook';await log();w=await applyChanges(page,w,plan.changes,folder,p.key+'-after');}
   if(apply)result.completedSteps.push('週報日更已核對');
   await page.close();page=await openSheet(context,config.revenueId);let rw=await snapshot(page,folder,p.key+'-revenue-before');const revenueStructure=d.rollover?revenueMonthStructure(rw,d):null;if(apply&&revenueStructure){result.state='creating-revenue-month';await log();rw=await applyRevenueMonthStructure(page,rw,revenueStructure,folder,p.key+'-revenue-month-after');result.completedSteps.push('營收總表新月份結構已核對');}const revenueCoinStructure=d.rollover?coinMonthStructure(rw,p,d,true):null;if(apply&&revenueCoinStructure){result.state='creating-revenue-coin-month';await log();rw=await applyCoinMonthStructure(page,rw,revenueCoinStructure,folder,p.key+'-revenue-coin-month-after');result.completedSteps.push('營收總表幣商新月份結構已核對');}const rp=mergeChanges(rw,revenuePlan(rw,p,source,d),revenueClosingMerchantPlan(rw,p,source.monthClose,d));
   if(apply&&rp.length){result.state='writing-revenue';await log();await applyChanges(page,rw,rp,folder,p.key+'-revenue-after');}
   if(apply)result.completedSteps.push('營收總表已核對');result.revenueChanges=rp.length;
   if(d.monday){
    if(!config.weeklyEnabled){result.warnings.push('機台週更未啟用');}
    else{
     result.state='reading-machine-week';await log();const weeklyRead=await readBackend(collectWeekly,context,p,login=>{result.loginWeekly=login;},d,config.approvedMonth);Object.assign(source,weeklyRead.data);if(weeklyRead.fallback)result.backendSession='giftChrome';await fs.writeFile(path.join(folder,p.key+'-source.json'),JSON.stringify(source));
     await page.close();page=await openSheet(context,p.sheetId);w=await snapshot(page,folder,p.key+'-weekly-before');wp=await weeklyPlan(w,p,source,d);await fs.writeFile(path.join(folder,p.key+'-plan.json'),JSON.stringify({daily:plan,weekly:wp},null,2));
     if(apply){result.state='writing-machine-week';await log();await applyWeekly(page,w,wp,folder,p.key+'-weekly-after');result.completedSteps.push('機台週更已核對');}
    }
   }
   result.state=apply?'verified':'preview-ready';result.weekly=wp?{insert:wp.insert,rows:wp.rows.length,label:wp.label}:null;
  }catch(e){result.state='failed';result.error=e.message;}finally{if(page)await page.close().catch(()=>{});await log().catch(()=>{});}
 }
 if(apply&&d.rollover&&status.platforms.every(p=>p.state==='verified'&&!p.warnings.length)){config.approvedMonth=d.monthKey;await fs.writeFile(path.join(root,'config.json'),JSON.stringify(config,null,2)+'\n');status.approvedMonth=d.monthKey;}
 status.completed=status.platforms.every(p=>p.state===(apply?'verified':'preview-ready')&&!p.warnings.length);
}

const outcome=await guardedRun({
 status,work,timeoutMs:DEFAULT_RUN_TIMEOUT_MS,shouldNotify:apply&&(scheduled||args.has('--notify')),
 finalize:async()=>{
  if(context)await context.close().catch(()=>{});
  if(scheduled){
   const helper='C:\\Users\\User\\Documents\\ChatGPT\\營運自動化\\scripts\\dedicated-chrome-window.ps1';
   const hidden=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-Action','Hide','-Port','19385'],{encoding:'utf8',windowsHide:true,timeout:15000});
   if(hidden.error||hidden.status!==0)console.warn('營運專用 Chrome 無法在排程結束後隱藏');
  }
 },
 notify:s=>notifyOperations(s,{configPath:telegramConfigPath}),
 // Failures before the lock is attempted (bad config, module load) still leave a status record;
 // a run that lost the lock to another run must not overwrite that run's logs.
 release:async()=>{if(lock){await log();await lock.close();await fs.unlink(path.join(root,'private','run.lock')).catch(()=>{});}else if(!lockAttempted)await log().catch(()=>{});},
});
console.log(JSON.stringify(status,null,2));
let finalExitCode=outcome.exitCode;
if(scheduled&&finalExitCode!==0&&!outcome.aborted&&!args.has('--no-auto-retry')){
 try{
  const config=JSON.parse((await fs.readFile(path.join(root,'config.json'),'utf8')).replace(/^\uFEFF/,''));
  let previous=status;
  for(let attempt=1;attempt<=MAX_AUTO_RETRIES;attempt++){
   const keys=failedPlatformKeys(previous,config.platforms);
   const startup=canRetryStartupFailure(previous);
   const currentDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
   if((!keys&&!startup)||previous.date!==currentDate)break;
   await delay(AUTO_RETRY_DELAY_MS);
   const childArgs=startup?['--apply','--scheduled','--daily-only','--no-auto-retry']
    :['--apply','--scheduled','--daily-only','--no-auto-retry',`--resume-source-run=${previous.runId}`,`--only-platforms=${keys.join(',')}`];
   const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),...childArgs],{
    cwd:root,encoding:'utf8',windowsHide:true,timeout:DEFAULT_RUN_TIMEOUT_MS+60000,maxBuffer:2*1024*1024,
   });
   let next=null;
   try{next=JSON.parse(child.stdout?.trim()||'');}catch{}
   if(child.error||!next||(!startup&&next.resumedFrom!==previous.runId)||next.date!==previous.date){
    console.error(`自動補跑第 ${attempt} 次未取得有效續跑結果；已停止重試。`);
    break;
   }
   console.log(`自動補跑第 ${attempt} 次：${startup?'啟動前失敗':keys.join(',')}；完成=${next.completed===true}；退出碼=${child.status??'unknown'}`);
   previous=next;
   if(child.status===0&&next.completed===true){finalExitCode=0;break;}
  }
 }catch(error){console.error(`自動補跑未啟動：${error.message}`);}
}
process.exitCode=finalExitCode;
// A hung browser call can keep the event loop alive after an abort; the result is already
// recorded, notified and the lock released, so exit explicitly.
if(outcome.aborted)process.exit(outcome.exitCode);
