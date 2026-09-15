import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTime, timeDistance, timeHours, nextCycleTime, storyTimes, prepareTimeBatch, compileTimeResponse, replayTimeBatches, timeRecallProjection } from '../src/v3/time-engine.js';
import { createTimeStore, createTimeRuntime } from '../src/v3/time-runtime.js';
import { formatRecallInjection, selectRecall, buildRecallQueryContext, estimateRecallTokens } from '../src/v3/recall-selector.js';
import { projectInlineRecallReceipt } from '../src/ui/inline-projection.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FLOOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMORY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GEN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
function reachable(date = '2026-05-10', extra = false) {
  const memory = { id: MEMORY, floorId: FLOOR, recordStatus: 'active', summary: { aiText: '手腕受伤，约好三天后复查。' }, chronology: [{ time: { kind: 'explicit', normalized: extra ? '2026-05-10' : date } }],
    observations: [{ itemId: 'injury', subjectEntityId: PERSON, kind: 'injury', description: '手腕擦伤' }], commitments: [], cseSignals: [], participants: [], locations: [], actions: [], informationTransfers: [], privateCognition: [], openLoops: [], exactAnchors: [], eventFragments: [] };
  const floors = [{ id: FLOOR, assistantSeq: 1 }], memories = [memory];
  if (extra) { floors.push({ id: 'floor-2', assistantSeq: 2 }); memories.push({ ...structuredClone(memory), id: 'memory-2', floorId: 'floor-2', chronology: [{ time: { kind: 'explicit', normalized: date } }], observations: [] }); }
  return { status: 'ready', rootRevision: 1, root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: 'head' }, checkpoint: { id: 'head' }, cseUnavailable: true, floors, floorMemories: memories,
    entities: [{ id: PERSON, entityType: 'person', displayName: '甲', aliases: [], recordStatus: 'active', status: 'established' }] };
}
function response(prepared, patch = {}) { const ref = prepared.request.observations[0]; return { changes: [{ itemId: null, sourceKeys: [ref.sourceKey], subjectEntityId: PERSON, type: 'body', label: '手腕擦伤', observation: '手腕擦伤', occurrenceTime: '昨天', dueTime: '', status: 'active', stateRefs: [], progression: '已康复', ...patch }] }; }
function backend() {
  const records = new Map();
  return { records, client: { async get(collection, id) { const found = records.get(`${collection}/${id}`); if (!found) throw Object.assign(new Error('missing'), { status: 404 }); return structuredClone(found); },
    async put(collection, id, data, revision, { signal } = {}) { if (signal?.aborted) throw new DOMException('abort', 'AbortError'); const key = `${collection}/${id}`; const old = records.get(key); assert.equal(old?.revision ?? 0, revision); const envelope = { data: structuredClone(data), revision: revision + 1 }; records.set(key, envelope); return structuredClone(envelope); } } };
}
function harness({ enabled = true, generate = null } = {}) {
  const back = backend(), store = createTimeStore(back); let on = enabled, chatId = CHAT, calls = 0;
  let value = reachable(), busy = false, cseReady = true, syncStatus = 'idle', runtime;
  const create = () => createTimeRuntime({ store, foundationStore: { readReachable: async () => structuredClone(value), readRoot: async () => ({ data: value.root }) }, hostAdapter: {}, session: { identity: () => ({ chatId }) }, isEnabled: () => on,
    getReachable: () => value, getMemoryState: () => ({ memorySyncStatus: syncStatus, memoryWorkBusy: busy, floors: (value?.floors ?? []).map(floor => ({ floorId: floor.id, memory: value.floorMemories.find(memory => memory.floorId === floor.id), cse: { status: cseReady ? 'ready' : 'pending', deltaId: cseReady ? `delta-${floor.id}` : null } })) }),
    logger: { warn() {} }, generateAnalysisTask: async options => { calls += 1; assert.equal(options.transportBudget.remaining, 1); assert.equal(options.maxTokens, undefined); const prepared = await prepareTimeBatch(value, (await store.read(CHAT)).batches); return generate ? generate(options, prepared) : response(prepared); } });
  runtime = create();
  return { get runtime() { return runtime; }, reload: () => { runtime = create(); return runtime; }, store, back, calls: () => calls, setEnabled: v => { on = v; }, setChat: v => { chatId = v; }, setSource: v => { value = v; }, setBusy: v => { busy = v; }, setSyncStatus: v => { syncStatus = v; }, setCseReady: v => { cseReady = v; } };
}

test('首次历史身体观察同一请求推算、落盘并进入真实召回；当前观察未知倒退不推', async () => {
  const h = harness(); h.setSource(reachable('2026-05-12', true));
  await h.runtime.organize(); assert.equal(h.calls(), 1);
  const saved = (await h.store.read(CHAT)).batches[0].changes[0];
  assert.equal(saved.observationTime.date, '2026-05-10');
  assert.equal(saved.projection.text, '已康复');
  const prepared = await prepareTimeBatch(reachable('2026-05-12', true));
  assert.equal(prepared.request.observations[0].observationElapsedDays, 2);
  const source = { entities: [{ entityId: PERSON, displayName: '甲' }], currentState: [] };
  const timeProjection = timeRecallProjection([saved], source, projectTime('2026-05-12'));
  const selection = selectRecall({ source: { status: 'ready', chatId: CHAT, coverage: { memoryComplete: true, cseCurrent: true }, bodyMatch: { visibleFloorIds: [], summaryCoveredFloorIds: [] }, cseChanges: [], floorMemories: [], currentState: [], entities: source.entities, timeProjection }, queryContext: buildRecallQueryContext({ coreChat: [{ is_user: true, mes: '甲手腕怎么样' }] }), contextSize: 12000 });
  assert.match(selection.injectionText, /已康复/u);
  for (const date of ['2026-05-10', '时间未知', '2026-05-09']) {
    const input = await prepareTimeBatch(reachable(date, true)); input.request.chatId = CHAT;
    assert.equal((await compileTimeResponse(response(input), input)).changes[0].projection, null, date);
  }
  const fresh = reachable('2026-05-12', true);
  fresh.floorMemories[1].observations = [{ itemId: 'fresh', subjectEntityId: PERSON, kind: 'injury', description: '此刻再次擦伤' }];
  const input = await prepareTimeBatch(fresh); input.request.chatId = CHAT;
  const latest = input.request.observations.find(ref => ref.floorId === 'floor-2');
  const result = await compileTimeResponse(response(input, { sourceKeys: input.request.observations.map(ref => ref.sourceKey), observation: latest.description }), input);
  assert.equal(result.changes[0].observationTime.date, '2026-05-12');
  assert.equal(result.changes[0].projection, null);
});

