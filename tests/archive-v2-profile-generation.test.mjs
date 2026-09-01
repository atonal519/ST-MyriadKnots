import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/identity.js';
import {
  ARCHIVE_V2_PROFILE_DRAFT_KIND,
  ARCHIVE_V2_PROFILE_FIELD_KEYS,
  ArchiveV2ProfileGenerationError,
  createArchiveV2ProfileGenerator,
} from '../src/archive-v2-profile-generation.js';

const CHAT = '11111111-1111-4111-8111-111111111111';
const OTHER_CHAT = '22222222-2222-4222-8222-222222222222';
const fp = char => `sha256:${char.repeat(64).slice(0, 64)}`;
const source = (content, overrides = {}) => ({
  id: 'card:card:char.png#description', kind: 'card', locator: 'card:char.png#description',
  fingerprint: fp('a'), label: '角色描述', content, selected: true, availability: 'card', ...overrides,
});
async function sourceFingerprint(sources) {
  const selected = sources.filter(item => item.selected === true && item.availability !== 'disabled');
  const parts = [];
  for (const item of selected) parts.push({
    kind: item.kind, locator: item.locator, fingerprint: item.fingerprint,
    contentFingerprint: `sha256:${await sha256(item.content)}`,
  });
  return `sha256:${await sha256(JSON.stringify(parts))}`;
}
const ref = item => ({ kind: item.kind, locator: item.locator, fingerprint: item.fingerprint });
async function fixture({ people } = {}) {
  const sources = [
    source('沈砚：成年男性，黑发，性格沉静。'),
    source('阿福喜欢甜食。', { kind: 'worldbook', locator: 'book:1', fingerprint: fp('b'), availability: 'enabled' }),
  ];
  const fingerprint = await sourceFingerprint(sources);
  const defaultPeople = [
    { identityId: 'p1', displayName: '沈砚', aliases: ['阿砚'], recognitionReason: '核心人物。', sourceRefs: [ref(sources[0])] },
    { identityId: 'p2', displayName: '阿福', aliases: [], recognitionReason: '重要配角。', sourceRefs: [ref(sources[1])] },
  ];
  return {
    sources,
    plan: { schemaVersion: 1, kind: 'myriad-knots-selected-people-plan', chatId: CHAT, sourceFingerprint: fingerprint, people: people ?? defaultPeople },
  };
}
function fields(value = '', evidence = []) {
  return Object.fromEntries(ARCHIVE_V2_PROFILE_FIELD_KEYS.map(key => [key, { value, evidence: [...evidence] }]));
}
const aiPerson = (identityId, overrides = {}) => ({ identityId, fields: fields('', []), ...overrides });
function harness({ generateTask, isEnabled = true } = {}) {
  let context = { hostChatId: 'host-a', chatId: CHAT, characterLocator: 'char.png', personaLocator: 'persona.png' };
  const calls = [];
  const generator = createArchiveV2ProfileGenerator({
    contextProvider: () => context,
    isEnabled,
    generateTask: async options => { calls.push(options); return generateTask(options); },
  });
  return { generator, calls, setContext: value => { context = value; }, getContext: () => context };
}

test('合法多人物计划只调用一次 AI，输出顺序与身份文字完全取自 plan', async () => {
  const f = await fixture();
  f.plan.people[0].displayName = ' 沈砚 ';
  f.plan.people[0].aliases = [' 阿砚 '];
  f.plan.people[0].recognitionReason = ' 核心人物。 ';
  const h = harness({ generateTask: async options => {
    assert.equal(options.includeCharacterCard, false);
    assert.equal(options.worldInfoSource, 'none');
    assert.equal(options.substituteMacros, false);
    assert.equal(options.maxTokens, 30000);
    assert.equal(options.jsonSchema.strict, true);
    assert.match(options.taskMessages[0].content, /p1/);
    assert.doesNotMatch(options.taskMessages[0].content, /card:char|sha256:/);
    return { jsonData: { people: [aiPerson('p2'), aiPerson('p1')] } };
  } });
  const result = await h.generator.generate(f);
  assert.equal(result.status, 'ready');
  assert.equal(result.draft.kind, ARCHIVE_V2_PROFILE_DRAFT_KIND);
  assert.deepEqual(result.draft.people.map(item => [item.identityId, item.displayName, item.aliases]), [
    ['p1', ' 沈砚 ', [' 阿砚 ']], ['p2', '阿福', []],
  ]);
  assert.equal(result.draft.people[0].recognitionReason, ' 核心人物。 ');
  assert.equal(h.calls.length, 1);
});

