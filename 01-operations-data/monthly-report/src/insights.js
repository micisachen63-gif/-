import fs from 'node:fs';
import path from 'node:path';
import {fmtKpi, fmtPct, fmtWan, writeJson, readJson} from './util.js';

// ===================== INSIGHT HOOK =====================
// IN : facts-<brand>.json  (every number the slides show, computed by code)
// OUT: insights-<brand>.json (text blocks below). If that file exists in the month folder it is
//      used as-is; otherwise every block is filled with a clearly marked placeholder
//      (〔AI 待填〕 + a plain factual draft written by code).
// Stage 2 plugs a small AI call into generateInsights(); stage 1 never calls any AI.
export const INSIGHT_SCHEMA = {
  kpi: {status: '平台現況（2-3 句）', strategy: '活躍維持策略（2-3 句）', effect: '成效（2-3 句）'},
  tiers: {points: ['重點觀察 1', '重點觀察 2', '重點觀察 3']},
  rtp: {summary: '（可省略；省略時由程式依數據產生）'},
  strategy: {title: '社群戰略', cards: [{title: '標題', bullets: ['重點', '重點', '重點']}], banner: '一句總結'},
};

/** Stage-2 extension point: return an object shaped like INSIGHT_SCHEMA, or null. */
export async function generateInsights(_facts, _schema) { return null; }

const dir = (p) => (p == null ? '持平' : p > 0 ? '上升' : p < 0 ? '下降' : '持平');
const pctTxt = (p) => (p == null ? '—' : fmtPct(Math.abs(p)));

function placeholders(f) {
  const P = f.prev.label, C = f.month.label, k = f.kpi;
  const t = f.tiers, tl = t.list;
  const ph = (text) => ({text, placeholder: true});
  return {
    kpi: {
      status: ph(`${C}相較${P}，DAU ${dir(k.dau.pct)} ${pctTxt(k.dau.pct)}、NU ${dir(k.nu.pct)} ${pctTxt(k.nu.pct)}、玩家儲值 ${dir(k.revenue.pct)} ${pctTxt(k.revenue.pct)}、ARPPU ${dir(k.arppu.pct)} ${pctTxt(k.arppu.pct)}。`),
      strategy: ph('依本月數據撰寫活躍維持策略（例如：新增導流、首儲轉化、分層活動與回流任務）。'),
      effect: ph('依本月數據撰寫整體成效與趨勢判讀。'),
    },
    tiers: {
      points: [
        ph(`${C}整體儲值用戶由 ${fmtKpi(t.total.prev.users)} 人${dir(t.total.pct)}至 ${fmtKpi(t.total.cur.users)} 人，儲值總額由 ${fmtKpi(t.total.prev.amount)} ${dir(t.total.amountPct)}至 ${fmtKpi(t.total.cur.amount)}。`),
        ph(`${tl[0].label}由 ${tl[0].prev.users} 人變為 ${tl[0].cur.users} 人，貢獻占比由 ${fmtPct(tl[0].prev.share)} 變為 ${fmtPct(tl[0].cur.share)}。`),
        ph('依分層變化撰寫經營建議。'),
      ],
    },
    rtp: {summary: {text: rtpSummary(f), placeholder: false}},
    strategy: {
      title: {text: '社群戰略', placeholder: false},
      cards: [1, 2, 3, 4].map((i) => ({title: ph(`策略重點 ${i}`), bullets: [ph('依本月營運狀況撰寫重點'), ph('具體做法或活動'), ph('預期效果與追蹤指標')]})),
      banner: ph('本月策略總結（一句話）'),
    },
  };
}

/** Deterministic, number-only summary for the RTP page (no opinions). */
export function rtpSummary(f) {
  const r = f.rtp, P = f.prev.label, C = f.month.label;
  if (!r.prev.length || !r.cur.length) return '本月沒有失分機台。';
  const p = r.top5.pct;
  return `${P}由《${r.prev[0].game}》失分最高；${C}則由《${r.cur[0].game}》居首。` +
    `Top5 RTP 失分總額由 ${fmtWan(r.top5.prev)} 萬${dir(p) === '持平' ? '持平於' : (p < 0 ? '降至' : '升至')} ${fmtWan(r.top5.cur)} 萬，${dir(p)} ${pctTxt(p)}；` +
    `集中度（Top5 占全部失分機台）由 ${fmtPct(r.concentration.prev)} ${r.concentration.cur < r.concentration.prev ? '降至' : '升至'} ${fmtPct(r.concentration.cur)}。`;
}

const wrap = (v) => (v && typeof v === 'object' && 'text' in v ? v : {text: String(v ?? ''), placeholder: false});

function merge(base, given) {
  if (given == null) return base;
  if (Array.isArray(base)) return base.map((b, i) => merge(b, Array.isArray(given) ? given[i] : undefined));
  if (base && typeof base === 'object' && !('text' in base)) {
    const out = {};
    for (const k of Object.keys(base)) out[k] = merge(base[k], given[k]);
    if (Array.isArray(given?.cards) && base.cards) out.cards = given.cards.slice(0, 4).map((c, i) => merge(base.cards[i] || base.cards[0], c));
    return out;
  }
  return typeof given === 'string' || typeof given === 'object' ? wrap(given) : base;
}

export async function getInsights(monthDir, brandKey, facts, {schema = INSIGHT_SCHEMA, draft = placeholders} = {}) {
  writeJson(path.join(monthDir, `facts-${brandKey}.json`), facts);
  writeJson(path.join(monthDir, `insights-request-${brandKey}.json`), {
    說明: '把 facts 交給 AI，請它依 schema 回傳 JSON，存成同資料夾的 insights-' + brandKey + '.json，再重跑 build。',
    schema, facts,
  });
  const file = path.join(monthDir, `insights-${brandKey}.json`);
  const base = draft(facts);
  const given = fs.existsSync(file) ? readJson(file) : await generateInsights(facts, schema);
  return merge(base, given);
}
