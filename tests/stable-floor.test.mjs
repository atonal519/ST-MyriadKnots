import test from 'node:test';
import assert from 'node:assert/strict';
import { bindStableFloorEvents } from '../src/integration-port.js';
import { compareStableLedgers, computeStableFloorSnapshot, createStableLedger, findRollbackBoundary } from '../src/stable-floor.js';
import { createStableFloorAdapter } from '../src/stable-floor-storage.js';

const chatUuid = '123e4567-e89b-12d3-a456-426614174000';
const cardUuid = '223e4567-e89b-12d3-a456-426614174001';
const personaUuid = '323e4567-e89b-12d3-a456-426614174002';
const date = index => `2026-08-29T00:${String(index).padStart(2, '0')}:00.000Z`;
const greeting = (content = '你好') => assistant(content, 0);
const user = (content, index) => ({ name: 'U', is_user: true, is_system: false, send_date: date(index), mes: content, extra: {} });
function assistant(content, index, overrides = {}) {
  const firstDate = date(index);
  return { name: 'C', is_user: false, is_system: false, send_date: firstDate, mes: content, swipe_id: 0, swipes: [content], swipe_info: [{ send_date: firstDate, extra: {} }], extra: {}, ...overrides };
}
const host = chat => ({ characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'char.png' }], userAvatar: 'me.png', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: chatUuid } }, chat });
const meta = (overrides = {}) => ({ schemaVersion: 1, kind: 'chat-profile', chatId: chatUuid, cardId: cardUuid, personaId: personaUuid, source: { card: { locator: 'char.png' }, persona: { locator: 'me.png' } }, cardType: 'single', route: { state: 'uninitialized' }, parentChatId: null, forkFloor: null, canonCheckpoint: null, provisional: null, status: 'ready', rebuildState: 'idle', migration: { source: 'qianqianjie-demo-v1', state: 'complete', sourceRevisions: { chatMeta: 1, cardMapping: 1, personaMapping: 1 } }, ...overrides });
const envelope = (data, revision = 1) => ({ schemaVersion: 1, revision, generationId: '423e4567-e89b-12d3-a456-426614174003', createdAt: date(0), updatedAt: date(1), data });

function fakeClient(initial, options = {}) {
  const collection = `chat-${chatUuid}`;
  const records = new Map([[`${collection}/meta`, initial]]);
  const calls = [];
  return {
    calls,
    get metaRecord() { return records.get(`${collection}/meta`); },
    get runtimeRecord() { return records.get(`${collection}/runtime`); },
    setRuntimeRecord(value) { records.set(`${collection}/runtime`, value); },
    get: async (targetCollection, id) => {
      calls.push({ op: 'get', collection: targetCollection, id }); const key = `${targetCollection}/${id}`; const record = records.get(key);
      if (options.get) return options.get({ collection: targetCollection, id, record, records });
      if (!record) throw Object.assign(new Error('404'), { status: 404 });
      return structuredClone(record);
    },
    put: async (collection, id, data, expectedRevision) => {
      calls.push({ op: 'put', collection, id, data, expectedRevision }); const key = `${collection}/${id}`; const record = records.get(key);
      if (options.put) return options.put({ collection, id, data, expectedRevision, record, records, setRecord: value => { records.set(key, value); } });
      if (expectedRevision !== (record?.revision ?? 0)) throw Object.assign(new Error('409'), { status: 409 });
      const next = envelope(structuredClone(data), expectedRevision + 1); records.set(key, next); return structuredClone(next);
    },
  };
}

test('空聊天和仅 greeting 均无 Canon/provisional；正常交替只把最新 AI 留作 provisional', async () => {
  for (const messages of [[], [greeting()]]) {
    const result = await computeStableFloorSnapshot(messages);
    assert.equal(result.status, 'ready'); assert.equal(result.canon.length, 0); assert.equal(result.provisional, null);
  }
  const result = await computeStableFloorSnapshot([greeting(), user('一', 1), assistant('二', 2), user('三', 3), assistant('四', 4)]);
  assert.deepEqual(result.canon.map(x => x.role), ['user', 'assistant', 'user']);
  assert.equal(result.provisional.role, 'assistant'); assert.equal(result.provisional.sourceIndex, 4);
});

