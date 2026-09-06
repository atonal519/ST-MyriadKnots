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
  parseClockFields,
  parseSharedStoryClock,
  storyClockSignature,
} from '../src/story-clock.js';

const pair = (namespace, start = '10月4日 | weekday=周二 | time=15:30', end = '10月4日 | weekday=周二 | time=16:00') => `<!-- ${namespace}-start | date=${start} -->正文<!-- ${namespace}-end | date=${end} -->`;

test('默认 myknots、SDC 与星期别名均能读成完整时间戳', () => {
  assert.match(DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT, /myknots-start/);
  for (const namespace of ['myknots', 'SDC']) {
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

test('双前缀各自配对，合法并存不算重复，残缺 SDC 可回退完整 myknots', () => {
  const both = parseSharedStoryClock(`${pair('SDC')}\n${pair('myknots')}`);
  assert.equal(both.namespace, 'SDC'); assert.equal(both.complete, true); assert.equal(both.duplicate, false);
  const fallback = parseSharedStoryClock(`<!-- SDC-start | date=10月4日 | weekday=周二 | time=15:30 -->${pair('myknots')}`);
  assert.equal(fallback.namespace, 'myknots'); assert.equal(fallback.complete, true);
  const duplicate = parseSharedStoryClock(`${pair('myknots')}<!-- myknots-start | date=10月4日 | weekday=周二 | time=16:10 -->`);
  assert.equal(duplicate.complete, false); assert.equal(duplicate.duplicate, true);
  assert.notEqual(storyClockSignature(duplicate), '', '残缺同楼时间戳也必须参与 raw 元数据变化检测');
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
});
