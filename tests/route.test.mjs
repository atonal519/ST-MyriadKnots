import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAnalysisText, collectSourceCatalogCandidates, normalizeGreeting, normalizeWorldInfoEntries } from '../src/route-source.js';

test('当前开场白使用第 0 楼当前 swipe 并严格拒绝瞬态/隐藏来源', async () => {
  const valid = { chat: [{ is_user: false, mes: '第二版', swipe_id: 1, swipes: ['第一版', '第二版'] }] };
  const greeting = await normalizeGreeting(valid);
  assert.equal(greeting.floor, 0);
  assert.equal(greeting.swipeId, 1);
  assert.match(greeting.fingerprint, /^sha256:/);
  await assert.rejects(normalizeGreeting({ chat: [{ is_user: false, mes: '瞬态', swipe_id: 1, swipes: ['第一版'] }] }));
  await assert.rejects(normalizeGreeting({ chat: [{ is_user: false, mes: '隐藏', is_hidden: true }] }));
});

test('世界书按 world+uid 去重排序并指纹，冲突 fail closed', async () => {
  const entries = await normalizeWorldInfoEntries([{ world: 'B', uid: 2, content: 'b' }, { world: 'A', uid: 1, content: 'a' }, { world: 'A', uid: 1, content: 'a' }]);
  assert.deepEqual(entries.map(item => `${item.world}:${item.uid}`), ['A:1', 'B:2']);
  await assert.rejects(normalizeWorldInfoEntries([{ world: 'A', uid: 1, content: 'a' }, { world: 'A', uid: 1, content: 'changed' }]));
});

test('V2 来源只纳入当前角色卡、实际开场白与当前启用世界书；disabled IF 线不勾选', async () => {
  const calls = [];
  const context = {
    characterId: 0,
    characters: [{ avatar: 'char.png', data: { description: '沈辞情的角色卡', extensions: { world: '当前世界' } } }],
    chat: [{ is_user: false, mes: '采用的开场白', swipe_id: 0, swipes: ['采用的开场白'] }],
    simulateWorldInfoActivation: async options => { calls.push(options); return { activatedEntries: [{ world: '实际 IF', uid: 3, content: '池逾白登场', disable: false }] }; },
    getCharaFilename: () => 'char',
    getCharaAuxWorlds: () => [],
    loadWorldInfoBatch: async worlds => {
      assert.deepEqual(worlds, ['当前世界', '实际 IF']);
      return new Map([
        ['当前世界', { entries: { 1: { uid: 1, content: '楚宵资料', disable: false }, 2: { uid: 2, content: '未启用 IF', disable: true } } }],
        ['实际 IF', { entries: { 3: { uid: 3, content: '池逾白登场', disable: false } } }],
      ]);
    },
  };
  const result = await collectSourceCatalogCandidates(context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, true);
  assert.deepEqual(result.candidates.map(item => item.kind), ['card', 'greeting', 'worldbook', 'worldbook', 'worldbook']);
  assert.equal(result.candidates.find(item => item.locator === '当前世界:1').selected, true);
  assert.equal(result.candidates.find(item => item.locator === '当前世界:2').selected, false);
  assert.equal(result.candidates.find(item => item.locator === '实际 IF:3').availability, 'activated');
});

test('正文清洗删除脚本、样式、宏和隐藏标签', () => {
  assert.equal(cleanAnalysisText('<script>x()</script><b>人物</b>{{setvar::x}}'), '人物');
});
