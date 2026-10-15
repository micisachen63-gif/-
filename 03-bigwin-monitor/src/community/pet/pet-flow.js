// Pet interaction workflows: Group Play, PvP Challenges, Boss Controls, and Admin Configuration.
import { taipeiDay, PRODUCTS, formatPetName, BOSS_DURATION_MS } from './rules.js';
import { makePvpAnimation } from './pvp-animation.js';

export function createPetFlow({ store, bossManager, cfg, send, sendAnimation = null, createAnimation = makePvpAnimation, edit = null, answer, del, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console, botUsername = () => '', isGroupAdmin = async () => false }) {
  const playInvites = new Map(); // id -> { id, key, initiatorTgId, initiatorName, createdAt, expiresAt }
  const pvpInvites = new Map(); // id -> { id, key, challengerTgId, challengerName, createdAt, expiresAt }
  const adminSetupState = new Map(); // adminTgId -> { key, step, tempSchedule }

  const INVITE_EXPIRE_MS = 10 * 60_000;

  function defaultBossSchedule(key) {
    return { id: `sched_${key}`, enabled: false, times: ['20:00'], time: '20:00', dropMin: 10, dropMax: 20, maxHp: 500 };
  }

  function normalizeBossSchedule(schedule, key) {
    const times = Array.isArray(schedule.times) ? schedule.times : [schedule.time || '20:00'];
    schedule.times = [...new Set(times.filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)))].sort();
    if (!schedule.lastTriggeredByTime || typeof schedule.lastTriggeredByTime !== 'object' || Array.isArray(schedule.lastTriggeredByTime)) {
      schedule.lastTriggeredByTime = {};
    }
    if (schedule.lastTriggerDay && schedule.time && !schedule.lastTriggeredByTime[schedule.time]) {
      schedule.lastTriggeredByTime[schedule.time] = schedule.lastTriggerDay;
    }
    schedule.time = schedule.times[0] || '20:00'; // Keep the legacy field for older state readers.
    schedule.id ||= `sched_${key}`;
    schedule.dropMin ||= 10;
    schedule.dropMax ||= 20;
    schedule.maxHp ||= 500;
    return schedule;
  }

  function scheduleTimesConflict(times, candidate) {
    const toMinutes = (value) => {
      const [hour, minute] = value.split(':').map(Number);
      return hour * 60 + minute;
    };
    const proposed = toMinutes(candidate);
    const requiredGap = Math.ceil(BOSS_DURATION_MS / 60_000);
    return times.find((time) => {
      const directGap = Math.abs(proposed - toMinutes(time));
      return Math.min(directGap, 1440 - directGap) < requiredGap;
    });
  }

  function pruneInvites() {
    const t = now();
    for (const [id, inv] of playInvites.entries()) {
      if (t > inv.expiresAt) playInvites.delete(id);
    }
    for (const [id, inv] of pvpInvites.entries()) {
      if (t > inv.expiresAt) pvpInvites.delete(id);
    }
  }

  // ---------- Group Play ----------
  async function startPlayInvite(cq, key) {
    const user = cq.from;
    const tgId = String(user.id);
    const pet = await store.refreshAccount(key, tgId);
    if (!pet) {
      return answer(cq, '❌ 你尚未開啟寵物，請先到私訊開啟寵物！', true);
    }
    if (pet.pet.life !== 'alive') {
      return answer(cq, '❌ 寵物已死亡，無法發起玩耍', true);
    }
    const today = taipeiDay(now());
    if (pet.pet.lastPlayDay === today) {
      return answer(cq, '❗ 你今天已經領取過玩耍獎勵囉（每日限一次）', true);
    }

    const inviteId = `play_${now()}_${Math.random().toString(36).slice(2, 6)}`;
    const petFullName = formatPetName(key, pet.pet);
    playInvites.set(inviteId, {
      id: inviteId,
      key,
      initiatorTgId: tgId,
      initiatorName: petFullName,
      initiatorPetName: petFullName,
      createdAt: now(),
      expiresAt: now() + INVITE_EXPIRE_MS,
    });

    const text = [
      `🎾 【寵物玩耍邀請】 🎾`,
      `「${petFullName}」向群組夥伴發起玩耍邀請！`,
      `• 只要另一位存活寵物玩家接受，雙方各得 1 寵物點數 ＋ 8 心情`,
      `• 每日每個帳號限領一次獎勵`,
      `（有效時間 10 分鐘）`,
    ].join('\n');

    const markup = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🤝 接受玩耍', callback_data: `mg:pet:play_acc:${inviteId}` }],
        ],
      },
    };

    await answer(cq, '玩耍邀請已發出！');
    const chatId = cfg.groups[key]?.chatId;
    if (chatId) await send(chatId, text, markup);
  }

  async function acceptPlayInvite(cq, key, inviteId) {
    pruneInvites();
    const inv = playInvites.get(inviteId);
    if (!inv) {
      return answer(cq, '此玩耍邀請已過期或已被接受', true);
    }

    const user = cq.from;
    const tgId = String(user.id);
    if (tgId === inv.initiatorTgId) {
      return answer(cq, '不能自己接受自己的玩耍邀請喔', true);
    }

    const pet = await store.refreshAccount(key, tgId);
    if (!pet) {
      return answer(cq, '❌ 你尚未開啟寵物，請先至私訊開啟寵物！', true);
    }
    if (pet.pet.life !== 'alive') {
      return answer(cq, '❌ 寵物已死亡，無法玩耍', true);
    }

    const today = taipeiDay(now());
    if (pet.pet.lastPlayDay === today) {
      return answer(cq, '❗ 你今天已經領取過玩耍獎勵囉', true);
    }

    try {
      const res = await store.recordPlay({
        product: key,
        userAId: inv.initiatorTgId,
        userBId: tgId,
        day: today,
      });

      playInvites.delete(inviteId);
      const acceptorPet = await store.refreshAccount(key, tgId);
      const acceptorPetName = formatPetName(key, acceptorPet?.pet);
      await answer(cq, '🎉 玩耍成功！各得 1 點數與 8 心情！', true);

      const chatId = cfg.groups[key]?.chatId;
      if (chatId) {
        await send(
          chatId,
          `✨ 【玩耍大成功】\n「${inv.initiatorPetName}」與「${acceptorPetName}」開心地玩耍在一起！\n雙方各獲得 ＋1 寵物點數 與 ＋8 心情值！`
        );
      }
    } catch (e) {
      return answer(cq, `❌ 玩耍失敗：${e.message}`, true);
    }
  }

  // ---------- PvP Challenges ----------
  async function startPvPChallenge(cq, key) {
    const user = cq.from;
    const tgId = String(user.id);
    const pet = await store.refreshAccount(key, tgId);
    if (!pet) {
      return answer(cq, '❌ 你尚未開啟寵物，請先到私訊開啟寵物！', true);
    }
    if (pet.pet.life !== 'alive') {
      return answer(cq, '❌ 寵物已死亡，無法發起對戰', true);
    }

    const challengeId = `pvp_${now()}_${Math.random().toString(36).slice(2, 6)}`;
    const petFullName = formatPetName(key, pet.pet);
    pvpInvites.set(challengeId, {
      id: challengeId,
      key,
      challengerTgId: tgId,
      challengerName: petFullName,
      challengerPetName: petFullName,
      createdAt: now(),
      expiresAt: now() + INVITE_EXPIRE_MS,
    });

    const text = [
      `⚔️ 【寵物對戰擂台】 ⚔️`,
      `「${petFullName}」在群組擂台發起挑戰！`,
      `• 雙方寵物將進行回合制戰鬥，比拼戰力與狀態！`,
      `• 勝負將記入戰報（每位對手每日首場計入排行榜戰績）`,
      `• 敗方有 10% 機率掉落一件身上裝備，勝方獲得該裝備；平手不掉裝備。`,
      `（有效時間 10 分鐘）`,
    ].join('\n');

    const markup = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛡️ 應戰！', callback_data: `mg:pet:pvp_acc:${challengeId}` }],
        ],
      },
    };

    await answer(cq, '對戰戰帖已發出！');
    const chatId = cfg.groups[key]?.chatId;
    if (chatId) await send(chatId, text, markup);
  }

  async function acceptPvPChallenge(cq, key, challengeId) {
    pruneInvites();
    const inv = pvpInvites.get(challengeId);
    if (!inv) {
      return answer(cq, '此挑戰已過期或已結束', true);
    }

    const user = cq.from;
    const tgId = String(user.id);
    if (tgId === inv.challengerTgId) {
      return answer(cq, '不能自己應戰自己喔', true);
    }

    const pet = await store.refreshAccount(key, tgId);
    if (!pet) {
      return answer(cq, '❌ 你尚未開啟寵物，請先至私訊開啟寵物！', true);
    }
    if (pet.pet.life !== 'alive') {
      return answer(cq, '❌ 寵物已死亡，無法應戰', true);
    }

    try {
      const today = taipeiDay(now());
      const res = await store.recordPvP({
        product: key,
        userAId: inv.challengerTgId,
        userBId: tgId,
        day: today,
      });

      pvpInvites.delete(challengeId);
      const challengerAcc = await store.refreshAccount(key, inv.challengerTgId);
      const pAFullName = inv.challengerPetName || formatPetName(key, challengerAcc?.pet);
      const pBFullName = formatPetName(key, pet.pet);

      const winnerName = res.winner === 'a' ? pAFullName : res.winner === 'b' ? pBFullName : '雙方平手';

      const roundTexts = res.rounds.map(
        (r) => `第 ${r.round} 回合：${pAFullName} (${r.pA}) vs ${pBFullName} (${r.pB}) ➔ ${r.winner === 'draw' ? '平手' : r.winner === 'a' ? `${pAFullName} 得分` : `${pBFullName} 得分`}`
      );

      let ptsLine = '';
      if (res.ranked) {
        if (res.winner === 'a') {
          ptsLine = `📈 賽季天梯積分：${pAFullName} +${res.deltaWin ?? 10} ➔ ${res.aPoints ?? 100} 分 ｜ ${pBFullName} -${res.deltaLose ?? 8} ➔ ${res.bPoints ?? 100} 分`;
        } else if (res.winner === 'b') {
          ptsLine = `📈 賽季天梯積分：${pBFullName} +${res.deltaWin ?? 10} ➔ ${res.bPoints ?? 100} 分 ｜ ${pAFullName} -${res.deltaLose ?? 8} ➔ ${res.aPoints ?? 100} 分`;
        } else {
          ptsLine = `📈 賽季天梯積分：雙方平手，積分不變（${pAFullName}: ${res.aPoints ?? 100} 分 ｜ ${pBFullName}: ${res.bPoints ?? 100} 分）`;
        }
      }

      let rankNote = '';
      if (res.ranked) {
        rankNote = '📊 戰績已正式記入每日天梯排行榜！';
      } else if (res.seasonOpen === false) {
        rankNote = '🌟 友誼休閒賽（目前非季賽開放期間，不計天梯積分）';
      } else {
        rankNote = '🤝 友誼對抗賽（今日已交手過，不重複計分）';
      }

      const lines = [
        `🏆 【寵物對戰結果】 🏆`,
        `⚔️ 對戰雙方：${pAFullName} vs ${pBFullName}`,
        ...roundTexts,
        `\n🥇 最終勝利：${winnerName}！`,
        rankNote,
      ];
      if (res.droppedEquipment) {
        const receiver = res.winner === 'a' ? pAFullName : pBFullName;
        const loser = res.winner === 'a' ? pBFullName : pAFullName;
        const tierNames = { common: '一般', advanced: '高級', epic: '極品', legendary: '傳說', supreme: '霸主' };
        const tier = tierNames[res.droppedEquipment.elementTier || res.droppedEquipment.element_tier] || '一般';
        lines.push(`💥 ${loser} 掉落【${res.droppedEquipment.name}（${tier}）】，由 ${receiver} 獲得！`);
      }
      if (ptsLine) lines.push(ptsLine);

      await answer(cq, `對戰結束！獲勝者：${winnerName}`);
      const chatId = cfg.groups[key]?.chatId;
      let animationDurationMs = 0;
      if (chatId && sendAnimation) {
        try {
          const animation = await createAnimation({
            product: key,
            aStage: challengerAcc?.pet?.stage,
            bStage: pet.pet.stage,
            rounds: res.rounds,
            winner: res.winner,
          });
          await sendAnimation({
            chatId,
            buffer: animation.buffer,
            mimeType: 'image/gif',
            fileName: 'pet-pvp-battle.gif',
            caption: `⚔️ 寵物對戰動畫｜${pAFullName} VS ${pBFullName}`,
          });
          animationDurationMs = Number(animation.durationMs) || 0;
        } catch (error) {
          log.warn?.(`PvP animation send failed: ${error.message}`);
        }
      }
      if (animationDurationMs) await sleep(animationDurationMs + 350);
      if (chatId) await send(chatId, lines.join('\n'));
    } catch (e) {
      return answer(cq, `❌ 對戰計算失敗：${e.message}`, true);
    }
  }

  // ---------- Admin BOSS Setup Console ----------
  async function presentBossPanel(cq, adminId, text, markup) {
    const message = cq?.message;
    if (message?.chat?.type === 'private' && message.message_id && edit) {
      try {
        await edit(message.chat.id, message.message_id, text, markup);
        return;
      } catch (error) {
        log.warn?.(`BOSS admin panel edit failed; sending a new panel: ${error.message}`);
      }
    }
    await send(adminId, text, markup);
  }

  async function showAdminBossPanel(cq, key, adminId, notice = '') {
    const sched = normalizeBossSchedule(store.getBossSchedule(key) || defaultBossSchedule(key), key);

    const gname = cfg.groups[key]?.name || key;
    const timeText = sched.times.length ? sched.times.join('、') : '未設定';
    const lines = [
      `👹 【BOSS 出現設定】｜${gname}`,
      `• 排程狀態：${sched.enabled ? '🟢 已啟用' : '🔴 已停用'}`,
      `• 每日出現時間（台北）：${timeText}`,
      `• 進化石掉落區間：${sched.dropMin} ～ ${sched.dropMax} 顆`,
      `• 下一場首領生命：${sched.maxHp.toLocaleString()} HP`,
      `• 目前每場最多 30 分鐘，同一群組不會同時出現兩隻 BOSS。`,
      `• 500 HP 粗估約 9 隻初始幼體打滿攻擊次數；人數會隨成長與裝備變動。`,
      notice ? `\n✅ ${notice}` : '',
      `\n點按下方按鈕即可調整：`,
    ];

    const timeRows = sched.times.length
      ? sched.times.map((time) => [{ text: `🗑 移除 ${time}`, callback_data: `mg:pet:boss_rm:${key}:${time.replace(':', '')}` }])
      : [[{ text: '尚未設定時段', callback_data: `mg:pet:boss_time:${key}` }]];
    const markup = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: sched.enabled ? '🔴 停用排程' : '🟢 啟用排程', callback_data: `mg:pet:boss_tgl:${key}` },
            { text: '➕ 新增每日時段', callback_data: `mg:pet:boss_time:${key}` },
          ],
          [
            { text: '💎 變更掉落區間', callback_data: `mg:pet:boss_drop:${key}` },
            { text: '❤️ 變更生命值', callback_data: `mg:pet:boss_hp:${key}` },
          ],
          [
            { text: '👾 立即測試生成一場', callback_data: `mg:pet:boss_test:${key}` },
          ],
          ...timeRows,
          [{ text: '🔙 返回管理面板', callback_data: 'mg:p:adm' }],
        ],
      },
    };

    if (cq?.id) await answer(cq, notice);
    await presentBossPanel(cq, adminId, lines.join('\n'), markup);
  }

  async function showBossChoicePanel(cq, key, adminId, title, rows) {
    const text = `👹 【BOSS 設定】｜${cfg.groups[key]?.name || key}\n${title}\n\n點選選項後會立即套用：`;
    const markup = { reply_markup: { inline_keyboard: [...rows, [{ text: '↩️ 回 BOSS 設定', callback_data: `mg:pet:boss:${key}` }]] } };
    await presentBossPanel(cq, adminId, text, markup);
  }

  async function handleAdminBossCallback(cq, act, key, arg = '') {
    const adminId = cq.from.id;
    const sched = normalizeBossSchedule(store.getBossSchedule(key) || defaultBossSchedule(key), key);

    if (act === 'tgl') {
      if (!sched.enabled && !sched.times.length) {
        await answer(cq, '請先新增至少一個每日出現時段，再啟用排程。', true);
        return showAdminBossPanel(null, key, adminId);
      }
      sched.enabled = !sched.enabled;
      await store.saveBossSchedule(key, sched);
      return showAdminBossPanel(cq, key, adminId, `已${sched.enabled ? '啟用' : '停用'}每日排程`);
    }

    if (act === 'rm') {
      const encodedTime = String(arg || '');
      const time = /^(?:[01]\d|2[0-3])[0-5]\d$/.test(encodedTime)
        ? `${encodedTime.slice(0, 2)}:${encodedTime.slice(2)}`
        : null;
      if (!time || !sched.times.includes(time)) {
        await answer(cq, '找不到這個 BOSS 時段，請重新整理設定面板。', true);
        return showAdminBossPanel(cq, key, adminId);
      }
      sched.times = sched.times.filter((value) => value !== time);
      sched.time = sched.times[0] || '20:00';
      if (!sched.times.length) sched.enabled = false;
      await store.saveBossSchedule(key, sched);
      return showAdminBossPanel(cq, key, adminId, `已移除每日 ${time} 的時段`);
    }

    if (act === 'time') {
      await answer(cq);
      const choices = ['08:00', '12:00', '16:00', '18:00', '20:00', '22:00'];
      const rows = [];
      for (let i = 0; i < choices.length; i += 2) {
        rows.push(choices.slice(i, i + 2).map((time) => ({ text: `➕ ${time}`, callback_data: `mg:pet:boss_timeadd:${key}:${time.replace(':', '')}` })));
      }
      return showBossChoicePanel(cq, key, adminId, `新增每日時段（台北時間）。場次至少間隔 30 分鐘；目前：${sched.times.join('、') || '尚無'}`, [
        ...rows,
        [{ text: '⌨️ 自訂時間', callback_data: `mg:pet:boss_timecustom:${key}` }],
      ]);
    }

    if (act === 'drop') {
      await answer(cq);
      return showBossChoicePanel(cq, key, adminId, `選擇每場進化石總掉落區間（目前 ${sched.dropMin}～${sched.dropMax} 顆）`, [
        ...[[1, 5], [6, 10], [11, 20], [21, 50], [51, 100]].map(([min, max], index, all) => index % 2 === 0
          ? [[min, max], all[index + 1]].filter(Boolean).map(([lo, hi]) => ({ text: `💎 ${lo}～${hi}`, callback_data: `mg:pet:boss_dropset:${key}:${lo}-${hi}` }))
          : null).filter(Boolean),
        [{ text: '⌨️ 自訂區間', callback_data: `mg:pet:boss_dropcustom:${key}` }],
      ]);
    }

    if (act === 'hp') {
      await answer(cq);
      return showBossChoicePanel(cq, key, adminId, `選擇下一場生命值（目前 ${sched.maxHp.toLocaleString()} HP）`, [
        ...[500, 1000, 2500, 5000, 10000, 25000, 50000, 100000].reduce((rows, hp, index) => {
          if (index % 2 === 0) rows.push([]);
          rows[rows.length - 1].push({ text: `❤️ ${hp.toLocaleString()}`, callback_data: `mg:pet:boss_hpset:${key}:${hp}` });
          return rows;
        }, []),
        [{ text: '⌨️ 自訂生命值', callback_data: `mg:pet:boss_hpcustom:${key}` }],
      ]);
    }

    if (act === 'timeadd') {
      const time = /^(?:[01]\d|2[0-3])[0-5]\d$/.test(String(arg)) ? `${arg.slice(0, 2)}:${arg.slice(2)}` : null;
      const conflict = time && (sched.times.includes(time) ? time : scheduleTimesConflict(sched.times, time));
      if (!time || conflict) {
        await answer(cq, conflict === time ? `${time} 已經在排程裡。` : `距離 ${conflict} 不足 30 分鐘。`, true);
        return showAdminBossPanel(cq, key, adminId);
      }
      sched.times = [...sched.times, time].sort();
      sched.time = sched.times[0];
      await store.saveBossSchedule(key, sched);
      return showAdminBossPanel(cq, key, adminId, `已新增每日 ${time}`);
    }

    if (act === 'dropset') {
      const match = /^(\d+)-(\d+)$/.exec(String(arg));
      const min = Number(match?.[1]); const max = Number(match?.[2]);
      if (!match || min < 1 || max > 500 || min > max) {
        await answer(cq, '這個掉落區間不正確。', true);
        return showAdminBossPanel(cq, key, adminId);
      }
      sched.dropMin = min; sched.dropMax = max;
      await store.saveBossSchedule(key, sched);
      return showAdminBossPanel(cq, key, adminId, `已更新掉落區間為 ${min}～${max} 顆`);
    }

    if (act === 'hpset') {
      const hp = Number(arg);
      if (!Number.isSafeInteger(hp) || hp < 100 || hp > 1_000_000_000) {
        await answer(cq, '生命值需介於 100～1,000,000,000。', true);
        return showAdminBossPanel(cq, key, adminId);
      }
      sched.maxHp = hp;
      await store.saveBossSchedule(key, sched);
      return showAdminBossPanel(cq, key, adminId, `下一場生命值已設為 ${hp.toLocaleString()} HP`);
    }

    if (act === 'timecustom' || act === 'dropcustom' || act === 'hpcustom') {
      const step = act === 'timecustom' ? 'time' : act === 'dropcustom' ? 'drop' : 'boss_hp';
      adminSetupState.set(adminId, { key, step });
      await answer(cq);
      const prompt = step === 'time'
        ? '輸入每日時間 HH:MM（台北時間，例如 12:30）。'
        : step === 'drop'
          ? '輸入每場總掉落區間，例如 10-20（1～500 顆）。'
          : `輸入下一場 BOSS HP（100～1,000,000,000）。目前 ${sched.maxHp.toLocaleString()} HP。`;
      return showBossChoicePanel(cq, key, adminId, `⌨️ ${prompt}`, [[{ text: '✍️ 請在聊天中輸入數值', callback_data: `mg:pet:boss:${key}` }]]);
    }

    if (act === 'test') {
      await answer(cq, '正在釋放測試 BOSS……');
      const boss = await bossManager.spawnBoss(key, {
        dropMin: sched.dropMin,
        dropMax: sched.dropMax,
        maxHp: sched.maxHp,
      });
      if (boss) {
        return send(adminId, `✅ 已成功在 ${cfg.groups[key]?.name || key} 生成測試 BOSS：${boss.bossName}！`);
      } else {
        return send(adminId, `❌ 生成失敗：請確認群組 chatId 是否正確綁定。`);
      }
    }
  }

  async function handleAdminText(msg, text) {
    const adminId = msg.from.id;
    const state = adminSetupState.get(adminId);
    if (!state) return false;

    const { key, step } = state;
    if (!await isGroupAdmin(key, adminId)) {
      adminSetupState.delete(adminId);
      await send(adminId, `管理權限已失效，請回【${cfg.groups[key]?.name || key}】社群確認管理員身分後再操作。`);
      return true;
    }
    const sched = normalizeBossSchedule(store.getBossSchedule(key) || defaultBossSchedule(key), key);

    if (step === 'time') {
      const match = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/.exec(text.trim());
      if (!match) {
        await send(adminId, '時間格式不正確，請輸入 HH:MM（例如 20:00）：');
        return true;
      }
      const timeStr = `${match[1].padStart(2, '0')}:${match[2]}`;
      if (sched.times.includes(timeStr)) {
        await send(adminId, `每日 ${timeStr} 已經在排程裡。請輸入另一個時間：`);
        return true;
      }
      const conflict = scheduleTimesConflict(sched.times, timeStr);
      if (conflict) {
        await send(adminId, `每日 ${timeStr} 距離既有時段 ${conflict} 不足 30 分鐘；每場 BOSS 最長 30 分鐘，請選至少相隔 30 分鐘的時段：`);
        return true;
      }
      sched.times = [...sched.times, timeStr].sort();
      sched.time = sched.times[0];
      await store.saveBossSchedule(key, sched);
      adminSetupState.delete(adminId);
      await send(adminId, `✅ 已新增 ${cfg.groups[key]?.name || key} 每日 ${timeStr} 的 BOSS 時段！目前排程：${sched.times.join('、')}`);
      await showAdminBossPanel(null, key, adminId);
      return true;
    }

    if (step === 'boss_hp') {
      const raw = text.trim().replaceAll(',', '');
      const hp = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(hp) || hp < 100 || hp > 1_000_000_000) {
        await send(adminId, '生命值格式不正確，請輸入 100～1,000,000,000 的整數，例如 50000：');
        return true;
      }
      sched.maxHp = hp;
      await store.saveBossSchedule(key, sched);
      adminSetupState.delete(adminId);
      await send(adminId, `✅ 已將 ${cfg.groups[key]?.name || key} 的下一場 BOSS 生命值設為 ${hp.toLocaleString()} HP。`);
      await showAdminBossPanel(null, key, adminId);
      return true;
    }

    if (step === 'drop') {
      const match = /^(\d+)\s*[-~～至到]\s*(\d+)$/.exec(text.trim());
      if (!match) {
        await send(adminId, '格式不正確，請輸入「最小值-最大值」（例如 10-25）：');
        return true;
      }
      const min = Number(match[1]);
      const max = Number(match[2]);
      if (min > max || min < 1 || max > 500) {
        await send(adminId, '數值範圍不合理（需 1 <= 最小 <= 最大 <= 500），請重新輸入：');
        return true;
      }
      sched.dropMin = min;
      sched.dropMax = max;
      await store.saveBossSchedule(key, sched);
      adminSetupState.delete(adminId);
      await send(adminId, `✅ 已將 ${cfg.groups[key]?.name || key} 的進化石掉落區間設為 ${min} ～ ${max} 顆！`);
      await showAdminBossPanel(null, key, adminId);
      return true;
    }

    if (step === 'season_time') {
      const parts = text.trim().split('|');
      if (parts.length !== 2) {
        await send(adminId, '格式不正確，請以「|」分隔開始與結束時間（例如 2026-10-07 00:00|2026-10-14 23:59）：');
        return true;
      }
      const [startTime, endTime] = parts.map((s) => s.trim());
      const cur = state.season || {};
      await store.saveSeasonConfig(key, { ...cur, startTime, endTime });
      adminSetupState.delete(adminId);
      await send(adminId, `✅ 已成功更新賽季時間！\n開始：${startTime}\n結束：${endTime}`);
      await showAdminSeasonPanel(null, key, adminId);
      return true;
    }

    if (step === 'season_coin') {
      const num = parseInt(text.trim(), 10);
      if (isNaN(num) || num <= 0) {
        await send(adminId, '請輸入有效的正整數金幣數量（例如 100）：');
        return true;
      }
      const cur = state.season || {};
      await store.saveSeasonConfig(key, { ...cur, badgeToCoin: num });
      adminSetupState.delete(adminId);
      await send(adminId, `✅ 已將 1 賽季勳章兌換金幣調整為：${num} 金幣！`);
      await showAdminSeasonPanel(null, key, adminId);
      return true;
    }

    if (step === 'season_wager') {
      const num = parseFloat(text.trim());
      if (isNaN(num) || num < 0) {
        await send(adminId, '請輸入有效的流水倍數（例如 1 或 0）：');
        return true;
      }
      const cur = state.season || {};
      await store.saveSeasonConfig(key, { ...cur, wagerMultiplier: num });
      adminSetupState.delete(adminId);
      await send(adminId, `✅ 已將金幣獎勵流水倍數調整為：${num} 倍！`);
      await showAdminSeasonPanel(null, key, adminId);
      return true;
    }

    if (step === 'season_rewards') {
      const nums = text.trim().split(/[,，\s]+/).map((n) => parseInt(n, 10));
      if (nums.length !== 10 || nums.some((n) => isNaN(n) || n < 0)) {
        await send(adminId, '請輸入 10 個由大到小的正整數（例如 100,70,50,40,30,20,15,10,8,5）：');
        return true;
      }
      const cur = state.season || {};
      await store.saveSeasonConfig(key, { ...cur, rewards: nums });
      adminSetupState.delete(adminId);
      await send(adminId, `✅ 已成功更新前 10 名勳章分配：[${nums.join(', ')}]！`);
      await showAdminSeasonPanel(null, key, adminId);
      return true;
    }

    return false;
  }

  // ---------- Season Ladder Rankings ----------
  async function showSeasonRankings(cq, key, targetChatId = null) {
    try {
      const res = await store.getSeasonRankings(key);
      const season = res?.season || {};
      const rankings = res?.rankings || [];
      const gname = cfg.groups[key]?.name || key;

      const rankMedals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      const rankLines = rankings.length > 0
        ? rankings.map((r, i) => {
            const medal = rankMedals[i] || `${i + 1}.`;
            const badgeReward = r.badgeReward != null ? ` ➔ 預計獎勵 ${r.badgeReward} 勳章` : '';
            return `${medal} ${r.nickname || '玩家'}（${r.points} 分）${badgeReward}`;
          })
        : ['目前尚無天梯對戰紀錄，所有玩家初始皆為 100 分！'];
      const hasSeason = !!(season.id || season.title || season.status);

      const text = [
        hasSeason ? `🏆 【${season.title || '社群季賽天梯爭霸榜'}】｜${gname}` : `🏆 【社群天梯】｜${gname}`,
        hasSeason
          ? `📅 賽季時間：${season.startTime || season.start_time || '待設定'} ～ ${season.endTime || season.end_time || '待設定'}`
          : '目前尚無管理員開啟的賽季。賽季由管理員設定並啟動後才會開始。',
        ...(hasSeason ? [`💰 結算兌換：1 賽季勳章 ＝ ${season.badgeToCoin || season.badge_to_coin || 100} 贏麻金幣（${season.wagerMultiplier || season.wager_multiplier || 1} 倍流水）`] : []),
        `\n🌟 【目前排名前 10 強】`,
        ...rankLines,
        `\n💡 初始積分皆為 100 分，每日首場群組 PvP 對戰獲勝 +10 分、戰敗 -8 分！`,
        ...(hasSeason ? ['季賽結算後前 10 名發放專屬勳章，可於寵物介面兌換贏麻金幣獎勵！'] : []),
      ].join('\n');

      const destination = targetChatId || cq?.message?.chat?.id || cfg.groups[key]?.chatId;
      const markup = Number(destination) > 0 ? {
        reply_markup: { inline_keyboard: [[{
          text: '🐾 開啟我的寵物 (查看個人積分)',
          web_app: { url: `${(cfg.petMiniAppUrl || 'https://minigame-pet-api.micisachen.workers.dev').replace(/\/$/, '')}/?product=${encodeURIComponent(key)}` },
        }]] },
      } : {};

      if (cq?.id) await answer(cq);
      const dest = targetChatId || (cq?.message?.chat?.id) || cfg.groups[key]?.chatId;
      if (dest) await send(dest, text, markup);
    } catch (e) {
      if (cq?.id) await answer(cq, `載入排行榜失敗：${e.message}`, true);
    }
  }

  // ---------- Admin Season Setup Console ----------
  async function showAdminSeasonPanel(cq, key, adminId) {
    let season = null;
    try {
      const res = await store.getSeasonConfig(key);
      season = res?.season;
    } catch (e) {
      log.warn(`getSeasonConfig failed: ${e.message}`);
    }
    season ||= {
      title: '尚未設定賽季',
      startTime: '',
      endTime: '',
      badgeToCoin: 100,
      wagerMultiplier: 1,
      rewards: [100, 70, 50, 40, 30, 20, 15, 10, 8, 5],
      status: 'draft',
    };

    const gname = cfg.groups[key]?.name || key;
    const rewardsStr = Array.isArray(season.rewards) ? season.rewards.join(', ') : '100, 70, 50...';
    const lines = [
      `🏆 【季賽天梯管理設置】｜${gname}`,
      `• 賽季標題：${season.title}`,
      `• 賽季起訖：${season.startTime} ～ ${season.endTime}`,
      `• 當前狀態：${({ active: '🟢 進行中', scheduled: '🕒 已排程', draft: '⚪ 草稿（尚未啟動）', settled: '🏁 已結算' })[season.status] || '⚪ 草稿（尚未啟動）'}`,
      `• 勳章金幣匯率：1 賽季勳章 ＝ ${season.badgeToCoin} 贏麻金幣`,
      `• 獎勵流水倍數：${season.wagerMultiplier} 倍流水`,
      `• 前 10 名勳章分配：[${rewardsStr}]`,
      `\n請選擇要設定的項目：`,
    ];

    const markup = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📅 變更賽季起訖時間', callback_data: `mg:pet:season_time:${key}` },
            { text: '🪙 變更勳章金幣匯率', callback_data: `mg:pet:season_coin:${key}` },
          ],
          [
            { text: '🎰 變更獎勵流水倍數', callback_data: `mg:pet:season_wager:${key}` },
            { text: '🎖 變更前10名獎勵數量', callback_data: `mg:pet:season_rewards:${key}` },
          ],
          [{ text: season.status === 'scheduled' ? '🕒 已排程（等待開始）' : '✅ 管理員開啟／排程賽季', callback_data: `mg:pet:season_activate:${key}` }],
          [
            { text: '🏁 立即結算派獎（結算本季）', callback_data: `mg:pet:season_settle:${key}` },
            { text: '📊 檢視目前天梯排行', callback_data: `mg:pet:season_view:${key}` },
          ],
          [{ text: '🔙 返回管理控制台', callback_data: 'mg:p:adm' }],
        ],
      },
    };

    if (cq?.id) await answer(cq);
    await send(adminId, lines.join('\n'), markup);
  }

  async function handleAdminSeasonCallback(cq, act, key) {
    const adminId = cq.from.id;
    let season = null;
    try {
      const cfgRes = await store.getSeasonConfig(key);
      season = cfgRes?.season;
    } catch {}
    season ||= {
      title: '尚未設定賽季',
      startTime: '',
      endTime: '',
      badgeToCoin: 100,
      wagerMultiplier: 1,
      rewards: [100, 70, 50, 40, 30, 20, 15, 10, 8, 5],
      status: 'draft',
    };

    if (act === 'time') {
      adminSetupState.set(adminId, { key, step: 'season_time', season });
      await answer(cq);
      return send(adminId, `請輸入賽季開始與結束時間（台北時間，格式：YYYY-MM-DD HH:MM|YYYY-MM-DD HH:MM）\n例如：\n2026-10-07 00:00|2026-10-14 23:59`);
    }

    if (act === 'coin') {
      adminSetupState.set(adminId, { key, step: 'season_coin', season });
      await answer(cq);
      return send(adminId, `請輸入 1 個賽季勳章可兌換多少贏麻了金幣（目前：${season.badgeToCoin}，請輸入正整數例如 100）：`);
    }

    if (act === 'wager') {
      adminSetupState.set(adminId, { key, step: 'season_wager', season });
      await answer(cq);
      return send(adminId, `請輸入金幣獎勵的流水倍數（目前：${season.wagerMultiplier} 倍，請輸入數字例如 1 或 2，若無流水請填 0）：`);
    }

    if (act === 'rewards') {
      adminSetupState.set(adminId, { key, step: 'season_rewards', season });
      await answer(cq);
      return send(adminId, `請輸入第 1 至 10 名發放的勳章數量（以逗號分隔，共 10 個數字）\n例如：\n100,70,50,40,30,20,15,10,8,5`);
    }

    if (act === 'view') {
      await answer(cq);
      return showSeasonRankings(cq, key, adminId);
    }

    if (act === 'activate') {
      await answer(cq, '正在啟動或排程賽季……');
      try {
        const res = await store.activateSeason(key);
        const message = res.status === 'scheduled'
          ? `🕒 賽季已排程，將於 ${res.startTime}（台北時間）開始，並於 ${res.endTime} 結束。`
          : `✅ 賽季已由管理員開啟，時間：${res.startTime} ～ ${res.endTime}（台北時間）。`;
        await send(adminId, message);
        return showAdminSeasonPanel(null, key, adminId);
      } catch (e) {
        return send(adminId, `❌ 無法啟動賽季：${e.message}`);
      }
    }

    if (act === 'settle') {
      await answer(cq, '正在執行季賽結算並派發勳章……');
      try {
        const res = await store.settleSeason(key, { force: true });
        const settled = res?.settled;
        const topWinners = res?.winners || settled?.topWinners || [];
        const winners = topWinners
          .map((w) => `• 第 ${w.rank} 名：${w.nickname || '玩家'}（${w.points}分）➔ 發放 ${w.badges} 勳章`)
          .join('\n');
        const text = [
          `🏁 【季賽結算完成】`,
          `本季代號：${res?.seasonId || settled?.seasonId || '當前賽季'}`,
          `結算人數：共 ${res?.settledCount ?? settled?.settledCount ?? 0} 位玩家`,
          `\n🎖 前 10 名得獎者與勳章派發：\n${winners || '無名次'}`,
          `\n🔄 全服玩家積分已重置回 100 分。新賽季不會自動開啟，須由管理員另行設定並啟動。`,
        ].join('\n');
        await send(adminId, text);
        const groupChatId = cfg.groups[key]?.chatId;
        if (groupChatId) {
          await send(groupChatId, `🎉 【社群季賽天梯正式結算】\n${winners}\n\n🏆 恭喜以上得獎夥伴！勳章已存入各位的寵物背包，可至 Mini App 兌換金幣！全服積分已重置為 100 分；新賽季須由管理員設定並啟動。`);
        }
        return showAdminSeasonPanel(null, key, adminId);
      } catch (e) {
        return send(adminId, `❌ 結算失敗：${e.message}`);
      }
    }
  }

  return {
    startPlayInvite,
    acceptPlayInvite,
    startPvPChallenge,
    acceptPvPChallenge,
    showAdminBossPanel,
    handleAdminBossCallback,
    showSeasonRankings,
    showAdminSeasonPanel,
    handleAdminSeasonCallback,
    handleAdminText,
    pruneInvites,
  };
}
