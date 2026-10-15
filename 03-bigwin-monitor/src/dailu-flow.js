// 🧚 小精靈帶路 Telegram flow (private chat only; places are personal). Zero AI: TDX + weather APIs only.
// 上班 = 家→公司, 下班 = 公司→家, 出去玩 = 目前位置→目的地 (not saved; last 3 destinations offered as quick buttons).
import { DAILU_PENDING_TTL_MS, DAILU_RECENT_MAX, DAILU_LONG_WAIT_MIN, TRIP_KINDS, BIKE_M_PER_MIN, distanceM, directionFromStops, evaluateRoute,
  addressVariants, cleanAddress, firstTransit, looksLikeAddress, matchBusEta, matchStations, normalizeQuery, parseBikes, parseGeocode, parseMetroAlert, parseRoutes,
  pickAlternatives, pickPrimary, placeLabel, reachable, renderTrip, walkMin, walkBefore, nextScheduledDeparture, sameDistrict, alightCandidate, improveAlight, sameStopHint } from './dailu.js';

export const DL_CALLBACK_RE = /^dl:([mwhoserctxfdvk])(?::([a-z0-9]{1,24}))?(?::([0-9]{1,5}))?(?::([0-9]{1,2}))?$/;
const MENU_WORDS = new Set(['🧚 小精靈帶路', '小精靈帶路', '帶路']);
const KIND_WORDS = { '上班': 'w', '🏢 上班': 'w', '下班': 'h', '🏠 下班': 'h', '出去玩': 'o', '🏖️ 出去玩': 'o', '🏖 出去玩': 'o' };
const CANCEL_WORDS = new Set(['❌ 取消', '取消']);
const FROM_HOME = '🏠 從家裡出發', FROM_WORK = '🏢 從公司出發';
const q = (s) => encodeURIComponent(s);
const sp = (lat, lng, r) => `%24spatialFilter=nearby(${Number(lat).toFixed(6)},${Number(lng).toFixed(6)},${r})&%24format=JSON`;

