import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ArchiveV2MemoryRunnerError,
  createArchiveV2MemoryRunner,
} from '../src/archive-v2-memory-runner.js';
import { createArchiveV2MemoryBatchRecordId } from '../src/archive-v2-memory-store.js';
import {
  createArchiveV2MemoryBatch,
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
  validateArchiveV2MemoryManifest,
} from '../src/archive-v2-memory-foundation.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TIME = '2026-08-31T10:20:30.000Z';

const assistant = content => ({
  is_user: false, is_system: false, mes: content, swipe_id: 0, swipes: [content], extra: {},
});

function rawContext(contents = ['正文一', '正文二']) {
  return {
    characterId: 0,
    characters: [{ avatar: 'character.png' }],
    userAvatar: 'persona.png',
    chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
    chat: contents.map(assistant),
  };
}

function identity(overrides = {}) {
  return {
    hostChatId: 'host-chat',
    chatId: CHAT,
    characterLocator: 'character.png',
    personaLocator: 'persona.png',
    ...overrides,
  };
}

const emptyRows = () => ({ people: [], facts: [], relations: [], events: [] });

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('等待异步测试条件超时');
}

async function snapshot(contents = ['正文一', '正文二']) {
  return createArchiveV2MemorySnapshot(rawContext(contents), { maxFloorsPerBatch: 1 });
}

async function partialManifest(source, completed = [], status = 'interrupted') {
  const base = createArchiveV2MemoryManifest({ snapshot: source, scanId: 'scan-fixed', createdAt: TIME });
  const refs = [];
  for (const batchIndex of completed) {
    const plan = source.batches[batchIndex];
    refs.push({
      batchIndex,
      recordId: await createArchiveV2MemoryBatchRecordId({
        scanId: base.scanId,
        batchIndex,
        sourceFingerprint: plan.sourceFingerprint,
      }),
      sourceFingerprint: plan.sourceFingerprint,
    });
  }
  return validateArchiveV2MemoryManifest({
    ...structuredClone(base), completedBatchIndexes: completed, batchRefs: refs, status,
  });
}

function fakeStore({ manifest = null, revision = 1, batches = new Map(), hooks = {} } = {}) {
  let currentManifest = manifest ? structuredClone(manifest) : null;
  let currentRevision = revision;
  const events = [];
  const store = {
    async readManifest() {
      events.push(['readManifest']);
      if (hooks.readManifest) return hooks.readManifest();
      return currentManifest
        ? { status: 'ready', manifest: structuredClone(currentManifest), revision: currentRevision }
        : { status: 'uninitialized' };
    },
    async createManifest({ manifest: value }) {
      events.push(['createManifest', value.status, value.totalBatches]);
      if (hooks.createManifest) return hooks.createManifest(value);
      currentManifest = structuredClone(value);
      currentRevision = 1;
      return { status: 'created', manifest: structuredClone(currentManifest), revision: currentRevision };
    },
    async saveManifest({ manifest: value, expectedRevision }) {
      events.push(['saveManifest', [...value.completedBatchIndexes], value.status, expectedRevision]);
      if (hooks.saveManifest) return hooks.saveManifest(value, expectedRevision);
      currentManifest = structuredClone(value);
      currentRevision += 1;
      return { status: 'saved', manifest: structuredClone(currentManifest), revision: currentRevision };
    },
    async readBatch({ recordId, plan }) {
      events.push(['readBatch', plan.batchIndex]);
      if (hooks.readBatch) return hooks.readBatch(recordId, plan);
      return batches.has(recordId)
        ? { status: 'ready', batch: structuredClone(batches.get(recordId)), revision: 1 }
        : { status: 'missing' };
    },
    async putBatch({ recordId, batch, plan }) {
      events.push(['putBatch', plan.batchIndex]);
      if (hooks.putBatch) return hooks.putBatch(recordId, batch, plan);
      batches.set(recordId, structuredClone(batch));
      return { status: 'saved', batch: structuredClone(batch), revision: 1 };
    },
    invalidate() { events.push(['invalidate']); hooks.invalidate?.(); },
  };
  return {
    store,
    events,
    batches,
    get manifest() { return currentManifest; },
    get revision() { return currentRevision; },
  };
}

