import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../art-runtime/rpg-boss');
const cache = new Map();
export function bossCardBytes(boss) {
  const map = Number(boss.mapId);
  if (!Number.isInteger(map) || map < 1 || map > 12) return null;
  if (!cache.has(map)) cache.set(map, fs.readFileSync(path.join(root, `boss-${map}.png`)));
  return cache.get(map);
}
