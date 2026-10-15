import fs from 'node:fs';
import path from 'node:path';
import { config, gameDefinitions } from './config.js';
import { captureGameUrls, collectRooms, scanStatus } from './site.js';
import { selectRooms } from './rooms.js';
import { formatMessage, sendTelegram, telegramLength } from './telegram.js';

const lastMessagesPath = path.join(config.projectRoot, 'logs', 'last-messages.json');
const lastMessagePath = path.join(config.projectRoot, 'logs', 'last-message.html');
// Machine-readable summary of the latest run; scripts/run-scheduled.ps1 hands it to src/ops-notify.mjs.
const lastRunPath = path.join(config.projectRoot, 'logs', 'last-run.json');
const runState = { startedAt: new Date().toISOString(), command: process.argv[2] ?? 'run', games: [], sent: [] };

function writeLastRun(extra) {
  if (runState.command !== 'run') return;
  try {
    fs.mkdirSync(path.dirname(lastRunPath), { recursive: true });
    const summary = { ...runState, ...extra, finishedAt: new Date().toISOString() };
    fs.writeFileSync(lastRunPath, JSON.stringify(summary, null, 2), 'utf8');
  } catch {
    // Summary is best-effort; never break the main flow.
  }
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.mkdirSync(path.dirname(config.logPath), { recursive: true });
  fs.appendFileSync(config.logPath, line);
  process.stdout.write(line);
}

function saveLastMessages(messages) {
  fs.mkdirSync(path.dirname(lastMessagesPath), { recursive: true });
  const serializable = messages.map(({ game, text, photoPath }) => ({ game, text, photoPath }));
  fs.writeFileSync(lastMessagesPath, JSON.stringify(serializable, null, 2), 'utf8');
  fs.writeFileSync(
    lastMessagePath,
    messages.map((item) => item.text).join('\n\n========\n\n'),
    'utf8',
  );
}

async function sendOne({ text, game, photoPath }) {
  const result = await sendTelegram({
    token: config.token,
    chatId: config.chatId,
    text,
    buttonUrl: config.buttonUrl,
    photoPath,
  });
  log(`已發送「${game}」Telegram 訊息 ${result.message_id}${photoPath ? '（含圖）' : ''}`);
  return result;
}

