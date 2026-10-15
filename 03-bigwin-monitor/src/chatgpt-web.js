import { chromium } from 'playwright-core';
import { noteTabUse, withBrowserJob } from './browser-activity.js';
import { spawn, spawnSync } from 'node:child_process';
import { hideDedicatedWindows } from './dedicated-window.js';

const CHATGPT_URL = 'https://chatgpt.com/';
const COMPOSER = '#prompt-textarea, [contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"]';
// The generic Markdown/Dil selectors also match user messages in the current ChatGPT UI.
const ASSISTANT = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';
const SEND = 'button[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="傳送"]';
const LOGIN_ERROR = 'ChatGPT 登入需要密碼、驗證碼或帳號選擇；請用「開啟GPT專用瀏覽器」完成一次人工確認。';

/** ChatGPT can keep several composers in one tab (hidden 0×0, off-screen quick-chat frames, or canvas/writing blocks):
 *  score candidates so that the actual chat composer (inside form / composer-layout, on-screen) is reliably chosen. */
export async function activeComposer(page) {
  const index = await page.evaluate((selector) => {
    const elements = Array.from(document.querySelectorAll(selector));
    if (!elements.length) return -1;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    const scored = elements.map((el, i) => {
      // Must not be inside writing block / canvas / artifact editor
      if (el.closest('.writing-block-editor, [class*="writing-block"], .magic-edit-minimal, [class*="canvas-"]')) {
        return { i, score: -1 };
      }
      // Must not be inside an existing assistant message
      if (el.closest('[data-message-author-role="assistant"], [class*="DilResponseRoot"], [class*="MarkdownRoot"]')) {
        return { i, score: -1 };
      }

      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return { i, score: -1 };
      // Bounding box must be within viewport (partially or fully)
      if (rect.bottom <= 0 || rect.top >= vpH || rect.right <= 0 || rect.left >= vpW) {
        return { i, score: -1 };
      }
      // Height should be reasonable for a composer (not an entire page canvas)
      if (rect.height > 500) return { i, score: -1 };

      let score = 10;
      // High preference: inside a <form>
      if (el.closest('form')) score += 50;
      // High preference: inside data-composer-body or ComposerLayout
      if (el.closest('[data-composer-body], [class*="ComposerLayout"], [class*="AdaptiveFooterInput"]')) score += 40;
      // Preference: id="prompt-textarea"
      if (el.id === 'prompt-textarea') score += 30;
      // Preference: closer to the bottom of the viewport
      score += Math.floor((rect.top / vpH) * 20);

      return { i, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.score > 0 ? scored[0].i : -1;
  }, COMPOSER).catch(() => -1);

  if (index < 0) return null;
  return page.locator(COMPOSER).nth(index);
}
async function waitComposer(page, ms) {
  const end = Date.now() + ms;
  for (;;) { const c = await activeComposer(page); if (c || Date.now() >= end) return c; await page.waitForTimeout(500); }
}

export class ChatGptWebError extends Error {
  constructor(message, { uncertain = false } = {}) { super(message); this.name = 'ChatGptWebError'; this.uncertain = uncertain; }
}

export async function waitForStableAnswer(page, beforeCount, { timeoutMs = 180000, stableMs = 1800, beforeImages = [], beforeText = '', toolMode=false, signal } = {}) {
  const messages = page.locator(ASSISTANT);
  const deadline = Date.now() + timeoutMs;
  let previous = ''; let stableSince = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ChatGptWebError('任務已被使用者停止。');
    const count=await messages.count();
    const current=count?(await messages.last().innerText().catch(() => '')).trim():'';
    const changed=count>beforeCount||(current&&current!==beforeText);
    const hasNewImage=await page.locator('img[src]').evaluateAll((els,old)=>els.some(e=>!old.includes(e.currentSrc||e.src)&&e.clientWidth>=128&&e.clientHeight>=128),beforeImages).catch(()=>false);
    const stopping = await page.locator('button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]').first().isVisible().catch(() => false);
    if ((changed||hasNewImage) && current === previous && !stopping) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) {const code=messages.last().locator('pre code, pre');return toolMode&&await code.count()?(await code.first().textContent()).trim():current;}
    } else { previous = current; stableSince = 0; }
    await page.waitForTimeout(450);
  }
  const rescued=(await messages.last().innerText().catch(()=>'')).trim();
  if(rescued&&rescued!==beforeText&&!await page.locator('button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]').first().isVisible().catch(()=>false))return rescued;
  throw new ChatGptWebError('GPT 已收到問題，但等待回答完成逾時；請到專用瀏覽器確認，程式不會自動重送。', { uncertain: true });
}

