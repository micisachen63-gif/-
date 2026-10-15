// Boss schedule management and battle coordinator.
import fs from 'node:fs';
import path from 'node:path';
import {
  BOSS_DURATION_MS,
  ATTACK_COOLDOWN_MS,
  taipeiDay,
  formatPetName,
  BOSS_ELEMENT_DATA,
  randomBossElement,
  ELEMENTS,
} from './rules.js';

export function createBossManager({ store, cfg, send, sendPhoto = null, answer = () => {}, del, editMessage, now = Date.now, log = console, random = Math.random }) {
  const activeMessages = new Map(); // product -> messageId
  const lastCountdownMinute = new Map();
  const lastPublicStateSignature = new Map();
  const bossAssetDir = path.resolve(import.meta.dirname, '../../../cloudflare/public/assets');
  const bossAssetBaseUrl = cfg.petMiniAppUrl || 'https://minigame-pet-api.micisachen.workers.dev';
  const bossImages = new Map();
  for (const [element, data] of Object.entries(BOSS_ELEMENT_DATA)) {
    const imagePath = path.join(bossAssetDir, data.image);
    try { bossImages.set(element, fs.readFileSync(imagePath)); }
    catch (error) { log.error?.(`BOSS image missing for ${element} (${imagePath}): ${error.message}`); }
  }

  function taipeiHourMin(ms = now()) {
    const d = new Date(ms + 8 * 3600e3);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function getGroupChatId(product) {
    return cfg.groups?.[product]?.chatId || null;
  }

  function getGroupName(product) {
    return cfg.groups?.[product]?.name || product;
  }

  function bossProgressBar(current, max, length = 10) {
    const pct = Math.max(0, Math.min(1, current / max));
    const filled = Math.round(pct * length);
    const bar = '🟥'.repeat(filled) + '⬜'.repeat(length - filled);
    return `${bar} ${current}/${max} (${Math.round(pct * 100)}%)`;
  }

  function remainingMinuteBucket(boss) {
    return Math.max(0, Math.ceil((Number(boss.expiresAt) - now()) / 60000));
  }

  function announcementText(boss, { recovered = false, finished = false } = {}) {
    const expireMin = Math.round(BOSS_DURATION_MS / 60000);
    const elemObj = ELEMENTS[boss.element] || ELEMENTS.fire;
    return [
      finished ? (boss.status === 'defeated' ? `🎉 【全服 BOSS 討伐成功】 🎉` : `⌛ 【全服 BOSS 討伐已結束】 ⌛`) : recovered ? `🖼️ 【BOSS 戰況補圖】 🖼️` : `🚨 【全服 BOSS 降臨】 🚨`,
      `👾 首領名稱：${boss.bossName}`,
      `🌟 屬性弱點：此 BOSS 為【${elemObj.icon} ${elemObj.name}屬性】！裝備相剋武器可爆發 +25% 傷害！`,
      `❤️ 生命值：${bossProgressBar(boss.currentHp, boss.maxHp)}`,
      `💎 進化石掉落區間：${boss.dropMin} ～ ${boss.dropMax} 顆`,
      `⏱️ 討伐時限：${expireMin} 分鐘（限本群存活寵物參戰）`,
      ...(!finished ? [`⌛ 剩餘時間：${remainingMinuteBucket(boss)} 分鐘`] : []),
      `⚔️ 攻擊冷卻：每位玩家每 5 分鐘可攻擊一次`,
      recovered ? `\n此圖片公告補上目前進行中的討伐戰況。` : finished ? `\n本場討伐已結束！感謝各位勇士熱情參戰！` : `\n請各位召喚師穿上最強裝備、派出寵物，擊退巨獸！`,
    ].join('\n');
  }

  async function rememberAnnouncement(product, boss, msg, isPhoto) {
    if (!msg?.message_id) return;
    activeMessages.set(product, { messageId: msg.message_id, isPhoto });
    if (boss.status === 'active') lastCountdownMinute.set(product, remainingMinuteBucket(boss));
    await store.saveBossAnnouncement?.({ product, bossId: boss.id, messageId: msg.message_id, isPhoto });
  }

  async function postBossPhoto(product, boss, { recovered = false } = {}) {
    const chatId = getGroupChatId(product);
    const replyMarkup = { inline_keyboard: [[{ text: '⚔️ 發動攻擊！', callback_data: `mg:pet:boss_atk:${boss.id}` }]] };
    const caption = announcementText(boss, { recovered });
    const bossData = BOSS_ELEMENT_DATA[boss.element] || BOSS_ELEMENT_DATA.fire;
    const bossImage = bossImages.get(boss.element);
    const bossImageUrl = new URL(`/assets/${bossData.image}`, bossAssetBaseUrl).toString();
    if (sendPhoto && bossImage) {
      try {
        const msg = await sendPhoto({ chatId, buffer: bossImage, mimeType: 'image/png', fileName: 'boss.png', caption, replyMarkup });
        await rememberAnnouncement(product, boss, msg, true);
        log.info?.(`BOSS ${boss.element} image posted for ${product} (message ${msg?.message_id || 'unknown'}, ${bossImage.length} bytes)`);
        return msg;
      } catch (error) {
        log.warn?.(`BOSS ${boss.element} photo upload failed for ${product}; retrying from hosted asset: ${error.message}`);
        try {
          const msg = await sendPhoto({ chatId, photoUrl: bossImageUrl, caption, replyMarkup });
          await rememberAnnouncement(product, boss, msg, true);
          log.info?.(`BOSS ${boss.element} hosted image posted for ${product} (message ${msg?.message_id || 'unknown'})`);
          return msg;
        } catch (urlError) {
          log.error?.(`BOSS ${boss.element} image send failed for ${product} from both local and hosted assets: ${urlError.message}`);
        }
      }
    } else if (!bossImage) {
      log.error?.(`No matching BOSS image loaded for ${boss.element} (${bossData.name})`);
    }
    const msg = await send(chatId, caption, { reply_markup: replyMarkup });
    await rememberAnnouncement(product, boss, msg, false);
    return msg;
  }

  async function restoreActiveAnnouncements() {
    for (const [product, group] of Object.entries(cfg.groups || {})) {
      if (!group?.chatId) continue;
      const boss = store.getActiveBoss(product);
      if (!boss || boss.status !== 'active' || now() >= boss.expiresAt) continue;
      if (boss.announcementMessageId) {
        activeMessages.set(product, { messageId: boss.announcementMessageId, isPhoto: Boolean(boss.announcementIsPhoto) });
        lastCountdownMinute.set(product, remainingMinuteBucket(boss));
        continue;
      }
      try {
        await postBossPhoto(product, boss, { recovered: true });
      } catch (error) {
        log.error?.(`Failed to restore active BOSS announcement for ${product}: ${error.message}`);
      }
    }
  }

  async function spawnBoss(product, { maxHp = 500, dropMin = 10, dropMax = 20, scheduleId = null } = {}) {
    const chatId = getGroupChatId(product);
    if (!chatId) return null;

    const cur = store.getActiveBoss(product);
    if (cur && cur.status === 'active') {
      log.info?.(`Boss for ${product} is already active (${cur.id})`);
      return cur;
    }

    // 6 屬性完全隨機召喚，管理員無法指定
    const element = randomBossElement(random);
    const bossData = BOSS_ELEMENT_DATA[element] || BOSS_ELEMENT_DATA.fire;
    const name = bossData.title;

    const boss = await store.createBossInstance({
      product,
      scheduleId,
      bossName: name,
      element,
      maxHp,
      dropMin,
      dropMax,
    });

    try {
      await postBossPhoto(product, boss);
      const msg = activeMessages.get(product);
      if (msg?.messageId) {
        return boss;
      }
    } catch (e) {
      log.error?.(`Failed to send boss announcement to ${chatId}: ${e.message}`);
    }

    return boss;
  }

  async function updateBossAnnouncement(product, boss, finished = false) {
    if (!editMessage || !boss) return;
    const activeMessage = activeMessages.get(product);
    const msgId = typeof activeMessage === 'object' ? activeMessage.messageId : activeMessage;
    const chatId = getGroupChatId(product);
    if (!msgId || !chatId) return;

    const text = announcementText(boss, { finished });

    const markup = {
      reply_markup: {
        inline_keyboard: finished
          ? [[{ text: '🏁 討伐已結束', callback_data: 'mg:pet:boss_ended' }]]
          : [[{ text: '⚔️ 發動攻擊！', callback_data: `mg:pet:boss_atk:${boss.id}` }]],
      },
    };

    try {
      await editMessage(chatId, msgId, text, markup, { isPhoto: Boolean(activeMessage?.isPhoto) });
      if (!finished && boss.status === 'active') lastCountdownMinute.set(product, remainingMinuteBucket(boss));
    } catch (e) {
      log.warn?.(`Failed to update boss message: ${e.message}`);
      if (!finished && boss.status === 'active') lastCountdownMinute.set(product, remainingMinuteBucket(boss));
    }
  }

  async function refreshCountdowns() {
    for (const product of Object.keys(cfg.groups || {})) {
      const boss = store.getActiveBoss(product);
      if (!boss || boss.status !== 'active' || now() >= boss.expiresAt) continue;
      if (!activeMessages.has(product)) continue;
      const minute = remainingMinuteBucket(boss);
      if (lastCountdownMinute.get(product) === minute) continue;
      await updateBossAnnouncement(product, boss, false);
    }
  }

  async function handleAttack(cq, product, bossId) {
    const user = cq.from;
    const tgId = String(user.id);
    const day = taipeiDay(now());

    try {
      await store.refreshAccount(product, tgId);
      const res = await store.attackBoss({ product, bossId, tgId, day });
      const boss = store.getActiveBoss(product);
      const pet = store.getAccount(product, tgId);
      const petFullName = formatPetName(product, pet?.pet);

      if (res.defeated) {
        await store.syncBossAwards(product);
        await updateBossAnnouncement(product, { ...boss, currentHp: 0, status: 'defeated' }, true);
        activeMessages.delete(product);

        // BOSS 擊敗公告
        const settlement = res.settlement;
        const totalDamage = settlement.totalDamage;
        const totalStones = settlement.totalStones;

        const allocEntries = Object.entries(settlement.allocation)
          .filter(([, count]) => count > 0)
          .sort(([, a], [, b]) => b - a);

        const lines = [
          `🎉 【首領已被討伐！】 🎉`,
          `👾 首領 ${boss.bossName} 已被全體勇士擊敗！`,
          `💥 全場總傷害：${totalDamage}`,
          `💎 本場掉落進化石總數：${totalStones} 顆`,
          `\n🏆 進化石按傷害占比分配名單：`,
        ];

        for (const [uid, count] of allocEntries) {
          await store.refreshAccount(product, uid).catch(() => null);
          const uAcc = store.getAccount(product, uid);
          const dmg = boss.userDamage[uid] || 0;
          const pct = Math.round((dmg / totalDamage) * 100);
          const uPetName = formatPetName(product, uAcc?.pet);
          lines.push(`• ${uPetName}｜造成 ${dmg} 傷害 (${pct}%) ➔ 獲贈 ${count} 顆進化石`);
        }

        const unrewarded = Object.entries(boss.userDamage).filter(([uid]) => !settlement.allocation[uid]);
        if (unrewarded.length > 0) {
          lines.push(`\n（部分傷害較低參戰者因整數分配獲得 0 顆進化石）`);
        }
        lines.push(`\n獎勵已自動記入個人寵物帳本，可至 Mini App 查看！`);

        const chatId = getGroupChatId(product);
        if (chatId) {
          await send(chatId, lines.join('\n'));
        }
        await answer(cq, `💥 你的「${petFullName}」給予最後一擊，造成 ${res.damage} 傷害！首領已陣亡！`, true);
        return { alert: true, text: `💥 造成 ${res.damage} 傷害！恭喜給予最後一擊，BOSS 已被討伐！` };
      }

      await updateBossAnnouncement(product, { ...boss, currentHp: res.bossHp }, false);
      await answer(cq, `⚔️ 你的「${petFullName}」對 ${boss.bossName} 造成 ${res.damage} 傷害！\nBOSS 剩餘血量：${res.bossHp}/${res.maxHp}\n冷卻中（5 分鐘後可再攻擊）`, true);
      return {
        alert: true,
        text: `⚔️ 你的「${petFullName}」對 ${boss.bossName} 造成 ${res.damage} 傷害！\nBOSS 剩餘血量：${res.bossHp}/${res.maxHp}\n冷卻中（5 分鐘後可再攻擊）`,
      };
    } catch (e) {
      await answer(cq, `❌ ${e.message}`, true);
      return { alert: true, text: `❌ ${e.message}` };
    }
  }

  async function checkSchedules() {
    const currentHm = taipeiHourMin();
    const today = taipeiDay(now());
    const currentMinute = Number(currentHm.slice(0, 2)) * 60 + Number(currentHm.slice(3));

    for (const [key, group] of Object.entries(cfg.groups || {})) {
      if (!group?.chatId) continue;
      const sched = store.getBossSchedule(key);
      if (!sched || !sched.enabled) continue;
      const times = [...new Set((Array.isArray(sched.times) ? sched.times : [sched.time]).filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)))].sort();
      if (!times.length) continue;

      const lastTriggeredByTime = { ...(sched.lastTriggeredByTime || {}) };
      let migrated = !Array.isArray(sched.times);
      // Migrate the legacy one-time-per-day marker without suppressing newly added slots.
      if (sched.lastTriggerDay && sched.time && !lastTriggeredByTime[sched.time]) {
        lastTriggeredByTime[sched.time] = sched.lastTriggerDay;
        migrated = true;
      }
      if (migrated) {
        sched.times = times;
        sched.lastTriggeredByTime = lastTriggeredByTime;
        await store.saveBossSchedule(key, sched);
      }
      const dueTimes = times.filter((time) => {
        const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
        const minutesLate = currentMinute - minute;
        return minutesLate >= 0 && lastTriggeredByTime[time] !== today;
      });
      if (!dueTimes.length) continue;

      // One active encounter is supported per group. Due slots remain pending while a
      // previous BOSS is active, then are released one at a time in schedule order.
      const activeBoss = store.getActiveBoss(key);
      if (activeBoss?.status === 'active') continue;

      const dueTime = dueTimes[0];
      log.info?.(`Triggering boss schedule for ${key} at ${dueTime} (checked ${currentHm})`);
      lastTriggeredByTime[dueTime] = today;
      sched.times = times;
      sched.lastTriggeredByTime = Object.fromEntries(
        Object.entries(lastTriggeredByTime).filter(([, day]) => day === today)
      );
      await store.saveBossSchedule(key, sched);
      await spawnBoss(key, {
        dropMin: sched.dropMin || 10,
        dropMax: sched.dropMax || 20,
        maxHp: sched.maxHp || 500,
        scheduleId: `${sched.id || 'daily'}:${dueTime.replace(':', '')}`,
      });
    }
  }

  async function syncPublicBossState() {
    if (!store.syncBossPublicState) return;
    for (const key of Object.keys(cfg.groups || {})) {
      const schedule = store.getBossSchedule(key) || { enabled: false, times: [] };
      const current = store.getActiveBoss(key);
      const activeBoss = current?.status === 'active' && Number(current.expiresAt) > now() ? current : null;
      // Boss HP changes on every attack; only publish schedule / appearance transitions.
      const signature = JSON.stringify({
        enabled: Boolean(schedule.enabled),
        times: schedule.times || [],
        lastTriggeredByTime: schedule.lastTriggeredByTime || {},
        active: activeBoss ? {
          id: activeBoss.id,
          bossName: activeBoss.bossName,
          element: activeBoss.element,
          startedAt: activeBoss.startedAt,
          expiresAt: activeBoss.expiresAt,
        } : null,
      });
      if (signature === lastPublicStateSignature.get(key)) continue;
      try {
        await store.syncBossPublicState(key);
        lastPublicStateSignature.set(key, signature);
      } catch (error) {
        log.warn?.(`BOSS public state sync failed for ${key}: ${error.message}`);
      }
    }
  }

  async function checkTimeouts() {
    for (const key of Object.keys(cfg.groups || {})) {
      const boss = store.getActiveBoss(key);
      if (!boss || (boss.status !== 'active' && !(boss.status === 'expired' && !boss.timeoutNotifiedAt))) continue;
      if (boss.status === 'active' && now() < boss.expiresAt) continue;

      const chatId = getGroupChatId(key);
      if (!chatId) continue;
      const timeoutRes = await store.settleBossTimeout({ product: key, bossId: boss.id });
      if (!timeoutRes) continue;

      const damageEntries = Object.entries(timeoutRes.damageByUser || {})
        .sort((a, b) => b[1] - a[1]);
      const lines = [
        `⌛ 【BOSS 討伐結果】`,
        `⏱️ ${boss.bossName} 出現已滿 30 分鐘，討伐時間結束！`,
        `💨 首領未被擊敗，剩餘生命：${timeoutRes.currentHp}/${timeoutRes.maxHp}`,
        `⚔️ 本場總傷害：${timeoutRes.totalDamage}｜參戰玩家：${timeoutRes.participants} 人`,
      ];
      if (damageEntries.length) {
        lines.push('', '🏅 傷害貢獻排行：');
        for (const [uid, damage] of damageEntries.slice(0, 10)) {
          await store.refreshAccount(key, uid).catch(() => null);
          const acc = store.getAccount(key, uid);
          const attacks = timeoutRes.attackCountByUser?.[uid] || 0;
          const pct = timeoutRes.totalDamage ? Math.round((damage / timeoutRes.totalDamage) * 100) : 0;
          const name = formatPetName(key, acc?.pet);
          lines.push(`• ${name}｜${damage} 傷害（${pct}%／${attacks} 次攻擊）`);
        }
        if (damageEntries.length > 10) lines.push(`（另有 ${damageEntries.length - 10} 位參戰者）`);
      } else {
        lines.push('', '本場沒有玩家參戰。');
      }
      lines.push('', '未擊敗 BOSS 不掉落進化石。');

      // Telegram message text limit is 4096 characters; keep a safe margin.
      let message = lines.join('\n');
      if (message.length > 3800) message = `${message.slice(0, 3770)}…\n（排行內容已截短）`;
      await send(chatId, message);
      await updateBossAnnouncement(key, { ...boss, currentHp: timeoutRes.currentHp, status: 'expired' }, true);
      activeMessages.delete(key);
      await store.markBossTimeoutAnnounced({ product: key, bossId: boss.id });
    }
  }

  async function tick() {
    for (const key of Object.keys(cfg.groups || {})) {
      try { await store.syncBossAwards(key); } catch (e) { log.warn?.(`BOSS reward sync pending for ${key}: ${e.message}`); }
    }
    try {
      await checkTimeouts();
      await checkSchedules();
      await refreshCountdowns();
      await syncPublicBossState();
    } catch (e) {
      log.warn?.(`bossManager tick error: ${e.message}`);
    }
  }

  return {
    spawnBoss,
    handleAttack,
    tick,
    restoreActiveAnnouncements,
  };
}
