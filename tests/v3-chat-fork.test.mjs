import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { createChatBranchInitializer } from '../src/v3/chat-branch-inheritance.js';
import { initializeMigrationGraph } from '../src/v3/memory-migration.js';
import { MIGRATION_ALIAS_KEY } from '../src/v3/migration-prefix.js';
import { createV3RecallRuntime, projectHistoricalRecallReceipt, RECALL_PROMPT_SLOT, RECALL_RECEIPT_KEY } from '../src/v3/recall-runtime.js';
import { createPeopleWorkspaceStore } from '../src/v3/people-workspace.js';
import { replayCurrentState } from '../src/v3/cse-engine.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import { createChatIdentityCoordinator, CHAT_IDENTITY_COLLECTION } from '../src/chat-identity.js';
import { createChatSession } from '../src/chat-session.js';
import { createPluginLifecycle } from '../src/plugin-lifecycle.js';
import { deterministicUuid } from '../src/v3/foundation-domain.js';

const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-09-05T00:00:00.000Z';
const assistant = mes => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0 });
const user = mes => ({ is_user: true, is_system: false, mes, send_date: `test-user:${mes}` });
const uuidFactory = () => { let value = 1000; return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };

function backendHarness() {
  const records = new Map();
  const calls = [];
  const failure = status => Object.assign(new Error(`HTTP ${status}`), { status });
  const envelope = (data, revision) => ({ revision, data: structuredClone(data), createdAt: NOW, updatedAt: NOW });
  const client = {
    async get(collection, key) {
      calls.push(['get', collection, key]);
      const value = records.get(`${collection}/${key}`);
      if (!value) throw failure(404);
      return envelope(value.data, value.revision);
    },
    async put(collection, key, data, expectedRevision) {
      calls.push(['put', collection, key]);
      const mapKey = `${collection}/${key}`;
      const previous = records.get(mapKey);
      if ((previous?.revision ?? 0) !== expectedRevision) throw failure(409);
      const revision = (previous?.revision ?? 0) + 1;
      records.set(mapKey, { revision, data: structuredClone(data) });
      return envelope(data, revision);
    },
  };
  return { records, calls, client };
}

function context(hostChatId, qqjChatId, chat, characterAvatar = 'character.png') {
  const value = {
    name1: '林岚', name2: '裴晚生', characterId: 0, groupId: null, chatId: hostChatId,
    characters: [{ avatar: characterAvatar, name: '裴晚生', data: { description: '角色描述', personality: '克制', scenario: '雨夜' } }],
    userAvatar: 'persona.png', powerUserSettings: { persona_description: '调查员' },
    chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: qqjChatId } }, chat,
    async saveMetadata() {}, async saveChat() { return true; }, getRequestHeaders() { return {}; },
    getWorldInfoNames() { return []; }, async loadWorldInfoBatch() { return new Map(); },
  };
  return value;
}

