import { isUuid } from '../host-context.js';
import { sanitizeMemoryContent } from '../memory-content-sanitizer.js';
import { scanWorldInfo, createWorldInfoSourceCandidates } from '../world-info-scanner.js';
import { withBaseProcessingPrompt } from '../internal-processing-prompt.js';
import { replaceCseSourceMacros } from '../cse-source-selection.js';
import { LEGACY_PEOPLE_PROFILE_FIELDS, PEOPLE_PROFILE_FIELDS, PEOPLE_PROFILE_FIELD_SET, emptyPeopleProfileFields } from './people-profile-fields.js';

export const PEOPLE_WORKSPACE_RECORD_ID = 'v3-people-workspace';
export const PEOPLE_WORKSPACE_SCHEMA_VERSION = 2;

export const DEFAULT_PROFILE_GUIDANCE = `你是“千千结”的人物基础资料整理员。只整理输入材料中有明确依据、适合长期建档的目标人物资料，不推测或续写剧情。

人物卡和世界书属于明确设定；楼层摘要是对已发生剧情的归纳；CSE Core 是已有的人物分析，不自动等同作者明确设定。按目标人物和来源归属整理信息，不要把不同人物、不同来源或彼此冲突的说法擅自拼成同一事实。遇到来源差异时不要输出核验说明或替作者裁决，只整理能够明确归属的稳定资料，无法判断时留空。

按基础信息、外貌、身份、性格与 NSFW 五类整理稳定资料。性别、年龄、生日没有明确依据时留空，外观年龄不能当作实际年龄。短期情绪、当前关系变化和一时应对不应写成固定人格。appearance 只填写无法归入细分外貌字段的必要补充，不重复五官、发型、体态、着装等已有内容；notes 只填写无法归入其他字段、仍值得长期保存的人物信息，不写来源说明、整理过程、核验过程、解释或模型想法。主动重新整理时，把原始人物卡、允许的世界书、摘要与 CSE 作为资料来源；manualProfile 中的人工维护字段及人工清空必须逐字返回。`;

export const PROFILE_FIXED_CONTRACT = `【固定人物资料合同】
1. 只处理输入 people 中的目标人物。characterCard、allowedWorldInfo、summaries 与 cseCoreTraits 是分开的来源，不得把一个人物的材料写给另一个人物。
2. 只返回一个 JSON 对象，profiles 每项固定含 personKey、${PEOPLE_PROFILE_FIELDS.join('、')}；aliases 是数组，其余资料字段是字符串。
3. personKey 必须逐字使用输入中的键；每个输入人物恰好返回一次，不得新增、遗漏或合并人物。没有依据的字段返回空字符串或空数组。
4. 不输出解释、剧情续写、数据库 ID 或 JSON 之外的内容。`;

export function buildPeopleProfileSystemPrompt(guidance = '') {
  const custom = typeof guidance === 'string' ? guidance : '';
  return withBaseProcessingPrompt(`${custom.trim() ? custom : DEFAULT_PROFILE_GUIDANCE}\n\n${PROFILE_FIXED_CONTRACT}`);
}

