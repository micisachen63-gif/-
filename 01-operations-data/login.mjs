import fs from 'node:fs/promises';
import path from 'node:path';
import {loadCredentials,CredentialsError,MISSING_CREDENTIALS,redactSecrets} from './credentials.mjs';

// Backend login handling for the dedicated Chrome sessions.
// Credentials come from the DPAPI-encrypted file (credentials.mjs) and are typed into the login
// form. They are never logged, stored in events/status, included in errors or screenshotted:
// every input on the page is cleared before a failure screenshot.
const timeout=60000;
export const MAX_LOGIN_ATTEMPTS=2;
const USER_FIELDS='input[type=text]:visible,input[type=email]:visible,input:not([type]):visible';
const PASSWORD_FIELDS='input[type=password]:visible';

export const LOGIN_KINDS={
 'credentials-missing':MISSING_CREDENTIALS,
 'fields-not-found':'登入頁找不到帳號或密碼欄位',
 'fields-not-filled':'帳號或密碼沒有成功輸入欄位',
 'login-button-disabled':'登入按鈕不可用',
 'login-rejected':'已按登入，但仍停在登入頁',
 'session-rejected':'後台拒絕工作階段',
 'backup-login-page':'備用視窗停在登入頁（備用視窗不自動輸入帳密）',
};

export class LoginError extends Error{
 constructor(platform,kind,detail=''){
  super(`${platform}需要重新登入：${LOGIN_KINDS[kind]||kind}${detail?`（${detail}）`:''}`);
  this.name='LoginError';this.platform=platform;this.kind=kind;this.detail=detail;
 }
}

export class BackendLoginFailure extends Error{
 constructor(platform,login){
  super(login.backup?.kind==='backup-disabled'
   ?`${platform}後台自動登入失敗（本次已停用備用視窗）。主視窗：${login.main.summary}`
   :`${platform}後台登入失效，主視窗與備用視窗都無法讀取，請人工登入專用 Chrome。主視窗：${login.main.summary}；備用視窗：${login.backup.summary}`);
  this.name='BackendLoginFailure';this.login=login;
 }
}

export function cleanText(value){
 return String(value??'').replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g,'').replace(/\s*\n\s*/g,' ').trim();
}

// Legacy helpers kept for compatibility with earlier callers/tests (backend.mjs re-exports them).
export function storedCredentialsReady(values){return values.users.some(Boolean)&&values.passwords.some(Boolean);}
export function credentialsReady(state){
 const ok=f=>f===true||Boolean(f?.filled||f?.autofill);
 return state.users.some(ok)&&state.passwords.some(ok);
}

async function settle(page){await page.waitForLoadState('networkidle',{timeout}).catch(()=>{});await page.waitForTimeout(1200);}
async function bodyText(page){return await page.locator('body').innerText().catch(()=>'');}
async function onLoginForm(page){return (await page.locator(PASSWORD_FIELDS).count())>0;}
async function pageNotice(page){
 const texts=await page.locator('[role=alert]:visible,.el-message:visible,.el-form-item__error:visible,.ant-message:visible').allInnerTexts().catch(()=>[]);
 return cleanText(texts.join(' ')).slice(0,80);
}

// Clear the field, then type key by key so the page's own input handlers see the value.
async function typeInto(page,field,value,delay){
 await field.click();
 await field.fill('');
 await page.keyboard.type(value,{delay});
}
// Only the length is read back, never the value.
async function valueLength(field){return await field.evaluate(e=>String(e.value??'').length).catch(()=>0);}

// Copy of a non-login error with any credential text removed from message and stack.
function scrub(error,pair){
 const message=redactSecrets(error?.message,pair),stack=redactSecrets(error?.stack,pair);
 if(message===error?.message&&stack===error?.stack)return error;
 const copy=new Error(message);copy.name=error?.name||'Error';copy.stack=stack;return copy;
}

// After login (or when the reload already restored the session) open the route and
// confirm the backend accepts the session.
async function confirmRoute(page,p,route){
 await page.goto(p.url+route,{waitUntil:'domcontentloaded',timeout});await settle(page);
 if((await bodyText(page)).includes('Session Unauthorized'))throw new LoginError(p.name,'session-rejected','登入後');
 if(await onLoginForm(page))throw new LoginError(p.name,'login-rejected','登入後又回到登入頁');
}

