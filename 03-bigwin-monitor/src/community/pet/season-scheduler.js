import { parseSeasonTimestamp } from './season-time.js';

/** Executes only seasons that an administrator explicitly activated or scheduled. */
export function createPetSeasonScheduler({ store, products, groupChatId, announce = async () => {}, log = console, now = Date.now }) {
  let running = false;

  async function tick() {
    if (running) return { skipped: 'already-running' };
    running = true;
    const results = [];
    try {
      for (const product of products) {
        try {
          const config = await store.getSeasonConfig(product);
          const season = config?.season;
          if (!season) continue;

          if (season.status === 'scheduled') {
            const startAt = parseSeasonTimestamp(season.startTime ?? season.start_time);
            if (startAt == null || now() < startAt) continue;
            const started = await store.startSeason(product);
            if (started?.started) {
              const message = `🏆 【${season.title || '社群季賽'}】已開始！\n賽季時間：${season.startTime || season.start_time} ～ ${season.endTime || season.end_time}（台北時間）`;
              await announce(groupChatId(product), message);
              results.push({ product, action: 'started' });
            }
            continue;
          }

          if (season.status === 'active') {
            const endAt = parseSeasonTimestamp(season.endTime ?? season.end_time, { endOfMinute: true });
            if (endAt == null || now() <= endAt) continue;
            const settled = await store.settleSeason(product);
            if (settled?.ok) {
              const winners = (settled.winners || []).map((winner) =>
                `• 第 ${winner.rank} 名：${winner.nickname || '玩家'}（${winner.points} 分）🎖 ${winner.badges} 勳章`
              ).join('\n');
              const message = `🏁 【${season.title || '社群季賽'}】已自動結算\n${winners || '本季沒有得獎玩家'}\n\n前 10 名勳章已存入寵物背包；積分已重置為 100。下一季須由管理員另行設定並開啟。`;
              await announce(groupChatId(product), message);
              results.push({ product, action: 'settled', settledCount: settled.settledCount || 0 });
            }
          }
        } catch (error) {
          log.warn?.(`season scheduler ${product}: ${error.message}`);
        }
      }
      return { results };
    } finally {
      running = false;
    }
  }

  return { tick };
}
