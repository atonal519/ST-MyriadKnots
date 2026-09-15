import { estimateRecallTokens } from './recall-selector.js';
import { TIME_HEAD_ID, TIME_SYSTEM_PROMPT, TIME_INPUT_TOKENS, prepareTimeBatch, compileTimeResponse, compileTimeEdit, replayTimeBatches, storyTimes, projectTime, timeRecallProjection, timeFingerprint, timeDistance, timeHours, validTimeProjection, timeBodyReads } from './time-engine.js';
import { projectRecallSource } from './recall-source.js';
import { sanitizeTaskMetadata } from './safe-metadata.js';
import { publicErrorMessage } from '../public-error.js';
import { newIdentityUuid } from '../identity.js';
import { readTimeBody, timeBodyStart, resolveTimeStart, planTimeBody } from './time-body.js';

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
    const normalized = retainedFloors.map(floor => ({ ...floor, canonicalFingerprint: floor.content?.canonicalFingerprint ?? floor.canonicalFingerprint,
      content: typeof floor.content === 'string' ? floor.content : floor.content?.canonicalContent }));
    const floors = new Set(normalized.map(floor => floor.id));
    const candidates = source.batches.filter(batch => floors.has(batch.cutoffFloorId) && batch.dependencies.every(ref => floors.has(ref.floorId)
      && (typeof ref.canonicalFingerprint !== 'string' || normalized.find(floor => floor.id === ref.floorId)?.canonicalFingerprint === ref.canonicalFingerprint)));
    const observations = new Map(), batches = [];
    for (const batch of candidates) {
      if ((batch.changes ?? []).some(item => item.previousObservationKey && observations.get(item.id) !== item.previousObservationKey)) continue;
      batches.push(batch); for (const item of batch.changes ?? []) observations.set(item.id, item.observationKey);
    }
    const ids = [];
    for (const batch of batches) {
      const copied = { ...structuredClone(batch), chatId: targetChatId };
      await putBatch(targetChatId, copied, signal); ids.push(copied.id);
    }
    const partial = batches.at(-1)?.status === 'partial' ? batches.at(-1) : source.head.lastRun?.status === 'partial' ? batches.findLast(batch => batch.status === 'partial') : null;
    await putHead(targetChatId, { schemaVersion: 1, chatId: targetChatId, batchIds: ids, ...(source.head.bodyStart?.floorId && floors.has(source.head.bodyStart.floorId) ? { bodyStart: source.head.bodyStart } : {}), lastAttemptSignature: batches.at(-1)?.signature ?? null, lastAttemptTime: batches.at(-1)?.currentTime ?? null,
      ...(partial ? { lastRun: { status: 'partial', itemErrors: partial.itemErrors, message: '已保留部分成功事项；仍有正文待补查，请手动继续。' } } : {}) }, 0, signal);
  }
  return Object.freeze({ read, putHead, putBatch, copyPrefix });
}

export async function prepareTimeRequest(reachable, batches = [], options = {}) {
  const prepared = await prepareTimeBatch(reachable, batches, options);
  const recall = await projectRecallSource(reachable, () => new Date());
  const subjects = new Set([...prepared.request.people.map(item => item.entityId), ...prepared.request.trackedItems.map(item => item.subjectEntityId)]);
  const linkFloors = new Set(prepared.request.observations.map(item => item.floorId));
  const linkedStates = new Set(prepared.trackedRecords.flatMap(item => (item.stateRefs ?? []).map(ref => ref.stateId)));
  prepared.request.currentStates = recall.currentState.filter(subject => subjects.has(subject.subjectEntityId)).flatMap(subject => ['core', 'adaptive', 'situational'].flatMap(layer => subject[layer].map(state => ({ ...state, subjectEntityId: subject.subjectEntityId, layer })))).filter(state => linkFloors.has(state.sourceFloorId) || linkedStates.has(state.stateId));
  prepared.request.chatId = reachable.root.chatId;
  while (estimateRecallTokens(JSON.stringify(prepared.request) + TIME_SYSTEM_PROMPT) > (options.inputTokens ?? TIME_INPUT_TOKENS) && prepared.request.currentStates.length) prepared.request.currentStates.pop();
  return prepared;
}

