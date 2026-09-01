import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_V2_MEMORY_BATCH_KIND,
  ARCHIVE_V2_MEMORY_DEFAULTS,
  ARCHIVE_V2_MEMORY_MANIFEST_KIND,
  ARCHIVE_V2_MEMORY_SCHEMA_VERSION,
  ARCHIVE_V2_MEMORY_WARNING,
  createArchiveV2MemoryBatch,
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
  validateArchiveV2MemoryBatch,
  validateArchiveV2MemoryManifest,
} from '../src/archive-v2-memory-foundation.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TIME = '2026-08-31T10:20:30.000Z';
const FP = character => `sha256:${character.repeat(64)}`;

const assistant = (content, overrides = {}) => ({
  is_user: false,
  is_system: false,
  mes: content,
  swipe_id: 0,
  swipes: [content],
  extra: {},
  ...overrides,
});

function context(overrides = {}) {
  let metadataWrites = 0;
  const value = {
    characterId: 0,
    characters: [{ avatar: 'character.png' }],
    userAvatar: 'persona.png',
    chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
    chat: [assistant('开场白'), assistant('第一楼')],
    saveMetadata: async () => { metadataWrites += 1; },
    ...overrides,
  };
  return { value, writes: () => metadataWrites };
}

function rows(overrides = {}) {
  return {
    people: [{ localId: 'P1', displayName: '沈砚', aliases: ['阿砚'], sourceFloors: [0] }],
    facts: [{ subjectLocalId: 'P1', category: 'personality', value: '沉静', sourceFloors: [0] }],
    relations: [{
      subjectLocalId: 'P1', objectKind: 'user', objectLocalId: null, category: 'bond', summary: '信任用户', sourceFloors: [0],
    }],
    events: [{
      localId: 'E1', title: '相遇', summary: '二人初次相遇', participantLocalIds: ['P1'],
      involvesUser: true, significance: 'major', sourceFloors: [0],
    }],
    ...overrides,
  };
}

async function fixture() {
  const ctx = context({ chat: [assistant('开场白'), assistant('第一楼')] }).value;
  const snapshot = await createArchiveV2MemorySnapshot(ctx, { maxFloorsPerBatch: 1, maxCharactersPerBatch: 1000 });
  const manifest = createArchiveV2MemoryManifest({ snapshot, scanId: 'scan-1', createdAt: TIME });
  return { snapshot, manifest, plan: snapshot.batches[0] };
}

test('稳定 UUID、单聊、角色和 Persona 缺失均安全失败且零 metadata 写入', async () => {
  const cases = [
    context({ chatMetadata: {} }),
    context({ groupId: 'group-1' }),
    context({ characters: [{}], characterAvatar: '' }),
    context({ userAvatar: '', personaAvatar: '' }),
  ];
  for (const item of cases) {
    await assert.rejects(createArchiveV2MemorySnapshot(item.value), TypeError);
    assert.equal(item.writes(), 0);
  }
});

test('可见、两种 hidden 与 /hide assistant 都纳入，user 正文 getter 零读取', async () => {
  let userReads = 0;
  const ctx = context({ chat: [
    assistant('可见'),
    assistant('直接隐藏', { is_hidden: true }),
    assistant('extra 隐藏', { extra: { is_hidden: true } }),
    { is_user: true, is_system: false, get mes() { userReads += 1; throw new Error('不应读取的用户正文'); } },
    { is_user: false, is_system: true, mes: '/hide 后的正文' },
  ] }).value;
  const snapshot = await createArchiveV2MemorySnapshot(ctx);
  assert.deepEqual(snapshot.floors.map(floor => [floor.content, floor.hidden]), [
    ['可见', false], ['直接隐藏', true], ['extra 隐藏', true], ['/hide 后的正文', true],
  ]);
  assert.equal(userReads, 0);
});

