import { newIdentityUuid, sha256 } from '../identity.js';
import { buildFoundationIndexes } from './foundation-runtime.js';
import { createCheckpointInputFingerprints, deterministicUuid } from './foundation-domain.js';
import { validateFoundationCheckpoint, validateFoundationRoot, validateFoundationRun, V3_INDEX_LAYOUT_FLOOR_ORDER } from './foundation-schema.js';
import { validateCseGraph } from './cse-schema.js';
import { diagnosticsWithRealtimeOrigin, realtimeOriginFromReachable } from './memory-coverage.js';
import {
  CSE_COMPILER_VERSION, CSE_PROMPT_VERSION, buildCseSystemPrompt, captureCseBaseline, createBaselineRoleEntities, cseReferencedEntityIds,
  createCseEnvelope, createManualCseCorrection, deriveCseTimeline, filterReachableDeltas, replayCurrentState, runCseRequest, selectTrackedSubjects, verifyCseBaselineFingerprint,
} from './cse-engine.js';
import { sanitizeDiagnosticValue, sanitizeSensitiveText } from './safe-metadata.js';
import {
  buildEntityIdentityDirectory, deriveUserIdentityProjection, entitiesThroughFloorIds, identityLabelKey, normalizeIdentityProjection, reuseIdentityProjection,
  projectCseStateIdentityReferences, projectFloorMemoryIdentityReferences, resolveIdentityEntityId,
} from './entity-identity.js';
import { captureCseRequestSources } from '../cse-source-selection.js';
import { PREQUEL_METADATA_KEY, selectPrequel } from './recall-prequel.js';
import { memorySourceFloorIds, validateEntityRecord } from './memory-schema.js';
import { floorProvenanceForReachable, migrationPartition } from './migration-prefix.js';

const emptyManifest = () => ({ floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] });
const PHASE_A_PERSIST_CONCURRENCY = 6;
const nowIso = now => { const value = now()?.toISOString?.() ?? String(now()); if (!Number.isFinite(Date.parse(value))) throw new TypeError('V3_CSE_TIME_INVALID'); return value; };
const hash = async value => `sha256:${await sha256(JSON.stringify(value))}`;
const errorWith = (code, message) => { const error = new Error(message ?? code); error.code = code; return error; };

const coreMeaning = items => JSON.stringify((items ?? []).map(item => [item.text, item.visibility, item.towardEntityId ?? null]));
const effectiveMemorySummary = memory => memory?.summary?.effectiveSource === 'user' ? memory.summary.userText : memory?.summary?.aiText;
const archivedStoryClockSignature = (value, floorId) => value?.floorMemories?.find(item => item.floorId === floorId && item.recordStatus === 'active')?.sourceStoryClockSignature
  ?? floorProvenanceForReachable(value)[floorId]?.storyClockSignature ?? '';

export function selectUserAdaptiveHistory({ floors = [], floorMemories = [], targetIndex, userEntityId, identityProjection = {} }) {
  const canonicalUserId = resolveIdentityEntityId(userEntityId, identityProjection);
  const memoryByFloor = new Map(floorMemories.filter(memory => memory.recordStatus === 'active').map(memory => [memory.floorId, memory]));
  const candidates = [];
  for (let index = 0; index < Math.min(floors.length, Number(targetIndex) || 0); index += 1) {
    const floor = floors[index], memory = memoryByFloor.get(floor.id);
    if (!memory) continue;
    const isUser = id => Boolean(canonicalUserId) && resolveIdentityEntityId(id, identityProjection) === canonicalUserId;
    const hasUserSignal = memory.actions?.some(item => isUser(item.actorEntityId))
      || memory.privateCognition?.some(item => isUser(item.ownerEntityId))
      || memory.informationTransfers?.some(item => isUser(item.fromEntityId))
      || memory.commitments?.some(item => isUser(item.speakerEntityId))
      || memory.cseSignals?.some(item => isUser(item.subjectEntityId));
    if (!hasUserSignal) continue;
    const snapshot = memory.sourceFloorSnapshots?.find(item => item.floorId === floor.id);
    const sourceFloorIds = memorySourceFloorIds(memory);
    const content = typeof snapshot?.canonicalContent === 'string' && snapshot.canonicalContent.trim()
      ? snapshot.canonicalContent
      : sourceFloorIds.length === 1 && sourceFloorIds[0] === floor.id
        ? (typeof memory.sourceCanonicalContent === 'string' && memory.sourceCanonicalContent.trim()
          ? memory.sourceCanonicalContent : floor.content?.canonicalContent)
        : null;
    if (typeof content === 'string' && content.trim()) candidates.push({ floorId: floor.id, assistantSeq: floor.assistantSeq, content, index, ordinal: candidates.length });
  }
  const selected = [];
  let used = 0;
  const add = candidate => {
    if (!candidate || selected.length >= 3 || used + candidate.content.length > 6000) return false;
    selected.push(candidate); used += candidate.content.length; return true;
  };
  for (let index = candidates.length - 1; index >= 0; index -= 1) if (add(candidates[index])) break;
  for (const candidate of candidates) if (!selected.includes(candidate) && add(candidate)) break;
  const midpoint = (candidates.length - 1) / 2;
  let middle = null, middleDistance = Infinity;
  for (const candidate of candidates) {
    if (selected.includes(candidate) || used + candidate.content.length > 6000) continue;
    const distance = Math.abs(candidate.ordinal - midpoint);
    if (distance < middleDistance) { middle = candidate; middleDistance = distance; }
  }
  if (middle) add(middle);
  return selected.sort((left, right) => left.index - right.index).map(({ floorId, assistantSeq, content }) => ({ floorId, assistantSeq, content }));
}

function currentUserInputFromMemory(memory) {
  const messages = Array.isArray(memory?.sourceFloorSnapshots)
    ? memory.sourceFloorSnapshots.flatMap(snapshot => snapshot?.sourceUserInputSnapshot?.messages ?? [])
    : memory?.sourceUserInputSnapshot?.messages;
  if (!Array.isArray(messages) || !messages.length) return null;
  return Object.freeze({ messages: Object.freeze(messages.map((message, sourceSnapshotIndex) => Object.freeze({ sourceSnapshotIndex, messageIndex: message.messageIndex, content: message.content }))) });
}

async function dependencySnapshot(value, floorId, entities, previousState, coreUserEditedSubjectEntityIds = [], identityProjection = {}, identityBriefTargetIds = []) {
  const targetIndex = value?.floors?.findIndex(floor => floor.id === floorId) ?? -1;
  if (targetIndex < 0 || !value?.baseline) return null;
  const floors = value.floors.slice(0, targetIndex + 1);
  const floorIds = new Set(floors.map(floor => floor.id));
  const activeMemoryIdsByFloor = new Map();
  const firstActiveMemoryByFloor = new Map();
  for (const memory of value.floorMemories ?? []) {
    if (memory.recordStatus !== 'active') continue;
    const ids = activeMemoryIdsByFloor.get(memory.floorId) ?? [];
    ids.push(memory.id);
    activeMemoryIdsByFloor.set(memory.floorId, ids);
    if (!firstActiveMemoryByFloor.has(memory.floorId)) firstActiveMemoryByFloor.set(memory.floorId, memory);
  }
  const activeMemoryIds = floors.map(floor => [...(activeMemoryIdsByFloor.get(floor.id) ?? [])].sort());
  let fallbackProvenance = null;
  const storyClockSignatureForFloor = floor => {
    const memorySignature = firstActiveMemoryByFloor.get(floor.id)?.sourceStoryClockSignature;
    if (memorySignature !== null && memorySignature !== undefined) return memorySignature;
    fallbackProvenance ??= floorProvenanceForReachable(value);
    return fallbackProvenance[floor.id]?.storyClockSignature ?? '';
  };
  const deltas = filterReachableDeltas({ floors: value.floors, floorMemories: value.floorMemories ?? [], stateDeltas: value.stateDeltas ?? [] });
  const deltaByFloor = new Map(deltas.map(delta => [delta.floorId, delta.id]));
  const identityBriefTargets = new Set(identityBriefTargetIds);
  const floorOrder = new Map(floors.map((floor, index) => [floor.id, index]));
  const identityDirectory = buildEntityIdentityDirectory({ entities, floorIds, floorOrder, identityProjection }).map(entry => ({
    entityId: entry.entityId,
    entityType: entry.entityType,
    specialRole: entry.specialRole,
    displayName: entry.displayName,
    identityBrief: identityBriefTargets.has(entry.entityId) ? entry.identityBrief ?? null : null,
    identityBriefSource: identityBriefTargets.has(entry.entityId) ? entry.identityBriefSource ?? null : null,
    labels: [...entry.labels].map(label => [identityLabelKey(label), label]).sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1])),
  })).sort((left, right) => left.entityId.localeCompare(right.entityId));
  return {
    chatId: value.root.chatId,
    narrativeGeneration: value.root.narrativeGeneration,
    baseline: { id: value.baseline.id, fingerprint: value.baseline.fingerprint },
    floors: floors.map(floor => ({ id: floor.id, rawFingerprint: floor.content.rawFingerprint, canonicalFingerprint: floor.content.canonicalFingerprint,
      storyClockSignature: storyClockSignatureForFloor(floor) })),
    activeMemoryIds,
    precedingDeltaIds: floors.slice(0, -1).map(floor => deltaByFloor.get(floor.id) ?? null),
    targetDeltaId: deltaByFloor.get(floorId) ?? null,
    previousStateFingerprint: previousState?.fingerprint ?? null,
    identityDirectory,
    identityProjection,
    coreUserEditedSubjectEntityIds: [...coreUserEditedSubjectEntityIds].sort(),
  };
}

