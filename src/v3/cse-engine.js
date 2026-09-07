import { sha256 } from '../identity.js';
import { repairJsonWithUniqueMissingObjectClose } from '../compact-api-client.js';
import { scanWorldInfo } from '../world-info-scanner.js';
import { sanitizeMemoryContent } from '../memory-content-sanitizer.js';
import { deterministicUuid } from './foundation-domain.js';
import { validateEntityRecord } from './memory-schema.js';
import { sanitizeDiagnosticValue, sanitizeTaskMetadata } from './safe-metadata.js';
import { CSE_VISIBILITIES, stateFingerprint, validateBaselineRecord, validateCurrentStateRecord, validateStateDeltaRecord } from './cse-schema.js';
import { withBaseProcessingPrompt } from '../internal-processing-prompt.js';
import { buildEntityIdentityDirectory } from './entity-identity.js';

export const CSE_PROMPT_VERSION = 'qqj-v3-cse-prompt-6';
export const CSE_COMPILER_VERSION = 'qqj-v3-cse-prompt-2/after-state-compiler-5';

export const DEFAULT_CSE_GUIDANCE = `你是“千千结”的人物状态理解器。完整阅读本楼正文，并结合结构化楼层记忆、人物此前状态与相关初始设定，分析人物在本楼结束时的状态。

优先识别正文真正造成的变化，也保留有连续性价值的稳定状态；不要为了显得有变化而改写人物。关注人物的核心倾向、可长期演化的应对方式或关系状态、当前短期情境，以及人物面对不同对象时采取的不同态度和行为模式。长期核心、逐渐形成的适应模式与一时情绪要分层表达；涉及特定对象时明确 toward。

按正文信息量决定详略。用清楚、具体、便于后续连续理解的短句说明状态，避免空泛形容、同义反复、好感度分数和无证据的心理诊断。新增或更新状态时尽量给出简短 reason，指出正文中的行为、表达、想法或事件依据；正文没有依据时不要为了补 reason 编造。`;

export const CSE_FIXED_CONTRACT = `【固定事实与隐私边界】
正文 canonicalContent 是本楼事实的最高来源；结构化楼层记忆和 subjectRelevantEvidence 只是证据索引，可能稀疏或缺项，冲突时以正文为准。某个结构数组为空或没有某人物，不等于正文没有发生相关事件，也不等于该人物不知道。初始设定属于作者设定，不等于任何角色已经知道它。私密想法只属于其本人，不能自动变成其他人物的认知。

subjectRelevantEvidence 按 tracked subject 汇集角色相关条目，relationToSubject 只说明该人物在既有 FloorMemory 条目里的结构角色，不是“此人已知证据”。participant 的 mentioned/privateCognitionOnly 不表示本人在场；行动 target 不表示本人知情，completion 为 intended/attempted/interrupted/uncertain 时尤其不能写成已完成；信息发送者只证明其说出或发出了相应内容，不证明消息内容客观为真，只有正文或实际送达证据才能支持接收者知情；承诺或指令的 target 不自动表示收到、同意或执行，plan 也不能写成已执行；cseSignal 的 object 只表示相关对象。远程行为与通信要按正文中的行为主体、对象、消息来源、接收者、渠道和完成状态分别理解，待转告不等于已经转告。不得把正文明确写出的人物认知反写为不知；人物被提及、被计划涉及或从叙述中推断出相关性，也不等于本人在场、参与或知情。

previousState 只放人物自己的前态；authorialOtherStateContext 是经过隐私过滤的作者态连续性参考，不代表相应人物知道其他人的状态。作者态推断与人物本人已知必须分开：observable 只用于正文中实际可观察的状态，private 只属于该人物的内心或明确知情，authorial 只作作者塑造参考。

只可为输入中的 trackedSubjects 输出状态；trackedSubjects 是候选范围，不要求逐人补写。若本楼没有足够新依据，可省略该人物；若只支持某些分类，可省略其他分类，让编译器沿用旧状态。不要用“本楼未出现”“状态无变化”之类空话替换旧状态，也不要因为缺少证据而反推“不知道”。knownPeople 仅用于 toward 对象绑定，不代表他们本楼也要输出状态。Core 首次可建立；已有 Core 只有在正文真正挑战它时才写入 coreChallenges，不能直接改写旧 Core。Adaptive 涉及对象时使用 toward。Situational 只有在正文给出明确时间流逝时才可写 reasonableProgression，不能补造新事件。新增或更新的状态推荐使用带简短 reason 的对象；如果正文没有可引用依据，可省略 reason，程序仍会接收并清楚标记为“未提供依据”，不要为凑字段编造。不要输出数据库 ID。

返回一个 JSON 对象。推荐结构：
{"subjects":[{"subject":"人物名","core":[{"reason":"正文依据","text":"核心特征","visibility":"authorial"}],"adaptive":[{"reason":"正文依据","text":"对某人的应对方式","toward":"对象名","visibility":"observable"}],"situational":[{"reason":"正文依据","text":"此刻状态","visibility":"private","origin":"floor"}],"changeSummary":["变化摘要"],"coreChallenges":["对既有 Core 的挑战"]}]}
不确定的可选人物或分类宁可省略。只输出 JSON，不要解释。`;

