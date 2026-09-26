import test from 'node:test';
import assert from 'node:assert/strict';
import { ANNUAL_SETTING_SYSTEM_PROMPT, buildAnnualSettingSources, compileAnnualSettingResponse, projectAnnualSettings } from '../src/v3/time-annual-setting.js';
import { createTimeRuntime, createTimeStore } from '../src/v3/time-runtime.js';
import { projectTime, timeRecallProjection } from '../src/v3/time-engine.js';
import { buildRecallQueryContext, selectRecall } from '../src/v3/recall-selector.js';
import { scanAssistantCandidates, createFloorRecord } from '../src/v3/foundation-domain.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', PERSON = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('只投递生日与明确年度语义小段，无关资料不进入指纹来源', () => {
  const profile = { name: '阿岚', birthday: '1999年9月20日', notes: '喜欢蓝色。每年9月21日去祭奠老师。发型为短发。', background: '2012年7月1日搬家。', identityRelations: '' };
  const sources = buildAnnualSettingSources({ people: [{ entityId: PERSON, displayName: '阿岚', profile }],
    userPersona: { entityId: USER, name: '用户', description: '身高170。纪念日是每年10月2日。喜欢咖啡。' } });
  assert.deepEqual(sources.map(source => source.sourceKey), [`person:${PERSON}:birthday`, `person:${PERSON}:notes`, `user:${USER}:description`]);
  assert.match(sources[1].content, /祭奠老师/u); assert.equal(sources[1].content.includes('发型'), false);
  assert.equal(sources.some(source => source.content.includes('搬家')), false, '只有一次历史日期不成为年度来源');
  assert.equal(sources[2].content.includes('身高'), false);
});

test('每来源恰好一个结果才留痕，合法空结果可保存且坏来源保持待处理', () => {
  const sources = [
    { id: 'S1', sourceKey: 'one', fingerprint: 'fp1', subjectEntityId: PERSON, subjectName: '阿岚', field: 'birthday' },
    { id: 'S2', sourceKey: 'two', fingerprint: 'fp2', subjectEntityId: USER, subjectName: '用户', field: 'description' },
  ];
  const compiled = compileAnnualSettingResponse({ sources: [
    { sourceId: 'S1', items: [] },
    { sourceId: 'S2', items: [{ category: 'anniversary', label: '相识纪念日', originalDate: '每年10月2日', note: '相识周年' }] },
  ] }, { sources });
  assert.equal(compiled.succeeded.length, 2); assert.deepEqual(compiled.succeeded[0].items, []); assert.equal(compiled.errors.length, 0);
  assert.deepEqual(compiled.succeeded[1].items[0], { category: 'anniversary', label: '相识纪念日', originalDate: '每年10月2日', month: 10, day: 2, note: '相识周年' });
  assert.doesNotMatch(ANNUAL_SETTING_SYSTEM_PROMPT, /calendar|历法|公历/u, '年度提取提示与新条目不再要求分类日期体系');
  assert.equal(Object.hasOwn(compiled.succeeded[1].items[0], 'calendar'), false);
  const partial = compileAnnualSettingResponse({ sources: [{ sourceId: 'S1', items: [] }, { sourceId: 'S2', items: [] }, { sourceId: 'S2', items: [] }] }, { sources });
  assert.deepEqual(partial.succeeded.map(row => row.sourceKey), ['one']); assert.equal(partial.errors[0].sourceKey, 'two');
});

