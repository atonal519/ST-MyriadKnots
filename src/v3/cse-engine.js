import { sha256 } from '../identity.js';
import { scanArchiveV2WorldInfo } from '../archive-v2-source-scanner.js';
import { sanitizeArchiveV2SourceContent } from '../memory-content-sanitizer.js';
import { deterministicUuid } from './foundation-domain.js';
import { validateEntityRecord } from './memory-schema.js';
import { sanitizeDiagnosticValue, sanitizeTaskMetadata } from './safe-metadata.js';
import { stateFingerprint, validateBaselineRecord, validateCurrentStateRecord, validateStateDeltaRecord } from './cse-schema.js';

export const CSE_PROMPT_VERSION = 'qqj-v3-cse-prompt-1';
export const CSE_COMPILER_VERSION = `${CSE_PROMPT_VERSION}/after-state-compiler-1`;

export const CSE_SYSTEM_PROMPT = `你是“千千结”的人物状态理解器。请完整阅读本楼正文，并结合结构化楼层记忆、此前状态与相关初始设定，说明人物在本楼结束后处于什么状态以及原因。

正文 canonicalContent 是本楼事实的最高来源；结构化楼层记忆只是证据索引，冲突时以正文为准。初始设定属于作者设定，不等于任何角色已经知道它。私密想法只属于其本人，不能自动变成其他人物的认知。

只为输入中的 trackedSubjects 输出完整状态；knownPeople 仅用于 toward 对象绑定，不代表他们本楼也要输出状态。Core 是长期核心人格：首次可建立；以后如正文真正挑战 Core，请把挑战写进 coreChallenges，不要直接改写旧 Core。Adaptive 是可长期演化的应对方式或关系状态；涉及对象时写 toward。Situational 是短期状态；只有正文给出明确时间流逝时，才可按常识写 reasonableProgression，不能补造新事件。不要输出好感度、强度分数或数据库 ID。

返回一个 JSON 对象。推荐结构：
{"subjects":[{"subject":"人物名","core":[{"text":"核心特征","visibility":"authorial","reason":"依据"}],"adaptive":[{"text":"对某人的应对方式","toward":"对象名","visibility":"observable","reason":"依据"}],"situational":[{"text":"此刻状态","visibility":"private","reason":"依据","origin":"floor"}],"changeSummary":["变化摘要"],"coreChallenges":["对既有 Core 的挑战"]}],"noMaterialChange":false}
字段可以少，条目也可以直接写成字符串；不确定的可选项宁可省略。只输出 JSON，不要解释。`;

const normalized = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
const text = (value, maximum = 4000) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const list = value => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const field = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  for (const name of names) {
    const found = entries.find(([key]) => normalized(key) === normalized(name));
    if (found) return found[1];
  }
  return undefined;
};
const char = (ctx) => Array.isArray(ctx?.characters) ? ctx.characters[ctx.characterId] : ctx?.characters?.[ctx.characterId];
const personaDescription = ctx => text(ctx?.powerUserSettings?.persona_description ?? ctx?.personaDescription ?? ctx?.persona?.description ?? '', 40000);
const cardText = (character, names) => text(names.map(name => character?.data?.[name] ?? character?.[name]).find(value => typeof value === 'string') ?? '', 40000);
const aliasRecord = name => ({ name, normalized: normalized(name), kind: 'canonical', evidenceRefs: [], baselineClaimIds: [] });

export async function verifyCseBaselineFingerprint(baseline) {
  const payload = { userPersona: baseline.userPersona, characterCard: baseline.characterCard, worldInfoSources: baseline.worldInfoSources };
  return baseline.fingerprint === `sha256:${await sha256(JSON.stringify(payload))}`;
}

function entityLabels(entity) {
  return [entity.displayName, ...(entity.aliases ?? []).map(alias => alias.name)].map(normalized).filter(Boolean);
}

