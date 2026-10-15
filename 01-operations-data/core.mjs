export function iso(d){return d.toISOString().slice(0,10);}
export function dates(now=new Date()){
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const t=new Date(today+'T00:00:00Z'),y=new Date(t-86400000),month=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth(),1));
 const previous=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()-1,1));
 const monday=new Date(t-((t.getUTCDay()+6)%7)*86400000);
 const previousMonthKey=iso(previous).slice(0,7),day=t.getUTCDate();
 return {today,month:iso(month),monthKey:today.slice(0,7),previousMonthKey,rollover:day===1,compact:day===2,from:iso(previous),to:iso(y),days:day-1,monday:t.getUTCDay()===1,weekStart:iso(new Date(monday-7*86400000)),weekEnd:iso(new Date(monday-86400000))};
}
export function numeric(v){if(typeof v==='number'){if(!Number.isFinite(v))throw Error('非有限數值');return v;}let s=String(v).trim().replaceAll(',','');if(s==='-'||s==='－')return '-';if(!/^[-+]?\d+(\.\d+)?%?$/.test(s))throw Error('非預期數值: '+s);return Number(s.replace('%',''))/(s.endsWith('%')?100:1);}
export function equal(a,b){return typeof a==='number'&&typeof b==='number'?Math.abs(a-b)<1e-7:a===b;}
export function col(n){let s='';for(;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
export function index(s){return [...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);}
export function addr(a){const m=/^([A-Z]+)(\d+)$/.exec(a);if(!m)throw Error('不正確儲存格 '+a);return {column:index(m[1]),row:Number(m[2])};}
export function dateRange(from,to){let a=[];for(let d=new Date(from+'T00:00Z');iso(d)<=to;d=new Date(+d+86400000))a.push(iso(d));return a;}
export function datedRows(rows,from,to,width){const a=rows.filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r[0]));const expected=dateRange(from,to);if(a.length!==expected.length||a.some((r,i)=>r[0]!==expected[i]||r.length!==width))throw Error('日期不完整、重複或欄位數改變；預期 '+expected.length+' 日、'+width+' 欄；實際日期與欄數 '+JSON.stringify(a.map(r=>[r[0],r.length]))+'；表格前 3 列 '+JSON.stringify(rows.slice(0,3).map(r=>r.slice(0,3))));return a.map(r=>[r[0],...r.slice(1).map(numeric)]);}
export function cell(sheet,a){return sheet.cells[a]?.value??null;}
export function dateRows(sheet,column=1){return Object.entries(sheet.cells).filter(([a,c])=>addr(a).column===column&&typeof c.value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(c.value)).map(([a,c])=>({row:addr(a).row,date:c.value})).sort((a,b)=>a.row-b.row);}
export function makePlan(workbook,p,data,d){
 const changes=[],warnings=[];
 function set(sheet,a,value,formulaAllowed=false){const s=workbook[sheet];if(!s)throw Error('缺少分頁 '+sheet);const old=cell(s,a);if(typeof old==='string'&&old.startsWith('=')&&!formulaAllowed)throw Error('拒絕覆蓋公式 '+sheet+'!'+a);if(!equal(old,value))changes.push({sheet,cell:a,before:old,after:value,format:s.cells[a]?.format??null});}
 function upsert(sheet,rows){const s=workbook[sheet];if(!s)throw Error('缺少分頁 '+sheet);
  // Other sections may contain a historical date in column A (e.g. recall date).
  // Only the reporting window's daily rows can determine where the next day goes.
  const existing=dateRows(s).filter(r=>r.date>=d.from&&r.date<=d.to),seen=new Map();for(const r of existing){if(seen.has(r.date))throw Error('日期重複 '+sheet);seen.set(r.date,r.row);}let last=existing.at(-1);if(!last)throw Error('找不到日期欄 '+sheet);
  for(const r of rows){let target=seen.get(r[0]);if(!target){if(r[0]<=last.date||r[0]!==iso(new Date(Date.parse(last.date+'T00:00Z')+86400000)))throw Error('無法安全延伸日期 '+sheet+' '+r[0]);target=last.row+1;for(let c=1;c<=r.length;c++)if(cell(s,col(c)+target)!==null)throw Error('新增列已有資料 '+sheet);set(sheet,'A'+target,r[0]);last={row:target,date:r[0]};seen.set(r[0],target);}for(let c=1;c<r.length;c++)set(sheet,col(c+1)+target,r[c]);}
 }
 upsert('總表',data.daily);upsert(p.name+'儲值',data.daily);upsert(p.name+'留存',data.retention);upsert(p.name+'留存%',data.retentionPct);
 const transition=d.rollover&&data.approvedMonth===d.previousMonthKey;if(data.approvedMonth!==d.monthKey&&!transition){warnings.push('月份尚未核准：月彙總及幣商月資料保留');return{changes,warnings};}
 const summary=workbook['總表'],monthLabel=Number(d.monthKey.slice(-2))+'月';
 function monthRow(column,anchor){const rows=[];for(let r=1;r<=summary.maxRow;r++)if(cell(summary,column+r)===monthLabel)rows.push(r);if(!rows.length)throw Error('找不到月份位置 '+column+' '+monthLabel);rows.sort((a,b)=>Math.abs(a-anchor)-Math.abs(b-anchor));if(rows.length>1&&Math.abs(rows[0]-anchor)===Math.abs(rows[1]-anchor))throw Error('月份位置不唯一 '+column+' '+monthLabel);return rows[0];}
 const revenueRow=monthRow('A',addr(p.monthly.revenue).row),betRow=monthRow('J',addr(p.monthly.bet).row);set('總表','B'+revenueRow,data.revenue);set('總表','K'+betRow,data.bet);
 if(d.days>0){
  const dauRow=monthRow('A',addr(p.monthly.dau).row),labels=[],previousLabels=[];for(let r=1;r<=summary.maxRow;r++){const value=cell(summary,'Q'+r);if(value===monthLabel+'新增會員數')labels.push(r);if(value===Number(d.previousMonthKey.slice(-2))+'月新增會員數')previousLabels.push(r);}
  const previousRow=previousLabels.at(-1)??0,currentLabels=labels.filter(r=>r>previousRow);
  let labelRow=currentLabels[0]??(data.approvedMonth===d.monthKey?addr(p.monthly.members).row-1:null);if(currentLabels.length>1)throw Error('新增會員月份重複 '+monthLabel);
  if(!labelRow){const prior=[];for(let r=1;r<=summary.maxRow;r++)if(/^\d{1,2}月新增會員數$/.test(String(cell(summary,'Q'+r)??'')))prior.push(r);if(!prior.length)throw Error('找不到新增會員月份模板');labelRow=prior.at(-1)+2;for(const c of ['Q','R','S','T'])set('總表',c+labelRow,c==='Q'?monthLabel+'新增會員數':cell(summary,c+prior.at(-1)));}
  const memberCell='Q'+(labelRow+1),averageCell='T'+(labelRow+1);set('總表','B'+dauRow,Math.round(data.daily.filter(r=>r[0]>=d.month).reduce((s,r)=>s+r[1],0)/d.days));set('總表',memberCell,data.members);set('總表',averageCell,'='+memberCell+'/'+d.days,true);
 }
 const coins=workbook['幣商金幣變化'];let activeDate=null;const seen=new Set();for(let row=1;row<=coins.maxRow;row++){const dt=cell(coins,'A'+row);if(dt)activeDate=dt;if(typeof activeDate!=='string'||!activeDate.startsWith(d.monthKey))continue;const name=cell(coins,'B'+row),m=data.merchants.find(x=>x.name===name);if(m){if(seen.has(name))throw Error('本月幣商重複');seen.add(name);set('幣商金幣變化','C'+row,Math.round(m.balance));}}if(seen.size!==p.merchants.length)throw Error('找不到本月完整幣商名單');
 return {changes,warnings};
}
export function revenuePlan(w,p,data,d){const changes=[];function set(sheet,a,value){const old=cell(w[sheet],a);if(typeof old==='string'&&old.startsWith('='))throw Error('拒絕覆蓋營收公式');if(!equal(old,value))changes.push({sheet,cell:a,before:old,after:value});}
 if(data.approvedMonth!==d.monthKey&&!(d.rollover&&data.approvedMonth===d.previousMonthKey))throw Error('營收月份未核准');
 // Column B also holds the monthly share block (e.g. B75 =C39/J39), so only the primary revenue row, whose J is =SUM(C<row>:I<row>), counts.
 const rs=dateRows(w['全平台營收'],2).filter(r=>r.date.startsWith(d.monthKey)&&cell(w['全平台營收'],'J'+r.row)===`=SUM(C${r.row}:I${r.row})`);if(rs.length!==1)throw Error('營收年月不唯一');set('全平台營收',p.revenueColumn+rs[0].row,data.revenue);
 const s=w['幣商金幣統計'],starts=[];for(let row=1;row<=s.maxRow;row++){const dt=cell(s,p.coinDateColumn+row);if(typeof dt==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(dt)&&dt.startsWith(d.monthKey))starts.push(row);}
 if(!starts.length)throw Error('營收表找不到本月正式幣商區塊');const start=starts.at(-1),seen=new Set();for(let i=0;i<p.merchants.length;i++){const row=start+i,name=cell(s,p.coinNameColumn+row),m=data.merchants.find(x=>x.name===name);if(!m||seen.has(name))throw Error('營收表本月幣商名稱或順序不符 '+p.coinNameColumn+row);seen.add(name);set('幣商金幣統計',p.coinValueColumn+row,m.balance);}if(seen.size!==p.merchants.length)throw Error('營收表幣商缺漏');return changes;
}
