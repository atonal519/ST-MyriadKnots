import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_V2_KIND,
  ARCHIVE_V2_RECORD_ID,
  ARCHIVE_V2_SCHEMA_VERSION,
  ArchiveV2ValidationError,
  createArchiveV2Adapter,
  createEmptyArchiveV2,
  validateArchiveV2,
} from '../src/archive-v2.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function archive(overrides = {}) {
  return {
    ...createEmptyArchiveV2({
      chatId: CHAT,
      characterLocator: 'character.png',
      personaLocator: 'persona.png',
      personaSummary: 'U',
    }),
    ...overrides,
  };
}

function ownership(value, overrides = {}) {
  return {
    value,
    origin: 'ai',
    sourceRefs: [{ kind: 'card', locator: 'card:1', fingerprint: `sha256:${'a'.repeat(64)}` }],
    userProtected: false,
    ...overrides,
  };
}

function initializedArchive() {
  const data = archive();
  data.initialization = {
    confirmedAt: '2026-08-31T10:20:30.000Z',
    sourceFingerprint: `sha256:${'b'.repeat(64)}`,
    sources: [{
      kind: 'card',
      locator: 'card:1',
      fingerprint: `sha256:${'a'.repeat(64)}`,
      content: '沈砚的角色卡正文',
      futureSourceMetadata: { retained: true },
    }],
    futureInitializationMetadata: '保留',
  };
  data.people = {
    order: ['person-1'],
    byId: {
      'person-1': {
        identityId: 'person-1',
        followed: true,
        displayName: ownership('沈砚'),
        aliases: ownership(['阿砚']),
        fields: { personality: ownership('沉静') },
        sourceRefs: [{ kind: 'card', locator: 'card:1', fingerprint: `sha256:${'a'.repeat(64)}` }],
      },
    },
  };
  return data;
}

function envelope(data = archive(), revision = 1) {
  return {
    schemaVersion: 1,
    revision,
    generationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    data: structuredClone(data),
  };
}

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function harness({ get, put, isEnabled = true } = {}) {
  const calls = [];
  let context = {
    hostChatId: 'host-chat-a',
    chatId: CHAT,
    characterLocator: 'character.png',
    personaLocator: 'persona.png',
  };
  const client = {
    async get(collection, recordId) {
      calls.push({ op: 'get', collection, recordId });
      if (get) return get({ collection, recordId });
      return envelope();
    },
    async put(collection, recordId, data, expectedRevision) {
      calls.push({ op: 'put', collection, recordId, data: structuredClone(data), expectedRevision });
      if (put) return put({ collection, recordId, data, expectedRevision });
      return envelope(data, expectedRevision + 1);
    },
  };
  const adapter = createArchiveV2Adapter({ client, contextProvider: () => context, isEnabled });
  return {
    adapter,
    calls,
    setContext(next) { context = next; },
  };
}

test('空档案工厂生成严格最小结构且实例不共享引用', () => {
  const first = createEmptyArchiveV2({ chatId: CHAT, characterLocator: 'c', personaLocator: 'u' });
  const second = createEmptyArchiveV2({ chatId: CHAT, characterLocator: 'c', personaLocator: 'u' });
  assert.deepEqual(first, {
    schemaVersion: ARCHIVE_V2_SCHEMA_VERSION,
    kind: ARCHIVE_V2_KIND,
    chatId: CHAT,
    identity: { characterLocator: 'c', personaLocator: 'u', personaSummary: '' },
    initialization: { confirmedAt: null, sources: [] },
    people: { order: [], byId: {} },
    events: [],
    bonds: {},
    nextSteps: { items: [] },
    progress: { lastConfirmedFloor: null },
  });
  first.people.order.push('person-1');
  first.events.push({ id: 'event-1' });
  assert.deepEqual(second.people.order, []);
  assert.deepEqual(second.events, []);
});

test('根级只允许固定键并拒绝运行态字段，合法容器内扩展仍返回安全副本', () => {
  for (const key of ['futureExtension', 'loading', 'error', 'retry', 'operationId', 'stale']) {
    assert.throws(
      () => validateArchiveV2(archive({ [key]: true }), { expectedChatId: CHAT }),
      error => error instanceof ArchiveV2ValidationError && error.code === 'ARCHIVE_V2_ROOT_KEY_UNKNOWN',
    );
  }
  const input = archive();
  input.identity.futureExtension = { enabled: true };
  const safe = validateArchiveV2(input, { expectedChatId: CHAT });
  safe.identity.futureExtension.enabled = false;
  assert.equal(input.identity.futureExtension.enabled, true);
});

