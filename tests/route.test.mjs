import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSourceCatalogCandidates, createRouteSourceAdapter, normalizeGreeting, normalizeWorldInfoEntries } from '../src/route-source.js';
import { createFormalAdapter } from '../src/formal-storage.js';
import { sha256 } from '../src/identity.js';

const greetingContext = (overrides = {}) => ({ chat: [{ mes: '开场', swipe_id: 0 }], simulateWorldInfoActivation: async () => ({ activatedEntries: [] }), ...overrides });

const ids = { chat: '123e4567-e89b-12d3-a456-426614174000', card: '223e4567-e89b-12d3-a456-426614174001', persona: '323e4567-e89b-12d3-a456-426614174002' };
const formalContext = () => ({ characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'char.png' }], userAvatar: 'me.png', chat: [{ mes: '开场', swipe_id: 0 }], chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: ids.chat } } });
const envelope = (data, revision = 1) => ({ schemaVersion: 1, revision, generationId: '423e4567-e89b-12d3-a456-426614174003', createdAt: '2026-08-28', updatedAt: '2026-08-28', data });
const readyMeta = () => ({ schemaVersion: 1, kind: 'chat-profile', chatId: ids.chat, cardId: ids.card, personaId: ids.persona, source: { card: { locator: 'char.png' }, persona: { locator: 'me.png' } }, cardType: 'single', route: { state: 'uninitialized' }, rebuildState: 'idle', status: 'ready', migration: { source: 'qianqianjie-demo-v1', state: 'complete', sourceRevisions: { chatMeta: 2, cardMapping: 3, personaMapping: 4 } } });

test('开场白使用第 0 楼当前 swipe，并生成稳定指纹', async () => {
  const a = await normalizeGreeting(greetingContext());
  const b = await normalizeGreeting(greetingContext({ chat: [{ mes: '开场', swipe_id: 1, swipes: ['旧开场', '开场'] }] }));
  assert.equal(a.floor, 0); assert.equal(a.swipeId, 0); assert.match(a.fingerprint, /^sha256:[0-9a-f]{64}$/); assert.notEqual(a.fingerprint, b.fingerprint);
});

test('greeting deck 严格校验 selected swipe，legacy 无 deck 仅允许 swipe 0', async () => {
  const deck = await normalizeGreeting(greetingContext({ chat: [{ mes: '第二', swipe_id: 1, swipes: ['第一', '第二'] }] }));
  assert.equal(deck.swipeId, 1);
  const macro = await normalizeGreeting(greetingContext({ chat: [{ mes: '欢迎，Alice', swipe_id: 0, swipes: ['欢迎，{{user}}'] }] }));
  assert.match(macro.fingerprint, /^sha256:/);
  await assert.rejects(normalizeGreeting(greetingContext({ chat: [{ mes: '错', swipe_id: 1, swipes: ['第一'] }] })), error => error.diagnosticCode === 'GREETING_INVALID');
  await assert.rejects(normalizeGreeting(greetingContext({ chat: [{ mes: '旧', swipe_id: 1 }] })), error => error.diagnosticCode === 'GREETING_INVALID');
});

test('严格 EJS system greeting 允许真实 deck，其他 system/EJS 证据缺失全部拒绝', async () => {
  const valid = { mes: '欢迎，Alice', is_user: false, is_system: true, is_ejs_processed: true, swipe_id: 1, swipes: ['旧', '欢迎，{{user}}', '三', '四', '五', '六'] };
  const normalized = await normalizeGreeting({ chat: [valid] }); assert.equal(normalized.swipeId, 1); assert.match(normalized.fingerprint, /^sha256:/);
  const arrayMarker = await normalizeGreeting({ chat: [{ ...valid, is_ejs_processed: [true, true] }] }); assert.equal(arrayMarker.swipeId, 1);
  const cases = [
    { is_system: true, is_ejs_processed: undefined }, { is_system: true, is_ejs_processed: false }, { is_system: true, is_ejs_processed: 'true' }, { is_system: true, is_ejs_processed: 1 }, { is_system: true, is_ejs_processed: [] }, { is_system: true, is_ejs_processed: [true, false] }, { is_system: true, is_ejs_processed: [true, 'true'] }, { is_system: true, is_ejs_processed: {} }, { is_system: true, is_ejs_processed: [[true]] },
    { is_system: true, is_ejs_processed: true, swipe_id: undefined }, { is_system: true, is_ejs_processed: true, swipes: undefined }, { is_system: true, is_ejs_processed: true, swipes: ['x'], swipe_id: 2 }, { is_system: true, is_ejs_processed: true, swipes: [1], swipe_id: 0 },
  ];
  for (const changes of cases) await assert.rejects(normalizeGreeting({ chat: [{ ...valid, ...changes }] }), error => error.diagnosticCode === 'GREETING_INVALID');
  await normalizeGreeting({ chat: [{ mes: '普通', is_user: false, is_system: false, swipe_id: 0 }] });
});

