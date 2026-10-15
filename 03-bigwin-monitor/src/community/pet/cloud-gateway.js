// Server-to-server bridge. D1 is the pet wallet and character source of truth.
export function createPetCloudGateway({ apiUrl, serviceSecret, fetchImpl = fetch }) {
  const base = String(apiUrl || '').replace(/\/$/, '');
  if (!base || !serviceSecret) throw new Error('Pet cloud gateway needs URL and service secret');

  async function request(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Secret': serviceSecret,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `寵物雲端服務 HTTP ${res.status}`);
    return data;
  }

  return {
    account: (product, tgId) => request(`/api/pet/service/account?product=${encodeURIComponent(product)}&tgId=${encodeURIComponent(tgId)}`),
    play: (body) => request('/api/pet/service/play', { method: 'POST', body }),
    shareLike: (body) => request('/api/pet/service/share/like', { method: 'POST', body }),
    pvp: (body) => request('/api/pet/service/pvp', { method: 'POST', body }),
    bossAward: (body) => request('/api/pet/service/boss-award', { method: 'POST', body }),
    syncBossState: (body) => request('/api/pet/service/boss-state', { method: 'POST', body }),
    seasonConfig: (product) => request(`/api/pet/service/season/config?product=${encodeURIComponent(product)}`),
    saveSeasonConfig: (body) => request('/api/pet/service/season/config', { method: 'POST', body }),
    seasonActivate: (body) => request('/api/pet/service/season/activate', { method: 'POST', body }),
    seasonStart: (body) => request('/api/pet/service/season/start', { method: 'POST', body }),
    seasonRankings: (product) => request(`/api/pet/service/season/rankings?product=${encodeURIComponent(product)}`),
    seasonSettle: (body) => request('/api/pet/service/season/settle', { method: 'POST', body }),
    claimSeasonPayout: (body) => request('/api/pet/service/season/payouts/claim', { method: 'POST', body }),
    completeSeasonPayout: (body) => request('/api/pet/service/season/payouts/complete', { method: 'POST', body }),
    dungeonTick: (body) => request('/api/pet/service/dungeon/tick', { method: 'POST', body }),
    dungeonForceDrop: (body) => request('/api/pet/service/dungeon/force-drop', { method: 'POST', body }),
  };
}