async function roleEntity({ chatId, narrativeGeneration, role, name, aliases = [], now }) {
  const id = await deterministicUuid(['v3-cse-role-entity', chatId, role]);
  const displayName = text(name, 500) || (role === 'user' ? '用户' : '角色');
  const names = [...new Set([displayName, ...aliases.map(value => text(value, 500)).filter(Boolean)])];
  return validateEntityRecord({
    schemaVersion: 3, recordType: 'entity', id, chatId, narrativeGeneration,
    entityType: 'person', displayName,
    aliases: names.map(aliasRecord), specialRole: role,
    firstSeenFloorId: null, lastSeenFloorId: null, status: 'established', mergedIntoEntityId: null,
    mergeEvidenceRefs: [], baselineClaimIds: [], createdAt: now, updatedAt: now,
    recordStatus: 'active', supersedes: null,
  }, { expectedChatId: chatId });
}

export async function captureCseBaseline({ hostAdapter, chatId, narrativeGeneration, entities = [], sanitizerOptions = {}, now }) {
  const snapshot = hostAdapter.snapshot();
  const ctx = snapshot.context;
  const userIdentity = snapshot.userIdentity;
  const character = char(ctx) ?? {};
  const user = entities.find(entity => entity.specialRole === 'user' && entity.recordStatus === 'active')
    ?? await roleEntity({ chatId, narrativeGeneration, role: 'user', name: userIdentity.displayName, aliases: userIdentity.aliases, now });
  const characterName = text(ctx?.name2 ?? character?.name ?? character?.data?.name ?? '角色', 500);
  const matchingCharacter = entities.filter(entity => entity.recordStatus === 'active' && entityLabels(entity).includes(normalized(characterName)));
  const characterEntity = entities.find(entity => entity.specialRole === 'char' && entity.recordStatus === 'active')
    ?? (matchingCharacter.length === 1 ? matchingCharacter[0] : null)
    ?? await roleEntity({ chatId, narrativeGeneration, role: 'char', name: characterName, aliases: [characterName, '{{char}}'], now });
  let catalog = { entries: [], warnings: [] };
  try { catalog = await scanArchiveV2WorldInfo(ctx); } catch { /* Luker/旧宿主缺少世界书接口时安全降级为空 */ }
  const worldInfoSources = [];
  for (const entry of catalog.entries ?? []) {
    if (entry.hostEnabled === false || entry.disabled === true) continue;
    const content = sanitizeArchiveV2SourceContent(entry.content, sanitizerOptions);
    if (!content) continue;
    worldInfoSources.push({
      sourceKind: 'worldbook', sourceName: text(entry.source, 512), scope: text(entry.scope, 80) || 'unknown',
      locator: `${text(entry.source, 240)}:${text(entry.uid, 120)}`, enabled: true,
      activated: entry.activated === true, content, fingerprint: `sha256:${await sha256(content)}`, visibility: 'authorial',
    });
  }
  const payload = {
    userPersona: { entityId: user.id, name: user.displayName, description: personaDescription(ctx), aliases: [...new Set(userIdentity.aliases ?? [])] },
    characterCard: { entityId: characterEntity.id, name: characterEntity.displayName, description: cardText(character, ['description']), personality: cardText(character, ['personality']), scenario: cardText(character, ['scenario']) },
    worldInfoSources,
  };
  const fingerprint = `sha256:${await sha256(JSON.stringify(payload))}`;
  const id = await deterministicUuid(['v3-cse-baseline', chatId]);
  const baseline = validateBaselineRecord({ schemaVersion: 3, recordType: 'baseline', id, chatId, narrativeGeneration, ...payload, fingerprint, createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: null }, { expectedChatId: chatId });
  return Object.freeze({ baseline, roleEntities: Object.freeze([user, characterEntity]), warnings: Object.freeze(catalog.warnings ?? []) });
}