test('世界书按 world+uid 去重排序并指纹，冲突或缺字段 fail closed', async () => {
  const entries = await normalizeWorldInfoEntries([
    { world: 'b', uid: 2, content: 'B' }, { world: 'a', uid: '1', content: 'A' }, { world: 'b', uid: '2', content: 'B' },
  ]);
  assert.deepEqual(entries.map(x => `${x.world}:${x.uid}`), ['a:1', 'b:2']); assert.match(entries[0].fingerprint, /^sha256:/);
  await assert.rejects(normalizeWorldInfoEntries([{ world: 'b', uid: 2, content: 'B' }, { world: 'b', uid: 2, content: 'other' }]), error => error.diagnosticCode === 'ENTRY_INVALID');
  await assert.rejects(normalizeWorldInfoEntries([{ world: 'b', content: 'B' }]), error => error.diagnosticCode === 'ENTRY_INVALID');
});

test('人物来源预检覆盖 dry-run 激活与角色主辅世界书，并保留 disabled 但不勾选', async () => {
  let batches = 0, writes = 0;
  const context = greetingContext({
    characterId: 0, characters: [{ avatar: 'char.png', data: { description: '角色卡原文', extensions: { world: 'main' } } }],
    getCharaFilename: () => 'char', getCharaAuxWorlds: () => ['aux'],
    simulateWorldInfoActivation: async ({ dryRun }) => { assert.equal(dryRun, true); return { activatedEntries: [{ world: 'global', uid: 9, content: '处理后激活原文' }, { world: 'main', uid: 1, content: '处理后主书原文' }] }; },
    loadWorldInfoBatch: async names => {
      batches += 1; assert.deepEqual(new Set(names), new Set(['main', 'aux', 'global']));
      return new Map([
        ['main', { entries: { 1: { uid: 1, comment: '主书人物', content: '原始主书原文', disable: false }, 2: { uid: 2, comment: '禁用人物', content: '禁用原文', disable: true } } }],
        ['aux', { entries: { 3: { uid: 3, key: ['角色'], content: '辅助原文', disable: false } } }],
        ['global', { entries: { 9: { uid: 9, comment: '激活项', content: '原始激活原文', disable: false } } }],
      ]);
    }, saveWorldInfo: async () => { writes += 1; },
  });
  const result = await collectSourceCatalogCandidates(context);
  assert.equal(batches, 1); assert.equal(writes, 0);
  assert.ok(result.candidates.some(item => item.kind === 'card' && item.selected));
  assert.ok(result.candidates.some(item => item.kind === 'greeting' && item.selected));
  assert.equal(result.candidates.find(item => item.locator === 'main:1').availability, 'activated');
  assert.equal(result.candidates.find(item => item.locator === 'main:2').availability, 'disabled');
  assert.equal(result.candidates.find(item => item.locator === 'main:2').selected, false);
  assert.equal(result.candidates.find(item => item.locator === 'aux:3').availability, 'enabled');
  assert.equal(result.candidates.find(item => item.locator === 'global:9').content, '原始激活原文');
});

