import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyArchiveV2 } from '../src/archive-v2.js';
import {
  ArchiveV2CompositionError,
  createArchiveV2Composition,
} from '../src/archive-v2-composition.js';
import { ARCHIVE_V2_PROFILE_FIELD_KEYS } from '../src/archive-v2-profile-generation.js';

const CHAT = '11111111-1111-4111-8111-111111111111';
const HOST_CHAT = 'host-chat-file-name';
const fingerprint = `sha256:${'a'.repeat(64)}`;

function rawContext(overrides = {}) {
  return {
    characterId: 0,
    groupId: null,
    chatId: HOST_CHAT,
    characters: [{ avatar: 'character.png', name: '角色' }],
    userAvatar: 'persona.png',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
    chat: [{ mes: '开场白' }],
    simulateWorldInfoActivation() {},
    getRequestHeaders: () => ({ 'X-Test': 'yes' }),
    ...overrides,
  };
}

function sourceResult() {
  return {
    status: 'ready',
    candidates: [{
      id: 'card:1',
      kind: 'card',
      locator: 'card:1',
      fingerprint,
      label: '角色卡',
      content: '沈砚是核心人物。',
      selected: true,
      availability: 'card',
    }],
    warnings: [],
  };
}

function profileFields() {
  return Object.fromEntries(ARCHIVE_V2_PROFILE_FIELD_KEYS.map(key => [key, { value: '', evidence: [] }]));
}

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function basicOptions(overrides = {}) {
  return {
    client: {
      async get() { throw httpError(404); },
      async put() { throw new Error('不应写入'); },
    },
    contextProvider: () => rawContext(),
    generateTask: async () => ({ jsonData: { people: [] } }),
    collectSources: async () => sourceResult(),
    createId: ({ index }) => `candidate-${index + 1}`,
    ...overrides,
  };
}

test('构造参数只做约定的最小接口检查', () => {
  assert.doesNotThrow(() => createArchiveV2Composition(basicOptions()));
  for (const options of [
    {},
    basicOptions({ client: { get() {} } }),
    basicOptions({ contextProvider: null }),
    basicOptions({ generateTask: null }),
    basicOptions({ isEnabled: 'yes' }),
    basicOptions({ collectSources: null }),
    basicOptions({ now: 1 }),
    basicOptions({ createId: {} }),
  ]) assert.throws(() => createArchiveV2Composition(options), TypeError);
});

test('readArchive 使用稳定 V2 UUID 路径且不会自动采集、调用 AI 或写入', async () => {
  const calls = { context: 0, get: [], put: 0, ai: 0, collect: 0, metadata: 0 };
  const raw = rawContext({ saveMetadata: () => { calls.metadata += 1; } });
  const composition = createArchiveV2Composition(basicOptions({
    client: {
      async get(collection, recordId) { calls.get.push([collection, recordId]); throw httpError(404); },
      async put() { calls.put += 1; },
    },
    contextProvider: () => { calls.context += 1; return raw; },
    generateTask: async () => { calls.ai += 1; return { jsonData: { people: [] } }; },
    collectSources: async () => { calls.collect += 1; return sourceResult(); },
  }));
  assert.equal(calls.context, 0);
  assert.deepEqual(await composition.readArchive(), { status: 'uninitialized' });
  assert.deepEqual(calls.get, [[`chat-${CHAT}`, 'archive-v2']]);
  assert.equal(calls.put, 0);
  assert.equal(calls.ai, 0);
  assert.equal(calls.collect, 0);
  assert.equal(calls.metadata, 0);
});

test('currentIdentity 每次返回独立规范对象并原样接收 personaSummary', () => {
  const raw = rawContext();
  const composition = createArchiveV2Composition(basicOptions({ contextProvider: () => raw }));
  const first = composition.currentIdentity({ personaSummary: '用户自己填写的摘要' });
  const second = composition.currentIdentity();
  assert.deepEqual(first, {
    characterLocator: 'character.png',
    personaLocator: 'persona.png',
    personaSummary: '用户自己填写的摘要',
  });
  assert.deepEqual(second, {
    characterLocator: 'character.png',
    personaLocator: 'persona.png',
    personaSummary: '',
  });
  assert.notEqual(first, second);
  first.characterLocator = 'changed';
  assert.equal(second.characterLocator, 'character.png');
  assert.throws(() => composition.currentIdentity({ personaSummary: 1 }), TypeError);
  assert.equal(raw.chatId, HOST_CHAT);
});

