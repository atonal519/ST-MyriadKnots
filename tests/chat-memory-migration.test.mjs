import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCarry, cleanOwnedMessage, createChatMemoryMigration, selectCarriedSourceFloor } from '../src/chat-memory-migration.js';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { selectCompletedCarriedAliases } from '../src/v3/memory-migration.js';
import { CHAT_IDENTITY_COLLECTION } from '../src/chat-identity.js';
import { MIGRATION_ALIAS_KEY } from '../src/v3/migration-prefix.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-10-10T01:02:03.000Z';
const assistant = (mes, swipes = [mes], swipe_id = 0) => ({ is_user: false, is_system: false, mes, swipes, swipe_id, extra: { thirdParty: { keep: true } } });
const user = mes => ({ is_user: true, is_system: false, mes, send_date: `date:${mes}`, extra: { thirdParty: true } });
const uuidFactory = () => { let value = 2000; return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };

function backend(trace = []) {
  const records = new Map();
  const client = {
    async get(collection, id) { const value = records.get(`${collection}/${id}`); if (!value) throw Object.assign(new Error('missing'), { status: 404 }); return structuredClone(value); },
    async put(collection, id, data, revision) {
      trace.push(['put', collection, id]);
      const key = `${collection}/${id}`, previous = records.get(key);
      if ((previous?.revision ?? 0) !== revision) throw Object.assign(new Error('conflict'), { status: 409 });
      const value = { revision: revision + 1, data: structuredClone(data) }; records.set(key, value); return structuredClone(value);
    },
  };
  return { client, records };
}

function makeContext(chat) {
  return { chatId: 'A-file', name1: 'User', name2: 'Character', characterId: 0, groupId: null,
    characters: [{ name: 'Character', avatar: 'character.png' }], userAvatar: 'persona.png', chat,
    chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: A } }, getRequestHeaders: () => ({}),
    openCharacterChat(name) { this.opened = name; } };
}

async function fixture(chat, { holdSourceRead = false } = {}) {
  const trace = [], store = backend(trace), context = makeContext(chat);
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => context } } });
  const sourceIdentity = { hostChatId: 'A-file', chatId: A, characterLocator: 'character.png', personaLocator: 'persona.png' };
  const sourceStore = createFoundationStore({ client: store.client, contextProvider: () => sourceIdentity });
  const runtime = createFoundationRuntime({ hostAdapter, store: sourceStore, contextProvider: () => context,
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  await runtime.start();
  const files = new Map(), opened = [];
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body), key = body.file_name;
    if (url.endsWith('/api/chats/save')) { files.set(key, structuredClone(body.chat)); return { ok: true, status: 200, async json() { return {}; } }; }
    if (url.endsWith('/api/chats/get')) return files.has(key)
      ? { ok: true, status: 200, async json() { return structuredClone(files.get(key)); } }
      : { ok: false, status: 404, async json() { return {}; } };
    throw new Error(`unexpected ${url}`);
  };
  let releaseSourceRead;
  const sourceGate = holdSourceRead ? new Promise(resolve => { releaseSourceRead = resolve; }) : null;
  const migration = createChatMemoryMigration({ client: store.client,
    session: { identity: () => sourceIdentity }, hostAdapter, sourceStoreForIdentity: identity => {
      const value = createFoundationStore({ client: store.client, contextProvider: () => identity });
      if (identity.chatId !== A || !sourceGate) return value;
      return { ...value, readReachable: async options => { await sourceGate; return value.readReachable(options); } };
    },
    listHostChats: async avatar => { assert.equal(avatar, 'character.png'); return []; }, freshUuid: uuidFactory(), now: () => new Date(NOW), fetchImpl,
    copyPeople: async ({ targetIdentity, entities }) => { trace.push(['people', entities.length]); await store.client.put(`chat-${targetIdentity.chatId}`, 'v3-people-workspace', { copied: true }, 0); return { copied: true }; },
    copyTime: async ({ sourceIdentity, reachable }) => { assert.equal(reachable.status, 'ready'); trace.push(['time']); return {
      batchIds: ['time-record-1'], sourceHeadSnapshot: { schemaVersion: 1, chatId: sourceIdentity.chatId,
        batchIds: ['time-record-1'], bodyStart: { floorId: 'source-floor', awaitingFirst: false },
        settingAnnualSources: { year: { sourceKey: 'year', status: 'active' } }, manualStop: { itemId: 'old-item' } },
    }; },
    copyVector: async ({ sourceReachable }) => { assert.equal(sourceReachable.status, 'ready'); trace.push(['vector']); return ['vector-shard-1']; },
  });
  // Keep the fake open operation observable without changing the captured source target.
  context.openCharacterChat = name => opened.push(name);
  return { ...store, trace, context, sourceIdentity, sourceStore, runtime, migration, files, opened, releaseSourceRead };
}

