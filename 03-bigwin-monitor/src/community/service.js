// 小遊戲精靈 service entry: `node src/community/service.js`. Separate process, token, state dir, log and Chrome profile
// from 小精靈. Pure code at runtime; only 海龜湯 uses the GPT web automation (as in 小精靈).
import fs from 'node:fs';
import path from 'node:path';
import { createTelegramApi, TelegramError } from '../telegram.js';
import { createLogger } from '../log.js';
import { acquireLock, releaseLock } from '../locks.js';
import { JsonStore } from '../store.js';
import { BridgeState } from '../bridge-state.js';
import { sleep, writeJsonAtomic } from '../util.js';
import { createCommunityBot } from './bot.js';
import { createBackendBrowser, createMemberBackend } from './backend.js';
import { createRecords } from './records.js';
import { createPayout } from './payout.js';
import { createMailSender } from './mail-sender.js';
import { opsBusy } from './sheet-queue.js';
import { createPetStore } from './pet/store.js';
import { createPetCloudGateway } from './pet/cloud-gateway.js';
import { createPetApiServer } from './pet/api-server.js';
import { createWagerSync } from './pet/wager-sync.js';
import { createPetSeasonScheduler } from './pet/season-scheduler.js';
import { createSeasonPayoutSync } from './pet/season-payout-sync.js';
import { createDungeonManager } from './pet/dungeon-manager.js';

export const ROOT = path.resolve(process.env.FAIRY_MINIGAME_ROOT || path.resolve(import.meta.dirname, '../..'));
export const CONFIG_FILE = path.resolve(process.env.FAIRY_MINIGAME_CONFIG_FILE || path.join(ROOT, 'minigame.local.json'));
const STATE = path.resolve(process.env.FAIRY_MINIGAME_STATE_DIR || path.join(ROOT, 'state-minigame'));
const SHARED_ROOT = path.resolve(process.env.FAIRY_MINIGAME_SHARED_ROOT || ROOT);
const DEFAULT_GROUPS = {
  yingma: { name: '贏麻了社群', short: 'YM', adminName: '詩詩', chatId: null, multiplier: true, brand: { key: 'winmalo', name: '贏麻', uiBase: 'https://admin.winmalo.com:9955', apiBase: 'https://admin.winmalo.com:9032' }, sheet: { enabled: false, fileId: '', gid: '', tab: '', writeHeaderIfEmpty: false, url: '', secret: '' } },
  shuangbao: { name: '爽爆社群', short: 'SB', adminName: '沐沐', chatId: null, multiplier: false, brand: { key: 'songyy', name: '爽爆', uiBase: 'https://admin.song-yy.com:9955', apiBase: 'https://admin.song-yy.com:9032' }, sheet: { enabled: false, fileId: '', gid: '', tab: '', writeHeaderIfEmpty: false, url: '', secret: '' } },
  qiezi: { name: '茄子社群', short: 'QZ', adminName: '管理員', chatId: null, multiplier: false, brand: { key: 'qiezi', name: '茄子', uiBase: 'https://admin.qzplays.com:9955', apiBase: 'https://admin.qzplays.com:9032' }, sheet: { enabled: false, fileId: '', gid: '', tab: '', writeHeaderIfEmpty: false, url: '', secret: '' } },
};

export function loadConfig(file = CONFIG_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw.botToken) throw new Error('minigame.local.json 缺少 botToken');
  const groups = {};
  const configuredKeys = raw.groups && Object.keys(raw.groups).length ? Object.keys(raw.groups) : Object.keys(DEFAULT_GROUPS);
  for (const k of configuredKeys) {
    const d = DEFAULT_GROUPS[k] || { name: `${k} 社群`, short: k.slice(0, 3).toUpperCase(), adminName: '管理員', chatId: null, multiplier: false, brand: {}, sheet: { enabled: false, fileId: '', gid: '', tab: '', writeHeaderIfEmpty: false, url: '', secret: '' } };
    const custom = raw.groups?.[k] || {};
    groups[k] = { ...d, ...custom, brand: { ...d.brand, ...(custom.brand || {}) }, sheet: { ...d.sheet, ...(custom.sheet || {}) } };
  }
  let shared = {}; try { shared = JSON.parse(fs.readFileSync(path.join(SHARED_ROOT, 'config.json'), 'utf8')); } catch { /* optional */ }
  const chrome = { executablePath: raw.chrome?.executablePath || shared.chrome?.executablePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', profileDir: path.resolve(ROOT, raw.chrome?.profileDir || '.auth/minigame-chrome') };
  const gpt = { ...(shared.chatgptWeb || {}), ...(raw.chatgptWeb || {}) };
  if (gpt.profileDir) gpt.profileDir = path.resolve(SHARED_ROOT, gpt.profileDir);
  return { ...raw, groups, chrome, gpt, payout: { enabled: false, ...(raw.payout || {}) } };
}

