import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createArchiveV2MemoryComposition } from '../src/archive-v2-memory-composition.js';
import {
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
  validateArchiveV2MemoryManifest,
} from '../src/archive-v2-memory-foundation.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TIME = '2026-08-31T10:20:30.000Z';

const assistant = (content, overrides = {}) => ({
  is_user: false, is_system: false, mes: content, swipe_id: 0, swipes: [content], extra: {}, ...overrides,
});
const user = content => ({ is_user: true, is_system: false, mes: content });
const system = content => ({ is_user: false, is_system: true, mes: content });

function host(chat = [assistant('第一段 AI 正文')], overrides = {}) {
  return {
    characterId: 0,
    groupId: null,
    characters: [{ avatar: 'character.png' }],
    userAvatar: 'persona.png',
    chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
    chat,
    ...overrides,
  };
}

function fakeClient() {
  const records = new Map();
  const calls = [];
  const key = (collection, recordId) => `${collection}/${recordId}`;
  const missing = () => Object.assign(new Error('missing'), { status: 404 });
  const conflict = () => Object.assign(new Error('conflict'), { status: 409 });
  return {
    records,
    calls,
    client: {
      async get(collection, recordId) {
        calls.push(['get', collection, recordId]);
        const value = records.get(key(collection, recordId));
        if (!value) throw missing();
        return structuredClone(value);
      },
      async put(collection, recordId, data, expectedRevision) {
        calls.push(['put', collection, recordId, expectedRevision, structuredClone(data)]);
        const recordKey = key(collection, recordId);
        const previous = records.get(recordKey);
        if ((previous?.revision ?? 0) !== expectedRevision) throw conflict();
        const revision = expectedRevision + 1;
        const envelope = {
          schemaVersion: 1,
          revision,
          generationId: previous?.generationId ?? '11111111-1111-4111-8111-111111111111',
          createdAt: previous?.createdAt ?? TIME,
          updatedAt: TIME,
          data: structuredClone(data),
        };
        records.set(recordKey, envelope);
        return structuredClone(envelope);
      },
    },
    seed(recordId, data, revision = 1) {
      records.set(`chat-${CHAT}/${recordId}`, {
        schemaVersion: 1,
        revision,
        generationId: '11111111-1111-4111-8111-111111111111',
        createdAt: TIME,
        updatedAt: TIME,
        data: structuredClone(data),
      });
    },
  };
}

const emptyRows = () => ({ people: [], facts: [], relations: [], events: [] });
const onePersonRows = () => ({
  people: [{ localId: 'P1', displayName: '沈砚', aliases: [], sourceFloors: [0] }],
  facts: [], relations: [], events: [],
});
const onePersonResult = () => ({ people: [{
  localId: 'C1', displayName: '沈砚', aliases: [], recognitionReason: '独立人物',
  sourcePeopleRefs: [{ batchIndex: 0, localId: 'P1' }], recommendation: 'romance_candidate',
  recommendationReason: '与用户关系值得关注',
}], userSourcePeopleRefs: [] });

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('等待异步测试条件超时');
}

function harness({ current = host(), clientHarness = fakeClient(), primary, utility, enabled = () => true } = {}) {
  let currentHost = current;
  const primaryCalls = [];
  const utilityCalls = [];
  const composition = createArchiveV2MemoryComposition({
    client: clientHarness.client,
    contextProvider: () => currentHost,
    generatePrimaryTask: async options => {
      primaryCalls.push(options);
      return primary ? primary(options) : { jsonData: onePersonResult() };
    },
    generateUtilityTask: async options => {
      utilityCalls.push(options);
      return utility ? utility(options) : { jsonData: emptyRows() };
    },
    isEnabled: enabled,
    now: () => TIME,
    createScanId: () => 'scan-fixed',
  });
  return {
    composition,
    clientHarness,
    primaryCalls,
    utilityCalls,
    setHost(value) { currentHost = value; },
  };
}

