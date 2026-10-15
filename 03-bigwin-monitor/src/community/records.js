// 社群版 活動紀錄: one row per participant. Always written locally (JSONL + Excel-friendly CSV, the permanent backup);
// optionally appended to a sheet tab. Remote target per group (minigame.local.json groups.<key>.sheet):
//   { enabled: true, fileId, gid[, tab][, writeHeaderIfEmpty] } → append to that existing tab through our own tab in the
//     營運 Chrome (19385), columns mapped by the tab's header, deferred while 營運數據 runs (sheet-writer.js)
//   { url, secret, tab } → Apps Script web app (assets/community/apps-script/Code.gs)
// Remote appends go through a serialized persistent queue (remote-queue.json) and are retried until sent.
import fs from 'node:fs';
import path from 'node:path';
import { describeConditions, GAMES } from './conditions.js';
import { createAppendQueue, opsBusy } from './sheet-queue.js';
import { OVER_CAP_NOTE } from './payout.js';

export const COLUMNS = ['日期時間', '社群', '遊戲', '當日輪次', '場次ID', '參與條件', 'AID', '遊戲暱稱', 'TG名稱', '結果', '獎金', '是否派獎', '派獎人員', '派獎時間', '備註'];
export const stamp = (ms) => new Date(ms + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** round: bot round record; outcome: 'completed' | 'cancelled' | 'aborted'; winners: Set of tg ids;
 *  overCap: Set of tg ids beyond 本輪最多贈送總金額 (still 待審核, 備註 超過本輪贈送上限). */
export function buildRows({ round, groupName, outcome, winners, players, endedAt, overCap = new Set() }) {
  const prize = round.prize > 0 ? `${round.prize}${round.multiplier > 0 ? `（${round.multiplier} 倍打碼）` : ''}` : '';
  return players.map((p) => {
    const escaped = round.game === 'es' && (round.result == null || round.result === 'good'); // 密室逃脫: only a successful escape wins
    const won = outcome === 'completed' && (round.game === 'es' ? escaped : winners.has(String(p.id)));
    const result = outcome === 'cancelled' ? '流局' : outcome === 'aborted' ? '終止' : (round.game === 'es' && !escaped ? '未逃出' : (won && !p.admin ? '優勝' : '未中獎'));
    return {
      日期時間: stamp(endedAt), 社群: groupName, 遊戲: GAMES[round.game].name, 當日輪次: `第 ${round.roundNo} 輪`, 場次ID: round.id,
      參與條件: describeConditions(round.conditions), AID: p.admin ? '管理員' : (p.aid || ''), 遊戲暱稱: p.admin ? (p.nickname || p.name || '') : (p.nickname || ''), TG名稱: p.tgName || '',
      結果: result, 獎金: won && !p.admin ? prize : '', 是否派獎: won && !p.admin ? '待審核' : '無', 派獎人員: '', 派獎時間: '', 備註: won && !p.admin && overCap.has(String(p.id)) ? OVER_CAP_NOTE : '',
    };
  });
}

export const hasRemote = (t) => !!(t && t.enabled !== false && ((t.fileId && t.gid != null && t.gid !== '') || t.url));

export function createRecords({ dir, log, remote = null, fetchImpl = fetch, sheetWrite = null, busy = opsBusy }) {
  fs.mkdirSync(dir, { recursive: true });
  function writeLocal(groupKey, rows) {
    fs.appendFileSync(path.join(dir, `${groupKey}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const csv = path.join(dir, `${groupKey}.csv`);
    if (!fs.existsSync(csv)) fs.writeFileSync(csv, '\uFEFF' + COLUMNS.join(',') + '\r\n');
    fs.appendFileSync(csv, rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(',')).join('\r\n') + '\r\n');
  }
  function updateLocal(groupKey, match, updates) {
    const jsonlFile = path.join(dir, `${groupKey}.jsonl`);
    if (fs.existsSync(jsonlFile)) {
      const lines = fs.readFileSync(jsonlFile, 'utf8').split('\n').filter(Boolean);
      const updated = lines.map((line) => {
        try {
          const row = JSON.parse(line);
          const isMatch = Object.entries(match).every(([k, v]) => String(row[k] ?? '') === String(v));
          if (isMatch) return JSON.stringify({ ...row, ...updates });
          return line;
        } catch { return line; }
      });
      fs.writeFileSync(jsonlFile, updated.join('\n') + '\n');
    }
    const csvFile = path.join(dir, `${groupKey}.csv`);
    if (fs.existsSync(csvFile)) {
      const jsonlLines = fs.existsSync(jsonlFile) ? fs.readFileSync(jsonlFile, 'utf8').split('\n').filter(Boolean) : [];
      const rows = jsonlLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      fs.writeFileSync(csvFile, '\uFEFF' + COLUMNS.join(',') + '\r\n' + rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(',')).join('\r\n') + '\r\n');
    }
  }
  async function postRemote(target, rows) {
    const res = await fetchImpl(target.url, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: target.secret, tab: target.tab, columns: COLUMNS, rows: rows.map((r) => COLUMNS.map((c) => r[c] ?? '')) }), redirect: 'follow', signal: AbortSignal.timeout(30000) });
    const j = await res.json().catch(() => null);
    if (!j?.ok) throw new Error(`sheet append failed: HTTP ${res.status} ${String(j?.error || '').slice(0, 120)}`);
    return j;
  }
  let cdpWrite = sheetWrite;
  async function write(target, rows) {
    if (target.fileId) {
      if (!cdpWrite) { const { createSheetWriter } = await import('./sheet-writer.js'); cdpWrite = createSheetWriter({ columns: COLUMNS, log }); }
      return cdpWrite(target, rows);
    }
    return postRemote(target, rows);
  }
  const queue = createAppendQueue({ file: path.join(dir, 'remote-queue.json'), write, log, busy: (t) => (t?.fileId ? busy() : null) });
  const targetFor = (key) => { const t = remote?.(key); return hasRemote(t) ? t : null; };
  const flush = () => queue.flush({ targetFor });

  async function append(groupKey, rows) {
    if (!rows.length) return { local: 0 };
    writeLocal(groupKey, rows);
    if (!targetFor(groupKey)) return { local: rows.length, remote: 'off' };
    await queue.enqueue(groupKey, rows);
    void flush().catch((e) => log.warn(`records flush: ${e.message}`)); // never blocks the game flow
    return { local: rows.length, remote: 'queued' };
  }
  async function update(groupKey, match, updates) {
    updateLocal(groupKey, match, updates);
    if (!targetFor(groupKey)) return { local: true, remote: 'off' };
    const res = await queue.update(groupKey, match, updates, { targetFor });
    return { local: true, remote: res };
  }
  async function retry() { return (await flush()).sent; }
  return { append, update, retry, flush, pending: queue.pending };
}