test('隐藏开场白不进入 catalog，也不传给世界书 dry-run', async () => {
  for (const hidden of [{ is_hidden: true }, { extra: { is_hidden: true } }]) {
    let scans = 0;
    const context = greetingContext({
      chat: [{ mes: '隐藏开场', swipe_id: 0, ...hidden }],
      characterId: 0, characters: [{ avatar: 'char.png', data: { description: '角色卡原文' } }],
      simulateWorldInfoActivation: async () => { scans += 1; return { activatedEntries: [] }; },
    });
    await assert.rejects(collectSourceCatalogCandidates(context), error => error.diagnosticCode === 'GREETING_INVALID');
    assert.equal(scans, 0);
  }
});

test('世界书排序使用 locale-independent 复合键比较', async () => {
  const entries = await normalizeWorldInfoEntries([
    { world: 'a', uid: 'B', content: '1' }, { world: 'a', uid: 'a', content: '2' }, { world: 'A', uid: 'x', content: '3' }, { world: 'a', uid: 'é', content: '4' }, { world: 'a', uid: '!', content: '5' },
  ]);
  assert.deepEqual(entries.map(x => `${x.world}:${x.uid}`), ['A:x', 'a:!', 'a:B', 'a:a', 'a:é']);
});

test('路线来源适配器明确传入 dry-run，扫描失败不等同合法空集合', async () => {
  let args;
  const source = createRouteSourceAdapter({ contextProvider: () => greetingContext({ simulateWorldInfoActivation: async value => { args = value; return { activatedEntries: [] }; } }) });
  const route = await source.collect();
  assert.equal(args.dryRun, true); assert.ok(Array.isArray(args.coreChat)); assert.deepEqual(route.worldInfoEntries, []);
  const broken = createRouteSourceAdapter({ contextProvider: () => greetingContext({ simulateWorldInfoActivation: async () => { throw new Error('unavailable'); } }) });
  await assert.rejects(broken.collect(), error => error.failClosed === true && error.diagnosticCode === 'SCAN_FAILED' && !('cause' in error));
  const unavailable = createRouteSourceAdapter({ contextProvider: () => ({ chat: [{ mes: 'x', swipe_id: 0 }] }) });
  await assert.rejects(unavailable.collect(), error => error.diagnosticCode === 'SCANNER_UNAVAILABLE');
  const invalidResult = createRouteSourceAdapter({ contextProvider: () => greetingContext({ simulateWorldInfoActivation: async () => ({ nope: true }) }) });
  await assert.rejects(invalidResult.collect(), error => error.diagnosticCode === 'SCAN_RESULT_INVALID');
});

test('formal seam 首次 CAS route_ready、二次零 PUT，来源变化不覆盖旧 route', async () => {
  const context = formalContext(); const cardKey = `avatar-${await sha256('char.png')}`; const personaKey = `avatar-${await sha256('me.png')}`;
  const records = {
    [`chat-${ids.chat}/meta`]: envelope(readyMeta(), 5),
    [`identity-cards/${cardKey}`]: envelope({ schemaVersion: 1, kind: 'identity-card', avatar: 'char.png', identityId: ids.card }, 3),
    [`identity-personas/${personaKey}`]: envelope({ schemaVersion: 1, kind: 'identity-persona', avatar: 'me.png', identityId: ids.persona }, 4),
    [`chat-meta`]: envelope({ schemaVersion: 1, kind: 'chat-demo-profile', chatId: ids.chat, cardId: ids.card, personaId: ids.persona, source: { characterAvatar: 'char.png', personaAvatar: 'me.png' }, demoProbe: 'qianqianjie-demo-v1' }, 2),
  };
  const calls = []; const client = { get: async (collection, id) => { calls.push(['get', collection, id]); const key = collection.startsWith('chat-') ? `${collection}/${id}` : `${collection}/${id}`; if (!records[key]) throw Object.assign(new Error('404'), { status: 404 }); return records[key]; }, put: async (collection, id, data, revision) => { calls.push(['put', collection, id, data, revision]); const key = `${collection}/${id}`; records[key] = envelope(data, revision + 1); return records[key]; } };
  let route = { state: 'ready', greeting: { floor: 0, swipeId: 0, fingerprint: 'sha256:' + '1'.repeat(64) }, worldInfoEntries: [] };
  const adapter = createFormalAdapter({ client, contextProvider: () => context, routeSource: { collect: async () => route } });
  assert.equal((await adapter.getFormalState()).status, 'route_ready');
  const firstPuts = calls.filter(x => x[0] === 'put').length;
  assert.equal((await adapter.getFormalState()).status, 'ready'); assert.equal(calls.filter(x => x[0] === 'put').length, firstPuts);
  route = { ...route, greeting: { ...route.greeting, swipeId: 1 } };
  assert.equal((await adapter.getFormalState()).status, 'ready'); assert.equal(calls.filter(x => x[0] === 'put').length, firstPuts);
});

