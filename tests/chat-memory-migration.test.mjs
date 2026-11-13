import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCarry, cleanOwnedMessage, createChatMemoryMigration, selectCarriedSourceFloor } from '../src/chat-memory-migration.js';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import { selectCompletedCarriedAliases } from '../src/v3/memory-migration.js';
import { CHAT_IDENTITY_COLLECTION } from '../src/chat-identity.js';
import { MIGRATION_ALIAS_KEY } from '../src/v3/migration-prefix.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-10-10T01:02:03.000Z';
const assistant = (mes, swipes = [mes], swipe_id = 0) => ({ is_user: false, is_system: false, mes, swipes, swipe_id, extra: { thirdParty: { keep: true } } });
const user = mes => ({ is_user: true, is_system: false, mes, send_date: `date:${mes}`, extra: { thirdParty: true } });
const uuidFactory = () => { let value = 2000; return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };

function backend(trace = [], { batchWrites = false } = {}) {
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
  if (batchWrites) client.putMany = async (collection, items) => {
    trace.push(['putMany', collection, items.length, Buffer.byteLength(JSON.stringify({ records: items }))]);
    const start = trace.length;
    const results = [];
    for (const item of items) {
      try { results.push({ recordId: item.recordId, status: 200, envelope: await client.put(collection, item.recordId, item.data, item.expectedRevision) }); }
      catch (error) { results.push({ recordId: item.recordId, status: error.status }); }
    }
    for (let index = start; index < trace.length; index++) if (trace[index][0] === 'put') trace[index][0] = 'batchItem';
    return results;
  };
  return { client, records };
}

function makeContext(chat) {
  return { chatId: 'A-file', name1: 'User', name2: 'Character', characterId: 0, groupId: null,
    characters: [{ name: 'Character', avatar: 'character.png' }], userAvatar: 'persona.png', chat,
    chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: A } }, getRequestHeaders: () => ({}),
    openCharacterChat(name) { this.opened = name; } };
}

async function fixture(chat, { holdSourceRead = false, mutateTargetRead = null, host = 'native', batchWrites = false } = {}) {
  const trace = [], store = backend(trace, { batchWrites }), context = makeContext(chat);
  const hostRoot = { getContext: () => context };
  const hostAdapter = createHostAdapter({ globalRef: host === 'luker' ? { Luker: hostRoot } : { SillyTavern: hostRoot } });
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
      ? { ok: true, status: 200, async json() {
        const value = structuredClone(files.get(key));
        mutateTargetRead?.(value, key);
        files.set(key, structuredClone(value));
        return value;
      } }
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
  return { ...store, trace, context, sourceIdentity, hostAdapter, sourceStore, runtime, migration, files, opened, releaseSourceRead };
}

async function completedMemoryFixture(chat, migrateOptions = {}) {
  const h = await fixture(chat, migrateOptions);
  let modelCalls = 0;
  const utility = async options => {
    modelCalls++;
    if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) return { jsonData: {
      summary: '林岚在书房把钥匙放进木盒。', people: [{ name: '林岚' }],
    } };
    const request = JSON.parse(options.taskMessages[0].content);
    const subject = request.payload?.trackedSubjects?.[0]?.name;
    return { jsonData: subject ? { subjects: [{ subject, situational: [
      { text: '把钥匙放进木盒', reason: '本楼正文明确描述', visibility: 'observable' },
    ] }] } : { noMaterialChange: true } };
  };
  const memoryRuntime = createV3MemoryRuntime({ foundationRuntime: h.runtime, store: h.sourceStore, hostAdapter: h.hostAdapter,
    generateAnalysisTask: utility, generateUtilityTask: utility, isEnabled: true,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), now: () => new Date(NOW), newUuid: uuidFactory(),
    logger: { warn() {} } });
  await memoryRuntime.start();
  assert.equal(h.hostAdapter.snapshot().context.chatMetadata.qianqianjie.chatId, A, 'memory runtime固定在来源身份');
  assert.equal(memoryRuntime.getState().chatId, A, '真实memory runtime已同步来源身份');
  const floor = memoryRuntime.getState().floors.find(value => value.assistantSeq === 1);
  assert.ok(floor, '来源消息经真实foundation扫描为稳定楼');
  await memoryRuntime.extractFloor(floor.floorId);
  const reachable = await h.sourceStore.readReachable({ mode: 'runtime' });
  assert.equal(reachable.status, 'ready');
  assert.equal(reachable.floorMemories.find(value => value.floorId === floor.floorId)?.recordStatus, 'active', 'summary通过真实memory runtime落盘');
  assert.equal(reachable.stateDeltas.find(value => value.floorId === floor.floorId)?.recordStatus, 'active', 'CSE通过真实memory runtime落盘');
  const source = reachable.floors.find(value => value.id === floor.floorId);
  assert.ok(source?.content?.rawFingerprint && source?.content?.canonicalFingerprint);
  const eligible = selectCompletedCarriedAliases({ reachable,
    carried: [{ sourceMessageIndex: floor.messageIndex, targetMessageIndex: 1, sourceFloorId: floor.floorId,
      rawFingerprint: source.content.rawFingerprint, canonicalFingerprint: source.content.canonicalFingerprint }],
    sourceCandidates: [{ hostLocator: { messageIndex: floor.messageIndex }, rawFingerprint: source.content.rawFingerprint,
      canonicalFingerprint: source.content.canonicalFingerprint }], newUuid: uuidFactory() });
  assert.equal(eligible.length, 1, '该摘要和CSE完成楼确实满足搬家alias选择条件');
  return { ...h, memoryRuntime, sourceReachable: reachable, sourceFloorId: floor.floorId, get modelCalls() { return modelCalls; } };
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

