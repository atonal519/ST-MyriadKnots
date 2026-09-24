import { estimateRecallTokens } from './recall-selector.js';
import { TIME_HEAD_ID, TIME_INPUT_TOKENS, prepareTimeBatch, compileTimeResponse, compileTimeEdits, replayTimeBatches, sanitizeTimeBatchForDeletion, sanitizeTimeHeadForDeletion, storyTimes, projectTime, effectiveTime, timeRecallProjection, timeFingerprint, timeDistance, timeHours, validTimeProjection, timeBodyReads, timeItemFailures } from './time-engine.js';
import { projectRecallSource } from './recall-source.js';
import { sanitizeTaskMetadata } from './safe-metadata.js';
import { publicErrorMessage } from '../public-error.js';
import { newIdentityUuid } from '../identity.js';
import { readRecentBodyStoryTimes, readTimeBody, timeBodyStart, resolveTimeStart, planTimeBody } from './time-body.js';
import { ANNUAL_SETTING_SYSTEM_PROMPT, buildAnnualSettingSources, compileAnnualSettingResponse, projectAnnualSettings } from './time-annual-setting.js';
import { prepareQianshiCandidates, projectQianshiGraph } from './qianshi-domain.js';

export function createTimeStore({ client }) {
  const BATCH_READ_CONCURRENCY = 16;
  const collection = chatId => `chat-${chatId}`;
  const readRecord = async (chatId, id) => {
    try { return await client.get(collection(chatId), id); }
    catch (error) { if (error?.status === 404) return { data: null, revision: 0 }; throw error; }
  };
  async function read(chatId) {
    const head = await readRecord(chatId, TIME_HEAD_ID);
    if (!head.data) return { head: null, revision: 0, batches: [] };
    if (head.data.schemaVersion !== 1 || head.data.chatId !== chatId || !Array.isArray(head.data.batchIds)) throw new Error('时间记录头无效。');
    const batches = [], batchRecords = [];
    const envelopes = new Array(head.data.batchIds.length);
    let cursor = 0, firstError = null;
    async function worker() {
      while (!firstError) {
        const index = cursor++;
        if (index >= head.data.batchIds.length) return;
        try { envelopes[index] = await readRecord(chatId, head.data.batchIds[index]); }
        catch (error) { firstError ??= error; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(BATCH_READ_CONCURRENCY, envelopes.length) }, () => worker()));
    if (firstError) throw firstError;
    for (const [index, envelope] of envelopes.entries()) {
      if (!envelope.data || envelope.data.chatId !== chatId || envelope.data.schemaVersion !== 1) throw new Error('时间增量记录无效。');
      batches.push(envelope.data); batchRecords.push({ id: head.data.batchIds[index], revision: envelope.revision, data: envelope.data });
    }
    return { head: head.data, revision: head.revision, batches, batchRecords };
  }
  const putHead = (chatId, data, revision, signal) => client.put(collection(chatId), TIME_HEAD_ID, data, revision, { signal });
  const putBatch = (chatId, data, signal) => client.put(collection(chatId), data.id, data, 0, { signal });
  async function requirePermanentDelete() {
    let health;
    try { health = await client.health?.(); }
    catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      const error = new Error('批量永久删除需要更新白鳥后端；本次没有改动时间记录。');
      error.code = 'QQJ_TIME_PERMANENT_DELETE_UNAVAILABLE'; error.cause = cause; throw error;
    }
    if (health?.capabilities?.permanentDelete !== true || typeof client.removePermanent !== 'function') {
      const error = new Error('批量永久删除需要更新白鳥后端；本次没有改动时间记录。');
      error.code = 'QQJ_TIME_PERMANENT_DELETE_UNAVAILABLE'; throw error;
    }
  }
  const removePermanent = (chatId, id, revision, signal) => client.removePermanent(collection(chatId), id, revision, { signal });
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
      ...(source.head.currentReviewAttempt && floors.has(source.head.currentReviewAttempt.cutoffFloorId) && batches.some(batch => batch.currentReview) ? { currentReviewAttempt: source.head.currentReviewAttempt } : {}),
      ...(partial ? { lastRun: { status: 'partial', cutoffFloorId: partial.cutoffFloorId, cutoffAssistantSeq: partial.cutoffAssistantSeq, itemErrors: partial.itemErrors, message: '已保留部分成功事项；失败项可在后续新正文或手动补查时再试。' } } : {}) }, 0, signal);
  }
  return Object.freeze({ read, putHead, putBatch, requirePermanentDelete, removePermanent, copyPrefix });
}

export async function prepareTimeRequest(reachable, batches = [], options = {}) {
  const prepared = await prepareTimeBatch(reachable, batches, options);
  const recall = await projectRecallSource(reachable, () => new Date());
  const subjects = new Set([...prepared.request.people.map(item => item.entityId), ...prepared.request.trackedItems.map(item => item.subjectEntityId)]);
  const linkFloors = new Set(prepared.request.observations.map(item => item.floorId));
  const linkedStates = new Set(prepared.trackedRecords.flatMap(item => (item.stateRefs ?? []).map(ref => ref.stateId)));
  prepared.request.currentStates = recall.currentState.filter(subject => subjects.has(subject.subjectEntityId)).flatMap(subject => ['core', 'adaptive', 'situational'].flatMap(layer => subject[layer].map(state => ({ ...state, subjectEntityId: subject.subjectEntityId, layer })))).filter(state => linkFloors.has(state.sourceFloorId) || linkedStates.has(state.stateId));
  try {
    const qianshi = prepareQianshiCandidates(reachable, { canonicalContent: [
      ...prepared.request.observations.map(item => item.description),
      ...prepared.request.trackedItems.map(item => `${item.label} ${item.observation}`),
    ].join('\n'), identityProjection: reachable.identityProjection });
    prepared.request.qianshiCandidates = [...qianshi.request];
    prepared.qianshiCandidateBindings = [...qianshi.bindings];
  } catch {
    // 千事关联是可选输入；派生图异常不能阻断正文时间整理。
    prepared.request.qianshiCandidates = [];
    prepared.qianshiCandidateBindings = [];
  }
  prepared.request.chatId = reachable.root.chatId;
  const exposeExistingQianshiLinks = () => {
    const keyByRef = new Map(prepared.qianshiCandidateBindings.map(item => [`${item.matterId}|${item.originEventId}`, item.key]));
    prepared.request.trackedItems.forEach((item, index) => {
      const ref = prepared.trackedRecords[index]?.qianshiRef;
      const key = ref ? keyByRef.get(`${ref.matterId}|${ref.originEventId}`) : null;
      if (key) item.qianshiCandidateKey = key; else delete item.qianshiCandidateKey;
    });
  };
  exposeExistingQianshiLinks();
  while (estimateRecallTokens(JSON.stringify(prepared.request) + prepared.systemPrompt) > (options.inputTokens ?? TIME_INPUT_TOKENS) && prepared.request.qianshiCandidates.length) {
    prepared.request.qianshiCandidates.pop(); prepared.qianshiCandidateBindings.pop(); exposeExistingQianshiLinks();
  }
  while (estimateRecallTokens(JSON.stringify(prepared.request) + prepared.systemPrompt) > (options.inputTokens ?? TIME_INPUT_TOKENS) && prepared.request.currentStates.length) prepared.request.currentStates.pop();
  return prepared;
}

