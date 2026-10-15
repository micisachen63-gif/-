import { scrubCreds } from './creds.js';
import { AuthError } from './errors.js';
import { fmtApiTime, sleep, withTimeout } from './util.js';

const BLANK_PATH = '/__bigwin_blank__';

/**
 * Talks to one brand's admin API from inside Chrome (cookie auth, same as the admin UI).
 * API calls run from a synthetic blank document on the :9955 origin (served by page.route, never
 * hitting the server), so the SPA itself is not loaded and CORS/cookies behave like the real UI.
 */
export class BrandClient {
  constructor({ brand, getContext, log, requestTimeoutMs = 150000, getCredentials = null, loginWaitMs = 1500 }) {
    this.brand = brand;
    this.getCredentials = getCredentials;
    this.loginWaitMs = loginWaitMs;
    this.getContext = getContext;
    this.log = log;
    this.requestTimeoutMs = requestTimeoutMs;
    this.page = null;
  }

  async #apiPage() {
    if (this.page && !this.page.isClosed()) return this.page;
    const ctx = await this.getContext();
    const page = await ctx.newPage();
    const blankUrl = this.brand.uiBase + BLANK_PATH;
    await page.route(blankUrl, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>bigwin</title>' }));
    await page.goto(blankUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    this.page = page;
    return page;
  }

  async closePage() {
    const p = this.page;
    this.page = null;
    if (p && !p.isClosed()) await p.close().catch(() => {});
  }

  async api(path, body) {
    const page = await this.#apiPage();
    const url = this.brand.apiBase + path;
    let r;
    try {
      r = await withTimeout(page.evaluate(async ({ url, body, timeoutMs }) => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
          return { http: res.status, text: await res.text() };
        } catch (error) {
          return { fetchError: String(error && error.name === 'TimeoutError' ? 'request timeout' : error) };
        }
      }, { url, body, timeoutMs: this.requestTimeoutMs }), this.requestTimeoutMs + 20000, `${this.brand.key} ${path}`);
    } catch (error) {
      await this.closePage(); // page may be wedged or crashed: recreate next time
      throw error;
    }
    if (r.fetchError) throw new Error(`${path}: ${r.fetchError}`);
    let json = null;
    try { json = JSON.parse(r.text); } catch { /* handled below */ }
    if (r.http === 401 || r.http === 419 || json?.status === 401 || /unauthori[sz]ed/i.test(json?.msg || '')) {
      throw new AuthError(`${path}: ${json?.msg || 'HTTP ' + r.http}`);
    }
    if (!json) throw new Error(`${path}: HTTP ${r.http} non-JSON response`);
    if (json.status !== 2) throw new Error(`${path}: API status ${json.status} ${String(json.msg || '').slice(0, 120)}`);
    return json.data;
  }

  /** One page of bets. pay:0 on purpose — the payout threshold is applied locally. */
  async fetchBets({ start, stop, page, limit }) {
    const data = await this.api('/api/gameSTMT/searchAccountSTMT', {
      page, limit, a_id: null, start: fmtApiTime(start), stop: fmtApiTime(stop), pay: 0, vendor_id: null,
    });
    if (!data || !Array.isArray(data.data)) throw new Error('searchAccountSTMT: unexpected response shape');
    return { rows: data.data, lastPage: data.last_page, total: data.total };
  }

  /** Exact a_id match (the backend search is a substring search). Only non-sensitive fields are kept. */
  async lookupPlayer(aid) {
    const data = await this.api('/api/player/list', { searchBy: '0', searchContent: String(aid), limit: 50, page: 1 });
    const p = (data?.data || []).find((x) => String(x.a_id) === String(aid));
    if (!p) return null;
    return { nickname: p.nickname ?? null, money: p.money, totalCharge: p.total_charge, vip: p.vip ?? null };
  }

  /** 平台報表 → 收贈禮統計 → 贈禮排行 (one page). date: 'YYYY-MM-DD' (Taipei). */
  async fetchGiftRank({ date, page = 1, limit = 5000 }) {
    const data = await this.api('/api/platformSTMT/txnRank', {
      start: date, stop: date, toaId: null, fromaId: null, toStatus: '', fromStatus: '', limit, page,
    });
    if (!data || !Array.isArray(data.data)) throw new Error('txnRank: unexpected response shape');
    return { rows: data.data, total: data.total, perPage: data.per_page };
  }

  /** 平台報表 → 儲值排行 for one day (all VIP levels). Rows keep a_id / nickname / price (= 儲值金額). */
  async fetchPurchaseRank({ date }) {
    const d = date.replace(/-/g, '/');
    const data = await this.api('/api/platformSTMT/purchaseRank', { start: d, stop: d, vip: 0 });
    if (!data || typeof data !== 'object') throw new Error('purchaseRank: unexpected response shape');
    return Object.values(data).map((r) => ({ a_id: r.a_id, nickname: r.nickname ?? null, price: r.price }));
  }

  async checkSession() {
    await this.api('/api/player/list', { searchBy: '0', searchContent: '0', limit: 1, page: 1 });
    return true;
  }

  /** true = logged in, false = backend says 401; other errors propagate. */
  async #sessionOk() {
    try {
      await this.checkSession();
      return true;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      return false;
    }
  }

  /**
   * Re-login. Primary: shared DPAPI credentials typed into the login form (Chrome autofill does not
   * fire for CDP/Playwright clicks). Fallback only when decryption fails: the old click-to-autofill path.
   */
  async relogin() {
    let creds = null;
    let credError = null;
    if (this.getCredentials) {
      try { creds = await this.getCredentials(this.brand); } catch (error) { credError = String(error?.message || error); }
    }
    if (creds) {
      try {
        return await this.#typedLogin(creds);
      } finally {
        creds = null;
      }
    }
    if (credError) this.log?.warn?.(`${credError}; falling back to Chrome autofill`);
    const r = await this.#autofillLogin();
    if (!r.ok && credError) r.reason = `${credError}；自動填入：${r.reason}`;
    return r;
  }

  /** Empties both login fields (done before closing the page / any screenshot). */
  static async clearLoginFields(page) {
    await page.evaluate(() => {
      for (const sel of ['#login_account', '#login_password']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }

  /** At most 2 rounds (lockout safety): reload login page, clear + type both fields, verify, click 登入 once. */
  async #typedLogin(creds, maxRounds = 2) {
    let lastReason = '未知錯誤';
    for (let round = 1; round <= maxRounds; round++) {
      let page;
      try {
        const ctx = await this.getContext();
        page = await ctx.newPage();
        await page.goto(this.brand.uiBase + '/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
        const account = page.locator('#login_account');
        const password = page.locator('#login_password');
        const visible = await account.waitFor({ state: 'visible', timeout: 30000 }).then(() => true, () => false);
        if (!visible) {
          if (await this.#sessionOk()) return { ok: true, method: 'credentials', note: 'already logged in' };
          lastReason = '找不到登入表單';
          continue;
        }
        await sleep(this.loginWaitMs);
        for (const [field, value] of [[account, creds.username], [password, creds.password]]) {
          await field.click();
          await field.fill('');
          await page.keyboard.press('Control+A');
          await page.keyboard.press('Backspace');
          await page.keyboard.type(value, { delay: 40 });
        }
        const len = await page.evaluate(() => ({
          u: (document.querySelector('#login_account')?.value || '').length,
          p: (document.querySelector('#login_password')?.value || '').length,
        }));
        if (len.u !== creds.username.length || len.p !== creds.password.length) {
          lastReason = `輸入後欄位內容不完整（帳號${len.u ? '有' : '空'}／密碼${len.p ? '有' : '空'}），未送出`;
          continue;
        }
        await page.locator('button[type=submit]').first().click();
        let left = false;
        for (let i = 0; i < 20 && !left; i++) {
          await sleep(this.loginWaitMs);
          left = !/\/login(\b|$)/.test(page.url());
        }
        if (left) {
          for (let i = 0; i < 5; i++) {
            if (await this.#sessionOk()) return { ok: true, method: 'credentials', rounds: round };
            await sleep(this.loginWaitMs);
          }
          lastReason = '已離開登入頁，但 API 仍回報未登入';
        } else {
          lastReason = '按下登入後仍停在登入頁（帳密可能錯誤或需要驗證）';
        }
      } catch (error) {
        lastReason = scrubCreds(error?.message || error, creds).split('\n')[0].slice(0, 200);
      } finally {
        if (page) {
          await BrandClient.clearLoginFields(page).catch(() => {});
          await page.close().catch(() => {});
        }
      }
      this.log?.warn?.(`credential login round ${round}/${maxRounds} failed: ${lastReason}`);
    }
    return { ok: false, method: 'credentials', reason: `帳密登入失敗：${lastReason}` };
  }

  /**
   * Old fallback: open the login page, click the account field so Chrome autofills saved
   * credentials, press 登入. Never submits an empty/partial form.
   */
  async #autofillLogin() {
    let page;
    try {
      const ctx = await this.getContext();
      page = await ctx.newPage();
      await page.goto(this.brand.uiBase + '/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
      const account = page.locator('#login_account');
      await account.waitFor({ state: 'visible', timeout: 30000 });
      await sleep(this.loginWaitMs);
      await account.click();
      await sleep(this.loginWaitMs);
      const filled = await page.evaluate(() => ({
        user: (document.querySelector('#login_account')?.value || '').length > 0,
        pass: (document.querySelector('#login_password')?.value || '').length > 0,
      }));
      if (!filled.user || !filled.pass) return { ok: false, method: 'autofill', reason: `Chrome 沒有自動填入帳密（帳號${filled.user ? '有' : '空'}／密碼${filled.pass ? '有' : '空'}）` };
      await page.locator('button[type=submit]').first().click();
      for (let i = 0; i < 20; i++) {
        await sleep(this.loginWaitMs);
        if (await this.#sessionOk()) return { ok: true, method: 'autofill' };
      }
      return { ok: false, method: 'autofill', reason: '按下登入後仍未登入（帳密可能已變更）' };
    } catch (error) {
      return { ok: false, method: 'autofill', reason: error.message };
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
}