test('循环引用和底层复制异常统一转换为 ArchiveV2ValidationError', () => {
  const circular = archive();
  circular.bonds.self = circular.bonds;
  assert.throws(
    () => validateArchiveV2(circular),
    error => error instanceof ArchiveV2ValidationError && !(error instanceof RangeError),
  );

  const deep = archive();
  let cursor = deep.bonds;
  for (let index = 0; index < 20000; index += 1) cursor = cursor.next = {};
  assert.throws(
    () => validateArchiveV2(deep),
    error => error instanceof ArchiveV2ValidationError
      && error.code === 'ARCHIVE_V2_CLONE_FAILED'
      && !(error instanceof RangeError),
  );
});

test('合法初始化正式档案能由 adapter 读取并返回安全副本', async () => {
  const input = initializedArchive();
  const h = harness({ get: async () => envelope(input) });
  const result = await h.adapter.read();
  assert.equal(result.status, 'ready');
  const safe = result.archive;
  assert.deepEqual(safe, input);
  safe.people.byId['person-1'].fields.personality.value = '外部修改';
  assert.equal(input.people.byId['person-1'].fields.personality.value, '沉静');
});

test('人物 order 重复、缺项、多项及 identityId 错配均拒绝', () => {
  const cases = [];
  {
    const data = initializedArchive();
    data.people.order.push('person-1');
    cases.push(data);
  }
  {
    const data = initializedArchive();
    delete data.people.byId['person-1'];
    cases.push(data);
  }
  {
    const data = initializedArchive();
    data.people.byId['person-2'] = { identityId: 'person-2' };
    cases.push(data);
  }
  {
    const data = initializedArchive();
    data.people.byId['person-1'].identityId = 'person-2';
    cases.push(data);
  }
  for (const data of cases) {
    assert.throws(
      () => validateArchiveV2(data),
      error => error instanceof ArchiveV2ValidationError && error.code === 'ARCHIVE_V2_PEOPLE_INVALID',
    );
  }
});

test('必要 ownership 外壳类型错误按结构类别拒绝', () => {
  const mutations = [
    person => { person.displayName.origin = ''; },
    person => { person.displayName.sourceRefs = {}; },
    person => { person.displayName.sourceRefs[0].kind = 1; },
    person => { person.displayName.userProtected = 'false'; },
    person => { person.displayName.value = ['沈砚']; },
    person => { person.aliases.value = ['阿砚', 1]; },
    person => { delete person.fields.personality.value; },
  ];
  for (const mutate of mutations) {
    const data = initializedArchive();
    mutate(data.people.byId['person-1']);
    assert.throws(() => validateArchiveV2(data), ArchiveV2ValidationError);
  }
});

test('未来人物字段、ownership 元数据及未建模内容完整保留', () => {
  const data = initializedArchive();
  const person = data.people.byId['person-1'];
  person.futurePersonState = { arbitrary: ['内容', 7] };
  person.displayName.futureOwnershipMetadata = { reviewer: 'user' };
  person.fields = {
    futureFreeText: ownership(' '.repeat(10000) + '<任意用户文案>{{macro}}</任意用户文案>'),
    futureStructuredValue: ownership({ arbitrary: ['JSON', 7] }),
  };
  data.events = [{ futureEvent: { prose: '不解析事件语义' } }];
  data.bonds = { futureBond: ['任意', { score: '不是数字也保留' }] };
  data.nextSteps = { items: [{ futureStep: '不解析' }], futureMetadata: true };
  const safe = validateArchiveV2(data);
  assert.deepEqual(safe.people.byId['person-1'].futurePersonState, person.futurePersonState);
  assert.deepEqual(safe.people.byId['person-1'].displayName.futureOwnershipMetadata, { reviewer: 'user' });
  assert.equal(safe.people.byId['person-1'].fields.futureFreeText.value.length > 10000, true);
  assert.deepEqual(safe.people.byId['person-1'].fields.futureStructuredValue.value, { arbitrary: ['JSON', 7] });
  assert.deepEqual(safe.events, data.events);
  assert.deepEqual(safe.bonds, data.bonds);
  assert.deepEqual(safe.nextSteps, data.nextSteps);
});

