import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTransfer, parseMemoryPackage, transferWitness } from '../src/memory-transfer.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createChatSession } from '../src/chat-session.js';
import { createChatIdentityCoordinator } from '../src/chat-identity.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import { sha256 } from '../src/identity.js';
import { stableJson } from '../src/memory-transfer-json.js';
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
    async list(collection) { return [...records].filter(([key]) => key.startsWith(`${collection}/`)).map(([key, value]) => ({ recordId: key.slice(collection.length + 1), ...envelope(value.data, value.revision) })); },
    async get(collection, key) {
      calls.push(['get', collection, key]);
      const value = records.get(`${collection}/${key}`);
      if (!value) throw failure(404);
      return envelope(value.data, value.revision);
    },
    async getMany(collection, recordIds) {
      calls.push(['getMany', collection, recordIds]);
      return recordIds.map(recordId => {
        const value = records.get(`${collection}/${recordId}`);
        return value ? { recordId, status: 200, envelope: envelope(value.data, value.revision) }
          : { recordId, status: 404 };
      });
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

const TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IMPORTED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function fixture({ excluded = false } = {}) {
  const backend = backendHarness();
  const ctx = context('old-chat', SOURCE, [user('旧档开场'), assistant('她把钥匙放进木盒。'), user('继续'), assistant('最新一楼'), user('钥匙呢？')]);
  if (excluded) ctx.chat[3].extra = { qianqianjie_memory_excluded: true };
  let selected = ctx;
  const host = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => selected } } });
  const store = createFoundationStore({ client: backend.client, contextProvider: () => identity(ctx.chatId, SOURCE) });
  const foundation = createFoundationRuntime({ hostAdapter: host, store, contextProvider: () => ctx, newUuid: uuidFactory(), logger: { warn() {} } });
  await foundation.start();
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => ({ jsonData: { noMaterialChange: true } }),
    generateUtilityTask: async options => ({ jsonData: options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { summary: '钥匙在木盒里。' } : { noMaterialChange: true } }) });
  await memory.start();
  await memory.extractFloor(memory.getState().floors[0].floorId, { analyzeState: false });
  await memory.analyzeNextState();
  const graph = await store.readReachable({ mode: 'full' });
  const coordinator = createChatIdentityCoordinator({ client: backend.client });
  await backend.client.put('chat-identity-bindings', `binding-${SOURCE}`, { schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: SOURCE,
    owner: { hostChatId: ctx.chatId, characterLocator: 'character.png', personaLocator: 'persona.png' }, state: 'ready', sourceChatId: null, createdAt: NOW, updatedAt: NOW }, 0);
  // A real session checks the new binding on import; no mocked identity acceptance.
  const session = createChatSession({ contextProvider: () => selected, identityCoordinator: coordinator });
  await session.prepare();
  let api = targetChatApi(selected);
  const runtime = createMemoryTransfer({ client: backend.client, session, hostAdapter: host, freshUuid: () => IMPORTED,
    fetchImpl: (...args) => api.fetch(...args), onSettled: async () => { session.invalidate(); await session.prepare(); } });
  const exported = await runtime.exportCurrent();
  return { backend, ctx, host, graph, runtime, exported, session,
    async target({ changed = false } = {}) {
      selected = context('imported-chat', TARGET, structuredClone(ctx.chat), 'updated-avatar.png');
      selected.name2 = '新版角色'; selected.characters[0].name = '新版角色'; selected.characters[0].data.description = '作者更新后的设定';
      if (changed) selected.chat[1].mes = '改写的正文';
      await session.prepare(); api = targetChatApi(selected); return selected;
    }, get api() { return api; }, setApi(value) { api = value; }, select(value) { selected = value; },
  };
}