function identity(hostChatId, chatId, characterLocator = 'character.png') {
  return { hostChatId, chatId, characterLocator, personaLocator: 'persona.png' };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function chatRecords(records, chatId) {
  return JSON.stringify([...records.entries()].filter(([key]) => key.startsWith(`chat-${chatId}/`)).sort(([left], [right]) => left.localeCompare(right)));
}

test('一键搬家为B独立复制完整冻结图，保留A字节并让B正常foundation读取归档前缀', async () => {
  const backend = backendHarness();
  const aChat = [user('旧档的开场问题。'), assistant('裴晚生把蓝铜钥匙放进东馆的旧木盒。'), user('继续。'), assistant('A最新的普通回复。'), user('蓝铜钥匙现在放在哪里？')];
  const sourceIdentity = identity('A-file', SOURCE);
  const sourceContext = context(sourceIdentity.hostChatId, SOURCE, aChat);
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => sourceContext } } });
  const sourceStore = createFoundationStore({ client: backend.client, contextProvider: () => sourceIdentity });
  const sourceFoundation = createFoundationRuntime({ hostAdapter, store: sourceStore, contextProvider: () => sourceContext, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  await sourceFoundation.start();
  const sourceMemory = createV3MemoryRuntime({ foundationRuntime: sourceFoundation, store: sourceStore, hostAdapter,
    automationSettings: () => ({ enabled: false, batchSize: 1 }),
    generateAnalysisTask: async () => ({ jsonData: { noMaterialChange: true } }),
    generateUtilityTask: async options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '裴晚生把蓝铜钥匙放进东馆的旧木盒。' } }
      : { jsonData: { noMaterialChange: true } },
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  await sourceMemory.start();
  const sourceFloorIdForSummary = sourceMemory.getState().floors[0].floorId;
  await sourceMemory.extractFloor(sourceFloorIdForSummary, { analyzeState: false });
  await sourceMemory.analyzeNextState();
  const source = await sourceStore.readReachable({ mode: 'full' });
  assert.equal(source.status, 'ready');
  const sourceMemoryRecord = source.floorMemories.find(memory => memory.floorId === sourceFloorIdForSummary && memory.recordStatus === 'active');
  const sourceDeltaRecord = source.stateDeltas.find(delta => delta.floorId === sourceFloorIdForSummary && delta.recordStatus === 'active');
  assert.ok(sourceMemoryRecord?.summary.aiText, '搬家前通过正式Extractor保存至少一份旧摘要');
  assert.ok(sourceDeltaRecord, '搬家前通过正式CSE保存至少一条旧delta');
  const sourceBefore = chatRecords(backend.records, SOURCE);
  const bId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const targetIdentity = identity('B-file', bId);
  const aliasId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const bChat = [assistant('A最新的普通回复。'), user('蓝铜钥匙现在放在哪里？')];
  bChat[0].extra = { [MIGRATION_ALIAS_KEY]: aliasId };
  const sourceFloor = source.floors.at(-1);
  assert.equal(sourceFloor.assistantSeq, 2, JSON.stringify(source.floors.map(floor => [floor.id, floor.assistantSeq, floor.hostLocator])));
  const alias = { aliasId, floorId: sourceFloor.id, targetMessageIndex: 0,
    rawFingerprint: sourceFloor.content.rawFingerprint, canonicalFingerprint: sourceFloor.content.canonicalFingerprint };
  const targetStore = createFoundationStore({ client: backend.client, contextProvider: () => targetIdentity });
  const migrated = await initializeMigrationGraph({ store: targetStore, sourceIdentity, targetIdentity, sourceReachable: source,
    carriedAliases: [alias], targetChat: bChat, now: () => new Date(NOW), newUuid: uuidFactory() });
  assert.equal(migrated.status, 'ready');
  assert.equal(migrated.reachable.root.chatId, bId);
  assert.equal(migrated.reachable.migrationDescriptor.frozenFloorIds.length, source.floors.length);
  assert.deepEqual(migrated.reachable.floors.map(floor => floor.id), source.floors.map(floor => floor.id));
  assert.notEqual(migrated.reachable.root.narrativeGeneration, source.root.narrativeGeneration);
  assert.equal(chatRecords(backend.records, SOURCE), sourceBefore, 'A 的正式图未被搬家改写');

  // A frozen floor with no summary must still resist orphan-marker recovery:
  // this uses an actual migration descriptor and B foundation read path.
  const frozenTargetId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const frozenTargetIdentity = identity('B-frozen-file', frozenTargetId);
  const frozenChat = structuredClone(aChat);
  const frozenAliases = await Promise.all(source.floors.map(async floor => {
    const aliasId = await deterministicUuid(['frozen-orphan-alias', frozenTargetId, floor.id]);
    const message = frozenChat[floor.hostLocator.messageIndex];
    message.extra = { ...(message.extra ?? {}), [MIGRATION_ALIAS_KEY]: aliasId };
    delete message.extra.qianqianjie_floor;
    return { aliasId, floorId: floor.id, targetMessageIndex: floor.hostLocator.messageIndex,
      rawFingerprint: floor.content.rawFingerprint, canonicalFingerprint: floor.content.canonicalFingerprint };
  }));
  const frozenTargetStore = createFoundationStore({ client: backend.client, contextProvider: () => frozenTargetIdentity });
  const frozenMigration = await initializeMigrationGraph({ store: frozenTargetStore, sourceIdentity, targetIdentity: frozenTargetIdentity,
    sourceReachable: source, carriedAliases: frozenAliases, targetChat: frozenChat, now: () => new Date(NOW), newUuid: uuidFactory() });
  const frozenContext = context(frozenTargetIdentity.hostChatId, frozenTargetId, frozenChat);
  const frozenHost = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => frozenContext } } });
  const frozenRuntime = createFoundationRuntime({ hostAdapter: frozenHost, store: frozenTargetStore, contextProvider: () => frozenContext,
    hasTimeFloorReference: async () => false, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal(frozenMigration.status, 'ready');
  assert.ok(frozenMigration.reachable.migrationDescriptor.frozenFloorIds.includes(source.floors.at(-1).id));
  assert.ok(!source.floorMemories.some(memory => memory.floorId === source.floors.at(-1).id && memory.recordStatus === 'active'),
    '被测归档末楼没有摘要，保持为冻结历史');
  assert.equal((await frozenRuntime.start()).status, 'ready');
  const frozenTargetMessage = frozenContext.chat[source.floors.at(-1).hostLocator.messageIndex];
  const frozenOrphanId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  frozenTargetMessage.extra.qianqianjie_floor = { schemaVersion: 1, chatId: frozenTargetId, floorId: frozenOrphanId };
  const frozenPutsBefore = backend.calls.filter(([method, collection]) => method === 'put' && collection === `chat-${frozenTargetId}`).length;
  const frozenReview = await frozenRuntime.refreshStatus();
  assert.equal(frozenReview.status, 'ready', '匹配归档alias仍作为冻结历史，不把其host marker当作B live楼重登');
  assert.ok(frozenRuntime.getReachable().migrationDescriptor.frozenFloorIds.includes(source.floors.at(-1).id));
  assert.equal(frozenTargetMessage.extra.qianqianjie_floor.floorId, frozenOrphanId);
  assert.equal(backend.calls.filter(([method, collection]) => method === 'put' && collection === `chat-${frozenTargetId}`).length, frozenPutsBefore,
    '归档alias被识别后marker与root均未改动');

  // A separate actual B graph without a carried alias exercises archive recall
  // without treating the copied latest reply as a current source-body witness.
  const recallTargetId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const recallTargetIdentity = identity('B-recall-file', recallTargetId);
  const recallTargetChat = [assistant('A最新的普通回复。'), user('蓝铜钥匙现在放在哪里？')];
  const recallTargetStore = createFoundationStore({ client: backend.client, contextProvider: () => recallTargetIdentity });
  const recallMigration = await initializeMigrationGraph({ store: recallTargetStore, sourceIdentity, targetIdentity: recallTargetIdentity,
    sourceReachable: source, targetChat: recallTargetChat, now: () => new Date(NOW), newUuid: uuidFactory() });
  assert.equal(recallMigration.status, 'ready');
  assert.ok(recallMigration.reachable.floorMemories.some(memory => memory.floorId === sourceMemoryRecord.floorId && memory.recordStatus === 'active'),
    '第二个真实初始化的B图保留源摘要记录');
  let recallContext = context(recallTargetIdentity.hostChatId, recallTargetId, recallTargetChat);
  const recallHost = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => recallContext } } });
  const recallFoundation = createFoundationRuntime({ hostAdapter: recallHost, store: recallTargetStore, contextProvider: () => recallContext,
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await recallFoundation.start()).status, 'ready');
  assert.equal(recallFoundation.getReachable().migrationDescriptor.id, recallMigration.descriptor.id);
  const promptCalls = [];
  recallContext.setExtensionPrompt = (slot, text) => promptCalls.push([slot, text]);
  const recall = createV3RecallRuntime({ store: recallTargetStore, hostAdapter: recallHost, now: () => new Date(NOW), pluginVersion: '0.7.2', logger: { warn() {} } });
  const recallResult = await recall.intercept(recallContext.chat, 12000, null, 'normal');
  assert.equal(recallResult.lastRecall.status, 'ready', JSON.stringify(recallResult.lastRecall));
  assert.ok(recallResult.lastRecall.selectedFloors.some(floor => floor.floorId === sourceMemoryRecord.floorId), '正式selector选中B图内的冻结旧summary');
  assert.match(recallResult.lastRecall.injectionText, /蓝铜钥匙.*东馆.*旧木盒/u);
  assert.equal(promptCalls.filter(([slot]) => slot === RECALL_PROMPT_SLOT).at(-1)?.[1], recallResult.lastRecall.injectionText,
    '正式recall interceptor把冻结来源材料写入宿主prompt slot');
  const recallUser = recallContext.chat.at(-1);
  const verifiedReceipt = await projectHistoricalRecallReceipt(recallUser, { chatId: recallTargetId, userMessageIndex: 1 });
  assert.equal(recallUser.extra[RECALL_RECEIPT_KEY].completionStatus, 'ready');
  assert.equal(verifiedReceipt?.selectedFloors.some(floor => floor.floorId === sourceMemoryRecord.floorId), true,
    '正式回执通过签名/归属核验并可只读恢复');

  let activeContext = context(targetIdentity.hostChatId, bId, bChat);
  const targetHost = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => activeContext } } });
  const targetFoundation = createFoundationRuntime({ hostAdapter: targetHost, store: targetStore, contextProvider: () => activeContext, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  const loaded = await targetFoundation.start();
  assert.equal(loaded.status, 'ready');
  assert.equal(targetFoundation.getReachable().migrationDescriptor.id, migrated.descriptor.id);
  assert.equal(targetFoundation.getReachable().floors.length, source.floors.length, 'alias携带AI仍只对应冻结source floor');
  let rebuilding = false, rebuildCalls = 0, rebuildCseCalls = 0;
  const targetMemory = createV3MemoryRuntime({ foundationRuntime: targetFoundation, store: targetStore, hostAdapter: targetHost,
    automationSettings: () => ({ enabled: false, batchSize: 1 }),
    generateAnalysisTask: async () => { if (rebuilding) rebuildCseCalls += 1; return { jsonData: { noMaterialChange: true } }; },
    generateUtilityTask: async options => {
      if (rebuilding) rebuildCalls += 1;
      return options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
        ? { jsonData: { summary: rebuilding ? 'B活动摘要-重构后' : 'B活动摘要-第一次' } }
        : { jsonData: { noMaterialChange: true } };
    }, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  await targetMemory.start();
  const aliasUiState = targetMemory.getState();
  assert.ok(aliasUiState.migrationAliases.some(alias => alias.aliasId === aliasId && alias.floorId === sourceFloor.id && alias.targetMessageIndex === 0),
    '楼内投影复用正式migration descriptor中的alias来源，不重新读档或计算正文hash');
  assert.equal(aliasUiState.floors.find(floor => floor.floorId === sourceFloor.id)?.frozen, true);
  const aliasPromptCalls = [];
  activeContext.setExtensionPrompt = (slot, text) => aliasPromptCalls.push([slot, text]);
  const aliasRecall = createV3RecallRuntime({ store: targetStore, hostAdapter: targetHost, now: () => new Date(NOW), pluginVersion: '0.7.2', logger: { warn() {} } });
  const aliasRecallResult = await aliasRecall.intercept(activeContext.chat, 12000, null, 'normal');
  assert.equal(aliasRecallResult.lastRecall.status, 'ready', JSON.stringify(aliasRecallResult.lastRecall));
  assert.ok(aliasRecallResult.lastRecall.selectedFloors.some(floor => floor.floorId === sourceMemoryRecord.floorId), '带alias的真实B图召回冻结旧summary');
  assert.equal(aliasPromptCalls.filter(([slot]) => slot === RECALL_PROMPT_SLOT).at(-1)?.[1], aliasRecallResult.lastRecall.injectionText);
  const aliasReceipt = await projectHistoricalRecallReceipt(activeContext.chat.at(-1), { chatId: bId, userMessageIndex: 1 });
  assert.equal(aliasReceipt?.selectedFloors.some(floor => floor.floorId === sourceMemoryRecord.floorId), true,
    '带alias的正式召回receipt已保存并通过归属核验');
  activeContext.chat[0].mes = 'B把携带的回复编辑成了新内容。';
  activeContext.chat[0].swipes = [activeContext.chat[0].mes];
  const afterAliasEdit = await targetFoundation.refreshStatus();
  assert.equal(afterAliasEdit.status, 'ready');
  assert.ok(!targetFoundation.getReachable().migrationDescriptor.frozenFloorIds.includes(targetFoundation.getReachable().floors.at(-1).id),
    '编辑携带正文后按B真实新楼处理');
  const recallAfterAliasEdit = await aliasRecall.intercept(activeContext.chat, 12000, null, 'normal');
  assert.equal(recallAfterAliasEdit.lastRecall.status, 'ready', JSON.stringify(recallAfterAliasEdit.lastRecall));
  assert.ok(recallAfterAliasEdit.lastRecall.selectedFloors.some(floor => floor.floorId === sourceMemoryRecord.floorId),
    'B携带正文编辑后仍可召回不可变旧摘要');
  activeContext.chat.push(assistant('B继续后的新楼'), user('B下一位用户'));
  const continued = await targetFoundation.refreshStatus();
  assert.equal(continued.status, 'ready');
  const afterNewFloor = targetFoundation.getReachable();
  assert.equal(afterNewFloor.floors.length, source.floors.length + 2);
  assert.equal(afterNewFloor.floors.at(-1).assistantSeq, source.floors.length + 2);
  assert.equal(afterNewFloor.floors.at(-1).hostLocator.messageIndex, 2, '活动楼使用B真实宿主楼号');
  assert.deepEqual(afterNewFloor.floors[0], migrated.reachable.floors[0], '新增B楼没有重绑或改写冻结旧楼');

  await targetMemory.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(targetMemory.getState().rebuildStatus) && !targetMemory.getState().activeAutoMemory, 'B活动楼首次分析未追平');
  const firstComplete = await targetStore.readReachable({ mode: 'runtime' });
  const firstLive = firstComplete.floors.at(-1), firstLiveMemory = firstComplete.floorMemories.find(memory => memory.floorId === firstLive.id && memory.recordStatus === 'active');
  const firstLiveDelta = firstComplete.stateDeltas.find(delta => delta.floorId === firstLive.id && delta.recordStatus === 'active');
  assert.equal(firstLiveMemory?.summary.aiText, 'B活动摘要-第一次');
  assert.ok(firstLiveDelta, 'B活动楼先具有已完成的CSE记录');
  const frozenIds = new Set(firstComplete.migrationDescriptor.frozenFloorIds);
  const liveFloorCountBeforeRebuild = firstComplete.floors.filter(floor => !frozenIds.has(floor.id)).length;
  const frozenMemoriesBefore = firstComplete.floorMemories.filter(memory => frozenIds.has(memory.floorId));
  const frozenDeltasBefore = firstComplete.stateDeltas.filter(delta => frozenIds.has(delta.floorId));
  assert.ok(frozenMemoriesBefore.length > 0, '重构前的冻结旧summary数组非空');
  assert.ok(frozenDeltasBefore.length > 0, '重构前的冻结旧CSE数组非空');
  const firstMemoryId = firstLiveMemory.id, firstDeltaId = firstLiveDelta.id;
  // The public runtime method is the same reset used by the production rebuild task.
  rebuilding = true;
  await targetMemory.resetLiveMigrationMemoriesForRebuild();
  await targetMemory.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(targetMemory.getState().rebuildStatus) && !targetMemory.getState().activeAutoMemory, '迁移B活动楼完整重构未追平');
  const rebuilt = await targetStore.readReachable({ mode: 'runtime' });
  const rebuiltLiveMemory = rebuilt.floorMemories.find(memory => memory.floorId === firstLive.id && memory.recordStatus === 'active');
  const rebuiltLiveDelta = rebuilt.stateDeltas.find(delta => delta.floorId === firstLive.id && delta.recordStatus === 'active');
  assert.equal(rebuildCalls, liveFloorCountBeforeRebuild, '每个B真实活动楼恰好重提取一次；冻结楼不进入Extractor');
  assert.equal(rebuildCseCalls, liveFloorCountBeforeRebuild, '每个B真实活动楼恰好重新分析一次CSE；冻结楼不进入CSE');
  assert.equal(rebuiltLiveMemory?.summary.aiText, 'B活动摘要-重构后');
  assert.notEqual(rebuiltLiveMemory.id, firstMemoryId);
  assert.ok(rebuiltLiveDelta);
  assert.notEqual(rebuiltLiveDelta.id, firstDeltaId);
  assert.equal(rebuilt.migrationDescriptor.id, migrated.descriptor.id);
  assert.deepEqual(rebuilt.floorMemories.filter(memory => frozenIds.has(memory.floorId)), frozenMemoriesBefore, '冻结历史FloorMemory记录及引用不变');
  assert.deepEqual(rebuilt.stateDeltas.filter(delta => frozenIds.has(delta.floorId)), frozenDeltasBefore, '冻结历史CSE记录及引用不变');
});