export function createTimeRuntime({ store, foundationStore, hostAdapter, session, generateTimeTask, annualSettingsProvider = () => ({ ready: false }), sanitizerOptions = () => ({}), storyClockReferenceTags = () => '', newUuid = newIdentityUuid, getReachable = () => null, getMemoryState = () => null, isEnabled = () => false, onInvalidate = () => {}, logger = console }) {
  let epoch = 0, active = null, last = null, pendingDeletionCount = 0, projectionCache = null, pendingReceipt = null, statusKey = null, statusRead = null, trackedItems = null, stoppedItems = null, annualItems = null, itemsKey = null, coverage = null, historyAuthorization = null, automatic = null, startingController = null;
  const subscribers = new Set();
  const enabled = () => isEnabled() === true;
  const identity = () => { try { return session.identity(); } catch { return { chatId: null }; } };
  const current = operation => enabled() && operation.epoch === epoch && !operation.controller.signal.aborted && identity().chatId === operation.chatId;
  const bodyAttempt = (fragments, prepared = null) => ({
    cutoffFloorId: prepared?.cutoffFloorId ?? fragments.at(-1)?.floorId ?? null,
    cutoffAssistantSeq: prepared?.cutoffAssistantSeq ?? fragments.at(-1)?.assistantSeq ?? 0,
    ...(prepared ? { sourceKeys: prepared.sourceKeys } : {}),
    fragments: fragments.map(({ floorId, canonicalFingerprint, timeSourceFingerprint, from, to, totalCharacters }) => ({ floorId, canonicalFingerprint, timeSourceFingerprint, from, to, totalCharacters })),
  });
  const sameBodyAttempt = (attempt, fragments, prepared = null) => Array.isArray(attempt?.fragments)
    ? JSON.stringify(attempt.fragments) === JSON.stringify(bodyAttempt(fragments).fragments)
    : prepared && prepared.cutoffFloorId === attempt?.cutoffFloorId && JSON.stringify(prepared.sourceKeys) === JSON.stringify(attempt?.sourceKeys);
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
      host.chatId, host.chat.map(message => [message.is_user, message.is_system, message.is_hidden, message.hidden, message.mes, message.swipe_id, message.swipes?.[Number.isSafeInteger(message.swipe_id) ? message.swipe_id : 0]])]);
  };
  async function bodySource(base = getReachable()) {
    const owner = identity(), host = hostAdapter.snapshot();
    if (!owner.chatId || owner.hostChatId && owner.hostChatId !== host.chatId || host.context?.chatMetadata?.qianqianjie?.chatId && host.context.chatMetadata.qianqianjie.chatId !== owner.chatId) throw new Error('当前聊天身份已变化。');
    return readTimeBody(base ?? { root: { chatId: owner.chatId }, floors: [], floorMemories: [], entities: [] }, host,
      { sanitizerOptions: sanitizerOptions(), storyClockReferenceTags: storyClockReferenceTags() });
  }
  async function annualSnapshot() {
    const provided = await annualSettingsProvider();
    if (!provided?.ready) return { ready: false, sources: [], fingerprint: null };
    const sources = buildAnnualSettingSources(provided).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
    for (const source of sources) source.fingerprint = await timeFingerprint([source.sourceKey, source.subjectEntityId, source.subjectName, source.field, source.content]);
    return { ready: true, sources, fingerprint: await timeFingerprint(sources.map(source => [source.sourceKey, source.fingerprint])) };
  }
  const currentAnnualRecords = (head, snapshot) => snapshot?.ready ? snapshot.sources.flatMap(source => {
    const record = head?.settingAnnualSources?.[source.sourceKey];
    return record?.fingerprint === source.fingerprint ? [record] : [];
  }) : [];
  async function prepareAnnualSetting(snapshot, head, triggerFingerprint, manual = false) {
    if (!snapshot.ready) return { ready: false, shouldRequest: false, removed: [] };
    const stored = head?.settingAnnualSources ?? {};
    const removed = Object.keys(stored).filter(key => !snapshot.sources.some(source => source.sourceKey === key));
    const changed = snapshot.sources.filter(source => stored[source.sourceKey]?.fingerprint !== source.fingerprint);
    const attempt = head?.settingAttempt;
    if (!manual && attempt?.contentFingerprint === snapshot.fingerprint && attempt.triggerFingerprint === triggerFingerprint && ['running', 'failed', 'partial'].includes(attempt.status)) {
      return { ready: true, shouldRequest: false, removed, suppressed: true, pending: changed.length };
    }
    const sources = [];
    for (const source of changed) {
      const candidate = [...sources, { ...source, id: `S${sources.length + 1}` }];
      if (estimateRecallTokens(ANNUAL_SETTING_SYSTEM_PROMPT + JSON.stringify({ task: 'annual-settings', sources: candidate.map(({ id, subjectName, field, content }) => ({ sourceId: id, person: subjectName, field, content })) })) > TIME_INPUT_TOKENS) break;
      sources.push(candidate.at(-1));
    }
    return { ready: true, removed, sources, pending: changed.length - sources.length, shouldRequest: sources.length > 0,
      request: { task: 'annual-settings', sources: sources.map(({ id, subjectName, field, content }) => ({ sourceId: id, person: subjectName, field, content })) } };
  }
  const memoryNeedsSync = () => ['syncing', 'needsReview', 'error'].includes(getMemoryState()?.memorySyncStatus)
    || ['needsReview', 'error'].includes(getMemoryState()?.status);
  function cacheItems(batches, source, annualRecords = []) {
    const times = source.bodyTimes ?? storyTimes(source.floorMemories, source.floors), currentTime = times.get(source.floors.at(-1)?.id) ?? projectTime('');
    const reviewBatch = batches.findLast(batch => batch.currentReview);
    const reviewCurrent = reviewBatch && JSON.stringify(reviewBatch.currentTime) === JSON.stringify(currentTime);
    const selectedIds = new Set(reviewBatch?.currentReview?.selectedItemIds ?? []);
    const answeredIds = new Set(reviewBatch?.changes?.map(item => item.id) ?? []);
    const failures = timeItemFailures(batches, source);
    const names = new Map((source.entities ?? []).map(entity => [entity.id, entity.displayName]));
    const items = replayTimeBatches(batches, source).map(item => ({
      id: item.id, mergedInto: item.mergedInto ?? null, mergeDescription: item.mergeDescription ?? null, retirementReason: item.retirementReason ?? null, observationKey: item.observationKey, status: item.status, person: names.get(item.subjectEntityId) ?? item.subjectName ?? '人物未提供', label: item.label, type: item.type,
      observation: item.observation, observationTime: effectiveTime(item.observationTime), occurrenceTime: effectiveTime(item.occurrenceTime),
      dueTime: effectiveTime(item.dueTime), periodDays: item.periodDays,
      elapsedDays: timeDistance(item.occurrenceTime, currentTime), elapsedHours: timeHours(item.occurrenceTime, currentTime),
      observationElapsedDays: timeDistance(item.observationTime, currentTime), observationElapsedHours: timeHours(item.observationTime, currentTime),
      projection: validTimeProjection(item, currentTime) ? item.projection.text : null,
      oldProjection: item.projection?.observationKey === item.observationKey && !validTimeProjection(item, currentTime) ? { text: item.projection.text, applicableTime: item.projection.applicableTime } : null,
      assessmentReason: item.reviewAssessment?.observationKey === item.observationKey && JSON.stringify(item.reviewAssessment.applicableTime) === JSON.stringify(currentTime) ? item.reviewAssessment.reason : null,
      failureReason: item.status !== 'cancelled' ? failures.get(item.id) ?? null : null,
      reviewStatus: reviewCurrent && item.status === 'active' ? !selectedIds.has(item.id) ? 'omitted' : !answeredIds.has(item.id) ? 'unanswered' : null : null,
    }));
    trackedItems = items.filter(item => item.status === 'active'); stoppedItems = items.filter(item => item.status !== 'active');
    annualItems = projectAnnualSettings(annualRecords, currentTime).items;
    itemsKey = sourceKey(source);
    statusKey = sourceKey(getReachable()) === itemsKey ? itemsKey : null;
    return trackedItems.length;
  }
  const getState = () => {
    const disabledReason = manualBlock();
    const canDisplay = enabled() && !memoryNeedsSync() && itemsKey === sourceKey(getReachable());
    return { status: active ? 'running' : enabled() ? memoryNeedsSync() ? 'waiting' : last?.status ?? 'idle' : 'disabled', phase: active?.phase ?? null, active: Boolean(active), last, coverage, progress: active?.progress ?? null, canOrganize: !disabledReason, disabledReason, pendingDeletionCount, trackedItems: canDisplay ? structuredClone(trackedItems) : null, stoppedItems: canDisplay ? structuredClone(stoppedItems) : null, annualItems: canDisplay ? structuredClone(annualItems) : null };
  };
  const notify = () => { const state = getState(); for (const listener of subscribers) try { listener(state); } catch { /* UI isolation */ } return state; };
  function invalidate() {
    epoch += 1; active?.controller.abort(); startingController?.abort(); startingController = null; automatic = null; last = null; pendingDeletionCount = 0; projectionCache = null; pendingReceipt = null; statusKey = null; statusRead = null; trackedItems = null; stoppedItems = null; annualItems = null; itemsKey = null; coverage = null; historyAuthorization = null; onInvalidate(); notify();
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
    const bodyKey = sourceKey(source);
    if (['needsReview', 'error'].includes(getMemoryState()?.memorySyncStatus) || ['needsReview', 'error'].includes(getMemoryState()?.status)) { trackedItems = null; stoppedItems = null; itemsKey = null; statusKey = null; last = { status: 'waiting', message: '请先同步当前聊天记忆。' }; return notify(); }
    if (getMemoryState()?.memorySyncStatus === 'syncing') {
      if (itemsKey !== bodyKey) { trackedItems = null; stoppedItems = null; itemsKey = null; statusKey = null; }
      return notify();
    }
    const annual = await annualSnapshot();
    const key = JSON.stringify([bodyKey, annual.ready, annual.fingerprint]);
    if (statusRead?.key === key) return statusRead.promise;
    if (!force && statusKey === key) return notify();
    const token = epoch, chatId = source.root.chatId;
    const read = { key, promise: null }; statusRead = read;
    read.promise = (async () => {
      try {
        const stored = await store.read(chatId);
        if (token !== epoch || !enabled() || active || identity().chatId !== chatId || sourceKey(getReachable()) !== bodyKey || memoryNeedsSync()) return getState();
        pendingDeletionCount = stored.head?.pendingDeletionRecords?.length ?? 0;
        const projected = await bodySource(source), freshAnnual = await annualSnapshot();
        if (token !== epoch || sourceKey(getReachable()) !== bodyKey || freshAnnual.ready !== annual.ready || freshAnnual.fingerprint !== annual.fingerprint) return getState();
        coverage = planTimeBody(projected, stored.batches, { start: stored.head?.bodyStart });
        const run = stored.head?.lastRun, items = cacheItems(stored.batches, projected, currentAnnualRecords(stored.head, annual));
        if (run) last = { ...run, status: run.status === 'running' ? 'interrupted' : run.status, items, message: run.status === 'running' ? '上次整理未确认完成，可手动重试。' : run.message };
        else if (retryable(stored.head, stored.batches)) last = { status: 'interrupted', items, message: '上次整理未确认完成，可手动重试。' };
        else if (stored.batches.length) last = { status: 'completed', items, cutoffAssistantSeq: stored.batches.at(-1).cutoffAssistantSeq };
        else last = { status: 'idle', items: 0 };
        if (pendingDeletionCount) last = { ...last, status: 'partial', pendingDeletionCount,
          message: `永久删除尚有 ${pendingDeletionCount} 份旧历史记录未清理；可在停止项中继续，不会重新调用模型。` };
        if (stored.head?.settingAttempt?.contentFingerprint === annual.fingerprint && ['running', 'failed', 'partial'].includes(stored.head.settingAttempt.status)) {
          const message = stored.head.settingAttempt.status === 'running' ? '上次年度设定补读未确认完成，可手动补查。' : stored.head.settingAttempt.status === 'failed'
            ? '年度设定补读失败；可在下次新正文或手动补查时重试。' : `仍有 ${stored.head.settingAttempt.pending ?? 0} 个年度设定来源待后续新正文或手动补查。`;
          last = { ...last, status: stored.head.settingAttempt.status === 'running' ? 'interrupted' : last.status === 'failed' ? 'failed' : 'partial', message: [last.message, message].filter(Boolean).join(' ') };
        }
        statusKey = key;
      } catch {
        if (token === epoch && !active && identity().chatId === chatId) { trackedItems = null; stoppedItems = null; annualItems = null; itemsKey = null; last = { status: 'failed', reason: 'read', message: '时间记录读取失败，请稍后重新整理。' }; }
      } finally { if (statusRead === read) statusRead = null; }
      return notify();
    })();
    return read.promise;
  }
  const reviewScopeKey = (source, witness) => timeFingerprint([source.root.narrativeGeneration, witness.floorId, witness.canonicalFingerprint, witness.timeSourceFingerprint]);
  async function prepareHistoryPlan() {
    if (manualBlock()) throw new Error(manualBlock());
    const token = epoch, source = await bodySource(), stored = await store.read(identity().chatId);
    if (token !== epoch || source.root.chatId !== identity().chatId) throw new Error('当前聊天已变化。');
    const plan = planTimeBody(source, stored.batches, { history: true, start: stored.head?.bodyStart });
    const currentWitness = source.bodyFloors.filter(body => body.floorId).at(-1);
    const prepared = await prepareTimeRequest(source, stored.batches, { cutoffBody: currentWitness, allowInitialProjection: true, currentReview: true });
    const settingSnapshot = await annualSnapshot();
    const triggerFingerprint = await timeFingerprint([source.root.narrativeGeneration, currentWitness?.floorId ?? null, currentWitness?.canonicalFingerprint ?? null]);
    const annualSetting = await prepareAnnualSetting(settingSnapshot, stored.head, triggerFingerprint, true);
    const sameAttempt = currentWitness && stored.head?.currentReviewAttempt?.scopeKey === await reviewScopeKey(source, currentWitness);
    const retryCurrentReview = Boolean(sameAttempt && ['running', 'failed', 'partial'].includes(stored.head.currentReviewAttempt.status));
    const currentReview = Boolean(currentWitness && (plan.groups.length ? !sameAttempt : prepared.shouldRequest && (!sameAttempt || retryCurrentReview || stored.head.currentReviewAttempt.signature !== prepared.signature)));
    const supplement = !plan.groups.length && currentReview;
    return { ...plan, groups: plan.groups.length ? plan.groups : supplement ? [[]] : [], bodyBatchCount: plan.batchCount,
      batchCount: plan.batchCount + Number(currentReview) + Number(annualSetting.shouldRequest), apiCalls: plan.apiCalls + Number(currentReview) + Number(annualSetting.shouldRequest),
      currentWitness, currentReview, retryCurrentReview, reviewAuthorization: currentReview ? newUuid() : null, annualSetting: { ...annualSetting, fingerprint: settingSnapshot.fingerprint, triggerFingerprint }, supplement,
      epoch: token, chatId: identity().chatId, narrativeGeneration: source.root.narrativeGeneration };
  }
  async function organize(plan) {
    if (!plan || plan.epoch !== epoch || plan.chatId !== identity().chatId || manualBlock()) return notify();
    return runPlan(plan, true);
  }
  async function editItems(edits) {
    const blocked = manualBlock(); if (blocked) throw new Error(blocked);
    if (!Array.isArray(edits) || !edits.length || new Set(edits.map(edit => edit?.itemId)).size !== edits.length) throw new Error('请选择有效且不重复的时间事项。');
    const operation = { epoch, chatId: identity().chatId, controller: new AbortController(), phase: 'saving', promise: null, manual: true };
    active = operation; notify();
    operation.promise = (async () => {
      const reachable = await bodySource();
      const key = sourceKey(reachable);
      const valid = () => current(operation) && sourceKey(getReachable()) === key && !manualBlock(true);
      if (!valid() || !reachable?.root || reachable.root.chatId !== operation.chatId || !reachable.floors?.length) throw new Error('当前聊天记忆已变化，请刷新事项后重试。');
      const stored = await store.read(operation.chatId);
      if (!valid()) throw new Error('当前聊天记忆已变化，请刷新事项后重试。');
      const currentItems = replayTimeBatches(stored.batches, reachable);
      for (const edit of edits) {
        const item = currentItems.find(value => value.id === edit?.itemId);
        if (!item || item.observationKey !== edit.observationKey) throw new Error('事项已变化或来源已失效，请取消编辑并刷新后重试。');
      }
      const batch = await compileTimeEdits(edits, reachable, `v3-time-batch-${newUuid()}`, currentItems);
      const root = await foundationStore.readRoot();
      if (!valid() || root.data?.chatId !== operation.chatId || root.data?.narrativeGeneration !== reachable.root.narrativeGeneration) throw new Error('当前聊天记忆已变化，请刷新事项后重试。');
      await store.putBatch(operation.chatId, batch, operation.controller.signal);
      if (!valid()) throw new Error('当前聊天记忆已变化，本次编辑未应用。');
      const lastRun = stored.head?.lastRun ? { ...stored.head.lastRun, items: itemCount([...stored.batches, batch], reachable) } : null;
      if (lastRun) delete lastRun.initialProjectionCheckedSignature;
      const priorPartial = lastRun?.currentReview ? stored.batches.findLast(value => value.status === 'partial' && value.currentReview && value.signature === stored.head.lastAttemptSignature) : null;
      const afterItems = replayTimeBatches([...stored.batches, batch], reachable);
      const unresolvedIds = new Set((priorPartial?.itemErrors ?? []).flatMap(error => error.itemIds ?? []));
      if (priorPartial) {
        const answered = new Set(priorPartial.changes?.map(value => value.id) ?? []);
        for (const id of priorPartial.currentReview.selectedItemIds ?? []) if (!answered.has(id)) unresolvedIds.add(id);
      }
      const hasUnlocated = Boolean(priorPartial?.itemErrors?.some(error => !error.itemIds?.length));
      const unresolved = [...unresolvedIds].some(id => afterItems.find(value => value.id === id)?.status !== 'cancelled');
      const resolvedByRemoval = lastRun?.status === 'partial' && priorPartial && !hasUnlocated && !unresolved;
      if (resolvedByRemoval) Object.assign(lastRun, { status: 'completed', message: '本次未完成事项已移除；原内容未记作评估成功。' });
      const currentReviewAttempt = resolvedByRemoval && stored.head?.currentReviewAttempt?.status === 'partial'
        ? { ...stored.head.currentReviewAttempt, status: 'resolved' } : stored.head?.currentReviewAttempt;
      const nextHead = { ...stored.head, ...(currentReviewAttempt ? { currentReviewAttempt } : {}), batchIds: [...stored.head.batchIds, batch.id], ...(lastRun ? { lastRun } : {}) };
      await store.putHead(operation.chatId, nextHead, stored.revision, operation.controller.signal);
      if (!valid()) throw new Error('当前聊天记忆已变化，本次编辑未应用到当前事项。');
      const freshAnnual = await annualSnapshot();
      if (!valid()) throw new Error('当前聊天记忆已变化，本次编辑未应用到当前事项。');
      cacheItems([...stored.batches, batch], reachable, currentAnnualRecords(nextHead, freshAnnual)); last = lastRun ? { ...last, ...lastRun } : last;
      projectionCache = null; onInvalidate(); return getState();
    })();
    try { await operation.promise; }
    finally { if (active === operation) active = null; notify(); }
    return getState();
  }
  const editItem = (itemId, fields, observationKey) => editItems([{ itemId, fields, observationKey }]);
  async function deleteItems(items = []) {
    const blocked = manualBlock(); if (blocked) throw new Error(blocked);
    if (!Array.isArray(items) || new Set(items.map(item => item?.itemId)).size !== items.length) throw new Error('请选择有效且不重复的停止事项。');
    const operation = { epoch, chatId: identity().chatId, controller: new AbortController(), phase: 'saving', promise: null, manual: true };
    active = operation; notify();
    operation.promise = (async () => {
      const reachable = await bodySource(), key = sourceKey(reachable);
      const valid = () => current(operation) && sourceKey(getReachable()) === key && !manualBlock(true);
      if (!valid() || !reachable?.root || reachable.root.chatId !== operation.chatId) throw new Error('当前聊天记忆已变化，请刷新事项后重试。');
      let stored = await store.read(operation.chatId);
      if (!valid()) throw new Error('当前聊天记忆已变化，请刷新事项后重试。');
      await store.requirePermanentDelete();
      if (!valid()) throw new Error('当前聊天记忆已变化，请刷新事项后重试。');
      let pending = stored.head?.pendingDeletionRecords ?? [];
      pendingDeletionCount = pending.length;
      if (pending.length && items.length) throw new Error('已有永久删除待续清；请先在同一入口完成清理，再选择其他停止事项。');
      if (!pending.length) {
        if (!items.length) throw new Error('请先选择要永久删除的停止事项。');
        const currentItems = new Map(replayTimeBatches(stored.batches, reachable).map(item => [item.id, item]));
        for (const selected of items) {
          const item = currentItems.get(selected?.itemId);
          if (!item || item.status === 'active' || item.observationKey !== selected.observationKey) throw new Error('停止事项已变化或来源已失效，请刷新后重试。');
        }
        const deletedIds = new Set(items.map(item => item.itemId)), replacements = new Map(), preparedBatches = [];
        for (const record of stored.batchRecords ?? []) {
          const clean = sanitizeTimeBatchForDeletion(record.data, deletedIds);
          if (JSON.stringify(clean) === JSON.stringify(record.data)) continue;
          clean.id = `v3-time-batch-${newUuid()}`;
          await store.putBatch(operation.chatId, clean, operation.controller.signal);
          replacements.set(record.id, clean.id); preparedBatches.push(clean);
          if (!valid()) throw new Error('当前聊天记忆已变化，本次删除未应用。');
        }
        if (!replacements.size) throw new Error('未找到可删除的历史事项，请刷新后重试。');
        const root = await foundationStore.readRoot();
        if (!valid() || root.data?.chatId !== operation.chatId || root.data?.narrativeGeneration !== reachable.root.narrativeGeneration) throw new Error('当前聊天记忆已变化，本次删除未应用。');
        pending = (stored.batchRecords ?? []).filter(record => replacements.has(record.id)).map(record => ({ id: record.id, revision: record.revision }));
        const nextBatches = stored.batches.map(batch => preparedBatches.find(value => replacements.get(batch.id) === value.id) ?? batch);
        const nextHead = sanitizeTimeHeadForDeletion(stored.head, deletedIds);
        nextHead.batchIds = stored.head.batchIds.map(id => replacements.get(id) ?? id);
        nextHead.pendingDeletionRecords = pending;
        if (nextHead.lastRun) nextHead.lastRun.items = itemCount(nextBatches, reachable);
        const saved = await store.putHead(operation.chatId, nextHead, stored.revision, operation.controller.signal);
        stored = { ...stored, head: nextHead, revision: saved.revision, batches: nextBatches };
        pendingDeletionCount = pending.length;
      }
      for (const record of pending) {
        if (!valid()) throw new Error('当前聊天已变化，旧历史记录尚未清理完，可稍后继续。');
        try { await store.removePermanent(operation.chatId, record.id, record.revision, operation.controller.signal); }
        catch (error) { if (error?.status !== 404) throw error; }
      }
      if (!valid()) throw new Error('当前聊天已变化，清理结果尚未确认，可稍后继续。');
      const { pendingDeletionRecords: _pending, ...cleanHead } = stored.head;
      const saved = await store.putHead(operation.chatId, cleanHead, stored.revision, operation.controller.signal);
      const freshAnnual = await annualSnapshot();
      if (!valid()) throw new Error('当前聊天已变化，清理结果已保存但界面尚未刷新。');
      cacheItems(stored.batches, reachable, currentAnnualRecords(cleanHead, freshAnnual));
      pendingDeletionCount = 0;
      last = { status: 'completed', items: trackedItems.length, message: items.length
        ? `已永久删除 ${items.length} 个停止事项及其时间历史；其他事项、摘要与千事保留。`
        : '待清理的旧历史记录已永久删除；停止事项清单保持不变。' };
      statusKey = null; projectionCache = null; onInvalidate();
      return { ...stored, head: cleanHead, revision: saved.revision };
    })();
    try { await operation.promise; }
    catch (error) {
      try {
        const latest = await store.read(operation.chatId), count = latest.head?.pendingDeletionRecords?.length ?? 0;
        if (current(operation) && count) { pendingDeletionCount = count; last = { status: 'partial', message: `已保存删除后的清单，但尚有 ${count} 份旧历史记录未清理；可在同一入口继续。`, pendingDeletionCount: count }; statusKey = null; }
      } catch { /* 保留原始错误给界面。 */ }
      throw error;
    } finally { if (active === operation) active = null; notify(); }
    return getState();
  }
  async function ensureStart(source, stored, signal) {
    let start = stored.head?.bodyStart ?? timeBodyStart(source);
    const bound = resolveTimeStart(start, source);
    if (bound && !start.floorId && !start.awaitingFirst) start = { ...start, hostLocator: bound.hostLocator, rawFingerprint: bound.rawFingerprint, canonicalFingerprint: bound.canonicalFingerprint,
      ...(bound.floorId ? { floorId: bound.floorId, awaitingFirst: undefined } : {}) };
    else if (bound?.floorId && !start.floorId) start = { ...start, floorId: bound.floorId, awaitingFirst: undefined };
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
  async function runAnnualSetting(operation, source, stored, plan) {
    const annual = plan.annualSetting;
    if (!annual?.ready || !annual.shouldRequest && !annual.removed?.length) return stored;
    const remove = head => Object.fromEntries(Object.entries(head?.settingAnnualSources ?? {}).filter(([key]) => !annual.removed.includes(key)));
    const stillCurrent = async () => {
      const fresh = await annualSnapshot(), root = await foundationStore.readRoot();
      return current(operation) && fresh.ready && fresh.fingerprint === annual.fingerprint
        && root.data?.chatId === operation.chatId && root.data?.narrativeGeneration === source.root.narrativeGeneration;
    };
    if (!await stillCurrent()) return stored;
    if (!annual.shouldRequest) {
      const { settingAttempt: _oldAttempt, ...rest } = stored.head;
      const head = { ...rest, settingAnnualSources: remove(stored.head) };
      const saved = await store.putHead(operation.chatId, head, stored.revision, operation.controller.signal);
      projectionCache = null; onInvalidate(); operation.progress.completed += 1;
      last = { status: 'completed', items: itemCount(stored.batches, source), message: '已移除清空或失效来源对应的年度设定。' };
      return { ...stored, head, revision: saved.revision };
    }
    operation.phase = 'collecting'; operation.annualSetting = true; notify();
    const attempt = { contentFingerprint: annual.fingerprint, triggerFingerprint: annual.triggerFingerprint, status: 'running', pending: annual.pending };
    let head = { ...stored.head, settingAttempt: attempt };
    const attempted = await store.putHead(operation.chatId, head, stored.revision, operation.controller.signal);
    stored = { ...stored, head, revision: attempted.revision };
    try {
      const transportBudget = { remaining: 1, used: 0 }; operation.requests += 1;
      const result = await generateTimeTask({ systemPrompt: ANNUAL_SETTING_SYSTEM_PROMPT, taskMessages: [{ role: 'user', content: JSON.stringify(annual.request) }],
        temperature: 0, includeCharacterCard: false, worldInfoSource: 'none', parseMode: 'semantic', transportBudget, transportRetries: 0, signal: operation.controller.signal });
      if (!await stillCurrent()) return stored;
      const compiled = compileAnnualSettingResponse(result, { sources: annual.sources });
      if (!await stillCurrent()) return stored;
      const records = remove(head);
      for (const record of compiled.succeeded) records[record.sourceKey] = record;
      const status = compiled.errors.length || annual.pending ? 'partial' : 'completed';
      head = { ...head, settingAnnualSources: records, settingAttempt: { ...attempt, status, pending: compiled.errors.length + annual.pending } };
      const saved = await store.putHead(operation.chatId, head, stored.revision, operation.controller.signal);
      stored = { ...stored, head, revision: saved.revision }; operation.progress.completed += 1;
      last = { status, items: itemCount(stored.batches, source), annualSaved: compiled.succeeded.length,
        message: status === 'partial' ? `年度设定已保存 ${compiled.succeeded.length} 个来源，另有 ${compiled.errors.length + annual.pending} 个来源待后续新正文或手动补查。` : `年度设定已更新 ${compiled.succeeded.length} 个来源。`, requests: operation.requests, api: sanitizeTaskMetadata(result?.taskMetadata) };
      if (status === 'partial') operation.annualMessage = last.message;
      projectionCache = null; onInvalidate(); notify(); return stored;
    } catch (error) {
      if (await stillCurrent()) {
        head = { ...head, settingAttempt: { ...attempt, status: 'failed' } };
        try { const saved = await store.putHead(operation.chatId, head, stored.revision, operation.controller.signal); stored = { ...stored, head, revision: saved.revision }; } catch { /* UI still reports the failed attempt. */ }
        last = { status: 'failed', items: itemCount(stored.batches, source), message: '年度设定补读失败；本次不会自动连发，下次新正文或手动补查可重试。', persisted: true };
        operation.annualMessage = last.message;
        notify();
      }
      return stored;
    } finally { operation.annualSetting = false; }
  }
  async function runPlan(plan, manual = false) {
    if (active || !enabled()) return getState();
    const operation = { epoch, chatId: plan.chatId, controller: new AbortController(), phase: 'preparing', promise: null, manual,
      requests: 0, progress: { completed: 0, total: plan.groups.length + Number(Boolean(plan.currentReview && plan.groups.at(-1)?.length)) + Number(Boolean(plan.annualSetting?.shouldRequest || plan.annualSetting?.removed?.length)) } };
    active = operation; notify();
    operation.promise = (async () => {
      try {
        let source = await bodySource(), stored = await store.read(operation.chatId);
        if (!current(operation) || source.root.narrativeGeneration !== plan.narrativeGeneration) return;
        stored = await ensureStart(source, stored, operation.controller.signal);
        stored = await runAnnualSetting(operation, source, stored, plan);
        if (!current(operation)) return;
        if (plan.annualSetting?.ready) { const freshAnnual = await annualSnapshot(); cacheItems(stored.batches, source, currentAnnualRecords(stored.head, freshAnnual)); coverage = planTimeBody(source, stored.batches, { start: stored.head.bodyStart }); }
        const groups = [...plan.groups];
        const roundFailures = [];
        if (plan.currentReview && groups.at(-1)?.length) groups.push([]);
        for (const planned of groups) {
          const currentReview = Boolean(plan.currentReview && !planned.length);
          if (currentReview && plan.reviewAuthorization && stored.head?.currentReviewAttempt?.authorization === plan.reviewAuthorization) break;
          const reads = timeBodyReads(stored.batches, source);
          const fragments = planned.filter(fragment => {
            let cursor = fragment.from;
            for (const range of (reads.get(fragment.floorId) ?? []).sort((a,b) => a.from-b.from)) if (range.from <= cursor) cursor = Math.max(cursor, range.to);
            return cursor < fragment.to;
          });
          if (planned.length && !fragments.length) { operation.progress.completed += 1; notify(); continue; }
          const witnesses = fragments.length ? fragments : plan.currentWitness ? [{ ...plan.currentWitness, totalCharacters: plan.currentWitness.content.length }] : [];
          if (!witnesses.length) continue;
          if (!current(operation)) return;
          if (!await validateBody(operation, source, witnesses)) throw Object.assign(new Error('正文来源已变化，本批未应用。'), { code: 'QQJ_TIME_SOURCE_CHANGED' });
          let prepared;
          try {
            prepared = await prepareTimeRequest(source, stored.batches, { fragments, cutoffBody: !fragments.length ? plan.currentWitness : null, allowInitialProjection: manual || currentReview, currentReview });
          } catch (error) {
            if (!current(operation) || error?.name === 'AbortError' || error?.code !== 'QQJ_TIME_INVALID') throw error;
            const message = publicErrorMessage({ code: error.code, name: error.name, status: error.status }, { fallback: '本批时间正文无法准备；其余批次已继续处理，可手动补查本批。' });
            const attempt = currentReview ? {} : bodyAttempt(fragments);
            const failedRun = { status: 'partial', cutoffFloorId: attempt.cutoffFloorId ?? plan.currentWitness?.floorId ?? null,
              cutoffAssistantSeq: attempt.cutoffAssistantSeq ?? plan.currentWitness?.assistantSeq ?? 0, items: itemCount(stored.batches, source), message };
            const failedHead = { ...stored.head, lastRun: failedRun };
            const saved = await store.putHead(operation.chatId, failedHead, stored.revision, operation.controller.signal);
            stored = { ...stored, head: failedHead, revision: saved.revision };
            roundFailures.push({ currentReview, message, ...attempt });
            operation.progress.completed += 1; statusKey = null;
            last = { ...failedRun, requests: operation.requests, persisted: true }; notify();
            continue;
          }
          if (!prepared.shouldRequest) { if (currentReview) operation.progress.total -= 1; continue; }
          operation.currentReview = currentReview;
          const latestSourceBody = source.bodyFloors.filter(body => body.floorId).at(-1);
          const run = { ...(currentReview ? { currentReview: { pending: true, omitted: prepared.omitted } } : {}), status: 'running', cutoffFloorId: prepared.cutoffFloorId, cutoffAssistantSeq: prepared.cutoffAssistantSeq,
            sourceScope: latestSourceBody ? { floorId: latestSourceBody.floorId, assistantSeq: latestSourceBody.assistantSeq, canonicalFingerprint: latestSourceBody.canonicalFingerprint } : null,
            items: itemCount(stored.batches, source) };
          const reviewAttempt = currentReview ? { authorization: plan.reviewAuthorization, scopeKey: await reviewScopeKey(source, plan.currentWitness), signature: prepared.signature, cutoffFloorId: prepared.cutoffFloorId, cutoffAssistantSeq: prepared.cutoffAssistantSeq, status: 'running' } : null;
          const head = { ...stored.head, ...(reviewAttempt ? { currentReviewAttempt: reviewAttempt } : {}), lastAttemptSignature: prepared.signature, lastAttemptTime: prepared.request.currentTime, lastRun: run };
          const attempted = await store.putHead(operation.chatId, head, stored.revision, operation.controller.signal);
          stored = { ...stored, head, revision: attempted.revision };
          operation.phase = prepared.request.trackedItems.length ? 'projecting' : 'collecting'; notify();
          const transportBudget = { remaining: 1, used: 0 };
          operation.requests += 1;
          let result, batch;
          try {
            result = await generateTimeTask({ systemPrompt: prepared.systemPrompt, taskMessages: [{ role: 'user', content: JSON.stringify(prepared.request) }],
              temperature: 0, includeCharacterCard: false, worldInfoSource: 'none', parseMode: 'semantic', transportBudget, transportRetries: 0, signal: operation.controller.signal });
            if (!current(operation)) return;
            operation.phase = 'saving'; notify();
            batch = await compileTimeResponse(result, prepared, stored.batches);
          } catch (error) {
            if (!current(operation) || error?.name === 'AbortError') throw error;
            const message = error?.code === 'QQJ_TIME_INVALID' && error.itemErrors?.length
              ? `${error.itemErrors.map(item => `第${item.index}项：${item.reason}`).join('；')} 本批未保存，可手动补查。`
              : publicErrorMessage({ code: error?.code, name: error?.name, status: error?.status }, { fallback: '本批时间正文处理失败；成功批次已保留，可补查本批。' });
            const failedRun = { ...run, status: 'partial', message };
            const failedHead = { ...head, ...(reviewAttempt ? { currentReviewAttempt: { ...reviewAttempt, status: 'failed' } } : {}), lastRun: failedRun };
            const saved = await store.putHead(operation.chatId, failedHead, stored.revision, operation.controller.signal);
            stored = { ...stored, head: failedHead, revision: saved.revision };
            roundFailures.push({ currentReview, message, ...(currentReview ? {} : bodyAttempt(fragments, prepared)) });
            operation.progress.completed += 1; statusKey = null;
            last = { ...failedRun, requests: operation.requests, persisted: true }; notify();
            continue;
          }
          batch.id = `v3-time-batch-${newUuid()}`;
          if (!await validateBody(operation, source, [...witnesses, ...batch.dependencies.filter(ref => ref.canonicalFingerprint).map(ref => ({ floorId: ref.floorId, canonicalFingerprint: ref.canonicalFingerprint, totalCharacters: source.bodyFloors.find(body => body.floorId === ref.floorId)?.content.length }))])) throw Object.assign(new Error('正文来源已变化，本批未应用。'), { code: 'QQJ_TIME_SOURCE_CHANGED' });
          await store.putBatch(operation.chatId, batch, operation.controller.signal);
          if (!await validateBody(operation, source, witnesses)) throw Object.assign(new Error('正文来源已变化，本批未应用。'), { code: 'QQJ_TIME_SOURCE_CHANGED' });
          const completed = { ...run, status: batch.status === 'partial' ? 'partial' : batch.changes.length ? 'completed' : 'empty',
            ...(batch.itemErrors?.length ? { itemErrors: batch.itemErrors, message: `已保存 ${batch.changes.length} 项；${batch.itemErrors.map(item => `第${item.index}项：${item.reason}`).join('；')} 失败项可在后续新正文或手动补查时再试。` } : {}), items: itemCount([...stored.batches, batch], source),
            ...(!fragments.length && batch.status !== 'partial' ? { initialProjectionCheckedSignature: prepared.signature } : {}) };
          if (batch.currentReview) { completed.currentReview = batch.currentReview; completed.message = `当前评估：估计 ${batch.currentReview.updated} 项，依据不足 ${batch.currentReview.insufficient} 项，短期事项退出 ${batch.currentReview.retired ?? 0} 项，归并退出 ${batch.currentReview.merged ?? 0} 项，未纳入 ${batch.currentReview.omitted} 项。${completed.message ?? ''}`; }
          const nextHead = { ...head, ...(reviewAttempt ? { currentReviewAttempt: { ...reviewAttempt, status: completed.status } } : {}), batchIds: [...head.batchIds, batch.id], lastRun: completed };
          const saved = await store.putHead(operation.chatId, nextHead, stored.revision, operation.controller.signal);
          if (!current(operation)) return;
          stored = { head: nextHead, revision: saved.revision, batches: [...stored.batches, batch] };
          operation.progress.completed += 1;
          if (batch.status === 'partial') roundFailures.push({ currentReview, message: completed.message ?? '本批有未完成事项，可手动补查。', ...(currentReview ? {} : bodyAttempt(fragments, prepared)) });
          const freshAnnual = await annualSnapshot();
          if (!current(operation)) return;
          cacheItems(stored.batches, source, currentAnnualRecords(stored.head, freshAnnual)); coverage = planTimeBody(source, stored.batches, { start: stored.head.bodyStart });
          const visibleCompleted = operation.annualMessage ? { ...completed, status: 'partial', message: [completed.message, operation.annualMessage].filter(Boolean).join(' ') } : completed;
          last = { ...visibleCompleted, requests: operation.requests, api: sanitizeTaskMetadata(result?.taskMetadata) };
          projectionCache = null; onInvalidate(); notify();
        }
        if (roundFailures.length && current(operation)) {
          const failedBodyAttempts = roundFailures.filter(failure => !failure.currentReview).map(({ cutoffFloorId, cutoffAssistantSeq, sourceKeys, fragments }) => ({ cutoffFloorId, cutoffAssistantSeq, sourceKeys, fragments }));
          const details = roundFailures.slice(0, 3).map(failure => failure.message).filter(Boolean).join(' ');
          const message = `本轮 ${roundFailures.length} 批未完成；其余批次已继续处理，失败范围仍可手动补查。${details ? ` ${details}` : ''}`;
          const aggregate = { ...stored.head.lastRun, status: 'partial', message, failedBatchCount: roundFailures.length,
            ...(failedBodyAttempts.length ? { failedBodyAttempts } : {}) };
          const nextHead = { ...stored.head, lastRun: aggregate };
          const saved = await store.putHead(operation.chatId, nextHead, stored.revision, operation.controller.signal);
          stored = { ...stored, head: nextHead, revision: saved.revision };
          last = { ...aggregate, requests: operation.requests, persisted: true }; statusKey = null; notify();
        }
        if (historyAuthorization?.chatId === operation.chatId) {
          const remaining = planTimeBody({ ...source, bodyFloors: source.bodyFloors.filter(body => body.assistantSeq <= historyAuthorization.through) }, stored.batches, { history: true });
          if (!remaining.groups.length && !source.bodyFloors.some(body => body.assistantSeq <= historyAuthorization.through && !body.floorId)) historyAuthorization = null;
        }
      } catch (error) {
        if (current(operation)) {
          const message = error?.code === 'QQJ_TIME_INVALID' && error.itemErrors?.length ? `${error.itemErrors.map(item => `第${item.index}项：${item.reason}`).join('；')} 本批未保存，可手动补查。` : publicErrorMessage({ code: error?.code, name: error?.name, status: error?.status }, { fallback: '本批时间正文处理失败；成功批次已保留，可补查剩余正文。' });
          last = { status: 'failed', message, persisted: false, ...(operation.currentReview ? { currentReview: { failed: true } } : {}) }; statusKey = null;
          try {
            const latest = await store.read(operation.chatId);
            if (current(operation) && latest.head) { await store.putHead(operation.chatId, { ...latest.head, ...(latest.head.currentReviewAttempt?.status === 'running' ? { currentReviewAttempt: { ...latest.head.currentReviewAttempt, status: 'failed' } } : {}), lastRun: { ...latest.head.lastRun, status: 'failed', message } }, latest.revision, operation.controller.signal); last.persisted = true; }
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
      if (manualBlock()) return refreshStatus();
      const latestSourceBody = source.bodyFloors.filter(body => body.floorId).at(-1);
      if (stored.head?.lastRun?.status === 'partial') {
        const currentScope = latestSourceBody ? { floorId: latestSourceBody.floorId, assistantSeq: latestSourceBody.assistantSeq, canonicalFingerprint: latestSourceBody.canonicalFingerprint } : null;
        if (!stored.head.lastRun.sourceScope) {
          const attemptedBody = source.bodyFloors.find(body => body.floorId === stored.head.lastRun.cutoffFloorId)
            ?? source.bodyFloors.find(body => body.assistantSeq === stored.head.lastRun.cutoffAssistantSeq);
          const attemptedScope = attemptedBody ? { floorId: attemptedBody.floorId, assistantSeq: attemptedBody.assistantSeq, canonicalFingerprint: attemptedBody.canonicalFingerprint } : currentScope;
          const head = { ...stored.head, lastRun: { ...stored.head.lastRun, sourceScope: attemptedScope } };
          const saved = await store.putHead(source.root.chatId, head, stored.revision, controller.signal);
          stored = { ...stored, head, revision: saved.revision };
          if (JSON.stringify(attemptedScope) === JSON.stringify(currentScope)) return refreshStatus({ force: true });
        }
        if (JSON.stringify(stored.head.lastRun.sourceScope) === JSON.stringify(currentScope)) return refreshStatus();
      }
      const history = historyAuthorization?.chatId === identity().chatId;
      const plan = planTimeBody(source, stored.batches, { start: stored.head.bodyStart, history });
      if (history) plan.groups = plan.groups.map(group => group.filter(row => row.assistantSeq <= historyAuthorization.through)).filter(group => group.length);
      if (stored.head?.lastRun?.status === 'partial') {
        const partialBatch = stored.batches.findLast(batch => batch.status === 'partial');
        const failedBodyAttempts = [...(stored.head.lastRun.failedBodyAttempts ?? []), ...(partialBatch ? [{ cutoffFloorId: partialBatch.cutoffFloorId, sourceKeys: partialBatch.sourceKeys }] : [])];
        if (failedBodyAttempts.length) {
          const groups = [];
          for (const group of plan.groups) {
            if (failedBodyAttempts.some(attempt => sameBodyAttempt(attempt, group))) continue;
            const prepared = await prepareTimeRequest(source, stored.batches, { fragments: group });
            if (failedBodyAttempts.some(attempt => sameBodyAttempt(attempt, group, prepared))) continue;
            groups.push(group);
          }
          plan.groups = groups;
        }
      }
      if (plan.groups.length) {
        const prepared = await prepareTimeRequest(source, stored.batches, { fragments: plan.groups[0] });
        if (stored.head.lastAttemptSignature === prepared.signature && ['running', 'failed'].includes(stored.head.lastRun?.status)) return refreshStatus();
      }
      const currentWitness = history ? source.bodyFloors.filter(body => body.floorId && body.assistantSeq <= historyAuthorization.through).at(-1) : null;
      const currentReview = Boolean(currentWitness && !source.bodyFloors.some(body => body.assistantSeq <= historyAuthorization.through && !body.floorId)
        && stored.head?.currentReviewAttempt?.scopeKey !== await reviewScopeKey(source, currentWitness));
      const settingSnapshot = await annualSnapshot();
      const triggerBody = source.bodyFloors.filter(body => body.floorId).at(-1);
      const triggerFingerprint = await timeFingerprint([source.root.narrativeGeneration, triggerBody?.floorId ?? null, triggerBody?.canonicalFingerprint ?? null]);
      const annualSetting = await prepareAnnualSetting(settingSnapshot, stored.head, triggerFingerprint, false);
      if (plan.groups.length || currentReview || annualSetting.shouldRequest || annualSetting.removed?.length) return runPlan({ ...plan, groups: plan.groups.length ? plan.groups : currentReview ? [[]] : [], currentWitness,
        currentReview, reviewAuthorization: historyAuthorization?.reviewAuthorization, annualSetting: { ...annualSetting, fingerprint: settingSnapshot.fingerprint, triggerFingerprint }, chatId: source.root.chatId, narrativeGeneration: source.root.narrativeGeneration }, false);
      if (history && !plan.groups.length && !source.bodyFloors.some(body => body.assistantSeq <= historyAuthorization.through && !body.floorId)) historyAuthorization = null;
      cacheItems(stored.batches, source, currentAnnualRecords(stored.head, settingSnapshot)); coverage = plan;
      if (annualSetting.pending) last = { status: 'partial', items: itemCount(stored.batches, source), message: `有 ${annualSetting.pending} 个年度设定来源超过单次输入预算，尚未标记为已处理。` };
      return notify();
    } catch { return getState(); } finally { if (startingController === controller) startingController = null; }
  }
  async function authorizeHistory() {
    const token = epoch, chatId = identity().chatId;
    const source = await bodySource();
    if (token !== epoch || identity().chatId !== chatId) return getState();
    const through = source.bodyFloors.filter(body => body.stable).at(-1)?.assistantSeq ?? 0;
    historyAuthorization = through ? { chatId: identity().chatId, through, reviewAuthorization: newUuid() } : null;
    return runBatch();
  }
  async function recallProjection(source) {
    if (!enabled() || source?.status !== 'ready' || identity().chatId !== source.chatId) return null;
    const token = epoch, bodyKey = sourceKey(getReachable()), annual = await annualSnapshot();
    const key = JSON.stringify([source.chatId, source.headCheckpointId, source.rootRevision, source.identityProjection, bodyKey, annual.ready, annual.fingerprint]);
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
      const host = hostAdapter.snapshot();
      const currentBody = reachable.bodyFloors.filter(body => {
        const message = host.chat?.[body.hostLocator.messageIndex];
        return message && message.is_system !== true && message.is_hidden !== true && message.hidden !== true;
      }).at(-1);
      const currentTime = currentBody?.observationTime ?? projectTime('');
      let qianshiProjection = null;
      try { qianshiProjection = projectQianshiGraph(cached, { identityProjection: source.identityProjection }); }
      catch { /* Optional associations never suppress the ordinary time projection. */ }
      const projection = timeRecallProjection(items, source, currentTime, currentAnnualRecords(stored.head, annual), qianshiProjection);
      if (currentBody) projection.currentBodyWitness = { hostLocator: currentBody.hostLocator, rawContent: currentBody.rawContent, canonicalContent: currentBody.content };
      const value = { ...projection, fingerprint: await timeFingerprint([stored.head?.batchIds ?? [], annual.fingerprint, projection]) };
      const freshAnnual = await annualSnapshot();
      if (!enabled() || token !== epoch || identity().chatId !== source.chatId || sourceKey(getReachable()) !== bodyKey
        || freshAnnual.ready !== annual.ready || freshAnnual.fingerprint !== annual.fingerprint) return null;
      projectionCache = { key, value };
      return value;
    } catch (error) {
      if (token === epoch) { last = { status: 'failed', message: '时间记录暂时无法读取；本轮继续使用原记忆召回。' }; notify(); }
      logger?.warn?.('[qianqianjie] time projection unavailable', { code: error?.code ?? error?.name ?? 'QQJ_TIME_READ_FAILED' });
      return null;
    }
  }
  async function currentStoryContext(source) {
    if (source?.status !== 'ready' || identity().chatId !== source.chatId) return null;
    const cached = getReachable();
    if (!cached?.root || cached.root.chatId !== source.chatId || cached.root.narrativeGeneration !== source.narrativeGeneration
      || cached.root.headCheckpointId !== source.headCheckpointId) return null;
    const owner = identity(), host = hostAdapter.snapshot();
    if (!owner.chatId || owner.hostChatId && owner.hostChatId !== host.chatId
      || host.context?.chatMetadata?.qianqianjie?.chatId && host.context.chatMetadata.qianqianjie.chatId !== owner.chatId) return null;
    const reliable = readRecentBodyStoryTimes(host, { storyClockReferenceTags: storyClockReferenceTags(), limit: 32 });
    const currentBody = reliable.at(-1);
    if (!currentBody) return null;
    return { currentTime: currentBody.observationTime,
      recentStoryTimes: reliable.slice(-32).map(item => item.observationTime) };
  }
  function bind({ eventSource, eventTypes, foundationRuntime } = {}) {
    const event = eventTypes?.CHAT_CHANGED;
    if (event && eventSource?.on) eventSource.on(event, invalidate);
    const refreshAnnual = () => { projectionCache = null; statusKey = null; void runBatch(); };
    for (const name of ['PERSONA_CHANGED', 'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED']) {
      const personaEvent = eventTypes?.[name];
      if (personaEvent && eventSource?.on) eventSource.on(personaEvent, refreshAnnual);
    }
    foundationRuntime?.subscribe?.(state => { if (['ready', 'needsReseal'].includes(state?.status)) void runBatch(); });
    void runBatch();
  }
  return Object.freeze({ runBatch, prepareHistoryPlan, organize, authorizeHistory, editItem, editItems, deleteItems, refreshStatus, recallProjection, currentStoryContext, getState, invalidate, stop, bind,
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } });
}
