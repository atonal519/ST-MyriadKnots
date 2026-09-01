import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256 } from '../src/identity.js';
import {
  ARCHIVE_V2_CANDIDATE_DRAFT_KIND,
  ARCHIVE_V2_CANDIDATE_DRAFT_SCHEMA_VERSION,
} from '../src/archive-v2-recognition.js';
import {
  ARCHIVE_V2_PROFILE_DRAFT_KIND,
  ARCHIVE_V2_PROFILE_FIELD_KEYS,
} from '../src/archive-v2-profile-generation.js';
import {
  ArchiveV2InitializationFlowError,
  createArchiveV2InitializationFlow,
} from '../src/archive-v2-initialization-flow.js';

const CHAT = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-08-31T12:00:00.000Z';
const fp = char => `sha256:${char.repeat(64).slice(0, 64)}`;
const ref = source => ({ kind: source.kind, locator: source.locator, fingerprint: source.fingerprint });

function source(id, overrides = {}) {
  return {
    id,
    kind: 'card',
    locator: `${id}:locator`,
    fingerprint: fp(id.at(-1) || 'a'),
    label: id,
    content: `${id} 正文`,
    selected: true,
    availability: 'card',
    ...overrides,
  };
}

function defaultSources() {
  return [
    source('source-a', { fingerprint: fp('a') }),
    source('source-b', {
      kind: 'worldbook',
      fingerprint: fp('b'),
      availability: 'enabled',
    }),
    source('source-c', {
      kind: 'worldbook',
      fingerprint: fp('c'),
      availability: 'disabled',
      selected: false,
    }),
  ];
}

async function sourceFingerprint(sources) {
  const selected = sources.filter(item => item.selected === true && item.availability !== 'disabled');
  const parts = [];
  for (const item of selected) parts.push({
    kind: item.kind,
    locator: item.locator,
    fingerprint: item.fingerprint,
    contentFingerprint: `sha256:${await sha256(item.content)}`,
  });
  return `sha256:${await sha256(JSON.stringify(parts))}`;
}

async function candidateDraft(sources, count = 3) {
  const selected = sources.filter(item => item.selected === true && item.availability !== 'disabled');
  return {
    schemaVersion: ARCHIVE_V2_CANDIDATE_DRAFT_SCHEMA_VERSION,
    kind: ARCHIVE_V2_CANDIDATE_DRAFT_KIND,
    chatId: CHAT,
    sourceFingerprint: await sourceFingerprint(sources),
    candidates: Array.from({ length: count }, (_, index) => ({
      candidateId: `c${index + 1}`,
      displayName: `人物${index + 1}`,
      aliases: [],
      reason: `人物${index + 1} 的识别依据`,
      sourceRefs: [ref(selected[index % selected.length])],
    })),
  };
}

function profileFields(sourceRefs) {
  return Object.fromEntries(ARCHIVE_V2_PROFILE_FIELD_KEYS.map(key => [key, {
    value: key === 'gender' ? '未知' : '',
    origin: 'ai',
    sourceRefs: key === 'gender' ? sourceRefs.map(item => ({ ...item })) : [],
    userProtected: false,
  }]));
}

function profileDraft(plan) {
  return {
    schemaVersion: 1,
    kind: ARCHIVE_V2_PROFILE_DRAFT_KIND,
    chatId: plan.chatId,
    sourceFingerprint: plan.sourceFingerprint,
    people: plan.people.map(person => ({
      identityId: person.identityId,
      displayName: person.displayName,
      aliases: [...person.aliases],
      recognitionReason: person.recognitionReason,
      sourceRefs: person.sourceRefs.map(item => ({ ...item })),
      fields: profileFields(person.sourceRefs),
    })),
  };
}

