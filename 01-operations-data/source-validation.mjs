export function validateDailySource(source, d, approvedMonth, merchantCount) {
 if (source.approvedMonth !== approvedMonth || source.daily?.[0]?.[0] !== d.from || source.daily?.at(-1)?.[0] !== d.to) {
  throw Error('來源核准月份或每日資料期間不符');
 }
 if (d.rollover && (source.monthClose?.members?.month !== d.previousMonthKey || source.monthClose?.merchants?.length !== merchantCount)) {
  throw Error('跨月會員結算期間或幣商數量不符');
 }
 if (!d.rollover && source.monthClose != null) throw Error('一般日更不應夾帶跨月結算資料');
}
