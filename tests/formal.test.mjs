import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_TYPES, createFormalAdapter, formalKeys } from '../src/formal-storage.js';
import { sha256 } from '../src/identity.js';
import { createRerunOrchestrator, startInitialRun, bindRerunEvents } from '../src/integration-port.js';

const chatUuid = '123e4567-e89b-12d3-a456-426614174000';
const cardUuid = '223e4567-e89b-12d3-a456-426614174001';
const personaUuid = '323e4567-e89b-12d3-a456-426614174002';
const state = () => ({ characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'char.png' }], userAvatar: 'me.png', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: chatUuid } } });
const rec = (data, revision = 1) => data?.kind === 'chat-profile' || data?.kind === 'card-profile' ? { schemaVersion: 1, revision, generationId: '423e4567-e89b-12d3-a456-426614174003', createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z', data } : { data, revision };
const validDemo = () => ({
  'chat-meta': rec({ schemaVersion: 1, kind: 'chat-demo-profile', chatId: chatUuid, cardId: cardUuid, personaId: personaUuid, source: { characterAvatar: 'char.png', personaAvatar: 'me.png' }, demoProbe: 'qianqianjie-demo-v1' }, 2),
  'identity-cards': rec({ schemaVersion: 1, kind: 'identity-card', avatar: 'char.png', identityId: cardUuid }, 3),
  'identity-personas': rec({ schemaVersion: 1, kind: 'identity-persona', avatar: 'me.png', identityId: personaUuid }, 4),
});
const formalMeta = (type = null) => ({ schemaVersion: 1, kind: 'chat-profile', chatId: chatUuid, cardId: cardUuid, personaId: personaUuid, source: { card: { locator: 'char.png' }, persona: { locator: 'me.png' } }, cardType: type, route: { state: 'uninitialized' }, parentChatId: null, forkFloor: null, canonCheckpoint: null, provisional: null, status: type ? 'ready' : 'awaiting_card_type', rebuildState: 'idle', migration: { source: 'qianqianjie-demo-v1', state: 'complete', sourceRevisions: { chatMeta: 2, cardMapping: 3, personaMapping: 4 } } });
const formalCard = (type = 'single', overrides = {}) => ({ schemaVersion: 1, kind: 'card-profile', cardId: cardUuid, cardType: type, boundPersonaId: personaUuid, sourceLocator: 'char.png', sourceFacts: [], userFacts: [], interpretations: [], status: 'initialized', lifecycle: 'active', ...overrides });
async function demoKeys() { return { card: `avatar-${await sha256('char.png')}`, persona: `avatar-${await sha256('me.png')}` }; }
function fakeClient(records = {}, options = {}) {
  const calls = []; let putCount = 0;
  return { calls, get: async (collection, id) => { calls.push({ op: 'get', collection, id }); const key = collection === 'chat-meta' ? collection : `${collection}/${id}`; if (!(key in records)) throw Object.assign(new Error('404'), { status: 404 }); return records[key]; }, put: async (collection, id, data, expectedRevision) => { calls.push({ op: 'put', collection, id, data, expectedRevision }); putCount += 1; if (options.put) return options.put({ collection, id, data, expectedRevision, putCount, records }); const key = collection === 'chat-meta' ? collection : `${collection}/${id}`; const result = rec(data, expectedRevision + 1); records[key] = result; return result; } };
}
function adapterFor(client, ctx = state()) { return createFormalAdapter({ client, contextProvider: () => ctx }); }

test('正式路径分离且严格 UUID/无斜杠/长度', () => { const keys = formalKeys(chatUuid, cardUuid); assert.deepEqual(keys, { chatCollection: `chat-${chatUuid}`, metaRecordId: 'meta', cardCollection: 'cards', cardRecordId: cardUuid }); for (const value of Object.values(keys)) assert.equal(value.includes('/'), false); for (const bad of ['', 'bad', `${chatUuid}/x`, 'x'.repeat(200)]) assert.throws(() => formalKeys(bad, cardUuid)); assert.throws(() => formalKeys(chatUuid, `${cardUuid}/x`)); });

test('Demo 三记录缺失、错误 kind/locator/UUID/revision 均零正式 PUT', async () => { const keys = await demoKeys(); const make = () => { const source = validDemo(); source[`identity-cards/${keys.card}`] = source['identity-cards']; source[`identity-personas/${keys.persona}`] = source['identity-personas']; return source; }; const cases = []; for (const missing of ['chat-meta', `identity-cards/${keys.card}`, `identity-personas/${keys.persona}`]) { const source = make(); delete source[missing]; cases.push({ source, target: missing }); } for (const [mutate, target] of [[d => { d['chat-meta'].data.kind = 'wrong'; }, 'chat-meta'], [d => { d[`identity-cards/${keys.card}`].data.avatar = 'other.png'; }, `identity-cards/${keys.card}`], [d => { d[`identity-personas/${keys.persona}`].data.identityId = 'bad'; }, `identity-personas/${keys.persona}`], [d => { d[`identity-cards/${keys.card}`].revision = 0; }, `identity-cards/${keys.card}`]]) { const source = make(); mutate(source); cases.push({ source, target }); } for (const { source, target } of cases) { const client = fakeClient(source); const result = await adapterFor(client).getFormalState(); assert.equal(result.status, 'mismatch'); assert.equal(client.calls.filter(x => x.op === 'put').length, 0); assert.equal(client.calls.some(x => x.op === 'get' && (x.collection === target || `${x.collection}/${x.id}` === target)), true); } });

test('Demo 合法时仅迁移正式 meta，二次运行正式层优先零 PUT', async () => { const keys = await demoKeys(); const source = validDemo(); source[`identity-cards/${keys.card}`] = source['identity-cards']; source[`identity-personas/${keys.persona}`] = source['identity-personas']; const client = fakeClient(source); const adapter = adapterFor(client); assert.equal((await adapter.getFormalState()).status, 'migrated'); assert.deepEqual(client.calls.filter(x => x.op === 'put').map(x => x.collection), ['chat-123e4567-e89b-12d3-a456-426614174000']); const writes = client.calls.filter(x => x.op === 'put').length; assert.equal((await adapter.getFormalState()).status, 'awaiting_card_type'); assert.equal(client.calls.filter(x => x.op === 'put').length, writes); });

test('formal 单次运行只读一份 meta/authority，三条独立 authority 并发且不因 404 改写语义', async () => {
  const keys = await demoKeys(), records = validDemo();
  records[`chat-${chatUuid}/meta`] = rec(formalMeta('single')); records[`identity-cards/${keys.card}`] = records['identity-cards']; records[`identity-personas/${keys.persona}`] = records['identity-personas'];
  const releases = [], calls = [];
  const client = {
    get: async (collection, id) => { calls.push({ collection, id }); await new Promise(resolve => releases.push(resolve)); const key = collection === 'chat-meta' ? collection : `${collection}/${id}`; if (!(key in records)) throw Object.assign(new Error('404'), { status: 404 }); return records[key]; },
    put: async () => { throw new Error('不应写入'); },
  };
  const pending = adapterFor(client).getFormalState();
  while (calls.length < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.collection === `chat-${chatUuid}` && call.id === 'meta').length, 1);
  assert.equal(calls.filter(call => ['chat-meta', 'identity-cards', 'identity-personas'].includes(call.collection)).length, 3);
  releases.splice(0).forEach(resolve => resolve());
  assert.equal((await pending).status, 'ready'); assert.equal(calls.length, 4);

  const missing = structuredClone(records); delete missing[`identity-personas/${keys.persona}`];
  const missingClient = fakeClient(missing); assert.equal((await adapterFor(missingClient).getFormalState()).status, 'ready');
  assert.equal(missingClient.calls.filter(call => call.op === 'get' && ['chat-meta', 'identity-cards', 'identity-personas'].includes(call.collection)).length, 3);
});