function harness(overrides = {}) {
  let context = {
    hostChatId: 'host-chat',
    chatId: CHAT,
    characterLocator: 'char.png',
    personaLocator: 'persona.png',
    chat: [],
  };
  const log = [];
  const invalidations = { recognizer: 0, profile: 0 };
  const collectResult = {
    status: 'ready',
    candidates: defaultSources(),
    warnings: [{ code: 'sample_warning' }],
  };
  const collectSources = overrides.collectSources ?? (async (ctx, options) => {
    log.push(['collect', ctx, options]);
    return collectResult;
  });
  const recognizer = {
    recognize: overrides.recognize ?? (async ({ sources }) => {
      log.push(['recognize', sources]);
      return { status: 'ready', draft: await candidateDraft(sources) };
    }),
    invalidate() { invalidations.recognizer += 1; overrides.recognizerInvalidate?.(); },
  };
  const profileGenerator = {
    generate: overrides.generate ?? (async ({ plan, sources }) => {
      log.push(['generate', plan, sources]);
      return plan.people.length === 0
        ? { status: 'empty' }
        : { status: 'ready', draft: profileDraft(plan) };
    }),
    invalidate() { invalidations.profile += 1; overrides.profileInvalidate?.(); },
  };
  const committer = {
    commit: overrides.commit ?? (async ({ archive }) => {
      log.push(['commit', archive]);
      return { status: 'created', archive, revision: 1, warnings: [] };
    }),
  };
  let nowCalls = 0;
  const flow = createArchiveV2InitializationFlow({
    sourceContextProvider: () => context,
    recognizer,
    profileGenerator,
    committer,
    collectSources,
    now: () => { nowCalls += 1; return NOW; },
  });
  return {
    flow,
    log,
    collectResult,
    invalidations,
    getContext: () => context,
    setContext: value => { context = value; },
    getNowCalls: () => nowCalls,
  };
}

async function reachCandidates(h, selectedIds = ['c1']) {
  await h.flow.loadSources();
  await h.flow.recognizeCandidates();
  for (const id of selectedIds) h.flow.setCandidateSelected(id, true);
}

async function reachProfiles(h, selectedIds = ['c1']) {
  await reachCandidates(h, selectedIds);
  await h.flow.generateProfiles();
}

const identity = () => ({
  characterLocator: 'char.png',
  personaLocator: 'persona.png',
  personaSummary: 'Persona 摘要',
});

test('注入依赖完成 sources→candidates→profiles→completed 全链且参数顺序正确', async () => {
  const h = harness();
  assert.equal((await h.flow.loadSources({ chatRange: { start: 1, end: 2 } })).status, 'ready');
  assert.equal((await h.flow.recognizeCandidates()).status, 'ready');
  h.flow.setCandidateSelected('c1', true);
  h.flow.renameCandidate('c1', '沈砚');
  assert.equal((await h.flow.generateProfiles()).status, 'ready');
  h.flow.setProfileField({ identityId: 'c1', field: 'age', value: '  28  ' });
  const result = await h.flow.commitInitialization({ identity: identity() });
  assert.equal(result.status, 'created');
  const completed = h.flow.getState();
  assert.equal(completed.stage, 'completed');
  assert.deepEqual(completed.sources, []);
  assert.equal(completed.candidateReview, null);
  assert.equal(completed.profileReview, null);
  assert.deepEqual(h.log.map(item => item[0]), ['collect', 'recognize', 'generate', 'commit']);
  assert.deepEqual(h.log[0][2], { chatRange: { start: 1, end: 2 } });
  assert.equal(h.log[2][1].people[0].displayName, '沈砚');
  assert.equal(h.log[3][1].initialization.confirmedAt, NOW);
  assert.equal(h.getNowCalls(), 1);
});

test('来源选择只改内存且 disabled 来源不能选中', async () => {
  const h = harness(); await h.flow.loadSources();
  h.flow.setSourceSelected('source-a', false);
  assert.equal(h.flow.getState().sources[0].selected, false);
  assert.throws(
    () => h.flow.setSourceSelected('source-c', true),
    error => error?.code === 'ARCHIVE_V2_INITIALIZATION_FLOW_SOURCE_DISABLED',
  );
  assert.equal(h.flow.getState().sources[2].selected, false);
  const invalidDependency = harness({
    collectSources: async () => ({
      status: 'ready',
      candidates: [source('bad-disabled', { availability: 'disabled', selected: true })],
      warnings: [],
    }),
  });
  await assert.rejects(
    invalidDependency.flow.loadSources(),
    error => error?.code === 'ARCHIVE_V2_INITIALIZATION_FLOW_CONTRACT',
  );
  assert.equal(invalidDependency.flow.getState().stage, 'idle');
});

