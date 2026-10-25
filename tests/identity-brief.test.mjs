import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createExtractorEnvelope, normalizeExtractorResponse, EXTRACTOR_PROMPT_VERSION } from '../src/v3/extractor.js';
import { compileCseResponse, createCseEnvelope } from '../src/v3/cse-engine.js';
import { buildEntityIdentityDirectory, entitiesThroughFloorIds } from '../src/v3/entity-identity.js';
import { validateEntityRecord } from '../src/v3/memory-schema.js';
import { buildPublicContext } from '../src/v3/public-context.js';
import { createPublicMemoryBridge } from '../src/v3/public-memory-bridge.js';
import { projectRecallSource } from '../src/v3/recall-source.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const NPC = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const CHAR = '55555555-5555-4555-8555-555555555555';
const BATCH = '66666666-6666-4666-8666-666666666666';
const NOW = '2026-10-25T01:00:00.000Z';
const entity = (extra = {}) => ({ schemaVersion: 3, recordType: 'entity', id: NPC, chatId: CHAT, narrativeGeneration: GEN,
  entityType: 'person', displayName: '沈禾', aliases: [], specialRole: 'none', firstSeenFloorId: F1, lastSeenFloorId: F1,
  status: 'established', mergedIntoEntityId: null, mergeEvidenceRefs: [], baselineClaimIds: [], createdAt: NOW,
  updatedAt: NOW, recordStatus: 'active', supersedes: null, ...extra });
const floor = (id = F1, content = '沈禾是北城图书馆管理员。') => ({ id, chatId: CHAT, narrativeGeneration: GEN,
  assistantSeq: id === F1 ? 1 : 2, content: { canonicalContent: content, rawFingerprint: `sha256:${createHash('sha256').update(content).digest('hex')}` } });
const evidence = (quote = '沈禾是北城图书馆管理员。', extra = {}) => [{ quoteSegments: [quote], supports: '明确的职业身份',
  evidenceMode: 'explicit', sourceMentionKey: null, ...extra }];
const facts = (quote, extra) => [{ kind: 'occupation', text: '北城图书馆管理员。', evidence: evidence(quote, extra) }];
const order = new Map([[F1, 0], [F2, 1]]);

test('简介剧情楼序：补旧楼的处理时间不能盖过后楼，同楼修订仍有效', () => {
  const original = entity({ identityBrief: '图书馆学徒。' });
  const later = entity({ id: BATCH, status: 'merged', mergedIntoEntityId: NPC, firstSeenFloorId: F2,
    identityBrief: '图书馆管理员。', updatedAt: '2026-10-24T01:00:00.000Z' });
  const reprocessed = entity({ id: USER, status: 'merged', mergedIntoEntityId: NPC, identityBrief: '图书馆学徒。', updatedAt: NOW });
  const directory = buildEntityIdentityDirectory({ entities: [original, later, reprocessed], floorOrder: order });
  assert.equal(directory[0].identityBrief, '图书馆管理员。');
  assert.equal(directory[0].identityBriefSource.entityRecordId, BATCH);
  assert.equal(directory[0].identityBriefSource.legacy, true);
  const revised = { ...later, id: CHAR, identityBrief: '图书馆馆长。', updatedAt: NOW };
  assert.equal(buildEntityIdentityDirectory({ entities: [revised, reprocessed, original, later], floorOrder: order })[0].identityBrief, '图书馆馆长。');
});

test('稳定身份条目：摘要实际编译逐条保存定位依据，旧无依据string不影响摘要', async () => {
  const f = floor();
  const envelope = await createExtractorEnvelope({ batchId: BATCH, chatId: CHAT, narrativeGeneration: GEN, floor: f, entities: [], floorOrder: order });
  const compile = response => normalizeExtractorResponse({ response, envelope, floor: f, now: NOW, existingEntities: [], expectedScope: envelope.scope });
  const result = await compile({ summary: '沈禾介绍自己的职业。', people: [{ name: '沈禾', identityFacts: facts() }] });
  assert.equal(result.newEntities[0].identityBrief, '北城图书馆管理员。');
  const source = result.newEntities[0].identityBriefSource;
  assert.equal(source.sourceFloorId, F1);
  assert.equal(source.origin, 'extractor');
  assert.equal(source.facts[0].evidence[0].quotedText, f.content.canonicalContent);
  assert.equal(source.facts[0].evidence[0].floorId, F1);
  assert.deepEqual(validateEntityRecord(result.newEntities[0]).identityBriefSource, source);
  const legacy = await compile({ summary: '仍可用的摘要。', people: [{ name: '沈禾', identityBrief: '无来源的稳定身份。' }] });
  assert.equal(legacy.memory.summary.aiText, '仍可用的摘要。');
  assert.equal(Object.hasOwn(legacy.newEntities[0], 'identityBrief'), false);
});