test('十个字段完整映射所有权并把 evidence 解析为真实 sourceRefs', async () => {
  const f = await fixture({ people: undefined });
  const populated = fields('有依据', ['S1', 'S2']);
  const h = harness({ generateTask: async () => ({ jsonData: { people: [
    aiPerson('p1', { fields: populated }), aiPerson('p2', { fields: populated }),
  ] } }) });
  const result = await h.generator.generate(f);
  const profile = result.draft.people[0];
  assert.deepEqual(Object.keys(profile.fields), ARCHIVE_V2_PROFILE_FIELD_KEYS);
  for (const field of Object.values(profile.fields)) {
    assert.equal(field.origin, 'ai');
    assert.equal(field.userProtected, false);
    assert.deepEqual(field.sourceRefs, [ref(f.sources[0]), ref(f.sources[1])]);
  }
  assert.equal(Object.hasOwn(profile.fields.gender, 'evidence'), false);
});

test('空值只允许空 evidence，非空值必须有 evidence', async () => {
  const f = await fixture();
  for (const invalidField of [
    { value: '', evidence: ['S1'] },
    { value: '男性', evidence: [] },
  ]) {
    const broken = fields('', []); broken.gender = invalidField;
    const h = harness({ generateTask: async () => ({ jsonData: { people: [aiPerson('p1', { fields: broken }), aiPerson('p2')] } }) });
    await assert.rejects(h.generator.generate(f), error => error?.code === 'ARCHIVE_V2_PROFILE_GENERATION_FORMAT');
    assert.equal(h.calls.length, 1);
  }
});

test('plan 固定键、类型、重复 ID、sourceRef 和上限严格拒绝且零 AI', async () => {
  const f = await fixture();
  const invalidPlans = [
    { ...f.plan, loading: true },
    { ...f.plan, kind: 'wrong' },
    { ...f.plan, chatId: '' },
    { ...f.plan, people: [f.plan.people[0], { ...f.plan.people[0] }] },
    { ...f.plan, people: [{ ...f.plan.people[0], content: '正文' }] },
    { ...f.plan, people: [{ ...f.plan.people[0], sourceRefs: [{ ...f.plan.people[0].sourceRefs[0], content: '正文' }] }] },
    { ...f.plan, people: [{ ...f.plan.people[0], displayName: '人'.repeat(121) }] },
  ];
  for (const plan of invalidPlans) {
    const h = harness({ generateTask: async () => { throw new Error('不应调用'); } });
    await assert.rejects(h.generator.generate({ plan, sources: f.sources }), ArchiveV2ProfileGenerationError);
    assert.equal(h.calls.length, 0);
  }
});

test('来源指纹变化、缺失精确 ref、disabled/未选来源和内容上限均零 AI', async () => {
  const f = await fixture();
  const cases = [];
  cases.push({ plan: f.plan, sources: f.sources.map((item, index) => index ? item : { ...item, content: `${item.content}变化` }) });
  const missingRefPlan = structuredClone(f.plan); missingRefPlan.people[0].sourceRefs[0].fingerprint = fp('c');
  cases.push({ plan: missingRefPlan, sources: f.sources });
  for (const key of ['disabled', 'unselected']) {
    const sources = f.sources.map((item, index) => index === 1 ? { ...item, ...(key === 'disabled' ? { availability: 'disabled' } : { selected: false }) } : item);
    const plan = structuredClone(f.plan); plan.sourceFingerprint = await sourceFingerprint(sources);
    cases.push({ plan, sources });
  }
  cases.push({ plan: f.plan, sources: [source('x'.repeat(24001))] });
  for (const value of cases) {
    const h = harness({ generateTask: async () => { throw new Error('不应调用'); } });
    await assert.rejects(h.generator.generate(value), ArchiveV2ProfileGenerationError);
    assert.equal(h.calls.length, 0);
  }
});

test('AI 缺人、多人、重复/额外 ID、未知字段和缺字段整批拒绝', async () => {
  const f = await fixture();
  const invalid = [
    [aiPerson('p1')],
    [aiPerson('p1'), aiPerson('p2'), aiPerson('p3')],
    [aiPerson('p1'), aiPerson('p1')],
    [aiPerson('p1'), aiPerson('extra')],
    [{ ...aiPerson('p1'), displayName: '改名' }, aiPerson('p2')],
    [{ identityId: 'p1' }, aiPerson('p2')],
    [aiPerson('p1', { fields: Object.fromEntries(Object.entries(fields()).slice(1)) }), aiPerson('p2')],
  ];
  for (const people of invalid) {
    const h = harness({ generateTask: async () => ({ jsonData: { people } }) });
    await assert.rejects(h.generator.generate(f), error => error?.code === 'ARCHIVE_V2_PROFILE_GENERATION_FORMAT');
    assert.equal(h.calls.length, 1);
  }
});

