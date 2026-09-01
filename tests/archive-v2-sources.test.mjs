import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_V2_SOURCE_WARNING,
  collectArchiveV2InitializationSources,
  normalizeArchiveV2ChatRange,
} from '../src/archive-v2-sources.js';

const date = index => `2026-08-31T00:${String(index).padStart(2, '0')}:00.000Z`;
const greeting = (content = '当前开场白', overrides = {}) => ({
  name: 'C',
  is_user: false,
  is_system: false,
  send_date: date(0),
  mes: content,
  swipe_id: 1,
  swipes: ['其他开场白', content],
  swipe_info: [{ send_date: date(0) }, { send_date: date(0) }],
  extra: {},
  ...overrides,
});
const hiddenGreeting = (content = '被 /hide 的当前开场白', overrides = {}) => ({
  name: 'C',
  is_user: false,
  is_system: true,
  send_date: date(0),
  mes: content,
  extra: {},
  ...overrides,
});
const user = (content, index, overrides = {}) => ({
  name: 'U', is_user: true, is_system: false, send_date: date(index), mes: content, extra: {}, ...overrides,
});
const assistant = (content, index, overrides = {}) => ({
  name: 'C', is_user: false, is_system: false, send_date: date(index), mes: content,
  swipe_id: 0, swipes: [content], swipe_info: [{ send_date: date(index) }], extra: {}, ...overrides,
});

function context(overrides = {}) {
  const mainBook = {
    entries: {
      enabled: { uid: 'enabled', comment: '已启用', content: '<b>主书可用正文</b>' },
      disabled: { uid: 'disabled', comment: '已禁用', content: '禁用正文', disable: true },
    },
  };
  const activeBook = {
    entries: {
      active: { uid: 'active', comment: '当前激活', content: '激活正文' },
    },
  };
  return {
    characterId: 0,
    characters: [{
      avatar: 'char.png',
      data: {
        description: '<b>角色核心描述</b>',
        personality: '沉静',
        alternate_greetings: ['绝不能枚举的其他开场白'],
        extensions: { world: 'main-book' },
      },
    }],
    chat: [greeting(), user('用户正文', 1), assistant('AI 正文', 2)],
    getCharaFilename: () => 'char',
    getCharaAuxWorlds: () => [],
    simulateWorldInfoActivation: async () => ({
      activatedEntries: [{ world: 'active-book', uid: 'active', content: '激活正文' }],
    }),
    loadWorldInfoBatch: async worlds => new Map(worlds.map(world => [
      world,
      world === 'main-book' ? mainBook : activeBook,
    ])),
    ...overrides,
  };
}

function byKind(result, kind) {
  return result.candidates.filter(candidate => candidate.kind === kind);
}

test('角色卡核心字段与当前实际开场白被列出并默认选中', async () => {
  const result = await collectArchiveV2InitializationSources(context());
  assert.equal(result.status, 'ready');
  assert.deepEqual(byKind(result, 'card').map(item => item.label), ['角色描述', '角色性格']);
  assert.ok(byKind(result, 'card').every(item => item.selected && item.availability === 'card'));
  assert.equal(byKind(result, 'greeting').length, 1);
  assert.deepEqual(
    { content: byKind(result, 'greeting')[0].content, selected: byKind(result, 'greeting')[0].selected },
    { content: '当前开场白', selected: true },
  );
});

test('原生 /hide 形态的第 0 楼仍收集 card+greeting 并参与世界书 activation', async () => {
  let activationInput;
  const ctx = context({
    chat: [hiddenGreeting(), user('用户正文', 1)],
    simulateWorldInfoActivation: async input => {
      activationInput = input;
      return { activatedEntries: [] };
    },
  });
  const result = await collectArchiveV2InitializationSources(ctx);
  assert.equal(byKind(result, 'card').length, 2);
  assert.deepEqual(byKind(result, 'greeting').map(item => item.content), ['被 /hide 的当前开场白']);
  assert.equal(activationInput.dryRun, true);
  assert.equal(activationInput.coreChat[0].mes, '被 /hide 的当前开场白');
  assert.equal(activationInput.coreChat[0].is_system, false);
  assert.equal(ctx.chat[0].is_system, true);
  assert.equal(Object.hasOwn(ctx.chat[0], 'swipes'), false);
});

