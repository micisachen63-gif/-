import fs from 'node:fs/promises';
import path from 'node:path';
import {browser,root} from './runtime.mjs';
import {openRoute} from './login.mjs';
const config=JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8'));
const context=await browser();
const result=[];
try {
 for(const p of config.platforms.filter(p=>!process.argv[2]||p.key===process.argv[2])){
  const page=await context.newPage();
  try {
   await openRoute(page,p,'/player/log',{});
   const aid=process.argv.includes('--test-member')?(await fs.readFile('C:/Users/User/Documents/Codex/2026-09-21/new-chat/daily_gift/work/export-check/songyy-2026-09-30-verify.csv','utf8')).split(/\r?\n/)[1]?.split(',')[0]?.replaceAll('"','').trim():p.merchants[Number(process.argv[3]||0)][0];
   if(!process.argv.includes('--no-aid'))await page.locator('input[name=aid]').fill(aid);
   const dates=page.locator('input[type=tel]');
   await dates.nth(0).fill(process.argv.includes('--broad')?'2026-07-01 00:00:00':process.argv.includes('--oneday')?'2026-09-30 00:00:00':'2026-09-01 00:00:00');
   await dates.nth(1).fill(process.argv.includes('--today')?'2026-10-01 23:59:59':'2026-09-30 23:59:59');
   await dates.nth(1).press('Tab');
   const combos=page.locator('[role=button][aria-haspopup=listbox]');
   if(!process.argv.includes('--all-resources')){await combos.nth(2).click();await page.getByRole('option',{name:'金幣',exact:true}).click();}
   await page.getByRole('button',{name:'送出',exact:true}).click();
   await page.waitForLoadState('networkidle',{timeout:60000}).catch(()=>{});
   await page.waitForTimeout(6000);
   if(process.argv.includes('--shot'))await page.screenshot({path:path.join(root,'private','preflight-2026-10-01',p.key+'-merchant-log.png'),fullPage:true});
   const rows=await page.getByRole('table').locator('tr').evaluateAll(rs=>rs.map(r=>[...r.querySelectorAll('th,td')].map(c=>c.textContent.trim())));
   const headings=rows[0],ti=headings.indexOf('時間'),ri=headings.indexOf('資源');
   result.push({platform:p.name,aid:process.argv.includes('--test-member')?'member':[p.merchants[Number(process.argv[3]||0)][0]],path:new URL(page.url()).pathname,selectedAid:await page.locator('input[name=aid]').inputValue(),dates:await dates.evaluateAll(es=>es.map(x=>x.value)),combos:await combos.allInnerTexts(),totalText:await page.locator('p').filter({hasText:'Total Rows:'}).allInnerTexts(),headers:headings,rows:rows.slice(1,6).map(r=>({time:r[ti],resource:r[ri]}))});
  }catch(error){result.push({platform:p.name,error:String(error.message).slice(0,240)});}
  finally{await page.close();}
 }
}finally{await context.close();}
console.log(JSON.stringify(result));
