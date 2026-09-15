import { estimateRecallTokens } from './recall-selector.js';
import { TIME_HEAD_ID, TIME_SYSTEM_PROMPT, prepareTimeBatch, compileTimeResponse, replayTimeBatches, storyTimes, projectTime, timeRecallProjection, timeFingerprint, timeDistance, timeHours, validTimeProjection } from './time-engine.js';
import { projectRecallSource } from './recall-source.js';
import { sanitizeTaskMetadata } from './safe-metadata.js';
import { publicErrorMessage } from '../public-error.js';

export function createTimeStore({ client }) {
  const collection = chatId => `chat-${chatId}`;
  const readRecord = async (chatId, id) => {
    try { return await client.get(collection(chatId), id); }
    catch (error) { if (error?.status === 404) return { data: null, revision: 0 }; throw error; }
  };
  async function read(chatId) {
    const head = await readRecord(chatId, TIME_HEAD_ID);
    if (!head.data) return { head: null, revision: 0, batches: [] };
    if (head.data.schemaVersion !== 1 || head.data.chatId !== chatId || !Array.isArray(head.data.batchIds)) throw new Error('时间记录头无效。');
    const batches = [];
    const envelopes = await Promise.all(head.data.batchIds.map(id => readRecord(chatId, id)));
    for (const envelope of envelopes) {
      if (!envelope.data || envelope.data.chatId !== chatId || envelope.data.schemaVersion !== 1) throw new Error('时间增量记录无效。');
      batches.push(envelope.data);
    }
    return { head: head.data, revision: head.revision, batches };
  }
  const putHead = (chatId, data, revision, signal) => client.put(collection(chatId), TIME_HEAD_ID, data, revision, { signal });
  const putBatch = (chatId, data, signal) => client.put(collection(chatId), data.id, data, 0, { signal });
  async function copyPrefix(sourceChatId, targetChatId, retainedFloors, signal) {
    const target = await read(targetChatId);
    if (target.head) return;
    const source = await read(sourceChatId);
    if (!source.head) return;
    const floors = new Set(retainedFloors.map(floor => floor.id));
    const batches = source.batches.filter(batch => floors.has(batch.cutoffFloorId) && batch.dependencies.every(ref => floors.has(ref.floorId)));
    const ids = [];
    for (const batch of batches) {
      const copied = { ...structuredClone(batch), chatId: targetChatId };
      await putBatch(targetChatId, copied, signal); ids.push(copied.id);
    }
    await putHead(targetChatId, { schemaVersion: 1, chatId: targetChatId, batchIds: ids, lastAttemptSignature: batches.at(-1)?.signature ?? null, lastAttemptTime: batches.at(-1)?.currentTime ?? null }, 0, signal);
  }
  return Object.freeze({ read, putHead, putBatch, copyPrefix });
}

export async function prepareTimeRequest(reachable, batches = [], options = {}) {
  const prepared = await prepareTimeBatch(reachable, batches, options);
  const recall = await projectRecallSource(reachable, () => new Date());
  const subjects = new Set([...prepared.request.observations, ...prepared.request.trackedItems].map(item => item.subjectEntityId));
  const linkFloors = new Set(prepared.request.observations.map(item => item.floorId));
  const linkedStates = new Set(prepared.trackedRecords.flatMap(item => (item.stateRefs ?? []).map(ref => ref.stateId)));
  prepared.request.currentStates = recall.currentState.filter(subject => subjects.has(subject.subjectEntityId)).flatMap(subject => ['core', 'adaptive', 'situational'].flatMap(layer => subject[layer].map(state => ({ ...state, subjectEntityId: subject.subjectEntityId, layer })))).filter(state => linkFloors.has(state.sourceFloorId) || linkedStates.has(state.stateId));
  prepared.request.chatId = reachable.root.chatId;
  while ((JSON.stringify(prepared.request).length > 24000 || estimateRecallTokens(JSON.stringify(prepared.request) + TIME_SYSTEM_PROMPT) > 6000) && prepared.request.currentStates.length) prepared.request.currentStates.pop();
  return prepared;
}

