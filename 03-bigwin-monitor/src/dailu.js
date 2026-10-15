// 🧚 小精靈帶路: pure helpers (no I/O). Parsing TDX geocode / MaaS routing / bus ETA / metro alert / YouBike,
// the long-wait threshold, alternative ranking and the compact Traditional Chinese message. Zero AI.
import { TAIPEI_OFFSET_MS } from './util.js';

export const DAILU_LONG_WAIT_MIN = 10;      // 第一班車要等超過 10 分鐘 → 列出替代方案
export const DAILU_PENDING_TTL_MS = 15 * 60e3;
export const DAILU_RECENT_MAX = 3;
export const WALK_M_PER_MIN = 75;           // 約 4.5 km/h
export const BIKE_M_PER_MIN = 250;          // 約 15 km/h
export const BUS_STATUS = { 0: '正常', 1: '尚未發車', 2: '交管不停靠', 3: '末班車已過', 4: '今日未營運' };
export const TRIP_KINDS = {
  w: { emoji: '🏢', title: '上班帶路', fromLabel: '🏠 家', toLabel: '🏢 公司' },
  h: { emoji: '🏠', title: '下班帶路', fromLabel: '🏢 公司', toLabel: '🏠 家' },
  o: { emoji: '🏖️', title: '出去玩', fromLabel: '📍 出發', toLabel: '🎯 目的地' },
};

export const hhmm = (ms) => { const d = new Date(ms + TAIPEI_OFFSET_MS); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
/** "2026-10-02T11:19:15" (Taipei, no zone) or with offset → epoch ms */
export function parseTaipeiTime(value) {
  if (!value) return null; const s = String(value);
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/.exec(s); if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - TAIPEI_OFFSET_MS;
}
export const taipeiIso = (ms) => new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 19);

