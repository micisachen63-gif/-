import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import {attemptLogin,openRoute,readWithFallback,credentialsReady,LoginError,BackendLoginFailure,isLoginFailure} from './login.mjs';
import {secretPair,CredentialsError} from './credentials.mjs';
import {buildTelegramReport} from './telegram-notify.mjs';

const platform={key:'qz',name:'茄子',url:'https://admin.example.test:9955'};
// Dummy values only; never real credentials.
const USER='dummy-operator',PASS='Dummy#Pw-7731';
function creds(calls=[]){return async p=>{calls.push(p.key);return secretPair(USER,PASS);};}
const opts=(extra={})=>({credentials:creds(),typeDelay:0,...extra});

// Minimal stand-in for a Playwright page on the backend login screen. Typing only lands in
// the focused field; reload/goto give a fresh (empty) form like a real page.
function fakePage(initial={}){
 const s={loginForm:true,unauthorized:false,users:[{value:''}],passwords:[{value:''}],buttonVisible:true,buttonDisabled:false,notice:'',
  typeWorks:true,maxLength:Infinity,afterLogin:st=>{st.loginForm=false;},onGoto:()=>{},onReload:()=>{},...initial};
 const log={gotos:[],reloads:0,loginClicks:0,screenshots:[],shotValues:[],typedAtLogin:null,masks:0,order:[]};
 let focused=null;
 const reset=()=>{for(const f of [...s.users,...s.passwords])f.value='';focused=null;};
 const fields=kind=>({
  count:async()=>s.loginForm?s[kind].length:0,
  evaluateAll:async fn=>fn(s.loginForm?s[kind].map(f=>({value:f.value,matches:()=>false})):[]),
  first:()=>({
   click:async()=>{focused=kind;log.order.push(kind+'-click');},
   fill:async v=>{focused=kind;s[kind][0].value=v;log.order.push(kind+'-clear');},
   evaluate:async fn=>fn({value:s[kind][0].value}),
  }),
 });
 const page={
  state:s,log,
  async goto(url){log.gotos.push(url);log.order.push('goto');reset();s.onGoto(s,log);},
  async reload(){log.reloads++;log.order.push('reload');reset();s.onReload(s,log);},
  keyboard:{type:async text=>{log.order.push('type:'+focused);if(s.typeWorks&&focused)s[focused][0].value=(s[focused][0].value+text).slice(0,s.maxLength);if(s.onType)s.onType(text);}},
  async evaluate(){log.masks++;log.order.push('mask');for(const f of [...s.users,...s.passwords])f.value='';},
  async waitForLoadState(){},async waitForTimeout(){},
  url:()=>s.loginForm?platform.url+'/login?next=%2F':platform.url+'/',
  async title(){return '後台管理';},
  async screenshot({path:p}){log.screenshots.push(p);log.order.push('screenshot');log.shotValues.push([...s.users,...s.passwords].map(f=>f.value));},
  locator(selector){
   if(selector==='body')return {innerText:async()=>s.unauthorized?'Session Unauthorized':'首頁'};
   if(selector==='input[type=password]:visible')return fields('passwords');
   if(selector.startsWith('input[type=text]'))return fields('users');
   return {allInnerTexts:async()=>s.notice?[s.notice]:[]};
  },
  getByRole(role,{name}){
   assert.equal(role,'button');assert.equal(name,'登入');
   return {
    waitFor:async()=>{if(!s.buttonVisible)throw Error('timeout');},
    isDisabled:async()=>s.buttonDisabled,
    click:async()=>{log.loginClicks++;log.order.push('login');log.typedAtLogin=[s.users[0]?.value,s.passwords[0]?.value];s.afterLogin(s);},
   };
  },
 };
 return page;
}

