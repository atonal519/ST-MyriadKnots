import test from 'node:test';
import assert from 'node:assert/strict';
import { BASIC_FIELD_KEYS, DYNAMIC_FIELD_KEYS, createFoundationAwarePeopleAdapter, createPeopleFoundationAdapter, normalizePeopleProfile, PEOPLE_STATE_RECORD_ID } from '../src/people-foundation.js';
import { createCRegistryAdapter } from '../src/c-registry.js';
import { createRuntimeRunner } from '../src/runtime-runner.js';

const chatId = '123e4567-e89b-12d3-a456-426614174000';
const cardId = '223e4567-e89b-12d3-a456-426614174001';
const personaId = '323e4567-e89b-12d3-a456-426614174002';
const c1 = '423e4567-e89b-12d3-a456-426614174003';
const c2 = '523e4567-e89b-12d3-a456-426614174004';
const generationId = '623e4567-e89b-12d3-a456-426614174005';
const date = '2026-08-29T00:00:00.000Z';
const collection = `chat-${chatId}`;
const profiles = `chat-${chatId}-people`;
const host = (overrides = {}) => ({ characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'char.png' }], userAvatar: 'me.png', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId } }, ...overrides });
const envelope = (data, revision = 1) => ({ schemaVersion: 1, revision, generationId, createdAt: date, updatedAt: date, data: structuredClone(data) });
const meta = (overrides = {}) => ({ schemaVersion: 1, kind: 'chat-profile', chatId, cardId, personaId, source: { card: { locator: 'char.png' }, persona: { locator: 'me.png' } }, cardType: 'single', route: { state: 'ready' }, status: 'ready', rebuildState: 'idle', ...overrides });
const binding = (identityId, displayName, status = 'selected') => ({ identityId, displayName, sourceAnchor: displayName, primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceKey: `greeting:greeting:0:0:${displayName}`, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }], selection: { status } });
const index = ({ confirmed = [binding(c1, '甲')], candidate = [], discarded = [], shelved = [], overrides = {} } = {}) => ({ schemaVersion: 1, kind: 'people-index', chatId, contractVersion: 3, sourceFingerprint: 'sha256:test', status: 'ready', confirmed, candidate, discarded, shelved, tombstones: [], ...overrides });
const cProfile = (identityId, displayName, overrides = {}) => ({ schemaVersion: 1, kind: 'people-profile', identityId, subject: 'character', displayName, category: 'confirmed', selection: { status: 'selected' }, sourceFacts: [], userFacts: [], interpretations: [], locks: [], pendingReview: [], sourceAnchor: displayName, primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceKey: `greeting:greeting:0:0:${displayName}`, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }], lifecycle: 'active', chatId, ...overrides });
const stable = { status: 'ready', revision: 4, ledger: { schemaVersion: 1, entries: [{ identity: 'floor-1', signature: 'sha256:tail' }], hugeLedgerField: '不得复制' } };

function fakeClient(initial = {}, hooks = {}) {
  const records = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  const calls = [];
  return {
    calls, records,
    get: async (targetCollection, id) => {
      calls.push({ op: 'get', collection: targetCollection, id });
      const key = `${targetCollection}/${id}`;
      if (hooks.get) {
        const value = await hooks.get({ key, collection: targetCollection, id, records });
        if (value !== undefined) return structuredClone(value);
      }
      if (!records.has(key)) throw Object.assign(new Error('404'), { status: 404 });
      return structuredClone(records.get(key));
    },
    put: async (targetCollection, id, data, expectedRevision) => {
      calls.push({ op: 'put', collection: targetCollection, id, data: structuredClone(data), expectedRevision });
      const key = `${targetCollection}/${id}`, current = records.get(key);
      if (hooks.put) {
        const value = await hooks.put({ key, collection: targetCollection, id, data, expectedRevision, current, records });
        if (value !== undefined) return structuredClone(value);
      }
      if (expectedRevision !== (current?.revision ?? 0)) throw Object.assign(new Error('409'), { status: 409 });
      const next = envelope(data, expectedRevision + 1);
      records.set(key, next);
      return structuredClone(next);
    },
  };
}