export function createTimeRuntime({ store, foundationStore, hostAdapter, session, generateTimeTask, sanitizerOptions = () => ({}), storyClockReferenceTags = () => 'Ti', newUuid = newIdentityUuid, getReachable = () => null, getMemoryState = () => null, isEnabled = () => false, onInvalidate = () => {}, logger = console }) {
  let epoch = 0, active = null, last = null, projectionCache = null, pendingReceipt = null, statusKey = null, statusRead = null, trackedItems = null, stoppedItems = null, itemsKey = null, coverage = null, historyAuthorization = null, automatic = null, startingController = null;
  const subscribers = new Set();
  const enabled = () => isEnabled() === true;
  const identity = () => { try { return session.identity(); } catch { return { chatId: null }; } };
  const current = operation => enabled() && operation.epoch === epoch && !operation.controller.signal.aborted && identity().chatId === operation.chatId;
  const manualBlock = (ignoreActive = false) => {
    if (!enabled()) return '时间推演已关闭。';
    if (active && !ignoreActive) return active.phase === 'saving' ? '正在保存时间事项。' : '正在整理时间事项。';
    const source = getReachable(), memory = getMemoryState();
    if (['needsReview', 'error'].includes(memory?.memorySyncStatus) || ['needsReview', 'error'].includes(memory?.status)) return '请先同步当前聊天记忆，再整理时间事项。';
    if (!source?.root || !['ready', 'needsReseal'].includes(source.status ?? 'ready') || source.root.chatId !== identity().chatId) return '请等待当前聊天记忆读取就绪。';
    return '';
  };
  const sourceKey = source => {
    let host; try { host = hostAdapter.snapshot(); } catch { return null; }
    return JSON.stringify([epoch, source?.root?.chatId, source?.root?.narrativeGeneration, (source?.floors ?? []).map(floor => floor.id),
      host.chatId, host.chat.map(message => [message.is_user, message.is_system, message.is_hidden, message.mes, message.swipe_id, message.swipes?.[message.swipe_id]])]);
  };
  async function bodySource(base = getReachable()) {
    const owner = identity(), host = hostAdapter.snapshot();
    if (!owner.chatId || owner.hostChatId && owner.hostChatId !== host.chatId || host.context?.chatMetadata?.qianqianjie?.chatId && host.context.chatMetadata.qianqianjie.chatId !== owner.chatId) throw new Error('当前聊天身份已变化。');
    return readTimeBody(base ?? { root: { chatId: owner.chatId }, floors: [], floorMemories: [], entities: [] }, host,
      { sanitizerOptions: sanitizerOptions(), storyClockReferenceTags: storyClockReferenceTags() });
  }
  const memoryNeedsSync = () => ['syncing', 'needsReview', 'error'].includes(getMemoryState()?.memorySyncStatus)
    || ['needsReview', 'error'].includes(getMemoryState()?.status);
  function cacheItems(batches, source) {
    const times = source.bodyTimes ?? storyTimes(source.floorMemories, source.floors), currentTime = times.get(source.floors.at(-1)?.id) ?? projectTime('');
    const names = new Map((source.entities ?? []).map(entity => [entity.id, entity.displayName]));
    const items = replayTimeBatches(batches, source).map(item => ({
      id: item.id, observationKey: item.observationKey, status: item.status, person: names.get(item.subjectEntityId) ?? item.subjectName ?? '人物未提供', label: item.label, type: item.type,
      observation: item.observation, observationTime: item.observationTime, occurrenceTime: item.occurrenceTime,
      dueTime: item.dueTime, periodDays: item.periodDays,
      elapsedDays: timeDistance(item.occurrenceTime, currentTime), elapsedHours: timeHours(item.occurrenceTime, currentTime),
      observationElapsedDays: timeDistance(item.observationTime, currentTime), observationElapsedHours: timeHours(item.observationTime, currentTime),
      projection: validTimeProjection(item, currentTime) ? item.projection.text : null,
    }));
    trackedItems = items.filter(item => item.status === 'active'); stoppedItems = items.filter(item => item.status !== 'active');
    itemsKey = sourceKey(source);
    statusKey = sourceKey(getReachable()) === itemsKey ? itemsKey : null;
    return trackedItems.length;
  }
  const getState = () => {
    const disabledReason = manualBlock();
    const canDisplay = enabled() && !memoryNeedsSync() && itemsKey === sourceKey(getReachable());
    return { status: active ? 'running' : enabled() ? memoryNeedsSync() ? 'waiting' : last?.status ?? 'idle' : 'disabled', phase: active?.phase ?? null, active: Boolean(active), last, coverage, progress: active?.progress ?? null, canOrganize: !disabledReason, disabledReason, trackedItems: canDisplay ? structuredClone(trackedItems) : null, stoppedItems: canDisplay ? structuredClone(stoppedItems) : null };
  };
  const notify = () => { const state = getState(); for (const listener of subscribers) try { listener(state); } catch { /* UI isolation */ } return state; };
  function invalidate() {
    epoch += 1; active?.controller.abort(); startingController?.abort(); startingController = null; automatic = null; last = null; projectionCache = null; pendingReceipt = null; statusKey = null; statusRead = null; trackedItems = null; stoppedItems = null; itemsKey = null; coverage = null; historyAuthorization = null; onInvalidate(); notify();
  }
  async function stop() {
    const pending = active?.promise;
    invalidate();
    if (pending) await pending;
  }
  const itemCount = (batches, reachable) => replayTimeBatches(batches, reachable).filter(item => item.status === 'active').length;
  const retryable = (head, batches) => ['failed', 'running', 'partial'].includes(head?.lastRun?.status) || Boolean(head?.lastAttemptSignature && !head.lastRun && head.lastAttemptSignature !== batches.at(-1)?.signature);
  async function refreshStatus({ force = false } = {}) {
    if (!enabled() || active) return notify();
    if (last?.status === 'failed' && last.persisted === false) return notify();
    const source = getReachable();
    if (!source?.root || !['ready', 'needsReseal'].includes(source.status ?? 'ready') || source.root.chatId !== identity().chatId) {
      trackedItems = null; stoppedItems = null; itemsKey = null; statusKey = null; last = { status: 'waiting', message: '等待当前聊天记忆读取。' }; return notify();
    }
    const key = sourceKey(source);
    if (['needsReview', 'error'].includes(getMemoryState()?.memorySyncStatus) || ['needsReview', 'error'].includes(getMemoryState()?.status)) { trackedItems = null; stoppedItems = null; itemsKey = null; statusKey = null; last = { status: 'waiting', message: '请先同步当前聊天记忆。' }; return notify(); }
    if (getMemoryState()?.memorySyncStatus === 'syncing') {
      if (itemsKey !== key) { trackedItems = null; stoppedItems = null; itemsKey = null; statusKey = null; }
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
        const projected = await bodySource(source);
        if (token !== epoch || sourceKey(getReachable()) !== key) return getState();
        coverage = planTimeBody(projected, stored.batches, { start: stored.head?.bodyStart });
        const run = stored.head?.lastRun, items = cacheItems(stored.batches, projected);
        if (run) last = { ...run, status: run.status === 'running' ? 'interrupted' : run.status, items, message: run.status === 'running' ? '上次整理未确认完成，可手动重试。' : run.message };
        else if (retryable(stored.head, stored.batches)) last = { status: 'interrupted', items, message: '上次整理未确认完成，可手动重试。' };
        else if (stored.batches.length) last = { status: 'completed', items, cutoffAssistantSeq: stored.batches.at(-1).cutoffAssistantSeq };
        else last = { status: 'idle', items: 0 };
        statusKey = key;
      } catch {
        if (token === epoch && !active && identity().chatId === chatId) { trackedItems = null; stoppedItems = null; itemsKey = null; last = { status: 'failed', reason: 'read', message: '时间记录读取失败，请稍后重新整理。' }; }
      } finally { if (statusRead === read) statusRead = null; }
      return notify();
    })();
    return read.promise;
  }
  async function prepareHistoryPlan() {
    if (manualBlock()) throw new Error(manualBlock());
    const token = epoch, source = await bodySource(), stored = await store.read(identity().chatId);
    if (token !== epoch || source.root.chatId !== identity().chatId) throw new Error('当前聊天已变化。');
    const plan = planTimeBody(source, stored.batches, { history: true, start: stored.head?.bodyStart });
    const prepared = await prepareTimeRequest(source, stored.batches, { allowInitialProjection: true });
    const supplement = !plan.groups.length && prepared.shouldRequest && (stored.head?.lastRun?.status === 'partial' || stored.head?.lastRun?.initialProjectionCheckedSignature !== prepared.signature);
    return { ...plan, groups: plan.groups.length ? plan.groups : supplement ? [[]] : [], batchCount: plan.batchCount || (supplement ? 1 : 0),
      apiCalls: plan.apiCalls || (supplement ? 1 : 0), currentWitness: source.bodyFloors.filter(body => body.floorId).at(-1), supplement, epoch: token, chatId: identity().chatId, narrativeGeneration: source.root.narrativeGeneration };
  }
  async function organize(plan) {
    if (!plan || plan.epoch !== epoch || plan.chatId !== identity().chatId || manualBlock()) return notify();
    return runPlan(plan, true);
  }
  async function editItem(itemId, fields, observationKey) {
    const blocked = manualBlock(); if (blocked) throw new Error(blocked);
    const operation = { epoch, chatId: identity().chatId, controller: new AbortController(), phase: 'saving', promise: null, manual: true };
    active = operation; notify();
    operation.promise = (async () => {
      const reachable = await bodySource();
      const key = sourceKey(reachable);
      const valid = () => current(operation) && sourceKey(getReachable()) === key && !manualBlock(true);
      if (!valid() || !reachable?.root || reachable.root.chatId !== operation.chatId || !reachable.floors?.length) throw new Error('当前聊天记忆已变化，请刷新事项后重试。');
      const stored = await store.read(operation.chatId);
      if (!valid()) throw new Error('当前聊天记忆已变化，请刷新事项后重试。');
      const item = replayTimeBatches(stored.batches, reachable).find(value => value.id === itemId);
      if (!item || item.observationKey !== observationKey) throw new Error('事项已变化或来源已失效，请取消编辑并刷新后重试。');
      const batch = await compileTimeEdit(item, fields, reachable, `v3-time-batch-${newUuid()}`);
      const root = await foundationStore.readRoot();
      if (!valid() || root.data?.chatId !== operation.chatId || root.data?.narrativeGeneration !== reachable.root.narrativeGeneration) throw new Error('当前聊天记忆已变化，请刷新事项后重试。');
      await store.putBatch(operation.chatId, batch, operation.controller.signal);
      if (!valid()) throw new Error('当前聊天记忆已变化，本次编辑未应用。');
      const lastRun = stored.head?.lastRun ? { ...stored.head.lastRun, items: itemCount([...stored.batches, batch], reachable) } : null;
      if (lastRun) delete lastRun.initialProjectionCheckedSignature;
      await store.putHead(operation.chatId, { ...stored.head, batchIds: [...stored.head.batchIds, batch.id], ...(lastRun ? { lastRun } : {}) }, stored.revision, operation.controller.signal);
      if (!valid()) throw new Error('当前聊天记忆已变化，本次编辑未应用到当前事项。');
      cacheItems([...stored.batches, batch], reachable); last = lastRun ? { ...last, ...lastRun } : last;
      projectionCache = null; onInvalidate(); return getState();
    })();
    try { await operation.promise; }
    finally { if (active === operation) active = null; notify(); }
    return getState();
  }
  async function ensureStart(source, stored, signal) {
    let start = stored.head?.bodyStart ?? timeBodyStart(source);
    const bound = resolveTimeStart(start, source);
    if (bound?.floorId && !start.floorId) start = { ...start, floorId: bound.floorId, awaitingFirst: undefined };
    if (JSON.stringify(start) !== JSON.stringify(stored.head?.bodyStart)) {
      const head = { schemaVersion: 1, chatId: source.root.chatId, batchIds: [], ...stored.head, bodyStart: start };
      const result = await store.putHead(source.root.chatId, head, stored.revision, signal);
      return { ...stored, head, revision: result.revision };
    }
    return stored;
  }
  async function validateBody(operation, source, fragments) {
    if (!current(operation)) return false;
    const root = await foundationStore.readRoot();
    if (!current(operation) || root.data?.chatId !== operation.chatId || root.data?.narrativeGeneration !== source.root.narrativeGeneration) return false;
    const latest = await bodySource();
    return current(operation) && fragments.every(fragment => latest.bodyFloors.some(body => body.floorId === fragment.floorId
      && body.canonicalFingerprint === fragment.canonicalFingerprint && (!fragment.timeSourceFingerprint || body.timeSourceFingerprint === fragment.timeSourceFingerprint) && (!fragment.rawFingerprint || body.rawFingerprint === fragment.rawFingerprint) && body.content.length === fragment.totalCharacters));
  }
  async function runPlan(plan, manual = false) {
    if (active || !enabled()) return getState();
    const operation = { epoch, chatId: plan.chatId, controller: new AbortController(), phase: 'preparing', promise: null, manual,
      requests: 0, progress: { completed: 0, total: plan.groups.length } };
    active = operation; notify();
    operation.promise = (async () => {
      try {
        let source = await bodySource(), stored = await store.read(operation.chatId);
        if (!current(operation) || source.root.narrativeGeneration !== plan.narrativeGeneration) return;
        stored = await ensureStart(source, stored, operation.controller.signal);
        for (const planned of plan.groups) {
          const reads = timeBodyReads(stored.batches, source);
          const fragments = planned.filter(fragment => {
            let cursor = fragment.from;
            for (const range of (reads.get(fragment.floorId) ?? []).sort((a,b) => a.from-b.from)) if (range.from <= cursor) cursor = Math.max(cursor, range.to);
            return cursor < fragment.to;
          });
          if (planned.length && !fragments.length) { operation.progress.completed += 1; notify(); continue; }
          const witnesses = fragments.length ? fragments : plan.currentWitness ? [{ ...plan.currentWitness, totalCharacters: plan.currentWitness.content.length }] : [];
          if (!witnesses.length) continue;
          if (!current(operation) || !await validateBody(operation, source, witnesses)) throw new Error('正文来源已变化，本批未应用。');
          const prepared = await prepareTimeRequest(source, stored.batches, { fragments, cutoffBody: !fragments.length ? source.bodyFloors.find(body => body.floorId === plan.currentWitness?.floorId) : null, allowInitialProjection: manual });
          if (!prepared.shouldRequest) continue;
          const run = { status: 'running', cutoffFloorId: prepared.cutoffFloorId, cutoffAssistantSeq: prepared.cutoffAssistantSeq, items: itemCount(stored.batches, source) };
          const head = { ...stored.head, lastAttemptSignature: prepared.signature, lastAttemptTime: prepared.request.currentTime, lastRun: run };
          const attempted = await store.putHead(operation.chatId, head, stored.revision, operation.controller.signal);
          stored = { ...stored, head, revision: attempted.revision };
          operation.phase = prepared.request.trackedItems.length ? 'projecting' : 'collecting'; notify();
          const transportBudget = { remaining: 1, used: 0 };
          operation.requests += 1;
          const result = await generateTimeTask({ systemPrompt: TIME_SYSTEM_PROMPT, taskMessages: [{ role: 'user', content: JSON.stringify(prepared.request) }],
            temperature: 0, includeCharacterCard: false, worldInfoSource: 'none', parseMode: 'semantic', transportBudget, transportRetries: 0, signal: operation.controller.signal });
          if (!current(operation)) return;
          operation.phase = 'saving'; notify();
          const batch = await compileTimeResponse(result, prepared, stored.batches);
          batch.id = `v3-time-batch-${newUuid()}`;
          if (!await validateBody(operation, source, [...witnesses, ...batch.dependencies.filter(ref => ref.canonicalFingerprint).map(ref => ({ floorId: ref.floorId, canonicalFingerprint: ref.canonicalFingerprint, totalCharacters: source.bodyFloors.find(body => body.floorId === ref.floorId)?.content.length }))])) throw new Error('正文来源已变化，本批未应用。');
          await store.putBatch(operation.chatId, batch, operation.controller.signal);
          if (!await validateBody(operation, source, witnesses)) throw new Error('正文来源已变化，本批未应用。');
          const completed = { ...run, status: batch.status === 'partial' ? 'partial' : batch.changes.length ? 'completed' : 'empty',
            ...(batch.itemErrors?.length ? { itemErrors: batch.itemErrors, message: `已保存 ${batch.changes.length} 项；${batch.itemErrors.map(item => `第${item.index}项：${item.reason}`).join('；')} 本批仍待补查，请手动继续。` } : {}), items: itemCount([...stored.batches, batch], source),
            ...(!fragments.length && batch.status !== 'partial' ? { initialProjectionCheckedSignature: prepared.signature } : {}) };
          const nextHead = { ...head, batchIds: [...head.batchIds, batch.id], lastRun: completed };
          const saved = await store.putHead(operation.chatId, nextHead, stored.revision, operation.controller.signal);
          if (!current(operation)) return;
          stored = { head: nextHead, revision: saved.revision, batches: [...stored.batches, batch] };
          if (batch.status !== 'partial') operation.progress.completed += 1;
          cacheItems(stored.batches, source); coverage = planTimeBody(source, stored.batches, { start: stored.head.bodyStart });
          last = { ...completed, requests: operation.requests, api: sanitizeTaskMetadata(result?.taskMetadata) };
          projectionCache = null; onInvalidate(); notify();
          if (batch.status === 'partial') break;
        }
        if (historyAuthorization?.chatId === operation.chatId) {
          const remaining = planTimeBody({ ...source, bodyFloors: source.bodyFloors.filter(body => body.assistantSeq <= historyAuthorization.through) }, stored.batches, { history: true });
          if (!remaining.groups.length && !remaining.pendingFloors) historyAuthorization = null;
        }
      } catch (error) {
        if (current(operation)) {
          const message = error?.code === 'QQJ_TIME_INVALID' && error.itemErrors?.length ? `${error.itemErrors.map(item => `第${item.index}项：${item.reason}`).join('；')} 本批未保存，可手动补查。` : publicErrorMessage({ code: error?.code, name: error?.name, status: error?.status }, { fallback: '本批时间正文处理失败；成功批次已保留，可补查剩余正文。' });
          last = { status: 'failed', message, persisted: false }; statusKey = null;
          try {
            const latest = await store.read(operation.chatId);
            if (current(operation) && latest.head) { await store.putHead(operation.chatId, { ...latest.head, lastRun: { ...latest.head.lastRun, status: 'failed', message } }, latest.revision, operation.controller.signal); last.persisted = true; }
          } catch { /* Keep the visible failure if its status could not be saved. */ }
          notify();
        }
      } finally { if (active === operation) active = null; notify(); if (manual && pendingReceipt) { const next = pendingReceipt; pendingReceipt = null; void runBatch(next); } }
    })();
    await operation.promise; return getState();
  }
  function runBatch(receipt = { chatId: identity().chatId }) {
    if (active) { pendingReceipt = receipt; return Promise.resolve(getState()); }
    if (automatic) { pendingReceipt = receipt; return automatic; }
    const pending = runAutomatic(receipt); automatic = pending;
    return pending.finally(() => { if (automatic === pending) { automatic = null; const next = pendingReceipt; pendingReceipt = null; if (next && enabled()) void runBatch(next); } });
  }
  async function runAutomatic(receipt) {
    if (!enabled() || active || receipt?.chatId !== identity().chatId) return getState();
    const token = epoch, controller = new AbortController(); startingController = controller;
    try {
      const source = await bodySource();
      let stored = await store.read(identity().chatId);
      if (token !== epoch || !enabled() || source.root.chatId !== identity().chatId) return getState();
      stored = await ensureStart(source, stored, controller.signal);
      if (manualBlock() || stored.head?.lastRun?.status === 'partial') return refreshStatus();
      let history = historyAuthorization?.chatId === identity().chatId;
      if (history) {
        const remaining = planTimeBody({ ...source, bodyFloors: source.bodyFloors.filter(body => body.assistantSeq <= historyAuthorization.through) }, stored.batches, { history: true });
        if (!remaining.groups.length && !remaining.pendingFloors) { historyAuthorization = null; history = false; }
      }
      const plan = planTimeBody(source, stored.batches, { start: stored.head.bodyStart, history });
      if (history) plan.groups = plan.groups.map(group => group.filter(row => row.assistantSeq <= historyAuthorization.through)).filter(group => group.length);
      if (plan.groups.length) {
        const prepared = await prepareTimeRequest(source, stored.batches, { fragments: plan.groups[0] });
        if (stored.head.lastAttemptSignature === prepared.signature && ['running', 'failed'].includes(stored.head.lastRun?.status)) return refreshStatus();
      }
      if (plan.groups.length) return runPlan({ ...plan, chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration }, false);
      cacheItems(stored.batches, source); coverage = plan; return notify();
    } catch { return getState(); } finally { if (startingController === controller) startingController = null; }
  }
  async function authorizeHistory() {
    const token = epoch, chatId = identity().chatId;
    const source = await bodySource();
    if (token !== epoch || identity().chatId !== chatId) return getState();
    historyAuthorization = { chatId: identity().chatId, through: source.bodyFloors.at(-1)?.assistantSeq ?? 0 };
    return runBatch();
  }
  async function recallProjection(source) {
    if (!enabled() || source?.status !== 'ready' || identity().chatId !== source.chatId) return null;
    const token = epoch;
    const key = JSON.stringify([source.chatId, source.headCheckpointId, source.rootRevision, source.identityProjection, sourceKey(getReachable())]);
    if (projectionCache?.key === key) return projectionCache.value;
    try {
      const stored = await store.read(source.chatId);
      if (!enabled() || token !== epoch || identity().chatId !== source.chatId) return null;
      // Recall already validated this narrow source; no second foundation graph read is needed.
      const memories = source.floorMemories.map(memory => ({ ...memory, id: memory.floorMemoryId, recordStatus: 'active' }));
      const floors = (source.bodyMatchRefs?.length ? source.bodyMatchRefs : source.floorMemories).map(ref => ({ id: ref.floorId, assistantSeq: ref.assistantSeq }));
      const allowed = new Set(floors.map(floor => floor.id));
      const cached = getReachable();
      if (cached?.root?.chatId !== source.chatId) return null;
      const reachable = await bodySource({ root: cached.root, floorMemories: memories,
        floors: cached.floors.filter(floor => allowed.has(floor.id)), entities: [] });
      const items = replayTimeBatches(stored.batches, reachable);
      const times = reachable.bodyTimes;
      const projection = timeRecallProjection(items, source, times.get(reachable.floors.at(-1)?.id) ?? projectTime(''));
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
  function bind({ eventSource, eventTypes, foundationRuntime } = {}) {
    const event = eventTypes?.CHAT_CHANGED;
    if (event && eventSource?.on) eventSource.on(event, invalidate);
    foundationRuntime?.subscribe?.(state => { if (['ready', 'needsReseal'].includes(state?.status)) void runBatch(); });
    void runBatch();
  }
  return Object.freeze({ runBatch, prepareHistoryPlan, organize, authorizeHistory, editItem, refreshStatus, recallProjection, getState, invalidate, stop, bind,
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
