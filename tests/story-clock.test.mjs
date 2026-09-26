import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT,
  MYKNOTS_STORY_CLOCK_KEY,
  buildMyKnotsClockPrompt,
  createMyKnotsStoryClockController,
  createStoryClockStatusProjection,
  decideStoryClockInjection,
  extensionStoryClockState,
  normalizeStoryClockReferenceTags,
  parseClockFields,
  parseSharedStoryClock,
  parseStoryClockEvidence,
  parseStoryClockReference,
  storyClockSignature,
} from '../src/story-clock.js';

const pair = (namespace, start = '10月4日 | weekday=周二 | time=15:30', end = '10月4日 | weekday=周二 | time=16:00') => `<!-- ${namespace}-start | date=${start} -->正文<!-- ${namespace}-end | date=${end} -->`;

test('默认 QQJ，且 QQJ、SDC、旧 myknots 与星期别名均能读成完整时间戳', () => {
  assert.match(DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT, /QQJ-start/);
  assert.doesNotMatch(DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT, /myknots-start/);
  assert.match(DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT, /date=大陆历1686年10月4日/);
  assert.match(DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT, /世界书中的日期和时间要求仍须完整执行/);
  assert.match(DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT, /沿用该年份和正文时间写法/);
  assert.match(DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT, /没有可靠年份时不要补写年份或猜算跨年日期/);
  assert.match(DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT, /不用系统或服务器现实年份填补/);
  assert.doesNotMatch(DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT, /未知故事年份：/);
  assert.doesNotMatch(DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT, /历法|公历/);
  assert.equal(parseClockFields('date=大陆历1686年10月4日 | weekday=周二 | time=15:30').date, '大陆历1686年10月4日');
  for (const namespace of ['QQJ', 'myknots', 'SDC']) {
    const parsed = parseSharedStoryClock(pair(namespace));
    assert.equal(parsed.namespace, namespace);
    assert.equal(parsed.complete, true);
    assert.equal(parsed.startMeta.weekday, '周二');
  }
  assert.equal(parseClockFields('date=10月4日 | 星期=星期三 | time=辰时').complete, true);
});

test('生产 peer 状态只在已发现、未被宿主禁用且两级开关开启时生效', () => {
  const id = 'third-party/ST-SevenDaysCal', base = { extensionNames: [id], disabledExtensions: [], extensionSuffix: '/ST-SevenDaysCal', peerSettings: { pluginEnabled: true, storyClockEnabled: true, storyClockPrompt: '残留自定义' } };
  assert.deepEqual(extensionStoryClockState(base), { active: true, custom: true });
  assert.deepEqual(extensionStoryClockState({ ...base, extensionNames: [] }), { active: false, custom: false });
  assert.deepEqual(extensionStoryClockState({ ...base, disabledExtensions: [id] }), { active: false, custom: false });
  assert.deepEqual(extensionStoryClockState({ ...base, peerSettings: { ...base.peerSettings, pluginEnabled: false } }), { active: false, custom: false });
  assert.deepEqual(extensionStoryClockState({ ...base, peerSettings: { ...base.peerSettings, storyClockEnabled: false } }), { active: false, custom: false });
});

test('peer 状态变化后 refresh 同步刷新已挂载的协调文案', () => {
  const settings = { pluginEnabled: true, storyClockEnabled: true, storyClockPrompt: '' }, peer = { active: false, custom: false };
  const host = { setExtensionPrompt() {}, constants: { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } } };
  const controller = createMyKnotsStoryClockController({ context: () => host, settings: () => settings, peerState: () => peer });
  const statusNode = { textContent: '' }, documentRef = { getElementById: () => ({ shadowRoot: { getElementById: () => statusNode } }) };
  const project = createStoryClockStatusProjection({ controller, documentRef, labelFor: state => state.status === 'adapted-sdc' ? '已适配构画时间戳' : '已调用千千结时间戳' });
  assert.equal(project().status, 'standalone-default'); assert.equal(statusNode.textContent, '已调用千千结时间戳');
  peer.active = true;
  assert.equal(project().status, 'adapted-sdc'); assert.equal(statusNode.textContent, '已适配构画时间戳');
});

