// Pet Mini App entry buttons.
// Groups: a plain URL button opens the Mini App as an ordinary web page with no Telegram initData,
// which the Worker now rejects. Use the bot's Main Mini App link (t.me/<bot>?startapp=<product>)
// so Telegram opens it as a real Mini App with signed initData. Private chats can use web_app buttons.
const DEFAULT_MINI_APP_URL = 'https://minigame-pet-api.micisachen.workers.dev';

export function petMiniAppUrl(cfg) {
  return cfg?.petMiniAppUrl || DEFAULT_MINI_APP_URL;
}

export function petAppLink(cfg, product) {
  const username = String(cfg?.botUsername || '').replace(/^@/, '').trim();
  if (!username) return petMiniAppUrl(cfg);
  const param = String(product || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return `https://t.me/${username}${param ? `?startapp=${param}` : '?startapp'}`;
}

export function petAppButton(text, cfg, { product, chatId } = {}) {
  if (Number(chatId) > 0) {
    const url = new URL(petMiniAppUrl(cfg));
    if (product) url.searchParams.set('product', String(product));
    return { text, web_app: { url: url.toString() } };
  }
  return { text, url: petAppLink(cfg, product) };
}
