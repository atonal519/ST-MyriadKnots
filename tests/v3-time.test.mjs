import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTime, timeDistance, timeHours, nextCycleTime, storyTimes, timeRecallProjection } from '../src/v3/time-engine.js';
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


test('真实selectRecall校正与原状态共同保留或舍弃，到期无话题独立入预算', () => {
  const state = { stateId: 'state', text: '手腕擦伤', visibility: 'observable', reason: '身体观察', origin: 'floor', towardEntityId: null, sourceFloorId: FLOOR, sourceDeltaId: 'delta', sourceAssistantSeq: 1 };
  const source = { status: 'ready', chatId: CHAT, entities: [{ entityId: PERSON, displayName: '甲', aliases: [], entityType: 'person', specialRole: 'char' }], floorMemories: [], cseChanges: [], currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [state] }], coverage: { memoryComplete: true, cseCurrent: true }, bodyMatch: { visibleFloorIds: [], summaryCoveredFloorIds: [] }, timeProjection: {
    corrections: { [`state|${PERSON}|${FLOOR}`]: { itemId: 'item', text: '原观察（5月9日）：手腕擦伤；已过2天（第3天）；当前推测：可能减轻' } }, reminders: [{ itemId: 'due', text: '甲 / 约定期限5月12日；尚未确认完成', distance: 1 }],
  } };
  const queryContext = buildRecallQueryContext({ coreChat: [{ is_user: true, mes: '甲的手腕怎么样' }] });
  const selected = selectRecall({ source, queryContext, contextSize: 8192 });
  assert.match(selected.injectionText, /原观察.*当前推测/u);
  assert.match(selected.injectionText, /约定期限5月12日/u);
  assert.deepEqual(selected.timeDependencies.corrections, [{ key: `state|${PERSON}|${FLOOR}`, itemId: 'item', text: source.timeProjection.corrections[`state|${PERSON}|${FLOOR}`].text, sourceSignature: null }]);
  assert.deepEqual(selected.timeDependencies.reminders, [{ itemId: 'due', text: source.timeProjection.reminders[0].text, sourceSignature: null }]);
  assert.equal(selected.states[0].text, '手腕擦伤', 'receipt留原观察供源校验，临时文本只在renderer');
  assert.ok(estimateRecallTokens(selected.injectionText) <= selected.limits.estimatedTokenBudget);
  source.timeProjection.corrections[`state|${PERSON}|${FLOOR}`].text = '原观察和预计'.repeat(6000);
  const dropped = selectRecall({ source, queryContext, contextSize: 8192 });
  assert.equal(dropped.states.length, 0);
  assert.deepEqual(dropped.timeDependencies.corrections, []);
  assert.equal(dropped.injectionText.includes('手腕擦伤'), false, '不能只截掉校正而留下旧状态');
  const breakfast = buildRecallQueryContext({ coreChat: [{ is_user: true, mes: '早餐吃什么' }] });
  const deadline = selectRecall({ source, queryContext: breakfast, contextSize: 8192 });
  assert.match(deadline.injectionText, /约定期限5月12日/u);
});


test('formatter仅记录实际渲染的校正，时间项来源变化也进入依赖', () => {
  const state = { stateId: 'state', subjectEntityId: PERSON, sourceFloorId: FLOOR, storylineId: 'unrendered-line', text: '原状态' };
  const projection = { corrections: { [`state|${PERSON}|${FLOOR}`]: { itemId: 'body', text: '时间校正文本' } } };
  const deps = { corrections: [], reminders: [] };
  const text = formatRecallInjection({ states: [state], floors: [], cseChanges: [], coverage: { memoryComplete: true, cseCurrent: true }, entityById: new Map(), storylines: [{ storylineId: 'other-line', title: '另一条线', basis: '测试' }], timeProjection: projection, timeDependencies: deps });
  assert.equal(text.includes('时间校正文本'), false); assert.deepEqual(deps.corrections, []);
  const item = { id: 'body', subjectEntityId: PERSON, type: 'body', label: '擦伤', status: 'active', observation: '擦伤', observationKey: 'observation', observationTime: projectTime('2026-05-09'), occurrenceTime: projectTime('2026-05-09'), dueTime: projectTime(''), stateRefs: [{ stateId: 'state', sourceFloorId: FLOOR }], sourceRefs: [{ floorId: FLOOR, canonicalFingerprint: 'old-body' }] };
  const source = { entities: [{ entityId: PERSON, displayName: '甲' }], currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [state] }] };
  const first = timeRecallProjection([item], source, projectTime('2026-05-11')).corrections[`state|${PERSON}|${FLOOR}`];
  item.sourceRefs[0].canonicalFingerprint = 'new-body';
  const second = timeRecallProjection([item], source, projectTime('2026-05-11')).corrections[`state|${PERSON}|${FLOOR}`];
  assert.equal(first.text, second.text); assert.notEqual(first.sourceSignature, second.sourceSignature);
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


test('同日时钟回退时未来推演不可采用', () => {
  const item = { id: 'body', subjectEntityId: PERSON, type: 'body', status: 'active', label: '擦伤', observation: '擦伤', observationKey: 'key', observationTime: projectTime('2026-05-10 07:00'), occurrenceTime: projectTime('2026-05-10 07:00'), dueTime: projectTime(''), stateRefs: [{ stateId: 'state', sourceFloorId: FLOOR }], projection: { observationKey: 'key', applicableTime: projectTime('2026-05-10 14:00'), text: '未来预计状态' } };
  const source = { entities: [{ entityId: PERSON, displayName: '甲' }], identityProjection: {}, currentState: [{ subjectEntityId: PERSON, core: [], adaptive: [], situational: [{ stateId: 'state', sourceFloorId: FLOOR }] }] };
  const projection = timeRecallProjection([item], source, projectTime('2026-05-10 08:00'));
  assert.equal(projection.corrections[`state|${PERSON}|${FLOOR}`].text.includes('未来预计状态'), false);
  assert.match(projection.corrections[`state|${PERSON}|${FLOOR}`].text, /待新观察确认/u);
});