test('既成空推算手动机会成功空项仅一次，失败可重试且自动不补跑', async () => {
  for (const fail of [false, true]) {
    let count = 0;
    const h = harness({ generate: async (_, prepared) => {
      count += 1;
      if (count === 1) return response(prepared, { progression: '' });
      if (fail && count === 2) throw new Error('mock failure');
      return { changes: [] };
    } });
    h.setSource(reachable('2026-05-12', true));
    await h.runtime.runBatch({ chatId: CHAT });
    await h.runtime.runBatch({ chatId: CHAT }); assert.equal(h.calls(), 1);
    await h.runtime.organize(); assert.equal(h.calls(), 2);
    if (fail) { await h.runtime.organize(); assert.equal(h.calls(), 3); }
    const stored = await h.store.read(CHAT);
    assert.equal(stored.head.lastRun.initialProjectionCheckedSignature, stored.head.lastAttemptSignature);
    h.reload(); await h.runtime.organize(); assert.equal(h.calls(), fail ? 3 : 2);
  }
});

test('只读清单冷读空值、成功与来源修订核对失败，关闭切聊迟到均不写不调用', async () => {
  const h = harness(); assert.equal(h.runtime.getState().trackedItems, null);
  await h.runtime.refreshStatus(); assert.deepEqual(h.runtime.getState().trackedItems, []);
  assert.equal(h.back.records.size, 0); assert.equal(h.calls(), 0);
  h.setSource(reachable('2026-05-12', true)); await h.runtime.organize();
  h.reload(); await h.runtime.refreshStatus();
  const state = h.runtime.getState(); assert.equal(state.trackedItems.length, state.last.items);
  assert.equal(state.trackedItems[0].person, '甲'); assert.equal(state.trackedItems[0].projection, '已康复');
  state.trackedItems[0].label = '篡改副本'; assert.notEqual(h.runtime.getState().trackedItems[0].label, '篡改副本');
  h.setSyncStatus('needsReview'); await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().trackedItems, null);
  h.setSyncStatus('idle'); const edited = reachable('2026-05-12', true); edited.floorMemories[0].id = 'changed'; h.setSource(edited);
  await h.runtime.refreshStatus({ force: true }); assert.deepEqual(h.runtime.getState().trackedItems, []);
  const originalGet = h.back.client.get; h.back.client.get = async () => { throw new Error('offline'); };
  await h.runtime.refreshStatus({ force: true }); assert.equal(h.runtime.getState().trackedItems, null);
  h.back.client.get = originalGet; h.setEnabled(false); await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().trackedItems, null);
  h.setEnabled(true); let release; const gate = new Promise(resolve => { release = resolve; });
  h.back.client.get = async (...args) => { await gate; return originalGet(...args); };
  const pending = h.runtime.refreshStatus({ force: true }); h.setChat('other'); h.runtime.invalidate(); release(); await pending;
  assert.equal(h.runtime.getState().trackedItems, null); assert.equal(h.calls(), 1);
});

test('同源时间读取只一次，短同步后恢复成功状态、整理后复用缓存，错误强制重读', async () => {
  const h = harness(); let reads = 0;
  const get = h.back.client.get; h.back.client.get = async (...args) => { reads += 1; return get(...args); };
  await h.runtime.refreshStatus(); await h.runtime.refreshStatus(); assert.equal(reads, 1);
  h.setSyncStatus('syncing'); await h.runtime.refreshStatus();
  assert.equal(h.runtime.getState().status, 'waiting'); assert.equal(h.runtime.getState().trackedItems, null);
  h.setSyncStatus('idle'); await h.runtime.refreshStatus(); assert.equal(reads, 1);
  assert.equal(h.runtime.getState().status, 'idle'); assert.deepEqual(h.runtime.getState().trackedItems, []);
  await h.runtime.organize(); const afterOrganize = reads;
  await h.runtime.refreshStatus(); assert.equal(reads, afterOrganize);
  assert.equal(h.runtime.getState().status, 'completed'); assert.equal(h.runtime.getState().trackedItems.length, 1);
  h.setSyncStatus('syncing'); await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().status, 'waiting');
  h.setSyncStatus('idle'); await h.runtime.refreshStatus(); assert.equal(reads, afterOrganize);
  assert.equal(h.runtime.getState().status, 'completed'); assert.equal(h.runtime.getState().last.status, 'completed');
  const newer = reachable(); newer.rootRevision = 2; h.setSource(newer); await h.runtime.refreshStatus(); assert.ok(reads > afterOrganize);
  for (const status of ['needsReview', 'error']) {
    const before = reads; h.setSyncStatus(status); await h.runtime.refreshStatus();
    assert.equal(reads, before); assert.equal(h.runtime.getState().trackedItems, null);
    h.setSyncStatus('idle'); await h.runtime.refreshStatus(); assert.ok(reads > before);
  }
  const beforeFailure = reads; h.back.client.get = async () => { reads += 1; throw new Error('mock read failure'); };
  await h.runtime.refreshStatus({ force: true }); assert.equal(h.runtime.getState().trackedItems, null);
  assert.equal(h.runtime.getState().last.reason, 'read');
  h.back.client.get = async (...args) => { reads += 1; return get(...args); };
  await h.runtime.refreshStatus({ force: true }); assert.ok(reads > beforeFailure + 1); assert.equal(h.runtime.getState().status, 'completed');
  h.runtime.invalidate(); await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().trackedItems.length, 1);
  assert.equal(h.calls(), 1);
});