export async function createBaselineRoleEntities(baseline) {
  const user = await roleEntity({ chatId: baseline.chatId, narrativeGeneration: baseline.narrativeGeneration, role: 'user', name: baseline.userPersona.name, aliases: baseline.userPersona.aliases, now: baseline.createdAt });
  const character = await roleEntity({ chatId: baseline.chatId, narrativeGeneration: baseline.narrativeGeneration, role: 'char', name: baseline.characterCard.name, aliases: [baseline.characterCard.name, '{{char}}'], now: baseline.createdAt });
  return Object.freeze([
    user.id === baseline.userPersona.entityId ? user : Object.freeze({ ...user, id: baseline.userPersona.entityId }),
    character.id === baseline.characterCard.entityId ? character : Object.freeze({ ...character, id: baseline.characterCard.entityId }),
  ]);
}

function memoryEntityIds(memory) {
  const result = new Set();
  const add = value => { if (typeof value === 'string') result.add(value); };
  memory.participants?.forEach(item => add(item.entityId));
  memory.privateCognition?.forEach(item => add(item.ownerEntityId));
  memory.commitments?.forEach(item => { add(item.speakerEntityId); item.targetEntityIds?.forEach(add); });
  memory.cseSignals?.forEach(item => { add(item.subjectEntityId); add(item.objectEntityId); });
  return result;
}

export function selectTrackedSubjects({ baseline, entities = [], floorMemories = [], floorMemory }) {
  const active = entities.filter(entity => entity.recordStatus === 'active' && entity.status !== 'merged' && entity.status !== 'invalidated' && entity.entityType === 'person');
  const byId = new Map(active.map(entity => [entity.id, entity]));
  const repeated = new Map();
  for (const memory of floorMemories) for (const id of memoryEntityIds(memory)) repeated.set(id, (repeated.get(id) ?? 0) + 1);
  const strong = new Set();
  floorMemory.privateCognition?.forEach(item => strong.add(item.ownerEntityId));
  floorMemory.commitments?.forEach(item => { strong.add(item.speakerEntityId); item.targetEntityIds?.forEach(id => strong.add(id)); });
  floorMemory.cseSignals?.forEach(item => { strong.add(item.subjectEntityId); if (item.objectEntityId) strong.add(item.objectEntityId); });
  const selected = new Map();
  const user = byId.get(baseline.userPersona.entityId) ?? active.find(entity => entity.specialRole === 'user');
  if (user) selected.set(user.id, user);
  for (const entity of active) if (entity.specialRole === 'user' || (repeated.get(entity.id) ?? 0) >= 2 || strong.has(entity.id)) selected.set(entity.id, entity);
  return [...selected.values()];
}

function semanticMemory(memory, entities) {
  const byId = new Map(entities.map(entity => [entity.id, entity.displayName]));
  const mapIds = value => Array.isArray(value) ? value.map(id => byId.get(id)).filter(Boolean) : byId.get(value) ?? null;
  return {
    summary: memory.summary?.effectiveSource === 'user' ? memory.summary.userText : memory.summary?.aiText,
    chronology: memory.chronology,
    locations: memory.locations?.map(item => ({ name: item.name, change: item.change, participants: mapIds(item.participantEntityIds) })),
    participants: memory.participants?.map(item => ({ person: mapIds(item.entityId), presence: item.presence })),
    actions: memory.actions?.map(item => ({ actor: mapIds(item.actorEntityId), targets: mapIds(item.targetEntityIds), action: item.action, completion: item.completion, result: item.result })),
    observations: memory.observations?.map(item => ({ subject: mapIds(item.subjectEntityId), kind: item.kind, description: item.description })),
    informationTransfers: memory.informationTransfers?.map(item => ({ from: mapIds(item.fromEntityId), to: mapIds(item.toEntityIds), claim: item.claimText, channel: item.channel })),
    privateCognition: memory.privateCognition?.map(item => ({ owner: mapIds(item.ownerEntityId), kind: item.kind, content: item.content, visibility: 'private' })),
    commitments: memory.commitments?.map(item => ({ speaker: mapIds(item.speakerEntityId), targets: mapIds(item.targetEntityIds), kind: item.kind, content: item.content, status: item.status })),
    cseSignals: memory.cseSignals?.map(item => ({ subject: mapIds(item.subjectEntityId), object: mapIds(item.objectEntityId), type: item.signalType, description: item.description })),
  };
}

