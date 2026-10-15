import fs from 'node:fs';
import path from 'node:path';
import { describeKeyboard, formatCongrats, pendingKeyboard } from './format.js';
import { sendVerified } from './telegram.js';
import { sleep } from './util.js';

/** Dry-run sink: everything that would be sent goes to a local text file instead of Telegram. */
export function createDryWriter(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return {
    file,
    write(text) { fs.appendFileSync(file, text.endsWith('\n') ? text : text + '\n'); },
  };
}

export function createNotifier({ dry, dryWriter, api, chatId, brands = [], loadCommunityBot, paceMs = 1100 }) {
  if (dry) {
    return {
      async sendAlert(rec) {
        const lines = ['', `===== [DRY] 小精靈 → 私人群組（${rec.brandName}，alert id ${rec.id}）=====`, rec.text];
        if (rec.publishable) {
          lines.push('[inline buttons] ' + describeKeyboard(pendingKeyboard(rec.id)), `[callback_data] p:${rec.id} / s:${rec.id}`);
          const brand = brands.find((b) => b.key === rec.brand);
          let button = '(community bot config unreadable)';
          try {
            const bot = loadCommunityBot(brand);
            button = describeKeyboard({ inline_keyboard: [[{ text: bot.buttonText, url: bot.buttonUrl }]] });
          } catch (error) { button = `(community bot config error: ${error.message})`; }
          lines.push(`----- [DRY] 若按「發佈」，${rec.brandName} 社群 bot 會發：`, formatCongrats(rec), '[inline button] ' + button);
        } else {
          lines.push('[no buttons: brand has no community publishing]');
        }
        dryWriter.write(lines.join('\n'));
        return { messageId: null, chatId: 'DRY' };
      },
      async sendText(text, { label = '系統通知' } = {}) {
        dryWriter.write(['', `===== [DRY] 小精靈 → 私人群組（${label}）=====`, text].join('\n'));
      },
      pace: async () => {},
    };
  }
  return {
    async sendAlert(rec) {
      const msg = await sendVerified(api, chatId, {
        text: rec.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(rec.publishable ? { reply_markup: pendingKeyboard(rec.id) } : {}),
      });
      return { messageId: msg.message_id, chatId: msg.chat.id };
    },
    async sendText(text) {
      await sendVerified(api, chatId, { text, parse_mode: 'HTML', disable_web_page_preview: true });
    },
    pace: () => sleep(paceMs),
  };
}
