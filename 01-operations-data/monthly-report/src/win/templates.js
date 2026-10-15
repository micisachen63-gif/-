import {esc, fmtInt, fmtPct} from '../util.js';

// 贏麻了 pages (1920x1080), woodblock style. Live HTML on top of assets\bg\win\{cover,page}.png.
const KAI = `'DFKai-SB','BiauKai','標楷體','KaiTi','Noto Serif TC','Noto Serif CJK TC',serif`;
const SANS = `'Microsoft JhengHei','微軟正黑體','Noto Sans TC','Noto Sans CJK TC',sans-serif`;
const NUM = `'Times New Roman','Noto Serif TC','Noto Serif CJK TC',serif`;

const CSS = (bg) => `
:root{--navy:#1b2b4b;--navy2:#13203a;--ver:#a8322a;--ver2:#c8442f;--gold:#c9a24a;--gold2:#e8c874;--paper:#f6ecd4;--ink:#2b2014;--soft:#5b4a35;--up:#b3261e;--down:#1d5f86}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1920px;height:1080px;overflow:hidden}
body{position:relative;font-family:${SANS};color:var(--ink);background:#ead8b0 url("${bg}") center/cover no-repeat;-webkit-font-smoothing:antialiased}
.k{font-family:${KAI};font-weight:700}
.n{font-family:${NUM};font-weight:700;font-variant-numeric:lining-nums tabular-nums}
.ab{position:absolute}
.ttl{position:absolute;left:150px;right:150px;text-align:center;white-space:nowrap;overflow:hidden;font-family:${KAI};font-weight:700;line-height:1.15;padding:.08em .2em .14em}
.ttl span{color:var(--navy);paint-order:stroke fill;-webkit-text-stroke:.16em var(--paper);text-shadow:0 .05em 0 rgba(0,0,0,.25)}
.ttl span::selection{background:none}
.band{position:absolute;left:0;right:0;text-align:center}
.band b{display:inline-block;font-family:${KAI};font-weight:700;color:var(--paper);background:var(--ver);border:4px solid var(--gold);outline:3px solid var(--navy);padding:.12em 1.4em;letter-spacing:.06em;white-space:nowrap;box-shadow:0 6px 14px rgba(40,20,0,.3)}
.band.nv b{background:var(--navy)}
.pn,.pd{position:absolute;border:4px solid var(--navy);box-shadow:inset 0 0 0 4px rgba(246,236,212,.95),inset 0 0 0 6px var(--gold),0 10px 24px rgba(40,25,5,.28)}
.pn{background:rgba(248,240,220,.95)}
.pd{background:linear-gradient(180deg,#203560,#14223f);color:var(--paper);border-color:var(--gold);box-shadow:inset 0 0 0 4px #14223f,inset 0 0 0 6px rgba(232,200,116,.7),0 10px 24px rgba(20,10,0,.35)}
.pr{position:absolute;background:linear-gradient(180deg,#b23a2e,#8e2a21);color:var(--paper);border:4px solid var(--gold);box-shadow:inset 0 0 0 4px #8e2a21,inset 0 0 0 6px rgba(232,200,116,.7),0 10px 24px rgba(20,10,0,.35)}
.hd{position:absolute;left:50%;top:-30px;transform:translateX(-50%);font-family:${KAI};font-weight:700;font-size:36px;line-height:1.2;color:var(--paper);background:var(--ver);border:3px solid var(--gold);outline:3px solid var(--navy);padding:4px 30px;white-space:nowrap}
.pd .hd,.pr .hd{background:var(--navy)}
.in{position:absolute;inset:34px 26px 18px}
.ai{position:relative;height:100%}
.ai.ph{border:3px dashed var(--gold);background:repeating-linear-gradient(135deg,rgba(255,250,235,.55) 0 14px,rgba(232,214,170,.45) 14px 28px);padding:38px 14px 8px}
.pd .ai.ph,.pr .ai.ph{background:repeating-linear-gradient(135deg,rgba(255,255,255,.06) 0 14px,rgba(255,255,255,.12) 14px 28px)}
.ai-tag{position:absolute;top:6px;left:10px;font-size:19px;font-weight:700;color:var(--paper);background:var(--ver);padding:1px 12px;letter-spacing:1px}
.fit{height:100%;overflow:hidden;font-size:28px;line-height:1.5}
.fitw{white-space:nowrap;overflow:hidden}
.up{color:var(--up)}.down{color:var(--down)}.flat{color:var(--soft)}
.pd .up,.pr .up{color:#ffb4a2}.pd .down,.pr .down{color:#9fd3f2}
.masc{position:absolute;border:6px solid var(--gold);outline:4px solid var(--navy);box-shadow:0 14px 30px rgba(30,15,0,.4);background:#1b2b4b center/cover no-repeat}
.masc i{position:absolute;left:50%;bottom:-26px;transform:translateX(-50%);font-style:normal;font-family:${KAI};font-weight:700;font-size:30px;color:var(--navy);background:var(--paper);border:3px solid var(--gold);outline:3px solid var(--navy);padding:2px 22px;white-space:nowrap}
.seal{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;background:var(--ver);color:var(--paper);border:3px solid var(--gold);font-family:${KAI};font-weight:700;font-size:34px;flex:none}
.tile{position:relative;overflow:hidden;border:4px solid var(--gold);outline:3px solid var(--navy);background:linear-gradient(160deg,#24396a,#121f3a)}
.tile img{width:100%;height:100%;object-fit:cover;display:block}
.tile .tn{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:10px;font-family:${KAI};font-weight:700;color:var(--gold2);font-size:40px;line-height:1.15}
.rk{position:absolute;left:-4px;top:-4px;width:56px;height:56px;display:flex;align-items:center;justify-content:center;background:var(--ver);color:var(--paper);border:3px solid var(--gold);font-family:${NUM};font-weight:700;font-size:34px}
.note{position:absolute;font-size:18px;color:var(--soft)}
`;
const READY = `<script>document.fonts.ready.then(()=>{
for(const el of document.querySelectorAll('.fit')){let s=parseFloat(getComputedStyle(el).fontSize);while(el.scrollHeight>el.clientHeight+1&&s>15){s-=1;el.style.fontSize=s+'px';}}
for(const el of document.querySelectorAll('.fitw')){let s=parseFloat(getComputedStyle(el).fontSize);while(el.scrollWidth>el.clientWidth+1&&s>13){s-=1;el.style.fontSize=s+'px';}}
window.__ready=true;});</script>`;
const page = (bg, body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS(bg)}${extra}</style></head><body>${body}${READY}</body></html>`;

// ---------- helpers ----------
const I = (n) => fmtInt(n);
const S = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtInt(Math.abs(n))}`;
const W = (n) => fmtInt(n / 1e4);
const W1 = (n) => (n / 1e4).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1});
const P1 = (x) => `${(x * 100).toFixed(1)}%`;
const SP = (p, d = 1) => (p == null ? '—' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${(Math.abs(p) * 100).toFixed(d)}%`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const pct = (c, p) => (p ? (c - p) / p : null);
const box = (c, x, y, w, h, inner, head = '', extra = '') => `<div class="${c}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;${extra}">${head ? `<div class="hd">${esc(head)}</div>` : ''}${inner}</div>`;
const title = (text, top = 44, size = 92) => `<div class="ttl fitw" style="top:${top}px;font-size:${size}px"><span>${esc(text)}</span></div>`;
const band = (text, top = 168, size = 36, c = '') => `<div class="band ${c}" style="top:${top}px"><b style="font-size:${size}px">${esc(text)}</b></div>`;
const ai = (b, size = 28) => `<div class="ai ${b?.placeholder ? 'ph' : ''}">${b?.placeholder ? '<span class="ai-tag">AI 洞察・待填</span>' : ''}<div class="fit" style="font-size:${size}px">${esc(b?.text ?? '')}</div></div>`;
const masc = (img, x, y, w, h, cap = '') => `<div class="masc" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;background-image:url('${img}')">${cap ? `<i>${esc(cap)}</i>` : ''}</div>`;
const tile = (r, icons, size) => { const src = icons(r); return `<div class="tile" style="width:${size}px;height:${size}px">${src ? `<img src="${src}">` : `<div class="tn fitw" style="font-size:${Math.round(size / 5)}px">${esc(r.game)}</div>`}</div>`; };
const vs = (f) => `${f.month.label} VS. ${f.prev.label}`;
const pm = (f) => `${f.prev.m}-${f.month.m}月`;

// ---------- 1 cover ----------
export function cover({bg, f, deco}) {
  const body = `
<div class="ttl" style="top:110px;font-size:190px"><span>《${esc(f.brand.name)}》</span></div>
<div class="ttl" style="top:330px;font-size:104px"><span>營運數據分析報告</span></div>
${band(`${f.prev.label} vs. ${f.month.label} 營運實效、VIP動能與機台表現深度對比`, 500, 40, 'nv')}
<div class="band" style="top:610px"><b class="n" style="font-size:56px;padding:.08em 1.2em">${esc(f.quarter)}</b></div>
${masc(deco.a, 80, 640, 500, 330)}${masc(deco.b, 1520, 600, 320, 376)}
<div class="ab k" style="left:70px;top:70px;writing-mode:vertical-rl;font-size:34px;color:var(--paper);background:var(--ver);border:3px solid var(--gold);padding:14px 8px;letter-spacing:6px">${esc(f.brand.name)}月報</div>`;
  return page(bg, body);
}

// ---------- 2 core summary ----------
export function summary({bg, f, ins, deco}) {
  const big = (c, x, label, p, seal, detail) => box(c, x, 250, 570, 410, `
<div class="ab" style="left:36px;top:40px"><span class="seal">${seal}</span></div>
<div class="ab n fitw ${cls(p)}" style="left:120px;right:30px;top:40px;font-size:118px;line-height:1;text-align:center">${SP(p, 2)}</div>
<div class="ab k" style="left:0;right:0;top:186px;text-align:center;font-size:42px">${esc(label)}</div>
<div class="ab" style="left:40px;right:40px;top:262px;font-size:28px;line-height:1.55;text-align:center">${detail}</div>`);
  const d = f.dailyRevenue, b = f.bet;
  const body = `${title('核心摘要')}${band(vs(f))}
${big('pr', 80, '日均儲值變化', d.pct, '儲', `${f.month.label}日均 <b class="n">${I(d.cur)}</b>，<br>${f.prev.label}日均 <b class="n">${I(d.prev)}</b>。`)}
${big('pd', 690, '壓碼量趨勢', b.pct, '碼', `${f.month.label}壓碼 <b class="n">${I(b.cur)}</b>，<br>${f.prev.label}壓碼 <b class="n">${I(b.prev)}</b>。`)}
${box('pn', 80, 712, 1180, 240, `<div class="in" style="top:40px">${ai(ins.summary.insight, 28)}</div>`, '核心洞察')}
${masc(deco.b, 1330, 230, 500, 600, `${pm(f)}營運摘要`)}`;
  return page(bg, body);
}

// ---------- 3 channels ----------
export function channel({bg, f, ins}) {
  const c = f.channel, P = c.prev?.total, C = c.cur?.total;
  if (!C || !P) {
    const which = [!C && f.month.label, !P && f.prev.label].filter(Boolean).join('、');
    return page(bg, `${title('渠道成效分析')}${band(`${vs(f)} 新增會員渠道`)}
${box('pn', 260, 330, 1400, 420, `<div class="in k" style="display:flex;align-items:center;justify-content:center;text-align:center;font-size:46px;line-height:1.6">試算表「總表」${esc(which)}的渠道表尚未完成<br><span style="font-size:32px">（後台${esc(f.month.label)}新增 ${I(f.nuSum.cur)} 人）。試算表更新後重跑即可。</span></div>`, '資料待更新')}`);
  }
  const stat = (i, label, pv, cv, delta, fmt) => box(i % 2 ? 'pd' : 'pn', 80 + i * 445, 262, 415, 176, `
<div class="ab" style="left:0;right:0;top:40px;text-align:center;font-size:26px;opacity:.85">${f.prev.label} <b class="n" style="font-size:34px">${fmt(pv)}</b> → ${f.month.label}</div>
<div class="ab n fitw" style="left:20px;right:20px;top:82px;text-align:center;font-size:58px;line-height:1">${fmt(cv)}</div>
<div class="ab n ${delta.c}" style="left:0;right:0;top:142px;text-align:center;font-size:26px">${delta.t}</div>`, label);
  const pp = (a, b) => { const v = (a - b) * 100; return {t: `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}pp`, c: cls(v)}; };
  const dn = {t: `${S(C.reg - P.reg)}（${SP(pct(C.reg, P.reg))}）`, c: cls(C.reg - P.reg)};
  const cards = c.cards.slice(0, 6).map((x, i) => box('pn', 80 + (i % 3) * 590, 478 + Math.floor(i / 3) * 156, 560, 140, `
<div class="ab k fitw" style="left:24px;right:24px;top:14px;font-size:32px;color:var(--navy)">${esc(x.name)}</div>
<div class="ab" style="left:24px;right:20px;top:62px;display:flex;justify-content:space-between;font-size:22px;color:var(--soft)"><span>新增</span><span>無效率</span><span>付費轉化</span><span>儲值總額</span></div>
<div class="ab n" style="left:24px;right:20px;top:88px;display:flex;justify-content:space-between;font-size:30px"><span>${I(x.reg)}</span><span>${(x.invalidRate * 100).toFixed(2)}%</span><span>${(x.conv * 100).toFixed(2)}%</span><span style="color:var(--ver)">${I(x.amount)}</span></div>`)).join('');
  const low = c.low.length ? c.low.map((x) => `${esc(x.name)} ${I(x.reg)}/${I(x.payers)}`).join('、') : '無';
  const body = `${title('渠道成效分析')}${band(`${vs(f)} 新增會員渠道`)}
${stat(0, '新增人數', P.reg, C.reg, dn, I)}${stat(1, '無效率', P.invalidRate, C.invalidRate, pp(C.invalidRate, P.invalidRate), (v) => `${(v * 100).toFixed(2)}%`)}
${stat(2, '新增付費轉化', P.conv, C.conv, pp(C.conv, P.conv), (v) => `${(v * 100).toFixed(2)}%`)}${stat(3, '渠道儲值總額', P.amount, C.amount, {t: `${S(C.amount - P.amount)}（${SP(pct(C.amount, P.amount))}）`, c: cls(C.amount - P.amount)}, I)}
${cards}
${box('pd', 80, 800, 560, 150, `<div class="in" style="top:40px;font-size:24px;line-height:1.5"><div class="fit" style="font-size:24px">低量渠道（新增/付費）：${low}</div></div>`, '低量渠道')}
${box('pn', 670, 800, 1170, 150, `<div class="in" style="top:36px;bottom:12px">${ai(ins.channel.insight, 24)}</div>`, '核心洞察')}
${c.warn ? `<div class="note" style="left:60px;top:1046px">⚠ ${esc(c.warn)}</div>` : ''}`;
  return page(bg, body);
}

function lineChart(prev, cur, w, h) {
  const all = [...prev, ...cur].filter((v) => v != null);
  const max = Math.max(...all) * 1.08, min = Math.min(...all) * 0.9, n = Math.max(prev.length, cur.length);
  const X = (i) => 50 + (i / Math.max(n - 1, 1)) * (w - 70), Y = (v) => h - 36 - ((v - min) / (max - min || 1)) * (h - 60);
  const path = (a) => a.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
  const ticks = [1, 10, 20, n].map((d) => `<text x="${X(d - 1)}" y="${h - 8}" font-size="20" text-anchor="middle" fill="#5b4a35">${d}日</text>`).join('');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="50" y1="${h - 36}" x2="${w - 20}" y2="${h - 36}" stroke="#1b2b4b" stroke-width="2"/>
<path d="${path(prev)}" fill="none" stroke="#1b2b4b" stroke-width="4" stroke-dasharray="10 7"/><path d="${path(cur)}" fill="none" stroke="#b3261e" stroke-width="5"/>${ticks}</svg>`;
}

// ---------- 4 DAU / ARPPU ----------
export function activity({bg, f, ins, deco}) {
  const k = f.kpi, a = k.arppu, d = k.dau;
  const bh = (v) => Math.round((v / Math.max(a.prev, a.cur)) * 250);
  const bar = (x, v, c, lab) => `<div class="ab" style="left:${x}px;bottom:70px;width:150px;height:${bh(v)}px;background:${c};border:3px solid var(--gold);box-shadow:0 8px 16px rgba(0,0,0,.25)"><div class="n" style="position:absolute;top:-52px;left:-30px;right:-30px;text-align:center;font-size:44px">${I(v)}</div></div><div class="ab k" style="left:${x}px;width:150px;bottom:24px;text-align:center;font-size:30px">${lab}</div>`;
  const body = `${title('用戶活躍度與付費質量')}${band('DAU ・ ARPPU 月度比較')}
${box('pn', 80, 250, 860, 500, `
<div class="ab" style="left:36px;top:44px;font-size:30px">${f.prev.label} <b class="n" style="font-size:52px;color:var(--navy)">${I(d.prev)}</b> → ${f.month.label} <b class="n" style="font-size:64px;color:var(--ver)">${I(d.cur)}</b> <b class="n ${cls(d.pct)}" style="font-size:30px">（${SP(d.pct)}）</b></div>
<div class="ab" style="left:20px;top:140px">${lineChart(f.dauDaily.prev, f.dauDaily.cur, 820, 330)}</div>
<div class="ab" style="right:30px;top:130px;font-size:22px"><span style="color:var(--navy)">┅ ${f.prev.label}</span>　<span style="color:var(--up)">━ ${f.month.label}</span></div>`, 'DAU 月度比較（平均）')}
${box('pn', 980, 250, 620, 500, `${bar(120, a.prev, 'linear-gradient(#2a4374,#14223f)', f.prev.label)}${bar(350, a.cur, 'linear-gradient(#c8442f,#8e2a21)', f.month.label)}
<div class="ab n ${cls(a.cur - a.prev)}" style="left:0;right:0;top:44px;text-align:center;font-size:36px">${S(a.cur - a.prev)}（${SP(a.pct)}）</div>`, 'ARPPU 月度比較（台幣）')}
${masc(deco.b, 1640, 260, 210, 470)}
${box('pd', 80, 790, 860, 160, `<div class="in" style="top:22px">${ai(ins.activity.dau, 26)}</div>`)}
${box('pd', 980, 790, 860, 160, `<div class="in" style="top:22px">${ai(ins.activity.arppu, 26)}</div>`)}`;
  return page(bg, body);
}

// ---------- 5 net-win ranking ----------
export function winners({bg, f, ins, deco}) {
  const w = f.winners;
  const rows = w.top.map((r) => `<tr><td class="n">【${r.rank}】</td><td class="fitw nm">${esc(r.nick)}</td><td class="n" style="color:#ffd9a0">${I(r.net)}</td><td class="n">${r.hist == null ? '—' : I(r.hist)}</td></tr>`).join('');
  const lc = w.lowCap;
  const extra = `.tb{position:absolute;left:24px;right:24px;top:40px;border-collapse:collapse;font-size:29px}
.tb th{font-size:24px;color:var(--gold2);font-weight:700;padding:4px 8px;border-bottom:2px solid var(--gold);text-align:center}
.tb td{padding:2px 8px;text-align:center;border-bottom:1px solid rgba(232,200,116,.25);height:49px}.tb td.nm{max-width:300px;text-align:left}`;
  const body = `${title(`${f.month.label}贏錢排行分析`, 40, 88)}
<div class="band" style="top:152px"><b style="font-size:24px;background:var(--navy);padding:4px 26px">計算規則：幣商＝${esc(f.merchantShort)}｜贈禮差額正數＝玩家贏錢｜幣價÷${f.coinRate}｜儲值 1:1</b></div>
${box('pd', 80, 226, 900, 604, `<table class="tb"><tr><th>排名</th><th>暱稱</th><th>${f.month.label}淨贏</th><th>歷史充值</th></tr>${rows}</table>`, `${f.month.label}淨贏 TOP 10`)}
${box('pn', 1020, 230, 820, 330, `<div class="in" style="top:40px">${ai(ins.winners.analysis, 26)}</div>`, '核心分析')}
${masc(deco.a, 1020, 590, 820, 240)}
${box('pr', 80, 852, 560, 108, `<div class="ab k" style="left:24px;top:14px;font-size:30px">TOP1</div><div class="ab fitw" style="left:24px;right:20px;top:58px;font-size:30px">${esc(w.top[0]?.nick ?? '—')}　淨贏 <b class="n">${w.top[0] ? I(w.top[0].net) : '—'}</b></div>`)}
${box('pn', 670, 852, 560, 108, `<div class="ab k" style="left:24px;top:14px;font-size:30px;color:var(--ver)">低本金高贏幅</div><div class="ab fitw" style="left:24px;right:20px;top:58px;font-size:26px">${lc ? `${esc(lc.nick)}　歷史充值 <b class="n">${I(lc.hist)}</b> → 淨贏 <b class="n">${I(lc.net)}</b>` : '—'}</div>`)}
${box('pd', 1260, 852, 580, 108, `<div class="in" style="inset:12px 16px 10px">${ai(ins.winners.observe, 22)}</div>`)}`;
  return page(bg, body, extra);
}

// ---------- 6 where the platform loses ----------
export function bleed({bg, f, ins, deco}) {
  const w = f.winners, sm = w.smallMid;
  const li = (a, b, c = '') => `<div style="display:flex;justify-content:space-between;font-size:30px;line-height:1.75"><span>${a}</span><b class="n ${c}">${b}</b></div>`;
  const body = `${title('平台失血來源分析：前10名 vs 中小R', 44, 80)}
${box('pd', 80, 220, 1100, 300, `<div class="in" style="top:44px;left:40px;right:40px">
${li(`全體 ${I(w.players)} 人・玩家淨贏`, S(w.total), cls(w.total))}${li('TOP10 淨贏', S(w.top10), cls(w.top10))}${li(`TOP10 以外 ${I(w.restN)} 人`, S(w.rest), cls(w.rest))}
<div class="k" style="margin-top:6px;font-size:30px;color:var(--gold2)">${w.rest < 0 ? `排除 TOP10，平台反向貢獻約 ${W1(-w.rest)} 萬` : `排除 TOP10，平台仍失血 ${W1(w.rest)} 萬`}</div></div>`, '平台失血高度集中')}
${box('pn', 80, 560, 1100, 230, `<div class="in" style="top:44px;left:40px;right:40px">
${li(`小R（&lt;1萬）＋中R（1–5萬）合計 ${I(sm.n)} 人`, S(sm.sum), cls(sm.sum))}${li(`TOP10 內 ${I(sm.inTopN)} 人屬中小R，合計`, S(sm.inTop), cls(sm.inTop))}${li(`排除後 ${I(sm.outN)} 名中小R`, S(sm.out), cls(sm.out))}</div>`, '中小R不是主因，少數高贏幅才是重點')}
${box('pr', 80, 822, 340, 130, `<div class="ab" style="left:0;right:0;top:16px;text-align:center;font-size:24px">TOP10 占玩家贏錢總額</div><div class="ab n" style="left:0;right:0;top:50px;text-align:center;font-size:58px">${P1(w.top10ShareOfWins)}</div>`)}
${box('pn', 450, 822, 350, 130, `<div class="in" style="inset:12px 14px 10px">${ai(ins.bleed.watch, 22)}</div>`)}
${box('pn', 830, 822, 350, 130, `<div class="in" style="inset:12px 14px 10px">${ai(ins.bleed.focus, 22)}</div>`)}
${box('pn', 1220, 220, 620, 360, `<div class="in" style="top:40px">${ai(ins.bleed.insight, 26)}</div>`, '核心分析')}
${masc(deco.b, 1220, 610, 620, 340, `${f.month.label}失血結構分析`)}`;
  return page(bg, body);
}

// ---------- 7 VIP momentum ----------
export function vip({bg, f, ins, deco}) {
  const v = f.vip, max = Math.max(...v.top.map((r) => Math.max(r.cur, r.prev)), 1);
  const rows = v.top.map((r, i) => `<div class="ab" style="left:30px;right:30px;top:${60 + i * 60}px;height:56px;display:flex;align-items:center">
<div class="fitw" style="width:230px;font-size:26px;font-weight:700">${esc(r.nick)}</div>
<div style="position:relative;flex:1;height:52px">
<div style="position:absolute;left:0;top:3px;height:20px;width:${(r.prev / max) * 88}%;background:linear-gradient(90deg,#c8442f,#8e2a21)"></div><span class="n" style="position:absolute;top:0;left:calc(${(r.prev / max) * 88}% + 8px);font-size:20px">${I(r.prev)}</span>
<div style="position:absolute;left:0;top:28px;height:20px;width:${(r.cur / max) * 88}%;background:linear-gradient(90deg,#2a4374,#14223f)"></div><span class="n" style="position:absolute;top:25px;left:calc(${(r.cur / max) * 88}% + 8px);font-size:20px">${I(r.cur)}</span></div></div>`).join('');
  const t1 = v.top[0], p1 = v.prevTop1;
  const facts = [
    t1 ? `${esc(t1.nick)} ${f.month.label}儲值 ${I(t1.cur)}，${f.prev.label} ${I(t1.prev)}${t1.prev ? `（${SP(pct(t1.cur, t1.prev))}）` : ''}。` : '',
    p1 && t1 ? `${f.month.label}榜首 ${I(t1.cur)}，${f.prev.label}榜首 ${I(p1.amount)}（${SP(pct(t1.cur, p1.amount))}）；TOP ${v.top.length} 占當月儲值 ${P1(v.share.prev)} → ${P1(v.share.cur)}。` : '',
  ].filter(Boolean).map((s) => `<div>・${s}</div>`).join('');
  const body = `${title('頂尖大戶（VIP）儲值動能對比', 44, 84)}
${box('pn', 80, 220, 1160, 590, `${rows}<div class="ab" style="right:30px;top:20px;font-size:22px"><span style="color:var(--ver)">■ ${f.prev.label}</span>　<span style="color:var(--navy)">■ ${f.month.label}</span></div>`, `VIP 用戶 ${f.month.label}儲值 Top ${v.top.length}`)}
${box('pd', 80, 830, 1160, 130, `<div class="ab" style="left:26px;right:26px;top:14px;font-size:24px;line-height:1.5">${facts}</div>`)}
${box('pn', 1280, 220, 560, 330, `<div class="in" style="top:40px">${ai(ins.vip.notes, 25)}</div>`, '觀察')}
${masc(deco.a, 1280, 580, 560, 370)}`;
  return page(bg, body);
}

// ---------- 8 VIP insight ----------
export function vipinsight({bg, f, ins}) {
  const v = f.vip, t1 = v.top[0] || {nick: '—', prev: 0, cur: 0};
  const mx = Math.max(t1.prev, t1.cur, 1);
  const y = (val) => 300 - (val / mx) * 220;
  const chart = `<svg width="700" height="330"><line x1="60" y1="300" x2="680" y2="300" stroke="#e8c874" stroke-width="2"/>
<line x1="160" y1="${y(t1.prev)}" x2="560" y2="${y(t1.cur)}" stroke="#ff7a5c" stroke-width="6"/>
<circle cx="160" cy="${y(t1.prev)}" r="14" fill="#c8442f" stroke="#e8c874" stroke-width="3"/><circle cx="560" cy="${y(t1.cur)}" r="14" fill="#c8442f" stroke="#e8c874" stroke-width="3"/>
<text x="160" y="${y(t1.prev) - 26}" fill="#f6ecd4" font-size="30" text-anchor="middle" font-weight="700">${I(t1.prev)}</text><text x="560" y="${y(t1.cur) - 26}" fill="#f6ecd4" font-size="30" text-anchor="middle" font-weight="700">${I(t1.cur)}</text>
<text x="160" y="326" fill="#e8c874" font-size="24" text-anchor="middle">${f.prev.label}</text><text x="560" y="326" fill="#e8c874" font-size="24" text-anchor="middle">${f.month.label}</text></svg>`;
  const ov = v.overlap.slice(0, 4).map((o, i) => `<div class="ab" style="left:30px;right:30px;top:${50 + i * 58}px;height:52px;display:flex;align-items:center;gap:22px;border-bottom:1px solid rgba(27,43,75,.25)">
<span class="seal n" style="width:46px;height:46px;font-size:26px">${i + 1}</span><span class="k fitw" style="width:420px;font-size:32px;color:var(--navy)">${esc(o.nick)}</span>
<span style="font-size:28px">${f.prev.label} Top ${o.prevRank} → ${f.month.label} Top ${o.curRank}</span><span class="n" style="margin-left:auto;font-size:28px">${I(o.prev)} → ${I(o.cur)}</span></div>`).join('') ||
    `<div class="in k" style="font-size:34px;display:flex;align-items:center;justify-content:center">兩個月 Top 10 沒有重疊的 VIP</div>`;
  const body = `${title('VIP 核心洞察')}${band(vs(f))}
${box('pd', 80, 250, 760, 380, `<div class="ab k fitw" style="left:0;right:0;top:36px;text-align:center;font-size:32px;color:var(--gold2)">${esc(t1.nick)}</div><div class="ab" style="left:30px;top:44px">${chart}</div>`, `${f.month.label}儲值榜首`)}
${box('pn', 880, 250, 960, 170, `<div class="in" style="top:40px">${ai(ins.vipInsight.head, 25)}</div>`, '頭部效應')}
${box('pn', 880, 460, 960, 170, `<div class="in" style="top:40px">${ai(ins.vipInsight.core, 25)}</div>`, '核心大戶留存')}
${box('pn', 80, 670, 1760, 290, ov, `雙月重疊 VIP 名單（兩月 Top 10）`)}`;
  return page(bg, body);
}

const payerFacts = (f) => {
  const p = f.payers;
  return {
    a: [`${f.prev.label}付費人數 <b class="n">${I(p.payers.prev)}</b>`, `${f.month.label}付費人數 <b class="n">${I(p.payers.cur)}</b>`,
      `變化 <b class="n ${cls(p.payers.cur - p.payers.prev)}">${S(p.payers.cur - p.payers.prev)}（${SP(pct(p.payers.cur, p.payers.prev))}）</b>`,
      `營收 <b class="n">${I(p.revenue.prev)}</b> → <b class="n">${I(p.revenue.cur)}</b>（${SP(pct(p.revenue.cur, p.revenue.prev))}）`],
    b: [`雙月皆付費 <b class="n">${I(p.both.n)}</b> 人`, `${f.prev.label}儲值 <b class="n">${I(p.both.prev)}</b>`, `${f.month.label}儲值 <b class="n">${I(p.both.cur)}</b>（${S(p.both.cur - p.both.prev)}，${SP(pct(p.both.cur, p.both.prev))}）`,
      `ARPPU <b class="n">${I(p.arppu.prev)}</b> → <b class="n">${I(p.arppu.cur)}</b>（${SP(pct(p.arppu.cur, p.arppu.prev))}）`],
    c: [`${f.prev.label}付費、${f.month.label}未續 <b class="n">${I(p.gone.n)}</b> 人（${P1(p.gone.share)}）`, `其中${f.month.label}仍有投注 <b class="n">${I(p.gone.active)}</b> 人（${P1(p.gone.n ? p.gone.active / p.gone.n : 0)}）`,
      `${f.prev.label}新付費 <b class="n">${I(p.newPayers.n)}</b> 人 → ${f.month.label}續付 <b class="n">${I(p.newPayers.renewed)}</b> 人（${P1(p.newPayers.n ? p.newPayers.renewed / p.newPayers.n : 0)}）`],
  };
};
const bottom3 = (b, labels) => labels.map((l, i) => box('pn', 80 + i * 590, 840, 560, 115, `<div class="ab k" style="left:20px;top:12px;font-size:28px;color:var(--ver)">${l}</div><div class="ab" style="left:120px;right:16px;top:10px;bottom:8px">${ai(b[i], 22)}</div>`)).join('');

// ---------- 9 payer churn ----------
export function payers({bg, f, ins, deco}) {
  const x = payerFacts(f), li = (a) => a.map((s) => `<div style="margin-bottom:12px">・${s}</div>`).join('');
  const col = (c, i, head, items) => box(c, 80 + i * 420, 470, 395, 340, `<div class="ab" style="left:22px;right:18px;top:44px;font-size:24px;line-height:1.45">${li(items)}</div>`, head);
  const body = `${title(`${pm(f)}付費用戶分析：`, 36, 70)}<div class="ttl fitw" style="top:120px;font-size:62px"><span style="color:var(--ver)">${esc(ins.payers.headline.text)}</span></div>
${box('pn', 80, 250, 1240, 180, `<div class="in" style="top:40px">${ai(ins.payers.conclusion, 26)}</div>`, '結論')}
${col('pd', 0, '付費人數與營收', x.a)}${col('pn', 1, '持續付費用戶', x.b)}${col('pr', 2, '未續付與新付費', x.c)}
${masc(deco.b, 1360, 250, 480, 560, `${pm(f)}付費流失分析`)}
${bottom3([ins.payers.cause, ins.payers.cause2, ins.payers.focus], ['主因', '次因', '重點'])}`;
  return page(bg, body);
}

// ---------- 10 VIP driven revenue ----------
export function vipdrive({bg, f, ins, deco}) {
  const x = payerFacts(f), li = (a) => a.map((s) => `<div>・${s}</div>`).join('');
  const body = `${title(`VIP 驅動效應：${ins.vipDrive.headline.text}`, 40, 80)}
${box('pn', 80, 220, 1240, 150, `<div class="in" style="top:38px">${ai(ins.vipDrive.conclusion, 26)}</div>`, '核心結論')}
${box('pr', 80, 404, 1240, 206, `<div class="ab" style="left:30px;right:30px;top:40px;font-size:24px;line-height:1.45;columns:2">${li(x.b)}</div>`, '主力儲值用戶仍在')}
${box('pd', 80, 640, 1240, 170, `<div class="ab" style="left:30px;right:30px;top:40px;font-size:24px;line-height:1.45">${li([x.a[3], x.c[0] + '；' + x.c[1], x.c[2]])}</div>`, '儲值下降・付費轉換')}
${masc(deco.a, 1360, 220, 480, 590, `${pm(f)}營收變化分析`)}
${bottom3([ins.vipDrive.cause, ins.vipDrive.watch, ins.vipDrive.focus], ['主因', '觀察', '重點'])}`;
  return page(bg, body);
}

// ---------- 12 / 13 machine ranks ----------
function machineRanks({bg, f, ins, icons}, kind) {
  const isBet = kind === 'bet';
  const val = (r) => (isBet ? W(r[f.machines.field]) : W1(r.loss));
  const col = (list, x, head) => box('pn', x, 260, 860, 540, list.map((r, i) => `<div class="ab" style="left:${22 + i * 166}px;top:50px;width:150px">
<div style="position:relative">${tile(r, icons, 150)}<div class="rk">${r.rank}</div></div>
<div class="k fitw" style="margin-top:12px;text-align:center;font-size:27px;color:var(--navy);height:38px">${esc(r.game)}</div>
<div class="fitw" style="text-align:center;font-size:17px;color:var(--soft);height:24px">${esc(r.vendor)}</div>
<div class="n" style="margin-top:14px;text-align:center;font-size:${isBet ? 50 : 44}px;color:var(--ver)">${val(r)}</div></div>`).join('') +
    `<div class="ab" style="left:22px;right:22px;bottom:22px;text-align:center;font-size:24px;color:var(--soft)">Top5 合計 <b class="n" style="color:var(--navy);font-size:30px">${isBet ? W(list.reduce((s, r) => s + r[f.machines.field], 0)) : W1(list.reduce((s, r) => s + r.loss, 0))}</b> 萬</div>`, head);
  const m = f.machines, P = isBet ? m.prev.topBet : m.prev.topLoss, C = isBet ? m.cur.topBet : m.cur.topLoss;
  const body = `${title(isBet ? '熱門機台投注量 Top5' : 'RTP 失分機台 Top5')}${band(`${vs(f)} ${isBet ? '投注量分析（萬）' : '平台失分分析（萬）'}`)}
${col(P, 80, `${f.prev.label} ${isBet ? '投注量' : '失分'}（萬）`)}${col(C, 980, `${f.month.label} ${isBet ? '投注量' : '失分'}（萬）`)}
${box('pd', 80, 830, 1760, 125, `<div class="in" style="inset:16px 26px 12px">${ai(isBet ? ins.bets.text : ins.rtp.text, 25)}</div>`)}`;
  return page(bg, body);
}
export const bets = (a) => machineRanks(a, 'bet');
export const rtp = (a) => machineRanks(a, 'rtp');

// ---------- 14 machine insight ----------
export function machineinsight({bg, f, ins, icons}) {
  const m = f.machines, fld = m.field;
  const sumP = m.prev.topBet.reduce((s, r) => s + r[fld], 0), sumC = m.cur.topBet.reduce((s, r) => s + r[fld], 0);
  const cards = f.featured.map((r, i) => box('pn', 80 + i * 445, 240, 415, 410, `<div class="ab" style="left:52px;top:26px">${tile(r, icons, 300)}</div>
<div class="ab k fitw" style="left:16px;right:16px;top:338px;text-align:center;font-size:32px;color:var(--navy)">${esc(r.game)}</div>
<div class="ab" style="left:0;right:0;top:-24px;text-align:center"><b style="font-size:22px;background:var(--ver);color:var(--paper);border:2px solid var(--gold);padding:2px 14px">${esc(r.tag)}</b></div>`)).join('');
  const body = `${title('機台表現核心洞察')}${band(`${vs(f)} 熱門機台分析`)}
${cards}
${box('pd', 80, 690, 870, 220, `<div class="in" style="top:38px">${ai(ins.machineInsight.a, 25)}</div>`, ins.machineInsight.aTitle.text)}
${box('pn', 970, 690, 870, 220, `<div class="in" style="top:38px">${ai(ins.machineInsight.b, 25)}</div>`, ins.machineInsight.bTitle.text)}
<div class="band" style="top:930px"><b style="font-size:32px;background:var(--navy)">Top 5 總投注量：${f.prev.label} <span class="n">${W(sumP)}</span> 萬 → ${f.month.label} <span class="n">${W(sumC)}</span> 萬（${SP(pct(sumC, sumP))}）</b></div>`;
  return page(bg, body);
}

// ---------- 19 strategy ----------
export function strategy({bg, f, ins, deco}) {
  const s = ins.strategy, w = f.winners;
  const cards = s.cards.slice(0, 4).map((c, i) => box(i % 2 ? 'pn' : 'pd', 690, 220 + i * 186, 1150, 166, `
<div class="ab" style="left:24px;top:48px"><span class="seal n">${i + 1}</span></div>
<div class="ab k fitw" style="left:110px;right:24px;top:14px;font-size:34px;${i % 2 ? 'color:var(--ver)' : 'color:var(--gold2)'}">${esc(c.title.text)}</div>
<div class="ab" style="left:110px;right:24px;top:62px;bottom:10px">${ai(c.text, 24)}</div>`)).join('');
  const body = `${title(`戰略收斂：${s.title.text}`, 40, 84)}
${masc(deco.b, 80, 220, 570, 470)}
${box('pr', 80, 730, 570, 225, `<div class="ab" style="left:28px;right:28px;top:44px;font-size:26px;line-height:1.6">
<div>・全體 ${I(w.players)} 人淨贏 <b class="n">${S(w.total)}</b></div><div>・TOP10 <b class="n">${S(w.top10)}</b>（占玩家贏錢 ${P1(w.top10ShareOfWins)}）</div><div>・其餘 ${I(w.restN)} 人 <b class="n">${S(w.rest)}</b></div></div>`, '數據重點摘要')}
${cards}`;
  return page(bg, body);
}

export const PAGES = [
  {no: 1, key: 'cover', bg: 'cover', fn: cover}, {no: 2, key: 'summary', bg: 'page', fn: summary}, {no: 3, key: 'channel', bg: 'page', fn: channel},
  {no: 4, key: 'activity', bg: 'page', fn: activity}, {no: 5, key: 'winners', bg: 'page', fn: winners}, {no: 6, key: 'bleed', bg: 'page', fn: bleed},
  {no: 7, key: 'vip', bg: 'page', fn: vip}, {no: 8, key: 'vipinsight', bg: 'page', fn: vipinsight}, {no: 9, key: 'payers', bg: 'page', fn: payers},
  {no: 10, key: 'vipdrive', bg: 'page', fn: vipdrive}, {no: 12, key: 'bets', bg: 'page', fn: bets}, {no: 13, key: 'rtp', bg: 'page', fn: rtp},
  {no: 14, key: 'machineinsight', bg: 'page', fn: machineinsight}, {no: 19, key: 'strategy', bg: 'page', fn: strategy},
];
