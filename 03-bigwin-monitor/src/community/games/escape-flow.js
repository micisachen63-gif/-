// 🚪 密室逃脫 group flow for the community bot (小遊戲精靈): the same engine as 小精靈 (src/escape-flow.js), shared instead of copied.
// Scripts: assets/escape/scripts/ with assets/escape/scripts10/ overriding by id (all 15 are 10-level now, incl. hospital v2): per-game random answers,
// cross-level clues, item combining, red herrings, wrong-answer penalties / traps, branching routes. The community hooks (admin-opened rounds, AID signup,
// max players, no 存檔, results via onEnd) are the `community` option of createEscapeFlow. The old copy is kept as escape-flow.js.bak-20261004-mg10.
export { ES_CALLBACK_RE, createEscapeFlow } from '../../escape-flow.js';
