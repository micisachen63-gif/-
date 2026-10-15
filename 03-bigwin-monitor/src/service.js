import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackendClientFactory } from './wiring.js';
import { cashoutEnabled, runCashoutCycle } from './cashout.js';
import { paths, projectRoot } from './config.js';
import { createHiphop } from './hiphop.js';
import { ProfileBusyError } from './errors.js';
import { createCallbackHandler, createCreatorResolver, createPublisher, pollLoop } from './listener.js';
import { createOpsShareHandler } from './ops-share.js';
import { createRelay, loadRelayConfig } from './relay.js';
import { createChatGptWeb } from './chatgpt-web.js';
import { createGrokWeb } from './grok-web.js';
import { createGptSceneImage, createGrokSceneImage, createSceneImager } from './haigui-scene.js';
import { BridgeState } from './bridge-state.js';
import { maintenanceRoute } from './maintenance-routing.js';
import { classifyMediaIntent, createGrokVideo, GrokVideoError, requiresImageReference } from './grok-video.js';
import { createTabCleanup } from './tab-cleanup.js';
import { createGameGptCleanup } from './game-gpt-cleanup.js';
import { setBrowserJobPreflight } from './browser-activity.js';
import { hideDedicatedWindows } from './dedicated-window.js';
import { createVideoMap, videoReplyAction } from './video-edit.js';
import { createLocalMaintenance, isLocalMaintenanceRequest } from './local-maintenance.js';
import { createFullAccessAgent, isFullAccessUser, isStopCommand } from './full-access.js';
import { grokTaskRoute } from './grok-intent.js';
import { acquireLock, holderAlive, holdsLock, readLock, releaseLock } from './locks.js';
import { runBrandCycle } from './scan.js';
import { AlertStore, BrandStateStore, CashoutStore, JsonStore } from './store.js';
import { createTelegramApi } from './telegram.js';
import { createTdxClient, loadTdxConfig } from './tdx.js';
import { createCwaFallback, createWeather } from './weather.js';
import { fmtStamp, readJson, sleep, writeJsonAtomic } from './util.js';

const MIN = 60e3;

/**
 * Resident mode: one process owns the headless Chrome, runs an independent scan loop per brand
 * (so a slow/broken brand never delays the others) and the 小精靈 callback listener.
 */
