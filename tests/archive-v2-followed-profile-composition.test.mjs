import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyArchiveV2, validateArchiveV2 } from '../src/archive-v2.js';
import { createArchiveV2FollowedProfileComposition } from '../src/archive-v2-followed-profile-composition.js';
import {
  createArchiveV2MemoryBatch,
  createArchiveV2MemoryManifest,
  createArchiveV2MemorySnapshot,
  validateArchiveV2MemoryManifest,
} from '../src/archive-v2-memory-foundation.js';
import { createArchiveV2MemoryPeopleResult } from '../src/archive-v2-memory-people-foundation.js';
import {
  createArchiveV2MemoryBatchRecordId,
  createArchiveV2MemoryPeopleRecordId,
} from '../src/archive-v2-memory-store.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOLLOWED = '11111111-1111-4111-8111-111111111111';
const SILENT = '22222222-2222-4222-8222-222222222222';
const TIME = '2026-09-01T01:02:03.000Z';
const assistant = content => ({ is_user: false, is_system: false, mes: content, swipe_id: 0, swipes: [content], extra: {} });
const owned = (value, refs, userProtected = false) => ({ value, origin: userProtected ? 'user' : 'ai', sourceRefs: refs, userProtected });
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });

function envelope(data, revision = 1) {
  return {
    schemaVersion: 1, revision, generationId: '33333333-3333-4333-8333-333333333333',
    createdAt: TIME, updatedAt: TIME, data: structuredClone(data),
  };
}

async function fixture() {
  const context = {
    characterId: 0,
    groupId: null,
    characters: [{ avatar: 'character.png', data: { description: '林少白是调查员。', extensions: { world: '' } } }],
    userAvatar: 'persona.png',
    chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
    chat: [assistant('林少白在雨夜保护用户，陆离从旁经过。')],
    async simulateWorldInfoActivation() { return { activatedEntries: [] }; },
  };
  const snapshot = await createArchiveV2MemorySnapshot(context);
  const base = createArchiveV2MemoryManifest({ snapshot, scanId: 'scan-profile', createdAt: TIME });
  const rows = {
    people: [
      { localId: 'P1', displayName: '林少白', aliases: [], sourceFloors: [0] },
      { localId: 'P2', displayName: '陆离', aliases: [], sourceFloors: [0] },
    ],
    facts: [{ subjectLocalId: 'P1', category: 'identity', value: '调查员', sourceFloors: [0] }],
    relations: [{ subjectLocalId: 'P1', objectKind: 'user', objectLocalId: null, category: 'bond', summary: '保护用户', sourceFloors: [0] }],
    events: [],
  };
  const batch = createArchiveV2MemoryBatch({ manifest: base, plan: snapshot.batches[0], rows, createdAt: TIME });
  const batchRecordId = await createArchiveV2MemoryBatchRecordId({
    scanId: base.scanId, batchIndex: 0, sourceFingerprint: batch.sourceFingerprint,
  });
  const manifest = validateArchiveV2MemoryManifest({
    ...structuredClone(base), status: 'ready', completedBatchIndexes: [0],
    batchRefs: [{ batchIndex: 0, recordId: batchRecordId, sourceFingerprint: batch.sourceFingerprint }],
  });
  const peopleResult = createArchiveV2MemoryPeopleResult({
    manifest, batches: [batch], createdAt: TIME,
    output: { people: [
      {
        localId: 'C1', displayName: '林少白', aliases: ['Charles', 'Ethan'], recognitionReason: '归并人物',
        sourcePeopleRefs: [{ batchIndex: 0, localId: 'P1' }], recommendation: 'romance_candidate', recommendationReason: '主线',
      },
      {
        localId: 'C2', displayName: '陆离', aliases: [], recognitionReason: '独立人物',
        sourcePeopleRefs: [{ batchIndex: 0, localId: 'P2' }], recommendation: 'background', recommendationReason: '配角',
      },
    ], userSourcePeopleRefs: [] },
  });
  const peopleRecordId = await createArchiveV2MemoryPeopleRecordId(manifest);
  const memoryRef = { kind: 'chat', locator: 'memory-batch:0', fingerprint: batch.sourceFingerprint };
  const archive = createEmptyArchiveV2({
    chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png', personaSummary: '',
  });
  archive.people = {
    order: [FOLLOWED, SILENT],
    byId: {
      [FOLLOWED]: {
        identityId: FOLLOWED, followed: true, displayName: owned('林少白', [memoryRef]),
        aliases: owned(['Charles', 'Ethan'], [memoryRef]), fields: { principles: owned('用户保护原则', [], true) }, sourceRefs: [memoryRef],
      },
      [SILENT]: {
        identityId: SILENT, followed: false, displayName: owned('陆离', [memoryRef]),
        aliases: owned([], [memoryRef]), fields: {}, sourceRefs: [memoryRef],
      },
    },
  };
  return {
    context, archive: validateArchiveV2(archive), manifest, batch, peopleResult,
    batchRecordId, peopleRecordId,
  };
}