test('formal ready 冻结 route 直接返回，当前 scanner 即使激活动态条目也为零调用', async () => {
  const context = formalContext(); let scans = 0;
  context.simulateWorldInfoActivation = async () => { scans += 1; return { activatedEntries: [{ world: 'dynamic', uid: '9', content: '不应重建' }] }; };
  const cardKey = `avatar-${await sha256('char.png')}`; const personaKey = `avatar-${await sha256('me.png')}`;
  const route = { state: 'ready', greeting: { floor: 0, swipeId: 0, fingerprint: `sha256:${await sha256('floor=0\nswipe=0\ncontent=开场')}` }, worldInfoEntries: [] };
  const records = {
    [`chat-${ids.chat}/meta`]: envelope({ ...readyMeta(), route }, 5),
    [`identity-cards/${cardKey}`]: envelope({ schemaVersion: 1, kind: 'identity-card', avatar: 'char.png', identityId: ids.card }, 3),
    [`identity-personas/${personaKey}`]: envelope({ schemaVersion: 1, kind: 'identity-persona', avatar: 'me.png', identityId: ids.persona }, 4),
    [`chat-meta/${ids.chat}`]: envelope({ schemaVersion: 1, kind: 'chat-demo-profile', chatId: ids.chat, cardId: ids.card, personaId: ids.persona, source: { characterAvatar: 'char.png', personaAvatar: 'me.png' } }, 2),
  };
  const client = { get: async (collection, id) => { const value = records[`${collection}/${id}`]; if (!value) throw Object.assign(new Error('404'), { status: 404 }); return value; }, put: async () => { throw new Error('ready route 不应 PUT'); } };
  const result = await createFormalAdapter({ client, contextProvider: () => context, routeSource: { collect: async () => { throw new Error('不应 collect'); } } }).getFormalState();
  assert.equal(result.status, 'ready'); assert.deepEqual(result.route, route); assert.equal(scans, 0);
});


test('严格 EJS greeting 可通过生产 route source 进入 formal CAS，普通 system 零 PUT', async () => {
  const context = formalContext(); context.chat = [{ mes: '欢迎，Alice', is_user: false, is_system: true, is_ejs_processed: [true, true], swipe_id: 1, swipes: ['旧', '欢迎，{{user}}', '三', '四', '五', '六'] }];
  const cardKey = `avatar-${await sha256('char.png')}`; const personaKey = `avatar-${await sha256('me.png')}`;
  const records = { [`chat-${ids.chat}/meta`]: envelope(readyMeta(), 5), [`identity-cards/${cardKey}`]: envelope({ schemaVersion: 1, kind: 'identity-card', avatar: 'char.png', identityId: ids.card }, 3), [`identity-personas/${personaKey}`]: envelope({ schemaVersion: 1, kind: 'identity-persona', avatar: 'me.png', identityId: ids.persona }, 4), [`chat-meta/${ids.chat}`]: envelope({ schemaVersion: 1, kind: 'chat-demo-profile', chatId: ids.chat, cardId: ids.card, personaId: ids.persona, source: { characterAvatar: 'char.png', personaAvatar: 'me.png' }, demoProbe: 'qianqianjie-demo-v1' }, 2) };
  const calls = []; const client = { get: async (collection, id) => { calls.push(['get', collection, id]); const record = records[`${collection}/${id}`]; if (!record) throw Object.assign(new Error('404'), { status: 404 }); return record; }, put: async (collection, id, data, revision) => { calls.push(['put', collection, id, data, revision]); const record = envelope(data, revision + 1); records[`${collection}/${id}`] = record; return record; } };
  const routeSource = createRouteSourceAdapter({ contextProvider: () => context }); context.simulateWorldInfoActivation = async () => ({ activatedEntries: [] });
  const result = await createFormalAdapter({ client, contextProvider: () => context, routeSource }).getFormalState(); assert.equal(result.status, 'route_ready'); assert.equal(calls.filter(x => x[0] === 'put').length, 1);
  context.chat = [{ mes: '普通系统', is_user: false, is_system: true, swipe_id: 0 }]; const before = calls.filter(x => x[0] === 'put').length; const rejected = await createFormalAdapter({ client, contextProvider: () => context, routeSource }).getFormalState(); assert.equal(rejected.status, 'ready'); assert.equal(calls.filter(x => x[0] === 'put').length, before);
  context.chat = [{ mes: 'EJS 缺失 swipe', is_user: false, is_system: true, is_ejs_processed: true, swipes: ['原始'] }]; const missingSwipe = await createFormalAdapter({ client, contextProvider: () => context, routeSource }).getFormalState(); assert.equal(missingSwipe.status, 'ready'); assert.equal(calls.filter(x => x[0] === 'put').length, before);
});

