import { sha256 } from '../identity.js';
import { parseJsonWithSymbolRepair, repairJsonWithUniqueMissingObjectClose } from '../json-symbol-repair.js';
import { scanWorldInfo } from '../world-info-scanner.js';
import { sanitizeMemoryContent } from '../memory-content-sanitizer.js';
import { deterministicUuid } from './foundation-domain.js';
import { validateEntityRecord } from './memory-schema.js';
import { sanitizeDiagnosticValue, sanitizeTaskMetadata } from './safe-metadata.js';
import { CSE_ISOLATION_CODES, CSE_VISIBILITIES, LATEST_CSE_CALIBRATION_VERSION, isSupportedCseCalibrationVersion, stateFingerprint, validateBaselineRecord, validateCurrentStateRecord, validateStateDeltaRecord } from './cse-schema.js';
import { withBaseProcessingPrompt } from '../internal-processing-prompt.js';
import { buildEntityIdentityDirectory } from './entity-identity.js';

export const CSE_PROMPT_VERSION = 'qqj-v3-cse-prompt-14';
export const CSE_COMPILER_VERSION = 'qqj-v3-cse-prompt-2/calibration-compiler-10';
export const CSE_CALIBRATION_VERSION = LATEST_CSE_CALIBRATION_VERSION;

export const DEFAULT_CSE_GUIDANCE = `你是“千千结”的人物状态理解器。完整阅读本楼正文，并结合结构化楼层记忆、人物此前状态与相关初始设定，分析人物在本楼结束时的状态。

优先识别正文真正造成的变化，也保留有连续性价值的稳定状态；不要为了显得有变化而改写人物。关注人物的核心倾向、可长期演化的应对方式或关系状态、当前短期情境，以及人物面对不同对象时采取的不同态度和行为模式。长期核心、逐渐形成的适应模式与一时情绪要分层表达。处理短期信息时，不要仅按句中是否出现他人机械决定 toward；先判断这条主要说明人物现在怎样、处境如何，还是人物此刻怎样对待某人。关系反应可以由有明确指向的言语和行为表现，不要求正文直接说出态度。

按正文信息量决定详略。用清楚、具体、便于后续连续理解的短句说明状态，避免空泛形容、同义反复、好感度分数和无证据的心理诊断。新增或更新状态时尽量给出简短 reason，指出正文中的行为、表达、想法或事件依据；正文没有依据时不要为了补 reason 编造。`;

