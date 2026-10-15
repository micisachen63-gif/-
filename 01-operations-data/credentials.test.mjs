import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {loadCredentials,secretPair,redactSecrets,runHelper,CredentialsError,CREDENTIALS_FILE,MISSING_CREDENTIALS} from './credentials.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const platform={key:'qz',name:'茄子',url:'https://admin.qzplays.com:9955'};
const encode=value=>Buffer.from(JSON.stringify(value),'utf8').toString('base64');
async function tempFile(t,content){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ops-cred-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'backend-credentials.dpapi.json');if(content!==undefined)await fs.writeFile(file,content);return file;
}

test('帳密檔不存在：提示執行 設定後台帳密.cmd，且不啟動解密程式',async t=>{
 const file=await tempFile(t);let ran=0;
 const error=await loadCredentials(platform,{file,run:async()=>{ran++;}}).then(()=>null,e=>e);
 assert.ok(error instanceof CredentialsError);assert.equal(error.kind,'credentials-missing');
 assert.equal(error.message,`${MISSING_CREDENTIALS}（找不到加密帳密檔）`);assert.equal(ran,0);
 assert.equal(MISSING_CREDENTIALS,'尚未設定後台帳密，請執行 設定後台帳密.cmd');
});

test('解密程式的結束碼轉成清楚原因，錯誤訊息不含輸出內容',async t=>{
 const file=await tempFile(t,'{}');
 for(const [code,reason] of [[3,'此後台尚未設定帳密'],[4,'加密帳密檔無法解開'],[9,'解密程式未成功結束']]){
  const error=await loadCredentials(platform,{file,run:async()=>({code,stdout:encode({username:'u-secret',password:'p-secret'})})}).then(()=>null,e=>e);
  assert.ok(error instanceof CredentialsError);assert.ok(error.message.startsWith(MISSING_CREDENTIALS));assert.match(error.message,new RegExp(reason));
  assert.equal(/secret/.test(error.message+error.stack),false);
 }
 const bad=await loadCredentials(platform,{file,run:async()=>({code:0,stdout:'not base64 json'})}).then(()=>null,e=>e);
 assert.match(bad.message,/解密結果格式錯誤/);
});

test('只以平台代號與檔案路徑呼叫解密程式；結果物件的 JSON、字串與 inspect 都隱藏帳密',async t=>{
 const file=await tempFile(t,'{}');const calls=[];
 const pair=await loadCredentials(platform,{file,run:async args=>{calls.push(args);return {code:0,stdout:encode({username:'dummy-user',password:'Dummy-密碼#1'})+'\r\n'};}});
 assert.deepEqual(calls,[['-Decrypt','-Platform','qz','-Path',file]]);
 assert.equal(pair.username,'dummy-user');assert.equal(pair.password,'Dummy-密碼#1');
 const shown=[JSON.stringify({pair}),String(pair),`${pair}`,util.inspect(pair),util.inspect({pair}),Object.keys(pair).join()].join('|');
 assert.equal(shown.includes('Dummy'),false);assert.equal(shown.includes('dummy-user'),false);
 assert.ok(Object.isFrozen(pair));
});

test('redactSecrets 移除密碼與帳號文字',()=>{
 const pair=secretPair('operator','pw-123');
 assert.equal(redactSecrets('operator 使用 pw-123 失敗',pair),'*** 使用 *** 失敗');
 assert.equal(redactSecrets('ab 失敗',secretPair('ab','zz9')),'ab 失敗');
});

test('設定後台帳密.cmd 以 UTF-8 代碼頁與 Bypass 啟動同資料夾的 PowerShell 腳本並保留視窗',async()=>{
 const cmd=await fs.readFile(path.join(root,'設定後台帳密.cmd'),'utf8');
 assert.match(cmd,/chcp 65001/);assert.match(cmd,/-ExecutionPolicy Bypass -File "%~dp0backend-credentials\.ps1" %\*/);assert.match(cmd,/\r\npause\r\n$/);
 assert.equal(/[^\x00-\x7f]/.test(cmd),false,'cmd 內容只用 ASCII，避免代碼頁問題');
 const ps1=await fs.readFile(path.join(root,'backend-credentials.ps1'));
 assert.deepEqual([...ps1.subarray(0,3)],[0xef,0xbb,0xbf],'ps1 需為 UTF-8 BOM，Windows PowerShell 5.1 才能正確讀中文');
 const text=ps1.toString('utf8');
 assert.match(text,/三個後台是否使用同一組帳密？\(Y\/N\)/);assert.match(text,/Read-Host '密碼（輸入時不會顯示）' -AsSecureString/);
 assert.match(text,/ConvertFrom-SecureString -SecureString \$Secure/);
});