test('冻结来源正式 batch 直读：scanner=0、额外条目排除、缺失非阻断', async () => {
  let scans = 0; const context = { chat: [{ mes: '锁定问候', swipe_id: 0 }, { mes: '后续正文不得读取' }], simulateWorldInfoActivation: async () => { scans += 1; return { activatedEntries: [] }; }, loadWorldInfoBatch: async names => new Map(names.map(name => [name, { entries: { '1': { content: '冻结人物' }, '9': { content: '额外条目' } } }])) };
  const source = createRouteSourceAdapter({ contextProvider: () => context }); const route = { state: 'ready', greeting: { floor: 0, swipeId: 0, fingerprint: `sha256:${await sha256('floor=0\nswipe=0\ncontent=锁定问候')}`, content: '锁定问候' }, worldInfoEntries: [{ world: 'book', uid: '1', fingerprint: `sha256:${await sha256('冻结人物')}` }, { world: 'missing', uid: '2', fingerprint: 'sha256:' + '0'.repeat(64) }] };
  const result = await source.collectFrozenAnalysisSources(route); assert.equal(scans, 0); assert.equal(result.status, 'ready'); assert.deepEqual(result.sources.worldInfoEntries.map(item => item.uid), ['1']); assert.doesNotMatch(JSON.stringify(result.sources), /额外条目|后续正文/); assert.ok(result.warnings.some(item => item.code === 'WORLDBOOK_ENTRY_MISSING'));
  assert.deepEqual(result.diagnostics, { greeting: 'same', worldbookTotal: 2, worldbookChanged: 0, worldbookMissing: 1, worldbookUnreadable: 0, codes: ['WORLDBOOK_ENTRY_MISSING'] });
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /冻结人物|锁定问候|"book"|"missing"/);
});

test('新 route 用 raw 世界书指纹，processed 内容不同但来源未改仍为 same', async () => {
  let scans = 0; let batches = 0;
  const rawContent = '<b>原始人物</b>'; const processedContent = '激活后人物';
  const context = greetingContext({
    simulateWorldInfoActivation: async () => { scans += 1; return { activatedEntries: [{ world: 'book', uid: 1, content: processedContent }] }; },
    loadWorldInfoBatch: async names => { batches += 1; return new Map(names.map(name => [name, { entries: { '1': { content: rawContent } } }])); },
  });
  const source = createRouteSourceAdapter({ contextProvider: () => context });
  const route = await source.collect();
  assert.equal(route.worldInfoEntries[0].fingerprint, `sha256:${await sha256(rawContent)}`);
  assert.notEqual(route.worldInfoEntries[0].fingerprint, `sha256:${await sha256(processedContent)}`);
  const frozen = await source.collectFrozenAnalysisSources(route);
  assert.equal(scans, 1); assert.equal(batches, 2);
  assert.equal(frozen.sources.worldInfoEntries[0].content, '原始人物');
  assert.deepEqual(frozen.diagnostics, { greeting: 'same', worldbookTotal: 1, worldbookChanged: 0, worldbookMissing: 0, worldbookUnreadable: 0, codes: [] });
});

