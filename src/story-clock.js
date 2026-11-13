import { calendarMonthDays } from './v3/calendar-rules.js';

export const MYKNOTS_STORY_CLOCK_KEY = 'myknots_story_clock';
export const STORY_CLOCK_DEPTH = 0;

export const DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT = [
  '【故事时间戳 QQJ｜每楼附加元数据】',
  '请在本楼正文最前与最后各放一个 HTML 注释，作为本楼的附加故事时间元数据。HTML 注释不会显示给读者。',
  '日期与时间的表达方式应与当前故事背景及正文保持一致。沿用正文已有的时间写法，不因示例而改变格式。',
  '格式示例（仅示意字段结构，不构成剧情事实；请替换为本楼实际内容）：',
  '  已知故事年份：<!-- QQJ-start | date=大陆历1686年10月4日 | weekday=周二 | time=15:30 -->正文<!-- QQJ-end | date=大陆历1686年10月4日 | weekday=周二 | time=16:00 -->',
  'start 与 end 都必须同时填写 date、weekday、time；有可靠故事依据时 weekday 使用周一至周日，没有依据时写“未知”，不凭日期或现实时间猜星期。正文或可靠故事时间依据明确给出年份时，start 与 end 沿用该年份和正文时间写法；跨年或倒叙按本楼正文及可靠时间依据记录。没有可靠年份时不要补写年份或猜算跨年日期；没有可靠日期时保留不确定表达，不用系统或服务器现实年份填补。世界书中的日期和时间要求仍须完整执行，QQJ 不替代、不合并、不改写它们。',
  '本楼仅按本提示指定的 QQJ 格式输出一套 start/end；历史楼出现 SDC、myknots 等同类标记时，不因此重复追加。世界书自身的独立输出要求仍须完整执行。',
  '通常以上一楼 end 为参考推进本楼时间；无可用参考时保留当前剧情能确认的时间，不能确认的字段写“未知”。除这两个注释外，不要在正文中讨论 QQJ。',
].join('\n');

const text = value => typeof value === 'string' ? value : '';
const field = (raw, name) => {
  const matches = [...raw.matchAll(new RegExp(`(?:^|[|｜,，;；\\n])\\s*(?:${name})\\s*[=＝:]\\s*([^|｜,，;；\\n]+)`, 'igu'))];
  const value = matches.length === 1 ? matches[0][1].trim() : '';
  return value && !/[=＝]/u.test(value) ? value : null;
};
const REFERENCE_TAG_NAME = /^[\p{L}][\p{L}\p{N}_-]*~?$/u;