const baseRecords = (peopleIndex = index()) => ({ [`${collection}/meta`]: envelope(meta()), [`${collection}/people-index`]: envelope(peopleIndex), [`${profiles}/${c1}`]: envelope(cProfile(c1, '甲')) });
const adapter = (client, ctx = host()) => createPeopleFoundationAdapter({ client, contextProvider: () => ctx });
const puts = client => client.calls.filter(call => call.op === 'put');

test('生产存储 seam 只初始化已选择 C，保留 personaId 且不新建 U profile', async () => {
  const client = fakeClient(baseRecords());
  const result = await adapter(client).initialize({ stableFloorState: stable });
  assert.equal(result.status, 'ready');
  assert.equal(result.profiles.length, 1);
  const state = client.records.get(`${collection}/${PEOPLE_STATE_RECORD_ID}`).data;
  assert.deepEqual(state.activeMemberIds, [c1]);
  assert.equal(state.personaId, personaId);
  assert.deepEqual(state.canonRef, { schemaVersion: 1, canonLength: 1, tailIdentity: 'floor-1', tailSignature: 'sha256:tail', runtimeRevision: 4 });
  assert.equal(JSON.stringify(state).includes('hugeLedgerField'), false);
  assert.equal(client.records.has(`${profiles}/${personaId}`), false);
  assert.equal(client.records.get(`${profiles}/${c1}`).data.sourceBinding.identityId, c1);
});

test('重复初始化完全幂等；新实例刷新只读恢复且不触发重复写入', async () => {
  const client = fakeClient(baseRecords());
  const firstAdapter = adapter(client);
  await firstAdapter.initialize({ stableFloorState: stable });
  const writes = puts(client).length;
  assert.equal((await firstAdapter.initialize({ stableFloorState: stable })).reused, true);
  assert.equal(puts(client).length, writes);
  const restored = await adapter(client).restore();
  assert.equal(restored.status, 'ready');
  assert.equal(restored.restored, true);
  assert.equal(puts(client).length, writes);
});

test('新选择只补新 C；取消选择不删除旧档，再选择复用同一 UUID', async () => {
  const client = fakeClient(baseRecords());
  const people = adapter(client);
  await people.initialize({ stableFloorState: stable });
  const c1Envelope = client.records.get(`${profiles}/${c1}`);
  client.records.set(`${collection}/people-index`, envelope(index({ confirmed: [binding(c1, '甲', 'unselected'), binding(c2, '乙', 'selected')] }), 2));
  const added = await people.initialize({ stableFloorState: stable });
  assert.equal(added.status, 'ready');
  assert.equal(client.records.has(`${profiles}/${c1}`), true);
  assert.equal(client.records.has(`${profiles}/${c2}`), true);
  let state = client.records.get(`${collection}/${PEOPLE_STATE_RECORD_ID}`).data;
  assert.equal(state.initializedMembers.some(item => item.identityId === c1), false);
  assert.equal(state.initializedMembers.find(item => item.identityId === c2).active, true);
  client.records.set(`${collection}/people-index`, envelope(index({ confirmed: [binding(c1, '甲', 'selected'), binding(c2, '乙', 'unselected')] }), 3));
  await people.initialize({ stableFloorState: stable });
  state = client.records.get(`${collection}/${PEOPLE_STATE_RECORD_ID}`).data;
  assert.equal(state.initializedMembers.find(item => item.identityId === c1).active, true);
  assert.equal(client.records.get(`${profiles}/${c1}`).generationId, c1Envelope.generationId);
});