test('缺失或非法稳定 UUID 明确失败且零后端、零 AI、零 metadata 写入', async () => {
  for (const qianqianjie of [undefined, { schemaVersion: 1, chatId: 'not-a-uuid' }]) {
    const calls = { get: 0, put: 0, ai: 0, collect: 0, metadata: 0 };
    const raw = rawContext({
      chatMetadata: qianqianjie === undefined ? {} : { qianqianjie },
      saveMetadata: () => { calls.metadata += 1; },
      saveChatMetadata: () => { calls.metadata += 1; },
    });
    const composition = createArchiveV2Composition(basicOptions({
      client: {
        async get() { calls.get += 1; },
        async put() { calls.put += 1; },
      },
      contextProvider: () => raw,
      generateTask: async () => { calls.ai += 1; },
      collectSources: async () => { calls.collect += 1; return sourceResult(); },
    }));
    assert.throws(
      () => composition.currentIdentity(),
      error => error instanceof ArchiveV2CompositionError
        && error.code === 'ARCHIVE_V2_COMPOSITION_CONTEXT_INVALID',
    );
    await assert.rejects(composition.readArchive(), ArchiveV2CompositionError);
    await assert.rejects(
      composition.flow.loadSources(),
      error => error?.code === 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTEXT_INVALID',
    );
    assert.deepEqual(calls, { get: 0, put: 0, ai: 0, collect: 0, metadata: 0 });
  }
});

test('来源 collector 收到完整宿主浅副本与规范四字段且原对象不变', async () => {
  const raw = rawContext();
  const originalKeys = Object.keys(raw);
  let received;
  const composition = createArchiveV2Composition(basicOptions({
    contextProvider: () => raw,
    collectSources: async context => { received = context; return sourceResult(); },
  }));
  assert.deepEqual(await composition.flow.loadSources(), { status: 'ready' });
  assert.notEqual(received, raw);
  assert.equal(received.chat, raw.chat);
  assert.equal(received.characters, raw.characters);
  assert.equal(received.simulateWorldInfoActivation, raw.simulateWorldInfoActivation);
  assert.equal(received.hostChatId, HOST_CHAT);
  assert.equal(received.chatId, CHAT);
  assert.equal(received.characterLocator, 'character.png');
  assert.equal(received.personaLocator, 'persona.png');
  assert.equal(raw.chatId, HOST_CHAT);
  assert.deepEqual(Object.keys(raw), originalKeys);
  assert.equal(Object.hasOwn(raw, 'hostChatId'), false);
});

test('recognizer 与 profile generator 共用注入 generateTask 和稳定身份语义', async () => {
  const calls = [];
  const generateTask = async options => {
    calls.push(options);
    if (options.jsonSchema.name === 'qianqianjie_v2_candidate_recognition') {
      return { jsonData: { people: [{ name: '沈砚', aliases: ['阿砚'], reason: '核心人物', evidence: ['S1'] }] } };
    }
    return { jsonData: { people: [{ identityId: 'candidate-1', fields: profileFields() }] } };
  };
  const composition = createArchiveV2Composition(basicOptions({ generateTask }));
  await composition.flow.loadSources();
  assert.deepEqual(await composition.flow.recognizeCandidates(), { status: 'ready' });
  let state = composition.flow.getState();
  assert.equal(state.candidateReview.chatId, CHAT);
  composition.flow.setCandidateSelected('candidate-1', true);
  assert.deepEqual(await composition.flow.generateProfiles(), { status: 'ready' });
  state = composition.flow.getState();
  assert.equal(state.profileReview.chatId, CHAT);
  assert.deepEqual(calls.map(call => call.jsonSchema.name), [
    'qianqianjie_v2_candidate_recognition',
    'qianqianjie_v2_people_profiles',
  ]);
});

