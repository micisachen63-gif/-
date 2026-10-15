import fs from 'node:fs';
import path from 'node:path';
import {root} from './util.js';
import {protect, unprotect} from './secrets.js';

// Google upload goes through the user's own Apps Script web app (apps-script\Code.gs).
// Its URL and shared secret are stored DPAPI-encrypted in .auth\webapp.dpapi.txt (this Windows account
// only) and are never printed or written to logs.
const FILE = path.join(root, '.auth', 'webapp.dpapi.txt');

/** One-time setup: read {"url": "...", "secret": "..."} from a temp file, encrypt, store, delete the temp file. */
export async function setupWebapp(input, {keep = false} = {}) {
  if (!input || !fs.existsSync(input)) throw new Error('請用 --file 指定含 url 與 secret 的暫存 JSON 檔');
  let v;
  try { v = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('暫存檔不是正確的 JSON'); }
  const url = String(v.url || '').trim(), secret = String(v.secret || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('url 必須是 https://script.google.com/macros/s/…/exec');
  if (secret.length < 32) throw new Error('secret 太短（至少 32 字元）');
  fs.mkdirSync(path.dirname(FILE), {recursive: true});
  fs.writeFileSync(FILE, await protect(JSON.stringify({url, secret})), 'utf8');
  if (!keep) fs.rmSync(input, {force: true});
  console.log(`已加密儲存網頁應用程式設定（${path.relative(root, FILE)}）${keep ? '' : '，暫存檔已刪除'}。`);
  const c = await client();
  const r = await c.call('ping');
  console.log(`連線測試成功（腳本版本 ${r.version}）。`);
}

export async function client() {
  if (!fs.existsSync(FILE)) throw new Error('尚未設定上傳用的網頁應用程式：請先執行 node src\\index.js webapp-setup --file <暫存檔>');
  const {url, secret} = JSON.parse(await unprotect(fs.readFileSync(FILE, 'utf8')));
  const hide = (s) => String(s ?? '').split(secret).join('***').split(url).join('<web app>');
  return {
    async call(action, body = {}, {timeoutMs = 360000, retries = 1} = {}) {
      for (let attempt = 0; ; attempt++) {
        try {
          // Apps Script answers POST /exec with a 302 to the result URL; fetch follows it with GET.
          const res = await fetch(url, {method: 'POST', headers: {'content-type': 'text/plain;charset=utf-8'}, body: JSON.stringify({...body, action, secret}), redirect: 'follow', signal: AbortSignal.timeout(timeoutMs)});
          const text = await res.text();
          let j;
          try { j = JSON.parse(text); } catch { throw new Error(`網頁應用程式沒有回傳 JSON（HTTP ${res.status}）。請確認部署時「誰可以存取」選了「所有人」，且網址是最新的部署`); }
          if (!j.ok) { const e = new Error(`網頁應用程式回報錯誤：${j.error}`); e.final = true; throw e; }
          return j;
        } catch (e) {
          if (e.final || attempt >= retries) throw new Error(hide(e.message));
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    },
  };
}