test('三前缀各自配对，合法并存不算重复，残缺格式按完整与正文位置回退', () => {
  const both = parseSharedStoryClock(`${pair('SDC')}\n${pair('QQJ')}\n${pair('myknots')}`);
  assert.equal(both.namespace, 'SDC'); assert.equal(both.complete, true); assert.equal(both.duplicate, false);
  const fallback = parseSharedStoryClock(`<!-- SDC-start | date=10月4日 | weekday=周二 | time=15:30 -->${pair('QQJ')}`);
  assert.equal(fallback.namespace, 'QQJ'); assert.equal(fallback.complete, true);
  const legacyFallback = parseSharedStoryClock(`<!-- QQJ-start | date=10月4日 | weekday=周二 | time=15:30 -->${pair('myknots')}`);
  assert.equal(legacyFallback.namespace, 'myknots'); assert.equal(legacyFallback.complete, true);
  const duplicate = parseSharedStoryClock(`${pair('QQJ')}<!-- QQJ-start | date=10月4日 | weekday=周二 | time=16:10 -->`);
  assert.equal(duplicate.complete, true); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.pairs.length, 1);
  assert.equal(storyClockSignature(parseSharedStoryClock(pair('QQJ'))), '["qqj","| date=10月4日 | weekday=周二 | time=15:30","| date=10月4日 | weekday=周二 | time=16:00"]');
  assert.match(storyClockSignature(duplicate), /16:10/, '残缺同楼时间戳也必须参与 raw 元数据变化检测');
});

test('同一前缀按标签顺序逐段配对，保留完整区间且不猜悬空标签', () => {
  const twoWithTail = parseSharedStoryClock(`${pair('QQJ', '10月30日 | weekday=周五 | time=12:45', '10月30日 | weekday=周五 | time=13:10')}${pair('QQJ', '10月30日 | weekday=周五 | time=14:30', '10月30日 | weekday=周五 | time=14:50')}<!-- QQJ-start | date=10月30日 | weekday=周五 | time=15:15 -->`);
  assert.equal(twoWithTail.complete, true);
  assert.deepEqual(twoWithTail.pairs.map(item => [item.startMeta.time, item.endMeta.time]), [['12:45', '13:10'], ['14:30', '14:50']]);
  assert.match(storyClockSignature(twoWithTail), /15:15/, '坏尾巴仍须进入变更签名');

  const four = parseSharedStoryClock([
    pair('myknots', '10月30日 | weekday=周五 | time=15:40', '10月30日 | weekday=周五 | time=16:15'),
    pair('myknots', '10月30日 | weekday=周五 | time=16:30', '10月30日 | weekday=周五 | time=17:00'),
    pair('myknots', '10月30日 | weekday=周五 | time=19:00', '10月30日 | weekday=周五 | time=19:15'),
    pair('myknots', '10月30日 | weekday=周五 | time=19:30', '10月30日 | weekday=周五 | time=19:40'),
  ].join('正文'));
  assert.deepEqual(four.pairs.map(item => [item.startMeta.time, item.endMeta.time]), [['15:40', '16:15'], ['16:30', '17:00'], ['19:00', '19:15'], ['19:30', '19:40']]);

  const startStartEnd = parseSharedStoryClock('<!-- SDC-start | date=10月30日 | weekday=周五 | time=10:00 --><!-- SDC-start | date=10月30日 | weekday=周五 | time=10:10 --><!-- SDC-end | date=10月30日 | weekday=周五 | time=10:20 -->');
  assert.deepEqual(startStartEnd.pairs.map(item => [item.startMeta.time, item.endMeta.time]), [['10:10', '10:20']]);
  assert.equal(parseSharedStoryClock('<!-- SDC-end | date=10月30日 | weekday=周五 | time=10:20 -->').pairs.length, 0);
  assert.equal(parseSharedStoryClock('<!-- SDC-end | date=10月30日 | weekday=周五 | time=10:20 --><!-- SDC-start | date=10月30日 | weekday=周五 | time=10:30 -->').pairs.length, 0);
});