function errorWith(code, message) { return Object.assign(new Error(message), { code }); }
function clone(value) { return structuredClone(value); }
function clean(value, max = 20000) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length > max) throw errorWith('QQJ_PEOPLE_PROFILE_FIELD_TOO_LONG', '人物资料字段过长，请缩短后重试。');
  return result;
}
function aliasesText(value) {
  if (Array.isArray(value)) return [...new Set(value.map(item => clean(item, 500)).filter(Boolean))].join('、');
  return clean(value);
}
function nowIso(now) {
  const result = now()?.toISOString?.() ?? String(now());
  if (!Number.isFinite(Date.parse(result))) throw errorWith('QQJ_PEOPLE_TIME_INVALID', '人物资料时间无效。');
  return result;
}
function sameIdentity(left, right) {
  return left?.chatId === right?.chatId && left?.hostChatId === right?.hostChatId
    && left?.characterLocator === right?.characterLocator && left?.personaLocator === right?.personaLocator;
}
function profileFields(value = {}) {
  const result = emptyPeopleProfileFields();
  for (const field of PEOPLE_PROFILE_FIELDS) result[field] = field === 'aliases' ? aliasesText(value[field]) : clean(value[field]);
  return Object.freeze(result);
}
function macrosFor(reachable) {
  return Object.freeze({ user: clean(reachable?.baseline?.userPersona?.name, 500), char: clean(reachable?.baseline?.characterCard?.name, 500) });
}
function macroText(value, macros) { return replaceCseSourceMacros(value, macros); }
function profileWithMacros(value, macros) {
  const result = profileFields(value);
  return Object.freeze(Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, macroText(result[field], macros)])));
}
function manualProfile(value, macros) {
  if (!value) return Object.freeze({});
  return Object.freeze(Object.fromEntries((value.manualFields ?? []).map(field => [field, macroText(value[field], macros)])));
}
function manualFields(value, schemaVersion) {
  if (schemaVersion === 1) return value.source === 'manual' ? [...LEGACY_PEOPLE_PROFILE_FIELDS] : [];
  if (!Array.isArray(value.manualFields) || value.manualFields.some(field => !PEOPLE_PROFILE_FIELD_SET.has(field))) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物资料人工字段标记无效。');
  return [...new Set(value.manualFields)];
}
function validateProfile(value, entityId, schemaVersion) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.entityId !== entityId || !isUuid(entityId)) {
    throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物资料记录损坏，已停止读取。');
  }
  if (!['manual', 'generated'].includes(value.source) || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物资料来源或时间无效，已停止读取。');
  }
  return Object.freeze({ entityId, ...profileFields(value), manualFields: Object.freeze(manualFields(value, schemaVersion)), source: value.source, createdAt: value.createdAt, updatedAt: value.updatedAt });
}
function validateAvatar(value, entityId) {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value) || !isUuid(entityId)) {
    throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物头像记录无效，已停止读取。');
  }
  return value;
}
export function validatePeopleWorkspace(value, expectedChatId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![1, PEOPLE_WORKSPACE_SCHEMA_VERSION].includes(value.schemaVersion) || value.kind !== 'qqj-v3-people-workspace'
    || !isUuid(value.chatId) || value.chatId !== expectedChatId
    || !Array.isArray(value.selectedEntityIds) || !value.profilesByEntityId || typeof value.profilesByEntityId !== 'object' || Array.isArray(value.profilesByEntityId)
    || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物工作区记录损坏，已停止读取以避免串档。');
  }
  const selectedEntityIds = [];
  for (const id of value.selectedEntityIds) {
    if (!isUuid(id)) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '重要人物标识无效。');
    if (!selectedEntityIds.includes(id)) selectedEntityIds.push(id);
  }
  const profilesByEntityId = {};
  for (const [entityId, profile] of Object.entries(value.profilesByEntityId)) profilesByEntityId[entityId] = validateProfile(profile, entityId, value.schemaVersion);
  const avatarsByEntityId = {};
  if (value.schemaVersion === PEOPLE_WORKSPACE_SCHEMA_VERSION) {
    if (!value.avatarsByEntityId || typeof value.avatarsByEntityId !== 'object' || Array.isArray(value.avatarsByEntityId)) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物头像索引无效。');
    for (const [entityId, avatar] of Object.entries(value.avatarsByEntityId)) avatarsByEntityId[entityId] = validateAvatar(avatar, entityId);
  }
  return Object.freeze({
    schemaVersion: PEOPLE_WORKSPACE_SCHEMA_VERSION, kind: 'qqj-v3-people-workspace', chatId: value.chatId,
    selectedEntityIds: Object.freeze(selectedEntityIds), profilesByEntityId: Object.freeze(profilesByEntityId), avatarsByEntityId: Object.freeze(avatarsByEntityId),
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  });
}

