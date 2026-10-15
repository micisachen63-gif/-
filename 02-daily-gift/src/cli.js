#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'help', ...args] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) throw new Error(`無效參數：${args[i]}`);
  const name = args[i].slice(2);
  if (Object.hasOwn(opts, name)) throw new Error(`參數重複：--${name}`);
  if (args[i + 1] && !args[i + 1].startsWith('--')) opts[name] = args[++i];
  else opts[name] = true;
}
const cfgPath = path.join(root, 'config.json');
const config = JSON.parse(fs.readFileSync(fs.existsSync(cfgPath) ? cfgPath : path.join(root, 'config.example.json'), 'utf8'));
const statePath = path.join(root, 'state', 'runs.json');
const lockPath = path.join(root, 'state', 'runs.lock');
const brands = Object.keys(config.brands);

function loadState() { return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { runs: {} }; }
function mutateState(change) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('另一個批次正在更新狀態；請先確認執行中的程序，勿直接重送。'); throw error; }
  try {
    fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`);
    const state = loadState(), result = change(state);
    const temp = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n'); fs.renameSync(temp, statePath); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return result;
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, content); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function log(message) { fs.mkdirSync(path.join(root, 'logs'), { recursive: true }); fs.appendFileSync(path.join(root, 'logs', `${todayTaipei()}.log`), `[${new Date().toISOString()}] ${message}\n`); }
function dateCheck(d) { if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? '')) throw new Error('請以 --date YYYY-MM-DD 指定註冊日期。'); const [y,m,day]=d.split('-').map(Number); const dt=new Date(Date.UTC(y,m-1,day)); if(Number.isNaN(+dt)||dt.getUTCFullYear()!==y||dt.getUTCMonth()!==m-1||dt.getUTCDate()!==day) throw new Error(`日期無效：${d}`); return d; }
function todayTaipei() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function yesterdayTaipei() { const [y,m,d]=todayTaipei().split('-').map(Number); return new Date(Date.UTC(y,m-1,d-1)).toISOString().slice(0,10); }
function parseCsv(input) {
  const text = input.replace(/^\uFEFF/, '');
  const records = [];
  let record = [], field = '', quoted = false, closedQuote = false;
  function endRecord() {
    record.push(field);
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = []; field = ''; closedQuote = false;
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else field += char;
    } else if (char === ',') { record.push(field); field = ''; closedQuote = false; }
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i+1] === '\n') i++; endRecord(); }
    else if (char === '"' && field === '' && !closedQuote) quoted = true;
    else if (closedQuote || char === '"') throw new Error('CSV 引號格式無效。');
    else field += char;
  }
  if (quoted) throw new Error('CSV 引號未關閉。');
  if (record.length || field !== '' || closedQuote) endRecord();
  if (!records.length) throw new Error('CSV 檔案沒有欄位標題。');
  const headers = records.shift().map(value => value.trim());
  const named = headers.filter(Boolean);
  if (!named.length || new Set(named).size !== named.length || headers.slice(0,-1).some(value => !value)) throw new Error('CSV 欄位標題空白或重複。');
  for (const row of records) if (row.length !== headers.length) throw new Error('CSV 有欄位數量不符的資料列。');
  return { headers, rows: records };
}
function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/.exec(String(value??'').trim());
  if (!match) return null;
  const [,y,m,d,h,minute,second,zone] = match;
  if (Number(h)>23 || Number(minute)>59 || Number(second)>59) return null;
  const calendar = new Date(Date.UTC(Number(y),Number(m)-1,Number(d)));
  if (calendar.getUTCFullYear()!==Number(y) || calendar.getUTCMonth()!==Number(m)-1 || calendar.getUTCDate()!==Number(d)) return null;
  const suffix = zone ? zone.replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : '+08:00';
  const parsed = new Date(`${y}-${m}-${d}T${h}:${minute}:${second}${suffix}`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}
function quote(value) { return '"'+String(value??'').replaceAll('"','""')+'"'; }
function slug(s) { return s.replace(/[^\p{L}\p{N}-]+/gu,'_'); }
function batchKey(date, brand) { return `${date}/${brand}`; }
function resolveDate() { return dateCheck(opts.date ?? yesterdayTaipei()); }
function help(){ console.log('Commands: prepare [--date YYYY-MM-DD] | begin --date YYYY-MM-DD --brand BRAND | needs-review --date YYYY-MM-DD --brand BRAND --reason TEXT | complete --date YYYY-MM-DD --brand BRAND --mail-count N --line-count N --mail-verified --line-audience-verified --line-broadcast-verified --cleanup-verified | status [--date YYYY-MM-DD] | audit'); }

try {
  if (command === 'help' || command === '--help') { help(); process.exit(0); }
  if (command === 'audit') {
    const checks = {
      persistentAuthenticatedBrowser: Boolean(config.automation?.browserExecutable && config.automation?.profileDirectory),
      gameAdminSelectorsVerified: brands.every(b => Boolean(config.brands[b].automation?.selectorsVerified)),
      appsScriptTriggerVerified: Boolean(config.spreadsheet?.automation?.triggerVerified),
      linePushIntegrationVerified: Boolean(config.line?.api?.pushIntegrationVerified),
      cleanupActionVerified: Boolean(config.spreadsheet?.automation?.cleanupVerified),
      dailyRunnerIntegrated: false
    };
    const ready = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ ready, checks }, null, 2));
    process.exit(ready ? 0 : 2);
  }
  if (command === 'status') {
    const date=resolveDate(), state=loadState();
    for(const brand of brands) console.log(`${brand}: ${JSON.stringify(state.runs[batchKey(date,brand)]??{status:'not-recorded'})}`);
    process.exit(0);
  }
  if (command === 'begin') {
    const date=dateCheck(opts.date), brand=opts.brand, key=batchKey(date,brand);
    if(!Object.hasOwn(config.brands, brand??'')) throw new Error('品牌代碼無效。');
    const run=mutateState(state => {
      const item=state.runs[key];
      if(item?.status!=='prepared') throw new Error('批次未準備完成或已開始；先核對狀態，禁止重送。');
      const staging=path.resolve(root,item.stagingFile);
      if(!staging.startsWith(path.join(root,'staging')+path.sep)) throw new Error('派送檔案位置無效。');
      if(!fs.existsSync(staging)||sha256(fs.readFileSync(staging))!==item.stagingHash) throw new Error('派送檔不存在或已變更，停止對外派送。');
      item.status='in_progress';item.externalActionStartedAt=new Date().toISOString();
      return item;
    });
    log(`BEGIN ${key} count=${run.memberCount}`);
    console.log(`已鎖定 ${key}；外部動作可開始，失敗時不得自動重送。`);
    process.exit(0);
  }
  if (command === 'needs-review') {
    const date=dateCheck(opts.date), brand=opts.brand, key=batchKey(date,brand), reason=String(opts.reason??'').trim();
    if(!Object.hasOwn(config.brands,brand??'')) throw new Error('品牌代碼無效。');
    if(!reason||reason==='true') throw new Error('請填寫 --reason。');
    mutateState(state => {
      const run=state.runs[key];
      if(run?.status!=='in_progress') throw new Error('只有執行中的批次可標記為需核對。');
      run.status='needs_review';run.reviewReason=reason;run.reviewAt=new Date().toISOString();
    });
    log(`NEEDS_REVIEW ${key}`);console.log(`${key} 已標記需核對；禁止自動重送。`);process.exit(0);
  }
  if (command === 'complete') {
    const date=dateCheck(opts.date), brand=opts.brand, key=batchKey(date,brand);
    if(!Object.hasOwn(config.brands,brand??'')) throw new Error('品牌代碼無效。');
    for(const flag of ['mail-verified','line-audience-verified','line-broadcast-verified','cleanup-verified']) if(opts[flag]!==true) throw new Error(`請先確認 --${flag}。`);
    for(const field of ['mail-count','line-count']) if(!/^\d+$/.test(String(opts[field]??''))||!Number.isSafeInteger(Number(opts[field]))) throw new Error(`請填入有效的 --${field}。`);
    mutateState(state => {
      const run=state.runs[key];
      if(run?.status!=='in_progress') throw new Error('批次未鎖定或已有不確定的外部結果，禁止標記完成。');
      run.status='completed';run.completedAt=new Date().toISOString();run.mailCount=Number(opts['mail-count']);run.lineCount=Number(opts['line-count']);
      run.steps??={};for(const step of ['gameMail','lineAudience','lineBroadcast','cleanup']) run.steps[step]='confirmed';
    });
    log(`COMPLETED ${key} mail=${opts['mail-count']} line=${opts['line-count']} cleanup=true`);console.log(`已完成並記錄 ${config.brands[brand].name} ${date}。`);process.exit(0);
  }
  if (command !== 'prepare') throw new Error(`未知指令：${command}`);
  const date=resolveDate(), dayStart=Date.parse(`${date}T00:00:00+08:00`), dayEnd=dayStart+86400000;
  let errors=0;
  for(const [brand,bcfg] of Object.entries(config.brands)) {
    const key=batchKey(date,brand);
    try {
      const old=loadState().runs[key];
      if(old?.status==='completed'){console.log(`SKIP ${bcfg.name}: ${date} 已完成。`);continue;}
      if(old?.status==='in_progress'||old?.status==='needs_review'){console.log(`STOP ${bcfg.name}: 上次外部結果不確定，禁止重送。`);continue;}
      const source=path.resolve(root,bcfg.inbox,`${brand}-${date}.csv`);
      if(!fs.existsSync(source)){console.log(`WAIT ${bcfg.name}: 缺少 ${brand}-${date}.csv。`);continue;}
      const sourceBytes=fs.readFileSync(source), {headers,rows}=parseCsv(sourceBytes.toString('utf8'));
      const idIndex=headers.indexOf(bcfg.memberIdColumn), timeIndex=headers.indexOf(bcfg.registeredAtColumn);
      if(idIndex<0||timeIndex<0) throw new Error(`${bcfg.name} CSV 欄位不符。`);
      const seen=new Set();
      for(const row of rows){
        const id=row[idIndex].trim(), registration=parseDate(row[timeIndex]);
        if(!id) throw new Error(`${bcfg.name} 有空白會員 ID。`);
        if(seen.has(id)) throw new Error(`${bcfg.name} 同日有重複會員 ID。`);
        seen.add(id);
        if(!registration) throw new Error(`${bcfg.name} 註冊時間格式無法解析。`);
        if(registration.valueOf()<dayStart||registration.valueOf()>=dayEnd) throw new Error(`${bcfg.name} CSV 含指定日期以外的會員，停止匯入。`);
      }
      const relativeFile=path.join('staging',date,brand,`${brand}-${date}-members.csv`);
      const staging=path.join(root,relativeFile);
      const stagingBytes=Buffer.from('\uFEFF'+[headers.map(quote).join(','),...rows.map(row=>row.map(quote).join(','))].join('\r\n')+'\r\n','utf8');
      const sourceHash=sha256(sourceBytes),stagingHash=sha256(stagingBytes);
      const report={date,brand,name:bcfg.name,timezone:config.timezone,memberCount:rows.length,sourceFile:path.relative(root,source),sourceHash,stagingFile:relativeFile,stagingHash,steps:{sourceExport:'validated',appsScript:'pending',gameMail:'pending',lineAudience:'pending',lineBroadcast:'pending',cleanup:'pending'},status:'prepared',preparedAt:new Date().toISOString()};
      const outcome=mutateState(state=>{
        const current=state.runs[key];
        if(current?.status==='completed')return 'completed';
        if(current?.status==='in_progress'||current?.status==='needs_review')return 'blocked';
        if(current?.status==='prepared'){
          if(current.sourceHash!==sourceHash||current.stagingHash!==stagingHash||current.memberCount!==rows.length)throw new Error(`${bcfg.name} 已準備的名單與目前 CSV 不同，需核對後才可重跑。`);
          if(!fs.existsSync(staging)||sha256(fs.readFileSync(staging))!==stagingHash)throw new Error(`${bcfg.name} 已準備的派送檔遺失或變更，需核對。`);
          return 'prepared';
        }
        writeAtomic(staging,stagingBytes);state.runs[key]=report;return 'ready';
      });
      if(outcome==='ready'){log(`PREPARED ${key} count=${rows.length}`);console.log(`READY ${bcfg.name}: ${rows.length} 筆 → ${relativeFile}`);}
      else console.log(`${outcome==='prepared'?'SKIP':'STOP'} ${bcfg.name}: ${date} ${outcome==='prepared'?'已準備且檔案一致。':'不可重新派送。'}`);
    }catch(error){errors++;console.error(`ERROR ${bcfg.name}: ${error.message}`);log(`ERROR PREPARE ${key}: ${error.message}`);}
  }
  if(errors)process.exitCode=1;
} catch(e) { console.error(`ERROR: ${e.message}`);log(`ERROR ${command}: ${e.message}`);process.exitCode=1; }
