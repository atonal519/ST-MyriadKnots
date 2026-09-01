import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_V2_RECORD_ID,
  createArchiveV2Adapter,
  createEmptyArchiveV2,
} from '../src/archive-v2.js';
import {
  ArchiveV2InitializationCommitError,
  createArchiveV2InitializationCommitter,
} from '../src/archive-v2-initialization-commit.js';

const CHAT = '11111111-1111-4111-8111-111111111111';

function archive(overrides = {}) {
  const value = createEmptyArchiveV2({
    chatId: CHAT,
    characterLocator: 'char.png',
    personaLocator: 'persona.png',
    personaSummary: '初始摘要',
  });
  return { ...value, ...overrides };
}

function ready(status, value = archive(), revision = 1, warnings = []) {
  return { status, archive: value, revision, warnings };
}

test('未初始化时严格 read 一次、create 一次并返回 created', async () => {
  const calls = [];
  const committer = createArchiveV2InitializationCommitter({
    archiveAdapter: {
      read: async () => { calls.push('read'); return { status: 'uninitialized' }; },
      create: async ({ archive: input }) => { calls.push('create'); return ready('created', input); },
    },
  });
  const result = await committer.commit({ archive: archive() });
  assert.equal(result.status, 'created');
  assert.deepEqual(calls, ['read', 'create']);
});

test('已有档案返回 already_initialized，create/save 均为零', async () => {
  const existing = archive();
  let reads = 0; let creates = 0; let saves = 0;
  const committer = createArchiveV2InitializationCommitter({
    archiveAdapter: {
      read: async () => { reads += 1; return ready('ready', existing, 8, ['persona_mismatch']); },
      create: async () => { creates += 1; throw new Error('不应调用'); },
      save: async () => { saves += 1; throw new Error('不应调用'); },
    },
  });
  const result = await committer.commit({ archive: archive() });
  assert.deepEqual(result, {
    status: 'already_initialized', archive: existing, revision: 8, warnings: ['persona_mismatch'],
  });
  assert.equal(reads, 1); assert.equal(creates, 0); assert.equal(saves, 0);
});

test('create conflict 原样返回且不重读、不重试、不 save', async () => {
  let reads = 0; let creates = 0; let saves = 0;
  const committer = createArchiveV2InitializationCommitter({
    archiveAdapter: {
      read: async () => { reads += 1; return { status: 'uninitialized' }; },
      create: async () => { creates += 1; return { status: 'conflict' }; },
      save: async () => { saves += 1; },
    },
  });
  assert.deepEqual(await committer.commit({ archive: archive() }), { status: 'conflict' });
  assert.equal(reads, 1); assert.equal(creates, 1); assert.equal(saves, 0);
});

test('read stale 或 disabled 直接返回且不 create', async () => {
  for (const status of ['stale', 'disabled']) {
    let creates = 0;
    const committer = createArchiveV2InitializationCommitter({
      archiveAdapter: {
        read: async () => ({ status }),
        create: async () => { creates += 1; throw new Error('不应调用'); },
      },
    });
    assert.deepEqual(await committer.commit({ archive: archive() }), { status });
    assert.equal(creates, 0);
  }
});

test('create stale 或 disabled 原状态返回', async () => {
  for (const status of ['stale', 'disabled']) {
    let reads = 0; let creates = 0;
    const committer = createArchiveV2InitializationCommitter({
      archiveAdapter: {
        read: async () => { reads += 1; return { status: 'uninitialized' }; },
        create: async () => { creates += 1; return { status }; },
      },
    });
    assert.deepEqual(await committer.commit({ archive: archive() }), { status });
    assert.equal(reads, 1); assert.equal(creates, 1);
  }
});

test('非法 archive 在 read 前失败且后端调用为零', async () => {
  let reads = 0; let creates = 0;
  const committer = createArchiveV2InitializationCommitter({
    archiveAdapter: {
      read: async () => { reads += 1; return { status: 'uninitialized' }; },
      create: async () => { creates += 1; return { status: 'created' }; },
    },
  });
  const blankChat = archive(); blankChat.chatId = '   ';
  const unknown = { ...archive(), loading: true };
  const cyclic = archive(); cyclic.events.push(cyclic);
  for (const value of [null, blankChat, unknown, cyclic]) {
    await assert.rejects(
      committer.commit({ archive: value }),
      ArchiveV2InitializationCommitError,
    );
  }
  assert.equal(reads, 0); assert.equal(creates, 0);
});

test('adapter 缺少 read 或 create 时构造失败', () => {
  for (const archiveAdapter of [undefined, {}, { read() {} }, { create() {} }]) {
    assert.throws(() => createArchiveV2InitializationCommitter({ archiveAdapter }), TypeError);
  }
});

