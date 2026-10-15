// Game GPT conversation cleanup (zero AI), shared by 小精靈 and 小遊戲精靈.
// Every ChatGPT conversation a game creates (海龜湯 etc.) is registered in ONE shared file (state/game-gpt-conversations.json, guarded by a
// .lock file). A conversation with no new message for idleMs (30 min) is DELETED in ChatGPT and its tab is closed.
// Only registered (game-created) conversations are ever touched; never one with an in-flight request; never the last tab of the Chrome.
// Each bot sweeps its own entries plus orphans (owner process gone, e.g. before a restart); a claim in the registry prevents double deletes.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { assertDedicatedEndpoint } from './dedicated-window.js';
import { withBrowserJob } from './browser-activity.js';
import { deleteGptConversation } from './haigui-scene.js';
import { isPidAlive } from './util.js';

export const DEFAULT_REGISTRY = path.resolve(import.meta.dirname, '..', 'state', 'game-gpt-conversations.json');
const MIN = 60e3;
export const convIdOf = (url) => /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(?:.*\/)?c\/([A-Za-z0-9-]+)/i.exec(String(url || ''))?.[1] || null;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Synchronous read-modify-write of the shared registry under an exclusive-create lock file (stale after 30 s or when its pid is dead). */
export function withRegistry(file, fn, { pidAlive = isPidAlive, waitMs = 5000 } = {}) {
  const lock = file + '.lock'; fs.mkdirSync(path.dirname(file), { recursive: true });
  const end = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let cur = null; try { cur = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* being written */ }
      if (cur && (!pidAlive(cur.pid) || Date.now() - cur.at > 30e3)) { try { fs.unlinkSync(lock); } catch { /* raced */ } continue; }
      if (Date.now() > end) throw new Error('game GPT registry is locked');
      sleepSync(50);
    }
  }
  try {
    let data = { conversations: {}, inflight: {} };
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
    data.conversations ??= {}; data.inflight ??= {};
    const out = fn(data);
    const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file);
    return out;
  } finally { try { fs.unlinkSync(lock); } catch { /* ignore */ } }
}

/** Pure: which registered conversations this process should delete now. */
export function planGameGptSweep(data, { owner, pid, now, idleMs = 30 * MIN, abandonGraceMs = 5 * MIN, claimMs = 10 * MIN, inflightMs = 20 * MIN, pidAlive = isPidAlive }) {
  const busy = new Set(Object.values(data.inflight || {}).filter((f) => pidAlive(f.pid) && now - f.since < inflightMs).map((f) => f.owner + '|' + f.sessionKey));
  const pick = [];
  for (const [id, e] of Object.entries(data.conversations || {})) {
    const ownerAlive = pidAlive(e.pid);
    if (e.owner !== owner && ownerAlive) continue; // the other bot sweeps its own conversations
    if (busy.has(e.owner + '|' + e.sessionKey)) continue; // a request is running in this game conversation
    if (e.claim && e.claim.pid !== pid && pidAlive(e.claim.pid) && now - e.claim.at < claimMs) continue; // being deleted by the other bot
    const idle = now - (e.lastActivity || e.createdAt || 0);
    if (idle < idleMs) continue;
    // a game still running but silent for idleMs = abandoned; give its own timeout (海龜湯 20 min) a short grace to end it gracefully first
    if (!e.ended && ownerAlive && e.pid === pid && idle < idleMs + abandonGraceMs) continue;
    pick.push({ id, ...e, abandoned: !e.ended });
  }
  return pick;
}