test('切换 is_system 只改变 hidden 投影，不改变内容集合与三级指纹', async () => {
  const ctx = context({ chat: [assistant('同一正文')] }).value;
  const visible = await createArchiveV2MemorySnapshot(ctx);
  ctx.chat[0].is_system = true;
  const hidden = await createArchiveV2MemorySnapshot(ctx);
  assert.deepEqual(hidden.floors.map(floor => floor.content), visible.floors.map(floor => floor.content));
  assert.equal(visible.floors[0].hidden, false);
  assert.equal(hidden.floors[0].hidden, true);
  assert.equal(hidden.floors[0].fingerprint, visible.floors[0].fingerprint);
  assert.equal(hidden.sourceFingerprint, visible.sourceFingerprint);
  assert.deepEqual(hidden.batches.map(batch => batch.sourceFingerprint), visible.batches.map(batch => batch.sourceFingerprint));
});

test('只采用当前 swipe，换行等价放行；非法、瞬时错配告警且不泄露原文', async () => {
  const secret = '绝不能泄露的正文';
  const snapshot = await createArchiveV2MemorySnapshot(context({ chat: [
    assistant('第二版\r\n正文', { swipe_id: 1, swipes: ['第一版', '第二版\n正文'] }),
    assistant(secret, { swipe_id: 3, swipes: ['一版'] }),
    assistant(secret, { swipe_id: 0, swipes: ['另一份秘密'] }),
    { is_user: false, is_system: false, mes: '无 swipes 正文\r下一行' },
    { is_user: false, is_system: false, mes: '缺省 swipe_id', swipes: ['缺省 swipe_id'] },
  ] }).value);
  assert.deepEqual(snapshot.floors.map(floor => [floor.swipeId, floor.content]), [
    [1, '第二版\n正文'], [0, '无 swipes 正文\n下一行'], [0, '缺省 swipe_id'],
  ]);
  assert.deepEqual(snapshot.warnings, [
    { code: ARCHIVE_V2_MEMORY_WARNING.SWIPE_UNSTABLE, sourceIndex: 1 },
    { code: ARCHIVE_V2_MEMORY_WARNING.SWIPE_UNSTABLE, sourceIndex: 2 },
  ]);
  assert.equal(JSON.stringify(snapshot.warnings).includes(secret), false);
});

test('未知 role、空白和无 swipes 非字符串分别稳定告警', async () => {
  const snapshot = await createArchiveV2MemorySnapshot(context({ chat: [
    { mes: '不能猜角色' },
    assistant('   '),
    { is_user: false, is_system: false, mes: null },
  ] }).value);
  assert.deepEqual(snapshot.warnings, [
    { code: ARCHIVE_V2_MEMORY_WARNING.ROLE_UNKNOWN, sourceIndex: 0 },
    { code: ARCHIVE_V2_MEMORY_WARNING.CONTENT_INVALID, sourceIndex: 1 },
    { code: ARCHIVE_V2_MEMORY_WARNING.CONTENT_INVALID, sourceIndex: 2 },
  ]);
});

test('snapshot 冻结 cutoff 与字符串副本，原 chat 后续 push/edit/hide 不反向改变', async () => {
  const ctx = context({ chat: [assistant('原始正文')] }).value;
  const snapshot = await createArchiveV2MemorySnapshot(ctx);
  ctx.chat[0].mes = ctx.chat[0].swipes[0] = '外部编辑';
  ctx.chat[0].is_hidden = true;
  ctx.chat.push(assistant('新增楼'));
  assert.equal(snapshot.targetFloor, 0);
  assert.deepEqual(snapshot.floors.map(floor => [floor.content, floor.hidden]), [['原始正文', false]]);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.floors) && Object.isFrozen(snapshot.floors[0]));
});

test('调用后立即修改宿主第二楼，异步哈希完成的 snapshot 仍保留调用时纯值', async () => {
  const ctx = context({ chat: [assistant('第一楼旧正文'), assistant('第二楼旧正文')] }).value;
  const pending = createArchiveV2MemorySnapshot(ctx);
  ctx.chat[1].mes = '第二楼新正文';
  ctx.chat[1].swipes[0] = '第二楼新正文';
  ctx.chat[1].is_hidden = true;
  const snapshot = await pending;
  assert.deepEqual(snapshot.floors.map(floor => [floor.content, floor.hidden]), [
    ['第一楼旧正文', false], ['第二楼旧正文', false],
  ]);
});

