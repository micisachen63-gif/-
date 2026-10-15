const { chromium } = require('playwright');
(async () => { const b = await chromium.connectOverCDP('http://127.0.0.1:9222'); const c = b.contexts()[0];
  const all = await c.cookies(); console.log('qz cookies now:', all.filter(x => x.domain.includes('qzplays')).map(x => x.domain + ':' + x.name).join(', '));
  await c.clearCookies({ domain: 'admin.qzplays.com' });
  console.log('after clear:', (await c.cookies()).filter(x => x.domain.includes('qzplays')).map(x => x.name).join(','));
  const p = await c.newPage(); await p.goto('https://admin.qzplays.com:9955/gm/mail', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000);
  console.log('url', p.url(), 'pwd visible', await p.locator('input[name="login_password"]').first().isVisible().catch(() => false), 'tabs', await p.locator('[role="tab"]').count());
  await p.close(); })().catch(e => { console.error(e.message); process.exit(1); });