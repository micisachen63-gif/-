import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {guardedRun,readTelegramConfigPath,markUnfinished,withTimeout} from './run-guard.mjs';
import {buildTelegramReport} from './telegram-notify.mjs';

function harness(overrides={}){
 const calls=[];const status={runId:'r1',mode:'apply',date:'2026-09-26',platforms:[],completed:false};
 const proc=new EventEmitter();
 const options={status,processLike:proc,shouldNotify:true,timeoutMs:1000,stepTimeoutMs:200,
  finalize:async()=>{calls.push('finalize');},
  notify:async s=>{calls.push(['notify',structuredClone(s)]);return {sent:true};},
  release:async()=>{calls.push('release');},...overrides};
 return {calls,status,proc,options,notified:()=>calls.filter(c=>c[0]==='notify').map(c=>c[1])};
}

test('全部完成：通知一次、釋放鎖、結束碼 0',async()=>{
 const h=harness({work:async function(){this;}});
 h.options.work=async()=>{h.status.platforms.push({platform:'茄子',state:'verified',completedSteps:[],warnings:[]});h.status.completed=true;};
 const r=await guardedRun(h.options);
 assert.equal(r.exitCode,0);assert.equal(r.aborted,false);
 assert.deepEqual(h.calls.map(c=>Array.isArray(c)?c[0]:c),['finalize','notify','release']);
 assert.equal(h.notified()[0].completed,true);assert.equal(h.status.telegram.sent,true);
});

test('平台失敗（後台登入或 Sheets 錯誤）：送失敗通知、結束碼 1',async()=>{
 const h=harness();
 h.options.work=async()=>{h.status.platforms.push({platform:'茄子',state:'failed',completedSteps:[],warnings:[],error:'茄子後台登入失效，主視窗與備用視窗都無法讀取'},{platform:'爽爆',state:'failed',completedSteps:[],warnings:[],error:'locator.waitFor: Timeout 90000ms exceeded.'});h.status.completed=false;};
 const r=await guardedRun(h.options);
 assert.equal(r.exitCode,1);
 const [sent]=h.notified();assert.equal(sent.completed,false);
 const text=buildTelegramReport(sent).text;
 assert.match(text,/尚有未竟之事/);assert.match(text,/茄子：❌ 失敗；原因：茄子後台登入失效/);assert.match(text,/爽爆：❌ 失敗；原因：locator\.waitFor/);
});

test('頂層例外（設定檔、模組載入、鎖、瀏覽器連線）：記錄錯誤、通知、釋放鎖',async()=>{
 const h=harness({work:async()=>{throw Error("Cannot find module 'playwright'");}});
 const r=await guardedRun(h.options);
 assert.equal(r.exitCode,1);assert.equal(r.aborted,false);
 assert.match(h.status.error,/Cannot find module/);
 assert.match(buildTelegramReport(h.notified()[0]).text,/啟動／整體錯誤：Cannot find module/);
 assert.ok(h.calls.includes('release'));
});

test('執行卡住：逾時中止、進行中平台標為失敗、通知並釋放鎖',async()=>{
 const h=harness({timeoutMs:60});
 h.options.work=()=>{h.status.platforms.push({platform:'贏麻了',state:'verified',completedSteps:['週報日更已核對'],warnings:[]},{platform:'爽爆',state:'writing-revenue',completedSteps:[],warnings:[]});return new Promise(()=>{});};
 const r=await guardedRun(h.options);
 assert.equal(r.exitCode,1);assert.equal(r.aborted,true);
 assert.match(h.status.error,/整體執行逾時/);
 assert.equal(h.status.platforms[0].state,'verified');
 assert.equal(h.status.platforms[1].state,'failed');assert.match(h.status.platforms[1].error,/逾時/);
 assert.deepEqual(h.calls.map(c=>Array.isArray(c)?c[0]:c),['finalize','notify','release']);
 assert.match(buildTelegramReport(h.notified()[0]).text,/爽爆：❌ 失敗；原因：整體執行逾時/);
});

test('未捕捉的例外／未處理的 Promise 拒絕：視為異常中止並通知',async()=>{
 const h=harness();
 h.options.work=()=>{setTimeout(()=>h.proc.emit('unhandledRejection',Error('socket hang up')),5);return new Promise(()=>{});};
 const r=await guardedRun(h.options);
 assert.equal(r.exitCode,1);assert.equal(r.aborted,true);
 assert.match(h.status.error,/程式異常中止：socket hang up/);
 assert.equal(h.notified().length,1);
 assert.equal(h.proc.listenerCount('unhandledRejection'),0);assert.equal(h.proc.listenerCount('uncaughtException'),0);
});

test('關閉瀏覽器卡住仍會通知並釋放鎖',async()=>{
 const h=harness({finalize:()=>new Promise(()=>{}),stepTimeoutMs:30});
 h.options.work=async()=>{h.status.completed=true;};
 const r=await guardedRun(h.options);
 assert.match(h.status.finalizeError,/關閉瀏覽器連線逾時/);
 assert.equal(h.notified().length,1);assert.ok(h.calls.includes('release'));assert.equal(r.exitCode,0);
});

test('TG 發送失敗：不影響釋放鎖，結束碼 1',async()=>{
 const h=harness({notify:async()=>{throw Error('TG 連線失敗或逾時。');}});
 h.options.work=async()=>{h.status.completed=true;};
 const r=await guardedRun(h.options);
 assert.equal(r.exitCode,1);assert.deepEqual(h.status.telegram,{sent:false,error:'TG 連線失敗或逾時。'});assert.ok(h.calls.includes('release'));
});

test('試跑（不通知）不送 TG',async()=>{
 const h=harness({shouldNotify:false});
 h.options.work=async()=>{throw Error('boom');};
 await guardedRun(h.options);
 assert.equal(h.notified().length,0);assert.ok(h.calls.includes('release'));
});

test('設定檔損壞時仍能取得 TG 設定路徑',()=>{
 assert.equal(readTelegramConfigPath('{"telegramConfigPath":"C:\\\\a\\\\tg.json","x":1}'),'C:\\a\\tg.json');
 assert.equal(readTelegramConfigPath('{ "telegramConfigPath": "C:\\\\a\\\\tg.json", broken'),'C:\\a\\tg.json');
 assert.equal(readTelegramConfigPath('\uFEFF{"enabled":true}'),null);
});

test('輔助函式：markUnfinished 與 withTimeout',async()=>{
 const s={platforms:[{state:'verified'},{state:'reading'},{state:'failed',error:'x'}]};
 markUnfinished(s,'中止');assert.deepEqual(s.platforms.map(p=>[p.state,p.error]),[['verified',undefined],['failed','中止'],['failed','x']]);
 assert.equal(await withTimeout(Promise.resolve(5),50,'t'),5);
 await assert.rejects(withTimeout(new Promise(()=>{}),10,'逾時了'),/逾時了/);
});

test('主視窗自動重新登入成功時，TG 報告附註已自動重新登入',()=>{
 const text=buildTelegramReport({runId:'r',date:'2026-09-26',completed:true,platforms:[{platform:'茄子',state:'verified',completedSteps:['週報日更已核對'],warnings:[],login:{main:{ok:true,events:[{outcome:'logged-in'}]}}}]}).text;
 assert.match(text,/茄子：✅ 完成；已核對 週報日更已核對；後台登入逾時，已自動重新登入/);
});
