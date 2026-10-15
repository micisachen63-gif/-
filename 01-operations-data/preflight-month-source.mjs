import fs from 'node:fs/promises';
import path from 'node:path';
import {browser,root} from './runtime.mjs';
import {dates} from './core.mjs';
import {collect} from './backend.mjs';
import {readWithFallback} from './login.mjs';

const config=JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8'));
const d=dates(new Date('2026-10-01T08:00:00+08:00'));
if(!d.rollover||config.approvedMonth!==d.previousMonthKey)throw Error('跨月資料來源設定不符');
const folder=path.join(root,'private','preflight-2026-10-01');
await fs.mkdir(folder,{recursive:true});
const context=await browser();
const checks=[];
try {
  for(const p of config.platforms.filter(p=>!process.argv[2]||p.key===process.argv[2])){
    try {
      const result=await readWithFallback({reader:collect,context,platform:p,params:[d,config.approvedMonth],folder,onLogin:()=>{},connectBackup:null});
      const data=result.data;
      if(data.daily[0]?.[0]!==d.from||data.daily.at(-1)?.[0]!==d.to||data.monthClose?.members?.month!==d.previousMonthKey||data.monthClose?.merchants?.length!==p.merchants.length)throw Error('結算期間或筆數不符：'+JSON.stringify({dailyFirst:data.daily[0]?.[0],expectedFirst:d.from,dailyLast:data.daily.at(-1)?.[0],expectedLast:d.to,analysisMonth:data.monthClose?.members?.month,expectedMonth:d.previousMonthKey,merchants:data.monthClose?.merchants?.length,expectedMerchants:p.merchants.length}));
      checks.push({platform:p.name,ok:true,through:d.to,memberExport:data.monthClose.members.total,channels:data.monthClose.members.channels.length,merchants:data.monthClose.merchants.length,currentRevenueRead:true});
    } catch(error) {checks.push({platform:p.name,ok:false,error:String(error.message).slice(0,280)});}
  }
} finally {await context.close();}
console.log(JSON.stringify({period:d.from+'–'+d.to,checks}));
if(checks.some(x=>!x.ok))process.exitCode=1;
