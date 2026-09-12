import { formatChronologyAnchor, projectRecallSource, readRecallSource } from './recall-source.js';
import { PEOPLE_PROFILE_FIELDS } from './people-profile-fields.js';

export const QQJ_PUBLIC_MEMORY_BRIDGE_KEY = 'qqj_v3_public_bridge_v1';

const clean = (value, maximum = 4000) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximum);

const frozen = value => Object.freeze(value);
const entityName = (id, entityById) => entityById.get(id)?.displayName || '未知人物';
const entityNames = (ids, entityById) => [...new Set((ids ?? []).filter(Boolean).map(id => entityName(id, entityById)))].join('、');

function actionText(value, entityById) {
  const completion = ({
    intended: '打算', attempted: '尝试', completed: '完成', interrupted: '中断', uncertain: '结果未定',
  })[value.completion] ?? '行动';
  const actor = entityName(value.actorEntityId, entityById);
  const targets = entityNames(value.targetEntityIds, entityById);
  return `${actor}${targets ? ` → ${targets}` : ''}：${completion}「${value.action}」${value.result ? `，结果：${value.result}` : ''}`;
}

function commitmentText(value, entityById) {
  const speaker = entityName(value.speakerEntityId, entityById);
  const targets = entityNames(value.targetEntityIds, entityById);
  const status = ({ accepted: '已接受', refused: '已拒绝', pending: '待定', uncertain: '是否成立未定' })[value.status] ?? clean(value.status, 100);
  const kind = value.kind === 'plan' ? '计划' : '承诺';
  return `${speaker}${targets ? ` → ${targets}` : ''}：${kind}「${value.content}」${status ? `（${status}；不代表已履行）` : '（不代表已履行）'}`;
}

function stateBoundary(value, subject) {
  if (value.visibility === 'private') return `仅 ${subject} 本人知情`;
  if (value.visibility === 'authorial') return '作者塑造参考，不代表任何人物知情';
  if (value.visibility === 'shared') return '已共享';
  if (value.visibility === 'expressed') return '已表达';
  return '可观察';
}

export function formatPublicMemoryProjection(source) {
  if (!source || source.status !== 'ready') return '';
  const entities = Array.isArray(source.entities) ? source.entities : [];
  const memories = Array.isArray(source.floorMemories) ? source.floorMemories : [];
  const states = Array.isArray(source.currentState) ? source.currentState : [];
  if (!memories.length && !states.length) return '';
  const entityById = new Map(entities.map(entity => [entity.entityId, entity]));
  const lines = [
    '<qqj_memory_context>',
    '以下是千千结已经正式保存的长期记忆与人物状态，只作剧情参考；与当前正文冲突时以正文为准。',
  ];

  const people = entities.filter(entity => entity.entityType === 'person' && entity.displayName);
  if (people.length) {
    lines.push('', '[人物索引]');
    for (const person of people) {
      const aliases = [...new Set((person.aliases ?? []).map(alias => clean(alias, 500)).filter(alias => alias && alias !== person.displayName))];
      lines.push(`- ${person.displayName}${aliases.length ? `（别名：${aliases.join('、')}）` : ''}`);
    }
  }

  if (memories.length) {
    lines.push('', '[长期剧情记忆]');
    for (const memory of memories) {
      const details = [];
      for (const event of memory.events ?? []) details.push(`事件：${event.title}${event.description ? `——${event.description}` : ''}`);
      for (const action of memory.actions ?? []) details.push(`行动：${actionText(action, entityById)}`);
      for (const commitment of memory.commitments ?? []) details.push(`承诺/计划：${commitmentText(commitment, entityById)}`);
      for (const loop of memory.openLoops ?? []) {
        const owners = entityNames(loop.ownerEntityIds, entityById);
        details.push(`未结事项${owners ? `（相关人物：${owners}）` : ''}：${loop.description}`);
      }
      const summary = clean(memory.summary);
      if (!summary && !details.length) continue;
      const time = formatChronologyAnchor(memory.chronology);
      lines.push(`- AI #${memory.assistantSeq}${time ? `（${time}）` : ''}${summary ? `：${summary}` : ''}`);
      for (const detail of details) lines.push(`  - ${detail}`);
    }
  }

  if (states.length) {
    const coverage = source.coverage ?? {};
    lines.push('', coverage.cseCurrent ? '[当前人物状态]' : `[已保存人物状态（仅连续到 AI #${coverage.cseThroughAssistantSeq || 0}，不代表当前完整状态）]`);
    for (const subject of states) {
      const subjectName = entityName(subject.subjectEntityId, entityById);
      for (const [layer, values] of [['Core', subject.core], ['Adaptive', subject.adaptive], ['Situational', subject.situational]]) {
        for (const value of values ?? []) {
          const toward = value.towardEntityId ? `；对象：${entityName(value.towardEntityId, entityById)}` : '';
          const sourceFloor = value.sourceAssistantSeq ? `；来源 AI #${value.sourceAssistantSeq}` : '';
          const reason = value.reason ? `；依据：${value.reason}` : '';
          lines.push(`- ${subjectName} / ${layer} / ${stateBoundary(value, subjectName)}${toward}${sourceFloor}：${value.text}${reason}`);
        }
      }
    }
  }

  const coverage = source.coverage ?? {};
  if (coverage.memoryComplete === false || coverage.cseCurrent === false) {
    const missing = Array.isArray(coverage.missingAssistantSeq) && coverage.missingAssistantSeq.length
      ? coverage.missingAssistantSeq.join('、') : '无';
    lines.push('', `[覆盖说明] 已保存 ${coverage.rememberedAiFloors ?? memories.length}/${coverage.stableAiFloors ?? '?'} 个稳定 AI 楼；缺失 AI #${missing}。已有记忆仍可参考，未追平部分不可当作完整现状。`);
  }
  lines.push('</qqj_memory_context>');
  return lines.join('\n');
}

