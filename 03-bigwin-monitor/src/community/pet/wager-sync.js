// Wager & Binding synchronization between brand backends (headless Chrome) and Cloudflare Pet Ledger
import { taipeiDay } from './rules.js';

export function createWagerSync({
  apiUrl,
  serviceSecret = 'CHANGE_ME_SECRET_KEY',
  backendFor,
  groupStore,
  groups = ['yingma', 'shuangbao', 'qiezi'],
  log = console,
  now = Date.now,
}) {
  let isSyncing = false;

  async function syncBindings() {
    if (!apiUrl) return { ok: false, error: 'no apiUrl' };
    const allBindings = [];

    for (const key of groups) {
      const store = groupStore(key);
      const bindings = store?.data?.bindings || {};
      for (const [tgId, b] of Object.entries(bindings)) {
        for (const aid of (b.aids || [])) {
          allBindings.push({
            product: key,
            tg_id: tgId,
            aid: String(aid),
            nickname: b.nicknames?.[aid] || null,
          });
        }
      }
    }

    if (!allBindings.length) return { ok: true, count: 0 };

    try {
      const res = await fetch(`${apiUrl}/api/pet/service/sync-bindings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Secret': serviceSecret,
        },
        body: JSON.stringify({ bindings: allBindings }),
      });
      const data = await res.json();
      log.info(`[wager-sync] synced ${data.synced || allBindings.length} AID bindings to Cloudflare`);
      return data;
    } catch (e) {
      log.warn(`[wager-sync] syncBindings failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async function syncBaseline(product, tgId, aid, nickname) {
    if (!apiUrl) return { ok: false, error: '未設定寵物 API' };
    try {
      const backend = backendFor(product);
      if (!backend) throw new Error('找不到此產品的後台連線');
      const status = await backend.status(String(aid), { wager: { period: 'today' } }, { fresh: true });
      if (!status?.exists || status.wager == null || !Number.isFinite(Number(status.wager)) || Number(status.wager) < 0) {
        throw new Error('無法取得可信的今日打碼基準');
      }
      const response = await fetch(`${apiUrl}/api/pet/service/wager-baseline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Secret': serviceSecret },
        body: JSON.stringify({ product, tgId: String(tgId), aid: String(aid), nickname: nickname || null, day: taipeiDay(now()), total: Number(status.wager) }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      return { ...result, baselineSynced: true };
    } catch (error) {
      log.warn(`[wager-sync] baseline refresh failed for ${product} AID ${aid}: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  async function syncOneBinding(product, tgId, aid, nickname) {
    if (!apiUrl) return { ok: false, error: '未設定寵物 API' };
    try {
      const res = await fetch(`${apiUrl}/api/pet/service/sync-bindings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Secret': serviceSecret,
        },
        body: JSON.stringify({
          bindings: [{ product, tg_id: String(tgId), aid: String(aid), nickname }],
        }),
      });
      const result = await res.json();
      if (!res.ok || !result.ok) throw new Error(result.error || `HTTP ${res.status}`);
      const baseline = await syncBaseline(product, tgId, aid, nickname);
      if (!baseline.ok) return { ...result, ok: false, error: baseline.error, baselineSynced: false, baselineError: baseline.error };
      log.info?.(`[wager-sync] single binding and fresh baseline synced: ${product} TG ${tgId} -> AID ${aid}`);
      return { ...result, ...baseline };
    } catch (e) {
      log.warn(`[wager-sync] syncOneBinding failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async function syncWagers() {
    if (isSyncing || !apiUrl) return;
    isSyncing = true;
    try {
      // A binding can reach Cloudflare even when the initial backend wager lookup
      // fails. Keep retrying those baselines independently of active pets.
      try {
        const missingRes = await fetch(`${apiUrl}/api/pet/service/missing-wager-baselines`, {
          headers: { 'X-Service-Secret': serviceSecret },
        });
        const missingData = await missingRes.json();
        if (!missingRes.ok || !missingData?.ok) {
          throw new Error(missingData?.error || `HTTP ${missingRes.status} while listing missing wager baselines`);
        }
        for (const binding of missingData.bindings || []) {
          const result = await syncBaseline(binding.product, binding.tgId, binding.aid, binding.nickname);
          if (result.ok) {
            log.info(`[wager-sync] initialized missing baseline: ${binding.product} TG ${binding.tgId} AID ${binding.aid} = ${result.checkpoint}`);
          } else {
            log.warn(`[wager-sync] missing baseline retry failed for ${binding.product} TG ${binding.tgId} AID ${binding.aid}: ${result.error}`);
          }
        }
      } catch (error) {
        log.warn(`[wager-sync] missing baseline scan failed: ${error.message}`);
      }

      const petsRes = await fetch(`${apiUrl}/api/pet/service/active-pets`, {
        headers: { 'X-Service-Secret': serviceSecret },
      });
      const petsData = await petsRes.json();
      const pets = petsData?.pets || [];

      if (!pets.length) {
        isSyncing = false;
        return;
      }

      const today = taipeiDay(now());

      for (const pet of pets) {
        try {
          const backend = backendFor(pet.product);
          if (!backend) continue;

          const st = await backend.status(pet.aid, { wager: { period: 'today' } });
          if (!st || !st.exists || st.wager == null) continue;

          const syncRes = await fetch(`${apiUrl}/api/pet/wager-sync`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Service-Secret': serviceSecret,
            },
            body: JSON.stringify({
              product: pet.product,
              aid: pet.aid,
              day: today,
              total: Number(st.wager) || 0,
            }),
          });
          const result = await syncRes.json();
          if (result.ok && result.awarded > 0) {
            log.info(`[wager-sync] 🌟 ${pet.product} AID ${pet.aid} 增加打碼 ${result.delta} -> 發放 ${result.awarded} 寵物點數 (總點數: ${result.points_after || '-'})`);
          }
        } catch (err) {
          log.warn(`[wager-sync] check wager for ${pet.product} AID ${pet.aid} failed: ${err.message}`);
        }
      }
    } catch (e) {
      log.warn(`[wager-sync] syncWagers cycle failed: ${e.message}`);
    } finally {
      isSyncing = false;
    }
  }

  return {
    syncBindings,
    syncOneBinding,
    syncBaseline,
    syncWagers,
  };
}
