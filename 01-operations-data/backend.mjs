import {numeric,datedRows} from './core.mjs';
import {openRoute} from './login.mjs';
import fs from 'node:fs/promises';
const timeout=60000;
async function table(page){return page.getByRole('table').last().locator('tr').evaluateAll(rs=>rs.map(r=>[...r.querySelectorAll('th,td')].flatMap(c=>[c.textContent.trim(),...Array(Math.max(0,c.colSpan-1)).fill(null)])));}
async function waitForDataRows(page, minimum=1, matches=()=>true){
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){
  const rows=await table(page);
  const data=rows.slice(1).filter(r=>r.some(v=>v!==null&&v!=='')&&r[0]!=='加總');
  if(data.length>=minimum&&matches(data))return;
  if((await page.locator('body').innerText()).includes('Session Unauthorized'))throw Error('後台工作階段已失效');
  await page.waitForTimeout(750);
 }
 // The caller retains its strict validation and reports the actual empty result.
}
async function settle(page){await page.waitForLoadState('networkidle',{timeout}).catch(()=>{});await page.waitForTimeout(1200);}
export async function submit(page){
 const button=page.getByRole('button',{name:'送出',exact:true});
 try{await button.click({timeout:8000});}
 catch(error){
  if(!/outside of the viewport/i.test(error.message))throw error;
  const clicked=await button.evaluate(el=>{
   const style=getComputedStyle(el),rect=el.getBoundingClientRect();
   if(el.disabled||style.display==='none'||style.visibility==='hidden'||rect.width<=0||rect.height<=0)return false;
   el.click();return true;
  });
  if(!clicked)throw error;
 }
 await settle(page);
}
export async function clickTab(page,name){
 const tab=page.getByRole('tab',{name,exact:true});await tab.waitFor({state:'visible',timeout:timeout});
 if(await tab.getAttribute('aria-selected')==='true')return;
 await tab.evaluate(el=>el.scrollIntoView({block:'center',inline:'center'}));
 const box=await tab.boundingBox(),viewport=page.viewportSize();
 if(!box)throw Error('報表分頁無可見區域：'+name);
 const inViewport=!viewport||(box.x+box.width>0&&box.y+box.height>0&&box.x<viewport.width&&box.y<viewport.height);
 if(!inViewport){
  const visible=await tab.evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&!el.disabled&&r.width>0&&r.height>0;});
  if(!visible)throw Error('報表分頁無法顯示或已停用：'+name);
  await tab.evaluate(el=>el.click());
 }else{
  try{await tab.click({timeout:8000});}
  catch(error){
   if(!/outside of the viewport/i.test(error.message))throw error;
   const visible=await tab.evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&!el.disabled&&r.width>0&&r.height>0;});
   if(!visible)throw error;
   await tab.evaluate(el=>el.click());
  }
 }
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){if(await tab.getAttribute('aria-selected')==='true')return;await page.waitForTimeout(100);}
 throw Error('報表分頁點擊後未切換：'+name);
}
export {storedCredentialsReady,credentialsReady} from './login.mjs';
async function go(page,p,route,diag){return openRoute(page,p,route,diag);}
async function exactDates(page,from,to){const fields=page.getByRole('textbox');await fields.nth(0).fill(from);await fields.nth(1).fill(to);await fields.nth(1).press('Tab');const values=await fields.evaluateAll(es=>es.map(e=>e.value));if(!values[0]?.startsWith(from.slice(0,10))||!values[1]?.startsWith(to.slice(0,10)))throw Error('後台未接受日期');}
function sumField(rows,label){const header=rows[0],i=header.indexOf(label),r=rows.find(r=>r[0]==='加總');if(i<0||!r||r[i]===null)throw Error('找不到加總欄 '+label);const n=numeric(r[i]);if(typeof n!=='number')throw Error('加總缺值');return n;}
function headers(rows,wanted){if(JSON.stringify(rows[0])!==JSON.stringify(wanted))throw Error('來源報表欄位已改變');return rows;}
async function waitDatedRows(page,from,to,width,wanted){
 const deadline=Date.now()+45000;let lastError;
 do{
  try{const rows=await table(page);return datedRows(wanted?headers(rows,wanted):rows,from,to,width);}
  catch(error){lastError=error;await page.waitForTimeout(750);}
 }while(Date.now()<deadline);
 throw lastError;
}
async function allSource(page){await page.getByRole('radio',{name:'All',exact:true}).check();if(!await page.getByRole('button',{name:'全部',exact:true}).isVisible())throw Error('來源篩選不是全部');}
function validateGame(rows){const header=['廠商名稱','機台名稱','不重複玩家數','投注筆數','總投注額','有效投注額','總出分','遊戲淨利','RTP','淨利表','活動加贈'];if(JSON.stringify(rows[0])!==JSON.stringify(header))throw Error('遊戲欄位變更');const data=rows.slice(1).filter(r=>r[0]!=='加總');if(!data.length||data.some(r=>r.length!==11))throw Error('遊戲明細空白或欄位錯誤；列數='+data.length+'；欄數分布='+JSON.stringify([...new Set(data.map(r=>r.length))])+'；異常列='+JSON.stringify(data.filter(r=>r.length!==11).slice(0,3)));for(const label of ['總投注額','有效投注額','總出分','遊戲淨利']){const i=header.indexOf(label),s=data.reduce((s,r)=>s+Number(numeric(r[i])),0);if(Math.abs(s-sumField(rows,label))>Math.max(1,data.length*.011))throw Error('遊戲明細與加總不符 '+label);}return data.map(r=>r.map((v,i)=>i<2?v:(i===8||i===9?Number(String(v).replace('%','')):numeric(v))));}
function csv(text){const out=[],row=[];let field='',quoted=false;for(let i=0;i<text.length;i++){const ch=text[i];if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"')quoted=false;else field+=ch;}else if(ch==='"')quoted=true;else if(ch===','){row.push(field);field='';}else if(ch==='\n'){row.push(field.replace(/\r$/,''));out.push(row.splice(0));field='';}else field+=ch;}if(field||row.length){row.push(field);out.push(row);}return out;}
async function monthlyMembers(page,p,d,diag){
 await go(page,p,'/player/list',diag);await page.getByRole('radio',{name:'創辦時間',exact:true}).check();await exactDates(page,d.from+' 00:00:00',d.to+' 23:59:59');await submit(page);
 let total=null,previous=null,stable=0;const deadline=Date.now()+45000;while(Date.now()<deadline){const text=(await page.locator('p').filter({hasText:'Total Rows:'}).innerText()).trim(),n=/^Total Rows:\s*(\d+)$/.exec(text);if(!n)throw Error('會員導出總筆數不明');const count=Number(n[1]),dates=await page.getByRole('table').locator('tr').evaluateAll(rs=>{const h=[...rs[0].querySelectorAll('th,td')].map(c=>c.textContent.trim()),i=h.indexOf('創帳時間');return i<0?[]:rs.slice(1).map(r=>r.querySelectorAll('th,td')[i]?.textContent.trim()).filter(Boolean);}),valid=count>0&&dates.length===Math.min(count,50)&&dates.every(x=>x.slice(0,10)>=d.from&&x.slice(0,10)<=d.to);stable=valid&&previous===count?stable+1:0;previous=count;if(valid&&stable>=2){total=count;break;}await page.waitForTimeout(750);}if(total===null)throw Error('完整月份會員查詢未穩定，停止導出');const button=page.locator('button').filter({has:page.locator('[data-testid=SaveAltIcon]')});
 const [download]=await Promise.all([page.waitForEvent('download',{timeout}),button.click()]);const temp=await download.path();const rows=csv((await fs.readFile(temp,'utf8')).replace(/^\uFEFF/,'')),head=rows.shift();if(rows.length!==total)throw Error('會員導出筆數不符：畫面 '+total+'，檔案 '+rows.length);
 const ix=name=>{const n=head.indexOf(name);if(n<0)throw Error('會員導出缺少欄位 '+name);return n;},source=ix('來源'),deposit=ix('總儲值'),vip=ix('VIP'),coin=ix('金幣'),wash=p.key==='win'?ix('洗碼限制'):-1,groups=new Map();
 for(const r of rows){const channel=r[source].trim()||(p.key==='win'?'無來源(推薦好友)':'無來源'),amount=r[deposit].trim()&&r[deposit].trim()!=='-'?numeric(r[deposit]):0,invalid=p.key==='win'?numeric(r[coin])===20&&numeric(r[wash])===500:String(r[vip]).trim()==='1'&&numeric(r[coin])===1000,g=groups.get(channel)??{channel,registered:0,invalid:0,paid:0,deposit:0};g.registered++;if(invalid)g.invalid++;if(amount>0){g.paid++;g.deposit+=amount;}groups.set(channel,g);}
 return{month:d.previousMonthKey,days:new Date(Date.UTC(Number(d.monthKey.slice(0,4)),Number(d.monthKey.slice(5,7)),0)).getUTCDate(),total,channels:[...groups.values()]};
}
async function closingMerchants(page,p,d){
 const result=[];
 for(const [aid,name] of p.merchants){
  await go(page,p,'/player/log',{});
  await page.locator('input[name=aid]').fill(aid);
  const ds=page.locator('input[type=tel]');
  await ds.nth(0).fill(d.to+' 00:00:00');await ds.nth(1).fill(d.to+' 23:59:59');await ds.nth(1).press('Tab');
  const combos=page.locator('[role=button][aria-haspopup=listbox]');await combos.nth(2).click();await page.getByRole('option',{name:'金幣',exact:true}).click();
  await submit(page);
  // The table can still show the old "Total Rows: 0" while the new request is loading.
  await waitForDataRows(page,1,rows=>rows.some(r=>String(r[0]).startsWith(d.to)));
  const found=[];let previousPage='';
  for(;;){
   const rows=await table(page),signature=JSON.stringify(rows);
   if(signature===previousPage)throw Error(name+' 資源紀錄翻頁未更新');
   previousPage=signature;
   const h=rows[0],ti=h.indexOf('時間'),ri=h.indexOf('資源'),ai=h.indexOf('異動後');
   if(ti<0||ri<0||ai<0)throw Error('玩家資源紀錄欄位改變');
   found.push(...rows.slice(1).filter(r=>r[ri]==='金幣'&&String(r[ti]).startsWith(d.to)).map(r=>({time:r[ti],balance:numeric(r[ai])})));
   const next=page.getByRole('button',{name:'Go to next page'});
   if(await next.isDisabled())break;
   await next.click();
   const deadline=Date.now()+45000;
   while(Date.now()<deadline&&JSON.stringify(await table(page))===previousPage)await page.waitForTimeout(750);
  }
  if(!found.length)throw Error(name+' 在 '+d.to+' 找不到金幣異動紀錄');
  found.sort((a,b)=>a.time.localeCompare(b.time));result.push({aid,name,balance:found.at(-1).balance,time:found.at(-1).time});
 }
 return result;
}
export async function collect(context,p,d,approvedMonth,diag){const page=await context.newPage();page.setDefaultTimeout(timeout);try{
 await go(page,p,'/',diag);const home=await page.getByRole('table').filter({hasText:'首儲總額'}).filter({hasText:'本月'}).locator('tr').evaluateAll(rs=>rs.map(r=>[...r.querySelectorAll('th,td')].map(c=>c.textContent.trim())));const revenue=numeric(home.find(r=>r[0]==='本月')?.[home[0].indexOf('儲值金額')]);
 await go(page,p,'/statements/player-summary',diag);await clickTab(page,'玩家消費');await allSource(page);await exactDates(page,d.from,d.to);await submit(page);const daily=await waitDatedRows(page,d.from,d.to,10,['日期','DAU','DPU','總筆數','總金額','儲值率','ARPU','ARPPU','首儲人數','首儲總額']);
 await go(page,p,'/statements/xlogin',diag);await allSource(page);await exactDates(page,d.from,d.to);await submit(page);const retention=await waitDatedRows(page,d.from,d.to,16,['日期',...[0,1,2,3,4,5,6,7,10,15,20,25,30,45,60].map(n=>n+'日登')]);await page.getByRole('tab',{name:'比例',exact:true}).click();await settle(page);const retentionPct=await waitDatedRows(page,d.from,d.to,16);
 const merchants=[];await go(page,p,'/player/list',diag);for(const [aid,name]of p.merchants){await page.getByRole('radio',{name:'a_id',exact:true}).check();await page.getByRole('textbox').nth(0).fill(aid);await submit(page);await waitForDataRows(page,1,data=>data.length===1&&data[0][0]===aid&&data[0][1]===name);const rs=await page.getByRole('table').locator('tr').evaluateAll(rs=>rs.map(r=>{const c=[...r.querySelectorAll('th,td')];return[c[0]?.textContent.trim(),c[1]?.textContent.trim(),c[5]?.textContent.trim()];}));if(rs.length!==2||rs[1][0]!==aid||rs[1][1]!==name)throw Error('幣商查詢結果不符 '+name+'；預期 AID='+aid+'；讀取列数='+rs.length+'；實際 AID 與名稱='+JSON.stringify(rs.slice(0,4).map(r=>r.slice(0,2))));merchants.push({aid,name,balance:numeric(rs[1][2])});}
 let members=null;if(d.days>0){
  // Discard the merchant query's filters and stale Total Rows before querying.
  await go(page,p,'/player/list',diag);await page.getByRole('radio',{name:'創辦時間',exact:true}).check();await exactDates(page,d.month+' 00:00:00',d.to+' 23:59:59');await submit(page);
  const deadline=Date.now()+45000;let previous=null,stable=0;
  while(Date.now()<deadline){
   const txt=(await page.locator('p').filter({hasText:'Total Rows:'}).innerText()).trim();
   if(!/^Total Rows:\s*\d+$/.test(txt))throw Error('會員總數不明');
   const total=Number(txt.replace(/\D/g,''));
   const rows=await page.getByRole('table').locator('tr').evaluateAll(rs=>{const headers=[...rs[0].querySelectorAll('th,td')].map(c=>c.textContent.trim());const index=headers.indexOf('創帳時間');if(index<0)throw Error('找不到創帳時間欄');return rs.slice(1).map(r=>r.querySelectorAll('th,td')[index]?.textContent.trim()).filter(Boolean);});
   const valid=rows.length===Math.min(total,50)&&rows.every(v=>v.slice(0,10)>=d.month&&v.slice(0,10)<=d.to);
   stable=valid&&previous===total?stable+1:0;previous=total;
   if(valid&&stable>=2){members=total;break;}
   await page.waitForTimeout(750);
  }
  if(members===null)throw Error('新增會員查詢未完成，總數、明細日期或筆數不一致');
 }
 await go(page,p,'/game-statements/statistics',diag);await page.getByRole('button',{name:'本月',exact:true}).click();await submit(page);await waitForDataRows(page);const monthly=await table(page);validateGame(monthly);const bet=sumField(monthly,'有效投注額');let weekly=null;
 if(d.monday){await go(page,p,'/game-statements/statistics',diag);await exactDates(page,d.weekStart+' 00:00:00',d.weekEnd+' 23:59:59');await submit(page);await waitForDataRows(page);weekly=validateGame(await table(page));}
 let monthClose=null;if(d.rollover)monthClose={members:await monthlyMembers(page,p,d,diag),merchants:await closingMerchants(page,p,d)};
 return{revenue,daily,retention,retentionPct,merchants,members,bet,weekly,approvedMonth,monthClose};
 }finally{await page.close();}}

export async function collectWeekly(context,p,d,approvedMonth,diag){
 const page=await context.newPage();page.setDefaultTimeout(timeout);
 try{await go(page,p,'/game-statements/statistics',diag);await exactDates(page,d.weekStart+' 00:00:00',d.weekEnd+' 23:59:59');await submit(page);await waitForDataRows(page);const weekly=validateGame(await table(page));return{weekly,approvedMonth,weekStart:d.weekStart,weekEnd:d.weekEnd};}
 finally{await page.close();}
}
