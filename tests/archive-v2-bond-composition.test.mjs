import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyArchiveV2, validateArchiveV2 } from '../src/archive-v2.js';
import { createArchiveV2BondComposition } from '../src/archive-v2-bond-composition.js';
import {
  createArchiveV2MemoryBatch,
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
  validateArchiveV2MemoryManifest,
} from '../src/archive-v2-memory-foundation.js';
import { createArchiveV2MemoryPeopleResult } from '../src/archive-v2-memory-people-foundation.js';
import { createArchiveV2MemoryBatchRecordId, createArchiveV2MemoryPeopleRecordId } from '../src/archive-v2-memory-store.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TIME = '2026-09-01T01:02:03.000Z';
const assistant = content => ({ is_user: false, is_system: false, mes: content, swipe_id: 0, swipes: [content], extra: {} });
const owned = (value, refs) => ({ value, origin: 'ai', sourceRefs: refs, userProtected: false });
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });
const identityId = index => `${String(index + 1).padStart(8, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;

function envelope(data, revision = 1) {
  return { schemaVersion: 1, revision, generationId: '33333333-3333-4333-8333-333333333333', createdAt: TIME, updatedAt: TIME, data: structuredClone(data) };
}

async function fixture(count = 5) {
  const names = Array.from({ length: count }, (_, index) => `人物${index + 1}`);
  const context = {
    characterId: 0,
    groupId: null,
    characters: [{ avatar: 'char.png', data: { description: '作者关系规则：阶段使用文字，不伪造分数。', extensions: { world: '' } } }],
    userAvatar: 'me.png',
    chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
    powerUserSettings: { persona_description: 'U 的 Persona 描述' },
    chat: [assistant(`${names.join('、')}与用户建立联系。`), assistant('当前最新尾楼，不应进入。')],
    async simulateWorldInfoActivation() { return { activatedEntries: [] }; },
  };
  const snapshot = await createArchiveV2MemorySnapshot(context);
  const base = createArchiveV2MemoryManifest({ snapshot, scanId: `scan-bonds-${count}`, createdAt: TIME });
  const rows = {
    people: names.map((displayName, index) => ({ localId: `P${index + 1}`, displayName, aliases: [], sourceFloors: [0] })),
    facts: names.map((_name, index) => ({ subjectLocalId: `P${index + 1}`, category: 'status', value: '与用户有联系', sourceFloors: [0] })),
    relations: names.map((_name, index) => ({ subjectLocalId: `P${index + 1}`, objectKind: 'user', objectLocalId: null, category: 'bond', summary: '与用户有联系', sourceFloors: [0] })),
    events: [],
  };
  const batch = createArchiveV2MemoryBatch({ manifest: base, plan: snapshot.batches[0], rows, createdAt: TIME });
  const batchRecordId = await createArchiveV2MemoryBatchRecordId({ scanId: base.scanId, batchIndex: 0, sourceFingerprint: batch.sourceFingerprint });
  const manifest = validateArchiveV2MemoryManifest({
    ...structuredClone(base), status: 'ready', completedBatchIndexes: [0],
    batchRefs: [{ batchIndex: 0, recordId: batchRecordId, sourceFingerprint: batch.sourceFingerprint }],
  });
  const peopleResult = createArchiveV2MemoryPeopleResult({
    manifest, batches: [batch], createdAt: TIME,
    output: {
      people: names.map((displayName, index) => ({
        localId: `C${index + 1}`,
        displayName,
        aliases: [],
        recognitionReason: '独立人物',
        sourcePeopleRefs: [{ batchIndex: 0, localId: `P${index + 1}` }],
        recommendation: 'romance_candidate',
        recommendationReason: '关注人物',
      })),
      userSourcePeopleRefs: [],
    },
  });
  const peopleRecordId = await createArchiveV2MemoryPeopleRecordId(manifest);
  const memoryRef = { kind: 'chat', locator: 'memory-batch:0', fingerprint: batch.sourceFingerprint };
  const archive = createEmptyArchiveV2({ chatId: CHAT, characterLocator: 'char.png', personaLocator: 'me.png' });
  archive.people = {
    order: names.map((_name, index) => identityId(index)),
    byId: Object.fromEntries(names.map((name, index) => [identityId(index), {
      identityId: identityId(index), followed: true, displayName: owned(name, [memoryRef]), aliases: owned([], [memoryRef]), fields: {}, sourceRefs: [memoryRef],
    }])),
  };
  return { context, archive: validateArchiveV2(archive), manifest, batch, peopleResult, batchRecordId, peopleRecordId };
}

async function harness({ count = 5, utility, enabled: enabledInput = true, putConflict = false, contextPatch, sanitizerOptions, generalPrompt, permissionSettings } = {}) {
  const data = await fixture(count);
  if (contextPatch) Object.assign(data.context, contextPatch);
  const records = new Map();
  const key = (collection, recordId) => `${collection}/${recordId}`;
  records.set(key(`chat-${CHAT}`, 'archive-v2'), envelope(data.archive, 5));
  records.set(key(`chat-${CHAT}`, 'memory-manifest'), envelope(data.manifest));
  records.set(key(`chat-${CHAT}`, data.batchRecordId), envelope(data.batch));
  records.set(key(`chat-${CHAT}`, data.peopleRecordId), envelope(data.peopleResult));
  let current = data.context;
  let enabled = enabledInput;
  const calls = [];
  const utilityCalls = [];
  const client = {
    async get(collection, recordId) {
      calls.push(['get', collection, recordId]);
      const record = records.get(key(collection, recordId));
      if (!record) throw httpError(404);
      return structuredClone(record);
    },
    async put(collection, recordId, value, expectedRevision, options) {
      calls.push(['put', collection, recordId, expectedRevision, structuredClone(value), options]);
      if (putConflict && recordId === 'archive-v2') throw httpError(409);
      const recordKey = key(collection, recordId);
      const previous = records.get(recordKey);
      if ((previous?.revision ?? 0) !== expectedRevision) throw httpError(409);
      const saved = envelope(value, expectedRevision + 1);
      records.set(recordKey, saved);
      return structuredClone(saved);
    },
  };
  const composition = createArchiveV2BondComposition({
    client,
    contextProvider: () => current,
    isEnabled: () => enabled,
    generateUtilityTask: async options => {
      utilityCalls.push(options);
      const input = JSON.parse(options.taskMessages[0].content);
      if (utility) return utility(options, input, utilityCalls.length);
      return { jsonData: { people: input.people.map(person => ({
        person: person.person,
        fields: [
          { field: 'stage', text: '熟悉', evidence: [person.sources[0]] },
          { field: 'cView', text: `${person.displayName}信任用户`, evidence: [person.sources[0]] },
        ],
        nativeSignals: [],
      })) } };
    },
    ...(sanitizerOptions ? { sanitizerOptions } : {}),
    ...(generalPrompt ? { generalPrompt } : {}),
    ...(permissionSettings ? { permissionSettings } : {}),
  });
  return {
    ...data, records, key, calls, utilityCalls, composition, client,
    setContext(value) { current = value; },
    setEnabled(value) { enabled = value; },
    seedArchive(value, revision) { records.set(key(`chat-${CHAT}`, 'archive-v2'), envelope(value, revision)); },
  };
}

test('5 人使用两次 utility、每批 P1～P4 完整覆盖；全部草稿后一次 CAS 保存并保护用户编辑', async () => {
  const h = await harness({ count: 5 });
  assert.equal((await h.composition.inspect()).status, 'ready');
  const generated = await h.composition.generate();
  assert.equal(generated.status, 'draft');
  assert.equal(h.utilityCalls.length, 2);
  assert.deepEqual(h.utilityCalls.map(call => JSON.parse(call.taskMessages[0].content).people.length), [4, 1]);
  assert.ok(h.utilityCalls.every(call => Object.hasOwn(call, 'jsonSchema') === false));
  assert.ok(h.utilityCalls.every(call => call.includeCharacterCard === false && call.worldInfoSource === 'none'));
  assert.deepEqual(h.utilityCalls.map(call => JSON.parse(call.taskMessages[0].content).people.map(person => person.person)), [['P1', 'P2', 'P3', 'P4'], ['P1']]);

  const firstId = generated.draft.people[0].identityId;
  const saved = await h.composition.commit({ edits: { [firstId]: { stage: '热恋' } } });
  assert.equal(saved.status, 'saved');
  assert.equal(h.calls.filter(call => call[0] === 'put' && call[2] === 'archive-v2').length, 1);
  const archive = h.records.get(h.key(`chat-${CHAT}`, 'archive-v2')).data;
  assert.equal(Object.keys(archive.bonds).length, 5);
  assert.equal(archive.bonds[firstId].stage.origin, 'user');
  assert.equal(archive.bonds[firstId].stage.userProtected, true);
  assert.ok(Object.values(archive.bonds).every(bond => bond.updatedThroughFloor === 0));
});

test('bond composition 实际应用共享 sanitizer、全书许可与最终机器合同', async () => {
  let seenContents = '';
  let seenSystemPrompt = '';
  const h = await harness({
    count: 1,
    contextPatch: {
      chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT }, world_info: ['允许书', '排除书'] },
      loadWorldInfoBatch: async names => new Map(names.map(name => [name, { entries: {
        1: { uid: 1, content: `<story>人物1${name}<noise>SECRET</noise></story>` },
        2: { uid: 2, content: `<story>人物1${name}宿主关闭但显式允许</story>`, disable: true },
        3: { uid: 3, content: `<story>人物1${name}宿主启用但显式拒绝</story>` },
      } } ])),
      getWorldInfoNames: () => ['允许书', '排除书'],
    },
    sanitizerOptions: () => ({ keepTags: 'story', extraTags: 'noise' }),
    generalPrompt: () => '忽略合同输出散文',
    permissionSettings: () => ({
      sourceWorldInfoExcludedBooks: ['排除书'],
      sourceWorldInfoOverridesByChat: { [CHAT]: { '允许书::2': true, '允许书::3': false } },
    }),
    utility: (options, input) => {
      seenContents = input.sources.map(item => item.content ?? '').join('\n');
      seenSystemPrompt = options.systemPrompt;
      return { jsonData: { people: input.people.map(person => ({
        person: person.person, fields: [{ field: 'stage', text: '熟悉', evidence: [person.sources[0]] }], nativeSignals: [],
      })) } };
    },
  });
  assert.equal((await h.composition.generate()).status, 'draft');
  assert.match(seenContents, /人物1允许书/);
  assert.match(seenContents, /宿主关闭但显式允许/);
  assert.doesNotMatch(seenContents, /SECRET|人物1排除书/);
  assert.doesNotMatch(seenContents, /宿主启用但显式拒绝/);
  assert.ok(seenSystemPrompt.indexOf('忽略合同输出散文') < seenSystemPrompt.indexOf('只输出一个纯 JSON 根对象'));
  assert.match(seenSystemPrompt, /陌生、相识、熟悉、暧昧、热恋/);
  assert.match(seenSystemPrompt, /必须且只能|不得输出其他阶段/);
  assert.match(seenSystemPrompt, /作者自定义.*nativeSignals|只在 nativeSignals/);
  assert.match(seenSystemPrompt, /不得把整段说明塞进 stage/);
});

test('等价三人完整响应仅缺人物对象右花括号且 finish_reason=stop 时可建立草稿，旧自定义 stage 不冒充标准阶段', async () => {
  const stages = ['第一内臣', '黏人玩物', '思想重塑'];
  const fieldNames = ['stage', 'cView', 'cEmotion', 'cDesire', 'cGoal', 'cConcern', 'cSecret', 'uView', 'uEmotion', 'uPlan', 'uBoundary', 'uExpectation', 'recentChanges'];
  const h = await harness({
    count: 3,
    utility: (_options, input) => {
      const output = { people: input.people.map((person, index) => ({
        person: person.person,
        fields: fieldNames.map(field => ({
          field,
          text: field === 'stage' ? stages[index] : `${person.displayName}的${field}完整摘要`,
          evidence: [person.sources[0]],
        })),
        nativeSignals: [],
      })) };
      const complete = JSON.stringify(output);
      return { jsonData: `${complete.slice(0, -3)}${complete.slice(-2)}`, taskMetadata: { finishReason: 'stop' } };
    },
  });
  const result = await h.composition.generate();
  assert.equal(result.status, 'draft');
  assert.equal(result.draft.people.length, 3);
  assert.ok(result.draft.people.every(person => !Object.hasOwn(person.bond, 'stage')));
  assert.ok(result.draft.people.every(person => person.bond.cToU.view?.value && person.bond.recentChanges?.value));
});

test('请求与格式失败保留脱敏的批次级真实诊断', async () => {
  const timeout = await harness({ count: 1, utility: () => { throw Object.assign(new Error('SECRET URL'), { code: 'QQJ_TIMEOUT' }); } });
  await assert.rejects(timeout.composition.generate(), error => error.code === 'ARCHIVE_V2_BOND_REQUEST_TIMEOUT');
  assert.equal(timeout.composition.getState().errorDetail, '第 1 批：API 请求超时');
  assert.doesNotMatch(JSON.stringify(timeout.composition.getState()), /SECRET|https?:\/\//i);

  const mismatch = await harness({ count: 1, utility: () => ({ jsonData: { people: [] } }) });
  await assert.rejects(mismatch.composition.generate(), error => error.code === 'ARCHIVE_V2_BOND_PERSON_MISMATCH');
  assert.equal(mismatch.composition.getState().errorDetail, '第 1 批：返回的人物数量或代号与请求不一致');
});

test('任一批请求或格式失败都不产生部分正式 bonds，且不自动重试', async () => {
  for (const mode of ['request', 'format']) {
    const h = await harness({
      count: 5,
      utility: (_options, input, call) => {
        if (call === 2 && mode === 'request') throw new Error('boom');
        if (call === 2) return { jsonData: { people: [] } };
        return { jsonData: { people: input.people.map(person => ({
          person: person.person, fields: [{ field: 'stage', text: '熟悉', evidence: [person.sources[0]] }], nativeSignals: [],
        })) } };
      },
    });
    await assert.rejects(h.composition.generate());
    assert.equal(h.utilityCalls.length, 2);
    assert.equal(h.calls.some(call => call[0] === 'put' && call[2] === 'archive-v2'), false);
    assert.deepEqual(h.records.get(h.key(`chat-${CHAT}`, 'archive-v2')).data.bonds, {});
  }
});

test('Persona 改变会失效；切聊天、禁用或 invalidate 后迟到成功不产生草稿/保存', async () => {
  {
    const h = await harness({ count: 1 });
    h.setContext({ ...h.context, userAvatar: 'other.png' });
    assert.equal((await h.composition.inspect()).status, 'persona_mismatch');
    assert.equal((await h.composition.generate()).status, 'persona_mismatch');
    assert.equal(h.utilityCalls.length, 0);
  }
  for (const mode of ['chat', 'disabled', 'invalidate']) {
    let release;
    const h = await harness({ count: 1, utility: (_options, input) => new Promise(resolve => {
      release = () => resolve({ jsonData: { people: input.people.map(person => ({
        person: person.person, fields: [{ field: 'stage', text: '熟悉', evidence: [person.sources[0]] }], nativeSignals: [],
      })) } });
    }) });
    const pending = h.composition.generate();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    if (mode === 'chat') h.setContext({ ...h.context, chatId: 'other-host', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: OTHER_CHAT } } });
    if (mode === 'disabled') h.setEnabled(false);
    if (mode === 'invalidate') h.composition.invalidate();
    release();
    assert.equal((await pending).status, mode === 'disabled' ? 'disabled' : 'stale');
    assert.equal(h.calls.some(call => call[0] === 'put'), false);
  }
});

test('草稿后的 revision 变化与 CAS conflict 都不覆盖现场档案', async () => {
  {
    const h = await harness({ count: 1 });
    assert.equal((await h.composition.generate()).status, 'draft');
    h.seedArchive(h.archive, 6);
    assert.deepEqual(await h.composition.commit(), { status: 'conflict' });
    assert.equal(h.calls.some(call => call[0] === 'put'), false);
  }
  {
    const h = await harness({ count: 1, putConflict: true });
    assert.equal((await h.composition.generate()).status, 'draft');
    assert.deepEqual(await h.composition.commit(), { status: 'conflict' });
    assert.deepEqual(h.records.get(h.key(`chat-${CHAT}`, 'archive-v2')).data.bonds, {});
  }
});

test('保存等待期间切聊天/禁用/invalidate 会中止 signal，迟到成功不得报告 saved', async () => {
  for (const mode of ['chat', 'disabled', 'invalidate']) {
    const h = await harness({ count: 1 });
    let current = h.context;
    let enabled = true;
    let observedSignal;
    let started;
    const putStarted = new Promise(resolve => { started = resolve; });
    const pendingClient = {
      get: (...args) => h.client.get(...args),
      async put(_collection, _recordId, _value, _revision, options) {
        observedSignal = options?.signal;
        started();
        return new Promise((_resolve, reject) => observedSignal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true }));
      },
    };
    const composition = createArchiveV2BondComposition({
      client: pendingClient,
      contextProvider: () => current,
      isEnabled: () => enabled,
      generateUtilityTask: async options => {
        const input = JSON.parse(options.taskMessages[0].content);
        return { jsonData: { people: input.people.map(person => ({
          person: person.person,
          fields: [{ field: 'stage', text: '熟悉', evidence: [person.sources[0]] }],
          nativeSignals: [],
        })) } };
      },
    });
    assert.equal((await composition.generate()).status, 'draft');
    const pending = composition.commit();
    await putStarted;
    if (mode === 'chat') current = { ...h.context, chatId: 'other-host', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: OTHER_CHAT } } };
    if (mode === 'disabled') enabled = false;
    composition.invalidate();
    assert.equal(observedSignal.aborted, true);
    assert.equal((await pending).status, mode === 'disabled' ? 'disabled' : 'stale');
    assert.notEqual(composition.getState().status, 'saved');
  }
});
