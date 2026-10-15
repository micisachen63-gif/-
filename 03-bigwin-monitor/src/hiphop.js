import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, fmtStamp, sleep } from './util.js';

export const PLAYLIST_TITLE = '小精靈｜每日嘻哈熱歌';
const API = 'https://www.googleapis.com/youtube/v3';
const SCOPE_ERROR = 'YouTube 授權已失效，請重新授權後再試';
// Curated official artist channels focusing on Melodic Rap, Emotional Rap, and Acoustic Trap
// (Post Malone, LOVIXX, The Kid LAROI, Juice WRLD, etc.)
const CHANNELS = [
  'UCCUfV7cYLzy1RqFa-tg4cIA', // LOVIXX
  'UCeLHszkByNZtPKcaVXOCOQQ', // Post Malone
  'UCOhtMAg7xh8wv_wUHMgFc-Q', // PostMaloneVEVO
  'UCyD3XWRK9ko-izf2nBSFitw', // Post Malone - Topic
  'UC6G2vAJrt407lwiynW116Eg', // The Kid LAROI
  'UC0BletW9phE4xHFM44q4qKA', // Juice WRLD
  'UCtpzjafUx5qbmxJdqm4-qmg', // iann dior
  'UCLvAxkjgDXIrO-IDNIBgnEg', // Trevor Daniel
  'UCR-eqHJMez-6oFJklTIqJ5Q', // 24kGoldn
  'UCUJTvb20oc_15y3DRNvZlEA', // Swae Lee
  'UCgT01FILdWB9BsXBXKjpQ7A', // Don Toliver
  'UCcwcJT8pVnq5MIDuNfca38Q', // Dominic Fike
  'UCKI6DNZu8-X5VWI0FEEYCTA', // Bazzi
  'UC9iPVgY-pv8Af7T75ujpiuw', // Arizona Zervas
  'UCmR-xOM0ZjY1cPdFp2WXT4g', // Powfu
  'UCHDByzNs5ejIa-ZJGHfA5CQ', // STOSLIV
  'UChQdA1rid5kKZh6oIc6DLNg', // Roddy Ricch
  'UCUs8sGiP4avNaYNVO22INhQ', // mgk (Machine Gun Kelly)
  'UC0gOw4iy-6HwO01q-gA1B0Q', // Lil Peep
  'UCOlxqtcKc-HBEQJgDsylyhA', // Lil Tecca
  'UCEB4a5o_6KfjxHwNMnmj54Q', // Lil Tjay
  'UCstw-41J8syXgdJ8xWvaizA', // Trippie Redd
];
const badTitle = /\b(mix|compilation|reaction|type beat|karaoke|cover|lyrics?|slowed|sped up|playlist|instrumental|ai generated|interview|trailer|teaser|vlog|behind the scenes|bts|live (?:in|at))\b/i;
const goodTitle = /\b(official (music )?video|official audio|official visualizer|visualizer)\b/i;
const dateInTaipei = (ms) => fmtStamp(ms).slice(0, 10);
const durationSeconds = (iso) => { const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const canonicalTitle = (s) => clean(s).toLowerCase().replace(/\([^)]*official[^)]*\)|\[[^\]]*official[^\]]*\]/gi, '').replace(/\W+/g, ' ').trim();

export function selectHiphopVideos(videos, seen = {}, now = Date.now(), limit = 30) {
  const result = [], titles = new Set();
  for (const v of videos) {
    const title = clean(v.snippet?.title);
    const rawChannel = clean(v.snippet?.channelTitle);
    const channel = rawChannel.replace(/\s*-\s*Topic$/i, '');
    const ageDays = (now - Date.parse(v.snippet?.publishedAt || 0)) / 86400e3;
    const seconds = durationSeconds(v.contentDetails?.duration);
    const isTopic = rawChannel.toLowerCase().endsWith('- topic');
    const isDash = title.includes('-') || title.includes('–') || title.includes('—');
    const titleOk = goodTitle.test(title) || isTopic || isDash;
    if (!v.id || seen[v.id] || !['10', '22'].includes(v.snippet?.categoryId) || ageDays < 0 || ageDays > 90 || seconds < 75 || seconds > 600 || badTitle.test(title) || !titleOk) continue;
    const key = canonicalTitle(title);
    if (!key || titles.has(key)) continue;
    titles.add(key);
    const views = Number(v.statistics?.viewCount || 0);
    result.push({ id: v.id, title, channel, views, publishedAt: v.snippet.publishedAt,
      score: Math.round(views / Math.pow(Math.max(1, ageDays), 0.65)) });
  }
  const byArtist = new Map(), selected = [];
  for (const item of result.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
    const artist = item.channel.toLowerCase().replace(/^theofficial/, '').replace(/vevo$/, '').replace(/\W+/g, '');
    if ((byArtist.get(artist) || 0) >= 4) continue;
    byArtist.set(artist, (byArtist.get(artist) || 0) + 1);
    selected.push(item);
    if (selected.length === limit) break;
  }
  return selected;
}

