import test from 'node:test';
import assert from 'node:assert/strict';
import { listWorldInfoBookNames, scanWorldInfo } from '../src/world-info-scanner.js';
import { createSourcePermissionController, filterSourcesByPermission, filterWorldInfoSourcesByPermission } from '../src/source-permission.js';

const CHAT_A = '11111111-1111-4111-8111-111111111111';
const CHAT_B = '22222222-2222-4222-8222-222222222222';
const candidate = (book, uid, hostEnabled = true) => ({
  kind: 'worldbook',
  world: book,
  uid: String(uid),
  permissionKey: `${book}::${uid}`,
  hostEnabled,
  availability: hostEnabled ? 'enabled' : 'disabled',
});
const raw = (chatId = CHAT_A) => ({
  characterId: 0,
  chatId: 'host-chat',
  userAvatar: 'me.png',
  characters: [{ avatar: 'char.png' }],
  chatMetadata: { qianqianjie: { schemaVersion: 1, chatId } },
});

test('生成来源只服从宿主启用与整本排除，残留逐条设置不再改变结果', () => {
  const candidates = [{ kind: 'card' }, candidate('甲书', 1), candidate('甲书', 2, false), candidate('乙书', 1)];
  const settings = {
    sourceWorldInfoDisabledByChat: { [CHAT_A]: ['甲书::1'] },
    sourceWorldInfoOverridesByChat: { [CHAT_A]: { '甲书::1': false, '甲书::2': true, '乙书::1': true } },
    sourceWorldInfoExcludedBooks: ['乙书'],
  };
  assert.deepEqual(filterSourcesByPermission({ candidates, chatId: CHAT_A, settings }), [candidates[0], candidates[1]], 'disabled/false 不阻止宿主启用条目，true 不放行宿主禁用条目，整本排除仍优先');
  assert.deepEqual(filterSourcesByPermission({ candidates, chatId: CHAT_B, settings }), [candidates[0], candidates[1]]);
  const controller = createSourcePermissionController({
    settings: { get: () => settings, update() {} },
    contextProvider: () => raw(),
    bookNamesProvider: async () => [],
  });
  assert.deepEqual(controller.filterCandidates({ chatId: CHAT_A, candidates }), [candidates[0], candidates[1]], '千人调用的 controller 入口必须使用同一现行边界');
});

test('CSE baseline 世界书只按最新整本排除过滤，不读取旧逐条覆盖且不改原数组', () => {
  const sources = [
    { sourceKind: 'worldbook', sourceName: '甲书', content: '甲设定' },
    { sourceKind: 'worldbook', sourceName: '乙书', content: '乙设定' },
  ];
  const settings = {
    sourceWorldInfoExcludedBooks: ['  甲书  '],
    sourceWorldInfoDisabledByChat: { [CHAT_A]: ['乙书::1'] },
    sourceWorldInfoOverridesByChat: { [CHAT_A]: { '甲书::1': true, '乙书::1': false } },
  };
  assert.deepEqual(filterWorldInfoSourcesByPermission({ sources, settings }), [sources[1]]);
  assert.deepEqual(sources.map(source => source.sourceName), ['甲书', '乙书']);
});

test('controller 每次过滤都重新读取共享整本排除快照，解除后旧 baseline 来源立即恢复', () => {
  let excludedBooks = ['甲书'];
  const local = { sourceWorldInfoExcludedBooks: ['本地旧值'] };
  const store = {
    get: () => local,
    update: patch => Object.assign(local, structuredClone(patch)),
    sourcePermissionSnapshot: () => ({ ...local, sourceWorldInfoExcludedBooks: [...excludedBooks] }),
  };
  const controller = createSourcePermissionController({ settings: store, contextProvider: () => raw(), bookNamesProvider: async () => [] });
  const sources = [{ sourceName: '甲书' }, { sourceName: '乙书' }];
  assert.deepEqual(controller.filterWorldInfoSources(sources), [sources[1]]);
  excludedBooks = [];
  assert.equal(controller.filterWorldInfoSources(sources), sources);
});