export function buildCseSystemPrompt(guidance = '') {
  const custom = typeof guidance === 'string' ? guidance : '';
  const businessGuidance = custom.trim() ? custom : DEFAULT_CSE_GUIDANCE;
  return withBaseProcessingPrompt(`${businessGuidance}\n\n${CSE_FIXED_CONTRACT}`);
}

export const CSE_SYSTEM_PROMPT = buildCseSystemPrompt();

const normalized = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
const errorWith = (code, message) => { const error = new TypeError(message ?? code); error.code = code; return error; };
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
  const id = await deterministicUuid(['v3-cse-role-entity', chatId, narrativeGeneration, role]);
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
  try { catalog = await scanWorldInfo(ctx); } catch { /* Luker/旧宿主缺少世界书接口时安全降级为空 */ }
  const worldInfoSources = [];
  for (const entry of catalog.entries ?? []) {
    if (entry.hostEnabled === false || entry.disabled === true) continue;
    const content = sanitizeMemoryContent(entry.content, sanitizerOptions);
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
  const id = await deterministicUuid(['v3-cse-baseline', chatId, narrativeGeneration]);
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
  memory.participants?.forEach(item => { if (item.presence === 'present' || item.presence === 'remote') add(item.entityId); });
  memory.actions?.forEach(item => { add(item.actorEntityId); item.targetEntityIds?.forEach(add); });
  memory.informationTransfers?.forEach(item => { add(item.fromEntityId); item.toEntityIds?.forEach(add); });
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

function subjectRelevantEvidence(memory, tracked, entities) {
  const semantic = semanticMemory(memory, entities);
  const related = (items, relationFor) => (items ?? []).flatMap((item, index) => {
    const relationToSubject = relationFor(index);
    return relationToSubject.length ? [{ ...item, relationToSubject }] : [];
  });
  return tracked.map(entity => {
    const sections = {
      participants: related(semantic.participants, index => memory.participants?.[index]?.entityId === entity.id ? ['participant'] : []),
      actions: related(semantic.actions, index => {
        const item = memory.actions?.[index];
        return [item?.actorEntityId === entity.id ? 'actor' : null, item?.targetEntityIds?.includes(entity.id) ? 'target' : null].filter(Boolean);
      }),
      observations: related(semantic.observations, index => memory.observations?.[index]?.subjectEntityId === entity.id ? ['subject'] : []),
      informationTransfers: related(semantic.informationTransfers, index => {
        const item = memory.informationTransfers?.[index];
        return [item?.fromEntityId === entity.id ? 'sender' : null, item?.toEntityIds?.includes(entity.id) ? 'recipient' : null].filter(Boolean);
      }),
      privateCognition: related(semantic.privateCognition, index => memory.privateCognition?.[index]?.ownerEntityId === entity.id ? ['owner'] : []),
      commitments: related(semantic.commitments, index => {
        const item = memory.commitments?.[index];
        return [item?.speakerEntityId === entity.id ? 'speaker' : null, item?.targetEntityIds?.includes(entity.id) ? 'target' : null].filter(Boolean);
      }),
      cseSignals: related(semantic.cseSignals, index => {
        const item = memory.cseSignals?.[index];
        return [item?.subjectEntityId === entity.id ? 'subject' : null, item?.objectEntityId === entity.id ? 'object' : null].filter(Boolean);
      }),
    };
    return { subject: entity.displayName, ...Object.fromEntries(Object.entries(sections).filter(([, items]) => items.length)) };
  });
}

function semanticItems(items, entities) {
  const byId = new Map(entities.map(entity => [entity.id, entity.displayName]));
  return items.map(item => ({ text: item.text, visibility: item.visibility, reason: item.reason, origin: item.origin, ...(item.towardEntityId ? { toward: byId.get(item.towardEntityId) ?? null } : {}) }));
}

function previousForPrompt(currentState, tracked, entities) {
  const trackedIds = new Set(tracked.map(entity => entity.id));
  return (currentState?.subjects ?? []).filter(subject => trackedIds.has(subject.subjectEntityId)).map(subject => {
    const owner = entities.find(entity => entity.id === subject.subjectEntityId);
    return { subject: owner?.displayName ?? '未知人物', ownState: { core: semanticItems(subject.core, entities), adaptive: semanticItems(subject.adaptive, entities), situational: semanticItems(subject.situational, entities) } };
  });
}

function authorialOtherStateContext(currentState, entities) {
  const visible = items => items.filter(item => item.visibility !== 'private' && item.visibility !== 'authorial');
  return (currentState?.subjects ?? []).map(subject => ({
    subject: entities.find(entity => entity.id === subject.subjectEntityId)?.displayName ?? '未知人物',
    core: semanticItems(visible(subject.core), entities),
    adaptive: semanticItems(visible(subject.adaptive), entities),
    situational: semanticItems(visible(subject.situational), entities),
  }));
}

export function createCseEnvelope({ floor, floorMemory, baseline, currentState, trackedSubjects, entities, worldInfoSources = null }) {
  const directory = buildEntityIdentityDirectory({ entities });
  const directoryById = new Map(directory.map(entry => [entry.entityId, entry]));
  const labelsFor = entity => directoryById.get(entity.id)?.labels ?? entityLabels(entity);
  const activeKnownEntities = directory.filter(entry => entry.entityType === 'person' || entry.specialRole !== 'none');
  const requestWorldInfoSources = Array.isArray(worldInfoSources) ? worldInfoSources : baseline.worldInfoSources;
  return Object.freeze({
    request: Object.freeze({ task: 'understandCharacterStateAfterFloor', locale: 'zh-CN', payload: {
      canonicalContent: floor.content.canonicalContent,
      floorMemory: semanticMemory(floorMemory, entities),
      previousState: previousForPrompt(currentState, trackedSubjects, entities),
      relevantBaseline: {
        userPersona: { name: baseline.userPersona.name, description: baseline.userPersona.description, visibility: 'authorial' },
        characterCard: { name: baseline.characterCard.name, description: baseline.characterCard.description, personality: baseline.characterCard.personality, scenario: baseline.characterCard.scenario, visibility: 'authorial' },
        worldInfo: requestWorldInfoSources.map(source => ({ source: source.sourceName, content: source.content, visibility: 'authorial', activated: source.activated })),
      },
      subjectRelevantEvidence: subjectRelevantEvidence(floorMemory, trackedSubjects, entities),
      authorialOtherStateContext: authorialOtherStateContext(currentState, entities),
      trackedSubjects: trackedSubjects.map(entity => ({ name: entity.displayName, aliases: labelsFor(entity) })),
      knownPeople: activeKnownEntities.map(entry => ({ name: entry.displayName, aliases: entry.labels })),
    } }),
    scope: Object.freeze({
      floorId: floor.id, floorMemoryId: floorMemory.id, chatId: floor.chatId, narrativeGeneration: floor.narrativeGeneration, baselineId: baseline.id,
      trackedBindings: trackedSubjects.map(entity => ({ entityId: entity.id, labels: labelsFor(entity), specialRole: entity.specialRole })),
      knownBindings: activeKnownEntities.map(entry => ({ entityId: entry.entityId, labels: entry.labels, specialRole: entry.specialRole })),
    }),
  });
}

function parsePacket(value, { finishReason } = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  let raw = String(value ?? '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu); if (fence) raw = fence[1].trim();
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? { subjects: parsed } : parsed; } catch { /* limited wrapper recovery */ }
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fail below */ } }
  const repaired = repairJsonWithUniqueMissingObjectClose(raw, { finishReason, allowArray: true });
  if (repaired) return Array.isArray(repaired) ? { subjects: repaired } : repaired;
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
    output.push({ id: await deterministicUuid(['v3-cse-state-item', deltaId, binding.entityId, category, index, value, towardEntityId]), text: value, visibility: visibility(typeof item === 'object' ? field(item, ['visibility', '可见性']) : null), reason: reason || '未提供依据', origin: origin(typeof item === 'object' ? field(item, ['origin', '来源']) : null), towardEntityId, sourceFloorId: floorId, sourceDeltaId: deltaId });
  }
  return output;
}