test('构造与 inspect 预览零 AI 零写，完整聊天复用 foundation 的 AI 楼层规则', async () => {
  const chat = [
    assistant('普通 AI 正文'),
    user('用户正文绝不能扫描'),
    system('系统正文绝不能扫描'),
    assistant('隐藏 AI 正文', { is_hidden: true }),
  ];
  const h = harness({ current: host(chat) });
  assert.equal(Object.isFrozen(h.composition), true);
  assert.deepEqual(Object.keys(h.composition).sort(), ['confirmPeople', 'consolidatePeople', 'getState', 'inspect', 'invalidate', 'start']);
  assert.equal(h.clientHarness.calls.length, 0);
  assert.equal(h.utilityCalls.length, 0);
  const result = await h.composition.inspect();
  assert.deepEqual(result, {
    status: 'uninitialized',
    targetFloor: 3,
    eligibleFloorCount: 3,
    completedBatches: 0,
    totalBatches: 1,
    currentBatchIndex: null,
    overRecommendedLimit: false,
    peopleStatus: 'idle',
  });
  assert.equal(h.utilityCalls.length, 0);
  assert.deepEqual(h.clientHarness.calls.map(call => call[0]), ['get']);
  assert.equal(JSON.stringify(result).includes('正文'), false);
});

test('start 真实组合 snapshot→utility→batch→manifest，utility 只收到有效 AI 正文', async () => {
  const chat = [assistant('可见 AI'), user('用户秘密'), system('系统秘密'), assistant('隐藏 AI', { is_hidden: true })];
  const original = structuredClone(chat);
  const h = harness({ current: host(chat) });
  const result = await h.composition.start();
  assert.equal(result.status, 'ready');
  assert.equal(h.utilityCalls.length, 1);
  assert.equal(h.primaryCalls.length, 0);
  const prompt = h.utilityCalls[0].taskMessages[0].content;
  assert.match(prompt, /可见 AI/);
  assert.match(prompt, /隐藏 AI/);
  assert.match(prompt, /系统秘密/);
  assert.doesNotMatch(prompt, /用户秘密/);
  const writes = h.clientHarness.calls.filter(call => call[0] === 'put');
  assert.deepEqual(writes.map(call => [call[2].startsWith('memory-batch-') ? 'batch' : call[2], call[3]]), [
    ['memory-manifest', 0], ['batch', 0], ['memory-manifest', 1],
  ]);
  assert.deepEqual(chat, original);
  assert.equal(JSON.stringify(result).includes('可见 AI'), false);
  assert.equal(JSON.stringify(h.composition.getState()).includes('model'), false);
});

test('组合扫描只清洗 utility prompt，宿主聊天与原文指纹写入的 manifest 均不改变', async () => {
  const chat = [assistant('<content>保留故事<think>删除推理</think></content>')];
  const original = structuredClone(chat);
  const expected = await createArchiveV2MemorySnapshot(host(chat));
  const h = harness({ current: host(chat) });
  assert.equal((await h.composition.start()).status, 'ready');
  const prompt = JSON.parse(h.utilityCalls[0].taskMessages[0].content);
  assert.deepEqual(prompt, [{ sourceFloor: 0, content: '保留故事' }]);
  assert.deepEqual(chat, original);
  const storedManifest = h.clientHarness.records.get(`chat-${CHAT}/memory-manifest`).data;
  assert.equal(storedManifest.sourceFingerprint, expected.sourceFingerprint);
  assert.equal(storedManifest.totalBatches, expected.batches.length);
});

test('恢复严格 slice 到旧 targetFloor，后来新增消息不进入 utility prompt 且宿主不变', async () => {
  const oldChat = [assistant('旧一'), assistant('旧二')];
  const oldSnapshot = await createArchiveV2MemorySnapshot(host(oldChat));
  const base = createArchiveV2MemoryManifest({ snapshot: oldSnapshot, scanId: 'scan-fixed', createdAt: TIME });
  const manifest = validateArchiveV2MemoryManifest({ ...structuredClone(base), status: 'interrupted' });
  const clientHarness = fakeClient();
  clientHarness.seed('memory-manifest', manifest);
  const currentChat = [...oldChat, assistant('后来新增，绝不能混入恢复')];
  const original = structuredClone(currentChat);
  const h = harness({ current: host(currentChat), clientHarness });
  assert.equal((await h.composition.start()).status, 'ready');
  assert.equal(h.utilityCalls.length, 1);
  const prompt = h.utilityCalls[0].taskMessages[0].content;
  assert.match(prompt, /旧一|旧二/);
  assert.doesNotMatch(prompt, /后来新增/);
  assert.deepEqual(currentChat, original);
});