export async function runService({ cfg, log, deps }) {
  if (!acquireLock(paths.serviceLock, 'service')) {
    log.info('another service instance holds the lock; exiting');
    return 0;
  }
  try { fs.unlinkSync(paths.stopRequest); } catch { /* none */ }
  const w = deps || new BackendClientFactory({ cfg, log, headless: true });
  const brandStore = new BrandStateStore(paths.brandsState);
  const alerts = new AlertStore(paths.alertsState);
  const cashout = new CashoutStore(paths.cashoutState);
  const tgStore = new JsonStore(paths.tgState, { offset: 0, creatorId: null, creatorFetchedAt: 0 });
  const fairy = w.alertBot();
  const api = createTelegramApi(fairy.token);
  if (cfg.relay?.mode === 'operations') {
    const call = api.call.bind(api);
    api.call = (method, payload, ...rest) => call(method,
      method === 'sendMessage' && payload?.text && !payload.text.includes('神殿守望者')
        ? { ...payload, text: '🧙 神殿守望者｜以實據察事，以審慎行事。\n' + payload.text } : payload, ...rest);
  }
  const hiphop = cfg.hiphop?.enabled ? createHiphop({ root: projectRoot, telegram: api,
    chatId: fairy.chatId, ownerId: cfg.relay?.ownerId, log: log.child('hiphop') }) : null;
  const notifier = w.notifier({ dry: false, api, chatId: fairy.chatId });

  const st = {
    stopping: false,
    pausedForLogin: false,
    startedAt: Date.now(),
    listenerAt: null,
    listenerState: 'starting',
    brands: Object.fromEntries(cfg.brands.map((b) => [b.key, { busySince: null, lastStart: null, lastEnd: null, last: null, cashout: null }])),
  };

  const heartbeat = () => {
    try {
      writeJsonAtomic(paths.heartbeat, {
        pid: process.pid,
        startedAt: new Date(st.startedAt).toISOString(),
        updatedAt: new Date().toISOString(),
        pausedForLogin: st.pausedForLogin,
        listener: { state: st.listenerState, lastLoopAt: st.listenerAt ? new Date(st.listenerAt).toISOString() : null },
        brands: Object.fromEntries(Object.entries(st.brands).map(([k, v]) => [k, {
          busySince: v.busySince ? new Date(v.busySince).toISOString() : null,
          lastCycleStart: v.lastStart ? new Date(v.lastStart).toISOString() : null,
          lastCycleEnd: v.lastEnd ? new Date(v.lastEnd).toISOString() : null,
          last: v.last,
          cashout: v.cashout,
        }])),
      });
    } catch (error) { log.warn(`heartbeat write failed: ${error.message}`); }
  };

  // ---- control files: stop request, login hand-off, self-watchdog ----
  const control = setInterval(async () => {
    heartbeat();
    if (fs.existsSync(paths.stopRequest) && !st.stopping) {
      log.info('stop requested');
      st.stopping = true;
    }
    for (const [key, b] of Object.entries(st.brands)) {
      if (b.busySince && Date.now() - b.busySince > (cfg.brandCycleHardLimitMinutes ?? 20) * MIN) {
        log.error(`${key} cycle stuck for > ${cfg.brandCycleHardLimitMinutes ?? 20} min; exiting so the watchdog restarts the service`);
        heartbeat();
        process.exit(3);
      }
    }
    await handleLoginRequest().catch((error) => log.error(`login hand-off error: ${error.message}`));
    await recycleBrowserIfOld().catch((error) => log.warn(`browser recycle error: ${error.message}`));
  }, 3000);

  // Recycle the headless Chrome every ~12h (between cycles) to avoid slow memory growth.
  let recycling = false;
  async function recycleBrowserIfOld() {
    const age = w.browserAgeMs?.();
    if (recycling || st.pausedForLogin || st.stopping || !age || age < (cfg.browserRecycleHours ?? 12) * 3600e3) return;
    if (Object.values(st.brands).some((b) => b.busySince)) return;
    recycling = true;
    try {
      log.info('recycling headless Chrome (periodic restart)');
      await w.closeBrowser();
    } finally {
      recycling = false;
    }
  }

  let releasing = false;
  async function handleLoginRequest() {
    const req = readJson(paths.loginRequest, null);
    const active = req && holderAlive(req.pid);
    if (!active) {
      if (req) { try { fs.unlinkSync(paths.loginRequest); } catch { /* ignore */ } }
      if (st.pausedForLogin) { st.pausedForLogin = false; log.info('login hand-off finished; resuming scans'); }
      return;
    }
    if (req.state === 'released' || releasing) return;
    releasing = true;
    try {
      st.pausedForLogin = true;
      log.info(`login requested by pid ${req.pid}; pausing scans and releasing Chrome`);
      const deadline = Date.now() + 10 * MIN;
      while (Object.values(st.brands).some((b) => b.busySince) && Date.now() < deadline) await sleep(1000);
      await w.closeBrowser();
      releaseLock(paths.browserLock);
      writeJsonAtomic(paths.loginRequest, { ...req, state: 'released', releasedAt: new Date().toISOString() });
      log.info('Chrome released for login');
    } finally {
      releasing = false;
    }
  }

  // ---- listener ----
  const listenerTask = (async () => {
    try {
      const info = await api.call('getWebhookInfo');
      if (info?.url) {
        st.listenerState = 'disabled: webhook is set';
        log.error('小精靈 has a webhook configured; NOT starting getUpdates (would conflict). Buttons will not work until resolved.');
        return;
      }
    } catch (error) {
      log.warn(`getWebhookInfo failed (${error.message}); starting listener anyway`);
    }
    st.listenerState = 'polling';
    const creator = createCreatorResolver({ api, chatId: fairy.chatId, tgStore, log });
    const handleAlert = createCallbackHandler({
      api, chatId: fairy.chatId, alerts, creator, log,
      publish: createPublisher({ brands: cfg.brands, loadCommunityBot: w.loadCommunityBot, createApi: (t) => createTelegramApi(t) }),
    });
    const handleOpsShare = cfg.relay?.mode === 'operations' ? createOpsShareHandler({
      api, chatId: fairy.chatId, stateDir: paths.stateDir, creator,
      brands: cfg.brands, loadCommunityBot: w.loadCommunityBot,
      createApi: (t) => createTelegramApi(t), log: log.child('ops-share'),
    }) : null;
    const chatgptEnabled=Boolean(cfg.chatgptWeb?.enabled);
    const bridgeState=new BridgeState(paths.stateDir+'/bridge.json');
    const clients=new Map();
    const maintenanceChatFor=(userId,provider='gpt')=>{
      const key=`${provider}:${userId}`;
      if(!clients.has(key))clients.set(key,provider==='grok'
        ?createGrokWeb({endpoint:cfg.grokVideo?.endpoint||cfg.chatgptWeb.endpoint,timeoutMs:300000,state:bridgeState,sessionKey:key,log:log.child(key)})
        :createChatGptWeb({endpoint:cfg.chatgptWeb.endpoint,timeoutMs:(cfg.localMaintenance?.timeoutSeconds??300)*1000,executablePath:cfg.chatgptWeb.executablePath,profileDir:cfg.chatgptWeb.profileDir,background:cfg.chatgptWeb.background!==false,dedicatedPage:true,newChatUrl:cfg.chatgptWeb.projectUrl,log:log.child(key),state:bridgeState,sessionKey:key}));
      return clients.get(key);
    };
    const privateJobs = new Map();
    const runPrivateJob = async (userId, work) => {
      const key = String(userId);
      const previous = privateJobs.get(key);
      if (previous) return { text: '上一項任務仍在執行；如需中止，請傳「停止」。', privateOwnerOnly: true };
      const controller = new AbortController();
      let resolveStopped;
      const stopped = new Promise(resolve => { resolveStopped = resolve; });
      const job = { stop: () => { controller.abort(); resolveStopped({ text: '🛑 任務已停止。', cancelled: true, privateOwnerOnly: true }); } };
      privateJobs.set(key, job);
      try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), stopped]); }
      finally { if (privateJobs.get(key) === job) privateJobs.delete(key); }
    };
    const askChatgpt=(userId,text,options)=>runPrivateJob(userId,signal=>maintenanceChatFor(userId).ask(text,{...options,signal,onProgress:(value)=>signal.aborted?undefined:options?.onProgress?.(value)}));
    // 🎮 game GPT conversations (海龜湯 …): shared registry with 小遊戲精靈; deleted in ChatGPT + tab closed after 30 min without a new message (game-gpt-cleanup.js)
    const dropGameClient=(key)=>{const c=clients.get(key);clients.delete(key);void c?.close?.()?.catch?.(()=>{});if(bridgeState.data.sessions[key]){delete bridgeState.data.sessions[key];try{bridgeState.save();}catch(error){log.warn(`bridge state save failed: ${error.message}`);}}};
    let gameGpt=null;
    try{if(chatgptEnabled&&cfg.relay?.mode!=='operations'&&cfg.gameGptCleanup?.enabled!==false)gameGpt=createGameGptCleanup({owner:'小精靈',endpoint:cfg.chatgptWeb.endpoint,newChatUrl:cfg.chatgptWeb.projectUrl||'https://chatgpt.com/',idleMs:(cfg.gameGptCleanup?.idleMinutes??30)*60000,release:(e)=>dropGameClient(e.sessionKey),log:log.child('game-gpt')});}catch(error){log.warn('game GPT cleanup disabled: '+error.message);}
    const gameAsk=(key,meta,client,run)=>gameGpt?gameGpt.track(key,meta,client,run):run();
    const grokBuild=cfg.grokBuild?.enabled?{exe:cfg.grokBuild.exe||path.join(os.homedir(),'.grok','bin','grok.exe'),model:cfg.grokBuild.model||null,maxTurns:cfg.grokBuild.maxTurns??40,timeoutMs:(cfg.grokBuild.timeoutSeconds??1200)*1000}:null;
    const localMaintenance=chatgptEnabled&&cfg.localMaintenance?.enabled!==false?createLocalMaintenance({chatFor:maintenanceChatFor,state:bridgeState,log:log.child('local-maintenance'),maxSteps:Math.min(12,cfg.localMaintenance?.maxSteps??12),grokBuild}):null;
    await localMaintenance?.recoverInterrupted();
    const fullAccessConf = {
      enabled: cfg.fullAccess?.enabled !== false,
      allowedUsername: cfg.fullAccess?.allowedUsername || 'micasachen',
      allowedUserId: cfg.fullAccess?.allowedUserId || cfg.relay?.ownerId || 489706404,
      maxSteps: cfg.fullAccess?.maxSteps ?? 25
    };
    const fullAccessAgent = chatgptEnabled && fullAccessConf.enabled
      ? createFullAccessAgent({
          chatFor: maintenanceChatFor,
          baseDir: projectRoot,
          backupDir: path.join(projectRoot, 'backup', 'full-access'),
          maxSteps: fullAccessConf.maxSteps,
          log: log.child('full-access'),
          api
        })
      : null;
    const rawGrokVideo=cfg.grokVideo?.enabled?createGrokVideo({journalFile:path.join(paths.stateDir,'grok-video-jobs.json'),endpoint:cfg.grokVideo.endpoint,timeoutMs:(cfg.grokVideo.timeoutSeconds??600)*1000,resolution:cfg.grokVideo.resolution??'720p',duration:cfg.grokVideo.duration??'6s',log:log.child('grok-video')}):null;
    const grokVideo=rawGrokVideo?{
      ...rawGrokVideo,
      generate:(prompt,options)=>runPrivateJob(options.job.userId,signal=>rawGrokVideo.generate(prompt,{...options,signal,onProgress:(value)=>signal.aborted?undefined:options?.onProgress?.(value)})),
      edit:(prompt,options)=>runPrivateJob(options.job.userId,signal=>rawGrokVideo.edit(prompt,{...options,signal,onProgress:(value)=>signal.aborted?undefined:options?.onProgress?.(value)}))
    }:null;
    const videoMap=grokVideo?createVideoMap({file:path.join(paths.stateDir,'grok-video-map.json'),log:log.child('video-map')}):null;
    // 🧚 小精靈帶路 (life role only, zero AI): TDX credentials come from tdx.local.json and are never logged.
    let dailuTdx = null;
    if (cfg.relay?.mode !== 'operations') {
      try { const tdxCreds = loadTdxConfig(paths.tdxConfig); if (tdxCreds) dailuTdx = createTdxClient({ credentials: tdxCreds, log: log.child('tdx'), persistFile: path.join(paths.stateDir, 'tdx-cache.json') }); else log.info('dailu: tdx.local.json not set; 小精靈帶路 route lookups disabled'); }
      catch (error) { log.warn(`dailu: tdx.local.json unreadable (${error.name})`); }
    }
    const relay = createRelay({
      onVideoDelivered: videoMap ? ({ chatId, messageId, grok, userId }) => videoMap.set(chatId, messageId, { ...grok, userId }) : null,
      mode: cfg.relay?.mode || 'all',
      api, chatId: fairy.chatId, ownerId: cfg.relay?.ownerId, tgStore, log: log.child('relay'),
      getConfig: () => cfg.relay?.mode === 'life' ? null : loadRelayConfig(paths.relayConfig),
      tarotInterpreter: chatgptEnabled ? async (prompt, session) => maintenanceChatFor(`tarot:${session.userId}`).ask(prompt, { conversationTitle: '塔羅占卜' }) : null,
      dailuTdx, dailuWeather: cfg.relay?.mode !== 'operations' ? createWeather({ log: log.child('weather'), fallback: createCwaFallback(dailuTdx) }) : null,
      qiuqianInterpreter: chatgptEnabled && cfg.relay?.mode !== 'operations' ? async (prompt, session) => maintenanceChatFor(`qiuqian:${session.userId}`).ask(prompt, { conversationTitle: '觀音求籤' }) : null,
      // 🐢 海龜湯 (life role only): one GPT conversation per game (unique title so a new game never reuses an old game's tab); released when the game ends
      haiguiInterpreter: chatgptEnabled && cfg.relay?.mode !== 'operations' && cfg.haiguitang?.enabled !== false ? async (prompt, game) => { const c = maintenanceChatFor(`haigui:${game.id}`); return gameAsk(`gpt:haigui:${game.id}`, { gameId: game.id, title: `海龜湯 ${game.id}` }, c, () => c.ask(prompt, { conversationTitle: `海龜湯 ${game.id}` })); } : null,
      haiguiScene: chatgptEnabled && cfg.relay?.mode !== 'operations' && cfg.haiguitang?.enabled !== false && cfg.haiguitang?.sceneImage !== false ? (() => { try { const sl = log.child('haigui-scene'); return createSceneImager({ grok: createGrokSceneImage({ endpoint: cfg.chatgptWeb.endpoint, log: sl }), gpt: createGptSceneImage({ endpoint: cfg.chatgptWeb.endpoint, log: sl }), log: sl, grokMs: 90e3, gptMs: 150e3 }); } catch (error) { log.warn(`haiguitang scene image disabled: ${error.message}`); return null; } })() : null, // 湯面情境圖: Grok web → GPT web (own tabs), never blocks the game
      haiguiRelease: (game) => { const key = `gpt:haigui:${game.id}`; gameGpt?.ended(key); const c = clients.get(key); clients.delete(key); void c?.close?.()?.catch?.(() => {}); if (bridgeState.data.sessions[key]) { delete bridgeState.data.sessions[key]; try { bridgeState.save(); } catch (error) { log.warn(`bridge state save failed: ${error.message}`); } } },
      ownerPrivateRoute: ({agent,text,msg}) => { if(agent!=='網頁版GPT')return false;if(fullAccessAgent&&isFullAccessUser(msg,fullAccessConf))return !msg?.forceChat;if(!localMaintenance||String(msg?.from?.id)!==String(cfg.relay?.ownerId)||msg?.forceChat)return false;const hasAttachments=Boolean((Array.isArray(msg?.photo)&&msg.photo.length)||msg?.document||msg?.video);const route=maintenanceRoute({text,userId:msg.from.id,ownerId:cfg.relay?.ownerId,provider:msg.maintenanceProvider,current:localMaintenance.current(msg.from.id),hasAttachments});return ['choose','status','start','resume'].includes(route); },
localAgents: chatgptEnabled ? { '網頁版GPT': async ({ text },msg,{onProgress}={}) => {const largest=Array.isArray(msg?.photo)?msg.photo.at(-1):null;const doc=msg?.document;const video=msg?.video;const imageDoc=doc&&String(doc.mime_type||'').startsWith('image/')?doc:null;const imageSource=largest?{file_id:largest.file_id,file_name:'telegram.jpg',mime_type:'image/jpeg'}:imageDoc;const images=imageSource?[await api.downloadFile(imageSource.file_id,{fileName:imageSource.file_name||'telegram-image',mimeType:imageSource.mime_type})]:[];const fileSource=video?{file_id:video.file_id,file_name:video.file_name||'telegram-video.mp4',mime_type:video.mime_type||'video/mp4'}:doc&&!imageDoc?doc:null;const files=fileSource?[await api.downloadFile(fileSource.file_id,{fileName:fileSource.file_name||'telegram-file',mimeType:fileSource.mime_type})]:[];if(fullAccessAgent&&isFullAccessUser(msg,fullAccessConf)&&!msg.forceChat){if(isStopCommand(text)){const stopped=fullAccessAgent.stop(msg.from.id);return {text:stopped?'🛑 已中止進行中的本機任務。':'目前沒有正在執行的本機任務。',privateOwnerOnly:true};}if(fullAccessAgent.isRunning(msg.from.id)){return {text:`任務執行中：${fullAccessAgent.currentStatus(msg.from.id)||'正在等待網頁版 GPT 回應'}`,privateOwnerOnly:true};}const conversationTitle=msg.from.username?`@${msg.from.username}`:[msg.from.first_name,msg.from.last_name].filter(Boolean).join(' ')||`TG-${msg.from.id}`;const result=await fullAccessAgent.run({text,userId:msg.from.id,chatId:msg.chat?.id||msg.from.id,onProgress,conversationTitle,images,files});return typeof result==='string'?{text:result,privateOwnerOnly:true}:{...result,privateOwnerOnly:true};}const route=msg.forceChat?'chat':localMaintenance?maintenanceRoute({text,userId:msg.from.id,ownerId:cfg.relay?.ownerId,provider:msg.maintenanceProvider,current:localMaintenance.current(msg.from.id),hasAttachments:images.length+files.length>0}):'chat';if(route==='choose')return{text:'這個任務要交給誰處理？',providerChoice:true,privateOwnerOnly:true};if(route==='status')return{text:'任務仍在執行：'+(localMaintenance.current(msg.from.id)?.lastDone||'等待模型回覆'),privateOwnerOnly:true};if(route==='start'&&msg.maintenanceProvider==='grok'&&grokBuild){const conversationTitle=msg.from.username?'@'+msg.from.username:[msg.from.first_name,msg.from.last_name].filter(Boolean).join(' ')||'TG-'+msg.from.id;const g=await grokTaskRoute({text,intent:msg.grokIntent,conversationTitle,askGrokWeb:(prompt)=>maintenanceChatFor(`qa:${msg.from.id}`,'grok').ask(prompt,{onProgress,conversationTitle})});if(g.kind==='choose')return{text:'GROK 要問問題還是開發？',intentChoice:true,privateOwnerOnly:true};if(g.kind==='qa')return{text:g.text,privateOwnerOnly:true};}if(route==='start'||route==='resume'){const result=await localMaintenance.run({text,userId:msg.from.id,onProgress,provider:msg.maintenanceProvider||'gpt',resume:route==='resume',conversationTitle:msg.from.username?'@'+msg.from.username:[msg.from.first_name,msg.from.last_name].filter(Boolean).join(' ')||'TG-'+msg.from.id});return typeof result==='string'?{text:result,privateOwnerOnly:true}:{...result,privateOwnerOnly:true};}const vr=grokVideo&&!msg.forceChat?videoReplyAction({msg,hasImages:images.length>0,map:videoMap}):null;if(vr){const job={chatId:msg.chat.id,messageId:msg.message_id,userId:msg.from?.id};if(vr.action==='edit')return grokVideo.edit(vr.prompt,{postUrl:vr.postUrl,onProgress,job});if(vr.action==='new')return grokVideo.generate(vr.prompt,{image:images[0],onProgress,job});return{text:vr.text};}const mediaIntent=classifyMediaIntent(text,{hasImage:images.length>0,hasVideo:Boolean(video)});if(grokVideo&&mediaIntent==='grok-video'){if(!images.length&&requiresImageReference(text))throw new GrokVideoError('沒有收到可作為首幀的圖片。請在 Telegram 以「照片」或圖片檔案重新傳送，不要選成影片。');return grokVideo.generate(text,{image:images[0],onProgress,job:{chatId:msg.chat.id,messageId:msg.message_id,userId:msg.from?.id}});}const conversationTitle=msg.from.username?`@${msg.from.username}`:[msg.from.first_name,msg.from.last_name].filter(Boolean).join(' ')||`TG-${msg.from.id}`;const styled=`請以親切、俐落的繁體中文「小精靈助手」口吻回答，不必說明這項口吻要求；若使用者指定語言、格式或只回覆特定內容，優先完全遵照。本對話只服務 Telegram 使用者「${conversationTitle}」，只根據目前這個對話的訊息與附件作答，不要引用或混用本專案內其他對話的內容。\n\n使用者問題：\n${text}`;return askChatgpt(msg.from.id,styled,{images,files,onProgress,conversationTitle});} } : {},
      throttleMs: (cfg.relay?.throttleSeconds ?? 15) * 1000, timeoutMs: (cfg.relay?.timeoutSeconds ?? 15) * 1000,
    });
    const handleAkashiUpdate = async (u) => {
      const pyExe = 'C:\\Users\\User\\Documents\\ChatGPT\\05-定期內容\\阿卡西片單推播\\.venv\\Scripts\\python.exe';
      const pyMain = 'C:\\Users\\User\\Documents\\ChatGPT\\05-定期內容\\阿卡西片單推播\\main.py';

      // 1. 處理回呼按鈕點擊 (Callback Query)
      const cq = u?.callback_query;
      if (cq) {
        const data = String(cq.data || '');
        if (!data.startsWith('theme:')) return false;

        const parts = data.split(':');
        const themeKey = parts[1] || '熱門';
        const platform = parts[2] || 'missav';
        const chatId = String(cq.message?.chat?.id || cq.from?.id || fairy.chatId);

        const isToday = themeKey === '當日最新' || themeKey === '今日最新';
        const toastText = isToday
          ? '🧚 小精靈正在為您準備今日最新片單，請稍候...'
          : `🧚 小精靈正在為您爬取【${themeKey}】最新前 3 名，請稍候...`;

        try {
          await api.call('answerCallbackQuery', {
            callback_query_id: cq.id,
            text: toastText,
            show_alert: false
          });
        } catch (err) {
          log.warn(`answerCallbackQuery error: ${err.message}`);
        }

        import('node:child_process').then(({ spawn }) => {
          const args = isToday
            ? [pyMain, '--now', '--chat-id', chatId]
            : [pyMain, '--theme', themeKey, '--platform', platform, '--chat-id', chatId];
          const cp = spawn(pyExe, args, { windowsHide: true, stdio: 'ignore' });
          cp.unref();
        }).catch(err => log.error(`spawn akashi callback error: ${err.message}`));

        return true;
      }

      // 2. 處理私訊或群組按鈕指令
      const msg = u?.message;
      if (msg && msg.text) {
        const text = String(msg.text).trim();
        const chatId = String(msg.chat?.id || '');
        const chatType = msg.chat?.type;
        const isPrivate = chatType === 'private';

        const isStartGentleman = /^\/start(?:\s+(?:gentleman|akashi|akashi_gentleman))/i.test(text);
        const isGentlemanTrigger = /^(?:🔞\s*紳士專區|紳士專區|\/gentleman|\/akashi|\/片單|片單)$/i.test(text);

        // A. 私訊觸發：直接推播當日精選片單與互動主題按鈕
        if (isStartGentleman || (isPrivate && isGentlemanTrigger)) {
          log.info(`收到阿卡西紳士專區私訊請求 [Chat ID: ${chatId}]: ${text}`);

          import('node:child_process').then(({ spawn }) => {
            const cp = spawn(pyExe, [pyMain, '--now', '--chat-id', chatId], {
              windowsHide: true,
              stdio: 'ignore'
            });
            cp.unref();
          }).catch(err => log.error(`spawn akashi start error: ${err.message}`));

          return true;
        }

        // B. 群組點擊「🔞 紳士專區」：引導使用者私訊獲取最新片單（保護群組並確保底層按鈕完整）
        if (!isPrivate && isGentlemanTrigger) {
          log.info(`收到群組點擊紳士專區 [Chat ID: ${chatId}]: ${text}`);
          const botUser = 'yingma_songbao_qiezi_bot';
          const userName = msg.from?.first_name || '朋友';
          const replyText = `🔞 <b>【阿卡西 · 紳士專區】</b>\n\n${userName}，每日精選片單與互動主題採<b>私訊專屬推播</b>。\n👉 <b>請點擊下方按鈕私訊小精靈，立即獲取今日最新片單：</b>`;

          try {
            await api.call('sendMessage', {
              chat_id: chatId,
              text: replyText,
              parse_mode: 'HTML',
              reply_to_message_id: msg.message_id,
              allow_sending_without_reply: true,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔞 點我私訊領取當日最新', url: `https://t.me/${botUser}?start=gentleman` }]
                ]
              }
            });
          } catch (err) {
            log.error(`send gentleman group reply failed: ${err.message}`);
          }

          return true;
        }
      }

      return false;
    };

    const ownerPrivateMessage = (u) => Boolean(fullAccessAgent && u?.message && isFullAccessUser(u.message, fullAccessConf));
    // Private GPT and Grok jobs can take minutes. Do not hold Telegram polling behind any of them.
    const asyncUpdate = (u) => Boolean(u?.message?.chat?.type === 'private') || Boolean(fullAccessAgent && /^rm:gpt:/.test(String(u?.callback_query?.data || '')) && isFullAccessUser({ from: u.callback_query.from, chat: u.callback_query.message?.chat }, fullAccessConf));
    const handleUpdate = async (u) => {
      const privateMessage = u?.message;
      if (privateMessage?.chat?.type === 'private' && isStopCommand(String(privateMessage.text || privateMessage.caption || ''))) {
        const job = privateJobs.get(String(privateMessage.from?.id));
        if (job) {
          job.stop();
          await api.call('sendMessage', { chat_id: privateMessage.chat.id, text: '🛑 已停止目前任務，不會再傳送這筆任務的結果。若影片已送到 Grok，線上生成可能仍會繼續，請到 Grok Imagine 查看。' });
          return true;
        }
      }
      if (ownerPrivateMessage(u)) {
        const msg = u.message;
        const text = String(msg.text || msg.caption || '').trim();
        if (isStopCommand(text)) {
          const stopped = fullAccessAgent.stop(msg.from.id);
          await api.call('sendMessage', { chat_id: msg.chat.id, text: stopped ? '🛑 已收到停止指令；後續本機操作不會繼續執行。' : '目前沒有正在執行的本機任務。' });
          return true;
        }
        if (fullAccessAgent.awaitingReply(msg.from.id)) {
          if (!text) { await api.call('sendMessage', { chat_id: msg.chat.id, text: '請用文字回答剛才的問題，或輸入「停止」。' }); return true; }
          fullAccessAgent.reply(msg.from.id, text);
          await api.call('sendMessage', { chat_id: msg.chat.id, text: '✅ 已把你的回答交給 GPT，原任務繼續。' });
          return true;
        }
        if (fullAccessAgent.isRunning(msg.from.id)) {
          await api.call('sendMessage', { chat_id: msg.chat.id, text: `任務仍在進行：${fullAccessAgent.currentStatus(msg.from.id) || '等待 GPT 回應'}\n如需中止，請輸入「停止」。` });
          return true;
        }
      }
      if (await handleOpsShare?.(u)) return true;
      if (await handleAkashiUpdate(u)) return true;
      return (await hiphop?.handleUpdate(u)) ?? (await relay.handleUpdate(u)) ?? (cfg.relay?.mode === 'life' ? null : handleAlert(u));
    };
    // 「✏️ 繼續修改」 → 「✅ 製作完成」 after 10 min: expiries are persisted, so sweep right away (catches up after a restart) and every minute
    void relay.sweepVideoButtons?.(); setInterval(() => void relay.sweepVideoButtons?.(), 60e3).unref?.();
    await creator.get().then((id) => log.info(`private-group creator id cached: ${id}`));
    if (cfg.relay?.ownerId) {
      await relay.init();
      await relay.ensureBotCommands().catch((error) => log.warn(`bot command menu setup failed: ${error.message}`));
      await relay.ensurePanel().catch((error) => log.warn(`relay panel post failed: ${error.message}`));
      await relay.ensureOwnerPrivateMenu().catch((error) => log.warn(`private tarot menu setup failed: ${error.message}`));
      void relay.recoverTarotReadings().catch((error) => log.warn(`tarot recovery failed: ${error.message}`));
      if (cfg.relay?.mode !== 'operations') { void relay.recoverHaiguitang?.().catch((error) => log.warn(`haiguitang recovery failed: ${error.message}`)); setInterval(() => void relay.tickHaiguitang?.().catch((error) => log.warn(`haiguitang tick failed: ${error.message}`)), 10e3).unref?.(); }
      if (cfg.relay?.mode !== 'operations') { void relay.recoverEscape?.().catch((error) => log.warn(`escape recovery failed: ${error.message}`)); setInterval(() => void relay.tickEscape?.().catch((error) => log.warn(`escape tick failed: ${error.message}`)), 10e3).unref?.(); }
    }
    // Persisted Werewolf phase deadlines: resume after a restart once the bot identity is known.
    const tickWerewolf = () => void relay.tickWerewolf?.()?.catch(error => log.warn(`werewolf tick failed: ${error.message}`));
    tickWerewolf(); setInterval(tickWerewolf, 5e3).unref?.();
    // Persisted Who's Undercover phase deadlines: auto-start, timeout turns, and recover clues after a restart.
    const tickUndercover = () => void relay.tickUndercover?.()?.catch(error => log.warn(`undercover tick failed: ${error.message}`));
    tickUndercover(); setInterval(tickUndercover, 5e3).unref?.();
    // 🔐 千鎖秘藏: persisted lobby / round deadlines (10-min round timeout) resume after a restart.
    const tickSafeCrack = () => void relay.tickSafeCrack?.()?.catch(error => log.warn(`safe-crack tick failed: ${error.message}`));
    tickSafeCrack(); setInterval(tickSafeCrack, 5e3).unref?.();
    // ⚔️ RPG 掛機冒險: deliver the Worker outbox (boss cards / news / DMs) and spawn-due fallback.
    const tickRpg = () => void relay.tickRpg?.()?.catch(error => log.warn(`rpg tick failed: ${error.message}`));
    tickRpg(); setInterval(tickRpg, 5e3).unref?.();
    // zero-AI cleanup of the dedicated Chrome's tabs (19386 only): once ~60 s after start, then every 30 min
    // keep the dedicated Chrome (19386) off-screen at start and before every GPT/Grok job (it can get restored on screen, e.g. by authorize-youtube --open)
    if (cfg.chatgptWeb?.enabled && cfg.relay?.mode !== 'operations' && /:19386\/?$/.test(String(cfg.chatgptWeb.endpoint || ''))) {
      const winLog = log.child('window'); const hideWindow = () => hideDedicatedWindows({ endpoint: cfg.chatgptWeb.endpoint, log: winLog });
      setBrowserJobPreflight(() => hideWindow().catch(() => {}));
      void hideWindow().catch((error) => winLog.warn('startup off-screen failed: ' + error.message));
    }
    let tabCleanup = null;
    try { if (cfg.chatgptWeb?.enabled && cfg.relay?.mode !== 'operations' && cfg.tabCleanup?.enabled !== false) tabCleanup = createTabCleanup({ endpoint: cfg.chatgptWeb.endpoint, idleMs: (cfg.tabCleanup?.idleMinutes ?? 20) * 60000, log: log.child('tabs') }); }
    catch (error) { log.warn('tab cleanup disabled: ' + error.message); }
    if (tabCleanup) { setTimeout(async () => { const r = await tabCleanup.run('startup'); if (r?.skipped) setTimeout(() => void tabCleanup.run('startup retry'), 3 * 60000).unref?.(); }, 60000).unref?.(); setInterval(() => void tabCleanup.run('periodic'), (cfg.tabCleanup?.everyMinutes ?? 30) * 60000).unref?.(); }
    if (gameGpt) { gameGpt.seed(Object.entries(bridgeState.data.sessions).filter(([k, s]) => /^gpt:haigui:/.test(k) && s?.url).map(([k, s]) => ({ sessionKey: k, url: s.url, gameId: k.slice(11), title: `海龜湯 ${k.slice(11)}` }))); setTimeout(() => void gameGpt.sweep('startup'), 75e3).unref?.(); setInterval(() => void gameGpt.sweep('periodic'), (cfg.gameGptCleanup?.everyMinutes ?? 5) * 60000).unref?.(); }
    void grokVideo?.recoverInterrupted(async (job, text) => api.call('sendMessage', { chat_id: job.chatId, text, ...(job.messageId ? { reply_to_message_id: job.messageId, allow_sending_without_reply: true } : {}) })).catch((error) => log.warn('grok video recovery failed: ' + error.message));
    await pollLoop({ api, tgStore, handleUpdate, dispatchAsync: asyncUpdate, log: log.child('listener'), shouldStop: () => st.stopping, onPoll: () => { st.listenerAt = Date.now(); } });
    st.listenerState = 'stopped';
  })().catch((error) => { st.listenerState = `crashed: ${error.message}`; log.error(`listener crashed: ${error.stack || error.message}`); });

  // ---- scan loops ----
  let lastBusyLog = 0;
  function ensureBrowserLock() {
    if (holdsLock(paths.browserLock)) return true;
    if (acquireLock(paths.browserLock, 'service')) return true;
    if (Date.now() - lastBusyLog > 30 * MIN) {
      lastBusyLog = Date.now();
      log.warn(`browser profile is held by pid ${readLock(paths.browserLock)?.pid} (${readLock(paths.browserLock)?.role}); scans wait`);
    }
    return false;
  }

  async function brandLoop(brand, index) {
    const blog = log.child(brand.key);
    const client = w.client(brand);
    await sleep(index * 20000); // stagger brands a little
    while (!st.stopping) {
      const cycleStart = Date.now();
      if (!st.pausedForLogin && !recycling && ensureBrowserLock()) {
        const b = st.brands[brand.key];
        b.busySince = b.lastStart = Date.now();
        try {
          const r = await runBrandCycle({
            brand, client, brandState: brandStore.brand(brand.key), saveBrandState: () => brandStore.save(),
            alerts, notifier, cfg, now: Date.now(), log: blog, opts: {},
          });
          b.last = r.ok
            ? { ok: true, window: `${fmtStamp(r.window.start)} ~ ${fmtStamp(r.window.stop)}`, rows: r.fetched, pages: r.pages, bigWins: r.bigWins, newAlerts: r.newAlerts, sent: r.sent }
            : { ok: false, error: r.error };
          if (r.ok) blog.info(`cycle ok: window ${b.last.window}, rows ${r.fetched} (${r.pages} pages), ≥${r.threshold}: ${r.bigWins}, new alerts ${r.newAlerts}, sent ${r.sent}, ${Math.round((Date.now() - cycleStart) / 1000)}s`);
          if (cashoutEnabled(cfg, brand) && !r.auth && !st.stopping) {
            const c = await runCashoutCycle({ brand, client, store: cashout, notifier, cfg, now: Date.now(), log: blog, opts: {} });
            b.cashout = c.ok
              ? { ok: true, at: new Date().toISOString(), date: c.date, rows: c.rows, matched: c.matched, changes: c.changes, sent: c.sent }
              : { ok: false, at: new Date().toISOString(), error: c.error };
            if (c.ok) blog.info(`cash-out ok: ${c.date} gift-rank rows ${c.rows}, to dealers ${c.matched}, new/changed ${c.changes}, sent ${c.sent}`);
          }
        } catch (error) {
          b.last = { ok: false, error: error.message };
          if (error instanceof ProfileBusyError) blog.warn(error.message);
          else blog.error(`cycle crashed: ${error.stack || error.message}`);
          if (!(error instanceof ProfileBusyError)) await client.closePage().catch(() => {});
        } finally {
          b.busySince = null;
          b.lastEnd = Date.now();
        }
      }
      const next = cycleStart + cfg.intervalMinutes * MIN;
      while (!st.stopping && Date.now() < next) await sleep(Math.min(2000, Math.max(0, next - Date.now())));
    }
  }

  // housekeeping: prune alert records once per hour
  const housekeeping = setInterval(() => { try { alerts.prune(); } catch (error) { log.warn(`prune failed: ${error.message}`); } }, 3600e3);
  const hiphopTick = async () => {
    if (!hiphop || st.stopping) return;
    try { await hiphop.remindAuthorization(); }
    catch (error) { log.warn(`hiphop authorization reminder failed: ${error.message}`); }
    try { if (hiphop.due()) await hiphop.recommend(); }
    catch (error) { log.error(`hiphop schedule failed: ${error.message}`); }
  };
  const hiphopTimer = setInterval(hiphopTick, 60_000);
  await hiphopTick();

  log.info(`service started pid ${process.pid}; brands: ${cfg.brands.map((b) => `${b.name}≥${b.threshold}`).join(', ')}; every ${cfg.intervalMinutes} min`);
  heartbeat();
  const shutdown = () => { if (!st.stopping) { log.info('signal received; stopping'); st.stopping = true; } };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (cfg.brands.length) await Promise.all(cfg.brands.map((b, i) => brandLoop(b, i)));
  else while (!st.stopping) await sleep(1000);
  clearInterval(control);
  clearInterval(housekeeping);
  clearInterval(hiphopTimer);
  await w.closeBrowser();
  releaseLock(paths.browserLock);
  releaseLock(paths.serviceLock);
  try { fs.unlinkSync(paths.stopRequest); } catch { /* ignore */ }
  heartbeat();
  log.info('service stopped');
  await Promise.race([listenerTask, sleep(1000)]);
  return 0;
}