test('real memory and CSE round trip onto an updated card, without analysis calls or original writes', async () => {
  const f = await fixture(), target = await f.target();
  const original = JSON.stringify([...f.backend.records].filter(([key]) => key.startsWith(`chat-${SOURCE}/`)));
  const plan = await f.runtime.preview(f.exported.text);
  assert.equal(plan.summaries, 1); assert.equal(plan.states, 1);
  assert.equal(f.api.saves, 0);
  await f.runtime.importPreview(plan);
  assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
  assert.deepEqual(f.api.persistedHeader.chat_metadata.qianqianjie.file, target.chatMetadata.qianqianjie.file);
  assert.equal(f.session.identity().chatId, IMPORTED);
  assert.equal(JSON.stringify([...f.backend.records].filter(([key]) => key.startsWith(`chat-${SOURCE}/`))), original);
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await foundation.start()).status, 'ready');
  const restored = await store.readReachable({ mode: 'full' });
  assert.deepEqual(restored.floorMemories.map(item => item.summary), f.graph.floorMemories.map(item => item.summary));
  assert.equal(restored.stateDeltas.length, f.graph.stateDeltas.length);
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => assert.fail('must not reanalyze'), generateUtilityTask: async () => assert.fail('must not resummarize') });
  await memory.start();
  assert.equal(memory.getState().rememberedCount, 1);
  await f.runtime.undo();
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  assert.ok(f.backend.records.has(`chat-${IMPORTED}/v3-root`), 'undo preserves imported memory too');
});

test('tampering, missing graph records, incompatible chat and consumed previews are rejected', async () => {
  const f = await fixture(); await f.target({ changed: true });
  await assert.rejects(f.runtime.preview(f.exported.text), /当前聊天与记忆包不一致/);
  const damaged = JSON.parse(f.exported.text); damaged.prequel = 'tampered';
  await assert.rejects(parseMemoryPackage(damaged), /完整性/);
  damaged.records = damaged.records.filter(item => item.data.recordType !== 'floorMemory');
  const { checksum, ...payload } = damaged; damaged.checksum = await sha256(stableJson(payload));
  await assert.rejects(parseMemoryPackage(damaged));
  const target = await f.target(); const plan = await f.runtime.preview(f.exported.text);
  target.chat.push(user('new message'));
  await assert.rejects(f.runtime.importPreview(plan), /有变化/);
  assert.equal(f.api.saves, 0);
  await assert.rejects(f.runtime.importPreview(plan), /预览已失效/);
});

