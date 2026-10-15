import fs from 'node:fs';
import path from 'node:path';
import {prevMonth, writeJson} from './util.js';
import {client} from './webapp.js';

// Upload = copy last month's deck in the Drive folder and replace slide pictures, done by the user's
// Apps Script web app (one image per request). Runs only when all three brands are built.
const titleFor = (tpl, m) => tpl.replace('{M}', String(m.m)).replace('{YYYY}', String(m.y)).replace('{MM}', String(m.m).padStart(2, '0'));

export async function push({cfg, month, monthDir, dryRun = false, test = false, sourceTitle = null, log = console.log}) {
  const d = cfg.drive;
  const mf = path.join(monthDir, 'manifest.json');
  if (!fs.existsSync(mf)) throw new Error('找不到 manifest.json，請先 build');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const png = (b, l) => manifest.slides.find((s) => s.brand === b && s.layout === l)?.png;
  const plan = d.slides.map((s) => ({...s, png: png(s.brand, s.layout)}));
  const missing = plan.filter((p) => !p.png || !fs.existsSync(p.png));
  if (missing.length) {
    const brands = [...new Set(missing.map((m) => cfg.brands[m.brand]?.name || m.brand))].join('、');
    throw new Error(`三個品牌都產生完才會上傳。尚缺：${brands}（${missing.map((m) => `${m.brand}/${m.layout}`).join(', ')}），請先 build`);
  }
  const title = titleFor(d.titleTemplate, month);
  // --test without --source: start from this month's existing deck (old title) so the copy is easy to compare
  const sourceTitles = sourceTitle ? [String(sourceTitle)] : [...new Set([...(test ? [titleFor(d.sourceTitleTemplate || d.titleTemplate, month)] : []),titleFor(d.titleTemplate, prevMonth(month)), titleFor(d.sourceTitleTemplate || d.titleTemplate, prevMonth(month))])];
  const req = {folderId: d.folderId, title, test, sourceTitles, ...(d.sourceDeckId ? {sourceId: d.sourceDeckId} : {})};
  const app = await client();

  const look = await app.call('lookup', req);
  const target = look.existingId ? `沿用已存在的「${look.title}」` : `複製「${look.sourceName}」→「${look.title}」`;
  if (!look.existingId && !look.sourceId) throw new Error(`資料夾內找不到上個月的簡報（${sourceTitles.join('」或「')}）`);
  const count = look.slides.length;
  for (const p of plan) p.op = p.slide <= count ? 'put' : p.duplicateOf ? 'append' : 'missing';
  const bad = plan.filter((p) => p.op === 'missing');
  if (bad.length) throw new Error(`簡報只有 ${count} 頁，找不到第 ${bad.map((p) => p.slide).join('、')} 頁`);
  plan.sort((a, b) => a.slide - b.slide);
  log(`${test ? '【測試】' : ''}${target}（${count} 頁）`);
  for (const p of plan) {
    const s = look.slides[(p.op === 'append' ? p.duplicateOf : p.slide) - 1];
    log(`  第 ${p.slide} 頁 ← ${path.basename(path.dirname(p.png))}\\${path.basename(p.png)}  ${p.op === 'append' ? `（複製第 ${p.duplicateOf} 頁加到最後）` : ''}${s ? `方式：${s.will === 'image' ? '換圖片' : '換背景'}${s.elements - (s.will === 'image' ? 1 : 0) > 0 ? `　⚠ 此頁另有 ${s.elements - (s.will === 'image' ? 1 : 0)} 個物件會疊在圖上` : ''}` : ''}`);
  }
  if (d.manualSlides) log(`  不動（人工填）：${Object.entries(d.manualSlides).map(([b, a]) => `${cfg.brands[b]?.name || b} 第 ${a.join('、')} 頁`).join('；')}`);
  if (dryRun) { log('（--dry-run：沒有做任何變更）'); return null; }

  const prep = await app.call('prepare', req);
  log(`${prep.reused ? '沿用' : '已建立'}：${prep.title}（${prep.slideCount} 頁）`);
  const done = [];
  for (const p of plan) {
    const body = {deckId: prep.deckId, index: p.slide, pngBase64: fs.readFileSync(p.png).toString('base64')};
    const r = p.op === 'append' ? await app.call('appendSlide', {...body, sourceIndex: p.duplicateOf}) : await app.call('putSlide', body);
    done.push({slide: p.slide, brand: p.brand, layout: p.layout, how: r.how});
    log(`  ✓ 第 ${p.slide} 頁（${r.how === 'image' ? '圖片' : '背景'}${r.appended ? '，新增' : ''}）`);
  }
  const fin = await app.call('finish', {deckId: prep.deckId});
  writeJson(path.join(monthDir, test ? 'push-test.json' : 'push.json'), {title: fin.title, url: fin.url, slideCount: fin.slideCount, at: new Date().toISOString(), slides: done});
  log(`完成：${fin.url}`);
  return fin.url;
}

/** Read-only check of a deck in the folder: info + slide thumbnails into output\<月份>\deck-check\.
 *  which = test ([測試] copy) | real (this month's deck) | original (this month's deck under the old title). */
export async function deckCheck({cfg, month, monthDir, which = 'test', slides = null, size = 'MEDIUM', log = console.log}) {
  const d = cfg.drive, app = await client();
  const title = which === 'original' ? titleFor(d.sourceTitleTemplate || d.titleTemplate, month) : titleFor(d.titleTemplate, month);
  const look = await app.call('lookup', {folderId: d.folderId, title, test: which === 'test', sourceTitles: []});
  if (!look.existingId) throw new Error(`資料夾內找不到「${look.title}」`);
  const info = await app.call('info', {fileId: look.existingId});
  const dir = path.join(monthDir, 'deck-check');
  fs.mkdirSync(dir, {recursive: true});
  writeJson(path.join(dir, `${which}.json`), {title: look.title, id: look.existingId, ...info, slides: look.slides});
  log(`${info.name}：${info.slideCount} 頁，最後修改 ${info.lastUpdated}`);
  const list = slides || Array.from({length: info.slideCount}, (_, i) => i + 1);
  for (const i of list) {
    const t = await app.call('thumbnail', {fileId: look.existingId, index: i, size});
    const res = await fetch(t.contentUrl, {signal: AbortSignal.timeout(60000)});
    if (!res.ok) throw new Error(`縮圖下載失敗（第 ${i} 頁，HTTP ${res.status}）`);
    fs.writeFileSync(path.join(dir, `${which}-${String(i).padStart(2, '0')}.png`), Buffer.from(await res.arrayBuffer()));
  }
  log(`縮圖 ${list.length} 張：${path.relative(path.dirname(path.dirname(monthDir)), dir)}`);
}
