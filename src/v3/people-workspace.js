import { isUuid } from '../host-context.js';
import { sanitizeMemoryContent } from '../memory-content-sanitizer.js';
import { scanWorldInfo, createWorldInfoSourceCandidates } from '../world-info-scanner.js';
import { withBaseProcessingPrompt } from '../internal-processing-prompt.js';
import { replaceCseSourceMacros } from '../cse-source-selection.js';
import {
  LEGACY_PEOPLE_PROFILE_FIELDS, PEOPLE_PROFILE_DEFINITIONS, PEOPLE_PROFILE_FIELDS,
  PEOPLE_PROFILE_FIELD_SET, PEOPLE_PROFILE_LABELS, emptyPeopleProfileFields,
} from './people-profile-fields.js';
import {
  buildEntityIdentityDirectory, identityProjectionMembers, isIdentityDeleted,
  normalizeIdentityProjection, resolveIdentityEntityId,
} from './entity-identity.js';
import { PREQUEL_METADATA_KEY, selectPrequel } from './recall-prequel.js';

export const PEOPLE_WORKSPACE_RECORD_ID = 'v3-people-workspace';
export const PEOPLE_WORKSPACE_SCHEMA_VERSION = 3;
export const PEOPLE_PROFILE_INPUT_CHAR_BUDGET = 24000;

export const DEFAULT_PROFILE_GUIDANCE = `你是“千千结”的人物基础资料整理员。只整理输入材料中有明确依据、适合长期建档的目标人物资料，不推测或续写剧情。

人物卡和世界书属于明确设定；逐楼 history 的 storyContent 是该楼已经保存并按用户包裹符设置清洗后的完整正文，summary 是对该楼的归纳，facts 是按目标人物归属筛出的结构事实；CSE Core 是已有的人物分析，不自动等同作者明确设定。旧 AI 档案只能作为待更新的参考。按目标人物和来源归属整理信息，不要把正文里其他人物的描写、不同人物、不同来源或彼此冲突的说法擅自拼成目标人物事实。遇到来源差异时不要输出核验说明或替作者裁决，只整理能够明确归属的稳定资料。

priorContext 若存在，是用户导入的过去经历资料。只把其中明确属于目标人物、适合长期建档的信息作为参考；过去的短期状态不等于现在仍持续，existingProfile、当前 history 与 CSE 中明确出现的新变化优先。

按基础信息、外貌、身份、性格与 NSFW 五类整理稳定资料。性别、年龄、生日没有明确依据时不要输出对应字段，外观年龄不能当作实际年龄。短期情绪、当前关系变化和一时应对不应写成固定人格。appearance 只填写无法归入细分外貌字段的必要补充，不重复五官、发型、体态、着装等已有内容；notes 只填写无法归入其他字段、仍值得长期保存的人物信息，不写来源说明、整理过程、核验过程、解释或模型想法。主动重新整理时，把原始人物卡、允许的世界书、全历史摘要与结构事实、旧 AI 档案和 CSE 作为资料来源；没有新信息的字段省略并保留旧值，只有资料明确纠正旧值时才返回空字符串或空 aliases。人工字段由保存层保护，不需要逐字抄回。`;

const PROFILE_FIELD_GUIDE = PEOPLE_PROFILE_FIELDS
  .map(field => `${field}（${PEOPLE_PROFILE_LABELS[field]}）：${PEOPLE_PROFILE_DEFINITIONS[field]}`)
  .join('\n');

export const PROFILE_FIXED_CONTRACT = `【固定人物资料合同】
1. 只处理输入 people 中的目标人物。characterCard、allowedWorldInfo、history、cseCoreTraits、priorContext、existingProfile 与 manualProfile 是分开的来源；history.storyContent 是对应楼的完整已保存正文，summary 只是归纳，必须结合该楼目标相关事实判断归属，不得把正文中其他人物的描写写给目标人物，也不得把他人的私密认知当成目标人物资料。priorContext 标记为导入前情，只能作为过去经历背景，不是当前楼或当前状态。
2. history.auxiliaryStateSnapshot 若存在，是对应楼当前分支当时已保存的只读变量快照，只作人物整理辅助。它可能同时包含多个人物、不完整或过时信息，不能整份归给目标人物，也不能当作人工字段或权威证据；与正文或用户明确事实冲突时以正文和用户明确事实为准。
3. 只返回一个 JSON 对象；profiles 每个输入人物恰好一项，personKey 必须逐字使用输入中的键，不得新增、遗漏或合并人物。
4. 每项除 personKey 外只返回需要新增或纠正的字段。省略字段表示保留 existingProfile 旧值；明确纠正为无资料时才返回空字符串，aliases 可返回字符串或字符串数组，明确清除 aliases 时返回空字符串或空数组。不要返回 null、对象或其他错误类型。
5. sourceFragments 是长资料按顺序切出的连续来源片段；part/total 只表示同一来源的连续位置。依次吸收当前批次信息，并以 existingProfile 为本批起点，不要求一次看到全部来源。
6. manualProfile 和 manualFields 由保存层保护，不需要模型复制；不输出解释、剧情续写、数据库 ID 或 JSON 之外的内容。

【字段中文定义】
${PROFILE_FIELD_GUIDE}`;