export function createChatGptWeb({ endpoint = 'http://127.0.0.1:19386', timeoutMs = 180000, executablePath, profileDir, background = true,dedicatedPage=false,newChatUrl=CHATGPT_URL, log,sessionKey,state } = {}) {
  let browser = null; let page = null; let queue = Promise.resolve();let lastRenamedConversationId='';
  async function connect(conversationTitle) {
    if (page && !page.isClosed()) return page;
    let context;
    if (browser) { const stale = browser; browser = null; await stale.close().catch(() => {}); } // our tab was closed (e.g. idle cleanup): drop the old CDP connection before reconnecting
    try { browser = await chromium.connectOverCDP(endpoint, { timeout: 3000 }); context = browser.contexts()[0]; }
    catch {
      if (!background || !profileDir) throw new ChatGptWebError('無法連上 GPT 專用 Chrome，請先雙擊「開啟GPT專用瀏覽器」並完成 ChatGPT 登入。');
      if (!executablePath) throw new ChatGptWebError('未設定 GPT 專用 Chrome 路徑。');
      try { const child=spawn(executablePath,[`--remote-debugging-address=127.0.0.1`,`--remote-debugging-port=${new URL(endpoint).port||19386}`,`--user-data-dir=${profileDir}`,'--no-first-run','--no-default-browser-check','--start-minimized','--window-position=-32000,-32000',newChatUrl],{detached:true,stdio:'ignore',windowsHide:true});child.unref(); }
      catch (error) { throw new ChatGptWebError(`無法啟動背景 GPT 瀏覽器（${String(error?.message || error).split('\n')[0]}）。`); }
      for(let i=0;i<30&&!context;i++){await new Promise(r=>setTimeout(r,500));try{browser=await chromium.connectOverCDP(endpoint,{timeout:1000});context=browser.contexts()[0];}catch{}}
      if(!context)throw new ChatGptWebError('背景 GPT 瀏覽器已啟動，但 19386 連線未就緒。');
      log?.info?.('ChatGPT normal Chrome started in background mode');
    }
    if (!context) throw new ChatGptWebError('GPT 專用 Chrome 沒有可用的瀏覽器工作階段。');
    await hideDedicatedWindows({endpoint,log}).catch(error=>log?.warn?.(`GPT 專用 Chrome 無法移到畫面外：${error.message}`)); // off-screen 1280x820, not minimized
    const hidden=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','C:\\Users\\User\\Documents\\ChatGPT\\營運自動化\\scripts\\dedicated-chrome-window.ps1','-Action','Hide','-Port','19386'],{windowsHide:true,encoding:'utf8',timeout:15000});
    if(hidden.error||hidden.status!==0)log?.warn?.(`GPT 專用 Chrome 無法隱藏：${(hidden.stderr||hidden.error?.message||`exit ${hidden.status}`).trim()}`);
    const saved=state?.session(sessionKey)?.url;
    if(saved)page=context.pages().find(p=>p.url()===saved)||await context.newPage();
    else if(sessionKey&&conversationTitle){for(const candidate of [...context.pages()].reverse()){if(candidate.url().includes('chatgpt.com/')&&/\/c\//.test(candidate.url())&&await candidate.title()===conversationTitle){page=candidate;break;}}}
    page ||= dedicatedPage?await context.newPage():context.pages().find((p) => /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(p.url())) || await context.newPage();
    if(saved&&page.url()!==saved)await page.goto(saved,{waitUntil:'domcontentloaded',timeout:60000});
    const projectPath=/\/g\/(g-p-[^/]+)/i.exec(new URL(newChatUrl).pathname)?.[1];const inProject=projectPath&&new URL(page.url()).pathname.includes(`/g/${projectPath}/`);
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(page.url())||(projectPath&&!inProject)) await page.goto(newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if(/\/c\//.test(page.url()))state?.setSession(sessionKey,{url:page.url()});
    return page;
  }
  async function ensureSignedIn(p) {
    let composer = await waitComposer(p, 15000);
    if (composer) return composer;
    const login = p.getByRole('button',{name:/^登入$|^Log in$/i}).or(p.getByRole('link',{name:/^登入$|^Log in$/i})).first();
    if (await login.isVisible().catch(() => false)) { await login.click(); await p.waitForTimeout(1200); }
    const google = p.getByRole('button',{name:/Google/i}).or(p.getByRole('link',{name:/Google/i})).first();
    if (await google.isVisible().catch(() => false)) { await google.click(); await p.waitForTimeout(1500); }
    if (/accounts\.google\.com/i.test(p.url())) {
      const accounts=p.locator('[data-identifier]:visible');
      if(await accounts.count()===1){await accounts.first().click();await p.waitForTimeout(1500);}
    }
    await p.waitForURL(url=>/chatgpt\.com/i.test(url.href),{timeout:30000}).catch(()=>{});
    composer=await waitComposer(p,15000);if(composer)return composer;
    const needsLogin=async()=>/accounts\.google\.com|auth\.openai\.com|\/auth\//i.test(p.url())||await login.isVisible().catch(()=>false);
    if(await needsLogin())throw new ChatGptWebError(LOGIN_ERROR);
    // signed in but no usable composer (tab stuck, 「無法載入此 ChatGPT 對話」, layout glitch): reload the tab once before giving up
    log?.warn?.('ChatGPT composer not on screen; reloading the tab once');
    await p.reload({waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
    composer=await waitComposer(p,20000);if(composer)return composer;
    if(await needsLogin())throw new ChatGptWebError(LOGIN_ERROR);
    throw new ChatGptWebError('ChatGPT 頁面找不到可用的輸入框（分頁卡住或沒載入完成）；問題尚未送出。');
  }
  async function contextLimitVisible(p) {
    const notices=await p.locator('[role="alert"], [data-testid*="toast"], [data-message-author-role="assistant"]:last-of-type').allInnerTexts().catch(()=>[]);
    return notices.some(x=>/maximum (conversation )?length|context length|conversation is too long|對話.{0,8}(上限|過長)|上下文.{0,8}(上限|過長)/i.test(x));
  }
  async function openFreshChat(p,reason) {
    await p.goto(newChatUrl,{waitUntil:'domcontentloaded',timeout:60000});
    await ensureSignedIn(p);
    log?.info?.(`ChatGPT fresh conversation opened (${reason})`);
  }
  async function renameConversation(p,title){const clean=String(title||'').trim().slice(0,80);const id=/\/c\/([^/?]+)/i.exec(new URL(p.url()).pathname)?.[1];if(!clean||!id||id===lastRenamedConversationId)return;try{const link=p.locator(`a[href*="/c/${id}"]`).first();await link.waitFor({state:'visible',timeout:12000});await link.hover();const row=link.locator('xpath=ancestor::*[.//button[@aria-label="對話動作"]][1]');await row.locator('button[aria-label="對話動作"]').click();await p.getByRole('menuitem',{name:'重新命名',exact:true}).click();const dialog=p.getByRole('dialog');await dialog.getByRole('textbox',{name:'對話標題'}).fill(clean);await dialog.getByRole('button',{name:'儲存',exact:true}).click();await link.waitFor({state:'visible',timeout:5000});lastRenamedConversationId=id;log?.info?.(`ChatGPT conversation renamed for Telegram user (${id})`);}catch(error){log?.warn?.(`ChatGPT conversation rename skipped: ${error.message}`);await p.keyboard.press('Escape').catch(()=>{});}}
  async function askOnce(text,{images=[],files=[],onProgress,conversationTitle,toolMode=false,signal}={},mayRetryContext=true) {
    try {
      if (signal?.aborted) throw new ChatGptWebError('任務已被使用者停止。');
      await onProgress?.('正在連接 ChatGPT');const p = await connect(conversationTitle);
      let composer = await ensureSignedIn(p);
      if(await contextLimitVisible(p)){await openFreshChat(p,'context limit shown');composer=await ensureSignedIn(p);}
      const pending=state?.session(sessionKey)?.pending;
      if(pending){
        await onProgress?.('正在讀取上次尚未確認的回覆');
        const assistantCount=await p.locator(ASSISTANT).count();
        const latest=(await p.locator(ASSISTANT).last().innerText().catch(()=>'' )).trim();
        const generating=await p.locator('button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]').first().isVisible().catch(()=>false);
        if(assistantCount>=pending.before&&latest&&latest!==pending.beforeText){state.setSession(sessionKey,{pending:null,url:p.url()});if(pending.text===text)return pending.toolMode?(await p.locator(ASSISTANT).last().locator('pre code, pre').first().textContent().catch(()=>latest))?.trim()||latest:latest;}
        else if(generating){const recovered=await waitForStableAnswer(p,assistantCount,{timeoutMs,beforeText:latest,beforeImages:pending.beforeImages||[],toolMode:pending.toolMode,signal});state.setSession(sessionKey,{pending:null,url:p.url()});if(pending.text===text)return recovered;}
        else if(pending.text===text)throw new ChatGptWebError('上一則問題已送達，但 GPT 沒有產生完整回覆；為避免重複執行，請先確認該對話。',{uncertain:true});
        else {state.setSession(sessionKey,{pending:null});await openFreshChat(p,'previous response stalled');composer=await ensureSignedIn(p);}
      }
      const before = await p.locator(ASSISTANT).count();
      const beforeText=before?(await p.locator(ASSISTANT).last().innerText().catch(()=>'' )).trim():'';
      const beforeImages=new Set(await p.locator('img[src]').evaluateAll(els=>els.map(e=>e.currentSrc||e.src)));
      const attachments=[...images,...files];
      if(attachments.length){await onProgress?.(files.length?'正在上傳附件':'正在上傳圖片');const hasFiles=files.length>0;const input=hasFiles?p.locator('input[type="file"][aria-label*="檔案"], input[type="file"]:not([accept])').first():p.locator('input[type="file"][accept*="image"]').first();if(!await input.count())throw new ChatGptWebError(`找不到 ChatGPT ${hasFiles?'檔案':'圖片'}上傳控制項。`);await input.setInputFiles(attachments.map((x,i)=>({name:x.fileName||`telegram-${i+1}`,mimeType:x.mimeType||'application/octet-stream',buffer:x.buffer})));await p.waitForTimeout(1800);}
      if (signal?.aborted) throw new ChatGptWebError('任務已被使用者停止。');
      await composer.fill(text);
      await p.waitForTimeout(300);
      // the send button of THIS composer (other, hidden/off-screen composers have their own) → Enter as a fallback; verify it really went out
      const form=composer.locator('xpath=ancestor::form[1]');
      let send=(await form.count().catch(()=>0)?form:p).locator(SEND).filter({visible:true}).first();
      await send.waitFor({state:'visible',timeout:5000}).catch(()=>{});
      if(!await send.isVisible().catch(()=>false))send=null;
      state?.setSession(sessionKey,{url:p.url(),pending:{text,before,beforeText,beforeImages:[...beforeImages],toolMode}});
      if(send)await send.click({timeout:10000}).catch(error=>{log?.warn?.(`ChatGPT send button click failed, pressing Enter instead: ${String(error?.message||error).split('\n')[0]}`);send=null;});
      if(!send)await composer.press('Enter');
      let sent=false;
      for(let i=0;i<20&&!sent;i++){const left=await composer.innerText({timeout:1000}).catch(()=>'');sent=left.trim().length<Math.min(8,text.length)||await p.locator('button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]').first().isVisible().catch(()=>false);if(!sent)await p.waitForTimeout(500);}
      if(!sent){state?.setSession(sessionKey,{url:p.url(),pending:null});throw new ChatGptWebError('ChatGPT 傳送沒有反應；問題尚未送出。');}
      await p.waitForURL(/\/c\//,{timeout:15000}).catch(()=>{});
      state?.setSession(sessionKey,{url:p.url()});
      await onProgress?.(files.length?'數據分析中':images.length?'圖片分析中':'小精靈正在思考');
      log?.info?.(`ChatGPT web question submitted (${text.length} chars)`);
      let answer;try{answer=await waitForStableAnswer(p, before, { timeoutMs,beforeImages:[...beforeImages],beforeText,toolMode,signal });}catch(error){if(!signal?.aborted&&mayRetryContext&&await contextLimitVisible(p)){state?.setSession(sessionKey,{pending:null});await openFreshChat(p,'context limit after submit');return askOnce(text,{images,files,onProgress,conversationTitle,toolMode,signal},false);}throw error;}await p.waitForTimeout(1500);await renameConversation(p,conversationTitle);
      const outputImages=[];const imgs=p.locator('img[src]');for(let i=0;i<await imgs.count()&&outputImages.length<4;i++){const img=imgs.nth(i),src=await img.getAttribute('src');const box=await img.boundingBox().catch(()=>null);if(!src||beforeImages.has(src)||!box||box.width<128||box.height<128)continue;if(!outputImages.length)await onProgress?.('圖片已產生，正在下載原圖');const original=await img.evaluate(async el=>{const response=await fetch(el.currentSrc||el.src);if(!response.ok)throw new Error(`HTTP ${response.status}`);const blob=await response.blob();const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let j=0;j<bytes.length;j+=0x8000)binary+=String.fromCharCode(...bytes.subarray(j,j+0x8000));return{base64:btoa(binary),mimeType:blob.type||response.headers.get('content-type')||'image/png'};}).catch(error=>{throw new ChatGptWebError(`無法下載 GPT 產生的原始圖片（${error.message}）。`);});const ext=/jpe?g/i.test(original.mimeType)?'jpg':/webp/i.test(original.mimeType)?'webp':'png';outputImages.push({buffer:Buffer.from(original.base64,'base64'),mimeType:original.mimeType,fileName:`gpt-original-${outputImages.length+1}.${ext}`});}
      state?.setSession(sessionKey,{url:p.url(),pending:null});
      return outputImages.length?{text:answer,images:outputImages}:answer;
    } finally { /* Dedicated Chrome stays minimized for the next Telegram question. */ }
  }
  return {
    async checkConnection() { return withBrowserJob(async () => { const p = await connect(); await ensureSignedIn(p); noteTabUse(p.url()); return { ready: Boolean(await activeComposer(p)) }; }); },
    /** URL of this client's tab right now (null when no tab): game-gpt-cleanup registers the conversation it used. */
    currentUrl() { return page && !page.isClosed() ? page.url() : null; },
    /** Drop this client's CDP connection once queued questions finish (the tab itself is left for the idle-tab cleanup). */
    close() { const run = queue.then(async () => { const b = browser; browser = null; page = null; if (b) await b.close().catch(() => {}); }); queue = run.catch(() => {}); return run; },
    ask(text,options={}) { const run = queue.then(() => withBrowserJob(async () => {
      const onAbort = () => { if (page && !page.isClosed()) void page.locator('button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]').first().click({timeout:2000}).catch(() => {}); };
      options.signal?.addEventListener('abort', onAbort, {once:true});
      try { return await askOnce(String(text ?? '').trim(),options); }
      finally { options.signal?.removeEventListener('abort', onAbort); if (page && !page.isClosed()) noteTabUse(page.url()); }
    })); queue = run.catch(() => {}); return run; }
  };
}