const publicIdentity = identity => frozen({
  hostChatId: identity.hostChatId,
  qqjChatId: identity.chatId,
  characterLocator: identity.characterLocator,
  personaLocator: identity.personaLocator,
});

const sameIdentity = (left, right) => left?.hostChatId === right?.hostChatId
  && left?.chatId === right?.chatId
  && left?.characterLocator === right?.characterLocator
  && left?.personaLocator === right?.personaLocator;

const completeFoundationSnapshot = foundationRuntime => {
  if (!foundationRuntime || typeof foundationRuntime.getState !== 'function' || typeof foundationRuntime.getReachable !== 'function') return null;
  try {
    if (foundationRuntime.getState()?.status !== 'ready') return null;
    const value = foundationRuntime.getReachable();
    if (!['ready', 'needsReseal'].includes(value?.status)
      || !value.root || !value.checkpoint
      || value.root.status !== 'ready'
      || value.checkpoint.id !== value.root.headCheckpointId
      || value.checkpoint.narrativeGeneration !== value.root.narrativeGeneration
      || value.checkpoint.sourceSnapshotFingerprint !== value.root.sourceSnapshotFingerprint
      || !Number.isSafeInteger(value.rootRevision)
      || !Array.isArray(value.floors) || !Array.isArray(value.floorMemories)
      || !Array.isArray(value.entities) || !Array.isArray(value.stateDeltas)
      || !Array.isArray(value.currentStates) || !value.run) return null;
    return value;
  } catch { return null; }
};

const sameReachableRoot = (value, rootResult) => rootResult?.status === 'ready'
  && rootResult.revision === value?.rootRevision
  && rootResult.data?.chatId === value?.root?.chatId
  && rootResult.data?.headCheckpointId === value?.root?.headCheckpointId
  && rootResult.data?.narrativeGeneration === value?.root?.narrativeGeneration
  && rootResult.data?.sourceSnapshotFingerprint === value?.root?.sourceSnapshotFingerprint;

const publicStateItem = value => ({
  id: value?.id ?? null,
  text: value?.text ?? '',
  visibility: value?.visibility ?? null,
  reason: value?.reason ?? '',
  origin: value?.origin ?? null,
  towardEntityId: value?.towardEntityId ?? null,
  towardDisplayName: value?.towardDisplayName ?? null,
  sourceFloorId: value?.sourceFloorId ?? null,
  sourceAssistantSeq: value?.sourceAssistantSeq ?? null,
});

const publicSubject = value => ({
  subjectEntityId: value?.subjectEntityId ?? null,
  displayName: value?.displayName ?? '未知人物',
  core: (value?.core ?? []).map(publicStateItem),
  adaptive: (value?.adaptive ?? []).map(publicStateItem),
  situational: (value?.situational ?? []).map(publicStateItem),
});