export const CSE_FIXED_CONTRACT = `【固定事实与隐私边界】
正文 canonicalContent 是本楼事实的最高来源；结构化楼层记忆和 subjectRelevantEvidence 只是证据索引，可能稀疏或缺项，冲突时以正文为准。某个结构数组为空或没有某人物，不等于正文没有发生相关事件，也不等于该人物不知道。初始设定属于作者设定，不等于任何角色已经知道它。私密想法只属于其本人，不能自动变成其他人物的认知。

subjectRelevantEvidence 按 tracked subject 汇集角色相关条目，relationToSubject 只说明该人物在既有 FloorMemory 条目里的结构角色，不是“此人已知证据”。participant 的 mentioned/privateCognitionOnly 不表示本人在场；行动 target 不表示本人知情，completion 为 intended/attempted/interrupted/uncertain 时尤其不能写成已完成；信息发送者只证明其说出或发出了相应内容，不证明消息内容客观为真，只有正文或实际送达证据才能支持接收者知情；承诺或指令的 target 不自动表示收到、同意或执行，plan 也不能写成已执行；cseSignal 的 object 只表示相关对象。远程行为与通信要按正文中的行为主体、对象、消息来源、接收者、渠道和完成状态分别理解，待转告不等于已经转告。不得把正文明确写出的人物认知反写为不知；人物被提及、被计划涉及或从叙述中推断出相关性，也不等于本人在场、参与或知情。

previousState 只放人物自己的前态；authorialOtherStateContext 是经过隐私过滤的作者态连续性参考，不代表相应人物知道其他人的状态。作者态推断与人物本人已知必须分开：observable 只用于正文中实际可观察的状态，private 只属于该人物的内心或明确知情，authorial 只作作者塑造参考。

只可为输入中的 trackedSubjects 输出状态；trackedSubjects 是候选范围，不要求逐人补写，也不要求每个分类凑数。若本楼没有足够新依据，可省略该人物；若只支持某些分类，可省略其他分类，让编译器沿用旧状态。不要用“本楼未出现”“状态无变化”之类空话替换旧状态，也不要因为缺少证据而反推“不知道”。knownPeople 仅用于 toward 对象绑定，不代表他们本楼也要输出状态。

判断每条候选信息时，在内部依次问三个问题：第一，这条主要回答人物现在怎样、处境如何，还是此刻怎样对待某人？第二，另一人只是背景、原因或事件参与者，还是这项态度或相处反应的明确对象？第三，这里有两条独立且分别有正文依据的信息，需要拆开表达，还是同一信息的重复描述？只输出判断后的状态，不要输出思考过程、问题答案或分类解释。

主要说明人物自身现状时不填写 toward；正文明确支持人物针对某个已知人物的看法、态度或相处反应时，Adaptive 或 Situational 才填写 toward。关系反应可以通过明确指向对方的言语和行为表现，不需要直接说出态度；但不能只因一个行为有受事者就自动判为关系态度，也不能把行为一律排除出关系反应。对各方使用同一判断标准。混合信息只在确有独立依据时拆分，不强制双栏填满，不重复同一事实，也不编造态度。private 只表示可见性，明确的私密态度仍可填写 toward。previousState 中旧 toward 也必须按本楼证据审视，不得盲从；本楼不足以更新相应分类时应省略该分类以保留旧状态，不要把旧状态改写成“未知”。无法唯一判断对象时留空。单方 A→B 不得自动镜像成 B→A，也不能把某人的单方声称写成双方态度。Core 不使用 toward；一次关系反应也不能被拔高为 Core 或长期 Adaptive。Situational 只有在正文给出明确时间流逝时才可写 reasonableProgression，不能补造新事件。新增或更新的状态推荐使用带简短 reason 的对象；如果正文没有可引用依据，可省略 reason，程序仍会接收并清楚标记为“未提供依据”，不要为凑字段编造。不要输出数据库 ID。

【持续校准合同】
每次都审视本楼相关人物的已有 Core 与 Adaptive，并把它们同最新作者设定、明确用户纠正和本楼正文一起判断。旧结论本身及其旧 reason 不能自证；相容且没有新依据时保持原项，出现可定位反证或明确的新适用条件时才 refine/remove。剧情允许人物改变，但不强制每楼改写；单个戏剧性场景不能覆盖明确作者锚点，普通角色扮演中的用户台词、动作或心理也不自动等于作者纠正。

单次情绪、动作或台词默认只支持 Situational，不能据此概括人物“总是”“习惯”“一贯如此”。新增或扩大 Adaptive 必须由明确作者设定、明确用户纠正，或本次可定位材料中的多个相互独立事实共同支持重复模式；同一事件链中的多个动作不算跨事件的独立重复证据，不得拿 previousState、旧 reason 或自行假设的未提供历史凑成多个事实。单个反例也不自动证明旧模式完全反转；若证据只说明适用条件变窄，用 refine 写清条件。

人物被提及不等于本人在场；第三方声称某人的处境、行动或心理，不等于该内容已被客观证实。证据只支持时，可以记录说话者作出该声称，或有实际送达证据时记录接收者得知该说法；不得据此给被提及者新增 observable 状态或把传闻写成事实。

Core 以明确作者设定为锚，普通单楼情绪、动作或台词不足以新增或改写 Core；Adaptive 可随新事实、反例和旧依据不足而保持、收窄或撤回。coreUserEdited 为 true 时，只有 currentUserInput 中明确的作者纠正才可改变 Core；它不锁定 Adaptive。

currentUserInput 只在目标 AI 楼紧邻上一条确为 user 时提供。它可能是普通角色台词、动作、插件参考，也可能是作者明确校正；必须按语义区分，不能把整条输入一律当可信设定。引用只能使用 evidenceSourceCatalog 中的 source，quote 必须逐字存在于对应实际材料。userPersona 只支持用户本人，characterCard 只支持对应角色；worldbook 需判断人物归属。引用可定位不等于语义必然成立，仍须判断其是否真的支持操作。
authorNote 是作者侧持续参考，其中的未来要求、写作风格或塑造方向不等于已经发生的事实、所有人物已经知情或人物的永久性格。它不能单独作为新增或改写 Core 的证据。

Core/Adaptive 每类采用 review/additions 新协议，或沿用旧的直接 after-state 数组，不能同时使用两套。review 以 previousText（Adaptive 同名时再用 toward）精确指向旧项，action 只能是 keep、refine、remove；refine 还需 text。未提到项保留。新增项放 additions。refine、remove、addition 都必须给 evidence:[{source,quote}]；keep 可不带证据。不要把 previousState、旧 reason 或 authorialOtherStateContext 写成 evidence source。

返回一个 JSON 对象。所有 JSON 字符串都必须使用标准 JSON 转义：字符串内容中的英文双引号写成 \\", 反斜杠写成 \\\\, 实际换行写成 \\n；evidence.quote 引用正文原句时也必须遵守同一转义规则。JSON 解码后的 quote 必须保留原文字面，不得换成其他引号、删去字符或改写内容。
英文 schema 键必须保持示例写法；所有面向用户显示的状态 text、reason 和 changeSummary 内容使用中文。changeSummary 只概括人物的实际状态变化，不要输出字段名说明或格式解释；它只是辅助说明，不是状态事实或操作成功凭据。必须放在对应 subject 内，根级 changeSummary/summary 不会被当作人物状态，也不得用来代替 subjects。
推荐结构：
{"subjects":[{"subject":"人物甲","review":{"core":[{"previousText":"旧核心","action":"keep"}],"adaptive":[{"previousText":"旧模式","toward":"人物乙","action":"refine","text":"收窄后的模式","reason":"为何调整","evidence":[{"source":"canonicalContent","quote":"正文原句"}]}]},"additions":{"core":[],"adaptive":[]},"situational":[{"reason":"正文写出人物甲困倦并闭眼入睡","text":"困倦放松，正在入睡","visibility":"private","origin":"floor"},{"reason":"人物甲推开人物乙的手并明确拒绝触碰","text":"拒绝人物乙触碰","toward":"人物乙","visibility":"observable","origin":"floor"}],"changeSummary":["变化摘要"]}]}
不确定的可选人物或分类宁可省略。只输出 JSON，不要解释。`;

