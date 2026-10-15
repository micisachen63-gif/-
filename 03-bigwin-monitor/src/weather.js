// Weather for 小精靈帶路 (zero AI): Open-Meteo by coordinates (same source/wording as 上班提醒), with a fallback to
// 中央氣象署鄉鎮預報 through TDX's CWA link service (POST /api/cwa/graphql with the TDX token; it counts against the
// TDX per-minute quota, so it is only tried when Open-Meteo fails). Result: { wx, temp, pop, rainy, source } where
// pop = highest precipitation probability in the next 3 hours. Cached 10 min per 鄉鎮區 (~1 km cell when unknown).
const WMO = { 0: '晴朗', 1: '大致晴朗', 2: '多雲時晴', 3: '陰天', 45: '有霧', 48: '有霧', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '凍雨', 57: '凍雨', 61: '小雨', 63: '下雨', 65: '大雨', 66: '凍雨', 67: '凍雨',
  71: '小雪', 73: '下雪', 75: '大雪', 77: '雪粒', 80: '陣雨', 81: '陣雨', 82: '強陣雨', 85: '陣雪', 86: '陣雪', 95: '雷雨', 96: '雷雨夾冰雹', 99: '強雷雨夾冰雹' };
export const isRainyCode = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
export function weatherEmoji(c) { if (c >= 95) return '⛈️'; if (isRainyCode(c)) return '🌧️'; if (c >= 45 && c <= 48) return '🌫️'; if (c === 3) return '☁️'; if (c === 2) return '⛅'; return '☀️'; }
export const describeWeather = (c) => (WMO[c] ? `${weatherEmoji(c)} ${WMO[c]}` : '');

export function parseOpenMeteo(json, { hours = 3 } = {}) {
  const cur = json?.current; if (!cur) return null;
  const pops = (json.hourly?.precipitation_probability || []).slice(0, hours + 1).filter((x) => Number.isFinite(x));
  const temp = Number(cur.temperature_2m);
  return { wx: describeWeather(cur.weather_code), temp: Number.isFinite(temp) ? Math.round(temp) : null, pop: pops.length ? Math.max(...pops) : null, rainy: isRainyCode(cur.weather_code) };
}

