// 小精靈回報：排程跑完、機台資料發到遊戲群之後，把結果回報到用戶的私人通知群。
// 用法（由 scripts/run-scheduled.ps1 呼叫）：
//   node src/ops-notify.mjs --project atg|shuangbao [--dry]
// 環境變數：RUN_STARTED_AT（本輪開始的 ISO 時間）、RUN_EXIT_CODE（主程式結束碼）
// 設定來源：OPS_TG_BOT_TOKEN / OPS_TG_CHAT_ID，沒有就讀 OPS_TG_CONFIG 或小精靈共用的 telegram.local.json。
// 群組只保留最新一則：發出新的回報後，刪掉同一天這支程式之前發過的回報。
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const DEFAULT_CONFIG = 'C:\\Users\\User\\Documents\\ChatGPT\\神殿守望者\\telegram.local.json';
const PROJECTS = {
  atg: '贏麻了選台小助手',
  shuangbao: '爽爆機台狙擊手',
};
const lastRunPath = path.join(projectRoot, 'logs', 'last-run.json');
const statePath = path.join(projectRoot, 'state', 'ops-notify.json');
const logPath = path.join(projectRoot, 'logs', 'ops-notify.log');

const taipeiDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
});
const taipeiTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
});

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line);
  } catch { /* ignore */ }
  process.stdout.write(line);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

export function loadConfig(env = process.env) {
  const file = readJson(env.OPS_TG_CONFIG || DEFAULT_CONFIG, {});
  const token = env.OPS_TG_BOT_TOKEN || file.botToken || '';
  const chatId = String(env.OPS_TG_CHAT_ID || file.chatId || '');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d+$/.test(chatId)) {
    throw new Error('找不到小精靈的 bot token 或群組 chat ID');
  }
  return { token, chatId };
}

function redact(text, token) {
  let out = String(text ?? '');
  if (token) out = out.replaceAll(token, '[BOT_TOKEN]');
  return out.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '[BOT_TOKEN]').replace(/([?&]t=)[^&\s]+/g, '$1[GAME_TOKEN]');
}

// summary: logs/last-run.json 的內容（可能是舊的或不存在）
export function buildReport({ projectName, summary, runStartedAt, exitCode, now = new Date() }) {
  const started = runStartedAt ? new Date(runStartedAt) : null;
  const fresh = Boolean(
    summary && summary.command === 'run' && summary.finishedAt
      && (!started || new Date(summary.startedAt).getTime() >= started.getTime() - 120000),
  );
  const startLabel = taipeiTime.format(started && !Number.isNaN(started.getTime()) ? started : now);
  const dateLabel = taipeiDate.format(now).slice(5).replace('-', '/');
  const minutes = started ? Math.max(1, Math.round((now.getTime() - started.getTime()) / 60000)) : null;
  const lines = [];

  if (!fresh) {
    lines.push(`❌ ${projectName}｜${dateLabel} ${startLabel} 排程失敗`);
    lines.push(`程式中途結束，沒有產生本輪結果（結束碼 ${exitCode ?? '未知'}），機台資料應該沒有發到遊戲群。`);
    lines.push('請看 logs\\bot.log 和 logs\\schedule-console.log。');
    return { level: 'failed', text: lines.join('\n') };
  }

  const games = Array.isArray(summary.games) ? summary.games : [];
  const sent = Array.isArray(summary.sent) ? summary.sent : [];
  const sentGames = new Set(sent.map((item) => item.game));
  let problems = 0;
  const gameLines = games.map((item) => {
    if (item.scan && item.scan.ok === false) {
      problems += 1;
      return `・${item.game}：掃描失敗，沒有發（${item.scan.error || '原因不明'}）`;
    }
    if (!item.rooms) return `・${item.game}：沒有符合條件的台，這款沒發`;
    if (sentGames.has(item.game)) return `・${item.game}：已發到遊戲群，${item.rooms} 台`;
    problems += 1;
    return `・${item.game}：找到 ${item.rooms} 台，但發送未確認`;
  });

  if (summary.ok === false) {
    lines.push(`❌ ${projectName}｜${dateLabel} ${startLabel} 排程失敗`);
    lines.push(`錯誤：${summary.error || '原因不明'}`);
    if (sent.length) lines.push(`失敗前已發出 ${sent.length} 則到遊戲群。`);
    if (gameLines.length) lines.push(...gameLines);
    return { level: 'failed', text: lines.join('\n') };
  }

  const level = problems ? 'partial' : 'ok';
  const recovered = Boolean(summary.recovery?.completedAt);
  lines.push(level === 'ok'
    ? `✅ ${projectName}｜${dateLabel} ${startLabel} ${recovered ? '補發完成' : '排程完成'}`
    : `⚠️ ${projectName}｜${dateLabel} ${startLabel} 部分完成`);
  lines.push(...gameLines);
  const tail = [`共掃描 ${summary.scanned ?? '?'} 台空桌，挑出 ${summary.selected ?? '?'} 台，遊戲群收到 ${sent.length} 則`];
  if (recovered) tail.push(`補發於 ${taipeiTime.format(new Date(summary.recovery.completedAt))}`);
  else if (minutes) tail.push(`耗時約 ${minutes} 分鐘`);
  lines.push(tail.join('，') + '。');
  return { level, text: lines.join('\n') };
}

