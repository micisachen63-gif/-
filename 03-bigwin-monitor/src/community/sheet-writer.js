// Append-only writer for an existing sheet tab (addressed by file id + gid), driven through our own tab in the 19385
// Chrome (see sheet-cdp.js). Columns are mapped by the tab's own header row (row 1): each header that names one of our
// fields gets that value, other columns stay blank. Never creates tabs, inserts rows or edits non-empty cells; refuses
// unless the header maps and the target rows are empty. An entirely empty tab only gets our header when
// target.writeHeaderIfEmpty is true (otherwise it is reported). Key cells are read back after every append.
import { connectOwnTabs, openSheet, saved, select, readCell, activeTab, nextEmptyRow, syntheticPaste, toTsv, sheetText } from './sheet-cdp.js';

export const colName = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const permanent = (msg) => Object.assign(new Error(msg), { permanent: true });

/** header: tab's row-1 labels; columns: our field names. Returns per-header-column field (or null) + unmapped lists. */
export function mapHeader(header, columns) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, '').trim();
  const fields = header.map((h) => columns.find((c) => norm(c) === norm(h)) ?? null);
  return { fields, missing: columns.filter((c) => !fields.includes(c)), extra: header.filter((h, i) => norm(h) && !fields[i]) };
}

export function createSheetWriter({ columns, chromium = null, staffColumns = ['是否派獎', '派獎人員', '派獎時間', '備註'], log = null, maxCols = 40 }) {
  return async function write(target, rows) {
    if (!target?.fileId || target?.gid == null || target.gid === '') throw new Error('sheet target not configured (fileId + gid)');
    const conn = await connectOwnTabs({ chromium });
    try {
      const page = await conn.newPage();
      await openSheet(page, target.fileId, target.gid);
      if (!page.url().includes('gid=' + target.gid)) throw new Error(`分頁 gid=${target.gid} 未開啟`);
      const tab = await activeTab(page);
      if (target.tab && tab !== target.tab) throw new Error(`分頁名稱不符：預期「${target.tab}」，實際「${tab}」`);
      const header = [];
      for (let i = 0, blanks = 0; i < maxCols && blanks < 3; i++) { const v = await readCell(page, colName(i) + '1'); header.push(v); blanks = v === '' ? blanks + 1 : 0; }
      while (header.length && header.at(-1) === '') header.pop();
      let next = await nextEmptyRow(page);
      if (!header.length) {
        if (next.row !== 1 || !target.writeHeaderIfEmpty) throw new Error(`分頁「${tab}」第 1 列沒有表頭${next.row !== 1 ? '但有資料' : ''}；未設定 writeHeaderIfEmpty，不寫入`);
        await select(page, `A1:${colName(columns.length - 1)}1`);
        if (!(await syntheticPaste(page, toTsv([columns])))) throw new Error('找不到試算表輸入目標');
        await saved(page);
        if (await readCell(page, 'A1') !== columns[0]) throw permanent('表頭寫入後比對不符');
        header.push(...columns); next = await nextEmptyRow(page);
        log?.info?.(`records: wrote header to empty tab ${tab}`);
      }
      const { fields, missing, extra } = mapHeader(header, columns);
      if (!fields.some(Boolean)) throw new Error(`分頁「${tab}」表頭與紀錄欄位完全不符：${header.join('|')}`);
      if (missing.length || extra.length) log?.warn?.(`records: ${tab} header mismatch; not in tab: ${missing.join('、') || '-'}; tab-only: ${extra.join('、') || '-'}`);
      const values = rows.map((r) => fields.map((f) => (f ? r[f] ?? '' : '')));
      const width = fields.length, last = colName(width - 1);
      const { row, bottom, full } = next;
      if (full || row + values.length - 1 > bottom) throw new Error(`分頁列數不足（第 ${row} 列起需 ${values.length} 列，現有 ${bottom} 列），請手動在底部新增列`);
      const check = [0, ...staffColumns.map((c) => fields.indexOf(c)).filter((i) => i > 0)].map(colName);
      for (let r = row; r < row + values.length; r++) for (const c of check) if (await readCell(page, c + r) !== '') throw new Error(`目標列 ${c}${r} 不是空白，停止寫入`);
      await select(page, `A${row}:${last}${row + values.length - 1}`);
      if (!(await syntheticPaste(page, toTsv(values)))) throw new Error('找不到試算表輸入目標');
      await saved(page);
      if (await readCell(page, `A${row}`) === '' && values[0][0] !== '') throw new Error('貼上未生效（第一格仍空白）');
      const keys = [...new Set(['日期時間', '場次ID', 'AID'].map((f) => fields.indexOf(f)).filter((i) => i >= 0))];
      if (!keys.length) keys.push(fields.findIndex(Boolean));
      for (let r = 0; r < values.length; r++) for (const i of keys) {
        const got = (await readCell(page, colName(i) + (row + r))).replace(/^'/, ''), want = sheetText(values[r][i]).replace(/^'/, '');
        if (got !== want) throw permanent(`寫入後比對不符 ${colName(i)}${row + r}：預期 ${want}，實際 ${got}`);
      }
      return { tab, row, count: values.length, missing, extra };
    } finally { await conn.close(); }
  };

  write.update = async function update(target, match, updates) {
    if (!target?.fileId || target?.gid == null || target.gid === '') return false;
    const conn = await connectOwnTabs({ chromium });
    try {
      const page = await conn.newPage();
      await openSheet(page, target.fileId, target.gid);
      const tab = await activeTab(page);
      if (target.tab && tab !== target.tab) throw new Error(`分頁名稱不符：預期「${target.tab}」，實際「${tab}」`);
      const header = [];
      for (let i = 0, blanks = 0; i < maxCols && blanks < 3; i++) { const v = await readCell(page, colName(i) + '1'); header.push(v); blanks = v === '' ? blanks + 1 : 0; }
      while (header.length && header.at(-1) === '') header.pop();
      const { fields } = mapHeader(header, columns);
      const next = await nextEmptyRow(page);
      const aidIdx = fields.indexOf('AID');
      const roundIdx = fields.indexOf('場次ID');
      if (aidIdx < 0) return false;
      const aidCol = colName(aidIdx);
      const roundCol = roundIdx >= 0 ? colName(roundIdx) : null;
      let targetRow = null;
      for (let r = next.row - 1; r >= Math.max(2, next.row - 100); r--) {
        const a = (await readCell(page, `${aidCol}${r}`)).replace(/^'/, '');
        const rd = roundCol ? (await readCell(page, `${roundCol}${r}`)).replace(/^'/, '') : null;
        if (String(a) === String(match.AID) && (!match['場次ID'] || String(rd) === String(match['場次ID']))) {
          targetRow = r;
          break;
        }
      }
      if (!targetRow) {
        log?.warn?.(`sheet update: row not found for AID ${match.AID} round ${match['場次ID']}`);
        return false;
      }
      for (const [key, val] of Object.entries(updates)) {
        const colI = fields.indexOf(key);
        if (colI >= 0) {
          await select(page, `${colName(colI)}${targetRow}`);
          await syntheticPaste(page, sheetText(val));
        }
      }
      await saved(page);
      log?.info?.(`sheet update: updated row ${targetRow} for AID ${match.AID}`);
      return true;
    } finally { await conn.close(); }
  };

  return write;
}
