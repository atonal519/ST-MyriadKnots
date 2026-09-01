import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_V2_CANDIDATE_DRAFT_KIND,
  ARCHIVE_V2_CANDIDATE_DRAFT_SCHEMA_VERSION,
  ArchiveV2RecognitionError,
  createArchiveV2CandidateRecognizer,
} from '../src/archive-v2-recognition.js';

const CHAT = '11111111-1111-4111-8111-111111111111';
const OTHER_CHAT = '22222222-2222-4222-8222-222222222222';
const fp = character => `sha256:${character.repeat(64).slice(0, 64)}`;

function source(content, overrides = {}) {
  return {
    id: 'card:card:char.png#description',
    kind: 'card',
    locator: 'card:char.png#description',
    fingerprint: fp('a'),
    label: '角色描述',
    content,
    selected: true,
    availability: 'card',
    ...overrides,
  };
}

function answer(people = []) {
  return { jsonData: { people } };
}

function person(overrides = {}) {
  return { name: '沈砚', aliases: ['阿砚'], reason: '来源明确描述其为核心人物。', evidence: ['S1'], ...overrides };
}

function harness({ generateTask, isEnabled = true, createId } = {}) {
  let current = {
    hostChatId: 'host-chat-a',
    chatId: CHAT,
    characterLocator: 'char.png',
    personaLocator: 'persona.png',
  };
  const calls = [];
  const recognizer = createArchiveV2CandidateRecognizer({
    contextProvider: () => current,
    isEnabled,
    createId: createId || (({ index }) => `candidate-${index + 1}`),
    generateTask: async options => {
      calls.push(options);
      return generateTask ? generateTask(options) : answer([person()]);
    },
  });
  return { recognizer, calls, setContext(value) { current = value; }, getContext() { return current; } };
}

test('模块创建与读取状态零 AI，显式 recognize 才调用一次', async () => {
  const h = harness();
  assert.deepEqual(h.recognizer.getState(), { status: 'idle' });
  assert.equal(h.calls.length, 0);
  const result = await h.recognizer.recognize({ sources: [source('沈砚是核心人物')] });
  assert.equal(result.status, 'ready');
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.recognizer.getState(), { status: 'idle' });
});

test('提示词只含 selected 且可用来源，以 S 代号隐藏内部 locator/fingerprint/UUID', async () => {
  const h = harness({
    generateTask: async options => {
      const prompt = options.taskMessages[0].content;
      assert.match(prompt, /\[S1\][\s\S]*SELECTED_CONTENT/);
      assert.doesNotMatch(prompt, /UNSELECTED_SECRET|DISABLED_SECRET/);
      assert.doesNotMatch(prompt, /private-locator|sha256:|11111111-1111-4111-8111-111111111111/);
      assert.equal(options.includeCharacterCard, false);
      assert.equal(options.worldInfoSource, 'none');
      assert.equal(options.substituteMacros, false);
      assert.equal(options.jsonSchema.strict, true);
      assert.equal(options.jsonSchema.name, 'qianqianjie_v2_candidate_recognition');
      return answer([person()]);
    },
  });
  const sources = [
    source('SELECTED_CONTENT', { locator: 'private-locator', fingerprint: fp('x') }),
    source('UNSELECTED_SECRET', { selected: false, locator: 'unselected' }),
    source('DISABLED_SECRET', { availability: 'disabled', locator: 'disabled' }),
  ];
  assert.equal((await h.recognizer.recognize({ sources })).status, 'ready');
  assert.equal(h.calls.length, 1);
});

test('合法输出生成安全候选草稿，evidence 映射为不含 content 的 sourceRefs', async () => {
  const sources = [
    source('来源甲', { kind: 'card', locator: 'card-a', fingerprint: fp('a') }),
    source('来源乙', { kind: 'worldbook', locator: 'book:1', fingerprint: fp('b'), availability: 'enabled' }),
  ];
  const h = harness({ generateTask: async () => answer([person({ evidence: ['S2', 'S1'] })]) });
  const result = await h.recognizer.recognize({ sources });
  assert.equal(result.status, 'ready');
  assert.equal(result.draft.schemaVersion, ARCHIVE_V2_CANDIDATE_DRAFT_SCHEMA_VERSION);
  assert.equal(result.draft.kind, ARCHIVE_V2_CANDIDATE_DRAFT_KIND);
  assert.equal(result.draft.chatId, CHAT);
  assert.match(result.draft.sourceFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.draft.candidates, [{
    candidateId: 'candidate-1',
    displayName: '沈砚',
    aliases: ['阿砚'],
    reason: '来源明确描述其为核心人物。',
    sourceRefs: [
      { kind: 'worldbook', locator: 'book:1', fingerprint: fp('b') },
      { kind: 'card', locator: 'card-a', fingerprint: fp('a') },
    ],
  }]);
  assert.equal(JSON.stringify(result.draft.candidates[0].sourceRefs).includes('来源'), false);
});