test('staging failure and a chat switch never publish over the old or another chat', async () => {
  const f = await fixture(); const target = await f.target();
  const plan = await f.runtime.preview(f.exported.text), put = f.backend.client.put;
  f.backend.client.put = async (...args) => { if (args[0] === `chat-${IMPORTED}`) throw new Error('disk full'); return put(...args); };
  await assert.rejects(f.runtime.importPreview(plan), /disk full/);
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET); assert.equal(f.api.saves, 0);
  f.backend.client.put = put;
  const next = await f.runtime.preview(f.exported.text);
  f.backend.client.put = async (...args) => {
    const result = await put(...args); f.select(context('other', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', [assistant('other')])); return result;
  };
  await assert.rejects(f.runtime.importPreview(next), /切换/); assert.equal(f.api.saves, 0);
});


test('undo refuses changed conversation and export excludes settings and credentials', async () => {
  const f = await fixture();
  await f.backend.client.put(`chat-${SOURCE}`, 'unrelated-api-settings', { key: 'SECRET' }, 0);
  const file = await f.runtime.exportCurrent(); assert.ok(!file.text.includes('SECRET'));
  const target = await f.target(); await f.runtime.importPreview(await f.runtime.preview(file.text));
  target.chat.push(user('new story'));
  await assert.rejects(f.runtime.undo(), /继续聊天/);
  assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
});

test('host save failure leaves the previous identity and source collection untouched', async () => {
  const f = await fixture(), target = await f.target(), api = f.api;
  const plan = await f.runtime.preview(f.exported.text);
  f.setApi({ fetch: (url, options) => url === '/api/chats/save' ? Promise.resolve({ ok: false, status: 409 }) : api.fetch(url, options) });
  await assert.rejects(f.runtime.importPreview(plan), /聊天文件未能保存/);
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  assert.equal(api.persistedHeader.chat_metadata.qianqianjie.chatId, TARGET);
  assert.ok(f.backend.records.has(`chat-${SOURCE}/v3-root`));
});

test('switching while host save completes publishes only to the captured file', async () => {
  const f = await fixture(), target = await f.target();
  const other = context('other', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', [assistant('other')]);
  const api = targetChatApi(target, { afterSave: () => f.select(other) }); f.setApi(api);
  const result = await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  assert.equal(result.reload, true); assert.equal(api.persistedHeader.chat_metadata.qianqianjie.chatId, IMPORTED);
  assert.equal(other.chat[0].mes, 'other'); assert.notEqual(other.chatMetadata.qianqianjie.chatId, IMPORTED);
});

test('hidden messages, local time records, vector cache and arbitrary non-QQJ metadata survive transfer', async () => {
  const f = await fixture();
  f.ctx.chat[1].is_system = true; f.ctx.chat[1].extra ??= {}; f.ctx.chat[1].extra.qianqianjieAutoHide = { schemaVersion: 1, chatId: SOURCE };
  f.ctx.chat[1].extra.variables = { home: 'new home' }; f.ctx.chatMetadata.otherPlugin = { enabled: true };
  await f.backend.client.put(`chat-${SOURCE}`, 'v3-time-head', { schemaVersion: 1, chatId: SOURCE, batchIds: [], bodyStart: 0 }, 0);
  await f.backend.client.put(`chat-${SOURCE}`, 'qqj-vector-index', { schemaVersion: 1, recordType: 'vectorCache', chatId: SOURCE,
    narrativeGeneration: f.graph.root.narrativeGeneration, modelKey: `sha256:${'a'.repeat(64)}`, dimensions: 1024, shardIds: [], chunkCount: 0 }, 0);
  const file = await f.runtime.exportCurrent(); const target = await f.target();
  target.chatMetadata.otherPlugin = { targetValue: true }; f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(file.text));
  assert.equal(target.chat[1].is_system, true); assert.equal(target.chat[1].extra.qianqianjieAutoHide.chatId, IMPORTED);
  assert.deepEqual(target.chat[1].extra.variables, { home: 'new home' }); assert.deepEqual(target.chatMetadata.otherPlugin, { targetValue: true });
  assert.equal(f.backend.records.get(`chat-${IMPORTED}/v3-time-head`).data.chatId, IMPORTED);
  assert.equal(f.backend.records.get(`chat-${IMPORTED}/qqj-vector-index`).data.modelKey, `sha256:${'a'.repeat(64)}`);
});

test('staging preserves unrelated live metadata, variables and unselected replies', async () => {
  const f = await fixture(), target = await f.target();
  target.chat[1].swipes.push('old unselected reply');
  target.chat[1].swipe_info = [{ extra: { variables: { before: true } } }, { extra: { pocketPhone: { before: true } } }];
  f.api.reloadFromContext();
  const plan = await f.runtime.preview(f.exported.text), put = f.backend.client.put;
  let changed = false;
  f.backend.client.put = async (...args) => {
    const result = await put(...args);
    if (!changed && args[0] === `chat-${IMPORTED}` && args[1] !== 'v3-root') {
      changed = true;
      target.chatMetadata.otherPlugin = { duringStaging: true };
      target.chatMetadata.pocketPhone = { unread: 4 };
      target.chatMetadata.integrity = 'latest-staging-integrity';
      target.chat[1].extra ??= {}; target.chat[1].extra.variables = { duringStaging: true };
      target.chat[1].swipes[1] = 'new unselected reply';
      target.chat[1].swipe_info[1].extra.pocketPhone = { duringStaging: true };
      f.api.reloadFromContext();
    }
    return result;
  };
  const result = await f.runtime.importPreview(plan);
  assert.equal(result.reload, false); assert.equal(changed, true);
  assert.deepEqual(f.api.persistedHeader.chat_metadata.otherPlugin, { duringStaging: true });
  assert.deepEqual(target.chatMetadata.pocketPhone, { unread: 4 });
  assert.deepEqual(f.api.persistedMessages[1].extra.variables, { duringStaging: true });
  assert.equal(f.api.persistedMessages[1].swipes[1], 'new unselected reply');
  assert.deepEqual(target.chat[1].swipe_info[1].extra.pocketPhone, { duringStaging: true });
});

test('publish merges QQJ into latest file and preserves fields created in live state while saving', async () => {
  const f = await fixture(), target = await f.target(); let gets = 0;
  const api = targetChatApi(target, {
    beforeGet({ header, messages }) {
      if (++gets !== 2) return;
      header.chat_metadata.otherPlugin = { diskOnly: true };
      header.chat_metadata.integrity = 'latest-file-integrity';
      header.unrelatedHeader = 'disk header';
      messages[1].extra ??= {}; messages[1].extra.diskOnly = { retained: true };
      messages[1].swipes.push('disk unselected');
      messages[1].swipe_info = [{ extra: { diskVariable: 1 } }, { extra: { diskVariable: 2 } }];
    },
    afterSave() {
      target.chatMetadata.pocketPhone = { createdWhileSaving: true };
      target.chat[1].extra ??= {}; target.chat[1].extra.liveOnly = { createdWhileSaving: true };
      target.chat[1].swipe_info = [{ extra: { liveVariable: true } }];
    },
  });
  f.setApi(api);
  const result = await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  assert.equal(result.reload, false); assert.equal(api.saves, 1);
  assert.deepEqual(api.persistedHeader.chat_metadata.otherPlugin, { diskOnly: true });
  assert.equal(api.persistedHeader.unrelatedHeader, 'disk header');
  assert.deepEqual(api.persistedMessages[1].extra.diskOnly, { retained: true });
  assert.equal(api.persistedMessages[1].swipes[1], 'disk unselected');
  assert.deepEqual(api.persistedMessages[1].swipe_info[1].extra, { diskVariable: 2 });
  assert.deepEqual(target.chatMetadata.pocketPhone, { createdWhileSaving: true });
  assert.deepEqual(target.chat[1].extra.liveOnly, { createdWhileSaving: true });
  assert.deepEqual(target.chat[1].swipe_info[0].extra, { liveVariable: true });
  assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
});

test('staging still rejects changed body, selected reply and QQJ ownership', async t => {
  for (const change of ['body', 'selected', 'selectedSameText', 'anchor', 'qqjHeader']) await t.test(change, async () => {
    const f = await fixture(), target = await f.target(), plan = await f.runtime.preview(f.exported.text), put = f.backend.client.put;
    let changed = false;
    f.backend.client.put = async (...args) => {
      const result = await put(...args);
      if (!changed && args[0] === `chat-${IMPORTED}` && args[1] !== 'v3-root') {
        changed = true;
        if (change === 'body') target.chat[1].mes = 'changed story';
        if (change.startsWith('selected')) { target.chat[1].swipes.push(change === 'selected' ? 'changed selected reply' : target.chat[1].mes); target.chat[1].swipe_id = 1; }
        if (change === 'anchor') { target.chat[1].extra ??= {}; target.chat[1].extra.qianqianjie_floor = { schemaVersion: 1, chatId: TARGET, floorId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }; }
        if (change === 'qqjHeader') target.chatMetadata.qianqianjiePrequel = 'changed QQJ prequel';
      }
      return result;
    };
    await assert.rejects(f.runtime.importPreview(plan), /变化|切换/);
    assert.equal(f.api.saves, 0);
    assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  });
});

test('core staging uses the existing batch store and commits root last, while batch failure never publishes', async t => {
  for (const failBatch of [false, true]) await t.test(failBatch ? 'failed batch' : 'successful batch', async () => {
    const f = await fixture(), target = await f.target(); const put = f.backend.client.put;
    let batches = 0;
    f.backend.client.putMany = async (collection, records) => {
      batches += 1; assert.ok(records.length <= 64); assert.ok(Buffer.byteLength(JSON.stringify({ records })) <= 1048576);
      assert.ok(records.every(record => record.recordId !== 'v3-root' && record.expectedRevision === 0));
      if (failBatch) return records.map(record => ({ recordId: record.recordId, status: 500, error: 'storage_error', message: 'offline fixture failure' }));
      const result = [];
      for (const record of records) result.push({ recordId: record.recordId, status: 200,
        envelope: await put(collection, record.recordId, record.data, record.expectedRevision) });
      return result;
    };
    const plan = await f.runtime.preview(f.exported.text);
    if (failBatch) {
      await assert.rejects(f.runtime.importPreview(plan)); assert.ok(batches > 0);
      assert.equal(f.api.saves, 0); assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
      assert.equal(f.backend.records.has(`chat-${IMPORTED}/v3-root`), false);
    } else {
      await f.runtime.importPreview(plan); assert.ok(batches > 0);
      const writes = f.backend.calls.filter(call => call[0] === 'put' && call[1] === `chat-${IMPORTED}` && call[2] !== 'self-use-memory-transfer-rollback-v1');
      assert.equal(writes.at(-1)[2], 'v3-root');
      const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
      const graph = await store.readReachable({ mode: 'full' });
      assert.equal(graph.status, 'ready'); assert.equal(graph.floorMemories.length, 1); assert.equal(graph.stateDeltas.length, 1);
    }
  });
});

test('V1 and V2 package witness hashes retain the original wire definition', async () => {
  const chat = [
    { is_user: true, mes: 'a\r\nb', send_date: 't', name: 'User', extra: { otherPlugin: true } },
    { is_user: false, is_system: true, mes: 'visible', swipes: ['unused', 'visible'], swipe_id: 1, extra: { qianqianjieAutoHide: { schemaVersion: 1 } } },
    { is_user: false, mes: 'narration', extra: { type: 'narrator' } },
  ];
  assert.deepEqual(await transferWitness(chat, { version: 1 }), ['6acc6d630762173128b1e72303676b1912a3dd47504a11f6af03515ad61a958e', '461e53fdb9a9056e74d1cec873b0bcb39fae01c677098c26a6a859f8c59c69df', 'e22a432a340f100be6a9c67507f5fffbe6c6182becbe4cad7c8c792060dbc105']);
  assert.deepEqual(await transferWitness(chat, { version: 2 }), ['3d9492e91127bd5661f3eee328c8df12659ac2ffdf0ce40e9bf4dab3ec1164d4', 'f2d6e9d6e5f6d2ce216bc59ee86f0aaf2190619300745a9d9b63a92597cfd85b', '1440e4db2b18bdd06ef56c298c09c092b03655760677d840ba8b4d561f162d50']);
});

test('new rollback uses V2 and undo preserves unrelated fields and unselected replies', async () => {
  const f = await fixture(), target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  const rollback = f.backend.records.get(`chat-${IMPORTED}/self-use-memory-transfer-rollback-v1`).data;
  assert.equal(rollback.witnessVersion, 2);
  target.chatMetadata.otherPlugin = { afterImport: true };
  target.chat[1].extra.variables = { afterImport: true };
  target.chat[1].swipes.push('new unrelated alternative');
  target.chat[1].swipe_info = [{ extra: { liveVariables: true } }, { extra: { pocketPhone: true } }];
  f.api.reloadFromContext();
  await f.runtime.undo();
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  assert.deepEqual(target.chatMetadata.otherPlugin, { afterImport: true });
  assert.deepEqual(target.chat[1].extra.variables, { afterImport: true });
  assert.equal(f.api.persistedMessages[1].swipes[1], 'new unrelated alternative');
  assert.deepEqual(target.chat[1].swipe_info[1].extra, { pocketPhone: true });
});

test('existing rollback without witnessVersion remains readable as V1', async () => {
  const f = await fixture(), target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  const rollback = f.backend.records.get(`chat-${IMPORTED}/self-use-memory-transfer-rollback-v1`).data;
  delete rollback.witnessVersion; rollback.importedMessages = await transferWitness(target.chat, { version: 1 });
  await f.runtime.undo(); assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
});

test('undo rejects an advanced memory root even when story text is unchanged', async () => {
  const f = await fixture(), target = await f.target();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  const root = f.backend.records.get(`chat-${IMPORTED}/v3-root`);
  root.data.updatedAt = '2026-10-27T00:00:00.000Z'; root.revision += 1;
  const saves = f.api.saves;
  await assert.rejects(f.runtime.undo(), /记忆.*变化|记忆.*更新/);
  assert.equal(f.api.saves, saves); assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
});

test('source changed without reconciliation cannot be exported with stale memories', async () => {
  const f = await fixture(); f.ctx.chat[1].mes = 'changed'; f.ctx.chat[1].swipes[0] = 'changed';
  await assert.rejects(f.runtime.exportCurrent(), /记忆中的楼层与聊天正文不一致/);
});

test('cross-host timestamp, visibility, absent/default swipe index and unselected history changes preserve real memory/CSE', async () => {
  const f = await fixture(), target = await f.target();
  target.chat[0].send_date = 1790000000000; target.chat[0].name = 'renamed persona';
  target.chat[2].send_date = 'different host timestamp representation';
  target.chat[4].send_date = '2026-10-15T01:00:00.000Z';
  target.chat[1].is_system = true; // native import may omit the QQJ auto-hide marker
  target.chat[1].swipes = ['unused alternative', target.chat[1].mes]; target.chat[1].swipe_id = 1;
  target.chat[1].swipe_info = [{ extra: { unrelated: true } }, { extra: { variables: { retained: true } } }];
  delete target.chat[3].swipes; delete target.chat[3].swipe_id;
  f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await foundation.start()).status, 'ready');
  const restored = await store.readReachable({ mode: 'full' });
  assert.deepEqual(restored.floorMemories.map(item => item.id), f.graph.floorMemories.map(item => item.id));
  assert.deepEqual(restored.stateDeltas.map(item => item.id), f.graph.stateDeltas.map(item => item.id));
  assert.equal(target.chat[1].swipe_id, 1); assert.equal(target.chat[0].send_date, 1790000000000);
  assert.deepEqual(target.chat[1].swipe_info[1].extra, { variables: { retained: true } });
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => assert.fail('must not reanalyze'), generateUtilityTask: async () => assert.fail('must not resummarize') });
  await memory.start(); assert.equal(memory.getState().rememberedCount, 1);
});

