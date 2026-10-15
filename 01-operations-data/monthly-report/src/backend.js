import path from 'node:path';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {root} from './util.js';
import {backendCredentials, redact} from './secrets.js';

// Read-only access to the admin APIs (:9032) through this program's OWN Chrome profile
// (.auth\chrome, headless). Same cookie-auth technique as 爆分監控: requests run with fetch()
// from a synthetic blank page on the admin UI origin, so CORS/cookies behave like the admin UI.
// Only query endpoints are called. No other browser/profile/port is ever touched.

const BLANK = '/__monthly_deck_blank__';
const USER_FIELDS = 'input[type=text]:visible,input[type=email]:visible,input:not([type]):visible';
const PASSWORD_FIELDS = 'input[type=password]:visible';

export class AuthError extends Error {}

export async function openProfile(cfg, {headed = false} = {}) {
  const dir = path.resolve(root, cfg.profileDir);
  fs.mkdirSync(dir, {recursive: true});
  const headless = headed ? false : cfg.headless !== false;
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync'];
  if (!headless) args.push('--window-position=-32000,-32000', '--window-size=1400,900'); // off-screen
  return chromium.launchPersistentContext(dir, {executablePath: cfg.chrome, headless, args, viewport: {width: 1400, height: 900}});
}

export class BrandApi {
  constructor(context, key, brand, cfg, log = () => {}) {
    Object.assign(this, {context, key, brand, cfg, log});
    this.page = null;
    this.timeoutMs = cfg.api?.requestTimeoutMs || 150000;
  }

