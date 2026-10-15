import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

// Reads the brand workbook through Google's public XLSX export (the files are link-shared).
// Read-only; the downloaded copy is cached in output\<month>\data.

export async function loadWorkbook(brandKey, brand, cacheDir, {refresh = false, log = () => {}} = {}) {
  const file = path.join(cacheDir, `${brandKey}-sheet.xlsx`);
  if (!refresh && fs.existsSync(file)) return XLSX.read(fs.readFileSync(file), {type: 'buffer'});
  const url = `https://docs.google.com/spreadsheets/d/${brand.sheetId}/export?format=xlsx`;
  log(`${brand.name}：下載試算表`);
  const res = await fetch(url, {redirect: 'follow'});
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('spreadsheet')) throw new Error(`${brand.name} 試算表下載失敗（HTTP ${res.status}，${type}）。是否已取消「知道連結的人可檢視」？`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(cacheDir, {recursive: true});
  fs.writeFileSync(file, buf);
  return XLSX.read(buf, {type: 'buffer'});
}

function toIso(v) {
  if (typeof v === 'number' && v > 30000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);
  }
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(String(v ?? '').trim());
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/,/g, '').trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null; // '-', '', '#DIV/0!' -> null
}

/**
 * Daily table: column A = date, row 1 = headers. Returns Map(iso -> {header: number|null}).
 * `wanted` headers must all exist, otherwise the sheet layout changed and we stop.
 */
export function dailyTable(wb, tab, wanted) {
  const ws = wb.Sheets[tab];
  if (!ws) throw new Error(`試算表找不到分頁「${tab}」`);
  const rows = XLSX.utils.sheet_to_json(ws, {header: 1, raw: true, defval: null});
  const header = (rows[0] || []).map((h) => String(h ?? '').trim());
  const idx = {};
  for (const w of wanted) {
    const i = header.indexOf(w);
    if (i < 0) throw new Error(`分頁「${tab}」缺少欄位「${w}」（欄位可能被改名）`);
    idx[w] = i;
  }
  const map = new Map();
  for (const r of rows.slice(1)) {
    const d = toIso(r[0]);
    if (!d) continue;
    const rec = {};
    for (const w of wanted) rec[w] = toNum(r[idx[w]]);
    map.set(d, rec);
  }
  return map;
}
