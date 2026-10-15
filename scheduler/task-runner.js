/**
 * 輕量化內建排程引擎 (取代外部 18 個 Windows 工作排程器，開箱即走)
 */
export class TaskScheduler {
  constructor({ log = console } = {}) {
    this.log = log;
    this.tasks = [];
    this.timer = null;
    this.running = false;
  }

  /**
   * 註冊定時任務
   * @param {string} name 任務名稱
   * @param {number} intervalMs 執行間隔 (毫秒)
   * @param {function} fn 執行函式
   */
  registerInterval(name, intervalMs, fn) {
    this.tasks.push({
      name,
      type: 'interval',
      intervalMs,
      lastRun: 0,
      fn
    });
  }

  /**
   * 註冊每日固定時刻任務 (例如 "07:00", "15:00")
   * @param {string} name 任務名稱
   * @param {string[]} dailyTimes 固定時段陣列，格式 "HH:MM"
   * @param {function} fn 執行函式
   */
  registerDaily(name, dailyTimes, fn) {
    this.tasks.push({
      name,
      type: 'daily',
      dailyTimes,
      lastExecutedDateStr: '',
      fn
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log.info('定時排程引擎啟動...');

    this.timer = setInterval(async () => {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const nowTimeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const nowDateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

      for (const t of this.tasks) {
        if (t.type === 'interval') {
          if (Date.now() - t.lastRun >= t.intervalMs) {
            t.lastRun = Date.now();
            try {
              await t.fn();
            } catch (err) {
              this.log.error(`[排程任務: ${t.name}] 執行例外: ${err.message}`);
            }
          }
        } else if (t.type === 'daily') {
          if (t.dailyTimes.includes(nowTimeStr)) {
            const executedKey = `${nowDateStr}_${nowTimeStr}`;
            if (t.lastExecutedKey !== executedKey) {
              t.lastExecutedKey = executedKey;
              this.log.info(`[每日排程: ${t.name}] 觸發時間: ${nowTimeStr}`);
              try {
                await t.fn();
              } catch (err) {
                this.log.error(`[每日排程: ${t.name}] 執行例外: ${err.message}`);
              }
            }
          }
        }
      }
    }, 10000); // 每 10 秒檢查一次
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