export function createGameGptCleanup({ owner, file = DEFAULT_REGISTRY, endpoint = 'http://127.0.0.1:19386', newChatUrl = 'https://chatgpt.com/', idleMs = 30 * MIN, abandonGraceMs = 5 * MIN,
  release = null, log, pid: myPid = process.pid, chromiumImpl = chromium, deleteConversation = deleteGptConversation, browserJob = withBrowserJob, now = () => Date.now(), pidAlive = isPidAlive, maxAttempts = 3 } = {}) {
  if (!owner) throw new Error('game GPT cleanup needs an owner name');
  assertDedicatedEndpoint(endpoint);
  const reg = (fn) => withRegistry(file, fn, { pidAlive });
  let seq = 0; let sweeping = null;
  const touch = (data, sessionKey, t) => { for (const e of Object.values(data.conversations)) if (e.owner === owner && e.sessionKey === sessionKey) { e.lastActivity = t; e.pid = myPid; } };
  function record(sessionKey, meta, url, t) {
    const id = convIdOf(url);
    return (data) => {
      touch(data, sessionKey, t);
      if (id) { const e = data.conversations[id] ||= { owner, sessionKey, gameId: meta.gameId ?? null, title: meta.title || '', createdAt: t }; Object.assign(e, { owner, pid: myPid, url, lastActivity: t, ended: false }); }
    };
  }
  const safe = (what, fn) => { try { return fn(); } catch (error) { log?.warn?.(`game GPT registry ${what} failed: ${error.message}`); return null; } };

  /** Run one game GPT request: marks it in flight (never swept meanwhile) and registers the conversation it used (client.currentUrl()). */
  async function track(sessionKey, meta, client, run) {
    const token = `${owner}:${myPid}:${++seq}`;
    safe('begin', () => reg((data) => { data.inflight[token] = { owner, pid: myPid, sessionKey, since: now() }; touch(data, sessionKey, now()); }));
    try { return await run(); }
    finally {
      let url = null; try { url = client?.currentUrl?.() || null; } catch { /* ignore */ }
      safe('end', () => reg((data) => { delete data.inflight[token]; record(sessionKey, meta, url, now())(data); }));
    }
  }
  /** The game ended (or detached this client): its conversations are swept idleMs after their last message. */
  function ended(sessionKey) { safe('ended', () => reg((data) => { for (const e of Object.values(data.conversations)) if (e.owner === owner && e.sessionKey === sessionKey) e.ended = true; })); }
  /** Register game sessions left in the bridge state by an earlier run (no message seen yet → idle counts from now). */
  function seed(sessions) {
    safe('seed', () => reg((data) => {
      for (const s of sessions) { const id = convIdOf(s.url); if (id && !data.conversations[id]) data.conversations[id] = { owner, pid: myPid, sessionKey: s.sessionKey, gameId: s.gameId ?? null, title: s.title || '', url: s.url, createdAt: now(), lastActivity: now(), ended: false, seeded: true }; }
      for (const [k, f] of Object.entries(data.inflight)) if (!pidAlive(f.pid)) delete data.inflight[k];
    }));
  }

  async function deleteOne(ctx, e) {
    const onIt = (p) => p.url().includes('/c/' + e.id);
    let page = ctx.pages().find(onIt) || null;
    if (!page) { page = await ctx.newPage(); await page.goto(e.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); }
    let how = false;
    try {
      await page.bringToFront().catch(() => {});
      await page.locator('button[data-testid="conversation-options-button"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      how = onIt(page) ? await deleteConversation(page, e.id) : 'already gone';
    } finally {
      if (ctx.pages().length <= 1) { const keep = await ctx.newPage(); await keep.goto(newChatUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); } // never close Chrome's last tab
      await page.close().catch((error) => log?.warn?.(`game GPT tab close failed: ${error.message}`));
    }
    return how;
  }

  /** Delete + close every idle game conversation this process is responsible for. */
  function sweep(reason = 'periodic') {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      const pid = myPid; const t = now();
      const picked = safe('plan', () => reg((data) => {
        const list = planGameGptSweep(data, { owner, pid, now: t, idleMs, abandonGraceMs, pidAlive });
        for (const e of list) data.conversations[e.id].claim = { pid, at: t };
        return list;
      })) || [];
      if (!picked.length) return { deleted: 0, failed: 0 };
      for (const e of picked) if (e.abandoned && e.owner === owner) { try { release?.(e); } catch (error) { log?.warn?.(`game GPT release failed: ${error.message}`); } }
      const results = new Map();
      const r = await browserJob(async () => {
        let browser = null;
        try {
          browser = await chromiumImpl.connectOverCDP(endpoint, { timeout: 10000 });
          const ctx = browser.contexts()[0]; if (!ctx) throw new Error('no browser context');
          for (const e of picked) {
            try { results.set(e.id, await deleteOne(ctx, e)); }
            catch (error) { results.set(e.id, false); log?.warn?.(`game GPT conversation ${e.id} cleanup error: ${error.message}`); }
          }
        } finally { await browser?.close().catch(() => {}); } // disconnect only
      }).then(() => null, (error) => error);
      if (r) log?.warn?.(`game GPT cleanup (${reason}) could not reach Chrome: ${r.message}`);
      let deleted = 0, failed = 0;
      safe('finish', () => reg((data) => {
        for (const e of picked) {
          const cur = data.conversations[e.id]; if (!cur) continue;
          const how = results.get(e.id);
          if ((cur.lastActivity || 0) > t) { delete cur.claim; continue; } // used again meanwhile: keep
          if (how) { delete data.conversations[e.id]; deleted++; log?.info?.(`game GPT conversation ${e.id} (${e.title || e.sessionKey}${e.abandoned ? ', abandoned' : ''}) deleted (${how}) and tab closed`); }
          else if (results.has(e.id) && (cur.attempts = (cur.attempts || 0) + 1) >= maxAttempts) { delete data.conversations[e.id]; failed++; log?.warn?.(`game GPT conversation ${e.id} NOT deleted after ${cur.attempts} tries; dropped from the registry (tab closed)`); }
          else { delete cur.claim; failed++; }
        }
      }));
      log?.info?.(`game GPT cleanup (${reason}): ${picked.length} idle -> deleted ${deleted}${failed ? ', retry/failed ' + failed : ''}`);
      return { deleted, failed };
    })().finally(() => { sweeping = null; });
    return sweeping;
  }
  return { track, ended, seed, sweep };
}
