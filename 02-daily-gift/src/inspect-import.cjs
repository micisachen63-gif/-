const path=require('node:path');
const {chromium}=require('playwright');
const file=path.resolve(__dirname,'..','work','export-check','qiezi-2026-09-22-verify.csv');
(async()=>{
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page=await browser.contexts()[0].newPage();
  try{
    await page.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'【茄子】新手禮包'}).click();
    await page.getByRole('menuitem',{name:'檔案',exact:true}).click({force:true});
    await page.getByRole('menuitem',{name:/^匯入/}).click({force:true});
    const picker=page.frameLocator('iframe[src*="/picker?"]');
    await picker.getByRole('tab',{name:'上傳'}).click();
    const chooser=page.waitForEvent('filechooser');
    await picker.getByRole('button',{name:'瀏覽'}).click();
    await (await chooser).setFiles(file);
    await page.getByText('匯入位置',{exact:true}).waitFor({timeout:30000});
    const dialog=page.locator('[role="dialog"]').last();
    console.log((await dialog.innerText()).slice(0,2000));
    const inputs=await dialog.locator('input,select,button,[role="combobox"]').evaluateAll(es=>es.map(e=>({tag:e.tagName,role:e.getAttribute('role'),text:e.innerText.slice(0,100),value:e.value||null,aria:e.getAttribute('aria-label')})));
    console.log(JSON.stringify(inputs,null,2));
    console.log(await page.getByText('建立新試算表',{exact:true}).evaluate(e=>e.parentElement?.outerHTML.slice(0,1000)));
    await page.getByText('建立新試算表',{exact:true}).click();
    console.log((await page.locator('[role="listbox"],[role="menu"]').allTextContents()).slice(-4));
  }finally{await page.close();await browser.close();}
})().catch(e=>{console.error(`ERROR: ${e.message}`);process.exitCode=1;});