function semanticItems(items, entities) {
  const byId = new Map(entities.map(entity => [entity.id, entity.displayName]));
  return items.map(item => ({ text: item.text, visibility: item.visibility, reason: item.reason, origin: item.origin, ...(item.towardEntityId ? { toward: byId.get(item.towardEntityId) ?? null } : {}) }));
}

function previousForPrompt(currentState, tracked, entities) {
  const trackedIds = new Set(tracked.map(entity => entity.id));
  return (currentState?.subjects ?? []).filter(subject => trackedIds.has(subject.subjectEntityId)).map(subject => {
    const owner = entities.find(entity => entity.id === subject.subjectEntityId);
    const visible = items => items.filter(item => item.visibility !== 'private' && item.visibility !== 'authorial');
    return { subject: owner?.displayName ?? '未知人物', ownState: { core: semanticItems(subject.core, entities), adaptive: semanticItems(subject.adaptive, entities), situational: semanticItems(subject.situational, entities) }, publicStateOfOthers: (currentState.subjects ?? []).filter(other => other.subjectEntityId !== subject.subjectEntityId).map(other => ({ subject: entities.find(entity => entity.id === other.subjectEntityId)?.displayName ?? '未知人物', core: semanticItems(visible(other.core), entities), adaptive: semanticItems(visible(other.adaptive), entities), situational: semanticItems(visible(other.situational), entities) })) };
  });
}

export function createCseEnvelope({ floor, floorMemory, baseline, currentState, trackedSubjects, entities }) {
  const activeKnownEntities = entities.filter(entity => entity.recordStatus !== 'invalidated' && entity.status !== 'merged' && entity.status !== 'invalidated');
  return Object.freeze({
    request: Object.freeze({ task: 'understandCharacterStateAfterFloor', locale: 'zh-CN', payload: {
      canonicalContent: floor.content.canonicalContent,
      floorMemory: semanticMemory(floorMemory, entities),
      previousState: previousForPrompt(currentState, trackedSubjects, entities),
      relevantBaseline: {
        userPersona: { name: baseline.userPersona.name, description: baseline.userPersona.description, visibility: 'authorial' },
        characterCard: { name: baseline.characterCard.name, description: baseline.characterCard.description, personality: baseline.characterCard.personality, scenario: baseline.characterCard.scenario, visibility: 'authorial' },
        worldInfo: baseline.worldInfoSources.map(source => ({ source: source.sourceName, content: source.content, visibility: 'authorial', activated: source.activated })),
      },
      trackedSubjects: trackedSubjects.map(entity => ({ name: entity.displayName, aliases: entityLabels(entity) })),
      knownPeople: activeKnownEntities.filter(entity => entity.entityType === 'person' || entity.specialRole !== 'none').map(entity => ({ name: entity.displayName, aliases: entityLabels(entity) })),
    } }),
    scope: Object.freeze({
      floorId: floor.id, floorMemoryId: floorMemory.id, chatId: floor.chatId, narrativeGeneration: floor.narrativeGeneration, baselineId: baseline.id,
      trackedBindings: trackedSubjects.map(entity => ({ entityId: entity.id, labels: entityLabels(entity), specialRole: entity.specialRole })),
      knownBindings: activeKnownEntities.map(entity => ({ entityId: entity.id, labels: entityLabels(entity), specialRole: entity.specialRole })),
    }),
  });
}

function parsePacket(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  let raw = String(value ?? '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu); if (fence) raw = fence[1].trim();
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? { subjects: parsed } : parsed; } catch { /* limited wrapper recovery */ }
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fail below */ } }
  const error = new TypeError('CSE 返回不是可识别的 JSON。'); error.code = 'V3_CSE_FORMAT_INVALID'; throw error;
}