test('formal 并行读取按旧串行可达顺序裁决 meta/authority 的 404、校验与 500', async t => {
  const keys = await demoKeys(), authority = validDemo();
  const makeClient = ({ meta = formalMeta('single'), demo = authority['chat-meta'], card = authority['identity-cards'], persona = authority['identity-personas'] } = {}) => ({
    async get(collection, id) {
      const value = collection === `chat-${chatUuid}` && id === 'meta' ? meta
        : collection === 'chat-meta' ? demo
          : collection === 'identity-cards' && id === keys.card ? card
            : collection === 'identity-personas' && id === keys.persona ? persona : undefined;
      if (value === '404' || value === undefined) throw Object.assign(new Error('missing'), { status: 404 });
      if (value === '500') throw Object.assign(new Error('authority boom'), { status: 500 });
      return collection === `chat-${chatUuid}` ? rec(value) : value;
    },
    async put() { throw new Error('不应写入'); },
  });

  await t.test('invalid meta 足以 mismatch，忽略并发 authority 500', async () => {
    const invalid = { ...formalMeta('single'), migration: null };
    assert.equal((await adapterFor(makeClient({ meta: invalid, demo: '500' })).getFormalState()).status, 'mismatch');
  });
  await t.test('initialize 的 meta 404 足以 not_initialized，忽略并发 authority 500', async () => {
    assert.equal((await adapterFor(makeClient({ meta: '404', demo: '500' })).initializeCard({ cardType: 'single' })).status, 'not_initialized');
  });
  await t.test('较早 authority 404 终止旧路径，较晚并发 500 不得抢先覆盖', async () => {
    assert.equal((await adapterFor(makeClient({ demo: '404', card: '500' })).getFormalState()).status, 'ready');
  });
  await t.test('合法 meta 且旧路径会到达的 authority 500 继续抛出', async () => {
    await assert.rejects(adapterFor(makeClient({ demo: '500' })).getFormalState(), /authority boom/);
  });
});

