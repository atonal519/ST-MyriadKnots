import { normalizeAutoHideKeepAiCount } from '../settings.js';

const MARKER_KEY = 'qianqianjieAutoHide';
const READY_CSE = new Set(['ready', 'noChange']);
const READY_MEMORY = new Set(['ready', 'needsReview']);

const autoHideError = (code, message) => { const error = new Error(message); error.code = code; return error; };
const isSystemEvent = message => message?.is_system === true && Boolean(message?.extra?.type);
const isAssistantMessage = message => message?.is_user === false && !isSystemEvent(message);
const ownsMessage = (message, chatId) => message?.extra?.[MARKER_KEY]?.schemaVersion === 1 && message.extra[MARKER_KEY].chatId === chatId;
const contiguousRanges = indexes => {
  const ranges = [];
  for (const value of [...indexes].sort((left, right) => left - right)) {
    const tail = ranges.at(-1);
    if (tail && tail.end + 1 === value) tail.end = value;
    else ranges.push({ start: value, end: value });
  }
  return ranges;
};

export function planAutoHide({ chat = [], memoryState = null, keepAiCount = 3, restoreAll = false } = {}) {
  const stableChatId = typeof memoryState?.chatId === 'string' ? memoryState.chatId : '';
  if (!stableChatId) return Object.freeze({ status: 'unavailable', hideRanges: Object.freeze([]), unhideRanges: Object.freeze([]), hideThrough: null, keepFrom: null });
  const source = Array.isArray(chat) ? chat : [];
  const assistants = source.map((message, messageIndex) => isAssistantMessage(message) ? { message, messageIndex } : null).filter(Boolean);
  const owned = source.map((message, messageIndex) => ownsMessage(message, stableChatId) ? messageIndex : null).filter(Number.isInteger);
  let hideThrough = -1;
  let keepFrom = 0;
  if (!restoreAll && assistants.length > normalizeAutoHideKeepAiCount(keepAiCount)) {
    const earliestKeptPosition = assistants.length - normalizeAutoHideKeepAiCount(keepAiCount);
    const previousAssistant = assistants[earliestKeptPosition - 1];
    keepFrom = previousAssistant ? previousAssistant.messageIndex + 1 : 0;
    const floors = [...(memoryState?.floors ?? [])].sort((left, right) => (left.assistantSeq ?? 0) - (right.assistantSeq ?? 0));
    let reliableThrough = -1;
    for (let index = 0; index < floors.length; index += 1) {
      const floor = floors[index];
      const messageIndex = floor?.messageIndex;
      if (floor?.assistantSeq !== index + 1 || !Number.isInteger(messageIndex) || !isAssistantMessage(source[messageIndex])) break;
      if (!floor.memoryId || !READY_MEMORY.has(floor.status) || !READY_CSE.has(floor.cse?.status)) break;
      reliableThrough = messageIndex;
    }
    hideThrough = Math.min(keepFrom - 1, reliableThrough);
  }
  const desired = new Set();
  if (hideThrough >= 0) for (let index = 0; index <= hideThrough; index += 1) {
    const message = source[index];
    if (!message || isSystemEvent(message)) continue;
    if (message.is_system !== true || ownsMessage(message, stableChatId)) desired.add(index);
  }
  const hideIndexes = [...desired].filter(index => source[index]?.is_system !== true);
  const unhideIndexes = owned.filter(index => !desired.has(index));
  return Object.freeze({
    status: 'ready',
    chatId: stableChatId,
    hideRanges: Object.freeze(contiguousRanges(hideIndexes).map(Object.freeze)),
    unhideRanges: Object.freeze(contiguousRanges(unhideIndexes).map(Object.freeze)),
    hideThrough: hideThrough >= 0 ? hideThrough : null,
    keepFrom,
  });
}

function snapshotMessages(chat, range) {
  return Array.from({ length: range.end - range.start + 1 }, (_, offset) => {
    const message = chat[range.start + offset];
    return { message, hadIsSystem: Boolean(message && Object.hasOwn(message, 'is_system')), isSystem: message?.is_system, hadExtra: Boolean(message && Object.hasOwn(message, 'extra')), extra: message?.extra === undefined ? undefined : structuredClone(message.extra) };
  });
}

function restoreMessages(snapshots) {
  for (const saved of snapshots) {
    if (!saved.message) continue;
    if (saved.hadIsSystem) saved.message.is_system = saved.isSystem;
    else delete saved.message.is_system;
    if (saved.hadExtra) saved.message.extra = saved.extra;
    else delete saved.message.extra;
  }
}

function markRange(chat, range, stableChatId, hide) {
  for (let index = range.start; index <= range.end; index += 1) {
    const message = chat[index];
    if (!message) continue;
    if (hide) {
      if (!message.extra || typeof message.extra !== 'object' || Array.isArray(message.extra)) message.extra = {};
      message.extra[MARKER_KEY] = { schemaVersion: 1, chatId: stableChatId };
    } else if (message.extra && typeof message.extra === 'object') {
      delete message.extra[MARKER_KEY];
      if (!Object.keys(message.extra).length) delete message.extra;
    }
  }
}