export function createTimeRuntime({ store, foundationStore, hostAdapter, session, generateAnalysisTask, getReachable = () => null, getMemoryState = () => null, isEnabled = () => false, onInvalidate = () => {}, logger = console }) {
  let epoch = 0, active = null, last = null, projectionCache = null, pendingReceipt = null, statusKey = null, statusRead = null, trackedItems = null, itemsKey = null;
  const subscribers = new Set();
  const enabled = () => isEnabled() === true;
  const identity = () => { try { return session.identity(); } catch { return { chatId: null }; } };
  const current = operation => enabled() && operation.epoch === epoch && !operation.controller.signal.aborted && identity().chatId === operation.chatId;
  const manualBlock = (ignoreActive = false) => {
    if (!enabled()) return '时间推演已关闭。';
    if (active && !ignoreActive) return '正在整理时间事项。';
    const source = getReachable(), memory = getMemoryState();
    if (memory?.memoryWorkBusy || memory?.activeExtraction || memory?.activeCse || memory?.activeRun || memory?.memorySyncStatus === 'syncing') return '请等待当前记忆处理完成。';
    if (['needsReview', 'error'].includes(memory?.memorySyncStatus) || ['needsReview', 'error'].includes(memory?.status)) return '请先同步当前聊天记忆，再整理时间事项。';
    if (!source?.root || !['ready', 'needsReseal'].includes(source.status ?? 'ready') || source.root.chatId !== identity().chatId) return '请等待当前聊天记忆读取就绪。';
    const byFloor = new Map((memory?.floors ?? []).map(floor => [floor.floorId, floor]));
    if (!(source.floors ?? []).every(floor => {
      const view = byFloor.get(floor.id);
      return view?.memory?.recordStatus === 'active' && view.cse?.status === 'ready' && Boolean(view.cse.deltaId);
    })) return '请先补全当前楼的摘要和人物状态。';
    return '';
  };
  const sourceKey = source => JSON.stringify([epoch, source?.root?.chatId, source?.root?.headCheckpointId, source?.rootRevision]);
  const memoryNeedsSync = () => ['syncing', 'needsReview', 'error'].includes(getMemoryState()?.memorySyncStatus)
    || ['needsReview', 'error'].includes(getMemoryState()?.status);
  function cacheItems(batches, source) {
    const times = storyTimes(source.floorMemories, source.floors), currentTime = times.get(source.floors.at(-1)?.id) ?? projectTime('');
    const names = new Map((source.entities ?? []).map(entity => [entity.id, entity.displayName]));
    trackedItems = replayTimeBatches(batches, source).filter(item => item.status === 'active').map(item => ({
      id: item.id, person: names.get(item.subjectEntityId) ?? '人物未提供', label: item.label, type: item.type,
      observation: item.observation, observationTime: item.observationTime, occurrenceTime: item.occurrenceTime,
      dueTime: item.dueTime, periodDays: item.periodDays,
      elapsedDays: timeDistance(item.occurrenceTime, currentTime), elapsedHours: timeHours(item.occurrenceTime, currentTime),
      observationElapsedDays: timeDistance(item.observationTime, currentTime), observationElapsedHours: timeHours(item.observationTime, currentTime),
      projection: validTimeProjection(item, currentTime) ? item.projection.text : null,
    }));
    itemsKey = sourceKey(source);
    statusKey = sourceKey(getReachable()) === itemsKey ? itemsKey : null;
    return trackedItems.length;
  }
  const getState = () => {
    const disabledReason = manualBlock();
    return { status: active ? 'running' : enabled() ? memoryNeedsSync() ? 'waiting' : last?.status ?? 'idle' : 'disabled', phase: active?.phase ?? null, active: Boolean(active), last, canOrganize: !disabledReason, disabledReason, trackedItems: enabled() && !memoryNeedsSync() && itemsKey === sourceKey(getReachable()) ? structuredClone(trackedItems) : null };
  };
  const notify = () => { const state = getState(); for (const listener of subscribers) try { listener(state); } catch { /* UI isolation */ } return state; };
  function invalidate() {
    epoch += 1; active?.controller.abort(); last = null; projectionCache = null; pendingReceipt = null; statusKey = null; statusRead = null; trackedItems = null; itemsKey = null; onInvalidate(); notify();
  }
  async function stop() {
    const pending = active?.promise;
    invalidate();
    if (pending) await pending;
  }
  const itemCount = (batches, reachable) => replayTimeBatches(batches, reachable).filter(item => item.status === 'active').length;
  const retryable = (head, batches) => ['failed', 'running'].includes(head?.lastRun?.status) || Boolean(head?.lastAttemptSignature && !head.lastRun && head.lastAttemptSignature !== batches.at(-1)?.signature);
  async function refreshStatus({ force = false } = {}) {
    if (!enabled() || active) return notify();
    if (last?.status === 'failed' && last.persisted === false) return notify();
    const source = getReachable();
    if (!source?.root || !['ready', 'needsReseal'].includes(source.status ?? 'ready') || source.root.chatId !== identity().chatId) {
      trackedItems = null; itemsKey = null; statusKey = null; last = { status: 'waiting', message: '等待当前聊天记忆读取。' }; return notify();
    }
    const key = sourceKey(source);
    if (['needsReview', 'error'].includes(getMemoryState()?.memorySyncStatus) || ['needsReview', 'error'].includes(getMemoryState()?.status)) { trackedItems = null; itemsKey = null; statusKey = null; last = { status: 'waiting', message: '请先同步当前聊天记忆。' }; return notify(); }
    if (getMemoryState()?.memorySyncStatus === 'syncing') {
      if (itemsKey !== key) { trackedItems = null; itemsKey = null; statusKey = null; }
      return notify();
    }
    if (statusRead?.key === key) return statusRead.promise;
    if (!force && statusKey === key) return notify();
    const token = epoch, chatId = source.root.chatId;
    const read = { key, promise: null }; statusRead = read;
    read.promise = (async () => {
      try {
        const stored = await store.read(chatId);
        if (token !== epoch || !enabled() || active || identity().chatId !== chatId || sourceKey(getReachable()) !== key || memoryNeedsSync()) return getState();
        const run = stored.head?.lastRun, items = cacheItems(stored.batches, source);
        if (run) last = { ...run, status: run.status === 'running' ? 'interrupted' : run.status, items, message: run.status === 'running' ? '上次整理未确认完成，可手动重试。' : run.message };
        else if (retryable(stored.head, stored.batches)) last = { status: 'interrupted', items, message: '上次整理未确认完成，可手动重试。' };
        else if (stored.batches.length) last = { status: 'completed', items, cutoffAssistantSeq: stored.batches.at(-1).cutoffAssistantSeq };
        else last = { status: 'idle', items: 0 };
        statusKey = key;
      } catch {
        if (token === epoch && !active && identity().chatId === chatId) { trackedItems = null; itemsKey = null; last = { status: 'failed', reason: 'read', message: '时间记录读取失败，请稍后重新整理。' }; }
      } finally { if (statusRead === read) statusRead = null; }
      return notify();
    })();
    return read.promise;
  }
  async function organize() {
    if (manualBlock()) return notify();
    return runBatch({ chatId: identity().chatId }, { manual: true });
  }
  async function runBatch(receipt, { manual = false } = {}) {
    if (!enabled() || identity().chatId !== receipt?.chatId) return getState();
    if (active) { if (!manual) pendingReceipt = receipt; return getState(); }
    const operation = { epoch, chatId: receipt.chatId, controller: new AbortController(), phase: 'preparing', promise: null, manual };
    active = operation; notify();
    operation.promise = (async () => {
      let head = null, attempted = null;
      try {
        const reachable = await foundationStore.readReachable();
        if (!current(operation) || !['ready', 'needsReseal'].includes(reachable?.status) || reachable.root.chatId !== operation.chatId) return;
        if (manual && manualBlock(true)) return;
        operation.headCheckpointId = reachable.root.headCheckpointId;
        const stored = await store.read(operation.chatId);
        if (!current(operation)) return;
        const previousAttemptTime = manual && retryable(stored.head, stored.batches) ? stored.head?.lastRun?.previousAttemptTime ?? null : stored.head?.lastAttemptTime ?? null;
        const prepared = await prepareTimeRequest(reachable, stored.batches, { lastAttemptTime: previousAttemptTime, allowInitialProjection: manual });
        const initialProjectionOpportunity = manual && prepared.initialProjectionPending && stored.head?.lastRun?.initialProjectionCheckedSignature !== prepared.signature;
        if (stored.head?.lastAttemptSignature === prepared.signature && !(manual && retryable(stored.head, stored.batches)) && !initialProjectionOpportunity) {
          if (stored.head.lastRun) last = { ...stored.head.lastRun, status: stored.head.lastRun.status === 'running' ? 'interrupted' : stored.head.lastRun.status, items: itemCount(stored.batches, reachable), requests: 0 };
          else last = { status: retryable(stored.head, stored.batches) ? 'interrupted' : 'completed', items: itemCount(stored.batches, reachable), requests: 0 };
          cacheItems(stored.batches, reachable); return;
        }
        if (!current(operation) || manual && manualBlock(true)) return;
        const run = { status: prepared.shouldRequest ? 'running' : 'empty', cutoffFloorId: prepared.cutoffFloorId, cutoffAssistantSeq: prepared.cutoffAssistantSeq, items: itemCount(stored.batches, reachable), previousAttemptTime };
        head = { schemaVersion: 1, chatId: operation.chatId, batchIds: stored.head?.batchIds ?? [], lastAttemptSignature: prepared.signature, lastAttemptTime: prepared.request.currentTime, lastRun: run };
        attempted = await store.putHead(operation.chatId, head, stored.revision, operation.controller.signal);
        if (!current(operation)) return;
        if (!prepared.shouldRequest) { last = { ...run, omitted: prepared.omitted, requests: 0 }; cacheItems(stored.batches, reachable); return; }
        operation.phase = prepared.request.trackedItems.length ? 'projecting' : 'collecting'; notify();
        const transportBudget = { remaining: 1, used: 0 };
        const result = await generateAnalysisTask({ systemPrompt: TIME_SYSTEM_PROMPT, taskMessages: [{ role: 'user', content: JSON.stringify(prepared.request) }],
          temperature: 0, includeCharacterCard: false, worldInfoSource: 'none', parseMode: 'semantic',
          transportBudget, transportRetries: 0, signal: operation.controller.signal });
        if (!current(operation)) return;
        const batch = await compileTimeResponse(result, prepared, stored.batches);
        batch.id = `v3-time-batch-${(await timeFingerprint([batch.id, attempted.revision])).slice(7, 39)}`;
        if (!current(operation)) return;
        const latest = await foundationStore.readRoot();
        if (!current(operation) || latest.data?.chatId !== operation.chatId || latest.data?.narrativeGeneration !== reachable.root.narrativeGeneration || latest.data?.headCheckpointId !== reachable.root.headCheckpointId) return;
        await store.putBatch(operation.chatId, batch, operation.controller.signal);
        if (!current(operation)) return;
        const completed = { ...run, status: batch.changes.length ? 'completed' : 'empty', items: itemCount([...stored.batches, batch], reachable),
          ...(initialProjectionOpportunity ? { initialProjectionCheckedSignature: prepared.signature } : {}) };
        await store.putHead(operation.chatId, { ...head, batchIds: [...head.batchIds, batch.id], lastRun: completed }, attempted.revision, operation.controller.signal);
        if (!current(operation)) return;
        cacheItems([...stored.batches, batch], reachable);
        last = { ...completed, omitted: prepared.omitted, requests: transportBudget.used || 1, api: sanitizeTaskMetadata(result?.taskMetadata) };
        projectionCache = null; onInvalidate();
      } catch (error) {
        if (current(operation)) {
          const message = publicErrorMessage({ code: error?.code, name: error?.name, status: error?.status }, { fallback: '时间事项处理或保存失败，请手动重试。' });
          const failure = { ...head?.lastRun, status: 'failed', message };
          last = { ...failure, persisted: false };
          statusKey = null;
          if (attempted && head) try {
            await store.putHead(operation.chatId, { ...head, lastRun: failure }, attempted.revision, operation.controller.signal);
            if (current(operation)) last = { ...failure, persisted: true };
          } catch { /* Keep the visible failure when its receipt cannot be saved. */ }
          logger?.warn?.('[qianqianjie] time analysis failed', { code: error?.code ?? error?.name ?? 'QQJ_TIME_FAILED' });
        }
      } finally {
        if (active === operation) active = null; notify();
        const next = pendingReceipt; pendingReceipt = null;
        if (!manual && next && current(operation) && next.headCheckpointId && next.headCheckpointId !== operation.headCheckpointId) void runBatch(next);
      }
    })();
    await operation.promise;
    return getState();
  }
  async function recallProjection(source) {
    if (!enabled() || source?.status !== 'ready' || identity().chatId !== source.chatId) return null;
    const token = epoch;
    const key = JSON.stringify([source.chatId, source.headCheckpointId, source.rootRevision, source.identityProjection]);
    if (projectionCache?.key === key) return projectionCache.value;
    try {
      const stored = await store.read(source.chatId);
      if (!enabled() || token !== epoch || identity().chatId !== source.chatId) return null;
      // Recall already validated this narrow source; no second foundation graph read is needed.
      const memories = source.floorMemories.map(memory => ({ ...memory, id: memory.floorMemoryId, recordStatus: 'active' }));
      const floors = (source.bodyMatchRefs?.length ? source.bodyMatchRefs : source.floorMemories).map(ref => ({ id: ref.floorId, assistantSeq: ref.assistantSeq }));
      const reachable = { floorMemories: memories, floors };
      const items = replayTimeBatches(stored.batches, reachable);
      const times = storyTimes(memories, floors);
      const projection = timeRecallProjection(items, source, times.get(floors.at(-1)?.id) ?? projectTime(''));
      const value = { ...projection, fingerprint: await timeFingerprint([stored.head?.batchIds ?? [], projection]) };
      if (!enabled() || token !== epoch || identity().chatId !== source.chatId) return null;
      projectionCache = { key, value };
      return value;
    } catch (error) {
      if (token === epoch) { last = { status: 'failed', message: '时间记录暂时无法读取；本轮继续使用原记忆召回。' }; notify(); }
      logger?.warn?.('[qianqianjie] time projection unavailable', { code: error?.code ?? error?.name ?? 'QQJ_TIME_READ_FAILED' });
      return null;
    }
  }
  function bind({ eventSource, eventTypes } = {}) {
    const event = eventTypes?.CHAT_CHANGED;
    if (event && eventSource?.on) eventSource.on(event, invalidate);
  }
  return Object.freeze({ runBatch, organize, refreshStatus, recallProjection, getState, invalidate, stop, bind,
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
