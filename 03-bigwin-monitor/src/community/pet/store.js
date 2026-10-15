// Pet state store & transaction ledger.
// Provides thread-safe / serialized transactional updates and idempotent ledger recording.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../util.js';
import {
  openPet,
  creditWager,
  advancePet,
  buyItem,
  useItem,
  tryEvolve,
  reviveOrRebirth,
  playTogether,
  resolvePvP,
  damageFor,
  allocateStones,
  taipeiDay,
  careStatus,
  PRODUCTS,
  ATTACK_COOLDOWN_MS,
  BOSS_DURATION_MS,
  EQUIP_TEMPLATES,
  EQUIP_TYPES,
  SAFE_LEVELS,
  ELEMENT_KEYS,
  ELEMENT_TIERS,
  ELEMENTS,
  rollEquipmentTier,
  formatEquipmentName,
  calcEquipmentStat,
  tryEnhanceEquipment,
  randomBossElement,
} from './rules.js';

export function createPetStore({ filePath, log = console, now = Date.now, random = Math.random, cloud = null }) {
  let data = {
    accounts: {}, // `${product}:${tgId}` -> account
    aidOwners: {}, // `${product}:${aid}` -> tgId
    ledger: {}, // eventId -> transaction record
    bossSchedules: {}, // product -> schedule
    bossInstances: {}, // product -> boss instance
    equipment: {}, // `${product}:${tgId}` -> Array of equipment
    forgeReactions: {}, // `${product}:${eventId}` -> per-user reaction votes
  };

  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      data = {
        accounts: raw.accounts || {},
        aidOwners: raw.aidOwners || {},
        ledger: raw.ledger || {},
        bossSchedules: raw.bossSchedules || {},
        bossInstances: raw.bossInstances || {},
        equipment: raw.equipment || {},
        forgeReactions: raw.forgeReactions || {},
      };
    } catch (e) {
      log.warn?.(`Failed to load pet store from ${filePath}: ${e.message}`);
    }
  }

  let writeChain = Promise.resolve();
  function save() {
    writeChain = writeChain.then(async () => {
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        writeJsonAtomic(filePath, data);
      } catch (e) {
        log.error?.(`Failed to save pet store to ${filePath}: ${e.message}`);
      }
    });
    return writeChain;
  }

  let queue = Promise.resolve();
  function locked(fn) {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  }

  const accountKey = (product, tgId) => `${product}:${tgId}`;
  const aidKey = (product, aid) => `${product}:${aid}`;

  function recordLedger(entry) {
    const rec = {
      id: `tx_${now()}_${Math.random().toString(36).slice(2, 8)}`,
      at: now(),
      ...entry,
    };
    if (entry.eventId) {
      data.ledger[entry.eventId] = rec;
    }
    return rec;
  }

  return {
    data,
    save,

    async refreshAccount(product, tgId) {
      if (!cloud) return this.getAccount(product, tgId);
      const res = await cloud.account(product, tgId);
      const row = res?.pet;
      const key = accountKey(product, tgId);
      if (!row) {
        delete data.accounts[key];
        return null;
      }
      const acc = {
        product, tgId: String(tgId), aid: row.aid, openedAt: row.opened_at, openedDay: row.opened_day,
        points: row.points, stones: row.stones, wagerRemainder: row.wager_remainder,
        inventory: { training: 0, food: 0, clean: 0, weapon_scroll: 0, armor_scroll: 0, reroll_scroll: 0 },
        equipped: res.equipped || [],
        pet: {
          platformNickname: row.platform_nickname || row.platformNickname || null,
          life: row.life, growth: row.growth, stage: row.stage, evolution: row.evolution,
          attack: row.attack, food: row.food, clean: row.clean, mood: row.mood,
          lastCareDay: row.last_care_day, lastStatusDay: row.last_status_day,
          lastTrainingDay: row.last_training_day, lastPlayDay: row.last_play_day,
          lastDailyBonusDay: row.last_daily_bonus_day || null,
          lastLoginBonusDay: row.last_login_bonus_day || null,
          seasonPoints: row.season_points ?? 100,
          seasonBadges: row.season_badges ?? 0,
          rebirths: row.rebirths, deaths: row.deaths,
          variantTitle: row.variant_title, variantTrait: row.variant_trait,
          variantAttr: row.variant_attr, evoTitle: row.evo_title, evoTrait: row.evo_trait,
        },
        pvp: { wins: row.pvp_wins, losses: row.pvp_losses, pvpToday: {} },
      };
      data.accounts[key] = acc;
      data.aidOwners[aidKey(product, row.aid)] = String(tgId);
      return acc;
    },

    getAccount(product, tgId) {
      const acc = data.accounts[accountKey(product, tgId)];
      if (!acc) return null;
      advancePet(acc, taipeiDay(now()));
      return acc;
    },

    getAccountByAid(product, aid) {
      const tgId = data.aidOwners[aidKey(product, aid)];
      if (!tgId) return null;
      return this.getAccount(product, tgId);
    },

    listAccounts(product) {
      return Object.values(data.accounts).filter((a) => a.product === product);
    },


    async openPetAccount({ product, tgId, aid, baseline, at = now() }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        if (data.accounts[k]) {
          throw new Error('此社群已開啟過寵物');
        }
        const ak = aidKey(product, aid);
        const existingOwner = data.aidOwners[ak];
        if (existingOwner && existingOwner !== String(tgId)) {
          throw new Error(`AID ${aid} 已被其他玩家的寵物綁定`);
        }

        const account = openPet({ product, tgId, aid, baseline, at });
        data.accounts[k] = account;
        data.aidOwners[ak] = String(tgId);

        recordLedger({
          eventId: `open:${product}:${tgId}:${aid}`,
          product,
          tgId: String(tgId),
          aid: String(aid),
          type: '開啟寵物',
          deltaPoints: 0,
          deltaStones: 0,
          pointsAfter: 0,
          stonesAfter: 0,
          note: `基準有效投注：${baseline}`,
        });

        await save();
        return account;
      });
    },

    async creditWager({ product, tgId, day = taipeiDay(now()), total, eventId = null }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        const account = data.accounts[k];
        if (!account) throw new Error('找不到寵物');

        const eid = eventId || `wager:${product}:${account.aid}:${day}:${total}`;
        if (data.ledger[eid]) {
          return { ...data.ledger[eid].result, duplicate: true };
        }

        advancePet(account, day);
        const res = creditWager(account, { day, total });

        if (res.awarded > 0) {
          recordLedger({
            eventId: eid,
            product,
            tgId: String(tgId),
            aid: account.aid,
            type: '打碼入點',
            deltaPoints: res.awarded,
            deltaStones: 0,
            pointsAfter: account.points,
            stonesAfter: account.stones,
            note: `打碼增量：${res.delta}，當日總額：${total}，餘額暫存：${account.wagerRemainder}`,
            result: res,
          });
        }

        await save();
        return res;
      });
    },

    async buyItem({ product, tgId, item, quantity = 1, day = taipeiDay(now()), eventId = null }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        const account = data.accounts[k];
        if (!account) throw new Error('找不到寵物');

        const eid = eventId || `buy:${product}:${tgId}:${item}:${now()}`;
        if (data.ledger[eid]) {
          return { ...data.ledger[eid].result, duplicate: true };
        }

        const res = buyItem(account, item, quantity, day);
        recordLedger({
          eventId: eid,
          product,
          tgId: String(tgId),
          aid: account.aid,
          type: '購買道具',
          deltaPoints: -res.cost,
          deltaStones: 0,
          pointsAfter: account.points,
          stonesAfter: account.stones,
          note: `購買 ${res.item} x${quantity}`,
          result: res,
        });

        await save();
        return res;
      });
    },

    async useItem({ product, tgId, item, day = taipeiDay(now()), eventId = null }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        const account = data.accounts[k];
        if (!account) throw new Error('找不到寵物');

        const eid = eventId || `use:${product}:${tgId}:${item}:${now()}`;
        if (data.ledger[eid]) {
          return { ...data.ledger[eid].result, duplicate: true };
        }

        const res = useItem(account, item, day);
        recordLedger({
          eventId: eid,
          product,
          tgId: String(tgId),
          aid: account.aid,
          type: '使用道具',
          deltaPoints: 0,
          deltaStones: 0,
          pointsAfter: account.points,
          stonesAfter: account.stones,
          note: `使用 ${res.item}`,
          result: res,
        });

        await save();
        return res;
      });
    },

    async tryEvolve({ product, tgId, roll = null, day = taipeiDay(now()), eventId = null }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        const account = data.accounts[k];
        if (!account) throw new Error('找不到寵物');

        const eid = eventId || `evolve:${product}:${tgId}:${account.pet.evolution}:${now()}`;
        if (data.ledger[eid]) {
          return { ...data.ledger[eid].result, duplicate: true };
        }

        const r = roll ?? random();
        const res = tryEvolve(account, r, day);

        recordLedger({
          eventId: eid,
          product,
          tgId: String(tgId),
          aid: account.aid,
          type: '進化嘗試',
          deltaPoints: 0,
          deltaStones: -res.cost,
          pointsAfter: account.points,
          stonesAfter: account.stones,
          note: res.success ? `成功進化至第 ${res.evolution} 階！` : `進化失敗，消耗 ${res.cost} 顆進化石`,
          result: res,
        });

        await save();
        return res;
      });
    },

    async reviveOrRebirth({ product, tgId, day = taipeiDay(now()), eventId = null, action = null }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        const account = data.accounts[k];
        if (!account) throw new Error('找不到寵物');

        const eid = eventId || `revive:${product}:${tgId}:${now()}`;
        if (data.ledger[eid]) {
          return { ...data.ledger[eid].result, duplicate: true };
        }

        const wasEvolved = (account.pet?.evolution || 0) > 0;
        const res = reviveOrRebirth(account, day, { action });

        recordLedger({
          eventId: eid,
          product,
          tgId: String(tgId),
          aid: account.aid,
          type: res.action === 'revived' ? '寵物復活' : '重新養成',
          deltaPoints: -res.cost,
          deltaStones: 0,
          pointsAfter: account.points,
          stonesAfter: account.stones,
          note: res.action === 'revived' ? '花費 10 點復活' : (wasEvolved ? '放棄進化重新養成' : '從未進化死亡後重新養成'),
          result: res,
        });

        await save();
        return res;
      });
    },

    async recordPlay({ product, userAId, userBId, day = taipeiDay(now()), eventId = null }) {
      if (cloud) {
        const result = await cloud.play({ product, userAId: String(userAId), userBId: String(userBId), day });
        await Promise.all([this.refreshAccount(product, userAId), this.refreshAccount(product, userBId)]);
        return result;
      }
      return locked(async () => {
        const a = data.accounts[accountKey(product, userAId)];
        const b = data.accounts[accountKey(product, userBId)];
        if (!a || !b) throw new Error('雙方必須都已開啟寵物');

        const sortedIds = [String(userAId), String(userBId)].sort();
        const eid = eventId || `play:${product}:${day}:${sortedIds[0]}:${sortedIds[1]}`;
        if (data.ledger[eid]) {
          return { ...data.ledger[eid].result, duplicate: true };
        }

        const res = playTogether(a, b, day);

        recordLedger({
          eventId: eid,
          product,
          tgId: `${a.tgId},${b.tgId}`,
          aid: `${a.aid},${b.aid}`,
          type: '玩耍獎勵',
          deltaPoints: 1,
          deltaStones: 0,
          pointsAfter: a.points,
          stonesAfter: a.stones,
          note: `玩耍互助成功，雙方各得 1 點與 8 心情`,
          result: res,
        });

        await save();
        return res;
      });
    },

    async recordPvP({ product, userAId, userBId, day = taipeiDay(now()), rolls = null, eventId = null }) {
      if (cloud) {
        const a = await this.refreshAccount(product, userAId);
        const b = await this.refreshAccount(product, userBId);
        if (!a || !b) throw new Error('雙方必須都已開啟寵物');
        const aEquip = a.equipped || this.getEquipped(product, userAId);
        const bEquip = b.equipped || this.getEquipped(product, userBId);
        const result = resolvePvP(structuredClone(a), structuredClone(b), {
          day,
          rolls: rolls ?? [random(), random(), random(), random(), random(), random()],
          aEquipment: aEquip,
          bEquipment: bEquip,
        });
        const remote = await cloud.pvp({ product, userAId: String(userAId), userBId: String(userBId), day, winner: result.winner, rounds: result.rounds, matchId: eventId || `pvp_${product}_${userAId}_${userBId}_${now()}` });
        result.ranked = remote.ranked;
        result.seasonOpen = remote.seasonOpen;
        result.deltaWin = remote.deltaWin;
        result.deltaLose = remote.deltaLose;
        result.aPoints = remote.aPoints;
        result.bPoints = remote.bPoints;
        result.droppedEquipment = remote.droppedEquipment || null;
        await Promise.all([this.refreshAccount(product, userAId), this.refreshAccount(product, userBId)]);
        return result;
      }
      return locked(async () => {
        const a = data.accounts[accountKey(product, userAId)];
        const b = data.accounts[accountKey(product, userBId)];
        if (!a || !b) throw new Error('雙方必須都已開啟寵物');

        const eid = eventId || `pvp:${product}:${userAId}:${userBId}:${now()}`;
        if (data.ledger[eid]) {
          return { ...data.ledger[eid].result, duplicate: true };
        }

        const chosenRolls = rolls ?? [random(), random(), random(), random(), random(), random()];
        const aEquip = a.equipped || this.getEquipped(product, userAId);
        const bEquip = b.equipped || this.getEquipped(product, userBId);
        const res = resolvePvP(a, b, { day, rolls: chosenRolls, aEquipment: aEquip, bEquipment: bEquip });

        if (res.winner !== 'draw' && random() < 0.1) {
          const loser = res.winner === 'a' ? b : a;
          const winner = res.winner === 'a' ? a : b;
          const loserKey = accountKey(product, loser.tgId);
          const winnerKey = accountKey(product, winner.tgId);
          const loserItems = (data.equipment[loserKey] || loser.equipment || [])
            .filter((item) => item.is_equipped === 1 || item.is_equipped === true);
          if (loserItems.length) {
            const dropped = loserItems[Math.floor(random() * loserItems.length)];
            const source = data.equipment[loserKey] || loser.equipment;
            const itemIndex = source.findIndex((candidate) => candidate.id === dropped.id);
            const [item] = source.splice(itemIndex, 1);
            item.tg_id = winner.tgId;
            item.is_equipped = 0;
            data.equipment[winnerKey] ||= winner.equipment || [];
            if (!data.equipment[winnerKey].some((candidate) => candidate.id === item.id)) data.equipment[winnerKey].push(item);
            if (loser.equipped) loser.equipped = loser.equipped.filter((candidate) => candidate.id !== item.id);
            if (winner.equipped) winner.equipped = winner.equipped.filter((candidate) => candidate.id !== item.id);
            res.droppedEquipment = structuredClone(item);
          }
        }

        recordLedger({
          eventId: eid,
          product,
          tgId: `${a.tgId},${b.tgId}`,
          aid: `${a.aid},${b.aid}`,
          type: '玩家對戰',
          deltaPoints: 0,
          deltaStones: 0,
          pointsAfter: a.points,
          stonesAfter: a.stones,
          note: `對戰結果：${res.winner} 勝出 (是否記入戰報：${res.ranked})`,
          result: res,
        });

        await save();
        return res;
      });
    },

    getLedger(product, tgId, limit = 50) {
      const records = Object.values(data.ledger).filter((r) => r.product === product && String(r.tgId).includes(String(tgId)));
      records.sort((a, b) => b.at - a.at);
      return records.slice(0, limit);
    },

    // ---------- Boss Scheduling & State ----------
    getBossSchedule(product) {
      return data.bossSchedules[product] || null;
    },

    async saveBossSchedule(product, schedule) {
      return locked(async () => {
        data.bossSchedules[product] = schedule;
        await save();
        return schedule;
      });
    },

    getActiveBoss(product) {
      return data.bossInstances[product] || null;
    },

    async syncBossPublicState(product) {
      if (!cloud?.syncBossState) return null;
      const schedule = this.getBossSchedule(product) || { enabled: false, times: [] };
      const boss = this.getActiveBoss(product);
      return cloud.syncBossState({ product, schedule, activeBoss: boss?.status === 'active' ? boss : null });
    },

    async saveBossAnnouncement({ product, bossId, messageId, isPhoto }) {
      return locked(async () => {
        const boss = data.bossInstances[product];
        if (!boss || boss.id !== bossId) return null;
        boss.announcementMessageId = Number(messageId);
        boss.announcementIsPhoto = Boolean(isPhoto);
        await save();
        return boss;
      });
    },

    async syncBossAwards(product) {
      if (!cloud) return;
      const boss = data.bossInstances[product];
      if (!boss || boss.status !== 'defeated' || !boss.stoneAllocation) return;
      boss.cloudAwarded ||= {};
      for (const [tgId, stones] of Object.entries(boss.stoneAllocation)) {
        if (stones < 1 || boss.cloudAwarded[tgId]) continue;
        await cloud.bossAward({ product, bossId: boss.id, tgId, stones });
        boss.cloudAwarded[tgId] = true;
        await save();
      }
    },

    async createBossInstance({ product, scheduleId = null, bossName = '遠古魔物', element = null, maxHp = 500, dropMin = 10, dropMax = 20 }) {
      return locked(async () => {
        const cur = data.bossInstances[product];
        if (cur && cur.status === 'active' && now() < cur.expiresAt) {
          return cur; // already running
        }

        const id = `boss_${product}_${now()}`;
        const bossElem = element || randomBossElement(random);
        const boss = {
          id,
          product,
          scheduleId,
          bossName,
          element: bossElem,
          maxHp,
          currentHp: maxHp,
          dropMin: Math.min(dropMin, dropMax),
          dropMax: Math.max(dropMin, dropMax),
          startedAt: now(),
          expiresAt: now() + BOSS_DURATION_MS,
          status: 'active',
          userDamage: {}, // tgId -> number
          userAttackCount: {}, // tgId -> number
          lastAttackAt: {}, // tgId -> timestamp
          attacks: [],
          settledAt: null,
          totalStonesAwarded: 0,
          stoneAllocation: {},
        };
        data.bossInstances[product] = boss;
        await save();
        return boss;
      });
    },

    async attackBoss({ product, bossId, tgId, day = taipeiDay(now()), roll = null }) {
      return locked(async () => {
        const boss = data.bossInstances[product];
        if (!boss || boss.id !== bossId) throw new Error('目前沒有進行中的 BOSS 場次');
        if (boss.status !== 'active') throw new Error(boss.status === 'defeated' ? 'BOSS 已被擊敗' : 'BOSS 已逾時結束');
        if (now() >= boss.expiresAt) {
          throw new Error('BOSS 戰鬥時間已結束');
        }

        const account = data.accounts[accountKey(product, tgId)];
        if (!account) throw new Error('你尚未開啟寵物');
        advancePet(account, day);
        if (account.pet.life !== 'alive') throw new Error('寵物已死亡，無法參戰');

        const lastAt = boss.lastAttackAt[String(tgId)] || 0;
        if (now() - lastAt < ATTACK_COOLDOWN_MS) {
          const waitSec = Math.ceil((ATTACK_COOLDOWN_MS - (now() - lastAt)) / 1000);
          throw new Error(`冷卻中，請等待 ${waitSec} 秒後再次攻擊`);
        }

        const r = roll ?? random();
        const equippedItems = account.equipped || this.getEquipped(product, tgId);
        const dmg = damageFor(account, r, day, { equippedItems, bossElement: boss.element });

        boss.currentHp = Math.max(0, boss.currentHp - dmg);
        boss.lastAttackAt[String(tgId)] = now();
        boss.userDamage[String(tgId)] = (boss.userDamage[String(tgId)] || 0) + dmg;
        boss.userAttackCount[String(tgId)] = (boss.userAttackCount[String(tgId)] || 0) + 1;

        boss.attacks.push({
          tgId: String(tgId),
          aid: account.aid,
          damage: dmg,
          at: now(),
        });

        let defeated = false;
        let settlement = null;
        if (boss.currentHp <= 0) {
          boss.status = 'defeated';
          boss.defeatedAt = now();
          defeated = true;
          settlement = this._settleBossInternal(boss);
        }

        await save();
        return {
          damage: dmg,
          bossHp: boss.currentHp,
          maxHp: boss.maxHp,
          defeated,
          settlement,
        };
      });
    },

    _settleBossInternal(boss) {
      if (boss.status !== 'defeated' || boss.settledAt) return null;
      boss.settledAt = now();

      const span = boss.dropMax - boss.dropMin;
      const totalStones = boss.dropMin + Math.floor(random() * (span + 1));
      boss.totalStonesAwarded = totalStones;

      const allocation = allocateStones(totalStones, boss.userDamage);
      boss.stoneAllocation = allocation;

      for (const [uid, count] of Object.entries(allocation)) {
        if (count > 0) {
          const acc = data.accounts[accountKey(boss.product, uid)];
          if (acc) {
            acc.stones += count;
            recordLedger({
              eventId: `boss_stone:${boss.id}:${uid}`,
              product: boss.product,
              tgId: uid,
              aid: acc.aid,
              type: 'BOSS掉落',
              deltaPoints: 0,
              deltaStones: count,
              pointsAfter: acc.points,
              stonesAfter: acc.stones,
              note: `BOSS ${boss.bossName} 討伐獎勵：造成傷害 ${boss.userDamage[uid]}，分配 ${count} 顆進化石`,
            });
          }
        }
      }

      return {
        totalStones,
        allocation,
        totalDamage: Object.values(boss.userDamage).reduce((s, v) => s + v, 0),
        participants: Object.keys(boss.userDamage).length,
      };
    },

    async settleBossTimeout({ product, bossId }) {
      return locked(async () => {
        const boss = data.bossInstances[product];
        if (!boss || boss.id !== bossId) return null;
        if (boss.status === 'active' && now() >= boss.expiresAt) {
          boss.status = 'expired';
          boss.expiredAt = now();
        }
        if (boss.status !== 'expired' || boss.timeoutNotifiedAt) return null;
        boss.timeoutResult ||= {
          status: 'expired',
          defeated: false,
          bossName: boss.bossName,
          currentHp: boss.currentHp,
          maxHp: boss.maxHp,
          totalDamage: Object.values(boss.userDamage || {}).reduce((sum, damage) => sum + damage, 0),
          participants: Object.keys(boss.userDamage || {}).length,
          damageByUser: { ...(boss.userDamage || {}) },
          attackCountByUser: { ...(boss.userAttackCount || {}) },
          totalStones: 0,
          allocation: {},
        };
        await save();
        return structuredClone(boss.timeoutResult);
      });
    },

    async markBossTimeoutAnnounced({ product, bossId }) {
      return locked(async () => {
        const boss = data.bossInstances[product];
        if (!boss || boss.id !== bossId || boss.status !== 'expired' || boss.timeoutNotifiedAt) return false;
        boss.timeoutNotifiedAt = now();
        await save();
        return true;
      });
    },

    async castForgeReaction({ product, eventId, tgId, reaction }) {
      if (!['lucky', 'awesome'].includes(reaction)) throw new Error('無效的互動按鈕');
      return locked(async () => {
        const cutoff = now() - 30 * 24 * 60 * 60_000;
        for (const [key, record] of Object.entries(data.forgeReactions)) {
          if ((record.createdAt || 0) < cutoff) delete data.forgeReactions[key];
        }
        const key = `${product}:${eventId}`;
        const record = data.forgeReactions[key] || (data.forgeReactions[key] = { createdAt: now(), votes: {} });
        record.votes ||= {};
        const voter = String(tgId);
        const previous = record.votes[voter];
        record.votes[voter] = reaction;
        const counts = Object.values(record.votes).reduce((out, value) => {
          if (value === 'lucky') out.lucky += 1;
          if (value === 'awesome') out.awesome += 1;
          return out;
        }, { lucky: 0, awesome: 0 });
        await save();
        return { ...counts, changed: previous !== reaction, reaction };
      });
    },

    // ---------- Equipment System (Local Store Support) ----------
    getEquipment(product, tgId) {
      const k = accountKey(product, tgId);
      return data.equipment[k] || [];
    },

    getEquipped(product, tgId) {
      const list = this.getEquipment(product, tgId);
      return list.filter((eq) => eq.is_equipped || eq.isEquipped);
    },

    async buyEquipment({ product, tgId, equipType }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        const acc = data.accounts[k];
        if (!acc) throw new Error('你尚未開啟寵物');
        if (acc.pet.life !== 'alive') throw new Error('寵物已死亡，無法購買裝備');
        const tmpl = EQUIP_TEMPLATES[equipType];
        if (!tmpl) throw new Error('未知裝備類型');
        if (acc.points < tmpl.cost) throw new Error('寵物點數不足');

        acc.points -= tmpl.cost;
        const element = ELEMENT_KEYS[Math.floor(random() * ELEMENT_KEYS.length)];
        const elementTier = 'common';
        const baseStat = tmpl.baseStatFixed || tmpl.baseStatMin;
        const elementStat = Math.max(1, Math.round(baseStat * 0.3));
        const equipId = `eq_${now()}_${Math.random().toString(36).slice(2, 7)}`;

        const item = {
          id: equipId,
          product,
          tg_id: String(tgId),
          equip_type: equipType,
          name: tmpl.name,
          enhance_level: 0,
          element,
          element_tier: elementTier,
          base_stat: baseStat,
          element_stat: elementStat,
          is_equipped: 0,
          bound: 0,
          trade_id: null,
          created_at: now(),
          updated_at: now(),
        };

        data.equipment[k] ||= [];
        data.equipment[k].push(item);

        recordLedger({
          eventId: `buy_eq:${product}:${tgId}:${equipId}`,
          product,
          tgId,
          aid: acc.aid,
          type: '購買裝備',
          deltaPoints: -tmpl.cost,
          deltaStones: 0,
          pointsAfter: acc.points,
          stonesAfter: acc.stones,
          note: `購買 ${tmpl.name} (${ELEMENT_TIERS[elementTier].name})`,
        });

        await save();
        return item;
      });
    },

    async equipItem({ product, tgId, equipId }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        const list = data.equipment[k] || [];
        const target = list.find((eq) => eq.id === equipId);
        if (!target) throw new Error('找不到該裝備');

        for (const eq of list) {
          if (eq.equip_type === target.equip_type) {
            eq.is_equipped = 0;
            eq.updated_at = now();
          }
        }
        target.is_equipped = 1;
        target.bound = 1;
        target.updated_at = now();
        await save();
        return target;
      });
    },

    async unequipItem({ product, tgId, equipId }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        const list = data.equipment[k] || [];
        const target = list.find((eq) => eq.id === equipId);
        if (!target) throw new Error('找不到該裝備');
        target.is_equipped = 0;
        target.updated_at = now();
        await save();
        return target;
      });
    },

    async unbindItem({ product, tgId, equipId }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        const acc = data.accounts[k];
        if (!acc) throw new Error('你尚未開啟寵物');
        const list = data.equipment[k] || [];
        const target = list.find((eq) => eq.id === equipId);
        if (!target) throw new Error('找不到該裝備');
        if (target.is_equipped) throw new Error('請先卸下裝備才能解綁');
        if (target.trade_id) throw new Error('裝備正在交易保管中，無法解綁');
        if (!target.bound) throw new Error('該裝備尚未綁定，無需解綁');
        acc.inventory ||= {};
        if ((acc.inventory.unbind_scroll || 0) < 1) throw new Error('缺少【解綁卷】');
        acc.inventory.unbind_scroll -= 1;
        target.bound = 0;
        target.updated_at = now();
        recordLedger({
          eventId: `unbind_eq:${product}:${tgId}:${equipId}:${now()}`,
          product,
          tgId,
          aid: acc.aid,
          type: '裝備解綁',
          deltaPoints: 0,
          deltaStones: 0,
          pointsAfter: acc.points,
          stonesAfter: acc.stones,
          note: `使用 1 張解綁卷解綁 ${target.name}`,
        });
        await save();
        return target;
      });
    },

    async enhanceItem({ product, tgId, equipId, roll = null }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        const acc = data.accounts[k];
        if (!acc) throw new Error('你尚未開啟寵物');
        const list = data.equipment[k] || [];
        const targetIdx = list.findIndex((eq) => eq.id === equipId);
        if (targetIdx === -1) throw new Error('查無該裝備');
        const item = list[targetIdx];

        const scrollKey = item.equip_type === 'weapon' ? 'weapon_scroll' : 'armor_scroll';
        acc.inventory ||= {};
        if ((acc.inventory[scrollKey] || 0) < 1) {
          throw new Error(`缺少【${scrollKey === 'weapon_scroll' ? '武器強化卷軸' : '防具強化卷軸'}】`);
        }
        acc.inventory[scrollKey] -= 1;

        const r = roll ?? random();
        const res = tryEnhanceEquipment(item, r);

        if (res.broken) {
          list.splice(targetIdx, 1);
          recordLedger({
            eventId: `enh:${product}:${tgId}:${equipId}:${now()}`,
            product,
            tgId,
            aid: acc.aid,
            type: '衝裝爆炸',
            deltaPoints: 0,
            deltaStones: 0,
            pointsAfter: acc.points,
            stonesAfter: acc.stones,
            note: `+${item.enhance_level} ${item.name} 衝裝失敗爆炸消失！`,
          });
          await save();
          return { result: 'broken', level: item.enhance_level };
        }

        if (res.success) {
          item.enhance_level += 1;
          item.updated_at = now();
          recordLedger({
            eventId: `enh:${product}:${tgId}:${equipId}:${now()}`,
            product,
            tgId,
            aid: acc.aid,
            type: '衝裝成功',
            deltaPoints: 0,
            deltaStones: 0,
            pointsAfter: acc.points,
            stonesAfter: acc.stones,
            note: `${item.name} 強化成功！升級為 +${item.enhance_level}！`,
          });
          await save();
          return { result: 'success', level: item.enhance_level, item };
        }

        item.updated_at = now();
        recordLedger({
          eventId: `enh:${product}:${tgId}:${equipId}:${now()}`,
          product,
          tgId,
          aid: acc.aid,
          type: '衝裝維持',
          deltaPoints: 0,
          deltaStones: 0,
          pointsAfter: acc.points,
          stonesAfter: acc.stones,
          note: `+${item.enhance_level} ${item.name} 強化沒有事情發生，裝備完好。`,
        });
        await save();
        return { result: 'fail', level: item.enhance_level, item };
      });
    },

    async rerollItem({ product, tgId, equipId }) {
      return locked(async () => {
        const k = accountKey(product, tgId);
        const acc = data.accounts[k];
        if (!acc) throw new Error('你尚未開啟寵物');
        const list = data.equipment[k] || [];
        const item = list.find((eq) => eq.id === equipId);
        if (!item) throw new Error('查無該裝備');

        acc.inventory ||= {};
        if ((acc.inventory.reroll_scroll || 0) < 1) {
          throw new Error('缺少【洗屬性卷軸】');
        }
        acc.inventory.reroll_scroll -= 1;

        const newElement = ELEMENT_KEYS[Math.floor(random() * ELEMENT_KEYS.length)];
        const newTier = rollEquipmentTier(random);
        const newElemStat = Math.max(1, Math.round(item.base_stat * 0.3));

        item.element = newElement;
        item.element_tier = newTier;
        item.element_stat = newElemStat;
        item.updated_at = now();

        recordLedger({
          eventId: `reroll:${product}:${tgId}:${equipId}:${now()}`,
          product,
          tgId,
          aid: acc.aid,
          type: '洗屬性',
          deltaPoints: 0,
          deltaStones: 0,
          pointsAfter: acc.points,
          stonesAfter: acc.stones,
          note: `${item.name} 洗出【${ELEMENTS[newElement].name}屬性·${ELEMENT_TIERS[newTier].name}】`,
        });

        await save();
        return { item };
      });
    },

    async getSeasonConfig(product) {
      if (cloud) {
        return cloud.seasonConfig(product);
      }
      return data.seasons?.[product] || null;
    },

    async saveSeasonConfig(product, config) {
      if (cloud) {
        return cloud.saveSeasonConfig({ product, ...config });
      }
      data.seasons ||= {};
      data.seasons[product] = { product, ...config, updatedAt: now() };
      await save();
      return { ok: true, season: data.seasons[product] };
    },

    async getSeasonRankings(product) {
      if (cloud) {
        return cloud.seasonRankings(product);
      }
      const accounts = Object.values(data.accounts).filter((a) => a.product === product);
      accounts.sort((a, b) => (b.pet?.seasonPoints ?? 100) - (a.pet?.seasonPoints ?? 100));
      return {
        ok: true,
        rankings: accounts.slice(0, 10).map((a, idx) => ({
          rank: idx + 1,
          tgId: a.tgId,
          aid: a.aid,
          nickname: a.nickname || a.petName || '玩家',
          points: a.pet?.seasonPoints ?? 100,
        })),
      };
    },

    async activateSeason(product) {
      if (!cloud?.seasonActivate) throw new Error('賽季雲端服務尚未連線');
      return cloud.seasonActivate({ product });
    },

    async startSeason(product) {
      if (!cloud?.seasonStart) throw new Error('賽季雲端服務尚未連線');
      return cloud.seasonStart({ product });
    },

    async settleSeason(product, { force = false } = {}) {
      if (cloud) {
        return cloud.seasonSettle({ product, force });
      }
      return { ok: true };
    },

    async shareLike({ product, shareId, tgId }) {
      if (!cloud?.shareLike) throw new Error('分享按讚服務尚未連線');
      return cloud.shareLike({ product, shareId, tgId: String(tgId) });
    },
  };
}