test('已有正式 meta 严格校验，Demo 权威 UUID 冲突与残缺 shape mismatch', async () => { const keys = await demoKeys(); const source = validDemo(); source[`chat-${chatUuid}/meta`] = rec({ ...formalMeta(), cardId: '423e4567-e89b-12d3-a456-426614174003' }); source[`identity-cards/${keys.card}`] = source['identity-cards']; source[`identity-personas/${keys.persona}`] = source['identity-personas']; const client = fakeClient(source); assert.equal((await adapterFor(client).getFormalState()).status, 'mismatch'); assert.equal(client.calls.filter(x => x.op === 'put').length, 0); source[`chat-${chatUuid}/meta`] = rec({ ...formalMeta(), migration: { source: 'qianqianjie-demo-v1', state: 'complete', sourceRevisions: { chatMeta: 0, cardMapping: 3, personaMapping: 4 } } }); assert.equal((await adapterFor(fakeClient(source)).getFormalState()).status, 'mismatch'); });

test('正式 meta 404→409 同值胜出，异值或畸形胜出 mismatch', async () => { const keys = await demoKeys(); const source = validDemo(); source[`identity-cards/${keys.card}`] = source['identity-cards']; source[`identity-personas/${keys.persona}`] = source['identity-personas']; for (const winner of [formalMeta(), { ...formalMeta(), cardId: '423e4567-e89b-12d3-a456-426614174003' }, { ...formalMeta(), migration: null }, { ...formalMeta(), source: { card: { locator: 'other.png' }, persona: { locator: 'me.png' } } }]) { const records = { ...source }; let first = true; const client = fakeClient(records, { put: ({ collection, records: db }) => { if (collection.startsWith('chat-') && first) { first = false; db[`${collection}/meta`] = rec(winner); throw Object.assign(new Error('409'), { status: 409 }); } } }); assert.equal((await adapterFor(client).getFormalState()).status, winner.cardId === cardUuid && winner.migration && winner.source.card.locator === 'char.png' ? 'awaiting_card_type' : 'mismatch'); assert.equal(client.calls.filter(x => x.op === 'put').length, 1); } });

test('四种 cardType 成功，非法类型零 GET/PUT；card 校验严格请求类型', async () => { const keys = await demoKeys(); for (const type of CARD_TYPES) { const records = validDemo(); records[`chat-${chatUuid}/meta`] = rec(formalMeta()); records[`identity-cards/${keys.card}`] = records['identity-cards']; records[`identity-personas/${keys.persona}`] = records['identity-personas']; const client = fakeClient(records); const result = await adapterFor(client).initializeCard({ cardType: type }); assert.equal(result.status, 'ready'); assert.equal(records[`cards/${cardUuid}`].data.cardType, type); } const records = validDemo(); records[`chat-${chatUuid}/meta`] = rec(formalMeta()); records[`identity-cards/${keys.card}`] = records['identity-cards']; records[`identity-personas/${keys.persona}`] = records['identity-personas']; const client = fakeClient(records); assert.equal((await adapterFor(client).initializeCard({ cardType: 'invalid' })).status, 'invalid_card_type'); assert.equal(client.calls.length, 0); });

