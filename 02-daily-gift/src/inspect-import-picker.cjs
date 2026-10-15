const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page = await browser.contexts()[0].newPage();
  try {
    await page.goto('https://docs.google.com/spreadsheets/d/1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI/edit?gid=565202922', {waitUntil:'domcontentloaded'});
    await page.locator('#docs-file-menu').click();
    const entry=page.getByRole('menuitem',{name:/^匯入/});
    await entry.waitFor({state:'visible',timeout:10000});
    await entry.click();
    await page.waitForTimeout(2000);
    const frames = [];
    for (const frame of page.frames()) {
      const role = await frame.locator('[role="tab"], [role="button"]').allTextContents().catch(()=>[]);
      frames.push({origin:new URL(frame.url()==='about:blank'?'about:blank':frame.url()).origin,controls:role.map(x=>x.trim()).filter(Boolean).slice(0,16)});
    }
    console.log(JSON.stringify({dialogs:await page.locator('[role="dialog"]').allInnerTexts().catch(()=>[]),frames}));
  } finally {await page.close();await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