test('sourceFingerprint 不使用显示 label 作为事实身份', async () => {
  const first = harness({ generateTask: async () => answer([]) });
  const second = harness({ generateTask: async () => answer([]) });
  const a = await first.recognizer.recognize({ sources: [source('同一内容', { label: '显示甲' })] });
  const b = await second.recognizer.recognize({ sources: [source('同一内容', { label: '显示乙' })] });
  assert.equal(a.draft.sourceFingerprint, b.draft.sourceFingerprint);
});

test('空 people 合法且只调用一次', async () => {
  const h = harness({ generateTask: async () => answer([]) });
  const result = await h.recognizer.recognize({ sources: [source('没有可靠人物')] });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.draft.candidates, []);
  assert.equal(h.calls.length, 1);
});

test('禁用字段、未知键/evidence、空值、超长内容和错误结构均安全失败且不重试', async () => {
  const invalidPeople = [
    { people: [{ ...person(), candidateId: 'AI-ID' }] },
    { people: [{ ...person(), confidence: 1 }] },
    { people: [person({ evidence: ['S99'] })] },
    { people: [person({ name: '' })] },
    { people: [person({ reason: ' ' })] },
    { people: [person({ name: '人'.repeat(121) })] },
    { people: [person({ aliases: ['别名'.repeat(61)] })] },
    { people: [person({ name: `${' '.repeat(10000)}沈砚` })] },
    { people: [person({ aliases: [`${' '.repeat(10000)}阿砚`] })] },
    { people: [person({ reason: `${' '.repeat(10000)}具体依据` })] },
    { people: 'wrong' },
    { people: [], status: 'ready' },
  ];
  for (const jsonData of invalidPeople) {
    const h = harness({ generateTask: async () => ({ jsonData }) });
    await assert.rejects(
      h.recognizer.recognize({ sources: [source('来源')] }),
      error => error instanceof ArchiveV2RecognitionError && error.code === 'ARCHIVE_V2_RECOGNITION_FORMAT',
    );
    assert.equal(h.calls.length, 1);
  }
});

test('字符串坏 JSON 格式失败不触发第二次 AI', async () => {
  const h = harness({ generateTask: async () => ({ jsonData: '{bad json' }) });
  await assert.rejects(
    h.recognizer.recognize({ sources: [source('来源')] }),
    error => error?.code === 'ARCHIVE_V2_RECOGNITION_FORMAT',
  );
  assert.equal(h.calls.length, 1);
});

test('零选中、超来源数、单项和总字符超限均零 AI', async () => {
  const cases = [
    [source('x', { selected: false })],
    Array.from({ length: 81 }, (_, index) => source('x', { locator: `source-${index}` })),
    [source('x'.repeat(24001))],
    Array.from({ length: 6 }, (_, index) => source('x'.repeat(21000), { locator: `large-${index}` })),
  ];
  for (const sources of cases) {
    const h = harness();
    await assert.rejects(h.recognizer.recognize({ sources }), error => error instanceof ArchiveV2RecognitionError);
    assert.equal(h.calls.length, 0);
  }
});

test('candidateId 只由注入工厂生成且必须唯一，AI 提供 ID 会失败', async () => {
  const ids = ['memory-a', 'memory-b'];
  const h = harness({
    createId: ({ index }) => ids[index],
    generateTask: async () => answer([person({ name: '甲' }), person({ name: '乙' })]),
  });
  const result = await h.recognizer.recognize({ sources: [source('甲和乙')] });
  assert.deepEqual(result.draft.candidates.map(item => item.candidateId), ids);

  const invalid = harness({ generateTask: async () => answer([{ ...person(), candidateId: 'from-ai' }]) });
  await assert.rejects(invalid.recognizer.recognize({ sources: [source('来源')] }));
  assert.equal(invalid.calls.length, 1);
});

test('createId 连续返回相同 ID 时安全失败且不返回部分草稿', async () => {
  const h = harness({
    createId: () => 'duplicate-id',
    generateTask: async () => answer([person({ name: '甲' }), person({ name: '乙' })]),
  });
  await assert.rejects(
    h.recognizer.recognize({ sources: [source('甲和乙')] }),
    error => error instanceof ArchiveV2RecognitionError
      && error.code === 'ARCHIVE_V2_RECOGNITION_ID_INVALID',
  );
  assert.equal(h.calls.length, 1);
});

