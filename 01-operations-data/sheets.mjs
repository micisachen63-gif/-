import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runtime,root} from './runtime.mjs';
import {cell,equal,addr,col,index} from './core.mjs';
const exec=promisify(execFile);
export async function openSheet(context,id){const page=await context.newPage();page.setDefaultTimeout(60000);await page.goto('https://docs.google.com/spreadsheets/d/'+id+'/edit',{waitUntil:'domcontentloaded'});await page.locator('#t-name-box').waitFor({state:'visible'});return page;}
export async function saved(page){await page.getByRole('button',{name:/文件狀態：已儲存到雲端硬碟|Document status: Saved to Drive/}).waitFor({state:'visible',timeout:90000});}
export async function snapshot(page,folder,label){
 const f=path.join(folder,label+'.xlsx');
 for(let attempt=0;attempt<2;attempt++){
  try{
   await saved(page);await page.getByRole('menuitem',{name:/^檔案$|^File$/}).click();
   const menu=page.getByRole('menuitem',{name:/^下載|^Download/}),xlsx=page.getByRole('menuitem',{name:/Microsoft Excel.*xlsx/});
   await menu.hover();
   if(!await xlsx.isVisible()){await menu.click();await xlsx.waitFor({state:'visible',timeout:10000});}
   const [download]=await Promise.all([page.waitForEvent('download',{timeout:90000}),xlsx.click({timeout:15000})]);await download.saveAs(f);
   await exec(path.join(runtime,'python/python.exe'),[path.join(root,'snapshot.py'),f,f+'.json'],{windowsHide:true,maxBuffer:1024*1024});
   return JSON.parse(await fs.readFile(f+'.json','utf8'));
  }catch(error){
   if(attempt||!/download\.saveAs: canceled/i.test(error.message))throw error;
   await page.reload({waitUntil:'domcontentloaded'});await page.locator('#t-name-box').waitFor({state:'visible'});
  }
 }
}
export function selectionMatches(requested,actual){const wanted=String(requested).toUpperCase(),shown=String(actual).toUpperCase();if(shown===wanted)return true;const single=/^([A-Z]+)(\d+)$/.exec(wanted),merged=/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(shown);return !!(single&&merged&&merged[1]===single[1]&&merged[2]===single[2]&&Number(merged[4])>=Number(single[2])&&index(merged[3])>=index(single[1]));}
export async function select(page,range){const box=page.locator('#t-name-box');let actual='';for(let attempt=0;attempt<3;attempt++){await box.fill(range);await box.press('Enter');for(let check=0;check<3;check++){await page.waitForTimeout(check===0?250:400);actual=await box.inputValue();if(selectionMatches(range,actual))return;}}throw Error('選區不符 '+range+'；實際 '+actual);}
async function tab(page,name){const button=page.getByRole('button',{name,exact:true});await button.click();await page.waitForFunction(element=>element.classList.contains('docs-sheet-active-tab'),await button.elementHandle(),{timeout:10000});await page.getByRole('button',{name:/^格式化為百分比$|^Format as percent$/}).waitFor({state:'visible'});await page.waitForTimeout(1000);}
async function paste(page,text,formula=false){await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:'https://docs.google.com'});await page.evaluate(text=>navigator.clipboard.writeText(text),text);await page.keyboard.press(formula?'Control+v':'Control+Shift+v');await page.waitForTimeout(600);await page.keyboard.press('Escape');}
function tsv(v){if(typeof v==='string'&&/[\t\r\n]/.test(v))throw Error('儲存格包含不允許的分隔符');return String(v??'');}
function display(c){const a=addr(c.cell);const pct=(c.sheet.endsWith('留存%')&&a.column>=2&&a.column<=16)||((c.sheet==='總表'||c.sheet.endsWith('儲值'))&&a.column===6);return typeof c.after==='number'&&pct?String(Math.round(c.after*1e10)/1e8)+'%':tsv(c.after);}
export async function applyChanges(page,before,changes,folder,label){const grouped=new Map();for(const c of changes){if(!equal(cell(before[c.sheet],c.cell),c.before))throw Error('寫入前值已改變');if(!grouped.has(c.sheet))grouped.set(c.sheet,[]);grouped.get(c.sheet).push(c);}
 for(const [sheet,cs]of grouped){await tab(page,sheet);
  for(const c of cs.filter(c=>/^A\d+$/.test(c.cell)&&c.before===null&&/^\d{4}-\d{2}-\d{2}$/.test(c.after))){const r=addr(c.cell).row,width=sheet.endsWith('留存')||sheet.endsWith('留存%')?'P':'J';await ensureRow(page,r);await select(page,'A'+(r-1)+':'+width+(r-1));await page.keyboard.press('Control+c');await select(page,'A'+r+':'+width+r);await page.keyboard.press('Control+v');await saved(page);}
  cs.sort((a,b)=>addr(a.cell).row-addr(b.cell).row||addr(a.cell).column-addr(b.cell).column);for(let i=0;i<cs.length;){const first=cs[i],a=addr(first.cell);let batch=[first];while(i+batch.length<cs.length){const next=cs[i+batch.length],b=addr(next.cell);if(b.row!==a.row||b.column!==a.column+batch.length||String(next.after).startsWith('=')||String(first.after).startsWith('=')||(next.after===null)!==(first.after===null))break;batch.push(next);}const last=batch.at(-1).cell;await select(page,batch.length===1?first.cell:first.cell+':'+last);if(first.after===null)await page.keyboard.press('Backspace');else await paste(page,batch.map(display).join('\t'),String(first.after).startsWith('='));i+=batch.length;}await saved(page);}
 const after=await snapshot(page,folder,label);for(const c of changes)if(!equal(cell(after[c.sheet],c.cell),c.after))throw Error('寫入後比對失敗 '+c.sheet+'!'+c.cell);
 const allowed=new Set(changes.map(c=>c.sheet+'!'+c.cell));for(const [name,s]of Object.entries(before)){for(const [a,c]of Object.entries(s.cells)){if(!allowed.has(name+'!'+a)&&!equal(c.value,cell(after[name],a)))throw Error('非預期變動 '+name+'!'+a);}}
 return after;
}
export async function weeklyPlan(w,p,data,d){if(!data.weekly)return null;if(d.weekStart.slice(0,4)!==data.approvedMonth.slice(0,4)||d.weekEnd.slice(0,4)!==data.approvedMonth.slice(0,4))throw Error('週報跨年須先核對年份');const s=w[p.name+'遊戲數據排行'];if(!s)throw Error('缺少機台週報');const label=d.weekStart.slice(5).replace('-','/')+'~'+d.weekEnd.slice(5).replace('-','/');const norm=v=>String(v).replace(/\b0(\d)/g,'$1');const existing=[];for(let c=1;c<=s.maxCol;c+=12)if(norm(cell(s,col(c)+'1'))===norm(label))existing.push(c);if(existing.length>1)throw Error('週區間重複，跨年需人工確認');if(!existing.length&&(!cell(s,'A1')||norm(cell(s,'A1'))===norm(cell(s,'M1'))))throw Error('疑似上次插欄未完成，先核對空白或重複週標籤');return{sheet:p.name+'遊戲數據排行',label,column:existing[0]??1,insert:existing.length===0,rows:data.weekly};}
export async function ensureRow(page,row,knownLastRow=null){
 if(!Number.isSafeInteger(row)||row<1)throw Error('新增列目標無效');
 const box=page.locator('#t-name-box'),dialog=page.getByRole('alertdialog',{name:/無效的範圍|Invalid range/});
 async function exists(r){let actual;for(let attempt=0;attempt<3;attempt++){await box.fill('A'+r);await box.press('Enter');await page.waitForTimeout(1500);if(await dialog.isVisible()){await dialog.getByRole('button',{name:/^確定$|^OK$/}).click();return false;}actual=(await box.inputValue()).toUpperCase();if(actual==='A'+r)return true;const merged=/^A(\d+):[A-Z]+(\d+)$/.exec(actual);if(merged&&Number(merged[1])<=r&&r<=Number(merged[2]))return true;}throw Error('列位置核對失敗：預期 A'+r+'，實際 '+actual);}
 if(await exists(row))return;
 // Selecting the final physical row exposes the bottom add-rows controls.
 // Weekly imports may need several rows, so first locate the actual boundary.
 let last=knownLastRow??row-1;
 if(knownLastRow!==null){
  if(!Number.isSafeInteger(last)||last<1||last>=row||!await exists(last)||await exists(last+1))throw Error('工作表實際末列與快照不符，停止新增列');
 }else if(last<1||!await exists(last)){let low=1,high=row-1;while(low<high){const mid=Math.ceil((low+high)/2);if(await exists(mid))low=mid;else high=mid-1;}last=low;}
 // A large workbook can finish switching tabs after the first name-box probe.
 // Recheck before opening the add-rows control, to avoid an unnecessary insert.
 if(await exists(row))return;
 await select(page,last+':'+last);
 const count=page.getByRole('textbox',{name:/要新增的列數|Number of rows to add/});
 if(!await count.waitFor({state:'visible',timeout:7000}).then(()=>true,()=>false)){
  if(await exists(row))return;
  const needed=row-last;
  if(needed>last)throw Error(`新增列控制未顯示，且無法從現有 ${last} 列安全選出 ${needed} 列`);
  await select(page,(last-needed+1)+':'+last);
  await page.getByRole('menuitem',{name:/^插入$|^Insert$/}).click();
  await page.getByRole('menuitem',{name:/^列(?:\s|$)|^Rows?(?:\s|$)/}).hover();
  const insertBelow=page.getByRole('menuitem',{name:new RegExp(`向下插入\\s*${needed}\\s*列|Insert\\s*${needed}\\s*rows?\\s*below`,'i')});
  await insertBelow.waitFor({state:'visible',timeout:7000});
  await insertBelow.click();await saved(page);
  if(!await exists(row))throw Error('透過插入選單新增列後，目標仍不存在');
  return;
 }
 await count.fill(String(row-last));await page.getByRole('button',{name:/^新增$|^Add$/}).click();await saved(page);
 if(!await exists(row))throw Error('新增列後目標仍不存在');
}