test('当前聊天短于旧 target 时自然 source_changed，零 AI 零写', async () => {
  const oldSnapshot = await createArchiveV2MemorySnapshot(host([assistant('一'), assistant('二')]));
  const manifest = createArchiveV2MemoryManifest({ snapshot: oldSnapshot, scanId: 'scan-fixed', createdAt: TIME });
  const clientHarness = fakeClient();
  clientHarness.seed('memory-manifest', manifest);
  const h = harness({ current: host([assistant('一')]), clientHarness });
  const beforeWrites = clientHarness.calls.filter(call => call[0] === 'put').length;
  assert.equal((await h.composition.start()).status, 'source_changed');
  assert.equal(h.utilityCalls.length, 0);
  assert.equal(clientHarness.calls.filter(call => call[0] === 'put').length, beforeWrites);
});

test('inspect 已有 manifest 不读取正文、不写且返回安全进度', async () => {
  const source = await createArchiveV2MemorySnapshot(host([assistant('一')]));
  const manifest = createArchiveV2MemoryManifest({ snapshot: source, scanId: 'scan-fixed', createdAt: TIME });
  const clientHarness = fakeClient();
  clientHarness.seed('memory-manifest', manifest);
  const current = host([]);
  Object.defineProperty(current, 'chat', { enumerable: true, get() { throw new Error('不应读取正文'); } });
  const h = harness({ current, clientHarness });
  assert.deepEqual(await h.composition.inspect(), {
    status: 'scanning',
    targetFloor: 0,
    eligibleFloorCount: null,
    completedBatches: 0,
    totalBatches: 1,
    currentBatchIndex: null,
    peopleStatus: 'idle',
  });
  assert.deepEqual(clientHarness.calls.map(call => call[0]), ['get']);
  assert.equal(h.utilityCalls.length, 0);
});

test('同页 runner 失败后 inspect 优先返回安全 error，不被 scanning manifest 伪装为仍在运行', async () => {
  const h = harness({ utility: async () => { throw new Error('SECRET 模型原文与 KEY'); } });
  await assert.rejects(h.composition.start());
  assert.equal(h.composition.getState().status, 'error');
  const storedManifest = h.clientHarness.records.get(`chat-${CHAT}/memory-manifest`).data;
  assert.equal(storedManifest.status, 'scanning');
  const beforeReads = h.clientHarness.calls.filter(call => call[0] === 'get').length;
  const inspected = await h.composition.inspect();
  assert.equal(inspected.status, 'error');
  assert.equal(inspected.completedBatches, 0);
  assert.equal(JSON.stringify(inspected).includes('SECRET'), false);
  assert.equal(h.clientHarness.calls.filter(call => call[0] === 'get').length, beforeReads);
});

test('inspect 切身份/disabled 与 invalidate 安全终止，不泄露依赖异常', async () => {
  let enabled = true;
  let release;
  const clientHarness = fakeClient();
  clientHarness.client.get = async () => new Promise((_resolve, reject) => {
    release = () => reject(Object.assign(new Error('正文与 SECRET'), { status: 404 }));
  });
  const h = harness({ clientHarness, enabled: () => enabled });
  const pending = h.composition.inspect();
  await new Promise(resolve => setImmediate(resolve));
  h.setHost(host([], { chatId: 'host-other', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: OTHER_CHAT } } }));
  release();
  assert.deepEqual(await pending, { status: 'stale' });

  const disabled = harness({ enabled: () => false });
  assert.deepEqual(await disabled.composition.inspect(), { status: 'disabled' });
  assert.equal(disabled.clientHarness.calls.length, 0);
  enabled = false;
  h.composition.invalidate();
  assert.equal(h.composition.getState().status, 'disabled');
});

