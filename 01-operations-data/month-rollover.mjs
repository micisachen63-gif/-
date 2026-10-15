import {addr,cell,col,dateRows,equal,index} from './core.mjs';

export function mergeChanges(before,...groups){
 const merged=new Map();
 for(const group of groups)for(const c of group){const key=c.sheet+'!'+c.cell,old=merged.get(key);merged.set(key,{...c,before:old?old.before:cell(before[c.sheet],c.cell)});}
 return [...merged.values()].filter(c=>!equal(c.before,c.after));
}

export function compactDailyPlan(workbook,p,d){
 if(Number(d.today.slice(-2))!==2)return{changes:[],workbook};
 const clone=structuredClone(workbook),changes=[];
 for(const [sheet,width]of [['總表',10]]){
  const s=clone[sheet];if(!s)throw Error('缺少分頁 '+sheet);
  const sequences=[];for(let header=1;header<=s.maxRow;header++)if(cell(s,'A'+header)==='日期'){const seq=[];for(let r=header+1;r<=s.maxRow;r++){const value=cell(s,'A'+r);if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))break;seq.push({row:r,date:value});}if(seq.length)sequences.push(seq);}const candidates=sequences.filter(seq=>seq.some(x=>x.date.startsWith(d.previousMonthKey)));if(candidates.length!==1)throw Error('跨月裁切無法辨識唯一每日區塊 '+sheet);const rows=candidates[0],keep=rows.filter(x=>x.date.startsWith(d.previousMonthKey));
  if(!keep.length)throw Error('跨月裁切找不到上月資料 '+sheet);
  const start=rows[0].row,end=rows.at(-1).row,final=new Map();
  for(let i=0;i<keep.length;i++)for(let c=1;c<=width;c++)final.set(col(c)+(start+i),cell(s,col(c)+keep[i].row));
  for(let r=start;r<=end;r++)for(let c=1;c<=width;c++){
   const a=col(c)+r,after=final.has(a)?final.get(a):null,before=cell(workbook[sheet],a);
   if(!equal(before,after))changes.push({sheet,cell:a,before,after});
   if(after===null)delete s.cells[a];else s.cells[a]={...(s.cells[a]??{}),value:after};
  }
 }
 return{changes,workbook:clone};
}

function monthRows(sheet,column){return dateRows(sheet,index(column));}

export function revenueMonthStructure(workbook,d){
 const s=workbook['全平台營收'];if(!s)throw Error('營收總表缺少全平台營收');
 const primary=x=>{const f=cell(s,'J'+x.row);return typeof f==='string'&&/^=SUM\(C\d+:I\d+\)$/.test(f);},current=monthRows(s,'B').filter(x=>x.date.startsWith(d.monthKey)&&primary(x));
 if(current.length>1)throw Error('營收總表新月份重複');
 if(current.length===1){const r=current[0].row,j=cell(s,'J'+r),l=cell(s,'L'+r);if(j!==`=SUM(C${r}:I${r})`||typeof l!=='string'||!l.includes(String(r)))throw Error('營收總表新月份基本公式不完整');for(let n=index('M');n<=index('S');n++){const c=col(n),prior=cell(s,c+(r-1)),now=cell(s,c+r);if(typeof prior==='string'&&prior.startsWith('=')&&(typeof now!=='string'||!now.startsWith('=')||now===prior))throw Error('營收總表新月份幣商公式不完整 '+c+r);}return null;}
 const rows=monthRows(s,'B').filter(primary),previous=rows.filter(x=>x.date.startsWith(d.previousMonthKey));
 if(previous.length!==1)throw Error('營收總表找不到唯一上月模板');
 const latest=previous[0],target=latest.row+1;if(cell(s,'B'+target)!==null)throw Error('營收總表新月份目標列已有資料');const formulaOverrides=[];
 for(let n=index('M');n<=index('S');n++){const column=col(n),older=cell(s,column+(latest.row-1)),last=cell(s,column+latest.row);if(typeof last!=='string'||!last.startsWith('='))continue;if(typeof older!=='string'||!older.startsWith('='))throw Error('營收總表無法推算新月份公式 '+column);const refs=f=>[...f.matchAll(/([A-Z]+)(\d+)/g)].map(m=>({all:m[0],column:m[1],row:Number(m[2])})),a=refs(older),b=refs(last);if(a.length!==b.length||a.some((x,i)=>x.column!==b[i].column)||older.replace(/\d+/g,'#')!==last.replace(/\d+/g,'#'))throw Error('營收總表月份公式規律不一致 '+column);let i=0;const next=last.replace(/([A-Z]+)(\d+)/g,()=>b[i].column+(b[i].row+(b[i].row-a[i++].row)));formulaOverrides.push({cell:column+target,formula:next});}
 return{sheet:'全平台營收',sourceRow:latest.row,targetRow:target,month:d.monthKey+'-01',copyFrom:'B'+latest.row+':S'+latest.row,copyTo:'B'+target+':S'+target,clear:'C'+target+':I'+target,formulaOverrides};
}

