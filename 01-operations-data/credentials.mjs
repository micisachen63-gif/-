import fs from 'node:fs/promises';
import path from 'node:path';
import util from 'node:util';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Backend credentials saved by 設定後台帳密.cmd (backend-credentials.ps1) in
// private\backend-credentials.dpapi.json, protected with Windows DPAPI (CurrentUser scope).
// They are decrypted for one platform at login time by a short PowerShell call, returned via
// stdout only and kept in memory. Never write, log, screenshot or report the values.
const root=path.dirname(fileURLToPath(import.meta.url));
export const CREDENTIALS_FILE=path.join(root,'private','backend-credentials.dpapi.json');
export const CREDENTIALS_HELPER=path.join(root,'backend-credentials.ps1');
export const MISSING_CREDENTIALS='尚未設定後台帳密，請執行 設定後台帳密.cmd';
const REASONS={2:'找不到加密帳密檔',3:'此後台尚未設定帳密',4:'加密帳密檔無法解開，可能是換了 Windows 帳號或檔案損壞',5:'缺少平台代號'};
const HIDDEN='[帳密已隱藏]';

export class CredentialsError extends Error{
 constructor(reason=''){
  super(`${MISSING_CREDENTIALS}${reason?`（${reason}）`:''}`);
  this.name='CredentialsError';this.kind='credentials-missing';this.reason=reason;
 }
}

// Username/password holder whose values do not show up in JSON, string or console output.
export function secretPair(username,password){
 const pair={};
 Object.defineProperties(pair,{
  username:{value:String(username)},password:{value:String(password)},
  toJSON:{value:()=>HIDDEN},toString:{value:()=>HIDDEN},[util.inspect.custom]:{value:()=>HIDDEN},
 });
 return Object.freeze(pair);
}

// Replace any credential text in a message (page notices, error text) before it is kept.
export function redactSecrets(text,pair){
 let out=String(text??'');
 if(pair?.password)out=out.split(pair.password).join('***');
 if(pair?.username&&pair.username.length>=3)out=out.split(pair.username).join('***');
 return out;
}

function powershell(){return path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');}

// Runs the helper; resolves with the exit code and stdout. stderr is ignored on purpose.
export function runHelper(args,{timeoutMs=30000}={}){
 return new Promise(resolve=>{
  execFile(powershell(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',CREDENTIALS_HELPER,...args],
   {windowsHide:true,timeout:timeoutMs,encoding:'utf8',maxBuffer:1<<20},
   (error,stdout)=>resolve({code:error?(Number.isInteger(error.code)?error.code:-1):0,stdout:String(stdout??'')}));
 });
}

// Decrypts one platform's username/password (matched by key, name or URL host).
export async function loadCredentials(platform,{file=CREDENTIALS_FILE,run=runHelper}={}){
 const wanted=platform?.key||platform?.name;
 if(!wanted)throw new CredentialsError(REASONS[5]);
 if(!await fs.access(file).then(()=>true,()=>false))throw new CredentialsError(REASONS[2]);
 let result;
 try{result=await run(['-Decrypt','-Platform',String(wanted),'-Path',file]);}
 catch{throw new CredentialsError('無法啟動解密程式');}
 if(result?.code!==0)throw new CredentialsError(REASONS[result?.code]||'解密程式未成功結束');
 let data;
 try{data=JSON.parse(Buffer.from(String(result.stdout).trim(),'base64').toString('utf8'));}
 catch{throw new CredentialsError('解密結果格式錯誤');}
 if(typeof data?.username!=='string'||typeof data?.password!=='string'||!data.username||!data.password)throw new CredentialsError(REASONS[3]);
 return secretPair(data.username,data.password);
}
