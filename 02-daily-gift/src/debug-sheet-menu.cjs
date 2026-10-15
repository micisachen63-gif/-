const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page=await browser.contexts()[0].newPage();
  try{
    await page.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit',{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'【茄子】新手禮包'}).click();
    const menu=page.getByRole('button',{name:'【省時小精靈】'});
    await menu.click({force:true});
    console.log('first menu',await menu.getAttribute('aria-expanded'),await page.getByRole('menuitem',{name:'【找出充值150以上用戶】',exact:true}).count());
    await page.getByRole('menuitem',{name:'【找出充值150以上用戶】',exact:true}).click({force:true});
    await page.getByText(/已寫入 R2/).waitFor({timeout:20000});
    await page.locator('.jfk-butterBar-shown').waitFor({state:'hidden',timeout:30000});
    console.log('after first',await menu.getAttribute('aria-expanded'));
    const rect=await menu.boundingBox();
    console.log('rect',rect);
    console.log('hit',await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.outerHTML.slice(0,250),{x:rect.x+rect.width/2,y:rect.y+rect.height/2}));
    await menu.click({force:true});
    console.log('second menu',await menu.getAttribute('aria-expanded'),await page.getByRole('menuitem',{name:'【找出充值未達150用戶】',exact:true}).count());
    console.log('menu texts',JSON.stringify((await page.locator('[role="menuitem"]').allTextContents()).filter(s=>s.includes('150'))));
  }finally{await page.close();await browser.close();}
})().catch(e=>{console.error(`ERROR: ${e.message}`);process.exitCode=1;});