test('Windows 實機：DPAPI 自我測試（假資料、暫存檔）與解密回傳',{skip:process.platform!=='win32'},async t=>{
 const before=await fs.stat(CREDENTIALS_FILE).then(s=>s.mtimeMs,()=>null);
 const file=await tempFile(t);
 const self=await runHelper(['-SelfTest','-Path',file,'-KeepDummy'],{timeoutMs:60000});
 assert.equal(self.code,0,self.stdout);assert.match(self.stdout,/SELFTEST OK/);
 const raw=await fs.readFile(file,'utf8');
 assert.equal(raw.includes('selftest-user'),false);assert.equal(raw.includes('selftest-dummy'),false);
 for(const p of [platform,{key:'win',name:'贏麻了'},{name:'爽爆'}]){
  const pair=await loadCredentials(p,{file});
  assert.equal(pair.username,'selftest-user');assert.equal(pair.password,'selftest-dummy-密碼-!"\\');
 }
 const missing=await loadCredentials({key:'nope'},{file}).then(()=>null,e=>e);
 assert.match(missing.message,/此後台尚未設定帳密/);
 const data=JSON.parse(raw);data.platforms.qz.password='01000000d08c9ddf0115d1118c7a00c04fc297eb00';
 await fs.writeFile(file,JSON.stringify(data));
 const broken=await loadCredentials(platform,{file}).then(()=>null,e=>e);
 assert.match(broken.message,/加密帳密檔無法解開/);
 const after=await fs.stat(CREDENTIALS_FILE).then(s=>s.mtimeMs,()=>null);
 assert.equal(after,before,'不可建立或修改正式帳密檔');
});

// Drives the real interactive setup with a mocked Read-Host (dummy answers) against a temp file.
const DRIVER=`param([string]$Helper,[string]$Store,[string]$Answers)
$global:opsAnswers = New-Object System.Collections.Queue
foreach ($a in $Answers.Split([char]0x7C)) { $global:opsAnswers.Enqueue($a) }
function global:Read-Host { param([Parameter(Position=0)]$Prompt,[switch]$AsSecureString)
 if ($global:opsAnswers.Count -eq 0) { return $null }
 $v = [string]$global:opsAnswers.Dequeue()
 if ($AsSecureString) { if (-not $v) { return (New-Object Security.SecureString) }; return (ConvertTo-SecureString $v -AsPlainText -Force) }
 return $v }
& $Helper -Path $Store
`;
function driveSetup(driver,store,answers){
 const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 return new Promise(resolve=>execFile(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',driver,'-Helper',path.join(root,'backend-credentials.ps1'),'-Store',store,'-Answers',answers.join('|')],
  {windowsHide:true,timeout:60000,encoding:'utf8'},(error,stdout,stderr)=>resolve({code:error?error.code:0,out:stdout+stderr})));
}

test('Windows 實機：設定流程 Y（三個後台同一組）與 N（Enter 保留、單獨更新）使用假資料寫入暫存檔',{skip:process.platform!=='win32'},async t=>{
 const before=await fs.stat(CREDENTIALS_FILE).then(s=>s.mtimeMs,()=>null);
 const store=await tempFile(t);const driver=path.join(path.dirname(store),'driver.ps1');
 await fs.writeFile(driver,'\uFEFF'+DRIVER,'utf8');
 const y=await driveSetup(driver,store,['y','dummy-a','DummyPw1','DummyPw1']);
 assert.equal(y.code,0,y.out);
 assert.match(y.out,/已儲存。目前狀態（不顯示密碼）：/);assert.match(y.out,/贏麻了：已設定/);assert.match(y.out,/爽爆：已設定/);assert.match(y.out,/茄子：已設定/);
 for(const key of ['win','song','qz']){const pair=await loadCredentials({key},{file:store});assert.equal(pair.username,'dummy-a');assert.equal(pair.password,'DummyPw1');}
 // N: keep 贏麻了 (Enter), 爽爆 new values after one mismatched confirmation, keep 茄子.
 const n=await driveSetup(driver,store,['N','','dummy-b','DummyPw2','Wrong','DummyPw2','DummyPw2','']);
 assert.equal(n.code,0,n.out);
 assert.match(n.out,/保留原本的設定/);assert.match(n.out,/兩次輸入的密碼不一致/);
 const expect={win:['dummy-a','DummyPw1'],song:['dummy-b','DummyPw2'],qz:['dummy-a','DummyPw1']};
 for(const [key,[u,pw]] of Object.entries(expect)){const pair=await loadCredentials({key},{file:store});assert.equal(pair.username,u);assert.equal(pair.password,pw);}
 const raw=await fs.readFile(store,'utf8');
 for(const text of [y.out,n.out,raw])assert.equal(/DummyPw|Wrong/.test(text),false,'密碼不可出現在畫面或檔案');
 assert.equal(raw.includes('dummy-a'),false);
 const after=await fs.stat(CREDENTIALS_FILE).then(s=>s.mtimeMs,()=>null);
 assert.equal(after,before,'不可建立或修改正式帳密檔');
});
