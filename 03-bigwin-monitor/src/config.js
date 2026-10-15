import fs from 'node:fs';
import path from 'node:path';
import { readJson, readEnvFile } from './util.js';

export const projectRoot = path.resolve(import.meta.dirname, '..');
export const serviceRole = process.env.FAIRY_SERVICE_ROLE === 'operations' ? 'operations' : 'life';
export const runtimeRoot = serviceRole === 'operations' ? path.resolve(projectRoot, '..', '神殿守望者') : projectRoot;

export const paths = {
  config: path.join(projectRoot, 'config.json'),
  stateDir: path.join(projectRoot, 'state'),
  logsDir: path.join(projectRoot, 'logs'),
  serviceLog: path.join(projectRoot, 'logs', 'service.log'),
  brandsState: path.join(projectRoot, 'state', 'brands.json'),
  alertsState: path.join(projectRoot, 'state', 'alerts.json'),
  tgState: path.join(projectRoot, 'state', 'telegram.json'),
  heartbeat: path.join(projectRoot, 'state', 'heartbeat.json'),
  serviceLock: path.join(projectRoot, 'state', 'service.lock'),
  browserLock: path.join(projectRoot, 'state', 'browser.lock'),
  loginRequest: path.join(projectRoot, 'state', 'login-request.json'),
  stopRequest: path.join(projectRoot, 'state', 'stop-request'),
  disabledFlag: path.join(projectRoot, 'state', 'disabled'),
  autofillCheck: path.join(projectRoot, 'state', 'autofill-check.json'),
  cashoutState: path.join(projectRoot, 'state', 'cashout.json'),
  relayConfig: path.join(projectRoot, 'relay.local.json'), // secrets: never log / print
  tdxConfig: path.join(projectRoot, 'tdx.local.json'), // 小精靈帶路 TDX client id/secret: never log / print
};
if (serviceRole === 'operations') {
  for (const key of Object.keys(paths)) {
    if (!['config', 'relayConfig', 'tdxConfig'].includes(key)) paths[key] = paths[key].replace(projectRoot, runtimeRoot);
  }
}

export function loadConfig(file = paths.config, { runtime = false } = {}) {
  const cfg = readJson(file);
  const required = ['intervalMinutes', 'overlapMinutes', 'firstRunMinutes', 'brands', 'telegram', 'chrome'];
  for (const key of required) if (cfg[key] === undefined) throw new Error(`config.json 缺少 ${key}`);
  for (const b of cfg.brands) {
    if (!b.key || !b.name || !b.uiBase || !b.apiBase) throw new Error(`config.json 品牌設定不完整：${JSON.stringify(b.key)}`);
    if (!(Number(b.threshold) > 0)) throw new Error(`config.json 品牌 ${b.key} 的 threshold 必須是正數`);
    if (b.cashout) {
      const d = b.cashout.dealers;
      if (!Array.isArray(d) || !d.length || d.some((x) => typeof x !== 'string' || !x.trim())) throw new Error(`config.json 品牌 ${b.key} 的 cashout.dealers 必須是幣商暱稱清單`);
      if (!(Number(b.cashout.twdRate) > 0)) throw new Error(`config.json 品牌 ${b.key} 的 cashout.twdRate 必須是正數`);
    }
  }
  cfg.chrome.profileDir = path.resolve(projectRoot, cfg.chrome.profileDir);
  if (cfg.chatgptWeb?.profileDir) cfg.chatgptWeb.profileDir = path.resolve(projectRoot, cfg.chatgptWeb.profileDir);
  if (cfg.serviceSplit?.enabled && runtime) {
    cfg.relay = { ...cfg.relay, mode: serviceRole };
    if (serviceRole === 'life') cfg.brands = [];
    else {
      cfg.telegram.alertConfigFile = path.join(runtimeRoot, 'telegram.local.json');
      for (const key of ['chatgptWeb', 'grokVideo', 'localMaintenance', 'hiphop', 'grokBuild']) cfg[key] = { ...cfg[key], enabled: false };
    }
  }
  return cfg;
}

/** 小精靈 (alert bot) credentials, read at runtime from the daily_gift config. Never log the token. */
export function loadAlertBot(cfg) {
  const file = cfg.telegram.alertConfigFile;
  const j = readJson(file);
  const token = String(j.botToken || '');
  const chatId = String(j.chatId || '');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d+$/.test(chatId)) throw new Error('小精靈 Telegram 設定不完整（botToken / chatId）');
  return { token, chatId };
}

/** Community bot for a brand, read at runtime from that brand's existing project .env. */
export function loadCommunityBot(brand) {
  const c = brand.community;
  if (!c) return null;
  if (!fs.existsSync(c.envFile)) throw new Error(`找不到 ${brand.name} 社群 bot 設定檔`);
  const env = readEnvFile(c.envFile);
  const token = String(env.TELEGRAM_BOT_TOKEN || '');
  const chatId = String(env.TELEGRAM_CHAT_ID || '');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d+$/.test(chatId)) throw new Error(`${brand.name} 社群 bot 設定不完整`);
  const buttonUrl = env.BUTTON_URL || c.buttonUrl;
  if (!/^https:\/\//.test(buttonUrl || '')) throw new Error(`${brand.name} 社群按鈕網址無效`);
  return { token, chatId, buttonText: c.buttonText, buttonUrl };
}
