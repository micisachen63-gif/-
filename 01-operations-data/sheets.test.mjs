import test from 'node:test';import assert from 'node:assert/strict';
import {ensureRow,weeklyPlan,shiftedHistoryFormula,isInsertColumnsLeftLabel,selectionMatches,select} from './sheets.mjs';
test('合併儲存格的單格選取可擴張，但不得跳到其他位置或擴張資料區',()=>{
 assert.equal(selectionMatches('A57','A57:A59'),true);
 assert.equal(selectionMatches('Q101','Q101:AC101'),true);
 assert.equal(selectionMatches('A86','A152:A153'),false);
 assert.equal(selectionMatches('Q92:AA92','Q92:AC92'),false);
});
test('名稱框短暫顯示上一列時重查選區',async()=>{let reads=0;const box={fill:async()=>{},press:async()=>{},inputValue:async()=>++reads<3?'A269:P269':'A270:P270'};await select({locator:()=>box,waitForTimeout:async()=>{}},'A270:P270');assert.equal(reads,3);});
function fakePage(size){let value='A1',invalid=false,count=0;const adds=[];const box={fill:async v=>{value=v;},press:async()=>{const r=Number(value.replace(/^A/,''));if(value.startsWith('A'))invalid=r>size;},inputValue:async()=>value};return{adds,locator:()=>box,waitForTimeout:async()=>{},getByRole:(role)=>{
 if(role==='alertdialog')return{isVisible:async()=>invalid,getByRole:()=>({click:async()=>{invalid=false;value='A1';}})};
 if(role==='textbox')return{waitFor:async()=>assert.equal(value,size+':'+size),fill:async v=>{count=Number(v);}};
 return{waitFor:async()=>{},click:async()=>{size+=count;adds.push(count);}};
 }};}
test('ensureRow 已存在時不新增',async()=>{const page=fakePage(245);await ensureRow(page,200);assert.deepEqual(page.adds,[]);});
test('ensureRow 定位最後列後只補一列',async()=>{const page=fakePage(245);await ensureRow(page,246);assert.deepEqual(page.adds,[1]);});
test('ensureRow 機台資料超出多列時只補足缺額且重跑不重複',async()=>{const page=fakePage(245);await ensureRow(page,403);await ensureRow(page,403);assert.deepEqual(page.adds,[158]);});
test('週更同週更新原區塊、新週插入、重複週拒絕',async()=>{const p={name:'測試'},s={maxCol:24,cells:{A1:{value:'9/7~9/13'},M1:{value:'8/31~9/6'}}},w={'測試遊戲數據排行':s},data={weekly:[Array(11).fill(1)],approvedMonth:'2026-09'};
 const existing=await weeklyPlan(w,p,data,{weekStart:'2026-09-07',weekEnd:'2026-09-13'});assert.equal(existing.insert,false);assert.equal(existing.column,1);
 assert.equal((await weeklyPlan(w,p,data,{weekStart:'2026-09-14',weekEnd:'2026-09-20'})).insert,true);
 s.cells.M1.value='09/07~09/13';await assert.rejects(weeklyPlan(w,p,data,{weekStart:'2026-09-07',weekEnd:'2026-09-13'}),/重複/);
});
test('插欄精確平移歷史公式，未知跨表公式先停止',()=>{assert.equal(shiftedHistoryFormula('=SUM($E$3:E225)',12),'=SUM($Q$3:Q225)');assert.equal(shiftedHistoryFormula('=C1/O1-1',12),'=O1/AA1-1');assert.equal(shiftedHistoryFormula('=BW1-#REF!',12),'=CI1-#REF!');assert.throws(()=>shiftedHistoryFormula('=Sheet2!A1',12),/人工/);});
test('中斷後空白或重複模板不可再次插欄',async()=>{const p={name:'測試'},data={weekly:[Array(11).fill(1)],approvedMonth:'2026-09'},d={weekStart:'2026-09-14',weekEnd:'2026-09-20'};for(const a of [null,'9/7~9/13']){const w={'測試遊戲數據排行':{maxCol:24,cells:{A1:{value:a},M1:{value:'9/7~9/13'}}}};await assert.rejects(weeklyPlan(w,p,data,d),/插欄未完成/);}});
test('歷史 INDEX/MATCH 的整欄及單格參照都平移',()=>{assert.equal(shiftedHistoryFormula('=IFERROR(INDEX(WS:WS,MATCH(1,(WO:WO=WC3)*(WP:WP=WD3),0)),0)',12),'=IFERROR(INDEX(XE:XE,MATCH(1,(XA:XA=WO3)*(XB:XB=WP3),0)),0)');});
test('跨週插欄接受 Google Sheets 中英文實際措辭',()=>{
 for(const text of ['向左插入 12 欄','在左側插入 12 欄','Insert 12 columns left','Insert 12 columns to the left'])assert.equal(isInsertColumnsLeftLabel(text),true,text);
 for(const text of ['向右插入 12 欄','在左側插入 11 欄','Insert 12 rows above','Insert 1 column left'])assert.equal(isInsertColumnsLeftLabel(text),false,text);
});
