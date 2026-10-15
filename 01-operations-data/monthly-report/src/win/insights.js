import {fmtInt} from '../util.js';

// 贏麻了 insight blocks. Same hook as 爽爆/茄子: insights-win.json (if present) or generateInsights()
// fills these; otherwise each block shows 〔AI 洞察・待填〕 with a factual draft written by code.
export const WIN_SCHEMA = {
  summary: {insight: '核心洞察（2-3 句）'},
  channel: {insight: '渠道核心洞察（2 句）'},
  activity: {dau: 'DAU 解讀（1-2 句）', arppu: 'ARPPU 解讀（1-2 句）'},
  winners: {analysis: '贏錢排行核心分析（3-4 點）', observe: '觀察（1 句）'},
  bleed: {insight: '失血來源核心分析（2-3 句）', watch: '觀察（1 句）', focus: '重點（1 句）'},
  vip: {notes: 'VIP 儲值動能觀察（2-3 句）'},
  vipInsight: {head: '頭部效應（1-2 句）', core: '核心大戶留存（1-2 句）'},
  payers: {headline: '標題第二行（12 字內）', conclusion: '結論（1-2 句）', cause: '主因（短句）', cause2: '次因（短句）', focus: '營運重點（短句）'},
  vipDrive: {headline: '標題後半（8 字內）', conclusion: '核心結論（1-2 句）', cause: '主因（短句）', watch: '觀察（短句）', focus: '重點（短句）'},
  bets: {text: '投注量 Top5 解讀（2 句）'},
  rtp: {text: 'RTP 失分解讀（2 句）'},
  machineInsight: {aTitle: '洞察一標題', a: '洞察一（2 句）', bTitle: '洞察二標題', b: '洞察二（2 句）'},
  strategy: {title: '戰略收斂標題（10 字內）', cards: [{title: '策略標題', text: '做法（1-2 句）'}]},
};

const I = (n) => fmtInt(n);
const P = (x) => `${(x * 100).toFixed(1)}%`;
const dir = (c, p) => (c > p ? '上升' : c < p ? '下降' : '持平');

export function winDraft(f) {
  const ph = (text) => ({text, placeholder: true});
  const fix = (text) => ({text, placeholder: false});
  const A = f.prev.label, B = f.month.label, k = f.kpi, w = f.winners, v = f.vip, p = f.payers, m = f.machines;
  const fld = m.field, w1 = (n) => (n / 1e4).toFixed(1), wi = (n) => I(n / 1e4);
  const sum = (a, g) => a.reduce((s, r) => s + g(r), 0);
  const c = f.channel;
  return {
    summary: {insight: ph(`平均 DAU 由 ${I(k.dau.prev)} ${dir(k.dau.cur, k.dau.prev)}至 ${I(k.dau.cur)}，平均新增由 ${f.nu.prev.toFixed(2)} ${dir(f.nu.cur, f.nu.prev)}至 ${f.nu.cur.toFixed(2)}；日均儲值 ${I(f.dailyRevenue.prev)} → ${I(f.dailyRevenue.cur)}。`)},
    channel: {insight: ph(c.cur?.total && c.prev?.total ? `${B}新增 ${I(c.cur.total.reg)} 人（${A} ${I(c.prev.total.reg)}），渠道儲值 ${I(c.prev.total.amount)} → ${I(c.cur.total.amount)}；${c.cards[0] ? `${c.cards[0].name} 貢獻最高（${I(c.cards[0].amount)}）。` : ''}` : '渠道資料待試算表更新。')},
    activity: {
      dau: ph(`DAU 由 ${A} ${I(k.dau.prev)} ${dir(k.dau.cur, k.dau.prev)}至 ${B} ${I(k.dau.cur)}。`),
      arppu: ph(`ARPPU 由 ${I(k.arppu.prev)} ${dir(k.arppu.cur, k.arppu.prev)}至 ${I(k.arppu.cur)}（日均 ARPPU 平均值）。`),
    },
    winners: {
      analysis: ph(w.top[0] ? `TOP1 ${w.top[0].nick} 淨贏 ${I(w.top[0].net)}；TOP10 合計 ${I(w.top10)}，全體 ${w.players} 人合計 ${I(w.total)}。` : `${B}沒有對幣商的贈禮紀錄。`),
      observe: ph('觀察重點（1 句）'),
    },
    bleed: {
      insight: ph(`玩家淨贏集中在 TOP10（${I(w.top10)}，占玩家贏錢 ${P(w.top10ShareOfWins)}）；其餘 ${w.restN} 人合計 ${I(w.rest)}。`),
      watch: ph('觀察（1 句）'), focus: ph('重點（1 句）'),
    },
    vip: {notes: ph(v.top[0] ? `${B}儲值榜首 ${v.top[0].nick} ${I(v.top[0].cur)}；TOP ${v.top.length} 占當月儲值 ${P(v.share.prev)} → ${P(v.share.cur)}。` : '')},
    vipInsight: {
      head: ph(`TOP ${v.top.length} 合計 ${I(v.topSum.prev)} → ${I(v.topSum.cur)}，占比 ${P(v.share.prev)} → ${P(v.share.cur)}。`),
      core: ph(`兩月 Top 10 重疊 ${v.overlap.length} 人${v.overlap.length ? `：${v.overlap.slice(0, 3).map((o) => o.nick).join('、')}` : ''}。`),
    },
    payers: {
      headline: ph('付費結構變化'),
      conclusion: ph(`付費人數 ${I(p.payers.prev)} → ${I(p.payers.cur)}，持續付費 ${I(p.both.n)} 人儲值 ${I(p.both.prev)} → ${I(p.both.cur)}。`),
      cause: ph('主因'), cause2: ph('次因'), focus: ph('營運重點'),
    },
    vipDrive: {
      headline: ph('營收支柱'),
      conclusion: ph(`持續付費 ${I(p.both.n)} 人貢獻 ${B}儲值 ${I(p.both.cur)}（占 ${P(p.revenue.cur ? p.both.cur / p.revenue.cur : 0)}）。`),
      cause: ph('主因'), watch: ph('觀察'), focus: ph('重點'),
    },
    bets: {text: ph(m.prev.topBet[0] && m.cur.topBet[0] ? `${A}由《${m.prev.topBet[0].game}》以 ${wi(m.prev.topBet[0][fld])} 萬居首，${B}由《${m.cur.topBet[0].game}》以 ${wi(m.cur.topBet[0][fld])} 萬居首；Top5 合計 ${wi(sum(m.prev.topBet, (r) => r[fld]))} 萬 → ${wi(sum(m.cur.topBet, (r) => r[fld]))} 萬。` : '')},
    rtp: {text: ph(m.prev.topLoss[0] && m.cur.topLoss[0] ? `${A}失分最高《${m.prev.topLoss[0].game}》${w1(m.prev.topLoss[0].loss)} 萬，${B}為《${m.cur.topLoss[0].game}》${w1(m.cur.topLoss[0].loss)} 萬；Top5 失分 ${w1(m.prev.top5Loss)} 萬 → ${w1(m.cur.top5Loss)} 萬。` : '')},
    machineInsight: {aTitle: fix('雙月核心機台'), a: ph('洞察一'), bTitle: fix('熱度輪替'), b: ph('洞察二')},
    strategy: {title: ph('聚焦成長與風險控管'), cards: [1, 2, 3, 4].map((i) => ({title: ph(`策略重點 ${i}`), text: ph('依本月數據撰寫做法')}))},
  };
}
