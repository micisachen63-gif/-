import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
const root=path.dirname(fileURLToPath(import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function available(){
  try {
    const connection=await chromium.connectOverCDP('http://127.0.0.1:19385',{timeout:5000});
    const ready=connection.contexts().length>0;
    await connection.close();
    return ready;
  } catch { return false; }
}
async function waitAvailable(attempts=8,delay=750){for(let i=0;i<attempts;i++){if(await available())return true;await sleep(delay);}return false;}
function setDedicatedWindowVisibility(visible){
  const helper='C:\\Users\\User\\Documents\\ChatGPT\\營運自動化\\scripts\\dedicated-chrome-window.ps1';
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-Action',visible?'Show':'Hide','-Port','19385'],{encoding:'utf8',windowsHide:true,timeout:15000});
  if(result.error||result.status!==0)console.warn(`專用 Chrome 視窗切換未完成：${(result.stderr||result.error?.message||`exit ${result.status}`).trim()}`);
}
function dedicatedChromeProcesses(profile){
  const escaped=profile.replace(/'/g,"''");
  const script=`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*--user-data-dir=*${escaped}*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { [string]$_.ProcessId + '|' + [string]$_.CommandLine }`;
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000});
  if(r.error||r.status!==0)return[];
  return String(r.stdout||'').split(/\r?\n/).map(line=>{const i=line.indexOf('|');return i>0?{pid:Number(line.slice(0,i)),commandLine:line.slice(i+1)}:null;}).filter(x=>Number.isInteger(x?.pid));
}
async function restartDedicatedChrome(profile,reason){
  const processes=dedicatedChromeProcesses(profile);
  if(!processes.length)return false;
  console.warn(`${reason}；準備自動重啟專用 Chrome（pid ${processes.map(x=>x.pid).join(',')}）。`);
  for(const {pid} of processes){const r=spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{encoding:'utf8',windowsHide:true,timeout:20000});if(r.error||r.status!==0)throw Error(`無法重新啟動專用 Chrome（pid ${pid}）。`);}
  for(let i=0;i<20&&dedicatedChromeProcesses(profile).length;i++)await sleep(500);
  return true;
}
try {
  const config=JSON.parse((await fs.readFile(path.join(root,'config.json'),'utf8')).replace(/^\uFEFF/,''));
  if(config.localControlApproved!==true)throw Error('尚未同意啟用本機連線。');
  if(/^codexsandbox/i.test(process.env.USERNAME??''))throw Error('請從 Windows 桌面雙擊登入入口。');
  const profile=path.resolve(config.browserProfile);
  const forceVisible=process.argv.includes('--visible');
  const background=config.browserBackground==='headless'&&!forceVisible;
  const minimized=(config.browserBackground===true||config.browserBackground==='minimized')&&!forceVisible;
  let healthy=await waitAvailable(2,400);
  if(healthy&&forceVisible&&dedicatedChromeProcesses(profile).some(x=>/--headless(?:=new)?(?:\s|$)/i.test(x.commandLine))){
    await restartDedicatedChrome(profile,'需要顯示人工登入視窗');healthy=false;
  }
  if(healthy&&background&&dedicatedChromeProcesses(profile).some(x=>!/--headless(?:=new)?(?:\s|$)/i.test(x.commandLine))){
    await restartDedicatedChrome(profile,'切換為背景執行模式');healthy=false;
  }
  if(healthy&&minimized&&dedicatedChromeProcesses(profile).some(x=>!/--start-minimized(?:\s|$)/i.test(x.commandLine))){
    await restartDedicatedChrome(profile,'切換為最小化背景模式');healthy=false;
  }
  if(healthy){
    console.log('常駐 Chrome 連線已開啟，請保持視窗開啟，執行桌面測試入口。');
  }else{
    await restartDedicatedChrome(profile,'專用 Chrome 存在但 19385 控制端點失效');
    let chrome;
    for(const dir of [process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA]){
      if(!dir)continue;
      const candidate=path.join(dir,'Google','Chrome','Application','chrome.exe');
      if(await fs.access(candidate).then(()=>true,()=>false)){chrome=candidate;break;}
    }
    if(!chrome)throw Error('找不到 Chrome。');
    const args=['--remote-debugging-address=127.0.0.1','--remote-debugging-port=19385','--user-data-dir='+profile,...(background?['--headless=new','--window-size=1440,1000']:['--new-window',...(minimized?['--start-minimized']:[])]),...config.platforms.map(p=>p.url+'/'),'https://docs.google.com/spreadsheets/d/'+config.revenueId+'/edit'];
    const child=spawn(chrome,args,{detached:true,stdio:'ignore',windowsHide:false});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();
    const ready=await waitAvailable(40,750);
    if(!ready)throw Error('專用 Chrome 已嘗試啟動，但 19385 控制連線仍未就緒。一般 Chrome 不受影響；請查看 Telegram 失敗通知。');
    console.log(background?'背景專用 Chrome 連線已就緒。':minimized?'最小化專用 Chrome 連線已就緒。':'可見專用 Chrome 連線已就緒。請完成三個後台和 Google 登入，保持視窗開啟，再執行桌面測試入口。');
  }
  setDedicatedWindowVisibility(forceVisible);
}catch(e){console.error(e.message);process.exitCode=1;}