test('扫描只走副 API、跨批人物归并只走主 API；已有候选不重复 AI', async () => {
  const h = harness({
    utility: () => ({ jsonData: onePersonRows(), taskMetadata: { source: 'shared-utility' } }),
    primary: () => ({ jsonData: onePersonResult(), taskMetadata: { source: 'shared-main' } }),
  });
  assert.equal((await h.composition.start()).status, 'ready');
  assert.equal(h.utilityCalls.length, 1);
  assert.equal(h.primaryCalls.length, 0);
  assert.match(h.utilityCalls[0].systemPrompt, /单批故事记忆抽取器/);
  const inspected = await h.composition.inspect();
  assert.equal(inspected.peopleStatus, 'uninitialized');
  assert.equal(h.utilityCalls.length, 1);
  assert.equal(h.primaryCalls.length, 0);

  const consolidated = await h.composition.consolidatePeople();
  assert.equal(consolidated.status, 'ready');
  assert.equal(h.utilityCalls.length, 1);
  assert.equal(h.primaryCalls.length, 1);
  assert.match(h.primaryCalls[0].systemPrompt, /跨批人物归并器/);
  assert.equal(h.composition.getState().peopleStatus, 'ready');
  assert.equal((await h.composition.consolidatePeople()).reused, true);
  assert.equal(h.utilityCalls.length, 1);
  assert.equal(h.primaryCalls.length, 1);

  const committed = await h.composition.confirmPeople({ selectedLocalIds: ['C1'] });
  assert.equal(committed.status, 'created');
  assert.equal(committed.followedCount, 1);
  assert.equal(committed.silentCount, 0);
  const archive = h.clientHarness.records.get(`chat-${CHAT}/archive-v2`).data;
  assert.equal(archive.people.order.length, 1);
  assert.equal(archive.people.byId[archive.people.order[0]].followed, true);
  assert.equal(h.composition.getState().peopleStatus, 'committed');
});

test('人物归并失败保留 batch 并允许人工重试；切聊天或禁用使迟到结果不写入', async () => {
  let attempts = 0;
  const retry = harness({
    utility: () => ({ jsonData: onePersonRows() }),
    primary: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('SECRET');
      return { jsonData: onePersonResult() };
    },
  });
  await retry.composition.start();
  const batchKeys = [...retry.clientHarness.records.keys()].filter(key => key.includes('/memory-batch-'));
  await assert.rejects(retry.composition.consolidatePeople());
  assert.equal(retry.composition.getState().peopleStatus, 'error');
  assert.deepEqual([...retry.clientHarness.records.keys()].filter(key => key.includes('/memory-batch-')), batchKeys);
  assert.equal((await retry.composition.consolidatePeople()).status, 'ready');
  assert.equal(attempts, 2);

  for (const mode of ['chat', 'disabled']) {
    let enabled = true;
    let release;
    const late = harness({
      enabled: () => enabled,
      utility: () => ({ jsonData: onePersonRows() }),
      primary: () => {
        return new Promise(resolve => { release = () => resolve({ jsonData: onePersonResult() }); });
      },
    });
    await late.composition.start();
    const pending = late.composition.consolidatePeople();
    await waitUntil(() => typeof release === 'function');
    if (mode === 'chat') late.setHost(host([assistant('沈砚')], {
      chatId: 'host-other', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: OTHER_CHAT } },
    }));
    else enabled = false;
    release();
    assert.equal((await pending).status, mode === 'disabled' ? 'disabled' : 'stale');
    assert.equal([...late.clientHarness.records.keys()].some(key => key.includes('/memory-people-')), false);
  }
});

test('生产组合只创建一套依赖，不写 metadata、不公开内部对象或正式 archive 接口', async () => {
  const source = await readFile(new URL('../src/archive-v2-memory-composition.js', import.meta.url), 'utf8');
  for (const factory of [
    'createArchiveV2MemoryStore', 'createArchiveV2MemoryBatchExtractor', 'createArchiveV2MemoryRunner',
    'createArchiveV2MemoryPeopleConsolidator', 'createArchiveV2MemoryPeopleCommitter', 'createArchiveV2Adapter',
  ]) assert.equal((source.match(new RegExp(`${factory}\\s*\\(`, 'g')) || []).length, 1, factory);
  assert.doesNotMatch(source, /saveMetadata|saveChatMetadata|persistChatId|registerIntegration|document\.|querySelector|innerHTML/);
  assert.doesNotMatch(source, /generatePeopleTask/);
});