test('稳定身份条目：CSE实际编译保存世界书可信定位，坏完整列表只隔离简介', async () => {
  const npc = entity();
  const baseline = { id: BATCH, userPersona: { entityId: USER, name: '林岚', description: '' },
    characterCard: { entityId: CHAR, name: '顾舟', description: '', personality: '', scenario: '' }, worldInfoSources: [] };
  const world = { sourceName: '城志', content: '沈禾是北城图书馆管理员。', locator: '城志:7', fingerprint: 'sha256:known' };
  const envelope = createCseEnvelope({ floor: floor(), floorMemory: { id: F2, summary: {}, participants: [] }, baseline, currentState: null,
    trackedSubjects: [], entities: [npc], identityBriefTargets: [{ entityId: NPC, name: '沈禾', labels: ['沈禾'] }],
    requestSources: { worldInfoSources: [world] } });
  const targetKey = envelope.scope.identityBriefBindings[0].key;
  const compile = identityFacts => compileCseResponse({ response: { noMaterialChange: true, identityBriefUpdates: [{ targetKey, identityFacts }] },
    envelope, previousCurrentState: null, now: NOW, deltaId: BATCH });
  const result = await compile([{ kind: 'occupation', text: '北城图书馆管理员。', evidence: [{ source: 'worldbook:1', quote: world.content, locator: '模型自报不可用' }] }]);
  assert.equal(result.identityBriefUpdates.length, 1);
  const source = result.identityBriefUpdates[0].identityBriefSource;
  assert.equal(source.sourceDeltaId, BATCH);
  assert.equal(source.facts[0].evidence[0].locator, '城志:7');
  assert.equal(source.facts[0].evidence[0].fingerprint, 'sha256:known');
  const bad = await compile([{ kind: 'occupation', text: '北城图书馆管理员。', evidence: [{ source: 'worldbook:1', quote: world.content }] },
    { kind: 'relation', text: '顾舟的同事。', evidence: [{ source: 'worldbook:1', quote: '未出现的原句' }] }]);
  assert.deepEqual(bad.identityBriefUpdates, []);
  assert.ok(bad.delta);
});

test('稳定身份条目：旧有据条目仅本目标key可复用，同文补依据仍保存且复用不增修订', async () => {
  const f = floor();
  const old = entity({ identityBrief: '北城图书馆管理员。', updatedAt: '2026-10-24T01:00:00.000Z' });
  const envelope = await createExtractorEnvelope({ batchId: BATCH, chatId: CHAT, narrativeGeneration: GEN, floor: f, entities: [old] });
  const upgrade = await normalizeExtractorResponse({ response: { summary: '沈禾介绍职业。', people: [{ name: '沈禾', sameAsEntityKey: 'catalog-1',
    identityBrief: old.identityBrief, identityBriefEvidence: evidence() }] }, envelope, floor: f, existingEntities: [old], now: NOW, expectedScope: envelope.scope });
  assert.equal(upgrade.newEntities.length, 1, '相同文字首次保存真实依据');
  const source = upgrade.newEntities[0].identityBriefSource;
  const other = entity({ id: USER, displayName: '顾舟', identityBrief: old.identityBrief, identityBriefSource: source });
  const current = [old, ...upgrade.newEntities, other];
  const next = await createExtractorEnvelope({ batchId: CHAR, chatId: CHAT, narrativeGeneration: GEN, floor: f, entities: current, floorOrder: order });
  const targets = next.request.payload.knownPeople;
  assert.notEqual(targets[0].identityFacts[0].existingKey, targets[1].identityFacts[0].existingKey);
  assert.equal(Object.hasOwn(targets[0], 'identityBrief'), false, '有据条目不重复发送拼接全文');
  assert.equal(JSON.stringify(targets).includes('quotedText'), false, '输入不复制旧引文');
  const compile = update => normalizeExtractorResponse({ response: { summary: '本楼摘要保留。', people: [{ name: '沈禾', sameAsEntityKey: targets[0].entityKey, ...update }] },
    envelope: next, floor: f, existingEntities: current, now: NOW, expectedScope: next.scope });
  const retained = await compile({ identityFacts: [{ existingKey: targets[0].identityFacts[0].existingKey }] });
  assert.equal(retained.newEntities.length, 0);
  for (const update of [
    { identityFacts: [{ existingKey: targets[1].identityFacts[0].existingKey }] },
    { identityFacts: [{ existingKey: targets[0].identityFacts[0].existingKey }, { kind: 'relation', text: '顾舟的同事。', evidence: evidence('正文不存在') }] },
    { identityFacts: [], identityBrief: '不能借string绕过列表。' },
    {},
  ]) {
    const result = await compile(update);
    assert.equal(result.newEntities.length, 0);
    assert.equal(result.memory.summary.aiText, '本楼摘要保留。');
  }
});

