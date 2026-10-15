import {THEMES} from './themes.js';

// Code-drawn pastel background art (stage 1). One PNG per layout per theme is rendered once into
// assets\bg\<theme>\<layout>.png; drop a Grok-made 1920x1080 PNG with the same name to replace it.

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const heart = (c) => `<svg viewBox="0 0 32 29"><path d="M16 28C7 21 0 15.5 0 8.6 0 3.8 3.7 0 8.4 0c3 0 5.8 1.6 7.6 4.1C17.8 1.6 20.6 0 23.6 0 28.3 0 32 3.8 32 8.6 32 15.5 25 21 16 28z" fill="${c}"/></svg>`;
const spark = (c) => `<svg viewBox="0 0 40 40"><path d="M20 0C21.6 12 28 18.4 40 20 28 21.6 21.6 28 20 40 18.4 28 12 21.6 0 20 12 18.4 18.4 12 20 0z" fill="${c}"/></svg>`;
const star = (c) => `<svg viewBox="0 0 50 48"><path d="M25 1l7 15 16 2-12 11 3 16-14-8-14 8 3-16L2 18l16-2z" fill="${c}" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>`;

export function bgHtml(themeKey, layout) {
  const t = THEMES[themeKey];
  const r = rng(hash(themeKey + ':' + layout));
  const pick = (a) => a[Math.floor(r() * a.length)];
  const cover = layout === 'cover';
  const g = cover ? t.coverBg : t.bg;
  const els = [];
  const place = (strict) => {
    for (let i = 0; i < 12; i++) {
      const x = r() * 1920, y = r() * 1080;
      const inside = x > 200 && x < 1720 && y > 220 && y < 960;
      if (!inside || r() > strict) return [x, y];
    }
    return [r() * 1920, r() * 140];
  };
  // soft bokeh
  for (let i = 0; i < 16; i++) {
    const s = 90 + r() * 220, [x, y] = [r() * 1920, r() * 1080];
    els.push(`<i class="b" style="left:${x - s / 2}px;top:${y - s / 2}px;width:${s}px;height:${s}px;background:${pick(t.hearts)};opacity:${(0.16 + r() * 0.2).toFixed(2)};filter:blur(${(8 + r() * 18).toFixed(0)}px)"></i>`);
  }
  // hearts, sparkles, stars (mostly around the edges, the centre is covered by cards)
  for (let i = 0; i < 20; i++) { const s = 24 + r() * 52, [x, y] = place(0.8); els.push(`<i class="d" style="left:${x}px;top:${y}px;width:${s}px;transform:rotate(${(r() * 50 - 25).toFixed(0)}deg);opacity:${(0.55 + r() * 0.4).toFixed(2)}">${heart(pick(t.hearts))}</i>`); }
  for (let i = 0; i < 36; i++) { const s = 14 + r() * 40, [x, y] = place(0.7); els.push(`<i class="d" style="left:${x}px;top:${y}px;width:${s}px;opacity:${(0.6 + r() * 0.4).toFixed(2)}">${spark(pick(t.stars))}</i>`); }
  for (let i = 0; i < 8; i++) { const s = 34 + r() * 30, [x, y] = place(0.9); els.push(`<i class="d" style="left:${x}px;top:${y}px;width:${s}px;transform:rotate(${(r() * 40 - 20).toFixed(0)}deg);filter:drop-shadow(0 4px 6px rgba(150,90,170,.25))">${star(pick([t.gold, t.a1l, t.a2l]))}</i>`); }
  // clouds along the bottom (two layers)
  for (let x = -120; x < 2040; x += 120 + r() * 60) { const s = 170 + r() * 150; els.push(`<i class="c" style="left:${x}px;top:${1080 - s * 0.45}px;width:${s}px;height:${s}px;opacity:.75"></i>`); }
  for (let x = -60; x < 2040; x += 150 + r() * 80) { const s = 120 + r() * 120; els.push(`<i class="c" style="left:${x}px;top:${1080 - s * 0.32}px;width:${s}px;height:${s}px"></i>`); }
  // small clouds top corners
  for (const [cx, cy] of [[60, 70], [1860, 60]]) for (let k = 0; k < 4; k++) { const s = 70 + r() * 70; els.push(`<i class="c" style="left:${cx - s / 2 + (r() * 140 - 70)}px;top:${cy - s / 2 + (r() * 40 - 20)}px;width:${s}px;height:${s}px;opacity:.7"></i>`); }
  // corner emoji mascots
  const em = t.emoji[layout] || [];
  const spots = cover
    ? [[60, 90, 190, -10], [1650, 80, 190, 10], [120, 760, 170, -6], [1630, 760, 170, 8], [420, 60, 110, -12], [1390, 60, 110, 12]]
    : [[34, 22, 150, -8], [1736, 22, 150, 8]];
  em.forEach((e, i) => { const s = spots[i]; if (s) els.push(`<i class="e" style="left:${s[0]}px;top:${s[1]}px;font-size:${s[2]}px;transform:rotate(${s[3]}deg)">${e}</i>`); });
  const extra = cover
    ? `<div class="burst"></div><div class="glow"></div>
       <svg class="rib" viewBox="0 0 1920 1080"><defs><linearGradient id="g1" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".0"/><stop offset=".5" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
       <path d="M-50 820 C 400 700, 700 980, 1100 860 S 1700 700, 1980 800" stroke="url(#g1)" stroke-width="26" fill="none"/>
       <path d="M-50 880 C 380 780, 760 1040, 1150 920 S 1720 790, 1980 880" stroke="${t.a1l}" stroke-opacity=".8" stroke-width="14" fill="none"/></svg>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1920px;height:1080px;overflow:hidden}
body{position:relative;background:
 radial-gradient(circle at 12% 18%,rgba(255,255,255,.75),transparent 34%),
 radial-gradient(circle at 88% 82%,rgba(255,255,255,.55),transparent 36%),
 radial-gradient(rgba(255,255,255,.38) 2px,transparent 2.6px) 0 0/38px 38px,
 linear-gradient(160deg,${g[0]} 0%,${g[1]} 52%,${g[2]} 100%)}
i{position:absolute;display:block}
.b{border-radius:50%}
.d svg{width:100%;height:auto;display:block}
.c{border-radius:50%;background:radial-gradient(circle at 40% 35%,#fff 0,#fff 55%,rgba(255,255,255,.85) 70%,rgba(255,255,255,0) 72%)}
.e{font-family:'Segoe UI Emoji','Noto Color Emoji',sans-serif;line-height:1;filter:drop-shadow(0 10px 14px rgba(120,60,150,.28))}
.burst{position:absolute;inset:-400px;background:repeating-conic-gradient(from 0deg at 50% 50%,rgba(255,255,255,.20) 0 5deg,rgba(255,255,255,0) 5deg 12deg);-webkit-mask:radial-gradient(circle at 50% 50%,#000 0,#000 30%,transparent 62%)}
.glow{position:absolute;left:560px;top:180px;width:800px;height:640px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.85),rgba(255,255,255,0) 68%)}
.rib{position:absolute;inset:0;width:1920px;height:1080px}
</style></head><body>${extra}${els.join('')}<script>document.fonts.ready.then(()=>{window.__ready=true})</script></body></html>`;
}
