// 社群版 派獎. Renders the mail each (non-admin) winner gets and logs it to payouts.jsonl.
// - dry-run (default): status 待審核, nothing sent.
// - live (enabled && liveConfirmed && sendMail; minigame.local.json payout.enabled + payout.liveConfirmed, 2026-10-06 autopay):
//   bot.js submits one persistent job per finished round (payout-jobs.json); drain() sends each winner's mail through
//   sendMail (mail-sender.js → the same backend /gm/mail form as the 新手禮包 automation), one winner at a time.
//   Over-cap winners (本輪最多贈送總金額) and admins are never sent; they stay 待審核 / 無.
//   Never double-sends: payout-ledger.json holds one entry per round+AID+lock, written as 'sending' BEFORE the form is
//   submitted. A 'sent' entry is never sent again; a 'sending' entry found after a restart (crash mid-send) is NOT resent
//   but marked 派獎失敗 for a manual check. Failures before 送出 (login, form) are retried (maxTries); failures after
//   送出 (no 寄信成功) are never retried. Paused while 營運數據 runs (busy(), same guard as the sheet writes).
//   When a job is final, payouts.jsonl gets the final status and the bot's settle handler writes the record rows
//   (是否派獎 已派獎 / 派獎失敗) and notifies the admin about failures.
import fs from 'node:fs';
import path from 'node:path';
import { fmtNum, md } from './conditions.js';

export const OVER_CAP_NOTE = '超過本輪贈送上限';
export const PAY_PENDING = '待審核';
export const PAY_SENT = '已派獎';
export const PAY_FAILED = '派獎失敗';
export const AUTO_STAFF = '小遊戲精靈(自動)';
/** dedupe key: one mail per round + AID (+ 千鎖秘藏 lock no) */
export const payoutKey = (roundId, aid, lock = null) => `${roundId}|${aid}|${lock ?? '-'}`;

/** 本輪最多贈送總金額: items (already in result order) are paid full prizes only, until the cap; the rest are `over`.
 *  No cap (legacy rounds / no prize) → everyone in `paid`. */
export function splitByCap(round, items) {
  const list = [...(items || [])]; const prize = Number(round?.prize) || 0; const cap = Number(round?.maxPayout) || 0;
  if (!(prize > 0) || !(cap > 0)) return { paid: list, over: [] };
  const n = Math.floor(cap / prize);
  return { paid: list.slice(0, n), over: list.slice(n) };
}

const MULT_PAREN = /[（(][^（()）]*\{multiplier\}[^（()）]*[）)]/g;
/** Fills {placeholders}; when no 打碼倍數 is set the whole （…{multiplier}…） part is dropped. */
export function renderMail(tpl, vars) {
  let { title, body } = tpl;
  if (!(Number(vars.multiplier) > 0)) { title = title.replace(MULT_PAREN, ''); body = body.replace(MULT_PAREN, ''); }
  const fill = (s) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
  return { title: fill(title), body: fill(body) };
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => { fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 1)); fs.renameSync(file + '.tmp', file); };
const short = (e) => String(e?.message || e).replace(/\s+/g, ' ').slice(0, 160);

