const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const {gotoWithRelogin}=require('./ensure-logins.cjs');
const {parseCsv}=require('./mail-template.cjs');
const {verifySheetCoverage}=require('./sheet-policy.cjs');
const {waitForStableReadback}=require('./sheet-readback.cjs');

const root=path.resolve(__dirname,'..');
const [brand,date,...flags]=process.argv.slice(2);
const tabs={qiezi:{name:'【茄子】新手禮包',gid:'800545005'},songyy:{name:'【爽爆】新手禮包',gid:'0'},winmalo:{name:'【贏麻了】新手禮包',gid:'565202922'}};
if(!tabs[brand]||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw new Error('用法：node src/process-sheet.cjs BRAND YYYY-MM-DD [--verify-only]');
const verifyOnly=flags.includes('--verify-only');
const source=verifyOnly?path.join(root,'work','export-check',`${brand}-${date}-verify.csv`):path.join(root,'inbox',brand,`${brand}-${date}.csv`);
if(!fs.existsSync(source))throw new Error(`找不到來源 CSV：${source}`);
const rows=parseCsv(fs.readFileSync(source,'utf8').replace(/^\uFEFF/,''));
const header=rows.shift()?.map(x=>x.trim());
const aidCol=header?.indexOf('AID'),lineCol=header?.indexOf('Line ID');
if(aidCol<0||lineCol<0)throw new Error('來源 CSV 缺少 AID 或 Line ID 欄。');
const sourceRows=rows.filter(row=>row.some(value=>String(value).trim()));
const sourceIds=new Set(sourceRows.map(row=>String(row[aidCol]||'').trim()));
const sourceLineIds=new Set(sourceRows.map(row=>String(row[lineCol]||'').trim()).filter(Boolean));
if(!sourceIds.size)throw new Error('來源 CSV 沒有會員。');
const outDir=path.join(root,verifyOnly?'work/flow-check':'staging',date,brand);
fs.mkdirSync(outDir,{recursive:true});

async function openMenu(page){
  await page.locator('.jfk-butterBar-shown').waitFor({state:'hidden',timeout:45000});
  await page.getByRole('dialog').waitFor({state:'hidden',timeout:10000}).catch(()=>{});
  const menu=page.getByRole('button',{name:'【省時小精靈】'});
  for(let i=0;i<3;i++){
    await menu.click({force:true});
    if((await menu.getAttribute('aria-expanded'))==='true')return;
    await page.waitForTimeout(350);
  }
  throw new Error('Apps Script 選單未開啟。');
}
async function clickTool(page,name,pattern){
  await openMenu(page);
  const item=page.getByRole('menuitem',{name,exact:true});
  await item.waitFor({state:'visible',timeout:5000});
  await item.click();
  const result=page.getByText(pattern).last();
  await result.waitFor({timeout:45000});
  return (await result.innerText()).trim();
}
async function readCell(page,cell){
  const box=page.locator('#t-name-box');
  await box.fill(cell);await box.press('Enter');
  await page.waitForTimeout(300);
  return (await page.locator('#t-formula-bar-input').textContent()||'').trim();
}
function parseIds(raw,label){
  const ids=raw.split(',').map(x=>x.trim()).filter(Boolean);
  if(ids.some(x=>!/^\d+$/.test(x)||!sourceIds.has(x)))throw new Error(`${label} 有無效或不屬於來源 CSV 的 AID。`);
  if(new Set(ids).size!==ids.length)throw new Error(`${label} 有重複 AID。`);
  return ids;
}
function listCount(raw){return raw.split(',').map(x=>x.trim()).filter(Boolean).length;}
function readIdList(page,cell,expected,label){
  return waitForStableReadback({
    read:()=>readCell(page,cell),wait:ms=>page.waitForTimeout(ms),
    matches:raw=>listCount(raw)===expected,
    verify:raw=>parseIds(raw,label),
    formatObserved:raw=>String(listCount(raw)),
    label,expectedDescription:`Apps Script 提示 ${expected} 位`,
  });
}
function readMatchingCell(page,cell,expected,label){
  return waitForStableReadback({
    read:()=>readCell(page,cell),wait:ms=>page.waitForTimeout(ms),
    matches:raw=>raw===expected,
    formatObserved:raw=>String(listCount(raw)),
    label,expectedDescription:'內容須與已核對名單一致',
  });
}

(async()=>{
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context=browser.contexts()[0];const page=await context.newPage();
  let selected=false,cleanupError,mainError;
  try{
    await gotoWithRelogin(page,'https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{kind:'google',ready:page.getByRole('button',{name:'【省時小精靈】'}),timeout:30000});
    await page.bringToFront();
    await page.getByRole('button',{name:tabs[brand].name,exact:true}).click();
    if(!page.url().includes(`gid=${tabs[brand].gid}`))throw new Error('工作表分頁不符。');
    selected=true;
    const firstAid=[...sourceIds][0];
    let observedAid=await readCell(page,'A2');
    if(observedAid!==firstAid){await page.waitForTimeout(1200);observedAid=await readCell(page,'A2');}
    if(observedAid!==firstAid)throw new Error(`工作表 A2 與來源 CSV 不符（工作表字數 ${observedAid.length}，來源字數 ${firstAid.length}），請先匯入正確名單。`);
    let groups;
    if(brand==='winmalo'){
      const message=await clickTool(page,'【生成1:1派送名單】',/1:1派送：\d+ 筆 A_ID 已寫入 R5 & S5/);
      const count=Number(message.match(/1:1派送：(\d+) 筆/)?.[1]);
      const ids=await readIdList(page,'R5',count,'1:1 名單');
      await readMatchingCell(page,'S5',ids.join(','),'S5 派送名單');
      groups={oneToOne:ids};
    }else{
      const highMessage=await clickTool(page,'【找出充值150以上用戶】',/≥150：\d+ 筆 A_ID 已寫入 R2/);
      const highCount=Number(highMessage.match(/≥150：(\d+) 筆/)?.[1]);
      const high=await readIdList(page,'R2',highCount,'150 以上名單');
      const lowMessage=await clickTool(page,'【找出充值未達150用戶】',/<150：\d+ 筆 A_ID 已寫入 R3/);
      const lowCount=Number(lowMessage.match(/<150：(\d+) 筆/)?.[1]);
      const low=await readIdList(page,'R3',lowCount,'150 未達名單');
      if(high.some(x=>low.includes(x)))throw new Error('高低組名單重疊。');
      groups={atLeast150:high,below150:low};
    }
    await openMenu(page);
    await page.getByRole('menuitem',{name:'【LINE推送名單下載】',exact:true}).click();
    const dialog=page.getByRole('dialog');await dialog.waitFor({timeout:45000});
    const message=await dialog.innerText();
    const driveUrl=message.match(/https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\/view/);
    if(!driveUrl)throw new Error('LINE CSV 視窗未提供 Google Drive 檔案連結。');
    await dialog.getByRole('button',{name:/確定|OK/}).click();
    await dialog.waitFor({state:'hidden',timeout:15000});
    const dlPage=await context.newPage();let lineFile;
    try{
      const wait=dlPage.waitForEvent('download',{timeout:30000});
      await dlPage.goto(`https://drive.google.com/uc?export=download&id=${driveUrl[1]}`,{waitUntil:'domcontentloaded'}).catch(()=>{});
      const download=await wait;
      lineFile=path.join(outDir,`${brand}-${date}-line-ids.csv`);
      await download.saveAs(lineFile);
      if(await download.failure())throw new Error('Google Drive LINE CSV 下載失敗。');
    }finally{await dlPage.close();}
    const lineIds=fs.readFileSync(lineFile,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    if(new Set(lineIds).size!==lineIds.length)throw new Error('LINE CSV 有重複 UID。');
    if(lineIds.some(id=>!/^U[0-9a-f]{32}$/i.test(id)))throw new Error('LINE CSV 有格式不正確的 UID。');
    if(lineIds.some(id=>!sourceLineIds.has(id)))throw new Error('LINE CSV 有不屬於來源會員的 UID。');
    if(lineIds.length>sourceIds.size)throw new Error('LINE CSV 筆數超過會員來源筆數。');
    const coverage=verifySheetCoverage(header,sourceRows,groups,lineIds);
    await clickTool(page,'【使用完畢，清理表格】',/✅ 已清理：保護 Q 欄標籤，清除其餘資料。/);
    // 清理後試算表可能延遲刷新；最多重讀 10 次（每次約 1 秒），仍有資料才判定失敗。
    let cleanupAttempts=0,leftover=true;
    while(cleanupAttempts<10){
      cleanupAttempts++;
      leftover=Boolean(await readCell(page,'A2')||await readCell(page,brand==='winmalo'?'R5':'R3'));
      if(!leftover)break;
      await page.waitForTimeout(1000);
    }
    if(leftover)throw new Error('清理後工作表仍有會員或派送資料。');
    console.log(`${brand}: 清理核對第 ${cleanupAttempts} 次讀取通過。`);
    selected=false;
    const out={date,brand,sourceCount:sourceIds.size,eligibleCount:coverage.eligibleCount,excludedDuplicateIpZeroDeposit:coverage.excludedDuplicateIpZeroDeposit,groups,lineCount:lineIds.length,lineFile:path.relative(root,lineFile),processedAt:new Date().toISOString()};
    fs.writeFileSync(path.join(outDir,'sheet-result.json'),JSON.stringify(out,null,2)+'\n','utf8');
    console.log(`${brand}: 分組 ${Object.entries(groups).map(([k,v])=>`${k}=${v.length}`).join('、')}，LINE UID ${lineIds.length}，工作表已清理。`);
  }catch(e){mainError=e;}
  finally{
    if(selected){
      try{await clickTool(page,'【使用完畢，清理表格】',/✅ 已清理：保護 Q 欄標籤，清除其餘資料。/);console.log(`${brand}: 發生錯誤後已清理工作表。`);}
      catch(e){cleanupError=e;}
    }
    await page.close();await browser.close();
  }
  if(mainError)throw new Error(`${mainError.message}${cleanupError?`；另有清理失敗：${cleanupError.message}`:''}`);
})().catch(error=>{console.error(`ERROR: ${error.message}`);process.exitCode=1;});