test('非法、重复和未知 evidence 均拒绝且不重试', async () => {
  const f = await fixture();
  for (const evidence of [['S1', 'S1'], ['S99'], [1]]) {
    const broken = fields('', []); broken.gender = { value: '男性', evidence };
    const h = harness({ generateTask: async () => ({ jsonData: { people: [aiPerson('p1', { fields: broken }), aiPerson('p2')] } }) });
    await assert.rejects(h.generator.generate(f), ArchiveV2ProfileGenerationError);
    assert.equal(h.calls.length, 1);
  }
});

test('单字段与全响应原始字符上限严格执行', async () => {
  const f = await fixture();
  const tooLong = fields('', []); tooLong.gender = { value: 'x'.repeat(1201), evidence: ['S1'] };
  const h1 = harness({ generateTask: async () => ({ jsonData: { people: [aiPerson('p1', { fields: tooLong }), aiPerson('p2')] } }) });
  await assert.rejects(h1.generator.generate(f), ArchiveV2ProfileGenerationError);
  const manyPeople = Array.from({ length: 80 }, (_, index) => ({
    identityId: `id-${index}`, displayName: `人物${index}`, aliases: [], recognitionReason: '依据', sourceRefs: [ref(f.sources[0])],
  }));
  const largeFixture = await fixture({ people: manyPeople });
  const largeFields = fields('x'.repeat(126), ['S1']);
  const h2 = harness({ generateTask: async () => ({ jsonData: { people: manyPeople.map(item => aiPerson(item.identityId, { fields: largeFields })) } }) });
  await assert.rejects(h2.generator.generate(largeFixture), ArchiveV2ProfileGenerationError);
  assert.equal(h1.calls.length, 1); assert.equal(h2.calls.length, 1);
});

test('空人物计划返回 empty 且零 AI', async () => {
  const f = await fixture({ people: [] });
  const h = harness({ generateTask: async () => { throw new Error('不应调用'); } });
  assert.deepEqual(await h.generator.generate({ plan: f.plan, sources: null }), { status: 'empty' });
  assert.equal(h.calls.length, 0);
});

test('并发 generate 复用同一 promise，只发一次请求', async () => {
  const f = await fixture(); let release;
  const h = harness({ generateTask: async () => { await new Promise(resolve => { release = resolve; }); return { jsonData: { people: [aiPerson('p1'), aiPerson('p2')] } }; } });
  const first = h.generator.generate(f); const second = h.generator.generate(f);
  assert.equal(first, second);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1); release();
  assert.equal((await first).status, 'ready');
});

test('切聊天、disabled、invalidate 与迟到成功均不返回草稿', async () => {
  const f = await fixture();
  const disabled = harness({ isEnabled: false, generateTask: async () => { throw new Error('不应调用'); } });
  assert.deepEqual(await disabled.generator.generate(f), { status: 'disabled' });
  assert.equal(disabled.calls.length, 0);
  for (const action of ['switch', 'invalidate']) {
    let release; let signal;
    const h = harness({ generateTask: async options => { signal = options.signal; await new Promise(resolve => { release = resolve; }); return { jsonData: { people: [aiPerson('p1'), aiPerson('p2')] } }; } });
    const pending = h.generator.generate(f); while (!release) await new Promise(resolve => setImmediate(resolve));
    if (action === 'switch') h.setContext({ ...h.getContext(), chatId: OTHER_CHAT });
    else h.generator.invalidate();
    if (action === 'invalidate') assert.equal(signal.aborted, true);
    release();
    assert.deepEqual(await pending, { status: 'stale' });
  }
});

test('输入、AI 对象和草稿不共享可变引用', async () => {
  const f = await fixture();
  const ai = { people: [aiPerson('p1'), aiPerson('p2')] };
  const h = harness({ generateTask: async () => ({ jsonData: ai }) });
  const result = await h.generator.generate(f);
  result.draft.people[0].aliases.push('外部');
  result.draft.people[0].sourceRefs[0].locator = 'changed';
  result.draft.people[0].fields.gender.sourceRefs.push(ref(f.sources[1]));
  assert.deepEqual(f.plan.people[0].aliases, ['阿砚']);
  assert.equal(f.plan.people[0].sourceRefs[0].locator, 'card:char.png#description');
  assert.deepEqual(ai.people[0].fields.gender, { value: '', evidence: [] });
});

test('模块不调用后端、archive 写入或宿主隐式来源', async () => {
  const f = await fixture(); const sideEffects = { backend: 0, archive: 0, host: 0 };
  const h = harness({ generateTask: async () => ({ jsonData: { people: [aiPerson('p1'), aiPerson('p2')] } }) });
  h.setContext({ ...h.getContext(), backend: () => { sideEffects.backend += 1; }, archive: () => { sideEffects.archive += 1; }, saveMetadata: () => { sideEffects.host += 1; } });
  assert.equal((await h.generator.generate(f)).status, 'ready');
  assert.deepEqual(sideEffects, { backend: 0, archive: 0, host: 0 });
});