test('年度提醒只看本年，月日可跨月，跨年不猜，旧特殊日期保留原文', () => {
  const records = [{ sourceKey: 'birthday', fingerprint: 'fp', subjectEntityId: PERSON, subjectName: '阿岚', items: [
    { category: 'birthday', label: '生日', originalDate: '1999年9月20日', month: 9, day: 20, note: '' },
    { category: 'anniversary', label: '月神祭', originalDate: '霜月初三', calendar: 'special', month: null, day: null, note: '每年祭典' },
  ] }];
  let projected = projectAnnualSettings(records, projectTime('2026-09-13'), []);
  assert.equal(projected.reminders[0].distance, 7); assert.equal(projected.items[1].status, '日期或年份未明确');
  assert.match(projected.reminders[0].text, /生日：原日期 1999年9月20日；下次日期 2026-09-20，还有7天/u);
  assert.doesNotMatch(projected.reminders[0].text, /尚未确认庆祝、纪念或履约/u, '通用未确认提示由时间参考总则统一说明');
  projected = projectAnnualSettings(records, projectTime('2026-09-21'), []);
  assert.equal(projected.items[0].nextDate, null); assert.equal(projected.items[0].status, '本年日期已过');
  assert.ok(projected.reminders.some(item => /原日期 1999年9月20日/u.test(item.text) && !Number.isFinite(item.distance)), '已过日期保留原文供相关召回判断，不猜下次年份');
  assert.ok(projected.reminders.some(item => /原日期 霜月初三/u.test(item.text) && !Number.isFinite(item.distance)), '特殊日期作为原文线索进入召回，不声称临近');
  projected = projectAnnualSettings(records, projectTime('9月13日'), []);
  assert.equal(projected.reminders[0].distance, 7); assert.equal(projected.items[0].nextDate, '9月20日（年份未明）');
  const crossMonth = [{ ...records[0], items: [{ category: 'anniversary', label: '纪念日', originalDate: '每年10月2日', month: 10, day: 2, note: '' }] }];
  projected = projectAnnualSettings(crossMonth, projectTime('2026-09-29'), []);
  assert.equal(projected.reminders[0].distance, 3, '明确公历当前年允许普通跨月日期进入7日提醒');
  projected = projectAnnualSettings(crossMonth, projectTime('大陆历1686年9月29日'), []);
  assert.equal(projected.reminders[0].distance, null, '特殊当前故事时间不借公历月日推年度提醒');
  assert.match(projected.reminders[0].text, /原日期 每年10月2日[\s\S]*当前日期关系不明确/u);
  for (const originalDate of ['公曆10月2日', '西曆2026年10月2日']) {
    const prefixed = [{ ...records[0], items: [{ category: 'anniversary', label: '纪念日', originalDate, note: '' }] }];
    const item = projectAnnualSettings(prefixed, projectTime('2026-09-29'), []).items[0];
    assert.equal(item.distance, 3, `${originalDate} 应与已有普通日期前缀保持一致`);
  }
  assert.equal(projectAnnualSettings(crossMonth, projectTime('2026-12-31'), []).items[0].nextDate, null, '本年已过的日期不自动滚到下一年');
  const special = [{ ...records[0], items: [{ category: 'anniversary', label: '祭典', originalDate: '大陆历1686年10月2日', month: 10, day: 2 }] }];
  projected = projectAnnualSettings(special, projectTime('2026-09-29'), []);
  assert.equal(projected.reminders.length, 1, '旧 calendar 不覆盖特殊纪年，未计算的原文仍进入召回');
  assert.match(projected.reminders[0].text, /原日期 大陆历1686年10月2日[\s\S]*当前日期关系不明确/u);
  assert.equal(projected.reminders[0].distance, null);
  assert.equal(Object.hasOwn(projected.items[0], 'calendar'), false, '旧 calendar 只读取为兼容，不进入新输出');
  const leap = [{ ...records[0], items: [{ category: 'birthday', label: '生日', originalDate: '2月29日', calendar: 'gregorian', month: 2, day: 29, note: '' }] }];
  projected = projectAnnualSettings(leap, projectTime('2025-03-01'), []);
  assert.equal(projected.items[0].nextDate, null); assert.equal(projected.items[0].status, '本年没有该日期');
  assert.ok(projected.reminders.some(item => /原日期 2月29日/u.test(item.text) && !Number.isFinite(item.distance)));
  projected = projectAnnualSettings(leap, projectTime('2024-02-28'), []);
  assert.equal(projected.items[0].nextDate, '2024-02-29');
  projected = projectAnnualSettings([{ ...records[0], items: [{ ...crossMonth[0].items[0], month: null, day: null }] }], projectTime('9月29日'), []);
  assert.equal(projected.items[0].distance, 3, '旧年份不明普通月日跨月可按同年区间计算');
  const duplicate = [{ type: 'deadline', subjectEntityId: PERSON, dueTime: projectTime('2026-09-20'), label: '生日提醒', observation: '生日将至' }];
  const deduplicated = projectAnnualSettings(records, projectTime('2026-09-19'), duplicate).reminders;
  assert.equal(deduplicated.some(item => /原日期 1999年9月20日/u.test(item.text)), false, '仅本轮同一次正文提醒去重');
  assert.ok(deduplicated.some(item => /原日期 霜月初三/u.test(item.text)), '去重不隐藏未计算的其他原文线索');
  duplicate[0].dueTime = projectTime('2025-09-20');
  assert.equal(projectAnnualSettings(records, projectTime('2026-09-19'), duplicate).reminders.length, 2, '旧年事项不能压掉今年提醒，其他原文线索仍可召回');
  duplicate[0].type = 'cycle'; duplicate[0].dueTime = projectTime('2026-09-20');
  assert.equal(projectAnnualSettings(records, projectTime('2026-09-19'), duplicate).reminders.length, 2, '周期事项不能冒充年度日期去重');
  duplicate[0].type = 'deadline'; duplicate[0].dueTime = projectTime('9月20日');
  assert.equal(projectAnnualSettings(records, projectTime('9月19日'), duplicate).reminders.length, 1, '年份未明时正文期限去重，特殊原文线索仍保留');
});