const rangeArgument = range => range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;

export function createAutoHideController({ hostAdapter, memoryRuntime, settings, notifyUser = null, logger = console } = {}) {
  if (!hostAdapter?.snapshot || !memoryRuntime?.getState || !settings?.get) throw new TypeError('自动隐藏控制器依赖无效');
  let disposed = false;
  let epoch = 0;
  let tail = Promise.resolve();

  const assertSameHost = hostChatId => {
    const current = hostAdapter.snapshot();
    if (current.chatId !== hostChatId) throw autoHideError('QQJ_AUTO_HIDE_CHAT_CHANGED', '聊天已切换，旧聊天的自动隐藏操作已停止。');
    return current;
  };

  async function executeRange({ stableChatId, hostChatId, range, hide }) {
    const snapshot = assertSameHost(hostChatId);
    const execute = snapshot.context?.executeSlashCommandsWithOptions;
    if (typeof execute !== 'function') throw autoHideError('QQJ_AUTO_HIDE_UNSUPPORTED', '当前酒馆版本不支持自动隐藏命令。');
    const saved = snapshotMessages(snapshot.chat, range);
    markRange(snapshot.chat, range, stableChatId, hide);
    try {
      await execute.call(snapshot.context, `/${hide ? 'hide' : 'unhide'} ${rangeArgument(range)}`);
      const current = assertSameHost(hostChatId);
      for (let index = range.start; index <= range.end; index += 1) {
        const message = current.chat[index];
        if (!message || message.is_system !== hide || ownsMessage(message, stableChatId) !== hide) throw autoHideError('QQJ_AUTO_HIDE_VERIFY_FAILED', '酒馆没有确认自动隐藏结果。');
      }
    } catch (error) {
      restoreMessages(saved);
      throw error;
    }
  }

  async function apply({ restoreAll = false, explicit = false, operationEpoch = epoch } = {}) {
    if (disposed) return Object.freeze({ status: 'disposed' });
    if (operationEpoch !== epoch) return Object.freeze({ status: 'stopped' });
    const config = settings.get();
    if (config.pluginEnabled === false) return Object.freeze({ status: 'disabled' });
    if (!explicit && config.autoHideEnabled !== true) return Object.freeze({ status: 'disabled' });
    const host = hostAdapter.snapshot();
    const state = memoryRuntime.getState();
    const metadataChatId = host.context?.chatMetadata?.qianqianjie?.chatId;
    if (metadataChatId !== state?.chatId) return Object.freeze({ status: 'stale' });
    const plan = planAutoHide({ chat: host.chat, memoryState: state, keepAiCount: config.autoHideKeepAiCount, restoreAll });
    if (plan.status !== 'ready') return plan;
    try {
      for (const range of plan.unhideRanges) {
        if (disposed || operationEpoch !== epoch) return Object.freeze({ ...plan, status: 'stopped' });
        await executeRange({ stableChatId: plan.chatId, hostChatId: host.chatId, range, hide: false });
        if (disposed || operationEpoch !== epoch) return Object.freeze({ ...plan, status: 'stopped' });
      }
      for (const range of plan.hideRanges) {
        if (disposed || operationEpoch !== epoch) return Object.freeze({ ...plan, status: 'stopped' });
        await executeRange({ stableChatId: plan.chatId, hostChatId: host.chatId, range, hide: true });
        if (disposed || operationEpoch !== epoch) return Object.freeze({ ...plan, status: 'stopped' });
      }
      return Object.freeze({ ...plan, status: plan.hideRanges.length || plan.unhideRanges.length ? 'applied' : 'unchanged' });
    } catch (error) {
      logger?.warn?.('[qianqianjie] auto hide failed', { code: error?.code ?? error?.name ?? 'QQJ_AUTO_HIDE_FAILED' });
      try { notifyUser?.({ kind: 'error', text: `千千结自动隐藏未完成：${error?.message || '未知错误'} 可在记忆设置中重试。` }); } catch { /* feedback must not affect chat */ }
      throw error;
    }
  }

  const enqueue = options => {
    const operationEpoch = epoch;
    const task = tail.catch(() => {}).then(() => apply({ ...options, operationEpoch }));
    tail = task.catch(() => {});
    return task;
  };
  const unsubscribe = typeof memoryRuntime.subscribe === 'function' ? memoryRuntime.subscribe(() => {
    const config = settings.get();
    if (!disposed && config.pluginEnabled !== false && config.autoHideEnabled === true) void enqueue().catch(() => {});
  }) : null;

  return Object.freeze({
    reconcile: () => enqueue(),
    applySettings: ({ enabled } = {}) => { epoch += 1; return enqueue({ restoreAll: enabled !== true, explicit: true }); },
    restoreOwned: () => { epoch += 1; return enqueue({ restoreAll: true, explicit: true }); },
    stop() { epoch += 1; },
    dispose() { disposed = true; epoch += 1; unsubscribe?.(); },
  });
}

export const AUTO_HIDE_MARKER_KEY = MARKER_KEY;
