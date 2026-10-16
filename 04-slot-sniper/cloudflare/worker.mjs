import { DurableObject } from 'cloudflare:workers';

const BRANDS = ['shuangbao', 'qiezi', 'yingma'];
const SCHEDULES = {
  shuangbao: [2, 7, 15, 20],
  qiezi: [0, 8, 10, 12, 14, 18, 20, 22],
  yingma: [0, 12, 18, 22],
};
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function digest(value, key) {
  const secret = await crypto.subtle.importKey('raw', new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', secret, new TextEncoder().encode(value)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function isAdmin(request, env) {
  if (!env.ADMIN_KEY) return false;
  const value = /(?:^|;\s*)slot_admin=([^;]+)/.exec(request.headers.get('cookie') || '')?.[1];
  if (!value) return false;
  const [expiry, signature] = value.split('.');
  if (!/^\d+$/.test(expiry) || Number(expiry) < Date.now() || Number(expiry) > Date.now() + 86400000) return false;
  const expected = await digest(expiry, env.ADMIN_KEY);
  return signature?.length === expected.length && signature === expected;
}

function credentials(env, brand) {
  const prefix = brand.toUpperCase();
  return {
    BRAND: brand,
    TELEGRAM_BOT_TOKEN: env[`${prefix}_TELEGRAM_BOT_TOKEN`] || '',
    TELEGRAM_CHAT_ID: env[`${prefix}_TELEGRAM_CHAT_ID`] || '',
  };
}

export class SlotContainer extends DurableObject {
  async ready(brand, interactive = false) {
    const container = this.ctx.container;
    if (!container.running) {
      const snapshot = await this.ctx.storage.get('snapshot');
      const options = {
        instance: 'standard-1',
        enableInternet: true,
        env: credentials(this.env, brand),
      };
      if (snapshot) options.containerSnapshot = snapshot;
      else options.image = container.images.base;
      container.start(options);
    }
    await container.setInactivityTimeout(interactive ? 30 * 60 * 1000 : 2 * 60 * 1000);
    const port = container.getTcpPort(8080);
    let lastError;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await port.fetch('http://container/health', { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) return port;
      } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Container ${brand} did not start: ${lastError?.message || 'health check failed'}`);
  }

  async save() {
    if (!this.ctx.container.running) return json({ error: 'Container not running' }, 409);
    const snapshot = await this.ctx.container.snapshotContainer({ name: 'authenticated-profile' });
    await this.ctx.storage.put('snapshot', snapshot);
    await this.ctx.storage.put('snapshotAt', new Date().toISOString());
    return json({ saved: true, at: new Date().toISOString() });
  }

  async startScheduled(brand, scheduleAt) {
    const key = `${brand}:${scheduleAt}`;
    if (await this.ctx.storage.get('lastScheduledKey') === key) return { skipped: 'already scheduled' };
    if (!(await this.ctx.storage.get('snapshot'))) throw new Error(`${brand} has no saved LINE login`);
    const port = await this.ready(brand);
    const response = await port.fetch('http://container/run', { method: 'POST' });
    if (!response.ok) throw new Error(`${brand} run rejected: ${response.status}`);
    await this.ctx.storage.put('lastScheduledKey', key);
    await this.ctx.storage.put('pending', { brand, scheduleAt, startedAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + 60000);
    return { accepted: true };
  }

  async alarm() {
    const pending = await this.ctx.storage.get('pending');
    if (!pending) return;
    try {
      const port = await this.ready(pending.brand);
      const response = await port.fetch('http://container/status');
      const status = await response.json();
      if (status.current) {
        await this.ctx.storage.setAlarm(Date.now() + 60000);
        return;
      }
      await this.ctx.storage.put('lastResult', status.last);
      await this.ctx.storage.delete('pending');
      await this.save();
    } catch (error) {
      console.error('Run monitoring failed', error);
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const brand = parts[2];
    if (!BRANDS.includes(brand)) return json({ error: 'Invalid brand' }, 400);
    if (parts[1] === 'console') {
      await this.ready(brand, true);
      const suffix = '/' + parts.slice(3).join('/');
      const target = new URL(`http://container${suffix}`);
      target.search = url.search;
      return this.ctx.container.getTcpPort(6080).fetch(new Request(target.toString(), request));
    }
    if (parts[1] === 'snapshot' && request.method === 'POST') return this.save();
    if (parts[1] === 'status' && request.method === 'GET') {
      const snapshotAt = await this.ctx.storage.get('snapshotAt');
      const lastResult = await this.ctx.storage.get('lastResult');
      if (!this.ctx.container.running) return json({ running: false, snapshotAt, lastResult });
      const port = await this.ready(brand);
      const live = await (await port.fetch('http://container/status')).json();
      return json({ running: true, snapshotAt, lastResult, live });
    }
    if (parts[1] === 'login' && request.method === 'POST') {
      const port = await this.ready(brand, true);
      return port.fetch('http://container/login', { method: 'POST' });
    }
    if (parts[1] === 'dry-run' && request.method === 'POST') {
      const port = await this.ready(brand);
      return port.fetch('http://container/run?dry=1', { method: 'POST' });
    }
    return json({ error: 'Not found' }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, cloudEnabled: env.CLOUD_ENABLED === 'true' });
    if (url.pathname === '/admin' && request.method === 'GET') {
      const authenticated = await isAdmin(request, env);
      const body = authenticated
        ? `<h1>掃台雲端登入與驗證</h1>${BRANDS.map(brand => `<section><h2>${brand}</h2><p><a href="/admin/console/${brand}/vnc.html?path=admin/console/${brand}/websockify">開啟登入畫面</a>　<a href="/admin/status/${brand}">查看狀態</a></p><form method="post" action="/admin/login/${brand}"><button>開始 LINE 登入</button></form><form method="post" action="/admin/snapshot/${brand}"><button>登入完成後保存狀態</button></form><form method="post" action="/admin/dry-run/${brand}"><button>只掃描、不發送</button></form></section>`).join('')}`
        : '<form method="post" action="/admin/session"><label>管理密鑰 <input type="password" name="key" autocomplete="off"></label><button>登入</button></form>';
      return new Response(body, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/admin/session' && request.method === 'POST') {
      const form = await request.formData();
      if (!env.ADMIN_KEY || form.get('key') !== env.ADMIN_KEY) return json({ error: 'Unauthorized' }, 401);
      const expiry = String(Date.now() + 60 * 60 * 1000);
      const signature = await digest(expiry, env.ADMIN_KEY);
      return new Response(null, {
        status: 303,
        headers: {
          location: '/admin',
          'set-cookie': `slot_admin=${expiry}.${signature}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`,
        },
      });
    }
    if (!(await isAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
    const parts = url.pathname.split('/').filter(Boolean);
    const brand = parts[2];
    if (parts[0] !== 'admin' || !BRANDS.includes(brand)) return json({ error: 'Not found' }, 404);
    return env.SLOT_CONTAINER.getByName(brand).fetch(request);
  },
  async scheduled(controller, env, ctx) {
    if (env.CLOUD_ENABLED !== 'true') return;
    const hour = (new Date(controller.scheduledTime).getUTCHours() + 8) % 24;
    const brands = BRANDS.filter(brand => SCHEDULES[brand].includes(hour));
    ctx.waitUntil(Promise.all(brands.map(async brand => {
      const token = env[`${brand.toUpperCase()}_TELEGRAM_BOT_TOKEN`];
      const chat = env[`${brand.toUpperCase()}_TELEGRAM_CHAT_ID`];
      if (!token || !chat) throw new Error(`${brand} Telegram secrets missing`);
      const result = await env.SLOT_CONTAINER.getByName(brand).startScheduled(brand, controller.scheduledTime);
      console.log(brand, result);
    })));
  },
};