test('明确年月日、相对日、无年同月算术与未知边界', () => {
  const anchor = projectTime('2026年5月10日');
  assert.equal(projectTime('昨天', anchor).date, '2026-05-09');
  assert.equal(timeDistance(projectTime('昨天', anchor), anchor), 1);
  assert.equal(projectTime('2026-02-30').date, null);
  const yearless = projectTime('5月10日');
  assert.equal(yearless.year, null);
  assert.equal(timeDistance(yearless, projectTime('5月12日')), 2);
  assert.equal(timeDistance(yearless, projectTime('6月1日')), null);
  assert.equal(projectTime('次日', yearless).monthDay, 11);
  assert.equal(projectTime('次日', projectTime('2月28日')).date, null);
  assert.equal(projectTime('木叶历七年霜月').date, null);
  assert.equal(projectTime('昨天').date, null);
});

test('新项首次保存观察、本地相对时间；不接受首次自然推演', async () => {
  const prepared = await prepareTimeBatch(reachable()); prepared.request.chatId = CHAT;
  const batch = await compileTimeResponse(response(prepared), prepared);
  assert.equal(batch.changes[0].projection, null);
  assert.equal(batch.changes[0].occurrenceTime.date, '2026-05-09');
  const next = await prepareTimeBatch(reachable(), [batch]);
  assert.equal(next.signature, prepared.signature, '自己的事项与保存状态不改变材料签名');
  assert.equal(next.request.observations.length, 0);
});

test('同日无材料变化与重复完成通知不新增调用；关闭零请求零文本', async () => {
  const h = harness(); await h.runtime.runBatch({ chatId: CHAT }); await h.runtime.runBatch({ chatId: CHAT });
  assert.equal(h.calls(), 1);
  h.setSource(reachable('2026-05-10', true)); await h.runtime.runBatch({ chatId: CHAT }); assert.equal(h.calls(), 1);
  h.setEnabled(false); await h.runtime.stop(); await h.runtime.runBatch({ chatId: CHAT }); assert.equal(h.calls(), 1);
  assert.equal(await h.runtime.recallProjection({ status: 'ready', chatId: CHAT }), null);
  const disabled = harness({ enabled: false }); await disabled.runtime.runBatch({ chatId: CHAT }); assert.equal(disabled.calls(), 0); assert.equal(disabled.back.records.size, 0);
});

test('可靠跨日允许整批一次，未知时间无新来源不调用', async () => {
  const h = harness({ generate: async (options, prepared) => prepared.request.observations.length ? response(prepared) : { changes: [] } });
  await h.runtime.runBatch({ chatId: CHAT }); h.setSource(reachable('2026-05-11', true)); await h.runtime.runBatch({ chatId: CHAT }); assert.equal(h.calls(), 2);
  h.setSource(reachable('时间未知', true)); await h.runtime.runBatch({ chatId: CHAT }); assert.equal(h.calls(), 2);
});

test('失败同份材料不隐式循环，停止、切聊、删除等待后迟到不采用', async () => {
  const failed = harness({ generate: async () => { throw new Error('bad'); } });
  await failed.runtime.runBatch({ chatId: CHAT }); await failed.runtime.runBatch({ chatId: CHAT }); assert.equal(failed.calls(), 1);
  for (const action of ['关闭', '切聊', '删除']) {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const h = harness({ generate: async (_, prepared) => { await gate; return response(prepared); } });
    const pending = h.runtime.runBatch({ chatId: CHAT });
    while (!h.calls()) await new Promise(resolve => setImmediate(resolve));
    if (action === '关闭') h.setEnabled(false);
    if (action === '切聊') h.setChat('another');
    const stopped = h.runtime.stop(); release(); await pending; await stopped;
    assert.equal((await h.store.read(CHAT)).batches.length, 0, action);
    if (action === '删除') { h.back.records.clear(); await h.runtime.runBatch({ chatId: 'different' }); assert.equal(h.back.records.size, 0); }
  }
});

test('新观察优先、同处再次受伤独立、取消不补造进展，原CSE不改', async () => {
  const first = await prepareTimeBatch(reachable()); first.request.chatId = CHAT;
  const batch = await compileTimeResponse(response(first), first);
  const old = batch.changes[0];
  const value = reachable('2026-05-11', true); value.floorMemories[1].observations = [{ itemId: 'new-injury', subjectEntityId: PERSON, kind: 'injury', description: '同一手腕再次擦伤' }];
  const next = await prepareTimeBatch(value, [batch]); next.request.chatId = CHAT;
  const updated = await compileTimeResponse(response(next, { observation: '同一手腕再次擦伤', occurrenceTime: '今天' }), next, [batch]);
  assert.notEqual(updated.changes[0].id, old.id);
  assert.equal(replayTimeBatches([batch, updated], value).length, 2);
  const corrected = await compileTimeResponse(response(next, { itemId: old.id, observation: '已止血', status: 'cancelled' }), next, [batch]);
  assert.equal(corrected.changes[0].projection, null);
  assert.equal(corrected.changes[0].occurrenceTime.date, '2026-05-09');
  assert.equal(corrected.changes[0].status, 'cancelled');
});