test('未计算的年度原文经过真实主楼召回选择器进入相关上下文', () => {
  const records = [{ sourceKey: 'annual', fingerprint: 'fp', subjectEntityId: PERSON, subjectName: '阿岚', items: [
    { category: 'anniversary', label: '霜月纪念', originalDate: '大陆历1686年霜月初三', month: null, day: null, note: '每年霜月祭典' },
  ] }];
  const projection = timeRecallProjection([], { entities: [{ entityId: PERSON, displayName: '阿岚' }], identityProjection: {}, currentState: [] },
    projectTime('2026-10-10'), records);
  assert.equal(projection.reminders[0].distance, null);
  const source = { status: 'ready', chatId: CHAT, entities: [{ entityId: PERSON, displayName: '阿岚', aliases: [], entityType: 'person', specialRole: 'char' }],
    floorMemories: [], cseChanges: [], currentState: [], coverage: { memoryComplete: true, cseCurrent: true },
    bodyMatch: { visibleFloorIds: [], summaryCoveredFloorIds: [] }, timeProjection: projection };
  const selected = selectRecall({ source, queryContext: buildRecallQueryContext({ coreChat: [{ is_user: true, mes: '阿岚的霜月纪念是什么' }] }), contextSize: 8192 });
  assert.match(selected.injectionText, /原日期 大陆历1686年霜月初三/u);
  assert.doesNotMatch(selected.injectionText, /还有\d+天|临近|最近/u);
});

function backend() {
  const records = new Map();
  return { client: {
    async health() { return { capabilities: { permanentDelete: true } }; },
    async get(collection, id) { const value = records.get(`${collection}/${id}`); if (!value) throw Object.assign(new Error('missing'), { status: 404 }); return structuredClone(value); },
    async put(collection, id, data, revision) { const key = `${collection}/${id}`, old = records.get(key); assert.equal(old?.revision ?? 0, revision); const value = { data: structuredClone(data), revision: revision + 1 }; records.set(key, value); return structuredClone(value); },
    async removePermanent(collection, id, revision) { const key = `${collection}/${id}`, old = records.get(key); if (!old) throw Object.assign(new Error('missing'), { status: 404 }); if (old.revision !== revision) throw Object.assign(new Error('conflict'), { status: 409 }); records.delete(key); return { ok: true }; },
  } };
}