test('formal getFormalState 只在合法 ready 权威状态公开稳定 cardId/cardType，route_unavailable 保持旧最小合同', async () => {
  const keys = await demoKeys(); const records = validDemo();
  records[`chat-${chatUuid}/meta`] = rec(formalMeta('single')); records[`identity-cards/${keys.card}`] = records['identity-cards']; records[`identity-personas/${keys.persona}`] = records['identity-personas'];
  const ready = await adapterFor(fakeClient(structuredClone(records))).getFormalState();
  assert.equal(ready.status, 'ready'); assert.equal(ready.cardId, cardUuid); assert.equal(ready.cardType, 'single'); assert.equal(ready.formal.cardType, 'single');
  const unavailable = createFormalAdapter({ client: fakeClient(structuredClone(records)), contextProvider: state, routeSource: { collect: async () => { throw Object.assign(new Error('扫描不可用'), { diagnosticCode: 'SCAN_FAILED' }); } } });
  const blocked = await unavailable.getFormalState(); assert.equal(blocked.status, 'route_unavailable'); assert.equal(blocked.cardId, undefined); assert.equal(blocked.cardType, undefined); assert.equal(blocked.formal.cardType, 'single'); assert.equal(blocked.diagnosticCode, 'SCAN_FAILED');
  const malformed = structuredClone(records); malformed[`chat-${chatUuid}/meta`].data.cardId = 'bad'; const mismatch = await adapterFor(fakeClient(malformed)).getFormalState();
  assert.equal(mismatch.status, 'mismatch'); assert.equal(mismatch.cardId, undefined);
});

test('同 chat/card 的真实旧档在 Persona locator 不同时明确分类且零写，切回后原档直接 ready', async () => {
  const keys = await demoKeys(), records = validDemo();
  records[`chat-${chatUuid}/meta`] = rec(formalMeta('single')); records[`identity-cards/${keys.card}`] = records['identity-cards']; records[`identity-personas/${keys.persona}`] = records['identity-personas'];
  const ctx = state(); ctx.userAvatar = 'new-persona.png'; const client = fakeClient(records), adapter = adapterFor(client, ctx);
  const mismatch = await adapter.getFormalState(); assert.deepEqual({ status: mismatch.status, reason: mismatch.mismatchReason }, { status: 'mismatch', reason: 'persona' }); assert.equal(client.calls.filter(call => call.op === 'put').length, 0);
  ctx.userAvatar = 'me.png'; const restored = await adapter.getFormalState(); assert.equal(restored.status, 'ready'); assert.equal(restored.cardId, cardUuid); assert.equal(restored.personaId, personaUuid); assert.equal(client.calls.filter(call => call.op === 'put').length, 0);
});

test('已有 card、card409 同值成功；异 type/persona/locator conflict；card 成功后 meta 500 可恢复', async () => { const keys = await demoKeys(); const base = validDemo(); base[`chat-${chatUuid}/meta`] = rec(formalMeta()); base[`identity-cards/${keys.card}`] = base['identity-cards']; base[`identity-personas/${keys.persona}`] = base['identity-personas']; base[`cards/${cardUuid}`] = rec(formalCard()); const client = fakeClient(base); assert.equal((await adapterFor(client).initializeCard({ cardType: 'single' })).status, 'ready'); assert.equal(client.calls.filter(x => x.op === 'put').length, 1); for (const badCard of [formalCard('multi'), formalCard('single', { boundPersonaId: '423e4567-e89b-12d3-a456-426614174003' }), formalCard('single', { sourceLocator: 'other.png' })]) { const records = { ...base, [`chat-${chatUuid}/meta`]: rec(formalMeta()), [`cards/${cardUuid}`]: rec(badCard) }; assert.equal((await adapterFor(fakeClient(records)).initializeCard({ cardType: 'single' })).status, 'conflict'); } let fail = true; const recoverRecords = { ...base, [`chat-${chatUuid}/meta`]: rec(formalMeta()) }; delete recoverRecords[`cards/${cardUuid}`]; const recover = fakeClient(recoverRecords, { put: args => { if (args.collection.startsWith('chat-') && fail) { fail = false; throw Object.assign(new Error('500'), { status: 500 }); } const key = args.collection === 'chat-meta' ? args.collection : `${args.collection}/${args.id}`; const result = rec(args.data, args.expectedRevision + 1); args.records[key] = result; return result; } }); await assert.rejects(adapterFor(recover).initializeCard({ cardType: 'single' }), /后端请求失败|500/); assert.equal((await adapterFor(recover).initializeCard({ cardType: 'single' })).status, 'ready'); assert.equal(recover.calls.filter(x => x.op === 'put' && x.collection === 'cards').length, 1); });