function bindingFor(value, bindings) {
  const label = normalized(typeof value === 'string' ? value : field(value, ['subject', 'name', 'person', 'character', '主体', '人物', '姓名']));
  if (!label) return null;
  const userAlias = ['你', '主角', '用户', '{{user}}', 'user', 'player'].includes(label);
  const matches = bindings.filter(binding => (userAlias && binding.specialRole === 'user') || binding.labels.includes(label));
  return matches.length === 1 ? matches[0] : null;
}

const visibility = value => ({ private: 'private', 私密: 'private', 内心: 'private', expressed: 'expressed', 表达: 'expressed', 已表达: 'expressed', observable: 'observable', 可观察: 'observable', shared: 'shared', 共享: 'shared', authorial: 'authorial', 作者设定: 'authorial' }[normalized(value)] ?? 'private');
const origin = value => ({ baseline: 'baseline', 初始设定: 'baseline', floor: 'floor', 本楼: 'floor', reasonableprogression: 'reasonableProgression', naturalprogression: 'reasonableProgression', 合理进展: 'reasonableProgression', 自然进展: 'reasonableProgression' }[normalized(value)] ?? 'floor');
const itemSemantic = item => typeof item === 'string' ? item.trim() : text(field(item, ['text', 'state', 'description', 'content', '状态', '描述', '内容']), 4000);
const stateMeaning = item => [item.text, item.visibility, item.reason, item.origin, item.towardEntityId ?? ''];
const storedProjection = subject => ({ core: subject.core.map(stateMeaning), adaptive: subject.adaptive.map(stateMeaning), situational: subject.situational.map(stateMeaning) });

async function compileItems({ raw, category, binding, knownBindings, deltaId, floorId, previous, isolated }) {
  const output = [];
  for (const [index, item] of list(raw).slice(0, 120).entries()) {
    const value = itemSemantic(item);
    if (!value) { isolated.push({ field: category, index, code: 'V3_CSE_OPTIONAL_ITEM_INVALID' }); continue; }
    let towardEntityId = null;
    const towardRaw = typeof item === 'object' ? field(item, ['toward', 'target', 'object', '对谁', '对象']) : null;
    if (towardRaw !== undefined && towardRaw !== null && String(towardRaw).trim()) {
      const toward = bindingFor(towardRaw, knownBindings);
      if (!toward) { isolated.push({ field: category, index, code: 'V3_CSE_TOWARD_UNBOUND' }); continue; }
      towardEntityId = toward.entityId;
    }
    const reason = typeof item === 'object' ? text(field(item, ['reason', 'because', '依据', '原因']), 4000) : '';
    output.push({ id: await deterministicUuid(['v3-cse-state-item', deltaId, binding.entityId, category, index, value, towardEntityId]), text: value, visibility: visibility(typeof item === 'object' ? field(item, ['visibility', '可见性']) : null), reason: reason || '本楼状态投影', origin: origin(typeof item === 'object' ? field(item, ['origin', '来源']) : null), towardEntityId, sourceFloorId: floorId, sourceDeltaId: deltaId });
  }
  return output;
}

