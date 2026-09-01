import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceCatalogAdapter } from '../src/source-catalog.js';

const CHAT = '11111111-1111-4111-8111-111111111111';
const CARD = '22222222-2222-4222-8222-222222222222';
const PERSONA = '33333333-3333-4333-8333-333333333333';
const CHAT_B = '44444444-4444-4444-8444-444444444444';
const CARD_B = '55555555-5555-4555-8555-555555555555';
const PERSONA_B = '66666666-6666-4666-8666-666666666666';
const FP = value => `sha256:${value.repeat(64).slice(0, 64)}`;

function backend() {
  const records = new Map();
  return {
    records,
    async get(collection, id) { const value = records.get(`${collection}/${id}`); if (!value) throw Object.assign(new Error('missing'), { status: 404 }); return structuredClone(value); },
    async put(collection, id, data, expectedRevision) {
      const key = `${collection}/${id}`, current = records.get(key), revision = current?.revision || 0;
      if (revision !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 409 });
      const record = { schemaVersion: 1, revision: revision + 1, generationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z', data: structuredClone(data) };
      records.set(key, record); return structuredClone(record);
    },
  };
}

function fixture() {
  const client = backend(); let collections = 0;
  const context = { characterId: 0, characters: [{ avatar: 'char.png' }], userAvatar: 'user.png', chatId: 'host-chat', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } } };
  const formalState = { status: 'route_ready', cardId: CARD, personaId: PERSONA, cardType: 'single' };
  const candidates = [
    { id: 'card:card:char.png#description', kind: 'card', locator: 'card:char.png#description', fingerprint: FP('a'), content: '角色原文', label: '角色描述', availability: 'card', selected: true, activated: false, linked: true },
    { id: 'worldbook:book:1', kind: 'worldbook', locator: 'book:1', fingerprint: FP('b'), content: '关系阶段原文', label: 'book · 关系', availability: 'enabled', selected: true, activated: false, linked: true },
    { id: 'worldbook:book:2', kind: 'worldbook', locator: 'book:2', fingerprint: FP('c'), content: '禁用原文', label: 'book · 禁用', availability: 'disabled', selected: false, activated: false, linked: true },
  ];
  const catalog = createSourceCatalogAdapter({
    client, contextProvider: () => context, formal: { getFormalState: async () => formalState },
    routeSource: { collectSourceCatalogCandidates: async () => { collections += 1; return { candidates, warnings: [] }; } },
  });
  return { catalog, client, context, formalState, collections: () => collections };
}

test('来源整理、勾选与确认全程只落一份 JSON，禁用项不进入确认快照', async () => {
  const { catalog, client, formalState, collections } = fixture();
  assert.equal((await catalog.getState({ formalState })).stage, 'uninitialized');
  const draft = await catalog.start({ formalState }); assert.equal(draft.stage, 'draft'); assert.equal(collections(), 1);
  await catalog.setSelected({ id: 'worldbook:book:1', selected: false });
  await catalog.setSelected({ id: 'worldbook:book:2', selected: true });
  const confirmed = await catalog.confirm();
  assert.equal(confirmed.stage, 'confirmed'); assert.deepEqual(confirmed.confirmedSources.map(item => item.locator), ['card:char.png#description']);
  assert.equal(client.records.size, 1); assert.equal(collections(), 1);
  const reopened = await catalog.getState({ formalState }); assert.equal(reopened.stage, 'confirmed'); assert.equal(collections(), 1);
});

test('一次性许可双领取合并；失败不自动复位，人工 retry 才产生新许可', async () => {
  const { catalog } = fixture(); await catalog.start(); await catalog.confirm();
  const [first, second] = await Promise.all([catalog.claimRecognition(), catalog.claimRecognition()]);
  assert.equal(first.status, 'claimed'); assert.equal(second.status, 'not_ready');
  assert.equal(catalog.consumeRecognitionClaim(first), true); assert.equal(catalog.consumeRecognitionClaim(first), false);
  const failed = await catalog.failRecognition({ operationId: first.operationId, errorCode: 'timeout' });
  assert.equal(failed.stage, 'failed'); assert.equal((await catalog.claimRecognition()).status, 'not_ready');
  const retried = await catalog.retry(); assert.equal(retried.stage, 'confirmed'); assert.notEqual(retried.permit.operationId, first.operationId);
  const next = await catalog.claimRecognition(); assert.equal(next.status, 'claimed');
  const completed = await catalog.completeRecognition({ operationId: next.operationId }); assert.equal(completed.stage, 'completed'); assert.equal(completed.permit.status, 'consumed');
});