test('1000楼正式foundation图搬家保留完整冻结前缀并按B身份独立读取', async () => {
  const backend = backendHarness();
  const chat = [];
  for (let index = 0; index < 1000; index += 1) {
    chat.push(assistant(`来源第${index + 1}楼正文，记录一条独特的旧经历 ${index + 1}。`), user(`继续第${index + 1}楼`));
  }
  const sourceIdentity = identity('A-1000-file', SOURCE), sourceContext = context(sourceIdentity.hostChatId, SOURCE, chat);
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => sourceContext } } });
  const sourceStore = createFoundationStore({ client: backend.client, contextProvider: () => sourceIdentity });
  const sourceFoundation = createFoundationRuntime({ hostAdapter, store: sourceStore, contextProvider: () => sourceContext,
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  const started = await sourceFoundation.start();
  assert.equal(started.status, 'ready');
  const source = await sourceStore.readReachable({ mode: 'full' });
  assert.equal(source.floors.length, 1000);
  const bId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', targetIdentity = identity('B-1000-file', bId);
  const targetStore = createFoundationStore({ client: backend.client, contextProvider: () => targetIdentity });
  const carried = [assistant('最近一次已完成回复'), user('之后继续')];
  const migrated = await initializeMigrationGraph({ store: targetStore, sourceIdentity, targetIdentity, sourceReachable: source,
    targetChat: carried, now: () => new Date(NOW), newUuid: uuidFactory() });
  assert.equal(migrated.reachable.floors.length, 1000);
  assert.equal(migrated.descriptor.frozenFloorIds.length, 1000);
  assert.equal(migrated.reachable.floors[999].assistantSeq, 1000);
  assert.equal(migrated.reachable.floors[999].chatId, bId);
  assert.equal(migrated.reachable.floors[999].hostLocator.messageIndex, 1998, '存档旧locator不伪装成B的两条消息楼号');
  assert.equal(migrated.reachable.root.chatId, bId);
  assert.equal((await targetStore.readReachable({ mode: 'runtime' })).floors.length, 1000);
});