export function createPeopleWorkspaceStore({ client } = {}) {
  if (!client || typeof client.get !== 'function' || typeof client.put !== 'function') throw new TypeError('人物工作区需要 record/CAS client');
  const collection = chatId => `chat-${chatId}`;
  async function read(identity) {
    if (!isUuid(identity?.chatId)) throw errorWith('QQJ_PEOPLE_IDENTITY_INVALID', '当前聊天身份不可用。');
    try {
      const envelope = await client.get(collection(identity.chatId), PEOPLE_WORKSPACE_RECORD_ID);
      if (!Number.isSafeInteger(envelope?.revision) || envelope.revision < 1) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物工作区版本无效。');
      return Object.freeze({ data: validatePeopleWorkspace(envelope.data, identity.chatId), revision: envelope.revision });
    } catch (error) {
      if (error?.status === 404) return Object.freeze({ data: null, revision: 0 });
      throw error;
    }
  }
  async function put(identity, data, expectedRevision, { signal } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw errorWith('QQJ_PEOPLE_REVISION_INVALID', '人物工作区版本无效。');
    const safe = validatePeopleWorkspace(data, identity?.chatId);
    const envelope = await client.put(collection(identity.chatId), PEOPLE_WORKSPACE_RECORD_ID, safe, expectedRevision, { signal });
    if (!Number.isSafeInteger(envelope?.revision) || envelope.revision !== expectedRevision + 1) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物工作区写入回读版本无效。');
    return Object.freeze({ data: validatePeopleWorkspace(envelope.data, identity.chatId), revision: envelope.revision });
  }
  return Object.freeze({ read, put });
}

function activePersonEntities(reachable) {
  return (reachable?.entities ?? []).filter(entity => entity?.entityType === 'person' && entity.recordStatus === 'active'
    && entity.status !== 'merged' && entity.status !== 'invalidated' && entity.specialRole !== 'user');
}
function candidateProjection(reachable, memoryState, workspace) {
  const counts = new Map();
  for (const memory of reachable?.floorMemories ?? []) {
    if (memory.recordStatus !== 'active') continue;
    for (const participant of memory.participants ?? []) counts.set(participant.entityId, (counts.get(participant.entityId) ?? 0) + 1);
  }
  const cseById = new Map((memoryState?.cseSubjects ?? []).map(subject => [subject.subjectEntityId, subject]));
  const selected = new Set(workspace?.selectedEntityIds ?? []);
  const macros = macrosFor(reachable);
  return Object.freeze(activePersonEntities(reachable).filter(entity => {
    const cse = cseById.get(entity.id);
    const sourcedCse = [...(cse?.core ?? []), ...(cse?.adaptive ?? []), ...(cse?.situational ?? [])].some(item => item.sourceFloorId || item.origin === 'delta');
    return Boolean(entity.firstSeenFloorId || counts.get(entity.id) || sourcedCse);
  }).map(entity => {
    const storedProfile = workspace?.profilesByEntityId?.[entity.id] ?? null;
    const profile = storedProfile ? Object.freeze({ ...storedProfile, ...profileWithMacros(storedProfile, macros) }) : null;
    const cse = cseById.get(entity.id) ?? null;
    const appearanceCount = counts.get(entity.id) ?? 0;
    return Object.freeze({
      entityId: entity.id, displayName: profile?.name || macroText(entity.displayName, macros),
      entityDisplayName: macroText(entity.displayName, macros), aliases: Object.freeze((entity.aliases ?? []).map(alias => macroText(alias?.name, macros)).filter(Boolean)),
      specialRole: entity.specialRole, selected: selected.has(entity.id), profiled: Boolean(profile), profile, avatar: workspace?.avatarsByEntityId?.[entity.id] ?? null,
      recommended: appearanceCount >= 2 || (cse?.core?.length ?? 0) > 0, appearanceCount, cse,
    });
  }).sort((left, right) => Number(right.selected) - Number(left.selected) || Number(right.recommended) - Number(left.recommended)
    || right.appearanceCount - left.appearanceCount || left.displayName.localeCompare(right.displayName, 'zh-Hans-CN')));
}

function emptyWorkspace(chatId, timestamp) {
  return Object.freeze({ schemaVersion: PEOPLE_WORKSPACE_SCHEMA_VERSION, kind: 'qqj-v3-people-workspace', chatId,
    selectedEntityIds: Object.freeze([]), profilesByEntityId: Object.freeze({}), avatarsByEntityId: Object.freeze({}), createdAt: timestamp, updatedAt: timestamp });
}
function sameFields(left, right) { return PEOPLE_PROFILE_FIELDS.every(field => String(left?.[field] ?? '') === String(right?.[field] ?? '')); }
function effectiveSummary(memory) { return memory?.summary?.effectiveSource === 'user' ? memory.summary.userText : memory?.summary?.aiText; }