test('程序回灌原观察时间、经过/第N天及预计标识，明确关联状态成组预算', async () => {
  const source = { entities: [{ entityId: PERSON, displayName: '甲' }], identityProjection: {}, currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [{ stateId: 'state', sourceFloorId: FLOOR }] }] };
  const item = { id: 'item', subjectEntityId: PERSON, type: 'cycle', label: '周期', status: 'active', observation: '周期开始', observationKey: 'key', observationTime: projectTime('2026-05-09'), occurrenceTime: projectTime('2026-05-09'), dueTime: projectTime('2026-05-12'), stateRefs: [{ stateId: 'state', sourceFloorId: FLOOR }], projection: { text: '自然进程可能减轻', observationKey: 'key', applicableTime: projectTime('2026-05-11') } };
  const projection = timeRecallProjection([item], source, projectTime('2026-05-11'));
  assert.match(projection.corrections[`state|${PERSON}|${FLOOR}`].text, /已过2天（第3天）/u);
  assert.match(projection.reminders[0].text, /预计周期日.*尚未确认/u);
  const state = { stateId: 'state', sourceFloorId: FLOOR, subjectEntityId: PERSON, subject: '甲', layer: 'situational', text: '现在仍受伤', reason: '旧观察', visibility: 'observable' };
  const injection = formatRecallInjection({ floors: [], states: [state], coverage: { memoryComplete: true, cseCurrent: true }, entityById: new Map(), timeProjection: projection });
  assert.equal(injection.includes('现在仍受伤'), false);
  assert.match(injection, /原观察.*当前推测/u);
  assert.equal(state.text, '现在仍受伤');
  const without = formatRecallInjection({ floors: [], states: [state], coverage: { memoryComplete: true, cseCurrent: true }, entityById: new Map() }); assert.match(without, /现在仍受伤/u);
  const fresh = { ...source, currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [{ stateId: 'new', sourceFloorId: 'floor-2' }] }] };
  assert.equal(Object.keys(timeRecallProjection([item], fresh, projectTime('2026-05-11')).corrections).length, 0);
});

test('分支按真实前缀裁切及再次分支，无额外模型或未来记录', async () => {
  const back = backend(), store = createTimeStore(back);
  const prepared = await prepareTimeBatch(reachable()); prepared.request.chatId = CHAT;
  const first = await compileTimeResponse(response(prepared), prepared);
  const future = { ...structuredClone(first), id: 'future', cutoffFloorId: 'floor-2', cutoffAssistantSeq: 2, dependencies: [{ floorId: 'floor-2', memoryId: 'memory-2' }], changes: [] };
  await store.putBatch(CHAT, first); await store.putBatch(CHAT, future);
  await store.putHead(CHAT, { schemaVersion: 1, chatId: CHAT, batchIds: [first.id, future.id] }, 0);
  const child = 'child', grandchild = 'grandchild';
  await store.copyPrefix(CHAT, child, reachable().floors);
  assert.equal((await store.read(child)).batches.length, 1);
  assert.equal((await store.read(child)).batches[0].chatId, child);
  assert.deepEqual((await store.read(child)).head.lastAttemptTime, first.currentTime);
  await store.copyPrefix(child, grandchild, []);
  assert.equal((await store.read(grandchild)).batches.length, 0);
  assert.equal((await store.read(grandchild)).head.lastAttemptTime, null);
  back.records.delete(`chat-${CHAT}/${first.id}`); assert.equal((await store.read(child)).batches.length, 1);
});


test('真实selectRecall校正与原状态共同保留或舍弃，到期无话题独立入预算', () => {
  const state = { stateId: 'state', text: '手腕擦伤', visibility: 'observable', reason: '身体观察', origin: 'floor', towardEntityId: null, sourceFloorId: FLOOR, sourceDeltaId: 'delta', sourceAssistantSeq: 1 };
  const source = { status: 'ready', chatId: CHAT, entities: [{ entityId: PERSON, displayName: '甲', aliases: [], entityType: 'person', specialRole: 'char' }], floorMemories: [], cseChanges: [], currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [state] }], coverage: { memoryComplete: true, cseCurrent: true }, bodyMatch: { visibleFloorIds: [], summaryCoveredFloorIds: [] }, timeProjection: {
    corrections: { [`state|${PERSON}|${FLOOR}`]: { itemId: 'item', text: '原观察（5月9日）：手腕擦伤；已过2天（第3天）；当前推测：可能减轻' } }, reminders: [{ itemId: 'due', text: '甲 / 约定期限5月12日；尚未确认完成', distance: 1 }],
  } };
  const queryContext = buildRecallQueryContext({ coreChat: [{ is_user: true, mes: '甲的手腕怎么样' }] });
  const selected = selectRecall({ source, queryContext, contextSize: 8192 });
  assert.match(selected.injectionText, /原观察.*当前推测/u);
  assert.match(selected.injectionText, /约定期限5月12日/u);
  assert.equal(selected.states[0].text, '手腕擦伤', 'receipt留原观察供源校验，临时文本只在renderer');
  assert.ok(estimateRecallTokens(selected.injectionText) <= selected.limits.estimatedTokenBudget);
  source.timeProjection.corrections[`state|${PERSON}|${FLOOR}`].text = '原观察和预计'.repeat(6000);
  const dropped = selectRecall({ source, queryContext, contextSize: 8192 });
  assert.equal(dropped.states.length, 0);
  assert.equal(dropped.injectionText.includes('手腕擦伤'), false, '不能只截掉校正而留下旧状态');
  const breakfast = buildRecallQueryContext({ coreChat: [{ is_user: true, mes: '早餐吃什么' }] });
  const deadline = selectRecall({ source, queryContext: breakfast, contextSize: 8192 });
  assert.match(deadline.injectionText, /约定期限5月12日/u);
});

