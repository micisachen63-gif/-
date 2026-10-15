// 社群版 member backend: read-only AID lookups against each brand's admin API (same cookie-auth API calls as 爆分監控),
// in the community bot's OWN headless Chrome profile. Never writes anything to the backend itself; ensureSession /
// relogin are also used by the 自動派獎 mail sender (mail-sender.js) before it opens the /gm/mail form.
import { BrandClient } from '../backend.js';
import { BrowserManager } from '../browser.js';
import { decryptBackendCreds } from '../creds.js';
import { AuthError } from '../errors.js';
import { resolvePeriod } from './conditions.js';

const slash = (iso) => iso.replace(/-/g, '/');
const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

/** Shared Chrome for both brands; closed after `idleMs` without lookups (it is only needed while people sign up). */
export function createBackendBrowser({ executablePath, profileDir, log, idleMs = 15 * 60e3, headless = true }) {
  const mgr = new BrowserManager({ cfg: { chrome: { executablePath, profileDir } }, log, headless });
  let lastUse = 0; let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(async () => { if (Date.now() - lastUse >= idleMs && mgr.ctx) { log.info('backend Chrome idle, closing'); await mgr.ctx.close().catch(() => {}); } }, idleMs + 1000); timer.unref?.(); };
  return {
    getContext: async () => { lastUse = Date.now(); arm(); return mgr.getContext(); },
    close: async () => { clearTimeout(timer); if (mgr.ctx) await mgr.ctx.close().catch(() => {}); },
  };
}

/**
 * VIP as the admin page shows it. The page maps player.vip through the site's GlobalIdToVip table:
 * sites with switcher.isLcVip (winmalo / 贏麻) store VIP 0-6 as 1-7, so the page shows raw - 1;
 * songyy / 爽爆 (isLcVip false) stores VIP 1-6 as-is. brand.vipOffset overrides the table.
 */
export const VIP_OFFSET = { winmalo: -1, songyy: 0 };
export function displayVip(brand, raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw); if (!Number.isFinite(n)) return null;
  return Math.max(0, n + Number(brand?.vipOffset ?? VIP_OFFSET[brand?.key] ?? 0));
}

/**
 * One brand. status(aid, conditions) → { exists, nickname, vip, recharge, wager }.
 * - 會員管理 /api/player/list (exact a_id match) → nickname / VIP
 * - 儲值排行 /api/platformSTMT/purchaseRank (date range) → price
 * - 打碼排行 /api/platformSTMT/betRank (date range, paged) → effective_bet (有效投注)
 * Rank lists are cached per date range for `cacheMs` so a burst of signups costs one query.
 */
export function createMemberBackend({ brand, getContext, log, cacheMs = 60e3, now = Date.now, client = null, getCredentials = (b) => decryptBackendCreds(b), wagerField = 'effective_bet' }) {
  const c = client || new BrandClient({ brand, getContext, log, getCredentials, requestTimeoutMs: 60000 });
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const cache = new Map();
  async function call(path, body) {
    try { return await c.api(path, body); } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      log.info(`${brand.key} backend session expired, logging in`);
      const r = await c.relogin();
      if (!r?.ok) throw new Error(`後台登入失敗：${r?.reason || 'unknown'}`);
      return c.api(path, body);
    }
  }
  const cached = (key, load) => {
    const hit = cache.get(key);
    if (hit && (hit.pending || now() - hit.at < cacheMs)) return hit.promise;
    const entry = { pending: true, at: now() };
    entry.promise = serial(load).then((v) => { entry.pending = false; entry.at = now(); return v; }, (e) => { cache.delete(key); throw e; });
    cache.set(key, entry); return entry.promise;
  };
  async function lookup(aid) {
    const data = await serial(() => call('/api/player/list', { searchBy: '0', searchContent: String(aid), limit: 50, page: 1 }));
    const p = (data?.data || []).find((x) => String(x.a_id) === String(aid));
    return p ? { nickname: p.nickname ?? null, vip: displayVip(brand, p.vip), vipRaw: p.vip == null || p.vip === '' ? null : Number(p.vip) } : null;
  }
  const rechargeMap = ({ start, stop }) => cached(`pr|${start}|${stop}`, async () => {
    const data = await call('/api/platformSTMT/purchaseRank', { start: slash(start), stop: slash(stop), vip: 0 });
    if (!data || typeof data !== 'object') throw new Error('purchaseRank: unexpected response shape');
    const m = new Map(); for (const r of Object.values(data)) m.set(String(r.a_id), (m.get(String(r.a_id)) || 0) + num(r.price)); return m;
  });
  const wagerMap = ({ start, stop }) => cached(`br|${start}|${stop}`, async () => {
    const m = new Map();
    for (let page = 1, last = 1; page <= last && page <= 200; page++) {
      const data = await call('/api/platformSTMT/betRank', { start: slash(start), stop: slash(stop), limit: 2000, page });
      if (!data || !Array.isArray(data.data)) throw new Error('betRank: unexpected response shape');
      for (const r of data.data) m.set(String(r.a_id), (m.get(String(r.a_id)) || 0) + num(r[wagerField] ?? r.bet));
      last = Number(data.last_page) || 1;
    }
    return m;
  });
  async function status(aid, conditions = {}) {
    const p = await lookup(aid);
    if (!p) return { exists: false };
    const out = { exists: true, nickname: p.nickname, vip: p.vip };
    if (conditions.recharge) out.recharge = (await rechargeMap(resolvePeriod(conditions.recharge.period, now()))).get(String(aid)) || 0;
    if (conditions.wager) out.wager = (await wagerMap(resolvePeriod(conditions.wager.period, now()))).get(String(aid)) || 0;
    return out;
  }
  /** logged in (re-login with the shared credentials when the API says 401) — used before the 派獎 mail form */
  const relogin = () => serial(async () => { const r = await c.relogin(); if (!r?.ok) throw new Error(`後台登入失敗：${r?.reason || 'unknown'}`); return true; });
  const ensureSession = () => serial(async () => {
    try { await c.checkSession(); return true; } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      log.info(`${brand.key} backend session expired, logging in`);
      const r = await c.relogin(); if (!r?.ok) throw new Error(`後台登入失敗：${r?.reason || 'unknown'}`); return true;
    }
  });
  return { lookup, status, ensureSession, relogin, close: () => c.closePage() };
}