test('用户继续发言后上一 AI 转为 Canon；新增稳定楼识别为纯追加', async () => {
  const before = await computeStableFloorSnapshot([greeting(), user('一', 1), assistant('二', 2)]);
  const previous = createStableLedger(before, { hostChatId: 'host-chat', personaAvatar: 'me.png' });
  const after = await computeStableFloorSnapshot([greeting(), user('一', 1), assistant('二', 2), user('三', 3)]);
  const change = compareStableLedgers(previous, after);
  assert.equal(after.canon.length, 3); assert.equal(after.provisional, null);
  assert.deepEqual({ kind: change.kind, first: change.firstDifferenceFloor, appended: change.appendedCount }, { kind: 'append', first: 2, appended: 2 });
});

test('无变化重复计算稳定；provisional reroll/swipe 只改变 provisional，不污染 Canon', async () => {
  const originalMessages = [greeting(), user('一', 1), assistant('旧回复', 2)];
  const original = await computeStableFloorSnapshot(originalMessages);
  const ledger = createStableLedger(original, { hostChatId: 'host-chat', personaAvatar: 'me.png' });
  const unchanged = compareStableLedgers(ledger, await computeStableFloorSnapshot(structuredClone(originalMessages)));
  assert.equal(unchanged.kind, 'unchanged'); assert.equal(unchanged.provisionalChanged, false);
  const rerolled = [greeting(), user('一', 1), assistant('新回复', 2)];
  const rerollChange = compareStableLedgers(ledger, await computeStableFloorSnapshot(rerolled));
  assert.equal(rerollChange.kind, 'unchanged'); assert.equal(rerollChange.canonChanged, false); assert.equal(rerollChange.provisionalChanged, true);
  const swiped = [greeting(), user('一', 1), assistant('第二 swipe', 2, { swipe_id: 1, swipes: ['旧回复', '第二 swipe'], swipe_info: [{ send_date: date(2), extra: {} }, { send_date: date(5), extra: {} }] })];
  const swipeChange = compareStableLedgers(ledger, await computeStableFloorSnapshot(swiped));
  assert.equal(swipeChange.kind, 'unchanged'); assert.equal(swipeChange.canonChanged, false); assert.equal(swipeChange.provisionalChanged, true);
});

test('已稳定 AI 的编辑与 swipe 均定位到正确首差异楼', async () => {
  const baseMessages = [greeting(), user('一', 1), assistant('稳定回复', 2), user('接受', 3)];
  const base = createStableLedger(await computeStableFloorSnapshot(baseMessages), { hostChatId: 'host-chat', personaAvatar: 'me.png' });
  const editedMessages = structuredClone(baseMessages); editedMessages[2].mes = '编辑后'; editedMessages[2].swipes[0] = '编辑后';
  const edited = compareStableLedgers(base, await computeStableFloorSnapshot(editedMessages));
  assert.deepEqual({ kind: edited.kind, floor: edited.firstDifferenceFloor }, { kind: 'edit', floor: 2 });
  const swipedMessages = structuredClone(baseMessages); Object.assign(swipedMessages[2], { mes: '另一 swipe', swipe_id: 1, swipes: ['稳定回复', '另一 swipe'], swipe_info: [{ send_date: date(2), extra: {} }, { send_date: date(8), extra: {} }] });
  const swiped = compareStableLedgers(base, await computeStableFloorSnapshot(swipedMessages));
  assert.deepEqual({ kind: swiped.kind, floor: swiped.firstDifferenceFloor }, { kind: 'stable_swipe', floor: 2 });
});

test('尾删和中段删除可区分，首差异点与 checkpoint 回退边界正确', async () => {
  const original = [greeting(), user('u1', 1), assistant('a1', 2), user('u2', 3), assistant('a2', 4), user('u3', 5)];
  const base = createStableLedger(await computeStableFloorSnapshot(original), { hostChatId: 'host-chat', personaAvatar: 'me.png' });
  const tail = compareStableLedgers(base, await computeStableFloorSnapshot(original.slice(0, 4)));
  assert.deepEqual({ kind: tail.kind, floor: tail.firstDifferenceFloor, removed: tail.removedCount, rollback: tail.rollbackBoundary }, { kind: 'tail_delete', floor: 4, removed: 2, rollback: 0 });
  const middleMessages = structuredClone(original); middleMessages.splice(3, 1);
  const middle = compareStableLedgers(base, await computeStableFloorSnapshot(middleMessages));
  assert.deepEqual({ kind: middle.kind, floor: middle.firstDifferenceFloor, removed: middle.removedCount }, { kind: 'middle_delete', floor: 3, removed: 1 });
  assert.equal(findRollbackBoundary([{ canonLength: 0 }, { canonLength: 25 }, { canonLength: 50 }], 57), 50);
});