test('搬家成功读回只核QQJ身份与alias，宿主正文回复变化沿原生结果', async t => {
  const cases = [
    { name: '原生：正常保存读回', host: 'native', mutation: null, expected: 'completed' },
    { name: 'Luker：正常保存读回', host: 'luker', mutation: null, expected: 'completed' },
    { name: '原生：宿主只更新外部显示字段', host: 'native', mutation: chat => { chat[1].extra.otherPluginDisplay = { label: '宿主更新后的标题' }; }, verifyExternalDisplay: true, expected: 'completed' },
    { name: 'Luker：宿主只更新外部显示字段', host: 'luker', mutation: chat => { chat[1].extra.otherPluginDisplay = { label: '宿主更新后的标题' }; }, verifyExternalDisplay: true, expected: 'completed' },
    { name: '读回正文变化', mutation: chat => { chat[1].mes += ' 被改动'; }, expected: 'completed' },
    { name: '读回复选变化', mutation: chat => { chat[1].swipes = ['另一个回答']; chat[1].swipe_id = 0; }, expected: 'completed' },
    { name: 'QQJ文件归属未写入', mutation: chat => { delete chat[0].chat_metadata.qianqianjie.file; }, expected: 'QQJ_MIGRATION_HOST_VERIFY_FAILED' },
    { name: '已选alias在读回时缺失', mutation: chat => { delete chat[1].extra[MIGRATION_ALIAS_KEY]; }, expected: 'QQJ_MIGRATION_HOST_VERIFY_FAILED' },
    { name: '已选alias在读回时变化', mutation: chat => { chat[1].extra[MIGRATION_ALIAS_KEY] = '99999999-9999-4999-8999-999999999999'; }, expected: 'QQJ_MIGRATION_HOST_VERIFY_FAILED' },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const mutation = item.mutation;
    const h = await completedMemoryFixture([user('林岚问起旧钥匙'), assistant('林岚在书房把钥匙放进木盒。'), user('确认这段记录')], {
      mutateTargetRead: mutation ? chat => mutation(chat) : null,
      host: item.host ?? 'native',
    });
    assert.equal(h.hostAdapter.snapshot().source, item.host === 'luker' ? 'Luker' : 'SillyTavern');
    const sourceBefore = JSON.stringify([...h.records].filter(([key]) => key.startsWith(`chat-${A}/`)));
    if (item.expected === 'completed') {
      const result = await h.migration.migrateCurrent();
      assert.equal(result.status, 'completed');
      const target = h.files.get(result.hostChatId);
      const copiedAi = target.find(value => value.is_user === false);
      assert.ok(copiedAi.extra[MIGRATION_ALIAS_KEY], '真实完成摘要/CSE楼获得已接受alias');
      const sourceIndexes = h.sourceReachable.indexes.filter(index => index.kind === 'floorOrder');
      assert.ok(sourceIndexes.length > 0 && sourceIndexes.every(index => index.sourceCheckpointId !== h.sourceReachable.checkpoint.id),
        '来源图的首次CSE已复用摘要提交产生的楼序索引');
      const migrated = await createFoundationStore({ client: h.client,
        contextProvider: () => ({ ...h.sourceIdentity, hostChatId: result.hostChatId, chatId: result.chatId }) }).readReachable({ mode: 'full' });
      const targetIndexes = migrated.indexes.filter(index => index.kind === 'floorOrder');
      assert.equal(migrated.status, 'ready');
      assert.ok(targetIndexes.length > 0 && targetIndexes.every(index => index.chatId === result.chatId
        && index.narrativeGeneration === migrated.root.narrativeGeneration
        && index.sourceCheckpointId === migrated.checkpoint.id),
      '搬家目标必须为新chat/gen重建自己的楼序索引');
      assert.notDeepEqual(targetIndexes.map(index => index.id), sourceIndexes.map(index => index.id),
        '搬家目标不能沿用来源索引key');
      if (item.verifyExternalDisplay) {
        assert.deepEqual(copiedAi.extra.otherPluginDisplay, { label: '宿主更新后的标题' }, '读回的宿主显示字段被保留');
      }
      assert.equal(h.records.has(`${CHAT_IDENTITY_COLLECTION}/binding-${result.chatId}`), true, '通过业务核验后才发布B身份绑定');
    } else {
      await assert.rejects(() => h.migration.migrateCurrent(), error => error.code === item.expected);
      assert.equal(h.records.size && [...h.records.keys()].some(key => key.startsWith(`${CHAT_IDENTITY_COLLECTION}/binding-`)), false,
        '读回业务冲突时不发布B身份绑定');
    }
    assert.equal(JSON.stringify([...h.records].filter(([key]) => key.startsWith(`chat-${A}/`))), sourceBefore, '所有读回结果都不改写A来源图');
  });
});