test('/hide 开场白的 scanner 结果失败时 worldbookless fallback 仍返回 card+greeting', async () => {
  const ctx = context({
    chat: [hiddenGreeting(), user('用户正文', 1)],
    simulateWorldInfoActivation: async () => ({ nope: true }),
  });
  const result = await collectArchiveV2InitializationSources(ctx);
  assert.equal(byKind(result, 'card').length, 2);
  assert.deepEqual(byKind(result, 'greeting').map(item => item.content), ['被 /hide 的当前开场白']);
  assert.equal(byKind(result, 'worldbook').length, 0);
  assert.ok(result.warnings.some(item => item.code === ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_SCAN_FAILED));
});

test('/hide 兼容不会把 user、空正文或非法 swipe 伪装成 greeting', async () => {
  const invalidGreetings = [
    hiddenGreeting('用户楼', { is_user: true }),
    hiddenGreeting('   '),
    hiddenGreeting('错位 swipe', { swipe_id: 1, swipes: ['只有第 0 项'] }),
  ];
  for (const first of invalidGreetings) {
    await assert.rejects(
      collectArchiveV2InitializationSources(context({ chat: [first, user('用户正文', 1)] })),
      error => error?.diagnosticCode === 'GREETING_INVALID',
    );
  }
});

test('不枚举角色卡中的其他 greeting，只保留当前 swipe', async () => {
  const result = await collectArchiveV2InitializationSources(context());
  const greetings = byKind(result, 'greeting');
  assert.equal(greetings.length, 1);
  assert.equal(greetings[0].locator, 'greeting:0:1');
  assert.equal(result.candidates.some(item => item.content.includes('绝不能枚举')), false);
  assert.equal(result.candidates.some(item => item.content === '其他开场白'), false);
});

test('第 0 楼新 swipe locator 与旧 mes 瞬时错配时跳过 greeting，其他来源仍保留', async () => {
  const ctx = context({
    chat: [
      greeting('旧开场白', { swipe_id: 1, swipes: ['旧开场白', '<b>新开场白</b>'] }),
      user('用户正文', 1),
      assistant('AI 正文', 2),
    ],
  });
  const result = await collectArchiveV2InitializationSources(ctx, { chatRange: { start: 1, end: 2 } });
  assert.equal(byKind(result, 'greeting').length, 0);
  assert.equal(byKind(result, 'card').length, 2);
  assert.equal(byKind(result, 'worldbook').length, 3);
  assert.deepEqual(byKind(result, 'chat').map(item => item.content), ['用户正文', 'AI 正文']);
  assert.ok(result.warnings.some(
    item => item.code === ARCHIVE_V2_SOURCE_WARNING.GREETING_TRANSIENT_SWIPE_MISMATCH,
  ));
  assert.equal(JSON.stringify(result.warnings).includes('旧开场白'), false);
  assert.equal(JSON.stringify(result.warnings).includes('新开场白'), false);
});

test('greeting 原文业务内容不同即使清洗结果相同仍过滤，只有换行差异则放行', async () => {
  const transient = context({
    chat: [
      greeting('正文<script>旧</script>', {
        swipe_id: 1,
        swipes: ['其他', '正文<script>新</script>'],
      }),
      user('用户正文', 1),
    ],
  });
  const rejected = await collectArchiveV2InitializationSources(transient);
  assert.equal(byKind(rejected, 'greeting').length, 0);
  assert.ok(rejected.warnings.some(
    item => item.code === ARCHIVE_V2_SOURCE_WARNING.GREETING_TRANSIENT_SWIPE_MISMATCH,
  ));

  const stable = context({
    chat: [
      greeting('第一行\r\n第二行<script>同一业务内容</script>', {
        swipe_id: 1,
        swipes: ['其他', '第一行\n第二行<script>同一业务内容</script>'],
      }),
      user('用户正文', 1),
    ],
  });
  const accepted = await collectArchiveV2InitializationSources(stable);
  assert.equal(byKind(accepted, 'greeting').length, 1);
  assert.equal(accepted.warnings.some(
    item => item.code === ARCHIVE_V2_SOURCE_WARNING.GREETING_TRANSIENT_SWIPE_MISMATCH,
  ), false);
});