test('相同文本的不同楼仍有不同复合身份；缺字段和瞬态 swipe 不一致保守拒绝', async () => {
  const valid = await computeStableFloorSnapshot([greeting(), user('相同', 1), assistant('收到', 2), user('相同', 3)]);
  assert.equal(valid.canon[0].contentHash, valid.canon[2].contentHash);
  assert.notEqual(valid.canon[0].identity, valid.canon[2].identity);
  for (const messages of [[greeting(), { is_user: true, mes: '缺时间' }], [greeting(), user('一', 1), assistant('A', 2, { mes: 'B' })], [greeting(), null]]) {
    const result = await computeStableFloorSnapshot(messages);
    assert.equal(result.status, 'invalid'); assert.ok(result.errors.length > 0);
  }
});

test('Luker 合法隐藏 system 楼被跳过，number/Date send_date 通过生产标准化 seam', async () => {
  const messages = [
    greeting(),
    { name: 'U', is_user: true, is_system: true, send_date: 1724889600000, mes: '隐藏但仍是用户楼', extra: {} },
    { name: 'U', is_user: true, is_system: false, send_date: 1724889600001, mes: '可见用户楼', extra: {} },
    assistant('日期对象回复', 2, { send_date: new Date('2026-08-29T00:02:00.000Z'), swipe_info: [{ send_date: new Date('2026-08-29T00:02:00.000Z'), extra: {} }] }),
    { name: 'U', is_user: true, is_system: false, send_date: new Date('2026-08-29T00:03:00.000Z'), mes: '接受', extra: {} },
  ];
  const result = await computeStableFloorSnapshot(messages);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.canon.map(entry => entry.role), ['user', 'assistant', 'user']);
  assert.equal(result.canon[0].creationDate, '1724889600001');
  assert.equal(result.canon[1].creationDate, '2026-08-29T00:02:00.000Z');
  assert.equal(result.canon[2].creationDate, '2026-08-29T00:03:00.000Z');
});

test('生产存储 seam 首次原子写入，重复运行零 PUT，纯追加使用 revision CAS', async () => {
  const ctx = host([greeting(), user('一', 1), assistant('二', 2)]);
  const client = fakeClient(envelope(meta()));
  const adapter = createStableFloorAdapter({ client, contextProvider: () => ctx });
  const first = await adapter.refresh();
  assert.equal(first.status, 'ready'); assert.equal(first.change.kind, 'append'); assert.equal(client.calls.filter(x => x.op === 'put').length, 1);
  const writes = client.calls.filter(x => x.op === 'put').length;
  const repeated = await adapter.refresh();
  assert.equal(repeated.status, 'unchanged'); assert.equal(client.calls.filter(x => x.op === 'put').length, writes);
  ctx.chat.push(user('三', 3));
  const appended = await adapter.refresh();
  assert.equal(appended.change.kind, 'append'); assert.equal(appended.ledger.entries.length, 3);
  assert.equal(client.calls.filter(x => x.op === 'put').at(-1).expectedRevision, 1);
});

test('provisional 更新不改 Canon；存储失败保留上次提交账本且不返回半份新状态', async () => {
  const ctx = host([greeting(), user('一', 1), assistant('旧', 2)]);
  let fail = false;
  const client = fakeClient(envelope(meta()), { put: ({ data, expectedRevision, setRecord }) => { if (fail) throw Object.assign(new Error('500'), { status: 500 }); const next = envelope(structuredClone(data), expectedRevision + 1); setRecord(next); return next; } });
  const adapter = createStableFloorAdapter({ client, contextProvider: () => ctx });
  const first = await adapter.refresh(); const oldSignature = first.ledger.provisional.signature;
  ctx.chat[2] = assistant('新', 2); fail = true;
  const failed = await adapter.refresh();
  assert.equal(failed.status, 'storage_error'); assert.equal(failed.ledger.provisional.signature, oldSignature);
  assert.equal(client.runtimeRecord.data.stableFloorLedger.provisional.signature, oldSignature);
});