function runnerHarness({
  source,
  storeHarness = fakeStore(),
  extract,
  enabled = () => true,
  currentIdentity = identity(),
  contextImpl = null,
  snapshotImpl,
  logger = { warn() {} },
} = {}) {
  let current = currentIdentity;
  const snapshotCalls = [];
  const extractCalls = [];
  let running = 0;
  let maxRunning = 0;
  const extractBatch = async options => {
    extractCalls.push(options.plan.batchIndex);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    try {
      if (extract) return await extract(options);
      return {
        status: 'ready',
        batch: createArchiveV2MemoryBatch({
          manifest: options.manifest, plan: options.plan, rows: emptyRows(), createdAt: options.createdAt,
        }),
      };
    } finally { running -= 1; }
  };
  const snapshotProvider = async options => {
    snapshotCalls.push(options.targetFloor);
    return snapshotImpl ? snapshotImpl(options) : source;
  };
  const runner = createArchiveV2MemoryRunner({
    store: storeHarness.store,
    snapshotProvider,
    extractBatch,
    createScanId: () => 'scan-fixed',
    now: () => TIME,
    contextProvider: () => contextImpl ? contextImpl() : current,
    isEnabled: enabled,
    logger,
  });
  return {
    runner,
    storeHarness,
    snapshotCalls,
    extractCalls,
    get maxRunning() { return maxRunning; },
    setIdentity(value) { current = value; },
  };
}

test('新扫描多批严格串行，逐批 batch→manifest，进度递增并最终 ready', async () => {
  const source = await snapshot(['一', '二', '三']);
  const h = runnerHarness({ source });
  const seenCompleted = [];
  const originalExtract = h.runner;
  void originalExtract;
  const result = await h.runner.start();
  assert.equal(result.status, 'ready');
  assert.deepEqual(h.snapshotCalls, [null]);
  assert.deepEqual(h.extractCalls, [0, 1, 2]);
  assert.equal(h.maxRunning, 1);
  assert.deepEqual(h.runner.getState(), {
    status: 'ready', targetFloor: 2, completedBatches: 3, totalBatches: 3, currentBatchIndex: null,
  });
  const writes = h.storeHarness.events.filter(event => ['putBatch', 'saveManifest'].includes(event[0]));
  assert.deepEqual(writes.map(event => event[0]), [
    'putBatch', 'saveManifest', 'putBatch', 'saveManifest', 'putBatch', 'saveManifest',
  ]);
  assert.deepEqual(writes.filter(event => event[0] === 'saveManifest').map(event => event[1]), [[0], [0, 1], [0, 1, 2]]);
  assert.deepEqual(seenCompleted, []);
});

test('恢复固定首次 targetFloor，已完成跳过，合法 orphan 直接引用且零 AI', async () => {
  const source = await snapshot(['旧一', '旧二']);
  const manifest = await partialManifest(source, [0]);
  const plan = source.batches[1];
  const orphan = createArchiveV2MemoryBatch({ manifest, plan, rows: emptyRows(), createdAt: TIME });
  const orphanId = await createArchiveV2MemoryBatchRecordId({
    scanId: manifest.scanId, batchIndex: 1, sourceFingerprint: plan.sourceFingerprint,
  });
  const batches = new Map([[orphanId, orphan]]);
  const storeHarness = fakeStore({ manifest, batches });
  const h = runnerHarness({ source, storeHarness });
  const result = await h.runner.start();
  assert.equal(result.status, 'ready');
  assert.deepEqual(h.snapshotCalls, [manifest.targetFloor]);
  assert.deepEqual(h.extractCalls, []);
  assert.deepEqual(storeHarness.events.filter(event => event[0] === 'readBatch'), [['readBatch', 1]]);
  assert.equal(storeHarness.events.some(event => event[0] === 'putBatch'), false);
  assert.deepEqual(storeHarness.manifest.completedBatchIndexes, [0, 1]);
});

test('已 ready manifest 不调用 snapshot/AI/PUT', async () => {
  const source = await snapshot(['一']);
  const ready = await partialManifest(source, [0], 'ready');
  const storeHarness = fakeStore({ manifest: ready });
  const h = runnerHarness({ source, storeHarness });
  assert.equal((await h.runner.start()).status, 'ready');
  assert.deepEqual(h.snapshotCalls, []);
  assert.deepEqual(h.extractCalls, []);
  assert.equal(storeHarness.events.some(event => event[0] === 'putBatch' || event[0] === 'saveManifest'), false);
});