test('世界书 activated、enabled、disabled 的默认选择与 availability 正确', async () => {
  const result = await collectArchiveV2InitializationSources(context());
  const worlds = new Map(byKind(result, 'worldbook').map(item => [item.locator, item]));
  assert.deepEqual(
    { availability: worlds.get('active-book:active').availability, selected: worlds.get('active-book:active').selected },
    { availability: 'activated', selected: true },
  );
  assert.deepEqual(
    { availability: worlds.get('main-book:enabled').availability, selected: worlds.get('main-book:enabled').selected },
    { availability: 'enabled', selected: true },
  );
  assert.deepEqual(
    { availability: worlds.get('main-book:disabled').availability, selected: worlds.get('main-book:disabled').selected },
    { availability: 'disabled', selected: false },
  );
});

test('世界书扫描失败保留角色卡、开场白和显式范围正文，并返回稳定 warning', async () => {
  const ctx = context({ simulateWorldInfoActivation: async () => { throw new Error('/secret/user/path'); } });
  const result = await collectArchiveV2InitializationSources(ctx, { chatRange: { start: 1, end: 2 } });
  assert.equal(byKind(result, 'card').length, 2);
  assert.equal(byKind(result, 'greeting').length, 1);
  assert.equal(byKind(result, 'chat').length, 2);
  assert.ok(result.warnings.some(item => item.code === ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_SCAN_FAILED));
  assert.equal(JSON.stringify(result.warnings).includes('secret'), false);
});

