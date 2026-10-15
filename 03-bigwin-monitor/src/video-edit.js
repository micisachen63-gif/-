// Reply-to-continue-editing for Grok videos: TG (chat, message) of each delivered video -> its Grok post URL, kept ~7 days.
import fs from 'node:fs';
import path from 'node:path';

export const VIDEO_MAP_TTL_MS = 7 * 24 * 3600 * 1000;
const NO_TEXT = '\u270f\ufe0f \u8acb\u5728\u56de\u8986\u88e1\u5beb\u4e0b\u60f3\u600e\u9ebc\u4fee\u6539\u9019\u652f\u5f71\u7247\uff0c\u4f8b\u5982\u300c\u8b93\u5979\u8f49\u982d\u5fae\u7b11\u300d\u3002';
const EXPIRED = '\u23f3 \u9019\u652f\u5f71\u7247\u5df2\u8d85\u904e 7 \u5929\uff0c\u5c0f\u7cbe\u9748\u6c92\u6709\u4fdd\u7559\u5b83\u7684 Grok \u7de8\u8f2f\u7d00\u9304\uff0c\u7121\u6cd5\u63a5\u7e8c\u4fee\u6539\u3002';
const UNMAPPED = '\ud83e\udd14 \u9019\u652f\u5f71\u7247\u6c92\u6709\u53ef\u63a5\u7e8c\u7684 Grok \u7de8\u8f2f\u7d00\u9304\uff08\u53ef\u80fd\u662f\u529f\u80fd\u4e0a\u7dda\u524d\u505a\u7684\uff0c\u6216\u4e0d\u662f\u7528 Grok \u505a\u7684\uff09\uff0c\u7121\u6cd5\u63a5\u7e8c\u4fee\u6539\u3002';
const HOW_NEW = '\u82e5\u8981\u505a\u65b0\u5f71\u7247\uff1a\u56de\u8986\u6642\u9644\u4e0a\u4e00\u5f35\u5716\u7247\uff08\u4f8b\u5982\u9019\u652f\u5f71\u7247\u7684\u622a\u5716\uff09\u4e26\u5beb\u4e0b\u6307\u793a\uff0c\u5c0f\u7cbe\u9748\u5c31\u6703\u7528\u5b83\u7576\u8d77\u59cb\u756b\u9762\u91cd\u65b0\u88fd\u4f5c\u3002';
export const VIDEO_REPLY_TEXT = { NO_TEXT, EXPIRED, UNMAPPED, HOW_NEW };

/** A video message sent by a bot (by this bot when its username is known). */
export const isBotVideoMessage = (m, botUsername = null) => Boolean(m?.from?.is_bot
  && (!botUsername || !m.from.username || m.from.username.toLowerCase() === String(botUsername).toLowerCase())
  && (m.video || m.animation || /^video\//i.test(m.document?.mime_type || '')));

export function createVideoMap({ file = null, ttlMs = VIDEO_MAP_TTL_MS, max = 3000, now = () => Date.now(), log } = {}) {
  let data = {};
  if (file) { try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { data = {}; } }
  const key = (chatId, messageId) => String(chatId) + ':' + String(messageId);
  const save = () => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file); }
    catch (error) { log?.warn?.('video map save failed: ' + error.message); }
  };
  const prune = () => {
    const t = now(); let changed = false;
    for (const [k, v] of Object.entries(data)) if (!v?.url || t - (v.at || 0) > ttlMs) { delete data[k]; changed = true; }
    const keys = Object.keys(data);
    if (keys.length > max) { for (const k of keys.sort((a, b) => data[a].at - data[b].at).slice(0, keys.length - max)) delete data[k]; changed = true; }
    return changed;
  };
  if (prune()) save();
  return {
    set(chatId, messageId, info) { if (!info?.url) return; data[key(chatId, messageId)] = { postId: info.postId || null, videoId: info.videoId || null, url: info.url, userId: info.userId ?? null, at: now() }; prune(); save(); log?.info?.('video map: ' + key(chatId, messageId) + ' -> post ' + (info.postId || '?')); },
    get(chatId, messageId) { const v = data[key(chatId, messageId)]; if (!v) return null; if (now() - v.at > ttlMs) { delete data[key(chatId, messageId)]; save(); return null; } return v; },
    prune() { if (prune()) save(); },
    size: () => Object.keys(data).length,
  };
}

/**
 * What to do with a message that replies to one of our videos. null = not such a reply (normal handling).
 * edit: continue editing the mapped Grok post. new: the reply brings its own picture, so make a new video from it. explain: tell the user why not.
 */
export function videoReplyAction({ msg, hasImages = false, map, now = Date.now(), ttlMs = VIDEO_MAP_TTL_MS }) {
  const rt = msg?.reply_to_message;
  if (!isBotVideoMessage(rt)) return null;
  const prompt = String(msg.text || msg.caption || '').trim();
  if (!prompt) return { action: 'explain', text: NO_TEXT };
  if (hasImages) return { action: 'new', prompt };
  const m = map?.get(msg.chat.id, rt.message_id);
  if (m?.url) return { action: 'edit', prompt, postUrl: m.url, postId: m.postId };
  const old = rt.date && now - rt.date * 1000 > ttlMs;
  return { action: 'explain', text: (old ? EXPIRED : UNMAPPED) + '\n' + HOW_NEW };
}