test('已保存摘要但CSE未齐的携带AI成为B真实活动楼并复用摘要，不回写冻结来源', async () => {
  const backend = backendHarness();
  const aChat = [user('原提问'), assistant('已完成摘要的旧回复'), user('等待续写')];
  const sourceIdentity = identity('A-partial', SOURCE), sourceContext = context(sourceIdentity.hostChatId, SOURCE, aChat);
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => sourceContext } } });
  const sourceStore = createFoundationStore({ client: backend.client, contextProvider: () => sourceIdentity });
  const sourceFoundation = createFoundationRuntime({ hostAdapter, store: sourceStore, contextProvider: () => sourceContext,
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  await sourceFoundation.start();
  const sourceMemory = createV3MemoryRuntime({ foundationRuntime: sourceFoundation, store: sourceStore, hostAdapter,
    generateAnalysisTask: async () => ({ jsonData: { noMaterialChange: true } }),
    generateUtilityTask: async options => options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT
      ? { jsonData: { summary: '已经保存的旧楼摘要。' } }
      : { jsonData: { noMaterialChange: true } },
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  await sourceMemory.start();
  const sourceFloorId = sourceMemory.getState().floors[0].floorId;
  await sourceMemory.extractFloor(sourceFloorId, { analyzeState: false });
  const source = await sourceStore.readReachable({ mode: 'full' });
  const sourceSavedMemory = source.floorMemories.find(item => item.floorId === sourceFloorId && item.recordStatus === 'active');
  assert.equal(source.status, 'ready'); assert.ok(sourceSavedMemory?.summary.aiText);
  assert.equal(source.stateDeltas.some(item => item.floorId === sourceFloorId), false);
  const enrichedSourceMemory = structuredClone(sourceSavedMemory);
  enrichedSourceMemory.locations = [{ itemId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', entityId: null, name: '东馆', change: 'present',
    participantEntityIds: [], evidenceRefs: [{ floorId: sourceFloorId, anchorId: null, quotedText: '已完成摘要的旧回复',
      occurrence: 1, evidenceMode: 'witnessed', supports: '地点证据', sourceEntityId: null }] }];
  const sourceForMigration = { ...source,
    run: { ...(source.run ?? {}), diagnostics: { ...(source.run?.diagnostics ?? {}),
      floorProvenance: { ...(source.run?.diagnostics?.floorProvenance ?? {}), [sourceFloorId]: {
        timeEdited: true, storyClockSignature: 'frozen-source-clock', api: 'transient-diagnostic',
      } } } },
    floorMemories: source.floorMemories.map(item => item.id === enrichedSourceMemory.id ? enrichedSourceMemory : item) };
  const bId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', targetIdentity = identity('B-partial', bId);
  const targetChat = [user('旧问题搬家后仍按原顺序保留'), assistant('已完成摘要的旧回复')];
  const targetStore = createFoundationStore({ client: backend.client, contextProvider: () => targetIdentity });
  const migrated = await initializeMigrationGraph({ store: targetStore, sourceIdentity, targetIdentity, sourceReachable: sourceForMigration,
    targetChat, carriedSummary: { sourceFloorId, sourceMemoryId: sourceSavedMemory.id, targetMessageIndex: 1 },
    now: () => new Date(NOW), newUuid: uuidFactory() });
  const liveFloor = migrated.reachable.floors.at(-1), liveMemory = migrated.reachable.floorMemories.find(item => item.floorId === liveFloor.id);
  assert.equal(liveFloor.hostLocator.messageIndex, 1, '活动副本只绑定B真实消息位置');
  assert.equal(migrated.reachable.migrationDescriptor.frozenFloorIds.includes(liveFloor.id), false);
  assert.equal(liveMemory.summary.aiText, sourceSavedMemory.summary.aiText);
  assert.equal(liveMemory.locations[0].name, '东馆', '已保存空间结构随单楼摘要保留');
  assert.equal(liveMemory.locations[0].evidenceRefs[0].floorId, liveFloor.id, '活动摘要证据指向B真实楼');
  assert.equal(migrated.reachable.stateDeltas.some(item => item.floorId === liveFloor.id), false, '缺少的CSE保持待分析');
  assert.deepEqual(migrated.descriptor.summarySources, [{ targetFloorId: liveFloor.id, sourceFloorId, sourceChatId: SOURCE,
    rawFingerprint: liveFloor.content.rawFingerprint }]);
  assert.deepEqual(migrated.descriptor.sourceFloorProvenance, [{ floorId: sourceFloorId, timeEdited: true, storyClockSignature: 'frozen-source-clock' }]);
  assert.deepEqual(migrated.reachable.floorMemories.find(item => item.floorId === sourceFloorId).summary, sourceSavedMemory.summary,
    '冻结来源摘要保持原值');

  const targetContext = context(targetIdentity.hostChatId, bId, targetChat);
  const targetHost = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => targetContext } } });
  const targetFoundation = createFoundationRuntime({ hostAdapter: targetHost, store: targetStore, contextProvider: () => targetContext,
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  let cseCalls = 0, extractorCalls = 0;
  const targetMemory = createV3MemoryRuntime({ foundationRuntime: targetFoundation, store: targetStore, hostAdapter: targetHost,
    generateAnalysisTask: async () => { cseCalls += 1; return { jsonData: { noMaterialChange: true } }; },
    generateUtilityTask: async options => { if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) extractorCalls += 1; return { jsonData: { noMaterialChange: true } }; },
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  await targetMemory.start();
  assert.equal(targetMemory.getState().floors.find(floor => floor.floorId === liveFloor.id)?.inherited, true,
    '正式memory runtime将B携带摘要识别为继承内容，供楼内UI只读展示');
  assert.equal(targetMemory.getState().unprocessedCount, 0, '复用的摘要不再进入Extractor队列');
  assert.ok(targetMemory.getState().csePendingCount >= 1, '缺项进入既有CSE待分析状态');
  assert.equal(cseCalls + extractorCalls, 0, '准备/打开B不会提前调用模型');
  targetChat.push(user('搬家后继续对话'));
  await targetMemory.refreshStatus();
  await targetMemory.analyzeNextState();
  assert.equal(extractorCalls, 0, 'USER→AI尾部已复用的摘要不重提');
  assert.equal(cseCalls, 1, '后续B楼到达后只完成一次缺失CSE');
});

test('CHAT_CHANGED 初始化同角色副本时只继承实际前缀，保留摘要/CSE/最新版人物且后续新楼可续写', async () => {
  const backend = backendHarness();
  let activeContext = context('原聊天', SOURCE, [
    user('开始'),
    assistant('公共 A'), user('继续 A'),
    assistant('公共 B'), user('继续 B'),
    assistant('旧线 C'), user('继续 C'),
    assistant('旧线 pending'),
  ]);
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => activeContext } } });
  const sourceSession = createChatSession({
    contextProvider: () => activeContext,
    identityCoordinator: createChatIdentityCoordinator({ client: backend.client, now: () => new Date(NOW) }),
  });
  assert.equal((await sourceSession.prepare()).identity.chatId, SOURCE);
  const sourceStore = createFoundationStore({ client: backend.client, contextProvider: () => identity('原聊天', SOURCE) });
  const sourceFoundation = createFoundationRuntime({ hostAdapter, store: sourceStore, contextProvider: () => activeContext, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  let apiCalls = 0;
  let cseCalls = 0;
  const generateUtilityTask = async options => {
    apiCalls += 1;
    if (options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT) {
      const content = JSON.parse(options.taskMessages[0].content).payload.canonicalContent;
      return { jsonData: { summary: `摘要-${content}`, people: [{ name: '裴晚生', presence: 'present' }] }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'mock' } };
    }
    cseCalls += 1;
    const { trackedSubjects } = JSON.parse(options.taskMessages[0].content).payload;
    return { jsonData: { subjects: trackedSubjects.map(({ name }) => ({ subject: name, situational: [{ text: `源状态-${cseCalls}`, visibility: 'observable', reason: `第${cseCalls}楼正文` }] })) }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'mock' } };
  };
  const sourceMemory = createV3MemoryRuntime({
    foundationRuntime: sourceFoundation, store: sourceStore, hostAdapter, generateAnalysisTask: generateUtilityTask, generateUtilityTask,
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} },
  });
  await sourceMemory.start();
  await sourceMemory.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(sourceMemory.getState().rebuildStatus) && !sourceMemory.getState().activeAutoMemory, '源聊天记忆未追平');

  const sourceReachable = await sourceStore.readReachable();
  assert.equal(sourceReachable.currentStates[0].subjects.find(subject => subject.subjectEntityId === sourceReachable.baseline.characterCard.entityId).situational[0].text, '源状态-3');
  const firstMemory = sourceReachable.floorMemories[0];
  const firstMemoryKey = `chat-${SOURCE}/v3-floor-memory-${firstMemory.id}`;
  backend.records.get(firstMemoryKey).data.summary = { ...backend.records.get(firstMemoryKey).data.summary, userText: '人工确认的公共 A', effectiveSource: 'user', revisionNote: '分支前修订' };
  const charEntity = sourceReachable.entities.find(entity => entity.id === sourceReachable.baseline.characterCard.entityId);
  const suffixOnlyEntityId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const peopleStore = createPeopleWorkspaceStore({ client: backend.client });
  await peopleStore.put(identity('原聊天', SOURCE), {
    schemaVersion: 3, kind: 'qqj-v3-people-workspace', chatId: SOURCE,
    selectedEntityIds: [charEntity.id, suffixOnlyEntityId], personOrderEntityIds: [charEntity.id, suffixOnlyEntityId],
    profilesByEntityId: {
      [charEntity.id]: { entityId: charEntity.id, name: '裴晚生最新版', manualFields: ['name'], source: 'manual', createdAt: NOW, updatedAt: NOW },
      [suffixOnlyEntityId]: { entityId: suffixOnlyEntityId, name: '后缀独有人物', manualFields: ['name'], source: 'manual', createdAt: NOW, updatedAt: NOW },
    },
    avatarsByEntityId: {}, identityRedirectsByEntityId: {}, deletedEntityIds: [],
    profileMaterialProgressByEntityId: { [charEntity.id]: { processedHistoryCount: 3, materialSignature: 'people-material-v1:3:0123456789abcdef', contextSignature: 'people-material-v1:3:fedcba9876543210', updatedAt: NOW } },
    createdAt: NOW, updatedAt: NOW,
  }, 0);

  const sourceBefore = chatRecords(backend.records, SOURCE);
  const callsBeforeClone = apiCalls;

  activeContext = context('复制聊天', SOURCE, [
    user('开始'),
    assistant('公共 A'), user('继续 A'),
    assistant('公共 B'),
  ]);
  activeContext.chat[1].is_system = true;
  activeContext.chat[1].extra = { kept: true, qianqianjieAutoHide: { schemaVersion: 1, chatId: SOURCE } };
  activeContext.chat[1].swipe_info = [{ extra: { swipeKept: true, qianqianjieAutoHide: { schemaVersion: 1, chatId: SOURCE } } }];
  let normalWriteAttempts = 0;
  let normalWritesInFlight = 0;
  let maxNormalWritesInFlight = 0;
  let failFirstNormalWrite = true;
  let releaseFirstBatch;
  const firstBatchReleased = new Promise(resolve => { releaseFirstBatch = resolve; });
  let fourNormalWritesStarted;
  const firstFourStarted = new Promise(resolve => { fourNormalWritesStarted = resolve; });
  let firstFailureReached;
  const firstFailure = new Promise(resolve => { firstFailureReached = resolve; });
  let releaseCheckpoint;
  const checkpointReleased = new Promise(resolve => { releaseCheckpoint = resolve; });
  let checkpointWritesStarted = 0;
  let rootWritesStarted = 0;
  let peopleWritesStarted = 0;
  let saveChatCalls = 0;
  let readbackCalls = 0;
  activeContext.saveChat = async () => { saveChatCalls += 1; return true; };
  const branchClient = {
    async get(collection, key) { return backend.client.get(collection, key); },
    async put(collection, key, data, expectedRevision) {
      const targetCollection = collection.startsWith('chat-') && collection !== `chat-${SOURCE}`;
      const normalRecord = targetCollection && key.startsWith('v3-')
        && key !== 'v3-root' && key !== 'v3-people-workspace' && !key.startsWith('v3-checkpoint-');
      if (normalRecord) {
        const attempt = ++normalWriteAttempts;
        normalWritesInFlight += 1;
        maxNormalWritesInFlight = Math.max(maxNormalWritesInFlight, normalWritesInFlight);
        if (attempt === 4) fourNormalWritesStarted();
        try {
          if (failFirstNormalWrite && attempt === 1) {
            await firstFourStarted;
            firstFailureReached();
            throw Object.assign(new Error('测试：分支普通记录写入失败'), { status: 503, code: 'TEST_BRANCH_RECORD_FAILURE' });
          }
          if (failFirstNormalWrite && attempt <= 4) await firstBatchReleased;
          await new Promise(resolve => setTimeout(resolve, 5));
          return await backend.client.put(collection, key, data, expectedRevision);
        } finally {
          normalWritesInFlight -= 1;
        }
      }
      if (targetCollection && key.startsWith('v3-checkpoint-')) {
        checkpointWritesStarted += 1;
        await checkpointReleased;
      } else if (targetCollection && key === 'v3-root') {
        rootWritesStarted += 1;
      } else if (targetCollection && key === 'v3-people-workspace') {
        peopleWritesStarted += 1;
      }
      return backend.client.put(collection, key, data, expectedRevision);
    },
  };
  let branchReadbackAvailable = false;
  const initializeBranch = createChatBranchInitializer({
    client: branchClient,
    hostAdapter,
    now: () => new Date(NOW),
    fetchImpl: async () => ({ ok: true, async json() {
      readbackCalls += 1;
      return branchReadbackAvailable
        ? [{ chat_metadata: structuredClone(activeContext.chatMetadata) }, ...structuredClone(activeContext.chat)]
        : [{ chat_metadata: structuredClone(activeContext.chatMetadata) }, ...activeContext.chat.map(message => ({ ...structuredClone(message), extra: {} }))];
    } }),
  });
  const cloneSession = createChatSession({
    contextProvider: () => activeContext,
    identityCoordinator: createChatIdentityCoordinator({
      client: branchClient,
      listHostChats: async () => ['原聊天', '复制聊天'],
      initializeBranch,
      now: () => new Date(NOW),
    }),
  });
  const lifecycle = createPluginLifecycle({ session: cloneSession, getUi: () => null, logger: { warn() {} } });
  lifecycle.onChatChanged();
  await firstFailure;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(normalWriteAttempts, 4, '首个错误出现后不得继续分配普通记录');
  assert.equal(normalWritesInFlight, 3, '首个错误出现时其余三个在途写入仍受控等待');
  assert.notEqual(cloneSession.getState().status, 'error', '普通记录池必须等待已在途写入结束后才返回错误');
  assert.equal(checkpointWritesStarted, 0, '普通记录失败时不得写 checkpoint');
  assert.equal(rootWritesStarted, 0, '普通记录失败时不得提交 root');
  assert.equal(peopleWritesStarted, 0, '普通记录失败时不得复制人物工作区');
  assert.equal(saveChatCalls, 0, '普通记录失败时不得保存聊天消息');
  assert.equal(readbackCalls, 0, '普通记录失败时不得读回聊天消息');
  failFirstNormalWrite = false;
  releaseFirstBatch();
  await waitFor(() => cloneSession.getState().status === 'error', 'CHAT_CHANGED 的首次分支初始化失败未被 session 接住');
  assert.equal(cloneSession.getState().error?.code, 'TEST_BRANCH_RECORD_FAILURE');
  assert.equal(normalWritesInFlight, 0, '分支普通记录失败返回前必须等全部在途写入结束');
  const preparingBindings = [...backend.records.values()].filter(row => row.data?.state === 'preparing' && row.data?.sourceChatId === SOURCE);
  assert.equal(preparingBindings.length, 1);
  const preparedTargetId = preparingBindings[0].data.chatId;
  assert.equal(backend.records.has(`chat-${preparedTargetId}/v3-root`), false, '普通记录失败不得暴露未完成的目标图');
  assert.equal(activeContext.chatMetadata.qianqianjie.chatId, SOURCE);
  lifecycle.onChatChanged();
  await waitFor(() => checkpointWritesStarted === 1, '重入没有在普通记录完成后进入 checkpoint 写入');
  assert.equal(normalWritesInFlight, 0, 'checkpoint 开始前普通记录必须全部完成');
  assert.equal(rootWritesStarted, 0, 'checkpoint 完成前不得提交 root');
  assert.equal(peopleWritesStarted, 0, 'checkpoint 完成前不得复制人物工作区');
  assert.equal(saveChatCalls, 0, 'checkpoint 完成前不得保存聊天消息');
  assert.equal(readbackCalls, 0, 'checkpoint 完成前不得读回聊天消息');
  assert.notEqual(cloneSession.getState().status, 'ready', 'checkpoint 完成前 binding 不得进入 ready');
  releaseCheckpoint();
  await waitFor(() => cloneSession.getState().status === 'error', '消息读回失败未被 session 接住');
  assert.equal(cloneSession.getState().error?.code, 'V3_BRANCH_MESSAGE_VERIFY_FAILED');
  assert.equal(activeContext.chat[1].extra.qianqianjieAutoHide.chatId, SOURCE, '消息读回失败必须回滚外层自动隐藏标记');
  assert.equal(activeContext.chat[1].swipe_info[0].extra.qianqianjieAutoHide.chatId, SOURCE, '消息读回失败必须回滚 swipe 自动隐藏标记');
  assert.equal(rootWritesStarted, 1);
  assert.equal(peopleWritesStarted, 1);
  assert.equal(saveChatCalls, 1);
  assert.equal(readbackCalls, 1);
  assert.equal((await createFoundationStore({ client: backend.client, contextProvider: () => identity('复制聊天', preparedTargetId) }).readReachable()).status, 'ready', '消息保存失败前目标图已经按相同确定性 ID 就绪');
  branchReadbackAvailable = true;
  lifecycle.onChatChanged();
  await waitFor(() => cloneSession.getState().status === 'ready', 'CHAT_CHANGED 重入未完成分支初始化');
  const prepared = cloneSession.getState();
  const targetChatId = prepared.identity.chatId;
  assert.equal(prepared.status, 'ready');
  assert.notEqual(targetChatId, SOURCE);
  assert.equal(targetChatId, preparedTargetId, '初始化失败重入不得产生第二个目标 ID');
  assert.ok(maxNormalWritesInFlight > 1, '普通 backing records 必须实际重叠写入');
  assert.ok(maxNormalWritesInFlight <= 4, '普通 backing records 同时最多写入 4 条');
  assert.equal(apiCalls, callsBeforeClone, '分支复制阶段不得调用 Extractor/CSE');
  assert.equal(chatRecords(backend.records, SOURCE), sourceBefore, '源聊天全部记录必须不变');
  const targetBinding = backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${targetChatId}`).data;
  assert.equal(targetBinding.state, 'ready');
  assert.equal(targetBinding.sourceChatId, SOURCE);

  const targetStore = createFoundationStore({ client: backend.client, contextProvider: () => identity('复制聊天', targetChatId) });
  const inherited = await targetStore.readReachable();
  assert.equal(inherited.status, 'ready');
  assert.deepEqual(inherited.floorMemories.map(item => item.summary.effectiveSource === 'user' ? item.summary.userText : item.summary.aiText), ['人工确认的公共 A', '摘要-公共 B']);
  assert.equal(inherited.floors.length, 2);
  assert.equal(inherited.floorMemories.some(item => item.summary.aiText === '摘要-旧线 C'), false, '源后缀摘要不得进入目标');
  const replayed = await replayCurrentState({ chatId: targetChatId, narrativeGeneration: inherited.root.narrativeGeneration, baselineId: inherited.baseline.id, floors: inherited.floors, floorMemories: inherited.floorMemories, stateDeltas: inherited.stateDeltas, now: NOW });
  assert.deepEqual(inherited.currentStates[0].subjects, replayed.subjects);
  assert.deepEqual(inherited.currentStates[0].appliedDeltaIds, replayed.appliedDeltaIds);
  assert.equal(inherited.currentStates[0].subjects.find(subject => subject.subjectEntityId === inherited.baseline.characterCard.entityId).situational[0].text, '源状态-2', '目标状态必须停在分叉截点，不能携带源后缀状态');
  const inheritedPeople = await peopleStore.read(identity('复制聊天', targetChatId));
  assert.equal(inheritedPeople.data.profilesByEntityId[charEntity.id].name, '裴晚生最新版');
  assert.deepEqual(inheritedPeople.data.profilesByEntityId[charEntity.id].manualFields, ['name']);
  assert.equal(inheritedPeople.data.profilesByEntityId[suffixOnlyEntityId], undefined);
  assert.deepEqual(inheritedPeople.data.profileMaterialProgressByEntityId, {});
  assert.equal(activeContext.chat.filter(message => message.is_user === false).every(message => !message.extra?.qqj_v3_recall_receipt), true);
  assert.equal(activeContext.chat[1].extra.qianqianjie_floor.chatId, targetChatId);
  assert.equal(activeContext.chat[1].extra.qianqianjieAutoHide.chatId, targetChatId);
  assert.equal(activeContext.chat[1].swipe_info[0].extra.qianqianjieAutoHide.chatId, targetChatId);
  assert.equal(activeContext.chat[3].extra.qianqianjie_floor.chatId, targetChatId);
  activeContext.chat.push(user('继续 B'), assistant('新线 X'), user('继续 X'), assistant('新线 pending'));
  const targetFoundation = createFoundationRuntime({ hostAdapter, store: targetStore, contextProvider: () => activeContext, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  const targetMemory = createV3MemoryRuntime({
    foundationRuntime: targetFoundation, store: targetStore, hostAdapter, generateAnalysisTask: generateUtilityTask, generateUtilityTask,
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} },
  });
  await targetMemory.start();
  assert.equal(targetMemory.getState().rebuildStatus, 'pendingRebuild');
  assert.equal(apiCalls, callsBeforeClone, '仅检测到目标新楼未处理不得在复制阶段调模型');
  await targetMemory.startHistoricalRebuild();
  await waitFor(() => ['caughtUp', 'waitingRealtime'].includes(targetMemory.getState().rebuildStatus) && !targetMemory.getState().activeAutoMemory, '复制分支手动重建未追平');
  const target = await targetStore.readReachable();
  assert.deepEqual(target.floorMemories.map(item => item.summary.effectiveSource === 'user' ? item.summary.userText : item.summary.aiText), ['人工确认的公共 A', '摘要-公共 B', '摘要-新线 X']);
  assert.equal(chatRecords(backend.records, SOURCE), sourceBefore, '分支自行重建也不得改源数据');
  backend.records.delete(firstMemoryKey);
  backend.records.get(`chat-${SOURCE}/v3-people-workspace`).data.profilesByEntityId[charEntity.id].name = '源档后来修改';
  const detachedTarget = await targetStore.readReachable();
  const detachedPeople = await peopleStore.read(identity('复制聊天', targetChatId));
  assert.equal(detachedTarget.floorMemories[0].summary.userText, '人工确认的公共 A', '源档后续删除不能影响目标摘要');
  assert.equal(detachedPeople.data.profilesByEntityId[charEntity.id].name, '裴晚生最新版', '源档后续修改不能影响目标人物资料');
});

test('分支半成品无 root 且精确 marker 前缀已编辑时改用新目标完整继承', async () => {
  const backend = backendHarness();
  let activeContext = context('原聊天', SOURCE, [assistant('公共 A'), user('继续 A'), assistant('公共 B'), user('继续 B')]);
  backend.records.set(`${CHAT_IDENTITY_COLLECTION}/binding-${SOURCE}`, {
    revision: 1,
    data: { schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: SOURCE,
      owner: { hostChatId: '原聊天', characterLocator: 'character.png', personaLocator: 'persona.png' },
      state: 'ready', sourceChatId: null, createdAt: NOW, updatedAt: NOW },
  });
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => activeContext } } });
  const sourceStore = createFoundationStore({ client: backend.client, contextProvider: () => identity('原聊天', SOURCE) });
  const sourceRuntime = createFoundationRuntime({ hostAdapter, store: sourceStore, contextProvider: () => activeContext,
    now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } });
  await sourceRuntime.start();
  const source = await sourceStore.readReachable();
  assert.equal(source.floors.length, 2);
  const sourceBefore = chatRecords(backend.records, SOURCE);

  activeContext = context('复制聊天', SOURCE, [assistant('公共 A'), user('继续 A'), assistant('公共 B'), user('继续 B')]);
  for (let index = 0; index < 2; index += 1) {
    activeContext.chat[index * 2].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: SOURCE, floorId: source.floors[index].id } };
  }
  let targetFloorPuts = 0;
  let failPartial = true;
  const branchClient = {
    async get(collection, key) { return backend.client.get(collection, key); },
    async put(collection, key, data, expectedRevision) {
      if (failPartial && collection !== `chat-${SOURCE}` && key.startsWith('v3-floor-')) {
        targetFloorPuts += 1;
        if (targetFloorPuts === 2) throw Object.assign(new Error('测试：留下无 root 的分支半成品'), { status: 503 });
      }
      return backend.client.put(collection, key, data, expectedRevision);
    },
  };
  const initializeBranch = createChatBranchInitializer({
    client: branchClient, hostAdapter, now: () => new Date(NOW),
    fetchImpl: async () => ({ ok: true, async json() { return [{ chat_metadata: structuredClone(activeContext.chatMetadata) }, ...structuredClone(activeContext.chat)]; } }),
  });
  const freshTarget = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const coordinator = createChatIdentityCoordinator({
    client: branchClient,
    listHostChats: async () => ['原聊天', '复制聊天'],
    initializeBranch,
    freshUuid: () => freshTarget,
    now: () => new Date(NOW),
  });
  const session = createChatSession({ contextProvider: () => activeContext, identityCoordinator: coordinator });
  await assert.rejects(session.prepare(), error => error?.status === 503);
  const oldBinding = [...backend.records.values()].find(row => row.data?.state === 'preparing'
    && row.data?.sourceChatId === SOURCE && row.data?.owner?.hostChatId === '复制聊天');
  assert.ok(oldBinding);
  const oldTarget = oldBinding.data.chatId;
  assert.equal(backend.records.has(`chat-${oldTarget}/v3-root`), false);
  const oldFloors = new Map([...backend.records.entries()].filter(([key]) => key.startsWith(`chat-${oldTarget}/v3-floor-`))
    .map(([key, value]) => [key, structuredClone(value)]));
  assert.ok(oldFloors.size >= 1, '首次失败必须真实留下至少一个 floor 半成品');

  activeContext.chat[0].mes = activeContext.chat[0].swipes[0] = '公共 A（分支内人工编辑）';
  failPartial = false;
  session.invalidate();
  const recovered = await session.prepare();
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.identity.chatId, freshTarget);
  assert.notEqual(freshTarget, oldTarget);
  assert.notEqual(freshTarget, SOURCE);
  assert.equal(activeContext.chatMetadata.qianqianjie.chatId, freshTarget);
  assert.equal(backend.records.has(`chat-${oldTarget}/v3-root`), false, '旧半成品不得补 root 或被当作源');
  for (const [key, value] of oldFloors) assert.deepEqual(backend.records.get(key), value, '旧目标已写 floor 不得覆盖');
  assert.equal((await createFoundationStore({ client: backend.client, contextProvider: () => identity('复制聊天', freshTarget) }).readReachable()).status, 'ready');
  assert.equal(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${freshTarget}`).data.sourceChatId, SOURCE);
  assert.equal(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${freshTarget}`).data.state, 'ready');
  assert.equal(chatRecords(backend.records, SOURCE), sourceBefore, '恢复不得修改源聊天记录');
});

test('直接打开 preparing 分支也沿原 source 换新目标，root存在或非目标错误不回退', async () => {
  const freshTarget = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const owner = { hostChatId: '复制聊天', characterLocator: 'character.png', personaLocator: 'persona.png' };
  const oldTarget = await deterministicUuid(['qqj-chat-independent-v2', SOURCE, owner.hostChatId, owner.characterLocator]);
  const preparing = {
    schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: oldTarget, owner,
    state: 'preparing', sourceChatId: SOURCE, createdAt: NOW, updatedAt: NOW,
  };
  const run = async ({ root = false, rootReadFailure = null, errorCode = 'V3_BRANCH_RECORD_CONFLICT', abort = false } = {}) => {
    const backend = backendHarness();
    backend.records.set(`${CHAT_IDENTITY_COLLECTION}/binding-${oldTarget}`, { revision: 1, data: structuredClone(preparing) });
    if (root) backend.records.set(`chat-${oldTarget}/v3-root`, { revision: 1, data: { occupied: true } });
    const calls = [];
    const client = rootReadFailure ? {
      async get(collection, key) {
        if (collection === `chat-${oldTarget}` && key === 'v3-root') throw Object.assign(new Error('root read failed'), { status: rootReadFailure });
        return backend.client.get(collection, key);
      },
      async put(...args) { return backend.client.put(...args); },
    } : backend.client;
    const activeContext = context(owner.hostChatId, oldTarget, []);
    const initializeBranch = async ({ sourceChatId, targetChatId }) => {
      calls.push({ sourceChatId, targetChatId });
      if (targetChatId === oldTarget) {
        if (abort) throw new DOMException('Aborted', 'AbortError');
        throw Object.assign(new Error('controlled branch failure'), { code: errorCode });
      }
    };
    const session = createChatSession({
      contextProvider: () => activeContext,
      identityCoordinator: createChatIdentityCoordinator({ client, initializeBranch, freshUuid: () => freshTarget, now: () => new Date(NOW) }),
    });
    return { backend, calls, activeContext, session };
  };

  const recovered = await run();
  const ready = await recovered.session.prepare();
  assert.equal(ready.identity.chatId, freshTarget);
  assert.deepEqual(recovered.calls, [
    { sourceChatId: SOURCE, targetChatId: oldTarget },
    { sourceChatId: SOURCE, targetChatId: freshTarget },
  ], '新目标必须继续从原source继承，不能把半成品旧target当source');
  assert.equal(recovered.activeContext.chatMetadata.qianqianjie.chatId, freshTarget);

  for (const options of [{ root: true }, { rootReadFailure: 503 }, { errorCode: 'V3_BRANCH_FLOOR_MATCH_INVALID' }, { abort: true }]) {
    const rejected = await run(options);
    await assert.rejects(rejected.session.prepare(), error => options.abort ? error?.name === 'AbortError'
      : error?.code === options.errorCode || error?.code === 'V3_BRANCH_RECORD_CONFLICT');
    assert.deepEqual(rejected.calls, [{ sourceChatId: SOURCE, targetChatId: oldTarget }]);
    assert.equal(rejected.backend.records.has(`${CHAT_IDENTITY_COLLECTION}/binding-${freshTarget}`), false, JSON.stringify(options));
    assert.equal(rejected.activeContext.chatMetadata.qianqianjie.chatId, oldTarget, JSON.stringify(options));
  }
});

test('源 root 不存在时仍清理副本携带的旧 marker/receipt，并以同一独立身份幂等打开', async () => {
  const backend = backendHarness();
  backend.records.set(`${CHAT_IDENTITY_COLLECTION}/binding-${SOURCE}`, {
    revision: 1,
    data: { schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: SOURCE,
      owner: { hostChatId: '空源原聊天', characterLocator: 'character.png', personaLocator: 'persona.png' },
      state: 'ready', sourceChatId: null, createdAt: NOW, updatedAt: NOW },
  });
  const oldFloorId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const copied = assistant('尚无后端记忆的旧消息');
  copied.extra = { kept: true, qianqianjie_floor: { schemaVersion: 1, chatId: SOURCE, floorId: oldFloorId }, qqj_v3_recall_receipt: { old: true } };
  copied.swipe_info = [{ extra: { keptSwipe: true, qianqianjie_floor: { schemaVersion: 1, chatId: SOURCE, floorId: oldFloorId }, qqj_v3_recall_receipt: { old: true } } }];
  const activeContext = context('空源副本', SOURCE, [copied]);
  const hostAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => activeContext } } });
  const initializer = createChatBranchInitializer({
    client: backend.client, hostAdapter, now: () => new Date(NOW),
    fetchImpl: async () => ({ ok: true, async json() { return [{ chat_metadata: structuredClone(activeContext.chatMetadata) }, ...structuredClone(activeContext.chat)]; } }),
  });
  const coordinator = createChatIdentityCoordinator({ client: backend.client, listHostChats: async () => ['空源原聊天', '空源副本'], initializeBranch: initializer, now: () => new Date(NOW) });
  const session = createChatSession({ contextProvider: () => activeContext, identityCoordinator: coordinator });
  const first = await session.prepare();
  assert.equal(first.status, 'ready');
  assert.notEqual(first.identity.chatId, SOURCE);
  assert.deepEqual(copied.extra, { kept: true });
  assert.deepEqual(copied.swipe_info[0].extra, { keptSwipe: true });
  assert.equal(backend.records.has(`chat-${first.identity.chatId}/v3-root`), false);
  session.invalidate();
  assert.equal((await session.prepare()).identity.chatId, first.identity.chatId);
});

test('无 binding 的旧 root 不再猜原分支：相同正文的两宿主按任何顺序打开都各领稳定新 ID', async () => {
  const openInOrder = async order => {
    const backend = backendHarness();
    const body = [user('开始'), assistant('公共 A'), user('继续 A'), assistant('公共 B'), user('继续 B'), assistant('pending')];
    const legacyHost = context('旧 root 建造宿主', SOURCE, body);
    const sourceAdapter = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => legacyHost } } });
    const sourceStore = createFoundationStore({ client: backend.client, contextProvider: () => identity('旧 root 建造宿主', SOURCE) });
    await createFoundationRuntime({ hostAdapter: sourceAdapter, store: sourceStore, contextProvider: () => legacyHost, now: () => new Date(NOW), newUuid: uuidFactory(), logger: { warn() {} } }).start();
    const legacyBefore = chatRecords(backend.records, SOURCE);
    const hosts = {
      source: context('原聊天', SOURCE, body),
      clone: context('复制聊天', SOURCE, body),
    };
    const ids = {};
    for (const name of order) {
      const session = createChatSession({
        contextProvider: () => hosts[name],
        identityCoordinator: createChatIdentityCoordinator({ client: backend.client, now: () => new Date(NOW) }),
      });
      ids[name] = (await session.prepare()).identity.chatId;
    }
    assert.notEqual(ids.source, SOURCE);
    assert.notEqual(ids.clone, SOURCE);
    assert.notEqual(ids.source, ids.clone);
    assert.equal(backend.records.has(`${CHAT_IDENTITY_COLLECTION}/binding-${SOURCE}`), false, '旧 ID 不得被任何宿主认领');
    assert.equal(backend.records.has(`chat-${ids.source}/v3-root`), false, '原聊天新身份不得继承 root');
    assert.equal(backend.records.has(`chat-${ids.clone}/v3-root`), false, '复制分支新身份不得继承 root');
    assert.equal(chatRecords(backend.records, SOURCE), legacyBefore, '旧 root 与其可达记录必须逐字不变');
    return ids;
  };
  const cloneFirst = await openInOrder(['clone', 'source']);
  const sourceFirst = await openInOrder(['source', 'clone']);
  assert.deepEqual(sourceFirst, cloneFirst, '独立 ID 只由宿主身份决定，不得受打开顺序影响');
});

test('复制到不同角色卡也只建独立身份，不读旧卡记忆', async () => {
  const backend = backendHarness();
  const source = context('原角色聊天', SOURCE, [], 'old-character.png');
  await createChatSession({
    contextProvider: () => source,
    identityCoordinator: createChatIdentityCoordinator({ client: backend.client, now: () => new Date(NOW) }),
  }).prepare();
  const clone = context('新角色复制', SOURCE, [], 'new-character.png');
  const guardedClient = {
    async get(collection, key) {
      assert.notEqual(collection, `chat-${SOURCE}`, '不得读旧角色记忆');
      return backend.client.get(collection, key);
    },
    async put(collection, key, data, expectedRevision) { return backend.client.put(collection, key, data, expectedRevision); },
  };
  const result = await createChatSession({
    contextProvider: () => clone,
    identityCoordinator: createChatIdentityCoordinator({
      client: guardedClient,
      listHostChats: async () => { assert.fail('跨角色复制不得读取原角色聊天列表'); },
      now: () => new Date(NOW),
    }),
  }).prepare();
  assert.notEqual(result.identity.chatId, SOURCE);
  assert.equal(backend.records.get(`${CHAT_IDENTITY_COLLECTION}/binding-${result.identity.chatId}`).data.owner.characterLocator, 'new-character.png');
  assert.equal(backend.records.has(`chat-${result.identity.chatId}/v3-root`), false);
});
