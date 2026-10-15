const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const nonce = crypto.randomBytes(24).toString('hex');
const route = `/setup/${nonce}`;
const expectedUsername = 'yingma_songbao_qiezi_bot';
const expectedGroup = '小精靈的日常回報';

function html(message = '') {
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>設定 TG 群組通知</title>
<body style="font:18px system-ui;max-width:560px;margin:50px auto">
<h1>設定小精靈工作回報</h1><p>只會送到本機程式，連線限定 127.0.0.1。Bot token 不會顯示在日誌。</p>
${message ? `<p style="color:#b00">${message}</p>` : ''}
<form method="post" action="${route}"><label for="token">BotFather token</label><br>
<input id="token" name="token" type="password" autocomplete="off" style="width:100%;font-size:18px" required>
<p><button type="submit" style="font-size:18px">驗證並連接群組</button></p></form></body></html>`;
}

async function telegram(token, method, payload = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error('無法連線 Telegram。'); }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok !== true) throw new Error(`Telegram 驗證失敗（HTTP ${response.status}）。`);
  return data.result;
}

async function configure(token) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Bot token 格式不正確。');
  const bot = await telegram(token, 'getMe');
  if (bot.username?.toLowerCase() !== expectedUsername) throw new Error('這不是指定的小精靈 Bot。');
  const updates = await telegram(token, 'getUpdates', { limit: 100, timeout: 0 });
  const chats = updates.flatMap(update => [
    update.message?.chat,
    update.my_chat_member?.chat,
    update.chat_member?.chat,
  ]).filter(Boolean);
  let group = chats.reverse().find(chat => chat.title === expectedGroup && ['group', 'supergroup'].includes(chat.type));
  if (!group) {
    try {
      const found = await telegram(token, 'getChat', { chat_id: '-5445135326' });
      if (found.title === expectedGroup && ['group', 'supergroup'].includes(found.type)) group = found;
    } catch { /* the web peer ID can differ from the Bot API chat ID */ }
  }
  if (!group) throw new Error(`尚未取得群組訊息（Bot 收到 ${updates.length} 則更新）。請在群組傳送 /start@yingma_songbao_qiezi_bot 後重試。`);
  const chatId = String(group.id);
  await telegram(token, 'sendMessage', {
    chat_id: chatId,
    text: '✅ 小精靈工作回報：群組通知已連接成功。每日新手禮包完成或異常後會在這裡回報。',
  });

  const file = path.join(root, 'telegram.local.json');
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ botToken: token, chatId, botUsername: bot.username, groupName: expectedGroup }, null, 2) + '\n', { mode: 0o600 });
  const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const acl = spawnSync('icacls.exe', [temp, '/inheritance:r', '/grant:r', `${account}:F`], { windowsHide: true, encoding: 'utf8' });
  if (acl.status !== 0) {
    fs.rmSync(temp, { force: true });
    throw new Error('本機設定檔權限無法鎖定，尚未儲存 Bot token。');
  }
  fs.renameSync(temp, file);
  return chatId;
}

const server = http.createServer(async (request, response) => {
  if (request.url !== route || !['GET', 'POST'].includes(request.method)) {
    response.writeHead(404).end('Not found'); return;
  }
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html());
    return;
  }
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2000) { response.writeHead(413).end('Too large'); return; }
  }
  const token = new URLSearchParams(body).get('token') || '';
  try {
    const chatId = await configure(token);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(`<meta charset="utf-8"><h1>✅ TG 群組通知已連接</h1><p>${expectedGroup}（${chatId}）已收到測試訊息。</p>`);
    console.log('CONFIGURED');
    setTimeout(() => server.close(), 1000);
  } catch (error) {
    response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html(error.message));
    console.log(`SETUP_FAILED: ${error.message}`);
  }
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`SETUP_URL=http://127.0.0.1:${port}${route}`);
});
setTimeout(() => server.close(), 10 * 60 * 1000).unref();