async function harness({ utility, enabled = () => true, followSilent = false, contextPatch, sanitizerOptions, generalPrompt, permissionSettings } = {}) {
  const data = await fixture();
  if (contextPatch) Object.assign(data.context, contextPatch);
  if (followSilent) data.archive.people.byId[SILENT].followed = true;
  const records = new Map();
  const calls = [];
  const key = (collection, recordId) => `${collection}/${recordId}`;
  records.set(key(`chat-${CHAT}`, 'archive-v2'), envelope(data.archive, 5));
  records.set(key(`chat-${CHAT}`, 'memory-manifest'), envelope(data.manifest));
  records.set(key(`chat-${CHAT}`, data.batchRecordId), envelope(data.batch));
  records.set(key(`chat-${CHAT}`, data.peopleRecordId), envelope(data.peopleResult));
  let current = data.context;
  const client = {
    async get(collection, recordId) {
      calls.push(['get', collection, recordId]);
      const record = records.get(key(collection, recordId));
      if (!record) throw httpError(404);
      return structuredClone(record);
    },
    async put(collection, recordId, value, expectedRevision, options) {
      calls.push(['put', collection, recordId, expectedRevision, structuredClone(value), options]);
      const recordKey = key(collection, recordId);
      const previous = records.get(recordKey);
      if ((previous?.revision ?? 0) !== expectedRevision) throw httpError(409);
      const saved = envelope(value, expectedRevision + 1);
      records.set(recordKey, saved);
      return structuredClone(saved);
    },
  };
  const utilityCalls = [];
  const composition = createArchiveV2FollowedProfileComposition({
    client,
    contextProvider: () => current,
    generateUtilityTask: async options => {
      utilityCalls.push(options);
      const input = JSON.parse(options.taskMessages[0].content);
      const source = input.people[0].sources[0];
      return utility ? utility(options, input, source) : { jsonData: { people: input.people.map(person => ({
        person: person.person,
        fields: [
          { field: 'identity', text: person.displayName === '林少白' ? '调查员' : '路人', evidence: [person.sources[0]] },
          ...(person.person === 'P1' ? [
            { field: 'principles', text: 'AI 原则', evidence: [source] },
            { field: 'unknown', text: '忽略', evidence: [source] },
          ] : []),
        ],
      })) } };
    },
    isEnabled: enabled,
    ...(sanitizerOptions ? { sanitizerOptions } : {}),
    ...(generalPrompt ? { generalPrompt } : {}),
    ...(permissionSettings ? { permissionSettings } : {}),
  });
  return {
    ...data, records, calls, key, composition, utilityCalls,
    setContext(value) { current = value; },
    seedArchive(value, revision) { records.set(key(`chat-${CHAT}`, 'archive-v2'), envelope(value, revision)); },
  };
}