test('旧 activated 指纹 route 只做一次回退，匹配时返回安全 activated 内容并判 same', async () => {
  let scans = 0; const rawContent = '<b>原始人物</b>'; const processedContent = '<i>激活后人物</i>';
  const context = greetingContext({
    simulateWorldInfoActivation: async () => { scans += 1; return { activatedEntries: [{ world: 'book', uid: 1, content: processedContent }] }; },
    loadWorldInfoBatch: async names => new Map(names.map(name => [name, { entries: { '1': { content: rawContent } } }])),
  });
  const source = createRouteSourceAdapter({ contextProvider: () => context });
  const greeting = await normalizeGreeting(context);
  const route = { state: 'ready', greeting: { ...greeting, content: '开场' }, worldInfoEntries: [{ world: 'book', uid: '1', fingerprint: `sha256:${await sha256(processedContent)}` }] };
  const frozen = await source.collectFrozenAnalysisSources(route);
  assert.equal(scans, 1);
  assert.equal(frozen.sources.worldInfoEntries[0].content, '激活后人物');
  assert.deepEqual(frozen.diagnostics, { greeting: 'same', worldbookTotal: 1, worldbookChanged: 0, worldbookMissing: 0, worldbookUnreadable: 0, codes: [] });
});

test('raw 内容真实修改时 changed，missing 仍为 missing 且不触发逐项扫描', async () => {
  let scans = 0; const context = greetingContext({
    simulateWorldInfoActivation: async () => { scans += 1; return { activatedEntries: [{ world: 'book', uid: '1', content: '激活后新内容' }] }; },
    loadWorldInfoBatch: async names => new Map(names.map(name => [name, { entries: name === 'book' ? { '1': { content: '原始新内容' } } : {} }])),
  });
  const source = createRouteSourceAdapter({ contextProvider: () => context }); const greeting = await normalizeGreeting(context);
  const route = { state: 'ready', greeting: { ...greeting, content: '开场' }, worldInfoEntries: [
    { world: 'book', uid: '1', fingerprint: `sha256:${await sha256('原始旧内容')}` },
    { world: 'missing', uid: '2', fingerprint: `sha256:${await sha256('不存在')}` },
  ] };
  const frozen = await source.collectFrozenAnalysisSources(route);
  assert.equal(scans, 1);
  assert.deepEqual(frozen.diagnostics, { greeting: 'same', worldbookTotal: 2, worldbookChanged: 1, worldbookMissing: 1, worldbookUnreadable: 0, codes: ['WORLDBOOK_ENTRY_MISSING', 'WORLDBOOK_VERSION_CHANGED'] });
  assert.equal(frozen.warnings.filter(item => item.code === 'WORLDBOOK_VERSION_CHANGED').length, 1);
  assert.equal(frozen.warnings.filter(item => item.code === 'WORLDBOOK_ENTRY_MISSING').length, 1);
});

test('新 route raw 条目缺失或 batch 读取失败均 fail closed', async () => {
  const activated = async () => ({ activatedEntries: [{ world: 'book', uid: '1', content: '处理后内容' }] });
  const missing = createRouteSourceAdapter({ contextProvider: () => greetingContext({ simulateWorldInfoActivation: activated, loadWorldInfoBatch: async () => new Map([['book', { entries: {} }]]) }) });
  await assert.rejects(missing.collect(), error => error.failClosed === true && error.diagnosticCode === 'ENTRY_INVALID');
  const failed = createRouteSourceAdapter({ contextProvider: () => greetingContext({ simulateWorldInfoActivation: activated, loadWorldInfoBatch: async () => { throw new Error('secret'); } }) });
  await assert.rejects(failed.collect(), error => error.failClosed === true && error.diagnosticCode === 'SCAN_FAILED' && !('cause' in error));
});

