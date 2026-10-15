import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const envFile = path.join(projectRoot, '.env');
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  // Strip UTF-8 BOM — Windows editors / PowerShell often add it and
  // process.loadEnvFile then misses the first key (usually TELEGRAM_BOT_TOKEN).
  let raw = fs.readFileSync(filePath);
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    raw = raw.subarray(3);
  }
  const tmp = `${filePath}.nobom`;
  fs.writeFileSync(tmp, raw);
  try {
    process.loadEnvFile(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}
loadEnv(envFile);

const integer = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必須是正整數`);
  return value;
};


export const gameDefinitions = [
  {
    name: '戰神賽特二',
    lobbyId: 584,
    search: '賽特',
    key: 'golden-seth',
    image: path.join(projectRoot, 'assets', 'golden-seth.jpg'),
  },
  {
    name: '虎小妹',
    lobbyId: 856,
    search: '虎小妹',
    key: 'tiger-princess',
    image: path.join(projectRoot, 'assets', 'tiger-princess.jpg'),
  },
  {
    name: '古神巴風特',
    lobbyId: 779,
    search: '巴風特',
    key: 'hades',
    image: path.join(projectRoot, 'assets', 'hades.jpg'),
  },
];

export const config = {
  projectRoot,
  gameUrl: process.env.GAME_URL || 'https://liff.line.me/2000222941-8ORVa7oZ?maintain',
  buttonUrl: process.env.BUTTON_URL || 'https://liff.line.me/2000222941-8ORVa7oZ',
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_CHAT_ID || '',
  minSpins: integer('MIN_SPINS', 50),
  maxRooms: integer('MAX_ROOMS', 10),
  // Always headless for run/dry-run/schedule. Login forces a window via interactiveLogin.
  // Set ATG_HEADED=1 only when you intentionally want to watch the browser.
  headless: process.env.ATG_HEADED !== '1',
  profilePath: path.join(projectRoot, '.auth', 'chrome'),
  launchUrlsPath: path.join(projectRoot, '.auth', 'game-urls.json'),
  logPath: path.join(projectRoot, 'logs', 'bot.log'),
};