export function isDailuTrigger(text, botUsername = '') {
  if (MENU_WORDS.has(text) || KIND_WORDS[text]) return true;
  const m = /^\/dailu(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(text);
  if (m && (!m[1] || m[1].toLowerCase() === String(botUsername).toLowerCase())) return true;
  return /^\/start\s+dailu$/i.test(text);
}

export function createDailuFlow({ api, send, answer, log, now = () => Date.now(), tgStore = null, inGroup, inUserPrivate, isGroupMember,
  botUsername = () => '', tdx = null, getWeather = null, mode = 'all', threshold = DAILU_LONG_WAIT_MIN }) {
  const data = tgStore?.data.dailu || {};
  const profiles = data.profiles || {}; const pending = data.pending || {}; const trips = data.trips || {};
  const busy = new Set(); let counter = Math.floor(Math.random() * 1296);
  const save = () => { if (!tgStore) return; tgStore.data.dailu = { profiles, pending, trips }; tgStore.save(); };
  const profile = (uid) => (profiles[uid] ||= { home: null, work: null, recent: [] });
  const newId = (uid) => `${now().toString(36)}${Math.abs(Number(uid)).toString(36)}${(++counter).toString(36)}`.slice(-24);
  const inline = (kb) => ({ reply_markup: { inline_keyboard: kb } });
  const removeKb = { reply_markup: { remove_keyboard: true } };
  const del = async (chatId, id) => { if (!id) return; try { await api.call('deleteMessage', { chat_id: chatId, message_id: id }); } catch { /* best effort */ } };
  const editText = async (chatId, id, text, kb) => {
    try { await api.call('editMessageText', { chat_id: chatId, message_id: id, text, reply_markup: { inline_keyboard: kb } }); return true; }
    catch (error) { if (/not modified/i.test(String(error?.description || error?.message))) return true; log.warn(`dailu edit failed: ${error.message}`); return false; }
  };
  const strip = async (chatId, id) => { if (!id) return; try { await api.call('editMessageReplyMarkup', { chat_id: chatId, message_id: id, reply_markup: { inline_keyboard: [] } }); } catch { /* gone or unchanged */ } };

  function menuKeyboard() { return [[{ text: '🏢 上班', callback_data: 'dl:w' }, { text: '🏠 下班', callback_data: 'dl:h' }], [{ text: '🏖️ 出去玩', callback_data: 'dl:o' }, { text: '⚙️ 設定地點', callback_data: 'dl:s' }]]; }
  function menuText(p) { return `🧚 小精靈帶路\n🏠 家：${placeLabel(p.home)}\n🏢 公司：${placeLabel(p.work)}\n\n上班、下班或出去玩，按一下就幫你查天氣和公車／捷運即時到站。`; }
  async function privateOnly(chat, user) {
    const bot = botUsername();
    const text = `${user?.first_name ? `${user.first_name}，` : ''}🧚 小精靈帶路會用到住家／公司位置，請私訊小精靈使用。`;
    return send(text, bot ? inline([[{ text: '🧚 私訊小精靈帶路', url: `https://t.me/${bot}?start=dailu` }]]) : {}, chat.id);
  }
  async function showMenu(user, chat) {
    const p = profile(user.id);
    if (!p.home || !p.work) return askPlace(user, chat, !p.home ? 'home' : 'work', { chain: true, intro: true });
    return { dailuMenu: (await send(menuText(p), inline(menuKeyboard()), chat.id))?.message_id ?? true };
  }
  async function showSettings(user, chat) {
    const p = profile(user.id);
    const kb = [[{ text: '🏠 改家裡', callback_data: 'dl:e:h' }, { text: '🏢 改公司', callback_data: 'dl:e:w' }]];
    if (p.recent?.length) kb.push([{ text: '🗑 清除最近目的地', callback_data: 'dl:k' }]);
    kb.push([{ text: '⬅️ 返回帶路', callback_data: 'dl:m' }]);
    const recent = p.recent?.length ? `\n📌 最近目的地：${p.recent.map((r) => r.name).join('、')}` : '';
    await send(`⚙️ 設定地點\n🏠 家：${p.home ? `${placeLabel(p.home)}\n   ${p.home.address || ''}` : '未設定'}\n🏢 公司：${p.work ? `${placeLabel(p.work)}\n   ${p.work.address || ''}` : '未設定'}${recent}`, inline(kb), chat.id);
    return { dailuSettings: true };
  }

  const PROMPTS = {
    home: '🏠 請輸入「家裡」的地點：地址或地標都可以（例如「板橋區府中路50號」或「捷運府中站」），或按下方「📍 傳送目前位置」。',
    work: '🏢 請輸入「上班」的地點：地址或地標都可以（例如「台北市信義區市府路1號」），或按下方「📍 傳送目前位置」。',
    from: '🏖️ 出去玩｜你現在在哪裡？輸入地點，或按下方「📍 傳送目前位置」。',
    to: '🎯 要去哪裡？輸入地名或地址（例如「淡水老街」「台北101」）。',
  };
  async function askPlace(user, chat, purpose, { chain = false, then = null, from = null, intro = false } = {}) {
    const p = profile(user.id); const old = pending[user.id];
    const sid = old && purpose === 'to' && old.purpose === 'from' ? old.sid : newId(user.id);
    const rows = [[{ text: '📍 傳送目前位置', request_location: true }]];
    if (purpose === 'from') { const quick = [p.home && { text: FROM_HOME }, p.work && { text: FROM_WORK }].filter(Boolean); if (quick.length) rows.push(quick); }
    if (purpose === 'to') { if (p.recent?.length) rows.push(p.recent.map((r) => ({ text: `📌 ${r.name}`.slice(0, 60) }))); rows[0] = [{ text: '📍 目的地就是我現在的位置', request_location: true }]; }
    rows.push([{ text: '❌ 取消' }]);
    const head = intro ? '🧚 第一次使用小精靈帶路，先記下兩個地點（只存在小精靈這台電腦）。\n\n' : '';
    const msg = await send(head + PROMPTS[purpose], { reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: true, input_field_placeholder: purpose === 'to' ? '輸入目的地…' : '輸入地址或地標…' } }, chat.id);
    pending[user.id] = { sid, seq: (old?.sid === sid ? old.seq : 0) + 1, purpose, chain, then, from, chatId: chat.id, at: now(), promptId: msg?.message_id ?? null, candidates: [] };
    save();
    return { dailuAsk: purpose, sessionId: sid };
  }

  async function geocode(text) {
    const query = cleanAddress(text); if (!query) return [];
    let stations = [];
    try { stations = matchStations(query, await tdx.get('/basic/v2/Rail/Metro/Station/TRTC?%24select=StationName,StationPosition,StationAddress&%24format=JSON', { ttlMs: 24 * 3600e3, staleMs: 7 * 24 * 3600e3, priority: 'optional' })); }
    catch { /* stations are a bonus */ }
    // exact station name first (「捷運府中站」), then the geocoder, then stations merely named inside the query (「板橋府中」→ 府中站)
    const out = stations.filter((c) => c.exact);
    const add = (c) => { if (out.length < 4 && !out.some((o) => distanceM(o, c) < 30)) out.push(c); };
    if (!out.length) {
      // TDX Address answers HTTP 503 when the city is missing → try 「新北市／臺北市」+ cleaned address (floors stripped), then place names
      const addr = addressVariants(query).map((s) => ['Address', s]); const mark = [['Markname', query]];
      const steps = looksLikeAddress(query) ? [...addr, ...mark] : [...mark, ...addr];
      let lastError = null, rateError = null;
      for (const [kind, s] of steps) { // one geocoder failing (e.g. HTTP 503) must not hide the next
        let rows;
        try { rows = await tdx.get(`/advanced/V3/Map/GeoCode/Coordinate/${kind}/${q(s)}?format=JSON`, { ttlMs: 24 * 3600e3, priority: 'must', maxWaitMs: 25000 }); }
        catch (error) { lastError = error; if (error?.kind === 'rate') { rateError = error; break; } continue; }
        const found = parseGeocode(rows, { limit: 3 }); found.forEach(add);
        if (found.length) break;
      }
      if (!out.length && !stations.length && (rateError || lastError)) throw rateError || lastError; // a failed source might have had it: say so instead of「找不到」
    }
    stations.filter((c) => !c.exact).forEach(add);
    return out;
  }
  async function placeFromLocation(loc) {
    const place = { name: '📍 分享的位置', address: '', lat: Number(loc.latitude), lng: Number(loc.longitude), town: '', cityName: '' };
    if (tdx) {
      try { const r = await tdx.get(`/advanced/V3/Map/GeoLocating/District/LocationX/${place.lng.toFixed(6)}/LocationY/${place.lat.toFixed(6)}?format=JSON`, { ttlMs: 3600e3, priority: 'optional' });
        const d = Array.isArray(r) ? r[0] : null; if (d) { place.town = d.TownName || ''; place.cityName = d.CityName || ''; place.address = `${place.cityName}${place.town}`; } }
      catch { /* district is cosmetic */ }
    }
    return place;
  }

  async function onInput(msg, text, pend) {
    const user = msg.from, chat = msg.chat, p = profile(user.id);
    if (CANCEL_WORDS.has(text)) { delete pending[user.id]; save(); await send('已取消小精靈帶路。', removeKb, chat.id); return { dailuCancelled: true }; }
    if (pend.purpose === 'from' && (text === FROM_HOME || text === FROM_WORK)) { const place = text === FROM_HOME ? p.home : p.work; if (place) return commit(user, chat, pend, place, { removeKeyboard: true }); }
    if (pend.purpose === 'to' && text.startsWith('📌 ')) { const r = p.recent?.find((x) => `📌 ${x.name}`.slice(0, 60) === text); if (r) return commit(user, chat, pend, r, { removeKeyboard: true }); }
    if (msg.location) {
      const place = await placeFromLocation(msg.location);
      if (pend.purpose === 'home' || pend.purpose === 'work') {
        pend.candidates = [place]; pend.seq++; save();
        await send('📍 收到位置', removeKb, chat.id);
        await send(`📍 你分享的位置${place.town ? `在${place.cityName}${place.town}` : ''}\n（${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}）\n要存成${pend.purpose === 'home' ? '🏠 家' : '🏢 公司'}嗎？`,
          inline([[{ text: '✅ 就是這裡', callback_data: `dl:c:${pend.sid}:${pend.seq}:0` }, { text: '✏️ 重新輸入', callback_data: `dl:t:${pend.sid}:${pend.seq}` }]]), chat.id);
        return { dailuConfirm: 1 };
      }
      return commit(user, chat, pend, place, { removeKeyboard: true });
    }
    if (!text) { await send('請輸入地點文字，或按「📍 傳送目前位置」。', {}, chat.id); return { ignored: 'empty place' }; }
    if (!tdx) { await send('⚠️ 小精靈帶路尚未設定 TDX 金鑰，暫時無法查地點。', removeKb, chat.id); return { dailuError: 'no tdx' }; }
    const status = await send(`🔎 正在查「${cleanAddress(text)}」…`, removeKb, chat.id);
    let cands;
    try { cands = await geocode(text); }
    catch (error) {
      await del(chat.id, status?.message_id);
      await send(error?.kind === 'rate' ? `⏳ 查詢太頻繁（TDX 每分鐘限 5 次），約 ${error.retryAfterSec || 60} 秒後再試。` : '⚠️ 地點查詢暫時失敗，請稍後再試一次（也可以改輸入地標，或按「📍 傳送目前位置」）。', {}, chat.id);
      return askPlace(user, chat, pend.purpose, pend);
    }
    await del(chat.id, status?.message_id);
    if (!cands.length) { await send(`🙈 找不到「${normalizeQuery(text)}」，請加上縣市區名或路名再試一次。`, {}, chat.id); return askPlace(user, chat, pend.purpose, pend); }
    pend.candidates = cands; pend.seq++; save();
    const label = { home: '🏠 家', work: '🏢 公司', from: '📍 出發地', to: '🎯 目的地' }[pend.purpose];
    const body = cands.map((c, i) => `${i + 1}. ${c.name}${c.address && c.address !== c.name ? `\n   ${c.address}` : ''}`).join('\n');
    const pick = cands.length === 1 ? [{ text: '✅ 就是這裡', callback_data: `dl:c:${pend.sid}:${pend.seq}:0` }] : cands.map((c, i) => ({ text: `✅ ${i + 1}`, callback_data: `dl:c:${pend.sid}:${pend.seq}:${i}` }));
    await send(`🔎 ${label}：找到${cands.length === 1 ? '這個地點' : '這些地點，請選一個'}\n${body}`, inline([pick, [{ text: '✏️ 重新輸入', callback_data: `dl:t:${pend.sid}:${pend.seq}` }, { text: '❌ 取消', callback_data: `dl:x:${pend.sid}:${pend.seq}` }]]), chat.id);
    return { dailuCandidates: cands.length, sessionId: pend.sid };
  }

  async function commit(user, chat, pend, place, { removeKeyboard = false } = {}) {
    const p = profile(user.id); const clean = { name: place.name, address: place.address || '', lat: place.lat, lng: place.lng, town: place.town || '', cityName: place.cityName || '' };
    if (pend.purpose === 'home' || pend.purpose === 'work') {
      p[pend.purpose] = clean; delete pending[user.id]; save();
      const saved = `✅ 已儲存${pend.purpose === 'home' ? '🏠 家' : '🏢 公司'}：${placeLabel(clean)}`;
      const missing = !p.home ? 'home' : !p.work ? 'work' : null;
      if (missing && pend.chain) { await send(saved, removeKeyboard ? removeKb : {}, chat.id); return askPlace(user, chat, missing, { chain: true, then: pend.then }); }
      if (pend.then === 'w' || pend.then === 'h') { await send(saved, removeKeyboard ? removeKb : {}, chat.id); return runTrip(user, chat, pend.then, null); }
      await send(saved, removeKeyboard ? removeKb : {}, chat.id);
      return showMenu(user, chat);
    }
    if (pend.purpose === 'from') { if (removeKeyboard) await send(`📍 出發地：${placeLabel(clean)}`, removeKb, chat.id); return askPlace(user, chat, 'to', { from: clean }); }
    // purpose 'to'
    const from = pend.from; delete pending[user.id];
    if (clean.name !== '📍 分享的位置') { p.recent = [clean, ...(p.recent || []).filter((r) => r.name !== clean.name)].slice(0, DAILU_RECENT_MAX); }
    save();
    if (!from) return askPlace(user, chat, 'from', {});
    return runTrip(user, chat, 'o', null, { from, to: clean, removeKeyboard });
  }

  // ---- route planning; TDX quota is 5 calls/min shared by everything, so every call here is budgeted ----
  const STATIC_TTL = 7 * 24 * 3600e3;          // stops / routes / timetables: change rarely, persisted by the TDX client
  const MAAS_REUSE_MS = 10 * 60e3;             // 🔄 within 10 min re-times the same itineraries with fresh real-time ETA
  const ALIGHT_RESERVE = 3;                    // an uncached StopOfRoute (alighting fix) only when ≥ 4 slots are free: real-time ETA + timetable come first
  const maasMemo = new Map();
  const nameEq = (n) => `RouteName/Zh_tw eq '${String(n).replace(/'/g, "''")}'`;
  const normName = (s) => String(s || '').replace(/[()（）\s]/g, '').replace(/台/g, '臺');
  /** StopOfRoute / Schedule for several routes of one city: cached per route; the missing ones in ONE $filter call. */
  async function perRoute(kind, city, names, opt) {
    const out = new Map(); const missing = [];
    for (const n of new Set(names)) { const hit = tdx.peek?.(`${kind}:${city}:${n}`, STATIC_TTL); if (hit !== undefined) out.set(n, hit); else missing.push(n); }
    if (missing.length) {
      const rows = await opt(`/basic/v2/Bus/${kind}/City/${city}?%24filter=${q(missing.map(nameEq).join(' or '))}&%24format=JSON`, { ttlMs: tdx.put ? 0 : STATIC_TTL });
      if (Array.isArray(rows)) for (const n of missing) { const mine = rows.filter((r) => normName(r?.RouteName?.Zh_tw) === normName(n)); tdx.put?.(`${kind}:${city}:${n}`, mine, STATIC_TTL); out.set(n, mine); }
    }
    return out;
  }
  async function plan(from, to) {
    const t = now(); const notes = []; let rateHit = false, failed = false;
    const calls0 = tdx?.counters ? tdx.counters.calls : null;
    // core calls (MaaS, real-time ETA) are what the answer depends on → say so when they fail; extras degrade silently
    const opt = async (path, o, { core = false } = {}) => { try { return await tdx.get(path, { priority: 'optional', ...o }); } catch (error) { if (core) { if (error?.kind === 'rate') rateHit = true; else failed = true; } return null; } };
    const same = sameDistrict(from, to);
    const wx = (pl) => Promise.resolve().then(() => getWeather(pl)).catch(() => null);
    const weatherP = getWeather ? (same ? wx(from).then((w) => [w, w]) : Promise.all([wx(from), wx(to)])) : Promise.resolve([null, null]);
    const dist = distanceM(from, to);
    const odKey = `${from.lat.toFixed(5)},${from.lng.toFixed(5)}|${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
    let reused = false;
    const keepRoute = (r) => !r.end || r.end > t || firstTransit(r)?.mode === 'bus'; // bus itineraries are re-timed by real-time ETA
    async function loadRoutes(force) {
      const memo = maasMemo.get(odKey);
      if (!force && memo && t - memo.at < MAAS_REUSE_MS) { reused = true; return fixAlights(parseRoutes(memo.json).filter(keepRoute)); }
      const json = await tdx.get(`/maas/routing?origin=${from.lat.toFixed(6)},${from.lng.toFixed(6)}&destination=${to.lat.toFixed(6)},${to.lng.toFixed(6)}&gc=1.0&top=5&transit=4,5,6,7&transfer_time=0,30&first_mile_mode=0&first_mile_time=15&last_mile_mode=0&last_mile_time=15`,
        { ttlMs: force ? 0 : 180e3, priority: 'must', maxWaitMs: 20000 });
      maasMemo.set(odKey, { at: now(), json }); if (maasMemo.size > 50) maasMemo.delete(maasMemo.keys().next().value);
      reused = false; return fixAlights(parseRoutes(json).filter(keepRoute));
    }
    // MaaS can let you off well before the stop nearest the destination → StopOfRoute (one call per city, cached 7 days) picks that stop
    async function fixAlights(routes) {
      const need = routes.map((r) => ({ r, leg: alightCandidate(r) })).filter((x) => x.leg?.city);
      if (!need.length) return routes;
      const cities = [...new Set(need.sort((a, b) => (a.r.end ?? Infinity) - (b.r.end ?? Infinity)).map((x) => x.leg.city))];
      const sorOf = new Map();
      for (const city of cities) {
        const names = [...new Set(need.filter((x) => x.leg.city === city).map((x) => x.leg.name))];
        const cached = names.every((n) => tdx.peek?.(`StopOfRoute:${city}:${n}`, STATIC_TTL) !== undefined);
        if (!cached && typeof tdx.available === 'function' && tdx.available() <= ALIGHT_RESERVE) continue; // quota is tight: a later press does it
        for (const [n, rows] of await perRoute('StopOfRoute', city, names, opt)) sorOf.set(`${city}:${n}`, rows);
      }
      let fixed = 0;
      const out = routes.map((r) => { const leg = alightCandidate(r); const rows = leg?.city ? sorOf.get(`${leg.city}:${leg.name}`) : null; const b = rows?.length ? improveAlight(r, rows, to) : null; if (b) fixed++; return b || r; });
      if (fixed) log.info?.(`dailu: ${fixed} alighting stop(s) moved nearer the destination`);
      return out;
    }
    async function assess(routes) {
      const base = routes.map((r) => evaluateRoute(r, { now: t, threshold }));
      // real-time ETA: bus boarding stops within 600 m of each other share ONE NearBy call, $filter'ed to just those routes (≤ 2 calls)
      const byArrive = (x, y) => (x.arrive ?? Infinity) - (y.arrive ?? Infinity);
      const groups = [];
      for (const e of base.filter((x) => x.leg?.mode === 'bus' && Number.isFinite(x.leg.from.lat)).sort(byArrive)) {
        let g = groups.find((x) => distanceM(x.center, e.leg.from) <= 600);
        if (!g && groups.length < 2) { g = { center: e.leg.from, legs: [] }; groups.push(g); }
        if (g) g.legs.push(e.leg);
      }
      const rowsOf = new Map();
      for (const g of groups) {
        const radius = Math.min(700, Math.max(100, ...g.legs.map((l) => Math.ceil(distanceM(g.center, l.from)) + 100))); // ≥100 m: MaaS stop coords can be ~60 m off TDX's
        const names = [...new Set(g.legs.map((l) => l.name))];
        const rows = await opt(`/advanced/v2/Bus/EstimatedTimeOfArrival/NearBy?${sp(g.center.lat, g.center.lng, radius)}&%24filter=${q(names.map(nameEq).join(' or '))}&%24select=StopUID,StopName,RouteName,Direction,EstimateTime,StopStatus,NextBusTime`, { ttlMs: 25e3 }, { core: true });
        if (rows) for (const l of g.legs) rowsOf.set(l, rows);
      }
      const etaArr = base.map((e) => (e.leg?.mode === 'bus' && rowsOf.has(e.leg) ? matchBusEta(rowsOf.get(e.leg), e.leg) : null));
      // both directions stop here → StopOfRoute decides; one call per city for all such routes, cached 7 days
      const amb = base.map((e, i) => ({ e, i, city: etaArr[i]?.city || e.leg?.city })).filter((x) => etaArr[x.i]?.ambiguous && x.city);
      for (const city of [...new Set(amb.map((x) => x.city))]) {
        const list = amb.filter((x) => x.city === city); const sor = await perRoute('StopOfRoute', city, list.map((x) => x.e.leg.name), opt);
        for (const { e, i } of list) { const rows = sor.get(e.leg.name); const dir = rows?.length ? directionFromStops(rows, e.leg.from.name, e.leg.to.name) : null; if (dir != null) etaArr[i] = matchBusEta(rowsOf.get(e.leg), e.leg, { direction: dir }); }
      }
      let alert = null;
      if (routes.some((r) => r.legs.some((l) => l.mode === 'mrt'))) alert = parseMetroAlert(await opt('/basic/v2/Rail/Metro/Alert/TRTC?%24format=JSON', { ttlMs: 600e3, staleMs: 1800e3 }));
      let evals = routes.map((r, i) => evaluateRoute(r, { now: t, eta: etaArr[i], alert, threshold }));
      // no usable bus right now (尚未發車 without NextBusTime / about to be missed / the timetable run left) → next scheduled departure
      const needs = evals.map((e, i) => (e.leg?.mode === 'bus' && (e.estimate === 'earliest' || (e.source === 'timetable' && e.leg.dep && e.leg.dep < t + walkBefore(e.route) * 1000 - 60e3)) ? i : -1)).filter((i) => i >= 0);
      if (needs.length) {
        const nextDeps = new Map(); const readyOf = (i) => t + walkBefore(routes[i]) * 1000;
        for (const i of needs) { // 1) a later MaaS itinerary on the same route from the same stop costs nothing
          const l = evals[i].leg; const later = evals.filter((x, j) => j !== i && x.leg?.mode === 'bus' && x.leg.name === l.name && x.leg.from.name === l.from.name && x.leg.dep && x.leg.dep >= readyOf(i) - 30e3).map((x) => x.leg.dep).sort((a, b) => a - b)[0];
          if (later) nextDeps.set(i, { at: later, kind: 'schedule' });
        }
        const rest = needs.filter((i) => !nextDeps.has(i)).map((i) => ({ i, l: evals[i].leg, city: etaArr[i]?.city || evals[i].leg.city })).filter((x) => x.city);
        for (const city of [...new Set(rest.map((x) => x.city))]) { // 2) TDX timetable: one $filter call per city, cached 7 days
          const list = rest.filter((x) => x.city === city); const sch = await perRoute('Schedule', city, list.map((x) => x.l.name), opt);
          for (const { i, l } of list) {
            const rows = sch.get(l.name); if (!rows?.length) continue;
            const n = nextScheduledDeparture(rows, { routeName: l.name, direction: etaArr[i] && !etaArr[i].ambiguous ? etaArr[i].direction : null, stopName: l.from.name, legDep: l.dep, readyAt: readyOf(i),
              notDepartedAfter: etaArr[i]?.status === 1 ? t - 60e3 : null });
            if (n) nextDeps.set(i, n);
          }
        }
        if (nextDeps.size) evals = routes.map((r, i) => evaluateRoute(r, { now: t, eta: etaArr[i], alert, threshold, nextDep: nextDeps.get(i) || null }));
      }
      return { evals: evals.filter((e) => reachable(e, t)), alert };
    }
    let routes = [];
    if (dist < 400) notes.push(`兩地很近（約 ${Math.round(dist)} 公尺），走路約 ${walkMin(dist)} 分`);
    else if (!tdx) notes.push('TDX 金鑰尚未設定，無法查路線');
    else {
      try {
        routes = await loadRoutes(false);
        if (!routes.length && reused) routes = await loadRoutes(true);
        if (!routes.length) notes.push(dist < 2000 ? `查不到合適的大眾運輸，走路約 ${walkMin(dist * 1.3)} 分` : '目前查不到大眾運輸路線（可能已收班）');
      } catch (error) { notes.push(error?.kind === 'rate' ? 'TDX 查詢額度暫滿（每分鐘 5 次），請一分鐘後按 🔄' : '路線規劃暫時失敗，請稍後按 🔄 再試'); }
    }
    // no `depart`: MaaS answers 400 for a departure time in the past, and defaults to now anyway
    let evals = [], alert = null;
    if (routes.length) {
      ({ evals, alert } = await assess(routes));
      if (!evals.length && reused) { try { routes = await loadRoutes(true); if (routes.length) ({ evals, alert } = await assess(routes)); } catch { /* keep the note below */ } }
      if (!evals.length) notes.push('時刻表上的班次都已經開走了，請按 🔄 重新查詢');
    }
    const primary = pickPrimary(evals); const hint = sameStopHint(primary, evals);
    let alternatives = [], bikes = [], bikeRideMin = null;
    if (primary?.long) {
      alternatives = pickAlternatives(evals, primary, 2);
      if (tdx && dist < 8000) {
        const st = await opt(`/advanced/v2/Bike/Station/NearBy?${sp(from.lat, from.lng, 400)}&%24select=StationUID,StationName,StationPosition`, { ttlMs: STATIC_TTL });
        const av = st?.length ? await opt(`/advanced/v2/Bike/Availability/NearBy?${sp(from.lat, from.lng, 400)}`, { ttlMs: 60e3 }) : null;
        bikes = parseBikes(st, av, from, { limit: alternatives.length >= 2 ? 1 : 2 }); if (bikes.length) bikeRideMin = Math.ceil((dist * 1.3) / BIKE_M_PER_MIN);
      }
    }
    if (rateHit) notes.push('TDX 每分鐘查詢額度已滿，部分以時刻表估算（一分鐘後可按 🔄）');
    else if (failed) notes.push('部分即時資料暫時查不到，以時刻表估算');
    const [wf, wt] = await weatherP;
    const tdxCalls = calls0 == null ? null : tdx.counters.calls - calls0;
    if (tdxCalls != null) log.info?.(`dailu plan: ${tdxCalls} TDX calls (MaaS ${reused ? 'reused' : 'fetched'}, ${evals.length} options)`);
    return { now: t, primary, alternatives, bikes, bikeRideMin, weather: { from: wf, to: wt }, notes, alert, hint, tdxCalls };
  }

  function tripKeyboard(trip) {
    const r = [{ text: '🔄 重新整理', callback_data: `dl:r:${trip.id}` }];
    if (trip.kind === 'o') return [[...r, { text: '🔁 回程', callback_data: `dl:v:${trip.id}` }], [{ text: '🏢 上班', callback_data: 'dl:w' }, { text: '🏠 下班', callback_data: 'dl:h' }]];
    return [[...r, { text: '⚙️ 設定地點', callback_data: 'dl:s' }], [trip.kind === 'w' ? { text: '🏠 下班', callback_data: 'dl:h' } : { text: '🏢 上班', callback_data: 'dl:w' }, { text: '🏖️ 出去玩', callback_data: 'dl:o' }]];
  }
  async function runTrip(user, chat, kind, editTrip, { from = null, to = null, removeKeyboard = false } = {}) {
    const uid = String(user.id); const p = profile(uid);
    if (busy.has(uid)) return { busy: true };
    if (!editTrip) {
      if (kind === 'w' || kind === 'h') {
        if (!p.home || !p.work) return askPlace(user, chat, !p.home ? 'home' : 'work', { chain: true, then: kind, intro: !p.home && !p.work });
        from = kind === 'w' ? p.home : p.work; to = kind === 'w' ? p.work : p.home;
      }
    } else ({ kind, from, to } = editTrip);
    busy.add(uid);
    try {
      const status = editTrip ? null : await send(`⏳ 小精靈查路線中…`, removeKeyboard ? removeKb : {}, chat.id);
      const result = await plan(from, to);
      const text = renderTrip({ kind, from, to, ...result });
      const trip = editTrip || { id: newId(uid), kind, from, to };
      trip.at = now();
      if (editTrip) { const ok = await editText(chat.id, editTrip.messageId, text, tripKeyboard(trip)); if (!ok) trip.messageId = (await send(text, inline(tripKeyboard(trip)), chat.id))?.message_id; }
      else { const msg = await send(text, inline(tripKeyboard(trip)), chat.id); trip.messageId = msg?.message_id ?? null; await del(chat.id, status?.message_id); }
      trips[uid] = [trip, ...(trips[uid] || []).filter((x) => x.id !== trip.id)].slice(0, 5); save();
      return { dailuTrip: kind, tripId: trip.id, long: Boolean(result.primary?.long), text, tdxCalls: result.tdxCalls };
    } finally { busy.delete(uid); }
  }

  async function startTrip(user, chat, kind) {
    if (kind === 'o') { delete pending[user.id]; return askPlace(user, chat, 'from', {}); }
    return runTrip(user, chat, kind, null);
  }

  return {
    profiles,
    prune() {
      let changed = false; const t = now();
      for (const [uid, p] of Object.entries(pending)) if (t - p.at > DAILU_PENDING_TTL_MS) { delete pending[uid]; changed = true; }
      if (changed) save();
    },
    /** Triggers, location shares and typed answers to a pending place question (private chat only). */
    async onMessage(msg, text) {
      const trigger = isDailuTrigger(text, botUsername());
      const pend = pending[msg.from?.id];
      if (!trigger && !msg.location && !pend) return null;
      if (mode === 'operations') return trigger ? { ignored: 'life feature' } : null;
      const priv = inUserPrivate(msg.chat, msg.from);
      if (trigger) {
        if (!priv) { if (!inGroup(msg.chat)) return null; await privateOnly(msg.chat, msg.from); return { dailuPrivateOnly: true }; }
        if (pend) delete pending[msg.from.id];
        const kind = KIND_WORDS[text]; return kind ? startTrip(msg.from, msg.chat, kind) : showMenu(msg.from, msg.chat);
      }
      if (!priv) return null;
      if (pend && String(pend.chatId) === String(msg.chat.id) && now() - pend.at <= DAILU_PENDING_TTL_MS) {
        if (text.startsWith('/')) return null;
        const rt = msg.reply_to_message; if (rt && pend.promptId && rt.message_id !== pend.promptId) return null;
        return onInput(msg, text, pend);
      }
      if (msg.location) { // a bare location share: start 出去玩 from here
        const place = await placeFromLocation(msg.location);
        return askPlace(msg.from, msg.chat, 'to', { from: place });
      }
      return null;
    },
    async onCallback(cq, action, sid, seq, idx) {
      const user = cq.from, chat = cq.message?.chat;
      if (mode === 'operations') { await answer(cq, '此職責已分流，請使用小精靈。'); return { denied: true }; }
      if (inGroup(chat)) { await answer(cq, '請私訊小精靈使用帶路'); await privateOnly(chat, user); return { dailuPrivateOnly: true }; }
      if (!inUserPrivate(chat, user)) { await answer(cq); return { ignored: 'chat' }; }
      if (!await isGroupMember(user)) { await answer(cq, '🚫⛔ 這一切已與你無關！👋'); return { denied: true }; }
      const uid = String(user.id);
      if (busy.has(uid)) { await answer(cq, '小精靈還在查，請稍候…'); return { busy: true }; }
      if (action === 'm') { await answer(cq); return showMenu(user, chat); }
      if (action === 'w' || action === 'h' || action === 'o') { await answer(cq, { w: '查上班路線…', h: '查下班路線…', o: '出去玩！' }[action]); delete pending[uid]; return startTrip(user, chat, action); }
      if (action === 's') { await answer(cq); return showSettings(user, chat); }
      if (action === 'e') { await answer(cq); if (!['h', 'w'].includes(sid)) return { ignored: 'bad edit' }; return askPlace(user, chat, sid === 'h' ? 'home' : 'work', {}); }
      if (action === 'k') { profile(uid).recent = []; save(); await answer(cq, '已清除最近目的地'); await strip(chat.id, cq.message?.message_id); return { dailuRecentCleared: true }; }
      if (action === 'r' || action === 'v') {
        const trip = (trips[uid] || []).find((x) => x.id === sid);
        if (!trip) { await answer(cq, '這筆查詢已過期，請重新點選'); await strip(chat.id, cq.message?.message_id); return { stale: true }; }
        if (action === 'r') { await answer(cq, '🔄 重新整理'); return runTrip(user, chat, trip.kind, { ...trip, messageId: cq.message?.message_id ?? trip.messageId }); }
        await answer(cq, '🔁 查回程'); return runTrip(user, chat, 'o', null, { from: trip.to, to: trip.from });
      }
      const pend = pending[uid];
      if (!pend || pend.sid !== sid || String(pend.seq) !== String(seq) || now() - pend.at > DAILU_PENDING_TTL_MS) { await answer(cq, '這個按鈕已過期'); await strip(chat.id, cq.message?.message_id); return { stale: true }; }
      await strip(chat.id, cq.message?.message_id);
      if (action === 'x') { delete pending[uid]; save(); await answer(cq, '已取消'); return { dailuCancelled: true }; }
      if (action === 't') { await answer(cq); return askPlace(user, chat, pend.purpose, pend); }
      if (action === 'c') {
        const place = pend.candidates?.[Number(idx)]; if (!place) { await answer(cq, '這個按鈕已過期'); return { stale: true }; }
        pend.seq++; await answer(cq, '✅ 已確認'); return commit(user, chat, pend, place);
      }
      await answer(cq); return { ignored: 'unknown' };
    },
  };
}