export function buildPeopleProfileSystemPrompt(guidance = '', processingPrompt = '') {
  const custom = typeof guidance === 'string' ? guidance : '';
  return withBaseProcessingPrompt(`${custom.trim() ? custom : DEFAULT_PROFILE_GUIDANCE}\n\n${PROFILE_FIXED_CONTRACT}`, processingPrompt);
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
function existingAiProfile(value, macros) {
  if (!value) return Object.freeze({});
  const manual = new Set(value.manualFields ?? []);
  const projected = profileWithMacros(value, macros);
  return Object.freeze(Object.fromEntries(PEOPLE_PROFILE_FIELDS
    .filter(field => !manual.has(field) && projected[field])
    .map(field => [field, projected[field]])));
}
function generatedAliases(value) {
  if (typeof value === 'string') return Object.freeze({ valid: true, value: aliasesText(value) });
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return Object.freeze({ valid: false, value: '' });
  return Object.freeze({ valid: true, value: clean(aliasesText(value)) });
}
function generatedProfilePatch(value, macros) {
  const result = {};
  let invalidFields = 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({ fields: Object.freeze(result), invalidFields: 1 });
  for (const field of PEOPLE_PROFILE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    if (field === 'aliases') {
      try {
        const aliases = generatedAliases(value[field]);
        if (aliases.valid) result[field] = aliasesText(macroText(aliases.value, macros));
        else invalidFields += 1;
      } catch { invalidFields += 1; }
      continue;
    }
    if (typeof value[field] !== 'string') { invalidFields += 1; continue; }
    try { result[field] = macroText(clean(value[field]), macros); } catch { invalidFields += 1; }
  }
  return Object.freeze({ fields: Object.freeze(result), invalidFields });
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
function validateMaterialProgress(value, entityId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isUuid(entityId)
    || !Number.isSafeInteger(value.processedHistoryCount) || value.processedHistoryCount < 0
    || typeof value.materialSignature !== 'string' || !/^people-material-v1:[0-9]+:[0-9a-f]{16}$/u.test(value.materialSignature)
    || typeof value.contextSignature !== 'string' || !/^people-material-v1:[0-9]+:[0-9a-f]{16}$/u.test(value.contextSignature)
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物资料材料进度无效。');
  }
  return Object.freeze({ processedHistoryCount: value.processedHistoryCount, materialSignature: value.materialSignature,
    contextSignature: value.contextSignature, updatedAt: value.updatedAt });
}
export function validatePeopleWorkspace(value, expectedChatId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![1, 2, PEOPLE_WORKSPACE_SCHEMA_VERSION].includes(value.schemaVersion) || value.kind !== 'qqj-v3-people-workspace'
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
  if (value.schemaVersion >= 2) {
    if (!value.avatarsByEntityId || typeof value.avatarsByEntityId !== 'object' || Array.isArray(value.avatarsByEntityId)) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物头像索引无效。');
    for (const [entityId, avatar] of Object.entries(value.avatarsByEntityId)) avatarsByEntityId[entityId] = validateAvatar(avatar, entityId);
  }
  const identityRedirectsByEntityId = {};
  const deletedEntityIds = [];
  const profileMaterialProgressByEntityId = {};
  if (value.schemaVersion >= 3) {
    if (!value.identityRedirectsByEntityId || typeof value.identityRedirectsByEntityId !== 'object' || Array.isArray(value.identityRedirectsByEntityId)
      || !Array.isArray(value.deletedEntityIds)) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物身份映射无效。');
    for (const [source, target] of Object.entries(value.identityRedirectsByEntityId)) {
      if (!isUuid(source) || !isUuid(target) || source === target) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物身份映射包含无效标识。');
      identityRedirectsByEntityId[source] = target;
    }
    for (const id of value.deletedEntityIds) {
      if (!isUuid(id)) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '已删除人物标识无效。');
      if (!deletedEntityIds.includes(id)) deletedEntityIds.push(id);
    }
    for (const source of Object.keys(identityRedirectsByEntityId)) {
      const seen = new Set(); let current = source;
      while (identityRedirectsByEntityId[current]) {
        if (seen.has(current)) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物身份映射形成循环。');
        seen.add(current); current = identityRedirectsByEntityId[current];
      }
    }
    if (value.profileMaterialProgressByEntityId !== undefined) {
      if (!value.profileMaterialProgressByEntityId || typeof value.profileMaterialProgressByEntityId !== 'object' || Array.isArray(value.profileMaterialProgressByEntityId)) {
        throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物资料材料进度索引无效。');
      }
      for (const [entityId, progress] of Object.entries(value.profileMaterialProgressByEntityId)) {
        profileMaterialProgressByEntityId[entityId] = validateMaterialProgress(progress, entityId);
      }
    }
  }
  return Object.freeze({
    schemaVersion: PEOPLE_WORKSPACE_SCHEMA_VERSION, kind: 'qqj-v3-people-workspace', chatId: value.chatId,
    selectedEntityIds: Object.freeze(selectedEntityIds), profilesByEntityId: Object.freeze(profilesByEntityId), avatarsByEntityId: Object.freeze(avatarsByEntityId),
    identityRedirectsByEntityId: Object.freeze(identityRedirectsByEntityId), deletedEntityIds: Object.freeze(deletedEntityIds),
    profileMaterialProgressByEntityId: Object.freeze(profileMaterialProgressByEntityId),
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

function identityProjection(workspace) {
  return normalizeIdentityProjection(workspace ?? {});
}
function activePersonDirectory(reachable, workspace) {
  return buildEntityIdentityDirectory({ entities: reachable?.entities ?? [], identityProjection: identityProjection(workspace) })
    .filter(entry => entry.entityType === 'person' && entry.entity.specialRole !== 'user');
}
function activePersonEntities(reachable, workspace) {
  return activePersonDirectory(reachable, workspace).map(entry => entry.entity);
}
function candidateProjection(reachable, memoryState, workspace) {
  const projection = identityProjection(workspace);
  const counts = new Map();
  for (const memory of reachable?.floorMemories ?? []) {
    if (memory.recordStatus !== 'active') continue;
    const seen = new Set((memory.participants ?? []).map(participant => resolveIdentityEntityId(participant.entityId, projection)));
    for (const entityId of seen) if (!isIdentityDeleted(entityId, projection)) counts.set(entityId, (counts.get(entityId) ?? 0) + 1);
  }
  const cseById = new Map();
  for (const subject of memoryState?.cseSubjects ?? []) {
    const entityId = resolveIdentityEntityId(subject.subjectEntityId, projection);
    if (isIdentityDeleted(entityId, projection)) continue;
    const current = cseById.get(entityId) ?? { subjectEntityId: entityId, core: [], adaptive: [], situational: [] };
    for (const category of ['core', 'adaptive', 'situational']) {
      for (const raw of subject[category] ?? []) {
        const item = { ...raw, towardEntityId: raw.towardEntityId ? resolveIdentityEntityId(raw.towardEntityId, projection) : null };
        if (!current[category].some(existing => (existing.id && existing.id === item.id) || JSON.stringify(existing) === JSON.stringify(item))) current[category].push(item);
      }
    }
    cseById.set(entityId, current);
  }
  const selected = new Set((workspace?.selectedEntityIds ?? []).map(id => resolveIdentityEntityId(id, projection)));
  const macros = macrosFor(reachable);
  return Object.freeze(activePersonDirectory(reachable, workspace).filter(entry => {
    const entity = entry.entity;
    const cse = cseById.get(entity.id);
    const sourcedCse = [...(cse?.core ?? []), ...(cse?.adaptive ?? []), ...(cse?.situational ?? [])].some(item => item.sourceFloorId || item.origin === 'delta');
    return Boolean(entity.firstSeenFloorId || counts.get(entity.id) || sourcedCse);
  }).map(entry => {
    const entity = entry.entity;
    const storedProfile = workspace?.profilesByEntityId?.[entity.id] ?? null;
    const profile = storedProfile ? Object.freeze({ ...storedProfile, ...profileWithMacros(storedProfile, macros) }) : null;
    const cse = cseById.get(entity.id) ?? null;
    const appearanceCount = counts.get(entity.id) ?? 0;
    return Object.freeze({
      entityId: entity.id, displayName: profile?.name || macroText(entity.displayName, macros),
      entityDisplayName: macroText(entity.displayName, macros), aliases: Object.freeze(entry.aliases.map(alias => macroText(alias, macros)).filter(Boolean)),
      specialRole: entity.specialRole, selected: selected.has(entity.id), profiled: Boolean(profile), profile, avatar: workspace?.avatarsByEntityId?.[entity.id] ?? null,
      appearanceCount, cse,
    });
  }).sort((left, right) => Number(right.selected) - Number(left.selected)
    || right.appearanceCount - left.appearanceCount || left.displayName.localeCompare(right.displayName, 'zh-Hans-CN')));
}

function emptyWorkspace(chatId, timestamp) {
  return Object.freeze({ schemaVersion: PEOPLE_WORKSPACE_SCHEMA_VERSION, kind: 'qqj-v3-people-workspace', chatId,
    selectedEntityIds: Object.freeze([]), profilesByEntityId: Object.freeze({}), avatarsByEntityId: Object.freeze({}),
    identityRedirectsByEntityId: Object.freeze({}), deletedEntityIds: Object.freeze([]), profileMaterialProgressByEntityId: Object.freeze({}),
    createdAt: timestamp, updatedAt: timestamp });
}
function sameFields(left, right) { return PEOPLE_PROFILE_FIELDS.every(field => String(left?.[field] ?? '') === String(right?.[field] ?? '')); }
function effectiveSummary(memory) { return memory?.summary?.effectiveSource === 'user' ? memory.summary.userText : memory?.summary?.aiText; }
function materialSignature(value) {
  const text = JSON.stringify(value);
  let left = 0x811c9dc5, right = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul((right + code + index) >>> 0, 0x85ebca6b) >>> 0;
  }
  return `people-material-v1:${text.length}:${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}
function targetRole(primary, related, entityId, primaryRole = 'owner', relatedRole = 'target', projection = {}) {
  const owns = resolveIdentityEntityId(primary, projection) === entityId;
  const receives = (related ?? []).some(id => resolveIdentityEntityId(id, projection) === entityId);
  return owns && receives ? `${primaryRole}-and-${relatedRole}` : owns ? primaryRole : receives ? relatedRole : null;
}
function targetHistory(reachable, entityId, macros, projection = {}) {
  const floorSequence = new Map((reachable?.floors ?? []).map(floor => [floor.id, floor.assistantSeq]));
  const floorContent = new Map((reachable?.floors ?? []).map(floor => [floor.id, floor.content?.canonicalContent]));
  return Object.freeze((reachable?.floorMemories ?? []).flatMap((memory, index) => {
    if (memory?.recordStatus !== 'active') return [];
    const facts = {};
    const actions = (memory.actions ?? []).flatMap(item => {
      const role = targetRole(item.actorEntityId, item.targetEntityIds, entityId, 'actor', 'target', projection);
      if (!role) return [];
      return [{ role, action: macroText(clean(item.action, 2000), macros), completion: item.completion,
        ...(item.result ? { result: macroText(clean(item.result, 2000), macros) } : {}) }];
    });
    if (actions.length) facts.actions = actions;
    const observations = (memory.observations ?? []).filter(item => resolveIdentityEntityId(item.subjectEntityId, projection) === entityId)
      .map(item => ({ kind: item.kind, description: macroText(clean(item.description, 2000), macros) }));
    if (observations.length) facts.observations = observations;
    const privateCognition = (memory.privateCognition ?? []).filter(item => resolveIdentityEntityId(item.ownerEntityId, projection) === entityId)
      .map(item => ({ kind: item.kind, content: macroText(clean(item.content, 2000), macros) }));
    if (privateCognition.length) facts.privateCognition = privateCognition;
    const commitments = (memory.commitments ?? []).flatMap(item => {
      const role = targetRole(item.speakerEntityId, item.targetEntityIds, entityId, 'speaker', 'recipient', projection);
      if (!role) return [];
      return [{ role, kind: item.kind, content: macroText(clean(item.content, 2000), macros), status: item.status }];
    });
    if (commitments.length) facts.commitments = commitments;
    const informationTransfers = (memory.informationTransfers ?? []).flatMap(item => {
      const role = targetRole(item.fromEntityId, item.toEntityIds, entityId, 'source', 'recipient', projection);
      if (!role) return [];
      return [{ role, claim: macroText(clean(item.claimText, 2000), macros), channel: item.channel }];
    });
    if (informationTransfers.length) facts.informationTransfers = informationTransfers;
    const locations = (memory.locations ?? []).filter(item => (item.participantEntityIds ?? []).some(id => resolveIdentityEntityId(id, projection) === entityId))
      .map(item => ({ name: macroText(clean(item.name, 500), macros), change: item.change }));
    if (locations.length) facts.locations = locations;
    const openLoops = (memory.openLoops ?? []).filter(item => (item.ownerEntityIds ?? []).some(id => resolveIdentityEntityId(id, projection) === entityId))
      .map(item => ({ description: macroText(clean(item.description, 2000), macros) }));
    if (openLoops.length) facts.openLoops = openLoops;
    const cseSignals = (memory.cseSignals ?? []).flatMap(item => {
      const role = targetRole(item.subjectEntityId, item.objectEntityId ? [item.objectEntityId] : [], entityId, 'subject', 'object', projection);
      if (!role) return [];
      return [{ role, type: item.signalType, description: macroText(clean(item.description, 2000), macros) }];
    });
    if (cseSignals.length) facts.cseSignals = cseSignals;
    const exactAnchors = (memory.exactAnchors ?? []).filter(item => resolveIdentityEntityId(item.speakerEntityId, projection) === entityId)
      .map(item => ({ kind: item.kind, exactText: macroText(clean(item.exactText, 2000), macros), whyPreserve: macroText(clean(item.whyPreserve, 1000), macros) }));
    if (exactAnchors.length) facts.exactAnchors = exactAnchors;
    const participated = (memory.participants ?? []).some(item => resolveIdentityEntityId(item.entityId, projection) === entityId);
    if (!participated && !Object.keys(facts).length) return [];
    const summary = macroText(clean(effectiveSummary(memory), 4000), macros);
    const storyContent = typeof floorContent.get(memory.floorId) === 'string'
      ? macroText(floorContent.get(memory.floorId), macros)
      : '';
    return [Object.freeze({
      sourceFloor: floorSequence.get(memory.floorId) ?? (Number.isSafeInteger(memory.assistantSeq) ? memory.assistantSeq : index + 1),
      ...(storyContent ? { storyContent } : {}),
      ...(summary ? { summary } : {}),
      ...(Object.keys(facts).length ? { facts: Object.freeze(facts) } : {}),
      ...(memory.sourceVariableReference ? { auxiliaryStateSnapshot: clone(memory.sourceVariableReference) } : {}),
    })];
  }));
}

function targetContext(reachable, memoryState, target, workspace, macros) {
  const projection = identityProjection(workspace);
  const directory = activePersonDirectory(reachable, workspace);
  const entry = directory.find(item => item.entityId === target.entityId);
  const entity = entry?.entity;
  const floorSequence = new Map((reachable?.floors ?? []).map(floor => [floor.id, floor.assistantSeq]));
  const cseCoreTraits = [];
  for (const subject of memoryState?.cseSubjects ?? []) {
    if (resolveIdentityEntityId(subject.subjectEntityId, projection) !== target.entityId) continue;
    for (const item of subject.core ?? []) cseCoreTraits.push({ text: macroText(item.text, macros), source: item.sourceFloorId ? 'story-floor' : item.origin || 'unknown',
      ...(item.sourceFloorId && floorSequence.has(item.sourceFloorId) ? { sourceFloor: floorSequence.get(item.sourceFloorId) } : {}) });
  }
  const characterCard = resolveIdentityEntityId(reachable?.baseline?.characterCard?.entityId, projection) === target.entityId
    ? Object.fromEntries(['name', 'description', 'personality', 'scenario'].map(field => [field, macroText(reachable.baseline.characterCard[field], macros)]))
    : null;
  return Object.freeze({
    currentName: macroText(entity?.displayName ?? target.entityDisplayName, macros),
    aliases: Object.freeze((entry?.aliases ?? []).map(alias => macroText(alias, macros))),
    characterCard: characterCard ? Object.freeze(characterCard) : null,
    cseCoreTraits: Object.freeze(cseCoreTraits),
  });
}

function splitContinuous(text, maximum) {
  const value = String(text ?? '');
  const characters = [...value];
  if (characters.length <= maximum) return [value];
  const parts = [];
  for (let offset = 0; offset < characters.length; offset += maximum) parts.push(characters.slice(offset, offset + maximum).join(''));
  return parts;
}

function sourceFragments(person, worldInfo, maximumPartCharacters) {
  const sources = [];
  for (const [field, value] of Object.entries(person.characterCard ?? {})) if (value) sources.push({ kind: 'characterCard', label: field, content: value });
  for (const source of worldInfo ?? []) sources.push({ kind: 'allowedWorldInfo', label: `${source.source || ''}${source.label ? ` · ${source.label}` : ''}`.trim(), content: source.content });
  for (const item of person.history ?? []) sources.push({ kind: 'history', sourceFloor: item.sourceFloor, content: JSON.stringify(item) });
  for (const item of person.cseCoreTraits ?? []) sources.push({ kind: 'cseCoreTrait', ...(item.sourceFloor ? { sourceFloor: item.sourceFloor } : {}), content: JSON.stringify(item) });
  if (person.priorContext) sources.push({ kind: 'priorContext', label: '导入前情', content: person.priorContext });
  return Object.freeze(sources.flatMap((source, sourceIndex) => {
    const parts = splitContinuous(source.content, maximumPartCharacters);
    return parts.map((content, partIndex) => Object.freeze({ sourceIndex: sourceIndex + 1, kind: source.kind,
      ...(source.label ? { label: source.label } : {}), ...(source.sourceFloor ? { sourceFloor: source.sourceFloor } : {}),
      part: partIndex + 1, total: parts.length, content }));
  }));
}

function longProfileBatches(request, maximumCharacters = PEOPLE_PROFILE_INPUT_CHAR_BUDGET) {
  const batches = [];
  for (const person of request.people) {
    const base = Object.fromEntries(Object.entries(person).filter(([key]) => !['history', 'cseCoreTraits', 'characterCard', 'priorContext'].includes(key)));
    const overhead = JSON.stringify({ task: request.task, people: [{ ...base, sourceFragments: [] }], allowedWorldInfo: [], batch: {} }).length;
    const partLimit = Math.max(2000, Math.min(12000, maximumCharacters - overhead - 1200));
    const fragments = sourceFragments(person, request.allowedWorldInfo, partLimit);
    const groups = [];
    let group = [];
    for (const fragment of fragments) {
      const candidate = [...group, fragment];
      const size = overhead + JSON.stringify(candidate).length;
      if (group.length && size > maximumCharacters) { groups.push(group); group = [fragment]; }
      else group = candidate;
    }
    if (group.length || !groups.length) groups.push(group);
    groups.forEach((sourceGroup, batchIndex) => batches.push({
      request: { task: request.task, people: [{ ...base, sourceFragments: sourceGroup }], allowedWorldInfo: [],
        batch: { personKey: person.personKey, index: batchIndex + 1, total: groups.length } },
      personKey: person.personKey,
    }));
  }
  return Object.freeze(batches.map((batch, index) => Object.freeze({ ...batch, overallIndex: index + 1, overallTotal: batches.length })));
}

export function createPeopleWorkspaceRuntime({
  store, session, foundationRuntime, memoryRuntime, generateUtilityTask, sourcePermissions,
  contextProvider, sanitizerOptions = () => ({}), scanner = scanWorldInfo,
  sourceCandidateFactory = createWorldInfoSourceCandidates, profilePromptGuidance = () => '', processingPrompt = () => '', isEnabled = true, now = () => new Date(), logger = console,
} = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.put !== 'function') throw new TypeError('人物工作区 store 无效');
  if (!session || typeof session.identity !== 'function') throw new TypeError('人物工作区 session 无效');
  if (!foundationRuntime || typeof foundationRuntime.getReachable !== 'function') throw new TypeError('人物工作区 foundationRuntime 无效');
  if (!memoryRuntime || typeof memoryRuntime.getState !== 'function') throw new TypeError('人物工作区 memoryRuntime 无效');
  if (typeof generateUtilityTask !== 'function' || typeof contextProvider !== 'function') throw new TypeError('人物资料生成依赖无效');
  if (!sourcePermissions || typeof sourcePermissions.filterCandidates !== 'function') throw new TypeError('人物资料来源许可依赖无效');
  let epoch = 0, active = null, workspace = null, revision = 0, chatId = null, people = Object.freeze([]), lastError = null, lastGenerationReport = null;
  let autoPending = false, autoDrainQueued = false, destroyed = false;
  const concurrentWrites = new Set();
  const subscribers = new Set();
  const failedAutomaticMaterials = new Set();
  const enabled = () => { try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; } catch { return false; } };
  const notify = () => { const value = getState(); for (const listener of subscribers) { try { listener(value); } catch { /* view isolation */ } } return value; };
  const capture = () => Object.freeze({ ...session.identity() });
  const isCurrent = operation => {
    if (!enabled() || operation.epoch !== epoch || operation.controller.signal.aborted) return false;
    try { return sameIdentity(operation.identity, capture()); } catch { return false; }
  };
  const assertCurrent = operation => { if (!isCurrent(operation)) throw errorWith('QQJ_PEOPLE_STALE', '聊天已变化，迟到的人物资料结果没有写入。'); };
  const project = () => { people = candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace); };
  const syncIdentityProjection = () => { try { memoryRuntime.setIdentityProjection?.(identityProjection(workspace)); } catch { /* memory projection remains readable */ } };
  function fullMaterialPlanFor(candidate) {
    const reachable = foundationRuntime.getReachable?.();
    const memoryState = memoryRuntime.getState();
    const macros = macrosFor(reachable);
    const history = targetHistory(reachable, candidate.entityId, macros, identityProjection(workspace));
    const context = targetContext(reachable, memoryState, candidate, workspace, macros);
    const contextSignature = materialSignature(context);
    const plan = Object.freeze({ entityId: candidate.entityId, history, context, historyStart: 0, includeContext: true, includeWorldInfo: true,
      processedHistoryCount: history.length, materialSignature: materialSignature(history), contextSignature });
    return Object.freeze({ ...plan, key: `${candidate.entityId}:0:${plan.materialSignature}:${contextSignature}:1` });
  }
  function materialPlanFor(candidate) {
    const full = fullMaterialPlanFor(candidate);
    const progress = workspace?.profileMaterialProgressByEntityId?.[candidate.entityId] ?? null;
    const processed = progress?.processedHistoryCount ?? 0;
    const prefixMatches = Boolean(progress) && processed <= full.history.length
      && materialSignature(full.history.slice(0, processed)) === progress.materialSignature;
    const contextChanged = !progress || progress.contextSignature !== full.contextSignature;
    const historyChanged = !prefixMatches || processed < full.history.length;
    if (!historyChanged && !contextChanged) return null;
    const historyStart = prefixMatches ? processed : 0;
    const includeWorldInfo = !prefixMatches;
    const plan = Object.freeze({
      entityId: candidate.entityId, history: full.history, context: full.context, historyStart,
      includeContext: includeWorldInfo || contextChanged, includeWorldInfo,
      processedHistoryCount: full.processedHistoryCount, materialSignature: full.materialSignature, contextSignature: full.contextSignature,
    });
    return Object.freeze({ ...plan, key: `${candidate.entityId}:${historyStart}:${plan.materialSignature}:${plan.contextSignature}:${Number(includeWorldInfo)}` });
  }
  function automaticGroup() {
    if (!workspace) return null;
    const candidates = candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace)
      .filter(candidate => candidate.selected);
    const plans = candidates.map(materialPlanFor).filter(Boolean).filter(plan => !failedAutomaticMaterials.has(plan.key));
    if (!plans.length) return null;
    const includeWorldInfo = plans.some(plan => plan.includeWorldInfo);
    const grouped = plans.filter(plan => plan.includeWorldInfo === includeWorldInfo);
    return Object.freeze({ includeWorldInfo, plans: Object.freeze(grouped),
      key: grouped.map(plan => plan.key).sort().join('|') });
  }
  function memoryIsBusy() {
    const state = memoryRuntime.getState();
    return Boolean(state?.memoryWorkBusy || state?.activeExtraction || state?.activeCse);
  }
  function requestAutomaticMaintenance() {
    if (destroyed || !enabled() || !workspace) return;
    autoPending = true;
    if (autoDrainQueued) return;
    autoDrainQueued = true;
    setTimeout(() => { autoDrainQueued = false; void drainAutomaticMaintenance(); }, 0);
  }
  async function drainAutomaticMaintenance() {
    if (destroyed || !autoPending || !workspace || active || memoryIsBusy()) return;
    autoPending = false;
    const group = automaticGroup();
    if (!group) return;
    const plans = new Map(group.plans.map(plan => [plan.entityId, plan]));
    try {
      await generateProfiles(candidates => candidates.filter(candidate => plans.has(candidate.entityId))
        .map(candidate => ({ ...candidate, materialPlan: plans.get(candidate.entityId) })), {
        replaceExisting: true, automatic: true, materialPlans: plans, includeWorldInfo: group.includeWorldInfo,
      });
    } catch (error) {
      if (error?.name !== 'AbortError' && error?.code !== 'QQJ_PEOPLE_STALE') {
        for (const plan of group.plans) failedAutomaticMaterials.add(plan.key);
        try { logger?.warn?.('[QQJ people] automatic profile maintenance failed', error); } catch { /* diagnostics only */ }
      }
    } finally {
      requestAutomaticMaintenance();
    }
  }
  function getState() {
    const selected = Object.freeze([...(workspace?.selectedEntityIds ?? [])]);
    const profiles = Object.freeze({ ...(workspace?.profilesByEntityId ?? {}) });
    const avatars = Object.freeze({ ...(workspace?.avatarsByEntityId ?? {}) });
    const redirects = Object.freeze({ ...(workspace?.identityRedirectsByEntityId ?? {}) });
    const deleted = Object.freeze([...(workspace?.deletedEntityIds ?? [])]);
    const materialProgress = Object.freeze({ ...(workspace?.profileMaterialProgressByEntityId ?? {}) });
    return Object.freeze({ status: !enabled() ? 'disabled' : active?.kind ?? (workspace ? 'ready' : 'idle'), chatId,
      revision, selectedEntityIds: selected, profilesByEntityId: profiles, avatarsByEntityId: avatars, people,
      active: active ? Object.freeze({ kind: active.kind, ...(active.batchTotal ? { batchIndex: active.batchIndex, batchTotal: active.batchTotal } : {}) }) : null,
      identityRedirectsByEntityId: redirects, deletedEntityIds: deleted,
      profileMaterialProgressByEntityId: materialProgress,
      unprofiledSelectedCount: people.filter(person => person.selected && !person.profiled).length, lastError, lastGenerationReport });
  }
  function begin(kind) {
    if (!enabled()) throw errorWith('QQJ_PEOPLE_DISABLED', '千千结已关闭。');
    const alongsideGeneration = active?.kind === 'generating' && ['savingProfile', 'savingSelection', 'savingAvatar'].includes(kind);
    if (active && !alongsideGeneration) throw errorWith('QQJ_PEOPLE_BUSY', '人物资料正在处理，请稍候。');
    const operation = { kind, epoch, identity: capture(), controller: new AbortController() };
    if (alongsideGeneration) concurrentWrites.add(operation); else active = operation;
    lastGenerationReport = null;
    lastError = null; notify(); return operation;
  }
  function adopt(operation, result) {
    assertCurrent(operation); workspace = result.data ?? emptyWorkspace(operation.identity.chatId, nowIso(now));
    revision = result.revision; chatId = operation.identity.chatId; syncIdentityProjection(); project();
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
      concurrentWrites.delete(operation); notify(); requestAutomaticMaintenance();
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
      failedAutomaticMaterials.clear(); lastError = null; return result.state;
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
  async function mergePeople(sourceEntityId, targetEntityId, profileSource = 'target') {
    const operation = begin('merging');
    return settle(operation, async () => {
      if (!isUuid(sourceEntityId) || !isUuid(targetEntityId) || sourceEntityId === targetEntityId || !['source', 'target'].includes(profileSource)) {
        throw errorWith('QQJ_PEOPLE_MERGE_INVALID', '请选择两个不同人物及要采用的整份资料。');
      }
      const candidates = candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace);
      const sourceCandidate = candidates.find(person => person.entityId === sourceEntityId);
      const targetCandidate = candidates.find(person => person.entityId === targetEntityId);
      if (!sourceCandidate || !targetCandidate) throw errorWith('QQJ_PEOPLE_MERGE_TARGET_INVALID', '合并人物已不在当前聊天的可用人物中。');
      const targetDisplayName = targetCandidate.displayName || targetCandidate.entityDisplayName;
      const result = await mutate(operation, current => {
        const projection = identityProjection(current);
        if (resolveIdentityEntityId(sourceEntityId, projection) !== sourceEntityId
          || resolveIdentityEntityId(targetEntityId, projection) !== targetEntityId
          || isIdentityDeleted(sourceEntityId, projection) || isIdentityDeleted(targetEntityId, projection)) {
          throw errorWith('QQJ_PEOPLE_MERGE_CONFLICT', '人物归属已经变化，本次没有覆盖新结果，请重试。');
        }
        const chosenId = profileSource === 'source' ? sourceEntityId : targetEntityId;
        const chosenProfile = current.profilesByEntityId[chosenId] ?? null;
        const chosenAvatar = current.avatarsByEntityId[chosenId] ?? null;
        const targetProfile = current.profilesByEntityId[targetEntityId] ?? null;
        const timestamp = nowIso(now);
        const redirects = { ...clone(current.identityRedirectsByEntityId), [sourceEntityId]: targetEntityId };
        const provisional = normalizeIdentityProjection({ identityRedirectsByEntityId: redirects });
        for (const id of Object.keys(redirects)) {
          const resolved = resolveIdentityEntityId(id, provisional);
          if (resolved === id) delete redirects[id]; else redirects[id] = resolved;
        }
        const profiles = { ...clone(current.profilesByEntityId) };
        const avatars = { ...clone(current.avatarsByEntityId) };
        const progress = { ...clone(current.profileMaterialProgressByEntityId ?? {}) };
        delete profiles[sourceEntityId]; delete avatars[sourceEntityId];
        delete progress[sourceEntityId]; delete progress[targetEntityId];
        if (chosenProfile) {
          const name = targetDisplayName || chosenProfile.name;
          const manual = new Set(chosenProfile.manualFields ?? []);
          if (profileSource === 'source') {
            manual.delete('name');
            if (targetProfile?.manualFields?.includes('name')) manual.add('name');
          }
          profiles[targetEntityId] = { ...clone(chosenProfile), entityId: targetEntityId, name,
            manualFields: [...manual], source: chosenProfile.source, updatedAt: timestamp };
        } else delete profiles[targetEntityId];
        if (chosenAvatar) avatars[targetEntityId] = chosenAvatar; else delete avatars[targetEntityId];
        const selected = [...new Set(current.selectedEntityIds.map(id => resolveIdentityEntityId(id, provisional)).filter(id => id !== sourceEntityId))];
        if ((current.selectedEntityIds.includes(sourceEntityId) || current.selectedEntityIds.includes(targetEntityId)) && !selected.includes(targetEntityId)) selected.push(targetEntityId);
        const deleted = current.deletedEntityIds.filter(id => id !== sourceEntityId && id !== targetEntityId);
        return { ...clone(current), selectedEntityIds: selected, profilesByEntityId: profiles, avatarsByEntityId: avatars,
          profileMaterialProgressByEntityId: progress,
          identityRedirectsByEntityId: redirects, deletedEntityIds: deleted, updatedAt: timestamp };
      });
      lastError = null; return result.state;
    });
  }
  async function deletePerson(entityId) {
    const operation = begin('deleting');
    return settle(operation, async () => {
      if (!isUuid(entityId)) throw errorWith('QQJ_PEOPLE_DELETE_INVALID', '要删除的人物标识无效。');
      const candidate = candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace).find(person => person.entityId === entityId);
      if (!candidate) throw errorWith('QQJ_PEOPLE_DELETE_TARGET_INVALID', '这个人物已不在当前聊天的人物管理列表中。');
      const result = await mutate(operation, current => {
        const projection = identityProjection(current);
        const canonical = resolveIdentityEntityId(entityId, projection);
        if (canonical !== entityId || isIdentityDeleted(canonical, projection)) throw errorWith('QQJ_PEOPLE_DELETE_CONFLICT', '人物归属已经变化，请刷新后重试。');
        const members = new Set(identityProjectionMembers(canonical, projection));
        const profiles = { ...clone(current.profilesByEntityId) }, avatars = { ...clone(current.avatarsByEntityId) };
        const progress = { ...clone(current.profileMaterialProgressByEntityId ?? {}) };
        for (const id of members) { delete profiles[id]; delete avatars[id]; delete progress[id]; }
        const timestamp = nowIso(now);
        return { ...clone(current), selectedEntityIds: current.selectedEntityIds.filter(id => !members.has(resolveIdentityEntityId(id, projection))),
          profilesByEntityId: profiles, avatarsByEntityId: avatars,
          profileMaterialProgressByEntityId: progress,
          deletedEntityIds: [...new Set([...current.deletedEntityIds, canonical])], updatedAt: timestamp };
      });
      lastError = null; return result.state;
    });
  }
  async function generationEnvelope(operation, targets, { includeWorldInfo = true } = {}) {
    const reachable = foundationRuntime.getReachable?.();
    const memoryState = memoryRuntime.getState();
    const macros = operation.macros;
    const hostContext = contextProvider();
    const prequelText = typeof hostContext?.chatMetadata?.[PREQUEL_METADATA_KEY] === 'string' ? hostContext.chatMetadata[PREQUEL_METADATA_KEY] : '';
    const peopleRequest = targets.map((target, index) => {
      const history = target.materialPlan?.history ?? targetHistory(reachable, target.entityId, macros, identityProjection(workspace));
      const context = target.materialPlan?.context ?? targetContext(reachable, memoryState, target, workspace, macros);
      const historyStart = target.materialPlan?.historyStart ?? 0;
      const includeContext = target.materialPlan?.includeContext !== false;
      const priorContext = selectPrequel({
        text: prequelText,
        queryContext: {
          latestUserText: [context.currentName, ...context.aliases].join(' '),
          recentAssistantText: JSON.stringify({ history: history.slice(historyStart), cseCoreTraits: includeContext ? context.cseCoreTraits : [] }),
          previousUserText: '',
        },
        maxCharacters: target.profiled ? 2400 : 24000,
        maxTokens: target.profiled ? 1000 : 10000,
        requireMatch: true,
        fallbackToTail: false,
      }).injectionText;
      return { personKey: `person-${index + 1}`, currentName: context.currentName,
        aliases: context.aliases,
        history: history.slice(historyStart),
        cseCoreTraits: includeContext ? context.cseCoreTraits : [],
        characterCard: includeContext ? context.characterCard : null,
        ...(priorContext ? { priorContext } : {}),
        existingProfile: existingAiProfile(target.profile, macros), manualProfile: manualProfile(target.profile, macros), manualFields: target.profile?.manualFields ?? [] };
    });
    let worldInfo = [];
    if (includeWorldInfo) {
      const catalog = await scanner(hostContext);
      assertCurrent(operation);
      const candidates = await sourceCandidateFactory(catalog);
      const allowed = sourcePermissions.filterCandidates({ chatId: operation.identity.chatId, candidates });
      if (!Array.isArray(allowed)) throw errorWith('QQJ_PEOPLE_WORLDBOOK_FILTER_INVALID', '世界书许可过滤结果无效。');
      const options = typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions;
      worldInfo = allowed.map(candidate => ({ source: candidate.world, label: candidate.label,
        content: macroText(sanitizeMemoryContent(candidate.content, options), macros) })).filter(item => item.content);
    }
    const request = { task: '整理选中人物的静态基础资料', people: peopleRequest, allowedWorldInfo: worldInfo };
    return { request, keys: new Map(peopleRequest.map((person, index) => [person.personKey, targets[index].entityId])) };
  }
  function parseGenerated(result, keys, macros) {
    const raw = result?.jsonData ?? result?.textData ?? result;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.profiles)) throw errorWith('QQJ_PEOPLE_GENERATION_INVALID', '人物资料回复格式无效，可重新整理。');
    const grouped = new Map([...keys.keys()].map(key => [key, []]));
    let unknown = 0;
    for (const item of raw.profiles) {
      const key = typeof item?.personKey === 'string' ? item.personKey.trim() : '';
      if (!keys.has(key)) { unknown += 1; continue; }
      grouped.get(key).push(item);
    }
    const generated = new Map();
    let missing = 0, conflicts = 0, invalid = 0;
    for (const [key, items] of grouped) {
      if (items.length === 0) { missing += 1; continue; }
      if (items.length > 1) { conflicts += 1; continue; }
      try {
        const patch = generatedProfilePatch(items[0], macros);
        if (Object.keys(patch.fields).length || patch.invalidFields === 0) generated.set(keys.get(key), patch.fields);
        else invalid += 1;
      }
      catch { invalid += 1; }
    }
    return Object.freeze({ generated, requested: keys.size, missing, conflicts, invalid, unknown });
  }
  async function generateProfiles(targetResolver, { replaceExisting = false, automatic = false, materialPlans = null, includeWorldInfo = true } = {}) {
    const operation = begin('generating');
    operation.automatic = automatic;
    operation.macros = macrosFor(foundationRuntime.getReachable?.());
    const guidanceSnapshot = typeof profilePromptGuidance === 'function' ? profilePromptGuidance() : profilePromptGuidance;
    const processingPromptSnapshot = typeof processingPrompt === 'function' ? processingPrompt() : processingPrompt;
    const systemPrompt = buildPeopleProfileSystemPrompt(guidanceSnapshot, processingPromptSnapshot);
    return settle(operation, async () => {
      const targets = targetResolver(candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace));
      if (!targets.length) throw errorWith('QQJ_PEOPLE_NOTHING_TO_GENERATE', replaceExisting ? '当前人物不可重新整理。' : '选中的人物都已有基础资料。');
      const plans = materialPlans ?? new Map(targets.map(target => [target.entityId, fullMaterialPlanFor(target)]));
      const preparedTargets = targets.map(target => ({ ...target, materialPlan: target.materialPlan ?? plans.get(target.entityId) }));
      const envelope = await generationEnvelope(operation, preparedTargets, { includeWorldInfo });
      const serialized = JSON.stringify(envelope.request);
      const requests = serialized.length <= PEOPLE_PROFILE_INPUT_CHAR_BUDGET
        ? Object.freeze([{ request: envelope.request, keys: envelope.keys, overallIndex: 1, overallTotal: 1 }])
        : longProfileBatches(envelope.request).map(batch => Object.freeze({ ...batch, keys: new Map([[batch.personKey, envelope.keys.get(batch.personKey)]]) }));
      const saved = new Set();
      const expectedBatches = new Map(), completedBatches = new Map();
      for (const batch of requests) for (const entityId of new Set(batch.keys.values())) expectedBatches.set(entityId, (expectedBatches.get(entityId) ?? 0) + 1);
      const totals = { missing: 0, conflicts: 0, invalid: 0, unknown: 0, skipped: 0 };
      let finalState = getState();
      for (const batch of requests) {
        operation.batchIndex = batch.overallIndex; operation.batchTotal = batch.overallTotal;
        const request = clone(batch.request);
        for (const person of request.people) {
          const entityId = batch.keys.get(person.personKey);
          const current = candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace).find(item => item.entityId === entityId);
          person.existingProfile = existingAiProfile(current?.profile, operation.macros);
          person.manualProfile = manualProfile(current?.profile, operation.macros);
          person.manualFields = current?.profile?.manualFields ?? [];
        }
        notify(); assertCurrent(operation);
        const result = await generateUtilityTask({ systemPrompt, taskMessages: [{ role: 'user', content: JSON.stringify(request) }],
          maxTokens: 30000, temperature: 0, signal: operation.controller.signal, includeCharacterCard: false, worldInfoSource: 'none' });
        assertCurrent(operation);
        const parsed = parseGenerated(result, batch.keys, operation.macros);
        for (const entityId of parsed.generated.keys()) completedBatches.set(entityId, (completedBatches.get(entityId) ?? 0) + 1);
        const completedMaterialEntityIds = new Set([...expectedBatches]
          .filter(([entityId, count]) => completedBatches.get(entityId) === count).map(([entityId]) => entityId));
        totals.missing += parsed.missing; totals.conflicts += parsed.conflicts; totals.invalid += parsed.invalid; totals.unknown += parsed.unknown;
        if (!parsed.generated.size) {
          lastGenerationReport = Object.freeze({ requested: targets.length, saved: saved.size, batches: requests.length, completedBatches: batch.overallIndex - 1, ...totals });
          throw errorWith('QQJ_PEOPLE_GENERATION_BINDING_INVALID', '人物资料回复没有可安全绑定的目标；此前批次已保存，可重新整理继续吸收资料。');
        }
        let savedEntityIds = [], skipped = 0;
        const persisted = await mutate(operation, current => {
        const profiles = { ...clone(current.profilesByEntityId) };
        const progress = { ...clone(current.profileMaterialProgressByEntityId ?? {}) };
        let changed = false; const timestamp = nowIso(now);
        const projection = identityProjection(current);
        const selected = new Set(current.selectedEntityIds.map(id => resolveIdentityEntityId(id, projection)));
        savedEntityIds = []; skipped = 0;
        for (const [entityId, patch] of parsed.generated) {
          if (automatic) {
            if (!selected.has(entityId)) { skipped += 1; continue; }
          }
          const existing = profiles[entityId];
          if (existing && !replaceExisting && !saved.has(entityId)) { skipped += 1; continue; }
          const manual = existing?.manualFields ?? [];
          if (!existing && !Object.keys(patch).length) { skipped += 1; continue; }
          const merged = { ...profileFields(existing ?? {}), ...patch };
          for (const field of manual) merged[field] = existing[field];
          if (existing && sameFields(existing, merged)) { skipped += 1; continue; }
          profiles[entityId] = { entityId, ...merged, manualFields: [...manual], source: manual.length ? 'manual' : 'generated', createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
          savedEntityIds.push(entityId); changed = true;
        }
        const reachable = foundationRuntime.getReachable?.();
        const memoryState = memoryRuntime.getState();
        const currentCandidates = candidateProjection(reachable, memoryState, current);
        for (const entityId of completedMaterialEntityIds) {
          const plan = plans.get(entityId);
          if (!plan || !selected.has(entityId)) continue;
          const candidate = currentCandidates.find(item => item.entityId === entityId);
          if (!candidate) continue;
          const history = targetHistory(reachable, entityId, operation.macros, projection);
          const context = targetContext(reachable, memoryState, candidate, current, operation.macros);
          const material = materialSignature(history), contextValue = materialSignature(context);
          if (history.length !== plan.processedHistoryCount || material !== plan.materialSignature || contextValue !== plan.contextSignature) continue;
          const next = { processedHistoryCount: history.length, materialSignature: material, contextSignature: contextValue, updatedAt: timestamp };
          if (JSON.stringify(progress[entityId] ?? null) !== JSON.stringify(next)) { progress[entityId] = next; changed = true; }
        }
        return changed ? { ...clone(current), profilesByEntityId: profiles, profileMaterialProgressByEntityId: progress, updatedAt: timestamp } : null;
        });
        for (const entityId of savedEntityIds) saved.add(entityId);
        totals.skipped += skipped;
        finalState = persisted.state;
        lastGenerationReport = Object.freeze({ requested: targets.length, saved: saved.size,
          ...(requests.length > 1 ? { batches: requests.length, completedBatches: batch.overallIndex } : {}), ...totals });
        notify();
      }
      const covered = new Set([...expectedBatches].filter(([entityId, count]) => completedBatches.get(entityId) === count).map(([entityId]) => entityId));
      if (automatic) for (const [entityId, plan] of plans) if (!covered.has(entityId)) failedAutomaticMaterials.add(plan.key);
      lastError = null; return finalState;
    });
  }
  async function generateMissingProfiles() {
    failedAutomaticMaterials.clear();
    return generateProfiles(candidates => candidates.filter(person => person.selected && !person.profiled));
  }
  async function regenerateProfile(entityId) {
    failedAutomaticMaterials.clear();
    return generateProfiles(candidates => candidates.filter(person => person.entityId === entityId && person.selected), { replaceExisting: true });
  }
  function invalidate() {
    epoch += 1; active?.controller.abort(); for (const operation of concurrentWrites) operation.controller.abort();
    active = null; concurrentWrites.clear(); workspace = null; revision = 0; chatId = null; people = Object.freeze([]); lastError = null; lastGenerationReport = null;
    autoPending = false; failedAutomaticMaterials.clear(); syncIdentityProjection(); notify();
  }
  async function setEnabled(value) { if (value !== true) { invalidate(); return getState(); } return refresh(); }
  const unsubscribeMemory = typeof memoryRuntime.subscribe === 'function' ? memoryRuntime.subscribe(() => {
    if (!workspace) return;
    try { if (capture().chatId !== chatId) return; project(); notify(); requestAutomaticMaintenance(); } catch { /* lifecycle owns identity transition */ }
  }) : null;
  return Object.freeze({ refresh, start: () => enabled() ? refresh() : Promise.resolve(getState()), setSelectedEntityIds, saveProfile, saveAvatar, mergePeople, deletePerson, generateMissingProfiles, regenerateProfile, invalidate, abortAll: invalidate, setEnabled,
    getIdentityProjection: () => identityProjection(workspace),
    getState, subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('人物工作区 listener 无效'); subscribers.add(listener); return () => subscribers.delete(listener); },
    destroy() { destroyed = true; unsubscribeMemory?.(); invalidate(); },
  });
}