test('稳定身份条目：聚合依据保真实成员楼与前置user索引，未来出处不入早楼', async () => {
  const first = floor(F1), second = floor(F2, '沈禾递来一本新书。');
  const aggregate = { ...second, content: { ...second.content, canonicalContent: first.content.canonicalContent + '\n' + second.content.canonicalContent } };
  const envelope = await createExtractorEnvelope({ batchId: BATCH, chatId: CHAT, narrativeGeneration: GEN, floor: aggregate,
    sourceFloors: [{ floor: first }, { floor: second, sourceUserInputSnapshot: { messages: [{ content: '沈禾是顾舟的姐姐。', messageIndex: 2 }] } }], entities: [] });
  const result = await normalizeExtractorResponse({ response: { summary: '沈禾介绍职业与亲属。', people: [{ name: '沈禾', identityFacts: [
    ...facts(first.content.canonicalContent, { sourceFloorKey: 'floor-1' }),
    { kind: 'relation', text: '顾舟的姐姐。', evidence: evidence('沈禾是顾舟的姐姐。', { sourceFloorKey: 'floor-2', sourceType: 'precedingUser', sourceSnapshotIndex: 0 }) },
  ] }] }, envelope, floor: aggregate, existingEntities: [], now: NOW, expectedScope: envelope.scope });
  const stored = result.newEntities[0];
  assert.equal(stored.identityBriefSource.sourceFloorId, F2);
  assert.deepEqual(stored.identityBriefSource.facts.map(fact => fact.evidence[0].floorId), [F1, F2]);
  assert.equal(stored.identityBriefSource.facts[1].evidence[0].sourceType, 'precedingUser');
  assert.equal(stored.identityBriefSource.facts[1].evidence[0].sourceSnapshotIndex, 0);
  const projected = entitiesThroughFloorIds([{ ...stored, firstSeenFloorId: F1 }], new Set([F1]));
  assert.equal(Object.hasOwn(projected[0], 'identityBriefSource'), false);
  assert.equal(Object.hasOwn(projected[0], 'identityBrief'), false);
});

test('稳定身份条目：整份证据和文字上限不按事实数放大，不截尾保存', async () => {
  const f = floor();
  const envelope = await createExtractorEnvelope({ batchId: BATCH, chatId: CHAT, narrativeGeneration: GEN, floor: f, entities: [] });
  for (const identityFacts of [
    [{ kind: 'occupation', text: '图书馆管理员。', evidence: Array.from({ length: 11 }, () => evidence()[0]) },
      { kind: 'identity', text: '沈禾本人。', evidence: Array.from({ length: 10 }, () => evidence()[0]) }],
    [{ kind: 'identity', text: '甲'.repeat(210), evidence: evidence() }, { kind: 'occupation', text: '乙'.repeat(210), evidence: evidence() }],
  ]) {
    const result = await normalizeExtractorResponse({ response: { summary: '摘要仍保存。', people: [{ name: '沈禾', identityFacts }] },
      envelope, floor: f, existingEntities: [], now: NOW, expectedScope: envelope.scope });
    assert.equal(Object.hasOwn(result.newEntities[0], 'identityBrief'), false);
    assert.equal(result.memory.summary.aiText, '摘要仍保存。');
  }
});