// ---- 中央氣象署 via TDX ----
// Linkage code published in TDX's CWA swagger for TDX members; the TDX access token (cwa role) is what authorises the call.
export const CWA_TDX_LINK_CODE = 'TDX-2A1E325A-C117-4EDB-B4B6-822AACF5088E';
export const CWA_TDX_PATH = `/cwa/graphql?Authorization=${CWA_TDX_LINK_CODE}`;
export const cwaTownQuery = (lat, lng) => `{ town(Longitude: ${Number(lng).toFixed(4)}, Latitude: ${Number(lat).toFixed(4)}) { ctyName townName forecast72hr { Temperature { Time { DataTime Temperature } } ProbabilityOfPrecipitation { Time { StartTime EndTime ProbabilityOfPrecipitation } } Weather { Time { StartTime EndTime Weather WeatherCode } } } } }`;
export function cwaEmoji(text) { const s = String(text || ''); if (/雷/.test(s)) return '⛈️'; if (/雨/.test(s)) return '🌧️'; if (/霧/.test(s)) return '🌫️'; if (/雪/.test(s)) return '🌨️'; if (/^陰/.test(s)) return '☁️'; if (/雲/.test(s)) return '⛅'; return '☀️'; }
/** CWA town forecast (GraphQL) → { wx, temp, pop, rainy } at `now`; null when the payload has nothing usable. */
export function parseCwaTown(json, { now = Date.now(), hours = 3 } = {}) {
  const f = json?.data?.town?.forecast72hr; if (!f) return null;
  const ts = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
  const temps = (f.Temperature?.Time || []).map((x) => ({ t: ts(x.DataTime), v: Number(x.Temperature) })).filter((x) => x.t != null && Number.isFinite(x.v));
  const cur = temps.filter((x) => x.t <= now).at(-1) || temps[0] || null;
  const block = (arr) => (arr || []).map((x) => ({ ...x, s: ts(x.StartTime), e: ts(x.EndTime) })).filter((x) => x.s != null && x.e != null);
  const wxs = block(f.Weather?.Time); const w = wxs.find((x) => x.s <= now && now < x.e) || wxs.find((x) => x.s > now) || null;
  const pops = block(f.ProbabilityOfPrecipitation?.Time).filter((x) => x.e > now && x.s < now + hours * 3600e3).map((x) => Number(x.ProbabilityOfPrecipitation)).filter((x) => Number.isFinite(x) && x >= 0);
  if (!cur && !w) return null;
  const text = String(w?.Weather || '');
  return { wx: text ? `${cwaEmoji(text)} ${text}` : '', temp: cur ? Math.round(cur.v) : null, pop: pops.length ? Math.max(...pops) : null, rainy: /雨|雷/.test(text) };
}
/** fallback(place) through a TDX client (needs tdx.post); optional priority, so it never waits for quota. */
export function createCwaFallback(tdx, { now = () => Date.now() } = {}) {
  if (!tdx?.post) return null;
  return async (place) => {
    const json = await tdx.post(CWA_TDX_PATH, { query: cwaTownQuery(place.lat, place.lng) }, { ttlMs: 10 * 60e3, priority: 'optional' });
    if (json?.errors?.length) throw new Error('cwa graphql error');
    return parseCwaTown(json, { now: now() });
  };
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const weatherKey = (place) => (place?.town ? `${place.cityName || ''}${place.town}` : `${place.lat.toFixed(2)},${place.lng.toFixed(2)}`);

export function createWeather({ fetchImpl = fetch, now = () => Date.now(), log = null, timeoutMs = 12000, retries = 1, retryDelayMs = 700, ttlMs = 10 * 60e3, staleMs = 3 * 3600e3,
  fallback = null, sleep = realSleep } = {}) {
  const cache = new Map(); const inflight = new Map();
  async function openMeteo(place) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat.toFixed(4)}&longitude=${place.lng.toFixed(4)}&current=temperature_2m,weather_code&hourly=precipitation_probability&forecast_hours=4&timezone=Asia%2FTaipei`;
    let lastError = null;
    for (let i = 0; i <= retries; i++) {
      if (i) await sleep(retryDelayMs);
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs); timer.unref?.();
      try {
        const r = await fetchImpl(url, { signal: ctrl.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const value = parseOpenMeteo(await r.json()); if (!value) throw new Error('no current weather in response');
        return { ...value, source: 'open-meteo' };
      } catch (error) { lastError = error?.name === 'AbortError' ? new Error(`timeout ${Math.round(timeoutMs / 1000)}s`) : error; }
      finally { clearTimeout(timer); }
    }
    throw lastError || new Error('failed');
  }
  async function load(place, key, haveStale) {
    try { return await openMeteo(place); }
    catch (error) {
      let note = 'no fallback';
      if (fallback) {
        try { const v = await fallback(place); if (v) { log?.warn(`weather open-meteo failed (${retries + 1} tries): ${error.message}; CWA fallback ok`); return { ...v, source: 'cwa' }; } note = 'CWA fallback empty'; }
        catch (e2) { note = `CWA fallback failed: ${e2?.kind === 'rate' ? 'TDX quota' : e2?.message || 'error'}`; }
      }
      log?.warn(`weather failed (${retries + 1} tries): ${error.message}; ${note}${haveStale ? '; using cached' : ''}`);
      return null;
    }
  }
  return async function getWeather(place) {
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return null;
    const key = weatherKey(place); const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const stale = hit && now() - hit.at < staleMs ? hit.value : null;
      const value = await load(place, key, Boolean(stale));
      if (value) { cache.set(key, { at: now(), value }); if (cache.size > 100) cache.delete(cache.keys().next().value); return value; }
      return stale; // a miss is never cached
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  };
}