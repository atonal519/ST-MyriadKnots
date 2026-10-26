import { identityBriefFields } from './identity-brief.js';
import { collectPeopleHistory, compactPeopleHistory, createPeopleEvidenceProjection, peopleMaterialSignature as materialSignature, splitProfileSource, yieldProfileWork } from './people-profile-material.js';
import { isUuid } from '../host-context.js';
import { normalizeAvatarSource } from '../avatar-image-store.js';
import { scanWorldInfo, createWorldInfoSourceCandidates } from '../world-info-scanner.js';
import { withBaseProcessingPrompt } from '../internal-processing-prompt.js';
import { replaceCseSourceMacros } from '../cse-source-selection.js';
import {
  LEGACY_PEOPLE_PROFILE_FIELDS, PEOPLE_PROFILE_DEFINITIONS, PEOPLE_PROFILE_FIELDS,
  PEOPLE_PROFILE_FIELD_SET, PEOPLE_PROFILE_LABELS, emptyPeopleProfileFields, hasPeopleProfileMaterial as hasProfileMaterial,
} from './people-profile-fields.js';
import {
  buildEntityIdentityDirectory, deriveUserIdentityProjection, identityProjectionMembers, isIdentityDeleted,
  normalizeIdentityProjection, projectCseStateIdentityReferences, resolveIdentityEntityId,
} from './entity-identity.js';
import { PREQUEL_METADATA_KEY, selectPrequel } from './recall-prequel.js';
import { inspectMessageFloorAnchor } from './message-floor-anchor.js';
import { isMemoryExcludedFloor } from './memory-exclusion.js';
import { migrationPartition } from './migration-prefix.js';
import { replayCurrentState } from './cse-engine.js';

export const PEOPLE_WORKSPACE_RECORD_ID = 'v3-people-workspace';
export const PEOPLE_WORKSPACE_SCHEMA_VERSION = 3;
export const PEOPLE_PROFILE_INPUT_CHAR_BUDGET = 24000;

export const DEFAULT_PROFILE_GUIDANCE = `你是“千千结”的人物基础资料整理员，只整理有明确依据、适合长期建档的目标人物资料。
人物卡和世界书属于明确设定；CSE Core 是人物分析，不自动等同作者设定。来源冲突时不拼凑或替作者裁决，只整理能明确归属的稳定资料。
按基础信息、外貌、身份、性格与 NSFW 五类整理。性别、年龄、生日无依据时省略，外观年龄不当实际年龄；短期情绪、当前关系变化和一时应对不固化为人格。appearance 只填写无法归入细分外貌字段的必要补充；notes 只填写其他字段容纳不了的长期资料，不写来源说明、整理过程、核验过程、解释或模型想法。`;

const PROFILE_FIELD_GUIDE = PEOPLE_PROFILE_FIELDS
  .map(field => `${field}（${PEOPLE_PROFILE_LABELS[field]}）：${PEOPLE_PROFILE_DEFINITIONS[field]}`)
  .join('\n');