test('有效身体推测无同源CSE时独立参考同预算，首次观察与匹配状态不重复', () => {
  const current = projectTime('2026-05-10 20:30');
  const item = { id: 'body', subjectEntityId: PERSON, type: 'body', label: '擦伤', status: 'active', observation: '擦伤', observationKey: 'observed', observationTime: projectTime('2026-05-10 04:40'), occurrenceTime: projectTime(''), dueTime: projectTime(''), stateRefs: [], projection: { observationKey: 'observed', applicableTime: current, text: '可能逐渐减轻，仍待新观察确认' } };
  const source = { status: 'ready', chatId: CHAT, entities: [{ entityId: PERSON, displayName: '甲', aliases: [], entityType: 'person', specialRole: 'char' }], currentState: [], floorMemories: [], cseChanges: [], identityProjection: {}, coverage: { memoryComplete: true, cseCurrent: true }, bodyMatch: { visibleFloorIds: [], summaryCoveredFloorIds: [] } };
  source.timeProjection = timeRecallProjection([item], source, current);
  assert.equal(source.timeProjection.reminders.length, 1);
  const selected = selectRecall({ source, queryContext: buildRecallQueryContext({ coreChat: [{ is_user: true, mes: '早餐吃什么' }] }), contextSize: 8192 });
  assert.match(selected.injectionText, /时间状态参考.*观察后已过0天.*15\.8小时.*当前推测/u);
  assert.ok(estimateRecallTokens(selected.injectionText) <= selected.limits.estimatedTokenBudget);
  item.projection.text = '当前预计'.repeat(6000);
  source.timeProjection = timeRecallProjection([item], source, current);
  const omitted = selectRecall({ source, queryContext: buildRecallQueryContext({ coreChat: [{ is_user: true, mes: '早餐吃什么' }] }), contextSize: 8192 });
  assert.equal(omitted.injectionText.includes('时间状态参考'), false);
  assert.equal(projectInlineRecallReceipt({ schemaVersion: 11, status: omitted.status, injectionText: omitted.injectionText, selectedFloors: omitted.floors, selectedStates: omitted.states }).timeReferenceCount, 0, '楼内不从后台补入预算舍弃项');
  assert.equal(selected.stages.finalInjectionItemCount, selected.stages.timeReminderCount);
  assert.ok(omitted.stages.budgetDroppedCount >= omitted.stages.timeBudgetDropped);
  item.projection = null;
  assert.equal(timeRecallProjection([item], source, current).reminders.length, 0);
  item.projection = { observationKey: 'observed', applicableTime: current, text: '可能减轻' };
  item.stateRefs = [{ stateId: 'state', sourceFloorId: FLOOR }];
  source.currentState = [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [{ stateId: 'state', sourceFloorId: FLOOR, text: '擦伤' }] }];
  const matched = timeRecallProjection([item], source, current);
  assert.equal(Object.keys(matched.corrections).length, 1);
  assert.equal(matched.reminders.length, 0);
});

test('旧档近期身体与明确临近期约定同档按楼排序，超额不建队列', async () => {
  const value = reachable('2026-05-10', true);
  value.floorMemories[0].observations = [];
  value.floorMemories[0].commitments = [{ itemId: 'near', speakerEntityId: PERSON, kind: 'agreement', content: '2026-05-11履行约定', status: 'made' }];
  value.floorMemories[1].observations = Array.from({ length: 20 }, (_, index) => ({ itemId: `body-${index}`, subjectEntityId: PERSON, kind: 'physical', description: `身体观察${index}`.repeat(40) }));
  const prepared = await prepareTimeBatch(value, [], { inputCharacters: 3000 });
  assert.equal(prepared.request.observations[0].kind, 'body');
  const small = structuredClone(value); small.floorMemories[1].observations = [];
  assert.equal((await prepareTimeBatch(small)).request.observations[0].commitmentKind, 'agreement');
  assert.ok(prepared.omitted > 0);
  prepared.request.chatId = CHAT;
  const batch = await compileTimeResponse({ changes: [] }, prepared);
  const next = await prepareTimeBatch(value, [batch], { inputCharacters: 3000 });
  assert.equal(next.request.observations.length, 0, '舍弃不排队，原记忆完整保留');
  assert.equal(value.floorMemories[1].observations.length, 20);
});

test('旧逾期计划不压近期伤情，类型保留而边界暗号排除', async () => {
  const value = reachable('2026-05-11', true);
  value.floorMemories[0].commitments = ['plan', 'command', 'boundary', 'codePhrase'].map(kind => ({ itemId: kind, speakerEntityId: PERSON, kind, content: '明天再说', status: 'made' }));
  value.floorMemories[1].observations = [{ itemId: 'recent-injury', subjectEntityId: PERSON, kind: 'injury', description: '新伤' }];
  const prepared = await prepareTimeBatch(value);
  assert.equal(prepared.request.observations[0].observationKind, 'injury');
  assert.deepEqual(prepared.request.observations.filter(item => item.kind === 'deadline').map(item => item.commitmentKind), ['plan', 'command']);
});

test('同人物旧项以短DTO进入预算，编译仍用完整记录且发生未知可算观察时长', async () => {
  const first = await prepareTimeBatch(reachable('2026-05-10 04:40')); first.request.chatId = CHAT;
  const batch = await compileTimeResponse(response(first, { occurrenceTime: '' }), first);
  const later = reachable('2026-05-10 20:30', true);
  later.floorMemories[0].chronology = [{ time: { kind: 'explicit', normalized: '2026-05-10 04:40' } }];
  later.floorMemories[1].observations = [{ itemId: 'unrelated-description', subjectEntityId: PERSON, kind: 'injury', description: '新的不同表述' }];
  const prepared = await prepareTimeBatch(later, [batch]); prepared.request.chatId = CHAT;
  assert.equal(prepared.request.trackedItems.length, 1);
  const dto = prepared.request.trackedItems[0];
  assert.equal(dto.sourceRefs, undefined);
  assert.equal(dto.elapsedHours, null);
  assert.ok(Math.abs(dto.observationElapsedHours - (15 + 50 / 60)) < 0.0001);
  const updated = await compileTimeResponse({ changes: [{ itemId: dto.id, subjectEntityId: PERSON, type: 'body', label: dto.label, status: 'active', sourceKeys: [], progression: '可能逐渐减轻' }] }, prepared);
  assert.deepEqual(updated.changes[0].sourceRefs, batch.changes[0].sourceRefs);
});