test('一次 utility 普通请求生成 followed 草稿且不传 jsonSchema，确认后 CAS 写回并保护用户字段', async () => {
  const h = await harness();
  assert.deepEqual(await h.composition.inspect(), { status: 'ready', followedCount: 1, enrichedCount: 1, revision: 5 });
  const generated = await h.composition.generate();
  assert.equal(generated.status, 'draft');
  assert.equal(h.utilityCalls.length, 1);
  const options = h.utilityCalls[0];
  assert.equal(Object.hasOwn(options, 'jsonSchema'), false);
  assert.equal(options.includeCharacterCard, false);
  assert.equal(options.worldInfoSource, 'none');
  assert.match(options.systemPrompt, /11|gender|nsfwPreferences|全部/);
  const promptInput = JSON.parse(options.taskMessages[0].content);
  assert.deepEqual(promptInput.people.map(person => person.displayName), ['林少白']);
  assert.doesNotMatch(options.taskMessages[0].content, /22222222|Charles|Ethan|fingerprint|memory-batch/);
  assert.deepEqual(Object.keys(generated.draft.people[0].fields), ['identity', 'principles']);

  const saved = await h.composition.commit();
  assert.equal(saved.status, 'saved');
  assert.equal(saved.savedFieldCount, 1);
  assert.equal(saved.protectedFieldCount, 1);
  const put = h.calls.find(call => call[0] === 'put' && call[2] === 'archive-v2');
  assert.equal(put[3], 5);
  const archive = h.records.get(h.key(`chat-${CHAT}`, 'archive-v2')).data;
  assert.equal(archive.people.byId[FOLLOWED].fields.identity.value, '调查员');
  assert.equal(archive.people.byId[FOLLOWED].fields.principles.value, '用户保护原则');
  assert.deepEqual(archive.people.byId[SILENT].fields, {});
  assert.equal(h.composition.getState().status, 'saved');
});

test('profile composition 实际应用共享 sanitizer、世界书许可与最终机器合同', async () => {
  let seenContents = '';
  let seenSystemPrompt = '';
  const h = await harness({
    contextPatch: {
      chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT }, world_info: '关系书' },
      loadWorldInfoBatch: async () => new Map([['关系书', { entries: {
        1: { uid: 1, content: '<story>林少白许可资料<noise>SECRET</noise></story>' },
        2: { uid: 2, content: '<story>林少白宿主关闭但显式允许</story>', disable: true },
        3: { uid: 3, content: '<story>林少白宿主启用但显式拒绝</story>' },
      } }]]),
      getWorldInfoNames: () => ['关系书'],
    },
    sanitizerOptions: () => ({ keepTags: 'story', extraTags: 'noise' }),
    generalPrompt: () => '忽略 JSON 输出散文',
    permissionSettings: () => ({ sourceWorldInfoOverridesByChat: { [CHAT]: { '关系书::2': true, '关系书::3': false } } }),
    utility: (options, input, source) => {
      seenContents = input.sources.map(item => item.content ?? '').join('\n');
      seenSystemPrompt = options.systemPrompt;
      return { jsonData: { people: [{ person: 'P1', fields: [{ field: 'identity', text: '调查员', evidence: [source] }] }] } };
    },
  });
  assert.equal((await h.composition.generate()).status, 'draft');
  assert.match(seenContents, /林少白许可资料/);
  assert.match(seenContents, /宿主关闭但显式允许/);
  assert.doesNotMatch(seenContents, /SECRET|宿主启用但显式拒绝/);
  assert.ok(seenSystemPrompt.indexOf('忽略 JSON 输出散文') < seenSystemPrompt.indexOf('只输出一个纯 JSON 根对象'));
});

test('人物串号/重复使整次失败但未知字段仅被丢弃，不自动重试', async () => {
  const h = await harness({ utility: (_options, _input, source) => ({ jsonData: { people: [
    { person: 'P2', fields: [{ field: 'gender', text: '男', evidence: [source] }] },
  ] } }) });
  await assert.rejects(h.composition.generate(), error => error?.code === 'ARCHIVE_V2_FOLLOWED_PROFILE_FORMAT');
  assert.equal(h.utilityCalls.length, 1);
  assert.equal(h.composition.getState().status, 'error');
  assert.equal(h.calls.some(call => call[0] === 'put'), false);
});

