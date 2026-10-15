import fs from 'node:fs/promises';
import path from 'node:path';

export function processExists(pid,signal=process.kill){
 if(!Number.isSafeInteger(pid)||pid<1)return false;
 try{signal(pid,0);return true;}catch(error){return error?.code==='EPERM';}
}

export async function acquireRunLock(root,record,{signal=process.kill}={}){
 const lockPath=path.join(root,'private','run.lock');
 const open=()=>fs.open(lockPath,'wx');
 try{return await open();}catch(error){
  if(error?.code!=='EEXIST')throw error;
  let prior=null;try{prior=JSON.parse(await fs.readFile(lockPath,'utf8'));}catch{}
  if(processExists(prior?.pid,signal))throw Error(`已有更新程序執行（PID ${prior.pid}），本次不重複啟動`);
  await fs.unlink(lockPath).catch(unlinkError=>{if(unlinkError?.code!=='ENOENT')throw unlinkError;});
  try{return await open();}catch{throw Error('失效鎖已清理，但另一個更新程序已先啟動');}
 }
}