export function buildCseSystemPrompt(guidance = '', processingPrompt = '') {
  const custom = typeof guidance === 'string' ? guidance : '';
  const businessGuidance = custom.trim() ? custom : DEFAULT_CSE_GUIDANCE;
  return withBaseProcessingPrompt(`${businessGuidance}\n\n${CSE_FIXED_CONTRACT}`, processingPrompt);
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
  try { catalog = await scanWorldInfo(ctx, { bindings: hostAdapter.getWorldInfoBindings?.() ?? {} }); } catch { /* Luker/旧宿主缺少世界书接口时安全降级为空 */ }
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

function previousForPrompt(currentState, tracked, entities, coreUserEditedSubjectEntityIds) {
  const trackedIds = new Set(tracked.map(entity => entity.id));
  return (currentState?.subjects ?? []).filter(subject => trackedIds.has(subject.subjectEntityId)).map(subject => {
    const owner = entities.find(entity => entity.id === subject.subjectEntityId);
    return { subject: owner?.displayName ?? '未知人物', coreUserEdited: coreUserEditedSubjectEntityIds.has(subject.subjectEntityId), ownState: { core: semanticItems(subject.core, entities), adaptive: semanticItems(subject.adaptive, entities), situational: semanticItems(subject.situational, entities) } };
  });
}

function cseEvidenceSources({ floor, baseline, currentUserInput, requestSources }) {
  const userPersona = requestSources.userPersona ?? baseline.userPersona;
  const characterCard = requestSources.characterCard ?? baseline.characterCard;
  const worldInfoSources = requestSources.worldInfoSources ?? baseline.worldInfoSources;
  const sources = [
    { source: 'canonicalContent', kind: 'story', subjectEntityId: null, contents: [floor.content.canonicalContent] },
    { source: 'userPersona', kind: 'authorialSetting', subjectEntityId: baseline.userPersona.entityId, contents: [userPersona.description] },
    { source: 'characterCard', kind: 'authorialSetting', subjectEntityId: baseline.characterCard.entityId, contents: [characterCard.description, characterCard.personality, characterCard.scenario] },
    ...worldInfoSources.map((entry, index) => ({ source: `worldbook:${index + 1}`, kind: 'authorialSetting', subjectEntityId: null, contents: [entry.content] })),
  ];
  if (requestSources.authorNote?.content) sources.push({ source: 'authorNote', kind: 'authorialReference', subjectEntityId: null, contents: [requestSources.authorNote.content] });
  if (currentUserInput?.content) sources.push({ source: 'currentUserInput', kind: 'userInput', subjectEntityId: null, contents: [currentUserInput.content] });
  return sources;
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

export function createCseEnvelope({ floor, floorMemory, baseline, currentState, trackedSubjects, entities, requestSources = null, worldInfoSources = null, currentUserInput = null, coreUserEditedSubjectEntityIds = [] }) {
  const directory = buildEntityIdentityDirectory({ entities });
  const directoryById = new Map(directory.map(entry => [entry.entityId, entry]));
  const labelsFor = entity => directoryById.get(entity.id)?.labels ?? entityLabels(entity);
  const activeKnownEntities = directory.filter(entry => entry.entityType === 'person' || entry.specialRole !== 'none');
  const requestWorldInfoSources = Array.isArray(worldInfoSources) ? worldInfoSources : baseline.worldInfoSources;
  const effectiveSources = requestSources && typeof requestSources === 'object' ? requestSources : {
    userPersona: baseline.userPersona,
    characterCard: baseline.characterCard,
    worldInfoSources: requestWorldInfoSources,
    authorNote: Object.freeze({ content: '' }),
    fingerprint: null,
  };
  const effectiveUserPersona = effectiveSources.userPersona ?? baseline.userPersona;
  const effectiveCharacterCard = effectiveSources.characterCard ?? baseline.characterCard;
  const effectiveWorldInfoSources = Array.isArray(effectiveSources.worldInfoSources) ? effectiveSources.worldInfoSources : requestWorldInfoSources;
  const evidenceSources = cseEvidenceSources({ floor, baseline, currentUserInput, requestSources: { ...effectiveSources, worldInfoSources: effectiveWorldInfoSources } });
  const coreUserEdited = new Set(coreUserEditedSubjectEntityIds);
  const nameForSubjectId = entityId => directoryById.get(entityId)?.displayName
    ?? (entityId === baseline.userPersona.entityId ? baseline.userPersona.name : entityId === baseline.characterCard.entityId ? baseline.characterCard.name : null);
  return Object.freeze({
    request: Object.freeze({ task: 'understandCharacterStateAfterFloor', locale: 'zh-CN', payload: {
      canonicalContent: floor.content.canonicalContent,
      floorMemory: semanticMemory(floorMemory, entities),
      previousState: previousForPrompt(currentState, trackedSubjects, entities, coreUserEdited),
      relevantBaseline: {
        userPersona: { name: effectiveUserPersona.name, description: effectiveUserPersona.description, visibility: 'authorial' },
        characterCard: { name: effectiveCharacterCard.name, description: effectiveCharacterCard.description, personality: effectiveCharacterCard.personality, scenario: effectiveCharacterCard.scenario, visibility: 'authorial' },
        worldInfo: effectiveWorldInfoSources.map((source, index) => ({ source: source.sourceName, evidenceSource: `worldbook:${index + 1}`, content: source.content, visibility: 'authorial', activated: source.activated })),
        authorNote: effectiveSources.authorNote?.content ? { evidenceSource: 'authorNote', content: effectiveSources.authorNote.content, visibility: 'authorialReference' } : null,
      },
      currentUserInput: currentUserInput?.content ? { source: 'currentUserInput', messageIndex: currentUserInput.messageIndex, content: currentUserInput.content } : null,
      evidenceSourceCatalog: evidenceSources.map(source => ({ source: source.source, kind: source.kind, ...(source.subjectEntityId ? { subject: nameForSubjectId(source.subjectEntityId) } : {}) })),
      subjectRelevantEvidence: subjectRelevantEvidence(floorMemory, trackedSubjects, entities),
      authorialOtherStateContext: authorialOtherStateContext(currentState, entities),
      trackedSubjects: trackedSubjects.map(entity => ({ name: entity.displayName, aliases: labelsFor(entity), coreUserEdited: coreUserEdited.has(entity.id) })),
      knownPeople: activeKnownEntities.map(entry => ({ name: entry.displayName, aliases: entry.labels })),
    } }),
    scope: Object.freeze({
      floorId: floor.id, floorMemoryId: floorMemory.id, chatId: floor.chatId, narrativeGeneration: floor.narrativeGeneration, baselineId: baseline.id,
      trackedBindings: trackedSubjects.map(entity => ({ entityId: entity.id, labels: labelsFor(entity), specialRole: entity.specialRole })),
      knownBindings: activeKnownEntities.map(entry => ({ entityId: entry.entityId, labels: entry.labels, specialRole: entry.specialRole })),
      evidenceSources,
      sourceSnapshotFingerprint: typeof effectiveSources.fingerprint === 'string' ? effectiveSources.fingerprint : null,
      coreUserEditedSubjectEntityIds: [...coreUserEdited],
    }),
  });
}

function parsePacket(value, { finishReason } = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  let raw = String(value ?? '').trim();
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/giu)];
  if (fences.length) raw = fences[0][1].trim();
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? { subjects: parsed } : parsed; } catch { /* limited wrapper recovery */ }
  const symbolRepaired = fences.length <= 1 ? parseJsonWithSymbolRepair(raw, { finishReason })?.value : null;
  if (symbolRepaired) return Array.isArray(symbolRepaired) ? { subjects: symbolRepaired } : symbolRepaired;
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const bounded = raw.slice(start, end + 1);
    try { return JSON.parse(bounded); } catch { /* fail below */ }
  }
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
    const towardRaw = category !== 'core' && typeof item === 'object' ? field(item, ['toward', 'target', 'object', '对谁', '对象']) : null;
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

