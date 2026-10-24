const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const QUARTER = '(?:[零〇一二三四五六七八九十初0-9]+刻)?';
export const TRADITIONAL_CLOCK_PATTERN = `(?:[子丑寅卯辰巳午未申酉戌亥][时時][初正]?${QUARTER}|(?:(?<![\\p{L}\\p{N}])|(?<=[日号號约約]))[子丑寅卯辰巳午未申酉戌亥][初正]${QUARTER}(?=$|[^\\p{L}\\p{N}]|左右|前后|前後|上下|至|到))`;
const normalize = value => String(value ?? '').replace(/[０-９]/gu, char => String(char.charCodeAt(0) - 0xFF10)).replace(/：/gu, ':');
const APPROXIMATE_PREFIX = /(?:大约|大約|大概|约莫|约|約)\s*$/u;
const APPROXIMATE_SUFFIX = /^\s*(?:左右|前后|前後|上下|[（(]\s*(?:左右|前后|前後|上下|约|約)\s*[）)])/u;

// 只解析钟点跨度；日期、历法和来源身份由调用方原合同决定。
export function parseStoryClockSpan(value) {
  const raw = normalize(value);
  const numeric = raw.match(/(?<!\d)(上午|下午|中午|正午|凌晨|清晨|早晨|早上|晚上|夜里|夜间|夜間|午夜|AM|PM)?\s*([01]?\d|2[0-3]):([0-5]\d)(?:[:：]\d{2})?(?:\s*(AM|PM))?(?!\d)/iu);
  let point = null;
  if (numeric) {
    const marker = String(numeric[1] || numeric[4] || '').toUpperCase();
    const english = marker === 'AM' || marker === 'PM';
    let hour = Number(numeric[2]);
    if (!(english && (hour < 1 || hour > 12) || !english && marker && hour < 1)) {
      if ((marker === 'PM' || ['下午', '中午', '正午', '晚上', '夜里', '夜间', '夜間'].includes(marker)) && hour <= 12) hour = hour % 12 + 12;
      else if ((marker === 'AM' || ['上午', '凌晨', '清晨', '早晨', '早上', '午夜'].includes(marker)) && hour <= 12) hour %= 12;
      if (hour <= 23) point = { match: numeric[0], index: numeric.index, clockIndex: numeric.index + numeric[0].search(/\d{1,2}:\d{2}/u),
        minute: hour * 60 + Number(numeric[3]), clock: `${String(hour).padStart(2, '0')}:${numeric[3]}`, traditional: false };
    }
  }
  const pattern = /([子丑寅卯辰巳午未申酉戌亥])(?:[时時])?([初正])?(?:([零〇一二三四五六七八九十初0-9]+)刻)?/gu;
  for (const match of raw.matchAll(pattern)) {
    const marked = match[0].length > 1;
    if (!marked && !(raw.trim() === match[0] || /[\s，,:：日号號]$/u.test(raw.slice(0, match.index)) && /^(?:\s*(?:至|到|[~～—–-])|\s*$)/u.test(raw.slice(match.index + match[0].length)))) continue;
    if (marked && !/[时時]/u.test(match[0])) {
      const suffix = raw.slice(match.index + match[0].length), prefix = raw.slice(0, match.index);
      if (/[\p{L}\p{N}]$/u.test(prefix) && !/[日号號约約]$/u.test(prefix) || /^(?!左右|前后|前後|上下|至|到)[\p{L}\p{N}]/u.test(suffix)) continue;
    }
    if (/[年月]/u.test(raw[match.index + match[0].length] ?? '')) continue;
    const start = (BRANCHES.indexOf(match[1]) * 120 + 1380) % 1440;
    const half = match[2];
    const quarter = match[3] === undefined ? null : ({ 零: 0, 〇: 0, 初: 0, 一: 1, 二: 2, 三: 3 })[match[3]] ?? (/^\d$/u.test(match[3]) ? Number(match[3]) : NaN);
    const ambiguousDate = match[1] === '子' && !half;
    let min = start + (half === '正' ? 60 : 0), max = min + (half ? 60 : 120);
    if (half === '正' && min === 1440) { min = 0; max = 60; }
    // 未注明初正的刻、越过该半时辰的刻，不猜成某一钟点。
    if (quarter !== null) {
      if (!half || !Number.isInteger(quarter) || quarter < 0 || quarter > 3) min = max = null;
      else { min += quarter * 15; max = min + 15; }
    }
    const suffix = raw.slice(match.index + match[0].length);
    const prefix = raw.slice(0, match.index);
    const approximate = APPROXIMATE_SUFFIX.test(suffix) || APPROXIMATE_PREFIX.test(prefix);
    const result = { match: match[0], index: match.index, clockIndex: match.index, minute: null, clock: match[0], traditional: true,
      min: approximate ? null : min, max: approximate ? null : max, ambiguousDate, approximate };
    return point && point.index < result.index ? point : result;
  }
  return point;
}

// 编辑往返用完整词段；计算仍只取正式钟点，不能丢掉约略修饰后再提高精度。
export function storyClockEndpointSpan(value) {
  const raw = normalize(value), clock = parseStoryClockSpan(raw);
  if (!clock) return null;
  const prefix = clock.traditional ? raw.slice(0, clock.index).match(APPROXIMATE_PREFIX)?.[0] ?? '' : '';
  const end = clock.index + clock.match.length;
  const suffix = clock.traditional ? raw.slice(end).match(APPROXIMATE_SUFFIX)?.[0] ?? '' : '';
  return { ...clock, index: clock.index - prefix.length, match: raw.slice(clock.index - prefix.length, end + suffix.length) };
}
export function isStoryClockOnly(value) {
  const raw = normalize(value).trim(), clock = storyClockEndpointSpan(raw);
  return Boolean(clock && clock.index === 0 && clock.match.trim() === raw);
}

export function storyClockRangeSpan(value) {
  const raw = normalize(value), first = storyClockEndpointSpan(raw);
  if (!first || /[（(]\s*$/u.test(raw.slice(0, first.index))) return null;
  const rest = raw.slice(first.index + first.match.length), separator = rest.match(/^\s*(?:~|～|—|–|-|至|到)\s*/u);
  if (!separator) return null;
  const second = storyClockEndpointSpan(rest.slice(separator[0].length));
  if (!second || second.index !== 0) return null;
  const end = first.index + first.match.length + separator[0].length + second.match.length;
  return { match: raw.slice(first.index, end), index: first.index };
}