test('V2 diagnostics identify counts and the first differing story floor, including user edits and rerolls', async () => {
  const f = await fixture();
  let target = await f.target(); target.chat[0].mes = 'different user message';
  await assert.rejects(f.runtime.preview(f.exported.text), /第 0 楼.*发言方、正文/);
  target = await f.target(); target.chat[1].swipes.push('actually different selected answer'); target.chat[1].swipe_id = 1;
  await assert.rejects(f.runtime.preview(f.exported.text), /第 1 楼/);
  target = await f.target(); target.chat.push(user('new'));
  await assert.rejects(f.runtime.preview(f.exported.text), /当前 6 条，记忆包 5 条/);
  target = await f.target(); target.chat[0].is_user = false;
  await assert.rejects(f.runtime.preview(f.exported.text), /第 0 楼/);
  assert.equal(f.api.saves, 0);
});

test('V1 stays readable when exact, and asks for a new export when the mixed hash cannot prove equality', async () => {
  const f = await fixture(), old = JSON.parse(f.exported.text);
  old.formatVersion = 1; old.messages = await transferWitness(f.ctx.chat, { version: 1 });
  const { checksum, ...payload } = old; old.checksum = await sha256(stableJson(payload));
  let target = await f.target(); assert.equal((await f.runtime.preview(old)).messages, 5);
  target.chat[0].send_date = 'timestamp changed';
  await assert.rejects(f.runtime.preview(old), /旧版记忆包.*第 0 楼.*重新导出/);
  target = await f.target(); await f.runtime.importPreview(await f.runtime.preview(old));
  await f.runtime.undo(); assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
});



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

