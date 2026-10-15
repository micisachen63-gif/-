// Admin season times are entered as Asia/Taipei wall-clock minutes.
export function parseSeasonTimestamp(value, { endOfMinute = false } = {}) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, datePart, hourText, minuteText] = match;
  const [, yearText, monthText, dayText] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart) || [];
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  const stamp = Date.UTC(year, month - 1, day, hour - 8, minute);
  if (!Number.isFinite(stamp)) return null;
  return stamp + (endOfMinute ? 59_999 : 0);
}

export function seasonIsOpen(season, at = Date.now()) {
  const start = parseSeasonTimestamp(season?.startTime ?? season?.start_time);
  const end = parseSeasonTimestamp(season?.endTime ?? season?.end_time, { endOfMinute: true });
  return start != null && end != null && at >= start && at <= end;
}