export function createPayout({ dir, log, templatesFile, enabled = false, liveConfirmed = false, sendMail = null, now = Date.now, busy = () => null, maxTries = 3, retryMs = 5 * 60e3 }) {
  const templates = JSON.parse(fs.readFileSync(templatesFile, 'utf8'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'payouts.jsonl');
  const ledgerFile = path.join(dir, 'payout-ledger.json');
  const jobsFile = path.join(dir, 'payout-jobs.json');
  const live = Boolean(enabled && liveConfirmed && typeof sendMail === 'function');
  let settled = null; // bot.js: async (job, items) => write rows + notify
  const ledger = () => readJson(ledgerFile, {});
  const setEntry = (key, entry) => { const L = ledger(); L[key] = entry; writeJson(ledgerFile, L); return entry; };
  const jobs = () => { const j = readJson(jobsFile, []); return Array.isArray(j) ? j : []; };

  /** items: [{ aid, nickname, admin?, round? }] in result order → rendered mails (admins dropped, over-cap flagged). */
  function render({ round, groupName, items }) {
    const list = (items || []).filter((it) => it.aid && !it.admin);
    if (!(round.prize > 0) || !list.length) return [];
    const tpl = templates[round.game]; if (!tpl) throw new Error(`no mail template for ${round.game}`);
    const multiplier = round.multiplier > 0 ? round.multiplier : '';
    const over = new Set(splitByCap(round, list).over);
    return list.map((it) => {
      const mail = renderMail(tpl, { community: groupName, round: it.round ?? round.roundNo, date: md(round.date), nickname: it.nickname || it.aid, aid: it.aid, amount: fmtNum(round.prize), prize: fmtNum(round.prize), multiplier });
      return { key: payoutKey(round.id, it.aid, it.round ?? null), aid: it.aid, nickname: it.nickname || null, ...(it.round != null ? { lock: it.round } : {}), amount: round.prize, multiplier: round.multiplier || 0, iconTitle: tpl.iconTitle || mail.title, ...mail, status: PAY_PENDING, ...(over.has(it) ? { overCap: true, note: OVER_CAP_NOTE } : {}) };
    });
  }
  const logLines = (round, mode, out) => { if (out.length) fs.appendFileSync(file, out.map((o) => JSON.stringify({ at: new Date(now()).toISOString(), mode, group: round.key, roundId: round.id, game: round.game, maxPayout: round.maxPayout || null, ...o })).join('\n') + '\n'); };

  /** One mail, guarded by the ledger. Returns 'done' (o.status final) or 'later' (retry after retryMs). */
  async function sendOne(round, o) {
    const e = ledger()[o.key];
    if (e?.status === 'sent') { Object.assign(o, { status: PAY_SENT, sentAt: e.at, dedup: true }); return 'done'; }
    if (e?.status === 'failed' || e?.status === 'uncertain') { Object.assign(o, { status: PAY_FAILED, note: e.note }); return 'done'; }
    if (e?.status === 'sending') { // crashed / restarted mid-send: maybe submitted → never resend, ask for a manual check
      const note = '上次寄送中途中斷，可能已寄出，請核對遊戲信箱'; setEntry(o.key, { ...e, status: 'uncertain', note, at: now() });
      log.warn(`payout ${o.key}: found 'sending' after restart → 派獎失敗 (manual check), not resent`);
      Object.assign(o, { status: PAY_FAILED, note }); return 'done';
    }
    if (e?.status === 'retry' && e.nextAt > now()) return 'later';
    const tries = (e?.tries || 0) + 1;
    const base = { roundId: round.id, group: round.key, aid: o.aid, lock: o.lock ?? null, amount: o.amount, multiplier: o.multiplier, tries };
    setEntry(o.key, { ...base, status: 'sending', at: now() });
    try {
      await sendMail({ round, ...o });
      setEntry(o.key, { ...base, status: 'sent', at: now() });
      Object.assign(o, { status: PAY_SENT, sentAt: now() }); return 'done';
    } catch (error) {
      const msg = short(error);
      if (error?.notSubmitted && tries < maxTries) {
        setEntry(o.key, { ...base, status: 'retry', error: msg, nextAt: now() + retryMs, at: now() });
        log.warn(`payout ${o.key}: not sent (try ${tries}/${maxTries}), retry later: ${msg}`); return 'later';
      }
      const note = error?.notSubmitted ? `寄送失敗：${msg}` : `送出後未確認成功，可能已寄出，請到後台核對：${msg}`;
      setEntry(o.key, { ...base, status: error?.notSubmitted ? 'failed' : 'uncertain', error: msg, note, at: now() });
      log.warn(`payout ${o.key}: ${PAY_FAILED}: ${msg}`);
      Object.assign(o, { status: PAY_FAILED, note }); return 'done';
    }
  }
  async function runItems(round, out) {
    let pending = false;
    for (const o of out) { if (o.overCap) continue; if ((await sendOne(round, o)) === 'later') pending = true; }
    return pending;
  }

  /** Direct, one-shot: dry-run logs 待審核; live sends (ledger-guarded) and logs the statuses. */
  async function process({ round, groupName, items }) {
    const out = render({ round, groupName, items });
    if (!out.length) return { mode: 'none', items: [] };
    const mode = live ? 'live' : 'dry-run';
    if (live) await runItems(round, out);
    logLines(round, mode, out);
    const over = out.filter((o) => o.overCap).length;
    log.info(`payout ${mode}: ${round.id} → ${out.length - over} mail(s) ${live ? 'processed' : 'logged as 待審核 (nothing sent)'}${over ? `, ${over} over cap ${round.maxPayout} → 待審核` : ''}`);
    return { mode, items: out };
  }

  /** live: persist the round's payout job (+ its record rows, written once the payout is final). Idempotent per round. */
  function submit({ round, groupName, groupKey, items, rows = [], notify = [] }) {
    const q = jobs(); if (q.some((j) => j.id === round.id)) return { queued: false, duplicate: true };
    q.push({ id: round.id, round, groupName, groupKey: groupKey || round.key, items, rows, notify, at: now(), nextAt: 0 });
    writeJson(jobsFile, q);
    log.info(`payout live: ${round.id} queued (${items.length} winner(s))`);
    return { queued: true };
  }

  let running = null;
  /** Processes due jobs (one winner at a time). Concurrent calls share the running pass. */
  function drain() {
    if (!live) return Promise.resolve({ sent: 0, settled: 0 });
    if (running) return running;
    running = (async () => {
      const result = { sent: 0, settled: 0, deferred: null };
      for (const job of jobs()) {
        if (job.nextAt > now()) continue;
        const reason = busy(); if (reason) { result.deferred = reason; break; }
        const out = render(job);
        const pending = await runItems(job.round, out);
        result.sent += out.filter((o) => o.status === PAY_SENT && !o.dedup).length;
        if (pending) { const q = jobs(); const cur = q.find((j) => j.id === job.id); if (cur) { cur.nextAt = now() + retryMs; writeJson(jobsFile, q); } continue; }
        logLines(job.round, 'live', out);
        try { if (settled) await settled(job, out); } catch (error) { log.warn(`payout ${job.id}: settle failed: ${short(error)}`); }
        writeJson(jobsFile, jobs().filter((j) => j.id !== job.id)); result.settled++;
        const n = (s) => out.filter((o) => o.status === s && !o.overCap).length;
        log.info(`payout live: ${job.id} done → ${n(PAY_SENT)} 已派獎, ${n(PAY_FAILED)} 派獎失敗, ${out.filter((o) => o.overCap).length} over cap 待審核`);
      }
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  async function sendOneWinner({ round, groupName, item }) {
    const rendered = render({ round, groupName, items: [item] });
    if (!rendered.length) return null;
    const o = rendered[0];
    if (item.overCap) { o.overCap = true; o.note = OVER_CAP_NOTE; }
    if (o.overCap) {
      logLines(round, live ? 'live' : 'dry-run', [o]);
      return o;
    }
    if (!live) {
      logLines(round, 'dry-run', [o]);
      return o;
    }
    await sendOne(round, o);
    logLines(round, 'live', [o]);
    return o;
  }

  return { process, submit, drain, sendOneWinner, live, onSettled: (fn) => { settled = fn; }, pending: jobs, ledger };
}
