import fs from 'node:fs';
import path from 'node:path';

const PLATFORM_URLS = {
  yingma: 'https://liff.line.me/2008678737-mZTxDgVt',
  shuangbao: 'https://liff.line.me/2000222941-8ORVa7oZ',
  qiezi: 'https://liff.line.me/2004182953-ZKaD27vq',
};

export function createDungeonManager({
  cloud,
  products = ['yingma', 'shuangbao', 'qiezi'],
  groupChatId = () => null,
  sendPhoto = null,
  sendMessage = null,
  call = null,
  answerCallback = null,
  assetsDir = path.resolve('cloudflare/public/assets/items'),
  botUsername = () => '',
  platformUrl = () => null,
  log = console,
  now = Date.now,
}) {
  let running = false;
  const dropsById = new Map();
  const tradeClickCooldowns = new Map();

  function formatPlayerTitle(drop) {
    if (drop.nickname) {
      return `${drop.nickname}（AID: ${drop.aid || '---'}）`;
    }
    if (drop.aid) {
      return `勇士（AID: ${drop.aid}）`;
    }
    return `冒險者（ID: ${drop.tgId}）`;
  }

  function buildBroadcastCaption(drop) {
    const player = formatPlayerTitle(drop);
    const pet = drop.petName || '小精靈';
    const rating = drop.gearRating || { title: '【B 精良】', score: 50 };

    if (drop.dropType === 'scroll') {
      return [
        '⛏️ <b>【地牢自動尋寶大豐收！】</b>',
        `🎉 恭喜 <b>${player}</b> 的寵物「<b>${pet}</b>」在地牢深處探險尋獲稀有秘寶！`,
        '',
        `📜 <b>獲得道具</b>：【${drop.itemName}】`,
        `⭐ <b>道具評級</b>：${rating.title}`,
        `✨ <b>道具效果</b>：${drop.statDesc}`,
        `🌟 <b>道具類別</b>：${drop.elementDesc}（已直接存入寵物背包）`,
        '',
        '💡 <i>寵物飽食度維持 30% 以上將持續自動尋寶（平均每 8 小時獲得 1 件），快餵飽寵物加入地牢探險吧！</i>',
      ].join('\n');
    }

    return [
      '⛏️ <b>【地牢自動尋寶大豐收！】</b>',
      `🎉 恭喜 <b>${player}</b> 的寵物「<b>${pet}</b>」在地牢深處探險挖到了稀有裝備！`,
      '',
      `📦 <b>獲得道具</b>：【${drop.itemName}】`,
      `⭐ <b>裝備評級</b>：${rating.title}（評分：${rating.score} 分）`,
      `⚔️ <b>能力數值</b>：${drop.statDesc}`,
      `🌟 <b>元素屬性</b>：${drop.elementDesc}`,
      '',
      '💡 <i>寵物飽食度維持 30% 以上將持續自動尋寶（平均每 8 小時獲得 1 件），快餵飽寵物加入地牢探險吧！</i>',
    ].join('\n');
  }

  function buildDropReplyMarkup(dropOrProduct, dropIdArg) {
    const isObject = typeof dropOrProduct === 'object' && dropOrProduct !== null;
    const product = isObject ? dropOrProduct.product : dropOrProduct;
    const ownerTgId = isObject ? (dropOrProduct.tgId || '0') : '0';
    const dropId = dropIdArg || (isObject && dropOrProduct.id) || '0';
    const rawBot = typeof botUsername === 'function' ? botUsername() : botUsername;
    const botName = String(rawBot || 'xiaoyouxi_jingling_bot').replace(/^@/, '').trim();
    const playUrl = (typeof platformUrl === 'function' ? platformUrl(product) : null) || PLATFORM_URLS[product] || `https://t.me/${botName}`;

    return {
      inline_keyboard: [
        [
          { text: '🤝 我要交易', callback_data: `mg:pet:dtr:${product}:${ownerTgId}:${dropId}` },
          { text: '🎰 進遊戲打碼', url: playUrl },
        ],
      ],
    };
  }

  async function announceDrop(drop) {
    const dropId = drop.id || `${now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    drop.id = dropId;
    dropsById.set(dropId, drop);
    if (dropsById.size > 2000) {
      const oldestKey = dropsById.keys().next().value;
      dropsById.delete(oldestKey);
    }

    const chatId = groupChatId(drop.product);
    if (!chatId) {
      log.info?.(`[dungeon] No group chatId configured for product ${drop.product}; skipping announcement`);
      return;
    }

    const caption = buildBroadcastCaption(drop);
    const replyMarkup = buildDropReplyMarkup(drop, dropId);
    const candidateFiles = [
      drop.itemName ? path.join(assetsDir, drop.product, `${drop.itemName}.jpg`) : null,
      drop.itemName ? path.join(assetsDir, drop.product, `${drop.itemName}.png`) : null,
      path.join(assetsDir, drop.product, `${drop.itemKey}.jpg`),
      path.join(assetsDir, drop.product, `${drop.itemKey}.png`),
      path.join(assetsDir, 'common', `${drop.itemKey}.jpg`),
      path.join(assetsDir, 'common', `${drop.itemKey}.png`),
    ].filter(Boolean);

    let imagePath = null;
    for (const p of candidateFiles) {
      if (fs.existsSync(p)) {
        imagePath = p;
        break;
      }
    }

    let imageSent = false;
    if (sendPhoto && imagePath) {
      try {
        const buffer = fs.readFileSync(imagePath);
        const isJpg = imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg');
        await sendPhoto({
          chatId,
          buffer,
          mimeType: isJpg ? 'image/jpeg' : 'image/png',
          fileName: path.basename(imagePath),
          caption,
          parseMode: 'HTML',
          replyMarkup,
        });
        imageSent = true;
      } catch (err) {
        log.warn?.(`[dungeon] sendPhoto failed for ${path.basename(imagePath)} in ${drop.product}: ${err.message}; falling back to text`);
      }
    }

    if (!imageSent && sendMessage) {
      try {
        await sendMessage(chatId, caption, { reply_markup: replyMarkup });
      } catch (err) {
        log.error?.(`[dungeon] sendMessage failed for ${drop.product}: ${err.message}`);
      }
    }
  }

  async function tick(elapsedMinutes = 1) {
    if (running) return null;
    if (!cloud || !cloud.dungeonTick) return null;
    running = true;
    try {
      const res = await cloud.dungeonTick({ elapsedMinutes });
      if (!res || !res.ok) {
        log.warn?.(`[dungeon] tick response not ok: ${res?.error}`);
        return null;
      }

      const drops = res.drops || [];
      if (drops.length > 0) {
        log.info?.(`[dungeon] tick triggered ${drops.length} drop(s) (exploring: ${res.exploringCount}, paused: ${res.pausedCount})`);
        for (const drop of drops) {
          try {
            await announceDrop(drop);
          } catch (dropErr) {
            log.error?.(`[dungeon] announceDrop failed: ${dropErr.message}`);
          }
        }
      }
      return res;
    } catch (e) {
      log.warn?.(`[dungeon] tick failed: ${e.message}`);
      return null;
    } finally {
      running = false;
    }
  }

  async function triggerForceDrop(product, tgId) {
    if (!cloud || !cloud.dungeonForceDrop) throw new Error('Cloud gateway does not support dungeonForceDrop');
    const res = await cloud.dungeonForceDrop({ product, tgId });
    if (res?.ok && res.drop) {
      await announceDrop(res.drop);
    }
    return res;
  }

  async function handleTradeCallback(cq) {
    const data = String(cq?.data || '');
    const parts = data.split(':');
    // data format: mg:pet:dtr:<product>:<ownerTgId>:<dropId>
    const product = parts[3] || 'yingma';
    const ownerTgId = parts[4] || '0';
    const dropId = parts[5] || '0';

    const clicker = cq?.from || {};
    const clickerId = clicker.id;
    const clickerName = clicker.first_name
      ? [clicker.first_name, clicker.last_name].filter(Boolean).join(' ')
      : (clicker.username ? `@${clicker.username}` : '冒險者');
    const clickerUsername = clicker.username ? `@${clicker.username}` : '';
    const clickerMention = clickerUsername || clickerName;

    const answer = async (text, alert = true) => {
      if (answerCallback) {
        return answerCallback(cq, text, alert);
      }
      if (call) {
        return call('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: String(text).slice(0, 190),
          show_alert: alert,
        }).catch(() => {});
      }
    };

    // 1. If clicker is the owner themselves
    if (String(clickerId) === String(ownerTgId)) {
      await answer('這是您自己的寵物挖到的道具喔！若要與其他玩家交易，請等待其他玩家聯繫，或進入寵物APP背包發起交易。', true);
      return;
    }

    // 2. Cooldown check: prevent rapid repeated clicks from spamming the owner (30 seconds cooldown per clicker per drop)
    const cooldownKey = `${clickerId}:${dropId}`;
    const lastClick = tradeClickCooldowns.get(cooldownKey) || 0;
    const currentTime = now();
    if (currentTime - lastClick < 30000) {
      await answer('🔔 剛才已私訊通知過裝備主人囉！請先在群組與對方討論確認～', true);
      return;
    }
    tradeClickCooldowns.set(cooldownKey, currentTime);

    // Retrieve drop details from cache if available
    const drop = dropsById.get(dropId);
    const itemName = drop?.itemName || '稀有裝備';
    const ownerName = drop?.nickname || (drop?.aid ? `勇士（AID: ${drop.aid}）` : '裝備主人');
    const productTitles = {
      yingma: '贏麻了社群',
      shuangbao: '爽爆社群',
      qiezi: '茄子社群',
    };
    const productTitle = productTitles[product] || product;

    const rawBot = typeof botUsername === 'function' ? botUsername() : botUsername;
    const botName = String(rawBot || 'xiaoyouxi_jingling_bot').replace(/^@/, '').trim();
    const tradeAppUrl = `https://t.me/${botName}?startapp=trade_${product}`;

    // 3. Send PM to owner
    const ownerNotice = [
      '📩 <b>【地牢尋寶裝備交易意向通知】</b>',
      '',
      `🎉 玩家 <b>${clickerName}</b>${clickerUsername ? `（${clickerUsername}）` : ''} 在群組對您在<b>${productTitle}</b>挖到的道具【<b>${itemName}</b>】表示想進行交易！`,
      '',
      '💬 <b>【交易建議流程】</b>：',
      `1️⃣ <b>先在群組討論</b>：建議您先在群組與對方（${clickerMention}）溝通確認想要交換的裝備或點數。`,
      '2️⃣ <b>達成共識後交易</b>：雙方談妥確認後，再點擊下方按鈕進入寵物 APP 進行雙向安全託管交易！',
      '',
      '👉 <b>趕快回群組跟對方打個招呼吧！</b>',
    ].join('\n');

    const ownerReplyMarkup = {
      inline_keyboard: [
        [
          { text: '🤝 前往寵物交易中心', url: tradeAppUrl },
        ],
      ],
    };

    let pmSuccess = false;
    if (call && ownerTgId && ownerTgId !== '0') {
      try {
        await call('sendMessage', {
          chat_id: ownerTgId,
          text: ownerNotice,
          parse_mode: 'HTML',
          reply_markup: ownerReplyMarkup,
        });
        pmSuccess = true;
      } catch (err) {
        log.warn?.(`[dungeon] Failed to send PM to owner ${ownerTgId}: ${err.message}`);
      }
    }

    // 4. Response to clicker
    if (pmSuccess) {
      await answer(
        `🔔 已私訊通知裝備主人（${ownerName}）！\n\n💡 提醒您：可以先在群組與對方討論確認，雙方談妥後再進入寵物APP進行交易喔！`,
        true
      );
    } else {
      await answer(
        `🔔 裝備主人（${ownerName}）尚未開啟機器人私訊！\n\n💡 建議直接在群組 @對方 進行討論確認，談妥後再進入寵物APP交易。`,
        true
      );
      if (call && cq.message?.chat?.id && cq.message?.message_id) {
        try {
          const groupHint = [
            `🔔 玩家 ${clickerMention} 想與道具主人 <b>${ownerName}</b> 交易【<b>${itemName}</b>】！`,
            '💡 由於主人尚未在私訊中啟動機器人，請雙方直接在群組中討論確認，談妥後再進入寵物 APP 進行交易喔～',
          ].join('\n');
          await call('sendMessage', {
            chat_id: cq.message.chat.id,
            text: groupHint,
            parse_mode: 'HTML',
            reply_to_message_id: cq.message.message_id,
          });
        } catch {
          // ignore fallback error
        }
      }
    }
  }

  return {
    tick,
    announceDrop,
    buildBroadcastCaption,
    buildDropReplyMarkup,
    handleTradeCallback,
    triggerForceDrop,
    getDrop: (id) => dropsById.get(id),
  };
}
