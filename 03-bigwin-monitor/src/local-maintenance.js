import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BridgeState } from './bridge-state.js';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { buildGrokArgs, diffSnapshot, parseGrokJson, pickGrokProject, restoreSnapshot, saveAttempt, scanOutsideChanges, snapshotProject, spawnGrokBuild, writeSnapshot } from './grok-build.js';

const TEXT_EXT = new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.json','.md','.ps1','.cmd','.bat','.sh','.html','.css','.scss','.txt','.yml','.yaml','.toml','.ini','.xml','.sql','.csv','.tsv']);
const BLOCKED = /(^|[\\/])(?:node_modules|\.git|\.auth|browser-profile|\.video-deps)(?:[\\/]|$)|(?:^|[\\/])(?:\.env(?:\..*)?|relay\.local\.json|telegram\.local\.json|tdx\.local\.json|backend-credentials\.ps1|credentials?\.json)$/i;
const SECRET = /(\b\d{7,12}:[A-Za-z0-9_-]{20,}\b)|(Bearer\s+[A-Za-z0-9._-]+)|(password|passwd|token|secret|api[_-]?key)(\s*[=:]\s*)([^\s,;]+)/gi;
const MAX_READ = 180_000;

export const DEFAULT_MAINTENANCE_PROJECTS = {
  operations: { label:'三平台營運報表', root:'C:\\Users\\User\\Documents\\Codex\\2026-09-18\\new-chat\\outputs\\operations-program', tests:[['npm.cmd',['test']]], task:'ThreePlatformOperations0800' },
  daily_gift: { label:'新手禮包', root:'C:\\Users\\User\\Documents\\Codex\\2026-09-21\\new-chat\\daily_gift', tests:[['node',['--test','src/telegram-notify.test.cjs','job-failure-alert.test.mjs']]] },
  fairy: { label:'小精靈', root:'C:\\Users\\User\\Documents\\ChatGPT\\爆分監控', tests:[['npm.cmd',['test']]] },
  monthly_report: { label:'月報簡報', root:'C:\\Users\\User\\Documents\\ChatGPT\\01-營運數據\\月報簡報', tests:[] },
  back_to_work: { label:'上班提醒', root:'C:\\Users\\User\\Documents\\ChatGPT\\05-定期內容\\上班提醒', tests:[['node',['--test','test/reminder.test.js']]] },
  weekend_picks: { label:'週末推薦', root:'C:\\Users\\User\\Documents\\ChatGPT\\05-定期內容\\週末推薦', tests:[['node',['--test','test/core.test.js']]] },
  song_slots: { label:'爽爆選台', root:'C:\\Users\\User\\Documents\\ChatGPT\\03-機台與風控\\爽爆機台狙擊手', tests:[] },
  qiezi_slots: { label:'茄子選台', root:'C:\\Users\\User\\Documents\\ChatGPT\\03-機台與風控\\茄子機台狙擊手', tests:[['npm.cmd',['test']]] },
  atg_slots: { label:'贏麻選台', root:'C:\\Users\\User\\Documents\\ChatGPT\\營運自動化', tests:[['npm.cmd',['test']]] },
  daily_fortune: { label:'每日運勢', root:'C:\\Users\\User\\Documents\\ChatGPT\\05-定期內容\\daily_fortune', tests:[['node',['--test']]] },
  daily_digest: { label:'八卦新聞', root:'C:\\Users\\User\\Documents\\ChatGPT\\05-定期內容\\daily_digest', tests:[['node',['--test','sources.test.mjs']]] },
  codex_workspace: { label:'Codex 工作區', root:'C:\\Users\\User\\Documents\\Codex', tests:[] },
  chatgpt_workspace: { label:'ChatGPT 工作區', root:'C:\\Users\\User\\Documents\\ChatGPT', tests:[] },
};

export function isLocalMaintenanceRequest(text='') {
  const s=String(text).trim();
  const action=/(排查|診斷|檢查|修正|修復|補跑|重跑|恢復|排程|改程式|改檔|新增.{0,8}(功能|按鈕)|開發.{0,8}功能|幫我弄|直接修好)/i.test(s);
  const target=/(本機|檔案|程式|專案|排程|營運|數據更新|報表|新手禮包|小精靈|監控|服務|按鈕|功能)/i.test(s);
  return action&&target;
}

