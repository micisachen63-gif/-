import { AuthError } from './errors.js';
import { formatAlert, formatLoginAlert, formatScanFailureAlert } from './format.js';
import { fmtStamp, parseRowTime, toNumber } from './util.js';

const MIN = 60e3;
const HOUR = 3600e3;

/**
 * Query window: from (last successful stop - overlap) to now. First run: last firstRunMs.
 * A very long outage is capped to maxCatchupMs (reported as truncated).
 */
export function computeWindow({ lastSuccessStop, now, overlapMs, firstRunMs, maxCatchupMs }) {
  const resume = Number.isFinite(lastSuccessStop) && lastSuccessStop > 0;
  let start = resume ? lastSuccessStop - overlapMs : now - firstRunMs;
  if (resume && start > now - overlapMs) start = now - overlapMs; // clock skew / fast re-run: still cover the overlap
  let truncated = false;
  if (maxCatchupMs && now - start > maxCatchupMs) {
    start = now - maxCatchupMs;
    truncated = true;
  }
  // The backend works in whole seconds; floor start / keep stop so the next overlap covers the edge.
  start = Math.floor(start / 1000) * 1000;
  return { start, stop: now, truncated };
}

/** Split [start, stop] into consecutive chunks of at most chunkMs (boundaries repeat; dedupe handles it). */
export function splitWindow(start, stop, chunkMs) {
  if (!chunkMs || stop - start <= chunkMs) return [[start, stop]];
  const out = [];
  for (let s = start; s < stop; s += chunkMs) out.push([s, Math.min(stop, s + chunkMs)]);
  return out;
}

export const betKey = (row) => `${row.vendorId ?? ''}:${row.docNo}`;

export function filterBigWins(rows, threshold) {
  return rows.filter((row) => {
    const pay = toNumber(row.payMoney);
    return Number.isFinite(pay) && pay >= threshold;
  });
}

/** Rows not already seen, unique within the batch. */
export function dedupeNew(rows, seen, isKnown = () => false) {
  const out = [];
  const batch = new Set();
  for (const row of rows) {
    const key = betKey(row);
    if (seen[key] || batch.has(key) || isKnown(key)) continue;
    batch.add(key);
    out.push(row);
  }
  return out;
}

export function pruneSeen(seen, now, retentionMs) {
  let removed = 0;
  for (const [key, at] of Object.entries(seen)) {
    if (!(now - at <= retentionMs)) { delete seen[key]; removed++; }
  }
  return removed;
}

/**
 * Fetch every page of a (Laravel-paginated, newest-first) window.
 * last_page is re-read on every response because late rows can grow the result while we page;
 * insertions only shift rows to later pages (duplicates, removed by key), never skip them.
 */
export async function fetchAllPages(fetchPage, { limit = 2000, maxPages = 100 } = {}) {
  const rows = new Map();
  let page = 1;
  let lastPage = 1;
  let firstTotal = null;
  let lastTotal = 0;
  do {
    const r = await fetchPage(page, limit);
    if (!Array.isArray(r.rows)) throw new Error('bets response has no rows array');
    if (firstTotal === null) firstTotal = Number(r.total) || 0;
    lastTotal = Number(r.total) || 0;
    for (const row of r.rows) rows.set(betKey(row), row);
    lastPage = Math.max(lastPage, Number(r.lastPage) || 1);
    if (r.rows.length === 0) break;
    page += 1;
    if (page > maxPages && page <= lastPage) throw new Error(`too many pages (${lastPage}) for one window; lower chunkMinutes`);
  } while (page <= lastPage);
  const all = [...rows.values()];
  return { rows: all, pages: page - 1, total: lastTotal, complete: all.length >= firstTotal };
}

async function deliverAlert(record, { alerts, notifier, log }) {
  try {
    const res = await notifier.sendAlert(record);
    alerts.update(record.id, { status: record.publishable ? 'pending' : 'sent', messageId: res?.messageId ?? null, chatId: res?.chatId ?? null, sentAt: Date.now(), lastError: null });
    return true;
  } catch (error) {
    if (error.chatMismatch) {
      alerts.update(record.id, { status: 'error', lastError: error.message, messageId: error.messageId ?? null });
    } else {
      alerts.update(record.id, { status: 'unsent', lastError: error.message, attempts: (record.attempts || 0) + 1 });
    }
    log.error(`alert ${record.id} (${record.betKey}) send failed: ${error.message}`);
    return false;
  }
}

/** Retry alerts that could not be sent earlier (Telegram outage); give up after 24h. */
export async function retryUnsent({ brand, alerts, notifier, now, log }) {
  let sent = 0;
  for (const rec of alerts.unsent().filter((a) => a.brand === brand.key)) {
    if (now - rec.createdAt > 24 * HOUR) {
      alerts.update(rec.id, { status: 'dropped' });
      log.error(`alert ${rec.id} (${rec.betKey}) dropped after 24h of failed sends`);
      continue;
    }
    if (await deliverAlert(rec, { alerts, notifier, log })) sent++;
  }
  return sent;
}

