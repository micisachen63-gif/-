import fs from 'node:fs/promises';
import path from 'node:path';
import {browser,root} from './runtime.mjs';
import {dates} from './core.mjs';
import {openSheet,snapshot} from './sheets.mjs';
import {revenueMonthStructure,coinMonthStructure,memberAnalysisPlan} from './month-rollover.mjs';

const config=JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8'));
const d=dates(new Date('2026-10-01T08:00:00+08:00'));
if(config.approvedMonth!==d.previousMonthKey||!d.rollover)throw Error('跨月設定不符');
const folder=path.join(root,'private','preflight-2026-10-01');
await fs.mkdir(folder,{recursive:true});
const connection=await browser();
const results=[];
try {
  let page=await openSheet(connection,config.revenueId);
  const revenue=await snapshot(page,folder,'revenue-before');
  await page.close();
  for(const p of config.platforms){
    page=await openSheet(connection,p.sheetId);
    const weekly=await snapshot(page,folder,p.key+'-weekly-before');
    await page.close();
    const analysis=memberAnalysisPlan(weekly,p,{month:d.previousMonthKey,days:30,channels:[]});
    results.push({platform:p.name,memberAnalysis:analysis?.insert?'add':'existing',weeklyCoin:coinMonthStructure(weekly,p,d,false)?'add':'existing',revenue:revenueMonthStructure(revenue,d)?'add':'existing',revenueCoin:coinMonthStructure(revenue,p,d,true)?'add':'existing'});
  }
  console.log(JSON.stringify({date:d.today,approvedMonth:config.approvedMonth,results}));
} finally {await connection.close();}