export async function compileCseResponse({ response, envelope, previousCurrentState, now, deltaId }) {
  const packet = parsePacket(response);
  const isolated = [];
  const previousById = new Map((previousCurrentState?.subjects ?? []).map(subject => [subject.subjectEntityId, subject]));
  const compiled = new Map();
  const rawSubjects = list(field(packet, ['subjects', 'people', 'characters', 'states', '人物', '角色', '状态']));
  for (const [subjectIndex, raw] of rawSubjects.slice(0, 80).entries()) {
    const binding = bindingFor(raw, envelope.scope.trackedBindings);
    if (!binding) { isolated.push({ field: 'subjects', index: subjectIndex, code: 'V3_CSE_SUBJECT_UNBOUND' }); continue; }
    if (compiled.has(binding.entityId)) { isolated.push({ field: 'subjects', index: subjectIndex, code: 'V3_CSE_SUBJECT_DUPLICATE' }); continue; }
    const previous = previousById.get(binding.entityId) ?? { core: [], adaptive: [], situational: [] };
    const hasCore = field(raw, ['core', '核心', '核心人格']) !== undefined;
    const hasAdaptive = field(raw, ['adaptive', '适应', '长期适应']) !== undefined;
    const hasSituational = field(raw, ['situational', 'situation', '短期状态', '情境']) !== undefined;
    const proposedCore = hasCore ? await compileItems({ raw: field(raw, ['core', '核心', '核心人格']), category: 'core', binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, previous, isolated }) : previous.core;
    const adaptive = hasAdaptive ? await compileItems({ raw: field(raw, ['adaptive', '适应', '长期适应']), category: 'adaptive', binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, previous, isolated }) : previous.adaptive;
    const situational = hasSituational ? await compileItems({ raw: field(raw, ['situational', 'situation', '短期状态', '情境']), category: 'situational', binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, previous, isolated }) : previous.situational;
    const explicitChallenges = list(field(raw, ['coreChallenges', 'coreChallenge', '核心挑战'])).map(itemSemantic).filter(Boolean);
    let core = proposedCore;
    const challenges = [...explicitChallenges];
    if (previous.core.length) {
      core = previous.core;
      if (hasCore && JSON.stringify(proposedCore.map(item => item.text)) !== JSON.stringify(previous.core.map(item => item.text))) challenges.push(...proposedCore.map(item => `AI 建议改写 Core：${item.text}`));
    }
    compiled.set(binding.entityId, { subjectEntityId: binding.entityId, core, adaptive, situational, changeSummary: list(field(raw, ['changeSummary', 'changes', '变化摘要', '变化'])).map(itemSemantic).filter(Boolean).slice(0, 40), coreChallenges: [...new Set(challenges)].slice(0, 40) });
  }
  for (const binding of envelope.scope.trackedBindings) if (!compiled.has(binding.entityId) && !previousById.has(binding.entityId)) compiled.set(binding.entityId, { subjectEntityId: binding.entityId, core: [], adaptive: [], situational: [], changeSummary: [], coreChallenges: [] });
  const subjectSnapshots = [...compiled.values()];
  const material = subjectSnapshots.some(subject => JSON.stringify(storedProjection(previousById.get(subject.subjectEntityId) ?? { core: [], adaptive: [], situational: [] })) !== JSON.stringify(storedProjection(subject)));
  const noMaterialChange = field(packet, ['noMaterialChange', 'noChange', '无实质变化']) === true || !material;
  const fingerprint = `sha256:${await sha256(JSON.stringify([envelope.scope.floorId, envelope.scope.floorMemoryId, subjectSnapshots, noMaterialChange]))}`;
  const delta = validateStateDeltaRecord({ schemaVersion: 3, recordType: 'stateDelta', id: deltaId, chatId: envelope.scope.chatId, narrativeGeneration: envelope.scope.narrativeGeneration, floorId: envelope.scope.floorId, floorMemoryId: envelope.scope.floorMemoryId, baselineId: envelope.scope.baselineId, previousCurrentStateId: previousCurrentState?.id ?? null, subjectSnapshots, noMaterialChange, fingerprint, source: { promptVersion: CSE_PROMPT_VERSION, compilerVersion: CSE_COMPILER_VERSION }, createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: null }, { expectedChatId: envelope.scope.chatId });
  return Object.freeze({ delta, isolated: Object.freeze(isolated) });
}

export async function runCseRequest({ generateUtilityTask, envelope, previousCurrentState, now, deltaId, signal }) {
  let candidate = null;
  const transportBudget = { remaining: 3, used: 0 };
  try {
    const result = await generateUtilityTask({ systemPrompt: CSE_SYSTEM_PROMPT, taskMessages: [{ role: 'user', content: JSON.stringify(envelope.request) }], maxTokens: 30000, temperature: 0, signal, includeCharacterCard: false, worldInfoSource: 'none', transportBudget, parseMode: 'semantic' });
    candidate = result?.jsonData ?? result?.textData ?? result;
    const compiled = await compileCseResponse({ response: candidate, envelope, previousCurrentState, now, deltaId });
    return Object.freeze({ ...compiled, metadata: sanitizeTaskMetadata(result?.taskMetadata), attempts: 1, transportAttempts: transportBudget.used || result?.taskMetadata?.transportAttempts || null, responseFingerprint: `sha256:${await sha256(JSON.stringify(candidate))}` });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    error.cseDiagnostics = { attempts: 1, transportAttempts: transportBudget.used || error?.transportAttempts || null, metadata: sanitizeTaskMetadata(error?.taskMetadata), candidate: (() => { try { return JSON.stringify(candidate).slice(0, 24000); } catch { return null; } })(), providerError: sanitizeDiagnosticValue(error?.providerError ?? null) };
    throw error;
  }
}