test('各阶段越级操作均以 STAGE_INVALID 拒绝', async () => {
  const h = harness();
  const stageError = error => error?.code === 'ARCHIVE_V2_INITIALIZATION_FLOW_STAGE_INVALID';
  for (const action of [
    () => h.flow.recognizeCandidates(),
    () => h.flow.setCandidateSelected('c1', true),
    () => h.flow.generateProfiles(),
    () => h.flow.setProfileField({ identityId: 'c1', field: 'age', value: '20' }),
    () => h.flow.commitInitialization({ identity: identity() }),
  ]) assert.throws(action, stageError);
  await h.flow.loadSources();
  assert.throws(() => h.flow.renameCandidate('c1', '改名'), stageError);
  assert.throws(() => h.flow.backToCandidates(), stageError);
});

test('候选选择、改名、别名、合并和删除实际保持生产纯函数语义', async () => {
  const h = harness(); await reachCandidates(h, []);
  h.flow.setCandidateSelected('c2', true);
  h.flow.renameCandidate('c1', '沈砚');
  h.flow.setCandidateAliases('c1', ['阿砚', '阿砚']);
  h.flow.mergeCandidates({ targetId: 'c1', sourceIds: ['c2'] });
  h.flow.removeCandidate('c3');
  const candidates = h.flow.getState().candidateReview.candidates;
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateId, 'c1');
  assert.equal(candidates[0].displayName, '沈砚');
  assert.equal(candidates[0].selected, true);
  assert.deepEqual(candidates[0].aliases, ['阿砚', '人物2']);
  assert.equal(candidates[0].sourceRefs.length, 2);
});

test('零已选人物返回 empty 且不丢候选审核态', async () => {
  const h = harness(); await reachCandidates(h, []);
  const before = h.flow.getState().candidateReview;
  assert.deepEqual(await h.flow.generateProfiles(), { status: 'empty' });
  const after = h.flow.getState();
  assert.equal(after.stage, 'candidates');
  assert.deepEqual(after.candidateReview, before);
});

test('profile 字段修改获得 user/protected/清证据语义', async () => {
  const h = harness(); await reachProfiles(h);
  h.flow.setProfileField({ identityId: 'c1', field: 'gender', value: '  女性  ' });
  assert.deepEqual(h.flow.getState().profileReview.people[0].fields.gender, {
    value: '女性', origin: 'user', sourceRefs: [], userProtected: true,
  });
});

test('backToCandidates/backToSources 只清理对应下游并保留来源勾选', async () => {
  const h = harness();
  await h.flow.loadSources(); h.flow.setSourceSelected('source-b', false);
  await h.flow.recognizeCandidates(); h.flow.setCandidateSelected('c1', true);
  await h.flow.generateProfiles();
  h.flow.backToCandidates();
  let state = h.flow.getState();
  assert.equal(state.stage, 'candidates');
  assert.ok(state.candidateReview); assert.equal(state.profileReview, null);
  assert.equal(state.sources[1].selected, false);
  h.flow.backToSources();
  state = h.flow.getState();
  assert.equal(state.stage, 'sources');
  assert.equal(state.candidateReview, null); assert.equal(state.profileReview, null);
  assert.equal(state.sources[1].selected, false);
});

test('终端非成功状态和依赖抛错均不破坏当前可编辑状态', async () => {
  for (const status of ['conflict', 'stale', 'disabled']) {
    const h = harness({ commit: async () => ({ status }) });
    await reachProfiles(h);
    const before = h.flow.getState().profileReview;
    assert.deepEqual(await h.flow.commitInitialization({ identity: identity(), confirmedAt: NOW }), { status });
    assert.equal(h.flow.getState().stage, 'profiles');
    assert.deepEqual(h.flow.getState().profileReview, before);
  }
  const recognizerError = harness({ recognize: async () => { throw new Error('识别失败'); } });
  await recognizerError.flow.loadSources();
  await assert.rejects(recognizerError.flow.recognizeCandidates(), /识别失败/);
  assert.equal(recognizerError.flow.getState().stage, 'sources');
  const commitError = harness({ commit: async () => { throw new Error('提交失败'); } });
  await reachProfiles(commitError);
  await assert.rejects(commitError.flow.commitInitialization({ identity: identity(), confirmedAt: NOW }), /提交失败/);
  assert.equal(commitError.flow.getState().stage, 'profiles');
});