test('冻结 batch 整体读取失败归类 unreadable，不伪报 missing/changed 且不泄漏正文', async () => {
  let scans = 0; const context = greetingContext({
    simulateWorldInfoActivation: async () => { scans += 1; return { activatedEntries: [{ world: 'book', uid: '1', content: 'SECRET 激活正文' }] }; },
    loadWorldInfoBatch: async () => { throw new Error('SECRET batch 正文'); },
  });
  const source = createRouteSourceAdapter({ contextProvider: () => context }); const greeting = await normalizeGreeting(context);
  const route = { state: 'ready', greeting: { ...greeting, content: '开场' }, worldInfoEntries: [
    { world: 'book', uid: '1', fingerprint: `sha256:${await sha256('旧内容一')}` },
    { world: 'book', uid: '2', fingerprint: `sha256:${await sha256('旧内容二')}` },
  ] };
  const frozen = await source.collectFrozenAnalysisSources(route);
  assert.equal(scans, 0); assert.deepEqual(frozen.sources.worldInfoEntries, []);
  assert.deepEqual(frozen.diagnostics, { greeting: 'same', worldbookTotal: 2, worldbookChanged: 0, worldbookMissing: 0, worldbookUnreadable: 2, codes: ['WORLDBOOK_READ_FAILED'] });
  assert.equal(frozen.warnings.filter(item => item.code === 'WORLDBOOK_READ_FAILED').length, 1);
  assert.equal(frozen.warnings.some(item => item.code === 'WORLDBOOK_ENTRY_MISSING' || item.code === 'WORLDBOOK_VERSION_CHANGED'), false);
  assert.doesNotMatch(JSON.stringify({ diagnostics: frozen.diagnostics, warnings: frozen.warnings }), /SECRET|正文|旧内容|"book"/);
});

test('formal route_unavailable 只返回安全最小状态并保持零 PUT，未知码归一 UNKNOWN', async () => {
  const context = formalContext(); const cardKey = `avatar-${await sha256('char.png')}`; const personaKey = `avatar-${await sha256('me.png')}`;
  const records = { [`chat-${ids.chat}/meta`]: envelope(readyMeta(), 5), [`identity-cards/${cardKey}`]: envelope({ schemaVersion: 1, kind: 'identity-card', avatar: 'char.png', identityId: ids.card }, 3), [`identity-personas/${personaKey}`]: envelope({ schemaVersion: 1, kind: 'identity-persona', avatar: 'me.png', identityId: ids.persona }, 4), [`chat-meta/${ids.chat}`]: envelope({ schemaVersion: 1, kind: 'chat-demo-profile', chatId: ids.chat, cardId: ids.card, personaId: ids.persona, source: { characterAvatar: 'char.png', personaAvatar: 'me.png' }, demoProbe: 'qianqianjie-demo-v1' }, 2) };
  const calls = []; const client = { get: async (collection, id) => { calls.push(['get', collection, id]); const record = records[`${collection}/${id}`]; if (!record) throw Object.assign(new Error('404'), { status: 404 }); return record; }, put: async (...args) => { calls.push(['put', ...args]); throw new Error('unexpected'); } };
  for (const diagnosticCode of ['GREETING_INVALID', 'SCANNER_UNAVAILABLE', 'SCAN_FAILED', 'SCAN_RESULT_INVALID', 'ENTRY_INVALID', 'ROUTE_INVALID', 'evil-secret-/tmp/book/uid']) {
    const adapter = createFormalAdapter({ client, contextProvider: () => context, routeSource: { collect: async () => { const error = new Error('SECRET正文 /tmp/private/book/uid'); error.failClosed = true; error.diagnosticCode = diagnosticCode; error.cause = { secret: '正文' }; throw error; } } });
    const result = await adapter.getFormalState(); const expected = diagnosticCode.startsWith('evil') ? 'UNKNOWN' : diagnosticCode;
    assert.deepEqual(result, { status: 'route_unavailable', diagnosticCode: expected, formal: { status: 'ready', cardType: 'single' } });
    assert.equal(calls.filter(x => x[0] === 'put').length, 0);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|private|book|uid|正文|tmp|123e4567|char\.png|me\.png/);
  }
});
