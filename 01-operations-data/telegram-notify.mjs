import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const sentFile=path.join(root,'private','telegram-notifications.json');
const DELETE_WINDOW_MS=48*60*60*1000;

export async function loadTelegramConfig(configPath){
 if(!configPath)throw Error('未指定共用 TG 設定檔。');
 const file=path.isAbsolute(configPath)?configPath:path.resolve(root,configPath);
 const config=JSON.parse(await fs.readFile(file,'utf8'));
 if(!/^\d+:[A-Za-z0-9_-]+$/.test(config.botToken||'')||! /^-[1-9]\d*$/.test(String(config.chatId||'')))throw Error('共用 TG 設定檔無效：需有 Bot token 與群組 chat ID。');
 if(!['yingma_songbao_qiezi_bot','temple_watchkeeper_bot'].includes(config.botUsername))throw Error('共用 TG 設定檔不是指定的 Bot。');
 return {token:config.botToken,chatId:String(config.chatId)};
}

// Error text from Playwright carries ANSI colour codes and multi-line call logs.
export function cleanText(value){
 return String(value??'').replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g,'').replace(/\s*\n\s*/g,' ').trim();
}

export function buildTelegramReport(status){
 const complete=status.completed===true;
 const lines=[complete?'🧙 神殿守望者：帳目已核，今日營運更新完成。':'🧙 神殿守望者：營運更新尚有未竟之事，請依下列紀錄審視。'];
 if(status.date)lines.push(`執行日期：${status.date}（台北時間）`);
 if(status.through)lines.push(`日更資料截至：${status.through}`);
 if(status.weeklyPlanned)lines.push('這次也有上一完整週的機台週更喔。');
 if(status.error)lines.push(`啟動／整體錯誤：${cleanText(status.error).slice(0,220)}`);
 if(!status.platforms?.length)lines.push('三個平台都還沒開始處理。');
 for(const platform of status.platforms||[]){
  const state=platform.state==='verified'?'✅ 完成':platform.state==='failed'?'❌ 失敗':`⏳ ${platform.state||'未完成'}`;
  let line=`${platform.platform}：${state}`;
  if(platform.completedSteps?.length)line+=`；已核對 ${platform.completedSteps.join('、')}`;
  if(platform.error)line+=`；原因：${cleanText(platform.error).slice(0,platform.login?320:220)}`;
  const logins=[platform.login,platform.loginWeekly].filter(Boolean);
  const fallback=logins.find(l=>l.backup?.ok);
  if(fallback&&!platform.error)line+=`；主視窗登入失敗（${cleanText(fallback.main?.summary).slice(0,80)}），已改用備用視窗讀取`;
  if(!fallback&&!platform.error&&logins.some(l=>l.main?.ok))line+='；後台登入逾時，已自動重新登入';
  if(logins.some(l=>[l.main,l.backup].some(s=>s?.events?.some(e=>e.screenshot))))line+='；已存登入截圖供核對';
  if(platform.warnings?.length)line+=`；提醒：${platform.warnings.map(w=>cleanText(w).slice(0,120)).join('、')}`;
  lines.push(line);
 }
 if(complete)lines.push('三個平台皆已核對。凡事以實據為準，方能行穩致遠。');
 else lines.push('📌 部分表格可能已更新；補跑前請先核對當次紀錄，避免重複寫入喔。');
 const text=lines.join('\n');
 return {complete,text:text.length>4000?`${text.slice(0,3990)}…`:text};
}