test('真实人物 action seam 选择/取消后立即收敛 activeMemberIds，foundation 不新增 AI', async () => {
  const ctx = host(); let aiCalls = 0;
  const client = fakeClient(baseRecords(index({ confirmed: [binding(c1, '甲', 'unselected')] })));
  const foundation = adapter(client, ctx);
  const registry = createCRegistryAdapter({ client, contextProvider: () => ctx, generateTask: async () => { aiCalls += 1; throw new Error('选择动作不应调用 AI'); } });
  const actions = createFoundationAwarePeopleAdapter({ people: registry, foundation, stableFloors: { getCommittedState: () => stable } });
  await foundation.initialize({ stableFloorState: stable });
  assert.deepEqual(client.records.get(`${collection}/${PEOPLE_STATE_RECORD_ID}`).data.activeMemberIds, []);
  const selected = await actions.select({ identityId: c1 });
  assert.equal(selected.status, 'ready');
  assert.deepEqual(client.records.get(`${collection}/${PEOPLE_STATE_RECORD_ID}`).data.activeMemberIds, [c1]);
  assert.equal(client.records.get(`${profiles}/${c1}`).data.peopleContractVersion, 1);
  const unselected = await actions.unselectPerson({ identityId: c1 });
  assert.equal(unselected.status, 'ready');
  assert.deepEqual(client.records.get(`${collection}/${PEOPLE_STATE_RECORD_ID}`).data.activeMemberIds, []);
  assert.equal(client.records.has(`${profiles}/${c1}`), true);
  assert.equal(aiCalls, 0);
});

test('同一 C UUID 的 sourceKey/来源锚点变化只更新证据，不制造身份冲突', async () => {
  const client = fakeClient(baseRecords()); const people = adapter(client);
  await people.initialize();
  const firstIdentity = client.records.get(`${profiles}/${c1}`).data.identityId;
  client.records.get(`${profiles}/${c1}`).data.sourceBinding = { kind: 'c-registry', identityId: c1, locator: '旧版可变 sourceKey 不再作为身份' };
  const nextBinding = binding(c1, '甲');
  nextBinding.sourceAnchor = '新锚点'; nextBinding.sourceKey = 'worldbook:人物书:2:新锚点';
  nextBinding.primarySourceRef = { kind: 'worldbook', locator: '人物书:2' };
  nextBinding.sourceRefs = [{ kind: 'worldbook', locator: '人物书:2' }];
  client.records.set(`${collection}/people-index`, envelope(index({ confirmed: [nextBinding] }), 2));
  const changed = await people.initialize();
  assert.equal(changed.status, 'ready');
  const profile = client.records.get(`${profiles}/${c1}`).data;
  assert.equal(profile.identityId, firstIdentity);
  assert.equal(profile.sourceBinding.identityId, c1);
  assert.equal(profile.sourceBinding.sourceKey, nextBinding.sourceKey);
  assert.ok(profile.sourceRefs.some(item => item?.locator === '人物书:2'));
  const writes = puts(client).length;
  assert.equal((await people.initialize()).reused, true);
  assert.equal(puts(client).length, writes);
});

test('候选、暂不采用、未选择与搁置人物不进入活跃正式成员', async () => {
  const ignored = [binding(c2, '未选择', 'unselected')];
  const peopleIndex = index({ confirmed: [binding(c1, '已选择'), ...ignored], candidate: [{ name: '候选' }], discarded: [{ name: '暂不采用' }], shelved: [binding(c2, '搁置')] });
  const client = fakeClient(baseRecords(peopleIndex));
  const result = await adapter(client).initialize();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.state.activeMemberIds, [c1]);
  assert.equal(client.records.has(`${profiles}/${c2}`), false);
});