const categoryNames = category => category === 'core' ? ['core', '核心', '核心人格'] : ['adaptive', '适应', '长期适应'];
const sameItemMeaning = (left, right) => normalized(left?.text) === normalized(right?.text)
  && (left?.towardEntityId ?? null) === (right?.towardEntityId ?? null)
  && left?.visibility === right?.visibility;

const EVIDENCE_QUOTE_STYLE = Object.freeze({
  '"': '"', '“': '"', '”': '"', '„': '"', '‟': '"', '＂': '"', '「': '"', '」': '"',
  "'": "'", '‘': "'", '’': "'", '‚': "'", '‛': "'", '＇': "'", '『': "'", '』': "'",
});

function normalizedEvidenceQuoteStyle(value) {
  return [...value].map(character => EVIDENCE_QUOTE_STYLE[character] ?? character).join('');
}

function locateEvidenceQuote(contents, quote) {
  for (const content of contents) if (typeof content === 'string' && content.includes(quote)) return quote;
  const normalizedQuote = normalizedEvidenceQuoteStyle(quote);
  for (const content of contents) {
    if (typeof content !== 'string') continue;
    const index = normalizedEvidenceQuoteStyle(content).indexOf(normalizedQuote);
    if (index >= 0) return content.slice(index, index + quote.length);
  }
  return null;
}

function calibratedEvidence(raw, { envelope, binding, category, index, isolated }) {
  const evidence = [];
  const allSubmitted = list(field(raw, ['evidence', '证据']));
  const submitted = allSubmitted.slice(0, 20);
  for (const [evidenceIndex, item] of submitted.entries()) {
    const sourceName = text(field(item, ['source', '来源']), 160);
    const quote = text(field(item, ['quote', '引用']), 2000);
    const source = envelope.scope.evidenceSources.find(candidate => candidate.source === sourceName);
    const path = `${category}.${index}.evidence.${evidenceIndex}`;
    const locatedQuote = source && quote ? locateEvidenceQuote(source.contents, quote) : null;
    if (!source || !quote || !locatedQuote) {
      isolated.push({ field: path, code: 'V3_CSE_EVIDENCE_UNLOCATED' });
      continue;
    }
    if (source.subjectEntityId && source.subjectEntityId !== binding.entityId) {
      isolated.push({ field: path, code: 'V3_CSE_EVIDENCE_SUBJECT_MISMATCH' });
      continue;
    }
    evidence.push({ source: source.source, kind: source.kind, quote: locatedQuote });
  }
  return Object.freeze({ evidence: Object.freeze(evidence), complete: submitted.length > 0 && allSubmitted.length === submitted.length && evidence.length === submitted.length });
}

function calibratedMutationAllowed({ category, evidence, manualCore }) {
  if (!evidence.length) return false;
  if (category !== 'core') return true;
  if (manualCore) return evidence.some(item => item.source === 'currentUserInput');
  return evidence.some(item => item.kind === 'authorialSetting' || item.source === 'currentUserInput');
}

function reasonWithEvidence(raw, evidence) {
  const reason = text(field(raw, ['reason', 'because', '依据', '原因']), 2600);
  const audit = evidence.map(item => `${item.source}「${item.quote}」`).join('；');
  return `${reason || '基于本次可定位证据'}（证据：${audit}）`.slice(0, 4000);
}