test('批次引用已齐但状态仍 interrupted 时只用 CAS 收口 ready', async () => {
  const source = await snapshot(['一']);
  const interrupted = await partialManifest(source, [0], 'interrupted');
  const storeHarness = fakeStore({ manifest: interrupted });
  const h = runnerHarness({ source, storeHarness });
  assert.equal((await h.runner.start()).status, 'ready');
  assert.deepEqual(h.extractCalls, []);
  assert.equal(storeHarness.events.some(event => event[0] === 'readBatch' || event[0] === 'putBatch'), false);
  assert.equal(storeHarness.events.filter(event => event[0] === 'saveManifest').length, 1);
  assert.equal(storeHarness.manifest.status, 'ready');
});

test('恢复时 source/target/批数变化返回 source_changed，零 AI 零写且旧 manifest 保留', async () => {
  const source = await snapshot(['一', '二']);
  const manifest = await partialManifest(source);
  const variants = [
    { ...structuredClone(source), sourceFingerprint: `sha256:${'f'.repeat(64)}` },
    { ...structuredClone(source), targetFloor: source.targetFloor + 1 },
    { ...structuredClone(source), batches: source.batches.slice(0, 1) },
    { ...structuredClone(source), batchSize: source.batchSize + 1 },
  ];
  for (const changed of variants) {
    const storeHarness = fakeStore({ manifest });
    const before = structuredClone(storeHarness.manifest);
    const h = runnerHarness({ source: changed, storeHarness });
    assert.equal((await h.runner.start()).status, 'source_changed');
    assert.deepEqual(h.extractCalls, []);
    assert.equal(storeHarness.events.some(event => event[0] === 'putBatch' || event[0] === 'saveManifest'), false);
    assert.deepEqual(storeHarness.manifest, before);
  }
});

test('zero-batch 初始化后直接 CAS ready，不调用 AI/batch PUT', async () => {
  const source = await snapshot([]);
  const h = runnerHarness({ source });
  const result = await h.runner.start();
  assert.deepEqual(result, {
    status: 'ready', targetFloor: -1, completedBatches: 0, totalBatches: 0, currentBatchIndex: null,
  });
  assert.deepEqual(h.extractCalls, []);
  assert.equal(h.storeHarness.events.some(event => event[0] === 'putBatch'), false);
  assert.deepEqual(h.storeHarness.events.filter(event => event[0] === 'saveManifest').map(event => event[3]), [1]);
  assert.equal(h.storeHarness.manifest.status, 'ready');
});

test('extractor failure 不写 batch/完成状态；batch 与 manifest conflict 都立即停止', async () => {
  const source = await snapshot(['一']);
  const manifest = await partialManifest(source);
  const failedStore = fakeStore({ manifest });
  const failed = runnerHarness({
    source,
    storeHarness: failedStore,
    extract: async () => { throw new Error('正文和 SECRET'); },
  });
  await assert.rejects(failed.runner.start(), error => error instanceof ArchiveV2MemoryRunnerError);
  assert.equal(failedStore.events.some(event => event[0] === 'putBatch' || event[0] === 'saveManifest'), false);

  const batchConflictStore = fakeStore({ manifest, hooks: { putBatch: async () => ({ status: 'conflict' }) } });
  const batchConflict = runnerHarness({ source, storeHarness: batchConflictStore });
  assert.equal((await batchConflict.runner.start()).status, 'conflict');
  assert.equal(batchConflictStore.events.some(event => event[0] === 'saveManifest'), false);

  const manifestConflictStore = fakeStore({ manifest, hooks: { saveManifest: async () => ({ status: 'conflict' }) } });
  const manifestConflict = runnerHarness({ source, storeHarness: manifestConflictStore });
  assert.equal((await manifestConflict.runner.start()).status, 'conflict');
  assert.equal(manifestConflictStore.events.filter(event => event[0] === 'putBatch').length, 1);
});

