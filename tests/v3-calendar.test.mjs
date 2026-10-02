import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore } from '../src/settings.js';
import { normalizeStoryCalendar } from '../src/v3/calendar-rules.js';
import { projectTime, projectTimeSource, effectiveTime, timeDistance, timeHours, shiftTime, evaluateTimeBatches, createTimeBodyRequest, validTimeProjection } from '../src/v3/time-engine.js';
import { projectAnnualSettings } from '../src/v3/time-annual-setting.js';
import { readTimeBody, readRecentBodyStoryTimes } from '../src/v3/time-body.js';
import { compileQianshiDelta, projectQianshiGraph, projectQianshiTimeline } from '../src/v3/qianshi-domain.js';
import { createQianshiSnapshotMemo } from '../src/v3/memory-runtime.js';
import { createTimeRuntime } from '../src/v3/time-runtime.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const four = { months: 4, prefix: '启航' }, twelve = { months: 12, prefix: '启航' };
const date = (raw, calendar = twelve, anchor = null) => projectTime(raw, anchor, { calendar });

test('两种月制计算跨月/跨年，纪年前缀与原文保留，十二月制不计算闰年', () => {
  for (const [calendar, distance] of [[four, 44], [twelve, 45]]) {
    const from = date('启航387年1月2日 10:30', calendar), to = date('启航387年2月16日 20:30', calendar);
    assert.equal(timeDistance(from, to), distance);
    assert.equal(timeHours(from, to), distance * 24 + 10);
    assert.equal(from.raw, '启航387年1月2日 10:30');
    const end = date(`启航387年${calendar.months}月${calendar.months === 4 ? 30 : 31}日 10:30`, calendar);
    for (const next of [shiftTime(end, 2), date('两天后', calendar, end)]) {
      assert.equal(next.year, 388); assert.equal(next.month, 1); assert.equal(next.monthDay, 2);
      assert.equal(timeDistance(end, next), 2);
    }
    assert.equal(shiftTime(date('启航388年1月1日', calendar), -1).year, 387);
  }
  assert.equal(timeDistance(date('启航2024年2月28日'), date('启航2024年3月1日')), 1);
  assert.equal(date('开元五年1月2日', { months: 12, prefix: '开元' }).year, 5);
  assert.equal(timeDistance(projectTime('2024-02-28'), projectTime('2024-03-01')), 2, '未配置的既有公历行为保留');
});

test('四月制每月30天，兼容省略日号和春夏秋冬；未确认纪年不套用规则', () => {
  for (const raw of ['启航5年2月30日', '启航五年二月三十', '启航5年夏月30日']) {
    const projected = date(raw, four);
    assert.equal(projected.month, 2, raw); assert.equal(projected.monthDay, 30, raw);
  }
  for (const raw of ['启航5年5月1日', '启航5年1月31日', '启航5年2月0日']) assert.equal(date(raw, four).date, null, raw);
  assert.equal(date('启航5年夏月30日', twelve).date, null);
  assert.equal(date('启航5年2月30日', twelve).date, null);
  assert.equal(timeDistance(date('其他5年1月2日', four), date('启航5年2月16日', four)), null);
  assert.equal(timeDistance(date('1/2', four), date('2/16', four)), 44);
  assert.equal(timeDistance(date('4月30日', four), date('1月1日', four)), null, '缺年份不猜跨年');
  assert.equal(shiftTime(date('4月30日', four), 1).date, null);
});

test('配置逐聊天保存，默认不覆盖旧行为，非法规则不生效', () => {
  const extensionSettings = {}, settings = createSettingsStore({ extensionSettings, save() {} });
  assert.deepEqual(settings.get().storyCalendars, {});
  settings.update({ storyCalendars: { [CHAT]: four, [OTHER]: { months: 12, prefix: ' 开元 ' }, bad: four } });
  assert.deepEqual(settings.get().storyCalendars, { [CHAT]: four, [OTHER]: { months: 12, prefix: '开元' } });
  for (const value of [{ months: 6, prefix: '' }, { months: 4, prefix: '启航387' }, { months: 4, prefix: '<启航>' }]) assert.equal(normalizeStoryCalendar(value), null);
});

