import fs from 'node:fs';
import { loadAlertBot, loadConfig, paths } from './config.js';
import { loadRelayConfig, splitText, TG_TEXT_LIMIT } from './relay.js';
import { sendVerified, createTelegramApi } from './telegram.js';
import { redact } from './util.js';

/**
 * Assistant → private group via 小精靈 (sendMessage only; safe while the service is running).
 * node src/tg-say.js --agent 機台數據 --file reply.txt [--reply-to <message_id>]
 */
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') a.agent = argv[++i];
    else if (argv[i] === '--file') a.file = argv[++i];
    else if (argv[i] === '--reply-to') a.replyTo = Number(argv[++i]);
    else throw new Error(`未知參數 ${argv[i]}`);
  }
  if (!a.file) throw new Error('用法：node src/tg-say.js --agent 機台數據 --file <utf8 文字檔> [--reply-to <message_id>]');
  if (a.replyTo !== undefined && !(Number.isInteger(a.replyTo) && a.replyTo > 0)) throw new Error('--reply-to 必須是訊息編號');
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let agent = String(args.agent || '').trim();
  if (!agent) { try { agent = loadRelayConfig(paths.relayConfig)?.default || '機台數據'; } catch { agent = '機台數據'; } }
  const body = fs.readFileSync(args.file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new Error('檔案是空的');
  const bot = loadAlertBot(loadConfig());
  const api = createTelegramApi(bot.token);
  const chunks = splitText(`🤖 ${agent}：${body}`, TG_TEXT_LIMIT);
  for (let i = 0; i < chunks.length; i++) {
    const msg = await sendVerified(api, bot.chatId, {
      text: chunks[i],
      disable_web_page_preview: true,
      ...(i === 0 && args.replyTo ? { reply_to_message_id: args.replyTo, allow_sending_without_reply: true } : {}),
    });
    process.stdout.write(`SENT ${msg.message_id}\n`);
  }
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`FAILED ${redact(error?.message || error)}\n`);
  process.exit(1);
});
