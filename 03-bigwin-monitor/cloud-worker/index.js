// Cloudflare Worker: 爆分監控與洗碼量同步 (純 HTTPS API，免瀏覽器)
export default {
  async scheduled(event, env, ctx) {
    console.log('[Cron] 5分鐘定時爆分與洗碼量檢查觸發:', new Date().toISOString());
    // 自動登入後台與檢查注單
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, time: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Ops Automation Cloud Worker', { status: 200 });
  }
};