test('辅助目录发布失败不否定已读回的搬家文件和独立图', async () => {
  const h = await fixture([user('中性问题'), assistant('中性回复'), user('继续')]);
  const put = h.client.put;
  h.client.put = async (collection, ...args) => { if (collection === CHAT_IDENTITY_COLLECTION) throw new Error('辅助目录发布失败'); return put(collection, ...args); };
  const result = await h.migration.migrateCurrent();
  assert.equal(result.status, 'completed'); assert.ok(h.files.has(result.hostChatId));
  const qqj = h.files.get(result.hostChatId)[0].chat_metadata.qianqianjie;
  assert.equal(qqj.chatId, result.chatId); assert.deepEqual(qqj.file, { characterLocator: 'character.png', hostChatId: result.hostChatId });
  assert.ok(h.records.has(`chat-${result.chatId}/v3-root`)); assert.deepEqual(h.opened, [result.hostChatId]);
});

test('328搬家必要历法先保存再发布文件，历法失败原A与文件目录保持',async t=>{
 for(const bad of [false,true])await t.test(bad?'历法保存失败':'健康顺序',async()=>{
  const h=await fixture([user('开场'),assistant('她把钥匙放到书房。'),user('继续')]);const before=structuredClone([...h.records].filter(([key])=>key.startsWith(`chat-${A}/`)));const calendar={months:4,prefix:'启航'},calendars=new Map();
  const moved=createChatMemoryMigration({client:h.client,session:{identity:()=>h.sourceIdentity},hostAdapter:h.hostAdapter,sourceStoreForIdentity:identity=>createFoundationStore({client:h.client,contextProvider:()=>identity}),listHostChats:async()=>[...h.files.keys()],freshUuid:uuidFactory(),now:()=>new Date(NOW),captureStoryCalendar:()=>calendar,persistStoryCalendar:async(chatId,value)=>{assert.equal(h.files.size,0);if(bad)throw Error('calendar failed');calendars.set(chatId,structuredClone(value));},fetchImpl:async(url,options)=>{const b=JSON.parse(options.body);if(url==='/api/chats/save'){assert.ok(calendars.has(b.chat[0].chat_metadata.qianqianjie.chatId));h.files.set(b.file_name,structuredClone(b.chat));return{ok:true};}const file=h.files.get(b.file_name);return{ok:!!file,status:file?200:404,json:async()=>structuredClone(file??{})};}});
  if(bad){await assert.rejects(moved.migrateCurrent(),/calendar failed/);assert.equal(h.files.size,0);assert.equal(h.opened.length,0);}else{assert.equal((await moved.migrateCurrent()).status,'completed');assert.equal(h.files.size,1);}
  assert.deepEqual([...h.records].filter(([key])=>key.startsWith(`chat-${A}/`)),before);
 });
});


