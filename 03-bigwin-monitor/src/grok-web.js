import { chromium } from 'playwright-core';
import { noteTabUse, withBrowserJob } from './browser-activity.js';

// Selectors inspected in the signed-in Grok chat UI (not Imagine).
const EDITOR='[role="textbox"][aria-label="Ask Grok anything"]';
const ANSWER='[data-testid="assistant-message"]';
export function createGrokWeb({endpoint='http://127.0.0.1:19386',timeoutMs=300000,state,sessionKey,log}={}){
  let page, browser, tail=Promise.resolve();
  async function connect(){
    if(page&&!page.isClosed())return page;
    if(browser){const stale=browser;browser=null;await stale.close().catch(()=>{});} // tab closed (e.g. idle cleanup): drop the old CDP connection
    browser=await chromium.connectOverCDP(endpoint,{timeout:10000});
    const context=browser.contexts()[0],saved=state.session(sessionKey)?.url;
    page=saved?context.pages().find(p=>p.url()===saved):null;
    page ||= context.pages().find(p=>p.url()==='https://grok.com/') || await context.newPage();
    if(page.url()!==(saved||'https://grok.com/'))await page.goto(saved||'https://grok.com/',{waitUntil:'domcontentloaded',timeout:30000});
    await page.locator(EDITOR).waitFor({timeout:15000});return page;
  }
  async function wait(p,pending){
    let previous='',stable=0;const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      const replies=p.locator(ANSWER),count=await replies.count();
      const text=count?await replies.last().innerText():'';
      const stop=await p.getByRole('button',{name:/stop|停止/i}).count();
      if(count>pending.before&&text&&text===previous&&!stop){if(!stable)stable=Date.now();if(Date.now()-stable>2500){const code=replies.last().locator('pre code,pre');return pending.toolMode&&await code.count()?await code.first().textContent():text;}}
      else {stable=0;previous=text;}
      await p.waitForTimeout(500);
    }
    const error=new Error('GROK 已送出，等待回覆逾時；狀態已保存，下次先讀回，不重送。');error.uncertain=true;throw error;
  }
  async function rename(p,title){
    const name=String(title||'').trim().slice(0,70);if(!name)return;
    const id=/\/c\/([^/?]+)/.exec(new URL(p.url()).pathname)?.[1];if(!id)return;
    const link=p.locator(`a[href="/c/${id}"]`).first();
    try{
      if(await link.innerText()===name)return;
      await link.locator('button[aria-label="選項"]').dispatchEvent('pointerdown',{button:0,buttons:1,pointerType:'mouse'});
      await p.getByRole('menuitem',{name:'重新命名'}).click();
      const field=p.locator('input[aria-label^="Rename"]');await field.fill(name);await field.press('Enter');
      log?.info?.('Grok conversation renamed for Telegram user');
    }catch(error){log?.warn?.(`Grok rename skipped: ${error.message}`);}
  }
  async function ask(text,options){
    await options.onProgress?.('正在連接 GROK');const p=await connect();
    const pending=state.session(sessionKey)?.pending;
    if(pending){const answer=await wait(p,pending);state.setSession(sessionKey,{pending:null,url:p.url()});if(text===pending.text)return answer;}
    const before=await p.locator(ANSWER).count();
    await p.locator(EDITOR).fill(text);
    const record={text,before,toolMode:options.toolMode};state.setSession(sessionKey,{url:p.url(),pending:record});
    await p.locator(EDITOR).press('Enter');
    await p.waitForURL(/\/c\//,{timeout:15000}).catch(()=>{});
    state.setSession(sessionKey,{url:p.url()});await options.onProgress?.('等待 GROK 回覆');
    const answer=await wait(p,record);state.setSession(sessionKey,{pending:null,url:p.url()});await rename(p,options.conversationTitle);
    log?.info?.('Grok web answer received');return answer;
  }
  return {ask(text,options={}){const result=tail.then(()=>withBrowserJob(()=>ask(text,options).finally(()=>{if(page&&!page.isClosed())noteTabUse(page.url());})));tail=result.catch(()=>{});return result;}};
}