test('runtime CAS 409 只接受同值胜出者；异值胜出 conflict，畸形旧账本零覆盖', async () => {
  for (const mode of ['same', 'different']) {
    const ctx = host([greeting(), user('一', 1), assistant('二', 2)]); let race = false;
    const client = fakeClient(envelope(meta()), { put: args => {
      if (!race) { const next = envelope(structuredClone(args.data), args.expectedRevision + 1); args.setRecord(next); return next; }
      const winnerData = mode === 'same' ? args.data : args.record.data;
      args.setRecord(envelope(structuredClone(winnerData), args.record.revision + 1));
      throw Object.assign(new Error('409'), { status: 409 });
    } });
    const adapter = createStableFloorAdapter({ client, contextProvider: () => ctx });
    await adapter.refresh(); ctx.chat.push(user('三', 3)); race = true;
    assert.equal((await adapter.refresh()).status, mode === 'same' ? 'ready' : 'conflict');
  }
  const ctx = host([greeting(), user('一', 1)]), client = fakeClient(envelope(meta()));
  const adapter = createStableFloorAdapter({ client, contextProvider: () => ctx }); await adapter.refresh();
  const broken = structuredClone(client.runtimeRecord); broken.data.stableFloorLedger.entries[0].signature = 'broken'; client.setRuntimeRecord(broken);
  const writes = client.calls.filter(call => call.op === 'put').length;
  assert.equal((await adapter.refresh()).status, 'invalid_ledger');
  assert.equal(client.calls.filter(call => call.op === 'put').length, writes);
});

test('Persona mismatch 零写入；切聊天/Persona 与 invalidate 使旧请求迟到时归 stale 且零 PUT', async () => {
  const mismatchCtx = host([greeting(), user('一', 1)]); mismatchCtx.userAvatar = 'other.png';
  const mismatchClient = fakeClient(envelope(meta()));
  assert.equal((await createStableFloorAdapter({ client: mismatchClient, contextProvider: () => mismatchCtx }).refresh()).status, 'mismatch');
  assert.equal(mismatchClient.calls.some(x => x.op === 'put'), false);
  for (const mutate of [ctx => { ctx.chatId = 'other-host-chat'; }, ctx => { ctx.userAvatar = 'other.png'; }]) {
    const ctx = host([greeting(), user('一', 1)]); let release, started = false;
    const client = fakeClient(envelope(meta()), { get: async ({ record }) => { started = true; await new Promise(resolve => { release = resolve; }); return structuredClone(record); } });
    const adapter = createStableFloorAdapter({ client, contextProvider: () => ctx });
    const pending = adapter.refresh(); while (!started) await new Promise(resolve => setImmediate(resolve)); mutate(ctx); adapter.invalidate(); release();
    assert.equal((await pending).status, 'stale'); assert.equal(client.calls.some(x => x.op === 'put'), false);
  }
});

test('真实消息事件 seam 合并同一轮重复刷新；关闭时仅 invalidate', async () => {
  const handlers = {}; let enabled = true, runs = 0, invalidations = 0;
  const eventTypes = { MESSAGE_SENT: 'sent', MESSAGE_RECEIVED: 'received', MESSAGE_EDITED: 'edited', MESSAGE_DELETED: 'deleted', MESSAGE_SWIPED: 'swiped', MESSAGE_SWIPE_DELETED: 'swipe-deleted' };
  assert.equal(bindStableFloorEvents({ eventSource: { on: (name, fn) => { handlers[name] = fn; } }, eventTypes, controller: { invalidate: () => { invalidations += 1; }, run: async () => { runs += 1; } }, isEnabled: () => enabled }), true);
  for (const name of Object.values(eventTypes)) handlers[name]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1); assert.equal(invalidations, 6);
  enabled = false; handlers.sent(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1); assert.equal(invalidations, 7);
});

test('后台消息事件提交的差异和 checkpoint 可由公开 getter 持续读取', async () => {
  const ctx = host([greeting(), user('一', 1), assistant('二', 2)]);
  const client = fakeClient(envelope(meta()));
  const adapter = createStableFloorAdapter({ client, contextProvider: () => ctx });
  await adapter.refresh();
  ctx.chat.push(user('三', 3));
  const handlers = {}; let resolveRun;
  const completed = new Promise(resolve => { resolveRun = resolve; });
  bindStableFloorEvents({
    eventSource: { on: (name, handler) => { handlers[name] = handler; } },
    eventTypes: { MESSAGE_SENT: 'sent' },
    controller: { invalidate: adapter.invalidate, run: async () => { const result = await adapter.refresh(); resolveRun(result); return result; } },
  });
  handlers.sent(3); await completed;
  const state = adapter.getCommittedState();
  assert.equal(state.status, 'cached');
  assert.equal(state.changeKind, 'append');
  assert.equal(state.firstDifferenceFloor, 2);
  assert.equal(state.rollbackBoundary, 1);
  assert.equal(state.checkpoint.canonLength, 3);
});