async function calibratedStateItem({ raw, category, binding, knownBindings, deltaId, floorId, index, isolated, evidence, original = null }) {
  const value = itemSemantic(raw);
  if (!value) { isolated.push({ field: category, index, code: 'V3_CSE_OPTIONAL_ITEM_INVALID' }); return null; }
  let towardEntityId = category === 'adaptive' ? original?.towardEntityId ?? null : null;
  const towardRaw = typeof raw === 'object' ? field(raw, ['toward', 'target', 'object', '对谁', '对象']) : null;
  if (category === 'adaptive' && towardRaw !== undefined && towardRaw !== null && String(towardRaw).trim()) {
    const toward = bindingFor(towardRaw, knownBindings);
    if (!toward) { isolated.push({ field: category, index, code: 'V3_CSE_TOWARD_UNBOUND' }); return null; }
    towardEntityId = toward.entityId;
  }
  const visibilityRaw = typeof raw === 'object' ? field(raw, ['visibility', '可见性']) : null;
  const sourceOrigin = evidence.every(item => item.kind === 'authorialSetting') ? 'baseline' : 'floor';
  return {
    id: await deterministicUuid(['v3-cse-calibrated-state-item', deltaId, binding.entityId, category, index, value, towardEntityId]),
    text: value,
    visibility: visibilityRaw === undefined || visibilityRaw === null ? original?.visibility ?? 'private' : visibility(visibilityRaw),
    reason: reasonWithEvidence(raw, evidence),
    origin: sourceOrigin,
    towardEntityId,
    sourceFloorId: floorId,
    sourceDeltaId: deltaId,
  };
}

function calibrationAuditEntry({ binding, category, action, original = null, item = null, raw, evidence }) {
  return {
    subjectEntityId: binding.entityId,
    category,
    action,
    previousText: original?.text ?? null,
    previousTowardEntityId: original?.towardEntityId ?? null,
    text: item?.text ?? null,
    towardEntityId: item?.towardEntityId ?? null,
    reason: text(field(raw, ['reason', 'because', '依据', '原因']), 4000) || '基于本次可定位证据',
    evidence: evidence.map(({ source, quote }) => ({ source, quote })),
  };
}