async function tg(config, method, body, fetchImpl) {
  const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let result = {};
  try { result = await response.json(); } catch { /* ignore */ }
  return { response, result };
}

export async function sendAndPrune({ config, text, fetchImpl = fetch, state, now = new Date() }) {
  const { response, result } = await tg(config, 'sendMessage', { chat_id: config.chatId, text: '🧙 神殿守望者：機台巡查結果如下，請依實據擇機。\n' + text, disable_web_page_preview: true }, fetchImpl);
  if (!response.ok || result.ok !== true) {
    throw new Error(`小精靈發送失敗（HTTP ${response.status}，${result.error_code || ''} ${result.description || ''}）`.trim());
  }
  if (String(result.result?.chat?.id) !== config.chatId) throw new Error('回傳的群組跟設定不符');
  const messageId = result.result.message_id;
  const date = taipeiDate.format(now);
  state.sent ||= [];
  const deleted = [];
  const failed = [];
  for (const entry of state.sent) {
    if (entry.chatId !== config.chatId) continue;
    if (entry.date !== date || entry.deleted || !Number.isInteger(entry.messageId)) continue;
    try {
      const del = await tg(config, 'deleteMessage', { chat_id: config.chatId, message_id: entry.messageId }, fetchImpl);
      if (del.result.ok === true || /message to delete not found/i.test(String(del.result.description || ''))) {
        entry.deleted = true;
        delete entry.deleteError;
        deleted.push(entry.messageId);
      } else {
        entry.deleteError = `HTTP ${del.response.status} ${del.result.description || ''}`.trim().slice(0, 200);
        failed.push(entry.messageId);
      }
    } catch (error) {
      entry.deleteError = String(error.message || error).slice(0, 200);
      failed.push(entry.messageId);
    }
  }
  state.sent.push({ date, messageId, chatId: config.chatId, sentAt: now.toISOString() });
  // 只留最近 3 天的紀錄（Telegram 也只讓機器人刪 48 小時內的訊息）。
  const cutoff = now.getTime() - 3 * 86400000;
  state.sent = state.sent.filter((entry) => new Date(entry.sentAt).getTime() >= cutoff);
  return { messageId, deleted, failed };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, statePath);
}

async function main() {
  const args = process.argv.slice(2);
  const key = args[args.indexOf('--project') + 1];
  const projectName = PROJECTS[key];
  if (!projectName) throw new Error('需要 --project atg 或 --project shuangbao');
  const dry = args.includes('--dry');
  const exitCode = process.env.RUN_EXIT_CODE ?? null;
  let summary = null;
  try { summary = readJson(lastRunPath, null); } catch (error) { log(`讀不到 last-run.json：${error.message}`); }
  const report = buildReport({ projectName, summary, runStartedAt: process.env.RUN_STARTED_AT, exitCode });
  if (dry) {
    console.log(report.text);
    log(`小精靈回報試跑（未發送），等級 ${report.level}`);
    return;
  }
  const config = loadConfig();
  const text = redact(report.text, config.token);
  const state = readJson(statePath, { sent: [] });
  const result = await sendAndPrune({ config, text, state });
  saveState(state);
  log(`小精靈回報已發送 ${result.messageId}（${report.level}），刪除舊回報 ${result.deleted.length} 則${result.failed.length ? `，刪除失敗 ${result.failed.length} 則` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    log(`小精靈回報失敗：${redact(error.message || error, process.env.OPS_TG_BOT_TOKEN)}`);
    process.exitCode = 1;
  });
}

