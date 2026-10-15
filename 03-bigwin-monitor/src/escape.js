// 🚪 密室逃脫 (group game): pure helpers — script loading + validation (incl. a solvability simulation), answer matching, texts and keyboards. No Telegram I/O here.
import fs from 'node:fs';

export const ES_MAX_PLAYERS = 10;
export const ES_MIN_PLAYERS = 1; // the initiator can play alone
export const ES_LOBBY_CANCEL_MS = 5 * 60e3; // initiator alone and never pressed start → 流局
export const ES_LOBBY_AUTOSTART_MS = 10 * 60e3; // players joined but the initiator never pressed start → auto start
export const ES_GAME_MS = 30 * 60e3; // per run; a saved game keeps its remaining time
export const ES_HINT_STUCK_MS = 5 * 60e3; // (unused since 2026-10-04: 💡 求救 no longer waits for 5 min stuck; kept for old imports)
export const ES_HINT_TAP_MS = 5e3; // 💡 求救 double-tap guard: two presses within 5 s give one hint
export const ES_MAX_HINTS = 3; // per game
export const ES_IDLE_SAVE_MS = 15 * 60e3; // no button / answer for 15 min → auto save + pause
export const ES_WARN_AT = [10, 5, 1]; // minutes left → a short warning message
export const ES_MAX_CODE_LEN = 40; // longer replies are chatter, not a code attempt
export const ES_CAPTION_MAX = 1024;
export const ES_TEXT_MAX = 4000;
export const ID_RE = /^[a-z0-9_]{1,12}$/;
export const SCRIPT_ID_RE = /^[a-z0-9_]{1,16}$/;
export const IMAGE_FILE_RE = /^[A-Za-z0-9_.-]{1,60}\.(?:jpe?g|png)$/i;
export const LOCK_FORMATS = ['digits', 'numbers', 'text'];
// ---------- 10-level (version 2) scripts: assets/escape/scripts10/<id>.json overrides scripts/<id>.json on 小精靈 ----------
export const ES_PENALTY_COOLDOWN_MS = 15e3; // wrong answers within 15 s of the last penalty don't stack (a whole group typing at once)
export const ES_PENALTY_FLOOR_MS = 60e3; // a time penalty never leaves less than 1 minute
export const isV2 = (s) => Number(s?.version) >= 2;
export const unitOf = (s) => (isV2(s) ? '關' : '房');
export const levelsOf = (s) => s.levels || s.rooms.length;
export const gameMs = (s) => (s?.minutes ? s.minutes * 60e3 : ES_GAME_MS);
export const maxHintsOf = (s) => s?.maxHints || ES_MAX_HINTS;
export const levelNo = (g) => (Array.isArray(g.path) && g.path.length ? g.path.length : g.room + 1);
const TOKEN_RE = /\{\{([a-z0-9_]+)(?:\.([a-z0-9_]+))?\}\}/g;
/** Per-game random values: { digits: n, noZero? } → a fresh n-digit code (all digit vars of a game differ), { int: [min, max] }, { pick: [...] } → index of one option (strings or objects with the same fields), { sum: [vars], add? } → derived total. */
export function rollVars(s, random = Math.random) {
  const out = {}; const used = new Set();
  for (const [k, v] of Object.entries(s.vars || {})) {
    if (v.digits) {
      let x = ''; for (let i = 0; i < 40 && (!x || used.has(x)); i++) x = Array.from({ length: v.digits }, (_, j) => (j === 0 && v.noZero ? 1 + Math.floor(random() * 9) : Math.floor(random() * 10))).join('');
      while (used.has(x)) x = String((Number(x) + 1) % 10 ** v.digits).padStart(v.digits, '0'); // deterministic fallback
      used.add(x); out[k] = x;
    } else if (v.int) { const [lo, hi] = v.int; out[k] = String(lo + Math.min(hi - lo, Math.floor(random() * (hi - lo + 1)))); }
    else if (v.pick) out[k] = Math.min(v.pick.length - 1, Math.floor(random() * v.pick.length));
  }
  for (const [k, v] of Object.entries(s.vars || {})) if (v.sum) out[k] = String(v.sum.reduce((a, x) => a + Number(out[x] || 0), Number(v.add || 0))); // derived: e.g. nails counted over three X-rays + a bed number
  return out;
}
/** {{code}} / {{pick.field}} → this game's value (pick options may themselves use digits / int vars). Unknown tokens stay as they are. */
export function fillText(text, s, vars) {
  return String(text).replace(TOKEN_RE, (m, k, sub) => {
    const def = s.vars?.[k]; if (!def || vars?.[k] == null) return m;
    if (!def.pick) return String(vars[k]);
    const opt = def.pick[vars[k]] ?? def.pick[0]; const v = sub ? opt?.[sub] : opt;
    return typeof v === 'string' ? fillText(v, s, vars) : m;
  });
}
/** The script as this game sees it: every string with {{…}} filled in (the vars table itself is kept as is). */
export function fillScript(s, vars) {
  if (!s?.vars || !vars) return s;
  const walk = (v, key) => (key === 'vars' ? v : typeof v === 'string' ? (v.includes('{{') ? fillText(v, s, vars) : v)
    : Array.isArray(v) ? v.map((x) => walk(x)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)])) : v);
  return walk(s);
}
/** Next room indexes after room ri is solved: branch options, an explicit next, or simply the following room ([] = escape). */
export function nextRooms(s, ri) {
  const r = s.rooms[ri]; const at = (id) => s.rooms.findIndex((x) => x.id === id);
  if (r.branch) return r.branch.options.map((o) => at(o.to));
  if (r.next) return [at(r.next)];
  if (r.end) return [];
  return ri + 1 < s.rooms.length ? [ri + 1] : [];
}
/** Every possible route through the script (room indexes; -1 = loops back or points nowhere). */
export function roomPaths(s, max = 64) {
  const out = [];
  const walk = (p) => {
    if (out.length > max) return;
    const nx = nextRooms(s, p.at(-1)); if (!nx.length) { out.push(p); return; }
    for (const n of nx) { if (n < 0 || p.includes(n)) out.push([...p, -1]); else walk([...p, n]); }
  };
  walk([0]); return out;
}

