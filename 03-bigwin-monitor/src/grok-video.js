import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { withBrowserJob } from './browser-activity.js';

const IMAGINE_URL='https://grok.com/imagine';

export class GrokVideoError extends Error{constructor(message,{uncertain=false}={}){super(message);this.name='GrokVideoError';this.uncertain=uncertain;}}

export function classifyMediaIntent(text,{hasImage=false,hasVideo=false}={}){
  const s=String(text||'').trim().replace(/[，。！？、,.!?]/g,' ');
  const asksAnalysis=/(?:分析|辨識|识别|判讀|解讀|看懂|描述|摘要|內容|发生什么|發生什麼|這是什麼|是什么|哪種|哪一種|什麼植物|什么植物|看一下|告訴我|告诉我)/i.test(s);
  const asksCreation=/(?:生成|製作|制作|產生|建立|創作|创作|做(?:一支|一個|成)?|轉(?:換)?成?|變成|变成|動畫化|动画化|動起來|动起来|加上動態|加上动态|運鏡|运镜)/i.test(s);
  const targetsVideo=/(?:影片|視頻|视频|短片|動畫|动画|動態影像|动态影像|MP4)/i.test(s);
  const asksHow=/(?:怎麼|怎么|如何|為什麼|为什么|教我|方法|步驟|步骤|能不能做到|可不可以做到)/i.test(s);
  const imageMotion=hasImage&&/(?:讓|使|把|將|令).{0,12}(?:動起來|动起来|走路|說話|说话|眨眼|轉動|转动|運鏡|运镜|動畫化|动画化)/i.test(s);
  // A supplied video is evidence to inspect that video. Grok Imagine currently accepts an image first frame, not video-to-video.
  if(hasVideo)return 'chatgpt';
  if(asksHow)return 'chatgpt';
  if(asksAnalysis&&!asksCreation)return 'chatgpt';
  if((asksCreation&&targetsVideo)||imageMotion)return 'grok-video';
  return 'chatgpt';
}
export const isVideoGenerationRequest=(text)=>classifyMediaIntent(text)==='grok-video';
export const requiresImageReference=(text)=>/(?:這|此|該|上面|剛才|剛剛)?(?:一)?張?(?:圖片|照片|圖)(?:片)?|(?:把|將|用).{0,8}(?:圖片|照片|圖)/i.test(String(text||''));
export const GROK_UI_CHANGED='Grok Imagine 網頁改版，找不到「影片」模式或解析度／時長選項，小精靈暫時無法製作影片（任務沒有送出，不會扣額度）。需要更新小精靈程式後才能使用。';
/** Playwright waits for Imagine's video controls time out when grok.com changes its UI → say so plainly instead of「逾時（15 秒）」. */
export const asUiChanged=(error)=>error?.name==='TimeoutError'?new GrokVideoError(GROK_UI_CHANGED):error;
export const NO_AUDIO_RE=/(?:\u4e0d\u9700\u8981|\u4e0d\u9700|\u4e0d\u8981|\u4e0d\u7528|\u4e0d\u5fc5|\u7121\u9700|\u7121\u9808|\u7121|\u65e0|\u6c92\u6709|\u6ca1\u6709|\u5225|\u4e0d\u542b|\u53bb\u6389|\u62ff\u6389|\u95dc\u6389|\u95dc\u9589|\u5173\u95ed|\u514d)(?:\u6709|\u4efb\u4f55|\u52a0|\u5e36|\u5e26)?(?:\u8a9e\u97f3|\u8bed\u97f3|\u8072\u97f3|\u58f0\u97f3|\u97f3\u8a0a|\u97f3\u6548|\u914d\u97f3|\u4eba\u8072|\u4eba\u58f0|\u97f3\u6a02|\u97f3\u4e50|\u8072|\u58f0)|\u7121\u8072|\u65e0\u58f0|\u975c\u97f3|\u9759\u97f3|\u9ed8\u7247|\u6d88\u97f3|\bno\s*(?:audio|sound|voice)\b|\bwithout\s*(?:audio|sound)\b|\bmuted?\b|\bsilent\b/i;
/** True when the request asks for a video without audio (no voice / silent / mute). */
export const wantsNoAudio=(text)=>NO_AUDIO_RE.test(String(text||''));
/** Video-audio toggle state from its attributes: true (on), false (off), null (unknown). */
export const audioOn=(attrs={})=>{const v=attrs['aria-pressed']??attrs['aria-checked']??attrs['data-state'];return v==null?null:/^(?:true|on|checked|active)$/i.test(String(v));};
async function readAudio(button){const attrs={};for(const k of ['aria-pressed','aria-checked','data-state']){const v=await button.getAttribute(k).catch(()=>null);if(v!=null)attrs[k]=v;}return audioOn(attrs);}
/** Turn Grok Imagine's video audio off. Never submits. Returns 'off' | 'already-off' | 'unknown' | 'absent'; throws if it stays on, so nothing is generated with audio by mistake. */
export async function turnAudioOff(page,{settleMs=300}={}){const button=page.locator('button[aria-label="\u5f71\u7247\u97f3\u8a0a"]').first();if(!(await button.isVisible().catch(()=>false)))return 'absent';const state=await readAudio(button);if(state===false)return 'already-off';if(state===null)return 'unknown';await button.click({timeout:5000});await page.waitForTimeout(settleMs);if(await readAudio(button)!==false)throw new GrokVideoError('\u7121\u6cd5\u95dc\u9589 Grok \u5f71\u7247\u97f3\u8a0a\uff0c\u5df2\u505c\u6b62\u9001\u51fa\uff08\u4e0d\u6703\u6263\u984d\u5ea6\uff09\u3002');return 'off';}
/** The submit button renders a moment after the prompt is filled: wait up to timeoutMs for it and click it; only then fall back to Enter. */
export async function submitPrompt(page,editor,{timeoutMs=8000}={}){const submit=page.locator('button[type="submit"][aria-label="\u9001\u51fa"]').first();const shown=await submit.waitFor({state:'visible',timeout:timeoutMs}).then(()=>true,()=>false);if(shown){await submit.click({timeout:5000});return 'button';}await editor.press('Enter');return 'enter';}
/** Only Grok-generated clips count as a result: the new Imagine page also plays promo clips (media.x.ai/...), which must never be sent as the user's video. */
export const isGeneratedVideo=(src)=>/\/generated\/[^/]+\/generated_video\.mp4/i.test(String(src||''));
export const findNewVideoSource=(sources,before=[],submittedId='')=>{const fresh=sources.filter(src=>src&&isGeneratedVideo(src)&&!before.includes(src));return fresh.find(src=>submittedId&&src.includes(submittedId))||fresh[0]||'';};