test('同动作并发共享 Promise，不同动作和同步编辑在 busy 时拒绝', async () => {
  let release;
  const h = harness({
    collectSources: async () => {
      await new Promise(resolve => { release = resolve; });
      return { status: 'ready', candidates: defaultSources(), warnings: [] };
    },
  });
  const first = h.flow.loadSources();
  const second = h.flow.loadSources();
  assert.equal(first, second);
  assert.equal(h.flow.getState().busy, true);
  const busy = error => error?.code === 'ARCHIVE_V2_INITIALIZATION_FLOW_BUSY';
  assert.throws(() => h.flow.recognizeCandidates(), busy);
  assert.throws(() => h.flow.setSourceSelected('source-a', false), busy);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(); await first;
  assert.equal(h.flow.getState().busy, false);
});

test('reset 调用两个 invalidate，迟到识别结果不能污染新 idle', async () => {
  let release; let seenSources;
  const h = harness({
    recognize: async ({ sources }) => {
      seenSources = sources;
      await new Promise(resolve => { release = resolve; });
      return { status: 'ready', draft: await candidateDraft(seenSources) };
    },
  });
  await h.flow.loadSources();
  const pending = h.flow.recognizeCandidates();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.flow.reset();
  assert.deepEqual(h.invalidations, { recognizer: 1, profile: 1 });
  assert.equal(h.flow.getState().stage, 'idle');
  release();
  assert.deepEqual(await pending, { status: 'stale' });
  assert.equal(h.flow.getState().stage, 'idle');

  let collects = 0;
  const immediate = harness({
    collectSources: async () => {
      collects += 1;
      return { status: 'ready', candidates: defaultSources(), warnings: [] };
    },
  });
  const notStarted = immediate.flow.loadSources();
  immediate.flow.reset();
  assert.deepEqual(await notStarted, { status: 'stale' });
  assert.equal(collects, 0);
});

test('来源采集期间切换 chat、character 或 persona 都返回 stale', async () => {
  for (const change of [
    { chatId: 'other-chat' },
    { characterLocator: 'other-char.png' },
    { personaLocator: 'other-persona.png' },
  ]) {
    let release;
    const h = harness({
      collectSources: async () => {
        await new Promise(resolve => { release = resolve; });
        return { status: 'ready', candidates: defaultSources(), warnings: [] };
      },
    });
    const pending = h.flow.loadSources();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    h.setContext({ ...h.getContext(), ...change });
    release();
    assert.deepEqual(await pending, { status: 'stale' });
    assert.equal(h.flow.getState().stage, 'idle');
  }
});

test('状态、输入和依赖返回值均不与内部状态共享可变引用', async () => {
  let commitRelease; let receivedArchive;
  const h = harness({
    commit: async ({ archive }) => {
      receivedArchive = archive;
      await new Promise(resolve => { commitRelease = resolve; });
      return { status: 'created', archive, revision: 1, warnings: [] };
    },
  });
  await h.flow.loadSources();
  h.collectResult.candidates[0].content = '依赖事后篡改';
  let exposed = h.flow.getState();
  assert.equal(exposed.sources[0].content, 'source-a 正文');
  exposed.sources[0].content = '调用者篡改';
  assert.equal(h.flow.getState().sources[0].content, 'source-a 正文');
  await h.flow.recognizeCandidates(); h.flow.setCandidateSelected('c1', true);
  await h.flow.generateProfiles();
  const inputIdentity = identity();
  const pending = h.flow.commitInitialization({ identity: inputIdentity, confirmedAt: NOW });
  inputIdentity.personaSummary = '调用后篡改';
  while (!commitRelease) await new Promise(resolve => setImmediate(resolve));
  assert.equal(receivedArchive.identity.personaSummary, 'Persona 摘要');
  commitRelease(); await pending;
  exposed = h.flow.getState();
  exposed.result.archive.identity.personaSummary = '结果篡改';
  assert.equal(h.flow.getState().result.archive.identity.personaSummary, 'Persona 摘要');
});

test('生产流程模块无 UI/index/backend/AI 直连且不包含持久化运行态', async () => {
  const code = await readFile(new URL('../src/archive-v2-initialization-flow.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /from ['"].*(?:index|ui|backend-client|compact-api-client)/);
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|fetch\s*\(/);
  assert.doesNotMatch(code, /document\.|querySelector|addEventListener/);
});
