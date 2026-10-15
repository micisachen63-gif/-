// 贏麻了 woodblock (ukiyo-e) backgrounds, drawn in code: parchment, navy frame, seigaiha waves, red sun,
// Fuji, maple leaves and gold coins. Rendered once into assets\bg\win\<layout>.png; replace those PNGs
// (1920x1080) with real artwork any time, the slide content is drawn on top.
export const WIN_BG_LAYOUTS = ['cover', 'page'];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const MAPLE = 'M50 2 L57 27 L76 12 L70 38 L97 34 L77 53 L88 62 L60 64 L63 92 L51 72 L50 99 L49 72 L37 92 L40 64 L12 62 L23 53 L3 34 L30 38 L24 12 L43 27 Z';
const maple = (x, y, s, rot, c, o = 1) => `<path d="${MAPLE}" transform="translate(${x} ${y}) rotate(${rot}) scale(${s / 100}) translate(-50 -50)" fill="${c}" opacity="${o}" stroke="#5a1a10" stroke-width="2.5"/>`;
const coin = (x, y, r) => `<g transform="translate(${x} ${y})"><circle r="${r}" fill="url(#gold)" stroke="#6b4a12" stroke-width="3"/><circle r="${r * 0.78}" fill="none" stroke="#7a5516" stroke-width="2" opacity=".7"/><rect x="${-r * 0.22}" y="${-r * 0.22}" width="${r * 0.44}" height="${r * 0.44}" fill="#3a2a10" stroke="#6b4a12" stroke-width="2"/></g>`;

export function winBgHtml(layout) {
  const r = rng(layout === 'cover' ? 11 : 7);
  const cover = layout === 'cover';
  const leaves = [], coins = [];
  const corners = cover
    ? [[40, 40, 420, 300], [1460, 40, 420, 260], [40, 760, 380, 200], [1500, 760, 380, 200]]
    : [[30, 30, 300, 150], [1590, 30, 300, 150], [30, 860, 260, 120], [1630, 860, 260, 120]];
  for (const [x0, y0, w, h] of corners) for (let i = 0; i < (cover ? 9 : 5); i++) {
    leaves.push(maple(x0 + r() * w, y0 + r() * h, 46 + r() * 50, Math.round(r() * 360), ['#c0392b', '#d35400', '#a93226', '#e67e22'][Math.floor(r() * 4)], 0.85 + r() * 0.15));
  }
  for (let i = 0; i < (cover ? 10 : 5); i++) coins.push(coin(cover ? 140 + r() * 360 : 70 + r() * 220, 900 + r() * 90, 22 + r() * 16), coin(cover ? 1420 + r() * 380 : 1630 + r() * 220, 900 + r() * 90, 22 + r() * 16));
  const sun = cover ? `<circle cx="1530" cy="250" r="150" fill="#c8442f" opacity=".92"/>` : `<circle cx="1700" cy="150" r="70" fill="#c8442f" opacity=".85"/>`;
  const fuji = cover
    ? `<path d="M560 760 L860 420 Q960 380 1060 420 L1360 760 Z" fill="#2c3e63" opacity=".85"/><path d="M800 490 L860 420 Q960 380 1060 420 L1120 490 L1060 470 L1010 500 L960 465 L905 505 L860 470 Z" fill="#f6f0e2"/>`
    : `<path d="M60 250 L190 110 Q230 92 270 110 L400 250 Z" fill="#2c3e63" opacity=".5"/><path d="M160 145 L190 110 Q230 92 270 110 L300 145 L270 138 L248 152 L228 136 L205 154 L188 138 Z" fill="#f6f0e2" opacity=".8"/>`;
  const waveH = cover ? 230 : 120;
  const clouds = cover ? `<g fill="#f6efe0" stroke="#c9a24a" stroke-width="3" opacity=".9"><rect x="1250" y="430" width="420" height="34" rx="17"/><rect x="1330" y="470" width="300" height="30" rx="15"/><rect x="250" y="360" width="380" height="32" rx="16"/><rect x="320" y="398" width="260" height="28" rx="14"/></g>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{width:1920px;height:1080px;overflow:hidden;background:#ead8b0}svg{display:block}</style></head><body>
<svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
<defs>
 <radialGradient id="paper" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#f6ead0"/><stop offset=".7" stop-color="#ead6aa"/><stop offset="1" stop-color="#cfae74"/></radialGradient>
 <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbe7a1"/><stop offset=".5" stop-color="#d8a93f"/><stop offset="1" stop-color="#9c6d1c"/></linearGradient>
 <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" seed="4"/><feColorMatrix values="0 0 0 0 .35  0 0 0 0 .25  0 0 0 0 .12  0 0 0 .55 0"/></filter>
 <filter id="fiber"><feTurbulence type="fractalNoise" baseFrequency=".012 .2" numOctaves="2" seed="9"/><feColorMatrix values="0 0 0 0 .55  0 0 0 0 .4  0 0 0 0 .2  0 0 0 .22 0"/></filter>
 <pattern id="sei" width="80" height="40" patternUnits="userSpaceOnUse">
  ${[[40, 0], [0, 20], [80, 20], [40, 40]].map(([x, y]) => `<g transform="translate(${x} ${y})">${[38, 29, 20, 11].map((rr, i) => `<circle r="${rr}" fill="${i % 2 ? '#f1e4c4' : '#1d2f52'}" stroke="#f1e4c4" stroke-width="2"/>`).join('')}</g>`).join('')}
 </pattern>
</defs>
<rect width="1920" height="1080" fill="url(#paper)"/>
<rect width="1920" height="1080" filter="url(#fiber)"/>
<rect width="1920" height="1080" filter="url(#grain)" opacity=".5"/>
${sun}${fuji}${clouds}
<g opacity="${cover ? 1 : 0.95}"><rect x="0" y="${1080 - waveH}" width="1920" height="${waveH}" fill="url(#sei)"/>
<path d="M0 ${1080 - waveH} ${Array.from({length: 25}, (_, i) => `Q ${i * 80 + 40} ${1080 - waveH - 26} ${i * 80 + 80} ${1080 - waveH}`).join(' ')}" fill="none" stroke="#f6efe0" stroke-width="7"/></g>
${leaves.join('')}${coins.join('')}
<rect x="14" y="14" width="1892" height="1052" fill="none" stroke="#1d2a44" stroke-width="16"/>
<rect x="30" y="30" width="1860" height="1020" fill="none" stroke="#c9a24a" stroke-width="4"/>
<rect x="38" y="38" width="1844" height="1004" fill="none" stroke="#1d2a44" stroke-width="2" opacity=".6"/>
${[[30, 30], [1890, 30], [30, 1050], [1890, 1050]].map(([x, y]) => `<rect x="${x - 16}" y="${y - 16}" width="32" height="32" fill="#b8352a" stroke="#c9a24a" stroke-width="3" transform="rotate(45 ${x} ${y})"/>`).join('')}
</svg><script>window.__ready=true</script></body></html>`;
}