test('失败诊断只记录白名单内部 code 或固定 fallback，不泄露异常正文、密钥、URL、请求体与堆栈', async () => {
  const source = await snapshot(['不能进入诊断的正文']);
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args) };
  const external = new Error('SECRET_BODY apiKey=sk-private https://private.example request body');
  external.name = 'SecretNetworkFailure';
  external.code = 'SECRET_REMOTE_CODE';
  external.stack = 'SECRET_STACK request body prompt';
  const failed = runnerHarness({
    source,
    logger,
    extract: async () => { throw external; },
  });
  await assert.rejects(failed.runner.start(), error => {
    assert.equal(error.code, 'ARCHIVE_V2_MEMORY_RUNNER_FAILED');
    return true;
  });
  assert.deepEqual(warnings, [[
    '[ST-QianQianJie] archive-v2 memory scan failed',
    { code: 'ARCHIVE_V2_MEMORY_RUNNER_FAILED' },
  ]]);

  const internal = runnerHarness({
    source,
    logger,
    storeHarness: fakeStore({ hooks: { readManifest: async () => ({ status: 'private-invalid' }) } }),
  });
  await assert.rejects(internal.runner.start(), error => {
    assert.equal(error.code, 'ARCHIVE_V2_MEMORY_RUNNER_STORE_INVALID');
    return true;
  });
  assert.deepEqual(warnings[1], [
    '[ST-QianQianJie] archive-v2 memory scan failed',
    { code: 'ARCHIVE_V2_MEMORY_RUNNER_STORE_INVALID' },
  ]);

  const forged = runnerHarness({
    source,
    logger,
    extract: async () => {
      throw new ArchiveV2MemoryRunnerError(
        'SECRET forged message',
        'ARCHIVE_V2_MEMORY_RUNNER_SECRET_API_KEY',
      );
    },
  });
  await assert.rejects(forged.runner.start(), error => {
    assert.equal(error.code, 'ARCHIVE_V2_MEMORY_RUNNER_FAILED');
    assert.equal(error.message, '后台记忆扫描失败');
    return true;
  });
  assert.deepEqual(warnings[2], [
    '[ST-QianQianJie] archive-v2 memory scan failed',
    { code: 'ARCHIVE_V2_MEMORY_RUNNER_FAILED' },
  ]);
  const serialized = JSON.stringify(warnings);
  assert.doesNotMatch(serialized, /不能进入诊断的正文|SECRET|sk-private|private\.example|request body|prompt|stack|message/i);
});

test('preflight context 恶意根因统一安全包装、进入 error 且不泄露原始异常', async () => {
  const source = await snapshot(['不能进入 preflight 诊断的正文']);
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args) };
  const malicious = new ArchiveV2MemoryRunnerError(
    'SECRET_BODY apiKey=sk-preflight https://private.example request body',
    'ARCHIVE_V2_MEMORY_RUNNER_CONTEXT_INVALID',
  );
  malicious.name = 'SecretPreflightFailure';
  malicious.stack = 'SECRET_STACK prompt /private/key';
  malicious.cause = { message: 'SECRET_CAUSE request body' };
  const h = runnerHarness({
    source,
    logger,
    contextImpl: () => { throw malicious; },
  });

  await assert.rejects(h.runner.start(), error => {
    assert.notEqual(error, malicious);
    assert.equal(error.name, 'ArchiveV2MemoryRunnerError');
    assert.equal(error.code, 'ARCHIVE_V2_MEMORY_RUNNER_CONTEXT_INVALID');
    assert.equal(error.message, '后台记忆扫描失败');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(
      JSON.stringify({ name: error.name, code: error.code, message: error.message, stack: error.stack }),
      /SECRET|sk-preflight|private\.example|request body|prompt|private\/key/i,
    );
    return true;
  });
  assert.equal(h.runner.getState().status, 'error');
  assert.deepEqual(h.storeHarness.events, []);
  assert.deepEqual(h.snapshotCalls, []);
  assert.deepEqual(warnings, [[
    '[ST-QianQianJie] archive-v2 memory scan failed',
    { code: 'ARCHIVE_V2_MEMORY_RUNNER_CONTEXT_INVALID' },
  ]]);
  assert.doesNotMatch(JSON.stringify(warnings), /SECRET|sk-preflight|private\.example|request body|prompt|stack|message/i);
});

