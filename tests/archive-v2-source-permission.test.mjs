import test from 'node:test';
import assert from 'node:assert/strict';
import { scanArchiveV2WorldInfo } from '../src/archive-v2-source-scanner.js';
import {
  createArchiveV2SourcePermissionController,
  filterArchiveV2SourcesByPermission,
} from '../src/archive-v2-source-permission.js';
import { collectArchiveV2PermittedSources } from '../src/archive-v2-sources.js';

const CHAT_A = '11111111-1111-4111-8111-111111111111';
const CHAT_B = '22222222-2222-4222-8222-222222222222';
const candidate = (book, uid, hostEnabled = true) => ({ kind: 'worldbook', world: book, uid: String(uid), permissionKey: `${book}::${uid}`, hostEnabled, availability: hostEnabled ? 'enabled' : 'disabled' });

function raw(chatId = CHAT_A) {
  return {
    characterId: 0, chatId: 'host-chat', userAvatar: 'me.png',
    characters: [{ avatar: 'char.png' }],
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId } },
  };
}

test('条目许可按稳定聊天隔离，显式覆盖宿主默认且整本排除优先', () => {
  const candidates = [{ kind: 'card' }, candidate('甲书', 1), candidate('甲书', 2, false), candidate('乙书', 1)];
  const settings = {
    sourceWorldInfoDisabledByChat: { [CHAT_A]: ['甲书::1'] },
    sourceWorldInfoOverridesByChat: { [CHAT_A]: { '甲书::2': true } },
    sourceWorldInfoExcludedBooks: ['乙书'],
  };
  assert.deepEqual(filterArchiveV2SourcesByPermission({ candidates, chatId: CHAT_A, settings }), [candidates[0], candidates[2]]);
  assert.deepEqual(filterArchiveV2SourcesByPermission({ candidates, chatId: CHAT_B, settings }), [candidates[0], candidates[1]]);
});

test('声明确认只记录当前稳定聊天；条目删除消失、修改和新增立即反映但不重置确认', async () => {
  const extension = {};
  const store = { get: () => extension, update: patch => Object.assign(extension, structuredClone(patch)) };
  let ctx = raw();
  let scan = { entries: [{ key: '甲书::1', source: '甲书', scope: 'char', label: '旧', preview: '旧', content: '旧' }], bookNames: ['甲书'], warnings: [] };
  const controller = createArchiveV2SourcePermissionController({ settings: store, contextProvider: () => ctx, scanner: async () => scan });
  assert.equal(controller.isCurrentConfirmed(), false);
  controller.confirmCurrent();
  controller.setEntryAllowed('甲书::1', false);
  assert.equal(controller.isCurrentConfirmed(), true);
  assert.deepEqual((await controller.inspectCurrent()).allowedKeys, []);
  scan = { entries: [{ key: '甲书::2', source: '甲书', scope: 'char', label: '新', preview: '改', content: '修改内容' }], bookNames: ['甲书'], warnings: [] };
  const changed = await controller.inspectCurrent();
  assert.deepEqual(changed.entries.map(item => item.key), ['甲书::2']);
  assert.deepEqual(changed.allowedKeys, ['甲书::2']);
  assert.equal(changed.confirmed, true);
  ctx = raw(CHAT_B);
  assert.equal(controller.isCurrentConfirmed(), false);
});

test('扫描器保留数字 uid，宿主启用／关闭条目都进入目录并保留默认状态', async () => {
  const result = await scanArchiveV2WorldInfo({
    characterId: 0,
    characters: [{ data: { extensions: { world: '甲书' } } }],
    getCharaFilename: () => '', getWorldInfoNames: () => ['甲书'],
    loadWorldInfoBatch: async () => new Map([['甲书', { entries: { 7: { uid: 7, content: '正文' }, 8: { uid: 8, content: '禁用', disable: true } } }]]),
  });
  assert.deepEqual(result.entries.map(item => [item.key, item.content, item.hostEnabled, item.availability]), [
    ['甲书::7', '正文', true, 'enabled'],
    ['甲书::8', '禁用', false, 'disabled'],
  ]);
});

test('整本排除目录在宿主书名缓存冷时仍刷新全部世界书，不被当前挂载书短路', async () => {
  let warm = false;
  const result = await scanArchiveV2WorldInfo({
    characterId: 0,
    characters: [{ data: { extensions: { world: '挂载书' } } }],
    getCharaFilename: () => '',
    getWorldInfoNames: () => warm ? ['挂载书', '未挂载书'] : [],
    updateWorldInfoList: async () => { warm = true; },
    loadWorldInfo: async name => name === '挂载书' ? { entries: { 1: { uid: 1, content: '正文' } } } : null,
  });
  assert.deepEqual(result.bookNames, ['挂载书', '未挂载书']);
  assert.deepEqual(result.entries.map(entry => entry.source), ['挂载书']);
});