test('accessor 在结构校验前不会执行', () => {
  const data = archive();
  let reads = 0;
  Object.defineProperty(data, 'identity', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return { characterLocator: 'c', personaLocator: 'u', personaSummary: '' };
    },
  });
  assert.throws(
    () => validateArchiveV2(data),
    error => error instanceof ArchiveV2ValidationError && error.code === 'ARCHIVE_V2_NOT_JSON',
  );
  assert.equal(reads, 0);
});

test('__proto__ 自有人物 ID 可安全复制且不污染原型', () => {
  const data = archive();
  data.people.order = ['__proto__'];
  Object.defineProperty(data.people.byId, '__proto__', {
    value: { identityId: '__proto__', futurePersonField: '保留' },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const safe = validateArchiveV2(data);
  assert.equal(Object.hasOwn(safe.people.byId, '__proto__'), true);
  assert.equal(safe.people.byId.__proto__.identityId, '__proto__');
  assert.equal(Object.getPrototypeOf(safe.people.byId), Object.prototype);
  assert.equal(Object.prototype.futurePersonField, undefined);
});

test('合法后端 envelope 读取成功并使用固定记录路径', async () => {
  const h = harness();
  const result = await h.adapter.read();
  assert.equal(result.status, 'ready');
  assert.equal(result.revision, 1);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.archive, archive());
  assert.deepEqual(h.calls, [{ op: 'get', collection: `chat-${CHAT}`, recordId: ARCHIVE_V2_RECORD_ID }]);
});

test('读取 404 返回 uninitialized 且不会自动写入', async () => {
  const h = harness({ get: async () => { throw httpError(404); } });
  assert.deepEqual(await h.adapter.read(), { status: 'uninitialized' });
  assert.equal(h.calls.filter(call => call.op === 'put').length, 0);
});

test('错误 schema、kind、chatId 与容器类型均拒绝读取', async () => {
  const invalidRecords = [
    archive({ schemaVersion: 2 }),
    archive({ kind: 'wrong-kind' }),
    archive({ chatId: OTHER_CHAT }),
    archive({ events: {} }),
    archive({ people: [] }),
  ];
  for (const data of invalidRecords) {
    const h = harness({ get: async () => envelope(data) });
    await assert.rejects(h.adapter.read(), error => error instanceof ArchiveV2ValidationError);
    assert.equal(h.calls.length, 1);
  }
});

test('Persona locator 不一致仍返回档案并给出稳定 warning', async () => {
  const data = archive();
  data.identity.personaLocator = 'old-persona.png';
  const h = harness({ get: async () => envelope(data) });
  const result = await h.adapter.read();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.warnings, ['persona_mismatch']);
  assert.equal(result.archive.identity.personaLocator, 'old-persona.png');
});

test('character locator 不一致仍返回档案并给出稳定 warning', async () => {
  const data = archive();
  data.identity.characterLocator = 'old-character.png';
  const h = harness({ get: async () => envelope(data) });
  const result = await h.adapter.read();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.warnings, ['character_mismatch']);
  assert.equal(result.archive.identity.characterLocator, 'old-character.png');
});

test('create 只用 expectedRevision 0 且不会被调用方后续修改污染', async () => {
  const h = harness();
  const input = archive();
  const pending = h.adapter.create({ archive: input });
  input.identity.personaSummary = '调用后修改';
  const result = await pending;
  assert.equal(result.status, 'created');
  const write = h.calls.find(call => call.op === 'put');
  assert.equal(write.expectedRevision, 0);
  assert.equal(write.collection, `chat-${CHAT}`);
  assert.equal(write.recordId, ARCHIVE_V2_RECORD_ID);
  assert.equal(write.data.identity.personaSummary, 'U');
});

test('save 使用调用方正整数 revision，非法 revision 零请求', async () => {
  const h = harness();
  const saved = await h.adapter.save({ archive: archive(), expectedRevision: 7 });
  assert.equal(saved.status, 'saved');
  assert.equal(h.calls[0].expectedRevision, 7);

  for (const expectedRevision of [undefined, 0, -1, 1.5, '7']) {
    await assert.rejects(
      h.adapter.save({ archive: archive(), expectedRevision }),
      error => error?.code === 'ARCHIVE_V2_REVISION_INVALID',
    );
  }
  assert.equal(h.calls.length, 1);
});

test('409 明确返回 conflict 且不自动重试覆盖', async () => {
  const h = harness({ put: async () => { throw httpError(409); } });
  assert.deepEqual(await h.adapter.save({ archive: archive(), expectedRevision: 3 }), { status: 'conflict' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].expectedRevision, 3);
});