test('未提供 chatRange 时完全不读取或输出聊天正文候选', async () => {
  const base = context();
  let bodyReads = 0;
  base.chat = new Proxy(base.chat, {
    get(target, property, receiver) {
      if (property === '1' || property === '2') bodyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = await collectArchiveV2InitializationSources(base);
  assert.equal(byKind(result, 'chat').length, 0);
  assert.equal(bodyReads, 0);
});

test('有效包含式范围同时读取 user 与 AI，全部默认不选', async () => {
  const result = await collectArchiveV2InitializationSources(context(), { chatRange: { start: 1, end: 2 } });
  const chat = byKind(result, 'chat');
  assert.deepEqual(chat.map(item => [item.locator, item.content]), [
    ['floor:1:user', '用户正文'],
    ['floor:2:assistant:swipe:0', 'AI 正文'],
  ]);
  assert.ok(chat.every(item => item.selected === false && item.availability === 'chat'));
});

test('范围内排除第 0 楼、system、隐藏楼和清洗后空楼', async () => {
  const ctx = context({
    chat: [
      greeting(),
      { is_user: false, is_system: true, mes: 'system', send_date: date(1) },
      user('隐藏', 2, { is_hidden: true }),
      assistant('隐藏 AI', 3, { extra: { is_hidden: true } }),
      user('<script>空</script>', 4),
      user('保留', 5),
    ],
  });
  const result = await collectArchiveV2InitializationSources(ctx, { chatRange: { start: 0, end: 5 } });
  assert.deepEqual(byKind(result, 'chat').map(item => item.content), ['保留']);
});

test('当前 AI swipe 的内容、locator 与 fingerprint 同步变化', async () => {
  const ctx = context({
    chat: [greeting(), user('用户正文', 1), assistant('第二版', 2, {
      swipe_id: 1,
      swipes: ['第一版', '第二版'],
      swipe_info: [{ send_date: date(2) }, { send_date: date(3) }],
    })],
  });
  const first = await collectArchiveV2InitializationSources(ctx, { chatRange: { start: 2, end: 2 } });
  const before = byKind(first, 'chat')[0];
  assert.equal(before.content, '第二版');
  assert.equal(before.locator, 'floor:2:assistant:swipe:1');

  ctx.chat[2] = assistant('第一版', 2);
  const second = await collectArchiveV2InitializationSources(ctx, { chatRange: { start: 2, end: 2 } });
  const after = byKind(second, 'chat')[0];
  assert.equal(after.content, '第一版');
  assert.equal(after.locator, 'floor:2:assistant:swipe:0');
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test('瞬时 swipe 不稳定时跳过该楼并返回稳定 warning', async () => {
  const ctx = context({
    chat: [greeting(), user('稳定用户楼', 1), assistant('正在切换', 2, { swipes: ['旧内容'], swipe_id: 0 })],
  });
  const result = await collectArchiveV2InitializationSources(ctx, { chatRange: { start: 1, end: 2 } });
  assert.deepEqual(byKind(result, 'chat').map(item => item.content), ['稳定用户楼']);
  assert.ok(result.warnings.some(item => item.code === ARCHIVE_V2_SOURCE_WARNING.CHAT_SWIPE_UNSTABLE));
});

test('非法、反向和越界范围稳定拒绝且不产生正文候选', async () => {
  const invalidRanges = [null, {}, { start: 1.5, end: 2 }, { start: 2, end: 1 }, { start: -1, end: 1 }, { start: 1, end: 99 }];
  for (const chatRange of invalidRanges) {
    const result = await collectArchiveV2InitializationSources(context(), { chatRange });
    assert.equal(byKind(result, 'chat').length, 0);
    assert.deepEqual(result.warnings.at(-1), { code: ARCHIVE_V2_SOURCE_WARNING.CHAT_RANGE_INVALID });
  }
  assert.deepEqual(normalizeArchiveV2ChatRange({ start: 1, end: 2 }, 3), { status: 'valid', start: 1, end: 2 });
});

test('候选 ID 与 kind/locator 均唯一，重复世界书来源不会重复输出', async () => {
  const ctx = context({
    simulateWorldInfoActivation: async () => ({ activatedEntries: [
      { world: 'active-book', uid: 'active', content: '激活正文' },
      { world: 'active-book', uid: 'active', content: '激活正文' },
    ] }),
  });
  const result = await collectArchiveV2InitializationSources(ctx, { chatRange: { start: 1, end: 2 } });
  assert.equal(new Set(result.candidates.map(item => item.id)).size, result.candidates.length);
  assert.equal(new Set(result.candidates.map(item => `${item.kind}\u0000${item.locator}`)).size, result.candidates.length);
});

test('返回内容与宿主输入互不保留引用，输出内容均为清洗字符串', async () => {
  const ctx = context();
  const first = await collectArchiveV2InitializationSources(ctx, { chatRange: { start: 1, end: 2 } });
  assert.equal(first.candidates.some(item => typeof item.content !== 'string'), false);
  assert.equal(first.candidates.some(item => /<b>|<script>/.test(item.content)), false);
  first.candidates[0].content = '外部修改';
  first.warnings.push({ code: 'external' });
  assert.equal(ctx.characters[0].data.description, '<b>角色核心描述</b>');
  const second = await collectArchiveV2InitializationSources(ctx, { chatRange: { start: 1, end: 2 } });
  assert.notEqual(second.candidates[0].content, '外部修改');
  assert.equal(second.warnings.some(item => item.code === 'external'), false);
});

test('全过程零后端、零 AI、零宿主写入', async () => {
  const calls = { backend: 0, ai: 0, write: 0 };
  const ctx = context({
    backendClient: { get: () => { calls.backend += 1; }, put: () => { calls.backend += 1; } },
    generate: () => { calls.ai += 1; },
    saveMetadata: () => { calls.write += 1; },
    saveChatMetadata: () => { calls.write += 1; },
  });
  await collectArchiveV2InitializationSources(ctx, { chatRange: { start: 1, end: 2 } });
  assert.deepEqual(calls, { backend: 0, ai: 0, write: 0 });
});