test('controller 整本排除同步返回共享或本地 fallback 的最新完整数组', () => {
  let sharedExcluded = ['甲书'];
  const sharedStore = {
    get: () => ({}),
    update() {},
    setSharedWorldInfoExcluded(name, excluded) {
      sharedExcluded = sharedExcluded.filter(item => item !== name);
      if (excluded) sharedExcluded.push(name);
      return [...sharedExcluded];
    },
  };
  const sharedController = createSourcePermissionController({ settings: sharedStore, contextProvider: () => raw(), bookNamesProvider: async () => [] });
  assert.deepEqual(sharedController.setBookExcluded('乙书', true), ['甲书', '乙书']);
  sharedExcluded = ['构画侧新排除', '乙书'];
  assert.deepEqual(sharedController.setBookExcluded('乙书', false), ['构画侧新排除']);

  const local = { sourceWorldInfoExcludedBooks: ['甲书'] };
  const fallbackStore = { get: () => local, update: patch => Object.assign(local, structuredClone(patch)) };
  const fallbackController = createSourcePermissionController({ settings: fallbackStore, contextProvider: () => raw(), bookNamesProvider: async () => [] });
  assert.deepEqual(fallbackController.setBookExcluded('乙书', true), ['甲书', '乙书']);
  assert.deepEqual(local.sourceWorldInfoExcludedBooks, ['甲书', '乙书']);
  assert.deepEqual(fallbackController.setBookExcluded('甲书', false), ['乙书']);
  assert.deepEqual(local.sourceWorldInfoExcludedBooks, ['乙书']);
});

test('世界书列表只显示当前书名目录，规范化去重并保留已删除书的共享排除偏好', async () => {
  const extension = { sourceWorldInfoExcludedBooks: ['现存乙', '已删除丙'] };
  const store = { get: () => extension, update: patch => Object.assign(extension, structuredClone(patch)) };
  let bookNames = ['现存甲', ' 现存甲 ', 'RÉSUMÉ', 'resume', '现存乙'];
  const controller = createSourcePermissionController({ settings: store, contextProvider: () => raw(), bookNamesProvider: async () => bookNames });

  const beforeRestore = await controller.inspectCurrent();
  assert.deepEqual(beforeRestore.bookNames, ['现存甲', 'RÉSUMÉ', '现存乙']);
  assert.deepEqual(beforeRestore.excludedBooks, ['现存乙', '已删除丙']);
  assert.deepEqual(Object.keys(beforeRestore).sort(), ['bookNames', 'chatId', 'excludedBooks', 'status']);

  bookNames = ['现存甲', '现存乙', '已删除丙'];
  const afterRestore = await controller.inspectCurrent();
  assert.deepEqual(afterRestore.bookNames, ['现存甲', '现存乙', '已删除丙']);
  assert.deepEqual(afterRestore.excludedBooks, ['现存乙', '已删除丙']);
});

test('生产书名枚举合并各作用域、内置书与冷目录，绝不读取世界书正文', async () => {
  let warm = false, updates = 0, batchReads = 0, singleReads = 0;
  const context = {
    characterId: 0,
    characters: [{ avatar: '角色.png', data: { extensions: { world: '角色书' }, character_book: { name: '内置书', entries: [{ id: 1, content: '内置正文' }] } } }],
    chatWorldInfo: { getNames: () => ['聊天书'], globalSelection: ['全局书'] },
    powerUserSettings: { persona_description_lorebook: '人格书' },
    getCharaFilename: () => '角色',
    getCharaAuxWorlds: () => ['附加书'],
    getWorldInfoNames: () => warm ? ['目录书', '角色书'] : [],
    updateWorldInfoList: async () => { updates += 1; warm = true; },
    loadWorldInfoBatch: async () => { batchReads += 1; return new Map(); },
    loadWorldInfo: async () => { singleReads += 1; return null; },
  };
  assert.deepEqual(await listWorldInfoBookNames(context), ['角色书', '附加书', '聊天书', '人格书', '全局书', '内置书', '目录书']);
  assert.equal(updates, 1);
  assert.equal(batchReads, 0);
  assert.equal(singleReads, 0);

  const store = { get: () => ({ sourceWorldInfoExcludedBooks: [] }), update() {} };
  const controller = createSourcePermissionController({ settings: store, contextProvider: () => ({ ...raw(), ...context }) });
  assert.equal((await controller.inspectCurrent()).bookNames.includes('目录书'), true);
  assert.equal(batchReads, 0);
  assert.equal(singleReads, 0);
});

test('世界书扫描保留数字 uid、宿主开关和冷缓存中的完整书名目录', async () => {
  let warm = false;
  const result = await scanWorldInfo({
    characterId: 0,
    characters: [{ data: { extensions: { world: '挂载书' } } }],
    getCharaFilename: () => '',
    getWorldInfoNames: () => warm ? ['挂载书', '未挂载书'] : [],
    updateWorldInfoList: async () => { warm = true; },
    loadWorldInfoBatch: async () => new Map([['挂载书', { entries: {
      7: { uid: 7, content: '正文' },
      8: { uid: 8, content: '禁用', disable: true },
    } }]]),
  });
  assert.deepEqual(result.bookNames, ['挂载书', '未挂载书']);
  assert.deepEqual(result.entries.map(item => [item.key, item.content, item.hostEnabled, item.availability]), [
    ['挂载书::7', '正文', true, 'enabled'],
    ['挂载书::8', '禁用', false, 'disabled'],
  ]);
});