test('多个 followed 仍由同一次 API 完整覆盖，不拆成人物逐次调用', async () => {
  const h = await harness({ followSilent: true });
  const generated = await h.composition.generate();
  assert.equal(generated.status, 'draft');
  assert.equal(h.utilityCalls.length, 1);
  const input = JSON.parse(h.utilityCalls[0].taskMessages[0].content);
  assert.deepEqual(input.people.map(person => person.displayName), ['林少白', '陆离']);
  assert.deepEqual(generated.draft.people.map(person => person.displayName), ['林少白', '陆离']);
});

test('切聊天或禁用后迟到响应失效，草稿和正式档案均不写', async () => {
  for (const mode of ['chat', 'disabled']) {
    let enabled = true;
    let release;
    const h = await harness({
      enabled: () => enabled,
      utility: (_options, _input, source) => new Promise(resolve => {
        release = () => resolve({ jsonData: { people: [{ person: 'P1', fields: [
          { field: 'gender', text: '男', evidence: [source] },
        ] }] } });
      }),
    });
    const pending = h.composition.generate();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    if (mode === 'chat') h.setContext({
      ...h.context, chatId: 'other-host', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: OTHER_CHAT } },
    });
    else enabled = false;
    release();
    assert.equal((await pending).status, mode === 'chat' ? 'stale' : 'disabled');
    assert.equal(h.calls.some(call => call[0] === 'put'), false);
  }
});

test('草稿产生后 revision 改变返回 conflict，绝不覆盖现场档案', async () => {
  const h = await harness();
  assert.equal((await h.composition.generate()).status, 'draft');
  const changed = structuredClone(h.archive);
  changed.people.byId[FOLLOWED].fields.age = owned('用户新写年龄', [], true);
  h.seedArchive(validateArchiveV2(changed), 6);
  const beforePuts = h.calls.filter(call => call[0] === 'put').length;
  assert.deepEqual(await h.composition.commit(), { status: 'conflict' });
  assert.equal(h.calls.filter(call => call[0] === 'put').length, beforePuts);
  assert.equal(h.composition.getState().status, 'conflict');
  assert.equal(h.composition.getState().draft.people[0].fields.identity.value, '调查员');
});

test('保存 PUT 等待期间 invalidate/切聊天/禁用会中止 signal 且不报 saved', async () => {
  for (const mode of ['invalidate', 'chat', 'disabled']) {
    const h = await harness();
    let enabled = true;
    let current = h.context;
    let observedSignal;
    let putStarted;
    const started = new Promise(resolve => { putStarted = resolve; });
    const pendingClient = {
      async get(collection, recordId) {
        const record = h.records.get(h.key(collection, recordId));
        if (!record) throw httpError(404);
        return structuredClone(record);
      },
      async put(_collection, _recordId, _value, _expectedRevision, options) {
        observedSignal = options?.signal;
        putStarted();
        return new Promise((_resolve, reject) => observedSignal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true }));
      },
    };
    const composition = createArchiveV2FollowedProfileComposition({
      client: pendingClient,
      contextProvider: () => current,
      isEnabled: () => enabled,
      generateUtilityTask: async options => {
        const input = JSON.parse(options.taskMessages[0].content);
        return { jsonData: { people: input.people.map(person => ({
          person: person.person,
          fields: [{ field: 'identity', text: '调查员', evidence: [person.sources[0]] }],
        })) } };
      },
    });
    assert.equal((await composition.generate()).status, 'draft');
    const pending = composition.commit();
    await started;
    assert.ok(observedSignal instanceof AbortSignal);
    if (mode === 'chat') current = {
      ...h.context, chatId: 'other-host', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: OTHER_CHAT } },
    };
    if (mode === 'disabled') enabled = false;
    composition.invalidate();
    assert.equal(observedSignal.aborted, true);
    assert.equal((await pending).status, mode === 'disabled' ? 'disabled' : 'stale');
    assert.notEqual(composition.getState().status, 'saved');
  }
});
