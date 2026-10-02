// 用户确认的两种固定月制；不借用系统公历闰年或推测其他纪年的规则。
const TWELVE_MONTHS = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
const FOUR_MONTHS = Object.freeze([30, 30, 30, 30]);

export function normalizeStoryCalendar(value) {
  if (!value || ![4, 12].includes(value.months) || typeof value.prefix !== 'string') return null;
  const prefix = value.prefix.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  if (prefix.length > 40 || /[\d<>\r\n]/u.test(prefix)) return null;
  return { months: value.months, prefix };
}

export function calendarMonthDays(calendar) {
  return calendar?.months === 4 ? FOUR_MONTHS : TWELVE_MONTHS;
}

export const calendarKey = calendar => calendar ? JSON.stringify([calendar.months, calendar.prefix]) : null;

export function fixedCalendarDate(year, month, monthDay, calendar) {
  const days = calendarMonthDays(calendar);
  if (!Number.isInteger(month) || month < 1 || month > days.length || !Number.isInteger(monthDay) || monthDay < 1
    || monthDay > days[month - 1] || year !== null && (!Number.isSafeInteger(year) || year < 1)) return null;
  const ordinal = days.slice(0, month - 1).reduce((sum, count) => sum + count, 0) + monthDay - 1;
  return { year, month, monthDay, day: year === null ? null : (year - 1) * days.reduce((sum, count) => sum + count, 0) + ordinal,
    calendar, calendarOrdinal: ordinal,
    date: `${calendar.prefix}${year === null ? '' : `${year}年`}${month}月${monthDay}日${year === null ? '（年份未明）' : ''}` };
}

export function shiftCalendarDate(time, days) {
  if (!time?.calendar || !Number.isInteger(time.calendarOrdinal) || !Number.isInteger(days)) return null;
  const months = calendarMonthDays(time.calendar), yearDays = months.reduce((sum, count) => sum + count, 0);
  let ordinal = time.calendarOrdinal + days, year = time.year;
  if (year === null && (ordinal < 0 || ordinal >= yearDays)) return null;
  if (year !== null) { year += Math.floor(ordinal / yearDays); ordinal = (ordinal % yearDays + yearDays) % yearDays; }
  let month = 1;
  while (ordinal >= months[month - 1]) ordinal -= months[month++ - 1];
  return fixedCalendarDate(year, month, ordinal + 1, time.calendar);
}