export function filterReachableDeltas({ floors = [], floorMemories = [], stateDeltas = [] }) {
  const order = new Map(floors.map((floor, index) => [floor.id, index]));
  const memoriesByFloor = new Map();
  for (const memory of floorMemories) memoriesByFloor.set(memory.floorId, [...(memoriesByFloor.get(memory.floorId) ?? []), memory]);
  const activeMemoryByFloor = new Map();
  for (const [floorId, memories] of memoriesByFloor) {
    const active = memories.filter(memory => memory.recordStatus === 'active');
    if (active.length === 1) activeMemoryByFloor.set(floorId, active[0].id);
  }
  const candidates = new Map();
  for (const delta of stateDeltas) {
    if (delta.recordStatus !== 'active' || !order.has(delta.floorId) || activeMemoryByFloor.get(delta.floorId) !== delta.floorMemoryId) continue;
    candidates.set(delta.floorId, [...(candidates.get(delta.floorId) ?? []), delta]);
  }
  const result = [], acceptedIds = new Set();
  for (const floor of floors) {
    const memories = memoriesByFloor.get(floor.id) ?? [];
    if (!memories.length) continue;
    if (memories.filter(memory => memory.recordStatus === 'active').length !== 1) break;
    const matches = candidates.get(floor.id) ?? [];
    if (matches.length !== 1) break;
    const delta = matches[0];
    const allowedIds = new Set([...acceptedIds, delta.id]);
    const sourceValid = delta.subjectSnapshots.every(subject => [...subject.core, ...subject.adaptive, ...subject.situational].every(item => (
      (!item.sourceDeltaId || allowedIds.has(item.sourceDeltaId))
      && (!item.sourceFloorId || (order.has(item.sourceFloorId) && order.get(item.sourceFloorId) <= order.get(delta.floorId)))
    )));
    if (!sourceValid) break;
    result.push(delta); acceptedIds.add(delta.id);
  }
  return result;
}

export async function replayCurrentState({ chatId, narrativeGeneration, baselineId, floors = [], floorMemories = [], stateDeltas = [], now, id = null, previousId = null }) {
  const deltas = filterReachableDeltas({ floors, floorMemories, stateDeltas });
  const subjects = new Map();
  for (const delta of deltas) for (const snapshot of delta.subjectSnapshots) {
    const previous = subjects.get(snapshot.subjectEntityId);
    subjects.set(snapshot.subjectEntityId, { subjectEntityId: snapshot.subjectEntityId, core: previous?.core?.length ? previous.core : snapshot.core, adaptive: snapshot.adaptive, situational: snapshot.situational });
  }
  const subjectList = [...subjects.values()];
  const appliedDeltaIds = deltas.map(delta => delta.id);
  const headFloorId = deltas.at(-1)?.floorId ?? null;
  const fingerprint = await stateFingerprint(subjectList, appliedDeltaIds, headFloorId);
  const recordId = id ?? await deterministicUuid(['v3-cse-current-state', chatId, narrativeGeneration, fingerprint]);
  return validateCurrentStateRecord({ schemaVersion: 3, recordType: 'currentState', id: recordId, chatId, narrativeGeneration, baselineId, subjects: subjectList, appliedDeltaIds, headFloorId, fingerprint, createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: previousId }, { expectedChatId: chatId });
}