test('read/create 未知、空、畸形状态都以合同错误拒绝', async () => {
  const badReadResults = [
    null,
    {},
    { status: 'mystery' },
    { status: 'uninitialized', extra: true },
    { status: 'ready', archive: archive(), revision: 1 },
    { status: 'ready', archive: archive(), revision: 0, warnings: [] },
  ];
  for (const result of badReadResults) {
    let creates = 0;
    const committer = createArchiveV2InitializationCommitter({
      archiveAdapter: {
        read: async () => result,
        create: async () => { creates += 1; return { status: 'created' }; },
      },
    });
    await assert.rejects(
      committer.commit({ archive: archive() }),
      error => error?.code === 'ARCHIVE_V2_INITIALIZATION_COMMIT_CONTRACT',
    );
    assert.equal(creates, 0);
  }
  const badCreateResults = [
    null,
    { status: 'mystery' },
    { status: 'conflict', extra: true },
    { status: 'created', archive: archive(), revision: 0, warnings: [] },
    { status: 'created', archive: archive(), revision: 1, warnings: [1] },
  ];
  for (const result of badCreateResults) {
    const committer = createArchiveV2InitializationCommitter({
      archiveAdapter: {
        read: async () => ({ status: 'uninitialized' }),
        create: async () => result,
      },
    });
    await assert.rejects(
      committer.commit({ archive: archive() }),
      error => error?.code === 'ARCHIVE_V2_INITIALIZATION_COMMIT_CONTRACT',
    );
  }
});

test('并发 commit 共享严格相同 Promise 且只 read/create 各一次', async () => {
  let release; let reads = 0; let creates = 0;
  const committer = createArchiveV2InitializationCommitter({
    archiveAdapter: {
      read: async () => {
        reads += 1;
        await new Promise(resolve => { release = resolve; });
        return { status: 'uninitialized' };
      },
      create: async ({ archive: value }) => { creates += 1; return ready('created', value); },
    },
  });
  const first = committer.commit({ archive: archive() });
  const second = committer.commit({ archive: archive() });
  assert.equal(first, second);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); release();
  assert.equal((await first).status, 'created');
  assert.equal(creates, 1);
});

test('settled 后再次 commit 会重新 read 当前状态', async () => {
  let reads = 0; let creates = 0; let stored;
  const committer = createArchiveV2InitializationCommitter({
    archiveAdapter: {
      read: async () => {
        reads += 1;
        return stored ? ready('ready', stored, 1) : { status: 'uninitialized' };
      },
      create: async ({ archive: value }) => {
        creates += 1; stored = value; return ready('created', value);
      },
    },
  });
  assert.equal((await committer.commit({ archive: archive() })).status, 'created');
  assert.equal((await committer.commit({ archive: archive() })).status, 'already_initialized');
  assert.equal(reads, 2); assert.equal(creates, 1);
});

test('调用后修改输入不影响传给 create 的安全快照', async () => {
  let release; let received;
  const input = archive();
  const committer = createArchiveV2InitializationCommitter({
    archiveAdapter: {
      read: async () => {
        await new Promise(resolve => { release = resolve; });
        return { status: 'uninitialized' };
      },
      create: async ({ archive: value }) => { received = value; return ready('created', value); },
    },
  });
  const pending = committer.commit({ archive: input });
  input.identity.personaSummary = '调用后篡改';
  input.events.push({ changed: true });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(); await pending;
  assert.equal(received.identity.personaSummary, '初始摘要');
  assert.deepEqual(received.events, []);
});

test('ready 与 created 返回值均不泄漏 adapter 内部可变引用', async () => {
  const existing = archive();
  const readWarnings = ['persona_mismatch'];
  const fromRead = createArchiveV2InitializationCommitter({
    archiveAdapter: {
      read: async () => ready('ready', existing, 2, readWarnings),
      create: async () => { throw new Error('不应调用'); },
    },
  });
  const readResult = await fromRead.commit({ archive: archive() });
  readResult.archive.identity.personaSummary = '外部改写';
  readResult.warnings.push('extra');
  assert.equal(existing.identity.personaSummary, '初始摘要');
  assert.deepEqual(readWarnings, ['persona_mismatch']);

  const created = archive();
  const createWarnings = ['character_mismatch'];
  const fromCreate = createArchiveV2InitializationCommitter({
    archiveAdapter: {
      read: async () => ({ status: 'uninitialized' }),
      create: async () => ready('created', created, 3, createWarnings),
    },
  });
  const createResult = await fromCreate.commit({ archive: archive() });
  createResult.archive.identity.personaSummary = '外部改写';
  createResult.warnings.push('extra');
  assert.equal(created.identity.personaSummary, '初始摘要');
  assert.deepEqual(createWarnings, ['character_mismatch']);
});

test('现有真实 adapter 加假 client 使用 archive-v2、revision 0 且无覆盖路径', async () => {
  const gets = []; const puts = [];
  const client = {
    async get(...args) {
      gets.push(args);
      const error = new Error('not found'); error.status = 404; throw error;
    },
    async put(...args) {
      puts.push(args);
      return { data: args[2], revision: 1 };
    },
  };
  const contextProvider = () => ({
    hostChatId: 'host-chat',
    chatId: CHAT,
    characterLocator: 'char.png',
    personaLocator: 'persona.png',
  });
  const archiveAdapter = createArchiveV2Adapter({ client, contextProvider });
  const committer = createArchiveV2InitializationCommitter({ archiveAdapter });
  const result = await committer.commit({ archive: archive() });
  assert.equal(result.status, 'created');
  assert.deepEqual(gets, [[`chat-${CHAT}`, ARCHIVE_V2_RECORD_ID]]);
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], `chat-${CHAT}`);
  assert.equal(puts[0][1], ARCHIVE_V2_RECORD_ID);
  assert.equal(puts[0][3], 0);
});