test('搬家正式入口按既有批写发布32和512楼，人工摘要逐字保留且源图不写', async t => {
  for (const count of [32, 512]) await t.test(`${count}楼`, async () => {
    const chat = [];
    for (let index = 0; index < count; index++) chat.push(assistant(`第${index + 1}楼，林岚收好钥匙。`), user(`继续${index + 1}`));
    const h = await completedMemoryFixture(chat, { batchWrites: true });
    await h.memoryRuntime.editSummary(h.sourceFloorId, '人工确认：钥匙仍在木盒，保留这句原文。');
    const source = await h.sourceStore.readReachable({ mode: 'full' });
    const sourceBefore = JSON.stringify([...h.records].filter(([key]) => key.startsWith(`chat-${A}/`)));
    h.trace.length = 0;
    const modelCallsBefore = h.modelCalls;
    const result = await h.migration.migrateCurrent();
    assert.equal(result.status, 'completed');
    const writes = h.trace.filter(item => item[1] === `chat-${result.chatId}` && ['put', 'putMany'].includes(item[0]));
    const batches = writes.filter(item => item[0] === 'putMany');
    assert.ok(batches.length > 0, '正式搬家必须复用store.putRecords，不能逐条PUT');
    assert.ok(batches.every(item => item[2] <= 64 && item[3] <= 1048576));
    assert.equal(writes.at(-1)[2], 'v3-root', '内容记录确认完毕才提交根');
    assert.equal(JSON.stringify([...h.records].filter(([key]) => key.startsWith(`chat-${A}/`))), sourceBefore);
    const target = await createFoundationStore({ client: h.client, contextProvider: () => ({ ...h.sourceIdentity, chatId: result.chatId, hostChatId: result.hostChatId }) }).readReachable();
    assert.deepEqual(target.floors.map(item => item.content), source.floors.map(item => item.content));
    assert.deepEqual(target.floorMemories.map(({ chatId, narrativeGeneration, ...item }) => item), source.floorMemories.map(({ chatId, narrativeGeneration, ...item }) => item));
    assert.equal(target.floorMemories[0].summary.userText, '人工确认：钥匙仍在木盒，保留这句原文。');
    assert.equal(h.files.get(result.hostChatId).length, 3, '宿主文件仍只携两条原消息');
    assert.equal(h.modelCalls, modelCallsBefore, '搬家不调用摘要或CSE模型');
    console.log(JSON.stringify({ migrationBatchFixture: { floors: count, targetBatches: batches.length, targetSinglePuts: writes.length - batches.length,
      batchLogicalRecords: batches.reduce((sum, item) => sum + item[2], 0), batchJsonBytes: batches.reduce((sum, item) => sum + item[3], 0), modelRequestsDuringMigration: h.modelCalls - modelCallsBefore } }));
  });
});


test('搬家批内失败或冲突不提交根和宿主文件，超大正文沿原单写保完整', async t => {
  for (const mode of ['partialFailure', 'conflict', 'oversized']) await t.test(mode, async () => {
    const content = mode === 'oversized' ? '甲'.repeat(400000) : '来源原文';
    const h = await fixture([assistant(content), user('继续'), assistant('末楼'), user('等待')], { batchWrites: true });
    const sourceBefore = JSON.stringify([...h.records].filter(([key]) => key.startsWith(`chat-${A}/`)));
    if (mode !== 'oversized') {
      const putMany = h.client.putMany;
      h.client.putMany = async (collection, records) => {
        const saved = await putMany(collection, records.slice(1));
        return [{ recordId: records[0].recordId, status: mode === 'conflict' ? 409 : 500, error: 'injected', message: 'injected failure' }, ...saved];
      };
      await assert.rejects(h.migration.migrateCurrent());
      assert.equal(h.files.size, 0);
      assert.equal([...h.records].filter(([key]) => !key.startsWith(`chat-${A}/`) && key.endsWith('/v3-root')).length, 0);
      assert.ok([...h.records].some(([key]) => !key.startsWith(`chat-${A}/`)), '已确认成功记录保留，不补偿重写');
    } else {
      h.trace.length = 0;
      const result = await h.migration.migrateCurrent(); assert.equal(result.status, 'completed');
      const floor = [...h.records].find(([key, value]) => key.startsWith(`chat-${result.chatId}/v3-floor-`) && value.data.recordType === 'floor' && value.data.content.canonicalContent === content);
      assert.ok(floor, '超1MiB正文逐字保存');
      assert.ok(h.trace.some(item => item[0] === 'put' && item[1] === `chat-${result.chatId}` && item[2] === floor[0].split('/').at(-1)), '超大单条沿原单写');
    }
    assert.equal(JSON.stringify([...h.records].filter(([key]) => key.startsWith(`chat-${A}/`))), sourceBefore);
  });
});