  async #apiPage() {
    if (this.page && !this.page.isClosed()) return this.page;
    const page = await this.context.newPage();
    const url = this.brand.uiBase + BLANK;
    await page.route(url, (r) => r.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>monthly-deck</title>'}));
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});
    this.page = page;
    return page;
  }

  /** Raw POST; returns {http, json}. Never throws on API status. */
  async raw(p, body) {
    const page = await this.#apiPage();
    const r = await page.evaluate(async ({url, body, timeoutMs}) => {
      try {
        const res = await fetch(url, {method: 'POST', credentials: 'include', headers: {'content-type': 'application/json', accept: 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)});
        return {http: res.status, text: await res.text()};
      } catch (e) { return {fetchError: String(e?.name === 'TimeoutError' ? 'request timeout' : e)}; }
    }, {url: this.brand.apiBase + p, body, timeoutMs: this.timeoutMs});
    if (r.fetchError) throw new Error(`${this.brand.name} ${p}: ${r.fetchError}`);
    let json = null;
    try { json = JSON.parse(r.text); } catch {}
    return {http: r.http, json};
  }

  async api(p, body) {
    const {http, json} = await this.raw(p, body);
    if (http === 401 || http === 419 || json?.status === 401 || /unauthori[sz]ed/i.test(json?.msg || '')) throw new AuthError(`${this.brand.name} ${p}: 未登入`);
    if (!json) throw new Error(`${this.brand.name} ${p}: HTTP ${http}，非 JSON 回應`);
    if (json.status !== 2) throw new Error(`${this.brand.name} ${p}: API status ${json.status} ${String(json.msg || '').slice(0, 120)}`);
    return json.data;
  }

  async checkSession() {
    await this.api('/player/list', {searchBy: '0', searchContent: '0', limit: 1, page: 1});
  }

  /** Ensure a logged-in session (log in with the DPAPI credentials when needed). */
  async ensureSession() {
    try { await this.checkSession(); return 'session-ok'; }
    catch (e) { if (!(e instanceof AuthError)) throw e; }
    await this.login();
    await this.checkSession();
    return 'logged-in';
  }

  async login() {
    const page = await this.context.newPage();
    let pair = null;
    try {
      await page.goto(this.brand.uiBase + '/', {waitUntil: 'domcontentloaded', timeout: 60000});
      await page.waitForLoadState('networkidle', {timeout: 20000}).catch(() => {});
      await page.waitForTimeout(1000);
      if (!(await page.locator(PASSWORD_FIELDS).count())) return; // already logged in (session restored)
      pair = await backendCredentials(this.brand.credentialKey || this.key, this.cfg.credentialsFile);
      const user = page.locator(USER_FIELDS).first(), pass = page.locator(PASSWORD_FIELDS).first();
      if (!(await page.locator(USER_FIELDS).count())) throw new Error(`${this.brand.name} 登入頁找不到帳號欄位`);
      for (const [f, v] of [[user, pair.username], [pass, pair.password]]) { await f.click(); await f.fill(''); await page.keyboard.type(v, {delay: 30}); }
      const lens = [await user.evaluate((e) => e.value.length), await pass.evaluate((e) => e.value.length)];
      if (lens[0] !== pair.username.length || lens[1] !== pair.password.length) throw new Error(`${this.brand.name} 帳密沒有正確輸入欄位`);
      const btn = page.getByRole('button', {name: '登入', exact: true});
      await btn.waitFor({state: 'visible', timeout: 10000});
      await btn.click();
      await page.waitForLoadState('networkidle', {timeout: 30000}).catch(() => {});
      await page.waitForTimeout(1500);
      if (await page.locator(PASSWORD_FIELDS).count()) throw new Error(`${this.brand.name} 已按登入，但仍停在登入頁`);
      this.log(`${this.brand.name}：已用加密帳密登入`);
    } catch (e) {
      throw new Error(redact(e?.message, pair));
    } finally {
      await page.evaluate(() => { for (const i of document.querySelectorAll('input')) i.value = ''; }).catch(() => {});
      await page.close().catch(() => {});
    }
  }

  // ---------- report queries (read-only) ----------

  /** 平台報表 → 儲值排行. start/stop 'YYYY-MM-DD' inclusive. Rows: {a_id, nickname, price, ...}. */
  async purchaseRank(start, stop) {
    const s = (d) => d.replace(/-/g, '/');
    const data = await this.api('/platformSTMT/purchaseRank', {start: s(start), stop: s(stop), vip: 0});
    if (!data || typeof data !== 'object') throw new Error('purchaseRank：回應格式不符');
    return Object.values(data);
  }

  /** 遊戲報表 → 遊戲數據 → 機台總覽 (all vendors, all sources). */
  async machineOverview(start, stop) {
    const fmt = this.cfg.api?.vendorGameDateFormat || 'YYYY-MM-DD HH:mm:ss';
    const body = {advertiserId: null, start: formatDate(start, '00:00:00', fmt), stop: formatDate(stop, '23:59:59', fmt)};
    const data = await this.api('/gameSTMT/vendorGameSTMT', body);
    if (!Array.isArray(data)) throw new Error('vendorGameSTMT：回應格式不符');
    return data;
  }

  /** Game catalogue (for machine pictures). */
  async gameList() {
    const data = await this.api('/gameSTMT/gameList', {});
    const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    return rows.map((g) => ({id: g.id, vendor_id: g.vendor_id, name: g.name, pic_small: g.pic_small, pic_large: g.pic_large}));
  }

  /** 平台報表 → 儲值統計 (daily; advertiserId 0 = 全部渠道, platform '-1' = 全部平台). {date: {_1:{_3:DAU}, _2:{_15:首儲總額}, _5:{_1:首儲人數,_2:筆數,_3:金額,_4:DPU}}} */
  async dailyPurchase(start, stop) {
    const data = await this.api('/platformSTMT/playerStatsPurchase', {advertiserId: 0, platform: '-1', start, stop});
    if (!data || typeof data !== 'object') throw new Error('playerStatsPurchase：回應格式不符');
    return data;
  }

  /** 平台報表 → X日登 (daily; key "0" = 當日新增). */
  async xLogin(start, stop) {
    const data = await this.api('/platformSTMT/xLoginData', {advertiserId: 0, platform: -1, start, stop});
    if (!data || typeof data !== 'object') throw new Error('xLoginData：回應格式不符');
    return data;
  }

  async #paged(p, body, label) {
    const rows = [];
    for (let page = 1; page <= 50; page++) {
      const d = await this.api(p, {...body, limit: 5000, page});
      if (!d || !Array.isArray(d.data)) throw new Error(`${label}：回應格式不符`);
      rows.push(...d.data);
      if (rows.length >= Number(d.total || 0) || !d.data.length) return rows;
    }
    throw new Error(`${label}：頁數過多`);
  }

  /** 平台報表 → 收贈禮統計 → 贈禮排行 (pairs from→to, give_money / receive_money / rang_money = 差額). */
  async giftRank(start, stop) {
    return this.#paged('/platformSTMT/txnRank', {start, stop, toaId: null, fromaId: null, toStatus: '', fromStatus: ''}, 'txnRank');
  }

  /** 平台報表 → 押碼排行 (per player: bet, effective_bet, pay, range_purchase, all_purchase). */
  async betRank(start, stop) {
    const s = (d) => d.replace(/-/g, '/');
    return this.#paged('/platformSTMT/betRank', {start: s(start), stop: s(stop)}, 'betRank');
  }

  async close() { if (this.page && !this.page.isClosed()) await this.page.close().catch(() => {}); }
}

export function formatDate(iso, time, fmt) {
  const [Y, M, D] = iso.split('-');
  const [h, m, s] = time.split(':');
  return fmt.replace('YYYY', Y).replace('MM', M).replace('DD', D).replace('HH', h).replace('mm', m).replace('ss', s);
}
