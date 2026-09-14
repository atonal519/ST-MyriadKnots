import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { createChatBranchInitializer } from '../src/v3/chat-branch-inheritance.js';
import { createPeopleWorkspaceStore } from '../src/v3/people-workspace.js';
import { replayCurrentState } from '../src/v3/cse-engine.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import { createChatIdentityCoordinator, CHAT_IDENTITY_COLLECTION } from '../src/chat-identity.js';
import { createChatSession } from '../src/chat-session.js';
import { createPluginLifecycle } from '../src/plugin-lifecycle.js';

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
    return { jsonData: { subjects: [{ subject: '裴晚生', situational: [{ text: `源状态-${cseCalls}`, visibility: 'observable', reason: `第${cseCalls}楼正文` }] }] }, taskMetadata: { source: 'test', sourceLabel: '测试', model: 'mock' } };
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
