import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_V2_SOURCE_WARNING, collectArchiveV2ProfileSources } from '../src/archive-v2-sources.js';

function context(overrides = {}) {
  return {
    characterId: 0,
    characters: [{ avatar: 'char.png', data: { description: '<b>沈辞情</b>', extensions: { world: '当前世界' } } }],
    chat: [{ is_user: false, mes: '当前开场白', swipe_id: 0, swipes: ['当前开场白'] }],
    simulateWorldInfoActivation: async () => ({ activatedEntries: [{ world: '当前世界', uid: 1, content: '沈辞情常驻资料' }] }),
    getCharaFilename: () => 'char',
    getCharaAuxWorlds: () => [],
    loadWorldInfoBatch: async () => new Map([['当前世界', { entries: {
      1: { uid: 1, content: '沈辞情常驻资料', disable: false },
      2: { uid: 2, content: '未启用 IF 线', disable: true },
    } }]]),
    ...overrides,
  };
}

test('关注人设来源保留角色卡、实际开场白和当前启用世界书，排除 disabled IF', async () => {
  const result = await collectArchiveV2ProfileSources(context());
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.candidates.map(item => item.kind), ['card', 'greeting', 'worldbook']);
  assert.equal(result.candidates.find(item => item.locator === '当前世界:1').selected, true);
  assert.equal(result.candidates.some(item => item.locator === '当前世界:2'), false);
  assert.equal(result.candidates.find(item => item.kind === 'card').content, '沈辞情');
});

test('当前开场白瞬态 swipe 不一致时排除 greeting 并给安全 warning', async () => {
  const ctx = context();
  ctx.chat[0].mes = 'DOM 尚未同步';
  const result = await collectArchiveV2ProfileSources(ctx);
  assert.equal(result.candidates.some(item => item.kind === 'greeting'), false);
  assert.equal(result.warnings.some(item => item.code === ARCHIVE_V2_SOURCE_WARNING.GREETING_TRANSIENT_SWIPE_MISMATCH), true);
});

test('世界书扫描失败时失败降级为卡与开场白，不把整本或其他 IF 线误当激活', async () => {
  const result = await collectArchiveV2ProfileSources(context({ simulateWorldInfoActivation: async () => { throw new Error('scan failed'); } }));
  assert.deepEqual(result.candidates.map(item => item.kind), ['card', 'greeting', 'worldbook']);
  assert.equal(result.candidates.filter(item => item.kind === 'worldbook').every(item => item.locator.startsWith('当前世界:')), true);
  assert.equal(result.warnings.some(item => item.code === ARCHIVE_V2_SOURCE_WARNING.WORLDBOOK_SCAN_FAILED), true);
});