test('同名候选不擅自合并，完整留给用户确认', async () => {
  const h = harness({ generateTask: async () => answer([
    person({ reason: '第一处依据。' }),
    person({ aliases: ['另一称呼'], reason: '第二处依据。' }),
  ]) });
  const result = await h.recognizer.recognize({ sources: [source('两处同名')] });
  assert.equal(result.draft.candidates.length, 2);
  assert.deepEqual(result.draft.candidates.map(item => item.displayName), ['沈砚', '沈砚']);
  assert.notEqual(result.draft.candidates[0].candidateId, result.draft.candidates[1].candidateId);
});

test('输入、AI 原始对象和返回草稿不共享引用', async () => {
  const sources = [source('人物来源')];
  const ai = { people: [person()] };
  const h = harness({ generateTask: async () => ({ jsonData: ai }) });
  const result = await h.recognizer.recognize({ sources });
  result.draft.candidates[0].aliases.push('外部修改');
  result.draft.candidates[0].sourceRefs[0].locator = 'changed';
  assert.deepEqual(ai.people[0].aliases, ['阿砚']);
  assert.equal(sources[0].locator, 'card:char.png#description');
  ai.people[0].aliases.push('AI 后改');
  assert.deepEqual(result.draft.candidates[0].aliases, ['阿砚', '外部修改']);
  assert.equal(Object.hasOwn(result.draft.candidates[0].sourceRefs[0], 'content'), false);
});

test('同时重复 recognize 复用同一 promise 且只发出一个请求', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ generateTask: async () => { await gate; return answer([person()]); } });
  const first = h.recognizer.recognize({ sources: [source('来源')] });
  const second = h.recognizer.recognize({ sources: [source('另一来源')] });
  assert.equal(first, second);
  while (h.calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  release();
  assert.equal((await first).status, 'ready');
});

test('invalidate/cancel 传递 AbortSignal、触发 abort 并使旧结果 stale', async () => {
  for (const action of ['invalidate', 'cancel']) {
    let observedSignal;
    const h = harness({
      generateTask: async ({ signal }) => {
        observedSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        ));
      },
    });
    const pending = h.recognizer.recognize({ sources: [source('来源')] });
    while (!observedSignal) await new Promise(resolve => setImmediate(resolve));
    assert.ok(observedSignal instanceof AbortSignal);
    h.recognizer[action]();
    assert.equal(observedSignal.aborted, true);
    assert.deepEqual(await pending, { status: 'stale' });
    assert.equal(h.calls.length, 1);
  }
});

test('disabled 零 AI；切聊天或 Persona 后迟到结果只返回 stale', async () => {
  const disabled = harness({ isEnabled: false });
  assert.deepEqual(
    await disabled.recognizer.recognize({ sources: [source('来源')] }),
    { status: 'disabled' },
  );
  assert.equal(disabled.calls.length, 0);

  for (const mutate of [
    h => h.setContext({ ...h.getContext(), hostChatId: 'host-chat-b', chatId: OTHER_CHAT }),
    h => h.setContext({ ...h.getContext(), personaLocator: 'other-persona.png' }),
  ]) {
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const h = harness({ generateTask: async () => { started(); await new Promise(resolve => { release = resolve; }); return answer([person()]); } });
    const pending = h.recognizer.recognize({ sources: [source('来源')] });
    await entered;
    mutate(h);
    release();
    assert.deepEqual(await pending, { status: 'stale' });
    assert.equal(h.calls.length, 1);
  }
});

test('AI 失败只调用一次且不泄露原始错误', async () => {
  const h = harness({ generateTask: async () => { throw new Error('SECRET_API_KEY'); } });
  await assert.rejects(
    h.recognizer.recognize({ sources: [source('来源')] }),
    error => error?.code === 'ARCHIVE_V2_RECOGNITION_FAILED' && !error.message.includes('SECRET'),
  );
  assert.equal(h.calls.length, 1);
});

test('全过程零后端、零正式档案写入、零宿主写入', async () => {
  const sideEffects = { backend: 0, archive: 0, host: 0 };
  const h = harness({ generateTask: async () => answer([]) });
  h.setContext({
    ...h.getContext(),
    backendClient: { put: () => { sideEffects.backend += 1; } },
    archiveAdapter: { create: () => { sideEffects.archive += 1; }, save: () => { sideEffects.archive += 1; } },
    saveMetadata: () => { sideEffects.host += 1; },
  });
  const result = await h.recognizer.recognize({ sources: [source('来源')] });
  assert.equal(result.status, 'ready');
  assert.deepEqual(sideEffects, { backend: 0, archive: 0, host: 0 });
});