export const userName = (u = {}) => String([u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : '') || `玩家${String(u.id ?? '').slice(-4)}`).slice(0, 24);
export const isEscapeStart = (text, botUsername = '') => {
  const t = String(text || '').trim();
  if (t === '密室逃脫' || t === '🚪 密室逃脫') return true;
  const m = /^\/escape(?:@([A-Za-z0-9_]+))?(?:\s|$)/i.exec(t);
  return Boolean(m && (!m[1] || !botUsername || m[1].toLowerCase() === String(botUsername).toLowerCase()));
};
export const isCodeText = (t) => /^(?:密碼|答案)\s*[:：]/.test(String(t || '').trim());
export const stripCode = (t) => String(t || '').trim().replace(/^(?:密碼|答案)\s*[:：]\s*/, '').trim();
export const stars = (d) => '★'.repeat(d) + '☆'.repeat(Math.max(0, 3 - d));
export const ghosts = (h) => '👻'.repeat(h);
export const hhmm = (ms) => { const d = new Date(ms + 8 * 3600e3); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
export const minutesLeft = (ms) => Math.max(0, Math.ceil(ms / 60e3));
export const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`; };

// ---------- answers ----------
/** digits: keep 0-9 only (full-width ok) · numbers: the list of numbers joined by "-" (「4 2 6 10」→ 4-2-6-10) · text: no spaces / punctuation / symbols, lower case. */
export function normalizeAnswer(raw, format = 'digits') {
  const s = String(raw ?? '').normalize('NFKC').trim().toLowerCase();
  if (format === 'digits') return s.replace(/[^0-9]/g, '');
  if (format === 'numbers') return (s.match(/\d+/g) || []).map((x) => String(Number(x))).join('-');
  return s.replace(/[\s\p{P}\p{S}]/gu, '');
}
export function checkAnswer(lock, raw) {
  const got = normalizeAnswer(raw, lock.format);
  if (!got) return false;
  return lock.answers.some((a) => { const want = normalizeAnswer(a, lock.format); return want && (got === want || (lock.match === 'contains' && got.includes(want) && got.length <= want.length + 8)); });
}

// ---------- scripts ----------
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const arr = (v) => (Array.isArray(v) ? v : []);
/** Validate one script; returns a list of problems (empty = OK). Includes a play-through simulation: every lock's needed clues/items must be obtainable in time, every non-trap spot must be openable. */
export function validateScript(s, { fileId = null } = {}) {
  const errs = []; const e = (m) => errs.push(`${s?.id || fileId || '?'}: ${m}`);
  if (!s || typeof s !== 'object') return ['script is not an object'];
  if (!SCRIPT_ID_RE.test(String(s.id))) e('id must match [a-z0-9_]{1,16}');
  if (fileId != null && s.id !== fileId) e(`id "${s.id}" must equal the file name "${fileId}"`);
  for (const [k, max] of [['title', 12], ['emoji', 8], ['setting', 40], ['blurb', 60], ['gimmick', 60], ['intro', 700]]) if (!str(s[k], max)) e(`${k} missing or longer than ${max}`);
  if (!Number.isInteger(s.difficulty) || s.difficulty < 1 || s.difficulty > 3) e('difficulty must be 1–3');
  if (!Number.isInteger(s.horror) || s.horror < 1 || s.horror > 5) e('horror must be 1–5');
  const images = s.images && typeof s.images === 'object' ? s.images : {}; if (!s.images) e('images missing');
  for (const [k, f] of Object.entries(images)) { if (!ID_RE.test(k)) e(`image key "${k}" invalid`); if (!IMAGE_FILE_RE.test(String(f))) e(`image file "${f}" invalid`); }
  for (const k of ['cover', 'good_end', 'bad_end']) if (!images[k]) e(`images.${k} missing`);
  const img = (k, where) => { if (k != null && !images[k]) e(`${where}: image "${k}" not in images`); };
  const items = s.items && typeof s.items === 'object' ? s.items : {}; const clues = s.clues && typeof s.clues === 'object' ? s.clues : {};
  for (const [id, it] of Object.entries(items)) { if (!ID_RE.test(id)) e(`item id "${id}" invalid`); if (!str(it?.name, 12) || !str(it?.emoji, 8) || !str(it?.desc, 200)) e(`item ${id}: name/emoji/desc`); }
  for (const [id, c] of Object.entries(clues)) { if (!ID_RE.test(id)) e(`clue id "${id}" invalid`); if (!str(c?.title, 20) || !str(c?.text, 600)) e(`clue ${id}: title/text`); img(c?.image, `clue ${id}`); }
  const endings = s.endings && typeof s.endings === 'object' ? s.endings : {};
  for (const k of ['good', 'bad']) if (!endings[k]) e(`endings.${k} missing`);
  for (const [id, en] of Object.entries(endings)) { if (!ID_RE.test(id)) e(`ending id "${id}" invalid`); if (!str(en?.title, 30) || !str(en?.text, 700)) e(`ending ${id}: title/text`); img(en?.image, `ending ${id}`); }
  const v2 = isV2(s);
  if (s.version != null && ![1, 2].includes(s.version)) e('version must be 1 or 2');
  if (s.minutes != null && !(Number.isInteger(s.minutes) && s.minutes >= 15 && s.minutes <= 90)) e('minutes must be 15–90');
  if (s.maxHints != null && !(Number.isInteger(s.maxHints) && s.maxHints >= 1 && s.maxHints <= 10)) e('maxHints must be 1–10');
  const rooms = arr(s.rooms);
  if (!v2 && (rooms.length < 3 || rooms.length > 4)) e('rooms must be 3–4');
  if (v2) { if (!Number.isInteger(s.levels) || s.levels < 5 || s.levels > 12) e('levels must be 5–12'); else if (rooms.length < s.levels || rooms.length > s.levels + 4) e('rooms must be levels … levels + 4 (branches)'); }
  checkTemplates(s, e);
  const roomIds = new Set(); const given = { items: new Set(), clues: new Set() }; const usedEndings = new Set();
  const checkGain = (o, where) => {
    for (const x of arr(o?.gives)) { if (!items[x]) e(`${where}: gives unknown item "${x}"`); given.items.add(x); }
    for (const x of arr(o?.clues)) { if (!clues[x]) e(`${where}: unknown clue "${x}"`); given.clues.add(x); }
    img(o?.image, where);
  };
  if (s.combos != null && !Array.isArray(s.combos)) e('combos must be a list');
  const pairs = new Set();
  for (const [i, c] of arr(s.combos).entries()) {
    const w = `combo ${i + 1}`;
    if (!items[c?.a] || !items[c?.b] || c.a === c.b) e(`${w}: a / b must be two different known items`);
    const key = [c?.a, c?.b].sort().join('+'); if (pairs.has(key)) e(`${w}: duplicate pair`); pairs.add(key);
    if (!c?.makes && !arr(c?.clues).length) e(`${w}: makes or clues missing`);
    if (c?.makes != null && !items[c.makes]) e(`${w}: makes unknown item "${c.makes}"`);
    if (!str(c?.text, 360)) e(`${w}: text missing or > 360`);
    checkGain({ gives: c?.makes ? [c.makes] : [], clues: c?.clues, image: c?.image }, w);
  }
  const checkPenalty = (p, where, spots) => {
    if (!p || typeof p !== 'object') { e(`${where}: penalty must be an object`); return; }
    if (p.seconds != null && !(Number.isInteger(p.seconds) && p.seconds >= 10 && p.seconds <= 300)) e(`${where}: penalty.seconds must be 10–300`);
    if (p.hide != null && (!Array.isArray(p.hide) || p.hide.some((x) => !spots.some((sp) => sp?.id === x && !sp.trap)))) e(`${where}: penalty.hide must list non-trap spots of this room`);
    if (p.hideSeconds != null && !(Number.isInteger(p.hideSeconds) && p.hideSeconds >= 30 && p.hideSeconds <= 600)) e(`${where}: penalty.hideSeconds must be 30–600`);
    if (p.text != null && !str(p.text, 200)) e(`${where}: penalty.text`);
    if (!p.seconds && !arr(p.hide).length) e(`${where}: penalty needs seconds or hide`);
  };
  for (const [ri, r] of rooms.entries()) {
    const w = `room ${ri + 1}`;
    if (!ID_RE.test(String(r?.id)) || roomIds.has(r?.id)) e(`${w}: id invalid or duplicate`); roomIds.add(r?.id);
    if (!str(r?.name, 12)) e(`${w}: name`); if (!str(r?.description, 380)) e(`${w}: description missing or > 380`);
    if (!r?.image) { if (!v2) e(`${w}: image key missing`); } else img(r.image, w); // 10-level scripts may have text-only levels
    const spots = arr(r?.spots); if (v2 ? spots.length < 2 || spots.length > 6 : spots.length < 3 || spots.length > 5) e(`${w}: needs ${v2 ? '2–6' : '3–5'} spots`);
    const spotIds = new Set();
    for (const sp of spots) {
      const sw = `${w} spot ${sp?.id}`;
      if (!ID_RE.test(String(sp?.id)) || spotIds.has(sp?.id)) e(`${sw}: id invalid or duplicate`); spotIds.add(sp?.id);
      if (!str(sp?.label, 14)) e(`${sw}: label missing or > 14`);
      if (sp.trap) {
        if (!str(sp.trap.confirm, 300) || !str(sp.trap.yes, 12)) e(`${sw}: trap needs confirm + yes`);
        if (sp.trap.penalty) { // a non-fatal trap: time loss / a spot sealed for a while
          if (sp.trap.ending != null) e(`${sw}: a trap has an ending or a penalty, not both`);
          if (!str(sp.trap.text, 360)) e(`${sw}: a penalty trap needs text`);
          checkPenalty(sp.trap.penalty, sw, spots); img(sp.trap.image, sw);
        } else { if (!endings[sp.trap.ending] || sp.trap.ending === 'good') e(`${sw}: trap ending "${sp.trap.ending}" missing`); usedEndings.add(sp.trap.ending); }
        if (sp.gives || sp.clues || sp.uses || sp.locked) e(`${sw}: a trap spot cannot give or be locked`);
        continue;
      }
      if (sp.locked) {
        if (!items[sp.locked.item]) e(`${sw}: locked by unknown item "${sp.locked.item}"`);
        if (!str(sp.locked.text, 300)) e(`${sw}: locked.text`);
        if (!sp.uses?.[sp.locked.item]) e(`${sw}: uses.${sp.locked.item} (the unlock outcome) missing`);
        if (Object.keys(sp.uses || {}).some((k) => k !== sp.locked.item)) e(`${sw}: a locked spot only accepts its own item`);
        if (sp.gives || sp.clues) e(`${sw}: a locked spot gives through uses.${sp.locked.item}`);
      } else if (!str(sp.text, 360)) e(`${sw}: text missing or > 360`);
      if (sp.again != null && !str(sp.again, 200)) e(`${sw}: again`);
      checkGain(sp, sw);
      for (const [itemId, o] of Object.entries(sp.uses || {})) { if (!items[itemId]) e(`${sw}: uses unknown item "${itemId}"`); if (!str(o?.text, 360)) e(`${sw}: uses.${itemId}.text`); checkGain(o, `${sw} uses ${itemId}`); }
    }
    const lock = r?.lock;
    if (!lock) { e(`${w}: lock missing`); continue; }
    if (!str(lock.prompt, 120) || !str(lock.solved, 300) || !str(lock.example, 20)) e(`${w}: lock prompt/solved/example`);
    if (!LOCK_FORMATS.includes(lock.format)) e(`${w}: lock.format must be ${LOCK_FORMATS.join('/')}`);
    if (lock.match != null && !['exact', 'contains'].includes(lock.match)) e(`${w}: lock.match`);
    const tpl = (a) => String(a).includes('{{'); // per-game answers are checked for every variant below
    if (!arr(lock.answers).length || arr(lock.answers).some((a) => !tpl(a) && !normalizeAnswer(a, lock.format))) e(`${w}: lock.answers empty or not matching the format`);
    if (lock.answers?.length && !lock.answers.some(tpl) && checkAnswer(lock, lock.example)) e(`${w}: the example must not be the answer`);
    if (lock.penalty != null) checkPenalty(lock.penalty, `${w} lock`, spots);
    for (const n of arr(lock.needs)) if (clues[n]?.herring) e(`${w}: lock.needs uses the red herring "${n}"`);
    if (!arr(lock.needs).length) e(`${w}: lock.needs (the clues/items the answer is derived from) missing`);
    for (const n of arr(lock.needs)) if (!clues[n] && !items[n]) e(`${w}: lock.needs unknown "${n}"`);
    const hintStr = (h) => (typeof h === 'string' ? h : h && typeof h === 'object' && !Array.isArray(h) ? h.text : null); // "text" or { text, done: [ids] }
    if (v2 ? arr(r.hints).length < 2 || arr(r.hints).length > 3 || r.hints.some((h) => !str(hintStr(h), 200)) : arr(r.hints).length !== 3 || r.hints.some((h) => !str(hintStr(h), 200))) e(`${w}: ${v2 ? '2–3' : 'exactly 3'} hints`);
    for (const h of arr(r.hints)) if (h && typeof h === 'object' && h.done != null) { // done: skip this hint once the team has all of these (clue / item ids, or spot:<id> of this room)
      if (!Array.isArray(h.done) || !h.done.length) e(`${w}: hint.done must be a non-empty list`);
      else for (const d of h.done) if (!(clues[d] || items[d] || (/^spot:/.test(d) && spots.some((sp) => `spot:${sp?.id}` === d && !sp.trap)))) e(`${w}: hint.done "${d}" unknown`);
    }
    if (arr(r.hints).length && arr(r.hints).every((h) => h && typeof h === 'object' && h.done)) e(`${w}: the last-resort hint must not be skippable (one hint without done)`);
  }
  for (const [ri, r] of rooms.entries()) {
    const w = `room ${ri + 1}`;
    if ((r?.next != null || r?.branch != null || r?.end != null) && !v2) e(`${w}: next / branch / end need version 2`);
    if (r?.next != null && !roomIds.has(r.next)) e(`${w}: next "${r.next}" unknown`);
    if (r?.end != null && r.end !== true) e(`${w}: end must be true`);
    if (r?.branch != null) {
      const b = r.branch; if (r.next != null || r.end != null) e(`${w}: branch cannot be combined with next / end`);
      if (!str(b?.prompt, 200)) e(`${w}: branch.prompt`);
      const o = arr(b?.options); if (o.length < 2 || o.length > 3) e(`${w}: branch needs 2–3 options`);
      for (const x of o) { if (!roomIds.has(x?.to) || x?.to === r.id) e(`${w}: branch to "${x?.to}" unknown`); if (!str(x?.label, 14)) e(`${w}: branch label missing or > 14`); if (x?.desc != null && !str(x.desc, 80)) e(`${w}: branch desc > 80`); }
    }
  }
  for (const id of Object.keys(items)) if (!given.items.has(id)) e(`item ${id} is never given`);
  for (const id of Object.keys(clues)) if (!given.clues.has(id)) e(`clue ${id} is never given`);
  for (const id of Object.keys(endings)) if (!['good', 'bad'].includes(id) && !usedEndings.has(id)) e(`ending ${id} is never used`);
  if (s.wrongTexts != null && (!Array.isArray(s.wrongTexts) || s.wrongTexts.some((t) => !str(t, 120)))) e('wrongTexts');
  if (!errs.length && v2) { // routes: no loops, every room reachable, every route exactly `levels` long
    const paths = roomPaths(s);
    if (paths.length > 64) e('too many routes');
    else if (paths.some((p) => p.includes(-1))) e('a route loops back or points nowhere');
    else {
      const seen = new Set(paths.flat()); rooms.forEach((r, i) => { if (!seen.has(i)) e(`room ${i + 1} (${r.id}) is never reached`); });
      if (paths.some((p) => p.length !== s.levels)) e(`every route must be exactly ${s.levels} levels (got ${[...new Set(paths.map((p) => p.length))].join('/')})`);
    }
  }
  if (!errs.length) checkVariants(s, e);
  if (!errs.length) errs.push(...simulate(s).map((m) => `${s.id}: ${m}`));
  return errs;
}

function checkTemplates(s, e) {
  const vars = s.vars;
  if (vars != null) {
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) { e('vars must be an object'); return; }
    for (const [k, v] of Object.entries(vars)) {
      if (!ID_RE.test(k)) e(`var "${k}" invalid`);
      const kinds = ['digits', 'int', 'pick', 'sum'].filter((x) => v?.[x] != null);
      if (kinds.length !== 1) { e(`var ${k}: exactly one of digits / int / pick / sum`); continue; }
      if (v.sum != null && (!Array.isArray(v.sum) || !v.sum.length || v.sum.some((x) => !vars[x] || !(vars[x].digits || vars[x].int)) || (v.add != null && !Number.isInteger(v.add)))) e(`var ${k}: sum must list digits / int vars (add: integer)`);
      if (v.digits != null && !(Number.isInteger(v.digits) && v.digits >= 1 && v.digits <= 8)) e(`var ${k}: digits must be 1–8`);
      if (v.int != null && !(Array.isArray(v.int) && v.int.length === 2 && v.int.every(Number.isInteger) && v.int[0] < v.int[1])) e(`var ${k}: int must be [min, max]`);
      if (v.pick != null) {
        if (!Array.isArray(v.pick) || v.pick.length < 2) { e(`var ${k}: pick needs 2+ options`); continue; }
        const objs = v.pick.every((x) => x && typeof x === 'object' && !Array.isArray(x)); const strs = v.pick.every((x) => typeof x === 'string');
        if (!objs && !strs) e(`var ${k}: pick options must be all strings or all objects`);
        if (objs) { const keys = Object.keys(v.pick[0]).sort().join(); if (v.pick.some((x) => Object.keys(x).sort().join() !== keys || Object.values(x).some((y) => typeof y !== 'string'))) e(`var ${k}: every pick option needs the same string fields`); }
        for (const m of JSON.stringify(v.pick).matchAll(TOKEN_RE)) if (!vars[m[1]] || vars[m[1]].pick || m[2]) e(`var ${k}: a pick option may only use digits / int / sum vars (${m[0]})`);
      }
    }
  }
  const { vars: _vars, ...rest } = s; const body = JSON.stringify(rest);
  if (/\{\{(?![a-z0-9_]+(?:\.[a-z0-9_]+)?\}\})/.test(body)) e('malformed {{template}}');
  for (const m of body.matchAll(TOKEN_RE)) {
    const def = vars?.[m[1]]; if (!def) { e(`template ${m[0]} uses an unknown var`); continue; }
    const objs = Array.isArray(def.pick) && def.pick[0] && typeof def.pick[0] === 'object';
    if (objs ? !m[2] || !(m[2] in def.pick[0]) : m[2]) e(`template ${m[0]}: ${objs ? 'needs one of the pick fields' : 'this var has no fields'}`);
  }
}
/** every pick option at least once (plus random codes): each lock's answers must fit its format and the example must stay wrong */
function checkVariants(s, e) {
  if (!s.vars) return;
  const n = Math.max(1, ...Object.values(s.vars).filter((v) => v.pick).map((v) => v.pick.length));
  for (let i = 0; i < Math.max(n, 3); i++) {
    let seed = i * 7919 + 17; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const vars = rollVars(s, rnd); for (const [k, v] of Object.entries(s.vars)) if (v.pick) vars[k] = i % v.pick.length;
    const f = fillScript(s, vars);
    for (const [ri, r] of f.rooms.entries()) {
      const L = r.lock;
      if (arr(L.answers).some((a) => String(a).includes('{{') || !normalizeAnswer(a, L.format))) e(`room ${ri + 1} variant ${i + 1}: lock.answers not matching the format`);
      else if (checkAnswer(L, L.example)) e(`room ${ri + 1} variant ${i + 1}: the example must not be the answer`);
    }
  }
}

/** Greedy play-through of every route: in each room investigate everything (no traps), use every held item wherever it does something and make every possible combination, until nothing changes; then the lock's needs must be known. */
export function simulate(s) {
  const errs = new Set();
  for (const p of roomPaths(s)) {
    if (p.includes(-1)) { errs.add('a route loops back or points nowhere'); continue; }
    const inv = new Set(); const known = new Set(); const done = new Set(); const made = new Set();
    const gain = (o) => { for (const x of arr(o.gives)) { inv.add(x); known.add(x); } for (const x of arr(o.clues)) known.add(x); };
    for (const ri of p) {
      const r = s.rooms[ri];
      for (let changed = true; changed;) {
        changed = false;
        for (const sp of r.spots) {
          if (sp.trap) continue;
          if (!sp.locked && !done.has(`${ri}.${sp.id}`)) { done.add(`${ri}.${sp.id}`); gain(sp); changed = true; }
          for (const [itemId, o] of Object.entries(sp.uses || {})) {
            const k = `${ri}.${sp.id}.${itemId}`;
            if (inv.has(itemId) && !done.has(k)) { done.add(k); if (sp.locked) done.add(`${ri}.${sp.id}`); gain(o); if (o.consume) inv.delete(itemId); changed = true; }
          }
        }
        for (const [ci, c] of arr(s.combos).entries()) {
          if (made.has(ci) || !inv.has(c.a) || !inv.has(c.b)) continue;
          made.add(ci); if (!c.keep) { inv.delete(c.a); inv.delete(c.b); } gain({ gives: c.makes ? [c.makes] : [], clues: c.clues }); changed = true;
        }
      }
      for (const sp of r.spots) if (!sp.trap && !done.has(`${ri}.${sp.id}`)) errs.add(`room ${ri + 1} spot ${sp.id} can never be opened (item ${sp.locked?.item} not obtainable by then)`);
      const missing = r.lock.needs.filter((n) => !known.has(n));
      if (missing.length) errs.add(`room ${ri + 1} lock is unsolvable: ${missing.join(', ')} not obtainable before it`);
    }
  }
  return [...errs];
}

/** Read every assets/escape/scripts/*.json; invalid ones are skipped (reported in errors). Sorted by order, then id. */
export function loadScripts(dirUrl, { readdir = (u) => fs.readdirSync(u), readFile = (u) => fs.readFileSync(u, 'utf8'), optional = false } = {}) {
  const scripts = []; const errors = [];
  let files = [];
  try { files = readdir(dirUrl).filter((f) => /\.json$/i.test(f)).sort(); } catch (error) { if (!(optional && error?.code === 'ENOENT')) errors.push(`scripts folder unreadable: ${error.message}`); }
  for (const f of files) {
    const fileId = f.replace(/\.json$/i, '');
    try {
      const s = JSON.parse(readFile(new URL(f, dirUrl)));
      const problems = validateScript(s, { fileId });
      if (problems.length) errors.push(...problems); else scripts.push(s);
    } catch (error) { errors.push(`${f}: ${error.message}`); }
  }
  scripts.sort(byOrder);
  return { scripts, errors };
}
const byOrder = (a, b) => (a.order ?? 99) - (b.order ?? 99) || a.id.localeCompare(b.id);
/** 小精靈: scripts/ (3–4 rooms, shared with the community bot) + scripts10/ (10-level upgrades; same id replaces the old one). An invalid upgrade keeps the old script. */
export function loadAllScripts(assetDir, opts = {}) {
  const a = loadScripts(new URL('scripts/', assetDir), opts); const b = loadScripts(new URL('scripts10/', assetDir), { ...opts, optional: true });
  const map = new Map(a.scripts.map((s) => [s.id, s])); for (const s of b.scripts) map.set(s.id, s);
  return { scripts: [...map.values()].sort(byOrder), errors: [...a.errors, ...b.errors.map((m) => `scripts10/${m}`)], upgraded: b.scripts.map((s) => s.id) };
}

// ---------- lobby texts ----------
const levelTag = (s) => (isV2(s) ? `｜🆕${levelsOf(s)}關` : '');
export const scriptLabel = (s) => `${s.emoji} ${s.title}｜${stars(s.difficulty)}｜${ghosts(s.horror)}${levelTag(s)}`;
export const saveLabel = (sv) => `${sv.title}・第${sv.level ?? sv.room + 1}${sv.unit || '房'}`;
export function lobbyText(g, { script = null, save = null, scripts = [], t }) {
  const others = g.players.length - 1;
  const roster = g.players.map((p, i) => `${i + 1}. ${p.name}${i === 0 ? '（發起人）' : ''}`).join('\n');
  const lines = [`🚪 密室逃脫開局囉！\n${g.players[0].name} 發起了一局密室逃脫：全隊被困在恐怖的密室裡，一起調查、找道具、破解密碼，${script ? Math.round(gameMs(script) / 60e3) : 30} 分鐘內逃出去。\n🩸 內含血腥、驚悚描寫，膽小慎入。`];
  if (save) lines.push(`📼 這個群組有存檔：${save.emoji || ''}${save.title}・第 ${save.level ?? save.room + 1} ${save.unit || '房'}「${save.roomName}」（剩 ${minutesLeft(save.remainingMs)} 分）`);
  if (script) lines.push(`📖 劇本：${scriptLabel(script)}\n${script.blurb}${save ? '\n⚠️ 開新劇本會覆蓋舊存檔' : ''}`);
  else lines.push(save ? '📖 發起人可以「▶️ 繼續上次進度」，或「🆕 選新劇本」' : '📖 劇本：還沒選，發起人請按「📖 選劇本」');
  const pickFull = `📚 劇本一覽（發起人點選）\n${scripts.map((s) => `${scriptLabel(s)}\n　${s.blurb}`).join('\n')}`;
  if (g.view === 'pick') lines.push(pickFull);
  const full = g.players.length >= ES_MAX_PLAYERS;
  const timer = others === 0
    ? `⏳ 一個人也能玩：發起人選好劇本按開始就開局；${Math.max(1, minutesLeft(g.createdAt + ES_LOBBY_CANCEL_MS - t))} 分鐘內沒按開始、也沒有其他人加入就流局`
    : `⏳ 發起人選好後按開始；${Math.max(1, minutesLeft(g.createdAt + ES_LOBBY_AUTOSTART_MS - t))} 分鐘後自動開始`;
  lines.push(`👥 報名（${g.players.length}/${ES_MAX_PLAYERS}）${full ? '｜已額滿' : ''}\n${roster}`, timer);
  const out = lines.join('\n\n');
  // many scripts + a full roster with long names can outgrow a photo caption (1024) → list titles only (the buttons still show ★ / 👻)
  if (g.view !== 'pick' || out.length <= ES_CAPTION_MAX) return out;
  // too long → progressively shorter lists: blurbs without ★/👻 → one-line settings → titles only
  const head = '📚 劇本一覽（發起人點選）\n';
  for (const list of [scripts.map((s) => `${s.emoji} ${s.title}\n　${s.blurb}`).join('\n'), scripts.map((s) => `${s.emoji} ${s.title}｜${s.setting}`).join('\n')]) {
    const alt = out.replace(pickFull, () => head + list); if (alt.length <= ES_CAPTION_MAX) return alt;
  }
  return out.replace(pickFull, () => `${head}${scripts.map((s) => `${s.emoji} ${s.title}`).join('　')}`);
}
export function lobbyKeyboard(g, { script = null, save = null, scripts = [] }) {
  const full = g.players.length >= ES_MAX_PLAYERS;
  const rows = [[{ text: full ? '🈵 已額滿' : '🚪 我也要玩', callback_data: `es:j:${g.id}` }]];
  if (g.view === 'pick') {
    for (const s of scripts) rows.push([{ text: `${script?.id === s.id ? '✅ ' : ''}${scriptLabel(s)}`, callback_data: `es:k:${g.id}:${s.id}` }]);
    rows.push([{ text: '⬅️ 返回', callback_data: `es:b:${g.id}` }]);
    return rows;
  }
  if (save) rows.push([{ text: `▶️ 繼續上次進度（${saveLabel(save)}）`, callback_data: `es:r:${g.id}` }]);
  rows.push([{ text: save ? '🆕 選新劇本' : script ? '📖 換劇本' : '📖 選劇本', callback_data: `es:p:${g.id}` }]);
  if (script) rows.push([{ text: `▶️ 開始：${script.title}`, callback_data: `es:s:${g.id}` }]);
  rows.push([{ text: '🛑 結束所有遊戲', callback_data: `es:e:${g.id}` }]);
  return rows;
}

// ---------- in-game texts ----------
export const PLAY_RULES = '📜 玩法\n• 🔍 調查：查看房間裡的地方，有發現會另外發一則訊息\n• 🎒 道具：全隊共用背包，選道具 → 選要用在哪裡\n• 🔢 密碼：「回覆」房間訊息輸入答案（或打「密碼：…」），答錯沒有懲罰\n• 💡 求救：隨時都能按，一局 3 次\n• 💾 存檔離開：發起人可以隨時存檔，下次接著玩（15 分鐘沒人動也會自動存檔）';
export const playRulesV2 = (s) => `📜 玩法（${levelsOf(s)} 關進階版）\n• 🔍 調查：查看每一關的地方，有發現會另外發一則訊息\n• 🎒 道具：選道具 → 用在某處，或「🔗」跟另一樣道具組合\n• 🔢 密碼：「回覆」關卡訊息輸入答案（或打「密碼：…」）。⚠️ 答錯會扣時間，有些鎖還會觸發機關\n• 📒 線索簿：前面關卡的線索，後面還會用到，隨時可以翻\n• 🧩 不是每條線索都可信，小心誤導\n• 🔀 有些關卡可以選路線\n• 🎲 每局的密碼都不一樣，背答案沒有用\n• 💡 求救：隨時都能按，一局 ${maxHintsOf(s)} 次；已經做到的步驟不會再提示，給過的提示在📒線索簿\n• 💾 存檔離開：發起人可以隨時存檔（15 分鐘沒人動也會自動存檔）`;
/** 社群版 has no 存檔: a round is one sitting (15 quiet minutes = 散場, not counted) */
export const NO_SAVE_RULE = '• 💤 社群場不能存檔：一次玩完，15 分鐘沒人行動就散場（不列入參加紀錄）';
export function introText(s, g, { resumed = false, noSave = false } = {}) {
  const who = `👥 玩家：${g.players.map((p) => p.name).join('、')}`;
  if (resumed) return `${s.emoji} ${s.title}｜繼續上次進度\n\n你們回到了第 ${levelNo(g)} ${unitOf(s)}「${s.rooms[g.room].name}」。背包和線索都還在，時間從暫停的地方繼續。\n⏱ 剩 ${mmss(g.deadline - g.startedAt)}（${hhmm(g.deadline)} 前）\n\n${who}`;
  const rules = isV2(s) ? playRulesV2(s) : PLAY_RULES;
  return `${s.emoji} ${s.title}｜${stars(s.difficulty)}｜${ghosts(s.horror)}${levelTag(s)}\n\n${s.intro}\n\n${noSave ? rules.replace(/\n• 💾[^\n]*/, () => `\n${NO_SAVE_RULE}`) : rules}\n⏱ 限時 ${Math.round(gameMs(s) / 60e3)} 分鐘（${hhmm(g.deadline)} 前）\n${who}`;
}
