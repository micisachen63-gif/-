// Zero-AI tab cleanup for the dedicated Chrome (CDP 19386 only; 9222 = the user's / Codex's Chrome is refused).
// Keeps one reusable main tab per site, closes tabs idle > idleMs, leftover Grok Imagine tabs and blank tabs; never the last tab.
import { tabLastUse, withExclusiveBrowser } from './browser-activity.js';

const SITE_RE = { chatgpt: /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i, grok: /^https:\/\/(?:www\.)?grok\.com\//i };
const IMAGINE_RE = /^https:\/\/(?:www\.)?grok\.com\/imagine(?:[/?#]|$)/i;
export function siteOf(url) {
  const u = String(url || '');
  if (SITE_RE.chatgpt.test(u)) return 'chatgpt';
  if (SITE_RE.grok.test(u)) return 'grok';
  if (!u || u === 'about:blank' || /^chrome:\/\/(?:newtab|new-tab-page)/i.test(u)) return 'blank';
  return 'other';
}
// Tabs the code reuses: any ChatGPT tab (per-user conversations reopen from their saved URL) and Grok chat tabs.
// Grok Imagine tabs are opened fresh by each video job and closed by it, so a leftover one is never the main tab.
const reusable = (t) => t.site === 'chatgpt' || (t.site === 'grok' && !IMAGINE_RE.test(t.url));

/** Pure plan. tabs: [{ id, url, lastUse (ms|null, from noteTabUse), firstSeen (ms, first time the cleanup saw this url in this tab) }]. */
export function planTabCleanup(tabs, { now, idleMs = 20 * 60 * 1000 }) {
  const list = tabs.map((t) => ({ ...t, site: siteOf(t.url) }));
  const keep = new Set();
  for (const site of ['chatgpt', 'grok']) {
    let main = null;
    for (const t of list) if (t.site === site && reusable(t) && (main == null || (t.lastUse ?? -1) > (main.lastUse ?? -1))) main = t;
    if (main) keep.add(main.id);
  }
  const close = [];
  for (const t of list) {
    if (keep.has(t.id)) continue;
    // our sites are only driven by code, so "never used since start" = idle; other pages (e.g. a login) must sit unchanged for idleMs
    const idle = t.lastUse != null ? now - t.lastUse > idleMs : t.site === 'other' ? now - (t.firstSeen ?? now) > idleMs : true;
    if (idle) close.push(t); else keep.add(t.id);
  }
  if (!keep.size && close.length) keep.add(close.pop().id); // never close the last tab (Chrome would quit)
  return { keep: list.filter((t) => keep.has(t.id)), close };
}

export function createTabCleanup({ endpoint = 'http://127.0.0.1:19386', allowedPorts = ['19386'], idleMs = 20 * 60 * 1000, log, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const u = new URL(endpoint);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port === '9222' || !allowedPorts.includes(u.port))
    throw new Error('tab cleanup refuses ' + endpoint + ' (only the dedicated Chrome on 127.0.0.1:' + allowedPorts.join('/') + ')');
  const base = u.origin; const seen = new Map();
  const getJson = async (p) => { const r = await fetchImpl(base + p, { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(p + ' HTTP ' + r.status); return r.json(); };
  const closeTarget = async (id) => {
    for (const method of ['GET', 'PUT']) {
      const r = await fetchImpl(base + '/json/close/' + encodeURIComponent(id), { method, signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (r?.ok) return true; if (r && r.status !== 405) return false;
    }
    return false;
  };
  async function run(reason = 'periodic') {
    try {
      const out = await withExclusiveBrowser(async () => {
        const pages = (await getJson('/json/list')).filter((t) => t.type === 'page');
        const t = now();
        for (const p of pages) { const f = seen.get(p.id); if (!f || f.url !== p.url) seen.set(p.id, { at: t, url: p.url }); }
        for (const id of [...seen.keys()]) if (!pages.some((p) => p.id === id)) seen.delete(id);
        const plan = planTabCleanup(pages.map((p) => ({ id: p.id, url: p.url, lastUse: tabLastUse(p.url), firstSeen: seen.get(p.id).at })), { now: t, idleMs });
        const closed = [];
        for (const c of plan.close) if (await closeTarget(c.id)) { closed.push(c); seen.delete(c.id); }
        const by = {}; for (const c of closed) by[c.site] = (by[c.site] || 0) + 1;
        log?.info?.('tab cleanup (' + reason + '): ' + pages.length + ' tabs -> ' + (pages.length - closed.length) + (closed.length ? '; closed ' + Object.entries(by).map(([k, n]) => k + ' ' + n).join(', ') : '; nothing idle'));
        return { before: pages.length, after: pages.length - closed.length, closed: closed.map((c) => ({ site: c.site, url: c.url })) };
      });
      if (out?.skipped) log?.info?.('tab cleanup (' + reason + ') skipped: a browser job is running');
      return out;
    } catch (error) { log?.warn?.('tab cleanup (' + reason + ') failed: ' + error.message); return { error: error.message }; }
  }
  return { run };
}