test('同一计划处理正文与年度时只多一次请求，正文保存和编辑后年度UI仍保留', async () => {
  const chat = [{ is_user: false, mes: '<!-- QQJ-start | date=2026-09-19 | time=08:00 -->阿岚回到家。<!-- QQJ-end | date=2026-09-19 | time=09:00 -->' }, { is_user: true, mes: '继续' }];
  const candidates = await scanAssistantCandidates(chat, { chatId: CHAT });
  const root = { chatId: CHAT, narrativeGeneration: 'generation', headCheckpointId: 'head' };
  const source = { status: 'ready', root, rootRevision: 1, floors: candidates.filter(row => row.stabilityProof).map((candidate, index) => createFloorRecord({ candidate, id: `floor-${index + 1}`, chatId: CHAT, narrativeGeneration: root.narrativeGeneration })), floorMemories: [], stateDeltas: [], entities: [], baseline: { userPersona: { entityId: USER, name: '用户' } } };
  const store = createTimeStore({ client: backend().client });
  const profile = { name: '阿岚', birthday: '9月20日' };
  const runtime = createTimeRuntime({ store, foundationStore: { readRoot: async () => ({ data: root }) }, hostAdapter: { snapshot: () => ({ chat, chatId: 'host', context: { chatMetadata: { qianqianjie: { chatId: CHAT } } } }) },
    session: { identity: () => ({ chatId: CHAT, hostChatId: 'host' }) }, getReachable: () => source, getMemoryState: () => ({ memorySyncStatus: 'idle' }), isEnabled: () => true,
    annualSettingsProvider: () => ({ ready: true, people: [{ entityId: PERSON, displayName: '阿岚', profile }] }),
    generateTimeTask: async ({ taskMessages }) => { const request = JSON.parse(taskMessages[0].content);
      if (request.task === 'annual-settings') return { jsonData: { sources: request.sources.map(row => ({ sourceId: row.sourceId, items: [{ category: 'birthday', label: '生日', originalDate: '9月20日', note: '' }] })) } };
      if (request.currentReview) return { jsonData: { changes: request.trackedItems.map(item => ({ itemId: item.id, progression: '仍待后续正文确认。', assessmentReason: '' })) } };
      return { jsonData: { changes: [{ itemId: null, subjectEntityId: null, subjectName: '阿岚', type: 'deadline', label: '回信期限', observation: '阿岚准备回信', occurrenceTime: '2026-09-19', dueTime: '2026-09-20', periodDays: null, status: 'active', stateRefs: [], progression: '尚未确认回信。', sourceKeys: [request.observations[0].sourceKey] }] } }; },
    newUuid: (() => { let id = 0; return () => `annual-body-${++id}`; })() });
  const plan = await runtime.prepareHistoryPlan();
  assert.equal(plan.annualSetting.shouldRequest, true);
  assert.equal(plan.apiCalls, plan.bodyBatchCount + Number(plan.currentReview) + 1);
  await runtime.organize(plan);
  assert.equal(runtime.getState().annualItems.length, 1, '同一计划的正文批次保存后保留年度UI');
  const item = runtime.getState().trackedItems[0];
  await runtime.editItem(item.id, { label: '人工回信期限' }, item.observationKey);
  assert.equal(runtime.getState().annualItems.length, 1, '编辑正文事项后保留年度UI');
  let stored = await store.read(CHAT);
  const pending = [{ id: 'expired-time-batch', revision: 1 }];
  await store.putHead(CHAT, { ...stored.head, pendingDeletionRecords: pending }, stored.revision);
  runtime.invalidate(); await runtime.refreshStatus({ force: true }); assert.equal(runtime.getState().pendingDeletionCount, 1);
  profile.birthday = '9月21日'; await runtime.runBatch();
  assert.equal(runtime.getState().pendingDeletionCount, 1, '年度资料更新改写lastRun后仍显示持久待清理状态');
  stored = await store.read(CHAT); assert.deepEqual(stored.head.pendingDeletionRecords, pending);
  await runtime.deleteItems([]); assert.equal(runtime.getState().pendingDeletionCount, 0, '年度更新后仍能从同一入口续清');
});