test('昨晚到今早钟点可算，身体每6小时机会与明确期限到点稀疏触发', async () => {
  assert.equal(projectTime('2026-05-11T08:00:00Z').clock, '08:00');
  assert.equal(timeHours(projectTime('5月10日 22:00'), projectTime('5月11日 08:00')), 10);
  const value = reachable('2026-05-10 08:00', true);
  const prepared = await prepareTimeBatch(value); prepared.request.chatId = CHAT;
  const batch = await compileTimeResponse(response(prepared, { occurrenceTime: '昨天 22:00' }), prepared);
  value.floorMemories[1].chronology[0].time.normalized = '2026-05-10 09:00';
  assert.equal((await prepareTimeBatch(value, [batch], { lastAttemptTime: projectTime('2026-05-10 08:00') })).shouldRequest, false);
  value.floorMemories[1].chronology[0].time.normalized = '2026-05-10 14:00';
  const next = await prepareTimeBatch(value, [batch], { lastAttemptTime: projectTime('2026-05-10 08:00') });
  assert.equal(next.shouldRequest, true);
  assert.equal(next.request.trackedItems[0].elapsedHours, 16);
  const due = { ...structuredClone(batch), changes: [{ ...batch.changes[0], type: 'deadline', dueTime: projectTime('2026-05-10 14:30') }] };
  value.floorMemories[1].chronology[0].time.normalized = '2026-05-10 14:31';
  assert.equal((await prepareTimeBatch(value, [due], { lastAttemptTime: projectTime('2026-05-10 14:00') })).shouldRequest, true);
});

test('明确周期只推进预计节点，未确认不当已发生；单独时间读失败保持原召回入口', async () => {
  const item = { type: 'cycle', dueTime: projectTime('2026-05-01'), periodDays: 7 };
  assert.equal(nextCycleTime(item, projectTime('2026-05-10')).date, '2026-05-01');
  assert.equal(nextCycleTime({ ...item, periodDays: null }, projectTime('2026-05-10')).date, '2026-05-01');
  const runtime = createTimeRuntime({ store: { read: async () => { throw new Error('offline'); } }, foundationStore: {}, hostAdapter: {}, session: { identity: () => ({ chatId: CHAT }) }, isEnabled: () => true, generateAnalysisTask: async () => {}, logger: { warn() {} } });
  assert.equal(await runtime.recallProjection({ status: 'ready', chatId: CHAT, headCheckpointId: 'head' }), null);
  assert.equal(runtime.getState().status, 'failed');
});


test('正文明确时间范围取末端，unknown参考原文有明确格式仍可算', () => {
  const value = reachable();
  value.floorMemories[0].chronology = [{ time: { kind: 'explicit', normalized: null, sourceText: '5月10日 22:00 → 5月11日 08:00' } }];
  const time = storyTimes(value.floorMemories, value.floors).get(FLOOR);
  assert.equal(time.monthDay, 11); assert.equal(time.clock, '08:00'); assert.match(time.rangeText, /22:00/u);
  value.floorMemories[0].chronology[0].time.kind = 'unknown';
  assert.equal(storyTimes(value.floorMemories, value.floors).get(FLOOR).monthDay, 11);
});


test('未确认周期超期仍在真实到期回灌，不滚到下月隐藏', () => {
  const item = { id: 'cycle', subjectEntityId: PERSON, type: 'cycle', label: '周期', status: 'active', periodDays: 28, dueTime: projectTime('2026-09-17'), occurrenceTime: projectTime('2026-08-20'), observationTime: projectTime('2026-08-20'), observation: '上次周期开始', observationKey: 'cycle-key', projection: null, stateRefs: [] };
  const source = { entities: [{ entityId: PERSON, displayName: '甲' }], currentState: [], identityProjection: {} };
  const projection = timeRecallProjection([item], source, projectTime('2026-09-18'));
  assert.equal(projection.reminders.length, 1);
  assert.match(projection.reminders[0].text, /2026-09-17.*已过1天.*尚未确认/u);
});

test('新实际周期确认重置发生锚，明确周期长度由程序算预计日', async () => {
  const prepared = await prepareTimeBatch(reachable('2026-09-18'));
  prepared.request.chatId = CHAT;
  prepared.request.trackedItems = [{ id: 'cycle', subjectEntityId: PERSON, type: 'cycle', occurrenceTime: projectTime('2026-08-20'), dueTime: projectTime('2026-09-17'), periodDays: 28, observationKey: 'old' }];
  const batch = await compileTimeResponse(response(prepared, { itemId: 'cycle', type: 'cycle', occurrenceTime: '今天', dueTime: '2026-12-01', periodDays: 28 }), prepared);
  assert.equal(batch.changes[0].occurrenceTime.date, '2026-09-18');
  assert.equal(batch.changes[0].dueTime.date, '2026-10-16');
  const noDate = await compileTimeResponse(response(prepared, { itemId: 'cycle', type: 'cycle', occurrenceTime: '', dueTime: '', periodDays: 28 }), prepared);
  assert.equal(noDate.changes[0].occurrenceTime.date, '2026-08-20');
});


test('人工记忆新版本原观察不变，旧依赖失效后后续真实批次可重新捕获', async () => {
  const before = await prepareTimeBatch(reachable()); before.request.chatId = CHAT;
  const batch = await compileTimeResponse(response(before), before);
  const edited = reachable(); edited.floorMemories[0].id = 'replacement-memory';
  assert.equal(replayTimeBatches([batch], edited).length, 0);
  const after = await prepareTimeBatch(edited, [batch]);
  assert.equal(after.request.observations.length, 1);
  assert.notEqual(after.signature, before.signature);
});

test('只修短历史记忆使旧批次失效，原身体来源仍可重新登记', async () => {
  const original = reachable('2026-05-11', true);
  const before = await prepareTimeBatch(original); before.request.chatId = CHAT;
  const batch = await compileTimeResponse(response(before), before);
  assert.ok(batch.dependencies.some(ref => ref.floorId === 'floor-2'));
  const edited = structuredClone(original); edited.floorMemories[1].id = 'memory-2-edited';
  assert.equal(replayTimeBatches([batch], edited).length, 0);
  const after = await prepareTimeBatch(edited, [batch]);
  assert.equal(after.request.observations.length, 1);
  assert.equal(after.shouldRequest, true);
});