test('invalidate 使已开始任务返回 stale、排队任务零 I/O', async () => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({
    get: async () => {
      markStarted();
      await gate;
      return envelope();
    },
  });
  const first = h.adapter.read();
  const queued = h.adapter.read();
  await started;
  h.adapter.invalidate();
  release();
  assert.deepEqual(await first, { status: 'stale' });
  assert.deepEqual(await queued, { status: 'stale' });
  assert.equal(h.calls.length, 1);
});

test('排队 create 在切聊天后零写入，排队 save 在 invalidate 后零写入', async () => {
  {
    let release;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = harness({ get: async () => { markStarted(); await gate; return envelope(); } });
    const blocker = h.adapter.read();
    const queuedCreate = h.adapter.create({ archive: archive() });
    await started;
    h.setContext({
      hostChatId: 'host-chat-b',
      chatId: OTHER_CHAT,
      characterLocator: 'other-character.png',
      personaLocator: 'other-persona.png',
    });
    release();
    assert.deepEqual(await blocker, { status: 'stale' });
    assert.deepEqual(await queuedCreate, { status: 'stale' });
    assert.equal(h.calls.filter(call => call.op === 'put').length, 0);
  }

  {
    let release;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = harness({ get: async () => { markStarted(); await gate; return envelope(); } });
    const blocker = h.adapter.read();
    const queuedSave = h.adapter.save({ archive: archive(), expectedRevision: 4 });
    await started;
    h.adapter.invalidate();
    release();
    assert.deepEqual(await blocker, { status: 'stale' });
    assert.deepEqual(await queuedSave, { status: 'stale' });
    assert.equal(h.calls.filter(call => call.op === 'put').length, 0);
  }
});

test('已开始写入后宿主上下文变化只返回 stale，并保留捕获路径', async () => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({
    put: async ({ data, expectedRevision }) => {
      markStarted();
      await gate;
      return envelope(data, expectedRevision + 1);
    },
  });
  const pending = h.adapter.save({ archive: archive(), expectedRevision: 5 });
  await started;
  h.setContext({
    hostChatId: 'host-chat-b',
    chatId: OTHER_CHAT,
    characterLocator: 'other-character.png',
    personaLocator: 'other-persona.png',
  });
  release();
  assert.deepEqual(await pending, { status: 'stale' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].collection, `chat-${CHAT}`);
});

test('archive.chatId 与捕获路径不符时 create/save 均零 I/O', async () => {
  const h = harness();
  const wrongChatArchive = archive({ chatId: OTHER_CHAT });
  await assert.rejects(
    h.adapter.create({ archive: wrongChatArchive }),
    error => error?.code === 'ARCHIVE_V2_CHAT_MISMATCH',
  );
  await assert.rejects(
    h.adapter.save({ archive: wrongChatArchive, expectedRevision: 2 }),
    error => error?.code === 'ARCHIVE_V2_CHAT_MISMATCH',
  );
  assert.equal(h.calls.length, 0);
});

test('disabled 时 read/create/save 全部零 I/O', async () => {
  const h = harness({ isEnabled: false });
  assert.deepEqual(await h.adapter.read(), { status: 'disabled' });
  assert.deepEqual(await h.adapter.create({ archive: archive() }), { status: 'disabled' });
  assert.deepEqual(
    await h.adapter.save({ archive: archive(), expectedRevision: 2 }),
    { status: 'disabled' },
  );
  assert.equal(h.calls.length, 0);
});

test('切聊天后的迟到读取只返回 stale，且请求始终使用捕获的 V2 chatId', async () => {
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({
    get: async () => {
      markStarted();
      await gate;
      return envelope();
    },
  });
  const pending = h.adapter.read();
  await started;
  h.setContext({
    hostChatId: 'host-chat-b',
    chatId: OTHER_CHAT,
    characterLocator: 'other-character.png',
    personaLocator: 'other-persona.png',
  });
  release();
  assert.deepEqual(await pending, { status: 'stale' });
  assert.equal(h.calls[0].collection, `chat-${CHAT}`);
});

test('后端返回对象与调用结果互不保留可反向修改的引用', async () => {
  const backendEnvelope = envelope();
  const h = harness({ get: async () => backendEnvelope });
  const result = await h.adapter.read();
  backendEnvelope.data.identity.personaSummary = '后端对象后来改变';
  assert.equal(result.archive.identity.personaSummary, 'U');
  result.archive.people.order.push('external-change');
  assert.deepEqual(backendEnvelope.data.people.order, []);
});