test('正式 GET 在途切聊天/Persona并 invalidate 后，旧 run 无后续 PUT', async () => { const keys = await demoKeys(); const records = validDemo(); records['chat-meta'] = rec(formalMeta()); records[`identity-cards/${keys.card}`] = records['identity-cards']; records[`identity-personas/${keys.persona}`] = records['identity-personas']; let release; const ctx = state(); const client = { get: async (...args) => { await new Promise(resolve => { release = resolve; }); return records[args[0] === 'chat-meta' ? 'chat-meta' : `${args[0]}/${args[1]}`]; }, put: async () => { throw new Error('不应写入'); } }; const adapter = adapterFor(client, ctx); const pending = adapter.getFormalState(); while (!release) await new Promise(resolve => setImmediate(resolve)); ctx.userAvatar = 'other.png'; adapter.invalidate(); release(); assert.equal((await pending).status, 'stale'); });

test('正式 GET 在途 hostChatId 改变并 invalidate 后同样失效', async () => { const releases = []; const ctx = state(); const client = { get: async () => { await new Promise(resolve => { releases.push(resolve); }); }, put: async () => { throw new Error('不应写入'); } }; const adapter = adapterFor(client, ctx); const pending = adapter.getFormalState(); while (releases.length < 4) await new Promise(resolve => setImmediate(resolve)); ctx.chatId = 'other-host-chat'; adapter.invalidate(); releases.splice(0).forEach(resolve => resolve()); assert.equal((await pending).status, 'stale'); });

test('正式队列积压后 invalidate：旧排队任务开始前零新增 GET/PUT', async () => { const releases = []; let gets = 0; const client = { get: async () => { gets += 1; await new Promise(resolve => { releases.push(resolve); }); throw Object.assign(new Error('404'), { status: 404 }); }, put: async () => { throw new Error('不应写入'); } }; const adapter = adapterFor(client); const first = adapter.getFormalState(); while (releases.length < 4) await new Promise(resolve => setImmediate(resolve)); const admittedGets = gets, queued = adapter.getFormalState(); adapter.invalidate(); releases.splice(0).forEach(resolve => resolve()); assert.equal((await first).status, 'stale'); assert.equal((await queued).status, 'stale'); assert.equal(gets, admittedGets); assert.equal(admittedGets, 4); });

test('初始/CHAT_CHANGED/PERSONA_CHANGED 入口均实际调用 formal seam', async () => { let formalCalls = 0; const formal = { invalidate() {}, getFormalState: async () => { formalCalls += 1; return { status: 'stopped' }; } }; const demo = { invalidate() {}, runDemo: async () => ({ status: 'stopped' }) }; const orchestrator = createRerunOrchestrator({ demo, formal }); startInitialRun(orchestrator); const handlers = {}; bindRerunEvents({ eventSource: { on: (name, fn) => { handlers[name] = fn; } }, eventTypes: { CHAT_CHANGED: 'chat', PERSONA_CHANGED: 'persona' }, controller: orchestrator }); await new Promise(resolve => setImmediate(resolve)); handlers.chat(); handlers.persona(); await new Promise(resolve => setImmediate(resolve)); assert.equal(formalCalls, 3); });