test('四月制省略月字的季节日期贯通间隔、正文时钟、年度提醒和时间线', async () => {
  const calendar = { months: 4, prefix: '' };
  for (const [month, name] of ['春', '夏', '秋', '冬'].entries()) {
    for (const raw of [`${name}1日`, `${name}月1日`, `启航五年${name}一日`]) {
      const time = date(raw, raw.startsWith('启航') ? four : calendar);
      assert.equal(time.month, month + 1, raw); assert.equal(time.monthDay, 1, raw);
      assert.equal(time.raw, raw, '日期原文保持');
    }
    assert.equal(date(`${name}31日`, calendar).date, null);
    assert.equal(date(`${name}1日`, { months: 12, prefix: '' }).date, null);
  }
  const from = date('春20日', calendar), to = date('夏10日', calendar);
  assert.equal(timeDistance(from, to), 20);
  assert.equal(timeDistance(date('春月20日', calendar), to), 20, '有月与无月写法可混用');
  assert.equal(timeDistance(date('启航五年春二十日', four), date('启航五年夏十日', four)), 20);
  assert.equal(timeDistance(date('冬30日', calendar), date('春1日', calendar)), null, '缺年份跨年不猜');
  const end = date('启航5年冬30日', four), next = date('明天', four, end);
  assert.equal(timeDistance(end, date('启航6年春1日', four)), 1);
  assert.equal(next.year, 6); assert.equal(next.month, 1); assert.equal(next.monthDay, 1);
  assert.equal(date('120日', calendar).date, null, '不会顺带让数字月份省略分隔符');

  const timestamp = raw => `<!-- QQJ-start | date=${raw} | weekday=周一 | time=10:00 -->前往河边。<!-- QQJ-end | date=${raw} | weekday=周一 | time=11:00 -->`;
  const host = { chat: ['春20日', '夏10日'].map(raw => ({ is_user: false, mes: timestamp(raw) })) };
  const reachable = { root: { chatId: CHAT }, floors: [], floorMemories: [] };
  const source = await readTimeBody(reachable, host, { calendar }), legacy = await readTimeBody(reachable, host);
  assert.equal(timeDistance(source.bodyFloors[0].observationTime, source.bodyFloors[1].observationTime), 20);
  assert.deepEqual(source.bodyFloors.map(body => body.timeSourceFingerprint), legacy.bodyFloors.map(body => body.timeSourceFingerprint));

  const records = [{ sourceKey: 'spring', subjectEntityId: OTHER, subjectName: '甲', items: [{ category: 'anniversary', label: '纪念日', originalDate: '每年夏10日' }] }];
  const annual = projectAnnualSettings(records, date('夏8日', calendar));
  assert.equal(annual.reminders[0].distance, 2);
  assert.equal(projectAnnualSettings(records, date('夏8日', calendar), [{ type: 'deadline', subjectEntityId: OTHER, label: '纪念日', dueTime: to }]).reminders.length, 0);
  assert.equal(projectAnnualSettings(records, date('夏11日', calendar)).reminders[0].distance, null);
  const timeline = projectQianshiTimeline({ events: ['夏10日', '春20日'].map((storyTime, index) => ({ id: `season-${index}`, storyTime, parsedStoryTime: date(storyTime, calendar) })) });
  assert.deepEqual(timeline.segments[0].groups.flatMap(group => group.eventIds), ['season-1', 'season-0']);
});