function targetChatApi(context, { afterSave = null, beforeGet = null, hasIntegrity = true } = {}) {
  let header = { chat_metadata: structuredClone(context.chatMetadata) };
  if (!hasIntegrity) delete header.chat_metadata.integrity;
  let messages = structuredClone(context.chat);
  let saves = 0;
  return {
    get saves() { return saves; },
    get persistedHeader() { return structuredClone(header); },
    get persistedMessages() { return structuredClone(messages); },
    reloadFromContext() {
      header = { chat_metadata: structuredClone(context.chatMetadata) };
      messages = structuredClone(context.chat);
    },
    async fetch(url, options = {}) {
      if (url === '/api/chats/get') {
        await beforeGet?.({ header, messages });
        return { ok: true, async json() { return [{ ...structuredClone(header) }, ...structuredClone(messages)]; } };
      }
      assert.equal(url, '/api/chats/save');
      const body = JSON.parse(options.body);
      assert.equal(body.force, false);
      assert.equal(body.ch_name, context.name2);
      const currentIntegrity = header.chat_metadata?.integrity;
      if (currentIntegrity !== undefined) assert.equal(body.chat[0]?.chat_metadata?.integrity, currentIntegrity, '宿主保存必须携带当前 integrity');
      header = structuredClone(body.chat[0]);
      messages = structuredClone(body.chat.slice(1));
      saves += 1;
      if (hasIntegrity) header.chat_metadata.integrity = `test-integrity-${saves}`;
      else delete header.chat_metadata.integrity;
      afterSave?.({ header, messages, saves });
      return { ok: true, async json() { return hasIntegrity ? { integrity: header.chat_metadata.integrity } : {}; } };
    },
  };
}