export function distanceM(a, b) {
  if (!a || !b) return Infinity; const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const walkMin = (m) => Math.max(1, Math.ceil(m / WALK_M_PER_MIN));

/** "POINT (121.517 25.046)" → { lat, lng } */
export function parsePoint(wkt) {
  const m = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(String(wkt || '')); if (!m) return null;
  const lng = Number(m[1]), lat = Number(m[2]); return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}
const CITY_RE = /(臺北市|台北市|新北市|基隆市|桃園市|新竹市|新竹縣|苗栗縣|臺中市|台中市|彰化縣|南投縣|雲林縣|嘉義市|嘉義縣|臺南市|台南市|高雄市|屏東縣|宜蘭縣|花蓮縣|臺東縣|台東縣|澎湖縣|金門縣|連江縣)/;
/** 從地址抓縣市與鄉鎮區：新北市板橋區府中路97號 → { cityName:'新北市', town:'板橋區' } */
export function districtFromAddress(address) {
  const s = String(address || '').replace(/^\d{3,6}/, ''); const c = CITY_RE.exec(s); if (!c) return {};
  const rest = s.slice(c.index + c[1].length); const t = /^(.{1,3}?[區鄉鎮市])/.exec(rest);
  return { cityName: c[1].replace('台', '臺'), town: t ? t[1] : '' };
}
export const looksLikeAddress = (text) => /\d+\s*號|[路街道]\s*[\d一二三四五六七八九十]+\s*段|\d+\s*[巷弄]|[路街]\s*\d/.test(String(text || ''));
export const normalizeQuery = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const TPE_TOWNS = new Set(['中正區', '大同區', '中山區', '松山區', '大安區', '萬華區', '信義區', '士林區', '北投區', '內湖區', '南港區', '文山區']);
const NTPC_TOWNS = new Set(['板橋區', '三重區', '中和區', '永和區', '新莊區', '新店區', '樹林區', '鶯歌區', '三峽區', '淡水區', '汐止區', '瑞芳區', '土城區', '蘆洲區', '五股區', '泰山區', '林口區', '深坑區', '石碇區', '坪林區', '三芝區', '石門區', '八里區', '平溪區', '雙溪區', '貢寮區', '金山區', '萬里區', '烏來區']);
const toHalf = (s) => String(s || '').replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
/** 地址清理：全形→半形、去空白、去掉「號」之後的樓層／室（18F、18樓、18樓之1、B1、3室）與郵遞區號。非地址原樣回傳。 */
export function cleanAddress(text) {
  let s = normalizeQuery(toHalf(text)); if (!looksLikeAddress(s)) return s;
  s = s.replace(/\s+/g, '').replace(/^\d{3,6}(?=\D)/, '').replace(/^台(?=[北中南東]市|東縣)/, '臺');
  const i = s.lastIndexOf('號'); if (i >= 0) return s.slice(0, i + 1);
  return s.replace(/(?:[Bb]?\d+|[一二三四五六七八九十]+)(?:[Ff]|樓|層)(?:之\d+)?(?:\d+室)?$/, '').replace(/\d+室$/, '');
}
/** 給 TDX Address 查詢的候選字串：沒寫縣市時依行政區補上（雙北），區名不明就依序試 新北市、臺北市（最多 2 個）。 */
export function addressVariants(text) {
  const s = cleanAddress(text); if (!s) return [];
  if (CITY_RE.test(s)) return [s];
  const town = /^(.{1,3}?區)/.exec(s)?.[1];
  if (town && TPE_TOWNS.has(town)) return ['臺北市' + s];
  if (town && NTPC_TOWNS.has(town)) return ['新北市' + s];
  return ['新北市' + s, '臺北市' + s];
}

/** TDX geocode rows (Address or Markname) → up to `limit` candidates, 雙北 first, de-duplicated. */
export function parseGeocode(rows, { limit = 3 } = {}) {
  const out = []; const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const p = parsePoint(r?.Geometry); if (!p) continue;
    const address = String(r.Address || '').trim(); const name = String(r.Name || r.Markname || '').trim() || address;
    const key = `${name}|${address}`; if (seen.has(key)) continue; seen.add(key);
    out.push({ name, address, ...p, ...districtFromAddress(address) });
  }
  const local = (c) => (/臺北市|新北市/.test(c.cityName || '') ? 0 : 1);
  return out.map((c, i) => ({ c, i })).sort((a, b) => local(a.c) - local(b.c) || a.i - b.i).slice(0, limit).map((x) => x.c);
}
/** Metro stations whose name appears in the query: 「板橋府中」 → 捷運府中站 */
export function matchStations(query, stations, { limit = 2 } = {}) {
  const raw = String(query || '').replace(/\s+/g, ''); const noMrt = raw.replace(/^捷運/, '');
  const variants = [...new Set([raw, noMrt, noMrt.replace(/站$/, '')])].filter(Boolean);
  const out = [];
  for (const s of Array.isArray(stations) ? stations : []) {
    const name = s?.StationName?.Zh_tw; const lat = s?.StationPosition?.PositionLat, lng = s?.StationPosition?.PositionLon;
    if (!name || name.length < 2 || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const exact = variants.some((v) => v === name || v === `${name}站`);
    if (exact || variants.some((v) => v.includes(name))) out.push({ name: `捷運${name}${name.endsWith('站') ? '' : '站'}`, address: String(s.StationAddress || '').replace(/^\d{3,6}/, ''), lat, lng, ...districtFromAddress(s.StationAddress), exact, score: name.length + (exact ? 100 : 0) });
  }
  const seen = new Set();
  return out.sort((a, b) => b.score - a.score).filter((c) => !seen.has(c.name) && seen.add(c.name)).slice(0, limit).map(({ score, ...c }) => c);
}
export function placeLabel(p) { return p ? `${p.name}${p.town ? `（${p.town}）` : ''}` : '未設定'; }

const legMode = (t = {}) => {
  const m = `${t.mode || ''} ${t.category || ''} ${t.type || ''}`.toLowerCase();
  if (/bus/.test(m)) return 'bus'; if (/mrt|metro|subway/.test(m)) return 'mrt'; if (/lrt|light/.test(m)) return 'lrt';
  if (/tra|rail|train|thsr|hsr/.test(m)) return 'rail'; if (/ferry/.test(m)) return 'ferry'; return 'other';
};
export const MODE_EMOJI = { walk: '🚶', bus: '🚌', mrt: '🚇', lrt: '🚊', rail: '🚆', ferry: '⛴️', other: '🚐' };

/** MaaS /routing response → routes with walk/transit legs (consecutive walking merged). */
export function parseRoutes(json) {
  const routes = json?.data?.routes; if (!Array.isArray(routes)) return [];
  return routes.map((r) => {
    const legs = [];
    for (const s of r.sections || []) {
      const dur = Number(s.travelSummary?.duration) || 0; const len = Number(s.travelSummary?.length) || 0;
      const from = { name: s.departure?.place?.name || '', lat: s.departure?.place?.location?.lat, lng: s.departure?.place?.location?.lng };
      const to = { name: s.arrival?.place?.name || '', lat: s.arrival?.place?.location?.lat, lng: s.arrival?.place?.location?.lng };
      const dep = parseTaipeiTime(s.departure?.time), arr = parseTaipeiTime(s.arrival?.time);
      if (s.type === 'transit') {
        const t = s.transport || {};
        legs.push({ mode: legMode(t), name: String(t.shortName || t.name || t.number || '').trim(), headsign: String(t.headsign || '').trim(), longName: t.longName || '',
          from, to, dep, arr, durSec: dur, stops: Array.isArray(s.intermediateStops) ? s.intermediateStops.length + 1 : null, fare: Number(t.fare ?? t.fareTW) || 0,
          city: STOP_CITY[String(s.agency?.agency_id || '').slice(0, 3)] || null });
      } else {
        const last = legs.at(-1);
        if (last?.mode === 'walk') { last.durSec += dur; last.lengthM += len; last.to = to; last.arr = arr ?? last.arr; }
        else legs.push({ mode: 'walk', from, to, dep, arr, durSec: dur, lengthM: len });
      }
    }
    return { travelSec: Number(r.travel_time) || 0, start: parseTaipeiTime(r.start_time), end: parseTaipeiTime(r.end_time), transfers: Number(r.transfers) || 0, price: Number(r.total_price) || null, legs };
  }).filter((r) => r.legs.some((l) => l.mode !== 'walk'));
}
export const firstTransit = (route) => route?.legs.find((l) => l.mode !== 'walk') || null;
export const walkBefore = (route) => { let s = 0; for (const l of route?.legs || []) { if (l.mode !== 'walk') break; s += l.durSec; } return s; };
// trains on the same rail/metro line between the same stations are one option (the next one is just a later departure)
export const routeKey = (route) => { const l = firstTransit(route); if (!l) return 'walk'; return ['rail', 'mrt', 'lrt'].includes(l.mode) ? `${l.mode}:${l.mode === 'rail' ? '' : l.name}:${l.from.name}:${l.to.name}` : `${l.mode}:${l.name}:${l.from.name}`; };
export const legName = (l) => (l.mode === 'rail' ? '台鐵' : l.mode === 'mrt' && !/線/.test(l.name) ? `捷運${l.name}` : l.name);
/** A timetable-only option whose vehicle leaves before you can reach the stop is gone (MaaS also returns past departures). */
export const reachable = (ev, now) => !(ev.source === 'timetable' && ev.departAt && ev.departAt < now + ev.walkMin * 60e3 - 60e3);
export const stopKey = (leg) => (leg ? `${Number(leg.from.lat).toFixed(4)},${Number(leg.from.lng).toFixed(4)}` : '');
export const STOP_CITY = { TPE: 'Taipei', NWT: 'NewTaipei', KEE: 'Keelung', TAO: 'Taoyuan' };

/**
 * Bus ETA rows (NearBy) → best match for this bus leg. Same route + same stop name; when both directions are
 * present the caller can pass `direction` (from StopOfRoute); otherwise the match is flagged ambiguous.
 */
export function matchBusEta(rows, leg, { direction = null } = {}) {
  const norm = (s) => String(s || '').replace(/[()（）\s]/g, '').replace(/台/g, '臺');
  const hits = (Array.isArray(rows) ? rows : []).filter((r) => norm(r?.RouteName?.Zh_tw) === norm(leg.name) && (!leg.from.name || norm(r?.StopName?.Zh_tw) === norm(leg.from.name)));
  const pool = hits.length ? hits : (Array.isArray(rows) ? rows : []).filter((r) => norm(r?.RouteName?.Zh_tw) === norm(leg.name));
  if (!pool.length) return null;
  const dirs = [...new Set(pool.map((r) => r.Direction))];
  let use = pool; let ambiguous = false;
  if (dirs.length > 1) { if (direction != null && dirs.includes(direction)) use = pool.filter((r) => r.Direction === direction); else ambiguous = true; }
  const best = use.slice().sort((a, b) => (a.StopStatus ?? 9) - (b.StopStatus ?? 9) || (a.EstimateTime ?? 1e9) - (b.EstimateTime ?? 1e9))[0];
  return { etaSec: Number.isFinite(best.EstimateTime) ? best.EstimateTime : null, status: Number(best.StopStatus ?? 0), nextBusTime: best.NextBusTime ? Date.parse(best.NextBusTime) : null,
    direction: best.Direction, ambiguous, stopUid: best.StopUID || '', city: STOP_CITY[String(best.StopUID || '').slice(0, 3)] || null, routeName: best?.RouteName?.Zh_tw || leg.name };
}
/** StopOfRoute rows → direction in which `fromName` comes before `toName` (null when unknown). */
export function directionFromStops(rows, fromName, toName) {
  const norm = (s) => String(s || '').replace(/[()（）\s]/g, '').replace(/台/g, '臺');
  for (const r of Array.isArray(rows) ? rows : []) {
    const names = (r.Stops || []).map((s) => norm(s?.StopName?.Zh_tw));
    const i = names.indexOf(norm(fromName)); const j = names.lastIndexOf(norm(toName));
    if (i >= 0 && j > i) return r.Direction;
  }
  return null;
}
/** The last vehicle leg when it is a bus followed only by the walk to the destination (≥ minWalkM), else null. */
export function alightCandidate(route, { minWalkM = 300 } = {}) {
  const legs = route?.legs || []; const li = legs.findLastIndex((l) => l.mode !== 'walk'); if (li < 0 || legs[li].mode !== 'bus') return null;
  const tail = legs.slice(li + 1); if (tail.length !== 1 || tail[0].mode !== 'walk') return null;
  const w = tail[0]; const m = w.lengthM || (w.durSec / 60) * WALK_M_PER_MIN; return m >= minWalkM ? legs[li] : null;
}
/**
 * MaaS sometimes lets you off well before the stop nearest the destination (e.g. 262 往宏國德霖: 中和保養廠, 1.1 km walk, while the
 * same bus later stops at 心中市, 289 m away). StopOfRoute rows (this route name, any sub-route/direction) → the route with its
 * last bus leg ending at the stop nearest the destination among the stops after boarding that every matching sub-route serves.
 * Ride time is extrapolated with the leg's own speed along the stops, the final walk keeps MaaS's own detour factor and pace.
 * Returns null when nothing is clearly better (gain < minGainM) or it would arrive more than maxLaterSec later.
 */
export function improveAlight(route, rows, dest, { minGainM = 120, maxLaterSec = 300 } = {}) {
  const leg = alightCandidate(route); if (!leg || !dest || !Array.isArray(rows) || !rows.length) return null;
  const li = route.legs.indexOf(leg); const walk = route.legs[li + 1];
  const pos = (s) => ({ lat: Number(s?.StopPosition?.PositionLat), lng: Number(s?.StopPosition?.PositionLon) });
  // first stop after `after` with this name; else the nearest one within 150 m (MaaS coordinates can be ~60 m off TDX's)
  const find = (stops, place, after) => {
    const n = normName(place.name); for (let x = after + 1; x < stops.length; x++) if (n && normName(stops[x]?.StopName?.Zh_tw) === n) return x;
    let best = -1, bd = 150; for (let x = after + 1; x < stops.length; x++) { const d = distanceM(pos(stops[x]), place); if (d < bd) { bd = d; best = x; } }
    return best;
  };
  const matched = [];
  for (const r of rows) { const st = r?.Stops || []; const i = find(st, leg.from, -1); if (i < 0) continue; const j = find(st, leg.to, i); if (j > i) matched.push({ st, i, j }); }
  if (!matched.length) return null;
  const served = (name) => matched.every((m) => m.st.slice(m.i + 1).some((s) => normName(s?.StopName?.Zh_tw) === name));
  const { st, i, j } = matched[0];
  let k = j, dk = distanceM(leg.to, dest);
  for (let x = i + 1; x < st.length; x++) { const p = pos(st[x]); if (!Number.isFinite(p.lat)) continue; const d = distanceM(p, dest); if (d < dk && served(normName(st[x]?.StopName?.Zh_tw))) { dk = d; k = x; } }
  const dOld = distanceM(leg.to, dest); if (k === j || dOld - dk < minGainM) return null;
  const along = (a, b) => { let s = 0; for (let x = Math.min(a, b); x < Math.max(a, b); x++) s += distanceM(pos(st[x]), pos(st[x + 1])); return s; };
  const speed = Math.min(9, Math.max(2.5, leg.durSec > 0 ? along(i, j) / leg.durSec : 4)); // m/s, includes dwell time
  const rideDelta = Math.round((along(i, k) - along(i, j)) / speed);
  const detour = Math.min(1.8, Math.max(1.1, walk.lengthM && dOld > 0 ? walk.lengthM / dOld : 1.3));
  const pace = walk.lengthM > 0 && walk.durSec > 0 ? walk.lengthM / walk.durSec : WALK_M_PER_MIN / 60; // m/s
  const lengthM = Math.round(dk * detour); const walkSec = Math.max(60, Math.round(lengthM / pace));
  const delta = rideDelta + walkSec - walk.durSec; if (delta > maxLaterSec) return null;
  const to = { name: String(st[k]?.StopName?.Zh_tw || ''), ...pos(st[k]) };
  const arr = leg.arr != null ? leg.arr + rideDelta * 1000 : null;
  const newLeg = { ...leg, to, arr, durSec: leg.durSec + rideDelta, stops: k - i, alightFixed: { maas: leg.to.name, gainM: Math.round(dOld - dk) } };
  const newWalk = { ...walk, from: to, dep: arr ?? walk.dep, durSec: walkSec, lengthM };
  const legs = route.legs.slice(); legs[li] = newLeg; legs[li + 1] = newWalk;
  return { ...route, legs, end: route.end != null ? route.end + delta * 1000 : null, travelSec: route.travelSec ? route.travelSec + delta : route.travelSec };
}
/** Seconds walked on the whole route. */
export const walkTotal = (route) => (route?.legs || []).filter((l) => l.mode === 'walk').reduce((s, l) => s + (l.durSec || 0), 0);
/** TRTC Alert → { normal, text, lines } ; Status 1 = 正常營運. */
export function parseMetroAlert(json) {
  const alerts = Array.isArray(json?.Alerts) ? json.Alerts : null; if (!alerts) return null;
  const bad = alerts.filter((a) => Number(a.Status) !== 1);
  if (!bad.length) return { normal: true, text: '正常營運', lines: [] };
  const lines = [...new Set(bad.flatMap((a) => (a.Scope?.Lines || []).map((l) => l.LineName?.Zh_tw || l.LineID).filter(Boolean)))];
  return { normal: false, text: String(bad[0].Title || bad[0].Description || '營運異常').slice(0, 80), lines };
}
const metroAffected = (alert, leg) => alert && !alert.normal && (!alert.lines.length || alert.lines.some((n) => String(leg.name).includes(n) || String(n).includes(leg.name)));

/**
 * Evaluate a route at time `now`: wait at the first stop (real-time when available), estimated arrival, long-wait flag.
 * eta: matchBusEta() result for the first bus leg, or null. alert: parseMetroAlert() result, or null.
 * nextDep: { at, kind:'schedule'|'headway' } = next scheduled departure at the boarding stop (a later MaaS itinerary or the TDX
 * timetable), used when real-time has no usable bus (尚未發車 without NextBusTime, about to be missed, or the timetable run already left).
 * estimate: null (real-time / itinerary) | 'schedule' | 'headway' | 'earliest' (no data: as if a bus came when you reach the stop).
 * Arrival = departure at the stop + the rest of the MaaS itinerary (in-vehicle time + walking), so every option gets a time.
 */
export function evaluateRoute(route, { now, eta = null, alert = null, threshold = DAILU_LONG_WAIT_MIN, nextDep = null } = {}) {
  const leg = firstTransit(route); const walkSec = walkBefore(route);
  const out = { route, leg, walkMin: Math.round(walkSec / 60), source: 'timetable', waitMin: null, status: null, long: false, reasons: [], arrive: route.end, departAt: leg?.dep ?? null, estimate: null, nextDepAt: null };
  if (!leg) return out;
  const readyAt = now + walkSec * 1000;
  let realDep = leg.dep; let unknownDep = false;
  const useNext = () => { if (!nextDep?.at) return false; realDep = Math.max(nextDep.at, readyAt); out.nextDepAt = nextDep.at; out.estimate = nextDep.kind === 'headway' ? 'headway' : 'schedule'; return true; };
  const earliest = () => { realDep = readyAt; out.estimate = 'earliest'; };
  if (leg.mode === 'bus' && eta && !eta.ambiguous) {
    out.source = 'realtime'; out.status = eta.status;
    if (eta.status !== 0 || eta.etaSec == null) {
      out.long = true; out.reasons.push(`${leg.name} ${BUS_STATUS[eta.status] || '暫無到站資訊'}`);
      if (eta.status >= 2 && eta.status <= 4) { out.noService = true; unknownDep = true; }
      else if (eta.nextBusTime && eta.nextBusTime >= now - 5 * 60e3) { realDep = Math.max(eta.nextBusTime, readyAt); out.nextDepAt = eta.nextBusTime; out.estimate = 'schedule'; }
      else if (!useNext()) earliest();
    } else {
      const arriveAtStop = now + eta.etaSec * 1000;
      if (arriveAtStop + 30e3 < readyAt) {
        out.missed = true; out.long = true; out.reasons.push(`${leg.name} 這班 ${Math.round(eta.etaSec / 60)} 分到站，走過去可能趕不上`);
        if (!useNext()) earliest();
      } else { realDep = arriveAtStop; out.etaMin = Math.round(eta.etaSec / 60); }
    }
    if (!unknownDep) out.waitMin = Math.max(0, Math.round((realDep - readyAt) / 60e3));
  } else if (leg.dep) {
    if (leg.mode === 'bus' && leg.dep < readyAt - 60e3) useNext(); // that run already left → the next scheduled one
    out.waitMin = Math.max(0, Math.round((realDep - readyAt) / 60e3)); // leaving now
    if (leg.mode === 'bus' && eta?.ambiguous) out.reasons.push(`${leg.name} 即時方向無法確認，先以時刻表估算`);
  }
  if (out.waitMin != null && out.waitMin > threshold) { out.long = true; out.reasons.push(`${leg.name} 要等約 ${out.waitMin} 分`); }
  if (['mrt', 'lrt'].includes(leg.mode) && metroAffected(alert, leg)) { out.long = true; out.reasons.push(`捷運${alert.text}`); }
  if (unknownDep) { out.arrive = null; out.departAt = null; }
  else if (realDep && leg.dep && route.end) { const shift = realDep - leg.dep; out.arrive = route.end + (route.transfers ? Math.max(0, shift) : shift); out.departAt = realDep; }
  return out;
}
const rankArrive = (e) => (e.arrive ?? Infinity) + (e.estimate === 'earliest' ? 10 * 60e3 : 0);
/** Up to n alternatives with a different first vehicle, best estimated arrival first (unknown arrival last). */
export function pickAlternatives(evals, primary, n = 2) {
  const seen = new Set([routeKey(primary.route)]); const out = [];
  const sorted = evals.filter((e) => e !== primary && !e.noService).sort((a, b) => (a.long - b.long) || (rankArrive(a) - rankArrive(b)));
  for (const e of sorted) { const k = routeKey(e.route); if (seen.has(k)) continue; seen.add(k); out.push(e); if (out.length >= n) break; }
  return out;
}
/** Primary = earliest estimated arrival among non-long routes (within 3 min, one walking ≥ 4 min less wins), else the earliest overall. */
export function pickPrimary(evals) {
  const by = (a, b) => rankArrive(a) - rankArrive(b);
  const pool = evals.filter((e) => !e.long).sort(by); const best = pool[0];
  if (best) return pool.filter((e) => e !== best && rankArrive(e) - rankArrive(best) <= 180e3 && walkTotal(e.route) <= walkTotal(best.route) - 240).sort((a, b) => walkTotal(a.route) - walkTotal(b.route))[0] || best;
  return evals.slice().sort(by)[0] || null;
}
const finalWalkSec = (route) => { const l = route?.legs?.at(-1); return l?.mode === 'walk' ? l.durSec || 0 : 0; };
/** Another bus from the same boarding stop that lets you off much nearer and arrives at most 5 min later (e.g. 262區 ends at 中和保養廠, 262 goes on to 心中市). */
export function sameStopHint(primary, evals) {
  const pl = primary?.leg; if (pl?.mode !== 'bus') return null; const pw = finalWalkSec(primary.route);
  const cand = (evals || []).filter((e) => e !== primary && !e.noService && e.arrive && !e.route.transfers && e.leg?.mode === 'bus' && e.leg.name !== pl.name && rankArrive(e) - rankArrive(primary) <= 5 * 60e3
    && normName(e.leg.from.name) === normName(pl.from.name) && finalWalkSec(e.route) <= pw - 240).sort((a, b) => rankArrive(a) - rankArrive(b))[0];
  if (!cand) return null; const l = cand.leg;
  return `同站的 ${legName(l)} 也可以搭，坐到 ${l.to.name}${l.stops ? `（${l.stops} 站）` : ''}只要再走 ${Math.max(1, Math.round(finalWalkSec(cand.route) / 60))} 分（${estPrefix(cand)}${hhmm(cand.arrive)} 到）`;
}
const normName = (s) => String(s || '').replace(/[()（）\s]/g, '').replace(/台/g, '臺');
export const sameDistrict = (a, b) => Boolean(a?.town && b?.town && a.town === b.town && String(a.cityName || '').replace(/台/g, '臺') === String(b.cityName || '').replace(/台/g, '臺'));
/** Taipei midnight (epoch ms) of the day containing `ms`. */
export function taipeiDayStart(ms) { const d = new Date(ms + TAIPEI_OFFSET_MS); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - TAIPEI_OFFSET_MS; }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/**
 * TDX Bus/Schedule rows → next departure at the boarding stop at/after `readyAt` ({ at, kind } or null).
 * Uses the stop's own StopTimes when listed; otherwise the terminal departures shifted by the MaaS offset
 * (MaaS leg departure − the latest terminal departure before it); otherwise Frequencys (wait ≈ half the headway).
 * notDepartedAfter (尚未發車): only trips that leave the terminal at/after this time count.
 */
export function nextScheduledDeparture(rows, { routeName, direction = null, stopName = '', legDep = null, readyAt, notDepartedAfter = null }) {
  const day0 = taipeiDayStart(readyAt); const wd = WEEKDAYS[new Date(readyAt + TAIPEI_OFFSET_MS).getUTCDay()];
  const at = (s) => { const m = /^(\d{1,2}):(\d\d)/.exec(String(s || '')); return m ? day0 + (Number(m[1]) * 60 + Number(m[2])) * 60e3 : null; };
  const runsToday = (sd) => !sd || Number(sd[wd]) === 1;
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => (!routeName || normName(r?.RouteName?.Zh_tw) === normName(routeName)) && (direction == null || r.Direction == null || Number(r.Direction) === Number(direction)));
  const trips = []; let freq = null;
  for (const r of mine) {
    for (const tt of r.Timetables || []) {
      if (!runsToday(tt.ServiceDay)) continue; const st = tt.StopTimes || [];
      const term = st[0] ? at(st[0].DepartureTime || st[0].ArrivalTime) : null;
      const hit = stopName ? st.find((x) => normName(x?.StopName?.Zh_tw) === normName(stopName)) : null;
      trips.push({ term, stop: hit ? at(hit.DepartureTime || hit.ArrivalTime) : null });
    }
    for (const f of r.Frequencys || []) {
      if (!runsToday(f.ServiceDay)) continue; const s = at(f.StartTime), e = at(f.EndTime); if (s == null || e == null) continue;
      const head = (Number(f.MinHeadwayMins) + Number(f.MaxHeadwayMins || f.MinHeadwayMins)) / 2;
      if (Number.isFinite(head) && head > 0 && readyAt <= e && (!freq || s < freq.s)) freq = { s, e, head };
    }
  }
  const leaves = (x) => notDepartedAfter == null || x.term == null || x.term >= notDepartedAfter;
  const first = (arr) => arr.filter((v) => v != null && v >= readyAt - 30e3).sort((a, b) => a - b)[0] ?? null;
  const direct = first(trips.filter((x) => x.stop != null && leaves(x)).map((x) => x.stop)); if (direct != null) return { at: direct, kind: 'schedule' };
  const terms = trips.filter((x) => x.stop == null && x.term != null);
  if (terms.length) {
    let offset = 0;
    if (legDep) { const prev = terms.map((x) => x.term).filter((v) => v <= legDep).sort((a, b) => b - a)[0]; if (prev != null && legDep - prev <= 120 * 60e3) offset = legDep - prev; }
    const v = first(terms.filter(leaves).map((x) => x.term + offset)); if (v != null) return { at: v, kind: 'schedule' };
  }
  if (freq) return { at: Math.max(readyAt, freq.s, notDepartedAfter ?? 0) + Math.round(freq.head / 2) * 60e3, kind: 'headway' };
  return null;
}
/** YouBike stations + availability near the origin → nearest stations with bikes. */
export function parseBikes(stations, availability, origin, { limit = 2 } = {}) {
  const avail = new Map((Array.isArray(availability) ? availability : []).map((a) => [a.StationUID, a]));
  return (Array.isArray(stations) ? stations : []).map((s) => {
    const a = avail.get(s.StationUID); const pos = { lat: s.StationPosition?.PositionLat, lng: s.StationPosition?.PositionLon };
    return { name: String(s.StationName?.Zh_tw || '').replace(/^YouBike\d(\.\d)?_/, ''), rent: Number(a?.AvailableRentBikes ?? -1), ret: Number(a?.AvailableReturnBikes ?? -1), service: Number(a?.ServiceStatus ?? 1), distM: distanceM(origin, pos) };
  }).filter((b) => b.name && b.rent > 0 && b.service === 1).sort((a, b) => a.distM - b.distM).slice(0, limit);
}