test('简介公开读取：轻简介同源可读，人工空档不回填，总预算不增加', async () => {
  const npc = entity({ identityBrief: '北城图书馆管理员。', identityBriefSource: { sourceFloorId: F1, origin: 'extractor', facts: [
    { kind: 'occupation', text: '北城图书馆管理员。', evidence: [{ source: 'canonicalContent', kind: 'story', floorId: F1, quotedText: floor().content.canonicalContent }] },
  ] } });
  const reachable = { status: 'ready', rootRevision: 1, root: { chatId: CHAT, narrativeGeneration: GEN, headCheckpointId: BATCH }, checkpoint: {},
    floors: [floor()], floorMemories: [], entities: [npc], stateDeltas: [] };
  const context = peopleState => buildPublicContext({ reachable, peopleState, currentStates: { subjects: [] }, entityIds: [NPC], maxCharacters: 1200 });
  const empty = context({ people: [] });
  assert.match(empty.actors[0].profileText, /有据身份简介.*AI #1.*北城图书馆管理员/u);
  const manual = context({ people: [{ entityId: NPC, profile: { name: '沈禾', occupation: '', manualFields: ['occupation'] } }] });
  assert.match(manual.actors[0].profileText, /occupation（人工决定）：已明确清空，不补填/u);
  assert.doesNotMatch(manual.actors[0].profileText, /管理员/u);
  assert.ok(manual.coverage.selectedCharacters <= 1200);
  const old = buildPublicContext({ reachable: { ...reachable, entities: [entity({ identityBrief: '旧简介。' })] }, peopleState: { people: [] },
    currentStates: { subjects: [] }, entityIds: [NPC], maxCharacters: 1200 });
  assert.match(old.actors[0].profileText, /历史简介，未记录引文/u);
  const source = await projectRecallSource(reachable, () => new Date(NOW));
  assert.equal(Object.hasOwn(source.entities[0], 'identityBriefSource'), false, '正式召回姓名索引不复制整份简介引文');
  const briefSource = buildEntityIdentityDirectory({ entities: [npc], floorOrder: order })[0].identityBriefSource;
  let reads = 0;
  const identity = { hostChatId: 'host', chatId: CHAT, characterLocator: 'card', personaLocator: 'persona' };
  const peopleState = { status: 'ready', chatId: CHAT, revision: 4, people: [{ entityId: NPC, displayName: '沈禾', aliases: [], profiled: false, profile: null,
    identityBrief: npc.identityBrief, identityBriefSource: briefSource }] };
  const bridge = createPublicMemoryBridge({ session: { identity: () => identity, getState: () => ({ status: 'ready', identity }) },
    hostAdapter: { snapshot: () => ({ chatId: 'host', chat: [] }) }, store: { readReachable() { reads++; throw new Error('不应重读图'); } },
    peopleRuntime: { getState: () => peopleState } });
  const snapshot = bridge.getPeopleSnapshot();
  assert.equal(snapshot.people.items[0].identityBriefSource.entityRecordId, NPC);
  assert.equal(snapshot.people.items[0].profiled, false);
  snapshot.people.items[0].identityBriefSource.facts[0].text = '外部改动';
  assert.equal(bridge.getSnapshot().people.items[0].identityBriefSource.facts[0].text, npc.identityBrief);
  assert.equal(reads, 0);
});

test('稳定身份条目：legacy同目标完整列表一份坏则保旧，其它人物和摘要可保存', async () => {
  const old = entity({ identityBrief: '旧有身份。' }), f = floor();
  const envelope = await createExtractorEnvelope({ batchId: BATCH, chatId: CHAT, narrativeGeneration: GEN, floor: f, entities: [old] });
  const mention = (mentionKey, identityFacts) => ({ mentionKey, surface: '沈禾', aliases: [], entityType: 'person', identity: 'existing',
    entityKey: 'catalog-1', evidence: [], identityFacts });
  const response = { schemaVersion: 3, task: 'extractFloorMemory', promptVersion: EXTRACTOR_PROMPT_VERSION, floors: [{ status: 'ok', summary: '摘要照常保存。',
    entityMentions: [mention('person-1', facts()), mention('person-2', facts('不存在的引用'))] }] };
  const result = await normalizeExtractorResponse({ response, envelope, floor: f, existingEntities: [old], now: NOW, expectedScope: envelope.scope });
  assert.equal(result.newEntities.filter(entity => entity.identityBriefSource).length, 0);
  assert.equal(result.memory.summary.aiText, '摘要照常保存。');
});

test('稳定身份条目：语义返回只用原句来源，不要求内部mentionKey', async () => {
  const f = floor(), envelope = await createExtractorEnvelope({ batchId: BATCH, chatId: CHAT, narrativeGeneration: GEN, floor: f });
  const result = await normalizeExtractorResponse({ response: { summary: '沈禾说明职业。', people: [{ name: '沈禾', identityFacts: [{
    kind: 'occupation', text: '北城图书馆管理员。', evidence: [{ quoteSegments: [f.content.canonicalContent], supports: '明确职业', evidenceMode: 'explicit' }],
  }] }] }, envelope, floor: f, existingEntities: [], now: NOW, expectedScope: envelope.scope });
  assert.equal(result.newEntities[0].identityBrief, '北城图书馆管理员。');
  assert.equal(result.newEntities[0].identityBriefSource.facts[0].evidence[0].sourceEntityId, null);
});

test('稳定身份条目：CSE只复用本目标本轮提供的key，旧引文与派生全文不重复送出', async () => {
  const source = { sourceFloorId: F1, origin: 'extractor', facts: [{ kind: 'occupation', text: '北城图书馆管理员。', evidence: [{
    source: 'canonicalContent', kind: 'story', floorId: F1, quotedText: floor().content.canonicalContent }] }] };
  const first = entity({ identityBrief: '北城图书馆管理员。', identityBriefSource: source });
  const second = entity({ id: BATCH, displayName: '叶青', identityBrief: '北城图书馆管理员。', identityBriefSource: source });
  const baseline = { id: CHAR, userPersona: { entityId: USER, name: '林岚', description: '' }, characterCard: { entityId: CHAR, name: '顾舟', description: '' }, worldInfoSources: [] };
  const envelope = createCseEnvelope({ floor: floor(), floorMemory: { id: F2, summary: {}, participants: [] }, baseline, currentState: null, trackedSubjects: [],
    entities: [first, second], identityBriefTargets: [{ entityId: NPC }, { entityId: BATCH }] });
  const targets = envelope.request.payload.identityBriefTargets;
  assert.equal(targets.length, 2);
  assert.equal(Object.hasOwn(targets[0], 'identityBrief'), false);
  assert.equal(JSON.stringify(targets).includes('quotedText'), false);
  assert.notEqual(targets[0].identityFacts[0].existingKey, targets[1].identityFacts[0].existingKey);
  for (const [key, valid] of [[targets[0].identityFacts[0].existingKey, true], [targets[1].identityFacts[0].existingKey, false]]) {
    const result = await compileCseResponse({ response: { noMaterialChange: true, identityBriefUpdates: [{ targetKey: targets[0].key, identityFacts: [{ existingKey: key }] }] },
      envelope, previousCurrentState: null, now: NOW, deltaId: BATCH });
    assert.deepEqual(result.identityBriefUpdates, []);
    assert.equal(result.isolated.some(item => item.code === 'V3_CSE_IDENTITY_BRIEF_INVALID'), !valid);
  }
});

test('简介公开读取：正常只改姓名别名仍保轻简介，人工空材料字段继续优先', () => {
  const npc = entity({ identityBrief: '北城图书馆管理员。' });
  const reachable = { root: { chatId: CHAT }, entities: [npc], floors: [floor()], floorMemories: [] };
  const context = profile => buildPublicContext({ reachable, peopleState: { people: [{ entityId: NPC, profile }] }, currentStates: { subjects: [] }, entityIds: [NPC] });
  const renamed = context({ name: '沈新名', aliases: '阿禾', manualFields: ['name', 'aliases'] });
  assert.match(renamed.actors[0].profileText, /北城图书馆管理员/u);
  assert.match(renamed.actors[0].profileText, /name（人工决定）：沈新名/u);
  const cleared = context({ name: '沈新名', occupation: '', manualFields: ['name', 'occupation'] });
  assert.doesNotMatch(cleared.actors[0].profileText, /管理员/u);
  assert.match(cleared.actors[0].profileText, /已明确清空，不补填/u);
});