test('unknown package records are rejected before any import writes', async () => {
  const f = await fixture();
  const invalid = JSON.parse(f.exported.text);
  assert.equal(invalid.format, 'qqj-core-chat-memory');
  invalid.records.push({ id: 'unknown-record', data: { chatId: SOURCE } });
  const { checksum, ...payload } = invalid;
  invalid.checksum = await sha256(stableJson(payload));
  await f.target();
  const before = f.backend.calls.length;
  await assert.rejects(f.runtime.preview(invalid), /不支持/);
  assert.equal(f.backend.calls.slice(before).some(call => call[0] === 'put'), false);
});


test('export collects all core records through the actual batch read shape', async () => {
  const f = await fixture();
  assert.ok(f.backend.calls.some(call => call[0] === 'getMany'));
  f.ctx.chatMetadata.transientCallback = () => {};
  const exported = await f.runtime.exportCurrent();
  const { graph } = await parseMemoryPackage(exported.text);
  assert.deepEqual(graph.floors.map(item => item.id), f.graph.floors.map(item => item.id));
  assert.deepEqual(graph.floorMemories.map(item => item.id), f.graph.floorMemories.map(item => item.id));
  assert.deepEqual(graph.stateDeltas.map(item => item.id), f.graph.stateDeltas.map(item => item.id));
  assert.equal(exported.text.includes('transientCallback'), false);
});