const sameDependencySnapshot = (left, right) => Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));

export function createCseRuntime({ store, hostAdapter, generateAnalysisTask, isEnabled = true, promptGuidance = () => '', processingPrompt = () => '', filterWorldInfoSources = sources => sources, sanitizerOptions = () => ({}), onGraphCommitted = null, onFailureHint = null, commitGate = task => task(), captureBusinessIdentity = null, storeForIdentity = null, identityProjectionProvider = null, now = () => new Date(), newUuid = newIdentityUuid, logger = console } = {}) {
  if (!store || ['readReachable', 'putRecord', 'commitRoot', 'recordKey'].some(name => typeof store[name] !== 'function')) throw new TypeError('V3 CSE store 无效');
  if (typeof generateAnalysisTask !== 'function') throw new TypeError('V3 CSE analysis route 无效');
  if (typeof filterWorldInfoSources !== 'function') throw new TypeError('V3 CSE 世界书过滤器无效');
  let epoch = 0, active = null, reachable = null, replayed = null, lastFailure = null, replayDiagnostic = null;
  let identityProjection = normalizeIdentityProjection();
  let historyProjectionCache = null;
  const subscribers = new Set();
  const enabled = () => { try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; } catch { return false; } };
  const notify = () => { const state = getState(); for (const listener of subscribers) { try { listener(state); } catch { /* listener isolation */ } } return state; };
  const setIdentityProjection = value => {
    const next = reuseIdentityProjection(identityProjection, deriveUserIdentityProjection({ ...reachable, identityProjection: value }));
    if (next === identityProjection) return getState();
    identityProjection = next;
    return notify();
  };
  const storeForTarget = identityValue => identityValue && typeof storeForIdentity === 'function' ? storeForIdentity(identityValue)
    : identityValue && typeof store?.forIdentity === 'function' ? store.forIdentity(identityValue) : store;
  const captureTargetIdentity = () => { try { return typeof captureBusinessIdentity === 'function' ? captureBusinessIdentity() : null; } catch { return null; } };
  const currentIdentityProjection = () => identityProjection;
  const readTargetReachable = async (targetStore, targetIdentity) => {
    if (reachable?.root && (!targetIdentity || reachable.root.chatId === targetIdentity.chatId) && typeof targetStore.readRoot === 'function') {
      const rootResult = await targetStore.readRoot();
      if (sameReachableRoot(reachable, rootResult)) return reachable;
    }
    return targetStore.readReachable({ mode: 'runtime' });
  };
  const capturedHostAdapter = (targetIdentity, floorHint = null) => {
    const current = hostAdapter.snapshot();
    const captureMessage = message => {
      if (!message || typeof message !== 'object') return message;
      const copy = { ...(Object.hasOwn(message, 'is_user') ? { is_user: message.is_user } : {}),
        ...(Object.hasOwn(message, 'is_system') ? { is_system: message.is_system } : {}),
        ...(message.extra?.type ? { extra: { type: message.extra.type } } : {}) };
      const selectedIndex = Number.isSafeInteger(message.swipe_id) ? message.swipe_id : 0;
      const selected = Array.isArray(message.swipes) ? message.swipes[selectedIndex] : message.mes;
      if (typeof selected === 'string') { copy.mes = selected; copy.swipes = [selected]; copy.swipe_id = 0; }
      return Object.freeze(copy);
    };
    const chat = new Array(current.chat?.length ?? 0);
    if (Number.isSafeInteger(floorHint?.hostLocator?.messageIndex)) {
      let assistantCount = 0;
      for (let index = floorHint.hostLocator.messageIndex; index >= 0 && assistantCount < 2; index -= 1) {
        const message = current.chat?.[index];
        if (!message || typeof message !== 'object') continue;
        chat[index] = captureMessage(message);
        if (message.is_user === false && message.extra?.type !== 'narrator' && !(message.is_system === true && message.extra?.type)) {
          assistantCount += 1;
          const previous = current.chat?.[index - 1];
          if (previous?.is_user === true) chat[index - 1] = captureMessage(previous);
        }
      }
    } else {
      for (let index = 0; index < (current.chat?.length ?? 0); index += 1) chat[index] = captureMessage(current.chat[index]);
    }
    const sourceContext = current.context ?? {};
    const chatMetadata = {};
    for (const key of ['world_info', 'note_prompt', PREQUEL_METADATA_KEY]) {
      if (Object.hasOwn(sourceContext.chatMetadata ?? {}, key)) chatMetadata[key] = sourceContext.chatMetadata[key];
    }
    const qianqianjie = sourceContext.chatMetadata?.qianqianjie;
    if (qianqianjie && typeof qianqianjie === 'object') chatMetadata.qianqianjie = Object.freeze({ ...qianqianjie });
    else if (targetIdentity?.chatId) chatMetadata.qianqianjie = Object.freeze({ chatId: targetIdentity.chatId });
    const characterId = sourceContext.characterId;
    const sourceCharacter = Array.isArray(sourceContext.characters) ? sourceContext.characters[characterId] : sourceContext.characters?.[characterId];
    const copyCharacterBook = book => book && typeof book === 'object' ? { name: book.name,
      entries: Array.isArray(book.entries) ? book.entries.map(entry => ({ ...entry, extensions: entry?.extensions ? { ...entry.extensions } : undefined })) : book.entries } : book;
    const character = sourceCharacter ? { name: sourceCharacter.name, avatar: sourceCharacter.avatar,
      description: sourceCharacter.description, personality: sourceCharacter.personality, scenario: sourceCharacter.scenario,
      ...(sourceCharacter.extensions ? { extensions: { world: sourceCharacter.extensions.world } } : {}),
      ...(sourceCharacter.data ? { data: { name: sourceCharacter.data.name, avatar: sourceCharacter.data.avatar,
        description: sourceCharacter.data.description, personality: sourceCharacter.data.personality, scenario: sourceCharacter.data.scenario,
        ...(sourceCharacter.data.extensions ? { extensions: { world: sourceCharacter.data.extensions.world } } : {}),
        ...(sourceCharacter.data.character_book ? { character_book: copyCharacterBook(sourceCharacter.data.character_book) } : {}) } } : {}) } : null;
    const characters = Array.isArray(sourceContext.characters) ? [] : {};
    if (character) characters[characterId] = character;
    const bound = name => typeof sourceContext[name] === 'function' ? sourceContext[name].bind(sourceContext) : undefined;
    const worldInfo = sourceContext.chatWorldInfo;
    const worldInfoNames = worldInfo?.getNames?.(), globalSelection = worldInfo?.globalSelection;
    const context = Object.freeze({ chat, chatId: current.chatId, chatMetadata: Object.freeze(chatMetadata), characterId,
      characters: Object.freeze(characters), powerUserSettings: Object.freeze({ persona_description: sourceContext.powerUserSettings?.persona_description,
        persona_description_lorebook: sourceContext.powerUserSettings?.persona_description_lorebook }),
      personaDescription: sourceContext.personaDescription, persona: sourceContext.persona ? Object.freeze({ description: sourceContext.persona.description }) : null,
      extensionSettings: Object.freeze({ note: sourceContext.extensionSettings?.note ? Object.freeze({ ...sourceContext.extensionSettings.note,
        chara: Array.isArray(sourceContext.extensionSettings.note.chara) ? sourceContext.extensionSettings.note.chara.map(item => item && typeof item === 'object' ? Object.freeze({ ...item }) : item) : sourceContext.extensionSettings.note.chara }) : undefined }),
      chatWorldInfo: Object.freeze({ ...(Array.isArray(worldInfoNames) ? { getNames: () => [...worldInfoNames] } : {}),
        ...(Array.isArray(globalSelection) ? { globalSelection: [...globalSelection] } : {}) }),
      ...Object.fromEntries(['getCharaFilename', 'getCharaAuxWorlds', 'getWorldInfoNames', 'updateWorldInfoList', 'loadWorldInfo', 'loadWorldInfoBatch']
        .map(name => [name, bound(name)]).filter(([, value]) => value)),
    });
    const snapshot = Object.freeze({ chat, context, chatId: current.chatId,
      userIdentity: Object.freeze({ ...(current.userIdentity ?? {}), personaIdentifier: current.userIdentity?.personaIdentifier ?? targetIdentity?.personaLocator ?? '' }) });
    const bindings = Object.freeze({ ...(hostAdapter.getWorldInfoBindings?.() ?? {}) });
    return Object.freeze({ snapshot: () => snapshot, getWorldInfoBindings: () => bindings });
  };
  const publishFailureHint = (value, floorId, failure) => { try { onFailureHint?.(value, floorId, failure); } catch { /* optional failure hints must not affect CSE */ } };

  async function coreUserEditedSubjects(deltas, targetStore = store, operationCache = null) {
    const protectedIds = new Set();
    const cache = operationCache ?? new Map();
    for (const delta of deltas) cache.set(delta.id, delta);
    for (const activeDelta of deltas) {
      for (const subjectId of activeDelta.source?.manualCoreSubjectEntityIds ?? []) protectedIds.add(subjectId);
      for (const audit of activeDelta.source?.calibrationAudit ?? []) {
        if (audit.category === 'core' && audit.evidence?.some(evidence => evidence.source === 'currentUserInput')) protectedIds.add(audit.subjectEntityId);
      }
      let delta = activeDelta;
      const visited = new Set();
      while (delta?.source?.manualSubjectEntityIds?.length && !visited.has(delta.id)) {
        visited.add(delta.id);
        let anchor = delta.supersedes ? cache.get(delta.supersedes) : null;
        if (!anchor && delta.supersedes && typeof targetStore.readRecord === 'function') {
          const read = await targetStore.readRecord('stateDelta', delta.supersedes);
          if (read.status === 'ready') { anchor = read.data; cache.set(anchor.id, anchor); }
        }
        for (const subjectId of delta.source.manualSubjectEntityIds) {
          const currentSubject = delta.subjectSnapshots.find(subject => subject.subjectEntityId === subjectId);
          const anchorSubject = anchor?.subjectSnapshots?.find(subject => subject.subjectEntityId === subjectId);
          const fixedCoreChanged = Object.hasOwn(delta, 'fixedChanges')
            && delta.fixedChanges.some(subject => subject.subjectEntityId === subjectId && subject.items.some(item => item.category === 'core'));
          if (currentSubject?.core?.some(item => item.origin === 'manual')
            || fixedCoreChanged
            || (!Object.hasOwn(delta, 'fixedChanges') && anchorSubject && coreMeaning(currentSubject?.core) !== coreMeaning(anchorSubject.core))) protectedIds.add(subjectId);
        }
        delta = anchor;
      }
    }
    return [...protectedIds];
  }

  async function calculateReplay(value) {
    const expectedEpoch = epoch;
    if (!value?.baseline) {
      replayed = null; replayDiagnostic = null; return true;
    }
    const stored = value.currentStates?.at(-1) ?? null;
    const rebuilt = await replayCurrentState({ chatId: value.root.chatId, narrativeGeneration: value.root.narrativeGeneration, baselineId: value.baseline.id, floors: value.floors, floorMemories: value.floorMemories, stateDeltas: value.stateDeltas, now: nowIso(now) });
    if (expectedEpoch !== epoch || reachable !== value) return false;
    replayed = stored?.fingerprint === rebuilt.fingerprint ? stored : rebuilt;
    replayDiagnostic = stored && stored.fingerprint !== rebuilt.fingerprint
      ? { code: 'V3_CSE_REPLAY_MISMATCH', message: '已存当前状态与可信增量重放不一致；界面已采用本地重放结果。', storedId: stored.id, replayFingerprint: rebuilt.fingerprint }
      : null;
    return true;
  }

  const sameReachableRoot = (value, rootResult) => rootResult?.status === 'ready'
    && rootResult.revision === value?.rootRevision
    && rootResult.data?.chatId === value?.root?.chatId
    && rootResult.data?.headCheckpointId === value?.root?.headCheckpointId
    && rootResult.data?.narrativeGeneration === value?.root?.narrativeGeneration
    && rootResult.data?.sourceSnapshotFingerprint === value?.root?.sourceSnapshotFingerprint;

  async function load(providedReachable = null) {
    const expectedEpoch = epoch;
    let value = providedReachable;
    if (!value && reachable && typeof store.readRoot === 'function') {
      const rootResult = await store.readRoot();
      if (expectedEpoch !== epoch) return getState();
      if (sameReachableRoot(reachable, rootResult)) value = reachable;
    }
    value ??= await store.readReachable({ mode: 'runtime' });
    if (expectedEpoch !== epoch) return getState();
    if (!['ready', 'needsReseal'].includes(value.status)) {
      if (value.status === 'uninitialized') { reachable = null; replayed = null; return notify(); }
      throw errorWith('V3_CSE_LOAD_FAILED', '人物状态读取失败，请刷新状态后重试。');
    }
    if (reachable?.root?.chatId === value.root.chatId && reachable.rootRevision > value.rootRevision) return getState();
    reachable = value;
    identityProjection = reuseIdentityProjection(identityProjection, deriveUserIdentityProjection({ ...value, identityProjection }));
    if (!await calculateReplay(value)) return getState();
    return notify();
  }

  function getState() {
    const floors = reachable?.floors ?? [];
    const projectedState = projectCseStateIdentityReferences(replayed, identityProjection);
    const entities = new Map(buildEntityIdentityDirectory({ entities: reachable?.entities ?? [], identityProjection })
      .map(entry => [entry.entityId, entry.entity]));
    const memoryByFloor = new Map((reachable?.floorMemories ?? []).filter(memory => memory.recordStatus === 'active').map(memory => [memory.floorId, memory]));
    if (historyProjectionCache?.reachable !== reachable || historyProjectionCache?.identityProjection !== identityProjection) {
      const reachableDeltas = filterReachableDeltas({ floors, floorMemories: reachable?.floorMemories ?? [], stateDeltas: reachable?.stateDeltas ?? [] });
      const deltaByFloor = new Map(reachableDeltas.map(delta => [delta.floorId, delta]));
      const timelineByFloor = new Map(deriveCseTimeline(reachableDeltas).map(item => [item.floorId, item]));
      const floorSeq = new Map(floors.map(floor => [floor.id, floor.assistantSeq]));
      const historyItem = item => item ? Object.freeze({
        text: item.text,
        visibility: item.visibility,
        reason: item.reason,
        origin: item.origin,
        towardEntityId: item.towardEntityId ? resolveIdentityEntityId(item.towardEntityId, identityProjection) : null,
        towardDisplayName: entities.get(resolveIdentityEntityId(item.towardEntityId, identityProjection))?.displayName ?? null,
        sourceFloorId: item.sourceFloorId ?? null,
        sourceAssistantSeq: floorSeq.get(item.sourceFloorId) ?? null,
      }) : null;
      const groupedTimelineSubjects = subjects => {
        const grouped = new Map();
        for (const subject of subjects ?? []) {
          const subjectEntityId = resolveIdentityEntityId(subject.subjectEntityId, identityProjection);
          const current = grouped.get(subjectEntityId) ?? { subjectEntityId, items: [] };
          current.items.push(...(subject.items ?? [])); grouped.set(subjectEntityId, current);
        }
        return [...grouped.values()];
      };
      const recordByFloor = new Map();
      for (const floor of floors) {
        const delta = deltaByFloor.get(floor.id), timeline = timelineByFloor.get(floor.id);
        if (!delta) continue;
        recordByFloor.set(floor.id, Object.freeze({
          fixedChangesAvailable: Object.hasOwn(delta, 'fixedChanges'),
          noMaterialChange: timeline?.noMaterialChange ?? true,
          isolationSummary: timeline?.isolationSummary ?? null,
          subjects: Object.freeze(groupedTimelineSubjects(timeline?.changes).map(subject => Object.freeze({
            subjectEntityId: subject.subjectEntityId,
            displayName: entities.get(subject.subjectEntityId)?.displayName ?? '未知人物',
            changes: Object.freeze(subject.items.map(item => Object.freeze({
              category: item.category,
              action: item.action,
              beforeText: item.before?.text ?? null,
              afterText: item.after?.text ?? null,
              before: historyItem(item.before),
              after: historyItem(item.after),
            }))),
          }))),
          endStateSubjects: Object.freeze((projectCseStateIdentityReferences({ subjects: timeline?.endStateSubjects ?? [] }, identityProjection)?.subjects ?? []).filter(subject => ['core', 'adaptive', 'situational'].some(category => subject[category]?.length)).map(subject => Object.freeze({
            subjectEntityId: subject.subjectEntityId,
            displayName: entities.get(subject.subjectEntityId)?.displayName ?? '未知人物',
            core: Object.freeze((subject.core ?? []).map(historyItem)),
            adaptive: Object.freeze((subject.adaptive ?? []).map(historyItem)),
            situational: Object.freeze((subject.situational ?? []).map(historyItem)),
          }))),
        }));
      }
      // Cache only immutable historical records; live status and the mutable current-state projection stay fresh per read.
      historyProjectionCache = { reachable, identityProjection, deltaByFloor, recordByFloor, reachableDeltas, floorSeq };
    }
    const { deltaByFloor, recordByFloor, reachableDeltas, floorSeq } = historyProjectionCache;
    const cseFloors = floors.map(floor => {
      const memory = memoryByFloor.get(floor.id), delta = deltaByFloor.get(floor.id), record = recordByFloor.get(floor.id) ?? null;
      const running = active?.floorId === floor.id;
      const failure = lastFailure?.floorId === floor.id ? lastFailure : null;
      const status = running ? 'running' : delta ? ((record?.noMaterialChange ?? true) ? 'noChange' : 'ready') : !memory ? 'notApplicable' : failure ? 'failed' : 'pending';
      return Object.freeze({ floorId: floor.id, floorMemoryId: delta?.floorMemoryId ?? memory?.id ?? null, status, deltaId: delta?.id ?? null, noMaterialChange: record?.noMaterialChange ?? false, record, error: failure?.message ?? null });
    });
    const subjects = (projectedState?.subjects ?? []).map(subject => ({
      subjectEntityId: subject.subjectEntityId,
      displayName: entities.get(subject.subjectEntityId)?.displayName ?? (subject.subjectEntityId === reachable?.baseline?.userPersona?.entityId ? reachable.baseline.userPersona.name : reachable?.baseline?.characterCard?.name) ?? '未知人物',
      core: subject.core.map(item => ({ ...item, sourceAssistantSeq: floorSeq.get(item.sourceFloorId) ?? null })),
      adaptive: subject.adaptive.map(item => ({ ...item, towardDisplayName: entities.get(item.towardEntityId)?.displayName ?? null, sourceAssistantSeq: floorSeq.get(item.sourceFloorId) ?? null })),
      situational: subject.situational.map(item => ({ ...item, towardDisplayName: entities.get(item.towardEntityId)?.displayName ?? null, sourceAssistantSeq: floorSeq.get(item.sourceFloorId) ?? null })),
    }));
    const pendingCount = cseFloors.filter(item => item.status === 'pending').length;
    const mainCharacterEntityId = resolveIdentityEntityId(reachable?.baseline?.characterCard?.entityId, identityProjection) ?? null;
    const mainCharacterDisplayName = mainCharacterEntityId
      ? entities.get(mainCharacterEntityId)?.displayName ?? reachable?.baseline?.characterCard?.name ?? null
      : null;
    const anchorFloorIndex = floors.findIndex(floor => floor.id === reachableDeltas.at(-1)?.floorId);
    const anchorFloorIds = new Set(floors.slice(0, anchorFloorIndex + 1).map(floor => floor.id));
    const cseTowardCandidates = buildEntityIdentityDirectory({ entities: reachable?.entities ?? [], floorIds: anchorFloorIds, identityProjection })
      .filter(entry => entry.entityType === 'person')
      .map(entry => Object.freeze({ entityId: entry.entityId, displayName: entry.displayName }));
    return Object.freeze({ cseReady: reachable?.root?.capabilities?.cseReady === true, baselineId: reachable?.baseline?.id ?? null, mainCharacterEntityId, mainCharacterDisplayName, currentStateId: replayed?.id ?? null, currentStateFingerprint: replayed?.fingerprint ?? null, replayedCurrentState: projectedState, cseTowardCandidates: Object.freeze(cseTowardCandidates), cseSubjects: Object.freeze(subjects), cseFloors: Object.freeze(cseFloors), csePendingCount: pendingCount, cseFailedCount: cseFloors.filter(item => item.status === 'failed').length, activeCse: active ? { floorId: active.floorId, runId: active.runId, phase: active.phase } : null, lastCseError: lastFailure, cseReplayDiagnostic: replayDiagnostic, csePromptVersion: CSE_PROMPT_VERSION, cseCompilerVersion: CSE_COMPILER_VERSION });
  }

  function getActivityState() {
    return Object.freeze({ activeCse: active ? Object.freeze({ floorId: active.floorId, runId: active.runId, phase: active.phase }) : null });
  }

  // Dollars asks for a few actors at a time; avoid constructing the full CSE UI projection.
  function getCurrentSubjectStates(entityIds = []) {
    if (!reachable?.root || !replayed || !Array.isArray(entityIds) || !entityIds.length) return { status: 'not-ready', subjects: [] };
    const requested = new Set(entityIds.map(id => resolveIdentityEntityId(id, identityProjection)).filter(Boolean));
    if (!requested.size) return { status: 'ready', subjects: [] };
    const directory = buildEntityIdentityDirectory({ entities: reachable.entities ?? [], identityProjection });
    const activeIds = new Set(directory.filter(entry => entry.entityType === 'person').map(entry => entry.entityId));
    const subjects = (replayed.subjects ?? []).filter(subject => {
      const id = resolveIdentityEntityId(subject.subjectEntityId, identityProjection);
      return requested.has(id) && activeIds.has(id);
    });
    const projected = projectCseStateIdentityReferences({ ...replayed, subjects }, identityProjection);
    const names = new Map(directory.map(entry => [entry.entityId, entry.displayName]));
    return { status: 'ready', subjects: (projected?.subjects ?? []).map(subject => ({
      subjectEntityId: subject.subjectEntityId,
      displayName: names.get(subject.subjectEntityId) ?? '未知人物',
      core: (subject.core ?? []).map(item => ({ ...item })),
      adaptive: (subject.adaptive ?? []).map(item => ({ ...item })),
      situational: (subject.situational ?? []).map(item => ({ ...item })),
    })) };
  }

  async function persist(records, signal, targetStore = store) {
    for (const record of records) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await targetStore.putRecord(record, { signal });
      if (!['saved', 'reused'].includes(result.status)) throw errorWith('V3_CSE_PERSIST_FAILED', '无法确认人物状态记录已保存。');
    }
  }

  async function persistPhaseA(records, signal, targetStore = store) {
    let cursor = 0;
    let firstError = null;
    async function worker() {
      while (firstError === null) {
        const index = cursor;
        if (index >= records.length) return;
        cursor += 1;
        try {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const result = await targetStore.putRecord(records[index], { signal });
          if (!['saved', 'reused'].includes(result.status)) throw errorWith('V3_CSE_PERSIST_FAILED', '无法确认人物状态记录已保存。');
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PHASE_A_PERSIST_CONCURRENCY, records.length) }, () => worker()));
    if (firstError) throw firstError;
  }

  async function ensureBaseline(value, operation) {
    if (value.baseline) return value;
    const targetStore = operation.store ?? store;
    return commitGate(async () => {
    const latest = await targetStore.readReachable({ mode: 'runtime' });
    if ((!operation.pinnedTarget && operation.epoch !== epoch) || operation.controller.signal.aborted || latest.status !== 'ready' || latest.root.chatId !== value.root.chatId || latest.root.narrativeGeneration !== value.root.narrativeGeneration) throw errorWith('V3_CSE_STALE', '人物状态资料已变化，请刷新状态后重新分析。');
    value = latest;
    if (value.baseline) return value;
    const created = await captureCseBaseline({ hostAdapter: operation.hostAdapter, chatId: value.root.chatId, narrativeGeneration: value.root.narrativeGeneration, entities: value.entities, sanitizerOptions: operation.sanitizerOptions, now: operation.startedAt });
    const saved = await targetStore.putRecord(created.baseline, { signal: operation.controller.signal });
    let adopted = ['saved', 'reused'].includes(saved.status) ? saved.data : null;
    if (saved.status === 'conflict') {
      const orphan = await targetStore.readRecord('baseline', created.baseline.id);
      if (orphan.status === 'ready' && orphan.data.id === created.baseline.id && orphan.data.chatId === value.root.chatId && orphan.data.recordStatus === 'active' && await verifyCseBaselineFingerprint(orphan.data)) adopted = orphan.data;
    }
    if (!adopted || !await verifyCseBaselineFingerprint(adopted)) throw errorWith('V3_CSE_BASELINE_PERSIST_FAILED', '人物基础资料保存或校验失败，无法开始分析。');
    const root = validateFoundationRoot({ ...value.root, baselineId: adopted.id, updatedAt: operation.startedAt }, { expectedChatId: value.root.chatId });
    const committed = await targetStore.commitRoot(root, value.rootRevision, { signal: operation.controller.signal });
    if (committed.status !== 'saved') {
      const winner = await targetStore.readReachable({ mode: 'runtime' });
      if (winner.status === 'ready' && winner.baseline) return winner;
      if (committed.status === 'conflict') throw errorWith('V3_CSE_BASELINE_CAS_CONFLICT', '人物资料已更新，请刷新后重新分析。');
      throw errorWith('V3_CSE_BASELINE_COMMIT_FAILED', '无法确认人物基础资料已保存，请刷新状态后查看。');
    }
    const next = committed.reachable;
    if (next?.status !== 'ready' || next.rootRevision !== committed.revision || next.baseline?.id !== adopted.id) throw errorWith('V3_CSE_BASELINE_COLD_READ_FAILED', '人物基础资料已保存，但读取结果不完整，无法继续分析。');
    return next;
    });
  }

  async function commitDeltaGraph({ operation, current, floor, memory, delta, deltas, entities, diagnostics }) {
    const targetStore = operation.store ?? store;
    const partition = migrationPartition(current);
    const deltaByFloor = new Map(deltas.map(item => [item.floorId, item]));
    if (partition.frozenFloorIds.size) {
      const persistedDeltaByFloor = new Map(filterReachableDeltas({ floors: current.floors,
        floorMemories: current.floorMemories, stateDeltas: current.stateDeltas }).map(item => [item.floorId, item]));
      for (const frozenFloorId of partition.frozenFloorIds) {
        const persisted = persistedDeltaByFloor.get(frozenFloorId);
        if (persisted && deltaByFloor.get(frozenFloorId)?.id !== persisted.id) {
          throw errorWith('V3_MIGRATION_PREFIX_CHANGED', '迁移来源状态属于只读历史，未覆盖归档图。');
        }
      }
    }
    const nowValue = nowIso(now);
    const runId = operation.runId;
    const checkpointId = await deterministicUuid(['v3-cse-checkpoint', current.root.headCheckpointId, delta.id]);
    const indexes = await buildFoundationIndexes({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, checkpointId, floors: current.floors, candidates: current.floors.map(item => ({ hostLocator: item.hostLocator, rawFingerprint: item.content.rawFingerprint, canonicalFingerprint: item.content.canonicalFingerprint })), entities, now: nowValue });
    const indexKeys = indexes.map(index => targetStore.recordKey(index));
    const previousState = current.currentStates.at(-1) ?? null;
    const currentState = await replayCurrentState({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, baselineId: current.baseline.id, floors: current.floors, floorMemories: current.floorMemories, stateDeltas: deltas, now: nowValue, previousId: previousState?.id ?? null });
    const activeMemories = current.floorMemories.filter(item => item.recordStatus === 'active');
    const cseReady = activeMemories.length > 0 && activeMemories.every(item => deltas.some(itemDelta => itemDelta.floorId === item.floorId));
    const capabilities = { foundationReady: true, memoryReady: activeMemories.length > 0, cseReady, recallReady: false };
    const stateGraphFingerprint = await hash([current.root.narrativeGeneration, current.floors.map(item => item.id), current.floors.map(item => item.content.canonicalFingerprint)]);
    const run = validateFoundationRun({ schemaVersion: 3, recordType: 'run', id: runId, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, parentCheckpointId: current.root.headCheckpointId, inputSnapshotFingerprint: current.root.sourceSnapshotFingerprint, mode: 'cse', sessionEpoch: operation.epoch, inputFloorIds: [floor.id], phase: 'completed', completedFloorIds: [floor.id], failedItems: [], preparedRecordRefs: [targetStore.recordKey(delta), targetStore.recordKey(currentState), ...indexKeys, `v3-checkpoint-${checkpointId}`], diagnostics: { ...diagnosticsWithRealtimeOrigin(current.run?.diagnostics, realtimeOriginFromReachable(current)), ...diagnostics, floorId: floor.id, floorMemoryId: memory.id }, startedAt: operation.startedAt, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: current.root.chatId });
    const checkpoint = validateFoundationCheckpoint({ schemaVersion: 3, recordType: 'checkpoint', id: checkpointId, chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, parentCheckpointId: current.root.headCheckpointId, runId, sourceSnapshotFingerprint: current.root.sourceSnapshotFingerprint, indexLayout: V3_INDEX_LAYOUT_FLOOR_ORDER, capabilities, floorRange: { fromAssistantSeq: current.floors.length ? 1 : 0, toAssistantSeq: current.floors.length, floorIds: current.floors.map(item => item.id) }, inputFingerprints: createCheckpointInputFingerprints(current.floors, { previous: current.checkpoint?.inputFingerprints }), producedRefs: { floors: current.floors.map(item => item.id), floorMemories: current.floorMemories.map(item => item.id), entities: entities.map(item => item.id), events: [], claims: [], knowledge: [], stateDeltas: deltas.map(item => item.id), currentStates: [currentState.id], stateProjections: [], episodes: [], threads: [], indexes: indexKeys }, validation: { schemaValid: true, referencesValid: true, orderedReplayValid: true, stateFingerprint: stateGraphFingerprint }, sealedAt: nowValue, createdAt: nowValue, updatedAt: nowValue, recordStatus: 'active', supersedes: null }, { expectedChatId: current.root.chatId });
    const root = validateFoundationRoot({ ...current.root, capabilities, headCheckpointId: checkpointId, indexManifest: { ...emptyManifest(), floor: indexKeys.filter(key => key.includes('-floorOrder-') || key.includes('-fingerprint-')), entity: indexKeys.filter(key => key.includes('-entity-')), reverseRef: indexKeys.filter(key => key.includes('-reverseRef-')) }, activeStateRefs: [currentState.id], updatedAt: nowValue }, { expectedChatId: current.root.chatId });
    await validateCseGraph({ root, checkpoint, run, floors: current.floors, floorMemories: current.floorMemories, entities, indexes, indexKeys, baseline: current.baseline, stateDeltas: deltas, currentStates: [currentState] });
    const newEntities = entities.filter(entity => !current.entities.some(old => old.id === entity.id));
    await persistPhaseA([...newEntities, delta, currentState, ...indexes], operation.controller.signal, targetStore);
    await persist([run, checkpoint], operation.controller.signal, targetStore);
    if ((!operation.pinnedTarget && operation.epoch !== epoch) || operation.controller.signal.aborted) throw errorWith('V3_CSE_STALE', '人物状态分析已停止。');
    if (operation.userCoreExtraction && (hostAdapter.snapshot?.()?.userIdentity?.personaIdentifier ?? '') !== operation.userCoreExtraction.personaLocator) throw errorWith('V3_CSE_STALE', '当前用户身份资料已变化，人物状态结果未采用。');
    const committed = await targetStore.commitRoot(root, current.rootRevision, { signal: operation.controller.signal });
    if (committed.status === 'conflict') throw errorWith('V3_CSE_CAS_CONFLICT', '人物资料已更新，请刷新后重新分析。');
    if (committed.status !== 'saved') throw errorWith('V3_CSE_COMMIT_FAILED', '无法确认人物状态结果已保存，请刷新状态后查看。');
    if ((!operation.pinnedTarget && operation.epoch !== epoch) || operation.controller.signal.aborted) throw errorWith('V3_CSE_STALE', '人物状态分析已停止。');
    const next = committed.reachable;
    if (next?.status !== 'ready') throw errorWith('V3_CSE_COMMIT_SNAPSHOT_INVALID', '人物状态结果已提交，但读取结果不完整，无法确认当前状态。');
    operation.committedReachable = next;
    publishFailureHint(next, floor.id, null);
    if (reachable?.root?.chatId === next.root.chatId) {
      reachable = next;
      identityProjection = reuseIdentityProjection(identityProjection, operation.identityProjection ?? identityProjection);
      const replayCurrent = await calculateReplay(next);
      if (replayCurrent && reachable === next) { onGraphCommitted?.(next, identityProjection); lastFailure = null; }
    }
    return notify();
  }

  async function commitDelta(operation, result, roleEntities) {
    return commitGate(() => commitDeltaUnlocked(operation, result, roleEntities));
  }

  async function commitDeltaUnlocked(operation, result, roleEntities) {
    const targetStore = operation.store ?? store;
    let current = null;
    const targetChatId = operation.targetIdentity?.chatId ?? operation.sourceReachable?.root?.chatId;
    const cached = [reachable, operation.sourceReachable].filter(value => value?.root?.chatId
      && (!targetChatId || value.root.chatId === targetChatId)).sort((left, right) => right.rootRevision - left.rootRevision)[0];
    if (cached && typeof targetStore.readRoot === 'function') {
      const rootResult = await targetStore.readRoot();
      if (sameReachableRoot(cached, rootResult)) current = cached;
    }
    current ??= await targetStore.readReachable({ mode: 'runtime' });
    if (current.status !== 'ready' || (!operation.pinnedTarget && operation.epoch !== epoch) || operation.controller.signal.aborted) throw errorWith('V3_CSE_STALE', '相关人物状态资料已变化，请刷新后重新分析。');
    const floor = current.floors.find(item => item.id === operation.floorId);
    const memory = current.floorMemories.find(item => item.id === operation.floorMemoryId && item.floorId === operation.floorId && item.recordStatus === 'active');
    const memoryClockSignature = memory?.sourceStoryClockSignature ?? current.run?.diagnostics?.floorProvenance?.[floor?.id]?.storyClockSignature ?? '';
    if (!floor || !memory || !current.baseline || floor.content.canonicalFingerprint !== operation.floorFingerprint || floor.content.rawFingerprint !== operation.floorRawFingerprint || memoryClockSignature !== operation.storyClockSignature) throw errorWith('V3_CSE_STALE', '本楼正文、时间信息或摘要记录已变化，不能继续采用本次分析。');
    const dependencyEntitiesById = new Map(current.entities.map(entity => [entity.id, entity]));
    for (const entity of roleEntities) if (!dependencyEntitiesById.has(entity.id)) dependencyEntitiesById.set(entity.id, entity);
    const dependencyTargetIndex = current.floors.findIndex(item => item.id === operation.floorId);
    const dependencyPrecedingFloors = current.floors.slice(0, dependencyTargetIndex);
    const dependencyPrecedingIds = new Set(dependencyPrecedingFloors.map(item => item.id));
    const dependencyPrecedingMemories = current.floorMemories.filter(item => item.recordStatus === 'active' && dependencyPrecedingIds.has(item.floorId));
    const dependencyPrecedingDeltas = filterReachableDeltas({ floors: dependencyPrecedingFloors, floorMemories: dependencyPrecedingMemories, stateDeltas: current.stateDeltas });
    const dependencyPreviousState = dependencyPrecedingDeltas.length
      ? await replayCurrentState({ chatId: current.root.chatId, narrativeGeneration: current.root.narrativeGeneration, baselineId: current.baseline?.id, floors: dependencyPrecedingFloors, floorMemories: dependencyPrecedingMemories, stateDeltas: dependencyPrecedingDeltas, now: nowIso(now) })
      : null;
    const coreUserEditedSubjectEntityIds = [...new Set((await coreUserEditedSubjects(dependencyPrecedingDeltas, targetStore, operation.coreUserEditedSubjectReadCache))
      .map(id => resolveIdentityEntityId(id, operation.identityProjection)))];
    const currentDependency = await dependencySnapshot(current, operation.floorId, [...dependencyEntitiesById.values()], dependencyPreviousState, coreUserEditedSubjectEntityIds, operation.identityProjection, operation.identityBriefTargetIds);
    if (!sameDependencySnapshot(operation.dependencySnapshot, currentDependency)) throw errorWith('V3_CSE_STALE', '此前楼层、摘要或人物资料已变化，请刷新后重新分析。');

    const floorOrder = new Map(current.floors.map((item, index) => [item.id, index]));
    const deltas = filterReachableDeltas({ floors: current.floors, floorMemories: current.floorMemories, stateDeltas: current.stateDeltas })
      .filter(delta => delta.floorId !== floor.id);
    deltas.push(result.delta);
    deltas.sort((left, right) => floorOrder.get(left.floorId) - floorOrder.get(right.floorId));
    const entitiesById = new Map(current.entities.map(entity => [entity.id, entity]));
    for (const entity of roleEntities) if (!entitiesById.has(entity.id) && [current.baseline.userPersona.entityId, current.baseline.characterCard.entityId].includes(entity.id)) entitiesById.set(entity.id, entity);
    for (const update of result.identityBriefUpdates ?? []) {
      const target = entitiesById.get(update.entityId);
      if (!target || target.entityType !== 'person' || target.specialRole !== 'none' || typeof update.identityBrief !== 'string' || !update.identityBrief.trim()) continue;
      const entityId = await deterministicUuid(['v3-cse-entity-identity-update', target.id, floor.id, result.delta.id, update.identityBriefSource]);
      const identityBriefUpdatedAt = nowIso(now);
      const revision = validateEntityRecord({ schemaVersion: 3, recordType: 'entity', id: entityId, chatId: floor.chatId, narrativeGeneration: floor.narrativeGeneration,
        entityType: target.entityType, displayName: target.displayName, aliases: [], specialRole: target.specialRole,
        firstSeenFloorId: floor.id, lastSeenFloorId: floor.id, identityBrief: update.identityBrief, identityBriefSource: update.identityBriefSource,
        status: 'merged', mergedIntoEntityId: target.id, mergeEvidenceRefs: [], baselineClaimIds: [],
        createdAt: identityBriefUpdatedAt, updatedAt: identityBriefUpdatedAt, recordStatus: 'active', supersedes: null }, { expectedChatId: floor.chatId });
      if (!entitiesById.has(revision.id)) entitiesById.set(revision.id, revision);
    }
    const entities = [...entitiesById.values()];
    return commitDeltaGraph({ operation, current, floor, memory, delta: result.delta, deltas, entities, diagnostics: { kind: 'cse', promptVersion: CSE_PROMPT_VERSION, compilerVersion: CSE_COMPILER_VERSION, promptGuidanceFingerprint: operation.promptGuidanceFingerprint ?? null, systemPromptFingerprint: operation.systemPromptFingerprint ?? null, api: result.metadata, attempts: result.attempts, transportAttempts: result.transportAttempts, responseFingerprint: result.responseFingerprint, isolated: result.isolated.slice(-40), sourceSelection: operation.sourceDiagnostics ?? null, cseRebuild: operation.cseRebuild } });
  }

  async function analyzeFloor(floorId, options = {}) {
    const targetIdentity = options.targetIdentity ?? captureTargetIdentity(), targetStore = storeForTarget(targetIdentity);
    try { return await analyzeFloorWithStore(floorId, { ...options, targetIdentity }, targetStore); }
    finally { targetStore.release?.(); }
  }

  async function analyzeFloorWithStore(floorId, { cseRebuild = null, replaceExisting = false, targetIdentity = captureTargetIdentity() } = {}, targetStore) {
    if (!enabled()) return notify();
    if (active) return getState();
    const cachedFloor = reachable?.root?.chatId === targetIdentity?.chatId ? reachable.floors.find(item => item.id === floorId) : null;
    const operationHostAdapter = capturedHostAdapter(targetIdentity, cachedFloor);
    let value = await readTargetReachable(targetStore, targetIdentity);
    if (!['ready', 'needsReseal'].includes(value.status)) throw errorWith('V3_CSE_LOAD_FAILED', '人物状态读取失败，请刷新状态后重试。');
    if (migrationPartition(value).isFrozenFloor(floorId)) throw errorWith('V3_MIGRATION_FLOOR_READ_ONLY', '来源聊天的已迁移楼只读，不能重新分析状态。');
    const existing = filterReachableDeltas({ floors: value?.floors ?? [], floorMemories: value?.floorMemories ?? [], stateDeltas: value?.stateDeltas ?? [] })
      .find(delta => delta.floorId === floorId);
    if (existing && !replaceExisting && !cseRebuild) return notify();
    const floor = value?.floors?.find(item => item.id === floorId);
    const memory = value?.floorMemories?.find(item => item.floorId === floorId && item.recordStatus === 'active');
    if (!floor || !memory) throw errorWith('V3_CSE_FLOOR_UNAVAILABLE', '本楼记录或摘要不可用，无法分析人物状态。');
    const analysisFloor = memory.sourceCanonicalContent ? { ...floor, content: { ...floor.content, canonicalContent: memory.sourceCanonicalContent } } : floor;
    const sourceClockSignature = archivedStoryClockSignature(value, floorId);
    const operation = { floorId, floorMemoryId: memory.id, floorFingerprint: floor.content.canonicalFingerprint, floorRawFingerprint: floor.content.rawFingerprint, storyClockSignature: sourceClockSignature, cseRebuild: cseRebuild ? structuredClone(cseRebuild) : null,
      epoch, controller: new AbortController(), store: targetStore, targetIdentity, pinnedTarget: Boolean(targetIdentity), sourceReachable: value, hostAdapter: operationHostAdapter, coreUserEditedSubjectReadCache: new Map(),
      sanitizerOptions: typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions,
      runId: await deterministicUuid(['v3-cse-run', value.root.headCheckpointId, memory.id, newUuid()]), startedAt: nowIso(now), phase: 'baseline' };
    active = operation; notify();
    try {
      operation.identityProjection = normalizeIdentityProjection(typeof identityProjectionProvider === 'function'
        ? await identityProjectionProvider(targetIdentity) : currentIdentityProjection());
      value = await ensureBaseline(value, operation);
      operation.sourceReachable = value;
      operation.phase = 'analyzing'; notify();
      const roleEntities = await createBaselineRoleEntities(value.baseline);
      const entitiesById = new Map(value.entities.map(entity => [entity.id, entity]));
      for (const entity of roleEntities) if (!entitiesById.has(entity.id)) entitiesById.set(entity.id, entity);
      const entities = [...entitiesById.values()];
      operation.identityProjection = deriveUserIdentityProjection({ entities, baseline: value.baseline, identityProjection: operation.identityProjection });
      const identityProjection = operation.identityProjection;
      const targetIndex = value.floors.findIndex(item => item.id === floor.id);
      const precedingFloors = value.floors.slice(0, targetIndex);
      const precedingFloorIds = new Set(precedingFloors.map(item => item.id));
      const trackedFloorIds = new Set(value.floors.slice(0, targetIndex + 1).map(item => item.id));
      const floorOrder = new Map(value.floors.slice(0, targetIndex + 1).map((item, index) => [item.id, index]));
      const scopedDirectory = buildEntityIdentityDirectory({ entities: entitiesThroughFloorIds(entities, trackedFloorIds, identityProjection), floorOrder, identityProjection });
      const scopedEntities = scopedDirectory.map(entry => entry.entity);
      const precedingMemories = value.floorMemories.filter(item => precedingFloorIds.has(item.floorId) && item.recordStatus === 'active');
      const precedingDeltas = filterReachableDeltas({ floors: precedingFloors, floorMemories: precedingMemories, stateDeltas: value.stateDeltas });
      const rebuiltPrevious = precedingDeltas.length
        ? await replayCurrentState({ chatId: value.root.chatId, narrativeGeneration: value.root.narrativeGeneration, baselineId: value.baseline.id, floors: precedingFloors, floorMemories: precedingMemories, stateDeltas: precedingDeltas, now: nowIso(now) })
        : null;
      const storedPrevious = value.currentStates?.at(-1) ?? null;
      const previousCurrentState = rebuiltPrevious && storedPrevious?.fingerprint === rebuiltPrevious.fingerprint ? storedPrevious : rebuiltPrevious;
      const projectedPreviousCurrentState = projectCseStateIdentityReferences(previousCurrentState, identityProjection);
      const trackedMemories = value.floorMemories.filter(item => item.recordStatus === 'active' && trackedFloorIds.has(item.floorId)).map(item => projectFloorMemoryIdentityReferences(item, identityProjection));
      const projectedMemory = projectFloorMemoryIdentityReferences(memory, identityProjection);
      const projectedBaseline = { ...value.baseline,
        userPersona: { ...value.baseline.userPersona, entityId: resolveIdentityEntityId(value.baseline.userPersona.entityId, identityProjection) },
        characterCard: { ...value.baseline.characterCard, entityId: resolveIdentityEntityId(value.baseline.characterCard.entityId, identityProjection) } };
      const baselineEntityIds = new Set([projectedBaseline.userPersona.entityId, projectedBaseline.characterCard.entityId].filter(Boolean));
      const referencedEntityIds = cseReferencedEntityIds(projectedMemory);
      for (const participant of projectedMemory.participants ?? []) referencedEntityIds.add(participant.entityId);
      const identityBriefTargets = scopedDirectory.filter(entry => entry.entityType === 'person' && entry.specialRole === 'none' && !baselineEntityIds.has(entry.entityId) && referencedEntityIds.has(entry.entityId))
        .map(entry => ({ entityId: entry.entityId, name: entry.displayName, labels: entry.labels, identityBrief: entry.identityBrief ?? null }));
      operation.identityBriefTargetIds = identityBriefTargets.map(target => target.entityId);
      const tracked = selectTrackedSubjects({ baseline: projectedBaseline, entities: scopedEntities, floorMemories: trackedMemories, floorMemory: projectedMemory });
      const trackedIds = new Set(tracked.map(entity => entity.id));
      const previousIds = new Set((projectedPreviousCurrentState?.subjects ?? []).map(subject => subject.subjectEntityId));
      const firstTrackedIds = new Set(tracked.filter(entity => !previousIds.has(entity.id)).map(entity => entity.id));
      const firstForAnyTracked = firstTrackedIds.size > 0;
      const prequelQueryIds = firstForAnyTracked ? firstTrackedIds : trackedIds;
      const prequelQueryLabels = scopedDirectory.filter(entry => prequelQueryIds.has(entry.entityId)).flatMap(entry => entry.labels);
      const prequelText = (() => {
        try { const context = operation.hostAdapter.snapshot()?.context; return typeof context?.chatMetadata?.[PREQUEL_METADATA_KEY] === 'string' ? context.chatMetadata[PREQUEL_METADATA_KEY] : ''; }
        catch { return ''; }
      })();
      const relevantPriorContext = selectPrequel({
        text: prequelText,
        queryContext: {
          latestUserText: prequelQueryLabels.join(' '),
          recentAssistantText: `${analysisFloor.content.canonicalContent ?? ''}\n${effectiveMemorySummary(projectedMemory) ?? ''}`,
          previousUserText: '',
        },
        maxCharacters: firstForAnyTracked ? 6000 : 2400,
        maxTokens: firstForAnyTracked ? 2500 : 1000,
        requireMatch: true,
        fallbackToTail: false,
      }).injectionText;
      const currentUserInput = currentUserInputFromMemory(memory);
      const requestSources = await captureCseRequestSources({
        hostAdapter: operation.hostAdapter,
        baseline: value.baseline,
        floor,
        expectedChatId: value.root.chatId,
        filterWorldInfoSources,
        sanitizerOptions: typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions,
        sourceSnapshot: { canonicalContent: memory.sourceCanonicalContent ?? floor.content.canonicalContent, rawFingerprint: memory.sourceRawFingerprint ?? floor.content.rawFingerprint },
      });
      operation.sourceDiagnostics = requestSources.diagnostics;
      const allReachableDeltas = filterReachableDeltas({ floors: value.floors, floorMemories: value.floorMemories, stateDeltas: value.stateDeltas });
      const coreUserEditedSubjectEntityIds = [...new Set((await coreUserEditedSubjects(precedingDeltas, targetStore, operation.coreUserEditedSubjectReadCache))
        .map(id => resolveIdentityEntityId(id, identityProjection)))];
      const allCoreUserEditedSubjectEntityIds = [...new Set((await coreUserEditedSubjects(allReachableDeltas, targetStore, operation.coreUserEditedSubjectReadCache))
        .map(id => resolveIdentityEntityId(id, identityProjection)))];
      const userEntityId = resolveIdentityEntityId(value.baseline.userPersona.entityId, identityProjection);
      const personaLocator = requestSources.userPersona.personaLocator ?? '';
      const hasPersonaDescription = Boolean(requestSources.userPersona.description.trim());
      const currentUserSubject = projectedPreviousCurrentState?.subjects?.find(subject => subject.subjectEntityId === userEntityId);
      const existingUserSubject = existing?.subjectSnapshots.find(subject => resolveIdentityEntityId(subject.subjectEntityId, identityProjection) === userEntityId);
      const hasManualCore = allCoreUserEditedSubjectEntityIds.includes(userEntityId)
        || currentUserSubject?.core?.some(item => item.origin === 'manual') === true
        || existingUserSubject?.core?.some(item => item.origin === 'manual') === true;
      const hasExistingCore = (currentUserSubject?.core?.length ?? 0) > 0 || (existingUserSubject?.core?.length ?? 0) > 0;
      const needsUserCoreExtraction = Boolean(personaLocator) && !hasManualCore && !hasExistingCore;
      const descriptionFingerprint = needsUserCoreExtraction
        ? `sha256:${await sha256(requestSources.userPersona.description)}` : null;
      // 重构记录会提前包含当前目标；只有此前已提交的本轮前缀可完成这次检查。
      const completedRebuildFloorIds = needsUserCoreExtraction && cseRebuild
        ? new Set((cseRebuild.completedFloorIds ?? []).filter(completedFloorId => completedFloorId !== floor.id))
        : null;
      const hasCompletedExtraction = needsUserCoreExtraction && allReachableDeltas.some(delta => {
        if (completedRebuildFloorIds && !completedRebuildFloorIds.has(delta.floorId)) return false;
        const extraction = delta.source?.userCoreExtraction ?? delta.source?.userCoreCheck;
        return resolveIdentityEntityId(extraction?.userEntityId, identityProjection) === userEntityId && extraction.personaLocator === personaLocator
          && extraction.descriptionFingerprint === descriptionFingerprint
          && ['traits', 'insufficient'].includes(extraction.status);
      });
      const userCoreExtraction = needsUserCoreExtraction && !hasCompletedExtraction
        ? { userEntityId, personaLocator, descriptionFingerprint, hasDescription: hasPersonaDescription }
        : null;
      operation.userCoreExtraction = userCoreExtraction;
      operation.dependencySnapshot = await dependencySnapshot(value, floor.id, entities, previousCurrentState, coreUserEditedSubjectEntityIds, operation.identityProjection, operation.identityBriefTargetIds);
      if (!operation.dependencySnapshot) throw errorWith('V3_CSE_STALE', '此前楼层的人物状态资料不可用，请刷新状态后重试。');
      const identityMemberEntityIdsBySubject = Object.fromEntries(tracked.map(entity => [entity.id, (previousCurrentState?.subjects ?? [])
        .filter(subject => resolveIdentityEntityId(subject.subjectEntityId, identityProjection) === entity.id)
        .filter(subject => ['core', 'adaptive', 'situational'].some(category => subject[category]?.length))
        .map(subject => subject.subjectEntityId)]));
      const userBindings = tracked.filter(entity => entity.id === userEntityId || identityMemberEntityIdsBySubject?.[entity.id]?.includes(userEntityId));
      const previousUserForReview = userBindings.length === 1 ? projectedPreviousCurrentState?.subjects?.find(subject => subject.subjectEntityId === userBindings[0].id) : null;
      const userAdaptiveReviewEligible = userBindings.length === 1 && !(previousUserForReview?.adaptive?.length);
      const userAdaptiveHistory = userAdaptiveReviewEligible
        ? selectUserAdaptiveHistory({ floors: value.floors, floorMemories: value.floorMemories, targetIndex, userEntityId, identityProjection: operation.identityProjection }) : [];
      const envelope = createCseEnvelope({ floor: analysisFloor, floorMemory: projectedMemory, baseline: projectedBaseline, currentState: projectedPreviousCurrentState, trackedSubjects: tracked, entities: scopedEntities, identityDirectory: scopedDirectory, identityBriefTargets, requestSources, currentUserInput, coreUserEditedSubjectEntityIds: coreUserEditedSubjectEntityIds.map(id => resolveIdentityEntityId(id, operation.identityProjection)), identityMemberEntityIdsBySubject, relevantPriorContext, userCoreExtraction, userAdaptiveHistory });
      const deltaId = await deterministicUuid(['v3-cse-delta', operation.runId, floor.id, memory.id]);
      const promptGuidanceSnapshot = typeof promptGuidance === 'function' ? promptGuidance() : promptGuidance;
      const processingPromptSnapshot = typeof processingPrompt === 'function' ? processingPrompt() : processingPrompt;
      operation.promptGuidanceFingerprint = `sha256:${await sha256(String(promptGuidanceSnapshot ?? ''))}`;
      operation.systemPromptFingerprint = `sha256:${await sha256(buildCseSystemPrompt(promptGuidanceSnapshot, processingPromptSnapshot))}`;
      const result = await runCseRequest({ generateAnalysisTask, envelope, previousCurrentState: projectedPreviousCurrentState, now: nowIso(now), deltaId, promptGuidance: promptGuidanceSnapshot, processingPrompt: processingPromptSnapshot, signal: operation.controller.signal });
      if ((!operation.pinnedTarget && operation.epoch !== epoch) || operation.controller.signal.aborted) throw errorWith('V3_CSE_STALE', '人物状态分析已停止。');
      operation.phase = 'committing'; notify();
      await commitDelta(operation, result, roleEntities);
    } catch (error) {
      const stopped = error?.name === 'AbortError' || operation.controller.signal.aborted;
      const failure = stopped || error?.code === 'V3_CSE_STALE'
        ? { floorId, runId: operation.runId, code: 'V3_CSE_STALE', message: stopped
          ? '人物状态分析已停止；请查看本楼记录确认当前状态。'
          : '本楼正文、摘要或人物资料已变化，请刷新状态后重新分析。', phase: 'stale' }
        : { floorId, runId: operation.runId, code: String(error?.code ?? 'V3_CSE_FAILED').slice(0, 120), message: sanitizeSensitiveText(error?.message ?? '状态分析失败，可单独重试。').slice(0, 500), phase: 'retryableError', ...(operation.userCoreExtraction ? { userCoreExtraction: operation.userCoreExtraction } : {}), diagnostics: sanitizeDiagnosticValue(error?.cseDiagnostics ?? error?.sourceDiagnostics ?? null) };
      if (failure.phase === 'retryableError') publishFailureHint(value, floorId, failure);
      if (reachable?.root?.chatId === operation.targetIdentity?.chatId || !operation.pinnedTarget) lastFailure = failure;
      logger?.warn?.('[qianqianjie] V3 CSE failed', { code: error?.code ?? error?.name ?? 'V3_CSE_FAILED' });
    } finally { if (active === operation) active = null; }
    return notify();
  }

  async function correctSubjectState({ subjectEntityId, expectedCurrentStateId, expectedCurrentStateFingerprint, core, adaptive, situational } = {}) {
    if (!enabled()) throw errorWith('V3_CSE_DISABLED', '人物状态功能当前不可用。');
    if (active) throw errorWith('V3_CSE_BUSY', '人物状态正在处理，请稍后再保存。');
    const current = await store.readReachable({ mode: 'runtime' });
    if (current.status !== 'ready' || !current.baseline) throw errorWith('V3_CSE_MANUAL_TARGET_INVALID', '当前人物状态尚不可编辑。');
    reachable = current;
    await calculateReplay(current);
    if (!replayed || replayed.id !== expectedCurrentStateId || replayed.fingerprint !== expectedCurrentStateFingerprint
      || current.root.chatId !== replayed.chatId || current.root.narrativeGeneration !== replayed.narrativeGeneration) {
      throw errorWith('V3_CSE_MANUAL_STALE', '人物状态已变化，请保留当前草稿并重新打开编辑后再保存。');
    }
    const liveDeltas = filterReachableDeltas({ floors: migrationPartition(current).liveFloors, floorMemories: current.floorMemories, stateDeltas: current.stateDeltas });
    const deltas = filterReachableDeltas({ floors: current.floors, floorMemories: current.floorMemories, stateDeltas: current.stateDeltas });
    const anchor = liveDeltas.at(-1);
    const anchorIndex = current.floors.findIndex(floor => floor.id === anchor?.floorId);
    const floor = anchorIndex >= 0 ? current.floors[anchorIndex] : null;
    const memory = floor ? current.floorMemories.find(item => item.floorId === floor.id && item.recordStatus === 'active') ?? { id: anchor.floorMemoryId } : null;
    const canonicalSubjectEntityId = resolveIdentityEntityId(subjectEntityId, identityProjection);
    const projectedCurrentState = projectCseStateIdentityReferences(replayed, identityProjection);
    if (!anchor || !floor || !memory || !projectedCurrentState?.subjects.some(subject => subject.subjectEntityId === canonicalSubjectEntityId)) throw errorWith('V3_CSE_MANUAL_TARGET_INVALID', '只能纠正当前已有状态的人物。');
    const prefixFloorIds = new Set(current.floors.slice(0, anchorIndex + 1).map(item => item.id));
    const towardCandidates = buildEntityIdentityDirectory({ entities: current.entities, floorIds: prefixFloorIds, identityProjection }).filter(entry => entry.entityType === 'person');
    const deltaId = await deterministicUuid(['v3-cse-manual-delta', anchor.id, canonicalSubjectEntityId, newUuid()]);
    const timestamp = nowIso(now);
    const subjectMemberEntityIds = replayed.subjects.filter(subject => resolveIdentityEntityId(subject.subjectEntityId, identityProjection) === canonicalSubjectEntityId).map(subject => subject.subjectEntityId);
    const correction = await createManualCseCorrection({ anchorDelta: anchor, currentState: projectedCurrentState, subjectEntityId: canonicalSubjectEntityId, subjectMemberEntityIds, edits: { core, adaptive, situational }, allowedTowardEntityIds: towardCandidates.map(entry => entry.entityId), deltaId, now: timestamp });
    if (correction.status === 'unchanged') { publishFailureHint(current, floor.id, null); lastFailure = null; return notify(); }
    const operation = { floorId: floor.id, floorMemoryId: memory.id, epoch, controller: new AbortController(), runId: await deterministicUuid(['v3-cse-manual-run', current.root.headCheckpointId, correction.delta.id]), startedAt: timestamp, phase: 'correcting' };
    active = operation;
    notify();
    try {
      return await commitDeltaGraph({ operation, current, floor, memory, delta: correction.delta, deltas: deltas.map(item => item.floorId === floor.id ? correction.delta : item), entities: current.entities, diagnostics: { kind: 'cseManualCorrection', promptVersion: CSE_PROMPT_VERSION, compilerVersion: CSE_COMPILER_VERSION, manualSubjectEntityIds: correction.delta.source.manualSubjectEntityIds, cseRebuild: null } });
    } catch (error) {
      lastFailure = { floorId: floor.id, runId: operation.runId, code: String(error?.code ?? 'V3_CSE_MANUAL_SAVE_FAILED').slice(0, 120), message: sanitizeSensitiveText(error?.message ?? '人物状态纠正保存失败。').slice(0, 500), phase: error?.code === 'V3_CSE_MANUAL_STALE' || error?.code === 'V3_CSE_CAS_CONFLICT' || error?.name === 'AbortError' ? 'stale' : 'retryableError' };
      if (lastFailure.phase === 'retryableError') publishFailureHint(current, floor.id, lastFailure);
      throw error;
    } finally {
      if (active === operation) active = null;
      notify();
    }
  }

  function cancelActive() {
    if (!active) return false;
    epoch += 1;
    active.controller.abort();
    active = null;
    notify();
    return true;
  }
  function clearView() { reachable = null; replayed = null; historyProjectionCache = null; lastFailure = null; replayDiagnostic = null; notify(); }
  function invalidate() { epoch += 1; active?.controller.abort(); active = null; reachable = null; replayed = null; historyProjectionCache = null; lastFailure = null; replayDiagnostic = null; notify(); }
  return Object.freeze({ load, analyzeFloor, correctSubjectState, cancelActive, clearView, invalidate, setIdentityProjection, getState, getActivityState, getCurrentSubjectStates, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