export function createPeopleWorkspaceRuntime({
  store, session, foundationRuntime, memoryRuntime, generateUtilityTask, sourcePermissions,
  contextProvider, sanitizerOptions = () => ({}), scanner = scanWorldInfo,
  sourceCandidateFactory = createWorldInfoSourceCandidates, profilePromptGuidance = () => '', isEnabled = true, now = () => new Date(), logger = console,
} = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.put !== 'function') throw new TypeError('人物工作区 store 无效');
  if (!session || typeof session.identity !== 'function') throw new TypeError('人物工作区 session 无效');
  if (!foundationRuntime || typeof foundationRuntime.getReachable !== 'function') throw new TypeError('人物工作区 foundationRuntime 无效');
  if (!memoryRuntime || typeof memoryRuntime.getState !== 'function') throw new TypeError('人物工作区 memoryRuntime 无效');
  if (typeof generateUtilityTask !== 'function' || typeof contextProvider !== 'function') throw new TypeError('人物资料生成依赖无效');
  if (!sourcePermissions || typeof sourcePermissions.filterCandidates !== 'function') throw new TypeError('人物资料来源许可依赖无效');
  let epoch = 0, active = null, workspace = null, revision = 0, chatId = null, people = Object.freeze([]), lastError = null;
  const concurrentWrites = new Set();
  const subscribers = new Set();
  const enabled = () => { try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; } catch { return false; } };
  const notify = () => { const value = getState(); for (const listener of subscribers) { try { listener(value); } catch { /* view isolation */ } } return value; };
  const capture = () => Object.freeze({ ...session.identity() });
  const isCurrent = operation => {
    if (!enabled() || operation.epoch !== epoch || operation.controller.signal.aborted) return false;
    try { return sameIdentity(operation.identity, capture()); } catch { return false; }
  };
  const assertCurrent = operation => { if (!isCurrent(operation)) throw errorWith('QQJ_PEOPLE_STALE', '聊天已变化，迟到的人物资料结果没有写入。'); };
  const project = () => { people = candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace); };
  function getState() {
    const selected = Object.freeze([...(workspace?.selectedEntityIds ?? [])]);
    const profiles = Object.freeze({ ...(workspace?.profilesByEntityId ?? {}) });
    const avatars = Object.freeze({ ...(workspace?.avatarsByEntityId ?? {}) });
    return Object.freeze({ status: !enabled() ? 'disabled' : active?.kind ?? (workspace ? 'ready' : 'idle'), chatId,
      revision, selectedEntityIds: selected, profilesByEntityId: profiles, avatarsByEntityId: avatars, people, active: active ? Object.freeze({ kind: active.kind }) : null,
      unprofiledSelectedCount: people.filter(person => person.selected && !person.profiled).length, lastError });
  }
  function begin(kind) {
    if (!enabled()) throw errorWith('QQJ_PEOPLE_DISABLED', '千千结已关闭。');
    const alongsideGeneration = active?.kind === 'generating' && ['savingProfile', 'savingSelection', 'savingAvatar'].includes(kind);
    if (active && !alongsideGeneration) throw errorWith('QQJ_PEOPLE_BUSY', '人物资料正在处理，请稍候。');
    const operation = { kind, epoch, identity: capture(), controller: new AbortController() };
    if (alongsideGeneration) concurrentWrites.add(operation); else active = operation;
    lastError = null; notify(); return operation;
  }
  function adopt(operation, result) {
    assertCurrent(operation); workspace = result.data ?? emptyWorkspace(operation.identity.chatId, nowIso(now));
    revision = result.revision; chatId = operation.identity.chatId; project();
  }
  async function latest(operation) { const result = await store.read(operation.identity); assertCurrent(operation); return result; }
  async function mutate(operation, updater) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await latest(operation);
      const base = current.data ?? emptyWorkspace(operation.identity.chatId, nowIso(now));
      const next = updater(base);
      if (!next) { adopt(operation, current); return { changed: false, state: getState() }; }
      try { const saved = await store.put(operation.identity, next, current.revision, { signal: operation.controller.signal }); adopt(operation, saved); return { changed: true, state: getState() }; }
      catch (error) { if (error?.status === 409) continue; throw error; }
    }
    throw errorWith('QQJ_PEOPLE_CAS_CONFLICT', '人物资料同时发生多次修改，本次没有覆盖新数据，请重试。');
  }
  async function settle(operation, task) {
    try { await task(); }
    catch (error) {
      if (isCurrent(operation) && error?.name !== 'AbortError' && error?.code !== 'QQJ_PEOPLE_STALE') {
        lastError = Object.freeze({ code: String(error?.code ?? 'QQJ_PEOPLE_FAILED'), message: clean(error?.message || '人物资料处理失败。', 500) });
      }
      throw error;
    } finally {
      if (active === operation) active = null;
      concurrentWrites.delete(operation); notify();
    }
    return getState();
  }
  async function refresh({ refreshMemory = true } = {}) {
    if (active) return getState();
    const operation = begin('loading');
    return settle(operation, async () => {
      if (refreshMemory && typeof memoryRuntime.refreshStatus === 'function') await memoryRuntime.refreshStatus({ preferCached: true });
      assertCurrent(operation); adopt(operation, await store.read(operation.identity)); lastError = null; return notify();
    });
  }
  async function setSelectedEntityIds(entityIds) {
    const operation = begin('savingSelection');
    return settle(operation, async () => {
      const startingSelection = JSON.stringify(workspace?.selectedEntityIds ?? []);
      const allowed = new Set(candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace).map(person => person.entityId));
      const requested = [...new Set((Array.isArray(entityIds) ? entityIds : []).map(String))];
      if (requested.some(id => !isUuid(id) || !allowed.has(id))) throw errorWith('QQJ_PEOPLE_SELECTION_INVALID', '重要人物选择包含当前聊天不可用的人物。');
      const result = await mutate(operation, current => {
        if (JSON.stringify(current.selectedEntityIds) === JSON.stringify(requested)) return null;
        if (JSON.stringify(current.selectedEntityIds) !== startingSelection) throw errorWith('QQJ_PEOPLE_SELECTION_CONFLICT', '重要人物选择已在其他页面更新，本次没有覆盖新选择，请重试。');
        return { ...clone(current), selectedEntityIds: requested, updatedAt: nowIso(now) };
      });
      lastError = null; return result.state;
    });
  }
  async function saveProfile(entityId, fields, { manualFields: requestedManualFields = null } = {}) {
    const operation = begin('savingProfile');
    return settle(operation, async () => {
      const startingProfile = workspace?.profilesByEntityId?.[entityId] ?? null;
      const candidate = candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace).find(person => person.entityId === entityId);
      if (!candidate) throw errorWith('QQJ_PEOPLE_PROFILE_ENTITY_INVALID', '这个人物已不在当前聊天的可用人物中。');
      const requested = profileFields(fields);
      const result = await mutate(operation, current => {
        const existing = current.profilesByEntityId[entityId];
        if (JSON.stringify(existing ?? null) !== JSON.stringify(startingProfile)) throw errorWith('QQJ_PEOPLE_PROFILE_CONFLICT', '这个人物资料已在其他页面更新，本次没有覆盖新内容，请重试。');
        const declaredInput = requestedManualFields === null ? null : [...new Set(requestedManualFields)].filter(field => PEOPLE_PROFILE_FIELD_SET.has(field));
        const desired = existing && declaredInput ? { ...profileFields(existing), ...Object.fromEntries(declaredInput.map(field => [field, requested[field]])) } : requested;
        if (existing && sameFields(existing, desired)) return null;
        const changedFields = PEOPLE_PROFILE_FIELDS.filter(field => String(existing?.[field] ?? '') !== String(desired[field] ?? ''));
        const declared = requestedManualFields === null ? changedFields : [...new Set(requestedManualFields)].filter(field => PEOPLE_PROFILE_FIELD_SET.has(field) && changedFields.includes(field));
        const manual = [...new Set([...(existing?.manualFields ?? []), ...declared])];
        const timestamp = nowIso(now);
        return { ...clone(current), profilesByEntityId: { ...clone(current.profilesByEntityId), [entityId]: {
          entityId, ...desired, manualFields: manual, source: manual.length ? 'manual' : existing?.source ?? 'manual', createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
        } }, updatedAt: timestamp };
      });
      lastError = null; return result.state;
    });
  }
  async function saveAvatar(entityId, avatarDataUrl) {
    const operation = begin('savingAvatar');
    return settle(operation, async () => {
      const startingAvatar = workspace?.avatarsByEntityId?.[entityId] ?? null;
      const candidate = candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace).find(person => person.entityId === entityId);
      if (!candidate) throw errorWith('QQJ_PEOPLE_PROFILE_ENTITY_INVALID', '这个人物已不在当前聊天的可用人物中。');
      const requested = avatarDataUrl === null || avatarDataUrl === '' ? null : validateAvatar(avatarDataUrl, entityId);
      const result = await mutate(operation, current => {
        const existing = current.avatarsByEntityId[entityId] ?? null;
        if (existing === requested) return null;
        if (existing !== startingAvatar) throw errorWith('QQJ_PEOPLE_PROFILE_CONFLICT', '这个人物头像已在其他页面更新，本次没有覆盖新头像，请重试。');
        const timestamp = nowIso(now), avatars = { ...clone(current.avatarsByEntityId) };
        if (requested) avatars[entityId] = requested; else delete avatars[entityId];
        return { ...clone(current), avatarsByEntityId: avatars, updatedAt: timestamp };
      });
      lastError = null; return result.state;
    });
  }
  async function generationEnvelope(operation, targets) {
    const reachable = foundationRuntime.getReachable?.();
    const memoryState = memoryRuntime.getState();
    const entityById = new Map(activePersonEntities(reachable).map(entity => [entity.id, entity]));
    const cseById = new Map((memoryState.cseSubjects ?? []).map(subject => [subject.subjectEntityId, subject]));
    const macros = operation.macros;
    const peopleRequest = targets.map((target, index) => {
      const entity = entityById.get(target.entityId), cse = cseById.get(target.entityId);
      const summaries = (reachable?.floorMemories ?? []).filter(memory => memory.recordStatus === 'active' && (memory.participants ?? []).some(item => item.entityId === target.entityId))
        .map(memory => macroText(clean(effectiveSummary(memory), 4000), macros)).filter(Boolean).slice(-12);
      const characterCard = reachable?.baseline?.characterCard?.entityId === target.entityId ? reachable.baseline.characterCard : null;
      return { personKey: `person-${index + 1}`, currentName: macroText(entity?.displayName ?? target.entityDisplayName, macros),
        aliases: (entity?.aliases ?? []).map(alias => macroText(alias.name, macros)).filter(Boolean), summaries,
        cseCoreTraits: (cse?.core ?? []).map(item => ({ text: macroText(item.text, macros), source: item.sourceFloorId ? 'story-floor' : item.origin || 'unknown' })),
        characterCard: characterCard ? Object.fromEntries(['name', 'description', 'personality', 'scenario'].map(field => [field, macroText(characterCard[field], macros)])) : null,
        manualProfile: manualProfile(target.profile, macros), manualFields: target.profile?.manualFields ?? [] };
    });
    const context = contextProvider();
    const catalog = await scanner(context);
    assertCurrent(operation);
    const candidates = await sourceCandidateFactory(catalog);
    const allowed = sourcePermissions.filterCandidates({ chatId: operation.identity.chatId, candidates });
    if (!Array.isArray(allowed)) throw errorWith('QQJ_PEOPLE_WORLDBOOK_FILTER_INVALID', '世界书许可过滤结果无效。');
    const options = typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions;
    const worldInfo = allowed.map(candidate => ({ source: candidate.world, label: candidate.label,
      content: macroText(sanitizeMemoryContent(candidate.content, options), macros) })).filter(item => item.content);
    const request = { task: '整理选中人物的静态基础资料', people: peopleRequest, allowedWorldInfo: worldInfo };
    const serialized = JSON.stringify(request);
    if (serialized.length > 300000) throw errorWith('QQJ_PEOPLE_GENERATION_TOO_LARGE', '选中人物或可用资料过多，本次整理输入超过安全大小；选择与现有资料均已保留。');
    return { request, keys: new Map(peopleRequest.map((person, index) => [person.personKey, targets[index].entityId])) };
  }
  function parseGenerated(result, keys, macros) {
    const raw = result?.jsonData ?? result?.textData ?? result;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.profiles)) throw errorWith('QQJ_PEOPLE_GENERATION_INVALID', '人物资料回复格式无效，可重新整理。');
    const found = new Map();
    for (const item of raw.profiles) {
      const key = clean(item?.personKey, 80);
      if (!keys.has(key) || found.has(key)) throw errorWith('QQJ_PEOPLE_GENERATION_BINDING_INVALID', '人物资料回复含未知或重复人物，未写入任何资料。');
      found.set(key, profileWithMacros(item, macros));
    }
    if (found.size !== keys.size) throw errorWith('QQJ_PEOPLE_GENERATION_BINDING_INVALID', '人物资料回复遗漏人物，未写入任何资料。');
    return new Map([...found].map(([key, value]) => [keys.get(key), value]));
  }
  async function generateProfiles(targetResolver, { replaceExisting = false } = {}) {
    const operation = begin('generating');
    operation.macros = macrosFor(foundationRuntime.getReachable?.());
    const guidanceSnapshot = typeof profilePromptGuidance === 'function' ? profilePromptGuidance() : profilePromptGuidance;
    const systemPrompt = buildPeopleProfileSystemPrompt(guidanceSnapshot);
    return settle(operation, async () => {
      const targets = targetResolver(candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace));
      if (!targets.length) throw errorWith('QQJ_PEOPLE_NOTHING_TO_GENERATE', replaceExisting ? '当前人物不可重新整理。' : '选中的人物都已有基础资料。');
      const envelope = await generationEnvelope(operation, targets);
      assertCurrent(operation);
      const result = await generateUtilityTask({ systemPrompt, taskMessages: [{ role: 'user', content: JSON.stringify(envelope.request) }],
        maxTokens: 30000, temperature: 0, signal: operation.controller.signal, includeCharacterCard: false, worldInfoSource: 'none' });
      assertCurrent(operation);
      const generated = parseGenerated(result, envelope.keys, operation.macros);
      const persisted = await mutate(operation, current => {
        const profiles = { ...clone(current.profilesByEntityId) }; let changed = false; const timestamp = nowIso(now);
        for (const [entityId, fields] of generated) {
          const existing = profiles[entityId];
          if (existing && !replaceExisting) continue;
          const manual = existing?.manualFields ?? [];
          const merged = { ...fields };
          for (const field of manual) merged[field] = existing[field];
          profiles[entityId] = { entityId, ...merged, manualFields: [...manual], source: manual.length ? 'manual' : 'generated', createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp }; changed = true;
        }
        return changed ? { ...clone(current), profilesByEntityId: profiles, updatedAt: timestamp } : null;
      });
      lastError = null; return persisted.state;
    });
  }
  async function generateMissingProfiles() {
    return generateProfiles(candidates => candidates.filter(person => person.selected && !person.profiled));
  }
  async function regenerateProfile(entityId) {
    return generateProfiles(candidates => candidates.filter(person => person.entityId === entityId && person.selected), { replaceExisting: true });
  }
  function invalidate() {
    epoch += 1; active?.controller.abort(); for (const operation of concurrentWrites) operation.controller.abort();
    active = null; concurrentWrites.clear(); workspace = null; revision = 0; chatId = null; people = Object.freeze([]); lastError = null; notify();
  }
  async function setEnabled(value) { if (value !== true) { invalidate(); return getState(); } return refresh(); }
  const unsubscribeMemory = typeof memoryRuntime.subscribe === 'function' ? memoryRuntime.subscribe(() => {
    if (!workspace || active) return;
    try { if (capture().chatId !== chatId) return; project(); notify(); } catch { /* lifecycle owns identity transition */ }
  }) : null;
  return Object.freeze({ refresh, start: () => enabled() ? refresh() : Promise.resolve(getState()), setSelectedEntityIds, saveProfile, saveAvatar, generateMissingProfiles, regenerateProfile, invalidate, abortAll: invalidate, setEnabled,
    getState, subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('人物工作区 listener 无效'); subscribers.add(listener); return () => subscribers.delete(listener); },
    destroy() { unsubscribeMemory?.(); invalidate(); },
  });
}