test('import replaces target exclusions and undo restores the previous marker', async () => {
  const f = await fixture(), target = await f.target();
  target.chat[1].extra ??= {};
  target.chat[1].extra.qianqianjie_memory_excluded = true;
  f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  assert.equal(target.chat[1].extra.qianqianjie_memory_excluded, undefined);
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await foundation.start()).status, 'ready');
  await f.runtime.undo();
  assert.equal(target.chat[1].extra.qianqianjie_memory_excluded, true);
});

test('source exclusion markers survive a native import that omits them', async () => {
  const f = await fixture({ excluded: true }), target = await f.target();
  assert.equal(f.graph.checkpoint.inputFingerprints[1].memoryExcluded, true);
  delete target.chat[3].extra.qianqianjie_memory_excluded;
  f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  assert.equal(target.chat[3].extra.qianqianjie_memory_excluded, true);
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await foundation.start()).status, 'ready');
  await f.runtime.undo();
  assert.equal(target.chat[3].extra.qianqianjie_memory_excluded, undefined);
});

test('0.9.9 matter overrides, deletion marks and captured variables round trip intact', async () => {
  const f = await fixture();
  const memory = structuredClone(f.graph.floorMemories[0]);
  const matterId = '11111111-1111-4111-8111-111111111111';
  memory.qianshiDelta = { schemaVersion: 1, status: 'empty', reason: null, compiledAt: NOW,
    candidateStats: { count: 0, characters: 0 }, events: [], relations: [],
    trackingOverrides: [{ matterId, following: false }],
    manualMatterStatusOverrides: [{ matterId, status: 'completed' }],
    deletedEventIds: ['22222222-2222-4222-8222-222222222222'] };
  memory.sourceVariableReference = { stat_data: { 剧情: { 钥匙: '木盒', 进度: 2 } }, ejsSaved: { season: '秋' } };
  const sourceRecord = [...f.backend.records].find(([, value]) => value.data.recordType === 'floorMemory' && value.data.id === memory.id);
  assert.ok(sourceRecord);
  sourceRecord[1].data = memory;
  const exported = await f.runtime.exportCurrent();
  await f.target();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const stored = [...f.backend.records].find(([recordKey, value]) => recordKey.startsWith(`chat-${IMPORTED}/`) && value.data.recordType === 'floorMemory' && value.data.id === memory.id)[1].data;
  assert.deepEqual(stored.qianshiDelta, memory.qianshiDelta);
  assert.deepEqual(stored.sourceVariableReference, memory.sourceVariableReference);
});

