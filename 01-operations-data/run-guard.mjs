// Guards a whole update run: every failure path (thrown error, crash, hang) ends with the
// status recorded, the browser connection closed, the failure notification sent (when
// enabled) and run.lock released, and a non-zero exit code.
export const DEFAULT_RUN_TIMEOUT_MS=40*60*1000;
const TERMINAL=new Set(['verified','preview-ready','failed']);

export function cleanError(value){
 return String(value?.message??value??'').replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g,'').replace(/\s*\n\s*/g,' ').trim();
}

export function withTimeout(promise,ms,message){
 let timer;
 return Promise.race([
  Promise.resolve(promise).finally(()=>clearTimeout(timer)),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error(message),{code:'TIMEOUT'})),ms);}),
 ]);
}

// Platforms still in progress when the run is aborted are reported as failed.
export function markUnfinished(status,reason){
 for(const p of status.platforms||[])if(!TERMINAL.has(p.state)){p.state='failed';p.error||=reason;}
}

// Extract the Telegram config path even when config.json is not valid JSON, so a broken
// config can still be reported.
export function readTelegramConfigPath(raw){
 const text=String(raw??'').replace(/^\uFEFF/,'');
 try{return JSON.parse(text).telegramConfigPath||null;}catch{}
 const m=/"telegramConfigPath"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
 if(!m)return null;
 try{return JSON.parse(`"${m[1]}"`);}catch{return null;}
}

export async function guardedRun({status,work,finalize=async()=>{},notify=async()=>({sent:false}),release=async()=>{},shouldNotify=false,
 timeoutMs=DEFAULT_RUN_TIMEOUT_MS,stepTimeoutMs=60000,processLike=process}){
 let abort;
 const aborted=new Promise((_,reject)=>{abort=reject;});
 aborted.catch(()=>{});
 const timer=setTimeout(()=>abort(Object.assign(Error(`整體執行逾時（超過 ${Math.round(timeoutMs/60000)} 分鐘），已中止`),{code:'RUN_TIMEOUT'})),timeoutMs);
 const crash=error=>abort(Object.assign(error instanceof Error?error:Error(String(error)),{code:'RUN_CRASH'}));
 processLike.on?.('uncaughtException',crash);processLike.on?.('unhandledRejection',crash);
 let exitCode=1,wasAborted=false;
 try{
  await Promise.race([Promise.resolve().then(work),aborted]);
  exitCode=status.completed===true?0:1;
 }catch(error){
  wasAborted=error?.code==='RUN_TIMEOUT'||error?.code==='RUN_CRASH';
  const reason=error?.code==='RUN_CRASH'?`程式異常中止：${cleanError(error)}`:cleanError(error);
  status.error||=reason;status.completed=false;
  markUnfinished(status,reason);
  exitCode=1;
 }finally{clearTimeout(timer);}
 try{await withTimeout(Promise.resolve().then(finalize),stepTimeoutMs,'關閉瀏覽器連線逾時');}
 catch(error){status.finalizeError=cleanError(error);}
 status.finished=new Date().toISOString();
 if(shouldNotify){
  try{
   const n=await withTimeout(Promise.resolve().then(()=>notify(status)),stepTimeoutMs,'TG 通知逾時');
   status.telegram={sent:!!n?.sent,duplicate:!!n?.duplicate,...(n?.sent?{deleted:n.deleted||0,deleteFailed:n.deleteFailed||0,manualDeleteNeeded:n.manualDeleteNeeded||0}:{})};
  }catch(error){status.telegram={sent:false,error:cleanError(error)};exitCode=1;}
 }
 try{await withTimeout(Promise.resolve().then(release),stepTimeoutMs,'釋放執行鎖逾時');}
 catch(error){status.releaseError=cleanError(error);exitCode=1;}
 processLike.off?.('uncaughtException',crash);processLike.off?.('unhandledRejection',crash);
 return {exitCode,aborted:wasAborted};
}
