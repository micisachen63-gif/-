function priorRunDecision(old) {
  if (['completed', 'awaiting_audience'].includes(old?.status)) return 'skip';
  if (['in_progress', 'needs_review'].includes(old?.status)
    || Object.keys(old?.actions || {}).length > 0) return 'stop';
  return 'run';
}

// 每日執行器鎖：避免排程、候補重跑或人工同時各跑一份而重複派送。超過 3 小時或行程已不存在就視為殘留鎖。
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function lockIsActive(info, now = Date.now(), isAlive = pidAlive) {
  if (!info || !Number.isInteger(info.pid)) return false;
  const started = Date.parse(info.startedAt || '');
  if (!Number.isFinite(started) || now - started > 3 * 60 * 60 * 1000) return false;
  return isAlive(info.pid);
}

// 早上準備步驟（匯出／匯入／分組，尚未寄出任何東西）失敗或整批沒跑時，候補排程自動重啟每日執行器。
// 限 07:20–16:30、每個批次日最多 3 次、每次至少間隔 20 分鐘；有外部動作紀錄的品牌一律不碰。
function prepRerunBrands(runs, date, localTime, history = {}, now = new Date(), brands = ['qiezi', 'songyy', 'winmalo']) {
  if (localTime < '07:20' || localTime >= '16:30') return [];
  const entry = history[date] || {};
  if ((entry.count || 0) >= 3) return [];
  if (entry.lastAt && now.getTime() - Date.parse(entry.lastAt) < 20 * 60 * 1000) return [];
  return brands.filter(brand => {
    const run = runs?.[`${date}/${brand}`];
    if (!run) return true;
    if (priorRunDecision(run) !== 'run') return false;
    const updated = Date.parse(run.updatedAt || run.createdAt || '');
    return !Number.isFinite(updated) || now.getTime() - updated >= 10 * 60 * 1000;
  });
}

module.exports = { priorRunDecision, lockIsActive, pidAlive, prepRerunBrands };