async function compileCalibratedCategory({ rawSubject, category, binding, previous, envelope, deltaId, isolated, calibrationAudit }) {
  const reviewContainer = field(rawSubject, ['review', '复核']);
  const additionsContainer = field(rawSubject, ['additions', '新增']);
  const reviewRaw = field(reviewContainer, categoryNames(category));
  const additionsRaw = field(additionsContainer, categoryNames(category));
  const directRaw = field(rawSubject, categoryNames(category));
  const usesCalibration = reviewRaw !== undefined || additionsRaw !== undefined;
  if (!usesCalibration) return null;
  if (directRaw !== undefined) isolated.push({ field: category, code: 'V3_CSE_CATEGORY_PROTOCOL_MIXED' });

  const original = previous[category] ?? [];
  const output = [...original];
  const reviewedIds = new Set();
  const manualCore = category === 'core' && (envelope.scope.coreUserEditedSubjectEntityIds.includes(binding.entityId) || original.some(item => item.origin === 'manual'));
  for (const [index, review] of list(reviewRaw).slice(0, 120).entries()) {
    if (!review || typeof review !== 'object' || Array.isArray(review)) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_REVIEW_INVALID' }); continue; }
    const previousText = text(field(review, ['previousText', 'previous', '旧内容']), 4000);
    const action = normalized(field(review, ['action', '操作']));
    if (!previousText || !['keep', 'refine', 'remove'].includes(action)) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_REVIEW_INVALID' }); continue; }
    let towardEntityId;
    const towardRaw = field(review, ['toward', 'target', 'object', '对谁', '对象']);
    if (category === 'adaptive' && towardRaw !== undefined && towardRaw !== null && String(towardRaw).trim()) {
      const toward = bindingFor(towardRaw, envelope.scope.knownBindings);
      if (!toward) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_TOWARD_UNBOUND' }); continue; }
      towardEntityId = toward.entityId;
    }
    const matches = original.filter(item => normalized(item.text) === normalized(previousText)
      && (towardEntityId === undefined || item.towardEntityId === towardEntityId));
    if (matches.length !== 1 || reviewedIds.has(matches[0]?.id)) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_REVIEW_TARGET_AMBIGUOUS' }); continue; }
    const matched = matches[0];
    reviewedIds.add(matched.id);
    if (action === 'keep') continue;
    const evidenceGroup = calibratedEvidence(review, { envelope, binding, category, index, isolated });
    const evidence = evidenceGroup.evidence;
    if (!evidenceGroup.complete || !calibratedMutationAllowed({ category, evidence, manualCore })) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT' }); continue; }
    const currentIndex = output.findIndex(item => item.id === matched.id);
    if (currentIndex < 0) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_REVIEW_TARGET_AMBIGUOUS' }); continue; }
    if (action === 'remove') {
      output.splice(currentIndex, 1);
      calibrationAudit.push(calibrationAuditEntry({ binding, category, action, original: matched, raw: review, evidence }));
      continue;
    }
    const replacement = await calibratedStateItem({ raw: review, category, binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, index, isolated, evidence, original: matched });
    if (replacement && !sameItemMeaning(matched, replacement)) {
      output.splice(currentIndex, 1, replacement);
      calibrationAudit.push(calibrationAuditEntry({ binding, category, action, original: matched, item: replacement, raw: review, evidence }));
    }
  }

  for (const [index, addition] of list(additionsRaw).slice(0, 120).entries()) {
    if (!addition || typeof addition !== 'object' || Array.isArray(addition)) { isolated.push({ field: `${category}.additions`, index, code: 'V3_CSE_OPTIONAL_ITEM_INVALID' }); continue; }
    const evidenceGroup = calibratedEvidence(addition, { envelope, binding, category, index, isolated });
    const evidence = evidenceGroup.evidence;
    if (!evidenceGroup.complete || !calibratedMutationAllowed({ category, evidence, manualCore })) { isolated.push({ field: `${category}.additions`, index, code: 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT' }); continue; }
    const item = await calibratedStateItem({ raw: addition, category, binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, index: original.length + index, isolated, evidence });
    if (item && !output.some(existing => normalized(existing.text) === normalized(item.text) && existing.towardEntityId === item.towardEntityId)) {
      output.push(item);
      calibrationAudit.push(calibrationAuditEntry({ binding, category, action: 'add', item, raw: addition, evidence }));
    }
  }
  return output;
}

export async function compileCseResponse({ response, finishReason, envelope, previousCurrentState, now, deltaId }) {
  const packet = parsePacket(response, { finishReason });
  const isolated = [];
  const previousById = new Map((previousCurrentState?.subjects ?? []).map(subject => [subject.subjectEntityId, subject]));
  const compiled = new Map();
  const calibrationAudit = [];
  const rawSubjects = list(field(packet, ['subjects', 'people', 'characters', 'states', '人物', '角色', '状态']));
  for (const [subjectIndex, raw] of rawSubjects.slice(0, 80).entries()) {
    const binding = bindingFor(raw, envelope.scope.trackedBindings);
    if (!binding) { isolated.push({ field: 'subjects', index: subjectIndex, code: 'V3_CSE_SUBJECT_UNBOUND' }); continue; }
    if (compiled.has(binding.entityId)) { isolated.push({ field: 'subjects', index: subjectIndex, code: 'V3_CSE_SUBJECT_DUPLICATE' }); continue; }
    const previous = previousById.get(binding.entityId) ?? { core: [], adaptive: [], situational: [] };
    const hasCore = field(raw, categoryNames('core')) !== undefined;
    const hasAdaptive = field(raw, categoryNames('adaptive')) !== undefined;
    const hasSituational = field(raw, ['situational', 'situation', '短期状态', '情境']) !== undefined;
    let calibratedCore = await compileCalibratedCategory({ rawSubject: raw, category: 'core', binding, previous, envelope, deltaId, isolated, calibrationAudit });
    const calibratedAdaptive = await compileCalibratedCategory({ rawSubject: raw, category: 'adaptive', binding, previous, envelope, deltaId, isolated, calibrationAudit });
    const hasAuthorNote = envelope.scope.evidenceSources.some(source => source.source === 'authorNote');
    if (calibratedCore === null && hasCore && previous.core.length === 0 && hasAuthorNote) {
      calibratedCore = await compileCalibratedCategory({
        rawSubject: { additions: { core: field(raw, categoryNames('core')) } },
        category: 'core', binding, previous, envelope, deltaId, isolated, calibrationAudit,
      });
    }
    const proposedCore = calibratedCore ?? (hasCore ? await compileItems({ raw: field(raw, categoryNames('core')), category: 'core', binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, previous, isolated }) : previous.core);
    const adaptive = calibratedAdaptive ?? (hasAdaptive ? await compileItems({ raw: field(raw, categoryNames('adaptive')), category: 'adaptive', binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, previous, isolated }) : previous.adaptive);
    const situational = hasSituational ? await compileItems({ raw: field(raw, ['situational', 'situation', '短期状态', '情境']), category: 'situational', binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, previous, isolated }) : previous.situational;
    const explicitChallenges = list(field(raw, ['coreChallenges', 'coreChallenge', '核心挑战'])).map(itemSemantic).filter(Boolean);
    let core = proposedCore;
    const challenges = [...explicitChallenges];
    const manualCoreProtected = envelope.scope.coreUserEditedSubjectEntityIds.includes(binding.entityId) || previous.core.some(item => item.origin === 'manual');
    if ((previous.core.length || manualCoreProtected) && calibratedCore === null) {
      core = previous.core;
      if (hasCore && JSON.stringify(proposedCore.map(item => item.text)) !== JSON.stringify(previous.core.map(item => item.text))) challenges.push(...proposedCore.map(item => `AI 建议改写 Core：${item.text}`));
    }
    compiled.set(binding.entityId, { subjectEntityId: binding.entityId, core, adaptive, situational, changeSummary: [], coreChallenges: [...new Set(challenges)].slice(0, 40) });
  }
  for (const binding of envelope.scope.trackedBindings) if (!compiled.has(binding.entityId) && !previousById.has(binding.entityId)) compiled.set(binding.entityId, { subjectEntityId: binding.entityId, core: [], adaptive: [], situational: [], changeSummary: [], coreChallenges: [] });
  const subjectSnapshots = [...compiled.values()].map(subject => {
    const previous = previousById.get(subject.subjectEntityId) ?? { core: [], adaptive: [], situational: [] };
    const audits = calibrationAudit.filter(entry => entry.subjectEntityId === subject.subjectEntityId);
    return {
      ...subject,
      changeSummary: actualSubjectChanges({ before: previous, after: subject, audits })
        .map(change => summarizeActualChange(change, envelope.scope.knownBindings))
        .slice(0, 40),
    };
  });
  const material = subjectSnapshots.some(subject => JSON.stringify(storedProjection(previousById.get(subject.subjectEntityId) ?? { core: [], adaptive: [], situational: [] })) !== JSON.stringify(storedProjection(subject)));
  const noMaterialChange = !material;
  const fingerprint = `sha256:${await sha256(JSON.stringify([envelope.scope.floorId, envelope.scope.floorMemoryId, subjectSnapshots, noMaterialChange]))}`;
  const isolationCodes = [...new Set(isolated.map(item => item.code).filter(code => CSE_ISOLATION_CODES.includes(code)))];
  const delta = validateStateDeltaRecord({ schemaVersion: 3, recordType: 'stateDelta', id: deltaId, chatId: envelope.scope.chatId, narrativeGeneration: envelope.scope.narrativeGeneration, floorId: envelope.scope.floorId, floorMemoryId: envelope.scope.floorMemoryId, baselineId: envelope.scope.baselineId, previousCurrentStateId: previousCurrentState?.id ?? null, subjectSnapshots, noMaterialChange, fingerprint, source: { promptVersion: CSE_PROMPT_VERSION, compilerVersion: CSE_COMPILER_VERSION, calibrationVersion: CSE_CALIBRATION_VERSION, ...(calibrationAudit.length ? { calibrationAudit } : {}), ...(isolated.length ? { isolationSummary: { count: isolated.length, codes: isolationCodes } } : {}) }, createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: null }, { expectedChatId: envelope.scope.chatId });
  return Object.freeze({ delta, isolated: Object.freeze(isolated) });
}

const categoryAllowsToward = category => category === 'adaptive' || category === 'situational';
const manualItemMeaning = (item, category) => [item.text, item.visibility, categoryAllowsToward(category) ? item.towardEntityId ?? null : null];

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
    const towardEntityId = categoryAllowsToward(category) && typeof raw.towardEntityId === 'string' && raw.towardEntityId ? raw.towardEntityId : null;
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
  const unchanged = categories.every(category => JSON.stringify(normalizedEdits[category].map(item => [String(item?.text ?? '').trim(), item?.visibility, categoryAllowsToward(category) ? item?.towardEntityId || null : null])) === JSON.stringify(currentSubject[category].map(item => manualItemMeaning(item, category))));
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
    source: {
      promptVersion: CSE_PROMPT_VERSION,
      compilerVersion: CSE_COMPILER_VERSION,
      ...(isSupportedCseCalibrationVersion(anchorDelta.source?.calibrationVersion) ? { calibrationVersion: anchorDelta.source.calibrationVersion } : {}),
      ...(Array.isArray(anchorDelta.source?.calibrationAudit) ? { calibrationAudit: anchorDelta.source.calibrationAudit } : {}),
      ...(anchorDelta.source?.isolationSummary ? { isolationSummary: anchorDelta.source.isolationSummary } : {}),
      manualSubjectEntityIds,
    },
    createdAt: now,
    updatedAt: now,
    recordStatus: 'active',
    supersedes: anchorDelta.id,
  }, { expectedChatId: anchorDelta.chatId });
  return Object.freeze({ status: 'ready', delta });
}

