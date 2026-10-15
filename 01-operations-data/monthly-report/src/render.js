import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {root} from './util.js';
import {bgHtml} from './bg.js';
import {THEMES, LAYOUTS} from './themes.js';
import {winBgHtml, WIN_BG_LAYOUTS} from './win/bg.js';
import {TEMPLATES} from './templates.js';

// Renders HTML to 1920x1080 PNG in a private headless Chrome (no profile, no debugging port).
export class Renderer {
  constructor(cfg) { this.cfg = cfg; }
  async start() {
    this.browser = await chromium.launch({executablePath: this.cfg.chrome, headless: true, args: ['--no-first-run', '--disable-extensions']});
    this.page = await this.browser.newPage({viewport: {width: 1920, height: 1080}, deviceScaleFactor: 1});
  }
  async png(html, out) {
    fs.mkdirSync(path.dirname(out), {recursive: true});
    await this.page.setContent(html, {waitUntil: 'load', timeout: 60000});
    await this.page.waitForFunction(() => window.__ready === true, null, {timeout: 30000});
    await this.page.screenshot({path: out, type: 'png'});
    return out;
  }
  async close() { await this.browser?.close().catch(() => {}); }
}

const themeLayouts = (th) => (th === 'win' ? WIN_BG_LAYOUTS : LAYOUTS);
export const dataUri = (f) => `data:image/${path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg')};base64,${fs.readFileSync(f).toString('base64')}`;
export const bgFile = (theme, layout) => path.join(root, 'assets', 'bg', theme, `${layout}.png`);

/** Create missing background PNGs (or all with force). */
export async function ensureBackgrounds(renderer, themes, layouts, {force = false, log = () => {}} = {}) {
  for (const th of themes) for (const l of layouts || themeLayouts(th)) {
    const f = bgFile(th, l);
    if (!force && fs.existsSync(f)) continue;
    await renderer.png(th === 'win' ? winBgHtml(l) : bgHtml(th, l), f);
    log(`背景圖：${path.relative(root, f)}`);
  }
}

/** Optional machine icons: assets\icons\<遊戲名稱>.png|jpg|webp */
/** Machine icons: assets\icons\<遊戲名稱>.png|jpg|webp (manual override) first, then pictures from the
 *  backend game list downloaded into output\<月份>\data\icons. */
export function iconLookup(downloaded = new Map()) {
  const dir = path.join(root, 'assets', 'icons');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : [];
  const manual = new Map(files.map((f) => [path.parse(f).name, path.join(dir, f)]));
  return (r) => {
    const f = manual.get(r.game) || downloaded.get(String(r.gameId));
    return f && fs.existsSync(f) ? dataUri(f) : null;
  };
}

const sniff = (b) => (b[0] === 0x89 && b[1] === 0x50 ? 'png' : b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' ? 'webp' : b.slice(0, 3).toString() === 'GIF' ? 'gif' : null);

/** Download the pictures of the given machines (best effort; failures fall back to the drawn tile). */
export async function fetchIcons(rows, gameList, baseUrl, dir, log = () => {}) {
  const byId = new Map(gameList.map((g) => [String(g.id), g]));
  const out = new Map();
  fs.mkdirSync(dir, {recursive: true});
  for (const r of rows) {
    const id = String(r.gameId ?? '');
    if (!id || out.has(id)) continue;
    const g = byId.get(id);
    const pic = g?.pic_small || g?.pic_large;
    if (!pic) continue;
    const existing = fs.readdirSync(dir).find((f) => path.parse(f).name === id);
    if (existing) { out.set(id, path.join(dir, existing)); continue; }
    try {
      // pictures live at <static host>/vendor_game/<game id>/<pic_small> (pic_small is a file name such as "s")
      const url = /^https?:/.test(pic) ? pic : `${baseUrl}vendor_game/${id}/${pic}`;
      const res = await fetch(url, {signal: AbortSignal.timeout(20000)});
      const type = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = sniff(buf); // the static host answers application/octet-stream, so look at the bytes
      if (!res.ok || !ext) throw new Error(`HTTP ${res.status} ${type}`);
      const f = path.join(dir, `${id}.${ext}`);
      fs.writeFileSync(f, buf);
      out.set(id, f);
    } catch (e) { log(`機台圖示下載失敗（${r.game}）：${e.message}`); }
  }
  return out;
}

export async function renderSlide(renderer, themeKey, layout, facts, insights, out, icons) {
  const t = THEMES[themeKey];
  const html = TEMPLATES[layout](t, dataUri(bgFile(themeKey, layout)), facts, insights, icons);
  return renderer.png(html, out);
}