const emptyMemorySnapshot = (status = 'not-ready', syncStatus = 'idle') => ({
  status,
  syncStatus,
  headCheckpointId: null,
  floors: [],
});

const emptyCseSnapshot = () => ({ ready: false, currentSubjects: [], floors: [] });
const emptyPeopleSnapshot = (status = 'not-ready') => ({ status, revision: null, items: [] });

function publicMemorySnapshot(value, chatId) {
  if (!value || value.chatId !== chatId) return emptyMemorySnapshot();
  const status = value.memorySnapshotStatus ?? 'not-ready';
  const syncStatus = value.memorySyncStatus ?? 'idle';
  if (status !== 'ready') return emptyMemorySnapshot(status, syncStatus);
  return {
    status,
    syncStatus,
    headCheckpointId: value.headCheckpointId ?? null,
    floors: (value.floors ?? []).filter(floor => floor?.memory?.recordStatus === 'active').map(floor => ({
      floorId: floor.floorId,
      messageIndex: floor.messageIndex,
      assistantSeq: floor.assistantSeq,
      summary: floor.summary,
      summarySource: floor.summarySource,
    })),
  };
}

function publicCseSnapshot(value, chatId) {
  if (!value || value.chatId !== chatId || value.memorySnapshotStatus !== 'ready') return emptyCseSnapshot();
  return {
    ready: value.cseReady === true,
    currentSubjects: (value.cseSubjects ?? []).map(publicSubject),
    floors: (value.floors ?? []).filter(floor => floor?.cse).map(floor => {
      const cse = floor.cse;
      const changesKnown = cse.record?.fixedChangesAvailable === true;
      return {
        floorId: floor.floorId,
        messageIndex: floor.messageIndex,
        assistantSeq: floor.assistantSeq,
        status: cse.status,
        deltaId: cse.deltaId ?? null,
        changesKnown,
        changes: changesKnown ? (cse.record?.subjects ?? []).map(subject => ({
          subjectEntityId: subject.subjectEntityId,
          displayName: subject.displayName,
          changes: (subject.changes ?? []).map(change => ({
            category: change.category,
            action: change.action,
            before: change.before ? publicStateItem(change.before) : null,
            after: change.after ? publicStateItem(change.after) : null,
          })),
        })) : null,
        savedSubjects: (cse.record?.endStateSubjects ?? []).map(publicSubject),
      };
    }),
  };
}

function publicPeopleSnapshot(value, chatId) {
  if (!value || value.chatId !== chatId) return emptyPeopleSnapshot();
  return {
    status: value.status ?? 'not-ready',
    revision: value.revision ?? null,
    items: (value.people ?? []).map(person => ({
      entityId: person.entityId,
      displayName: person.displayName,
      entityDisplayName: person.entityDisplayName,
      aliases: person.aliases ?? [],
      specialRole: person.specialRole ?? null,
      selected: person.selected === true,
      profiled: person.profiled === true,
      profile: person.profile ? {
        ...Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, person.profile[field] ?? ''])),
        manualFields: person.profile.manualFields ?? [],
        source: person.profile.source ?? null,
        createdAt: person.profile.createdAt ?? null,
        updatedAt: person.profile.updatedAt ?? null,
      } : null,
    })),
  };
}

