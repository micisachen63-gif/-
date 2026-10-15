import {esc, fmtKpi, fmtPct, fmtWan, zhMonth} from './util.js';

// HTML templates (1920x1080). Every number/text is live HTML on top of a swappable background.

const FONT = `'Microsoft JhengHei','微軟正黑體','Noto Sans TC','Noto Sans CJK TC',sans-serif`;
const NUMF = `'Segoe UI','Microsoft JhengHei','Noto Sans TC',sans-serif`;

function css(t, bg) {
  return `
:root{--ink:${t.ink};--soft:${t.soft};--muted:${t.muted};--a1:${t.a1};--a1l:${t.a1l};--a2:${t.a2};--a2l:${t.a2l};--a3:${t.a3};--a3l:${t.a3l};--gold:${t.gold};
--t1:${t.t[0]};--t2:${t.t[1]};--t3:${t.t[2]};--shadow:${t.shadow};--cb:${t.cardBorder};--prev:${t.prev};--cur:${t.cur};--up:${t.up};--down:${t.down}}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1920px;height:1080px;overflow:hidden}
body{position:relative;font-family:${FONT};color:var(--ink);background:#fff url("${bg}") center/cover no-repeat;-webkit-font-smoothing:antialiased}
.num{font-family:${NUMF};font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.emo{font-family:'Segoe UI Emoji','Noto Color Emoji',sans-serif;font-weight:400}
.ttl{position:absolute;left:220px;right:220px;text-align:center;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;padding:.12em .2em .2em}
.stk{position:relative;display:inline-block}
.stk::before{content:attr(data-t);position:absolute;left:0;top:0;-webkit-text-stroke:.22em #fff;color:#fff;filter:drop-shadow(0 .06em 0 var(--shadow)) drop-shadow(0 .12em .18em rgba(110,50,140,.25))}
.stk>span{position:relative;background:linear-gradient(180deg,var(--t1) 8%,var(--t2) 58%,var(--t3));-webkit-background-clip:text;background-clip:text;color:transparent}
.stk.alt>span{background-image:linear-gradient(180deg,var(--a3) 0%,var(--t3) 60%,var(--a2))}
.sub{position:absolute;left:0;right:0;text-align:center}
.pill{display:inline-flex;align-items:center;gap:.45em;padding:.26em 1.2em;border-radius:999px;background:rgba(255,255,255,.95);border:4px solid var(--a1l);font-weight:700;color:var(--ink);box-shadow:0 6px 0 var(--a2l),0 10px 24px rgba(120,70,160,.15);white-space:nowrap}
.card{position:absolute;background:rgba(255,255,255,.86);border-radius:36px;border:5px solid #fff;box-shadow:0 0 0 4px var(--cb),0 18px 40px rgba(120,70,160,.18)}
.hp{position:absolute;left:50%;top:-34px;transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:6px 34px;border-radius:999px;font-size:38px;font-weight:700;color:#fff;background:linear-gradient(90deg,var(--a1),var(--a2));border:5px solid #fff;box-shadow:0 6px 16px rgba(120,70,160,.25);white-space:nowrap}
.hp.b2{background:linear-gradient(90deg,var(--a2),var(--a3))}
.hp.b3{background:linear-gradient(90deg,var(--a3),var(--a1))}
.chg{display:flex;align-items:center;justify-content:center;gap:10px;font-weight:700;font-size:34px;border-radius:18px;padding:8px 0}
.chg.down{color:var(--down);background:rgba(59,134,240,.10)}
.chg.up{color:var(--up);background:rgba(255,79,139,.10)}
.chg.flat{color:var(--soft);background:rgba(120,100,160,.08)}
.ai{position:relative;height:100%}
.ai.ph{border:3px dashed var(--a2);border-radius:18px;background:repeating-linear-gradient(135deg,rgba(255,255,255,.75) 0 16px,rgba(238,230,255,.75) 16px 32px);padding:46px 18px 12px}
.ai-tag{position:absolute;top:8px;left:12px;font-size:20px;font-weight:700;color:#fff;background:var(--a2);padding:2px 14px;border-radius:999px;letter-spacing:1px}
.fit{height:100%;overflow:hidden;font-size:30px;line-height:1.55}
.ai.ph .fit{color:var(--soft)}
.fitw{white-space:nowrap;overflow:hidden}
`;
}

