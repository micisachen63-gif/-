// Local HTTP & API Bridge Server for Pet Mini App testing & standalone preview.
// Uses native Node.js http and fs modules (zero external dependencies).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { verifyTelegramInitData, taipeiDay, PRODUCTS } from './rules.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function createPetApiServer({ store, botToken = '', publicDir = null, port = 8787, log = console }) {
  const assetsDir = publicDir || path.resolve(import.meta.dirname, '../../../cloudflare/public');

  function sendJson(res, data, status = 200) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data, X-Service-Secret',
    });
    res.end(JSON.stringify(data));
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      return sendJson(res, { ok: true });
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. API Endpoints
    if (pathname.startsWith('/api/pet/')) {
      try {
        let authUser = null;
        const initDataHeader = req.headers['x-telegram-init-data'];
        if (initDataHeader && botToken) {
          const verified = verifyTelegramInitData(initDataHeader, botToken);
          if (verified) authUser = verified.user;
        }

        // Demo fallback for browser testing
        if (!authUser) {
          const demoTgId = parsedUrl.searchParams.get('demoTgId') || '8888001';
          authUser = { id: demoTgId, first_name: 'LocalPlayer' };
        }

        const tgId = String(authUser.id);

        if (pathname === '/api/pet/status' && req.method === 'GET') {
          const product = parsedUrl.searchParams.get('product') || 'yingma';
          const acc = store.getAccount(product, tgId);
          if (!acc) return sendJson(res, { ok: true, exists: false, product });

          const today = taipeiDay();
          const missedDays = Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${acc.pet.lastCareDay}T00:00:00Z`)) / 86400000));
          const isEndangered = acc.pet.life === 'alive' && missedDays >= 5;

          return sendJson(res, {
            ok: true,
            exists: true,
            product,
            pet: {
              tgId,
              aid: acc.aid,
              points: acc.points,
              stones: acc.stones,
              growth: acc.pet.growth,
              stage: acc.pet.stage,
              evolution: acc.pet.evolution,
              attack: acc.pet.attack,
              food: acc.pet.food,
              clean: acc.pet.clean,
              mood: acc.pet.mood,
              life: acc.pet.life,
              deaths: acc.pet.deaths,
              rebirths: acc.pet.rebirths,
              lastCareDay: acc.pet.lastCareDay,
              lastTrainingDay: acc.pet.lastTrainingDay,
              lastPlayDay: acc.pet.lastPlayDay,
              isEndangered,
              safeDaysRemaining: Math.max(0, 7 - missedDays),
              inventory: acc.inventory,
            },
          });
        }

        // Parse JSON body for POST
        if (req.method === 'POST') {
          let bodyStr = '';
          for await (const chunk of req) bodyStr += chunk;
          const body = bodyStr ? JSON.parse(bodyStr) : {};

          if (pathname === '/api/pet/open') {
            const { product, aid, baseline = 0 } = body;
            const acc = await store.openPetAccount({ product, tgId, aid, baseline });
            return sendJson(res, { ok: true, opened: true, aid: acc.aid });
          }

          if (pathname === '/api/pet/buy') {
            const { product, item, quantity = 1 } = body;
            const r = await store.buyItem({ product, tgId, item, quantity });
            return sendJson(res, { ok: true, cost: r.cost, balance: r.balance });
          }

          if (pathname === '/api/pet/use') {
            const { product, item } = body;
            const r = await store.useItem({ product, tgId, item });
            return sendJson(res, { ok: true, used: r.item });
          }

          if (pathname === '/api/pet/evolve') {
            const { product } = body;
            const r = await store.tryEvolve({ product, tgId });
            return sendJson(res, { ok: true, ...r });
          }

          if (pathname === '/api/pet/revive') {
            const { product, action } = body;
            const r = await store.reviveOrRebirth({ product, tgId, action });
            return sendJson(res, { ok: true, ...r });
          }
        }

        return sendJson(res, { ok: false, error: 'Not found' }, 404);
      } catch (e) {
        return sendJson(res, { ok: false, error: e.message }, 400);
      }
    }

    // 2. Static File Serving
    let filePath = path.join(assetsDir, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!fs.existsSync(filePath)) {
      filePath = path.join(assetsDir, 'index.html');
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  return {
    server,
    listen: () =>
      new Promise((resolve) => {
        server.on('error', (err) => {
          log.warn?.(`Pet Mini App preview server listen failed: ${err.message}`);
          resolve(null);
        });
        server.listen(port, '127.0.0.1', () => {
          log.info?.(`Pet Mini App preview server running at http://localhost:${port}`);
          resolve(port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}