// One attempt: whenever the login page shows, refresh it, decrypt this platform's saved
// credentials, clear and type account and password, check both fields are filled, then
// press 登入 exactly once and confirm the backend accepts the session.
// Returns true when a login was performed, false when no login page was shown.
export async function attemptLogin(page,p,route,{typeDelay=40,credentials=loadCredentials,allowLogin=true}={},trace=[]){
 await page.goto(p.url+route,{waitUntil:'domcontentloaded',timeout});await settle(page);
 if((await bodyText(page)).includes('Session Unauthorized'))throw new LoginError(p.name,'session-rejected','開啟頁面時');
 if(!await onLoginForm(page))return false;
 trace.push('login-page-detected');
 await page.reload({waitUntil:'domcontentloaded',timeout});await settle(page);trace.push('reloaded');
 if(!await onLoginForm(page)){trace.push('session-restored-by-reload');await confirmRoute(page,p,route);trace.push('route-confirmed');return false;}
 if(!allowLogin)throw new LoginError(p.name,'backup-login-page');
 let pair;
 try{pair=await credentials(p);}
 catch(error){throw new LoginError(p.name,'credentials-missing',error instanceof CredentialsError?error.reason:'');}
 trace.push('credentials-loaded');
 try{
  const users=page.locator(USER_FIELDS),passwords=page.locator(PASSWORD_FIELDS);
  if(!await users.count()||!await passwords.count())throw new LoginError(p.name,'fields-not-found');
  await typeInto(page,users.first(),pair.username,typeDelay);trace.push('username-typed');
  await typeInto(page,passwords.first(),pair.password,typeDelay);trace.push('password-typed');
  const typed=[await valueLength(users.first()),await valueLength(passwords.first())];
  if(!typed[0]||!typed[1])throw new LoginError(p.name,'fields-not-filled','輸入後欄位仍是空的');
  if(typed[0]!==pair.username.length||typed[1]!==pair.password.length)throw new LoginError(p.name,'fields-not-filled','欄位內容長度與設定不符');
  trace.push('fields-verified');
  const login=page.getByRole('button',{name:'登入',exact:true});
  if(!await login.waitFor({state:'visible',timeout:10000}).then(()=>true,()=>false))throw new LoginError(p.name,'login-button-disabled','找不到登入按鈕');
  if(await login.isDisabled())throw new LoginError(p.name,'login-button-disabled');
  await login.click();trace.push('login-clicked');await settle(page);
  if(await onLoginForm(page)||page.url().includes('/login')){const notice=redactSecrets(await pageNotice(page),pair);throw new LoginError(p.name,'login-rejected',notice?`頁面提示：${notice}`:'');}
  trace.push('left-login-page');
  await confirmRoute(page,p,route);trace.push('route-confirmed');
  return true;
 }catch(error){
  if(error instanceof LoginError)throw error;
  throw scrub(error,pair);
 }
}

// Clear every visible text-like input (account, password, show-password fields) so no
// credential text can appear in a screenshot. Returns false if the page could not be cleared.
async function clearInputs(page){
 try{
  await page.evaluate(()=>{for(const e of document.querySelectorAll('input'))if(!/^(hidden|checkbox|radio|submit|button|image|file|reset)$/i.test(e.type))e.value='';});
  return true;
 }catch{return false;}
}

// Save what the page looked like (URL without query, title, screenshot) for diagnosis.
export async function captureLoginFailure(page,diag,p,attempt,error,steps=[]){
 const event={attempt,outcome:'failed',steps,kind:error.kind,summary:LOGIN_KINDS[error.kind]||error.kind,detail:error.detail||'',time:new Date().toISOString(),url:null,title:null};
 try{const u=new URL(page.url());event.url=u.origin+u.pathname;}catch{}
 event.title=await Promise.resolve().then(()=>page.title()).catch(()=>null);
 if(diag?.folder){
  diag.seq=(diag.seq||0)+1;
  const name=`login-${p.key||'platform'}-${diag.source||'main'}-${diag.seq}.png`;
  if(!await clearInputs(page))event.screenshotError='未能先清除帳密欄位，已略過截圖';
  else{
   try{await page.screenshot({path:path.join(diag.folder,name)});event.screenshot=name;}
   catch(e){event.screenshotError=cleanText(e?.message).slice(0,120);}
  }
 }
 if(diag)await recordEvent(diag,p,event);
 return event;
}