const READY = `<script>document.fonts.ready.then(()=>{
for(const el of document.querySelectorAll('.fit')){let s=parseFloat(getComputedStyle(el).fontSize);while(el.scrollHeight>el.clientHeight+1&&s>16){s-=1;el.style.fontSize=s+'px';}}
for(const el of document.querySelectorAll('.fitw')){let s=parseFloat(getComputedStyle(el).fontSize);while(el.scrollWidth>el.clientWidth+1&&s>14){s-=1;el.style.fontSize=s+'px';}}
window.__ready=true;});</script>`;

const page = (t, bg, body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><style>${css(t, bg)}${extra}</style></head><body>${body}${READY}</body></html>`;
const title = (text, top, size, cls = '') => `<div class="ttl fitw" style="top:${top}px;font-size:${size}px"><span class="stk ${cls}" data-t="${esc(text)}"><span>${esc(text)}</span></span></div>`;
const twoTone = (a, b, top, size) => `<div class="ttl fitw" style="top:${top}px;font-size:${size}px"><span class="stk" data-t="${esc(a)}"><span>${esc(a)}</span></span>&nbsp;<span class="stk alt" data-t="${esc(b)}"><span>${esc(b)}</span></span></div>`;
const sub = (html, top, size = 34) => `<div class="sub" style="top:${top}px"><span class="pill" style="font-size:${size}px">${html}</span></div>`;
const ai = (block, size = 30) => `<div class="ai ${block?.placeholder ? 'ph' : ''}">${block?.placeholder ? '<span class="ai-tag">AI 洞察・待填</span>' : ''}<div class="fit" style="font-size:${size}px">${esc(block?.text ?? '')}</div></div>`;
const span = (f) => `${f.prev.m}-${f.month.m}月`;
function chg(p, prefix = '') {
  if (p == null) return `<div class="chg flat">—</div>`;
  const cls = p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
  const arrow = p > 0 ? '▲' : p < 0 ? '▼' : '＝';
  const word = p > 0 ? '上升' : p < 0 ? '下降' : '持平';
  return `<div class="chg ${cls}"><span>${arrow}</span><span>${prefix}${word} ${p === 0 ? '' : fmtPct(Math.abs(p))}</span></div>`;
}

// ---------------- cover (slide 20) ----------------
export function cover(t, bg, f) {
  const extra = `
.emb{position:absolute;left:760px;top:330px;width:400px;height:400px;border-radius:50%;padding:16px;background:conic-gradient(from 0deg,#ffe9a8,${t.gold},#fff4c9,${t.gold},#ffe9a8);box-shadow:0 20px 50px rgba(110,50,140,.35)}
.emb>div{width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 35% 30%,${t.a1l},${t.a1} 55%,${t.a2});display:flex;align-items:center;justify-content:center;flex-direction:column;border:8px solid #fff}
.emb b{font-size:210px;line-height:1;color:#fff;-webkit-text-stroke:6px ${t.gold};text-shadow:0 8px 0 rgba(120,40,120,.25);font-weight:700}
.emb i{font-style:normal;margin-top:6px;font-size:34px;font-weight:700;color:${t.ink};background:#fff;border-radius:999px;padding:2px 22px;letter-spacing:6px}
.crown{position:absolute;left:900px;top:250px;font-size:120px}
.rb{position:absolute;left:330px;right:330px;top:790px;height:118px;border-radius:999px;background:linear-gradient(90deg,${t.a2},${t.a1},${t.a2});border:6px solid #fff;box-shadow:0 10px 0 rgba(110,50,140,.18),0 18px 40px rgba(110,50,140,.25);display:flex;align-items:center;justify-content:center;font-size:58px;font-weight:700;color:#fff;letter-spacing:4px;text-shadow:0 3px 0 rgba(90,30,110,.35)}
.yt{position:absolute;left:0;right:0;top:940px;text-align:center}`;
  const name = `${f.brand.name}營運報告`;
  const body = `${title(name, 60, 190)}
<div class="crown emo">👑</div>
<div class="emb"><div><b>${esc(t.emblem)}</b><i>${esc(t.emblemSub)}</i></div></div>
<div class="rb">💗&nbsp;${esc(zhMonth(f.month.m))}月營運數據分析與表現回顧&nbsp;💗</div>
<div class="yt"><span class="pill num" style="font-size:36px">${f.month.y} 年 ${f.month.m} 月</span></div>`;
  return page(t, bg, body, extra);
}

// ---------------- key numbers with MoM (slide 21) ----------------
export function kpi(t, bg, f, ins) {
  const k = f.kpi, P = f.prev.label, C = f.month.label;
  const extra = `
.kc{top:270px;width:432px;height:330px;padding:62px 30px 24px}
.kr{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.kr .ml{flex:none;font-size:30px;font-weight:700;color:var(--soft);background:var(--a2l);border-radius:12px;padding:2px 14px}
.kr.cur .ml{background:var(--a1l);color:var(--ink)}
.kr .v{font-size:50px;color:var(--soft);text-align:right;min-width:0}
.kr.cur .v{font-size:76px;color:var(--ink)}
.vs{text-align:center;font-size:24px;font-weight:700;color:var(--muted);margin:2px 0}
.kc .chg{margin-top:14px}
.bc{top:668px;height:372px;width:432px;padding:56px 26px 24px}
.fd .l{font-size:26px;font-weight:700;color:var(--soft)}
.fd .v{font-size:56px;color:var(--ink);margin-bottom:6px}
.fd .v.cur{color:var(--a1)}
.fd .chg{font-size:28px;margin-top:6px}`;
  const card = (i, label, emo, key) => {
    const x = 54 + i * 462, d = k[key];
    return `<div class="card kc" style="left:${x}px"><div class="hp ${['', 'b2', 'b3', ''][i]}"><span class="emo">${emo}</span>${label}</div>
<div class="kr"><span class="ml">${P}</span><span class="v num fitw">${fmtKpi(d.prev)}</span></div>
<div class="vs">VS</div>
<div class="kr cur"><span class="ml">${C}</span><span class="v num fitw">${fmtKpi(d.cur)}</span></div>
${chg(d.pct)}</div>`;
  };
  const bottom = (i, label, emo, inner) => `<div class="card bc" style="left:${54 + i * 462}px"><div class="hp ${['b2', '', 'b3', 'b2'][i]}" style="font-size:34px"><span class="emo">${emo}</span>${label}</div>${inner}</div>`;
  const fd = k.firstDeposit;
  const body = `${twoTone(f.brand.name, `${span(f)}數據對比`, 36, 104)}
${sub('<span class="emo">💗</span>核心指標與表現分析<span class="emo">💗</span>', 178)}
${card(0, 'DAU', '👥', 'dau')}${card(1, 'NU', '🌱', 'nu')}${card(2, '玩家儲值', '💰', 'revenue')}${card(3, 'ARPPU', '💎', 'arppu')}
${bottom(0, '平台現況', '📊', ai(ins.kpi.status, 30))}
${bottom(1, '首儲成績', '🎁', `<div class="fd"><div class="l">${f.prev.range} 首儲總額</div><div class="v num">${fmtKpi(fd.prev)}</div>
<div class="l">${f.month.range} 首儲總額</div><div class="v num cur">${fmtKpi(fd.cur)}</div>${chg(fd.pct, `較${P}`)}</div>`)}
${bottom(2, '活躍維持策略', '🎯', ai(ins.kpi.strategy, 30))}
${bottom(3, '成效', '🏆', ai(ins.kpi.effect, 30))}`;
  return page(t, bg, body, extra);
}

function niceTicks(max, n = 4) {
  if (!(max > 0)) return {top: 1, ticks: [0, 1]};
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((x) => x * p).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step, ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  return {top, ticks};
}

// ---------------- spending tiers (slide 22) ----------------
export function tiers(t, bg, f, ins) {
  const L = f.tiers.list, P = f.prev.label, C = f.month.label;
  const extra = `
.ch{top:230px;width:888px;height:380px;padding:24px 34px 20px}
.ch h3{font-size:38px;display:flex;align-items:center;gap:12px}
.ch h3 small{font-size:26px;color:var(--soft);font-weight:700}
.lg{position:absolute;right:34px;top:34px;display:flex;gap:22px;font-size:26px;font-weight:700}
.lg i{display:inline-block;width:30px;height:20px;border-radius:6px;margin-right:8px;vertical-align:-2px}
.rows{position:absolute;left:34px;right:44px;top:92px;height:216px}
.row{position:absolute;left:0;right:0;height:62px;display:flex;align-items:center}
.row .lb{width:250px;font-size:26px;font-weight:700;color:var(--soft);line-height:1.15}
.bars{position:relative;flex:1;height:62px}
.bar{position:absolute;left:0;height:25px;border-radius:0 14px 14px 0;display:flex;align-items:center}
.bar b{position:absolute;left:100%;margin-left:10px;font-size:26px;white-space:nowrap}
.bar.p{top:3px;background:linear-gradient(90deg,var(--a3l),var(--prev))}
.bar.c{top:33px;background:linear-gradient(90deg,var(--a1l),var(--cur))}
.bar.p b{color:var(--prev)}.bar.c b{color:var(--cur)}
.ax{position:absolute;left:284px;right:44px;bottom:12px;height:28px}
.ax span{position:absolute;transform:translateX(-50%);font-size:20px;color:var(--muted);font-weight:700}
.grid{position:absolute;top:92px;bottom:44px;border-left:2px dashed rgba(160,130,190,.25)}
.tc{top:654px;width:576px;height:188px;padding:52px 26px 16px;display:flex;gap:16px}
.tc>div{flex:1;text-align:center}
.tc .h{font-size:24px;font-weight:700;color:var(--soft);margin-bottom:6px}
.tc .m{display:flex;align-items:center;justify-content:center;gap:10px;font-size:22px;font-weight:700}
.tc .m span.k{color:#fff;border-radius:8px;padding:0 10px}
.tc .v{display:flex;align-items:center;justify-content:center;gap:10px;font-size:48px}
.tc .v .ar{font-size:30px;color:var(--muted)}
.ob{top:872px;left:54px;width:1812px;height:178px;padding:22px 30px 18px 270px;display:flex;gap:22px}
.ob .tag{position:absolute;left:28px;top:34px;width:210px;height:110px;border-radius:26px;background:linear-gradient(135deg,var(--a1),var(--a2));color:#fff;font-size:34px;font-weight:700;white-space:nowrap;display:flex;align-items:center;justify-content:center;gap:6px;border:5px solid #fff;box-shadow:0 8px 20px rgba(120,70,160,.25)}
.ob .pt{flex:1;display:flex;gap:12px}
.ob .no{flex:none;width:52px;height:52px;border-radius:50%;background:var(--a2l);color:var(--ink);font-size:30px;font-weight:700;display:flex;align-items:center;justify-content:center}
.ob .pt .ai{flex:1}`;
  const chart = (x, ttl, emo, key, fmt) => {
    const max = Math.max(...L.flatMap((r) => [r.prev[key], r.cur[key]]));
    const {top, ticks} = niceTicks(max);
    const S = 0.86, w = (v) => `${(v / top) * 100 * S}%`;
    const rows = L.map((r, i) => `<div class="row" style="top:${i * 77}px"><div class="lb">${esc(r.label)}<br><small>(${esc(r.range)})</small></div>
<div class="bars"><div class="bar p" style="width:${w(r.prev[key])}"><b class="num">${fmt(r.prev[key])}</b></div><div class="bar c" style="width:${w(r.cur[key])}"><b class="num">${fmt(r.cur[key])}</b></div></div></div>`).join('');
    const axis = ticks.map((v) => `<span class="num" style="left:${(v / top) * 100 * S}%">${fmt(v)}</span>`).join('');
    const grid = ticks.map((v) => `<i class="grid" style="left:calc(284px + (100% - 328px) * ${(v / top) * S})"></i>`).join('');
    return `<div class="card ch" style="left:${x}px"><h3><span class="emo">${emo}</span>${ttl}<small>（${P} vs ${C}）</small></h3>
<div class="lg"><span><i style="background:var(--prev)"></i>${P}</span><span><i style="background:var(--cur)"></i>${C}</span></div>
${grid}<div class="rows">${rows}</div><div class="ax">${axis}</div></div>`;
  };
  const tierCard = (i, r) => `<div class="card tc" style="left:${54 + i * 618}px"><div class="hp ${['', 'b2', 'b3'][i]}" style="font-size:32px"><span class="emo">${['🏆', '💎', '🪙'][i]}</span>${esc(r.label)}<small style="font-size:24px">（${esc(r.range)}）</small></div>
<div><div class="h">用戶數量</div><div class="v num"><span style="color:var(--prev)">${fmtKpi(r.prev.users)}</span><span class="ar">➜</span><span style="color:var(--cur)">${fmtKpi(r.cur.users)}</span></div></div>
<div><div class="h">儲值貢獻占比</div><div class="v num" style="font-size:40px"><span style="color:var(--prev)">${fmtPct(r.prev.share)}</span><span class="ar">➜</span><span style="color:var(--cur)">${fmtPct(r.cur.share)}</span></div></div></div>`;
  const pts = ins.tiers.points.slice(0, 3).map((p, i) => `<div class="pt"><div class="no num">${i + 1}</div>${ai(p, 26)}</div>`).join('');
  const body = `${title(`${span(f)}儲值用戶輪廓分析`, 30, 96)}
${sub(`依儲值金額分層：${L.map((r) => `${r.label.replace('用戶', '')} ${r.range}`).join('｜')}`, 158, 30)}
${chart(54, '用戶數量', '👥', 'users', (v) => fmtKpi(v))}
${chart(978, '儲值貢獻金額', '💰', 'amount', (v) => Math.round(v).toLocaleString('en-US'))}
${L.map((r, i) => tierCard(i, r)).join('')}
<div class="card ob"><div class="tag"><span class="emo">🔍</span>重點觀察</div>${pts}</div>`;
  return page(t, bg, body, extra);
}

// shared Top5 list (slides 23/24)
function topList(t, f, items, valueOf, unit, icons) {
  const rows = items.map((r, i) => {
    const icon = icons?.(r);
    const hue = [...r.game].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 360, 7);
    const tile = icon
      ? `<div class="ic" style="background:#fff url('${icon}') center/cover"></div>`
      : `<div class="ic" style="background:linear-gradient(135deg,hsl(${hue} 85% 78%),hsl(${(hue + 40) % 360} 75% 62%))"><b>${esc([...r.game][0] || '?')}</b><span class="emo">🎰</span></div>`;
    return `<div class="it" style="top:${i * (unit.rowH + unit.gap)}px;height:${unit.rowH}px"><div class="rk num" style="background:${t.ranks[i]}">${i + 1}</div>${tile}
<div class="nm"><div class="g">${esc(r.game)}</div><div class="vd">${esc(r.vendor)}</div></div><div class="val num fitw">${valueOf(r)}${unit.suffix ? `<small>${unit.suffix}</small>` : ''}</div></div>`;
  }).join('');
  return rows || `<div class="it" style="top:0;height:${unit.rowH}px;justify-content:center;color:var(--soft);font-size:32px">本月無資料</div>`;
}
const listCss = (rowH) => `
.col{width:876px;padding:0 28px}
.col .hp{font-size:36px}
.lst{position:absolute;left:28px;right:28px}
.it{position:absolute;left:0;right:0;display:flex;align-items:center;gap:22px;background:rgba(255,255,255,.92);border-radius:26px;padding:0 28px 0 18px;box-shadow:0 0 0 3px var(--cb),0 6px 14px rgba(120,70,160,.12)}
.it:nth-child(odd){background:linear-gradient(90deg,rgba(255,255,255,.95),var(--a1l))}
.it:nth-child(even){background:linear-gradient(90deg,rgba(255,255,255,.95),var(--a2l))}
.rk{flex:none;width:${Math.round(rowH * 0.62)}px;height:${Math.round(rowH * 0.62)}px;border-radius:50%;color:#fff;font-size:${Math.round(rowH * 0.36)}px;display:flex;align-items:center;justify-content:center;border:4px solid #fff;box-shadow:0 4px 10px rgba(110,60,140,.25);text-shadow:0 2px 0 rgba(0,0,0,.15)}
.ic{position:relative;flex:none;width:${Math.round(rowH * 0.8)}px;height:${Math.round(rowH * 0.8)}px;border-radius:22px;border:4px solid #fff;box-shadow:0 4px 10px rgba(110,60,140,.22);display:flex;align-items:center;justify-content:center;overflow:hidden}
.ic b{font-size:${Math.round(rowH * 0.42)}px;color:#fff;text-shadow:0 3px 0 rgba(80,30,100,.3)}
.ic .emo{position:absolute;right:2px;bottom:0;font-size:${Math.round(rowH * 0.22)}px}
.nm{flex:1;min-width:0}
.nm .g{font-size:${Math.min(36, Math.round(rowH * 0.27))}px;font-weight:700;line-height:1.2;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nm .vd{font-size:22px;color:var(--soft);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.val{flex:none;max-width:330px;font-size:${Math.round(rowH * 0.36)}px;color:var(--ink);text-align:right}
.val small{font-size:.5em;margin-left:4px;color:var(--soft)}`;

// ---------------- machine Top5 by valid bet (slide 23) ----------------
export function machines(t, bg, f, _ins, icons) {
  const unit = {rowH: 140, gap: 18, suffix: ''};
  const col = (x, label, items, b) => `<div class="card col" style="left:${x}px;top:232px;height:820px"><div class="hp ${b}"><span class="emo">🏆</span>${label} 有效投注額（萬）</div>
<div class="lst" style="top:62px">${topList(t, f, items, (r) => fmtWan(r.validBet), unit, icons)}</div></div>`;
  const body = `${twoTone('熱門機台投注量', `${span(f)}數據對比 Top5`, 40, 92)}
${col(64, f.prev.label, f.machines.prev, 'b2')}${col(980, f.month.label, f.machines.cur, '')}`;
  return page(t, bg, body, listCss(unit.rowH));
}

// ---------------- RTP loss Top5 (slide 24) ----------------
export function rtp(t, bg, f, ins, icons) {
  const unit = {rowH: 96, gap: 10, suffix: '萬'};
  const col = (x, label, items, b) => `<div class="card col" style="left:${x}px;top:262px;height:556px"><div class="hp ${b}"><span class="emo">📉</span>${label} RTP 失分（萬）</div>
<div class="lst" style="top:50px">${topList(t, f, items, (r) => fmtWan(r.loss), unit, icons)}</div></div>`;
  const extra = listCss(unit.rowH) + `
.sm{left:64px;top:850px;width:1792px;height:196px;padding:26px 40px 22px 250px}
.sm .ico{position:absolute;left:40px;top:28px;width:170px;height:136px;border-radius:28px;background:linear-gradient(135deg,var(--a3),var(--a2));display:flex;align-items:center;justify-content:center;font-size:84px;border:5px solid #fff}
.sm .mo{position:absolute;right:36px;bottom:-26px;font-size:26px}
.sm .ai{height:136px}`;
  const body = `${twoTone('RTP失分監控', `${span(f)}數據對比 Top5`, 30, 92)}
${sub('<span class="emo">💗</span>依遊戲淨利失分排序，單位：萬<span class="emo">💗</span>', 160, 30)}
${col(64, f.prev.label, f.rtp.prev, 'b2')}${col(980, f.month.label, f.rtp.cur, 'b3')}
<div class="card sm"><div class="ico emo">🛡️</div>${ai(ins.rtp.summary, 30)}<div class="mo"><span class="pill" style="font-size:26px"><span class="emo">📅</span>統計月份：${f.prev.label} vs ${f.month.label}${f.month.full ? '' : `（${f.month.range}）`}</span></div></div>`;
  return page(t, bg, body, extra);
}

// ---------------- strategy / insight page (slide 25) ----------------
export function strategy(t, bg, f, ins) {
  const s = ins.strategy;
  const extra = `
.sc{width:880px;height:330px;padding:96px 34px 20px}
.sc .no{position:absolute;left:28px;top:22px;width:92px;height:62px;border-radius:20px;color:#fff;font-size:38px;display:flex;align-items:center;justify-content:center;border:4px solid #fff;box-shadow:0 6px 14px rgba(120,70,160,.25)}
.sc .h{position:absolute;left:138px;right:30px;top:20px;height:68px}
.sc .h .ai.ph{padding:6px 14px 6px 150px}
.sc .h .ai-tag{top:16px}
.sc ul{list-style:none;display:flex;flex-direction:column;gap:10px;height:100%}
.sc li{flex:1;display:flex;gap:14px;align-items:stretch}
.sc li::before{content:'';flex:none;width:16px;height:16px;margin-top:14px;border-radius:50%;background:var(--a1);box-shadow:0 0 0 5px var(--a1l)}
.sc li .ai{flex:1}
.sc li .ai.ph{padding:6px 14px 6px 150px}
.sc li .ai-tag{top:8px}
.bn{position:absolute;left:260px;right:260px;top:958px;height:92px;border-radius:999px;background:linear-gradient(90deg,var(--a2),var(--a1),var(--a2));border:5px solid #fff;box-shadow:0 10px 24px rgba(120,70,160,.25);padding:10px 40px}
.bn .ai .fit{color:#fff;font-weight:700;text-align:center}
.bn .ai.ph{padding:8px 14px 8px 160px;background:rgba(255,255,255,.88)}
.bn .ai.ph .fit{color:var(--soft)}`;
  const pos = [[64, 214], [976, 214], [64, 590], [976, 590]];
  const cards = s.cards.slice(0, 4).map((c, i) => `<div class="card sc" style="left:${pos[i][0]}px;top:${pos[i][1]}px">
<div class="no num" style="background:linear-gradient(135deg,${[t.a1, t.a2, t.a3, t.gold][i]},${[t.a2, t.a3, t.a1, t.a1][i]})">0${i + 1}</div>
<div class="h">${ai(c.title, 38)}</div>
<ul>${(c.bullets || []).slice(0, 3).map((b) => `<li>${ai(b, 26)}</li>`).join('')}</ul></div>`).join('');
  const body = `${title(s.title?.text || '社群戰略', 30, 120)}${cards}<div class="bn">${ai(s.banner, 36)}</div>`;
  return page(t, bg, body, extra);
}

export const TEMPLATES = {cover, kpi, tiers, machines, rtp, strategy};
