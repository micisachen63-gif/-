// 社群自動派獎 sender (2026-10-06 autopay): one winner → one backend mail (金幣(1) × prize, 贏麻 also 金幣綁洗碼量 =
// 打碼倍數), filled by mail-form.js (same /gm/mail form + selectors as the 新手禮包 automation).
// Runs in the 小遊戲精靈's OWN headless backend Chrome (createBackendBrowser, .auth/minigame-chrome) with the same
// session handling as the AID lookups (createMemberBackend: session check + DPAPI typed re-login). Never connects to
// any other Chrome (no 9222 / 19385). Sends are serialized.
// Every error that happened before 送出 is tagged notSubmitted (payout.js may retry it); errors after 送出 keep
// uncertain=true (never retried).
import { fillCommunityMail } from './mail-form.js';

export function createMailSender({ groups, getContext, backendFor, log, fill = fillCommunityMail }) {
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const pre = (error) => { if (!error?.uncertain) error.notSubmitted = true; return error; };

  return function sendMail({ round, aid, iconTitle, title, body, amount, multiplier = 0 }) {
    return serial(async () => {
      const brand = groups?.[round?.key]?.brand;
      if (!brand?.uiBase || !brand?.key) throw pre(new Error(`${round?.key} 沒有後台設定；獎金尚未送出。`));
      if (!aid || !(Number(amount) > 0)) throw pre(new Error('收件 AID 或金額無效；獎金尚未送出。'));
      const backend = backendFor(round.key);
      const attempt = async () => {
        const ctx = await getContext(); const page = await ctx.newPage();
        try { return await fill(page, { uiBase: brand.uiBase, brandKey: brand.key, aids: [String(aid)], iconTitle, title, body, amount, multiplier, submit: true }); }
        finally { await page.close().catch(() => {}); }
      };
      try {
        await backend.ensureSession();
        try { return await attempt(); } catch (error) {
          if (!error?.loginRequired) throw error;
          log?.info?.(`${brand.key}: mail page asked for login, re-login and retry once`);
          await backend.relogin();
          return await attempt();
        }
      } catch (error) { throw pre(error); }
    }).then((r) => { log?.info?.(`mail sent: ${round.id} AID ${aid} ${amount}${Number(multiplier) > 0 ? ` (${multiplier}x)` : ''}`); return r; });
  };
}