test('同一实例并发 start 复用同一 promise，external abort 中止且后续零写', async () => {
  const source = await snapshot(['一']);
  let release;
  const storeHarness = fakeStore({ hooks: {
    readManifest: () => new Promise(resolve => { release = () => resolve({ status: 'uninitialized' }); }),
  } });
  const h = runnerHarness({ source, storeHarness });
  const first = h.runner.start();
  const second = h.runner.start();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.equal((await first).status, 'ready');
  assert.equal(storeHarness.events.filter(event => event[0] === 'readManifest').length, 1);

  let extractRelease;
  let seenSignal;
  const manifest = await partialManifest(source);
  const abortStore = fakeStore({ manifest });
  const aborted = runnerHarness({
    source,
    storeHarness: abortStore,
    extract: options => {
      seenSignal = options.signal;
      return new Promise(resolve => { extractRelease = () => resolve({ status: 'ready', batch: createArchiveV2MemoryBatch({
        manifest: options.manifest, plan: options.plan, rows: emptyRows(), createdAt: options.createdAt,
      }) }); });
    },
  });
  const controller = new AbortController();
  const pending = aborted.runner.start({ signal: controller.signal });
  await waitUntil(() => typeof extractRelease === 'function');
  controller.abort();
  assert.equal(seenSignal.aborted, true);
  extractRelease();
  assert.equal((await pending).status, 'stale');
  assert.equal(abortStore.events.some(event => event[0] === 'putBatch' || event[0] === 'saveManifest'), false);
});

test('切 chat/character/persona、disabled 与迟到成功均停止；batch 已 PUT 后切 chat 不写 manifest', async () => {
  const source = await snapshot(['一']);
  const manifest = await partialManifest(source);
  for (const mode of ['chat', 'character', 'persona', 'disabled']) {
    let enabled = true;
    let release;
    let h;
    const storeHarness = fakeStore({ manifest });
    h = runnerHarness({
      source,
      storeHarness,
      enabled: () => enabled,
      extract: options => new Promise(resolve => { release = () => resolve({
        status: 'ready',
        batch: createArchiveV2MemoryBatch({
          manifest: options.manifest, plan: options.plan, rows: emptyRows(), createdAt: options.createdAt,
        }),
      }); }),
    });
    const pending = h.runner.start();
    await waitUntil(() => typeof release === 'function');
    if (mode === 'chat') h.setIdentity(identity({ hostChatId: 'host-other', chatId: OTHER_CHAT }));
    if (mode === 'character') h.setIdentity(identity({ characterLocator: 'other.png' }));
    if (mode === 'persona') h.setIdentity(identity({ personaLocator: 'other.png' }));
    if (mode === 'disabled') enabled = false;
    release();
    assert.equal((await pending).status, mode === 'disabled' ? 'disabled' : 'stale');
    assert.equal(storeHarness.events.some(event => event[0] === 'putBatch' || event[0] === 'saveManifest'), false);
  }

  let late;
  const lateStore = fakeStore({ manifest, hooks: {
    putBatch: async (_recordId, batch) => {
      late.setIdentity(identity({ hostChatId: 'host-other', chatId: OTHER_CHAT }));
      return { status: 'saved', batch, revision: 1 };
    },
  } });
  late = runnerHarness({ source, storeHarness: lateStore });
  assert.equal((await late.runner.start()).status, 'stale');
  assert.equal(lateStore.events.filter(event => event[0] === 'putBatch').length, 1);
  assert.equal(lateStore.events.some(event => event[0] === 'saveManifest'), false);
});

test('公开状态不含正文/metadata，返回对象只读且外部改写不污染内部', async () => {
  const source = await snapshot(['绝密正文']);
  const h = runnerHarness({ source });
  await h.runner.start();
  const state = h.runner.getState();
  assert.deepEqual(Object.keys(state), [
    'status', 'targetFloor', 'completedBatches', 'totalBatches', 'currentBatchIndex',
  ]);
  assert.equal(JSON.stringify(state).includes('绝密正文'), false);
  assert.equal(JSON.stringify(state).includes('metadata'), false);
  assert.throws(() => { state.status = 'idle'; }, TypeError);
  assert.equal(h.runner.getState().status, 'ready');
});

test('runner 源码无 DOM/UI、专用后端、正式 archive 写入或内部 AI 重试', async () => {
  const source = await readFile(new URL('../src/archive-v2-memory-runner.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /document\.|querySelector|innerHTML|backend-client|formal-storage|archiveAdapter|saveArchive|setTimeout|retry/i);
});