/** One scan of one brand: window → all pages → threshold → dedupe → player lookup → alert. */
export async function scanBrand({ brand, client, brandState: bs, saveBrandState, alerts, notifier, cfg, now, opts = {}, log }) {
  const threshold = opts.minPay ?? Number(brand.threshold);
  const win = computeWindow({
    lastSuccessStop: opts.windowMinutes ? null : bs.lastSuccessStop,
    now,
    overlapMs: cfg.overlapMinutes * MIN,
    firstRunMs: (opts.windowMinutes ?? cfg.firstRunMinutes) * MIN,
    maxCatchupMs: (cfg.maxCatchupMinutes ?? 180) * MIN,
  });
  if (win.truncated) log.warn(`outage longer than maxCatchupMinutes; only scanning from ${fmtStamp(win.start)}`);

  let fetched = 0;
  let pages = 0;
  let incomplete = false;
  const big = [];
  for (const [s, e] of splitWindow(win.start, win.stop, (cfg.chunkMinutes ?? 30) * MIN)) {
    const r = await fetchAllPages((page, limit) => client.fetchBets({ start: s, stop: e, page, limit }), { limit: cfg.pageLimit, maxPages: cfg.maxPages });
    fetched += r.rows.length;
    pages += r.pages;
    if (!r.complete) incomplete = true;
    big.push(...filterBigWins(r.rows, threshold));
  }
  if (incomplete) log.warn('paged row count below reported total (rows vanished while paging?)');

  let fresh = dedupeNew(big, bs.seen, (key) => alerts.hasBet(brand.key, key));
  fresh.sort((a, b) => (parseRowTime(a.time) - parseRowTime(b.time)) || String(a.docNo).localeCompare(String(b.docNo)));
  let cappedOut = 0;
  if (opts.maxAlerts && fresh.length > opts.maxAlerts) {
    cappedOut = fresh.length - opts.maxAlerts;
    fresh = [...fresh].sort((a, b) => toNumber(b.payMoney) - toNumber(a.payMoney)).slice(0, opts.maxAlerts);
  }

  let sent = 0;
  for (const bet of fresh) {
    let player = null;
    let lookupError = false;
    try {
      player = await client.lookupPlayer(bet.a_id);
    } catch (error) {
      lookupError = true;
      log.warn(`player lookup failed for ${bet.a_id}: ${error.message}`);
    }
    const key = betKey(bet);
    const record = {
      id: alerts.nextId(),
      brand: brand.key,
      brandName: brand.name,
      betKey: key,
      docNo: String(bet.docNo),
      aid: String(bet.a_id),
      nickname: player?.nickname ?? null,
      gameName: bet.gameName ?? '',
      vendor: bet.description ?? '',
      payMoney: bet.payMoney,
      betMoney: bet.betMoney,
      betTime: bet.time,
      text: formatAlert(brand, bet, player, { lookupError }),
      publishable: Boolean(brand.community),
      status: 'unsent',
      createdAt: now,
    };
    alerts.put(record);
    bs.seen[key] = now;
    saveBrandState();
    if (await deliverAlert(record, { alerts, notifier, log })) sent++;
    if (fresh.length > 1) await notifier.pace?.();
  }

  bs.lastSuccessStop = win.stop;
  pruneSeen(bs.seen, now, (cfg.seenRetentionHours ?? 48) * HOUR);
  saveBrandState();
  return { window: win, fetched, pages, threshold, bigWins: big.length, newAlerts: fresh.length, sent, cappedOut };
}

/**
 * Full per-brand cycle with failure isolation:
 * - AuthError → one auto re-login attempt; on success rescan; on failure count it and
 *   alert after cfg.loginFailuresBeforeAlert consecutive failures (cooldown per brand).
 * - other errors → counted; alert after cfg.scanFailuresBeforeAlert consecutive failures (cooldown).
 */
export async function runBrandCycle(ctx) {
  const { brand, client, brandState: bs, saveBrandState, notifier, cfg, now, log, alerts, opts = {} } = ctx;
  const result = { brand: brand.key, ok: false };
  try {
    if (!opts.dry) await retryUnsent({ brand, alerts, notifier, now, log });
    let r;
    try {
      r = await scanBrand(ctx);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      log.warn(`logged out (${error.message}); trying auto re-login`);
      const rl = await client.relogin();
      if (!rl.ok) {
        bs.loginFailures = (bs.loginFailures || 0) + 1;
        bs.lastError = `login: ${rl.reason}`;
        log.warn(`auto re-login failed (${rl.reason}); consecutive login failures = ${bs.loginFailures}`);
        const cooldown = (cfg.loginAlertCooldownHours ?? 4) * HOUR;
        if (bs.loginFailures >= (cfg.loginFailuresBeforeAlert ?? 2) && (!bs.lastLoginAlertAt || now - bs.lastLoginAlertAt >= cooldown)) {
          try {
            await notifier.sendText(formatLoginAlert(brand));
            bs.lastLoginAlertAt = now;
            log.warn('login-expired alert sent to private group');
          } catch (e) { log.error(`login alert send failed: ${e.message}`); }
        }
        saveBrandState();
        return { ...result, auth: true, error: bs.lastError, loginFailures: bs.loginFailures };
      }
      log.info('auto re-login succeeded; rescanning');
      bs.loginFailures = 0;
      r = await scanBrand(ctx);
      result.relogged = true;
    }
    bs.consecutiveFailures = 0;
    bs.loginFailures = 0;
    bs.lastOkAt = now;
    bs.lastError = null;
    saveBrandState();
    return { ...result, ...r, ok: true };
  } catch (error) {
    bs.consecutiveFailures = (bs.consecutiveFailures || 0) + 1;
    bs.lastError = error.message;
    log.error(`scan failed (${bs.consecutiveFailures} in a row): ${error.message}`);
    const cooldown = (cfg.scanFailureAlertCooldownHours ?? 6) * HOUR;
    const after = cfg.scanFailuresBeforeAlert ?? 6;
    if (after > 0 && bs.consecutiveFailures >= after && (!bs.lastFailureAlertAt || now - bs.lastFailureAlertAt >= cooldown)) {
      try {
        await notifier.sendText(formatScanFailureAlert(brand, bs.consecutiveFailures, error.message));
        bs.lastFailureAlertAt = now;
      } catch (e) { log.error(`failure alert send failed: ${e.message}`); }
    }
    saveBrandState();
    return { ...result, error: error.message, consecutiveFailures: bs.consecutiveFailures };
  }
}
