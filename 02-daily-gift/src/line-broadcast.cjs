const fs=require('node:fs');const path=require('node:path');
const {chromium}=require('playwright');
const {gotoWithRelogin}=require('./ensure-logins.cjs');
// 按下「預約傳送群發訊息」之前失敗 → 結束碼 5（LINE 上沒有任何預約，候補排程可安全再試）。
let submitted=false;
const root=path.resolve(__dirname,'..');
const [brand,date,...flags]=process.argv.slice(2);
const accounts={
 qiezi:{id:'@334ojgrp',name:'茄子',template:'茄寶來給新手大紅包拉！'},
 songyy:{id:'@270zjale',name:'爽爆',template:'丁鈴鈴~ 您獲得一個大獎機會'},
 winmalo:{id:'@502osqfx',name:'贏麻了',template:'恭喜您 新手 贏麻了！抽到58金幣！'}
};
if(!accounts[brand]||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw new Error('用法：node src/line-broadcast.cjs BRAND YYYY-MM-DD [--verify-only] [--schedule]');
const verifyOnly=flags.includes('--verify-only'),schedule=flags.includes('--schedule'),checkReady=flags.includes('--check-ready'),checkScheduled=flags.includes('--check-scheduled'),noWait=flags.includes('--no-wait');
if((verifyOnly&&schedule)||(checkReady&&(verifyOnly||schedule||checkScheduled))||(checkScheduled&&(verifyOnly||schedule)))throw new Error('LINE 狀態檢查、測試與正式預約模式不得併用。');
if(noWait&&!schedule)throw new Error('--no-wait 只可用於正式預約模式。');
if(schedule){const state=JSON.parse(fs.readFileSync(path.join(root,'state','runs.json'),'utf8'));if(state.runs?.[`${date}/${brand}`]?.status!=='in_progress')throw new Error('正式預約前必須先把批次鎖定為 in_progress。');}
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const yesterday=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(new Date(`${today}T12:00:00+08:00`).getTime()-86400000));
const localTime=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
if(schedule&&(date!==yesterday||localTime>='17:30'))throw new Error('正式預約只處理台北昨天註冊名單，並須在當日 17:30 前完成。');
const dateText=today.replaceAll('-','/');
const audienceName=`${accounts[brand].name}新手2025-${today.replaceAll('-','')}`;
async function uniqueAudienceRow(page){
 const links=page.getByRole('link',{name:audienceName,exact:true});
 await links.first().waitFor({timeout:20000});
 const count=await links.count();
 if(count!==1)throw new Error(`LINE 有 ${count} 筆同名受眾，須人工核對，禁止選擇不明的受眾。`);
 return links.first().locator('xpath=ancestor::tr');
}
const logsDir=path.join(root,'logs');
function note(message){
 console.log(message);
 try{fs.mkdirSync(logsDir,{recursive:true});fs.appendFileSync(path.join(logsDir,`line-broadcast-${today}.log`),`[${new Date().toISOString()}] ${brand} ${message}\n`);}catch{}
}
async function shot(page,label){
 try{
  fs.mkdirSync(logsDir,{recursive:true});
  const file=path.join(logsDir,`line-${brand}-${new Date().toISOString().replace(/[:.]/g,'-')}-${label}.png`);
  await page.screenshot({path:file,fullPage:true});
  note(`截圖 ${path.relative(root,file)}`);
 }catch(e){note(`截圖失敗（${label}）：${e.message.split('\n')[0]}`);}
}
// 群發訊息列表預設即「已預約傳送」分頁；明確點選可見的分頁（不點表格或視窗內的同名文字）。
async function openScheduledTab(page){
 const tabs=page.getByText('已預約傳送',{exact:true}).filter({visible:true});
 const n=await tabs.count();
 for(let i=0;i<n;i++){
  const tab=tabs.nth(i);
  if(await tab.evaluate(el=>!el.closest('table,.modal,[role=dialog]'))){await tab.click().catch(()=>{});break;}
 }
 await page.locator('tbody tr').first().waitFor({timeout:20000});
 await page.waitForTimeout(1000);
}