export function createGrokVideo({endpoint='http://127.0.0.1:19386',timeoutMs=10*60*1000,resolution='720p',duration='6s',log,journalFile=null,hardCapMs=null,chromiumImpl=chromium,now=()=>Date.now()}={}){
  let browser=null,page=null;let queue=Promise.resolve();
  // In-flight jobs are journaled so a restart mid-job still ends with a clear message (recoverInterrupted on the next start).
  const readJournal=()=>{if(!journalFile)return {};try{return JSON.parse(fs.readFileSync(journalFile,'utf8'))||{};}catch{return {};}};
  const writeJournal=(j)=>{if(!journalFile)return;try{fs.mkdirSync(path.dirname(journalFile),{recursive:true});const tmp=journalFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(j));fs.renameSync(tmp,journalFile);}catch(error){log?.warn?.('Grok video journal write failed: '+error.message);}};
  const mark=(id,patch)=>{if(!id||!journalFile)return;const j=readJournal();if(patch===null)delete j[id];else j[id]={...(j[id]||{}),...patch};writeJournal(j);};
  const capMs=hardCapMs??timeoutMs+5*60*1000;
  const twTime=(ms)=>{const d=new Date(Number(ms)+8*3600000);return String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0');};
  // Every job ends: if any step hangs past the cap, close the tab and say so (wording depends on whether Grok already got the job).
  const withHardCap=(inner,st)=>{let timer;const cap=new Promise((_,reject)=>{timer=setTimeout(()=>{const mins=Math.max(1,Math.round(capMs/60000));reject(st.submitted?new GrokVideoError('Grok \u5df2\u6536\u5230\u5f71\u7247\u4efb\u52d9\uff0c\u4f46\u7b49\u5f85\u8d85\u904e '+mins+' \u5206\u9418\u4ecd\u672a\u5b8c\u6210\uff0c\u5df2\u505c\u6b62\u7b49\u5f85\uff1b\u53ef\u80fd\u5df2\u6263\u984d\u5ea6\uff0c\u8acb\u5230 Grok Imagine \u7d00\u9304\u67e5\u770b\uff0c\u4e0d\u6703\u81ea\u52d5\u91cd\u9001\u3002',{uncertain:true}):new GrokVideoError('Grok \u5f71\u7247\u4efb\u52d9\u5361\u4f4f\u8d85\u904e '+mins+' \u5206\u9418\uff0c\u5df2\u505c\u6b62\uff08\u5c1a\u672a\u9001\u51fa\uff0c\u4e0d\u6703\u6263\u984d\u5ea6\uff09\u3002\u8acb\u7a0d\u5f8c\u518d\u8a66\u3002'));if(page&&!page.isClosed())page.close().catch(()=>{});if(browser)browser.close().catch(()=>{});},capMs);timer.unref?.();});return Promise.race([inner,cap]).finally(()=>clearTimeout(timer));};
  async function connect(){browser=await chromiumImpl.connectOverCDP(endpoint,{timeout:5000});const context=browser.contexts()[0];if(!context)throw new GrokVideoError('Grok 專用 Chrome 沒有可用工作階段。');page=await context.newPage();await page.goto(IMAGINE_URL,{waitUntil:'domcontentloaded',timeout:60000});return page;}
  async function choose(buttonAria,value){const button=page.locator(`button[aria-label="${buttonAria}"]`).first();await button.waitFor({state:'visible',timeout:15000});if((await button.innerText()).trim()===value)return;await button.click();const option=page.getByText(value,{exact:true}).last();await option.waitFor({state:'visible',timeout:5000});await option.click();}
  async function prepare(image,onProgress,{noAudio=false}={}){if(!/\/imagine(?:\?|$)/i.test(new URL(page.url()).pathname+new URL(page.url()).search))await page.goto(IMAGINE_URL,{waitUntil:'domcontentloaded',timeout:60000});const login=page.getByRole('link',{name:/登入|Log in/i}).or(page.getByRole('button',{name:/登入|Log in/i})).first();if(await login.isVisible().catch(()=>false))throw new GrokVideoError('Grok 登入已失效，請在專用瀏覽器用 Google 登入一次。');await page.locator('[role="textbox"][aria-label="Ask Grok anything"]').first().waitFor({state:'visible',timeout:30000});try{const videoMode=page.locator('button[aria-label="影片"]').first();await videoMode.waitFor({state:'visible',timeout:8000});await videoMode.click({timeout:8000});await choose('影片解析度',resolution);await choose('影片時長',duration);}catch(error){throw asUiChanged(error);}if(noAudio){try{const audio=await turnAudioOff(page);await onProgress?.(audio==='off'||audio==='already-off'?'\u5df2\u95dc\u9589\u5f71\u7247\u97f3\u8a0a':'\u627e\u4e0d\u5230\u5f71\u7247\u97f3\u8a0a\u958b\u95dc\uff0c\u7dad\u6301\u9810\u8a2d');if(audio==='absent'||audio==='unknown')log?.warn?.('Grok video audio toggle '+audio+'; left as default');}catch(error){throw asUiChanged(error);}}const remove=page.locator('button[aria-label="Remove image"]');while(await remove.count())await remove.first().click();if(image){await onProgress?.('正在上傳影片參考圖');const input=page.locator('input[type="file"][name="files"][accept*="image"]').first();await input.waitFor({state:'attached',timeout:10000});await input.setInputFiles({name:image.fileName||'telegram-reference.jpg',mimeType:image.mimeType||'image/jpeg',buffer:image.buffer});try{await page.locator('button[aria-label="Remove image"]').first().waitFor({state:'visible',timeout:30000});await page.locator('img[src^="blob:"]').last().waitFor({state:'visible',timeout:10000});}catch{throw new GrokVideoError('圖片未成功附加到 Grok 影片任務，已停止送出，避免變成憑空生成。');}await onProgress?.('參考圖已附加，準備生成影片');}}
  // Wait for the new clip (not one already on the page), download the original MP4. Shared by new videos and edits.
  async function awaitResult(p,{before,postId,onProgress,t0,signal}){const deadline=Date.now()+timeoutMs;let lastProgress='';while(Date.now()<deadline){if(signal?.aborted)throw new GrokVideoError('任務已被使用者停止；不會傳回影片。',{uncertain:true});const body=(await p.locator('body').innerText().catch(()=>''));const progress=/\b(\d{1,3})%\b/.exec(body)?.[1];const status=progress?`Grok 影片生成中 ${progress}%`:'Grok 影片生成中';if(status!==lastProgress){lastProgress=status;await onProgress?.(status);}const sources=await p.locator('video').evaluateAll(videos=>videos.map(v=>v.currentSrc||v.src).filter(Boolean)).catch(()=>[]);const cur=/\/imagine\/post\/([^?]+)/.exec(p.url())?.[1]||postId;const source=findNewVideoSource(sources,before,cur);if(source){await onProgress?.('影片已完成，正在下載原始 MP4');const response=await p.context().request.get(source,{timeout:120000});if(!response.ok())throw new GrokVideoError(`Grok 原始影片下載失敗：HTTP ${response.status()}`);const buffer=await response.body();if(buffer.length>49*1024*1024)throw new GrokVideoError('Grok 影片超過 Telegram 50MB 上限。');const resultId=/\/generated\/([^/]+)\/generated_video\.mp4/i.exec(source)?.[1]||postId;log?.info?.(`Grok video done (post ${cur}, video ${resultId}, ${(buffer.length/1048576).toFixed(1)} MB, ${Math.round((Date.now()-t0)/1000)} s)`);return{text:'🎬 Grok Imagine 影片生成完成',videos:[{buffer,mimeType:response.headers()['content-type']||'video/mp4',fileName:`grok-${resultId}.mp4`,grok:{postId:cur,videoId:resultId,url:p.url()}}]};}if(/失敗|failed|error/i.test(body.slice(-1200)))throw new GrokVideoError('Grok 影片生成失敗，請到 Imagine 頁面查看原因。');await p.waitForTimeout(3000);}throw new GrokVideoError('Grok 已收到影片任務，但等待生成完成逾時；不會自動重送。',{uncertain:true});}
  async function generateOnce(prompt,{image,onProgress,jobId=null,st={},signal}={}){let p;const t0=Date.now();try{p=await connect();await onProgress?.('正在連接 Grok Imagine');await prepare(image,onProgress,{noAudio:wantsNoAudio(prompt)});const before=await p.locator('video').evaluateAll(videos=>videos.map(v=>v.currentSrc||v.src).filter(Boolean)).catch(()=>[]);const editor=p.locator('[role="textbox"][aria-label="Ask Grok anything"]').first();await editor.fill(String(prompt||'').trim());if(signal?.aborted)throw new GrokVideoError('任務已被使用者停止；沒有送出 Grok。');await onProgress?.('正在送出 Grok 影片任務');await submitPrompt(p,editor);st.submitted=true;mark(jobId,{phase:'submitted'});try{await p.waitForURL(/\/imagine\/post\//,{timeout:60000});}catch{throw new GrokVideoError('Grok 送出後未顯示影片任務頁，可能已排入佇列；為避免重複生成，請先檢查 Grok Imagine 紀錄，不會自動重送。',{uncertain:true});}const postId=/\/imagine\/post\/([^?]+)/.exec(p.url())?.[1];if(!postId)throw new GrokVideoError('找不到 Grok 影片任務識別碼。',{uncertain:true});mark(jobId,{postId});log?.info?.(`Grok video submitted (${postId})`);await onProgress?.('Grok 已收到影片任務');return await awaitResult(p,{before,postId,onProgress,t0,signal});}finally{if(p&&!p.isClosed())await p.close().catch(()=>{});page=null;if(browser)await browser.close().catch(()=>{});browser=null;}}
  const EDIT_UI_CHANGED='Grok Imagine \u5f71\u7247\u9801\u6539\u7248\uff0c\u627e\u4e0d\u5230\u63a5\u7e8c\u7de8\u8f2f\u7684\u8f38\u5165\u6846\u6216\u300c\u88fd\u4f5c\u5f71\u7247\u300d\u6309\u9215\uff08\u4efb\u52d9\u6c92\u6709\u9001\u51fa\uff0c\u4e0d\u6703\u6263\u984d\u5ea6\uff09\u3002\u9700\u8981\u66f4\u65b0\u5c0f\u7cbe\u9748\u7a0b\u5f0f\u3002';
  /** Continue editing a finished video: its post page (same Grok conversation) has a prompt box and a 製作影片 button; nothing is clicked before the prompt is in. */
  async function editOnce(prompt,{postUrl,onProgress,jobId=null,st={},signal}={}){let p;const t0=Date.now();try{
    browser=await chromiumImpl.connectOverCDP(endpoint,{timeout:5000});const context=browser.contexts()[0];if(!context)throw new GrokVideoError('Grok \u5c08\u7528 Chrome \u6c92\u6709\u53ef\u7528\u5de5\u4f5c\u968e\u6bb5\u3002');page=await context.newPage();p=page;
    await onProgress?.('\u6b63\u5728\u958b\u555f\u539f\u672c\u7684 Grok \u5f71\u7247');
    await p.goto(postUrl,{waitUntil:'domcontentloaded',timeout:60000});
    const login=p.getByRole('link',{name:/\u767b\u5165|Log in/i}).or(p.getByRole('button',{name:/\u767b\u5165|Log in/i})).first();if(await login.isVisible().catch(()=>false))throw new GrokVideoError('Grok \u767b\u5165\u5df2\u5931\u6548\uff0c\u8acb\u5728\u5c08\u7528\u700f\u89bd\u5668\u7528 Google \u767b\u5165\u4e00\u6b21\u3002');
    const editor=p.locator('[role="textbox"][aria-label="Ask Grok anything"]').first();
    try{await editor.waitFor({state:'visible',timeout:30000});}catch{throw new GrokVideoError(EDIT_UI_CHANGED);}
    const fromPost=/\/imagine\/post\/([^?#]+)/.exec(p.url())?.[1];
    if(!fromPost)throw new GrokVideoError('\u539f\u672c\u7684 Grok \u5f71\u7247\u5df2\u4e0d\u5b58\u5728\uff08\u53ef\u80fd\u5df2\u522a\u9664\uff09\uff0c\u4efb\u52d9\u6c92\u6709\u9001\u51fa\uff0c\u4e0d\u6703\u6263\u984d\u5ea6\u3002\u8acb\u9644\u4e0a\u4e00\u5f35\u5716\u7247\u91cd\u65b0\u88fd\u4f5c\u3002');
    if(wantsNoAudio(prompt)){const audio=await turnAudioOff(p);await onProgress?.(audio==='off'||audio==='already-off'?'\u5df2\u95dc\u9589\u5f71\u7247\u97f3\u8a0a':'\u627e\u4e0d\u5230\u5f71\u7247\u97f3\u8a0a\u958b\u95dc\uff0c\u7dad\u6301\u9810\u8a2d');if(audio==='absent'||audio==='unknown')log?.warn?.('Grok video edit: audio toggle '+audio+'; left as default');}
    const before=await p.locator('video').evaluateAll(videos=>videos.map(v=>v.currentSrc||v.src).filter(Boolean)).catch(()=>[]);
    await editor.fill(String(prompt||'').trim());
    const make=p.locator('button[aria-label="\u88fd\u4f5c\u5f71\u7247"]').first();let ready=false;
    for(let i=0;i<16&&!ready;i++){ready=(await make.isVisible().catch(()=>false))&&(await make.isEnabled().catch(()=>false));if(!ready)await p.waitForTimeout(500);}
    if(!ready)throw new GrokVideoError(EDIT_UI_CHANGED);
    await onProgress?.('\u6b63\u5728\u9001\u51fa Grok \u5f71\u7247\u7de8\u8f2f');
    await make.click({timeout:5000});st.submitted=true;mark(jobId,{phase:'submitted',postId:fromPost});
    log?.info?.('Grok video edit submitted (from post '+fromPost+')');await onProgress?.('Grok \u5df2\u6536\u5230\u5f71\u7247\u7de8\u8f2f\u4efb\u52d9');
    const result=await awaitResult(p,{before,postId:'',onProgress,t0,signal});
    return{...result,text:'\ud83c\udfac \u5df2\u4f9d\u4f60\u7684\u65b0\u6307\u793a\u63a5\u7e8c\u7de8\u8f2f Grok \u5f71\u7247'};
  }finally{if(p&&!p.isClosed())await p.close().catch(()=>{});page=null;if(browser)await browser.close().catch(()=>{});browser=null;}}
  function enqueue(prompt,options={}){const {job,...rest}=options;const id=job&&journalFile?now().toString(36)+'-'+Math.random().toString(36).slice(2,7):null;mark(id,{...job,at:now(),phase:'queued',...(rest.postUrl?{editOf:rest.postUrl}:{})});const st={submitted:false};let settled=Promise.resolve();
    const once=rest.postUrl?editOnce:generateOnce;
    const run=queue.then(()=>{if(rest.signal?.aborted)throw new GrokVideoError('任務已被使用者停止；沒有送出 Grok。');mark(id,{phase:'preparing'});const inner=withBrowserJob(()=>once(prompt,{...rest,jobId:id,st}));settled=inner.catch(()=>{});return withHardCap(inner,st);})
      .catch((error)=>{log?.warn?.('Grok video '+(rest.postUrl?'edit ':'')+'failed'+(st.submitted?' after submit':'')+': '+error.message);throw error;}).finally(()=>mark(id,null));
    queue=run.catch(()=>{}).then(()=>settled);return run;}
  return{
    generate(prompt,options={}){return enqueue(prompt,{...options,postUrl:null});},
    /** Continue editing a finished Grok video (options.postUrl = its post page). Same queue, journal, 15-min cap and tab close as generate(). */
    edit(prompt,options={}){if(!options.postUrl)return Promise.reject(new GrokVideoError('missing Grok post URL'));return enqueue(prompt,options);},
    /** On startup: tell the user about jobs a restart cut off, then clear the journal. Returns how many were reported. */
    async recoverInterrupted(notify){const j=readJournal();const ids=Object.keys(j);if(!ids.length)return 0;writeJournal({});
      for(const id of ids){const job=j[id]||{};const at=twTime(job.at||now());
        const text=job.phase==='submitted'?'\u26a0\ufe0f \u5c0f\u7cbe\u9748\u525b\u624d\u91cd\u65b0\u555f\u52d5\uff0c'+at+' \u958b\u59cb\u7684 Grok \u5f71\u7247\u4efb\u52d9\u88ab\u4e2d\u65b7\uff0c\u6c92\u6709\u9001\u56de\u5f71\u7247\u3002\u4efb\u52d9\u5df2\u9001\u51fa Grok\uff0c\u53ef\u80fd\u5df2\u6263\u984d\u5ea6\uff1b\u8acb\u5148\u5230 Grok Imagine \u7d00\u9304\u67e5\u770b\uff0c\u9700\u8981\u6642\u518d\u91cd\u65b0\u50b3\u9001\u3002':'\u26a0\ufe0f \u5c0f\u7cbe\u9748\u525b\u624d\u91cd\u65b0\u555f\u52d5\uff0c'+at+' \u958b\u59cb\u7684 Grok \u5f71\u7247\u4efb\u52d9\u88ab\u4e2d\u65b7\uff08\u5c1a\u672a\u9001\u51fa\uff0c\u4e0d\u6703\u6263\u984d\u5ea6\uff09\u3002\u8acb\u91cd\u65b0\u50b3\u9001\u4e00\u6b21\u3002';
        log?.warn?.('Grok video job '+id+' was interrupted by a restart (phase '+job.phase+(job.postId?', post '+job.postId:'')+')');
        try{await notify(job,text);}catch(error){log?.warn?.('Grok video interrupted-job notice failed: '+error.message);}}
      return ids.length;}};
}
