// Drains Cloudflare's season coin queue through the existing 小遊戲精靈 mail payout flow.
export function createSeasonPayoutSync({ cloud, payout, groups = [], groupNames = {}, log = console, now = Date.now }) {
  let running = false;

  async function syncSeasonPayouts() {
    if (running || !payout?.live || !cloud) return { processed: 0 };
    running = true;
    let processed = 0;
    try {
      for (const product of groups) {
        for (;;) {
          const { payout: job } = await cloud.claimSeasonPayout({ product });
          if (!job) break;
          const isCompletePetCampaign = String(job.exchangeId).startsWith('activity_complete_2026_');
          const round = {
            id: `season-exchange:${job.exchangeId}`,
            key: product,
            game: isCompletePetCampaign ? 'pet_complete_campaign' : 'season',
            platform: ({ yingma: '贏麻了', shuangbao: '爽爆', qiezi: '茄子' })[product] || product,
            date: new Date(now()).toISOString(),
            roundNo: isCompletePetCampaign ? '完全體分享活動' : job.exchangeId,
            prize: Number(job.coins),
            multiplier: Number(job.wagerMultiplier) || 0,
          };
          try {
            const result = await payout.sendOneWinner({
              round,
              groupName: isCompletePetCampaign
                ? `${groupNames[product] || product}完全體達成活動`
                : `${groupNames[product] || product}賽季`,
              item: { aid: job.aid, nickname: job.tgId },
            });
            if (result?.status === '已派獎') {
              await cloud.completeSeasonPayout({ exchangeId: job.exchangeId, status: 'sent', note: '既有平台郵件派獎完成' });
            } else if (result?.status === '派獎失敗') {
              await cloud.completeSeasonPayout({ exchangeId: job.exchangeId, status: 'failed', note: result.note || '既有派獎器回報失敗；請人工核對平台信箱' });
            } else {
              // payout ledger controls its own safe retry timing for known pre-submit failures.
              await cloud.completeSeasonPayout({ exchangeId: job.exchangeId, status: 'pending', note: '待既有派獎器安全重試' });
            }
            processed++;
          } catch (error) {
            log.warn?.(`[season-payout] exchange ${job.exchangeId} remains recoverable: ${error.message}`);
            // Leave processing leased. A crash before send is recovered after the lease;
            // a send already completed is deduped by payout-ledger on the next pass.
            break;
          }
        }
      }
      return { processed };
    } catch (error) {
      log.warn?.(`[season-payout] queue sync failed: ${error.message}`);
      return { processed, error: error.message };
    } finally {
      running = false;
    }
  }

  return { syncSeasonPayouts };
}