export function createPublicMemoryBridge({ session, store, hostAdapter, foundationRuntime = null, memoryRuntime = null, peopleRuntime = null, isEnabled = true, sanitizerOptions = () => ({}), identityProjectionProvider = null, readSource = readRecallSource } = {}) {
  if (!session || typeof session.identity !== 'function' || typeof session.getState !== 'function') throw new TypeError('公共记忆桥 session 无效');
  if (!store || typeof store.readReachable !== 'function') throw new TypeError('公共记忆桥 store 无效');
  if (!hostAdapter || typeof hostAdapter.snapshot !== 'function') throw new TypeError('公共记忆桥 hostAdapter 无效');
  if (typeof readSource !== 'function') throw new TypeError('公共记忆桥 projection reader 无效');
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };
  const localStatus = () => {
    if (!enabled()) return frozen({ status: 'disabled', message: '千千结当前已关闭。' });
    const state = session.getState();
    if (state?.status !== 'ready' || !state.identity) return frozen({ status: 'not-ready', message: '千千结尚未准备好当前聊天身份。' });
    return frozen({ status: 'ready', identity: publicIdentity(state.identity) });
  };
  async function readMemory() {
    const status = localStatus();
    if (status.status !== 'ready') return status;
    let before;
    try { before = session.identity(); }
    catch { return frozen({ status: 'not-ready', message: '千千结尚未准备好当前聊天身份。' }); }
    try {
      const hostSnapshot = hostAdapter.snapshot();
      const currentSanitizerOptions = typeof sanitizerOptions === 'function' ? sanitizerOptions() : sanitizerOptions;
      const identityProjectionValue = typeof identityProjectionProvider === 'function' ? await identityProjectionProvider() : null;
      const identityProjection = identityProjectionValue?.data ?? identityProjectionValue;
      const foundationSnapshot = completeFoundationSnapshot(foundationRuntime);
      let source = null;
      if (foundationSnapshot && typeof store.readRoot === 'function') {
        const rootResult = await store.readRoot();
        if (sameReachableRoot(foundationSnapshot, rootResult)) {
          source = await projectRecallSource(
            foundationSnapshot,
            () => new Date(),
            frozen({ reachableReads: 0, exitPoint: 'foundationCache' }),
            hostSnapshot,
            currentSanitizerOptions,
            false,
            identityProjection,
          );
        }
      }
      source ??= await readSource({ store, hostSnapshot, sanitizerOptions: currentSanitizerOptions, identityProjection });
      let after;
      try { after = session.identity(); }
      catch { return frozen({ status: 'stale', message: '读取期间当前聊天已变化。' }); }
      if (!sameIdentity(before, after) || hostAdapter.snapshot()?.chatId !== before.hostChatId) {
        return frozen({ status: 'stale', message: '读取期间当前聊天已变化。' });
      }
      if (source.status !== 'ready') return frozen({ status: source.status, message: '当前聊天暂无可读取的千千结正式记忆。', identity: publicIdentity(before) });
      if (source.chatId !== before.chatId) return frozen({ status: 'stale', message: '千千结记忆身份已变化。' });
      const text = formatPublicMemoryProjection(source);
      return frozen({
        status: text ? 'ready' : 'empty',
        text,
        message: text ? '' : '当前聊天还没有千千结正式记忆。',
        identity: publicIdentity(before),
        anchor: frozen({ narrativeGeneration: source.narrativeGeneration, headCheckpointId: source.headCheckpointId, rootRevision: source.rootRevision }),
        coverage: source.coverage,
      });
    } catch (error) {
      return frozen({ status: 'error', message: clean(error?.message, 500) || '千千结记忆读取失败。', identity: publicIdentity(before) });
    }
  }
  function getSnapshot() {
    const status = localStatus();
    if (status.status !== 'ready') return status;
    try {
      const memoryState = typeof memoryRuntime?.getState === 'function' ? memoryRuntime.getState() : null;
      const peopleState = typeof peopleRuntime?.getState === 'function' ? peopleRuntime.getState() : null;
      return structuredClone({
        status: 'ready',
        identity: status.identity,
        memory: publicMemorySnapshot(memoryState, status.identity.qqjChatId),
        cse: publicCseSnapshot(memoryState, status.identity.qqjChatId),
        people: publicPeopleSnapshot(peopleState, status.identity.qqjChatId),
      });
    } catch (error) {
      return frozen({ status: 'error', message: clean(error?.message, 500) || '千千结快照读取失败。', identity: status.identity });
    }
  }
  return frozen({ schemaVersion: 1, kind: 'qqj-public-memory-bridge', getStatus: localStatus, readMemory, getSnapshot });
}

export function installPublicMemoryBridge({ globalRef = globalThis, ...options } = {}) {
  const bridge = createPublicMemoryBridge(options);
  globalRef[QQJ_PUBLIC_MEMORY_BRIDGE_KEY] = bridge;
  return frozen({
    bridge,
    cleanup() {
      if (globalRef[QQJ_PUBLIC_MEMORY_BRIDGE_KEY] === bridge) delete globalRef[QQJ_PUBLIC_MEMORY_BRIDGE_KEY];
    },
  });
}
