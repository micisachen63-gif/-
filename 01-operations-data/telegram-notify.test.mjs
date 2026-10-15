import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildTelegramReport,cleanText,loadTelegramConfig,notifyOperations,reportDateOf} from './telegram-notify.mjs';

const complete={
 runId:'run-1',date:'2026-09-23',through:'2026-09-22',weeklyPlanned:false,completed:true,
 platforms:['贏麻了','爽爆','茄子'].map(platform=>({platform,state:'verified',completedSteps:['週報日更已核對','營收總表已核對'],warnings:[]})),
};

test('a renamed group title does not invalidate the configured bot and group ID',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'operations-tg-config-'));
 const filename=path.join(directory,'telegram.json');
 t.after(async()=>{await unlink(filename);await rmdir(directory);});
 const config={botToken:'1:example',botUsername:'yingma_songbao_qiezi_bot',chatId:'-5445135326',groupName:'新的群組名稱'};
 await writeFile(filename,JSON.stringify(config));
 assert.deepEqual(await loadTelegramConfig(filename),{token:'1:example',chatId:'-5445135326'});
 await writeFile(filename,JSON.stringify({...config,botUsername:'other_bot'}));
 await assert.rejects(loadTelegramConfig(filename),/不是指定的 Bot/);
 await writeFile(filename,JSON.stringify({...config,chatId:'12345'}));
 await assert.rejects(loadTelegramConfig(filename),/群組 chat ID/);
});

test('complete report lists each verified platform',()=>{
 const report=buildTelegramReport(complete);
 assert.equal(report.complete,true);
 assert.match(report.text,/神殿守望者：帳目已核/);
 for(const name of ['贏麻了','爽爆','茄子'])assert.match(report.text,new RegExp(`${name}：✅ 完成`));
 assert.match(report.text,/三個平台皆已核對/);
});

test('partial failure preserves completed platform steps and the failing reason',()=>{
 const status={...complete,completed:false,platforms:[
  {platform:'贏麻了',state:'failed',completedSteps:['週報日更已核對'],error:'需要重新登入'},
  ...complete.platforms.slice(1),
 ]};
 const report=buildTelegramReport(status);
 assert.equal(report.complete,false);
 assert.match(report.text,/神殿守望者：營運更新尚有未竟之事/);
 assert.match(report.text,/贏麻了：❌ 失敗；已核對 週報日更已核對；原因：需要重新登入/);
 assert.match(report.text,/爽爆：✅ 完成；已核對/);
 assert.match(report.text,/茄子：✅ 完成；已核對/);
 assert.match(report.text,/部分表格可能已更新/);
});

test('one run is not notified twice',async()=>{
 const sentState={sent:{}};
 let calls=0;
 const fetchImpl=async(_url,request)=>{
  calls++;
  assert.match(JSON.parse(request.body).text,/神殿守望者：帳目已核/);
  return {ok:true,status:200,json:async()=>({ok:true,result:{chat:{id:-5445135326}}})};
 };
 const options={config:{token:'1:example',chatId:'-5445135326'},sentState,fetchImpl};
 assert.equal((await notifyOperations(complete,options)).sent,true);
 assert.equal((await notifyOperations(complete,options)).duplicate,true);
 assert.equal(calls,1);
});

test('Telegram must confirm the configured group ID',async()=>{
 const fetchImpl=async()=>({ok:true,status:200,json:async()=>({ok:true,result:{chat:{id:-1009876543210}}})});
 await assert.rejects(
  notifyOperations({}, {config:{token:'1:example',chatId:'-5445135326'},test:true,fetchImpl}),
  /群組 ID 不符/,
 );
});

// Replace earlier same-day reports: send the new one first, then delete old ones.


function recordingFetch({failDelete=false}={}){
 const calls=[];let nextId=500;
 const fetchImpl=async(url,request)=>{
  const method=url.split('/').pop(),body=JSON.parse(request.body);calls.push({method,body});
  if(method==='sendMessage')return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:nextId++,chat:{id:-5445135326}}})};
  if(method==='deleteMessage'){
   if(failDelete)return {ok:false,status:400,json:async()=>({ok:false,error_code:400,description:'Bad Request: message to delete not found'})};
   return {ok:true,status:200,json:async()=>({ok:true,result:true})};
  }
  throw Error('unexpected method '+method);
 };
 return {calls,fetchImpl};
}
const tgConfig={token:'1:example',chatId:'-5445135326'};
const now=Date.parse('2026-09-25T02:00:00Z');

test('a successful send records message_id, chat and report date',async()=>{
 const sentState={sent:{}};const {fetchImpl}=recordingFetch();
 const result=await notifyOperations(complete,{config:tgConfig,sentState,fetchImpl,now});
 assert.equal(result.sent,true);assert.equal(result.messageId,500);
 const [record]=Object.values(sentState.sent);
 assert.deepEqual(record,{runId:'run-1',complete:true,sentAt:new Date(now).toISOString(),reportDate:'2026-09-23',chatId:'-5445135326',messageId:500});
});