test('旧时间增量获得当前计算视图，来源键与已保存观察不改写，旧模型推测不能跨历法复用', () => {
  const old = projectTimeSource('启航387年2月30日 10:30');
  const before = structuredClone(old), projected = effectiveTime(old, four);
  assert.equal(projected.monthDay, 30); assert.equal(projected.calendar.months, 4);
  const batches = [{ cutoffFloorId: OTHER, dependencies: [], changes: [{ id: 'item', observationKey: 'old-key', observationTime: old, dueTime: old }], sourceKeys: [] }];
  const copy = structuredClone(batches);
  const result = evaluateTimeBatches(batches, { floors: [{ id: OTHER }], floorMemories: [], calendar: four });
  assert.equal(result.items[0].observationKey, 'old-key'); assert.equal(result.items[0].observationTime.calendar.months, 4);
  assert.deepEqual(batches, copy); assert.deepEqual(old, before);
  const current = date('启航387年3月1日', four);
  assert.equal(validTimeProjection({ observationKey: 'old-key', projection: { observationKey: 'old-key', applicableTime: projectTimeSource('启航387年3月1日'), text: '旧推测' } }, current), false);
  const request = createTimeBodyRequest({ root: { chatId: CHAT } }, [{ observationTime: projected }], { observationTime: current });
  assert.equal(request.observations[0].observationElapsedDays, 1);
  assert.deepEqual(request.calendarRule.monthDays, [30, 30, 30, 30]);
});

test('正文时间戳接受四月制2月30日，旧来源指纹与原始正文不变', async () => {
  const chat = [{ is_user: false, mes: '<!-- QQJ-start | date=2026年2月30日 | weekday=周一 | time=10:00 -->渡过河流。<!-- QQJ-end | date=2026年2月30日 | weekday=周一 | time=11:00 -->' }];
  const reachable = { root: { chatId: CHAT }, floors: [], floorMemories: [] }, host = { chat, chatId: 'host' };
  const original = structuredClone(chat), calendar = { months: 4, prefix: '' };
  const legacy = await readTimeBody(reachable, host), configured = await readTimeBody(reachable, host, { calendar });
  assert.equal(configured.bodyFloors[0].observationTime.monthDay, 30);
  assert.equal(configured.bodyFloors[0].observationTime.calendar.months, 4);
  assert.equal(configured.bodyFloors[0].timeSourceFingerprint, legacy.bodyFloors[0].timeSourceFingerprint);
  assert.equal(configured.bodyFloors[0].clockContentFingerprint, legacy.bodyFloors[0].clockContentFingerprint);
  assert.equal((await readRecentBodyStoryTimes(host, { reachable, calendar }))[0].observationTime.monthDay, 30);
  assert.deepEqual(chat, original);
});

test('年度提醒使用所选月长，未知/已过日期保持原文，正文重复期限仍能去重', () => {
  const records = [{ sourceKey: 'birthday', subjectEntityId: OTHER, subjectName: '甲', items: [{ category: 'birthday', label: '生日', originalDate: '启航五年2月30日', calendar: 'special' }] }];
  const original = structuredClone(records);
  let current = date('启航387年2月28日', four), result = projectAnnualSettings(records, current);
  assert.equal(result.reminders[0].distance, 2); assert.equal(result.items[0].month, 2); assert.equal(result.items[0].day, 30);
  assert.equal(result.items[0].nextDate, '启航387年2月30日');
  current = date('启航2月28日', four);
  assert.equal(projectAnnualSettings(records, current, [{ type: 'deadline', subjectEntityId: OTHER, label: '生日', dueTime: date('启航2月30日', four) }]).reminders.length, 0);
  result = projectAnnualSettings(records, date('启航387年3月1日', four));
  assert.equal(result.items[0].status, '本年日期已过'); assert.match(result.reminders[0].text, /原日期 启航五年2月30日/u);
  assert.equal(projectAnnualSettings(records, date('启航387年2月28日', twelve)).reminders[0].distance, null);
  assert.deepEqual(records, original);
});