export function normalizeStoryClockReferenceTags(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[\n,，]/u);
  const seen = new Set();
  return values.map(item => String(item).trim()).filter(item => {
    const key = item.toLocaleLowerCase('en-US');
    if (!REFERENCE_TAG_NAME.test(item) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 只比较明确的日期词元，纪年和未识别月名保持各自身份。
const CN_DIGITS = '零〇一二两兩三四五六七八九壹贰貳叁參叄肆伍陆陸柒捌玖';
const CN_NUMBER = `(?:元|[0-9${CN_DIGITS}十拾百佰千仟廿卄卅卌]+)`;
const CN_VALUES = Object.fromEntries([...CN_DIGITS].map((char, index) => [char, [0,0,1,2,2,2,3,4,5,6,7,8,9,1,2,2,3,3,3,4,5,6,6,7,8,9][index]]));
function cnNumber(value) {
  if (value === '元') return 1;
  if (/^\d+$/u.test(value)) return Number(value);
  if ([...value].every(char => char in CN_VALUES)) return Number([...value].map(char => CN_VALUES[char]).join(''));
  const compact = value.match(/^([廿卄卅卌])([零〇一二三四五六七八九])?$/u);
  if (compact) return ({ 廿: 20, 卄: 20, 卅: 30, 卌: 40 })[compact[1]] + (CN_VALUES[compact[2]] ?? 0);
  let total = 0, digit = null;
  for (const char of value) {
    if (char in CN_VALUES) { if (digit !== null && digit !== 0) return null; digit = CN_VALUES[char]; }
    else {
      const unit = ({ 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 })[char];
      if (!unit) return null;
      total += (digit ?? 1) * unit; digit = null;
    }
  }
  return total + (digit ?? 0);
}

function clockDateKey(raw, calendar) {
  const value = String(raw ?? '').normalize('NFKC').trim();
  const iso = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(value);
  if (iso) return ['', Number(iso[1]), Number(iso[2]), Number(iso[3])];
  const match = new RegExp(`^(?:([\\p{L}]*?)(${CN_NUMBER})\\s*年\\s*)?(${CN_NUMBER}|正|冬|腊|臘)月(?:初)?(${CN_NUMBER})(?:日|号|號)?$`, 'u').exec(value);
  const seasonal = calendar?.months === 4 ? new RegExp(`^(?:([\\p{L}]*?)(${CN_NUMBER})\\s*年\\s*)?(春|夏|秋|冬)(?:月)?(?:初)?(${CN_NUMBER})(?:日|号|號)?$`, 'u').exec(value) : null;
  if (!match && !seasonal) return value;
  const [, era = '', year, month, day] = seasonal ?? match;
  return [era, year ? cnNumber(year) ?? NaN : null, seasonal ? ({ 春: 1, 夏: 2, 秋: 3, 冬: 4 })[month] : ({ 正: 1, 冬: 11, 腊: 12, 臘: 12 })[month] ?? cnNumber(month), cnNumber(day)];
}
const clockTimeKey = value => String(value ?? '').normalize('NFKC').replace(/^(\d{1,2}):(\d{2})$/u, (_, h, m) => `${Number(h)}:${m}`);
function mergeClockMeta(values, calendar) {
  const compare = (key, value) => key === 'date' ? JSON.stringify(clockDateKey(value, calendar)) : key === 'time' ? clockTimeKey(value) : String(value).replace(/^(?:週|星期|礼拜|禮拜)/u, '周').replace(/天$/u, '日');
  const merged = {};
  let conflict = false;
  for (const key of ['date', 'weekday', 'time']) {
    const known = values.map(value => value?.[key]).filter(value => value != null);
    const same = known.every(value => compare(key, value) === compare(key, known[0]));
    if (!same) conflict = true;
    merged[key] = same && known.length === values.length ? known[0] : null;
  }
  return Object.freeze({ raw: values.map(value => value?.raw).filter(Boolean).join(' / '), ...merged,
    complete: !conflict && values.every(value => value?.complete), conflict });
}

export function parseClockFields(raw, calendar = null) {
  const value = text(raw).trim();
  const date = field(value, 'date');
  const weekdayText = field(value, 'weekday|星期');
  // 显式未知不否定已知日期与钟点；缺字段或非法星期仍是残缺戳。
  const weekdayUnknown = /^(?:未知|未明确|未明|不详)$/u.test(weekdayText ?? '');
  const weekday = weekdayUnknown ? null : weekdayText;
  const time = field(value, 'time');
  const weekdayValid = /^(?:周|週|星期|礼拜|禮拜)[一二三四五六日天]$/u.test(weekday ?? '');
  const normalizedTime = String(time ?? '').replace(/[０-９]/gu, char => String(char.charCodeAt(0) - 0xFF10)).replace(/：/gu, ':');
  const clocks = [...normalizedTime.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/gu)];
  const hasNumericClock = /\d+:\d+/u.test(normalizedTime);
  const period = /上午|下午|中午|正午|凌晨|清晨|早晨|早上|晚上|夜里|夜间|午夜|\b(?:AM|PM)\b/iu.test(normalizedTime);
  const timeValid = Boolean(time) && !/^(?:未知|未明确|未明|不详)$/u.test(time) && (!hasNumericClock || clocks.length > 0 && clocks.every(match => Number(match[1]) <= (period ? 12 : 23) && Number(match[2]) <= 59 && (!period || Number(match[1]) >= 1)));
  const normalizedDate = String(date ?? '').normalize('NFKC');
  const dateParts = clockDateKey(date, calendar);
  const numericDate = normalizedDate.match(/(?:^|\D)(\d{1,2})月(\d{1,2})(?:日|号|號)?(?:\D|$)/u)
    ?? normalizedDate.match(/(?:^|\D)\d{1,4}[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/u);
  const month = Array.isArray(dateParts) ? dateParts[2] : Number(numericDate?.[1]), day = Array.isArray(dateParts) ? dateParts[3] : Number(numericDate?.[2]);
  const gregorianYear = /^(\d{4})[-/.]\d{1,2}[-/.]\d{1,2}$/u.exec(normalizedDate)?.[1]
    ?? /^(\d{4})年\d{1,2}月\d{1,2}(?:日|号|號)?$/u.exec(normalizedDate)?.[1];
  const maxDay = (numericDate || Array.isArray(dateParts)) && month >= 1 && month <= 12
    ? calendar ? calendarMonthDays(calendar)[month - 1] ?? 0
      : gregorianYear ? new Date(Date.UTC(Number(gregorianYear), month, 0)).getUTCDate() : 31
    : 0;
  const dateValid = Boolean(date) && !/^(?:未知|未明确|未明|不详)$/u.test(date) && (!(numericDate || Array.isArray(dateParts)) || month >= 1 && month <= 12 && day >= 1 && day <= maxDay)
    && (!Array.isArray(dateParts) || dateParts[1] === null || Number.isSafeInteger(dateParts[1]) && dateParts[1] >= 0);
  return Object.freeze({ raw: value, date: dateValid ? date : null, weekday: weekdayValid ? weekday : null, time: timeValid ? time : null, complete: Boolean(dateValid && (weekdayValid || weekdayUnknown) && timeValid) });
}

function namespaceCandidate(source, namespace, calendar) {
  const tokenRe = new RegExp(`<!--\\s*${namespace}-(start|end)\\s+([\\s\\S]*?)\\s*-->`, 'igu');
  const tokens = [...source.matchAll(tokenRe)].map(match => Object.freeze({
    kind: match[1].toLocaleLowerCase('en-US'),
    raw: match[2],
    meta: parseClockFields(match[2], calendar),
    index: match.index,
  }));
  if (!tokens.length) return null;
  const starts = tokens.filter(token => token.kind === 'start');
  const ends = tokens.filter(token => token.kind === 'end');
  const pairs = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const start = tokens[index], end = tokens[index + 1];
    if (start.kind !== 'start' || end.kind !== 'end') continue;
    pairs.push(Object.freeze({ startMeta: start.meta, endMeta: end.meta, sourceIndex: start.index }));
    index += 1;
  }
  const currentPair = pairs.at(-1) ?? null;
  const startMeta = currentPair?.startMeta ?? starts[0]?.meta ?? null;
  const endMeta = currentPair?.endMeta ?? ends[0]?.meta ?? null;
  const duplicate = starts.length !== 1 || ends.length !== 1;
  return Object.freeze({
    namespace,
    start: startMeta?.raw ?? null,
    end: endMeta?.raw ?? null,
    startMeta,
    endMeta,
    duplicate,
    paired: Boolean(currentPair),
    complete: pairs.length > 0 && pairs.every(pair => pair.startMeta.complete && pair.endMeta.complete),
    singleEnd: starts.length === 0 && ends.length === 1 && ends[0].meta.complete,
    pairs: Object.freeze(pairs),
    tokens: Object.freeze(tokens.map(token => Object.freeze({ kind: token.kind, raw: token.meta.raw }))),
    sourceIndex: tokens[0].index,
  });
}

export function parseSharedStoryClock(value, calendar = null) {
  const source = text(value);
  const candidates = ['SDC', 'QQJ', 'myknots'].map(namespace => namespaceCandidate(source, namespace, calendar)).filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((left, right) => Number(right.complete) - Number(left.complete) || left.sourceIndex - right.sourceIndex);
  const usable = candidates.filter(candidate => candidate.paired || candidate.singleEnd);
  if (usable.length < 2) return usable[0] ?? candidates[0];
  const paired = usable.filter(candidate => candidate.paired);
  const count = Math.max(1, ...paired.map(candidate => candidate.pairs.length));
  const pairs = Array.from({ length: count }, (_, index) => Object.freeze({
    startMeta: mergeClockMeta(paired.map(candidate => candidate.pairs[index]?.startMeta ?? (index === 0 ? candidate.startMeta : null)), calendar),
    endMeta: mergeClockMeta(usable.map(candidate => candidate.pairs[index]?.endMeta ?? (index === 0 ? candidate.endMeta : null)), calendar),
  }));
  const ambiguous = pairs.some(pair => pair.startMeta.conflict || pair.endMeta.conflict);
  const current = pairs.at(-1);
  return Object.freeze({ ...usable[0], start: current.startMeta.raw || null, end: current.endMeta.raw || null,
    startMeta: paired.length ? current.startMeta : null, endMeta: current.endMeta,
    complete: paired.length > 0 && pairs.every(pair => pair.startMeta.complete && pair.endMeta.complete),
    paired: paired.length > 0, singleEnd: paired.length === 0, ambiguous, tokens: Object.freeze(usable.flatMap(candidate => candidate.tokens)), pairs: Object.freeze(paired.length ? pairs : []) });
}

export function parseStoryClockReference(value, referenceTags = '') {
  const source = text(value);
  const configured = [...new Set([...normalizeStoryClockReferenceTags(referenceTags), 'bbs_start', 'bbs_end'])];
  if (!source || !configured.length) return null;
  const configuredByKey = new Map(configured.map(name => [name.toLocaleLowerCase('en-US'), name]));
  const openByKey = new Map();
  const matches = [];
  const tagPattern = /<\s*(\/?)\s*(\p{L}[\p{L}\p{N}_-]*~?)(?=[\s/>])[^>]*>/giu;
  for (const token of source.matchAll(tagPattern)) {
    const key = token[2].toLocaleLowerCase('en-US');
    if (!configuredByKey.has(key)) continue;
    const closing = token[1] === '/';
    if (!closing && !/\/\s*>$/u.test(token[0])) {
      const stack = openByKey.get(key) ?? [];
      stack.push({ contentStart: token.index + token[0].length, sourceIndex: token.index });
      openByKey.set(key, stack);
      continue;
    }
    if (!closing) continue;
    const stack = openByKey.get(key);
    const opening = stack?.pop();
    if (!opening) continue;
    const referenceText = source.slice(opening.contentStart, token.index)
      .replace(/<!--[\s\S]*?-->/gu, '')
      .replace(/<\s*br\s*\/?>/giu, '\n')
      .replace(/<\s*\/?\s*\p{L}[\p{L}\p{N}_-]*~?(?=[\s/>])[^>]*>/giu, '')
      .trim();
    if (referenceText) matches.push({ sourceIndex: opening.sourceIndex, name: configuredByKey.get(key), referenceText });
  }
  if (!matches.length) return null;
  matches.sort((left, right) => left.sourceIndex - right.sourceIndex);
  const names = [...new Set(matches.map(match => match.name))];
  return Object.freeze({
    namespace: `tag:${names.join(',')}`,
    start: null,
    end: null,
    startMeta: null,
    endMeta: null,
    duplicate: matches.length > 1,
    complete: false,
    referenceText: matches.map(match => match.referenceText).join('\n'),
    lastReferenceText: matches.at(-1).referenceText,
    sourceIndex: matches[0].sourceIndex,
  });
}

export function parseStoryClockEvidence(value, referenceTags = '', calendar = null) {
  const shared = parseSharedStoryClock(value, calendar);
  const reference = parseStoryClockReference(value, referenceTags);
  return shared?.ambiguous || shared?.complete || shared?.singleEnd || shared?.paired && (shared.endMeta?.date || shared.endMeta?.time) ? shared : reference ?? shared;
}

export function resolveStoryClock(value, referenceTags = '', calendar = null) {
  const evidence = parseStoryClockEvidence(value, referenceTags, calendar);
  if (!evidence) return null;
  const current = evidence.pairs?.at(-1)?.endMeta ?? evidence.endMeta;
  const partial = evidence.paired || evidence.singleEnd ? current : null;
  const availableText = [partial?.date, partial?.time].filter(Boolean).join(' ');
  if (evidence.ambiguous) return Object.freeze({ status: 'ambiguous', source: 'timestamp', evidence, meta: partial, text: availableText, signature: storyClockSignature(evidence) });
  if (evidence.complete && !evidence.referenceText) {
    const currentPair = evidence.pairs?.at(-1);
    const meta = currentPair?.endMeta ?? evidence.endMeta ?? evidence.startMeta;
    return Object.freeze({ status: 'available', source: 'timestamp', evidence, meta,
      text: [meta?.date, meta?.time].filter(Boolean).join(' '), signature: storyClockSignature(evidence) });
  }
  if (evidence.singleEnd && !evidence.referenceText) {
    const meta = evidence.endMeta;
    return Object.freeze({ status: 'available', source: 'timestamp', evidence, meta,
      text: [meta?.date, meta?.time].filter(Boolean).join(' '), signature: storyClockSignature(evidence) });
  }
  const textValue = evidence.lastReferenceText ?? evidence.referenceText;
  if (textValue) return Object.freeze({ status: 'available', source: 'reference', evidence, text: textValue, signature: storyClockSignature(evidence) });
  return Object.freeze({ status: 'incomplete', source: 'timestamp', evidence, meta: partial, text: availableText, signature: storyClockSignature(evidence) });
}

export function storyClockSignature(clock) {
  if (!clock) return '';
  if (clock.referenceText == null) {
    if (!Array.isArray(clock.tokens) || clock.tokens.length <= 2) return JSON.stringify([clock.namespace.toLocaleLowerCase(), clock.start ?? null, clock.end ?? null]);
    return JSON.stringify([clock.namespace.toLocaleLowerCase(), ...clock.tokens.map(token => [token.kind, token.raw])]);
  }
  return JSON.stringify([clock.namespace.toLocaleLowerCase('en-US'), null, null, clock.referenceText]);
}

export function buildMyKnotsClockPrompt(settings = {}) {
  const raw = text(settings.storyClockPrompt);
  if (raw.trim()) return raw;
  return DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT;
}

export function decideStoryClockInjection({ owner, ownActive, ownCustom, peerActive, peerCustom } = {}) {
  if (!ownActive) return Object.freeze({ inject: false, status: 'closed' });
  if (ownCustom) return Object.freeze({ inject: true, status: 'custom' });
  if (peerActive && peerCustom) return Object.freeze({ inject: false, status: 'adapted-peer-custom' });
  if (owner === 'myknots' && peerActive) return Object.freeze({ inject: false, status: 'adapted-sdc' });
  return Object.freeze({ inject: true, status: peerActive ? 'primary-default' : 'standalone-default' });
}

export function extensionStoryClockState({ extensionNames = [], disabledExtensions = [], extensionSuffix, peerSettings } = {}) {
  const extensionId = extensionNames.find(name => String(name).endsWith(extensionSuffix)) ?? null;
  const active = Boolean(extensionId && !disabledExtensions.includes(extensionId) && peerSettings && peerSettings.pluginEnabled !== false && peerSettings.storyClockEnabled !== false);
  return Object.freeze({ active, custom: active && typeof peerSettings.storyClockPrompt === 'string' && peerSettings.storyClockPrompt.trim().length > 0 });
}

export function createMyKnotsStoryClockController({ context, settings, peerState = () => ({ active: false, custom: false }) } = {}) {
  let last = Object.freeze({ inject: false, status: 'unavailable' });
  const refresh = () => {
    const host = context?.();
    const setPrompt = host?.setExtensionPrompt;
    if (typeof setPrompt !== 'function') return (last = Object.freeze({ inject: false, status: 'unavailable' }));
    const current = settings?.() ?? {};
    const peer = peerState?.() ?? {};
    const decision = decideStoryClockInjection({
      owner: 'myknots',
      ownActive: current.pluginEnabled !== false && current.storyClockEnabled !== false,
      ownCustom: text(current.storyClockPrompt).trim().length > 0,
      peerActive: peer.active === true,
      peerCustom: peer.custom === true,
    });
    setPrompt(MYKNOTS_STORY_CLOCK_KEY, '');
    if (decision.inject) {
      const promptType = host.constants?.promptTypes?.IN_CHAT ?? 1;
      const promptRole = host.constants?.promptRoles?.SYSTEM ?? 0;
      setPrompt(MYKNOTS_STORY_CLOCK_KEY, buildMyKnotsClockPrompt(current), promptType, STORY_CLOCK_DEPTH, false, promptRole);
    }
    return (last = decision);
  };
  const clear = () => { context?.()?.setExtensionPrompt?.(MYKNOTS_STORY_CLOCK_KEY, ''); last = Object.freeze({ inject: false, status: 'closed' }); return last; };
  return Object.freeze({ refresh, clear, getState: () => last });
}

export function createStoryClockStatusProjection({ controller, documentRef = globalThis.document, labelFor = state => state?.status ?? '' } = {}) {
  if (!controller || typeof controller.refresh !== 'function' || typeof controller.getState !== 'function') throw new TypeError('story clock controller 无效');
  return ({ readOnly = false } = {}) => {
    const state = readOnly ? controller.getState() : controller.refresh();
    const result = Object.freeze({ ...state, label: labelFor(state) });
    try {
      const root = documentRef?.getElementById?.('qqj-panel-host')?.shadowRoot;
      const node = root?.getElementById?.('qqj-story-clock-status') ?? root?.querySelector?.('#qqj-story-clock-status');
      if (node) node.textContent = result.label;
    } catch { /* 状态投影不影响 prompt 协调 */ }
    return result;
  };
}
