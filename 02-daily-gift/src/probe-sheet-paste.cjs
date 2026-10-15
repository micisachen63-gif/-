const { chromium } = require('playwright');
(async () => {
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context=browser.contexts()[0];
  const page=await context.newPage();
  try {
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:'https://docs.google.com'});
    await page.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'【茄子】新手禮包'}).click();
    await page.bringToFront();
    const box=page.locator('#t-name-box');
    await box.fill('A2');await box.press('Enter');
    const gridRects=await page.locator('[id$="-grid-container"]').evaluateAll(elements=>elements.map(e=>({id:e.id,rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}})));
    const before=await page.evaluate(()=>({active:document.activeElement?.outerHTML.slice(0,300),box:document.querySelector('#t-name-box')?.value}));
    console.log(JSON.stringify({gridRects},null,2));
    await page.mouse.click(96,202);
    await page.keyboard.insertText('TEST123');
    await page.keyboard.press('Enter');
    const after=await page.evaluate(()=>({active:document.activeElement?.outerHTML.slice(0,300),box:document.querySelector('#t-name-box')?.value,formula:document.querySelector('#t-formula-bar-input')?.textContent}));
    await box.fill('A2');await box.press('Enter');await page.keyboard.press('Control+C');
    const copied=await page.evaluate(()=>navigator.clipboard.readText());
    console.log(JSON.stringify({before,after,copied:copied.slice(0,100)},null,2));
    await page.getByRole('button',{name:'【省時小精靈】'}).click({force:true});
    await page.getByRole('menuitem',{name:'【使用完畢，清理表格】'}).click({force:true});
    await page.getByText(/已清理：保護 Q 欄標籤/).waitFor({timeout:30000});
    console.log('cleanup confirmed');
  }finally{await page.close();await browser.close();}
})().catch(error=>{console.error(`ERROR: ${error.message}`);process.exitCode=1;});