test('上游依赖失效导致更新观察链断开，该更新来源不算已处理', async () => {
  const original = reachable('2026-05-11', true);
  original.floorMemories[1].observations = [{ itemId: 'new-observation', subjectEntityId: PERSON, kind: 'injury', description: '手腕擦伤的新观察' }];
  const before = await prepareTimeBatch(original); before.request.chatId = CHAT;
  const batch = await compileTimeResponse(response(before), before);
  const updateRef = before.request.observations.find(ref => ref.floorId === 'floor-2');
  const update = { ...structuredClone(batch), id: 'update', dependencies: [{ floorId: 'floor-2', memoryId: 'memory-2' }], sourceKeys: [updateRef.sourceKey],
    changes: [{ ...batch.changes[0], previousObservationKey: batch.changes[0].observationKey, observationKey: 'updated-observation' }] };
  const edited = structuredClone(original); edited.floorMemories[0].id = 'memory-edited';
  assert.equal(replayTimeBatches([batch, update], edited).length, 0);
  const after = await prepareTimeBatch(edited, [batch, update]);
  assert.ok(after.request.observations.some(ref => ref.sourceKey === updateRef.sourceKey));
  assert.equal(after.shouldRequest, true);
});

test('在途期间只合并最新真实完成通知，结束后检查新材料一次', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let attempts = 0;
  const h = harness({ generate: async (_, prepared) => { attempts += 1; if (attempts === 1) await gate; return response(prepared); } });
  const first = h.runtime.runBatch({ chatId: CHAT, headCheckpointId: 'head' });
  while (!h.calls()) await new Promise(resolve => setImmediate(resolve));
  const later = reachable('2026-05-11', true); later.root.headCheckpointId = 'head-next'; later.floorMemories[1].observations = [{ itemId: 'new', subjectEntityId: PERSON, kind: 'injury', description: '肩部受伤' }];
  h.setSource(later); await h.runtime.runBatch({ chatId: CHAT, headCheckpointId: 'head-next' }); await h.runtime.runBatch({ chatId: CHAT, headCheckpointId: 'head-next' });
  release(); await first;
  for (let count = 0; count < 1000 && h.runtime.getState().active; count += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.calls(), 2);
  assert.equal((await h.store.read(CHAT)).batches.length, 1);
});


test('同日时钟回退时未来推演不可采用', () => {
  const item = { id: 'body', subjectEntityId: PERSON, type: 'body', status: 'active', label: '擦伤', observation: '擦伤', observationKey: 'key', observationTime: projectTime('2026-05-10 07:00'), occurrenceTime: projectTime('2026-05-10 07:00'), dueTime: projectTime(''), stateRefs: [{ stateId: 'state', sourceFloorId: FLOOR }], projection: { observationKey: 'key', applicableTime: projectTime('2026-05-10 14:00'), text: '未来预计状态' } };
  const source = { entities: [{ entityId: PERSON, displayName: '甲' }], identityProjection: {}, currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [{ stateId: 'state', sourceFloorId: FLOOR }] }] };
  const projection = timeRecallProjection([item], source, projectTime('2026-05-10 08:00'));
  assert.equal(projection.corrections[`state|${PERSON}|${FLOOR}`].text.includes('未来预计状态'), false);
  assert.match(projection.corrections[`state|${PERSON}|${FLOOR}`].text, /待新观察确认/u);
});

test('整理结果持久重开，只读刷新零模型；有效数量按当前来源重放', async () => {
  const h = harness();
  await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().status, 'idle'); assert.equal(h.back.records.size, 0);
  await h.runtime.organize(); assert.equal(h.calls(), 1);
  assert.equal((await h.store.read(CHAT)).head.lastRun.status, 'completed');
  h.reload(); await h.runtime.refreshStatus();
  assert.equal(h.runtime.getState().last.items, 1); assert.equal(h.runtime.getState().last.cutoffAssistantSeq, 1);
  await h.runtime.organize(); assert.equal(h.calls(), 1, '成功同签名不重复请求');
  const edited = reachable(); edited.floorMemories[0].id = 'edited-memory'; h.setSource(edited);
  await h.runtime.refreshStatus({ force: true }); assert.equal(h.runtime.getState().last.items, 0, '不采用旧回执内保存的1条');
  assert.equal(h.calls(), 1);
});

test('成功空项与本地无候选均持久为已检查，旧head可读但attempt不是成功', async () => {
  for (const local of [false, true]) {
    const h = harness({ generate: async () => ({ changes: [] }) });
    if (local) { const source = reachable(); source.floorMemories[0].observations = []; h.setSource(source); }
    await h.runtime.organize(); assert.equal(h.calls(), local ? 0 : 1);
    h.reload(); await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().status, 'empty');
    await h.runtime.organize(); assert.equal(h.calls(), local ? 0 : 1);
  }
  const h = harness(); await h.runtime.organize();
  const stored = await h.store.read(CHAT); delete stored.head.lastRun;
  await h.store.putHead(CHAT, stored.head, stored.revision);
  h.reload(); await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().status, 'completed');
  const latest = await h.store.read(CHAT); latest.head.lastAttemptSignature = 'unconfirmed-attempt';
  await h.store.putHead(CHAT, latest.head, latest.revision);
  h.reload(); await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().status, 'interrupted');
});