function redact(value){return String(value??'').replace(SECRET,(m,a,b,c,d)=>a?'[REDACTED]':b?'Bearer [REDACTED]':`${c}${d}[REDACTED]`);}
function projectOf(projects,key){const p=projects[key];if(!p)throw new Error(`未知專案：${key}`);if(!fs.existsSync(p.root))throw new Error(`專案不存在：${p.label}`);return p;}
function resolveSafe(p,relative,{write=false,allowRoot=false}={}){
  const rel=String(relative||'').replaceAll('\\','/');
  if(!rel||path.isAbsolute(rel)||rel.split('/').includes('..'))throw new Error('路徑必須是專案內相對路徑');
  const full=path.resolve(p.root,rel);const base=path.resolve(p.root)+path.sep;
  if(((full!==path.resolve(p.root)||!allowRoot)&&!full.startsWith(base))||BLOCKED.test(full))throw new Error('此路徑不在允許範圍');
  if(write&&!TEXT_EXT.has(path.extname(full).toLowerCase()))throw new Error('不允許修改此檔案類型');
  return full;
}
function walk(dir,root,out,limit=300){if(out.length>=limit)return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,e.name);if(BLOCKED.test(full)||e.isDirectory()&&/^(backup|logs|state)$/i.test(e.name))continue;if(e.isDirectory())walk(full,root,out,limit);else out.push(path.relative(root,full).replaceAll('\\','/'));if(out.length>=limit)return;}}
function run(exe,args,cwd,timeoutMs=180000){return new Promise(resolve=>{let command=exe,commandArgs=args;if(process.platform==='win32'&&/^npm\.cmd$/i.test(exe)){command=process.execPath;commandArgs=[path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),...args];}const child=spawn(command,commandArgs,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';const add=b=>{output+=b.toString();if(output.length>120000)output=output.slice(-120000);};child.stdout.on('data',add);child.stderr.on('data',add);const timer=setTimeout(()=>{child.kill();resolve({ok:false,code:null,output:'逾時\n'+output});},timeoutMs);child.on('error',e=>{clearTimeout(timer);resolve({ok:false,code:null,output:e.message});});child.on('close',code=>{clearTimeout(timer);resolve({ok:code===0,code,output:redact(output)});});});}
function repairJsonStrings(value){let out='',quoted=false,escape=false;for(let i=0;i<value.length;i++){const ch=value[i];if(!quoted){out+=ch;if(ch==='"')quoted=true;continue;}if(escape){if(/["\\/bfnrtu]/.test(ch))out+=`\\${ch}`;else out+=`\\\\${ch}`;escape=false;continue;}if(ch==='\\'){escape=true;continue;}if(ch==='"'){quoted=false;out+=ch;continue;}if(ch==='\n'){out+='\\n';continue;}if(ch==='\r'){out+='\\r';continue;}if(ch==='\t'){out+='\\t';continue;}out+=ch;}if(escape)out+='\\\\';return out;}
export function jsonFrom(answer){const text=typeof answer==='string'?answer:String(answer?.text||'');const fenced=/```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];for(const source of [fenced,text]){if(!source)continue;const a=source.indexOf('{'),b=source.lastIndexOf('}');for(const candidate of [source.trim(),a>=0&&b>a?source.slice(a,b+1):'']){if(!candidate)continue;try{return JSON.parse(candidate);}catch{}try{return JSON.parse(repairJsonStrings(candidate));}catch{}}}throw new Error('GPT 未回傳可解析的工具指令');}

function commandSpec(p,call){
  const program=String(call.program||'').toLowerCase();const args=Array.isArray(call.args)?call.args.map(String):[];
  if(args.length>50||args.some(x=>x.length>1000||/[\r\n\0]/.test(x)))throw new Error('程式參數不合法');
  if(program==='npm')return{exe:'npm.cmd',args};
  if(program==='schtasks'){
    if(args.some(x=>/^\/(delete|change|end)$/i.test(x)))throw new Error('不允許刪除、變更或強制終止既有排程');
    if(!args.some(x=>/^\/(query|create|run)$/i.test(x)))throw new Error('schtasks 僅允許 Query、Create、Run');
    return{exe:'schtasks.exe',args};
  }
  if(program==='powershell'){
    const fileAt=args.findIndex(x=>/^-file$/i.test(x));if(fileAt<0||!args[fileAt+1]||args.some(x=>/^-command$|^-encodedcommand$/i.test(x)))throw new Error('PowerShell 僅允許執行工作區內的 -File 腳本');
    const script=resolveSafe(p,args[fileAt+1]);args[fileAt+1]=script;return{exe:'powershell.exe',args};
  }
  if(program==='node'||program==='python'){
    const scriptAt=args.findIndex(x=>!x.startsWith('-'));if(scriptAt<0)throw new Error(`${program} 必須指定工作區內腳本`);
    args[scriptAt]=resolveSafe(p,args[scriptAt]);return{exe:program==='node'?process.execPath:'python.exe',args};
  }
  throw new Error(`不允許執行程式：${program}`);
}

function validateOperatorCommand(command){
  const value=String(command||'').trim();if(!value||value.length>12000||/[\0]/.test(value))throw new Error('操作員命令不合法');
  if(/\b(format|diskpart|bcdedit|cipher\s+\/w)\b/i.test(value)||/Remove-Item[^\r\n]*(?:-Recurse|-r)[^\r\n]*(?:["']?C:\\["']?|\$env:(?:USERPROFILE|SystemRoot))/i.test(value))throw new Error('已阻擋高風險系統破壞命令');
  return value;
}

function toolSummary(call,result){
  const target=call.path?` ${call.path}`:'';
  if(call.tool==='list_files')return`已列出${target||'專案'}檔案（${result.files?.length??0} 個）`;
  if(call.tool==='read_file')return`已讀取 ${call.path}`;
  if(call.tool==='search_text')return`已搜尋「${String(call.query||'').slice(0,24)}」（${result.hits?.length??0} 筆）`;
  if(call.tool==='project_status')return`已取得 ${call.project} 服務與排程狀態`;
  if(call.tool==='replace_text')return`已備份並修改 ${call.path}`;
  if(call.tool==='create_file')return`已建立 ${call.path}`;
  if(call.tool==='write_file')return`已備份並整檔寫入 ${call.path}`;
  if(call.tool==='run_tests')return result.ok?`測試通過 ${call.project}${target}`:`測試失敗 ${call.project}${target}`;
  if(call.tool==='run_program')return`${call.program} 執行${result.ok?'成功':'失敗'}`;
  if(call.tool==='run_shell')return`本機命令執行${result.ok?'成功':'失敗'}`;
  return`${call.tool} ${result.ok?'完成':'失敗'}`;
}

export function createLocalMaintenance({chatFor,projects=DEFAULT_MAINTENANCE_PROJECTS,log,maxSteps=12,state=new BridgeState(),grokBuild=null}={}){
  const projectTails=new Map();
  const activeUsers=new Set();
  function persist(job){state.setJob(job.userId,{id:job.id,userId:job.userId,provider:job.provider,title:job.title,text:job.text,status:job.status,lastDone:job.lastDone,error:job.error,backups:[...job.backups],created:job.created,edited:[...job.edited],tested:[...job.tested],external:job.external||[],records:job.records||[],staged:job.staged||[],...(job.grok?{grok:job.grok}:{}),updatedAt:new Date().toISOString()});}
  const hash=file=>fs.existsSync(file)?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
  function stage(job){
    job.staged=[];
    const files=new Map();for(const [id,bak] of job.backups){const [key,...parts]=id.split(':');files.set(resolveSafe(projectOf(projects,key),parts.join(':')),{key,bak});}
    for(const full of job.created){const key=Object.keys(projects).filter(k=>full.startsWith(path.resolve(projects[k].root)+path.sep)).sort((a,b)=>projects[b].root.length-projects[a].root.length)[0];if(key)files.set(full,{key,bak:null});}
    for(const [full,{key,bak}] of files){if(!fs.existsSync(full))continue;const rel=path.relative(projects[key].root,full),saved=path.join(projects[key].root,'backup','gpt-maintenance',job.id,'staged',rel);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(full,saved);job.staged.push({full,saved,key,baseline:bak?hash(bak):null});}
    persist(job);
  }
  function restoreStaged(job,old){
    for(const item of old.staged||[]){const p=projectOf(projects,item.key);resolveSafe(p,path.relative(p.root,item.full),{write:true});resolveSafe(p,path.relative(p.root,item.saved));if(hash(item.full)!==item.baseline)throw new Error('原檔已被其他人修改，保留現況，未套用舊草稿：'+item.full);}
    job.backups=new Map(old.backups||[]);job.created=[...(old.created||[])];job.edited=new Set(old.edited||[]);job.staged=old.staged||[];persist(job);
    for(const item of old.staged||[]){fs.mkdirSync(path.dirname(item.full),{recursive:true});fs.copyFileSync(item.saved,item.full);}
  }
  async function lockProject(job,key){
    job.locked??=new Set();job.releases??=[];
    if(job.locked.has(key))return;let release;const gate=new Promise(r=>{release=r;});const previous=projectTails.get(key)||Promise.resolve();projectTails.set(key,previous.then(()=>gate));await previous;job.locked.add(key);job.releases.push(()=>release());
  }
  async function execute(job,call){
    const p=projectOf(projects,call.project);
    if(call.tool==='run_program'&&String(call.program).toLowerCase()==='schtasks'&&call.args?.some(x=>/^\/create$/i.test(x))){
      const nameAt=call.args.findIndex(x=>/^\/tn$/i.test(x));
      if(nameAt<0||!call.args[nameAt+1])throw new Error('建立排程必須指定 /TN');
      const existing=await run('schtasks.exe',['/Query','/TN',String(call.args[nameAt+1])],p.root,20000);
      if(existing.ok)throw new Error('同名排程已存在，停止建立以免覆蓋原排程');
    }
    if(['run_program','run_shell'].includes(call.tool)&&job.userId!=null){
      const query=call.tool==='run_program'&&String(call.program).toLowerCase()==='schtasks'&&call.args?.some(x=>/^\/query$/i.test(x));
      if(!query){
        if(!call.undoCommand||!call.verifyUndoCommand||!call.verifyCommand)throw new Error('外部命令必須先提供 verifyCommand、undoCommand 與 verifyUndoCommand；純檔案查詢請用 read_file/search_text/project_status。');
        for(const command of [call.verifyCommand,call.undoCommand,call.verifyUndoCommand])validateOperatorCommand(command);
        job.external.push({tool:call.tool,project:call.project,verifyCommand:call.verifyCommand,undoCommand:call.undoCommand,verifyUndoCommand:call.verifyUndoCommand,status:'pending',at:new Date().toISOString()});persist(job);
      }
    }
    if(call.tool==='list_files'){const start=call.path?resolveSafe(p,call.path,{allowRoot:true}):p.root;if(!fs.statSync(start).isDirectory())throw new Error('列檔目標不是資料夾');const files=[];walk(start,p.root,files,500);return{ok:true,project:call.project,files};}
    if(call.tool==='read_file'){const full=resolveSafe(p,call.path);const st=fs.statSync(full);if(st.size>MAX_READ&&!call.tailLines)throw new Error(`檔案過大（${st.size} bytes），可指定 tailLines 讀取末段`);const lines=Math.min(300,Math.max(1,Number(call.tailLines)||100));const raw=fs.readFileSync(full,'utf8');return{ok:true,path:call.path,content:redact(call.tailLines?raw.slice(-MAX_READ).split(/\r?\n/).slice(-lines).join('\n'):raw)};}
    if(call.tool==='search_text'){const q=String(call.query||'');if(!q||q.length>200)throw new Error('搜尋字串不合法');const start=call.path?resolveSafe(p,call.path,{allowRoot:true}):p.root;if(!fs.statSync(start).isDirectory())throw new Error('搜尋目標不是資料夾');const files=[];walk(start,p.root,files,2000);const hits=[];for(const rel of files){if(hits.length>=120)break;const full=resolveSafe(p,rel);if(!TEXT_EXT.has(path.extname(full).toLowerCase())||fs.statSync(full).size>MAX_READ)continue;const lines=fs.readFileSync(full,'utf8').split(/\r?\n/);lines.forEach((line,i)=>{if(hits.length<120&&line.toLowerCase().includes(q.toLowerCase()))hits.push({path:rel,line:i+1,text:redact(line.slice(0,500))});});}return{ok:true,hits};}
    if(call.tool==='project_status'){const recent=[];for(const folder of ['logs','state']){const d=path.join(p.root,folder);if(!fs.existsSync(d))continue;for(const e of fs.readdirSync(d,{withFileTypes:true}).filter(x=>x.isFile())){const full=path.join(d,e.name);recent.push({path:`${folder}/${e.name}`,mtime:fs.statSync(full).mtime.toISOString(),bytes:fs.statSync(full).size});}}recent.sort((a,b)=>b.mtime.localeCompare(a.mtime));let task=null;if(p.task)task=await run('schtasks.exe',['/Query','/TN',p.task,'/V','/FO','LIST'],p.root,20000);return{ok:true,label:p.label,recent:recent.slice(0,30),task};}
    if(call.tool==='replace_text'){
      await lockProject(job,call.project);
      const full=resolveSafe(p,call.path,{write:true}),expected=String(call.expected??''),replacement=String(call.replacement??'');if(!expected||expected.length>120000||replacement.length>160000)throw new Error('修改內容不合法');const old=fs.readFileSync(full,'utf8');const count=old.split(expected).length-1;if(count!==1)throw new Error(`預期文字命中 ${count} 次，必須恰好 1 次`);await backup(job,p,call.project,call.path,full);job.edited.add(call.project);job.tested.delete(call.project);persist(job);fs.writeFileSync(full,old.replace(expected,replacement),'utf8');return{ok:true,path:call.path,backup:job.backups.get(`${call.project}:${call.path}`)};
    }
    if(call.tool==='create_file'){
      await lockProject(job,call.project);
      const full=resolveSafe(p,call.path,{write:true});if(fs.existsSync(full))throw new Error('檔案已存在，請用 replace_text');const content=call.contentBase64?Buffer.from(String(call.contentBase64),'base64').toString('utf8'):String(call.content??'');if(content.length>160000)throw new Error('內容過大');job.created.push(full);job.edited.add(call.project);job.tested.delete(call.project);persist(job);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,content,'utf8');return{ok:true,path:call.path};
    }
    if(call.tool==='write_file'){
      await lockProject(job,call.project);const full=resolveSafe(p,call.path,{write:true}),content=String(call.content??'');if(content.length>160000)throw new Error('內容過大');if(fs.existsSync(full)&&!job.created.includes(full))await backup(job,p,call.project,call.path,full);else if(!job.created.includes(full))job.created.push(full);job.edited.add(call.project);job.tested.delete(call.project);persist(job);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,content,'utf8');return{ok:true,path:call.path,backup:job.backups.get(`${call.project}:${call.path}`)||null};
    }
    if(call.tool==='run_tests'){let commands=p.tests||[],cwd=p.root;if(call.path){const target=resolveSafe(p,call.path,{allowRoot:true}),st=fs.statSync(target);if(st.isFile()){cwd=p.root;commands=[[process.execPath,['--test',target]]];}else{cwd=target;const pkgPath=path.join(cwd,'package.json');if(!fs.existsSync(pkgPath))throw new Error('測試路徑沒有 package.json');const pkg=JSON.parse(fs.readFileSync(pkgPath,'utf8'));if(!pkg.scripts?.test)throw new Error('package.json 沒有 test 指令');commands=[['npm.cmd',['test']]];}}const results=[];for(const [exe,args] of commands)results.push(await run(exe,args,cwd,300000));const ok=results.length>0&&results.every(x=>x.ok);if(ok)job.tested.add(call.project);return{ok,results};}
    if(call.tool==='run_program'){await lockProject(job,call.project);const cwd=call.path?resolveSafe(p,call.path,{allowRoot:true}):p.root;if(!fs.statSync(cwd).isDirectory())throw new Error('執行路徑不是資料夾');const spec=commandSpec(p,call);const result=await run(spec.exe,spec.args,cwd,Math.min(600000,Math.max(1000,Number(call.timeoutMs)||300000)));const verified=await verifyEffect(job,call,p);return{ok:result.ok&&verified.ok,program:call.program,code:result.code,output:result.output,verification:verified.output};}
    if(call.tool==='run_shell'){await lockProject(job,call.project);const cwd=call.path?resolveSafe(p,call.path,{allowRoot:true}):p.root;if(!fs.statSync(cwd).isDirectory())throw new Error('執行路徑不是資料夾');const command=validateOperatorCommand(call.command);const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],cwd,Math.min(900000,Math.max(1000,Number(call.timeoutMs)||300000)));const verified=await verifyEffect(job,call,p);return{ok:result.ok&&verified.ok,code:result.code,output:result.output,verification:verified.output};}
    throw new Error(`不允許的工具：${call.tool}`);
  }
  async function verifyEffect(job,call,p){if(!call.verifyCommand)return{ok:true,output:''};const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',call.verifyCommand],p.root,60000);if(result.ok){job.external.at(-1).status='applied';persist(job);}return result;}
  async function backup(job,p,key,rel,full){const id=`${key}:${rel}`;if(job.backups.has(id))return;const dst=path.join(p.root,'backup','gpt-maintenance',job.id,rel);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(full,dst);job.backups.set(id,dst);}
  async function rollback(job){
    const errors=[];
    for(const effect of [...(job.external||[])].reverse()){
      if(effect.status==='restored')continue;
      try{const root=projectOf(projects,effect.project).root;for(const command of [effect.undoCommand,effect.verifyUndoCommand]){const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',validateOperatorCommand(command)],root,60000);if(!r.ok)throw new Error(r.output||'外部效果還原驗證失敗');}effect.status='restored';}catch(e){errors.push(e.message);}
    }
    for(const [id,bak] of [...job.backups].reverse()){const [key,...parts]=id.split(':');const full=resolveSafe(projectOf(projects,key),parts.join(':').replaceAll('\\','/'),{write:true});fs.copyFileSync(bak,full);if(!fs.readFileSync(full).equals(fs.readFileSync(bak)))throw new Error('還原驗證失敗：'+full);}
    for(const full of [...job.created].reverse()){if(!Object.values(projects).some(p=>full.startsWith(path.resolve(p.root)+path.sep)))throw new Error('還原路徑超出專案');if(fs.existsSync(full))fs.unlinkSync(full);if(fs.existsSync(full))throw new Error('無法移除本次建立檔案：'+full);}
    if(errors.length)throw new Error(errors.join('；'));
  }
  const protocol=`你是群主專用的本機維修、開發與部署代理，可由 GPT 或 GROK 網頁執行。這是外部工具呼叫協定：工具不會顯示在 ChatGPT 工具列，但你只要回傳 status=tool 的 JSON，本機程式就會實際執行並把 LOCAL_TOOL_RESULT 回傳給你；不得因為看不到原生工具而拒絕。只能回傳一個嚴格合法的 JSON 物件，放在單一 json 程式碼區塊中；JSON 字串中的換行與反斜線必須正確跳脫。可用工具：\nlist_files {project,path?}\nread_file {project,path,tailLines?}（大型日誌可讀末尾）\nsearch_text {project,path?,query}\nproject_status {project}\nreplace_text {project,path,expected,replacement}（小範圍精準修改並自動備份）\ncreate_file {project,path,content}\nwrite_file {project,path,content}（整檔建立或覆寫並自動備份；產生或修復完整程式檔時優先使用，不要自行做 Base64）\nrun_tests {project,path?}（path 可為單一測試檔或含 package.json 的資料夾）\nrun_program {project,path?,program,args,timeoutMs?,verifyCommand?,undoCommand?,verifyUndoCommand?}\nrun_shell {project,path?,command,timeoutMs?,verifyCommand,undoCommand,verifyUndoCommand}。查詢既有排程請用 schtasks /Query；會改變外部狀態的命令必須先提供成功讀回、還原與還原後核對的 PowerShell 命令。你可用 run_shell 執行完整的本機 PowerShell 工作流程，包括安裝依賴、建立或查詢排程、啟停服務、呼叫既有腳本及讀回驗證。專案鍵：operations、daily_gift、fairy、monthly_report、back_to_work、weekend_picks、song_slots、qiezi_slots、atg_slots、daily_fortune、daily_digest、codex_workspace、chatgpt_workspace。請先用明確專案鍵選正式目錄；後兩個工作區只用於跨任務找檔與建立新專案。不得主動擷取或回傳帳密與 token；不得破壞系統磁碟。為節省網頁 GPT 額度，每回合應盡量批次請求最多 8 個已能確定的工具動作：{"status":"tool","calls":[{"tool":"read_file",...},{"tool":"read_file",...}],"progress":"給使用者看的短狀態"}。calls 會依序執行，第一個失敗即停止該批；需要先看某項結果才能決定參數的動作必須留到下一回合。仍相容單一工具格式 {"status":"tool","tool":"read_file",...}。不得把同一工具指令重複送出。完成時：{"status":"complete","summary":"繁體中文結果","verified":true}。若有改檔，完成前必須 run_tests 且成功；新服務或排程還必須實際查詢狀態驗證；若無法安全完成則 status=complete、verified=false 並說明。`;
  async function runJob({text,userId,onProgress,provider='gpt',conversationTitle,resume=false}){
    if(activeUsers.has(String(userId)))return{text:'任務仍在執行：'+(state.job(userId)?.lastDone||'等待網頁模型回覆')};
    const old=resume?state.job(userId):null;
    if(grokBuild&&(old?.provider||provider)==='grok')return runGrokBuildJob({text,userId,onProgress,conversationTitle,old});
    const job={id:old?.id||`${new Date().toISOString().replace(/[:.]/g,'-')}-${Math.random().toString(36).slice(2,8)}`,userId,provider:old?.provider||provider,title:conversationTitle||old?.title||`TG-${userId}`,text:old?.text||text,status:'running',lastDone:'尚未執行本機工具',backups:new Map(),created:[],edited:new Set(),tested:new Set(),locked:new Set(),releases:[],external:old?.external||[],records:old?.records||[]};
    if(old?.status==='running'||old?.status==='rollback_failed'){
      const interrupted={...job,backups:new Map(old.backups),created:old.created||[]};await rollback(interrupted);
    }
    for(const item of old?.staged||[]){if(hash(item.full)!==item.baseline)return{text:'⚠️ 原檔在中斷後被修改，保留現況與草稿，未覆寫：'+item.full,incomplete:true};}
    activeUsers.add(String(userId));persist(job);
    const shortId=job.id.slice(-6).toUpperCase();const chat=chatFor(String(userId),job.provider);let prompt=`${protocol}\n\n重要傳輸規則：請把完整 JSON 放進單一 json 程式碼區塊，避免網頁 Markdown 吃掉程式碼中的反引號與星號。只輸出這個區塊。\n任務編號：${job.id}\n使用者要求：${job.text}${old?`\n恢復任務：上次失敗已還原正式檔案；本次已核對原檔後重新套入保存的工作草稿，從現況修正，不要重做或重複建立排程。上次進度：${old.lastDone||''}；錯誤：${old.error||''}。追加要求：${text}`:''}`;let lastDone='尚未執行本機工具',formatFailures=0;
    let previousBatch='',repeatBatches=0;
    try{
      if(old?.staged?.length)restoreStaged(job,old);
      for(let step=1;step<=maxSteps;step++){
        const status=current=>{job.lastDone=lastDone;persist(job);return onProgress?.(`任務 ${shortId}｜${job.provider.toUpperCase()} 回合 ${step}/${maxSteps}\n✅ ${lastDone}\n⏳ ${current}`);};
        await status(step===1?'正在分析需求並規劃第一步':'正在根據上一步結果規劃');
        const answer=await chat.ask(prompt,{onProgress:status,conversationTitle:job.title,toolMode:true});let call;try{call=jsonFrom(answer);formatFailures=0;}catch(error){formatFailures++;if(formatFailures>=2)throw error;lastDone='工具格式錯誤，要求重送一次';await status('正在修復 JSON 格式');prompt='FORMAT_ERROR：本機未執行。用單一 json 程式碼區塊重送完整 JSON，勿用一般 Markdown 文字。';continue;}
        if(call.status==='complete'){
          if(call.verified!==true)throw new Error(call.summary||'模型未完成驗證');
          const missing=[...job.edited].filter(x=>!job.tested.has(x));if(missing.length){prompt=`你尚未成功測試已修改專案：${missing.join(', ')}。請逐一呼叫 run_tests。`;continue;}
          if(job.external.some(x=>x.status!=='applied'&&x.status!=='restored'))throw new Error('外部效果仍未完成讀回驗證');
          job.status='complete';job.lastDone=call.summary||'已完成並驗證';persist(job);return{text:`🛠️ 小精靈本機處理完成\n${job.lastDone}`};
        }
        if(call.status!=='tool')throw new Error('GPT 指令狀態不合法');
        const calls=Array.isArray(call.calls)?call.calls:[call];
        if(!calls.length||calls.length>8)throw new Error('每批工具數量必須為 1 到 8 個');
        if(calls.some(x=>!x||typeof x!=='object'||!x.tool))throw new Error('批次工具格式不合法');
        const batchKey=JSON.stringify(calls);repeatBatches=batchKey===previousBatch?repeatBatches+1:0;previousBatch=batchKey;
        if(repeatBatches>=2){lastDone='偵測到重複工具指令，未再次執行';await status('正在要求 GPT 重新規劃，避免浪費額度');prompt='NO_PROGRESS：完全相同的工具批次已重複，請勿再次執行。請根據既有結果改用不同方法，或以 status=complete 說明無法完成。';continue;}
        await status(call.progress||`正在執行 ${calls.length} 個本機工具`);
        const results=[];
        for(let i=0;i<calls.length;i++){
          const item=calls[i];await status(`正在執行第 ${i+1}/${calls.length} 項：${item.tool}`);
          let result;try{result=await execute(job,item);}catch(error){result={ok:false,error:error.message};}
          results.push({index:i+1,tool:item.tool,result});lastDone=toolSummary(item,result);
          job.records.push({tool:item.tool,project:item.project,path:item.path,ok:result.ok,error:result.error,at:new Date().toISOString()});persist(job);
          if(result.ok===false)break;
        }
        lastDone=results.map(x=>toolSummary(calls[x.index-1],x.result)).join('；');await status(`${lastDone}，準備下一步`);
        prompt=`LOCAL_TOOL_RESULT_BATCH\n${JSON.stringify(results)}\n請根據全部結果回傳下一個批次 JSON；可確定的後續動作請合併在 calls，避免逐項浪費網頁額度。`;
      }
      throw new Error('維修步驟超過安全上限');
    }catch(error){job.error=error.message;try{stage(job);await rollback(job);job.status='failed';}catch(rollbackError){job.status='rollback_failed';job.error+='；'+rollbackError.message;}persist(job);log?.error?.(`local maintenance failed: ${job.id}: ${job.error}`);return{text:`⚠️ 任務 ${shortId} 尚未完成：${job.error}\n${job.status==='failed'?'追蹤的檔案修改已還原並核對，工作草稿另外保留。':'還原未完成，需先核對衝突。'}${job.external.some(x=>x.status!=='restored')?'\n命令的外部效果仍需核對，不能宣稱全部還原。':''}\n任務已保存；傳「繼續」可用相同使用者對話恢復。`,incomplete:true};}finally{activeUsers.delete(String(userId));for(const release of job.releases.reverse())release();}
  }
  async function runGrokBuildJob({text,userId,onProgress,conversationTitle,old}){
    if(old?.status==='rollback_failed')return{text:'⚠️ 上次 GROK 任務還原未完成，請先人工核對：'+(old.error||''),incomplete:true};
    const resumeNote=old?`\n這是續接任務。上次失敗原因：${old.error||''}；上次進度：${old.lastDone||''}。上次嘗試的檔案存放在 ${old.grok?.snapshotDir?path.join(old.grok.snapshotDir,'attempt'):'（無）'}，可參考但不要直接複製未驗證內容。`:'';
    const taskText=old?`${old.text}\n追加要求：${text}`:text;
    const key=old?.grok?.project&&projects[old.grok.project]?old.grok.project:pickGrokProject(taskText,projects);
    const p=projectOf(projects,key);
    const job={id:`${new Date().toISOString().replace(/[:.]/g,'-')}-${Math.random().toString(36).slice(2,8)}`,userId,provider:'grok',title:conversationTitle||`TG-${userId}`,text:taskText,status:'running',lastDone:'尚未執行 GROK Build',backups:new Map(),created:[],edited:new Set(),tested:new Set(),locked:new Set(),releases:[],external:[],records:[],staged:[]};
    const shortId=job.id.slice(-6).toUpperCase();const say=msg=>onProgress?.(`任務 ${shortId}｜GROK Build｜${p.label}\n⏳ ${msg}`);
    const snapshotDir=path.join(p.root,'backup','grok-build',job.id);const promptFile=path.join(os.tmpdir(),`fairy-grok-${job.id}.txt`);
    activeUsers.add(String(userId));
    let diff={created:[],modified:[],deleted:[]};
    try{
      await lockProject(job,key);
      await say('建立專案快照');
      const before=snapshotProject(p.root);writeSnapshot(before,snapshotDir);
      job.grok={project:key,snapshotDir,files:before.size};persist(job);
      fs.writeFileSync(promptFile,`你在 Windows 電腦上的專案「${p.label}」（${p.root}）中工作，透過 Telegram 小精靈接到群主的開發需求。\n需求：${taskText}${resumeNote}\n\n要求：在不影響現有功能的前提下完成；只改這個專案資料夾內的檔案；不要建立、修改或刪除 Windows 排程，不要啟停服務（需要的話在總結中說明，由小精靈另外處理）；完成前執行既有測試。最後用繁體中文簡短總結：做了什麼、改了哪些檔案、如何驗證。`,'utf8');
      await say('GROK Build 正在本機開發（可能需要數分鐘）');
      const started=Date.now();
      const r=await (grokBuild.spawn||spawnGrokBuild)({grokExe:grokBuild.exe,cwd:p.root,timeoutMs:grokBuild.timeoutMs??1_200_000,args:buildGrokArgs({promptFile,cwd:p.root,maxTurns:grokBuild.maxTurns??40,model:grokBuild.model||null,allow:grokBuild.allow,deny:grokBuild.deny,scope:grokBuild.scope!==false,listDirs:grokBuild.listDirs})});
      const result=parseGrokJson(r.out);const seconds=Math.round((Date.now()-started)/1000);
      job.grok={...job.grok,sessionId:result?.sessionId||null,turns:result?.num_turns??null,tokens:result?.usage?.total_tokens??null,stopReason:result?.stopReason||null,exitCode:r.code,seconds};
      diff=diffSnapshot(before,snapshotProject(p.root));
      job.records.push({tool:'grok_build',project:key,ok:r.code===0&&Boolean(result),at:new Date().toISOString()});
      for(const rel of [...diff.modified,...diff.deleted])job.backups.set(`${key}:${rel}`,path.join(snapshotDir,'files',rel));
      for(const rel of diff.created)job.created.push(path.join(p.root,rel));
      if(diff.created.length+diff.modified.length+diff.deleted.length)job.edited.add(key);
      job.lastDone=`GROK Build 執行 ${seconds} 秒，${result?.num_turns??'?'} 回合；新增 ${diff.created.length}、修改 ${diff.modified.length}、刪除 ${diff.deleted.length} 個檔案`;persist(job);
      const outside=(grokBuild.scanOutside||scanOutsideChanges)(p.root,started-(grokBuild.outsideMarginMs??2000));
      if(outside.length){job.grok.outside=outside.slice(0,20);persist(job);log?.error?.(`grok build touched files outside project: ${outside.slice(0,5).join(', ')}`);throw new Error(`GROK 在專案外修改了 ${outside.length} 個檔案（未自動刪除，請人工核對）：${outside.slice(0,5).join('、')}`);}
      if(r.timedOut)throw new Error('GROK Build 逾時');
      if(r.code!==0||!result)throw new Error(`GROK Build 未正常結束（exit ${r.code}）：${redact(String(r.err||r.out).trim().split(/\r?\n/).slice(-3).join(' ')).slice(0,300)}`);
      if(result.stopReason&&result.stopReason!=='end_turn'){const why=result.stopReason==='cancelled'?'某個動作被安全規則擋下，GROK 中止了本次執行':`GROK 未完成（${result.stopReason}）`;throw new Error(`${why}（stopReason=${result.stopReason}，${result.num_turns??'?'} 回合）${result.text?'：'+redact(String(result.text).trim()).slice(0,300):''}`);}
      const summary=redact(String(result.text||'').trim()).slice(0,3000)||'（GROK 未提供總結）';
      if(job.edited.has(key)&&(p.tests||[]).length){
        await say('正在執行專案測試驗證');
        const tests=await execute(job,{tool:'run_tests',project:key});
        job.records.push({tool:'run_tests',project:key,ok:tests.ok,at:new Date().toISOString()});persist(job);
        if(!tests.ok){const tail=(tests.results||[]).map(x=>x.output).join('\n').trim().split(/\r?\n/).slice(-6).join('\n');throw new Error(`變更後測試未通過：${tail.slice(0,600)}${(p.tests||[]).length?'':'（此專案未設定測試）'}`);}
      }
      job.status='complete';job.lastDone=summary;persist(job);
      const files=[...diff.created.map(x=>'＋'+x),...diff.modified.map(x=>'✎'+x),...diff.deleted.map(x=>'－'+x)];
      return{text:`🛠️ 小精靈本機處理完成（GROK Build）\n${summary}\n\n📁 ${p.label}：${files.length?files.slice(0,15).join('、')+(files.length>15?` 等 ${files.length} 個`:''):'無檔案變更'}\n${job.edited.has(key)?((p.tests||[]).length?'✅ 專案測試通過':'⚠️ 此專案未設定自動測試，請人工確認'):'ℹ️ 未修改檔案'}｜${job.grok.seconds} 秒、${job.grok.turns??'?'} 回合\n🗂 快照：${snapshotDir}`};
    }catch(error){
      job.error=error.message;
      try{if(fs.existsSync(path.join(snapshotDir,'manifest.json'))){saveAttempt(p.root,snapshotDir,diff);restoreSnapshot(p.root,snapshotDir);}job.status='failed';}catch(rollbackError){job.status='rollback_failed';job.error+='；'+rollbackError.message;}
      persist(job);log?.error?.(`grok build job failed: ${job.id}: ${job.error}`);
      return{text:`⚠️ 任務 ${shortId}（GROK Build）尚未完成：${job.error}\n${job.status==='failed'?'專案檔案已依快照還原並核對；本次嘗試另存於快照資料夾 attempt。':'還原未完成，需先人工核對：'+snapshotDir}\n任務已保存；傳「繼續」可重新交給 GROK。`,incomplete:true};
    }finally{fs.rmSync(promptFile,{force:true});activeUsers.delete(String(userId));for(const release of job.releases.reverse())release();}
  }
  async function recoverInterrupted(){for(const rec of Object.values(state.data.jobs)){if(rec.status!=='running')continue;if(rec.grok?.snapshotDir){try{restoreSnapshot(projectOf(projects,rec.grok.project).root,rec.grok.snapshotDir);rec.status='failed';rec.error='服務重啟；GROK 修改已依快照還原，可繼續原任務';}catch(error){rec.status='rollback_failed';rec.error=error.message;}rec.updatedAt=new Date().toISOString();state.setJob(rec.userId,rec);continue;}const job={...rec,backups:new Map(rec.backups||[]),created:rec.created||[],edited:new Set(rec.edited||[]),tested:new Set(rec.tested||[])};try{stage(job);await rollback(job);job.status='failed';job.error='服務重啟；追蹤檔案已還原，可繼續原任務';}catch(error){job.status='rollback_failed';job.error=error.message;}persist(job);}}
  return{run:runJob,execute,recoverInterrupted,current:userId=>state.job(userId),isRunning:userId=>activeUsers.has(String(userId))};
}