test('千事时间线按固定历法跨年排序，切换规则只刷新投影，不改事件日期文字', async () => {
  const floor = { id: OTHER, chatId: CHAT, narrativeGeneration: CHAT, assistantSeq: 1, hostLocator: { messageIndex: 0 } };
  const rawDates = ['启航388年1月2日', '启航387年4月30日', '启航388年1月1日'];
  const delta = await compileQianshiDelta({ floor, now: '2026-10-01T00:00:00.000Z', packet: { qianshi: {
    events: rawDates.map((storyTime, index) => ({ key: `e${index}`, title: `事件${index}`, description: '经过', storyTime, status: 'occurred', matter: false })), order: [] } } });
  const reachable = { root: { chatId: CHAT, narrativeGeneration: CHAT }, floors: [floor], floorMemories: [{ id: CHAT, floorId: OTHER, recordStatus: 'active', chronology: [], qianshiDelta: delta }], entities: [] };
  const before = structuredClone(reachable), graph = projectQianshiGraph(reachable, { calendar: four });
  const chronological = projectQianshiTimeline(graph);
  const orderedIds = chronological.segments.flatMap(segment => segment.groups.flatMap(group => group.eventIds));
  assert.deepEqual(orderedIds.map(id => graph.events.find(event => event.id === id).storyTime), [rawDates[1], rawDates[2], rawDates[0]]);
  assert.equal(chronological.segments[0].groups[0].period, '启航387年4月');
  const yearless = projectQianshiTimeline({ events: ['启航4月30日', '启航1月1日'].map((storyTime, index) => ({ id: `yearless-${index}`, storyTime, parsedStoryTime: date(storyTime, four) })) });
  assert.equal(yearless.hasGlobalLatest, false, '四月制缺年份跨年也不推断最新日');
  assert.deepEqual(yearless.segments[0].groups.flatMap(group => group.eventIds), ['yearless-0', 'yearless-1']);
  const mixed = projectQianshiTimeline({ events: [...graph.events, { id: 'foreign', storyTime: '公元2026年1月2日', parsedStoryTime: date('公元2026年1月2日', four) }] });
  assert.equal(mixed.segments.length, 2); assert.equal(mixed.hasGlobalLatest, false);
  let calls = 0;
  const memo = createQianshiSnapshotMemo((...args) => { calls += 1; return { events: projectQianshiGraph(args[0], { calendar: args[3] }).events }; });
  const first = memo(reachable, null, null, four);
  assert.equal(memo(reachable, null, null, { ...four }).projectionRevision, first.projectionRevision);
  assert.equal(memo(reachable, null, null, twelve).projectionRevision, first.projectionRevision + 1);
  assert.equal(calls, 2); assert.deepEqual(reachable, before);
});

test('时间推演关闭时也能读取历法供时间轴使用，刷新配置不调用模型', async () => {
  let calendar = four, calls = 0;
  const host = { chatId: 'host', chat: [{ is_user: false, mes: '<!-- QQJ-start | date=启航387年2月30日 | weekday=周一 | time=10:00 -->渡过河流。<!-- QQJ-end | date=启航387年2月30日 | weekday=周一 | time=11:00 -->' }] };
  const reachable = { root: { chatId: CHAT }, floors: [], floorMemories: [], entities: [] };
  const runtime = createTimeRuntime({ hostAdapter: { snapshot: () => host }, session: { identity: () => ({ chatId: CHAT, hostChatId: 'host' }) },
    getReachable: () => reachable, storyCalendarProvider: () => calendar, isEnabled: () => false, generateTimeTask: async () => { calls += 1; } });
  const source = { status: 'ready', chatId: CHAT };
  assert.equal((await runtime.currentStoryContext(source)).currentTime.monthDay, 30);
  calendar = twelve; runtime.invalidate(); await runtime.refreshStatus({ force: true });
  assert.equal(await runtime.currentStoryContext(source), null, '十二月制不会把2月30日当作可靠日期');
  assert.equal(calls, 0);
});
