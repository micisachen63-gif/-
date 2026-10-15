const digits = /\d[\d,]*/;

export function parseCount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  const match = String(value).replaceAll(',', '').match(digits);
  return match ? Number(match[0]) : null;
}

export function normalizeRoom(raw) {
  const game = String(raw.game ?? '').trim();
  const tableId = String(raw.tableId ?? '').trim();
  const spinsSinceBonus = parseCount(raw.spinsSinceBonus);
  const previousBonusSpins = parseCount(raw.previousBonusSpins);
  const secondPreviousBonusSpins = parseCount(raw.secondPreviousBonusSpins);
  const todayReturnRate = raw.todayReturnRate == null ? null : String(raw.todayReturnRate).trim() || null;
  const days30ReturnRate = raw.days30ReturnRate == null ? null : String(raw.days30ReturnRate).trim() || null;
  return {
    game,
    tableId,
    spinsSinceBonus,
    previousBonusSpins,
    secondPreviousBonusSpins,
    todayReturnRate,
    days30ReturnRate,
    isEmpty: raw.isEmpty === true,
    roomId: raw.roomId ?? null,
    page: parseCount(raw.page),
  };
}

/** Pick up to maxRoomsPerGame qualifying tables for each game (game order preserved). */
export function selectRooms(rawRooms, { games, minSpins = 50, maxRooms = 10, maxRoomsPerGame }) {
  const perGame = maxRoomsPerGame ?? maxRooms;
  const gameOrder = new Map(games.map((name, index) => [name, index]));
  const found = new Map();
  for (const raw of rawRooms) {
    const room = normalizeRoom(raw);
    if (!gameOrder.has(room.game) || !room.isEmpty || !room.tableId) continue;
    if (room.spinsSinceBonus == null || room.spinsSinceBonus < minSpins) continue;
    const key = `${room.game}\u0000${room.tableId}`;
    const existing = found.get(key);
    if (!existing || room.spinsSinceBonus > existing.spinsSinceBonus) found.set(key, room);
  }
  const selected = [];
  for (const game of games) {
    const group = [...found.values()]
      .filter((room) => room.game === game)
      .sort((a, b) =>
        b.spinsSinceBonus - a.spinsSinceBonus ||
        a.tableId.localeCompare(b.tableId, 'zh-Hant', { numeric: true }))
      .slice(0, perGame);
    selected.push(...group);
  }
  return selected;
}