async function tempFolder(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ops-login-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const TYPED_CYCLE=['users-click','users-clear','type:users','passwords-click','passwords-clear','type:passwords'];

test('已登入時不重新整理、不解密帳密、不輸入也不按登入',async()=>{
 const calls=[];const page=fakePage({loginForm:false});
 assert.equal(await attemptLogin(page,platform,'/',opts({credentials:creds(calls)})),false);
 assert.equal(page.log.reloads,0);assert.equal(page.log.loginClicks,0);assert.deepEqual(calls,[]);
 assert.equal(page.log.order.some(o=>o.startsWith('type:')),false);
});

test('看到登入頁：重新整理後清空並逐字輸入帳號與密碼，確認有值後只按一次登入',async()=>{
 const calls=[];const page=fakePage();
 assert.equal(await attemptLogin(page,platform,'/',opts({credentials:creds(calls)})),true);
 assert.deepEqual(page.log.order,['goto','reload',...TYPED_CYCLE,'login','goto']);
 assert.deepEqual(page.log.typedAtLogin,[USER,PASS]);
 assert.equal(page.log.loginClicks,1);assert.deepEqual(calls,['qz']);
});

test('欄位原本有舊值（例如自動填入）時先清空再輸入',async()=>{
 const page=fakePage({onReload:st=>{st.users[0].value='old-account';st.passwords[0].value='old';}});
 assert.equal(await attemptLogin(page,platform,'/',opts()),true);
 assert.deepEqual(page.log.typedAtLogin,[USER,PASS]);
});

test('重新整理後已恢復登入：不解密、不輸入也不按登入',async()=>{
 const calls=[];const page=fakePage({onReload:st=>{st.loginForm=false;}});
 assert.equal(await attemptLogin(page,platform,'/',opts({credentials:creds(calls)})),false);
 assert.equal(page.log.loginClicks,0);assert.deepEqual(calls,[]);
});

test('輸入沒有進到欄位：不按登入，重試一次後停止，並保存截圖、網址與標題',async t=>{
 const folder=await tempFolder(t);const diag={folder,source:'main',events:[]};
 const page=fakePage({typeWorks:false});
 const error=await openRoute(page,platform,'/',diag,opts()).then(()=>null,e=>e);
 assert.ok(error instanceof LoginError);assert.equal(error.kind,'fields-not-filled');
 assert.match(error.message,/茄子需要重新登入：帳號或密碼沒有成功輸入欄位（輸入後欄位仍是空的）/);
 assert.equal(page.log.loginClicks,0);assert.equal(page.log.gotos.length,2);assert.equal(page.log.reloads,2);
 assert.deepEqual(diag.events.map(e=>e.attempt),[1,2]);
 assert.equal(diag.events[0].url,platform.url+'/login');assert.equal(diag.events[0].title,'後台管理');
 assert.deepEqual(diag.events.map(e=>e.screenshot),['login-qz-main-1.png','login-qz-main-2.png']);
 assert.deepEqual(page.log.screenshots,[path.join(folder,'login-qz-main-1.png'),path.join(folder,'login-qz-main-2.png')]);
 const saved=JSON.parse(await fs.readFile(path.join(folder,'login-qz-main.json'),'utf8'));
 assert.equal(saved.length,2);
});

test('欄位長度與設定不符（例如欄位限制字數）：不按登入',async()=>{
 const page=fakePage({maxLength:5});
 const error=await openRoute(page,platform,'/',{events:[]},opts()).then(()=>null,e=>e);
 assert.equal(error.kind,'fields-not-filled');assert.match(error.detail,/長度與設定不符/);
 assert.equal(page.log.loginClicks,0);
});

test('登入頁找不到帳號欄：分類為找不到欄位且不按登入',async()=>{
 const page=fakePage({users:[]});
 const error=await openRoute(page,platform,'/',{events:[]},opts()).then(()=>null,e=>e);
 assert.equal(error.kind,'fields-not-found');assert.equal(page.log.loginClicks,0);
});

test('登入鍵停用：分類為按鈕不可用且不點擊',async()=>{
 const page=fakePage({buttonDisabled:true});
 const error=await openRoute(page,platform,'/',{events:[]},opts()).then(()=>null,e=>e);
 assert.equal(error.kind,'login-button-disabled');assert.equal(page.log.loginClicks,0);
});

test('按登入後仍在登入頁：每次嘗試只按一次，共兩次；截圖前先清空帳密欄位',async t=>{
 const folder=await tempFolder(t);
 const page=fakePage({notice:'帳號或密碼錯誤',afterLogin:()=>{}});
 const diag={folder,source:'main',events:[]};
 const error=await openRoute(page,platform,'/',diag,opts()).then(()=>null,e=>e);
 assert.equal(error.kind,'login-rejected');assert.match(error.message,/頁面提示：帳號或密碼錯誤/);
 assert.equal(page.log.loginClicks,2);assert.equal(page.log.reloads,2);assert.equal(diag.events.length,2);
 const cycle=['goto','reload',...TYPED_CYCLE,'login','mask','screenshot'];
 assert.deepEqual(page.log.order,[...cycle,...cycle]);
 assert.deepEqual(page.log.shotValues,[['',''],['','']]);
});

test('登入後後台仍拒絕工作階段',async()=>{
 const page=fakePage({afterLogin:st=>{st.loginForm=false;st.unauthorized=true;}});
 const diag={events:[]};
 const error=await openRoute(page,platform,'/',diag,opts()).then(()=>null,e=>e);
 assert.equal(error.kind,'session-rejected');assert.equal(page.log.loginClicks,1);
 assert.deepEqual(diag.events.map(e=>[e.kind,e.detail]),[['session-rejected','登入後'],['session-rejected','開啟頁面時']]);
});

test('第一次輸入失敗、再一次重新整理＋輸入＋登入後成功（重試只一次）',async()=>{
 let loads=0;
 const page=fakePage({typeWorks:false,onGoto:st=>{loads++;if(loads===2)st.typeWorks=true;}});
 const diag={events:[]};
 assert.equal(await openRoute(page,platform,'/',diag,opts()),true);
 assert.equal(diag.recovered,true);assert.deepEqual(diag.events.map(e=>e.outcome),['failed','logged-in']);
 assert.equal(page.log.loginClicks,1);assert.equal(page.log.reloads,2);
});

test('尚未設定帳密：清楚提示執行 設定後台帳密.cmd，不重試、不輸入、不按登入',async()=>{
 const page=fakePage();const diag={events:[]};
 const missing=async()=>{throw new CredentialsError('找不到加密帳密檔');};
 const error=await openRoute(page,platform,'/',diag,opts({credentials:missing})).then(()=>null,e=>e);
 assert.equal(error.kind,'credentials-missing');
 assert.equal(error.message,'茄子需要重新登入：尚未設定後台帳密，請執行 設定後台帳密.cmd（找不到加密帳密檔）');
 assert.equal(page.log.reloads,1);assert.equal(page.log.loginClicks,0);
 assert.equal(page.log.order.some(o=>o.startsWith('type:')),false);
 assert.equal(diag.events.length,1);assert.equal(diag.events[0].summary,'尚未設定後台帳密，請執行 設定後台帳密.cmd');
 assert.ok(isLoginFailure(error));
});

test('尚未設定帳密時照舊改用備用視窗讀取；備用視窗不輸入帳密',async()=>{
 const backupPage=fakePage();let login;const calls=[];
 const reader=async(context,p,diag)=>{
  if(context==='backup')return openRoute(backupPage,p,'/',diag,opts({credentials:creds(calls)})).then(()=>({ok:1}));
  return openRoute(fakePage(),p,'/',diag,opts({credentials:async()=>{throw new CredentialsError('找不到加密帳密檔');}}));
 };
 const error=await readWithFallback({reader,context:'main',platform,connectBackup:async()=>({contexts:()=>['backup'],close:async()=>{}}),onLogin:l=>{login=structuredClone(l);}}).then(()=>null,e=>e);
 assert.ok(error instanceof BackendLoginFailure);
 assert.match(error.message,/主視窗：尚未設定後台帳密，請執行 設定後台帳密\.cmd/);
 assert.match(error.message,/備用視窗：備用視窗停在登入頁/);
 assert.deepEqual(calls,[]);assert.equal(backupPage.log.loginClicks,0);
 assert.equal(backupPage.log.order.some(o=>o.startsWith('type:')),false);
 assert.equal(login.main.kind,'credentials-missing');
});

test('--no-fallback（沒有 connectBackup）：不連備用視窗，錯誤標示已停用備用視窗',async()=>{
 const logins=[];
 const reader=async()=>{throw new LoginError('茄子','login-rejected','頁面提示：帳號或密碼錯誤');};
 const error=await readWithFallback({reader,context:{},platform,connectBackup:null,onLogin:l=>logins.push(structuredClone(l))}).then(()=>null,e=>e);
 assert.ok(error instanceof BackendLoginFailure);
 assert.equal(error.message,'茄子後台自動登入失敗（本次已停用備用視窗）。主視窗：已按登入，但仍停在登入頁（頁面提示：帳號或密碼錯誤）');
 assert.equal(logins.at(-1).backup.kind,'backup-disabled');assert.ok(isLoginFailure(error));
});

test('帳密不會出現在錯誤、事件檔、狀態 JSON、TG 報告或主控台輸出',async t=>{
 const folder=await tempFolder(t);
 const printed=[];const original={log:console.log,error:console.error,warn:console.warn};
 for(const k of Object.keys(original))console[k]=(...a)=>printed.push(a.map(v=>typeof v==='string'?v:util.inspect(v)).join(' '));
 t.after(()=>Object.assign(console,original));
 const pair=secretPair(USER,PASS);
 console.log('credential object:',pair,JSON.stringify({pair}),`${pair}`);
 const scenarios=[
  {typeWorks:false},{maxLength:4},{buttonDisabled:true},
  // A page that echoes the typed values back in its notice must still not leak them.
  {notice:`帳號 ${USER} 或密碼 ${PASS} 錯誤`,afterLogin:()=>{}},
  {afterLogin:st=>{st.loginForm=false;st.unauthorized=true;}},
  // A browser-level failure whose text happens to include the typed value.
  {onType:text=>{if(text===PASS)throw Error(`keyboard.type: Target closed while typing "${text}"`);}},
 ];
 const status={runId:'r',date:'2026-09-26',platforms:[]};
 for(const [i,scenario] of scenarios.entries()){
  const diag={folder,source:'main',events:[]};
  const result={platform:'茄子',state:'failed',completedSteps:[],warnings:[]};
  try{
   await readWithFallback({reader:(c,p,d)=>openRoute(fakePage(scenario),p,'/',d,opts()),context:{},platform:{...platform,key:'qz'+i},folder,connectBackup:null,onLogin:l=>{result.login=l;}});
  }catch(e){result.error=e.message;result.stack=e.stack;}
  result.events=diag.events;status.platforms.push(result);
 }
 const files=await fs.readdir(folder);
 const written=await Promise.all(files.filter(f=>f.endsWith('.json')).map(f=>fs.readFile(path.join(folder,f),'utf8')));
 const report=buildTelegramReport(status).text;
 const everything=[JSON.stringify(status),report,...written,...printed].join('\n');
 assert.ok(status.platforms.every(p=>p.error),'每個情境都應失敗');
 assert.match(everything,/\*\*\*/);
 assert.equal(everything.includes(PASS),false);assert.equal(everything.includes(USER),false);
});

test('TG 報告先列中文摘要，並包含主視窗與備用視窗原因及截圖提示',()=>{
 const login={main:{kind:'login-rejected',summary:'已按登入，但仍停在登入頁',events:[{screenshot:'login-qz-main-1.png'}]},backup:{kind:'backup-unavailable',summary:'無法連上備用 Chrome（ECONNREFUSED）',events:[]}};
 const error=new BackendLoginFailure('茄子',login);
 const report=buildTelegramReport({runId:'r',date:'2026-09-26',through:'2026-09-25',completed:false,platforms:[{platform:'茄子',state:'failed',completedSteps:[],warnings:[],error:error.message,login}]});
 assert.match(report.text,/茄子：❌ 失敗；原因：茄子後台登入失效，主視窗與備用視窗都無法讀取，請人工登入專用 Chrome。主視窗：已按登入，但仍停在登入頁；備用視窗：無法連上備用 Chrome/);
 assert.match(report.text,/已存登入截圖供核對/);
 const ok=buildTelegramReport({runId:'r',date:'2026-09-26',completed:true,platforms:[{platform:'茄子',state:'verified',completedSteps:['週報日更已核對'],warnings:[],login:{main:{summary:'瀏覽器沒有自動填入可見的帳號與密碼',events:[]},backup:{ok:true,events:[]}}}]});
 assert.match(ok.text,/茄子：✅ 完成；已核對 週報日更已核對；主視窗登入失敗（瀏覽器沒有自動填入可見的帳號與密碼），已改用備用視窗讀取/);
});

test('自行輸入帳密登入成功時，TG 報告保留「後台登入逾時，已自動重新登入」',async()=>{
 let login;
 const result=await readWithFallback({reader:(c,p,d)=>openRoute(fakePage(),p,'/',d,opts()).then(()=>({ok:1})),context:{},platform,connectBackup:null,onLogin:l=>{login=l;}});
 assert.equal(result.fallback,false);assert.equal(login.main.ok,true);
 const report=buildTelegramReport({runId:'r',date:'2026-09-26',completed:true,platforms:[{platform:'茄子',state:'verified',completedSteps:['週報日更已核對'],warnings:[],login}]});
 assert.match(report.text,/茄子：✅ 完成；已核對 週報日更已核對；後台登入逾時，已自動重新登入/);
});

test('主視窗與備用視窗的錯誤都保留，不合併成一句',async()=>{
 const logins=[];
 const reader=async()=>{throw new LoginError('茄子','login-rejected','頁面提示：驗證碼錯誤');};
 const error=await readWithFallback({reader,context:{},platform,params:['d','m'],folder:null,
  connectBackup:async()=>{throw Error('browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222');},onLogin:l=>logins.push(structuredClone(l))}).then(()=>null,e=>e);
 assert.ok(error instanceof BackendLoginFailure);
 assert.match(error.message,/^茄子後台登入失效，主視窗與備用視窗都無法讀取/);
 assert.match(error.message,/主視窗：已按登入，但仍停在登入頁（頁面提示：驗證碼錯誤）/);
 assert.match(error.message,/備用視窗：無法連上備用 Chrome/);
 assert.equal(error.login.main.kind,'login-rejected');assert.equal(error.login.backup.kind,'backup-unavailable');
 assert.ok(isLoginFailure(error));
 assert.equal(logins.at(-1).backup.kind,'backup-unavailable');
});

test('備用視窗讀取成功時回傳 fallback 並記錄主視窗原因',async()=>{
 const backupContext={};let closed=0;const seen=[];
 const reader=async(context,p,d,m,diag)=>{seen.push([context,d,m,diag.source]);if(context!==backupContext)throw new LoginError('茄子','fields-not-filled');return {ok:1};};
 let login;
 const result=await readWithFallback({reader,context:{},platform,params:['d','m'],connectBackup:async()=>({contexts:()=>[backupContext],close:async()=>{closed++;}}),onLogin:l=>{login=l;}});
 assert.deepEqual(result,{data:{ok:1},fallback:true});
 assert.equal(closed,1);assert.equal(login.main.kind,'fields-not-filled');assert.equal(login.backup.ok,true);
 assert.deepEqual(seen.map(s=>s[3]),['main','backup']);assert.deepEqual(seen[1].slice(1,3),['d','m']);
});

test('非登入錯誤不改用備用視窗',async()=>{
 let connected=0;
 await assert.rejects(readWithFallback({reader:async()=>{throw Error('來源報表欄位已改變');},context:{},platform,connectBackup:async()=>{connected++;}}),/來源報表欄位已改變/);
 assert.equal(connected,0);
});

test('成功重新登入時記錄步驟（不含欄位值），可證明自動恢復',async t=>{
 const folder=await tempFolder(t);const diag={folder,source:'main',events:[]};
 assert.equal(await openRoute(fakePage(),platform,'/statements/xlogin',diag,opts()),true);
 assert.equal(diag.events.length,1);
 const [event]=diag.events;
 assert.equal(event.outcome,'logged-in');assert.equal(event.route,'/statements/xlogin');
 assert.deepEqual(event.steps,['login-page-detected','reloaded','credentials-loaded','username-typed','password-typed','fields-verified','login-clicked','left-login-page','route-confirmed']);
 const saved=JSON.parse(await fs.readFile(path.join(folder,'login-qz-main.json'),'utf8'));
 assert.equal(saved[0].outcome,'logged-in');
});

test('失敗事件也保留已完成的步驟',async()=>{
 const diag={events:[]};
 await openRoute(fakePage({afterLogin:()=>{}}),platform,'/',diag,opts()).catch(()=>{});
 assert.deepEqual(diag.events[0].steps,['login-page-detected','reloaded','credentials-loaded','username-typed','password-typed','fields-verified','login-clicked']);
 assert.equal(diag.events[0].outcome,'failed');
});

test('主視窗自動重新登入成功時回報 onLogin（ok），且不使用備用視窗',async()=>{
 let login,connected=0;
 const reader=async(context,p,d,m,diag)=>{diag.events.push({attempt:1,outcome:'logged-in',steps:['login-page-detected']});return {ok:1};};
 const result=await readWithFallback({reader,context:{},platform,params:['d','m'],connectBackup:async()=>{connected++;},onLogin:l=>{login=l;}});
 assert.equal(result.fallback,false);assert.equal(connected,0);assert.equal(login.main.ok,true);
});

test('舊版欄位判定輔助函式維持相容',()=>{
 assert.equal(credentialsReady({users:[{autofill:true}],passwords:[{filled:false,autofill:false}]}),false);
 assert.equal(credentialsReady({users:[true],passwords:[{filled:true}]}),true);
});
