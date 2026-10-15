#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentialsPath = process.env.DAILY_GIFT_GOOGLE_CREDENTIALS || path.join(root, 'google-oauth-client.json');
const tokenDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'DailyGiftAutomation');
const tokenPath = path.join(tokenDir, 'google-token.json');
const spreadsheetId = '1Rp-XsnRn3AOoTOE45lRq_jNa1lprVlHfaElsk4ugzaI';
const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

async function main() {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`缺少 Google OAuth 桌面應用程式憑證：${credentialsPath}`);
  }
  const clientJson = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const clientInfo = clientJson.installed || clientJson.web;
  if (!clientInfo?.client_id || !clientInfo?.client_secret) {
    throw new Error('Google OAuth 憑證格式不符，需要桌面應用程式的 client_id 與 client_secret。');
  }
  let auth;
  if (fs.existsSync(tokenPath)) {
    const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    if (saved.client_id !== clientInfo.client_id) throw new Error('Google OAuth 客戶端已更換，請先移除舊授權檔再重新授權。');
    auth = new google.auth.OAuth2(clientInfo.client_id, clientInfo.client_secret);
    auth.setCredentials({ refresh_token: saved.refresh_token });
  } else {
    if (process.argv.includes('--noninteractive')) throw new Error('尚未完成 Google OAuth 授權；排程模式不會跳出登入頁。');
    auth = await authenticate({ scopes, keyfilePath: credentialsPath });
    if (!auth.credentials.refresh_token) throw new Error('Google 未提供可更新的授權；無法供每日排程使用。');
    fs.mkdirSync(tokenDir, { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ client_id: clientInfo.client_id, refresh_token: auth.credentials.refresh_token }) + '\n', { mode: 0o600 });
  }
  const sheets = google.sheets({ version: 'v4', auth });
  const result = await sheets.spreadsheets.get({ spreadsheetId, fields: 'spreadsheetId,properties(title),sheets(properties(title,sheetId))' });
  const names = result.data.sheets?.map(s => s.properties?.title) || [];
  for (const required of ['【茄子】新手禮包', '【爽爆】新手禮包', '【贏麻了】新手禮包']) {
    if (!names.includes(required)) throw new Error(`Google Sheets 授權成功，但找不到「${required}」分頁。`);
  }
  console.log(`Google Sheets 授權成功：${result.data.properties?.title}；找到三個品牌分頁。`);
}

main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