test('hide/unhide 不改变 fingerprint 或分批，编辑和 swipe 变化会改变', async () => {
  const original = context({ chat: [assistant('第一版')] }).value;
  const visible = await createArchiveV2MemorySnapshot(original);
  original.chat[0].is_hidden = true;
  const hidden = await createArchiveV2MemorySnapshot(original);
  assert.equal(hidden.floors[0].fingerprint, visible.floors[0].fingerprint);
  assert.equal(hidden.sourceFingerprint, visible.sourceFingerprint);
  assert.deepEqual(hidden.batches.map(batch => batch.sourceFingerprint), visible.batches.map(batch => batch.sourceFingerprint));

  original.chat[0] = assistant('第二版', { swipe_id: 1, swipes: ['第一版', '第二版'] });
  const changed = await createArchiveV2MemorySnapshot(original);
  assert.notEqual(changed.floors[0].fingerprint, visible.floors[0].fingerprint);
  assert.notEqual(changed.sourceFingerprint, visible.sourceFingerprint);
  assert.notEqual(changed.batches[0].sourceFingerprint, visible.batches[0].sourceFingerprint);

  const sameContent = context({ chat: [assistant('相同正文', { swipes: ['相同正文', '相同正文'], swipe_id: 0 })] }).value;
  const swipeZero = await createArchiveV2MemorySnapshot(sameContent);
  sameContent.chat[0].swipe_id = 1;
  const swipeOne = await createArchiveV2MemorySnapshot(sameContent);
  assert.notEqual(swipeOne.floors[0].fingerprint, swipeZero.floors[0].fingerprint);
});

test('按有效楼层数分批且 gap 不占名额，字符提前截批，单超长楼完整独批', async () => {
  const floorLimit = await createArchiveV2MemorySnapshot(context({ chat: [
    assistant('A'), { is_user: true, is_system: false, mes: 'gap' }, assistant('B'),
    { is_user: false, is_system: true, mes: '/hide' }, assistant('C'),
  ] }).value, { maxFloorsPerBatch: 2, maxCharactersPerBatch: 100 });
  assert.deepEqual(floorLimit.batches.map(batch => batch.sourceIndices), [[0, 2], [3, 4]]);

  const characterLimit = await createArchiveV2MemorySnapshot(context({ chat: [
    assistant('1234'), assistant('5678'), assistant('X'.repeat(11)), assistant('ok'),
  ] }).value, { maxFloorsPerBatch: 20, maxCharactersPerBatch: 7 });
  assert.deepEqual(characterLimit.batches.map(batch => [batch.sourceIndices, batch.characterCount]), [
    [[0], 4], [[1], 4], [[2], 11], [[3], 2],
  ]);
  assert.equal(characterLimit.batches[2].floors[0].content.length, 11);
});

test('分批选项拒绝非正整数、越界和未知键；同输入结果确定', async () => {
  for (const options of [
    { maxFloorsPerBatch: 0 }, { maxFloorsPerBatch: 1.5 }, { maxFloorsPerBatch: 1001 },
    { maxCharactersPerBatch: -1 }, { maxCharactersPerBatch: 10000001 }, { surprise: true },
  ]) await assert.rejects(createArchiveV2MemorySnapshot(context().value, options), TypeError);
  const first = await createArchiveV2MemorySnapshot(context().value, ARCHIVE_V2_MEMORY_DEFAULTS);
  const second = await createArchiveV2MemorySnapshot(context().value, ARCHIVE_V2_MEMORY_DEFAULTS);
  assert.equal(first.sourceFingerprint, second.sourceFingerprint);
  assert.deepEqual(first.batches, second.batches);
});

test('manifest 工厂生成严格 scanning 合同、JSON 副本和冻结输出', async () => {
  const { snapshot } = await fixture();
  const manifest = createArchiveV2MemoryManifest({ snapshot, scanId: ' scan-1 ', createdAt: TIME });
  assert.deepEqual(manifest, {
    schemaVersion: ARCHIVE_V2_MEMORY_SCHEMA_VERSION,
    kind: ARCHIVE_V2_MEMORY_MANIFEST_KIND,
    chatId: CHAT,
    scanId: 'scan-1',
    targetFloor: 1,
    sourceFingerprint: snapshot.sourceFingerprint,
    batchSize: 1,
    totalBatches: 2,
    completedBatchIndexes: [],
    status: 'scanning',
    batchRefs: [],
    createdAt: TIME,
    updatedAt: TIME,
  });
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.batchRefs));
});