test('三态覆盖按聊天隔离，新条目继续跟随宿主状态', async () => {
  const extension = {};
  const store = { get: () => extension, update: patch => Object.assign(extension, structuredClone(patch)) };
  let ctx = raw(CHAT_A);
  let scan = { entries: [
    { key: '甲书::开', source: '甲书', scope: 'char', label: '开', preview: '', content: '开', hostEnabled: true },
    { key: '甲书::关', source: '甲书', scope: 'char', label: '关', preview: '', content: '关', hostEnabled: false },
  ], bookNames: ['甲书'], warnings: [] };
  const controller = createArchiveV2SourcePermissionController({ settings: store, contextProvider: () => ctx, scanner: async () => scan });
  assert.deepEqual((await controller.inspectCurrent()).allowedKeys, ['甲书::开']);
  controller.setEntryAllowed('甲书::开', false);
  controller.setEntryAllowed('甲书::关', true);
  assert.deepEqual((await controller.inspectCurrent()).allowedKeys, ['甲书::关']);
  ctx = raw(CHAT_B);
  assert.deepEqual((await controller.inspectCurrent()).allowedKeys, ['甲书::开']);
  scan = { ...scan, entries: [...scan.entries, { key: '甲书::新关', source: '甲书', scope: 'char', label: '新关', preview: '', content: '新关', hostEnabled: false }] };
  assert.deepEqual((await controller.inspectCurrent()).allowedKeys, ['甲书::开']);
});

test('设置目录与实际 profile/bond 来源共享 char/aux/chat/persona/global 发现及 permissionKey', async () => {
  const books = new Map([
    ['角色书', { entries: { 1: { uid: 1, content: '林的角色资料' } } }],
    ['辅助书', { entries: { 2: { uid: 2, content: '林的辅助资料' } } }],
    ['聊天书', { entries: { 3: { uid: 3, content: '林的聊天资料' }, 6: { uid: 6, content: '宿主关闭但千千结允许', disable: true } } }],
    ['人格书', { entries: { 4: { uid: 4, content: '林的人格资料' } } }],
    ['全局书', { entries: { 5: { uid: 5, content: '林的全局资料' } } }],
  ]);
  const ctx = {
    characterId: 0,
    characters: [{ avatar: 'char.png', data: { description: '<content>角色卡</content>', extensions: { world: '角色书' } } }],
    chat: [{ is_user: false, is_system: false, mes: '开场', swipe_id: 0, swipes: ['开场'] }],
    chatMetadata: { world_info: '聊天书' },
    powerUserSettings: { persona_description_lorebook: '人格书' },
    chatWorldInfo: { globalSelection: ['全局书'] },
    getCharaFilename: () => 'char', getCharaAuxWorlds: () => ['辅助书'],
    loadWorldInfoBatch: async names => new Map(names.map(name => [name, books.get(name)])),
    simulateWorldInfoActivation: async () => ({ activatedEntries: [{ world: '全局书', uid: 5 }] }),
    getWorldInfoNames: () => [...books.keys()],
  };
  const catalog = await scanArchiveV2WorldInfo(ctx);
  assert.deepEqual(new Set(catalog.entries.map(entry => entry.key)), new Set(['角色书::1', '辅助书::2', '聊天书::3', '聊天书::6', '人格书::4', '全局书::5']));
  const settings = {
    sourceWorldInfoDisabledByChat: { [CHAT_A]: ['聊天书::3'] },
    sourceWorldInfoOverridesByChat: { [CHAT_A]: { '聊天书::6': true } },
    sourceWorldInfoExcludedBooks: ['人格书'],
  };
  const actual = await collectArchiveV2PermittedSources(ctx, { chatId: CHAT_A, permissionSettings: settings });
  const actualKeys = actual.candidates.filter(item => item.kind === 'worldbook').map(item => item.permissionKey);
  assert.deepEqual(new Set(actualKeys), new Set(['角色书::1', '辅助书::2', '聊天书::6', '全局书::5']));
  assert.equal(actual.candidates.some(item => item.permissionKey === '聊天书::3' || item.permissionKey === '人格书::4'), false);
});