function coinChanges(workbook,p,merchants,monthKey,revenue){
 const sheet=revenue?'幣商金幣統計':'幣商金幣變化',s=workbook[sheet];if(!s)throw Error('缺少分頁 '+sheet);
 const dc=revenue?p.coinDateColumn:'A',nc=revenue?p.coinNameColumn:'B',vc=revenue?p.coinValueColumn:'C';let active=null;const found=new Set(),changes=[];
 for(let r=1;r<=s.maxRow;r++){
  const dt=cell(s,dc+r);if(dt)active=dt;
  if(typeof active!=='string'||!active.startsWith(monthKey))continue;
  const name=cell(s,nc+r),m=merchants.find(x=>x.name===name);if(!m)continue;
  if(found.has(name))throw Error(sheet+' 月底幣商重複 '+name);found.add(name);
  const after=revenue?m.balance:Math.round(m.balance),before=cell(s,vc+r);if(!equal(before,after))changes.push({sheet,cell:vc+r,before,after});
 }
 if(found.size!==p.merchants.length)throw Error(sheet+' 找不到完整月底幣商名單');
 return changes;
}

export function closingMerchantPlans(weekly,revenue,p,monthClose,d){
 if(!monthClose)return{weekly:[],revenue:[]};
 return{weekly:coinChanges(weekly,p,monthClose.merchants,d.previousMonthKey,false),revenue:coinChanges(revenue,p,monthClose.merchants,d.previousMonthKey,true)};
}
export function weeklyClosingMerchantPlan(weekly,p,monthClose,d){return monthClose?coinChanges(weekly,p,monthClose.merchants,d.previousMonthKey,false):[];}
export function revenueClosingMerchantPlan(revenue,p,monthClose,d){return monthClose?coinChanges(revenue,p,monthClose.merchants,d.previousMonthKey,true):[];}

export function coinMonthStructure(workbook,p,d,revenue=false){
 const sheet=revenue?'幣商金幣統計':'幣商金幣變化',s=workbook[sheet];if(!s)throw Error('缺少分頁 '+sheet);const dc=revenue?p.coinDateColumn:'A',nc=revenue?p.coinNameColumn:'B',vc=revenue?p.coinValueColumn:'C',starts=[];
 for(let r=1;r<=s.maxRow;r++){const dt=cell(s,dc+r);if(typeof dt==='string'&&/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(dt))starts.push({row:r,date:dt.replaceAll('/','-')});}
 const current=starts.filter(x=>x.date.startsWith(d.monthKey));if(current.length>1)throw Error(sheet+' 新月份區塊重複');if(current.length===1)return null;
 const previous=starts.filter(x=>x.date.startsWith(d.previousMonthKey));if(previous.length!==1)throw Error(sheet+' 找不到唯一上月幣商區塊');const sourceStart=previous[0].row,count=p.merchants.length,targetStart=sourceStart+count;
 for(let i=0;i<count;i++){const expected=p.merchants[i][1],actual=cell(s,nc+(sourceStart+i));if(actual!==expected)throw Error(sheet+' 上月幣商順序不符：預期 '+expected+'，實際 '+actual);const targetName=cell(s,nc+(targetStart+i));if(targetName!==null&&targetName!==expected)throw Error(sheet+' 新月份目標已有其他資料 '+nc+(targetStart+i));}
 const year=Number(d.monthKey.slice(0,4)),month=Number(d.monthKey.slice(5,7)),last=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10),end=revenue?({win:'AT',song:'AL',qz:'BB'}[p.key]??col(index(vc)+3)):'C';
 return{sheet,dateColumn:dc,nameColumn:nc,valueColumn:vc,sourceStart,targetStart,count,monthEnd:last,copyFrom:dc+sourceStart+':'+end+(sourceStart+count-1),copyTo:dc+targetStart+':'+end+(targetStart+count-1)};
}