test('旧档无正文可补读；相同和无关变化不调用，相关变化调用，失败同触发抑制且手动可重试，清空撤项', async () => {
  const db = backend(), store = createTimeStore({ client: db.client });
  let calls = 0, fail = false, enabled = true, providerReady = true, hold = null, releaseHold = null, announceHold = null;
  const profile = { name: '阿岚', birthday: '9月20日', notes: '', background: '', identityRelations: '', appearance: '短发' };
  const root = { chatId: CHAT, narrativeGeneration: 'generation', headCheckpointId: 'head' };
  const source = { status: 'ready', root, rootRevision: 1, floors: [], floorMemories: [], stateDeltas: [], entities: [], baseline: { userPersona: { entityId: USER, name: '用户' } } };
  const runtime = createTimeRuntime({ store, foundationStore: { readRoot: async () => ({ data: root }) },
    hostAdapter: { snapshot: () => ({ chat: [], chatId: 'host', context: { chatMetadata: { qianqianjie: { chatId: CHAT } } } }) }, session: { identity: () => ({ chatId: CHAT, hostChatId: 'host' }) },
    getReachable: () => source, getMemoryState: () => ({ memorySyncStatus: 'idle' }), isEnabled: () => enabled,
    annualSettingsProvider: () => providerReady ? ({ ready: true, people: [{ entityId: PERSON, displayName: '阿岚', profile }], userPersona: { entityId: USER, name: '用户', description: '' } }) : ({ ready: false }),
    generateTimeTask: async ({ taskMessages }) => { calls += 1; if (fail) throw new Error('synthetic'); const request = JSON.parse(taskMessages[0].content); if (hold) { announceHold(); await hold; }
      return { jsonData: { sources: request.sources.map(row => ({ sourceId: row.sourceId, items: row.field === 'birthday' ? [{ category: 'birthday', label: '生日', originalDate: '9月20日', note: '' }] : [] })) } }; },
    newUuid: () => `id-${calls}`,
  });
  await runtime.runBatch(); assert.equal(calls, 1); assert.equal(Object.keys((await store.read(CHAT)).head.settingAnnualSources).length, 1);
  const recall = { status: 'ready', chatId: CHAT, headCheckpointId: 'head', rootRevision: 1, bodyMatchRefs: [], floorMemories: [], entities: [], currentState: [], cseChanges: [], identityProjection: {} };
  const beforeProfileEdit = await runtime.recallProjection(recall);
  profile.birthday = '9月21日';
  const afterProfileEdit = await runtime.recallProjection(recall);
  assert.notEqual(afterProfileEdit.fingerprint, beforeProfileEdit.fingerprint, '人物资料手改后不复用旧年度投影缓存');
  profile.birthday = '';
  const staleRemoval = await runtime.prepareHistoryPlan(); assert.equal(staleRemoval.annualSetting.removed.length, 1);
  profile.birthday = '9月20日'; await runtime.organize(staleRemoval);
  assert.equal(Object.keys((await store.read(CHAT)).head.settingAnnualSources).length, 1, '过时手动计划不得删除已恢复来源');
  providerReady = false; profile.birthday = ''; await runtime.runBatch(); assert.equal(Object.keys((await store.read(CHAT)).head.settingAnnualSources).length, 1, '来源暂不可用不当成清空');
  providerReady = true; profile.birthday = '9月20日';
  await runtime.runBatch(); profile.appearance = '长发'; await runtime.runBatch(); assert.equal(calls, 1);
  profile.notes = '每年10月2日纪念相识。'; await runtime.runBatch(); assert.equal(calls, 2);
  fail = true; profile.notes = '每年10月3日纪念相识。'; await runtime.runBatch(); assert.equal(calls, 3); await runtime.runBatch(); assert.equal(calls, 3, '同正文触发不自动连发');
  const plan = await runtime.prepareHistoryPlan(); assert.equal(plan.apiCalls, 1); fail = false; await runtime.organize(plan); assert.equal(calls, 4);
  profile.notes = '每年10月4日纪念相识。'; hold = new Promise(resolve => { releaseHold = resolve; }); const started = new Promise(resolve => { announceHold = resolve; });
  const late = runtime.runBatch(); await started; profile.notes = '每年10月5日纪念相识。'; releaseHold(); await late; assert.equal(calls, 5);
  hold = null; await runtime.runBatch(); assert.equal(calls, 6, '来源变化后的旧响应不提交，新来源可继续处理');
  profile.birthday = ''; profile.notes = ''; await runtime.runBatch(); assert.equal(calls, 6); assert.deepEqual((await store.read(CHAT)).head.settingAnnualSources, {});
  enabled = false; profile.birthday = '9月21日'; await runtime.runBatch(); assert.equal(calls, 6);
});