test('禁止业务 collection 从未创建，畸形 PUT 成功响应不得视为 ready', async () => { const keys = await demoKeys(); const records = validDemo(); records[`chat-${chatUuid}/meta`] = rec(formalMeta()); records[`identity-cards/${keys.card}`] = records['identity-cards']; records[`identity-personas/${keys.persona}`] = records['identity-personas']; const client = fakeClient(records, { put: ({ collection, data }) => { if (collection === 'cards') return rec({ ...data, lifecycle: 'broken' }, 2); return rec(data, 2); } }); assert.equal((await adapterFor(client).initializeCard({ cardType: 'single' })).status, 'conflict'); assert.equal(client.calls.some(x => /people|bonds|milestone|knots|runtime|index/.test(x.collection)), false); });

test('card 404→PUT409→GET 同值真实竞争路径成功', async () => { const keys = await demoKeys(); const records = validDemo(); records[`chat-${chatUuid}/meta`] = rec(formalMeta()); records[`identity-cards/${keys.card}`] = records['identity-cards']; records[`identity-personas/${keys.persona}`] = records['identity-personas']; let raced = false; const client = fakeClient(records, { put: args => { if (args.collection === 'cards' && !raced) { raced = true; args.records[`cards/${cardUuid}`] = rec(formalCard(), 2); throw Object.assign(new Error('409'), { status: 409 }); } const key = `${args.collection}/${args.id}`; const result = rec(args.data, args.expectedRevision + 1); args.records[key] = result; return result; } }); assert.equal((await adapterFor(client).initializeCard({ cardType: 'single' })).status, 'ready'); assert.equal(raced, true); assert.equal(client.calls.filter(x => x.op === 'put' && x.collection === 'cards').length, 1); });

test('formal meta PUT 成功后的复读必须验证 envelope/绑定，404 或异值均失败', async () => { const keys = await demoKeys(); for (const mode of ['404', 'wrong']) { const records = validDemo(); records[`identity-cards/${keys.card}`] = records['identity-cards']; records[`identity-personas/${keys.persona}`] = records['identity-personas']; let formalPut = false; const client = fakeClient(records, { put: args => { const key = `${args.collection}/${args.id}`; formalPut = true; if (mode === 'wrong') args.records[key] = rec({ ...args.data, cardId: '423e4567-e89b-12d3-a456-426614174003' }, 2); return rec(args.data, 2); } }); const result = await adapterFor(client).getFormalState(); assert.equal(formalPut, true); assert.equal(result.status, 'mismatch'); } });

test('meta CAS 成功/409 复读必须是同值完整 envelope，异绑定或仅 data 均不得 ready', async () => { const keys = await demoKeys(); const variants = [
  { mode: 'success', winner: formalMeta('single') },
  { mode: 'success', winner: { ...formalMeta('single'), cardId: '423e4567-e89b-12d3-a456-426614174003' } },
  { mode: 'race', winner: formalMeta('single') },
  { mode: 'race', winner: { ...formalMeta('single'), personaId: '423e4567-e89b-12d3-a456-426614174003' } },
  { mode: 'race', winner: formalMeta('single'), bare: true },
]; for (const item of variants) { const records = validDemo(); records[`chat-${chatUuid}/meta`] = rec(formalMeta()); records[`identity-cards/${keys.card}`] = records['identity-cards']; records[`identity-personas/${keys.persona}`] = records['identity-personas']; records[`cards/${cardUuid}`] = rec(formalCard('single')); let writes = 0; const client = fakeClient(records, { put: args => { if (args.collection.startsWith('chat-')) { writes += 1; const key = `${args.collection}/${args.id}`; if (item.mode === 'race') { args.records[key] = item.bare ? { data: item.winner } : rec(item.winner, 2); throw Object.assign(new Error('409'), { status: 409 }); } args.records[key] = rec(item.winner, 2); return rec(item.winner, 2); } const key = `${args.collection}/${args.id}`; const result = rec(args.data, args.expectedRevision + 1); args.records[key] = result; return result; } }); const result = await adapterFor(client).initializeCard({ cardType: 'single' }); assert.equal(writes, 1); assert.equal(result.status, item.winner.cardId === cardUuid && item.winner.personaId === personaUuid && !item.bare ? 'ready' : 'conflict'); } });
