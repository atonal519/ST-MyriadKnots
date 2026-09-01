import { parseJsonOutput } from './compact-api-client.js';
import { createArchiveV2MemoryPeopleResult } from './archive-v2-memory-people-foundation.js';

export class ArchiveV2MemoryPeopleConsolidationError extends Error {
  constructor(message, code = 'ARCHIVE_V2_MEMORY_PEOPLE_CONSOLIDATION_INVALID') {
    super(message);
    this.name = 'ArchiveV2MemoryPeopleConsolidationError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ArchiveV2MemoryPeopleConsolidationError(message, code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function captureSnapshot(contextProvider) {
  let raw;
  try { raw = contextProvider(); }
  catch { fail('宿主身份不可用', 'ARCHIVE_V2_MEMORY_PEOPLE_CONTEXT_INVALID'); }
  if (!isPlainObject(raw)) fail('宿主身份不可用', 'ARCHIVE_V2_MEMORY_PEOPLE_CONTEXT_INVALID');
  const snapshot = {
    hostChatId: raw.hostChatId,
    chatId: raw.chatId,
    characterLocator: raw.characterLocator ?? raw.characterAvatar,
    personaLocator: raw.personaLocator ?? raw.personaAvatar,
  };
  for (const value of Object.values(snapshot)) {
    if (typeof value !== 'string' || !value.trim()) fail('宿主身份不可用', 'ARCHIVE_V2_MEMORY_PEOPLE_CONTEXT_INVALID');
  }
  return Object.freeze(snapshot);
}

function sameSnapshot(left, right) {
  return left.hostChatId === right.hostChatId
    && left.chatId === right.chatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}

function systemPrompt() {
  return [
    '你是千千结的跨批人物归并器。本次输入只有已经完成的 memory batch 表格；不得读取、推断或声称读取角色卡、世界书或原始聊天全文。',
    '合并同一人物的中英文名、全名/简称、职场称呼；不要合并同名但证据不足的人。不得把用户本人建立为 people 项。',
    '必须一次性覆盖全部输入 people 行，不得只返回值得关注的人物。每个输入人物引用必须且只能归入一个输出人物的 sourcePeopleRefs，或归入根级 userSourcePeopleRefs；两处合计必须完整覆盖，不得遗漏、重复归属或引用不存在的人物。',
    'userSourcePeopleRefs 只用于标记第一层误列为人物、但实际确实是当前用户/主角本人的来源行。真正 NPC 即使名字、称谓或 localId 含 User、用户、主角等字样，也不得仅凭字符串猜测排除。',
    '只输出一个纯 JSON 根对象，禁止 Markdown、代码围栏、解释、前后缀和思维链。根对象必须且只能包含 people 与 userSourcePeopleRefs 两个数组。',
    'userSourcePeopleRefs 允许为空；每项必须且只能包含 batchIndex 与 localId，并精确引用输入中的批次人物。',
    'people 每项必须且只能包含 localId、displayName、aliases、recognitionReason、sourcePeopleRefs、recommendation、recommendationReason。',
    'localId 必须使用本次结果内唯一的 C1、C2……；displayName、recognitionReason、recommendationReason 是非空字符串；aliases 是去重字符串数组。',
    'sourcePeopleRefs 是非空数组，每项必须且只能包含 batchIndex 与 localId，并精确引用输入中的批次人物，例如 {"batchIndex":0,"localId":"P1"} 表示 B0:P1。',
    'recommendation 只能是 romance_candidate、important_supporting、background、uncertain 之一。',
    'recommendationReason 只依据当前输入记忆判断其是否可能是攻略对象；高出场率本身不等于攻略对象，共同好友、同事、医生等应按实际恋爱关系证据分类。',
    '不得生成完整人设、基础字段、好感数值、事件列表、行动建议或任何未列出的键。',
  ].join('\n');
}

function taskInput(batches) {
  return JSON.stringify(batches.map(batch => ({
    batchIndex: batch.batchIndex,
    people: batch.rows.people,
    facts: batch.rows.facts,
    relations: batch.rows.relations,
    events: batch.rows.events,
  })));
}

function unwrap(response) {
  let value = response;
  let finishReason;
  if (isPlainObject(response) && Object.hasOwn(response, 'jsonData')) {
    value = response.jsonData;
    finishReason = response.taskMetadata?.finishReason;
  }
  return parseJsonOutput(value, { finishReason });
}

export function createArchiveV2MemoryPeopleConsolidator({
  contextProvider,
  generateTask,
  isEnabled = true,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof contextProvider !== 'function') throw new TypeError('contextProvider 必须是函数');
  if (typeof generateTask !== 'function') throw new TypeError('generateTask 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') throw new TypeError('isEnabled 无效');
  if (typeof now !== 'function') throw new TypeError('now 必须是函数');

  let epoch = 0;
  let active = null;
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };
  const current = operation => {
    if (operation.epoch !== epoch || operation.controller.signal.aborted || !enabled()) return false;
    try { return sameSnapshot(operation.snapshot, captureSnapshot(contextProvider)); }
    catch { return false; }
  };

  function consolidate({ manifest, batches } = {}) {
    if (active) return active.promise;
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    let snapshot;
    try { snapshot = captureSnapshot(contextProvider); }
    catch (error) { return Promise.reject(error); }
    const operation = { epoch, snapshot, controller: new AbortController(), promise: null };
    operation.promise = (async () => {
      if (!current(operation)) return { status: 'stale' };
      let response;
      try {
        response = await generateTask({
          includeCharacterCard: false,
          worldInfoSource: 'none',
          substituteMacros: false,
          systemPrompt: systemPrompt(),
          taskMessages: [{ role: 'user', content: taskInput(batches) }],
          signal: operation.controller.signal,
          maxTokens: 30000,
          temperature: 0.1,
        });
      } catch {
        if (!current(operation)) return { status: 'stale' };
        throw new ArchiveV2MemoryPeopleConsolidationError(
          '人物整理请求失败', 'ARCHIVE_V2_MEMORY_PEOPLE_CONSOLIDATION_FAILED',
        );
      }
      if (!current(operation)) return { status: 'stale' };
      let result;
      try {
        result = createArchiveV2MemoryPeopleResult({
          manifest,
          batches,
          output: unwrap(response),
          createdAt: now(),
        });
      } catch {
        if (!current(operation)) return { status: 'stale' };
        throw new ArchiveV2MemoryPeopleConsolidationError(
          '人物整理结果格式无效', 'ARCHIVE_V2_MEMORY_PEOPLE_CONSOLIDATION_FORMAT',
        );
      }
      return current(operation) ? { status: 'ready', result } : { status: 'stale' };
    })();
    active = operation;
    operation.promise.then(
      () => { if (active === operation) active = null; },
      () => { if (active === operation) active = null; },
    );
    return operation.promise;
  }

  function invalidate() {
    epoch += 1;
    active?.controller.abort();
  }

  return Object.freeze({ consolidate, invalidate, cancel: invalidate });
}