test('排队确认在调用时冻结 A 上下文，A→B 切聊与新 generation 后零写 B、零许可', async () => {
  const { catalog, client, context, formalState } = fixture();
  await catalog.start();
  const aRecord = structuredClone(client.records.get(`chat-${CHAT}/people-source-catalog`));
  const bRecord = structuredClone(aRecord);
  bRecord.data = { ...bRecord.data, chatId: CHAT_B, hostChatId: 'host-chat-b', cardId: CARD_B, personaId: PERSONA_B, characterAvatar: 'char-b.png', personaAvatar: 'user-b.png' };
  client.records.set(`chat-${CHAT_B}/people-source-catalog`, bRecord);
  const bBefore = structuredClone(bRecord);

  const originalGet = client.get.bind(client); let release, blocked = false;
  client.get = async (...args) => {
    if (!blocked) { blocked = true; await new Promise(resolve => { release = resolve; }); }
    return originalGet(...args);
  };
  const blocker = catalog.getState();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const queuedConfirm = catalog.confirm();
  context.chatId = 'host-chat-b'; context.characters[0].avatar = 'char-b.png'; context.userAvatar = 'user-b.png'; context.chatMetadata.qianqianjie.chatId = CHAT_B;
  formalState.cardId = CARD_B; formalState.personaId = PERSONA_B;
  catalog.invalidate(); release();

  assert.equal((await blocker).status, 'stale'); assert.equal((await queuedConfirm).status, 'stale');
  assert.deepEqual(client.records.get(`chat-${CHAT_B}/people-source-catalog`), bBefore);
  assert.equal(client.records.get(`chat-${CHAT_B}/people-source-catalog`).data.stage, 'draft');
  assert.equal(client.records.get(`chat-${CHAT_B}/people-source-catalog`).data.permit.status, 'none');
});

test('排队确认在调用时冻结 card/persona 绑定，映射变化后返回 stale 且零写', async () => {
  const { catalog, client, formalState } = fixture();
  const draft = await catalog.start();
  const originalGet = client.get.bind(client); let release, blocked = false;
  client.get = async (...args) => {
    if (!blocked) { blocked = true; await new Promise(resolve => { release = resolve; }); }
    return originalGet(...args);
  };
  const blocker = catalog.getState();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const queuedConfirm = catalog.confirm();
  formalState.cardId = CARD_B; formalState.personaId = PERSONA_B;
  release();
  assert.equal((await blocker).stage, 'draft'); assert.equal((await queuedConfirm).status, 'stale');
  const record = client.records.get(`chat-${CHAT}/people-source-catalog`);
  assert.equal(record.revision, draft.revision); assert.equal(record.data.stage, 'draft'); assert.equal(record.data.permit.status, 'none');
});

test('未来模块只读 seam 返回确认原文并支持 refs 过滤', async () => {
  const { catalog } = fixture(); await catalog.start(); await catalog.confirm();
  const all = await catalog.readCurrentRawSources(); assert.match(all.sources[1].content, /关系阶段原文/);
  const selected = await catalog.readRawSourcesByRefs({ refs: [{ kind: 'worldbook', locator: 'book:1' }] });
  assert.deepEqual(selected.map(item => item.content), ['关系阶段原文']);
});

test('catalog 写入逐次核对当前 card/persona，绑定变化后零写', async () => {
  const { catalog, client, formalState } = fixture();
  const draft = await catalog.start();
  formalState.cardId = '44444444-4444-4444-8444-444444444444';
  assert.equal((await catalog.setSelected({ id: 'worldbook:book:1', selected: false })).status, 'stale');
  assert.equal((await catalog.confirm()).status, 'stale');
  const record = [...client.records.values()][0];
  assert.equal(record.revision, draft.revision);
  assert.equal(record.data.stage, 'draft');
  assert.equal(record.data.candidates.find(item => item.id === 'worldbook:book:1').selected, true);
});