export async function runCseRequest({ generateAnalysisTask, envelope, previousCurrentState, now, deltaId, promptGuidance = '', processingPrompt = '', signal }) {
  let candidate = null;
  const transportBudget = { remaining: 3, used: 0 };
  try {
    const systemPrompt = buildCseSystemPrompt(promptGuidance, processingPrompt);
    const result = await generateAnalysisTask({ systemPrompt, taskMessages: [{ role: 'user', content: JSON.stringify(envelope.request) }], maxTokens: 30000, temperature: 0, signal, includeCharacterCard: false, worldInfoSource: 'none', transportBudget, parseMode: 'semantic' });
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

const EMPTY_CSE_SUBJECT = Object.freeze({ core: Object.freeze([]), adaptive: Object.freeze([]), situational: Object.freeze([]) });
const CSE_STATE_CATEGORIES = Object.freeze(['core', 'adaptive', 'situational']);
const itemMeaningKey = item => JSON.stringify(stateMeaning(item));

function applyDeltaSnapshot(subjects, delta, snapshot) {
  const previous = subjects.get(snapshot.subjectEntityId);
  const manualCore = delta.source?.manualSubjectEntityIds?.includes(snapshot.subjectEntityId) === true;
  const calibrated = isSupportedCseCalibrationVersion(delta.source?.calibrationVersion);
  const applied = {
    subjectEntityId: snapshot.subjectEntityId,
    core: calibrated || manualCore ? snapshot.core : previous?.core?.length ? previous.core : snapshot.core,
    adaptive: snapshot.adaptive,
    situational: snapshot.situational,
  };
  subjects.set(snapshot.subjectEntityId, applied);
  return applied;
}

function categoryChanges({ before, after, category, audits }) {
  const usedBefore = new Set(), usedAfter = new Set(), changes = [];
  const beforeKeys = before.map(itemMeaningKey), afterKeys = after.map(itemMeaningKey);
  for (let beforeIndex = 0; beforeIndex < before.length; beforeIndex += 1) {
    const afterIndex = afterKeys.findIndex((key, index) => !usedAfter.has(index) && key === beforeKeys[beforeIndex]);
    if (afterIndex >= 0) { usedBefore.add(beforeIndex); usedAfter.add(afterIndex); }
  }
  const findBefore = (value, toward) => before.findIndex((item, index) => !usedBefore.has(index) && normalized(item.text) === normalized(value) && (item.towardEntityId ?? null) === (toward ?? null));
  const findAfter = (value, toward) => after.findIndex((item, index) => !usedAfter.has(index) && normalized(item.text) === normalized(value) && (item.towardEntityId ?? null) === (toward ?? null));
  for (const audit of audits) {
    if (audit.action === 'refine') {
      const beforeIndex = findBefore(audit.previousText, audit.previousTowardEntityId), afterIndex = findAfter(audit.text, audit.towardEntityId);
      if (beforeIndex < 0 || afterIndex < 0) continue;
      usedBefore.add(beforeIndex); usedAfter.add(afterIndex);
      changes.push({ category, action: 'refine', before: before[beforeIndex], after: after[afterIndex] });
    } else if (audit.action === 'remove') {
      const beforeIndex = findBefore(audit.previousText, audit.previousTowardEntityId);
      if (beforeIndex < 0) continue;
      usedBefore.add(beforeIndex); changes.push({ category, action: 'remove', before: before[beforeIndex], after: null });
    } else if (audit.action === 'add') {
      const afterIndex = findAfter(audit.text, audit.towardEntityId);
      if (afterIndex < 0) continue;
      usedAfter.add(afterIndex); changes.push({ category, action: 'add', before: null, after: after[afterIndex] });
    }
  }
  const remainingBefore = before.map((item, index) => ({ item, index })).filter(({ index }) => !usedBefore.has(index));
  const remainingAfter = after.map((item, index) => ({ item, index })).filter(({ index }) => !usedAfter.has(index));
  if (category === 'situational' && remainingBefore.length === 1 && remainingAfter.length === 1) {
    changes.push({ category, action: 'update', before: remainingBefore[0].item, after: remainingAfter[0].item });
    usedBefore.add(remainingBefore[0].index); usedAfter.add(remainingAfter[0].index);
  }
  for (const { item, index } of before.map((value, position) => ({ item: value, index: position }))) if (!usedBefore.has(index)) changes.push({ category, action: 'remove', before: item, after: null });
  for (const { item, index } of after.map((value, position) => ({ item: value, index: position }))) if (!usedAfter.has(index)) changes.push({ category, action: 'add', before: null, after: item });
  return changes;
}

function actualSubjectChanges({ before, after, audits }) {
  return CSE_STATE_CATEGORIES.flatMap(category => categoryChanges({
    before: before[category] ?? [],
    after: after[category] ?? [],
    category,
    audits: audits.filter(entry => entry.category === category),
  }));
}

function summarizeActualState(item, category, knownBindings) {
  const details = [];
  if (categoryAllowsToward(category) && item?.towardEntityId) {
    const target = knownBindings.find(binding => binding.entityId === item.towardEntityId)?.labels?.[0];
    details.push(`对象：${target || '已绑定人物'}`);
  }
  const visibilityName = { private: '私密', expressed: '已表达', observable: '可观察', shared: '共享', authorial: '作者设定' }[item?.visibility];
  if (visibilityName) details.push(`信息范围：${visibilityName}`);
  const originName = { baseline: '初始设定', floor: '本楼', reasonableProgression: '合理进展', manual: '用户纠正' }[item?.origin];
  if (originName) details.push(`来源：${originName}`);
  return `${item?.text ?? ''}${details.length ? `（${details.join('；')}）` : ''}`;
}

function summarizeActualChange(change, knownBindings) {
  const categoryName = { core: '核心人格', adaptive: '长期适应', situational: '情境状态' }[change.category] ?? '人物状态';
  const before = change.before ? summarizeActualState(change.before, change.category, knownBindings) : '';
  const after = change.after ? summarizeActualState(change.after, change.category, knownBindings) : '';
  if (change.action === 'refine') return `调整${categoryName}：${before} → ${after}`.slice(0, 2000);
  if (change.action === 'update') return `更新${categoryName}：${before} → ${after}`.slice(0, 2000);
  if (change.action === 'remove') return `移除${categoryName}：${before}`.slice(0, 2000);
  return `新增${categoryName}：${after}`.slice(0, 2000);
}

export function deriveCseTimeline(stateDeltas = []) {
  const subjects = new Map(), timeline = [];
  for (const delta of stateDeltas) {
    const changes = [];
    for (const snapshot of delta.subjectSnapshots) {
      const before = subjects.get(snapshot.subjectEntityId) ?? EMPTY_CSE_SUBJECT;
      const after = applyDeltaSnapshot(subjects, delta, snapshot);
      const audits = (delta.source?.calibrationAudit ?? []).filter(entry => entry.subjectEntityId === snapshot.subjectEntityId);
      const items = CSE_STATE_CATEGORIES.flatMap(category => categoryChanges({ before: before[category] ?? [], after: after[category] ?? [], category, audits: audits.filter(entry => entry.category === category) }));
      if (items.length) changes.push(Object.freeze({ subjectEntityId: snapshot.subjectEntityId, items: Object.freeze(items.map(item => Object.freeze(item))) }));
    }
    const endStateSubjects = [...subjects.values()].map(subject => Object.freeze({ subjectEntityId: subject.subjectEntityId, core: Object.freeze([...(subject.core ?? [])]), adaptive: Object.freeze([...(subject.adaptive ?? [])]), situational: Object.freeze([...(subject.situational ?? [])]) }));
    timeline.push(Object.freeze({ deltaId: delta.id, floorId: delta.floorId, noMaterialChange: changes.length === 0, changes: Object.freeze(changes), endStateSubjects: Object.freeze(endStateSubjects), isolationSummary: delta.source?.isolationSummary ? Object.freeze({ count: delta.source.isolationSummary.count, codes: Object.freeze([...delta.source.isolationSummary.codes]) }) : null }));
  }
  return Object.freeze(timeline);
}

export async function replayCurrentState({ chatId, narrativeGeneration, baselineId, floors = [], floorMemories = [], stateDeltas = [], now, id = null, previousId = null }) {
  const deltas = filterReachableDeltas({ floors, floorMemories, stateDeltas });
  const subjects = new Map();
  for (const delta of deltas) for (const snapshot of delta.subjectSnapshots) applyDeltaSnapshot(subjects, delta, snapshot);
  const subjectList = [...subjects.values()];
  const appliedDeltaIds = deltas.map(delta => delta.id);
  const headFloorId = deltas.at(-1)?.floorId ?? null;
  const fingerprint = await stateFingerprint(subjectList, appliedDeltaIds, headFloorId);
  const recordId = id ?? await deterministicUuid(['v3-cse-current-state', chatId, narrativeGeneration, fingerprint]);
  return validateCurrentStateRecord({ schemaVersion: 3, recordType: 'currentState', id: recordId, chatId, narrativeGeneration, baselineId, subjects: subjectList, appliedDeltaIds, headFloorId, fingerprint, createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: previousId }, { expectedChatId: chatId });
}
