import { readJson, writeJsonAtomic } from './util.js';

/** JSON-file backed store. persist=false keeps it in memory only (dry runs / tests). */
export class JsonStore {
  constructor(file, defaults, { persist = true } = {}) {
    this.file = file;
    this.persist = persist && Boolean(file);
    this.data = file ? readJson(file, defaults) : structuredClone(defaults);
    for (const [k, v] of Object.entries(defaults)) if (this.data[k] === undefined) this.data[k] = structuredClone(v);
  }
  save() {
    if (this.persist) writeJsonAtomic(this.file, this.data);
  }
}

const DAY = 86400e3;

/** 出金通知 state: days[date][brand]["from:to"] = last notified amounts; brands[brand] = counters / dealer AIDs. */
export class CashoutStore extends JsonStore {
  constructor(file, opts) { super(file, { days: {}, brands: {} }, opts); }
}

/** Per-brand scan state: window cursor, big-win dedupe ids, failure counters. */
export class BrandStateStore extends JsonStore {
  constructor(file, opts) { super(file, { brands: {} }, opts); }
  brand(key) {
    this.data.brands[key] ||= { lastSuccessStop: null, seen: {}, consecutiveFailures: 0, loginFailures: 0, lastLoginAlertAt: null, lastFailureAlertAt: null };
    const b = this.data.brands[key];
    b.seen ||= {};
    return b;
  }
}

/**
 * Alert records keyed by a short id (callback_data must be <= 64 bytes).
 * published: brand|betKey -> { id, at } guarantees one community post per bet, ever (retention 30 days).
 */
export class AlertStore extends JsonStore {
  constructor(file, opts) { super(file, { seq: 0, alerts: {}, published: {} }, opts); }
  nextId() {
    this.data.seq += 1;
    return this.data.seq.toString(36);
  }
  get(id) { return this.data.alerts[id] || null; }
  put(record) { this.data.alerts[record.id] = record; this.save(); return record; }
  update(id, patch) {
    const rec = this.data.alerts[id];
    if (!rec) return null;
    Object.assign(rec, patch, { updatedAt: Date.now() });
    this.save();
    return rec;
  }
  publishedKey(brand, betKey) { return `${brand}|${betKey}`; }
  getPublished(brand, betKey) { return this.data.published[this.publishedKey(brand, betKey)] || null; }
  markPublished(brand, betKey, value) { this.data.published[this.publishedKey(brand, betKey)] = { ...value, at: Date.now() }; this.save(); }
  hasBet(brand, betKey) { return Object.values(this.data.alerts).some((a) => a.brand === brand && a.betKey === betKey); }
  unsent() { return Object.values(this.data.alerts).filter((a) => a.status === 'unsent'); }
  prune(now = Date.now(), { alertDays = 14, publishedDays = 30 } = {}) {
    let removed = 0;
    for (const [id, a] of Object.entries(this.data.alerts)) {
      if (now - (a.createdAt || 0) > alertDays * DAY && a.status !== 'publishing') { delete this.data.alerts[id]; removed++; }
    }
    for (const [k, v] of Object.entries(this.data.published)) {
      if (now - (v.at || 0) > publishedDays * DAY) { delete this.data.published[k]; removed++; }
    }
    if (removed) this.save();
    return removed;
  }
}
