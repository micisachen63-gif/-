import {change} from './util.js';

export function buildFacts({key, brand, per, prevPer, kpi, tiers, machines, tiersCfg, sources}) {
  const tl = tiersCfg.map((t) => ({key: t.key, label: t.label, range: t.range,
    prev: tiers.prev.tiers[t.key], cur: tiers.cur.tiers[t.key]}));
  return {
    brand: {key, name: brand.name},
    month: {key: per.key, m: per.month.m, y: per.month.y, label: per.label, start: per.start, end: per.end, full: per.full, range: per.range},
    prev: {key: prevPer.key, m: prevPer.month.m, y: prevPer.month.y, label: prevPer.label, start: prevPer.start, end: prevPer.end, range: prevPer.range},
    kpi,
    tiers: {list: tl, total: {prev: tiers.prev.total, cur: tiers.cur.total,
      pct: change(tiers.cur.total.users, tiers.prev.total.users), amountPct: change(tiers.cur.total.amount, tiers.prev.total.amount)}},
    machines: {prev: machines.prev.topBet, cur: machines.cur.topBet},
    rtp: {prev: machines.prev.topLoss, cur: machines.cur.topLoss,
      top5: {prev: machines.prev.top5Loss, cur: machines.cur.top5Loss, pct: change(machines.cur.top5Loss, machines.prev.top5Loss)},
      allLoss: {prev: machines.prev.allLoss, cur: machines.cur.allLoss},
      concentration: {prev: machines.prev.concentration, cur: machines.cur.concentration}},
    sources,
  };
}