export function createHiphop({ root, telegram, chatId, ownerId, fetchImpl = fetch, now = Date.now, log = console }) {
  const authDir = path.join(root, '.auth');
  const stateFile = path.join(root, 'state', 'hiphop.json');
  const state = readJson(stateFile, { seen: {}, recommendations: {}, playlistId: null, lastDate: null });
  const save = () => writeJsonAtomic(stateFile, state);
  let busy = false;

  async function token() {
    const tokenFile = path.join(authDir, 'youtube-token.json');
    const clientFile = path.join(authDir, 'youtube-client.json');
    const t = readJson(tokenFile, null), c = readJson(clientFile, null)?.installed;
    if (!t?.refresh_token || !c?.client_id || !c?.client_secret) throw new Error(SCOPE_ERROR);
    if (t.access_token && now() < t.obtained_at + (Number(t.expires_in) - 90) * 1000) return t.access_token;
    const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }) });
    const body = await response.json();
    if (!response.ok || !body.access_token) throw new Error(SCOPE_ERROR);
    const refreshed = { ...t, ...body, refresh_token: body.refresh_token || t.refresh_token,
      obtained_at: now(), refresh_obtained_at: t.refresh_obtained_at || t.obtained_at };
    fs.writeFileSync(tokenFile, JSON.stringify(refreshed, null, 2), { mode: 0o600 });
    return refreshed.access_token;
  }

  async function youtube(method, endpoint, params = {}, body) {
    const url = new URL(API + endpoint);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    const response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${await token()}`,
      ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) { const error = new Error(`YouTube ${endpoint} HTTP ${response.status}: ${data.error?.message || '未知錯誤'}`); error.status = response.status; throw error; }
    return data;
  }

  async function discover() {
    // Keep the full rolling window: yesterday's top 30 must not hide other
    // eligible, unseen releases that are still recent today.
    const cutoff = now() - 90 * 86400e3;
    const channels = await youtube('GET', '/channels', { part: 'contentDetails', id: CHANNELS.join(','), maxResults: 50 });
    const ids = new Set();
    const uploads = (channels.items || []).map(x => x.contentDetails?.relatedPlaylists?.uploads).filter(Boolean);
    for (let i = 0; i < uploads.length; i += 5) {
      const batch = await Promise.all(uploads.slice(i, i + 5).map(playlistId =>
        youtube('GET', '/playlistItems', { part: 'snippet', playlistId, maxResults: 50 })));
      for (const data of batch) for (const item of data.items || []) {
        if (Date.parse(item.snippet?.publishedAt || 0) >= cutoff && item.snippet?.resourceId?.videoId)
          ids.add(item.snippet.resourceId.videoId);
      }
    }
    const videos = [];
    const all = [...ids];
    for (let i = 0; i < all.length; i += 50) {
      const data = await youtube('GET', '/videos', { part: 'snippet,statistics,contentDetails', id: all.slice(i, i + 50).join(','), maxResults: 50 });
      videos.push(...(data.items || []));
    }
    return selectHiphopVideos(videos, state.seen, now());
  }

  function formatRecommendation(items, date) {
    const lines = items.map((v, i) => `${i + 1}. ${v.title} — ${v.channel}\nhttps://youtu.be/${v.id}`);
    const messages = [], header = `🎧 ${date} 旋律嘻哈新歌推薦（${items.length} 首，精選 Post Malone / LOVIXX 等旋律氛圍風格）\n\n`;
    let message = header;
    for (const line of lines) {
      if (message.length + line.length + 2 > 3700) { messages.push(message.trim()); message = ''; }
      message += line + '\n\n';
    }
    if (message.trim()) messages.push(message.trim());
    return messages;
  }

  async function recommend({ retryEmpty = false } = {}) {
    const date = dateInTaipei(now());
    if (busy || (state.lastDate === date && (!retryEmpty || state.recommendations[date]))) return { skipped: true };
    busy = true;
    try {
      // Never automatically resend an ambiguous Telegram post after a crash.
      if (state.pendingDate === date) return { skipped: true, pending: true };
      const items = await discover();
      if (!items.length) { state.lastDate = date; state.lastCheckedAt = now(); save(); return { skipped: true, noNewSongs: true }; }
      state.pendingDate = date; state.recommendations[date] = { items, status: 'pending' }; save();
      const messages = formatRecommendation(items, date);
      let last;
      for (let i = 0; i < messages.length; i++) {
        last = await telegram.call('sendMessage', { chat_id: chatId, text: messages[i], disable_web_page_preview: true,
          ...(i === messages.length - 1 ? { reply_markup: { inline_keyboard: [[{ text: '🎵 加入歌單', callback_data: `hp:add:${date}` }]] } } : {}) });
      }
      for (const item of items) state.seen[item.id] = date;
      state.recommendations[date].messageId = last.message_id;
      state.recommendations[date].status = 'sent';
      state.lastDate = date; state.lastCheckedAt = now(); delete state.pendingDate; delete state.retryAfter; save();
      return { sent: items.length, date };
    } catch (error) {
      if (error.message === SCOPE_ERROR) {
        const t = readJson(path.join(authDir, 'youtube-token.json'), null);
        state.authBlockedAt = t?.refresh_obtained_at || t?.obtained_at || now();
      } else state.retryAfter = now() + 30 * 60_000;
      save(); log.error?.(`hiphop recommendation failed: ${error.message}`); throw error;
    }
    finally { busy = false; }
  }

  async function playlistItems(playlistId) {
    const ids = new Set(); let pageToken;
    do {
      let data;
      for (let attempt = 0; ; attempt++) {
        try { data = await youtube('GET', '/playlistItems', { part: 'snippet', playlistId, maxResults: 50, pageToken }); break; }
        catch (error) { if (![404, 409].includes(error.status) || attempt >= 4) throw error; await sleep(500 * 2 ** attempt); }
      }
      for (const item of data.items || []) if (item.snippet?.resourceId?.videoId) ids.add(item.snippet.resourceId.videoId);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return ids;
  }

  async function ensurePlaylist() {
    if (state.playlistId) {
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await youtube('GET', '/playlists', { part: 'snippet,status', id: state.playlistId });
          if (data.items?.length !== 1 || data.items[0].snippet?.title !== PLAYLIST_TITLE)
            throw new Error('已記錄的播放清單不存在或名稱不符；已停止，避免另建重複歌單');
          if (data.items[0].status?.privacyStatus === 'private') throw new Error('同名歌單是私人狀態，無法分享給群友');
          return state.playlistId;
        } catch (error) {
          if (![404, 409].includes(error.status) || attempt >= 4) throw error;
          await sleep(500 * 2 ** attempt);
        }
      }
    }
    const matches = []; let pageToken;
    do {
      const data = await youtube('GET', '/playlists', { part: 'snippet,status', mine: true, maxResults: 50, pageToken });
      matches.push(...(data.items || []).filter(x => x.snippet?.title === PLAYLIST_TITLE));
      pageToken = data.nextPageToken;
    } while (pageToken);
    if (matches.length > 1) throw new Error('找到多個同名播放清單，已停止避免寫入錯誤歌單');
    if (matches.length === 1) {
      if (matches[0].status?.privacyStatus === 'private') throw new Error('同名歌單是私人狀態，無法分享給群友');
      state.playlistId = matches[0].id;
    }
    else {
      const created = await youtube('POST', '/playlists', { part: 'snippet,status' }, { snippet: { title: PLAYLIST_TITLE,
        description: '小精靈每日推薦的嘻哈新歌。點選 Telegram「加入歌單」時追加，不重建。' }, status: { privacyStatus: 'unlisted' } });
      state.playlistId = created.id;
    }
    save(); return state.playlistId;
  }

  async function add(date, userId) {
    if (String(userId) !== String(ownerId)) return { unauthorized: true };
    if (busy) return { busy: true };
    const rec = state.recommendations[date];
    if (!rec || !['sent', 'added'].includes(rec.status)) return { missing: true };
    busy = true;
    try {
      const playlistId = await ensurePlaylist();
      const existing = await playlistItems(playlistId);
      let added = 0;
      for (const item of rec.items) {
        if (existing.has(item.id)) continue;
        for (let attempt = 0; ; attempt++) {
          try {
            await youtube('POST', '/playlistItems', { part: 'snippet' }, { snippet: { playlistId,
              resourceId: { kind: 'youtube#video', videoId: item.id } } });
            added++; break;
          } catch (error) {
            if (![404, 409].includes(error.status) || attempt >= 4) throw error;
            await sleep(500 * 2 ** attempt);
            if ((await playlistItems(playlistId)).has(item.id)) break;
          }
        }
        existing.add(item.id);
      }
      const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
      rec.status = 'added'; rec.added = added; rec.playlistId = playlistId; save();
      if (rec.messageId) {
        try { await telegram.call('editMessageReplyMarkup', { chat_id: chatId, message_id: rec.messageId,
          reply_markup: { inline_keyboard: [[{ text: '🎧 我也要聽', url }]] } }); }
        catch (error) { if (!/message is not modified/i.test(error.message)) throw error; }
      }
      return { added, playlistId, url };
    } finally { busy = false; }
  }

  async function handleUpdate(update) {
    const cq = update?.callback_query;
    const m = /^hp:add:(\d{4}-\d{2}-\d{2})$/.exec(String(cq?.data || ''));
    if (!m) return null;
    const rec = state.recommendations[m[1]];
    const short = String(cq.from?.id) !== String(ownerId) ? '只有歌單擁有者可以加入歌曲' : busy ?
      '歌單正在更新，請稍候' : !rec || !['sent', 'added'].includes(rec.status) ? '這份推薦已過期或尚未送出' : null;
    if (short) { await telegram.call('answerCallbackQuery', { callback_query_id: cq.id, text: short }); return { skipped: true }; }
    const task = add(m[1], cq.from.id);
    try { await telegram.call('answerCallbackQuery', { callback_query_id: cq.id, text: '正在核對並更新同一份歌單，完成後會在群內通知。' }); }
    catch (error) { log.warn?.(`hiphop callback acknowledgement failed: ${error.message}`); }
    task.then(async result => {
      if (!result.busy && !result.missing) await telegram.call('sendMessage', { chat_id: chatId,
        text: `🎧 歌單更新完成：本次新增 ${result.added} 首。群友可點上方「我也要聽」開啟同一份歌單。`,
        reply_to_message_id: rec.messageId, allow_sending_without_reply: true }).catch(error =>
        log.error?.(`hiphop completion notice failed: ${error.message}`));
    }).catch(async error => {
      log.error?.(`hiphop playlist add failed: ${error.message}`);
      try { await telegram.call('sendMessage', { chat_id: chatId,
        text: `⚠️ 歌單更新暫時中斷：${error.message.slice(0, 220)}。已成功加入的歌曲會保留；再按一次會讀回後只補缺少的，不會重建歌單。`,
        reply_to_message_id: rec.messageId, allow_sending_without_reply: true }); }
      catch (notifyError) { log.error?.(`hiphop failure notice failed: ${notifyError.message}`); }
    });
    return { started: true };
  }

  async function remindAuthorization() {
    const t = readJson(path.join(authDir, 'youtube-token.json'), null);
    const expiry = (t?.refresh_obtained_at || t?.obtained_at || 0) + Number(t?.refresh_token_expires_in || 0) * 1000;
    if (!expiry || expiry - now() > 2 * 86400e3 || state.authReminderDate === dateInTaipei(now())) return false;
    await telegram.call('sendMessage', { chat_id: ownerId,
      text: expiry <= now() ?
        '⚠️ 小精靈的 YouTube 測試授權已到期，歌單更新已暫停。請在電腦雙擊「重新授權YouTube.cmd」，於 Google 視窗親自同意；不會另建重複歌單。' :
        '⚠️ 小精靈的 YouTube 測試授權將在 2 天內到期。請在電腦雙擊「重新授權YouTube.cmd」，於 Google 視窗親自同意；到期後會暫停歌單更新。' });
    state.authReminderDate = dateInTaipei(now()); save(); return true;
  }
  function due() {
    const stamp = fmtStamp(now()), t = readJson(path.join(authDir, 'youtube-token.json'), null);
    const authVersion = t?.refresh_obtained_at || t?.obtained_at || 0;
    return stamp.slice(11, 16) >= '13:30' && state.lastDate !== stamp.slice(0, 10) &&
      state.pendingDate !== stamp.slice(0, 10) && (state.retryAfter || 0) <= now() &&
      state.authBlockedAt !== authVersion;
  }
  return { recommend, add, handleUpdate, due, discover, remindAuthorization, state };
}
