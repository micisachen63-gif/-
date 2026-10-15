// 小精靈 → elf-rpg-api client. Secret comes from rpg.local.json (never logged). One retry on 409 conflict.
import fs from 'node:fs';

export class RpgApiError extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status; } }

/** rpg.local.json: { "apiUrl": "https://elf-rpg-api.<subdomain>.workers.dev", "serviceSecret": "<same as wrangler secret SERVICE_SECRET>",
 *  "appUrl": optional Mini App URL (default apiUrl + "/"; "" disables the Mini App buttons), "mainMiniApp": optional true once BotFather has a Main Mini App (enables t.me/<bot>?startapp links) } */
export function loadRpgConfig(file, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  let raw; try { raw = readFile(file); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const j = JSON.parse(raw); if(j.enabled===false)return null; const apiUrl = String(j.apiUrl || '').replace(/\/+$/, ''); const serviceSecret = String(j.serviceSecret || '');
  if (!/^https?:\/\//.test(apiUrl) || serviceSecret.length < 16) throw new Error('rpg.local.json needs apiUrl and serviceSecret (≥16 chars)');
  let appUrl = j.appUrl === undefined || j.appUrl === null ? `${apiUrl}/` : String(j.appUrl);
  if (appUrl && !/^https:\/\//.test(appUrl)) appUrl = '';   // Telegram only opens https Mini Apps
  return { apiUrl, serviceSecret, appUrl: appUrl || null, mainMiniApp: j.mainMiniApp === true };
}

export function createRpgApi({ apiUrl, serviceSecret, fetchImpl = fetch, timeoutMs = 10000, debugNow = null }) {
  async function once(path, body) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs); timer.unref?.();
    try {
      const headers = { 'content-type': 'application/json', 'X-Service-Secret': serviceSecret };
      if (debugNow) headers['X-Debug-Now'] = String(debugNow());   // only honoured by a development Worker
      const res = await fetchImpl(`${apiUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}), signal: ctl.signal });
      let j; try { j = await res.json(); } catch { throw new RpgApiError('bad_response', `RPG 伺服器回應異常（${res.status}）`, res.status); }
      if (!j.ok) throw new RpgApiError(j.error || 'error', j.message || '發生錯誤', res.status);
      return j;
    } catch (error) {
      if (error instanceof RpgApiError) throw error;
      throw new RpgApiError('network', error?.name === 'AbortError' ? 'RPG 伺服器逾時，請稍後再試' : 'RPG 伺服器連線失敗，請稍後再試', 0);
    } finally { clearTimeout(timer); }
  }
  return {
    async call(path, body) {
      try { return await once(path, body); }
      catch (error) { if (error.code === 'conflict') return once(path, body); throw error; }
    },
  };
}
