const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {parseCsv}=require('./mail-template.cjs');
const {priorRunDecision,lockIsActive}=require('./runner-policy.cjs');
const {humanizeError}=require('./error-text.cjs');
const root=path.resolve(__dirname,'..');
const statePath=path.join(root,'state','runs.json');
const lockPath=path.join(root,'state','daily-runner.lock');
const brands=['qiezi','songyy','winmalo'];
const flags=process.argv.slice(2);const verifyOnly=flags.includes('--verify-only');
const suppliedDate=flags.find(x=>x.startsWith('--date='))?.slice('--date='.length);
const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'});
const today=fmt.format(new Date());
const date=suppliedDate||fmt.format(new Date(new Date(`${today}T12:00:00+08:00`).getTime()-86400000));
if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(`${date}T00:00:00+08:00`)))throw new Error('批次日期無效。');
const logFile=path.join(root,'logs',`${today}.log`);
function note(message){const line=`[${new Date().toISOString()}] ${message}`;console.log(line);fs.mkdirSync(path.dirname(logFile),{recursive:true});fs.appendFileSync(logFile,line+'\n');}
function acquireLock(){
 fs.mkdirSync(path.dirname(lockPath),{recursive:true});
 for(let i=0;i<2;i++){
  try{fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx'});return true;}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   let info=null;try{info=JSON.parse(fs.readFileSync(lockPath,'utf8'));}catch{}
   if(lockIsActive(info))return false;
   note(`清除殘留的執行鎖（${info?.pid||'未知'}，${info?.startedAt||'時間不明'}）。`);
   fs.rmSync(lockPath,{force:true});
  }
 }
 return false;
}
function releaseLock(){try{const info=JSON.parse(fs.readFileSync(lockPath,'utf8'));if(info.pid===process.pid)fs.rmSync(lockPath,{force:true});}catch{}}
if(!verifyOnly){
 if(!acquireLock()){note(`另一個每日禮包執行器正在執行（${date}），這次不重複啟動。`);process.exit(0);}
 process.on('exit',releaseLock);
}
// 狀態檔讀不到時不可當成「沒有紀錄」重跑（會重複派送），改為停止並通知。
let state={runs:{}},stateError='';
try{if(fs.existsSync(statePath))state=JSON.parse(fs.readFileSync(statePath,'utf8'));}catch(e){stateError=e.message.split('\n')[0];}
state.runs||={};
const touched=new Set();
// 只寫回本次處理過的品牌，避免覆蓋候補排程同時寫入的其他品牌結果。
function save(){
 fs.mkdirSync(path.dirname(statePath),{recursive:true});
 let disk=null;try{disk=JSON.parse(fs.readFileSync(statePath,'utf8'));}catch{}
 if(disk&&typeof disk==='object'){disk.runs||={};for(const k of touched)disk.runs[k]=state.runs[k];}else disk=state;
 const tmp=`${statePath}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(disk,null,2)+'\n');fs.renameSync(tmp,statePath);
}
const stepLabels={'export-members.cjs':'後台會員匯出','import-members.cjs':'匯入 Google 試算表','process-sheet.cjs':'試算表分組與清理','mail-gift.cjs':'遊戲禮包寄送','line-audience.cjs':'LINE 受眾上傳','line-broadcast.cjs':'LINE 推播預約','telegram-notify.cjs':'TG 通知'};
const loginScope={'export-members.cjs':'--admin','mail-gift.cjs':'--admin','import-members.cjs':'--google','process-sheet.cjs':'--google','line-audience.cjs':'--line','line-broadcast.cjs':'--line'};
const loginChecked=new Set();
function ensureLogin(script,args){
 const scope=loginScope[script],brand=args[0];if(!scope||!brand)return;
 const key=scope==='--google'?'google':`${brand}${scope}`;if(loginChecked.has(key))return;loginChecked.add(key);
 const r=spawnSync(process.execPath,[path.join(root,'src','ensure-logins.cjs'),brand,scope],{cwd:root,encoding:'utf8',maxBuffer:1024*1024,timeout:3*60*1000});
 for(const line of `${r.stdout||''}${r.stderr||''}`.trim().split(/\r?\n/).filter(Boolean))note(`ensure-logins.cjs: ${line}`);
 if(r.error)note(`登入檢查未完成：${humanizeError(r.error.message)}`);
}
function run(script,args){
 try{ensureLogin(script,args);}catch(e){note(`登入檢查略過：${e.message}`);}
 const command=path.join(root,'src',script);
 const timeoutMs=script==='line-broadcast.cjs'?20*60*1000:10*60*1000;
 const result=spawnSync(process.execPath,[command,...args],{cwd:root,encoding:'utf8',maxBuffer:1024*1024,timeout:timeoutMs});
 const lines=`${result.stdout||''}${result.stderr||''}`.trim().split(/\r?\n/).filter(Boolean);
 for(const line of lines)note(`${script}: ${line}`);
 const label=stepLabels[script]||script;
 if(result.error)throw new Error(result.error.code==='ETIMEDOUT'?`${label}超過 ${timeoutMs/60000} 分鐘沒有完成，已中止。`:`${label}無法執行：${humanizeError(result.error.message)}`);
 if(result.status!==0){
  const reason=lines.filter(line=>line.includes('ERROR:')).pop();
  throw new Error(`${label}失敗${reason?`：${humanizeError(reason)}`:`（exit ${result.status}）`}。`);
 }
}
function validateCsv(file){
 const rows=parseCsv(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 const header=rows.shift()?.map(x=>x.trim());
 for(const required of ['AID','創帳時間','總儲值','Line ID'])if(!header?.includes(required))throw new Error(`CSV 缺少 ${required} 欄。`);
 const at=Object.fromEntries(header.map((h,i)=>[h,i]));const ids=new Set();let count=0;
 for(const row of rows.filter(r=>r.some(x=>String(x).trim()))){
   const id=String(row[at.AID]||'').trim(),created=String(row[at['創帳時間']]||'').trim();
   if(!/^\d+$/.test(id)||ids.has(id)||!created.startsWith(date))throw new Error('匯出 CSV 含無效／重複會員或非指定註冊日。');
   ids.add(id);count++;
 }
 return count;
}
function update(run,fields){Object.assign(run,fields);run.updatedAt=new Date().toISOString();save();}

let fatalError='';
try{
 note(`START ${date} ${verifyOnly?'VERIFY':'PRODUCTION'}`);
 if(stateError&&!verifyOnly)throw new Error(`批次狀態檔 state/runs.json 讀取失敗（${stateError}）；為避免重複派送，已停止。`);
 for(const brand of brands){
  const key=`${date}/${brand}`,old=state.runs[key];
  if(!verifyOnly){
    const decision=priorRunDecision(old);
    if(decision==='skip'){note(`SKIP ${key}: ${old.status}`);continue;}
    if(decision==='stop'){note(`STOP ${key}: ${old.status}，已有外部動作紀錄，禁止重複派送。`);continue;}
  }
  const args=[brand,date,...(verifyOnly?['--verify-only']:[])];
  const source=verifyOnly?path.join(root,'work','export-check',`${brand}-${date}-verify.csv`):path.join(root,'inbox',brand,`${brand}-${date}.csv`);
  try{
    if(verifyOnly||!fs.existsSync(source))run('export-members.cjs',args);
    const count=validateCsv(source);
    note(`${key}: CSV ${count} 位`);
    if(verifyOnly){
      if(count){run('import-members.cjs',args);run('process-sheet.cjs',args);run('mail-gift.cjs',args);run('line-audience.cjs',args);note(`${key}: 驗證模式不建立 LINE 受眾，故不測試需要既有受眾的預約頁；正式模式會在受眾建立後再預約。`);}
      continue;
    }
    const record=old||{date,brand,createdAt:new Date().toISOString(),actions:{}};
    state.runs[key]=record;touched.add(key);delete record.error;update(record,{status:'preparing',memberCount:count,sourceFile:path.relative(root,source)});
    if(!count){update(record,{status:'completed',completedAt:new Date().toISOString(),mailCount:0,lineCount:0,note:'前日無新會員'});note(`${key}: 無新會員，批次完成。`);continue;}
    run('import-members.cjs',args);run('process-sheet.cjs',args);
    update(record,{status:'prepared',sheetProcessed:true,cleanupVerified:true});
    const localTime=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
    if(localTime>='17:30')throw new Error('已超過 17:30，無法安全預約當日 18:00 禮包與推播。');
    const groups=brand==='winmalo'?['oneToOne']:['atLeast150','below150'];
    const sheet=JSON.parse(fs.readFileSync(path.join(root,'staging',date,brand,'sheet-result.json'),'utf8'));
    let mailed=0;
    for(const group of groups){
      const number=sheet.groups[group]?.length||0;
      if(!number)continue;
      update(record,{status:'in_progress',pendingAction:`gameMail/${group}`});
      run('mail-gift.cjs',[brand,date,`--group=${group}`,'--send']);
      mailed+=number;record.actions[`gameMail/${group}`]={count:number,confirmedAt:new Date().toISOString()};
      update(record,{pendingAction:null,mailCount:mailed});
    }
    update(record,{status:'in_progress',pendingAction:'lineAudience'});
    run('line-audience.cjs',[brand,date,'--update']);
    record.actions.lineAudience={confirmedAt:new Date().toISOString(),lastUploadedAt:new Date().toISOString(),retryCount:0,rawUidCount:sheet.lineCount};update(record,{pendingAction:null});
    update(record,{status:'awaiting_audience',pendingAction:'lineBroadcast',mailCount:mailed,lineUidCount:sheet.lineCount});
    note(`${key}: 禮包與 LINE 受眾已完成；等待受眾可用後另行預約 18:00 推播。`);
  }catch(e){
    note(`ERROR ${key}: ${e.message}`);
    if(!verifyOnly&&state.runs[key]){
      const record=state.runs[key];touched.add(key);
      update(record,{status:record.status==='in_progress'?'needs_review':'failed_preparation',error:e.message});
    }
    process.exitCode=1;
  }
 }
 note(`END ${date} ${verifyOnly?'VERIFY':'PRODUCTION'}`);
}catch(e){fatalError=e.message;console.error(`FATAL: ${e.message}`);note(`FATAL: ${e.message}`);process.exitCode=1;}
finally{
 if(!verifyOnly&&(!suppliedDate||flags.includes('--notify'))){
  try{
   if(fatalError)process.env.DAILY_GIFT_FATAL_ERROR=fatalError;
   run('telegram-notify.cjs',[date]);
  }catch(e){note(`TG 通知失敗：${e.message}`);process.exitCode=1;}
  finally{if(fatalError)delete process.env.DAILY_GIFT_FATAL_ERROR;}
 }
}