test('可配置时间参考标签保留完整语义与原文顺序，标准时间戳仍优先', () => {
  assert.deepEqual(normalizeStoryClockReferenceTags(' Ti，时标\nti '), ['Ti', '时标']);
  const raw = '<Slate><Ti>0081年10月20日·<b>清晨</b>·06:12</Ti><content>正文</content><ti>0081年10月20日·午前·10:40</ti></Slate>';
  assert.equal(parseStoryClockReference(raw), null);
  const reference = parseStoryClockReference(raw, 'TI,时标');
  assert.equal(reference.namespace, 'tag:TI');
  assert.equal(reference.referenceText, '0081年10月20日·清晨·06:12\n0081年10月20日·午前·10:40');
  assert.equal(reference.lastReferenceText, '0081年10月20日·午前·10:40');
  assert.equal(reference.complete, false);
  assert.equal(reference.start, null);
  assert.equal(reference.end, null);
  assert.match(storyClockSignature(reference), /0081年10月20日/);
  assert.equal(parseStoryClockReference('<时标>第三次忍界大战后某年·7月15日·18:00</时标>', '时标').referenceText, '第三次忍界大战后某年·7月15日·18:00');
  const multiline = parseStoryClockReference('<bbs_start><i>大陆历1686年10月30日</i>\n13:30</bbs_start><section><bbs_end>大陆历1686年10月30日\n14:15</bbs_end></section>', 'bbs_start,bbs_end');
  assert.equal(multiline.referenceText, '大陆历1686年10月30日\n13:30\n大陆历1686年10月30日\n14:15');
  assert.equal(multiline.lastReferenceText, '大陆历1686年10月30日\n14:15');
  assert.equal(parseStoryClockReference('<Ti>时间不明</Ti>', ''), null);
  assert.equal(parseStoryClockReference('<Ti>没有闭合', 'Ti'), null);
  const standard = parseStoryClockEvidence(`${raw}${pair('QQJ')}`, 'Ti');
  assert.equal(standard.namespace, 'QQJ');
  assert.equal(standard.complete, true);
});

test('协调矩阵与 controller 只操作自己的 prompt key', () => {
  assert.deepEqual(decideStoryClockInjection({ owner: 'myknots', ownActive: true, ownCustom: false, peerActive: true, peerCustom: false }), { inject: false, status: 'adapted-sdc' });
  assert.deepEqual(decideStoryClockInjection({ owner: 'myknots', ownActive: true, ownCustom: true, peerActive: true, peerCustom: true }), { inject: true, status: 'custom' });
  assert.deepEqual(decideStoryClockInjection({ owner: 'myknots', ownActive: true, ownCustom: false, peerActive: true, peerCustom: true }), { inject: false, status: 'adapted-peer-custom' });
  assert.equal(buildMyKnotsClockPrompt({ storyClockPrompt: '  自定义\n' }), '  自定义\n');
  assert.equal(buildMyKnotsClockPrompt({ storyClockPrompt: '' }), DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT);
  const calls = [], settings = { pluginEnabled: true, storyClockEnabled: true, storyClockPrompt: '逐字原样' };
  const host = { constants: { promptTypes: { IN_CHAT: 7 }, promptRoles: { SYSTEM: 9 } }, setExtensionPrompt: (...args) => calls.push(args) };
  const controller = createMyKnotsStoryClockController({ context: () => host, settings: () => settings, peerState: () => ({ active: true, custom: true }) });
  assert.equal(controller.refresh().status, 'custom');
  assert.deepEqual(calls, [[MYKNOTS_STORY_CLOCK_KEY, ''], [MYKNOTS_STORY_CLOCK_KEY, '逐字原样', 7, 0, false, 9]]);
  assert.equal(calls.some(call => call[0] === 'sdc_story_clock'), false);

  const peerCalls = [], peerController = createMyKnotsStoryClockController({ context: () => ({ ...host, setExtensionPrompt: (...args) => peerCalls.push(args) }), settings: () => ({ ...settings, storyClockPrompt: '' }), peerState: () => ({ active: true, custom: false }) });
  assert.equal(peerController.refresh().status, 'adapted-sdc');
  assert.deepEqual(peerCalls, [[MYKNOTS_STORY_CLOCK_KEY, '']]);
});
