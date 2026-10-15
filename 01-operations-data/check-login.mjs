import {browser} from './runtime.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {root} from './runtime.mjs';
const config=JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8'));
let c;
const results=[];
try{
 c=await browser(!process.argv.includes('--visible'));
 for(const [name,url,sheet] of [...config.platforms.map(p=>[p.name,p.url+'/',false]),['Google 表格','https://docs.google.com/spreadsheets/d/'+config.revenueId+'/edit',true]]){
  const page=await c.newPage();
  try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(2000);
   if(sheet)await page.locator('#t-name-box').waitFor({state:'visible',timeout:30000}).catch(()=>{});
   if(!sheet)await page.getByRole('cell',{name:'本月',exact:true}).waitFor({state:'visible',timeout:15000}).catch(()=>{});
   const denied=(await page.locator('body').innerText()).includes('Session Unauthorized');
   const ok=sheet?await page.locator('#t-name-box').isVisible():!denied&&!page.url().includes('/login')&&await page.getByRole('cell',{name:'本月',exact:true}).isVisible();
   results.push({name,ok,status:ok?'登入及資料讀取正常':denied?'後台拒絕工作階段':'需要登入或頁面尚未就緒',...(!ok?{pageTitle:await page.title(),pageHost:new URL(page.url()).hostname}:{})});
  }catch(e){results.push({name,ok:false,status:'連線或載入失敗',error:e.message.split('\n')[0]});}finally{await page.close();}
 }
}catch(e){results.push({name:'專用 Chrome 連線',ok:false,status:'無法開始測試',error:e.message.split('\n')[0]});}
finally{if(c)await c.close().catch(e=>{results.push({name:'結束連線',ok:false,error:e.message.split('\n')[0]});});}
await fs.mkdir(path.join(root,'logs'),{recursive:true});await fs.writeFile(path.join(root,'logs','login-check.json'),JSON.stringify(results,null,2));
await fs.writeFile(path.join(root,'logs','login-check-context.json'),JSON.stringify({time:new Date().toISOString(),windowsUser:process.env.USERNAME,results},null,2));
console.log(JSON.stringify(results,null,2));if(results.some(r=>!r.ok))process.exitCode=2;