const estPrefix = (ev) => (ev.estimate === 'earliest' ? '最快 ' : ev.estimate ? '約 ' : '');
const nextText = (ev) => (ev.nextDepAt ? `下一班約 ${hhmm(ev.nextDepAt)}` : '');
/** What is happening at the boarding stop (shared by the main route and the alternatives). */
function waitText(ev, l) {
  if (ev.source === 'realtime') {
    if (ev.missed) return `這班可能趕不上${ev.nextDepAt ? `，${nextText(ev)}` : ''}`;
    if (ev.status && ev.status !== 0) return `${BUS_STATUS[ev.status] || '暫無資訊'}${ev.nextDepAt ? `（${nextText(ev)}）` : ''}`;
    if (ev.etaMin != null) return `即時 ${ev.etaMin <= 1 ? '即將進站' : `${ev.etaMin} 分到站`}`;
    return '暫無即時';
  }
  const dep = ev.departAt ?? l.dep; return dep ? `${hhmm(dep)} 開` : '';
}
function legLine(leg, ev, isFirst, now) {
  if (leg.mode === 'walk') return `🚶 步行 ${Math.max(1, Math.round(leg.durSec / 60))} 分${leg.to?.name ? `到 ${leg.to.name}` : '到達'}`;
  const head = leg.headsign ? ` 往${leg.headsign.replace(/^往/, '')}` : '';
  let when = '';
  if (isFirst && ev) {
    if (ev.source === 'realtime') {
      if (ev.missed || (ev.status && ev.status !== 0)) when = `｜🔴 ${waitText(ev, leg)}`;
      else if (ev.etaMin != null) when = `｜🟢 ${waitText(ev, leg)}`;
    } else { const dep = ev.departAt ?? leg.dep; if (dep) when = `｜🕒 ${hhmm(dep)} 開${ev.waitMin != null ? `（等約 ${ev.waitMin} 分）` : ''}`; }
  } else if (leg.dep) when = `｜${hhmm(leg.dep)}`;
  return `${MODE_EMOJI[leg.mode] || '🚐'} ${legName(leg)}${head}${when}\n   ${leg.from.name || '上車'} → ${leg.to.name || '下車'}${leg.stops ? `（${leg.stops} 站）` : ''}`;
}
const arriveText = (ev, now) => (ev.arrive ? `${estPrefix(ev)}${hhmm(ev.arrive)} 到（約 ${Math.max(1, Math.round((ev.arrive - now) / 60e3))} 分）`
  : ev.noService ? (ev.status === 2 ? '本站暫不停靠' : '今日已無班次') : '到達時間未知');