export async function compileCseResponse({ response, finishReason, envelope, previousCurrentState, now, deltaId }) {
  const packet = parsePacket(response, { finishReason });
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
  const noMaterialChange = !material;
  const fingerprint = `sha256:${await sha256(JSON.stringify([envelope.scope.floorId, envelope.scope.floorMemoryId, subjectSnapshots, noMaterialChange]))}`;
  const delta = validateStateDeltaRecord({ schemaVersion: 3, recordType: 'stateDelta', id: deltaId, chatId: envelope.scope.chatId, narrativeGeneration: envelope.scope.narrativeGeneration, floorId: envelope.scope.floorId, floorMemoryId: envelope.scope.floorMemoryId, baselineId: envelope.scope.baselineId, previousCurrentStateId: previousCurrentState?.id ?? null, subjectSnapshots, noMaterialChange, fingerprint, source: { promptVersion: CSE_PROMPT_VERSION, compilerVersion: CSE_COMPILER_VERSION }, createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: null }, { expectedChatId: envelope.scope.chatId });
  return Object.freeze({ delta, isolated: Object.freeze(isolated) });
}

const manualItemMeaning = (item, category) => [item.text, item.visibility, category === 'adaptive' ? item.towardEntityId ?? null : null];

async function manualStateItems({ edits, originals, category, subjectEntityId, floorId, oldDeltaId, deltaId, allowedTowardEntityIds }) {
  if (!Array.isArray(edits) || edits.length > 120) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', `${category} 编辑内容无效。`);
  const originalById = new Map(originals.map(item => [item.id, item]));
  const usedIds = new Set();
  const output = [];
  for (const [index, raw] of edits.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', `${category} 第 ${index + 1} 项无效。`);
    const itemId = typeof raw.itemId === 'string' && raw.itemId ? raw.itemId : null;
    const original = itemId ? originalById.get(itemId) : null;
    if (itemId && (!original || usedIds.has(itemId))) throw errorWith('V3_CSE_MANUAL_INPUT_STALE', `${category} 第 ${index + 1} 项已变化，请重新打开编辑。`);
    if (itemId) usedIds.add(itemId);
    const itemText = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!itemText || itemText.length > 4000 || !CSE_VISIBILITIES.includes(raw.visibility)) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', `${category} 第 ${index + 1} 项内容或可见性无效。`);
    const towardEntityId = category === 'adaptive' && typeof raw.towardEntityId === 'string' && raw.towardEntityId ? raw.towardEntityId : null;
    if (towardEntityId && !allowedTowardEntityIds.has(towardEntityId)) throw errorWith('V3_CSE_MANUAL_TOWARD_INVALID', '关系对象不在当前锚点可用人物范围内。');
    const nextMeaning = [itemText, raw.visibility, towardEntityId];
    if (original && JSON.stringify(manualItemMeaning(original, category)) === JSON.stringify(nextMeaning)) {
      if (original.sourceDeltaId !== oldDeltaId) { output.push(original); continue; }
      const rebased = { ...original, sourceDeltaId: deltaId };
      rebased.id = await deterministicUuid(['v3-cse-manual-rebase-item', deltaId, original.id, subjectEntityId, category, index]);
      output.push(rebased);
      continue;
    }
    const next = {
      id: await deterministicUuid(['v3-cse-manual-state-item', deltaId, subjectEntityId, category, index, itemText, raw.visibility, towardEntityId]),
      text: itemText,
      visibility: raw.visibility,
      reason: '用户纠正当前状态',
      origin: 'manual',
      towardEntityId,
      sourceFloorId: floorId,
      sourceDeltaId: deltaId,
    };
    output.push(next);
  }
  return output;
}