test('people thumbnails, original image bytes and crop migrate to new host paths', async () => {
  const f = await fixture();
  const personId = '33333333-3333-4333-8333-333333333333';
  const originalPath = '/user/images/qqj-avatars/qqj-avatar-original.png';
  const newPath = '/user/images/qqj-avatars/qqj-avatar-imported.png';
  const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
  const thumbnail = 'data:image/png;base64,iVBORw0KGgo=';
  const crop = { aspectRatio: 1, zoom: 1.5, offsetX: 0.25, offsetY: -0.1 };
  const workspace = { schemaVersion: 3, kind: 'qqj-v3-people-workspace', chatId: SOURCE,
    selectedEntityIds: [personId], personOrderEntityIds: [personId], profilesByEntityId: {},
    avatarsByEntityId: { [personId]: thumbnail }, avatarSourcesByEntityId: { [personId]: { path: originalPath, mimeType: 'image/png', crop } },
    identityRedirectsByEntityId: {}, deletedEntityIds: [], profileMaterialProgressByEntityId: {}, createdAt: NOW, updatedAt: NOW };
  await f.backend.client.put(`chat-${SOURCE}`, 'v3-people-workspace', workspace, 0);
  const snapshotId = 'v3-people-snapshot-44444444-4444-4444-8444-444444444444';
  await f.backend.client.put(`chat-${SOURCE}`, snapshotId, { schemaVersion: 1, kind: 'qqj-v3-frozen-people-snapshot', chatId: SOURCE, sourceChatId: SOURCE, workspace: structuredClone(workspace) }, 0);
  const images = new Map([[originalPath, imageBytes]]), uploads = [];
  const withImages = api => ({ ...api, async fetch(url, options = {}) {
    if (images.has(url)) return { ok: true, async arrayBuffer() { return images.get(url).slice().buffer; } };
    if (url === '/api/images/upload') {
      const payload = JSON.parse(options.body);
      const bytes = Uint8Array.from(atob(payload.image), value => value.charCodeAt(0));
      uploads.push(bytes); images.set(newPath, bytes);
      return { ok: true, async json() { return { path: newPath }; } };
    }
    return api.fetch(url, options);
  } });
  f.setApi(withImages(f.api));
  const exported = await f.runtime.exportCurrent();
  assert.deepEqual(JSON.parse(exported.text).avatarImages, [{ path: originalPath, mimeType: 'image/png', data: Buffer.from(imageBytes).toString('base64') }]);
  await f.target(); f.setApi(withImages(f.api));
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  assert.equal(uploads.length, 1, 'shared originals are uploaded once for current and frozen workspaces');
  assert.deepEqual(uploads[0], imageBytes);
  for (const id of ['v3-people-workspace', snapshotId]) {
    const record = f.backend.records.get(`chat-${IMPORTED}/${id}`).data;
    const people = id === 'v3-people-workspace' ? record : record.workspace;
    assert.equal(people.chatId, IMPORTED);
    assert.equal(people.avatarsByEntityId[personId], thumbnail);
    assert.deepEqual(people.avatarSourcesByEntityId[personId], { path: newPath, mimeType: 'image/png', crop });
  }
  const reexported = JSON.parse((await f.runtime.exportCurrent()).text);
  assert.deepEqual(reexported.avatarImages, [{ path: newPath, mimeType: 'image/png', data: Buffer.from(imageBytes).toString('base64') }]);
});
