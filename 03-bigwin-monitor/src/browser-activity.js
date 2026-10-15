// Shared guard for the dedicated Chrome (CDP 19386). Browser jobs (ChatGPT web, Grok chat, Grok video) run under withBrowserJob;
// the tab cleanup runs under withExclusiveBrowser: it never starts while a job is running, and a job that starts meanwhile waits until it is done.
const jobs = new Map(); let seq = 0; let exclusive = null; const lastUse = new Map(); let preflight = null;
/** Hook run before every browser job (service.js: move the dedicated Chrome back off-screen). Its errors never block the job. */
export function setBrowserJobPreflight(fn) { preflight = typeof fn === 'function' ? fn : null; }
export async function withBrowserJob(fn) {
  while (exclusive) await exclusive;
  const id = ++seq; jobs.set(id, Date.now());
  try { if (preflight) { try { await preflight(); } catch { /* best effort */ } } return await fn(); } finally { jobs.delete(id); }
}
/** Running jobs; one stuck past every timeout (staleMs) no longer blocks the cleanup forever. */
export const activeBrowserJobs = ({ now = Date.now(), staleMs = 45 * 60 * 1000 } = {}) => [...jobs.values()].filter((t) => now - t < staleMs).length;
export async function withExclusiveBrowser(fn, opts = {}) {
  if (exclusive || activeBrowserJobs(opts)) return { skipped: 'busy' };
  let release; exclusive = new Promise((r) => { release = r; });
  try { return await fn(); } finally { exclusive = null; release(); }
}
/** Remember when our code last used a tab (by URL) so the cleanup keeps recently used tabs. */
export function noteTabUse(url, at = Date.now()) { if (!url) return; lastUse.delete(String(url)); lastUse.set(String(url), at); if (lastUse.size > 500) lastUse.delete(lastUse.keys().next().value); }
export const tabLastUse = (url) => lastUse.get(String(url)) ?? null;
/** Tests only. */
export function resetBrowserActivity() { jobs.clear(); lastUse.clear(); exclusive = null; preflight = null; }