test('new report is sent first, then only recorded same-day reports of this group are deleted',async()=>{
 const today={...complete,runId:'2026-09-25T01-40-00-000Z',date:'2026-09-25'};
 const sentState={sent:{
  a:{runId:'2026-09-25T00-00-02-647Z',complete:false,sentAt:'2026-09-25T00:03:05.301Z',reportDate:'2026-09-25',chatId:'-5445135326',messageId:101},
  b:{runId:'2026-09-24T00-12-25-115Z',complete:true,sentAt:'2026-09-24T00:15:40.103Z',reportDate:'2026-09-24',chatId:'-5445135326',messageId:99},
  c:{runId:'x',complete:false,sentAt:'2026-09-25T00:30:00.000Z',reportDate:'2026-09-25',chatId:'-100777',messageId:102},
  d:{runId:'2026-09-25T00-10-00-000Z',complete:false,sentAt:'2026-09-25T00:10:00.000Z'},
  e:{runId:'y',complete:false,sentAt:'2026-09-25T00:20:00.000Z',reportDate:'2026-09-25',chatId:'-5445135326',messageId:103,deletedAt:'2026-09-25T00:25:00.000Z'},
 }};
 const {calls,fetchImpl}=recordingFetch();
 const result=await notifyOperations(today,{config:tgConfig,sentState,fetchImpl,now});
 assert.deepEqual(calls.map(c=>c.method),['sendMessage','deleteMessage']);
 assert.deepEqual(calls[1].body,{chat_id:'-5445135326',message_id:101});
 assert.equal(result.deleted,1);assert.equal(result.deleteFailed,0);assert.equal(result.manualDeleteNeeded,1);
 assert.equal(sentState.sent.a.deletedAt,new Date(now).toISOString());
 assert.equal(sentState.sent.a.deletedBy,today.runId);
 for(const k of ['b','c','d'])assert.equal(sentState.sent[k].deletedAt,undefined);
});

test('messages older than 48 hours are never deleted',async()=>{
 const today={...complete,runId:'r2',date:'2026-09-25'};
 const sentState={sent:{old:{runId:'r1',complete:false,sentAt:'2026-09-22T00:00:00.000Z',reportDate:'2026-09-25',chatId:'-5445135326',messageId:5}}};
 const {calls,fetchImpl}=recordingFetch();
 const result=await notifyOperations(today,{config:tgConfig,sentState,fetchImpl,now});
 assert.deepEqual(calls.map(c=>c.method),['sendMessage']);
 assert.equal(result.deleted,0);assert.equal(sentState.sent.old.deletedAt,undefined);
});

test('a delete failure is only logged and never fails the notification',async()=>{
 const today={...complete,runId:'r2',date:'2026-09-25'};
 const sentState={sent:{old:{runId:'r1',complete:false,sentAt:'2026-09-25T00:03:05.301Z',reportDate:'2026-09-25',chatId:'-5445135326',messageId:101}}};
 const {fetchImpl}=recordingFetch({failDelete:true});
 const result=await notifyOperations(today,{config:tgConfig,sentState,fetchImpl,now});
 assert.equal(result.sent,true);assert.equal(result.deleted,0);assert.equal(result.deleteFailed,1);
 assert.match(sentState.sent.old.deleteError,/TG 拒絕刪除（HTTP 400/);
 assert.equal(sentState.sent.old.deletedAt,undefined);
});

test('delete network errors are also contained',async()=>{
 const today={...complete,runId:'r2',date:'2026-09-25'};
 const sentState={sent:{old:{runId:'r1',complete:false,sentAt:'2026-09-25T00:03:05.301Z',reportDate:'2026-09-25',chatId:'-5445135326',messageId:101}}};
 const fetchImpl=async(url)=>{if(url.endsWith('/deleteMessage'))throw Error('ECONNRESET');return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:600,chat:{id:-5445135326}}})};};
 const result=await notifyOperations(today,{config:tgConfig,sentState,fetchImpl,now});
 assert.equal(result.sent,true);assert.equal(result.deleteFailed,1);
 assert.match(sentState.sent.old.deleteError,/TG 連線失敗或逾時/);
});

test('report date of legacy records is derived from the runId in Taipei time',()=>{
 assert.equal(reportDateOf({runId:'2026-09-25T00-00-02-647Z'}),'2026-09-25');
 assert.equal(reportDateOf({runId:'2026-09-24T16-30-00-000Z'}),'2026-09-25');
 assert.equal(reportDateOf({runId:'2026-09-24T15-59-59-000Z'}),'2026-09-24');
 assert.equal(reportDateOf({runId:'weird'}),null);
});

test('ANSI escape codes and call-log line breaks are removed from error text',()=>{
 const error="locator.waitFor: Timeout 90000ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button') to be visible\u001b[22m\n";
 assert.equal(cleanText(error),"locator.waitFor: Timeout 90000ms exceeded. Call log: - waiting for getByRole('button') to be visible");
 const report=buildTelegramReport({...complete,completed:false,platforms:[{platform:'茄子',state:'failed',completedSteps:[],error}]});
 assert.doesNotMatch(report.text,/\u001b/);
 assert.match(report.text,/茄子：❌ 失敗；原因：locator\.waitFor: Timeout 90000ms exceeded\. Call log:/);
});