test('宽松补全旧档保留事实、锁、待确认、未知顶层与扩展 sourceRefs', async () => {
  const legacy = cProfile(c1, '甲', {
    peopleContractVersion: undefined,
    sourceFacts: { value: '原设' }, userFacts: ['用户事实'], interpretations: null,
    locks: { field: 'name' }, pendingReview: '待确认',
    sourceRefs: [{ kind: 'future-ref', locator: 'extension:x', extra: { keep: true } }, 'legacy-ref'],
    basicFields: { appearance: { value: '旧外貌', provenance: 'user', futureMeta: { keep: true } }, futureField: { value: '保留未知字段' } },
    dynamicFields: { currentGoals: { value: '寻找失踪的妹妹', provenance: 'user', futureMeta: { keep: true } }, futureDynamic: { value: '保留未知动态字段' } },
    futureExtension: { nested: ['必须保留'] },
  });
  const records = baseRecords(); records[`${profiles}/${c1}`] = envelope(legacy);
  records[`${profiles}/${personaId}`] = envelope({ schemaVersion: '1', identityId: personaId, subject: 'U', chatId, userFacts: { value: 'U 内容' }, unknownTop: 42 });
  const client = fakeClient(records);
  assert.equal((await adapter(client).initialize()).status, 'ready');
  const saved = client.records.get(`${profiles}/${c1}`).data;
  assert.deepEqual(saved.sourceFacts, [{ value: '原设' }]);
  assert.deepEqual(saved.userFacts, ['用户事实']);
  assert.deepEqual(saved.interpretations, []);
  assert.deepEqual(saved.locks, [{ field: 'name' }]);
  assert.deepEqual(saved.pendingReview, ['待确认']);
  assert.deepEqual(saved.futureExtension, { nested: ['必须保留'] });
  assert.deepEqual(saved.sourceRefs[0], { kind: 'future-ref', locator: 'extension:x', extra: { keep: true } });
  assert.equal(saved.sourceRefs.includes('legacy-ref'), true);
  assert.deepEqual(saved.basicFields.appearance.futureMeta, { keep: true }); assert.equal(saved.basicFields.futureField.value, '保留未知字段');
  assert.deepEqual(saved.dynamicFields.currentGoals.futureMeta, { keep: true }); assert.equal(saved.dynamicFields.futureDynamic.value, '保留未知动态字段');
  assert.equal(client.records.get(`${profiles}/${personaId}`).data.unknownTop, 42);
  assert.equal(puts(client).some(call => call.collection === profiles && call.id === personaId), false);
});

test('纯函数读取宽容但关键身份失败关闭；高版本保守只读', () => {
  assert.deepEqual(BASIC_FIELD_KEYS, ['gender', 'age', 'appearance', 'personality', 'identity', 'nsfwPreferences', 'abilities', 'likes', 'dislikes', 'principles', 'relationships']);
  assert.deepEqual(DYNAMIC_FIELD_KEYS, ['personalityState', 'currentGoals', 'currentSituation', 'currentSecrets', 'wellbeing', 'stableChanges']);
  const required = { chatId, identityId: personaId, subject: 'user', sourceRefs: [{ kind: 'persona', locator: 'me.png' }], sourceBinding: { kind: 'persona', identityId: personaId, locator: 'me.png' } };
  assert.equal(normalizePeopleProfile({ schemaVersion: '1', subject: 'persona', sourceFacts: '旧事实' }, required).data.sourceFacts[0], '旧事实');
  assert.throws(() => normalizePeopleProfile({ identityId: c1 }, required), error => error.foundationStatus === 'identity_mismatch');
  assert.throws(() => normalizePeopleProfile({ schemaVersion: 2 }, required), error => error.foundationStatus === 'future_schema_readonly');
});