function saveChatId(key, chatId) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  raw.groups ||= {}; raw.groups[key] ||= {}; raw.groups[key].chatId = chatId;
  writeJsonAtomic(CONFIG_FILE, raw);
}

export async function main() {
  fs.mkdirSync(STATE, { recursive: true });
  const log = createLogger(path.join(ROOT, 'logs', 'minigame.log'), { tag: 'minigame' });
  const lockFile = path.join(STATE, 'service.lock');
  if (!acquireLock(lockFile, 'minigame', { projectMarker: 'src\\community\\service.js' })) { log.warn('another 小遊戲精靈 is running; exiting'); process.exit(0); }
  let stopping = false;
  const stop = () => { stopping = true; releaseLock(lockFile); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  process.on('exit', () => releaseLock(lockFile));
  process.on('unhandledRejection', (e) => log.error(`unhandledRejection: ${e?.stack || e}`));
  process.on('uncaughtException', (e) => log.error(`uncaughtException: ${e?.stack || e}`));

  const cfg = loadConfig();
  const api = createTelegramApi(cfg.botToken);
  const me = await api.call('getMe');
  cfg.botUsername = me.username;
  cfg.botId = me.id;
  log.info(`小遊戲精靈 started as @${me.username} (pid ${process.pid})`);

  const globalStore = new JsonStore(path.join(STATE, 'global.json'), { offset: 0, setups: {}, pending: {} });
  const stores = new Map();
  const groupStore = (key) => { if (!stores.has(key)) stores.set(key, new JsonStore(path.join(STATE, `group-${key}.json`), {})); return stores.get(key); };
  const browser = createBackendBrowser({ executablePath: cfg.chrome.executablePath, profileDir: cfg.chrome.profileDir, log: log.child('chrome') });
  const backends = new Map();
  const backendFor = (key) => { if (!backends.has(key)) backends.set(key, createMemberBackend({ brand: cfg.groups[key].brand, getContext: browser.getContext, log: log.child(`backend:${key}`) })); return backends.get(key); };
  const records = createRecords({ dir: path.join(STATE, 'records'), log: log.child('records'), remote: (key) => cfg.groups[key]?.sheet });
  // 自動派獎 (2026-10-06): live only when minigame.local.json has payout.enabled AND payout.liveConfirmed = true. Mails go out
  // through the bot's OWN backend Chrome (same profile / session handling as the AID lookups); paused while 營運數據 runs.
  const sendMail = createMailSender({ groups: cfg.groups, getContext: browser.getContext, backendFor, log: log.child('mail') });
  const payout = createPayout({ dir: path.join(STATE, 'records'), log: log.child('payout'), templatesFile: path.join(SHARED_ROOT, 'assets', 'community', 'mail-templates.json'), enabled: cfg.payout.enabled === true, liveConfirmed: cfg.payout.liveConfirmed === true, sendMail, busy: () => opsBusy() });
  log.info(`payout mode: ${payout.live ? 'LIVE (自動派獎)' : 'dry-run (待審核)'}`);

  // 海龜湯 only: GPT web automation (same bridge Chrome as 小精靈, own conversations / session state).
  const haigui = {};
  if (cfg.gpt?.enabled !== false && cfg.gpt?.endpoint) {
    try {
      const { createChatGptWeb } = await import('../chatgpt-web.js');
      const bridge = new BridgeState(path.join(STATE, 'bridge.json'));
      const clients = new Map();
      const chatFor = (k) => { if (!clients.has(k)) clients.set(k, createChatGptWeb({ endpoint: cfg.gpt.endpoint, timeoutMs: (cfg.gpt.timeoutSeconds ?? 180) * 1000, executablePath: cfg.gpt.executablePath, profileDir: cfg.gpt.profileDir, background: cfg.gpt.background !== false, dedicatedPage: true, newChatUrl: cfg.gpt.projectUrl, log: log.child(k), state: bridge, sessionKey: k })); return clients.get(k); };
      // game GPT conversations: shared registry with 小精靈; deleted in ChatGPT + tab closed after 30 min without a new message (game-gpt-cleanup.js)
      const dropClient = (k) => { const c = clients.get(k); clients.delete(k); void c?.close?.()?.catch?.(() => {}); if (bridge.data.sessions[k]) { delete bridge.data.sessions[k]; bridge.save(); } };
      let gameGpt = null;
      try { const { createGameGptCleanup } = await import('../game-gpt-cleanup.js'); if (cfg.gameGptCleanup?.enabled !== false) gameGpt = createGameGptCleanup({ owner: '小遊戲精靈', endpoint: cfg.gpt.endpoint, newChatUrl: cfg.gpt.projectUrl || 'https://chatgpt.com/', idleMs: (cfg.gameGptCleanup?.idleMinutes ?? 30) * 60000, release: (e) => dropClient(e.sessionKey), log: log.child('game-gpt') }); } catch (error) { log.warn(`game GPT cleanup disabled: ${error.message}`); }
      haigui.interpreter = (prompt, game) => { const k = `mghaigui:${game.id}`, c = chatFor(k), title = `社群海龜湯 ${game.id}`; const run = () => c.ask(prompt, { conversationTitle: title }); return gameGpt ? gameGpt.track(k, { gameId: game.id, title }, c, run) : run(); };
      haigui.release = (game) => { const k = `mghaigui:${game.id}`; gameGpt?.ended(k); const c = clients.get(k); clients.delete(k); void c?.close?.()?.catch?.(() => {}); if (bridge.data.sessions[k]) { delete bridge.data.sessions[k]; bridge.save(); } };
      if (cfg.haiguitang?.sceneImage !== false) {
        const { createSceneImager, createGrokSceneImage, createGptSceneImage } = await import('../haigui-scene.js');
        const sl = log.child('haigui-scene');
        haigui.sceneImage = createSceneImager({ grok: createGrokSceneImage({ endpoint: cfg.gpt.endpoint, log: sl }), gpt: createGptSceneImage({ endpoint: cfg.gpt.endpoint, log: sl }), log: sl, grokMs: 90e3, gptMs: 150e3 });
      }
      if (gameGpt) { gameGpt.seed(Object.entries(bridge.data.sessions).filter(([k, s]) => /^mghaigui:/.test(k) && s?.url).map(([k, s]) => ({ sessionKey: k, url: s.url, gameId: k.slice(9), title: `社群海龜湯 ${k.slice(9)}` }))); setTimeout(() => void gameGpt.sweep('startup'), 90e3).unref?.(); setInterval(() => void gameGpt.sweep('periodic'), (cfg.gameGptCleanup?.everyMinutes ?? 5) * 60000).unref?.(); }
    } catch (error) { log.warn(`海龜湯 GPT disabled: ${error.message}`); }
  }

  const petCloud = createPetCloudGateway({
    apiUrl: cfg.petMiniAppUrl || 'https://minigame-pet-api.micisachen.workers.dev',
    serviceSecret: cfg.petServiceSecret || 'CHANGE_ME_SECRET_KEY',
  });
  const petPayoutSync = createSeasonPayoutSync({
    cloud: petCloud,
    payout,
    groups: Object.keys(cfg.groups),
    groupNames: Object.fromEntries(Object.entries(cfg.groups).map(([key, value]) => [key, value.name])),
    log: log.child('pet-payout'),
  });
  void petPayoutSync.syncSeasonPayouts();
  setInterval(() => void petPayoutSync.syncSeasonPayouts(), 30_000).unref();
  const petStore = createPetStore({ filePath: path.join(STATE, 'pet.json'), log: log.child('pet'), cloud: petCloud });
  const petApiServer = createPetApiServer({ store: petStore, botToken: cfg.botToken, port: cfg.petApiPort || 8787, log: log.child('pet-api') });
  const wagerSync = createWagerSync({
    apiUrl: cfg.petMiniAppUrl || 'https://minigame-pet-api.micisachen.workers.dev',
    serviceSecret: cfg.petServiceSecret || 'CHANGE_ME_SECRET_KEY',
    backendFor,
    groupStore,
    groups: Object.keys(cfg.groups),
    log: log.child('wager-sync'),
  });
  void wagerSync.syncBindings()
    .then(() => wagerSync.syncWagers())
    .catch((e) => log.warn(`initial wager sync: ${e.message}`));
  setInterval(() => void wagerSync.syncBindings().catch((e) => log.warn(`syncBindings: ${e.message}`)), 5 * 60e3).unref();
  setInterval(() => void wagerSync.syncWagers().catch((e) => log.warn(`syncWagers: ${e.message}`)), 5 * 60e3).unref();

  const dungeonManager = createDungeonManager({
    cloud: petCloud,
    products: Object.keys(cfg.groups),
    groupChatId: (key) => cfg.groups[key]?.chatId,
    sendPhoto: (payload) => api.sendPhoto(payload),
    sendMessage: (chatId, text, options = {}) => api.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...options }),
    call: (method, body) => api.call(method, body),
    answerCallback: (cq, text, alert = false) => api.call('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: alert }).catch(() => {}),
    assetsDir: path.join(ROOT, 'cloudflare/public/assets/items'),
    botUsername: () => cfg.botUsername,
    platformUrl: (product) => cfg.groups[product]?.claimUrl,
    log: log.child('dungeon'),
  });
  void dungeonManager.tick();
  setInterval(() => void dungeonManager.tick(), 60e3).unref();

  const bot = createCommunityBot({ api, cfg, groupStore, globalStore, backendFor, records, payout, log, botUsername: () => cfg.botUsername, haigui, saveGroupChatId: saveChatId, petStore, wagerSync, dungeonManager, sendPhoto: (payload) => api.sendPhoto(payload) });
  for (const key of Object.keys(cfg.groups)) bot.ensureFlows(key);
  await bot.bossManager.restoreActiveAnnouncements();
  await bot.ensurePetEntryMessages();

  const petSeasonScheduler = createPetSeasonScheduler({
    store: petStore,
    products: Object.keys(cfg.groups),
    groupChatId: (key) => cfg.groups[key]?.chatId,
    announce: (chatId, text) => chatId ? api.call('sendMessage', { chat_id: chatId, text }) : Promise.resolve(),
    log: log.child('pet-season'),
  });
  void petSeasonScheduler.tick();
  setInterval(() => void petSeasonScheduler.tick(), 60e3).unref();

  await setCommands(api, cfg, log);
  const heartbeat = () => { try { writeJsonAtomic(path.join(STATE, 'heartbeat.json'), { pid: process.pid, at: new Date().toISOString() }); } catch { /* ignore */ } };
  heartbeat();
  setInterval(heartbeat, 30e3).unref();
  setInterval(() => void bot.tick().catch((e) => log.warn(`tick: ${e.message}`)), 5000).unref();
  setInterval(() => void records.retry().then((n) => n && log.info(`records: ${n} queued append(s) sent`)).catch(() => {}), 5 * 60e3).unref(); // deferred while 營運數據 runs (sheet-queue.js)

  // Updates run concurrently across lanes (one lane per group chat / per DM user) so a slow backend lookup never stalls others.
  const lanes = new Map();
  const laneOf = (u) => String(u.callback_query?.message?.chat?.id ?? u.callback_query?.from?.id ?? u.message?.chat?.id ?? u.my_chat_member?.chat?.id ?? 'misc') + (u.callback_query?.data?.startsWith('mg:j') ? `:${u.callback_query.from.id}` : '');
  const dispatch = (u) => { const k = laneOf(u); const p = (lanes.get(k) || Promise.resolve()).then(() => bot.handleUpdate(u)); lanes.set(k, p.catch(() => {})); p.finally(() => { if (lanes.get(k) === p) lanes.delete(k); }).catch(() => {}); };
  let backoff = 5000;
  while (!stopping) {
    try {
      const updates = await api.call('getUpdates', { offset: globalStore.data.offset || undefined, timeout: 50, allowed_updates: ['message', 'callback_query', 'my_chat_member'] }, { timeoutMs: 70000 });
      backoff = 5000;
      for (const u of updates) { dispatch(u); globalStore.data.offset = u.update_id + 1; }
      if (updates.length) globalStore.save();
    } catch (error) {
      const conflict = error instanceof TelegramError && error.errorCode === 409;
      log.error(`getUpdates failed${conflict ? ' (CONFLICT: another consumer)' : ''}: ${error.message}`);
      await sleep(conflict ? 60000 : backoff); backoff = Math.min(60000, backoff * 2);
    }
  }
}

/** Keep the group command menu focused on the single Mini App entry; administration lives in DM. */
async function setCommands(api, cfg, log) {
  const set = (commands, scope) => api.call('setMyCommands', { commands, scope }).catch((e) => log.warn(`setMyCommands ${scope.type}: ${e.message}`));
  await set([], { type: 'default' });
  // Remove any prior admin-only group menu so group admins inherit the single /pet command.
  await set([], { type: 'all_chat_administrators' });
  await set([
    { command: 'start', description: '開始 / 報名說明' },
    { command: 'pet', description: '🐾 我的寵物 (Mini App)' },
    { command: 'bind', description: '🔗 綁定社群遊戲 AID' },
    { command: 'myaid', description: '查看我綁定的 AID' },
    { command: 'admin', description: '🎛 管理員控制台（限社群管理員）' },
  ], { type: 'all_private_chats' });
  await set([
    { command: 'pet', description: '🐾 我的寵物 (Mini App)' },
  ], { type: 'all_group_chats' });

  // Group entry is /pet; the private menu stays a normal command list.
  await api.call('setChatMenuButton', {
    menu_button: { type: 'commands' }
  }).catch((e) => log.warn(`setChatMenuButton: ${e.message}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main().catch((e) => { console.error(e); process.exit(1); });