function altLine(ev, now) {
  const l = ev.leg; if (!l) return '';
  const name = `${MODE_EMOJI[l.mode] || '🚐'} ${legName(l)}${l.mode === 'rail' && l.headsign ? ` 往${l.headsign}` : ''}`;
  const transfers = ev.route.transfers ? `，轉乘 ${ev.route.transfers} 次` : '';
  return `・${name}｜${l.from.name}｜${waitText(ev, l)}${transfers} → ${arriveText(ev, now)}`;
}
export function weatherLine(label, w) {
  if (!w) return `・${label}：天氣暫時查不到`;
  const t = w.temp != null ? `${w.temp}°C` : (w.minT != null && w.maxT != null ? `${w.minT}–${w.maxT}°C` : '');
  const pop = w.pop != null ? `降雨 ${w.pop}%` : '';
  const umbrella = (w.pop != null && w.pop >= 40) || w.rainy ? ' ☂️ 記得帶傘' : ''; // same threshold as 上班提醒
  return `・${label}：${[w.wx, t, pop].filter(Boolean).join(' ')}${umbrella}`;
}

/** The whole Telegram message (plain text, compact). */
export function renderTrip({ kind, from, to, now, primary, alternatives = [], bikes = [], bikeRideMin = null, weather = {}, notes = [], alert = null, hint = null }) {
  const k = TRIP_KINDS[kind] || TRIP_KINDS.o;
  const lines = [`${k.emoji} ${k.title}｜${hhmm(now)} 更新`, `${k.fromLabel}：${placeLabel(from)}`, `${k.toLabel}：${placeLabel(to)}`, ''];
  if (sameDistrict(from, to)) lines.push('🌤 天氣', weatherLine(from.town, weather.from || weather.to), '');
  else lines.push('🌤 天氣', weatherLine(from.town || from.name, weather.from), weatherLine(to.town || to.name, weather.to), '');
  if (!primary) {
    lines.push('🚏 目前查不到大眾運輸路線', ...notes.map((n) => `ℹ️ ${n}`));
    return lines.join('\n');
  }
  const r = primary.route;
  lines.push(`🚏 建議路線｜${arriveText(primary, now)}${r.transfers ? `｜轉乘 ${r.transfers} 次` : ''}${r.price ? `｜$${r.price}` : ''}`);
  let first = true;
  const leaveAt = primary.departAt && primary.source === 'timetable' ? primary.departAt - primary.walkMin * 60e3 : primary.waitMin != null && primary.source === 'realtime' ? now + primary.waitMin * 60e3 : null;
  if (leaveAt && leaveAt - now >= 3 * 60e3) lines.push(`⏰ 建議 ${hhmm(leaveAt)} 出門（還有 ${Math.round((leaveAt - now) / 60e3)} 分）`);
  for (const leg of r.legs) { lines.push(legLine(leg, primary, first && leg.mode !== 'walk', now)); if (leg.mode !== 'walk') first = false; }
  if (hint) lines.push(`💡 ${hint}`);
  if (alert && !alert.normal) lines.push(`🚇 捷運公告：${alert.text}`);
  if (primary.long) {
    lines.push('', `⚠️ 等車較久：${primary.reasons.join('；') || '班距較長'}`);
    if (alternatives.length || bikes.length) lines.push('可以改搭：');
    for (const a of alternatives) lines.push(altLine(a, now));
    for (const b of bikes) lines.push(`・🚲 YouBike ${b.name}（步行 ${walkMin(b.distM)} 分）可借 ${b.rent} 台${bikeRideMin ? `，騎到目的地約 ${bikeRideMin} 分` : ''}`);
    if (!alternatives.length && !bikes.length) lines.push('・目前沒有更快的替代方案');
  } else lines.push('', `✅ 等車時間正常（${primary.waitMin != null ? `約 ${primary.waitMin} 分` : '依時刻表'}）`);
  for (const n of notes) lines.push(`ℹ️ ${n}`);
  return lines.join('\n');
}