export async function createManualCseCorrection({ anchorDelta, currentState, subjectEntityId, edits, allowedTowardEntityIds = [], deltaId, now }) {
  const currentSubject = currentState?.subjects?.find(subject => subject.subjectEntityId === subjectEntityId);
  if (!currentSubject || !anchorDelta?.subjectSnapshots || typeof deltaId !== 'string') throw errorWith('V3_CSE_MANUAL_TARGET_INVALID', '当前人物状态或纠正锚点不可用。');
  const allowed = new Set(allowedTowardEntityIds);
  const categories = ['core', 'adaptive', 'situational'];
  const normalizedEdits = Object.fromEntries(categories.map(category => [category, Array.isArray(edits?.[category]) ? edits[category] : null]));
  if (categories.some(category => normalizedEdits[category] === null)) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', '人物状态编辑内容不完整。');
  const unchanged = categories.every(category => JSON.stringify(normalizedEdits[category].map(item => [String(item?.text ?? '').trim(), item?.visibility, category === 'adaptive' ? item?.towardEntityId || null : null])) === JSON.stringify(currentSubject[category].map(item => manualItemMeaning(item, category))));
  if (unchanged) return Object.freeze({ status: 'unchanged', delta: null });

  const corrected = { subjectEntityId, changeSummary: ['用户纠正当前状态'], coreChallenges: [] };
  for (const category of categories) corrected[category] = await manualStateItems({ edits: normalizedEdits[category], originals: currentSubject[category], category, subjectEntityId, floorId: anchorDelta.floorId, oldDeltaId: anchorDelta.id, deltaId, allowedTowardEntityIds: allowed });
  const snapshots = [];
  let replaced = false;
  for (const snapshot of anchorDelta.subjectSnapshots) {
    if (snapshot.subjectEntityId === subjectEntityId) { snapshots.push(corrected); replaced = true; continue; }
    const copy = structuredClone(snapshot);
    for (const category of categories) {
      copy[category] = await Promise.all(copy[category].map(async (item, index) => {
        if (item.sourceDeltaId !== anchorDelta.id) return item;
        const rebased = { ...item, sourceDeltaId: deltaId };
        rebased.id = await deterministicUuid(['v3-cse-manual-rebase-item', deltaId, item.id, copy.subjectEntityId, category, index]);
        return rebased;
      }));
    }
    snapshots.push(copy);
  }
  if (!replaced) snapshots.push(corrected);
  const manualSubjectEntityIds = [...new Set([...(anchorDelta.source?.manualSubjectEntityIds ?? []), subjectEntityId])];
  const noMaterialChange = false;
  const fingerprint = `sha256:${await sha256(JSON.stringify([anchorDelta.floorId, anchorDelta.floorMemoryId, snapshots, noMaterialChange]))}`;
  const delta = validateStateDeltaRecord({
    ...anchorDelta,
    id: deltaId,
    previousCurrentStateId: anchorDelta.previousCurrentStateId,
    subjectSnapshots: snapshots,
    noMaterialChange,
    fingerprint,
    source: { promptVersion: CSE_PROMPT_VERSION, compilerVersion: CSE_COMPILER_VERSION, manualSubjectEntityIds },
    createdAt: now,
    updatedAt: now,
    recordStatus: 'active',
    supersedes: anchorDelta.id,
  }, { expectedChatId: anchorDelta.chatId });
  return Object.freeze({ status: 'ready', delta });
}