test('manifest 接受 partial/interrupted/ready，拒绝越界乱序 refs 和不完整 ready', async () => {
  const { manifest, snapshot } = await fixture();
  const partial = {
    ...structuredClone(manifest),
    completedBatchIndexes: [0],
    status: 'interrupted',
    batchRefs: [{ batchIndex: 0, recordId: 'batch-0', sourceFingerprint: snapshot.batches[0].sourceFingerprint }],
  };
  assert.equal(validateArchiveV2MemoryManifest(partial).status, 'interrupted');
  const ready = {
    ...partial,
    completedBatchIndexes: [0, 1],
    status: 'ready',
    batchRefs: snapshot.batches.map((plan, batchIndex) => ({
      batchIndex, recordId: `batch-${batchIndex}`, sourceFingerprint: plan.sourceFingerprint,
    })),
  };
  assert.equal(validateArchiveV2MemoryManifest(ready, { expectedChatId: CHAT }).status, 'ready');

  for (const invalid of [
    { ...partial, completedBatchIndexes: [1, 0] },
    { ...partial, completedBatchIndexes: [2] },
    { ...partial, batchRefs: [{ ...partial.batchRefs[0], batchIndex: 1 }] },
    { ...partial, status: 'interrupted', batchRefs: [] },
    { ...partial, status: 'scanning', batchRefs: [] },
    { ...partial, completedBatchIndexes: [], batchRefs: [partial.batchRefs[0]] },
    { ...partial, batchRefs: [partial.batchRefs[0], partial.batchRefs[0]] },
    { ...partial, status: 'ready' },
    { ...partial, updatedAt: '2026-01-01T00:00:00.000Z' },
    { ...partial, unknown: true },
  ]) assert.throws(() => validateArchiveV2MemoryManifest(invalid), TypeError);
});

test('manifest 精确 JSON：拒绝循环、getter、symbol、非 JSON，并且输出不共享引用', async () => {
  const { manifest } = await fixture();
  const mutable = structuredClone(manifest);
  const safe = validateArchiveV2MemoryManifest(mutable);
  mutable.completedBatchIndexes.push(0);
  assert.deepEqual(safe.completedBatchIndexes, []);

  const circular = structuredClone(manifest);
  circular.self = circular;
  const getter = structuredClone(manifest);
  Object.defineProperty(getter, 'status', { enumerable: true, get() { throw new Error('secret'); } });
  const symbolic = structuredClone(manifest);
  symbolic[Symbol('secret')] = true;
  const nonJson = structuredClone(manifest);
  nonJson.totalBatches = NaN;
  for (const invalid of [circular, getter, symbolic, nonJson]) {
    assert.throws(() => validateArchiveV2MemoryManifest(invalid), TypeError);
  }
});

test('memory batch 四类扁平 row 可创建，trim、引用与 sourceFloors 生效且不存原文', async () => {
  const { manifest, plan } = await fixture();
  const inputRows = rows();
  inputRows.people[0].displayName = ' 沈砚 ';
  const batch = createArchiveV2MemoryBatch({ manifest, plan, rows: inputRows, createdAt: TIME });
  assert.equal(batch.kind, ARCHIVE_V2_MEMORY_BATCH_KIND);
  assert.equal(batch.rows.people[0].displayName, '沈砚');
  assert.equal('floors' in batch, false);
  assert.equal(JSON.stringify(batch).includes('开场白'), false);
  inputRows.people[0].aliases.push('外部修改');
  assert.deepEqual(batch.rows.people[0].aliases, ['阿砚']);
  assert.ok(Object.isFrozen(batch) && Object.isFrozen(batch.rows.people));
  assert.deepEqual(validateArchiveV2MemoryBatch(batch, {
    plan, expectedChatId: CHAT, expectedScanId: 'scan-1',
  }), batch);
});