test('disabled 时 readArchive 零后端，AI 阶段零 generateTask', async () => {
  const calls = { get: 0, put: 0, ai: 0, collect: 0 };
  const composition = createArchiveV2Composition(basicOptions({
    isEnabled: false,
    client: {
      async get() { calls.get += 1; },
      async put() { calls.put += 1; },
    },
    generateTask: async () => { calls.ai += 1; },
    collectSources: async () => { calls.collect += 1; return sourceResult(); },
  }));
  assert.deepEqual(await composition.readArchive(), { status: 'disabled' });
  await composition.flow.loadSources();
  assert.deepEqual(await composition.flow.recognizeCandidates(), { status: 'disabled' });
  assert.deepEqual(calls, { get: 0, put: 0, ai: 0, collect: 1 });
});

test('invalidate 清空 flow 并使已开始 read 返回 stale', async () => {
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  const gate = new Promise(resolve => { releaseRead = resolve; });
  const data = createEmptyArchiveV2({
    chatId: CHAT,
    characterLocator: 'character.png',
    personaLocator: 'persona.png',
  });
  const composition = createArchiveV2Composition(basicOptions({
    client: {
      async get() { markReadStarted(); await gate; return { revision: 1, data }; },
      async put() { throw new Error('不应写入'); },
    },
  }));
  await composition.flow.loadSources();
  assert.equal(composition.flow.getState().stage, 'sources');
  const pending = composition.readArchive();
  await readStarted;
  composition.invalidate();
  assert.equal(composition.flow.getState().stage, 'idle');
  releaseRead();
  assert.deepEqual(await pending, { status: 'stale' });
});

test('invalidate 即使 flow.reset 异常也会继续使 archive adapter 失效', async () => {
  const abortFailure = new Error('expected abort failure');
  const NativeAbortController = globalThis.AbortController;
  class ThrowingAbortController {
    constructor() {
      this.signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    }
    abort() {
      this.signal.aborted = true;
      throw abortFailure;
    }
  }
  let releaseRead;
  let markReadStarted;
  let releaseAi;
  let markAiStarted;
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  const aiStarted = new Promise(resolve => { markAiStarted = resolve; });
  const data = createEmptyArchiveV2({
    chatId: CHAT,
    characterLocator: 'character.png',
    personaLocator: 'persona.png',
  });
  const composition = createArchiveV2Composition(basicOptions({
    client: {
      async get() { markReadStarted(); await new Promise(resolve => { releaseRead = resolve; }); return { revision: 1, data }; },
      async put() { throw new Error('不应写入'); },
    },
    generateTask: async () => {
      markAiStarted();
      await new Promise(resolve => { releaseAi = resolve; });
      return { jsonData: { people: [] } };
    },
  }));
  await composition.flow.loadSources();
  globalThis.AbortController = ThrowingAbortController;
  let pendingRecognition;
  try {
    pendingRecognition = composition.flow.recognizeCandidates();
    await aiStarted;
  } finally {
    globalThis.AbortController = NativeAbortController;
  }
  const pendingRead = composition.readArchive();
  await readStarted;
  assert.throws(() => composition.invalidate(), error => error === abortFailure);
  assert.equal(composition.flow.getState().stage, 'idle');
  releaseRead();
  releaseAi();
  assert.deepEqual(await pendingRead, { status: 'stale' });
  assert.deepEqual(await pendingRecognition, { status: 'stale' });
});

test('返回对象冻结且公开面窄，不泄漏写入与底层依赖', () => {
  const composition = createArchiveV2Composition(basicOptions());
  assert.equal(Object.isFrozen(composition), true);
  assert.deepEqual(Object.keys(composition), ['flow', 'readArchive', 'currentIdentity', 'invalidate']);
  for (const key of ['save', 'create', 'client', 'generateTask', 'contextProvider', 'archiveAdapter']) {
    assert.equal(Object.hasOwn(composition, key), false);
  }
});