async function sendSavedMessages(onlyGames = null) {
  if (!fs.existsSync(lastMessagesPath)) {
    throw new Error('沒有上次文案，請先跑一次 dry-run 或 run');
  }
  const messages = JSON.parse(fs.readFileSync(lastMessagesPath, 'utf8'));
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('上次文案是空的，請先跑一次 dry-run 或 run');
  }
  const selected = onlyGames ? messages.filter((item) => onlyGames.includes(item.game)) : messages;
  if (onlyGames && (selected.length !== onlyGames.length || new Set(onlyGames).size !== onlyGames.length)) {
    throw new Error('補發遊戲清單無效或上次文案沒有該遊戲');
  }
  const failures = [];
  for (const item of selected) {
    try { await sendOne(item); }
    catch (error) {
      failures.push(item.game);
      log(`補發「${item.game}」未確認：${String(error.message ?? error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  if (failures.length) throw new Error(`補發未確認：${failures.join('、')}`);
}

function buildPerGameMessages(rooms, games = gameDefinitions) {
  const messages = [];
  for (const game of games) {
    const group = rooms.filter((room) => room.game === game.name);
    if (!group.length) continue;
    const text = formatMessage(group, [game.name]);
    const photoPath = game.image && fs.existsSync(game.image) ? game.image : null;
    if (!photoPath) {
      log(`警告：「${game.name}」找不到圖片 ${game.image}，改發純文字`);
    } else {
      log(`「${game.name}」圖文說明長度 ${telegramLength(text)}／1024`);
    }
    messages.push({ game: game.name, text, photoPath });
  }
  return messages;
}

async function main() {
  const command = process.argv[2] ?? 'run';
  if (command === 'login') {
    await captureGameUrls(config);
    return;
  }
  if (command === 'send-last') {
    const onlyArg = process.argv.find((arg) => arg.startsWith('--only-games='));
    await sendSavedMessages(onlyArg ? onlyArg.slice('--only-games='.length).split(',').map((name) => name.trim()) : null);
    return;
  }
  if (command !== 'run') throw new Error(`不認得命令：${command}`);
  const dryRun = process.argv.includes('--dry-run');
  const onlyArg = process.argv.find((arg) => arg.startsWith('--only-games='));
  const requested = onlyArg?.slice('--only-games='.length).split(',').map((name) => name.trim()) ?? null;
  const selectedGames = requested ? gameDefinitions.filter((game) => requested.includes(game.name)) : gameDefinitions;
  if (requested && (selectedGames.length !== requested.length || new Set(requested).size !== requested.length)) {
    throw new Error('補掃遊戲清單無效');
  }
  const rawRooms = await collectRooms(config, selectedGames);
  const rooms = selectRooms(rawRooms, {
    games: selectedGames.map((game) => game.name),
    minSpins: config.minSpins,
    maxRoomsPerGame: config.maxRooms,
  });
  runState.scanned = rawRooms.length;
  runState.selected = rooms.length;
  runState.games = selectedGames.map((game) => ({
    game: game.name,
    rooms: rooms.filter((room) => room.game === game.name).length,
    scan: scanStatus.find((item) => item.game === game.name) ?? null,
  }));
  log(`略過二次驗證，候選掃描 ${rawRooms.length} 台空桌，挑出 ${rooms.length} 台（每款最多 ${config.maxRooms}）`);
  const messages = buildPerGameMessages(rooms, selectedGames);
  const expectedGames = selectedGames.map((g) => g.name);
  const gotGames = messages.map((m) => m.game);
  const missing = expectedGames.filter((name) => !gotGames.includes(name));
  if (missing.length) {
    log(`警告：本輪缺少遊戲「${missing.join('、')}」（掃描失敗或無符合台），仍發送已有 ${messages.length} 則`);
  }
  saveLastMessages(messages);
  log(`文案已存：${lastMessagesPath}（${messages.length} 則圖文，一款一則）`);
  if (dryRun) {
    for (const item of messages) {
      console.log(item.text.replace(/<\/?b>/g, ''));
      console.log(`圖：${item.photoPath ?? '（無）'}`);
      console.log('\n========\n');
    }
    writeLastRun({ ok: true, dryRun: true });
    log(`試跑完成：掃描 ${rawRooms.length} 台空桌，符合 ${rooms.length} 台，將分 ${messages.length} 則發送（未發送）`);
    return;
  }
  const sendErrors = [];
  for (const item of messages) {
    try {
      const result = await sendOne(item);
      runState.sent.push({ game: item.game, messageId: result.message_id });
    } catch (error) {
      const reason = String(error.message ?? error);
      sendErrors.push({ game: item.game, error: reason.slice(0, 300) });
      log(`「${item.game}」Telegram 發送未確認：${reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  if (sendErrors.length) {
    runState.sendErrors = sendErrors;
    writeLastRun({ ok: false, dryRun: false, error: `${sendErrors.length} 款 Telegram 發送未確認` });
    process.exitCode = 1;
    return;
  }
  writeLastRun({ ok: true, dryRun: false });
  log(`全部發完：${messages.length} 則圖文通知`);
}

main().catch((error) => {
  let message = String(error.message ?? error);
  if (config.token) message = message.replaceAll(config.token, '[BOT_TOKEN]');
  message = message.replace(/([?&]t=)[^&\s]+/g, '$1[GAME_TOKEN]');
  log(`失敗：${message}`);
  writeLastRun({ ok: false, error: message.slice(0, 300) });
  process.exitCode = 1;
});