test('batch 本地严格拒绝跨批/重复楼层、人物引用、重复 alias/localId/参与者、非法枚举、越界数量与 plan 错配', async () => {
  const { manifest, plan } = await fixture();
  const invalidRows = [
    rows({ people: [{ localId: 'P1', displayName: '沈砚', aliases: [], sourceFloors: [99] }] }),
    rows({ facts: [{ subjectLocalId: 'P9', category: 'identity', value: '未知', sourceFloors: [0] }] }),
    rows({ relations: [{ subjectLocalId: 'P1', objectKind: 'person', objectLocalId: 'P9', category: 'bond', summary: '无', sourceFloors: [0] }] }),
    rows({ events: [{ localId: 'E1', title: '事', summary: '事', participantLocalIds: ['P9'], involvesUser: false, significance: 'major', sourceFloors: [0] }] }),
    rows({ people: [{ localId: 'P1', displayName: '沈砚', aliases: [' 沈砚 '], sourceFloors: [0] }] }),
    rows({ people: [{ localId: 'P1', displayName: '沈砚', aliases: ['阿砚', ' 阿砚 '], sourceFloors: [0] }] }),
    rows({ people: [{ localId: 'P1', displayName: '沈砚', aliases: [], sourceFloors: [0, 0] }] }),
    rows({ events: [{ localId: 'E1', title: '事', summary: '事', participantLocalIds: ['P1', 'P1'], involvesUser: false, significance: 'major', sourceFloors: [0] }] }),
    rows({ people: [
      { localId: 'P1', displayName: '甲', aliases: [], sourceFloors: [0] },
      { localId: 'P1', displayName: '乙', aliases: [], sourceFloors: [0] },
    ] }),
    rows({ facts: [{ subjectLocalId: 'P1', category: 'nonsense', value: '错', sourceFloors: [0] }] }),
    rows({ people: Array.from({ length: 501 }, (_, index) => ({ localId: `P${index}`, displayName: `人${index}`, aliases: [], sourceFloors: [0] })) }),
  ];
  for (const candidate of invalidRows) {
    assert.throws(() => createArchiveV2MemoryBatch({ manifest, plan, rows: candidate, createdAt: TIME }), TypeError);
  }
  const multiSnapshot = await createArchiveV2MemorySnapshot(context({ chat: [assistant('零'), assistant('一')] }).value);
  const multiManifest = createArchiveV2MemoryManifest({ snapshot: multiSnapshot, scanId: 'scan-multi', createdAt: TIME });
  assert.throws(() => createArchiveV2MemoryBatch({
    manifest: multiManifest,
    plan: multiSnapshot.batches[0],
    rows: rows({ people: [{ localId: 'P1', displayName: '沈砚', aliases: [], sourceFloors: [1, 0] }] }),
    createdAt: TIME,
  }), TypeError);
  assert.throws(() => createArchiveV2MemoryBatch({
    manifest, plan: { ...structuredClone(plan), batchIndex: 99 }, rows: rows(), createdAt: TIME,
  }), TypeError);
  assert.throws(() => validateArchiveV2MemoryBatch({
    schemaVersion: 1, kind: ARCHIVE_V2_MEMORY_BATCH_KIND, chatId: OTHER_CHAT, scanId: 'scan-1',
    batchIndex: 0, floorStart: 0, floorEnd: 0, floorCount: 1,
    sourceFingerprint: plan.sourceFingerprint, rows: rows(), createdAt: TIME,
  }, { plan, expectedChatId: CHAT, expectedScanId: 'scan-1' }), TypeError);
});

test('batch 精确字段并拒绝循环/getter/symbol/非 JSON，模块全过程不触碰 I/O', async () => {
  const { manifest, plan } = await fixture();
  const batch = structuredClone(createArchiveV2MemoryBatch({ manifest, plan, rows: rows(), createdAt: TIME }));
  for (const mutate of [
    value => { value.unknown = true; },
    value => { value.rows.people[0].self = value.rows.people[0]; },
    value => { Object.defineProperty(value.rows, 'facts', { enumerable: true, get() { throw new Error('secret'); } }); },
    value => { value.rows[Symbol('secret')] = true; },
    value => { value.rows.events[0].involvesUser = undefined; },
  ]) {
    const value = structuredClone(batch);
    mutate(value);
    assert.throws(() => validateArchiveV2MemoryBatch(value, { plan }), TypeError);
  }
  assert.equal(Object.keys(globalThis).some(key => key.startsWith('qianqianjieMemoryTestIo')), false);
});