test('尾部待回复用户消息与最近AI按原顺序优先携带，搬家只发布B文件与独立图', async () => {
  const h = await fixture([user('较早问题'), assistant('已完成回复'), user('待回复问题')]);
  const sourceBefore = JSON.stringify([...h.records].filter(([key]) => key.startsWith(`chat-${A}/`)));
  const result = await h.migration.migrateCurrent();
  assert.equal(result.status, 'completed');
  assert.equal(result.carriedMessageCount, 2);
  const [header, ...messages] = h.files.get(result.hostChatId);
  assert.equal(header.chat_metadata.qianqianjie.chatId, result.chatId);
  assert.equal(messages.length, 2); assert.equal(messages[0].mes, '已完成回复'); assert.equal(messages[1].mes, '待回复问题');
  assert.equal(messages[1].extra.thirdParty, true);
  assert.equal(messages[0].extra[MIGRATION_ALIAS_KEY], undefined, '没有已发布摘要/CSE的消息作为B普通新楼');
  assert.deepEqual(h.opened, [result.hostChatId]);
  const copiedAuxiliaryAt = Math.max(h.trace.findIndex(item => item[0] === 'people'), h.trace.findIndex(item => item[0] === 'time'), h.trace.findIndex(item => item[0] === 'vector'));
  const firstTargetGraphWrite = h.trace.findIndex(item => item[0] === 'put' && item[1] === `chat-${result.chatId}` && item[2] !== 'v3-people-workspace' && item[2] !== 'qqj-vector-index' && !item[2].startsWith('qqj-vector-shard-'));
  assert.ok(copiedAuxiliaryAt >= 0 && copiedAuxiliaryAt < firstTargetGraphWrite, 'people/time/vector先于B迁移root依赖图写入');
  assert.equal(h.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${result.chatId}`).data.sourceChatId, A);
  const migrated = await createFoundationStore({ client: h.client, contextProvider: () => ({ ...h.sourceIdentity, chatId: result.chatId, hostChatId: result.hostChatId }) }).readReachable();
  assert.equal(migrated.status, 'ready'); assert.deepEqual(migrated.migrationDescriptor.recordRefs.timeBatchIds, ['time-record-1']);
  assert.deepEqual(migrated.migrationDescriptor.sourceTimeHeadSnapshots, [{ sourceChatId: A, head: {
    schemaVersion: 1, chatId: A, batchIds: ['time-record-1'], bodyStart: { floorId: 'source-floor', awaitingFirst: false },
    settingAnnualSources: { year: { sourceKey: 'year', status: 'active' } }, manualStop: { itemId: 'old-item' },
  } }], 'A已保存head作为冻结来源保留，和B当前head分开');
  assert.equal(JSON.stringify([...h.records].filter(([key]) => key.startsWith(`chat-${A}/`))), sourceBefore, '搬家没有改写A图');
});

test('搬家跳过非千千结隐藏的system消息，携带最近普通AI和USER', async () => {
  const fakeSystemAssistant = { is_user: false, is_system: true, mes: '宿主系统消息', extra: {} };
  const carried = chooseCarry({ chat: [user('问题'), assistant('普通AI回复'), fakeSystemAssistant] },
    () => '33333333-3333-4333-8333-333333333333', A);
  assert.deepEqual(carried.messages.map(message => message.mes), ['问题', '普通AI回复']);
  assert.equal(carried.messages.some(message => message.mes === '宿主系统消息'), false);
});

test('首次正式source read挂起时后续原地清空A不改变已捕获的两条搬家消息', async () => {
  const h = await fixture([user('来源问题'), assistant('已捕获的回复'), user('待回复')], { holdSourceRead: true });
  const pending = h.migration.migrateCurrent();
  h.context.chat.length = 0;
  h.context.chat.push(user('后来替换的B内容'));
  h.releaseSourceRead();
  const result = await pending;
  const [, ...messages] = h.files.get(result.hostChatId);
  assert.deepEqual(messages.map(message => message.mes), ['已捕获的回复', '待回复']);
});

test('搬家目标保存不依赖后来选中的角色卡，切到另一角色时只跳过自动打开', async () => {
  const h = await fixture([user('问题'), assistant('回复'), user('后续')], { holdSourceRead: true });
  const pending = h.migration.migrateCurrent();
  h.context.characters[0].avatar = 'another-character.png';
  h.releaseSourceRead();
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.opened, false);
  assert.ok(h.files.has(result.hostChatId), 'A的固定目标B仍完成保存和校验');
  assert.deepEqual(h.opened, []);
});

test('非待回复尾部携带最近用户与AI的选中swipe，不打包旧swipe或千千结回执', async () => {
  const ai = assistant('旧未选内容', ['旧未选内容', '实际选中内容'], 1);
  ai.extra.qqj_v3_recall_receipt = { payload: 'old' }; ai.swipe_info = [{ extra: { keep: 'old' } }, { extra: { keep: 'selected', qianqianjie_floor: { chatId: A } } }];
  const h = await fixture([user('较早问题'), assistant('来源图中已完成回复'), user('对应提问'), ai]);
  const result = await h.migration.migrateCurrent();
  const [, carriedUser, carriedAi] = h.files.get(result.hostChatId);
  assert.equal(result.carriedMessageCount, 2);
  assert.equal(carriedUser.mes, '对应提问');
  assert.equal(carriedAi.mes, '实际选中内容');
  assert.deepEqual(carriedAi.swipes, ['实际选中内容']);
  assert.equal(carriedAi.swipe_info.length, 1);
  assert.equal(carriedAi.swipe_info[0].extra.keep, 'selected');
  assert.equal(carriedAi.extra.qqj_v3_recall_receipt, undefined);
  assert.equal(carriedAi.extra[MIGRATION_ALIAS_KEY], undefined, '没有已发布摘要/CSE的楼作为普通B新楼');
});

test('已记AI无extra且源选中非零swipe时仍建立携带alias并只保留选中内容', () => {
  const message = { is_user: false, mes: '旧候选', swipes: ['旧候选', '来源已记内容'], swipe_id: 1 };
  const copied = cleanOwnedMessage(message, { ai: true, aliasId: '33333333-3333-4333-8333-333333333333', sourceChatId: A });
  assert.equal(copied.mes, '来源已记内容');
  assert.deepEqual(copied.swipes, ['来源已记内容']);
  assert.equal(copied.swipe_id, 0);
  assert.equal(copied.extra[MIGRATION_ALIAS_KEY], '33333333-3333-4333-8333-333333333333');
});

test('再次搬家按实时partition定位来源楼，不与旧冻结楼的同号locator碰撞', () => {
  const frozenId = '11111111-1111-4111-8111-111111111111';
  const liveId = '22222222-2222-4222-8222-222222222222';
  const aliasId = '33333333-3333-4333-8333-333333333333';
  const reachable = { floors: [
    { id: frozenId, hostLocator: { messageIndex: 1 } },
    { id: liveId, hostLocator: { messageIndex: 1 } },
  ], migrationDescriptor: { frozenFloorIds: [frozenId], floorOrigins: [], carriedAliases: [] } };
  assert.equal(selectCarriedSourceFloor(reachable, { sourceMessageIndex: 1 }).id, liveId);
  reachable.migrationDescriptor.carriedAliases.push({ aliasId, floorId: frozenId });
  assert.equal(selectCarriedSourceFloor(reachable, { priorAliasId: aliasId, sourceMessageIndex: 1 }).id, frozenId,
    '原已记alias仍能映射其精确冻结floor');
});

test('显式来源楼指纹不符时不回退到同号B活动楼', () => {
  const frozen = { id: '11111111-1111-4111-8111-111111111111', hostLocator: { messageIndex: 0 },
    content: { rawFingerprint: 'old-raw', canonicalFingerprint: 'old-canonical' } };
  const live = { id: '22222222-2222-4222-8222-222222222222', hostLocator: { messageIndex: 0 },
    content: { rawFingerprint: 'new-raw', canonicalFingerprint: 'new-canonical' } };
  const reachable = { floors: [frozen, live], floorMemories: [{ floorId: live.id, recordStatus: 'active' }],
    stateDeltas: [{ floorId: live.id, recordStatus: 'active' }], migrationDescriptor: { frozenFloorIds: [frozen.id], floorOrigins: [], carriedAliases: [] } };
  const aliases = selectCompletedCarriedAliases({ reachable,
    carried: [{ sourceMessageIndex: 0, targetMessageIndex: 0, sourceFloorId: frozen.id, rawFingerprint: 'new-raw', canonicalFingerprint: 'new-canonical' }],
    sourceCandidates: [{ hostLocator: { messageIndex: 0 }, rawFingerprint: 'new-raw', canonicalFingerprint: 'new-canonical' }],
    newUuid: () => '33333333-3333-4333-8333-333333333333' });
  assert.deepEqual(aliases, [], '显式来源与正文见证冲突时不认领B同号楼');
});