export function shiftedHistoryFormula(formula,offset){
 if(!offset)return formula;
 if(/[!"']/.test(formula.replaceAll('#REF!','')))throw Error('歷史公式含跨表或文字參照，插欄前須人工核對');
 return formula.replace(/(\$?)([A-Z]+):(\$?)([A-Z]+)/g,(_,a,c,b,e)=>a+col(index(c)+offset)+':'+b+col(index(e)+offset)).replace(/(\$?)([A-Z]+)(\$?)(\d+)/g,(_,absolute,c,absoluteRow,row)=>absolute+col(index(c)+offset)+absoluteRow+row);
}
export function isInsertColumnsLeftLabel(value,count=12){
 const text=String(value??'').replace(/\s+/g,' ').trim();
 const n=String(count),hasCount=new RegExp(`(?:^|\\D)${n}(?:\\D|$)`).test(text);
 return hasCount&&(/(?:向左|左側).*插入.*欄|插入.*(?:向左|左側).*欄/.test(text)||/insert.*columns?.*left/i.test(text));
}
async function insertColumnsLeft(page,count=12){
 const seen=new Set();
 async function findAndClick(){
  const items=page.getByRole('menuitem');
  for(let i=0;i<await items.count();i++){const item=items.nth(i);if(!await item.isVisible().catch(()=>false))continue;const text=((await item.innerText().catch(()=>''))||(await item.getAttribute('aria-label').catch(()=>''))||'').replace(/\s+/g,' ').trim();if(text)seen.add(text);if(isInsertColumnsLeftLabel(text,count)){await item.click();return true;}}
  return false;
 }
 async function inspectInsertMenu(){
  if(await findAndClick())return true;
  const columns=page.getByRole('menuitem',{name:/^欄(?:位)?(?:\s|$)|^Columns?(?:\s|$)/i}).first();
  if(await columns.isVisible().catch(()=>false)){await columns.hover();await page.waitForTimeout(500);if(await findAndClick())return true;}
  return false;
 }
 await page.getByRole('menuitem',{name:/^插入$|^Insert$/}).click();
 if(await inspectInsertMenu())return;
 await page.keyboard.press('Escape');
 // The selected column range also exposes the command in its context menu.
 // This avoids depending on whether Google puts Columns in a submenu.
 await page.keyboard.press('Shift+F10');await page.waitForTimeout(500);
 if(await findAndClick())return;
 await page.keyboard.press('Escape');
 throw Error(`找不到向左插入 ${count} 欄；目前選單：${[...seen].join('｜')||'（無可見項目）'}`);
}
export async function applyWeekly(page,before,plan,folder,label){
 if(plan.insert)for(const v of Object.values(before[plan.sheet].cells))if(typeof v.value==='string'&&v.value.startsWith('='))shiftedHistoryFormula(v.value,12);
 await tab(page,plan.sheet);let c=plan.column;
 if(plan.insert){await select(page,'A:L');await insertColumnsLeft(page,12);await saved(page);await select(page,'M1:X2');await page.keyboard.press('Control+c');await select(page,'A1:L2');await page.keyboard.press('Control+v');await saved(page);}
 const oldSheet=before[plan.sheet];let oldEnd=2;for(let r=3;r<=oldSheet.maxRow;r++){if(cell(oldSheet,col(c)+r)!==null)oldEnd=r;}
 const end=plan.rows.length+2;await ensureRow(page,end);
 // Copy safe cell formatting only; data rows contain literal source values.
 const exemplar=plan.insert?13:c;await select(page,col(exemplar)+'3:'+col(exemplar+10)+'3');await page.keyboard.press('Control+c');await select(page,col(c)+'3:'+col(c+10)+end);await page.keyboard.press('Control+Alt+v');await page.waitForTimeout(400);
 await select(page,col(c)+'1');await paste(page,plan.label);
 await select(page,col(c)+'3:'+col(c+10)+end);await paste(page,plan.rows.map(r=>r.map(tsv).join('\t')).join('\n'));
 if(!plan.insert&&oldEnd>end){await select(page,col(c)+(end+1)+':'+col(c+10)+oldEnd);await page.keyboard.press('Backspace');}
 const formulas=[[col(c+2)+'1','=SUM('+col(c+4)+'3:'+col(c+4)+end+')'],[col(c+4)+'1','='+col(c+2)+'1/'+col(c+14)+'1-1'],[col(c+6)+'1','=1-SUM('+col(c+7)+'3:'+col(c+7)+end+')/'+col(c+2)+'1']];
 for(const [a,f]of formulas){await select(page,a);await paste(page,f,true);await saved(page);}
 await select(page,col(c+4)+'1');await page.getByRole('button',{name:/^格式化為百分比$|^Format as percent$/}).click();await saved(page);
 const after=await snapshot(page,folder,label);const s=after[plan.sheet];for(let r=0;r<plan.rows.length;r++)for(let x=0;x<11;x++){const a=col(c+x)+(r+3),expected=plan.rows[r][x]===''?null:plan.rows[r][x];if(!equal(cell(s,a),expected))throw Error('週更讀回不符 '+a);}
 if(cell(s,col(c)+'1')!==plan.label)throw Error('週更日期讀回不符');
 for(const [a,f]of formulas)if(cell(s,a)!==f)throw Error('週更彙總公式讀回不符 '+a);
 for(const [name,old]of Object.entries(before)){if(name!==plan.sheet){for(const [a,v]of Object.entries(old.cells))if(!equal(v.value,cell(after[name],a)))throw Error('週更影響其他分頁');continue;}for(const [a,v]of Object.entries(old.cells)){const xy=addr(a);if(!plan.insert&&xy.column>=c&&xy.column<c+12)continue;const dst=col(xy.column+(plan.insert?12:0))+xy.row;if(typeof v.value==='string'&&v.value.startsWith('=')){if(cell(s,dst)!==shiftedHistoryFormula(v.value,plan.insert?12:0))throw Error('歷史公式變動 '+a);}else if(!equal(v.value,cell(s,dst)))throw Error('歷史週資料變動 '+a);}}
 return after;
}

export async function applyRevenueMonthStructure(page,before,plan,folder,label){
 if(!plan)return before;await tab(page,plan.sheet);await ensureRow(page,plan.targetRow);await select(page,plan.copyFrom);await page.keyboard.press('Control+c');await select(page,plan.copyTo);await page.keyboard.press('Control+v');await saved(page);
 await select(page,'B'+plan.targetRow);await paste(page,plan.month);await select(page,plan.clear);await page.keyboard.press('Backspace');await saved(page);
 for(const x of plan.formulaOverrides){await select(page,x.cell);await paste(page,x.formula,true);}await saved(page);
 const after=await snapshot(page,folder,label),s=after[plan.sheet];if(cell(s,'B'+plan.targetRow)!==plan.month)throw Error('營收總表新月份日期讀回不符');
 for(const c of ['J','L']){const f=cell(s,c+plan.targetRow);if(typeof f!=='string'||!f.startsWith('=')||!f.includes(String(plan.targetRow)))throw Error('營收總表新月份公式未正確平移 '+c+plan.targetRow);}
 for(const x of plan.formulaOverrides)if(cell(s,x.cell)!==x.formula)throw Error('營收總表幣商引用公式未更新 '+x.cell);
 for(const [name,old]of Object.entries(before))for(const [a,v]of Object.entries(old.cells)){if(name===plan.sheet&&addr(a).row===plan.targetRow)continue;if(!equal(v.value,cell(after[name],a)))throw Error('新增營收月份影響歷史資料 '+name+'!'+a);}
 return after;
}

export async function applyMemberAnalysis(page,before,plan,folder,label){
 if(!plan)return before;await tab(page,plan.sheet);await ensureRow(page,plan.totalRow);const a=col(plan.startCol),z=col(plan.endCol),copy=(from,to)=>select(page,from).then(()=>page.keyboard.press('Control+c')).then(()=>select(page,to)).then(()=>page.keyboard.press('Control+v'));
 if(plan.insert){
  // Some existing reports merge the two title rows through AC, past the AA data grid.
  // Copy the complete merged headers, then write the unmerged data rows separately.
  const mergedEnd=col(Math.max(plan.endCol,index('AC')));
  for(let offset=0;offset<2;offset++)await copy(a+(plan.template.start+offset)+':'+mergedEnd+(plan.template.start+offset),a+(plan.target+offset)+':'+mergedEnd+(plan.target+offset));
  await copy(a+(plan.template.start+2)+':'+z+(plan.template.start+2),a+(plan.target+2)+':'+z+(plan.target+2));
  await copy(a+(plan.template.start+3)+':'+z+(plan.template.start+3),a+(plan.target+3)+':'+z+(plan.totalRow-1));
  await copy(a+plan.template.total+':'+z+plan.template.total,a+plan.totalRow+':'+z+plan.totalRow);
 }
 const titleEnd=col(Math.max(plan.endCol,index('AC')));
 await select(page,a+plan.target+':'+titleEnd+plan.target);await paste(page,tsv(plan.rows[0][0]),true);
 await select(page,a+(plan.target+3)+':'+z+plan.totalRow);await paste(page,plan.rows.slice(3).map(r=>r.map(tsv).join('\t')).join('\n'),true);
 if(plan.oldTotal&&plan.oldTotal>plan.totalRow){await select(page,a+(plan.totalRow+1)+':'+z+plan.oldTotal);await page.keyboard.press('Backspace');}await saved(page);
 const after=await snapshot(page,folder,label),s=after[plan.sheet];for(let r=0;r<plan.rows.length;r++)for(let c=0;c<plan.rows[r].length;c++){const address=col(plan.startCol+c)+(plan.target+r),expected=plan.rows[r][c],actual=cell(s,address);if(expected===null){if(actual!==null)throw Error('會員分析空白讀回不符 '+address);}else if(!equal(actual,expected))throw Error('會員分析讀回不符 '+address+'；預期 '+expected+'；實際 '+actual);}
 for(const [name,old]of Object.entries(before))for(const [address,v]of Object.entries(old.cells)){const x=addr(address),inside=name===plan.sheet&&x.column>=plan.startCol&&x.column<=plan.endCol&&x.row>=plan.target&&x.row<=Math.max(plan.totalRow,plan.oldTotal??0);if(!inside&&!equal(v.value,cell(after[name],address)))throw Error('會員分析影響歷史資料 '+name+'!'+address);}
 return after;
}

export async function applyCoinMonthStructure(page,before,plan,folder,label){
 if(!plan)return before;await tab(page,plan.sheet);await ensureRow(page,plan.targetStart+plan.count-1,before[plan.sheet].maxRow);await select(page,plan.copyFrom);await page.keyboard.press('Control+c');await select(page,plan.copyTo);await page.keyboard.press('Control+v');await saved(page);
 await select(page,plan.dateColumn+plan.targetStart);await paste(page,plan.monthEnd);for(let i=0;i<plan.count;i++){await select(page,plan.valueColumn+(plan.targetStart+i));await page.keyboard.press('Backspace');}await saved(page);
 const after=await snapshot(page,folder,label),s=after[plan.sheet];if(cell(s,plan.dateColumn+plan.targetStart)!==plan.monthEnd)throw Error('幣商新月份日期讀回不符');for(let i=0;i<plan.count;i++){const name=cell(s,plan.nameColumn+(plan.targetStart+i)),expected=cell(before[plan.sheet],plan.nameColumn+(plan.sourceStart+i));if(name!==expected)throw Error('幣商新月份名稱讀回不符');if(cell(s,plan.valueColumn+(plan.targetStart+i))!==null)throw Error('幣商新月份數值未清空');}
 for(const [name,old]of Object.entries(before))for(const [a,v]of Object.entries(old.cells)){const x=addr(a),inside=name===plan.sheet&&x.row>=plan.targetStart&&x.row<plan.targetStart+plan.count;if(!inside&&!equal(v.value,cell(after[name],a)))throw Error('新增幣商月份影響歷史資料 '+name+'!'+a);}
 return after;
}
