import { randomInt } from 'node:crypto';

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;
export const ROLE_NAMES = Object.freeze({ wolf: '狼人', seer: '預言家', witch: '女巫', guard: '守衛', hunter: '獵人', villager: '村民' });

const layouts = {
  5: ['wolf', 'seer', 'villager', 'villager', 'villager'],
  6: ['wolf', 'seer', 'witch', 'villager', 'villager', 'villager'],
  7: ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager', 'villager'],
  8: ['wolf', 'wolf', 'seer', 'witch', 'guard', 'villager', 'villager', 'villager'],
  9: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'guard', 'villager', 'villager', 'villager'],
  10: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'guard', 'hunter', 'villager', 'villager', 'villager'],
};

export function dealRoles(count, rand = randomInt) {
  if (!Number.isInteger(count) || count < MIN_PLAYERS || count > MAX_PLAYERS) throw new Error('狼人殺需 5–10 人');
  const roles = [...layouts[count]];
  for (let i = roles.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

export const living = game => game.players.filter(player => player.alive);
export const playerById = (game, id) => game.players.find(player => String(player.id) === String(id));
export const playerBySeat = (game, seat) => game.players[Number(seat) - 1];

export function winner(game) {
  const alive = living(game);
  const wolves = alive.filter(player => player.role === 'wolf').length;
  if (wolves === 0) return 'village';
  if (wolves >= alive.length - wolves) return 'wolves';
  return null;
}

export function mostChosen(selections, eligible, rand = randomInt) {
  const votes = Object.values(selections || {}).filter(target => eligible.has(Number(target)));
  if (!votes.length) return null;
  const counts = new Map();
  for (const target of votes) counts.set(Number(target), (counts.get(Number(target)) || 0) + 1);
  const max = Math.max(...counts.values());
  const tied = [...counts].filter(([, count]) => count === max).map(([seat]) => seat);
  return tied[rand(tied.length)];
}

export function voteResult(ballots, livingSeats, runoffSeats = null) {
  const allowed = new Set(runoffSeats || livingSeats);
  const counts = new Map();
  for (const target of Object.values(ballots || {})) {
    if (!allowed.has(Number(target))) continue;
    counts.set(Number(target), (counts.get(Number(target)) || 0) + 1);
  }
  if (!counts.size) return { seat: null, tied: [], counts: {} };
  const top = Math.max(...counts.values());
  const tied = [...counts].filter(([, count]) => count === top).map(([seat]) => seat);
  return { seat: tied.length === 1 ? tied[0] : null, tied, counts: Object.fromEntries(counts) };
}

export function resolveNight(game, rand = randomInt) {
  const alive = living(game);
  const aliveSeats = new Set(alive.map(player => player.seat));
  const wolfTarget = game.wolfTarget ?? mostChosen(game.nightActions?.wolves, new Set(alive.filter(player => player.role !== 'wolf').map(player => player.seat)), rand);
  const guardTarget = Number(game.nightActions?.guard) || null;
  const heal = game.nightActions?.witch?.kind === 'heal';
  const poison = game.nightActions?.witch?.kind === 'poison' ? Number(game.nightActions.witch.seat) : null;
  const deaths = [];
  if (wolfTarget && guardTarget !== wolfTarget && !heal) deaths.push({ seat: wolfTarget, cause: 'wolf' });
  if (poison && aliveSeats.has(poison) && !deaths.some(item => item.seat === poison)) deaths.push({ seat: poison, cause: 'poison' });
  return { wolfTarget, deaths };
}
