import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const xmlEscape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
try {
 if(/^codexsandbox/i.test(process.env.USERNAME??''))throw Error('請由 Windows 使用者雙擊安裝入口。');
 const configPath=path.join(root,'config.json');
 const config=JSON.parse(await fs.readFile(configPath,'utf8'));
 const latest=JSON.parse(await fs.readFile(path.join(root,'logs/latest.json'),'utf8'));
 if(!latest.completed||latest.mode!=='apply')throw Error('必須先完成實際更新與讀回核對。');
 const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 if(zone!=='Asia/Taipei')throw Error('Windows 時區必須為台灣，目前為 '+zone);
 const user=process.env.USERDOMAIN+'\\'+process.env.USERNAME;
 const systemNode='C:\\Program Files\\nodejs\\node.exe';
 await fs.access(systemNode);
 const start=new Date();start.setHours(8,0,0,0);if(start<=new Date())start.setDate(start.getDate()+1);
 const localDate=[start.getFullYear(),String(start.getMonth()+1).padStart(2,'0'),String(start.getDate()).padStart(2,'0')].join('-')+'T08:00:00';
 const xml=`<?xml version="1.0" encoding="UTF-16"?>
 <Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
 <RegistrationInfo><Description>三平台每日營運表，固定程式執行；機台週更另由原流程處理。</Description></RegistrationInfo>
 <Triggers><CalendarTrigger><StartBoundary>${localDate}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
 <Principals><Principal id="Author"><UserId>${xmlEscape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
 <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><WakeToRun>true</WakeToRun><ExecutionTimeLimit>PT2H</ExecutionTimeLimit></Settings>
 <Actions Context="Author"><Exec><Command>${xmlEscape(systemNode)}</Command><Arguments>${xmlEscape('"'+path.join(root,'run.mjs')+'" --apply --scheduled --daily-only')}</Arguments><WorkingDirectory>${xmlEscape(root)}</WorkingDirectory></Exec></Actions></Task>`;
 const xmlPath=path.join(root,'private/daily-task.xml');await fs.mkdir(path.dirname(xmlPath),{recursive:true});await fs.writeFile(xmlPath,'\uFEFF'+xml,'utf16le');
 const task='ThreePlatformOperations0800';
 execFileSync('schtasks.exe',['/Create','/TN',task,'/XML',xmlPath,'/F'],{stdio:'pipe',windowsHide:true});
 const registered=execFileSync('schtasks.exe',['/Query','/TN',task,'/XML'],{encoding:'utf8',windowsHide:true});
 if(!registered.includes('--daily-only')||!registered.includes('08:00:00'))throw Error('排程讀回核對失敗。');
 config.enabled=true;await fs.writeFile(configPath,JSON.stringify(config,null,2));
 await fs.writeFile(path.join(root,'logs/schedule-install.json'),JSON.stringify({installed:true,time:new Date().toISOString(),task,user,start:localDate,timezone:zone,dailyOnly:true},null,2));
 console.log('排程已建立並讀回核對。下次執行：'+localDate+' 台灣時間。請保持 Windows 登入及專用 Chrome 開啟，並通知 Codex 核對安裝結果。');
}catch(e){console.error('安裝未完成：'+e.message);process.exitCode=1;}