(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');const page=await browser.contexts()[0].newPage();
 try{
  const base=`https://manager.line.biz/account/${accounts[brand].id}/broadcast`;
  if(checkScheduled){
   await gotoWithRelogin(page,base,{kind:'line',brand,ready:page.getByText('已預約傳送',{exact:true})});
   await openScheduledTab(page);
   const matches=page.locator('tbody tr').filter({hasText:accounts[brand].template}).filter({hasText:`${dateText} 18:00`});
   const count=await matches.count();
   if(count===0){console.log(`${brand}: 尚無今天 18:00 的 LINE 預約。`);process.exitCode=3;return;}
   if(count!==1)throw new Error(`${brand}: 今天 18:00 有 ${count} 筆同範本推播，需人工核對。`);
   const broadcastId=(await matches.first().locator('td').first().innerText()).trim();
   if(!/^\d+$/.test(broadcastId))throw new Error('LINE 預約 ID 無法辨識。');
   await matches.first().locator('a').first().click();
   await page.getByText('已預約傳送',{exact:true}).waitFor({timeout:15000});
   const body=(await page.locator('body').innerText()).replace(/\s+/g,' ');
   const recipient=body.split('受眾・傳送記錄')[1]?.split('更新時間')[0]?.trim();
   if(!body.includes(`傳送時間 ${dateText} 18:00`)||recipient!==`包含 ${audienceName}`)throw new Error('既有 LINE 預約的時間或唯一受眾與本批次不符。');
   console.log(JSON.stringify({brand,broadcastId,scheduledLocalTime:`${today} 18:00`,audienceName}));
   return;
  }
  await gotoWithRelogin(page,`${base}/audience`,{kind:'line',brand,ready:page.getByRole('button',{name:'建立',exact:true})});if(!checkReady)await page.bringToFront();
  const audienceRow=await uniqueAudienceRow(page);
  if(checkReady){
    await audienceRow.waitFor({timeout:20000});
    const status=(await audienceRow.locator('td').last().innerText()).trim();
    console.log(`${brand}: LINE 受眾 ${status}。`);
    if(status!=='可用')process.exitCode=status==='準備中'?3:4;
    return;
  }
  let available=false;
  if(noWait){
    await audienceRow.waitFor({timeout:20000});
    available=(await audienceRow.locator('td').last().innerText()).trim()==='可用';
  }else{
    const audienceDeadline=Date.now()+12*60*1000;
    while(Date.now()<audienceDeadline){
      await audienceRow.waitFor({timeout:10000});
      if((await audienceRow.locator('td').last().innerText()).trim()==='可用'){available=true;break;}
      await page.waitForTimeout(15000);await page.reload({waitUntil:'domcontentloaded'});
    }
  }
  if(!available)throw new Error(noWait?'LINE 受眾尚未可用，未建立推播。':'等待約 12 分鐘後，當日 LINE 受眾仍不是可用狀態。');
  await gotoWithRelogin(page,base,{kind:'line',brand,ready:page.getByText('已傳送',{exact:true})});
  await page.getByText('已傳送',{exact:true}).last().click();
  const row=page.locator('tbody tr').filter({hasText:accounts[brand].template}).first();
  await row.waitFor({timeout:20000});
  const templateId=(await row.locator('td').first().innerText()).trim();
  if(!/^\d+$/.test(templateId))throw new Error('找不到可辨識的上一則 LINE 範本 ID。');
  await row.locator('.fa-ellipsis-h').click();await row.getByText('複製',{exact:true}).click();
  const section=page.getByText('受眾・傳送記錄',{exact:false}).first().locator('..').locator('..');
  await section.waitFor({timeout:15000});
  const old=section.locator('.card-body .la-times');
  while(await old.count())await old.first().click();
  await section.locator('button:has(.la-pen)').click();
  const choices=page.getByText(audienceName,{exact:true}).locator('xpath=ancestor::tr');
  await choices.first().waitFor({timeout:20000});
  if(await choices.count()!==1)throw new Error('LINE 受眾選擇清單出現同名或缺少資料。');
  const target=choices.first();
  await target.waitFor({timeout:20000});
  await target.getByText('包含',{exact:true}).click();
  await page.getByRole('button',{name:'新增',exact:true}).last().click();
  const selected=section.locator('.card-body .d-flex');
  // 複製舊訊息後，清掉的舊受眾可能在選擇視窗關閉時重新出現。
  for(let i=0;i<5;i++){
    const stale=selected.filter({hasNotText:audienceName});
    if(!await stale.count())break;
    await stale.first().locator('.la-times').click();
    await page.waitForTimeout(250);
  }
  let selectedCount=0,selectedText='';
  for(let i=0;i<20;i++){
    selectedCount=await selected.count();
    selectedText=selectedCount===1?(await selected.first().innerText()).replace(/\s+/g,' ').trim():'';
    if(selectedCount===1&&selectedText===`包含 ${audienceName}`)break;
    await page.waitForTimeout(250);
  }
  if(selectedCount!==1||selectedText!==`包含 ${audienceName}`){
    const descriptions=(await selected.allInnerTexts()).map(text=>text.replace(/\s+/g,' ').trim()).join('；');
    throw new Error(`LINE 推播受眾核對失敗（已選 ${selectedCount} 筆：${descriptions.slice(0,160)}）。`);
  }
  const dateInput=page.locator('input[name="datepicker"]'),timeInput=page.locator('input[name="timepicker"]');
  await dateInput.fill(dateText);await timeInput.fill('18:00');await timeInput.press('Tab');
  if(await dateInput.inputValue()!==dateText||await timeInput.inputValue()!=='18:00')throw new Error('LINE 推播預約時間未正確填入。');
  const radios=page.locator('input[name="radio"]');
  if(!(await radios.nth(1).isChecked()))await radios.nth(1).locator('..').click();
  if(!(await radios.nth(1).isChecked()))throw new Error('LINE 推播沒有選到預約時間。');
  if(schedule){
   try{
    // 與人工流程一致：先儲存草稿，再預約傳送（驗證模式不儲存，不建立任何東西）。
    const saveDraft=page.getByRole('button',{name:'儲存草稿',exact:true}).filter({visible:true});
    if(await saveDraft.count()!==1)throw new Error(`LINE 編輯頁「儲存草稿」按鈕數量 ${await saveDraft.count()}，未預約。`);
    const urlBeforeDraft=page.url();
    const toast=page.getByText(/已儲存|儲存成功|儲存草稿了|已將.*草稿/).filter({visible:true});
    const toastBaseline=await toast.count();
    await saveDraft.click();
    let draftSignal='';
    const draftDeadline=Date.now()+20000;
    while(Date.now()<draftDeadline){
      await page.waitForTimeout(500);
      if(await toast.count()>toastBaseline){draftSignal=`提示「${(await toast.last().innerText()).replace(/\s+/g,' ').trim().slice(0,80)}」`;break;}
      if(page.url()!==urlBeforeDraft){draftSignal=`網址改為 ${page.url()}`;break;}
    }
    await page.waitForTimeout(1500);
    await shot(page,'after-draft');
    const draftId=page.url().match(/\/broadcast\/(?:[a-z]+\/)*(\d+)/)?.[1]||'';
    note(`儲存草稿後：${draftSignal||'無提示且網址未變'}；目前網址 ${page.url()}；草稿 ID ${draftId||'(網址無 ID)'}。`);
    if(!draftSignal)throw new Error('按「儲存草稿」後 20 秒內沒有成功提示或網址變化，未預約。');
    // 儲存後重新核對：唯一受眾（包含）、今天日期、18:00、預約時間選項。
    const submitButton=page.getByRole('button',{name:'預約傳送群發訊息',exact:true}).filter({visible:true});
    await submitButton.last().waitFor({timeout:20000}).catch(()=>{});
    if(!await submitButton.count())throw new Error(`儲存草稿後找不到「預約傳送群發訊息」（網址 ${page.url()}，草稿 ${draftId||'未知'}），未預約。`);
    const savedSection=page.getByText('受眾・傳送記錄',{exact:false}).first().locator('..').locator('..');
    await savedSection.waitFor({timeout:15000});
    const savedSelected=savedSection.locator('.card-body .d-flex');
    const savedAudience=(await savedSelected.allInnerTexts()).map(text=>text.replace(/\s+/g,' ').trim());
    const savedDate=await page.locator('input[name="datepicker"]').inputValue().catch(()=>'');
    const savedTime=await page.locator('input[name="timepicker"]').inputValue().catch(()=>'');
    const savedRadio=await page.locator('input[name="radio"]').nth(1).isChecked().catch(()=>false);
    note(`草稿內容：受眾 ${savedAudience.join('；')}；日期 ${savedDate}；時間 ${savedTime}；預約選項 ${savedRadio}。`);
    if(savedAudience.length!==1||savedAudience[0]!==`包含 ${audienceName}`||savedDate!==dateText||savedTime!=='18:00'||!savedRadio)
      throw new Error(`儲存草稿後內容不符（草稿 ${draftId||'未知'}），未預約。`);
    const accepted=page.getByText(/已受理傳送群發訊息的操作/).filter({visible:true});
    // LINE 確認視窗：標題「傳送群發訊息」，內文「此則群發訊息將於YYYY/MM/DD HH:mm傳送給您所設定的目標對象，確定要傳送嗎？」，按鈕「取消」「傳送」。
    const modals=page.locator('.modal, .modal-dialog, .modal-content, [role=dialog], [role=alertdialog]').filter({visible:true})
      .filter({hasText:'傳送群發訊息'}).filter({hasText:'確定要傳送嗎'}).filter({has:page.getByRole('button',{name:'傳送',exact:true})});
    submitted=true;
    await page.getByRole('button',{name:'預約傳送群發訊息',exact:true}).last().click();
    await page.waitForTimeout(800);
    await shot(page,'after-submit');
    let outcome='';
    const confirmDeadline=Date.now()+15000;
    while(Date.now()<confirmDeadline){
      if(await accepted.count()){outcome='accepted';break;}
      if(await modals.count()){outcome='modal';break;}
      await page.waitForTimeout(300);
    }
    if(!outcome){await shot(page,'no-confirm');throw new Error('LINE 未出現預約確認視窗，未送出。');}
    if(outcome==='modal'){
      const modal=modals.last();
      const modalText=(await modal.innerText()).replace(/\s+/g,' ').trim();
      note(`LINE 確認視窗：${modalText.slice(0,200)}`);
      await shot(page,'confirm-modal');
      const buttons=modal.locator('button').filter({visible:true});
      note(`LINE 確認視窗按鈕：${(await buttons.allInnerTexts()).map(text=>text.replace(/\s+/g,' ').trim()).join('／')||'(無文字)'}`);
      if(!modalText.includes(`${dateText} 18:00`)){
        const cancel=modal.getByRole('button',{name:'取消',exact:true});
        if(await cancel.count()===1)await cancel.click();
        await shot(page,'wrong-time-cancelled');
        throw new Error(`LINE 確認視窗時間不是 ${dateText} 18:00，已按取消，未送出。`);
      }
      const confirm=modal.getByRole('button',{name:'傳送',exact:true});
      if(await confirm.count()!==1)throw new Error('LINE 確認視窗沒有唯一的「傳送」按鈕，未送出。');
      note('確認視窗時間正確，點選「傳送」。');
      await confirm.click();
      await page.waitForTimeout(800);
      await shot(page,'after-confirm');
      const ok=await accepted.first().waitFor({timeout:20000}).then(()=>true,()=>false);
      note(ok?'LINE 顯示已受理傳送群發訊息的操作。':'20 秒內未看到「已受理」文字；改以已預約傳送列表核對。');
    }else note('LINE 直接顯示已受理傳送群發訊息的操作（未出現確認視窗）。');
    await page.goto(base,{waitUntil:'domcontentloaded'});
    const scheduled=page.locator('tbody tr').filter({hasText:accounts[brand].template}).filter({hasText:`${dateText} 18:00`});
    let found=0;
    for(let attempt=1;attempt<=5;attempt++){
      await openScheduledTab(page);
      found=await scheduled.count();
      if(found)break;
      if(attempt<5){await page.waitForTimeout(10000);await page.reload({waitUntil:'domcontentloaded'});}
    }
    if(found!==1){await shot(page,'scheduled-list');throw new Error(found?`今天 18:00 有 ${found} 筆同範本預約，需人工核對。`:'約 50 秒內未在「已預約傳送」列表看到今天 18:00 的推播。');}
    const scheduledId=(await scheduled.first().locator('td').first().innerText()).trim();
    if(!/^\d+$/.test(scheduledId)||scheduledId===templateId)throw new Error('無法確認新的 LINE 預約紀錄。');
    note(`LINE 推播 ${scheduledId} 已預約 ${dateText} 18:00，受眾 ${audienceName}。`);
   }catch(e){await shot(page,'schedule-error');throw e;}
  }else console.log(`${brand}: LINE 範本 ${templateId}、唯一受眾 ${audienceName}、${dateText} 18:00 已驗證；未預約。`);
 }finally{await page.close();await browser.close();}
})().catch(e=>{console.error(`ERROR: ${e.message}`);process.exitCode=schedule&&!submitted?5:1});
