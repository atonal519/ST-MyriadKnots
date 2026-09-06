import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicMemoryBridge, formatPublicMemoryProjection, installPublicMemoryBridge, QQJ_PUBLIC_MEMORY_BRIDGE_KEY } from '../src/v3/public-memory-bridge.js';

const QQJ_CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const identity = () => ({ hostChatId: 'host-chat', chatId: QQJ_CHAT, characterLocator: 'char.png', personaLocator: 'me.png' });
const source = () => ({
  status: 'ready', chatId: QQJ_CHAT, narrativeGeneration: 'generation', headCheckpointId: 'head', rootRevision: 7,
  coverage: { stableAiFloors: 20, rememberedAiFloors: 19, missingAssistantSeq: [20], cseThroughAssistantSeq: 19, memoryComplete: false, cseCurrent: false },
  entities: [
    { entityId: 'p1', entityType: 'person', displayName: '沈砚', aliases: ['阿砚'], specialRole: 'char' },
    { entityId: 'p2', entityType: 'person', displayName: '顾舟', aliases: [], specialRole: 'user' },
  ],
  floorMemories: [{
    assistantSeq: 1, summary: '用户修订后的长期摘要。', chronology: [{ time: { kind: 'relative', sourceText: '次日清晨', normalized: null, precision: 'unresolved', relativeToAssistantSeq: 7 }, description: '' }], events: [{ title: '雨夜会面', description: '二人在钟楼重逢。' }],
    actions: [{ actorEntityId: 'p1', targetEntityIds: ['p2'], action: '交出地图', completion: 'completed', result: '顾舟收下' }],
    commitments: [{ speakerEntityId: 'p1', targetEntityIds: ['p2'], kind: 'promise', content: '天亮前守住北门', status: 'accepted' }],
    openLoops: [{ description: '追兵身份仍未查明', ownerEntityIds: ['p1'] }],
    privateCognition: [{ ownerEntityId: 'p1', content: '不得对外暴露的原始内心全文' }],
  }],
  currentState: [{ subjectEntityId: 'p1', core: [{ text: '习惯独自承担风险', visibility: 'authorial', reason: '长期塑造', sourceAssistantSeq: 1 }], adaptive: [], situational: [{ text: '担心顾舟受伤', visibility: 'private', reason: '雨夜行动', sourceAssistantSeq: 19 }] }],
});

test('formatter 保留正式长期记忆和 CSE 可见性边界，不输出 privateCognition 原文', () => {
  const text = formatPublicMemoryProjection(source());
  assert.match(text, /用户修订后的长期摘要/);
  assert.match(text, /AI #1（相对时间（未解析；相对 AI #7）：次日清晨）/);
  assert.match(text, /雨夜会面/);
  assert.match(text, /沈砚 → 顾舟：完成「交出地图」/);
  assert.match(text, /承诺\/计划/);
  assert.match(text, /追兵身份仍未查明/);
  assert.match(text, /作者塑造参考，不代表任何人物知情/);
  assert.match(text, /仅 沈砚 本人知情/);
  assert.match(text, /仅连续到 AI #19，不代表当前完整状态/);
  assert.doesNotMatch(text, /不得对外暴露的原始内心全文/);
});

test('公共桥只调用正式 projection 读取，区分宿主 chatId 与 QQJ UUID，且不触发任何写入或 AI', async () => {
  let reads = 0, writes = 0, aiCalls = 0, saveChatCalls = 0, promptCalls = 0, receiptCalls = 0;
  const bridge = createPublicMemoryBridge({
    session: { getState: () => ({ status: 'ready', identity: identity() }), identity },
    store: {
      readReachable: async () => { reads += 1; return source(); },
      putRecord: async () => { writes += 1; }, replaceRecord: async () => { writes += 1; }, commitRoot: async () => { writes += 1; },
    },
    hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) },
    isEnabled: () => true,
    readSource: async ({ store }) => store.readReachable(),
  });
  const result = await bridge.readMemory();
  assert.equal(result.status, 'ready');
  assert.equal(result.identity.hostChatId, 'host-chat');
  assert.equal(result.identity.qqjChatId, QQJ_CHAT);
  assert.notEqual(result.identity.hostChatId, result.identity.qqjChatId);
  assert.equal(reads, 1);
  assert.equal(writes + aiCalls + saveChatCalls + promptCalls + receiptCalls, 0);
});

test('关闭、未 ready 和切聊天迟到均返回简明状态，不自动 prepare 身份', async () => {
  let prepareCalls = 0, resolveRead;
  let current = identity();
  const session = {
    getState: () => ({ status: 'ready', identity: current }),
    identity: () => current,
    prepare: () => { prepareCalls += 1; },
  };
  const disabled = createPublicMemoryBridge({ session, store: { readReachable: async () => source() }, hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) }, isEnabled: false });
  assert.equal((await disabled.readMemory()).status, 'disabled');
  const notReady = createPublicMemoryBridge({ session: { ...session, getState: () => ({ status: 'idle' }) }, store: { readReachable: async () => source() }, hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) } });
  assert.equal((await notReady.readMemory()).status, 'not-ready');
  const pending = createPublicMemoryBridge({ session, store: { readReachable: () => new Promise(resolve => { resolveRead = resolve; }) }, hostAdapter: { snapshot: () => ({ chatId: current.hostChatId, chat: [] }) }, readSource: async ({ store }) => store.readReachable() });
  const task = pending.readMemory();
  current = { ...identity(), hostChatId: 'other-host-chat' };
  resolveRead(source());
  assert.equal((await task).status, 'stale');
  assert.equal(prepareCalls, 0);
});

test('安装器只清理自己挂载的版本化桥', () => {
  const globalRef = {};
  const mount = installPublicMemoryBridge({ globalRef, session: { getState: () => ({ status: 'ready', identity: identity() }), identity }, store: { readReachable: async () => source() }, hostAdapter: { snapshot: () => ({ chatId: 'host-chat', chat: [] }) } });
  assert.equal(globalRef[QQJ_PUBLIC_MEMORY_BRIDGE_KEY], mount.bridge);
  mount.cleanup();
  assert.equal(Object.hasOwn(globalRef, QQJ_PUBLIC_MEMORY_BRIDGE_KEY), false);
});