export const PROFILE_FIXED_CONTRACT = `【固定人物资料合同】
1. 只处理输入 people 中的目标人物。characterCard 是共享的作者侧角色卡材料，按明确归属提取，不默认把卡名或卡主当作目标。history 提供已记录的有效 summary、目标相关 facts 和 sources 原句，不含整楼全文。事实的 evidence 与 participantEvidence 用 sourceIndex 引用当前楼材料 sources（从1开始）；各自的 evidenceMode、sourceEntityId、supports 和 occurrence 保留原意，转述、内心和推断不等于客观设定。sourceFloor 指真实来源楼；precedingUser 及其 sourceSnapshotIndex 表示该楼前置用户原文。manual 原句保留人工载体及已明确知情人；知情不等于作者或内容主体，不得把原文中他人的设定归给知情目标。缺引用不表示事实无效，不猜未提供的原文。recentFloors 是自动粗扫的清洗原文，注明片段时并非完整楼。sourceEntityNames 将实际引用的来源人或知情人 ID 对应到确定姓名，people.entityId 表明目标身份；未知名不猜。summarySource 保留有效摘要的 user/ai 来源。CSE Core 仍为分析，manual 仅表示人工纠正，不自动成为作者静态设定；priorContext 是过去背景，不覆盖新事实；人物卡、许可世界书、旧档案和人工字段各按其来源判断归属。
2. history.auxiliaryStateSnapshot 是首份有来源的只读变量快照；后续 auxiliaryStateChanges 基于 fromSourceFloor 的快照，changes 按字符串数组 path 定位，value 替换、delete:true 删除，数组整值替换，空 changes 表示当楼无变化。缺少快照/变化字段不表示清空；按 history 原顺序延续，不把缺楼视作变化。变量只作人物整理辅助。它可能同时包含多个人物、不完整或过时信息，不能整份归给目标人物，也不能当作人工字段或权威证据；与正文或用户明确事实冲突时以正文和用户明确事实为准。
3. 只返回一个 JSON 对象，根对象必须包含 profiles 数组；profiles 每个输入人物恰好一项，且每项内部的 personKey 必须逐字使用输入中的键，不得新增、遗漏或合并人物。合法形状示例：{"profiles":[{"personKey":"person-1","name":"示例姓名"}]}。
4. 每项除 personKey 外只返回需要新增或纠正的字段。existingProfile 是待核旧 AI 资料，不是权威；结合本次证据纠错、补齐和整合，未覆盖字段省略并保留，不因缺少整楼原文而删除旧细节。材料明确否定旧值时可替换，明确应删除且没有替代值时返回空值。完整整理中，非人工 aliases 必须返回经本次全部材料核对的稳定别名全集；旧 aliases 仅为待核候选，不照单保留临时叫法，无稳定别名返回 []。自动粗扫的 aliases 只返回新发现的稳定称谓，空字符串或空数组表示无更新。文本字段最多 20000 字符；aliases 可返回字符串或字符串数组，数组每项最多 500 字符、合并后最多 20000 字符。不要返回 null、对象或其他错误类型。
5. sourceFragments 是长资料按顺序切出的连续来源片段；part/total 表示同一来源的连续位置。长材料分批时，共享角色卡也按来源连续切片并在当前请求中只提供一次。单人主动重整的一次请求包含本轮全部已选片段，应综合完整输入整理；分批整理时当前批可能只包含该来源的一部分，以 existingProfile 作为前批累计结果继续整理。不要把当前请求未出现的来源或字段当成不存在，也不要把局部片段当成完整人物档。
6. manualProfile 和 manualFields 由保存层保护，不需要模型复制；不输出解释、剧情续写、数据库 ID 或 JSON 之外的内容。
7. 自动粗扫每约十个新增稳定AI楼运行一次，输入为楼层标记的清洗原文；仅提取明确新增或重大变化的长期基础资料，例如稳定外貌、职业和身份。短期处境、换装和剧情状态不固化；无变化时该人物只返回 personKey。原文按最新楼优先提供，人工资料和旧档案仅作边界参考。
8. allowedWorldInfo 中的 EJS、MVU 或其他脚本包裹符号均为未执行的条件原文；不要执行，也不要把分支条件当成已成立。可整理明确归属的长期信息并保留其条件限定，不得仅因条目含控制符而忽略整条。

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
  return isUuid(left?.chatId) && isUuid(right?.chatId) && left.chatId === right.chatId;
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
function characterCardContext(reachable, macros) {
  const card = reachable?.baseline?.characterCard;
  if (!card || typeof card !== 'object') return null;
  return Object.freeze(Object.fromEntries(['name', 'description', 'personality', 'scenario']
    .map(field => [field, macroText(card[field], macros)])));
}
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
  if (value.aliasesComplete !== undefined && typeof value.aliasesComplete !== 'boolean') throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物别名资料记录损坏，已停止读取。');
  return Object.freeze({ entityId, ...profileFields(value), ...(value.aliasesComplete !== undefined ? { aliasesComplete: value.aliasesComplete } : {}), manualFields: Object.freeze(manualFields(value, schemaVersion)), source: value.source, createdAt: value.createdAt, updatedAt: value.updatedAt });
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
  if (value.personOrderEntityIds !== undefined && !Array.isArray(value.personOrderEntityIds)) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物显示顺序无效。');
  const personOrderEntityIds = [];
  for (const id of value.personOrderEntityIds ?? []) {
    if (!isUuid(id)) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物显示顺序包含无效标识。');
    if (!personOrderEntityIds.includes(id)) personOrderEntityIds.push(id);
  }
  const profilesByEntityId = {};
  for (const [entityId, profile] of Object.entries(value.profilesByEntityId)) profilesByEntityId[entityId] = validateProfile(profile, entityId, value.schemaVersion);
  const avatarsByEntityId = {};
  if (value.schemaVersion >= 2) {
    if (!value.avatarsByEntityId || typeof value.avatarsByEntityId !== 'object' || Array.isArray(value.avatarsByEntityId)) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物头像索引无效。');
    for (const [entityId, avatar] of Object.entries(value.avatarsByEntityId)) avatarsByEntityId[entityId] = validateAvatar(avatar, entityId);
  }
  const identityRedirectsByEntityId = {};
  const avatarSourcesByEntityId = {};
  if (value.avatarSourcesByEntityId !== undefined) {
    if (!value.avatarSourcesByEntityId || typeof value.avatarSourcesByEntityId !== 'object' || Array.isArray(value.avatarSourcesByEntityId)) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物原图索引无效。');
    for (const [id, source] of Object.entries(value.avatarSourcesByEntityId)) {
      if (!isUuid(id) || !avatarsByEntityId[id]) throw errorWith('QQJ_PEOPLE_WORKSPACE_INVALID', '人物原图缺少对应头像。');
      avatarSourcesByEntityId[id] = normalizeAvatarSource(source);
    }
  }
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
    selectedEntityIds: Object.freeze(selectedEntityIds), personOrderEntityIds: Object.freeze(personOrderEntityIds), profilesByEntityId: Object.freeze(profilesByEntityId), avatarsByEntityId: Object.freeze(avatarsByEntityId),
    ...(Object.keys(avatarSourcesByEntityId).length ? { avatarSourcesByEntityId: Object.freeze(avatarSourcesByEntityId) } : {}),
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
  const snapshotKey = sourceChatId => `v3-people-snapshot-${sourceChatId}`;
  async function readSnapshot(identity, id) {
    try {
      const envelope = await client.get(collection(identity.chatId), id);
      const value = envelope?.data;
      if (value?.schemaVersion !== 1 || value?.kind !== 'qqj-v3-frozen-people-snapshot'
        || value.chatId !== identity.chatId || typeof value.sourceChatId !== 'string'
        || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 0) throw errorWith('QQJ_PEOPLE_SNAPSHOT_INVALID', '冻结人物资料快照无效。');
      return Object.freeze({ id, revision: envelope.revision, data: Object.freeze({ ...value, workspace: validatePeopleWorkspace(value.workspace, identity.chatId) }) });
    } catch (error) { if (error?.status === 404) return null; throw error; }
  }
  async function putSnapshot(identity, { sourceChatId, sourceRevision, workspace, id = snapshotKey(sourceChatId), signal } = {}) {
    const data = { schemaVersion: 1, kind: 'qqj-v3-frozen-people-snapshot', chatId: identity.chatId, sourceChatId,
      sourceRevision, workspace: validatePeopleWorkspace({ ...structuredClone(workspace), chatId: identity.chatId }, identity.chatId) };
    try {
      const saved = await client.put(collection(identity.chatId), id, data, 0, { signal });
      return Object.freeze({ id, revision: saved.revision, data: Object.freeze({ ...data, workspace: validatePeopleWorkspace(saved.data.workspace, identity.chatId) }) });
    } catch (error) {
      if (error?.status !== 409) throw error;
      const existing = await readSnapshot(identity, id);
      if (!existing || JSON.stringify(existing.data) !== JSON.stringify(data)) throw errorWith('QQJ_PEOPLE_SNAPSHOT_CONFLICT', '冻结人物资料快照已变化，未覆盖旧资料。');
      return existing;
    }
  }
  async function copySnapshots(sourceIdentity, targetIdentity, sourceIds = [], currentSource = null) {
    const copied = [];
    for (const id of sourceIds) {
      const source = await readSnapshot(sourceIdentity, id);
      if (!source) throw errorWith('QQJ_PEOPLE_SNAPSHOT_MISSING', '已有冻结人物资料快照缺失，搬家未继续。');
      const saved = await putSnapshot(targetIdentity, { id, sourceChatId: source.data.sourceChatId, sourceRevision: source.data.sourceRevision,
        workspace: source.data.workspace });
      copied.push(saved.id);
    }
    if (currentSource?.data) {
      const saved = await putSnapshot(targetIdentity, { sourceChatId: sourceIdentity.chatId, sourceRevision: currentSource.revision,
        workspace: currentSource.data });
      copied.push(saved.id);
    }
    return Object.freeze([...new Set(copied)]);
  }
  return Object.freeze({ read, put, readSnapshot, putSnapshot, copySnapshots });
}

function identityProjection(workspace) {
  return normalizeIdentityProjection(workspace ?? {});
}
export function projectAnnualPeople(reachable, workspace) {
  const projection = identityProjection(workspace);
  const directory = activePersonDirectory(reachable, workspace);
  const validIds = new Set(directory.map(entry => entry.entityId));
  const names = new Map(directory.map(entry => [entry.entityId, entry.displayName]));
  const people = new Map();
  for (const [sourceId, profile] of Object.entries(workspace?.profilesByEntityId ?? {})) {
    const entityId = resolveIdentityEntityId(sourceId, projection);
    if (!entityId || !validIds.has(entityId) || isIdentityDeleted(entityId, projection) || people.has(entityId) && sourceId !== entityId) continue;
    people.set(entityId, { entityId, displayName: profile?.name || names.get(entityId), profile });
  }
  return [...people.values()];
}
function activePersonDirectory(reachable, workspace) {
  return buildEntityIdentityDirectory({ entities: reachable?.entities ?? [], floorOrder: new Map((reachable?.floors ?? []).map((floor, index) => [floor.id, index])), identityProjection: normalizeIdentityProjection(workspace ?? {}, macrosFor(reachable)) })
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
      entityDisplayName: macroText(entry.originalDisplayName ?? entity.displayName, macros), aliases: Object.freeze(entry.aliases.map(alias => macroText(alias, macros)).filter(Boolean)),
      ...identityBriefFields(entry),
      specialRole: entity.specialRole, selected: selected.has(entity.id), profiled: Boolean(profile), profile, avatar: workspace?.avatarsByEntityId?.[entity.id] ?? null,
      ...(workspace?.avatarSourcesByEntityId?.[entity.id] ? { avatarSource: workspace.avatarSourcesByEntityId[entity.id] } : {}),
      appearanceCount, cse,
    });
  }).sort((left, right) => Number(right.selected) - Number(left.selected)
    || right.appearanceCount - left.appearanceCount || left.displayName.localeCompare(right.displayName, 'zh-Hans-CN')));
}

function displayPeopleProjection(candidates, workspace) {
  const remaining = new Map(candidates.map(person => [person.entityId, person]));
  const ordered = [];
  for (const entityId of workspace?.personOrderEntityIds ?? []) {
    const person = remaining.get(entityId);
    if (!person) continue;
    ordered.push(person); remaining.delete(entityId);
  }
  return Object.freeze([...ordered, ...remaining.values()]);
}

function emptyWorkspace(chatId, timestamp) {
  return Object.freeze({ schemaVersion: PEOPLE_WORKSPACE_SCHEMA_VERSION, kind: 'qqj-v3-people-workspace', chatId,
    selectedEntityIds: Object.freeze([]), personOrderEntityIds: Object.freeze([]), profilesByEntityId: Object.freeze({}), avatarsByEntityId: Object.freeze({}),
    identityRedirectsByEntityId: Object.freeze({}), deletedEntityIds: Object.freeze([]), profileMaterialProgressByEntityId: Object.freeze({}),
    createdAt: timestamp, updatedAt: timestamp });
}
function sameFields(left, right) { return PEOPLE_PROFILE_FIELDS.every(field => String(left?.[field] ?? '') === String(right?.[field] ?? '')); }
function effectiveSummary(memory) { return memory?.summary?.effectiveSource === 'user' ? memory.summary.userText : memory?.summary?.aiText; }

function targetRole(primary, related, entityId, primaryRole = 'owner', relatedRole = 'target', projection = {}) {
  const owns = resolveIdentityEntityId(primary, projection) === entityId;
  const receives = (related ?? []).some(id => resolveIdentityEntityId(id, projection) === entityId);
  return owns && receives ? `${primaryRole}-and-${relatedRole}` : owns ? primaryRole : receives ? relatedRole : null;
}
function* targetHistoryEntries(reachable, entityId, macros, projection = {}, onEntityReference = () => {}) {
  const floorSequence = new Map((reachable?.floors ?? []).map(floor => [floor.id, floor.assistantSeq]));
  for (const [index, memory] of (reachable?.floorMemories ?? []).entries()) {
    if (memory?.recordStatus !== 'active') { yield null; continue; }
    const references = createPeopleEvidenceProjection({ floorSequence, fallbackFloorId: memory.floorId,
      resolveEntityId: id => resolveIdentityEntityId(id, projection), onEntityReference });
    const fact = (item, value) => {
      const evidence = references.evidence(item.evidenceRefs);
      return { ...value, ...(evidence.length ? { evidence } : {}) };
    };
    const facts = {};
    const actions = (memory.actions ?? []).flatMap(item => {
      const role = targetRole(item.actorEntityId, item.targetEntityIds, entityId, 'actor', 'target', projection);
      if (!role) return [];
      return [fact(item, { role, action: macroText(clean(item.action, 2000), macros), completion: item.completion,
        ...(item.result ? { result: macroText(clean(item.result, 2000), macros) } : {}) })];
    });
    if (actions.length) facts.actions = actions;
    const observations = (memory.observations ?? []).filter(item => resolveIdentityEntityId(item.subjectEntityId, projection) === entityId)
      .map(item => fact(item, { kind: item.kind, description: macroText(clean(item.description, 2000), macros) }));
    if (observations.length) facts.observations = observations;
    const privateCognition = (memory.privateCognition ?? []).filter(item => resolveIdentityEntityId(item.ownerEntityId, projection) === entityId)
      .map(item => fact(item, { kind: item.kind, content: macroText(clean(item.content, 2000), macros) }));
    if (privateCognition.length) facts.privateCognition = privateCognition;
    const commitments = (memory.commitments ?? []).flatMap(item => {
      const role = targetRole(item.speakerEntityId, item.targetEntityIds, entityId, 'speaker', 'recipient', projection);
      if (!role) return [];
      return [fact(item, { role, kind: item.kind, content: macroText(clean(item.content, 2000), macros), status: item.status })];
    });
    if (commitments.length) facts.commitments = commitments;
    const informationTransfers = (memory.informationTransfers ?? []).flatMap(item => {
      const role = targetRole(item.fromEntityId, item.toEntityIds, entityId, 'source', 'recipient', projection);
      if (!role) return [];
      return [fact(item, { role, claim: macroText(clean(item.claimText, 2000), macros), channel: item.channel })];
    });
    if (informationTransfers.length) facts.informationTransfers = informationTransfers;
    const locations = (memory.locations ?? []).filter(item => (item.participantEntityIds ?? []).some(id => resolveIdentityEntityId(id, projection) === entityId))
      .map(item => fact(item, { name: macroText(clean(item.name, 500), macros), change: item.change }));
    if (locations.length) facts.locations = locations;
    const openLoops = (memory.openLoops ?? []).filter(item => (item.ownerEntityIds ?? []).some(id => resolveIdentityEntityId(id, projection) === entityId))
      .map(item => fact(item, { description: macroText(clean(item.description, 2000), macros) }));
    if (openLoops.length) facts.openLoops = openLoops;
    const cseSignals = (memory.cseSignals ?? []).flatMap(item => {
      const role = targetRole(item.subjectEntityId, item.objectEntityId ? [item.objectEntityId] : [], entityId, 'subject', 'object', projection);
      if (!role) return [];
      return [fact(item, { role, type: item.signalType, description: macroText(clean(item.description, 2000), macros) })];
    });
    if (cseSignals.length) facts.cseSignals = cseSignals;
    const suppressed = new Set(memory.suppressedExactAnchorIds ?? []);
    const exactAnchors = (memory.exactAnchors ?? []).flatMap(item => {
      if (item.manual !== true && suppressed.has(item.anchorId)) return [];
      const knownEntityIds = (item.knownEntityIds ?? []).map(id => resolveIdentityEntityId(id, projection));
      if (resolveIdentityEntityId(item.speakerEntityId, projection) !== entityId
        && !(item.manual === true && knownEntityIds.includes(entityId))) return [];
      const anchor = references.anchor({ ...item, ...(item.manual === true ? { knownEntityIds } : {}) });
      const speakerEntityId = resolveIdentityEntityId(item.speakerEntityId, projection);
      if (anchor && speakerEntityId && speakerEntityId !== entityId) onEntityReference(speakerEntityId);
      return anchor ? [{ kind: item.kind, ...anchor, whyPreserve: macroText(clean(item.whyPreserve, 1000), macros),
        ...(speakerEntityId ? { speakerEntityId } : {}) }] : [];
    });
    if (exactAnchors.length) facts.exactAnchors = exactAnchors;
    const participants = (memory.participants ?? []).filter(item => resolveIdentityEntityId(item.entityId, projection) === entityId);
    const participated = participants.length > 0;
    if (!participated && !Object.keys(facts).length) { yield null; continue; }
    const summary = macroText(clean(effectiveSummary(memory), 4000), macros);
    const participantEvidence = references.evidence(participants.flatMap(item => item.evidenceRefs ?? []));
    yield Object.freeze({
      sourceFloor: floorSequence.get(memory.floorId) ?? (Number.isSafeInteger(memory.assistantSeq) ? memory.assistantSeq : index + 1),
      ...(summary ? { summary, summarySource: memory.summary?.effectiveSource } : {}),
      ...(Object.keys(facts).length ? { facts: Object.freeze(facts) } : {}),
      ...(references.sources.length ? { sources: Object.freeze(references.sources) } : {}),
      ...(participantEvidence.length ? { participantEvidence } : {}),
      ...(memory.sourceVariableReference ? { auxiliaryStateSnapshot: memory.sourceVariableReference } : {}),
    });
  }
}
function targetHistory(...args) { return Object.freeze([...targetHistoryEntries(...args)].filter(Boolean)); }

function targetContext(reachable, memoryState, target, workspace, macros, preparedDirectory = null) {
  const projection = identityProjection(workspace);
  const directory = preparedDirectory ?? activePersonDirectory(reachable, workspace);
  const entry = directory.find(item => item.entityId === target.entityId);
  const floorSequence = new Map((reachable?.floors ?? []).map(floor => [floor.id, floor.assistantSeq]));
  const cseCoreTraits = [];
  for (const subject of memoryState?.cseSubjects ?? []) {
    if (resolveIdentityEntityId(subject.subjectEntityId, projection) !== target.entityId) continue;
    for (const item of subject.core ?? []) cseCoreTraits.push({ text: macroText(item.text, macros), source: item.origin === 'manual' ? 'manual' : item.sourceFloorId ? 'story-floor' : item.origin || 'unknown',
      ...(item.sourceFloorId && floorSequence.has(item.sourceFloorId) ? { sourceFloor: floorSequence.get(item.sourceFloorId) } : {}) });
  }
  return Object.freeze({
    currentName: macroText(entry?.displayName ?? target.displayName ?? target.entityDisplayName, macros),
    ...(entry?.originalDisplayName ? { previousName: macroText(entry.originalDisplayName, macros) } : {}),
    aliases: Object.freeze((entry?.aliases ?? []).map(alias => macroText(alias, macros))),
    cseCoreTraits: Object.freeze(cseCoreTraits),
  });
}


async function sourceFragments(person, worldInfo, maximumPartCharacters, sharedCharacterCard = null) {
  const sources = [];
  for (const [field, value] of Object.entries(sharedCharacterCard ?? person.characterCard ?? {})) if (value) sources.push({ kind: 'characterCard', label: field, content: value });
  for (const source of worldInfo ?? []) sources.push({ kind: 'allowedWorldInfo', label: `${source.source || ''}${source.label ? ` · ${source.label}` : ''}`.trim(), content: source.content });
  for (const item of person.history ?? []) sources.push({ kind: 'history', sourceFloor: item.sourceFloor, content: JSON.stringify(item) });
  for (const item of person.cseCoreTraits ?? []) sources.push({ kind: 'cseCoreTrait', ...(item.sourceFloor ? { sourceFloor: item.sourceFloor } : {}), content: JSON.stringify(item) });
  if (person.priorContext) sources.push({ kind: 'priorContext', label: '导入前情', content: person.priorContext });
  const fragments = [];
  for (const [sourceIndex, source] of sources.entries()) {
    const parts = splitProfileSource(source.content, maximumPartCharacters);
    for (const [partIndex, content] of parts.entries()) fragments.push(Object.freeze({ sourceIndex: sourceIndex + 1, kind: source.kind,
      ...(source.label ? { label: source.label } : {}), ...(source.sourceFloor ? { sourceFloor: source.sourceFloor } : {}),
      part: partIndex + 1, total: parts.length, content }));
    if ((sourceIndex + 1) % 16 === 0) await yieldProfileWork();
  }
  return Object.freeze(fragments);
}

async function longProfileBatches(request, maximumCharacters = PEOPLE_PROFILE_INPUT_CHAR_BUDGET) {
  const batches = [];
  for (const person of request.people) {
    const base = Object.fromEntries(Object.entries(person).filter(([key]) => !['history', 'cseCoreTraits', 'characterCard', 'priorContext'].includes(key)));
    const overhead = JSON.stringify({ task: request.task, people: [{ ...base, sourceFragments: [] }], allowedWorldInfo: [], batch: {} }).length;
    const partLimit = Math.max(2000, Math.min(12000, maximumCharacters - overhead - 1200));
    const fragments = await sourceFragments(person, request.allowedWorldInfo, partLimit, request.characterCard);
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

export async function completeProfileRequest(request, maximumCharacters = PEOPLE_PROFILE_INPUT_CHAR_BUDGET) {
  const people = [];
  for (const person of request.people) {
    const base = Object.fromEntries(Object.entries(person).filter(([key]) => !['history', 'cseCoreTraits', 'characterCard', 'priorContext'].includes(key)));
    const overhead = JSON.stringify({ task: request.task, people: [{ ...base, sourceFragments: [] }], allowedWorldInfo: [] }).length;
    const partLimit = Math.max(2000, Math.min(12000, maximumCharacters - overhead - 1200));
    people.push({ ...base, sourceFragments: await sourceFragments(person, request.allowedWorldInfo, partLimit, request.characterCard) });
  }
  // 单人主动重整必须把同一选材计划的所有连续片段放进一次请求，不能分批早写部分档案。
  return { task: request.task, people, allowedWorldInfo: [] };
}

function personTerms(people) {
  return [...new Set(people.flatMap(person => [person.currentName, person.previousName, ...(person.aliases ?? [])])
    .map(value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-Hans-CN'))
    .filter(value => [...value].length >= 2))];
}

function keywordMatchesTerm(keyword, terms) {
  const normalized = String(keyword ?? '').normalize('NFKC').toLocaleLowerCase('zh-Hans-CN');
  return terms.some(term => {
    if (/\p{Script=Han}/u.test(term)) {
      const first = [...term][0], last = [...term].at(-1);
      let offset = normalized.indexOf(term);
      while (offset >= 0) {
        const before = [...normalized.slice(0, offset)].at(-1) ?? '';
        const after = [...normalized.slice(offset + term.length)][0] ?? '';
        if (!(/\p{N}/u.test(last) && /\p{N}/u.test(after))
          && !(/\p{N}/u.test(first) && /\p{N}/u.test(before))) return true;
        offset = normalized.indexOf(term, offset + 1);
      }
      return false;
    }
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(normalized);
  });
}

export function selectRelevantWorldInfoCandidates(candidates, people, macros = {}) {
  // The manual rebuild uses entry identity metadata only; short name fragments and sibling entries are not safe attribution evidence.
  const terms = personTerms(people);
  if (!terms.length) return [];
  return candidates.filter(candidate => [candidate.entryLabel ?? candidate.label, candidate.comment, candidate.title, ...(candidate.primaryKeys ?? []), ...(candidate.secondaryKeys ?? [])]
    .map(value => macroText(value, macros))
    .some(value => keywordMatchesTerm(value, terms)));
}

function isProfileInputLimitError(error) {
  // 400/422 也可能只是 JSON schema 不兼容；只接受 API 客户端归一后的明确超限证据。
  const status = error?.httpStatus ?? error?.status;
  const providerError = error?.providerError;
  const code = typeof providerError?.code === 'string' ? providerError.code.toLowerCase() : '';
  const message = typeof providerError?.message === 'string' ? providerError.message : '';
  return ((status === 400 || status === 422) && message === '上游认为请求内容超过限制')
    || /^(?:context_length_exceeded|max_input_tokens|request_too_large|prompt_too_long)$/u.test(code);
}

function incompleteProfileResult(result) {
  const reason = String(result?.taskMetadata?.finishReason ?? result?.finishReason ?? '').toLowerCase();
  if (['length', 'max_tokens', 'token_limit'].includes(reason)) {
    throw errorWith('QQJ_OUTPUT_TRUNCATED', '模型输出疑似被截断，本次人物资料未保存。');
  }
  if (['content_filter', 'safety', 'refusal'].includes(reason) || result?.refusal) {
    throw errorWith('QQJ_PEOPLE_GENERATION_INCOMPLETE', '模型未能完成这次人物资料整理，本次未保存。');
  }
}

export function createPeopleWorkspaceRuntime({
  store, session, foundationRuntime, foundationStore, hostAdapter, memoryRuntime, generateUtilityTask, sourcePermissions,
  contextProvider, scanner = scanWorldInfo, isMainGenerationActive = () => false,
  sourceCandidateFactory = createWorldInfoSourceCandidates, profilePromptGuidance = () => '', processingPrompt = () => '', avatarGenerator = null, avatarPrompt = () => '', avatarImageStore = null, isEnabled = true, now = () => new Date(), logger = console,
} = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.put !== 'function') throw new TypeError('人物工作区 store 无效');
  if (!session || typeof session.identity !== 'function') throw new TypeError('人物工作区 session 无效');
  if (!foundationRuntime || typeof foundationRuntime.getReachable !== 'function') throw new TypeError('人物工作区 foundationRuntime 无效');
  if (!memoryRuntime || typeof memoryRuntime.getState !== 'function') throw new TypeError('人物工作区 memoryRuntime 无效');
  if (typeof generateUtilityTask !== 'function' || typeof contextProvider !== 'function') throw new TypeError('人物资料生成依赖无效');
  if (!sourcePermissions || typeof sourcePermissions.filterCandidates !== 'function') throw new TypeError('人物资料来源许可依赖无效');
  let epoch = 0, active = null, workspace = null, revision = 0, chatId = null, viewIdentity = null, people = Object.freeze([]), lastError = null, lastGenerationReport = null;
  let autoDrainQueued = false, autoDrainTimer = null, pendingAutomaticScan = false, destroyed = false, automaticFloorCount = null, automaticChatId = null;
  const pendingInitialProfiles = new Set();
  const concurrentWrites = new Set();
  const subscribers = new Set();
  const enabled = () => { try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; } catch { return false; } };
  const notify = () => { let value; try { value = getState(); } catch { return null; } for (const listener of subscribers) { try { listener(value); } catch { /* view isolation */ } } return value; };
  const capture = () => Object.freeze({ ...session.identity() });
  const isCurrent = operation => {
    if (!enabled() || operation.epoch !== epoch || operation.controller.signal.aborted) return false;
    try { return sameIdentity(operation.identity, capture()); } catch { return false; }
  };
  const assertActive = operation => { if (!enabled() || operation.epoch !== epoch || operation.controller.signal.aborted) throw errorWith('QQJ_PEOPLE_STALE', '人物任务已停止，结果没有写入。'); };
  const operations = () => [active, ...concurrentWrites].filter(Boolean);
  const currentOperation = () => operations().find(isCurrent) ?? null;
  const viewIsCurrent = () => { try { return sameIdentity(viewIdentity, capture()); } catch { return false; } };
  const setReport = (operation, report) => { operation.lastGenerationReport = report; if (isCurrent(operation)) lastGenerationReport = report; };
  async function targetInputs(operation, currentWorkspace = operation.workspace) {
    assertActive(operation);
    let reachable = operation.currentReachable ?? operation.reachable;
    let graphChanged = false;
    if (typeof foundationStore?.forIdentity === 'function') {
      const targetStore = foundationStore.forIdentity(operation.identity);
      try {
        const root = await targetStore.readRoot?.();
        const sameRoot = root?.status === 'ready' && root.revision === reachable?.rootRevision
          && root.data?.chatId === operation.identity.chatId && root.data.headCheckpointId === reachable?.root?.headCheckpointId
          && root.data.narrativeGeneration === reachable?.root?.narrativeGeneration
          && root.data.sourceSnapshotFingerprint === reachable?.root?.sourceSnapshotFingerprint;
        if (!sameRoot) {
          const latest = await targetStore.readReachable({ mode: 'runtime' });
          graphChanged = latest !== reachable && !(latest?.root && reachable?.root
            && latest.rootRevision === reachable.rootRevision && latest.root.chatId === reachable.root.chatId
            && latest.root.headCheckpointId === reachable.root.headCheckpointId
            && latest.root.narrativeGeneration === reachable.root.narrativeGeneration
            && latest.root.sourceSnapshotFingerprint === reachable.root.sourceSnapshotFingerprint);
          reachable = latest;
        }
      }
      finally { targetStore.release?.(); }
      assertActive(operation);
      if (reachable?.root?.chatId && reachable.root.chatId !== operation.identity.chatId) throw errorWith('QQJ_PEOPLE_SOURCE_INVALID', '人物任务的原目标资料身份不一致。');
    }
    const previousMemory = operation.currentMemoryState ?? operation.memoryState;
    let subjects = previousMemory.sourceSubjects ?? previousMemory.cseSubjects;
    if (graphChanged && reachable?.root) {
      const replayed = reachable.baseline?.id ? await replayCurrentState({ chatId: operation.identity.chatId,
        narrativeGeneration: reachable.root.narrativeGeneration, baselineId: reachable.baseline.id,
        floors: reachable.floors, floorMemories: reachable.floorMemories, stateDeltas: reachable.stateDeltas, now: nowIso(now) }) : null;
      assertActive(operation);
      subjects = replayed?.subjects ?? [];
    }
    const projection = deriveUserIdentityProjection({ ...reachable, identityProjection: identityProjection(currentWorkspace) });
    const memoryState = { sourceSubjects: subjects,
      cseSubjects: projectCseStateIdentityReferences({ subjects }, projection).subjects };
    operation.currentReachable = reachable;
    operation.currentMemoryState = memoryState;
    return { reachable, memoryState };
  }
  let projectedInputs = null;
  const projectionInputs = (reachable, memoryState) => [chatId, revision, reachable, reachable?.floorMemories, reachable?.entities,
    reachable?.rootRevision, reachable?.root?.headCheckpointId, reachable?.baseline?.id,
    memoryState?.baselineId, memoryState?.currentStateId, memoryState?.currentStateFingerprint];
  const sameProjectionInputs = (left, right) => Boolean(left && right && left.length === right.length && left.every((value, index) => value === right[index]));
  const project = (memoryState = memoryRuntime.getState(), reachable = foundationRuntime.getReachable?.()) => {
    people = displayPeopleProjection(candidateProjection(reachable, memoryState, workspace), workspace);
    projectedInputs = projectionInputs(reachable, memoryState);
  };
  const syncIdentityProjection = () => { try { memoryRuntime.setIdentityProjection?.(identityProjection(workspace)); } catch { /* memory projection remains readable */ } };
  async function fullMaterialPlanFor(operation, candidate, characterCard) {
    const { reachable, memoryState, workspace } = operation;
    const macros = macrosFor(reachable);
    const projection = normalizeIdentityProjection(workspace ?? {}, macros);
    const directory = buildEntityIdentityDirectory({ entities: reachable?.entities ?? [], identityProjection: projection });
    const names = new Map(directory.filter(entry => entry.entityType === 'person').map(entry => [entry.entityId, entry.displayName]));
    const sourceEntityNames = {};
    const rememberName = id => { if (id && names.has(id)) sourceEntityNames[id] = names.get(id); };
    const { history, signature } = await collectPeopleHistory(targetHistoryEntries(reachable, candidate.entityId, macros, projection, rememberName));
    const context = targetContext(reachable, memoryState, candidate, workspace, macros, directory);
    const contextSignature = materialSignature({ context, characterCard });
    return Object.freeze({ entityId: candidate.entityId, history, context, sourceEntityNames: Object.freeze(sourceEntityNames), historyStart: 0, includeContext: true, includeWorldInfo: true,
      processedHistoryCount: history.length, materialSignature: signature, contextSignature });
  }
  function memoryIsBusy() {
    const state = memoryRuntime.getState();
    return Boolean(state?.memoryWorkBusy || state?.activeExtraction || state?.activeCse);
  }
  function confirmedFoundationSnapshot(identity, { allowPending = false } = {}) {
    const reachable = foundationRuntime.getReachable?.();
    const state = foundationRuntime.getState?.();
    const root = reachable?.root, checkpoint = reachable?.checkpoint;
    if (!reachable || !state || state.status !== 'ready' || state.foundationStatus !== 'ready'
      || state.chatId !== identity.chatId || state.activeRun || (state.pending && !allowPending)
      || root?.status !== 'ready' || root.chatId !== identity.chatId || !root.headCheckpointId
      || checkpoint?.id !== root.headCheckpointId || !checkpoint.capabilities?.foundationReady
      || reachable.status !== 'ready') return null;
    return { reachable, key: `${root.chatId}:${root.headCheckpointId}:${root.narrativeGeneration}` };
  }
  function pendingReplacementStillProven(proof, identity, snapshot) {
    if (!proof || !hostAdapter || typeof hostAdapter.snapshot !== 'function') return false;
    try {
      const host = hostAdapter.snapshot();
      if (host?.context?.chatMetadata?.qianqianjie?.chatId !== identity.chatId || !Array.isArray(host.chat)) return false;
      const oldAnchorStillPresent = host.chat.some(message => message?.is_user === false
        && inspectMessageFloorAnchor(message, identity.chatId).anchor?.floorId === proof.oldFloorId);
      if (oldAnchorStillPresent) return false;
      const replacementFloor = snapshot.reachable.floors?.find(floor => floor.id === proof.replacementFloorId
        && floor.hostLocator?.messageIndex === proof.messageIndex);
      const message = host.chat[proof.messageIndex];
      const isAiFloorMessage = message?.is_user === false && message?.extra?.type !== 'narrator'
        && !(message?.is_system === true && message?.extra?.type);
      const anchor = isAiFloorMessage ? inspectMessageFloorAnchor(message, identity.chatId) : null;
      return Boolean(replacementFloor && anchor?.status === 'valid' && anchor.anchor.floorId === proof.replacementFloorId);
    } catch { return false; }
  }
  async function pendingTailRemovalProofs(operation, snapshot, selectedIds) {
    if (!foundationStore || typeof foundationStore.readRecord !== 'function' || !hostAdapter || typeof hostAdapter.snapshot !== 'function') return new Map();
    const proofs = new Map();
    for (const entityId of selectedIds) {
      try {
        const entityResult = await foundationStore.readRecord('entity', entityId);
        if (!isCurrent(operation)) return proofs;
        const entity = entityResult?.status === 'ready' ? entityResult.data : null;
        const oldFloorId = entity?.firstSeenFloorId;
        if (entity?.id !== entityId || entity.chatId !== operation.identity.chatId || entity.entityType !== 'person'
          || entity.recordStatus !== 'active' || !oldFloorId) continue;
        const floorResult = await foundationStore.readRecord('floor', oldFloorId);
        if (!isCurrent(operation)) return proofs;
        const oldFloor = floorResult?.status === 'ready' ? floorResult.data : null;
        const messageIndex = oldFloor?.hostLocator?.messageIndex;
        if (oldFloor?.id !== oldFloorId || oldFloor.chatId !== operation.identity.chatId || !Number.isSafeInteger(messageIndex)) continue;
        const host = hostAdapter.snapshot();
        if (host?.context?.chatMetadata?.qianqianjie?.chatId !== operation.identity.chatId || !Array.isArray(host.chat)) continue;
        const oldAnchorStillPresent = host.chat.some(message => message?.is_user === false
          && inspectMessageFloorAnchor(message, operation.identity.chatId).anchor?.floorId === oldFloorId);
        if (oldAnchorStillPresent) continue;
        const replacement = snapshot.reachable.floors?.find(floor => floor.hostLocator?.messageIndex === messageIndex);
        const message = host.chat[messageIndex];
        const isAiFloorMessage = message?.is_user === false && message?.extra?.type !== 'narrator'
          && !(message?.is_system === true && message?.extra?.type);
        const anchor = isAiFloorMessage ? inspectMessageFloorAnchor(message, operation.identity.chatId) : null;
        if (!replacement || replacement.id === oldFloorId || anchor?.status !== 'valid' || anchor.anchor.floorId !== replacement.id) continue;
        proofs.set(entityId, Object.freeze({ oldFloorId, replacementFloorId: replacement.id, messageIndex }));
      } catch { /* Missing or unreliable source records leave the user's selection untouched. */ }
    }
    return proofs;
  }
  async function pruneUnreachableSelections(operation) {
    if (!isCurrent(operation) || operation.kind !== 'loading' || memoryIsBusy()) return;
    const initial = confirmedFoundationSnapshot(operation.identity, { allowPending: true });
    if (!initial) return;
    const foundationState = foundationRuntime.getState?.();
    const hasPendingTail = Boolean(foundationState?.pending);
    const pendingSignature = JSON.stringify(foundationState?.pending ?? null);
    let pendingProofs = new Map();
    if (hasPendingTail) {
      const projection = identityProjection(workspace);
      const reachablePeople = new Set(activePersonEntities(initial.reachable, workspace)
        .map(entity => resolveIdentityEntityId(entity.id, projection))
        .filter(entityId => entityId && !isIdentityDeleted(entityId, projection)));
      const absentSelections = workspace.selectedEntityIds.filter(entityId => {
        const canonicalId = resolveIdentityEntityId(entityId, projection);
        return canonicalId && !isIdentityDeleted(canonicalId, projection) && !reachablePeople.has(canonicalId);
      });
      pendingProofs = await pendingTailRemovalProofs(operation, initial, absentSelections);
      assertActive(operation);
    }
    await mutate(operation, current => {
      const latestSnapshot = confirmedFoundationSnapshot(operation.identity, { allowPending: true });
      if (!isCurrent(operation) || !latestSnapshot || latestSnapshot.key !== initial.key || memoryIsBusy()
        // A pending tail can appear while the workspace CAS reloads, even when root/head stay unchanged.
        || JSON.stringify(foundationRuntime.getState?.()?.pending ?? null) !== pendingSignature) return null;
      const currentProjection = identityProjection(current);
      const reachablePeople = new Set(activePersonEntities(latestSnapshot.reachable, current)
        .map(entity => resolveIdentityEntityId(entity.id, currentProjection))
        .filter(entityId => entityId && !isIdentityDeleted(entityId, currentProjection)));
      const selectedEntityIds = current.selectedEntityIds.filter(entityId => {
        const canonicalId = resolveIdentityEntityId(entityId, currentProjection);
        if (!canonicalId || isIdentityDeleted(canonicalId, currentProjection)) return false;
        if (reachablePeople.has(canonicalId)) return true;
        if (!hasPendingTail) return false;
        const proof = pendingProofs.get(entityId) ?? pendingProofs.get(canonicalId);
        return !(proof && pendingReplacementStillProven(proof, operation.identity, latestSnapshot));
      });
      if (selectedEntityIds.length === current.selectedEntityIds.length) return null;
      // Removed-floor identities leave the active selection only; their saved profiles and other history remain user data.
      return { ...clone(current), selectedEntityIds, updatedAt: nowIso(now) };
    });
  }
  function scheduleAutomaticMaintenance() {
    if (destroyed || !enabled() || !workspace || (!pendingInitialProfiles.size && !pendingAutomaticScan) || autoDrainQueued) return;
    if (!viewIsCurrent()) { pendingInitialProfiles.clear(); pendingAutomaticScan = false; return; }
    const scheduledEpoch = epoch, scheduledIdentity = viewIdentity;
    autoDrainQueued = true;
    autoDrainTimer = setTimeout(() => {
      autoDrainTimer = null;
      autoDrainQueued = false;
      if (scheduledEpoch !== epoch || !sameIdentity(scheduledIdentity, viewIdentity) || !viewIsCurrent()) { scheduleAutomaticMaintenance(); return; }
      void drainAutomaticMaintenance();
    }, 0);
  }
  function observeStableFloors() {
    if (destroyed || !enabled() || !workspace) return;
    let identity;
    try { identity = capture(); } catch { return; }
    const reachable = foundationRuntime.getReachable?.();
    if (!reachable || identity.chatId !== chatId || reachable.root?.chatId && reachable.root.chatId !== chatId) return;
    const count = eligibleAutomaticFloorCount(reachable);
    if (automaticChatId !== chatId || automaticFloorCount === null) {
      automaticChatId = chatId;
      automaticFloorCount = count;
      return;
    }
    if (count < automaticFloorCount) { automaticFloorCount = count; return; }
    // Advance the window before dispatch so automatic maintenance is a best-effort scan, not a backlog queue.
    if (count - automaticFloorCount < 10) return;
    automaticFloorCount = count;
    pendingAutomaticScan = true;
    scheduleAutomaticMaintenance();
  }
  async function drainAutomaticMaintenance() {
    if (destroyed || (!pendingInitialProfiles.size && !pendingAutomaticScan) || !workspace || !viewIsCurrent() || currentOperation() || memoryIsBusy()
      || (() => { try { return isMainGenerationActive() === true; } catch { return true; } })()) return;
    if (pendingInitialProfiles.size) {
      const entityId = pendingInitialProfiles.values().next().value;
      pendingInitialProfiles.delete(entityId);
      try {
        const candidate = candidateProjection(foundationRuntime.getReachable?.(), memoryRuntime.getState(), workspace).find(person => person.entityId === entityId);
        if (candidate?.selected && !workspace.profileMaterialProgressByEntityId?.[entityId]
          && !hasProfileMaterial(candidate.profile)) {
          await generateProfiles(items => items.filter(person => person.entityId === entityId && person.selected), {
            replaceExisting: true, firstInitialization: true,
          });
        }
      } catch (error) {
        // Failed first passes leave the queue; the user can retry explicitly or select the person again.
        if (error?.name !== 'AbortError' && error?.code !== 'QQJ_PEOPLE_STALE') {
          try { logger?.warn?.('[QQJ people] automatic first profile initialization failed', error); } catch { /* diagnostics only */ }
        }
      } finally {
        scheduleAutomaticMaintenance();
      }
      return;
    }
    if (!pendingAutomaticScan) return;
    pendingAutomaticScan = false;
    try {
      await generateProfiles(candidates => candidates.filter(candidate => candidate.selected), {
        automatic: true, includeWorldInfo: false,
      });
    } catch (error) {
      if (error?.name !== 'AbortError' && error?.code !== 'QQJ_PEOPLE_STALE') {
        try { logger?.warn?.('[QQJ people] automatic profile maintenance failed', error); } catch { /* diagnostics only */ }
      }
    } finally {
      scheduleAutomaticMaintenance();
    }
  }
  function getState(operation = null) {
    const visible = viewIsCurrent();
    const data = operation ? operation.workspace : visible ? workspace : null;
    const projectedPeople = operation ? operation.people : visible ? people : Object.freeze([]);
    const shownOperation = operation ? operation.settled ? null : operation : currentOperation();
    const shownChatId = operation ? operation.identity.chatId : (() => { try { return capture().chatId; } catch { return null; } })();
    const shownReachable = operation ? operation.currentReachable ?? operation.reachable : visible ? foundationRuntime.getReachable?.() : null;
    const selected = Object.freeze([...(data?.selectedEntityIds ?? [])]);
    const personOrder = Object.freeze([...(data?.personOrderEntityIds ?? [])]);
    const profiles = Object.freeze({ ...(data?.profilesByEntityId ?? {}) });
    const avatars = Object.freeze({ ...(data?.avatarsByEntityId ?? {}) });
    const redirects = Object.freeze({ ...(data?.identityRedirectsByEntityId ?? {}) });
    const deleted = Object.freeze([...(data?.deletedEntityIds ?? [])]);
    const materialProgress = Object.freeze({ ...(data?.profileMaterialProgressByEntityId ?? {}) });
    const migrationDescriptor = shownReachable?.migrationDescriptor ?? null;
    const archivedPeopleSnapshotIds = Object.freeze([...(migrationDescriptor?.recordRefs?.peopleSnapshotIds ?? [])]);
    return Object.freeze({ status: !enabled() ? 'disabled' : shownOperation?.kind ?? (data ? 'ready' : 'idle'), chatId: shownChatId,
      revision: operation ? operation.revision : visible ? revision : 0, selectedEntityIds: selected, personOrderEntityIds: personOrder, profilesByEntityId: profiles, avatarsByEntityId: avatars, people: projectedPeople,
      archivedPeopleSnapshotCount: archivedPeopleSnapshotIds.length,
      active: shownOperation ? Object.freeze({ kind: shownOperation.kind, ...(shownOperation.batchTotal ? { batchIndex: shownOperation.batchIndex, batchTotal: shownOperation.batchTotal } : {}) }) : null,
      identityRedirectsByEntityId: redirects, deletedEntityIds: deleted,
      profileMaterialProgressByEntityId: materialProgress,
      unprofiledSelectedCount: projectedPeople.filter(person => person.selected && !person.profiled).length, lastError: operation ? operation.lastError : visible ? lastError : null, lastGenerationReport: operation ? operation.lastGenerationReport : visible ? lastGenerationReport : null });
  }
  function getPeopleAvatars(entityIds = []) {
    const requested = [...new Set((Array.isArray(entityIds) ? entityIds : [])
      .filter(entityId => typeof entityId === 'string' && entityId.length > 0))];
    const requestedIds = new Set(requested);
    const avatarsByEntityId = Object.fromEntries(requested.map(entityId => [entityId, null]));
    if (!enabled()) return Object.freeze({ status: 'disabled', chatId: chatId ?? null, avatarsByEntityId: Object.freeze(avatarsByEntityId) });
    if (!workspace || !chatId || !viewIsCurrent()) return Object.freeze({ status: 'not-ready', chatId: null, avatarsByEntityId: Object.freeze(avatarsByEntityId) });
    for (const person of people) {
      const entityId = person?.entityId;
      if (requestedIds.has(entityId)) avatarsByEntityId[entityId] = typeof person.avatar === 'string' ? person.avatar : null;
    }
    return Object.freeze({ status: 'ready', chatId, avatarsByEntityId: Object.freeze(avatarsByEntityId) });
  }
  async function readArchivedProfileHistory(entityId) {
    if (typeof entityId !== 'string' || !entityId) throw errorWith('QQJ_PEOPLE_ENTITY_INVALID', '人物标识无效。');
    const reachable = foundationRuntime.getReachable?.();
    const snapshotIds = [...(reachable?.migrationDescriptor?.recordRefs?.peopleSnapshotIds ?? [])];
    if (!snapshotIds.length) return Object.freeze([]);
    const identity = capture();
    const values = [];
    for (const id of snapshotIds) {
      const saved = await store.readSnapshot(identity, id);
      const profile = saved?.data?.workspace?.profilesByEntityId?.[entityId];
      if (profile) values.push(Object.freeze({ sourceChatId: saved.data.sourceChatId, sourceRevision: saved.data.sourceRevision, profile }));
    }
    return Object.freeze(values);
  }
  function begin(kind) {
    if (!enabled()) throw errorWith('QQJ_PEOPLE_DISABLED', '千千结已关闭。');
    const identity = capture();
    const ownOperations = operations().filter(operation => sameIdentity(operation.identity, identity));
    const alongsideGeneration = ownOperations.length && ownOperations.every(operation => ['generating', 'generatingAvatar'].includes(operation.kind))
      && ['savingProfile', 'savingSelection', 'savingAvatar'].includes(kind);
    if (ownOperations.length && !alongsideGeneration) throw errorWith('QQJ_PEOPLE_BUSY', '人物资料正在处理，请稍候。');
    if (!sameIdentity(viewIdentity, identity)) {
      viewIdentity = identity; workspace = null; revision = 0; chatId = identity.chatId; people = Object.freeze([]); projectedInputs = null;
      lastError = null; lastGenerationReport = null;
      pendingInitialProfiles.clear(); pendingAutomaticScan = false; automaticFloorCount = null; automaticChatId = null;
    }
    const reachable = foundationRuntime.getReachable?.();
    const source = reachable?.root?.chatId && reachable.root.chatId !== identity.chatId ? null : reachable;
    const memory = memoryRuntime.getState();
    const operation = { kind, epoch, identity, controller: new AbortController(),
      reachable: source, memoryState: { cseSubjects: clone(memory?.cseSubjects ?? []) },
      workspace: workspace ?? emptyWorkspace(identity.chatId, nowIso(now)), revision,
      lastError: null, lastGenerationReport: null };
    operation.people = displayPeopleProjection(candidateProjection(source, operation.memoryState, operation.workspace), operation.workspace);
    if (active) concurrentWrites.add(operation); else active = operation;
    lastGenerationReport = null;
    lastError = null; notify(); return operation;
  }
  function adopt(operation, result) {
    operation.workspace = result.data ?? emptyWorkspace(operation.identity.chatId, nowIso(now));
    operation.revision = result.revision;
    operation.people = displayPeopleProjection(candidateProjection(operation.currentReachable ?? operation.reachable,
      operation.currentMemoryState ?? operation.memoryState, operation.workspace), operation.workspace);
    if (!isCurrent(operation) || chatId === operation.identity.chatId && revision > result.revision) return;
    workspace = operation.workspace; revision = result.revision; chatId = operation.identity.chatId; viewIdentity = operation.identity;
    syncIdentityProjection();
    try {
      const memoryState = memoryRuntime.getState(), reachable = foundationRuntime.getReachable?.();
      if (!sameProjectionInputs(projectedInputs, projectionInputs(reachable, memoryState))) project(memoryState, reachable);
    } catch { projectedInputs = null; /* A completed save is independent of its visible projection. */ }
  }
  async function latest(operation) { const result = await store.read(operation.identity); assertActive(operation); return result; }
  async function mutate(operation, updater) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await latest(operation);
      const base = current.data ?? emptyWorkspace(operation.identity.chatId, nowIso(now));
      const next = await updater(base);
      assertActive(operation);
      if (!next) { adopt(operation, current); return { changed: false, state: getState(operation) }; }
      try {
        const saved = await store.put(operation.identity, next, current.revision, { signal: operation.controller.signal });
        adopt(operation, saved); return { changed: true, state: getState(operation) };
      } catch (error) { if (error?.status === 409) continue; throw error; }
    }
    throw errorWith('QQJ_PEOPLE_CAS_CONFLICT', '人物资料同时发生多次修改，本次没有覆盖新数据，请重试。');
  }
  async function settle(operation, task) {
    try { await task(); }
    catch (error) {
      if (error?.name !== 'AbortError' && error?.code !== 'QQJ_PEOPLE_STALE') {
        operation.lastError = Object.freeze({ code: String(error?.code ?? 'QQJ_PEOPLE_FAILED'), message: clean(error?.message || '人物资料处理失败。', 500) });
        if (isCurrent(operation)) lastError = operation.lastError;
      }
      throw error;
    } finally {
      operation.settled = true;
      if (active === operation) active = null;
      concurrentWrites.delete(operation); notify(); scheduleAutomaticMaintenance();
    }
    return getState(operation);
  }
  async function refresh({ refreshMemory = true } = {}) {
    if (currentOperation()) return getState();
    const operation = begin('loading');
    return settle(operation, async () => {
      if (refreshMemory && typeof memoryRuntime.refreshStatus === 'function') await memoryRuntime.refreshStatus({ preferCached: true });
      assertActive(operation); adopt(operation, await latest(operation));
      await pruneUnreachableSelections(operation);
      if (!isCurrent(operation)) return;
      if (automaticChatId !== chatId || automaticFloorCount === null) {
        automaticChatId = chatId;
        automaticFloorCount = eligibleAutomaticFloorCount(foundationRuntime.getReachable?.());
      }
      lastError = null; notify();
    });
  }
  async function setSelectedEntityIds(entityIds) {
    const operation = begin('savingSelection');
    return settle(operation, async () => {
      const startingSelection = JSON.stringify(operation.workspace?.selectedEntityIds ?? []);
      const previouslySelected = new Set(operation.workspace?.selectedEntityIds ?? []);
      const requested = [...new Set((Array.isArray(entityIds) ? entityIds : []).map(String))];
      const result = await mutate(operation, async current => {
        const { reachable, memoryState } = await targetInputs(operation, current);
        if (JSON.stringify(current.selectedEntityIds) !== startingSelection) throw errorWith('QQJ_PEOPLE_SELECTION_CONFLICT', '重要人物选择已在其他页面更新，本次没有覆盖新选择，请重试。');
        const allowed = new Set(candidateProjection(reachable, memoryState, current).map(person => person.entityId));
        // Temporary roster gaps may keep a choice editable; confirmed checkpoint refresh removes IDs no longer canonical.
        if (requested.some(id => !isUuid(id) || (!allowed.has(id) && !previouslySelected.has(id)))) {
          throw errorWith('QQJ_PEOPLE_SELECTION_INVALID', '重要人物选择包含当前聊天不可用的人物。');
        }
        if (JSON.stringify(current.selectedEntityIds) === JSON.stringify(requested)) return null;
        return { ...clone(current), selectedEntityIds: requested, updatedAt: nowIso(now) };
      });
      if (isCurrent(operation)) lastError = null;
      const selectedNow = new Set(result.state.selectedEntityIds);
      // Only a newly added, actually empty profile starts first-time work; opening an old chat never backfills legacy profiles.
      if (isCurrent(operation)) {
        for (const id of result.state.selectedEntityIds) {
          if (!previouslySelected.has(id) && !result.state.profileMaterialProgressByEntityId?.[id]
            && !hasProfileMaterial(result.state.profilesByEntityId?.[id])) pendingInitialProfiles.add(id);
        }
        for (const id of [...pendingInitialProfiles]) if (!selectedNow.has(id)) pendingInitialProfiles.delete(id);
      }
      for (const pending of operations()) if (sameIdentity(pending.identity, operation.identity)
        && pending.firstInitializationEntityId && !selectedNow.has(pending.firstInitializationEntityId)) pending.controller.abort();
      scheduleAutomaticMaintenance();
      return result.state;
    });
  }
  async function setPersonOrderEntityIds(entityIds) {
    const operation = begin('savingOrder');
    return settle(operation, async () => {
      const startingOrder = JSON.stringify(operation.workspace?.personOrderEntityIds ?? []);
      const allowed = new Set(candidateProjection(operation.reachable, operation.memoryState, operation.workspace).map(person => person.entityId));
      const requested = [...new Set((Array.isArray(entityIds) ? entityIds : []).map(String))];
      if (requested.some(id => !isUuid(id) || !allowed.has(id))) throw errorWith('QQJ_PEOPLE_ORDER_INVALID', '人物顺序包含当前聊天不可用的人物。');
      const result = await mutate(operation, current => {
        if (JSON.stringify(current.personOrderEntityIds) === JSON.stringify(requested)) return null;
        if (JSON.stringify(current.personOrderEntityIds) !== startingOrder) throw errorWith('QQJ_PEOPLE_ORDER_CONFLICT', '人物顺序已在其他页面更新，本次没有覆盖新顺序，请重试。');
        return { ...clone(current), personOrderEntityIds: requested, updatedAt: nowIso(now) };
      });
      if (isCurrent(operation)) lastError = null; return result.state;
    });
  }
  async function saveProfile(entityId, fields, { manualFields: requestedManualFields = null } = {}) {
    const operation = begin('savingProfile');
    return settle(operation, async () => {
      const startingProfile = operation.workspace?.profilesByEntityId?.[entityId] ?? null;
      const candidate = candidateProjection(operation.reachable, operation.memoryState, operation.workspace).find(person => person.entityId === entityId);
      if (!candidate) throw errorWith('QQJ_PEOPLE_PROFILE_ENTITY_INVALID', '这个人物已不在当前聊天的可用人物中。');
      const requested = profileFields(fields);
      const result = await mutate(operation, async current => {
        const { reachable, memoryState } = await targetInputs(operation, current);
        const projection = identityProjection(current);
        if (resolveIdentityEntityId(entityId, projection) !== entityId || isIdentityDeleted(entityId, projection)
          || !candidateProjection(reachable, memoryState, current).some(person => person.entityId === entityId)) {
          throw errorWith('QQJ_PEOPLE_PROFILE_ENTITY_INVALID', '这个人物已删除或归属变化，本次资料没有写入。');
        }
        const existing = current.profilesByEntityId[entityId];
        if (JSON.stringify(existing ?? null) !== JSON.stringify(startingProfile)) throw errorWith('QQJ_PEOPLE_PROFILE_CONFLICT', '这个人物资料已在其他页面更新，本次没有覆盖新内容，请重试。');
        const declaredInput = requestedManualFields === null ? null : [...new Set(requestedManualFields)].filter(field => PEOPLE_PROFILE_FIELD_SET.has(field));
        const desired = existing && declaredInput ? { ...profileFields(existing), ...Object.fromEntries(declaredInput.map(field => [field, requested[field]])) } : requested;
        const confirmingAliases = declaredInput?.includes('aliases') && !existing?.manualFields?.includes('aliases');
        if (existing && sameFields(existing, desired) && !confirmingAliases) return null;
        const changedFields = PEOPLE_PROFILE_FIELDS.filter(field => String(existing?.[field] ?? '') !== String(desired[field] ?? ''));
        const declared = requestedManualFields === null ? changedFields : [...new Set(requestedManualFields)].filter(field => PEOPLE_PROFILE_FIELD_SET.has(field) && (changedFields.includes(field) || field === 'aliases'));
        const manual = [...new Set([...(existing?.manualFields ?? []), ...declared])];
        const timestamp = nowIso(now);
        return { ...clone(current), profilesByEntityId: { ...clone(current.profilesByEntityId), [entityId]: {
          entityId, ...desired, ...(existing?.aliasesComplete !== undefined ? { aliasesComplete: existing.aliasesComplete } : {}), manualFields: manual, source: manual.length ? 'manual' : existing?.source ?? 'manual', createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
        } }, updatedAt: timestamp };
      });
      if (isCurrent(operation)) lastError = null; return result.state;
    });
  }
  function prepareAvatarGeneration(entityId) {
    const person = people.find(item => item.entityId === entityId);
    if (!person) throw errorWith('QQJ_PEOPLE_PROFILE_ENTITY_INVALID', '这个人物已不在当前聊天的可用人物中。');
    if (!avatarGenerator) throw new Error('当前环境无法生成头像。');
    return avatarGenerator.prepare(person);
  }
  async function generateAvatar(entityId, { character } = {}) {
    const operation = begin('generatingAvatar');
    let result;
    await settle(operation, async () => {
      const person = operation.people.find(person => person.entityId === entityId);
      if (!person) throw errorWith('QQJ_PEOPLE_PROFILE_ENTITY_INVALID', '这个人物已不在当前聊天的可用人物中。');
      if (!avatarGenerator) throw new Error('当前环境无法生成头像。');
      result = await avatarGenerator.generate({ character, prompt: avatarPrompt(), clothingStyle: person.profile?.clothingStyle ?? '', signal: operation.controller.signal });
      assertActive(operation);
    });
    return result;
  }
  async function saveAvatar(entityId, avatarDataUrl, { originalFile = null, originalRef = null, crop = null, generated = false, onOriginalUploaded } = {}) {
    const operation = begin('savingAvatar');
    return settle(operation, async () => {
      const startingAvatar = operation.workspace?.avatarsByEntityId?.[entityId] ?? null;
      const startingSource = operation.workspace?.avatarSourcesByEntityId?.[entityId] ?? null;
      const candidate = candidateProjection(operation.reachable, operation.memoryState, operation.workspace).find(person => person.entityId === entityId);
      if (!candidate) throw errorWith('QQJ_PEOPLE_PROFILE_ENTITY_INVALID', '这个人物已不在当前聊天的可用人物中。');
      const requested = avatarDataUrl === null || avatarDataUrl === '' ? null : validateAvatar(avatarDataUrl, entityId);
      let source = null;
      if (requested && originalRef) source = normalizeAvatarSource({ ...originalRef, crop });
      else if (requested && originalFile) {
        if (!avatarImageStore) throw new Error('当前环境无法保存头像原图。');
        const uploaded = await avatarImageStore.upload(originalFile, { signal: operation.controller.signal, generated });
        onOriginalUploaded?.(uploaded);
        source = normalizeAvatarSource({ ...uploaded, crop });
      }
      const result = await mutate(operation, async current => {
        const { reachable, memoryState } = await targetInputs(operation, current);
        const projection = identityProjection(current);
        if (resolveIdentityEntityId(entityId, projection) !== entityId || isIdentityDeleted(entityId, projection)
          || !candidateProjection(reachable, memoryState, current).some(person => person.entityId === entityId)) {
          throw errorWith('QQJ_PEOPLE_PROFILE_ENTITY_INVALID', '这个人物已删除或归属变化，本次头像没有写入。');
        }
        const existing = current.avatarsByEntityId[entityId] ?? null;
        const existingSource = current.avatarSourcesByEntityId?.[entityId] ?? null;
        if (existing === requested && JSON.stringify(existingSource) === JSON.stringify(source)) return null;
        if (existing !== startingAvatar || JSON.stringify(existingSource) !== JSON.stringify(startingSource)) throw errorWith('QQJ_PEOPLE_PROFILE_CONFLICT', '这个人物头像已在其他页面更新，本次没有覆盖新头像，请重试。');
        const timestamp = nowIso(now), avatars = { ...clone(current.avatarsByEntityId) };
        const sources = { ...clone(current.avatarSourcesByEntityId ?? {}) };
        if (requested) avatars[entityId] = requested; else delete avatars[entityId];
        if (source) sources[entityId] = source; else delete sources[entityId];
        return { ...clone(current), avatarsByEntityId: avatars, avatarSourcesByEntityId: sources, updatedAt: timestamp };
      });
      if (isCurrent(operation)) lastError = null; return result.state;
    });
  }
  async function mergePeople(sourceEntityId, targetEntityId, profileSource = 'target') {
    const operation = begin('merging');
    return settle(operation, async () => {
      if (!isUuid(sourceEntityId) || !isUuid(targetEntityId) || sourceEntityId === targetEntityId || !['source', 'target'].includes(profileSource)) {
        throw errorWith('QQJ_PEOPLE_MERGE_INVALID', '请选择两个不同人物及要采用的整份资料。');
      }
      const candidates = candidateProjection(operation.reachable, operation.memoryState, operation.workspace);
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
        const chosenSource = current.avatarSourcesByEntityId?.[chosenId] ?? null;
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
        const avatarSources = { ...clone(current.avatarSourcesByEntityId ?? {}) };
        const progress = { ...clone(current.profileMaterialProgressByEntityId ?? {}) };
        delete profiles[sourceEntityId]; delete avatars[sourceEntityId]; delete avatarSources[sourceEntityId];
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
        if (chosenSource) avatarSources[targetEntityId] = clone(chosenSource); else delete avatarSources[targetEntityId];
        const selected = [...new Set(current.selectedEntityIds.map(id => resolveIdentityEntityId(id, provisional)).filter(id => id !== sourceEntityId))];
        if ((current.selectedEntityIds.includes(sourceEntityId) || current.selectedEntityIds.includes(targetEntityId)) && !selected.includes(targetEntityId)) selected.push(targetEntityId);
        const personOrder = [...new Set((current.personOrderEntityIds ?? []).map(id => resolveIdentityEntityId(id, provisional)).filter(id => id !== sourceEntityId))];
        const deleted = current.deletedEntityIds.filter(id => id !== sourceEntityId && id !== targetEntityId);
        return { ...clone(current), selectedEntityIds: selected, personOrderEntityIds: personOrder, profilesByEntityId: profiles, avatarsByEntityId: avatars, avatarSourcesByEntityId: avatarSources,
          profileMaterialProgressByEntityId: progress,
          identityRedirectsByEntityId: redirects, deletedEntityIds: deleted, updatedAt: timestamp };
      });
      if (isCurrent(operation)) { pendingInitialProfiles.delete(sourceEntityId); pendingInitialProfiles.delete(targetEntityId); }
      if (isCurrent(operation)) lastError = null; return result.state;
    });
  }
  async function deletePerson(entityId) {
    const operation = begin('deleting');
    return settle(operation, async () => {
      if (!isUuid(entityId)) throw errorWith('QQJ_PEOPLE_DELETE_INVALID', '要删除的人物标识无效。');
      const candidate = candidateProjection(operation.reachable, operation.memoryState, operation.workspace).find(person => person.entityId === entityId);
      if (!candidate) throw errorWith('QQJ_PEOPLE_DELETE_TARGET_INVALID', '这个人物已不在当前聊天的人物管理列表中。');
      const result = await mutate(operation, current => {
        const projection = identityProjection(current);
        const canonical = resolveIdentityEntityId(entityId, projection);
        if (canonical !== entityId || isIdentityDeleted(canonical, projection)) throw errorWith('QQJ_PEOPLE_DELETE_CONFLICT', '人物归属已经变化，请刷新后重试。');
        const members = new Set(identityProjectionMembers(canonical, projection));
        const profiles = { ...clone(current.profilesByEntityId) }, avatars = { ...clone(current.avatarsByEntityId) };
        const avatarSources = { ...clone(current.avatarSourcesByEntityId ?? {}) };
        const progress = { ...clone(current.profileMaterialProgressByEntityId ?? {}) };
        for (const id of members) { delete profiles[id]; delete avatars[id]; delete avatarSources[id]; delete progress[id]; }
        const timestamp = nowIso(now);
        return { ...clone(current), selectedEntityIds: current.selectedEntityIds.filter(id => !members.has(resolveIdentityEntityId(id, projection))),
          personOrderEntityIds: (current.personOrderEntityIds ?? []).filter(id => !members.has(resolveIdentityEntityId(id, projection))),
          profilesByEntityId: profiles, avatarsByEntityId: avatars, avatarSourcesByEntityId: avatarSources,
          profileMaterialProgressByEntityId: progress,
          deletedEntityIds: [...new Set([...current.deletedEntityIds, canonical])], updatedAt: timestamp };
      });
      if (isCurrent(operation)) {
        for (const id of identityProjectionMembers(entityId, identityProjection(operation.workspace))) pendingInitialProfiles.delete(id);
        pendingInitialProfiles.delete(entityId);
      }
      if (isCurrent(operation)) lastError = null; return result.state;
    });
  }
  function prepareWorldInfo(operation) {
    const filterBookNames = names => {
      if (typeof sourcePermissions.filterWorldInfoSources !== 'function') return names;
      const filtered = sourcePermissions.filterWorldInfoSources(names.map(sourceName => Object.freeze({ sourceName })));
      if (!Array.isArray(filtered)) throw errorWith('QQJ_PEOPLE_WORLDBOOK_FILTER_INVALID', '世界书许可过滤结果无效。');
      const allowedBooks = new Set(filtered.map(source => typeof source?.sourceName === 'string' ? source.sourceName.trim() : '').filter(Boolean));
      return names.filter(name => allowedBooks.has(name));
    };
    try { operation.worldInfoPromise = Promise.resolve(scanner(operation.context, { complete: true, strict: true, includeCatalog: false, filterBookNames })); }
    catch (error) { operation.worldInfoPromise = Promise.reject(error); }
    // History compaction may yield before the catalog is consumed.
    operation.worldInfoPromise.catch(() => {});
  }
  async function generationEnvelope(operation, targets, { includeWorldInfo = true, selectRelevantWorldInfo = false, characterCard = null } = {}) {
    const { reachable, memoryState, workspace } = operation;
    const macros = operation.macros;
    const hostContext = operation.context;
    const prequelText = typeof hostContext?.chatMetadata?.[PREQUEL_METADATA_KEY] === 'string' ? hostContext.chatMetadata[PREQUEL_METADATA_KEY] : '';
    const peopleRequest = [];
    const worldInfoPeople = [];
    for (const [index, target] of targets.entries()) {
      const history = target.materialPlan?.history ?? targetHistory(reachable, target.entityId, macros, identityProjection(workspace));
      const context = target.materialPlan?.context ?? targetContext(reachable, memoryState, target, workspace, macros);
      worldInfoPeople.push(context);
      const historyStart = target.materialPlan?.historyStart ?? 0;
      const includeContext = target.materialPlan?.includeContext !== false;
      const priorContext = prequelText.trim() ? selectPrequel({
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
      }).injectionText : '';
      peopleRequest.push({ personKey: `person-${index + 1}`, entityId: target.entityId, currentName: context.currentName,
        ...(Object.keys(target.materialPlan?.sourceEntityNames ?? {}).length ? { sourceEntityNames: target.materialPlan.sourceEntityNames } : {}),
        aliases: context.aliases,
        history: await compactPeopleHistory(historyStart ? history.slice(historyStart) : history),
        cseCoreTraits: includeContext ? context.cseCoreTraits : [],
        ...(priorContext ? { priorContext } : {}),
        existingProfile: existingAiProfile(target.profile, macros), manualProfile: manualProfile(target.profile, macros), manualFields: target.profile?.manualFields ?? [] });
    }
    let worldInfo = [];
    let worldInfoReport = null;
    if (includeWorldInfo) {
      let catalog;
      try { catalog = await operation.worldInfoPromise; }
      catch {
        throw errorWith('QQJ_PEOPLE_WORLDBOOK_INCOMPLETE', '关联世界书读取不完整，本次人物资料未保存。');
      }
      assertActive(operation);
      const candidates = await sourceCandidateFactory(catalog);
      const allowed = sourcePermissions.filterCandidates({ chatId: operation.identity.chatId, candidates });
      if (!Array.isArray(allowed)) throw errorWith('QQJ_PEOPLE_WORLDBOOK_FILTER_INVALID', '世界书许可过滤结果无效。');
      const selected = selectRelevantWorldInfo ? selectRelevantWorldInfoCandidates(allowed, worldInfoPeople, macros) : allowed;
      worldInfo = selected.map(candidate => ({ source: candidate.world, label: candidate.label, content: candidate.content })).filter(item => item.content);
      worldInfoReport = Object.freeze({ matched: worldInfo.length });
    }
    const includeCharacterCard = targets.some(target => target.materialPlan?.includeContext !== false);
    const request = { task: '整理选中人物的静态基础资料', people: peopleRequest,
      ...(includeCharacterCard && characterCard ? { characterCard } : {}), allowedWorldInfo: worldInfo };
    return { request, keys: new Map(peopleRequest.map((person, index) => [person.personKey, targets[index].entityId])), worldInfoReport };
  }
  function automaticRecentFloors(reachable) {
    const partition = migrationPartition(reachable);
    const floors = [...(reachable?.floors ?? [])].filter(floor => !isMemoryExcludedFloor(floor, null, reachable?.checkpoint, {
      frozen: partition.isFrozenFloor(floor.id),
    })).slice(-10);
    let remaining = 19000;
    const recentFloors = [];
    for (const floor of [...floors].reverse()) {
      const content = String(floor?.content?.canonicalContent ?? '');
      if (!content.trim()) continue;
      if (content.length <= remaining) {
        recentFloors.unshift({ sourceFloor: floor.assistantSeq, floorId: floor.id, content });
        remaining -= content.length;
      } else if (recentFloors.length === 0 && remaining > 0) {
        recentFloors.unshift({ sourceFloor: floor.assistantSeq, floorId: floor.id,
          excerpt: `仅提供本楼开头 ${remaining} 字符，后文省略`, content: content.slice(0, remaining) });
        remaining = 0;
      }
    }
    return Object.freeze(recentFloors);
  }
  function eligibleAutomaticFloorCount(reachable) {
    const partition = migrationPartition(reachable);
    return (reachable?.floors ?? []).filter(floor => !isMemoryExcludedFloor(floor, null, reachable?.checkpoint, {
      frozen: partition.isFrozenFloor(floor.id),
    })).length;
  }
  function automaticGenerationEnvelope(operation, targets) {
    const { reachable, memoryState, workspace } = operation;
    const macros = operation.macros;
    const recentFloors = automaticRecentFloors(reachable);
    if (!recentFloors.length) return null;
    const peopleRequest = targets.map((target, index) => {
      const context = targetContext(reachable, memoryState, target, workspace, macros);
      return {
        personKey: `person-${index + 1}`, currentName: context.currentName, aliases: context.aliases,
        existingProfile: existingAiProfile(target.profile, macros), manualProfile: manualProfile(target.profile, macros), manualFields: target.profile?.manualFields ?? [],
      };
    });
    return {
      targets,
      sourceSignature: materialSignature(recentFloors),
      selectedSignature: materialSignature([...(workspace?.selectedEntityIds ?? [])].sort()),
      request: { task: '根据最近稳定AI楼原文粗扫选中人物的长期基础资料；只返回明确新增或重大变化字段，无变化仅返回personKey', recentFloors, people: peopleRequest },
      keys: new Map(peopleRequest.map((person, index) => [person.personKey, targets[index].entityId])),
    };
  }
  function parseGenerated(result, keys, macros, { omitEmptyValues = false } = {}) {
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
        const fields = omitEmptyValues
          ? Object.fromEntries(Object.entries(patch.fields).filter(([, value]) => value.trim()))
          : patch.fields;
        if (Object.keys(fields).length || patch.invalidFields === 0) generated.set(keys.get(key), fields);
        else invalid += 1;
      }
      catch { invalid += 1; }
    }
    return Object.freeze({ generated, requested: keys.size, missing, conflicts, invalid, unknown });
  }
  async function generateProfiles(targetResolver, { replaceExisting = false, automatic = false, firstInitialization = false, includeWorldInfo = true } = {}) {
    const operation = begin('generating');
    return settle(operation, async () => {
      operation.automatic = automatic;
      const rebuilding = replaceExisting && !automatic;
      operation.firstInitializationEntityId = firstInitialization ? null : undefined;
      const initialReachable = operation.reachable;
      operation.macros = macrosFor(initialReachable);
      operation.characterCard = automatic ? null : characterCardContext(initialReachable, operation.macros);
      const guidanceSnapshot = typeof profilePromptGuidance === 'function' ? profilePromptGuidance() : profilePromptGuidance;
      const processingPromptSnapshot = typeof processingPrompt === 'function' ? processingPrompt() : processingPrompt;
      const systemPrompt = buildPeopleProfileSystemPrompt(guidanceSnapshot, processingPromptSnapshot);
      let targets = targetResolver(candidateProjection(operation.reachable, operation.memoryState, operation.workspace));
      if (automatic) targets = targets.filter(target => hasProfileMaterial(target.profile));
      if (!targets.length) {
        if (automatic) return getState();
        throw errorWith('QQJ_PEOPLE_NOTHING_TO_GENERATE', replaceExisting ? '当前人物不可重新整理。' : '选中的人物都已有基础资料。');
      }
      if (firstInitialization) operation.firstInitializationEntityId = targets[0].entityId;
      const host = contextProvider();
      const character = host?.characters?.[host.characterId];
      operation.context = { ...host, chatMetadata: { ...host?.chatMetadata },
        ...(character ? { characters: { [host.characterId]: { ...character, data: { ...character.data,
          ...(character.data?.character_book ? { character_book: clone(character.data.character_book) } : {}) } } } } : {}) };
      if (!automatic && includeWorldInfo) prepareWorldInfo(operation);
      if (!automatic) await yieldProfileWork();
      const plans = new Map();
      if (!automatic) for (const target of targets) plans.set(target.entityId, await fullMaterialPlanFor(operation, target, operation.characterCard));
      const preparedTargets = targets.map(target => ({ ...target, materialPlan: target.materialPlan ?? plans.get(target.entityId) }));
      const envelope = automatic
        ? automaticGenerationEnvelope(operation, targets)
        : await generationEnvelope(operation, preparedTargets, { includeWorldInfo, selectRelevantWorldInfo: rebuilding, characterCard: operation.characterCard });
      if (!envelope) return getState();
      if (automatic) {
        targets = envelope.targets;
        operation.automaticSourceSignature = envelope.sourceSignature;
        operation.automaticSelectedSignature = envelope.selectedSignature;
      }
      if (rebuilding) {
        envelope.request.task = '主动重新整理选中人物的静态基础资料';
      }
      const serializedLength = automatic || rebuilding ? 0 : JSON.stringify(envelope.request).length;
      // A full manual rebuild is one request and is persisted only after that complete response validates.
      const requests = rebuilding
        ? Object.freeze([{ request: await completeProfileRequest(envelope.request), keys: envelope.keys, overallIndex: 1, overallTotal: 1 }])
        : automatic || serializedLength <= PEOPLE_PROFILE_INPUT_CHAR_BUDGET
          ? Object.freeze([{ request: envelope.request, keys: envelope.keys, overallIndex: 1, overallTotal: 1 }])
          : (await longProfileBatches(envelope.request)).map(batch => Object.freeze({ ...batch, keys: new Map([[batch.personKey, envelope.keys.get(batch.personKey)]]) }));
      const saved = new Set();
      const aliasesNotUpdated = new Set();
      const expectedBatches = new Map(), completedBatches = new Map();
      for (const batch of requests) for (const entityId of new Set(batch.keys.values())) expectedBatches.set(entityId, (expectedBatches.get(entityId) ?? 0) + 1);
      const totals = { missing: 0, conflicts: 0, invalid: 0, unknown: 0, skipped: 0 };
      let finalState = getState();
      for (const batch of requests) {
        operation.batchIndex = batch.overallIndex; operation.batchTotal = batch.overallTotal;
        const request = { ...batch.request, people: batch.request.people.map(person => ({ ...person })) };
        const requestWorkspace = await latest(operation);
        const { reachable: requestReachable, memoryState: requestMemory } = await targetInputs(operation, requestWorkspace.data ?? operation.workspace);
        const requestCandidates = new Map(candidateProjection(requestReachable, requestMemory,
          requestWorkspace.data ?? emptyWorkspace(operation.identity.chatId, nowIso(now))).map(item => [item.entityId, item]));
        for (const person of request.people) {
          const entityId = batch.keys.get(person.personKey);
          const current = requestCandidates.get(entityId);
          person.existingProfile = existingAiProfile(current?.profile, operation.macros);
          person.manualProfile = manualProfile(current?.profile, operation.macros);
          person.manualFields = current?.profile?.manualFields ?? [];
        }
        notify(); assertActive(operation);
        let result;
        try {
          result = await generateUtilityTask({ systemPrompt, taskMessages: [{ role: 'user', content: JSON.stringify(request) }],
            maxTokens: 30000, temperature: 0, signal: operation.controller.signal, includeCharacterCard: false, worldInfoSource: 'none' });
        } catch (error) {
          if (rebuilding && isProfileInputLimitError(error)) {
            throw errorWith('QQJ_PEOPLE_INPUT_TOO_LARGE', '本次材料超过所选模型可接收范围，未保存。');
          }
          throw error;
        }
        assertActive(operation);
        if (rebuilding) incompleteProfileResult(result);
        const completionInputs = automatic ? await targetInputs(operation) : null;
        if (automatic && operation.automaticSourceSignature !== materialSignature(automaticRecentFloors(completionInputs.reachable))) {
          throw errorWith('QQJ_PEOPLE_STALE', '最近稳定楼正文已变化，迟到的人物粗扫结果未写入。');
        }
        const parsed = parseGenerated(result, batch.keys, operation.macros, { omitEmptyValues: automatic });
        for (const entityId of parsed.generated.keys()) completedBatches.set(entityId, (completedBatches.get(entityId) ?? 0) + 1);
        const completedMaterialEntityIds = new Set([...expectedBatches]
          .filter(([entityId, count]) => completedBatches.get(entityId) === count).map(([entityId]) => entityId));
        totals.missing += parsed.missing; totals.conflicts += parsed.conflicts; totals.invalid += parsed.invalid; totals.unknown += parsed.unknown;
        if (!parsed.generated.size) {
          setReport(operation, Object.freeze({ requested: targets.length, saved: saved.size, batches: requests.length, completedBatches: batch.overallIndex - 1, ...totals }));
          const savedEarlier = saved.size
            ? `此前已保存的 ${saved.size} 位资料已保留，请重新整理未完成部分。`
            : '本次没有保存资料，请稍后重新整理。';
          throw errorWith('QQJ_PEOPLE_GENERATION_BINDING_INVALID', `这次回复没有可保存的人物资料；${savedEarlier}`);
        }
        let savedEntityIds = [], skipped = 0;
        const persisted = await mutate(operation, async current => {
        const { reachable, memoryState } = await targetInputs(operation, current);
        if (automatic && (operation.automaticSourceSignature !== materialSignature(automaticRecentFloors(reachable))
          || operation.automaticSelectedSignature !== materialSignature([...current.selectedEntityIds].sort()))) {
          throw errorWith('QQJ_PEOPLE_STALE', '原文或重要人物选择已变化，迟到的人物粗扫结果未写入。');
        }
        const firstEntityId = firstInitialization ? envelope.keys.values().next().value : null;
        // First initialization is conditional on an empty dossier; check the latest CAS value before any patch or completion witness is written.
        if (firstInitialization && hasProfileMaterial(current.profilesByEntityId?.[firstEntityId])) { skipped = 1; return null; }
        const currentCandidates = new Map(candidateProjection(reachable, memoryState, current).map(item => [item.entityId, item]));
        const profiles = { ...clone(current.profilesByEntityId) };
        const progress = { ...clone(current.profileMaterialProgressByEntityId ?? {}) };
        let changed = false; const timestamp = nowIso(now);
        const projection = identityProjection(current);
        const selected = new Set(current.selectedEntityIds.map(id => resolveIdentityEntityId(id, projection)));
        if (rebuilding) {
          const entityId = envelope.keys.values().next().value;
          const stillPresent = currentCandidates.has(entityId);
          if (!selected.has(entityId) || !stillPresent || resolveIdentityEntityId(entityId, projection) !== entityId || isIdentityDeleted(entityId, projection)) {
            throw errorWith('QQJ_PEOPLE_STALE', '人物或重要人物选择已变化，本次资料没有保存。');
          }
        }
        savedEntityIds = []; skipped = 0;
        for (const [entityId, patch] of parsed.generated) {
          const canonicalId = resolveIdentityEntityId(entityId, projection);
          const live = canonicalId === entityId && !isIdentityDeleted(canonicalId, projection)
            && currentCandidates.has(canonicalId);
          if (!live) { skipped += 1; continue; }
          if (automatic) {
            if (!selected.has(entityId)) { skipped += 1; continue; }
          }
          const existing = profiles[entityId];
          // Ten-floor scans supplement existing material; only first initialization may create an empty dossier.
          if (automatic && !hasProfileMaterial(existing)) { skipped += 1; continue; }
          if (firstInitialization && hasProfileMaterial(existing)) { skipped += 1; continue; }
          if (!automatic && existing && !replaceExisting && !saved.has(entityId)) { skipped += 1; continue; }
          const manual = existing?.manualFields ?? [];
          const fullAliasReview = !automatic && completedMaterialEntityIds.has(entityId) && !manual.includes('aliases');
          const hasAliases = Object.hasOwn(patch, 'aliases');
          if (fullAliasReview && !hasAliases) aliasesNotUpdated.add(entityId);
          else aliasesNotUpdated.delete(entityId);
          if (!Object.keys(patch).length) { skipped += 1; continue; }
          const merged = { ...profileFields(existing ?? {}), ...patch };
          if (automatic && existing?.aliasesComplete === true && hasAliases && !manual.includes('aliases')) {
            const names = [existing.aliases, patch.aliases].flatMap(value => value.split(/[、，,\r\n]+/u));
            merged.aliases = normalizeIdentityProjection({ reviewedAliasesByEntityId: { [entityId]: names } }).reviewedAliasesByEntityId[entityId].join('、');
          }
          for (const field of manual) merged[field] = existing[field];
          const aliasesComplete = fullAliasReview && hasAliases ? true : existing?.aliasesComplete;
          if (existing && sameFields(existing, merged) && existing.aliasesComplete === aliasesComplete) { skipped += 1; continue; }
          profiles[entityId] = { entityId, ...merged, ...(aliasesComplete !== undefined ? { aliasesComplete } : {}), manualFields: [...manual], source: manual.length ? 'manual' : 'generated', createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
          savedEntityIds.push(entityId); changed = true;
        }
        if (!automatic) {
          const currentCharacterCard = characterCardContext(reachable, operation.macros);
          for (const entityId of completedMaterialEntityIds) {
            const plan = plans.get(entityId);
            if (!plan || !selected.has(entityId)) continue;
            const candidate = currentCandidates.get(entityId);
            if (!candidate) continue;
            const history = targetHistory(reachable, entityId, operation.macros, projection);
            const context = targetContext(reachable, memoryState, candidate, current, operation.macros);
            const material = materialSignature(history), contextValue = materialSignature({ context, characterCard: currentCharacterCard });
            if (history.length !== plan.processedHistoryCount || material !== plan.materialSignature || contextValue !== plan.contextSignature) continue;
            const next = { processedHistoryCount: history.length, materialSignature: material, contextSignature: contextValue, updatedAt: timestamp };
            if (JSON.stringify(progress[entityId] ?? null) !== JSON.stringify(next)) { progress[entityId] = next; changed = true; }
          }
        }
        if (firstInitialization) {
          const entityId = firstEntityId;
          const plan = plans.get(entityId);
          if (!plan) throw errorWith('QQJ_PEOPLE_MATERIAL_PLAN_INVALID', '首次人物整理材料计划无效，本次未保存。');
          // Keep the completed request's own source window as its witness even if new floors arrived while it ran.
          const previous = progress[entityId];
          const next = { processedHistoryCount: plan.processedHistoryCount, materialSignature: plan.materialSignature,
            contextSignature: plan.contextSignature, updatedAt: timestamp };
          if (JSON.stringify(previous ?? null) !== JSON.stringify(next)) { progress[entityId] = next; changed = true; }
        }
        return changed ? { ...clone(current), profilesByEntityId: profiles, profileMaterialProgressByEntityId: progress, updatedAt: timestamp } : null;
        });
        for (const entityId of savedEntityIds) saved.add(entityId);
        totals.skipped += skipped;
        finalState = persisted.state;
        setReport(operation, Object.freeze({ requested: targets.length, saved: saved.size,
          ...(aliasesNotUpdated.size ? { aliasesNotUpdated: aliasesNotUpdated.size } : {}),
          ...(requests.length > 1 ? { batches: requests.length, completedBatches: batch.overallIndex } : {}),
          ...(envelope.worldInfoReport ? { worldInfoMatched: envelope.worldInfoReport.matched } : {}), ...totals }));
        notify();
      }
      if (isCurrent(operation)) lastError = null; return finalState;
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
    active = null; concurrentWrites.clear(); workspace = null; revision = 0; chatId = null; viewIdentity = null; people = Object.freeze([]); projectedInputs = null; lastError = null; lastGenerationReport = null;
    if (autoDrainTimer !== null) clearTimeout(autoDrainTimer);
    autoDrainTimer = null; autoDrainQueued = false; pendingAutomaticScan = false; pendingInitialProfiles.clear(); automaticFloorCount = null; automaticChatId = null; syncIdentityProjection(); notify();
  }
  async function setEnabled(value) { if (value !== true) { invalidate(); return getState(); } return refresh(); }
  const unsubscribeMemory = typeof memoryRuntime.subscribe === 'function' ? memoryRuntime.subscribe(memoryState => {
    if (!workspace || !viewIsCurrent()) return;
    try {
      const reachable = foundationRuntime.getReachable?.(), nextInputs = projectionInputs(reachable, memoryState);
      if (!sameProjectionInputs(projectedInputs, nextInputs)) { project(memoryState); notify(); }
    } catch { /* projection can be refreshed by the next runtime notification */ }
    scheduleAutomaticMaintenance();
  }) : null;
  const unsubscribeFoundation = typeof foundationRuntime.subscribe === 'function' ? foundationRuntime.subscribe(() => observeStableFloors()) : null;
  return Object.freeze({ refresh, start: () => enabled() ? refresh() : Promise.resolve(getState()), setSelectedEntityIds, setPersonOrderEntityIds, saveProfile, saveAvatar, prepareAvatarGeneration, generateAvatar, mergePeople, deletePerson, generateMissingProfiles, regenerateProfile, readArchivedProfileHistory, invalidate, abortAll: invalidate, setEnabled,
    getIdentityProjection: () => identityProjection(viewIsCurrent() ? workspace : null),
    getActivityState: () => ({ busy: Boolean(active || concurrentWrites.size), phase: active?.kind ?? concurrentWrites.values().next().value?.kind ?? null }),
    getState, getPeopleAvatars, subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('人物工作区 listener 无效'); subscribers.add(listener); return () => subscribers.delete(listener); },
    wakeAutomaticMaintenance: scheduleAutomaticMaintenance,
    destroy() { destroyed = true; unsubscribeMemory?.(); unsubscribeFoundation?.(); invalidate(); },
  });
}
