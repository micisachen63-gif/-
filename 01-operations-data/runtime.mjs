import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import {chromium} from 'playwright';
import {borrowedContext} from './attached-browser.mjs';
export {chromium};
export const runtime=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies');
export const root=path.dirname(fileURLToPath(import.meta.url));
const settings=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8').replace(/^\uFEFF/,''));
export const profile=settings.browserProfile?path.resolve(settings.browserProfile):path.join(root,'private','chrome-profile');
export async function browser(headless=false){
 if(/^codexsandbox/i.test(process.env.USERNAME??''))throw Error('請由使用者雙擊桌面測試入口執行；Codex 隔離帳號與登入 Chrome 的 Windows 帳號不同，不能可靠驗證此登入環境。');
 if(settings.browserMode==='attach'){
  if(settings.localControlApproved!==true)throw Error('常駐瀏覽器控制尚未經使用者確認啟用');
  const connection=await chromium.connectOverCDP('http://127.0.0.1:19385',{timeout:15000}).catch(()=>{throw Error('請先開啟常駐登入視窗，並保持開啟；程式不會自動關閉或重啟 Chrome。');});
  const context=connection.contexts()[0];if(!context){await connection.close();throw Error('找不到專用瀏覽器工作階段');}
  return borrowedContext(connection,context);
 }
 return chromium.launchPersistentContext(profile,{channel:'chrome',headless,viewport:{width:1440,height:1000},locale:'zh-TW',timezoneId:'Asia/Taipei',acceptDownloads:true});
}
