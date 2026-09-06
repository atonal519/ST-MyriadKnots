export const MYKNOTS_STORY_CLOCK_KEY = 'myknots_story_clock';
export const STORY_CLOCK_DEPTH = 0;

export const DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT = [
  '【故事时间戳 QQJ｜每楼附加元数据】',
  '请在本楼正文最前与最后各放一个 HTML 注释，作为本楼的附加故事时间元数据。HTML 注释不会显示给读者。',
  '日期与时间的表达方式应与当前故事背景及正文保持一致。沿用正文已经使用的纪年、历法和计时方式，不因示例而切换格式。',
  '格式示例（仅示意字段结构，不指定故事年代或计时方式；请替换为本楼实际内容）：',
  '  <!-- QQJ-start | date=10月4日 | weekday=周二 | time=15:30 -->正文<!-- QQJ-end | date=10月4日 | weekday=周二 | time=16:00 -->',
  'start 与 end 都必须同时填写 date、weekday、time；weekday 只能使用周一至周日。上下文已有完整故事纪年时，date 原样复制年号与年份；未知年份时只写月日，不得猜现实年份。日期、历法、状态栏、时间戳等其他世界书要求仍须完整执行，QQJ 不替代、不合并、不改写它们。',
  '通常以上一楼 end 为参考推进本楼时间；若本楼没有可用参考，按当前剧情设定合理填写。除这两个注释外，不要在正文中讨论 QQJ。',
].join('\n');

const text = value => typeof value === 'string' ? value : '';
const field = (raw, name) => new RegExp(`(?:^|[|｜,，;；\\n])\\s*(?:${name})\\s*[=＝:]\\s*([^|｜,，;；\\n]+)`, 'iu').exec(raw)?.[1]?.trim() || null;

export function parseClockFields(raw) {
  const value = text(raw).trim();
  const date = field(value, 'date');
  const weekday = field(value, 'weekday|星期');
  const time = field(value, 'time');
  const weekdayValid = /^(?:周|週|星期|礼拜|禮拜)[一二三四五六日天]$/u.test(weekday ?? '');
  return Object.freeze({ raw: value, date, weekday, time, complete: Boolean(date && weekdayValid && time) });
}

function namespaceCandidate(source, namespace) {
  const startRe = new RegExp(`<!--\\s*${namespace}-start\\s+([\\s\\S]*?)\\s*-->`, 'igu');
  const endRe = new RegExp(`<!--\\s*${namespace}-end\\s+([\\s\\S]*?)\\s*-->`, 'igu');
  const starts = [...source.matchAll(startRe)], ends = [...source.matchAll(endRe)];
  if (!starts.length && !ends.length) return null;
  const start = starts[0] ?? null, end = ends[0] ?? null;
  const duplicate = starts.length !== 1 || ends.length !== 1;
  const ordered = Boolean(start && end && end.index >= start.index + start[0].length);
  const startMeta = start ? parseClockFields(start[1]) : null;
  const endMeta = end ? parseClockFields(end[1]) : null;
  return Object.freeze({
    namespace,
    start: startMeta?.raw ?? null,
    end: endMeta?.raw ?? null,
    startMeta,
    endMeta,
    duplicate,
    complete: !duplicate && ordered && startMeta?.complete === true && endMeta?.complete === true,
    sourceIndex: Math.min(start?.index ?? Infinity, end?.index ?? Infinity),
  });
}

export function parseSharedStoryClock(value) {
  const source = text(value);
  const candidates = ['SDC', 'QQJ', 'myknots'].map(namespace => namespaceCandidate(source, namespace)).filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((left, right) => Number(right.complete) - Number(left.complete) || left.sourceIndex - right.sourceIndex)[0];
}

export function storyClockSignature(clock) {
  if (!clock) return '';
  return JSON.stringify([clock.namespace.toLocaleLowerCase(), clock.start ?? null, clock.end ?? null]);
}

export function buildMyKnotsClockPrompt(settings = {}) {
  const raw = text(settings.storyClockPrompt);
  return raw.trim() ? raw : DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT;
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