test('分析失败冷重开显式重试一次，自动同份材料不解禁，安全错误不保存原文', async () => {
  let fail = true;
  const h = harness({ generate: async (_, prepared) => { if (fail) throw Object.assign(new Error('私密key不应出现'), { code: 'QQJ_AUTH' }); return response(prepared); } });
  await h.runtime.organize(); assert.equal(h.runtime.getState().status, 'failed');
  assert.match((await h.store.read(CHAT)).head.lastRun.message, /认证失败/u);
  assert.equal(JSON.stringify((await h.store.read(CHAT)).head).includes('私密'), false);
  h.reload(); await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().status, 'failed'); assert.equal(h.calls(), 1);
  await h.runtime.runBatch({ chatId: CHAT }); assert.equal(h.calls(), 1);
  fail = false; await h.runtime.organize(); assert.equal(h.calls(), 2); assert.equal(h.runtime.getState().status, 'completed');
  await h.runtime.organize(); assert.equal(h.calls(), 2);
});

test('时钟失败重试恢复previousAttemptTime，孤儿batch不会与重试ID冲突', async () => {
  let failure = false;
  const h = harness({ generate: async (options, prepared) => {
    const input = JSON.parse(options.taskMessages[0].content);
    if (failure) throw new Error('offline');
    if (input.observations.length) return response(prepared);
    assert.equal(input.trackedItems.length, 1);
    return { changes: [] };
  } });
  h.setSource(reachable('2026-05-10 08:00')); await h.runtime.organize();
  const later = reachable('2026-05-10 14:00', true); later.floorMemories[0].chronology[0].time.normalized = '2026-05-10 08:00'; h.setSource(later);
  failure = true; await h.runtime.runBatch({ chatId: CHAT });
  assert.equal((await h.store.read(CHAT)).head.lastRun.previousAttemptTime.clock, '08:00');
  h.reload(); await h.runtime.refreshStatus(); await h.runtime.runBatch({ chatId: CHAT }); assert.equal(h.calls(), 2);
  failure = false; await h.runtime.organize(); assert.equal(h.calls(), 3, '14点失败后仍能重试6小时时钟机会');

  const orphan = harness(); const put = orphan.back.client.put;
  let failHead = true;
  orphan.back.client.put = async (...args) => { if (failHead && args[2]?.lastRun?.status === 'completed') { failHead = false; throw new Error('head unavailable'); } return put(...args); };
  await orphan.runtime.organize(); assert.equal(orphan.runtime.getState().status, 'failed');
  assert.equal((await orphan.store.read(CHAT)).batches.length, 0);
  orphan.reload(); await orphan.runtime.organize();
  assert.equal(orphan.calls(), 2); assert.equal((await orphan.store.read(CHAT)).batches.length, 1);
  assert.equal([...orphan.back.records.keys()].filter(key => key.includes('/v3-time-batch-')).length, 2, '孤儿保留不清理，重试使用新attempt revision ID');
});

test('手动双击最多一次且不补队列，关闭/重构busy/摘要缺口/CSE缺口不请求', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ generate: async (_, prepared) => { await gate; return response(prepared); } });
  const first = h.runtime.organize(); while (!h.calls()) await new Promise(resolve => setImmediate(resolve));
  await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().status, 'running');
  await h.runtime.organize(); assert.equal(h.calls(), 1);
  await h.runtime.runBatch({ chatId: CHAT, headCheckpointId: 'head-next' }); release(); await first;
  assert.equal(h.calls(), 1);
  const blocked = harness(); blocked.setBusy(true); await blocked.runtime.organize(); assert.match(blocked.runtime.getState().disabledReason, /等待/u);
  blocked.setBusy(false); blocked.setCseReady(false); await blocked.runtime.organize();
  blocked.setCseReady(true); const partial = reachable('2026-05-11', true); partial.floorMemories.pop(); blocked.setSource(partial); await blocked.runtime.organize();
  blocked.setSource(null); await blocked.runtime.refreshStatus(); await blocked.runtime.organize(); assert.equal(blocked.runtime.getState().status, 'waiting');
  blocked.setSource(reachable()); blocked.setEnabled(false); await blocked.runtime.organize(); await blocked.runtime.refreshStatus();
  assert.equal(blocked.calls(), 0); assert.equal(blocked.back.records.size, 0);
});

test('只读失败明确显示，未落盘失败保留；持久running重开为未完成', async () => {
  const h = harness(); const get = h.back.client.get;
  h.back.client.get = async () => { throw new Error('unavailable'); };
  await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().status, 'failed'); assert.equal(h.runtime.getState().last.reason, 'read'); assert.equal(h.calls(), 0);
  h.back.client.get = get; await h.runtime.refreshStatus({ force: true }); assert.equal(h.runtime.getState().status, 'idle');
  const prepared = await prepareTimeBatch(reachable());
  await h.store.putHead(CHAT, { schemaVersion: 1, chatId: CHAT, batchIds: [], lastAttemptSignature: prepared.signature, lastAttemptTime: prepared.request.currentTime, lastRun: { status: 'running', previousAttemptTime: null } }, 0);
  h.reload(); await h.runtime.refreshStatus(); assert.equal(h.runtime.getState().status, 'interrupted');
  await h.runtime.runBatch({ chatId: CHAT }); assert.equal(h.calls(), 0);
  await h.runtime.organize(); assert.equal(h.calls(), 1);

  const failed = harness({ generate: async () => { throw new Error('offline'); } }); const put = failed.back.client.put;
  failed.back.client.put = async (...args) => { if (args[2]?.lastRun?.status === 'failed') throw new Error('storage unavailable'); return put(...args); };
  await failed.runtime.organize(); assert.equal(failed.runtime.getState().last.persisted, false);
  await failed.runtime.refreshStatus({ force: true }); assert.equal(failed.runtime.getState().status, 'failed');
});

test('旧图 ready 但记忆待核对或读取失败时手动整理零 API', async () => {
  for (const status of ['needsReview', 'error']) {
    const h = harness(); h.setSyncStatus(status);
    await h.runtime.refreshStatus();
    assert.equal(h.runtime.getState().canOrganize, false);
    assert.match(h.runtime.getState().disabledReason, /先同步当前聊天记忆/);
    await h.runtime.organize(); assert.equal(h.calls(), 0); assert.equal(h.back.records.size, 0);
  }
});