async function recordEvent(diag,p,event){
 (diag.events||=[]).push(event);
 if(diag.folder)await fs.writeFile(path.join(diag.folder,`login-${p.key||'platform'}-${diag.source||'main'}.json`),JSON.stringify(diag.events,null,2)).catch(()=>{});
}

// Open a backend route, logging in if needed; if the attempt fails, do exactly one more
// refresh + type + login cycle, then give up with the classified error. Missing
// credentials are not retried. The backup window (another program's Chrome) is only read:
// credentials are never typed there.
export async function openRoute(page,p,route,diag,options){
 if(diag?.source==='backup')options={...options,allowLogin:false};
 let last;
 for(let attempt=1;attempt<=MAX_LOGIN_ATTEMPTS;attempt++){
  const steps=[];
  try{
   const loggedIn=await attemptLogin(page,p,route,options,steps);
   if(attempt>1&&diag)diag.recovered=true;
   // Record successful logins too (steps only, no field values) so a recovery is provable.
   if(diag&&steps.length){let url=null;try{const u=new URL(page.url());url=u.origin+u.pathname;}catch{}await recordEvent(diag,p,{attempt,outcome:loggedIn?'logged-in':'session-restored',route,steps,url,time:new Date().toISOString()});}
   return loggedIn;
  }
  catch(error){
   if(!(error instanceof LoginError))throw error;
   last=error;await captureLoginFailure(page,diag,p,attempt,error,steps);
   if(error.kind==='credentials-missing'||error.kind==='backup-login-page')break;
  }
 }
 throw last;
}

export function isLoginFailure(error){
 return error instanceof LoginError||/需要重新登入|工作階段已失效|已按登入|後台拒絕|登入按鈕/u.test(error?.message||'');
}

export function describeLoginError(error){
 if(error instanceof LoginError)return {kind:error.kind,summary:`${LOGIN_KINDS[error.kind]||error.kind}${error.detail?`（${error.detail}）`:''}`,message:error.message};
 const text=cleanText(error?.message);
 if(/ECONNREFUSED|connectOverCDP|WebSocket|Target page, context or browser has been closed/i.test(text))return {kind:'backup-unavailable',summary:`無法連上備用 Chrome（${text.slice(0,80)}）`,message:text};
 return {kind:'other',summary:text.slice(0,120),message:text};
}

// Read through the dedicated window; only on a login failure try the backup window.
// Both errors are kept (never collapsed) and returned through onLogin. Without
// connectBackup (run.mjs --no-fallback) the backup window is not used at all.
export async function readWithFallback({reader,context,platform,params=[],folder,connectBackup,onLogin=()=>{}}){
 const main={folder,source:'main',events:[]};
 try{
  const data=await reader(context,platform,...params,main);
  if(main.events.length)onLogin({main:{ok:main.events.some(e=>e.outcome!=='failed'),recovered:true,events:main.events}});
  return{data,fallback:false};
 }
 catch(error){
  if(!isLoginFailure(error))throw error;
  const login={main:{...describeLoginError(error),events:main.events}};
  onLogin(login);
  if(!connectBackup){
   login.backup={kind:'backup-disabled',ok:false,summary:'本次已停用備用視窗（--no-fallback）',events:[]};onLogin(login);
   throw new BackendLoginFailure(platform.name,login);
  }
  const backup={folder,source:'backup',events:[]};let alternate;
  try{
   alternate=await connectBackup();
   const other=alternate.contexts()[0];
   if(!other)throw Error('找不到備用瀏覽器工作階段');
   const data=await reader(other,platform,...params,backup);
   login.backup={ok:true,summary:'備用視窗讀取成功',events:backup.events};onLogin(login);
   return{data,fallback:true};
  }catch(backupError){
   login.backup={...describeLoginError(backupError),events:backup.events};onLogin(login);
   throw new BackendLoginFailure(platform.name,login);
  }finally{if(alternate)await alternate.close().catch(()=>{});}
 }
}