export async function runCseRequest({ generateUtilityTask, envelope, previousCurrentState, now, deltaId, promptGuidance = '', signal }) {
  let candidate = null;
  const transportBudget = { remaining: 3, used: 0 };
  try {
    const systemPrompt = buildCseSystemPrompt(promptGuidance);
    const result = await generateUtilityTask({ systemPrompt, taskMessages: [{ role: 'user', content: JSON.stringify(envelope.request) }], maxTokens: 30000, temperature: 0, signal, includeCharacterCard: false, worldInfoSource: 'none', transportBudget, parseMode: 'semantic' });
    candidate = result?.jsonData ?? result?.textData ?? result;
    const compiled = await compileCseResponse({ response: candidate, finishReason: result?.taskMetadata?.finishReason, envelope, previousCurrentState, now, deltaId });
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
    const manualCore = delta.source?.manualSubjectEntityIds?.includes(snapshot.subjectEntityId) === true;
    subjects.set(snapshot.subjectEntityId, { subjectEntityId: snapshot.subjectEntityId, core: manualCore ? snapshot.core : previous?.core?.length ? previous.core : snapshot.core, adaptive: snapshot.adaptive, situational: snapshot.situational });
  }
  const subjectList = [...subjects.values()];
  const appliedDeltaIds = deltas.map(delta => delta.id);
  const headFloorId = deltas.at(-1)?.floorId ?? null;
  const fingerprint = await stateFingerprint(subjectList, appliedDeltaIds, headFloorId);
  const recordId = id ?? await deterministicUuid(['v3-cse-current-state', chatId, narrativeGeneration, fingerprint]);
  return validateCurrentStateRecord({ schemaVersion: 3, recordType: 'currentState', id: recordId, chatId, narrativeGeneration, baselineId, subjects: subjectList, appliedDeltaIds, headFloorId, fingerprint, createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: previousId }, { expectedChatId: chatId });
}