function analysisColumn(s){
 for(let r=1;r<=s.maxRow;r++)for(let c=1;c<=s.maxCol-1;c++)if(cell(s,col(c)+r)==='渠道'&&cell(s,col(c+1)+r)==='註冊人數')return c;
 throw Error('找不到會員分析標題');
}

export function memberAnalysisPlan(workbook,p,analysis){
 if(!analysis)return null;const s=workbook['總表'],startCol=analysisColumn(s),endCol=startCol+10,label=Number(analysis.month.slice(5,7))+'月',blocks=[];
 for(let r=1;r<=s.maxRow;r++)if(cell(s,col(startCol)+r)===label&&cell(s,col(startCol)+(r+1))==='新增會員分析')blocks.push(r);
 if(blocks.length>1)throw Error('會員分析月份重複 '+label);
 const all=[];for(let r=1;r<=s.maxRow;r++)if(/^\d{1,2}月$/.test(String(cell(s,col(startCol)+r)??''))&&cell(s,col(startCol)+(r+1))==='新增會員分析'){let total=r+3;while(total<=s.maxRow&&cell(s,col(startCol)+total)!=='加總')total++;if(total<=s.maxRow)all.push({start:r,total});}
 if(!all.length)throw Error('找不到會員分析模板');const template=all.at(-1),target=blocks[0]??template.total+1,oldTotal=blocks.length?(all.find(x=>x.start===blocks[0])?.total??blocks[0]+3):null;
 const order=[];for(let r=template.start+3;r<template.total;r++){const v=cell(s,col(startCol)+r);if(v)order.push(v);}
 const map=new Map(analysis.channels.map(x=>[x.channel,x])),channels=[...order.filter(x=>map.has(x)),...analysis.channels.map(x=>x.channel).filter(x=>!order.includes(x)).sort((a,b)=>a.localeCompare(b,'zh-Hant'))].map(x=>map.get(x));
 const totalRow=target+3+channels.length,totalDeposit=channels.reduce((n,x)=>n+x.deposit,0),a=c=>col(startCol+c),rows=[];
 rows.push([label,...Array(10).fill(null)]);rows.push(['新增會員分析',...Array(6).fill(null),'當月平台結構分析',...Array(3).fill(null)]);rows.push(['渠道','註冊人數','日新增','無效人數','無效率','付費人數','新增付費轉化率','ARPPU','當月渠道儲值人數','當月渠道儲值總額','當月渠道貢獻占比']);
 channels.forEach((x,i)=>{const r=target+3+i;rows.push([x.channel,x.registered,`=${a(1)}${r}/${analysis.days}`,x.invalid,`=${a(3)}${r}/${a(1)}${r}`,x.paid,`=${a(5)}${r}/${a(1)}${r}`,`=${a(9)}${r}/${a(8)}${r}`,x.paid,x.deposit,`=${a(9)}${r}/$${a(9)}$${totalRow}`]);});
 rows.push(['加總',`=SUM(${a(1)}${target+3}:${a(1)}${totalRow-1})`,null,`=SUM(${a(3)}${target+3}:${a(3)}${totalRow-1})`,`=${a(3)}${totalRow}/${a(1)}${totalRow}`,`=SUM(${a(5)}${target+3}:${a(5)}${totalRow-1})`,`=${a(5)}${totalRow}/${a(1)}${totalRow}`,`=${a(9)}${totalRow}/${a(8)}${totalRow}`,`=SUM(${a(8)}${target+3}:${a(8)}${totalRow-1})`,`=SUM(${a(9)}${target+3}:${a(9)}${totalRow-1})`,`=${a(9)}${totalRow}/$${a(9)}$${totalRow}`]);
 if(Math.abs(totalDeposit-channels.reduce((n,x)=>n+x.deposit,0))>.001)throw Error('會員分析儲值加總不符');
 return{sheet:'總表',label,startCol,endCol,target,totalRow,oldTotal,template,rows,insert:!blocks.length};
}
