// TDX（交通部運輸資料流通服務）client: OAuth client_credentials token, one shared per-minute rate limit, TTL cache.
// Credentials live only in tdx.local.json (gitignored) and are never logged, echoed or put into error messages.
// Long-lived entries (static stop / route / schedule data, ttl ≥ 6 h) are persisted to `persistFile` so a restart costs no quota.
import fs from 'node:fs';

export const TDX_BASE = 'https://tdx.transportdata.tw/api';
export const TDX_TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
// The key observed on 2026-10-02 answers with x-ratelimit-limit-minute=5, shared by every TDX API (MaaS, geocoding, bus, metro, bike, CWA).
export const TDX_DEFAULT_PER_MINUTE = 5;

export class TdxError extends Error {
  constructor(kind, message, status = null) { super(message); this.name = 'TdxError'; this.kind = kind; this.status = status; }
}

/** tdx.local.json → { clientId, clientSecret, perMinute } ; null when missing or incomplete. Throws on bad JSON. */
export function loadTdxConfig(file) {
  if (!file || !fs.existsSync(file)) return null;
  const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const clientId = String(j.clientId || '').trim(); const clientSecret = String(j.clientSecret || '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, perMinute: Number(j.perMinute) > 0 ? Number(j.perMinute) : TDX_DEFAULT_PER_MINUTE };
}

/** Sliding 60 s window. take() reserves a slot synchronously so concurrent callers never overshoot. */
export function createRateLimiter({ perMinute = TDX_DEFAULT_PER_MINUTE, now = () => Date.now() } = {}) {
  const stamps = []; let blockedUntil = 0;
  const prune = () => { const t = now(); while (stamps.length && t - stamps[0] >= 60e3) stamps.shift(); };
  return {
    available() { prune(); return now() < blockedUntil ? 0 : Math.max(0, perMinute - stamps.length); },
    waitMs() { prune(); const t = now(); const block = Math.max(0, blockedUntil - t); if (stamps.length < perMinute) return block; return Math.max(block, stamps[0] + 60e3 - t); },
    take() { if (this.available() <= 0) return false; stamps.push(now()); return true; },
    block(ms) { blockedUntil = Math.max(blockedUntil, now() + ms); },
  };
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());
export const TDX_PERSIST_MIN_TTL_MS = 6 * 3600e3;

/**
 * get(path, { ttlMs, staleMs, priority, maxWaitMs }) / post(path, body, same options)
 *  - priority 'must' waits up to maxWaitMs for a free slot; 'optional' never waits (throws kind 'rate', caller degrades).
 *  - a fresh cache hit costs nothing; on failure a stale entry younger than staleMs is returned instead.
 *  - peek(key, maxAgeMs) / put(key, value, ttlMs): caller-managed entries (e.g. one StopOfRoute per route out of a batched call).
 */
export function createTdxClient({ credentials, fetchImpl = fetch, now = () => Date.now(), sleep = realSleep, log = null, perMinute, timeoutMs = 12000, base = TDX_BASE, tokenUrl = TDX_TOKEN_URL,
  persistFile = null, persistMaxAgeMs = 14 * 24 * 3600e3, persistDelayMs = 2000 } = {}) {
  const limiter = createRateLimiter({ perMinute: perMinute || credentials?.perMinute || TDX_DEFAULT_PER_MINUTE, now });
  const cache = new Map(); const keep = new Set(); let token = null; let tokenPending = null; let saveTimer = null;
  const counters = { calls: 0, cacheHits: 0, rateLimited: 0, errors: 0, stale: 0 };
  if (persistFile) {
    try { const j = JSON.parse(fs.readFileSync(persistFile, 'utf8')); for (const [k, e] of Object.entries(j?.entries || {})) if (e && Number.isFinite(e.at) && now() - e.at < persistMaxAgeMs) { cache.set(k, { at: e.at, value: e.value }); keep.add(k); } }
    catch { /* first run or unreadable: start empty */ }
  }
  const savePersist = () => {
    saveTimer = null; if (!persistFile) return;
    try { const entries = {}; for (const k of keep) { const e = cache.get(k); if (e && now() - e.at < persistMaxAgeMs) entries[k] = e; }
      const tmp = `${persistFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ savedAt: now(), entries })); fs.renameSync(tmp, persistFile); }
    catch (error) { log?.warn(`tdx cache save failed: ${error.message}`); }
  };
  const store = (key, value, ttlMs) => {
    cache.set(key, { at: now(), value });
    if (persistFile && ttlMs >= TDX_PERSIST_MIN_TTL_MS) { keep.add(key); if (!saveTimer) { saveTimer = setTimeout(savePersist, persistDelayMs); saveTimer.unref?.(); } }
    if (cache.size > 400) { const k = cache.keys().next().value; cache.delete(k); keep.delete(k); }
  };
  const withTimeout = async (url, init) => {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs); timer.unref?.();
    try { return await fetchImpl(url, { ...init, signal: ctrl.signal }); }
    catch (error) { throw new TdxError(error?.name === 'AbortError' ? 'timeout' : 'network', error?.name === 'AbortError' ? 'TDX 連線逾時' : 'TDX 連線失敗'); }
    finally { clearTimeout(timer); }
  };
  async function getToken(force = false) {
    if (!credentials) throw new TdxError('config', 'TDX 金鑰尚未設定（tdx.local.json）');
    if (!force && token && token.exp - 120e3 > now()) return token.value;
    if (tokenPending) return tokenPending;
    tokenPending = (async () => {
      const r = await withTimeout(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: credentials.clientId, client_secret: credentials.clientSecret }).toString() });
      let j = null; try { j = await r.json(); } catch { /* not json */ }
      if (!r.ok || !j?.access_token) throw new TdxError('auth', `TDX 驗證失敗（HTTP ${r.status}）`, r.status);
      token = { value: j.access_token, exp: now() + (Number(j.expires_in) || 3600) * 1000 };
      return token.value;
    })();
    try { return await tokenPending; } finally { tokenPending = null; }
  }
  async function slot(priority, maxWaitMs) {
    if (limiter.take()) return;
    if (priority === 'must') {
      const wait = limiter.waitMs();
      if (wait <= maxWaitMs) { await sleep(wait + 50); if (limiter.take()) return; }
    }
    counters.rateLimited++;
    throw Object.assign(new TdxError('rate', 'TDX 每分鐘查詢額度已滿'), { retryAfterSec: Math.max(1, Math.ceil(limiter.waitMs() / 1000)) });
  }
  async function fetchJson(path, priority, maxWaitMs, body = null, retried = false, skipSlot = false) {
    if (!skipSlot) await slot(priority, maxWaitMs);
    const tok = await getToken();
    counters.calls++;
    const headers = { authorization: `Bearer ${tok}`, accept: 'application/json', 'accept-encoding': 'gzip, br' };
    const init = body == null ? { headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) };
    let r;
    // a dropped keep-alive socket (idle > ~60 s) fails before the request is served → one immediate retry on the same slot
    try { r = await withTimeout(`${base}${path}`, init); }
    catch (error) { if (error?.kind === 'network' && !retried) { await sleep(300); return fetchJson(path, priority, maxWaitMs, body, true, true); } throw error; }
    if (r.status === 429) {
      // the server-side window is shared with anything else using this key; honour its reset
      const reset = Number(r.headers?.get?.('ratelimit-reset')); const waitMs = (reset > 0 && reset <= 120 ? reset : 60) * 1000; limiter.block(waitMs);
      counters.rateLimited++;
      if (priority === 'must' && !retried && waitMs <= maxWaitMs) { await sleep(waitMs + 200); return fetchJson(path, priority, maxWaitMs, body, true); }
      throw Object.assign(new TdxError('rate', 'TDX 每分鐘查詢額度已滿', 429), { retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) });
    }
    if (r.status === 401 && !retried) { token = null; await getToken(true); return fetchJson(path, priority, maxWaitMs, body, true); }
    if (r.status === 401 || r.status === 403) throw new TdxError('forbidden', `TDX 無權限存取此服務（HTTP ${r.status}）`, r.status);
    if (!r.ok) throw new TdxError('http', `TDX 回應錯誤（HTTP ${r.status}）`, r.status);
    try { return await r.json(); } catch { throw new TdxError('parse', 'TDX 回應格式錯誤'); }
  }
  async function request(key, path, body, { ttlMs = 0, staleMs = 0, priority = 'optional', maxWaitMs = 15000 } = {}) {
    const hit = cache.get(key); const t = now();
    if (hit && t - hit.at < ttlMs) { counters.cacheHits++; return hit.value; }
    try {
      const value = await fetchJson(path, priority, maxWaitMs, body);
      if (ttlMs > 0 || staleMs > 0) store(key, value, Math.max(ttlMs, staleMs));
      return value;
    } catch (error) {
      if (hit && t - hit.at < Math.max(ttlMs, staleMs)) { counters.stale++; return hit.value; }
      counters.errors++;
      if (log && error.kind !== 'rate') log.warn(`tdx ${path.split('?')[0]} failed: ${error.kind || 'error'} ${error.message}`);
      throw error instanceof TdxError ? error : new TdxError('error', 'TDX 查詢失敗');
    }
  }
  return {
    limiter, counters,
    available: () => limiter.available(),
    get: (path, opts) => request(path, path, null, opts),
    post: (path, body, opts) => request(`POST ${path} ${JSON.stringify(body)}`, path, body, opts),
    peek(key, maxAgeMs) { const hit = cache.get(key); if (hit && now() - hit.at < maxAgeMs) { counters.cacheHits++; return hit.value; } return undefined; },
    put(key, value, ttlMs = 0) { store(key, value, ttlMs); },
    flush() { if (saveTimer) { clearTimeout(saveTimer); savePersist(); } },
  };
}