test('未来 people-state/profile 与 Persona/card 绑定冲突均零写入', async () => {
  for (const mutate of [
    records => { records[`${collection}/${PEOPLE_STATE_RECORD_ID}`] = envelope({ schemaVersion: 2, kind: 'people-foundation-state', chatId, cardId, personaId }); },
    records => { records[`${profiles}/${c1}`] = envelope(cProfile(c1, '甲', { peopleContractVersion: 2 })); },
    records => {
      records[`${collection}/meta`] = envelope(meta({ personaId: c2 }));
      records[`${collection}/${PEOPLE_STATE_RECORD_ID}`] = envelope({ schemaVersion: 1, contractVersion: 1, kind: 'people-foundation-state', chatId, cardId, personaId, source: { card: { locator: 'char.png' }, persona: { locator: 'me.png' } }, initializedMembers: [], activeMemberIds: [], canonRef: null, status: 'ready' });
    },
    records => { records[`${collection}/meta`] = envelope(meta({ source: { card: { locator: 'other.png' }, persona: { locator: 'me.png' } } })); },
    records => { records[`${collection}/people-index`] = envelope(index({ confirmed: [binding(c1, '甲'), binding(c1, '重复甲')] })); },
    records => { records[`${collection}/people-index`] = envelope(index({ confirmed: [binding(personaId, '身份碰撞')] })); },
  ]) {
    const records = baseRecords(); mutate(records); const client = fakeClient(records);
    const result = await adapter(client).initialize();
    assert.equal(['future_schema_readonly', 'identity_mismatch'].includes(result.status), true, result.status);
    assert.equal(puts(client).length, 0);
  }
  const futureRecords = baseRecords();
  futureRecords[`${collection}/${PEOPLE_STATE_RECORD_ID}`] = envelope({ schemaVersion: 2, contractVersion: 2, kind: 'people-foundation-state', chatId, cardId, personaId, futurePayload: { visible: true }, status: 'ready' });
  const futureClient = fakeClient(futureRecords);
  const restored = await adapter(futureClient).restore();
  assert.equal(restored.status, 'future_schema_readonly');
  assert.equal(restored.readonly, true);
  assert.equal(restored.state.futurePayload.visible, true);
  assert.equal(puts(futureClient).length, 0);
});

test('CAS 409 保留胜出状态并让后续重跑幂等收敛', async () => {
  let race = true;
  const client = fakeClient(baseRecords(), { put: ({ key, data, expectedRevision, records }) => {
    if (race && key === `${collection}/${PEOPLE_STATE_RECORD_ID}`) {
      race = false;
      records.set(key, envelope({ ...data, status: 'initializing', externalWriter: { keep: true } }, expectedRevision + 1));
      throw Object.assign(new Error('409'), { status: 409 });
    }
  } });
  const people = adapter(client);
  const conflicted = await people.initialize({ stableFloorState: stable });
  assert.equal(conflicted.status, 'conflict');
  assert.equal(client.records.get(`${collection}/${PEOPLE_STATE_RECORD_ID}`).data.externalWriter.keep, true);
  const recovered = await people.initialize({ stableFloorState: stable });
  assert.equal(recovered.status, 'ready');
  assert.equal(client.records.get(`${collection}/${PEOPLE_STATE_RECORD_ID}`).data.externalWriter.keep, true);
});

test('中途失败保留 initializing 而不谎报 ready，后续重跑补齐并收敛', async () => {
  let failProfile = true;
  const client = fakeClient(baseRecords(), { put: ({ key }) => {
    if (failProfile && key === `${profiles}/${c1}`) { failProfile = false; throw Object.assign(new Error('500'), { status: 500 }); }
  } });
  const people = adapter(client);
  const failed = await people.initialize({ stableFloorState: stable });
  assert.equal(failed.status, 'storage_error');
  assert.equal(client.records.get(`${collection}/${PEOPLE_STATE_RECORD_ID}`).data.status, 'initializing');
  const recovered = await people.initialize({ stableFloorState: stable });
  assert.equal(recovered.status, 'ready');
  assert.equal(client.records.get(`${collection}/${PEOPLE_STATE_RECORD_ID}`).data.status, 'ready');
  assert.equal(client.records.has(`${profiles}/${c1}`), true);
});

test('运行器生产 seam 在已有成品人物池时初始化千人且 AI 调用数为零', async () => {
  let aiCalls = 0, foundationCalls = 0, stableCalls = 0;
  const runner = createRuntimeRunner({
    orchestrator: { run: async () => ({ status: 'ready' }) },
    people: { getPeople: async () => ({ status: 'ready' }), identify: async () => { aiCalls += 1; return { status: 'ready' }; } },
    stableFloors: { refresh: async () => { stableCalls += 1; return stable; } },
    peopleFoundation: { initialize: async ({ stableFloorState }) => { foundationCalls += 1; assert.equal(stableFloorState, stable); return { status: 'ready' }; } },
  });
  const result = await runner.run();
  assert.equal(result.peopleFoundation.status, 'ready');
  assert.equal(aiCalls, 0);
  assert.equal(stableCalls, 1);
  assert.equal(foundationCalls, 1);
});