async function callTelegram(config,method,payload,fetchImpl){
 let response;
 try{
  response=await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`,{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify(payload),signal:AbortSignal.timeout(15000),
  });
 }catch{throw Error('TG 連線失敗或逾時。');}
 const data=await response.json().catch(()=>null);
 if(!response.ok||data?.ok!==true)throw Error(`TG 拒絕${method==='deleteMessage'?'刪除':'發送'}（HTTP ${response.status}，代碼 ${data?.error_code||'unknown'}）。`);
 return data;
}

// Returns the Telegram message_id so the send can be recorded and later replaced.
export async function sendTelegram(config,text,fetchImpl=fetch){
 const data=await callTelegram(config,'sendMessage',{chat_id:config.chatId,text},fetchImpl);
 if(String(data.result?.chat?.id)!==config.chatId)throw Error('TG 回傳的群組 ID 不符。');
 const messageId=data.result?.message_id;
 return {chatId:config.chatId,messageId:Number.isSafeInteger(messageId)?messageId:null};
}

export async function deleteTelegram(config,messageId,fetchImpl=fetch){
 if(!Number.isSafeInteger(messageId)||messageId<1)throw Error('沒有可刪除的訊息編號。');
 await callTelegram(config,'deleteMessage',{chat_id:config.chatId,message_id:messageId},fetchImpl);
}

// Older records have no reportDate; derive the Taipei date from the UTC runId.
export function reportDateOf(record){
 if(record?.reportDate)return record.reportDate;
 const m=/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(record?.runId||'');
 if(!m)return null;
 const t=new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
 return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(t);
}

async function readSent(){return await fs.readFile(sentFile,'utf8').then(JSON.parse).catch(error=>{
 if(error.code==='ENOENT')return {sent:{}};
 throw error;
});}

async function saveSent(state){
 await fs.mkdir(path.dirname(sentFile),{recursive:true});
 const temp=`${sentFile}.${process.pid}.tmp`;
 await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n');
 await fs.rename(temp,sentFile);
}

// After a new report is delivered, remove this program's earlier reports for the same
// report date in the same group. Only recorded message IDs are used; failures are logged only.
async function replaceEarlier(state,signature,record,config,fetchImpl,now){
 const result={deleted:0,deleteFailed:0,manualDeleteNeeded:0};
 if(!record.reportDate)return result;
 for(const [key,old] of Object.entries(state.sent)){
  if(key===signature||old.deletedAt||reportDateOf(old)!==record.reportDate)continue;
  if(old.chatId&&old.chatId!==config.chatId)continue;
  if(!Number.isSafeInteger(old.messageId)){if(!old.chatId||old.chatId===config.chatId)result.manualDeleteNeeded++;continue;}
  if(!old.chatId)continue;
  const age=now-Date.parse(old.sentAt);
  if(!(age>=0&&age<DELETE_WINDOW_MS)){result.manualDeleteNeeded++;continue;}
  try{
   await deleteTelegram(config,old.messageId,fetchImpl);
   old.deletedAt=new Date(now).toISOString();old.deletedBy=record.runId;delete old.deleteError;result.deleted++;
  }catch(error){old.deleteError=cleanText(error.message);old.deleteTriedAt=new Date(now).toISOString();result.deleteFailed++;}
 }
 return result;
}

export async function notifyOperations(status,options={}){
 const config=options.config||await loadTelegramConfig(options.configPath);
 const fetchImpl=options.fetchImpl||fetch;
 if(options.test){
  await sendTelegram(config,'🧙 神殿守望者：營運數據通知通道已核對。此為連線驗證，不代表報表已更新。',fetchImpl);
  return {sent:true,test:true};
 }
 const report=buildTelegramReport(status);
 const signature=crypto.createHash('sha256').update(JSON.stringify({runId:status.runId,report})).digest('hex');
 const state=options.sentState||await readSent();state.sent||={};
 if(state.sent[signature])return {sent:false,duplicate:true,complete:report.complete};
 const delivered=await sendTelegram(config,report.text,fetchImpl);
 const now=options.now??Date.now();
 const record={runId:status.runId,complete:report.complete,sentAt:new Date(now).toISOString(),reportDate:status.date||null,chatId:delivered.chatId,messageId:delivered.messageId};
 state.sent[signature]=record;
 if(!options.sentState)await saveSent(state);
 let cleanup={deleted:0,deleteFailed:0,manualDeleteNeeded:0};
 try{
  cleanup=await replaceEarlier(state,signature,record,config,fetchImpl,now);
  if(!options.sentState&&(cleanup.deleted||cleanup.deleteFailed))await saveSent(state);
 }catch(error){cleanup={...cleanup,cleanupError:cleanText(error.message)};}
 return {sent:true,complete:report.complete,messageId:delivered.messageId,...cleanup};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const config=JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8'));
  if(!process.argv.includes('--test'))throw Error('此入口只供 --test 測試通知；正式通知由 run.mjs 執行。');
  await notifyOperations({},{configPath:config.telegramConfigPath,test:true});
  console.log('TG 營運通知測試已送達。');
 }catch(error){console.error(`TG 營運通知測試失敗：${error.message}`);process.exitCode=1;}
}
