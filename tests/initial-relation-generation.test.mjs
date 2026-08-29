import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialRelationGenerationAdapter, INITIAL_RELATION_LIMITS, INITIAL_RELATION_SYSTEM_PROMPT, validateBasicInfoResult } from '../src/initial-relation-generation.js';
import { computeStableFloorSnapshot, createStableLedger } from '../src/stable-floor.js';
import { fingerprintGreeting } from '../src/route-source.js';
import { sha256 } from '../src/identity.js';

const CHAT = '11111111-1111-4111-8111-111111111111';
const CARD = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const C1 = '44444444-4444-4444-8444-444444444444';
const C2 = '55555555-5555-4555-8555-555555555555';
const GENERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clone = value => structuredClone(value);
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });

function envelope(data, revision = 1) {
  return { schemaVersion: 1, revision, generationId: GENERATION, createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z', data: clone(data) };
}

async function makeHarness({ generate, selected = [C1], profilePutFailure, oversized = false } = {}) {
  const greeting = '冻结开场：霜城的钟声响起。';
  const chat = [
    { is_user: false, is_system: false, mes: greeting, send_date: 'g0', swipe_id: 0 },
    { is_user: true, is_system: false, mes: '我走进钟楼，叫住了林岚。', send_date: 'u1', name: 'U' },
    { is_user: false, is_system: false, mes: '林岚回头，递来一枚旧钥匙。', send_date: 'a1', swipe_id: 0, name: '林岚' },
    { is_user: true, is_system: false, mes: '我收下钥匙，并答应明天再来。', send_date: 'u2', name: 'U' },
  ];
  const ctx = {
    characterId: 0, groupId: null, chatId: 'host-chat', userAvatar: 'me.png', name1: '旅人', name2: '林岚',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } }, chat,
    characters: [{ avatar: 'char.png', data: { name: '林岚', description: oversized ? `人物设定${'甲'.repeat(INITIAL_RELATION_LIMITS.maxSourceChars + 1)}` : '林岚是霜城钟楼的守门人。', personality: '寡言但守信。' } }],
    powerUserSettings: { persona_descriptions: { 'me.png': { description: '旅人重视承诺，也害怕被遗忘。' } } },
  };
  const snapshot = await computeStableFloorSnapshot(chat);
  const ledger = createStableLedger(snapshot, { hostChatId: 'host-chat', personaAvatar: 'me.png' });
  const greetingFingerprint = await fingerprintGreeting({ floor: 0, swipeId: 0, content: greeting });
  const route = { state: 'ready', greeting: { floor: 0, swipeId: 0, fingerprint: greetingFingerprint, content: greeting }, worldInfoEntries: [{ world: '霜城', uid: '7', fingerprint: `sha256:${await sha256('钟楼钥匙只交给可信之人。')}` }] };
  const members = [{ identityId: USER, subject: 'user', active: true }, ...selected.map((id, index) => ({ identityId: id, subject: 'character', active: true, displayName: index ? '白榆' : '林岚' }))];
  const records = new Map();
  const key = (collection, id) => `${collection}/${id}`;
  records.set(key(`chat-${CHAT}`, 'meta'), envelope({ schemaVersion: 1, kind: 'chat-profile', chatId: CHAT, cardId: CARD, personaId: USER, source: { card: { locator: 'char.png' }, persona: { locator: 'me.png' } }, route, cardType: 'single', status: 'ready', rebuildState: 'idle' }));
  records.set(key(`chat-${CHAT}`, 'people-index'), envelope({ schemaVersion: 1, contractVersion: 3, kind: 'people-index', chatId: CHAT, status: 'ready', confirmed: selected.map((id, index) => ({
    identityId: id,
    displayName: index ? '白榆' : '林岚',
    sourceAnchor: index ? '白榆' : '林岚',
    primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' },
    sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }, { kind: 'worldbook', locator: '霜城:7' }],
    selection: { status: 'selected' },
  })), candidate: [], discarded: [], shelved: [], tombstones: [], sourceFingerprint: 'source' }));
  records.set(key(`chat-${CHAT}`, 'people-state'), envelope({ schemaVersion: 1, contractVersion: 1, kind: 'people-foundation-state', chatId: CHAT, cardId: CARD, personaId: USER, source: { card: { locator: 'char.png' }, persona: { locator: 'me.png' } }, initializedMembers: members, activeMemberIds: members.map(item => item.identityId), canonRef: null, status: 'ready', unknownState: { keep: true } }));
  records.set(key(`chat-${CHAT}`, 'runtime'), envelope({ schemaVersion: 1, kind: 'stable-floor-runtime', chatId: CHAT, cardId: CARD, personaId: USER, source: { card: { locator: 'char.png' }, persona: { locator: 'me.png' } }, stableFloorLedger: ledger, canonCheckpoint: { canonLength: ledger.entries.length }, provisional: null, status: 'ready' }));
  const profile = (identityId, subject, displayName) => envelope({ schemaVersion: 1, peopleContractVersion: 1, kind: 'people-profile', identityId, chatId: CHAT, subject, displayName, sourceFacts: [{ id: 'old-source', value: '保留来源' }], userFacts: [{ id: 'user-owned', value: '用户内容' }], interpretations: [{ id: 'old-ai', value: '保留解释' }], locks: [{ id: 'lock' }], pendingReview: [{ id: 'old-review' }], sourceRefs: [{ kind: 'extension', locator: 'keep-me' }], sourceBinding: { kind: subject === 'user' ? 'persona' : 'c-registry', identityId, ...(subject === 'user' ? { locator: 'me.png' } : {}) }, lifecycle: 'active', unknownExtension: { keep: true } });
  records.set(key(`chat-${CHAT}-people`, USER), profile(USER, 'user', '旅人'));
  selected.forEach((id, index) => records.set(key(`chat-${CHAT}-people`, id), profile(id, 'character', index ? '白榆' : '林岚')));
  const calls = { get: [], put: [], ai: [] };
  let failedProfile = false;
  const client = {
    async get(collection, id) { calls.get.push([collection, id]); const record = records.get(key(collection, id)); if (!record) throw httpError(404); return clone(record); },
    async put(collection, id, data, expectedRevision) {
      calls.put.push([collection, id, clone(data), expectedRevision]);
      const recordKey = key(collection, id), current = records.get(recordKey);
      if ((current?.revision ?? 0) !== expectedRevision) throw httpError(409);
      if (profilePutFailure && collection.endsWith('-people') && profilePutFailure({ id, data, failedProfile })) { failedProfile = true; throw httpError(503); }
      const saved = envelope(data, expectedRevision + 1); records.set(recordKey, saved); return clone(saved);
    },
  };
  const routeState = { warnings: [], calls: 0, currentRoute: clone(route) };
  const routeSource = {
    async collect() { return clone(routeState.currentRoute); },
    async collectFrozenAnalysisSources(frozenRoute) {
      routeState.calls += 1;
      const current = routeState.currentRoute, warnings = clone(routeState.warnings);
      if (current.greeting?.fingerprint !== frozenRoute.greeting?.fingerprint) warnings.push({ code: 'GREETING_VERSION_CHANGED' });
      const currentEntries = new Map((current.worldInfoEntries || []).map(item => [`${item.world}\u0000${item.uid}`, item]));
      let changed = 0, missing = 0;
      const worldInfoEntries = [];
      for (const ref of frozenRoute.worldInfoEntries || []) {
        const item = currentEntries.get(`${ref.world}\u0000${ref.uid}`);
        if (!item) { missing += 1; warnings.push({ code: 'WORLDBOOK_ENTRY_MISSING' }); continue; }
        if (item.fingerprint !== ref.fingerprint) { changed += 1; warnings.push({ code: 'WORLDBOOK_VERSION_CHANGED' }); }
        worldInfoEntries.push({ ...clone(item), content: item.content || '钟楼钥匙只交给可信之人。' });
      }
      return {
        status: 'ready', warnings,
        diagnostics: { greeting: warnings.some(item => item.code === 'GREETING_VERSION_CHANGED') ? 'changed' : 'same', worldbookTotal: frozenRoute.worldInfoEntries.length, worldbookChanged: changed || (warnings.some(item => item.code === 'WORLDBOOK_VERSION_CHANGED') ? 1 : 0), worldbookMissing: missing, codes: [...new Set(warnings.map(item => item.code))] },
        sources: { greeting: clone(frozenRoute.greeting), worldInfoEntries },
      };
    },
  };
  const defaultGenerate = async options => {
    return { jsonData: { items: selected.length === 1 ? [
      { person: 'U', type: 'source_fact', text: '旅人重视承诺', evidence: ['A3'] },
      { person: 'U', type: 'interpretation', text: '旅人接受了林岚的信任凭证', evidence: ['H2'], relatedTo: 'C1' },
      { person: 'U', type: 'review', text: '旅人可能害怕失去林岚', evidence: ['H2'], relatedTo: 'C1' },
      { person: 'C1', type: 'source_fact', text: '林岚是钟楼守门人', evidence: ['A1'] },
      { person: 'C1', type: 'interpretation', text: '林岚开始信任旅人', evidence: ['H2'], relatedTo: 'U' },
    ] : [] } };
  };
  const generateRelationTask = async options => { calls.ai.push(options); return (generate || defaultGenerate)(options, { ctx, snapshot, route, records, calls }); };
  const adapter = createInitialRelationGenerationAdapter({ client, contextProvider: () => ctx, routeSource, generateRelationTask });
  return { adapter, ctx, records, calls, client, routeSource, routeState, snapshot, key, route, generateRelationTask };
}

async function changeCurrentRoute(h) {
  const greeting = '更新后的开场白'; h.ctx.chat[0].mes = greeting;
  h.routeState.currentRoute = {
    ...clone(h.route), greeting: { floor: 0, swipeId: 0, fingerprint: await fingerprintGreeting({ floor: 0, swipeId: 0, content: greeting }), content: greeting },
    worldInfoEntries: [{ world: '霜城', uid: '7', fingerprint: `sha256:${await sha256('更新后的世界书')}`, content: '更新后的世界书' }],
  };
}

test('首次生成只写 selected C，U legacy profile 零新增 AI 内容', async () => {
  const h = await makeHarness();
  const result = await h.adapter.start();
  assert.equal(result.status, 'ready'); assert.equal(h.calls.ai.length, 1);
  const state = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data;
  assert.equal(state.initialGeneration.status, 'ready'); assert.deepEqual(state.initialGeneration.completedMemberIds, [C1]); assert.equal(state.initialGeneration.draft, undefined); assert.deepEqual(state.unknownState, { keep: true });
  assert.equal(state.lastAttempt.action, 'initial_start'); assert.equal(state.lastAttempt.status, 'ready'); assert.equal(state.lastAttempt.aiCalled, true); assert.equal(state.lastAttempt.profileWrites, 1); assert.equal(state.lastAttempt.targetCount, 1);
  const user = h.records.get(h.key(`chat-${CHAT}-people`, USER)).data, character = h.records.get(h.key(`chat-${CHAT}-people`, C1)).data;
  assert.equal(user.userFacts[0].id, 'user-owned'); assert.equal(user.locks[0].id, 'lock'); assert.deepEqual(user.unknownExtension, { keep: true }); assert.equal(user.pendingReview.length, 1); assert.equal(user.sourceFacts.length, 1); assert.equal(user.interpretations.length, 1);
  assert.equal(character.sourceFacts.length, 2); assert.equal(character.interpretations.length, 2);
  for (const item of [...character.sourceFacts.slice(1), ...character.interpretations.slice(1)]) {
    assert.match(item.id, /^qqj-initial-v1:[0-9a-f]{64}$/); assert.equal(item.writerId, 'qianqianjie.initial-relation.v1'); assert.equal(item.operationId, state.initialGeneration.operationId); assert.match(item.baselineDigest, /^sha256:/);
  }
  const request = h.calls.ai[0]; assert.equal(request.systemPrompt, INITIAL_RELATION_SYSTEM_PROMPT); assert.equal(request.substituteMacros, false); assert.equal(request.maxTokens, INITIAL_RELATION_LIMITS.maxTokens);
  assert.match(request.taskMessages[0].content, /U \| 旅人/); assert.match(request.taskMessages[0].content, /\[A1\]|\[H1\]/); assert.match(request.taskMessages[0].content, /旅人重视承诺/);
  assert.doesNotMatch(request.taskMessages[0].content, new RegExp(`${USER}|${C1}|fingerprint=|locator=|sourceRefs=`, 'i'));
  assert.match(request.taskMessages[0].content, /不要输出 UUID、locator、fingerprint、anchor、confidence、sourceRefs/);
  const mappedFact = character.sourceFacts.at(-1), mappedInterpretation = character.interpretations.at(-1);
  assert.equal(mappedFact.sourceRefs[0].kind, 'card'); assert.equal(mappedFact.confidence, undefined); assert.equal(mappedFact.sourceRefs[0].anchor, undefined);
  assert.equal(mappedInterpretation.relationToIdentityId, USER); assert.equal(mappedInterpretation.sourceRefs[0].kind, 'chat');
  assert.equal(state.lastAttempt.acceptedItems, 2); assert.equal(state.lastAttempt.rejectedItems, 3); assert.equal(state.lastAttempt.emptyResult, false);
});

test('轻量 item 逐条拒绝越权字段、未知人物/证据/type，合法项不被拖累', async t => {
  const valid = { person: 'C1', type: 'source_fact', text: '林岚是守门人', evidence: ['A1'] };
  const cases = {
    forbidden: ['forbidden_field', { person: 'C1', type: 'source_fact', text: 'x', evidence: ['A1'], identityId: C1 }],
    database_field: ['forbidden_field', { person: 'C1', type: 'source_fact', text: 'x', evidence: ['A1'], revision: 7 }],
    person: ['unknown_person', { person: 'C99', type: 'source_fact', text: 'x', evidence: ['A1'] }],
    evidence: ['unknown_evidence', { person: 'C1', type: 'interpretation', text: 'x', evidence: ['H99'] }],
    type: ['unknown_type', { person: 'C1', type: 'database_patch', text: 'x', evidence: ['A1'] }],
    fact_history: ['evidence_policy', { person: 'C1', type: 'source_fact', text: 'x', evidence: ['H2'] }],
    interpretation_author_only: ['evidence_policy', { person: 'C1', type: 'interpretation', text: 'x', evidence: ['A1'] }],
    text_budget: ['invalid_text', { person: 'C1', type: 'source_fact', text: 'x'.repeat(INITIAL_RELATION_LIMITS.maxItemChars + 1), evidence: ['A1'] }],
    item_budget: ['item_too_large', { person: 'C1', type: 'source_fact', text: 'x', evidence: ['A1'], note: 'n'.repeat(INITIAL_RELATION_LIMITS.maxItemChars * 4) }],
  };
  for (const [name, [reason, bad]] of Object.entries(cases)) await t.test(name, async () => {
    const h = await makeHarness({ generate: async () => ({ jsonData: { items: [valid, bad] } }) });
    const result = await h.adapter.start(); assert.equal(result.status, 'ready'); assert.equal(h.calls.ai.length, 1);
    const attempt = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt;
    assert.equal(attempt.acceptedItems, 1); assert.equal(attempt.rejectedItems, 1); assert.deepEqual(attempt.rejectionCodes, [reason]);
    assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.sourceFacts.length, 2);
    assert.doesNotMatch(JSON.stringify(attempt), /旅人重视承诺|database_patch|C99|H99/);
  });
});

test('单一目标合法项即可完成全部 target；无害表达字段忽略且无目标覆盖要求', async () => {
  const h = await makeHarness({ generate: async () => ({ jsonData: { items: [
    { person: 'C1', type: 'source_fact', text: '林岚是守门人', evidence: ['A1'], note: '模型解释字段不参与存储' },
  ] } }) });
  assert.equal((await h.adapter.start()).status, 'ready'); assert.equal(h.calls.ai.length, 1);
  const state = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data;
  assert.deepEqual(state.initialGeneration.completedMemberIds, [C1]);
  assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, USER)).data.sourceFacts.length, 1);
  assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.sourceFacts.length, 2);
  assert.equal(state.lastAttempt.acceptedItems, 1); assert.equal(state.lastAttempt.rejectedItems, 0);
  assert.doesNotMatch(JSON.stringify(h.records.get(h.key(`chat-${CHAT}-people`, USER)).data), /模型解释字段/);
});

test('合法空 items 直接 ready 且零 profile PUT；非空零合法最多重试一次后安全失败', async () => {
  const empty = await makeHarness({ generate: async () => ({ jsonData: { items: [] } }) });
  assert.equal((await empty.adapter.start()).status, 'ready'); assert.equal(empty.calls.ai.length, 1);
  assert.equal(empty.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
  const emptyState = empty.records.get(empty.key(`chat-${CHAT}`, 'people-state')).data;
  assert.deepEqual(emptyState.initialGeneration.completedMemberIds, [C1]);
  assert.equal(emptyState.lastAttempt.emptyResult, true); assert.equal(emptyState.lastAttempt.acceptedItems, 0); assert.equal(emptyState.lastAttempt.rejectedItems, 0);

  const missing = await makeHarness({ generate: async () => ({ jsonData: {} }) });
  assert.equal((await missing.adapter.start()).status, 'ready'); assert.equal(missing.calls.ai.length, 1);
  assert.equal(missing.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
  assert.equal(missing.records.get(missing.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt.emptyResult, true);

  const invalid = await makeHarness({ generate: async () => ({ jsonData: { items: [{ person: 'C99', type: 'source_fact', text: '不可保存正文', evidence: ['A1'] }] } }) });
  assert.equal((await invalid.adapter.start()).status, 'failed_retryable');
  assert.equal(invalid.calls.ai.length, 2); assert.equal(invalid.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
  const invalidState = invalid.records.get(invalid.key(`chat-${CHAT}`, 'people-state')).data;
  assert.equal(invalidState.initialGeneration.status, 'failed_retryable'); assert.equal(invalidState.lastAttempt.errorCode, 'no_valid_items');
  assert.equal(invalidState.lastAttempt.formatStage, 'relation_semantic');
  assert.equal(invalidState.lastAttempt.acceptedItems, 0); assert.equal(invalidState.lastAttempt.rejectedItems, 1); assert.deepEqual(invalidState.lastAttempt.rejectionCodes, ['unknown_person']);
  assert.doesNotMatch(JSON.stringify(invalidState.lastAttempt), /不可保存正文|C99|A1/);
});

test('items 外壳错误属于 relation_schema，与零合法 relation_semantic 明确区分', async () => {
  const h = await makeHarness({ generate: async () => ({ jsonData: { items: 'not-an-array' } }) });
  assert.equal((await h.adapter.start()).status, 'failed_retryable');
  assert.equal(h.calls.ai.length, 2); assert.equal(h.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
  const attempt = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt;
  assert.equal(attempt.errorCode, 'QQJ_RELATION_SCHEMA'); assert.equal(attempt.formatStage, 'relation_schema');
  assert.equal(attempt.acceptedItems, 0); assert.equal(attempt.rejectedItems, 0);
});

test('有限格式宽容、完全重复项去重；第二次坏格式保留骨架', async () => {
  let attempt = 0;
  const good = await makeHarness({ generate: async () => {
    attempt += 1; if (attempt === 1) { const error = new Error('bad'); error.retryableRecognitionFormat = true; throw error; }
    const item = { person: 'C1', type: 'fact', text: '林岚守信', evidence: ['A1'] };
    return `\`\`\`json\n${JSON.stringify({ items: [item, item, { person: 'C1', type: 'insight', text: '建立信任', evidence: ['H2'] }] })}\n\`\`\``;
  } });
  assert.equal((await good.adapter.start()).status, 'ready'); assert.equal(good.calls.ai.length, 2);
  assert.equal(good.records.get(good.key(`chat-${CHAT}-people`, C1)).data.sourceFacts.length, 2);
  const goodAttempt = good.records.get(good.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt; assert.equal(goodAttempt.acceptedItems, 2); assert.equal(goodAttempt.rejectedItems, 1); assert.deepEqual(goodAttempt.rejectionCodes, ['duplicate']);
  const bad = await makeHarness({ generate: async () => '```json\nnot-json\n```' });
  assert.equal((await bad.adapter.start()).status, 'failed_retryable'); assert.equal(bad.calls.ai.length, 2); assert.equal(bad.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
  assert.equal(bad.records.get(bad.key(`chat-${CHAT}-people`, USER)).data.userFacts[0].id, 'user-owned');
});

test('首次格式失败后二次合法可成功；两次失败持久记录安全 API/模型/阶段且零 profile PUT', async () => {
  const seed = await makeHarness(); const valid = await seed.generateRelationTask({}); let attempts = 0;
  const recovered = await makeHarness({ generate: async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('模型输出格式无效'); error.code = 'QQJ_COMPLETION_JSON'; error.formatStage = 'completion_json'; error.retryableRecognitionFormat = true;
      error.taskMetadata = { source: 'seven-utility', sourceLabel: '构画机械预设 · G3.5F', model: 'gemini-3-flash-preview', finishReason: 'stop' };
      throw error;
    }
    return { ...clone(valid), taskMetadata: { source: 'seven-utility', sourceLabel: '构画机械预设 · G3.5F', model: 'gemini-3-flash-preview', finishReason: 'stop' } };
  } });
  assert.equal((await recovered.adapter.start()).status, 'ready'); assert.equal(recovered.calls.ai.length, 2);
  const readyAttempt = recovered.records.get(recovered.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt;
  assert.equal(readyAttempt.formatStage, 'none'); assert.equal(readyAttempt.apiSource, 'seven-utility'); assert.equal(readyAttempt.model, 'gemini-3-flash-preview'); assert.equal(readyAttempt.finishReason, 'stop');

  const failed = await makeHarness({ generate: async () => {
    const error = new Error('模型输出疑似被截断'); error.code = 'QQJ_OUTPUT_TRUNCATED'; error.formatStage = 'output_truncated'; error.finishReason = 'length'; error.retryableRecognitionFormat = true;
    error.taskMetadata = { source: 'seven-utility', sourceLabel: 'SECRET_URL https://private.example', model: 'gemini-3-flash-preview', finishReason: 'length' };
    error.url = 'https://private.example/v1'; error.key = 'SECRET_KEY'; error.prompt = 'SECRET_PROMPT正文'; error.completion = 'SECRET_COMPLETION正文'; error.stack = 'SECRET_STACK';
    throw error;
  } });
  assert.equal((await failed.adapter.start()).status, 'failed_retryable'); assert.equal(failed.calls.ai.length, 2); assert.equal(failed.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
  const failedAttempt = failed.records.get(failed.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt;
  assert.equal(failedAttempt.errorCode, 'QQJ_OUTPUT_TRUNCATED'); assert.equal(failedAttempt.formatStage, 'output_truncated'); assert.equal(failedAttempt.apiSource, 'seven-utility'); assert.equal(failedAttempt.model, 'gemini-3-flash-preview'); assert.equal(failedAttempt.finishReason, 'length');
  assert.doesNotMatch(JSON.stringify(failedAttempt), /SECRET|private\.example|PROMPT|COMPLETION|正文|STACK/i);
});

test('selected C profile 写入失败后保留 applying；新实例零 AI 恢复且不重复', async () => {
  const h = await makeHarness({ profilePutFailure: ({ id, failedProfile }) => id === C1 && !failedProfile });
  const first = await h.adapter.start(); assert.equal(first.status, 'storage_error'); assert.equal(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.initialGeneration.status, 'applying');
  assert.equal(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt.status, 'storage_error'); assert.equal(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt.profileWrites, 0); assert.equal(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt.aiCalled, true);
  assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, USER)).data.sourceFacts.length, 1); assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.sourceFacts.length, 1);
  let ai = 0;
  const restored = createInitialRelationGenerationAdapter({ client: h.client, contextProvider: () => h.ctx, routeSource: { collectFrozenAnalysisSources: async () => ({ status: 'ready', warnings: [], sources: { greeting: h.route.greeting, worldInfoEntries: [{ world: '霜城', uid: '7', fingerprint: h.route.worldInfoEntries[0].fingerprint, content: '钟楼钥匙只交给可信之人。' }] } }) }, generateRelationTask: async () => { ai += 1; throw new Error('不应调用'); } });
  const result = await restored.resume(); assert.equal(result.status, 'ready'); assert.equal(ai, 0);
  assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, USER)).data.sourceFacts.length, 1); assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.sourceFacts.length, 2);
});

test('完成后重复 start/刷新零 AI；输入过大不截断也不调用 AI', async () => {
  const h = await makeHarness(); assert.equal((await h.adapter.start()).status, 'ready'); const profileWrites = h.calls.put.filter(([collection]) => collection.endsWith('-people')).length;
  assert.equal((await h.adapter.start()).status, 'ready'); assert.equal((await h.adapter.resume()).status, 'ready'); assert.equal(h.calls.ai.length, 1); assert.equal(h.calls.put.filter(([collection]) => collection.endsWith('-people')).length, profileWrites);
  const large = await makeHarness({ oversized: true }); const result = await large.adapter.start(); assert.equal(result.status, 'input_too_large'); assert.equal(large.calls.ai.length, 0); assert.equal(large.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
});

test('切 Persona、Canon 历史变化与主动取消使迟到结果零 profile 写', async t => {
  for (const mode of ['persona', 'canon', 'cancel']) await t.test(mode, async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const h = await makeHarness({ generate: async (options, helper) => { await gate; return (await makeHarness()).generateRelationTask?.(options, helper); } });
    // Replace the generator through a second harness-style valid payload is cumbersome; all three guards fire before payload validation.
    const pending = h.adapter.start(); await new Promise(resolve => setImmediate(resolve));
    if (mode === 'persona') h.ctx.userAvatar = 'other.png';
    if (mode === 'canon') h.ctx.chat[2].mes = '历史已被编辑';
    if (mode === 'cancel') h.adapter.cancel();
    release(); const result = await pending; assert.equal(result.status, 'stale'); assert.equal(h.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
  });
});

test('来源变化与未来 schema 保守暂停，零 AI/零 profile PUT', async () => {
  const changed = await makeHarness(); changed.routeState.warnings = [{ code: 'WORLDBOOK_VERSION_CHANGED' }];
  assert.equal((await changed.adapter.start()).status, 'blocked_source_changed'); assert.equal(changed.calls.ai.length, 0); assert.equal(changed.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
  const attempt = changed.records.get(changed.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt;
  assert.equal(attempt.action, 'initial_start'); assert.equal(attempt.status, 'blocked_source_changed'); assert.equal(attempt.aiCalled, false); assert.equal(attempt.profileWrites, 0);
  assert.equal(attempt.targetCount, 1); assert.equal(attempt.sourceDiagnostics.worldbookChanged, 1); assert.equal(attempt.sourceDiagnostics.worldbookMissing, 0);
  assert.deepEqual(changed.records.get(changed.key(`chat-${CHAT}`, 'people-state')).data.unknownState, { keep: true });
  assert.doesNotMatch(JSON.stringify(attempt), /钟楼钥匙|霜城的钟声|旅人重视承诺/);
  const future = await makeHarness(); const profile = future.records.get(future.key(`chat-${CHAT}-people`, C1)); profile.data.peopleContractVersion = 2;
  assert.equal((await future.adapter.start()).status, 'future_schema_readonly'); assert.equal(future.calls.ai.length, 0); assert.equal(future.calls.put.length, 0);
});

test('刷新后的新实例可读取持久 lastAttempt，来源摘要仍无正文', async () => {
  const h = await makeHarness(); h.routeState.warnings = [{ code: 'WORLDBOOK_VERSION_CHANGED' }];
  assert.equal((await h.adapter.start()).status, 'blocked_source_changed');
  const restored = createInitialRelationGenerationAdapter({ client: h.client, contextProvider: () => h.ctx, routeSource: {
    collectFrozenAnalysisSources: async route => ({ status: 'ready', warnings: [{ code: 'WORLDBOOK_READ_FAILED', count: 1 }], diagnostics: { greeting: 'same', worldbookTotal: route.worldInfoEntries.length, worldbookChanged: 0, worldbookMissing: 0, worldbookUnreadable: 1, codes: ['WORLDBOOK_READ_FAILED'] }, sources: { greeting: route.greeting, worldInfoEntries: [] } }),
  }, generateRelationTask: async () => { throw new Error('不应调用 AI'); } });
  assert.equal((await restored.resume()).status, 'blocked_source_changed');
  const state = restored.getState(); assert.equal(state.lastAttempt.status, 'blocked_source_changed'); assert.equal(state.lastAttempt.aiCalled, false); assert.equal(state.lastAttempt.sourceDiagnostics.worldbookChanged, 0); assert.equal(state.lastAttempt.sourceDiagnostics.worldbookMissing, 0); assert.equal(state.lastAttempt.sourceDiagnostics.worldbookUnreadable, 1);
  assert.doesNotMatch(JSON.stringify(state.lastAttempt), /仅测试内容/);
});

test('采用当前作者来源只更新 meta.route 与 lastAttempt，不改人物/稳定账本且不自动 AI；随后 start 可继续', async () => {
  const h = await makeHarness();
  const nextGreeting = '新的开场白';
  h.ctx.chat[0].mes = nextGreeting;
  h.routeState.currentRoute = {
    ...clone(h.route),
    greeting: { floor: 0, swipeId: 0, fingerprint: await fingerprintGreeting({ floor: 0, swipeId: 0, content: nextGreeting }), content: nextGreeting },
    worldInfoEntries: [{ world: '霜城', uid: '7', fingerprint: `sha256:${await sha256('新的世界书内容')}`, content: '新的世界书内容' }],
  };
  const beforeIndex = clone(h.records.get(h.key(`chat-${CHAT}`, 'people-index')).data);
  const beforeRuntime = clone(h.records.get(h.key(`chat-${CHAT}`, 'runtime')).data);
  const beforeProfiles = [USER, C1].map(id => clone(h.records.get(h.key(`chat-${CHAT}-people`, id)).data));
  const result = await h.adapter.adoptCurrentSources();
  assert.equal(result.status, 'ready'); assert.equal(result.adopted, true); assert.equal(h.calls.ai.length, 0);
  assert.equal(h.calls.put.filter(([collection, id]) => collection === `chat-${CHAT}` && id === 'meta').length, 1);
  assert.equal(h.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
  assert.equal(h.records.get(h.key(`chat-${CHAT}`, 'meta')).data.route.greeting.fingerprint, h.routeState.currentRoute.greeting.fingerprint);
  assert.deepEqual(h.records.get(h.key(`chat-${CHAT}`, 'people-index')).data, beforeIndex); assert.deepEqual(h.records.get(h.key(`chat-${CHAT}`, 'runtime')).data, beforeRuntime);
  assert.deepEqual([USER, C1].map(id => h.records.get(h.key(`chat-${CHAT}-people`, id)).data), beforeProfiles);
  const attempt = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt;
  assert.equal(attempt.action, 'adopt_current_sources'); assert.equal(attempt.status, 'ready'); assert.equal(attempt.aiCalled, false); assert.equal(attempt.profileWrites, 0);
  assert.equal(attempt.sourceDiagnostics.greeting, 'changed'); assert.equal(attempt.sourceDiagnostics.worldbookChanged, 1);
  assert.deepEqual(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.initialGeneration, { schemaVersion: 1, status: 'uninitialized', completedMemberIds: [] });
  assert.deepEqual(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.unknownState, { keep: true });
  const restored = createInitialRelationGenerationAdapter({ client: h.client, contextProvider: () => h.ctx, routeSource: h.routeSource, generateRelationTask: async () => { throw new Error('权威 reload 不应调用 AI'); } });
  const reloaded = await restored.resume(); assert.equal(reloaded.status, 'uninitialized'); assert.equal(restored.getState().lastAttempt.action, 'adopt_current_sources'); assert.equal(restored.getState().lastAttempt.status, 'ready');
  assert.equal((await h.adapter.start()).status, 'ready'); assert.equal(h.calls.ai.length, 1);
});

test('已有首次 writer 内容时采用来源返回 requires_rebuild，零 meta/profile PUT', async () => {
  const h = await makeHarness(); assert.equal((await h.adapter.start()).status, 'ready');
  h.routeState.currentRoute = { ...clone(h.route), greeting: { ...clone(h.route.greeting), fingerprint: `sha256:${'f'.repeat(64)}` } };
  const before = h.calls.put.length; const result = await h.adapter.adoptCurrentSources();
  assert.equal(result.status, 'requires_rebuild'); assert.equal(h.calls.put.slice(before).some(([collection, id]) => collection === `chat-${CHAT}` && id === 'meta'), false);
  assert.equal(h.calls.put.slice(before).some(([collection]) => collection.endsWith('-people')), false);
  assert.equal(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt.status, 'requires_rebuild');
});

test('采用来源严格守住身份/未来 schema/CAS，且 route 成功后诊断 CAS 失败不回滚业务', async t => {
  await t.test('identity mismatch', async () => {
    const h = await makeHarness(); await changeCurrentRoute(h); h.ctx.userAvatar = 'other.png'; const before = h.calls.put.length;
    assert.equal((await h.adapter.adoptCurrentSources()).status, 'mismatch'); assert.equal(h.calls.put.length, before);
  });
  await t.test('future profile schema', async () => {
    const h = await makeHarness(); await changeCurrentRoute(h); h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.peopleContractVersion = 2; const before = h.calls.put.length;
    assert.equal((await h.adapter.adoptCurrentSources()).status, 'future_schema_readonly'); assert.equal(h.calls.put.length, before);
  });
  await t.test('divergent meta CAS winner', async () => {
    const h = await makeHarness(); await changeCurrentRoute(h); const original = h.client.put.bind(h.client); let raced = false;
    h.client.put = async (collection, id, data, revision) => {
      if (!raced && collection === `chat-${CHAT}` && id === 'meta') {
        raced = true; const current = h.records.get(h.key(collection, id)); h.records.set(h.key(collection, id), envelope({ ...current.data, unrelatedWinner: true }, revision + 1)); throw httpError(409);
      }
      return original(collection, id, data, revision);
    };
    assert.equal((await h.adapter.adoptCurrentSources()).status, 'conflict'); assert.notEqual(h.records.get(h.key(`chat-${CHAT}`, 'meta')).data.route.greeting.fingerprint, h.routeState.currentRoute.greeting.fingerprint);
  });
  await t.test('people-state CAS failure after route success requires reload and does not claim adopted ready', async () => {
    const h = await makeHarness(); await changeCurrentRoute(h); const original = h.client.put.bind(h.client);
    h.client.put = async (collection, id, data, revision) => {
      if (collection === `chat-${CHAT}` && id === 'people-state' && data.lastAttempt?.action === 'adopt_current_sources') throw httpError(409);
      return original(collection, id, data, revision);
    };
    const result = await h.adapter.adoptCurrentSources(); assert.equal(result.status, 'conflict'); assert.equal(result.adopted, false); assert.equal(result.routeAdopted, true); assert.equal(result.reloadRequired, true);
    assert.equal(h.records.get(h.key(`chat-${CHAT}`, 'meta')).data.route.greeting.fingerprint, h.routeState.currentRoute.greeting.fingerprint);
  });
  await t.test('disabled before enqueue', async () => {
    const h = await makeHarness(); await changeCurrentRoute(h); const adapter = createInitialRelationGenerationAdapter({ client: h.client, contextProvider: () => h.ctx, routeSource: { collect: async () => h.routeState.currentRoute, collectFrozenAnalysisSources: async () => { throw new Error('不应读取'); } }, generateRelationTask: async () => { throw new Error('不应调用'); }, isEnabled: () => false });
    const before = h.calls.put.length; assert.equal((await adapter.adoptCurrentSources()).status, 'stale'); assert.equal(h.calls.put.length, before);
  });
  await t.test('current route collection failure persists a bounded safe result', async () => {
    const h = await makeHarness(); const error = Object.assign(new Error('含正文的扫描错误'), { diagnosticCode: 'SCAN_FAILED' });
    const adapter = createInitialRelationGenerationAdapter({ client: h.client, contextProvider: () => h.ctx, routeSource: { ...h.routeSource, collect: async () => { throw error; } }, generateRelationTask: h.generateRelationTask });
    const result = await adapter.adoptCurrentSources(); assert.equal(result.status, 'route_unavailable');
    const attempt = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt;
    assert.equal(attempt.action, 'adopt_current_sources'); assert.equal(attempt.status, 'route_unavailable'); assert.equal(attempt.errorCode, 'SCAN_FAILED'); assert.equal(attempt.aiCalled, false); assert.equal(attempt.profileWrites, 0);
    assert.doesNotMatch(JSON.stringify(attempt), /含正文的扫描错误/); assert.equal(h.calls.put.some(([collection, id]) => collection === `chat-${CHAT}` && id === 'meta'), false);
  });
});

test('新选择 C 只生成缺失成员；取消选择不删除既有档案', async () => {
  const h = await makeHarness(); assert.equal((await h.adapter.start()).status, 'ready');
  const indexKey = h.key(`chat-${CHAT}`, 'people-index'), stateKey = h.key(`chat-${CHAT}`, 'people-state'), c2Key = h.key(`chat-${CHAT}-people`, C2);
  const index = h.records.get(indexKey); index.revision += 1; index.data.confirmed.push({ identityId: C2, displayName: '白榆', selection: { status: 'selected' } });
  const state = h.records.get(stateKey); state.revision += 1; state.data.initializedMembers.push({ identityId: C2, subject: 'character', active: true, displayName: '白榆' }); state.data.activeMemberIds.push(C2);
  const c2 = clone(h.records.get(h.key(`chat-${CHAT}-people`, C1))); c2.data.identityId = C2; c2.data.displayName = '白榆'; c2.data.sourceFacts = []; c2.data.interpretations = []; c2.data.pendingReview = []; c2.data.sourceBinding.identityId = C2; h.records.set(c2Key, c2);
  let ai = 0;
  const routeSource = { collectFrozenAnalysisSources: async () => ({ status: 'ready', warnings: [], sources: { greeting: h.route.greeting, worldInfoEntries: [{ world: '霜城', uid: '7', fingerprint: h.route.worldInfoEntries[0].fingerprint, content: '钟楼钥匙只交给可信之人。' }] } }) };
  const adapter = createInitialRelationGenerationAdapter({ client: h.client, contextProvider: () => h.ctx, routeSource, generateRelationTask: async (_options) => {
    ai += 1; return { jsonData: { items: [{ person: 'C2', type: 'interpretation', text: '白榆见证了双方的约定', evidence: ['H2'], relatedTo: 'U' }] } };
  } });
  const added = await adapter.start(); assert.equal(added.status, 'ready'); assert.equal(ai, 1); assert.equal(h.records.get(c2Key).data.interpretations.length, 1);
  assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, USER)).data.sourceFacts.length, 1); assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.sourceFacts.length, 2);
  const nextIndex = h.records.get(indexKey); nextIndex.revision += 1; nextIndex.data.confirmed.find(item => item.identityId === C1).selection = { status: 'unselected' };
  const nextState = h.records.get(stateKey); nextState.revision += 1; nextState.data.initializedMembers = nextState.data.initializedMembers.filter(item => item.identityId !== C1); nextState.data.activeMemberIds = nextState.data.activeMemberIds.filter(id => id !== C1);
  assert.equal((await adapter.start()).status, 'ready'); assert.equal(ai, 1); assert.equal(h.records.has(h.key(`chat-${CHAT}-people`, C1)), true);
});

test('profile CAS 胜出者含相同 operation 时接受，异值时停在 conflict', async () => {
  const sameWinner = await makeHarness(); const original = sameWinner.client.put.bind(sameWinner.client); let raced = false;
  sameWinner.client.put = async (collection, id, data, revision) => {
    if (!raced && collection.endsWith('-people')) { raced = true; await original(collection, id, data, revision); throw httpError(409); }
    return original(collection, id, data, revision);
  };
  assert.equal((await sameWinner.adapter.start()).status, 'ready');
  const divergent = await makeHarness(); const originalDivergent = divergent.client.put.bind(divergent.client); let diverged = false;
  divergent.client.put = async (collection, id, data, revision) => {
    if (!diverged && collection.endsWith('-people') && id === C1) {
      diverged = true; const current = divergent.records.get(divergent.key(collection, id)); divergent.records.set(divergent.key(collection, id), envelope({ ...current.data, unrelatedWinner: true }, revision + 1)); throw httpError(409);
    }
    return originalDivergent(collection, id, data, revision);
  };
  const result = await divergent.adapter.start(); assert.equal(result.status, 'conflict'); assert.equal(divergent.records.get(divergent.key(`chat-${CHAT}`, 'people-state')).data.initialGeneration.status, 'conflict');
});

test('诊断-only CAS 胜出者不阻断首次生成业务，且保留胜出者未知字段', async () => {
  const h = await makeHarness(); const original = h.client.put.bind(h.client); let raced = false;
  h.client.put = async (collection, id, data, revision) => {
    if (!raced && collection === `chat-${CHAT}` && id === 'people-state' && data.initialGeneration?.status === 'applying') {
      raced = true; const current = h.records.get(h.key(collection, id));
      await original(collection, id, { ...current.data, lastAttempt: { schemaVersion: 1, action: 'initial_resume', status: 'loaded' }, concurrentUnknown: { keep: true } }, revision);
      throw httpError(409);
    }
    return original(collection, id, data, revision);
  };
  const result = await h.adapter.start(); assert.equal(result.status, 'ready');
  const state = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data;
  assert.deepEqual(state.concurrentUnknown, { keep: true }); assert.equal(state.lastAttempt.status, 'ready'); assert.equal(state.lastAttempt.profileWrites, 1);
});

test('timeout 映射为 failed_retryable，保留生成 baseline 与现有骨架', async () => {
  const h = await makeHarness({ generate: async () => { const error = new Error('timeout'); error.code = 'QQJ_TIMEOUT'; throw error; } });
  const result = await h.adapter.start(); assert.equal(result.status, 'failed_retryable'); assert.equal(h.calls.ai.length, 1);
  const generation = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.initialGeneration; assert.equal(generation.status, 'failed_retryable'); assert.equal(generation.errorCode, 'QQJ_TIMEOUT'); assert.match(generation.baseline.digest, /^sha256:/);
  const attempt = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastAttempt; assert.equal(attempt.status, 'failed_retryable'); assert.equal(attempt.aiCalled, true); assert.equal(attempt.profileWrites, 0); assert.equal(attempt.errorCode, 'QQJ_TIMEOUT');
  assert.equal(h.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
});

test('恢复前严格拒绝污染 draft：未知字段、foreign writer/operation、篡改 baseline、重复 item 均零 profile PUT', async t => {
  const mutations = {
    unknown(draft) { draft.patches[0].sourceFacts[0].unknownSystem = true; },
    writer(draft) { draft.patches[0].sourceFacts[0].writerId = 'foreign.writer'; },
    operation(draft) { draft.patches[0].sourceFacts[0].operationId = '66666666-6666-4666-8666-666666666666'; },
    baseline(draft) { draft.baseline = { ...draft.baseline, canonDigest: `sha256:${'f'.repeat(64)}` }; },
    duplicate(draft) { draft.patches[0].sourceFacts.push(clone(draft.patches[0].sourceFacts[0])); },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const h = await makeHarness({ profilePutFailure: ({ id, failedProfile }) => id === C1 && !failedProfile });
    assert.equal((await h.adapter.start()).status, 'storage_error');
    const stateRecord = h.records.get(h.key(`chat-${CHAT}`, 'people-state'));
    assert.equal(stateRecord.data.initialGeneration.status, 'applying'); mutate(stateRecord.data.initialGeneration.draft);
    const before = h.calls.put.filter(([collection]) => collection.endsWith('-people')).length;
    const result = await h.adapter.resume(); assert.equal(result.status, 'mismatch');
    assert.equal(h.calls.put.filter(([collection]) => collection.endsWith('-people')).length, before);
    assert.equal(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.initialGeneration.status, 'mismatch');
  });
});

test('公开 start seam 严格核验 selected C foundation sourceBinding，错绑或缺失时零 AI/零 profile PUT', async t => {
  const cases = {
    missing_character(profile) { delete profile.data.sourceBinding; },
    cross_character(profile) { profile.data.sourceBinding.identityId = C2; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const h = await makeHarness(); mutate(h.records.get(h.key(`chat-${CHAT}-people`, C1)));
    const result = await h.adapter.start(); assert.equal(result.status, 'mismatch'); assert.equal(h.calls.ai.length, 0);
    assert.equal(h.calls.put.filter(([collection]) => collection.endsWith('-people')).length, 0);
  });
});

test('已 ready 的 selected C 可独立提取六字段，逐项拒绝坏字段且 U 零写', async () => {
  const h = await makeHarness({ generate: async options => options.jsonSchema?.name === 'qianqianjie_basic_info_v1'
    ? { jsonData: { fields: [
      { field: 'appearance', text: '银发，常穿深色长衣', evidence: ['A1'] },
      { field: 'personality', text: '寡言但守信', evidence: ['A2'] },
      { field: 'unknown', text: '越权', evidence: ['A1'] },
      { field: 'age', text: '', evidence: ['A1'] },
      { field: 'identity', text: '守门人', evidence: ['A99'] },
      { field: 'appearance', text: '重复值', evidence: ['A1'] },
      { field: 'gender', text: '女', evidence: ['A1'], writerId: '模型越权' },
    ] } }
    : { jsonData: { items: [{ person: 'C1', type: 'source_fact', text: '林岚是守门人', evidence: ['A1'] }] } } });
  assert.equal((await h.adapter.start()).status, 'ready');
  const userBefore = clone(h.records.get(h.key(`chat-${CHAT}-people`, USER)).data);
  const result = await h.adapter.extractBasicInfo({ identityId: C1 });
  assert.equal(result.status, 'ready'); assert.equal(result.acceptedFields, 2); assert.equal(result.rejectedFields, 5);
  assert.deepEqual(new Set(result.rejectionCodes), new Set(['unknown_field', 'invalid_text', 'unknown_evidence', 'duplicate_field', 'unknown_property']));
  const fields = h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.basicFields;
  assert.equal(fields.appearance.value, '银发，常穿深色长衣'); assert.equal(fields.appearance.provenance, 'source'); assert.equal(fields.appearance.sourceRefs[0].kind, 'card');
  assert.equal(fields.personality.value, '寡言但守信'); assert.equal(fields.age, undefined); assert.equal(fields.name, undefined);
  assert.deepEqual(h.records.get(h.key(`chat-${CHAT}-people`, USER)).data, userBefore);
});

test('能力、喜好、厌恶、原则、人际关系五字段可独立接纳并由系统回填来源', async () => {
  const h = await makeHarness({ generate: async () => ({ jsonData: { fields: [
    { field: 'abilities', text: '能维护钟楼机关', evidence: ['A1'] },
    { field: 'likes', text: '喜欢安静与旧钥匙', evidence: ['A2'] },
    { field: 'dislikes', text: '厌恶失信', evidence: ['A3'] },
    { field: 'principles', text: '只把钥匙交给可信之人', evidence: ['A4'] },
    { field: 'relationships', text: '郑柠：亲生妹妹；U：自幼相识的至交', evidence: ['A4'] },
  ] } }) });
  const result = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(result.status, 'ready'); assert.equal(result.acceptedFields, 5); assert.equal(result.rejectedFields, 0);
  const request = h.calls.ai.at(-1), system = request.systemPrompt, task = request.taskMessages[0].content;
  assert.match(system, /Reasonable classification, synonym mapping, and concise rephrasing/); assert.match(system, /skills \/ abilities[\s\S]*-> abilities/); assert.match(system, /likes \/ preferences[\s\S]*-> likes/); assert.match(system, /dislikes \/ aversions[\s\S]*-> dislikes/); assert.match(system, /values_and_drives \/ values \/ principles[\s\S]*-> principles/); assert.match(system, /relationships \/ family \/ connections[\s\S]*-> relationships/);
  assert.match(task, /允许不增加事实的合理分类、同义栏目映射和简洁整理/); assert.match(task, /skills \/ abilities[\s\S]*→ abilities/); assert.match(task, /likes \/ preferences[\s\S]*→ likes/); assert.match(task, /dislikes \/ aversions[\s\S]*→ dislikes/); assert.match(task, /values_and_drives \/ values \/ principles[\s\S]*→ principles/); assert.match(task, /relationships \/ family \/ connections[\s\S]*→ relationships/); assert.match(task, /不得从常识、外貌、语气或一次行为推测/); assert.match(task, /不得写当前好感、情绪、暧昧\/关系阶段或临时矛盾/);
  const fields = h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.basicFields;
  for (const field of ['abilities', 'likes', 'dislikes', 'principles', 'relationships']) {
    assert.equal(typeof fields[field].value, 'string'); assert.equal(fields[field].provenance, 'source'); assert.equal(fields[field].sourceRefs.length, 1); assert.equal(fields[field].writerId, 'qianqianjie.basic-info.v1');
  }
});

test('基础字段中文与固定英文栏目别名确定性归一，未知字段及坏证据仍拒绝', () => {
  const sources = [{ kind: 'card', locator: 'card:char.png#description', fingerprint: `sha256:${'a'.repeat(64)}` }];
  const chinese = validateBasicInfoResult({ fields: [
    ['性别', '女'], ['年龄', '二十余岁'], ['外貌', '银发'], ['性格', '寡言'], ['身份', '守门人'], ['能力', '剑术'],
    ['原则', '守信'], ['NSFW 喜好', '明确内容'], ['喜好', '甜食'], ['厌恶', '失信'], ['人际关系', '郑柠：妹妹'],
  ].map(([field, text]) => ({ field, text, evidence: ['A1'] })) }, { sources });
  assert.equal(chinese.diagnostics.acceptedFields, 11); assert.equal(chinese.diagnostics.rejectedFields, 0);
  assert.deepEqual(Object.keys(chinese.fields).sort(), ['gender', 'age', 'appearance', 'personality', 'identity', 'abilities', 'principles', 'nsfwPreferences', 'likes', 'dislikes', 'relationships'].sort());

  const aliases = validateBasicInfoResult({ fields: [
    { field: ' SKILL ', text: '剑术', evidence: ['A1'] },
    { field: 'Preferences', text: '甜食', evidence: ['a1'] },
    { field: 'AVERSIONS', text: '失信', evidence: ['A1'] },
    { field: 'values-and-drives', text: '守信', evidence: ['A1'] },
    { field: 'connections', text: '郑柠：妹妹', evidence: ['A1'] },
    { field: 'nsfw-preferences', text: '明确内容', evidence: ['A1'] },
    { field: '近似能力', text: '不得猜字段', evidence: ['A1'] },
    { field: 'age', text: '无效证据', evidence: ['A9'] },
    { field: 'gender', text: '', evidence: ['A1'] },
  ] }, { sources });
  assert.equal(aliases.diagnostics.acceptedFields, 6); assert.equal(aliases.diagnostics.rejectedFields, 3);
  assert.deepEqual(new Set(aliases.diagnostics.rejectionCodes), new Set(['unknown_field', 'unknown_evidence', 'invalid_text']));
});

test('lastBasicAttempt 有界记录成功、空结果、全拒、失败与 profile 写入，不保存正文', async t => {
  await t.test('mixed_success', async () => {
    const h = await makeHarness({ generate: async () => ({
      taskMetadata: { source: 'local', model: 'diag-model', finishReason: 'stop' },
      jsonData: { fields: [
        { field: '外貌', text: '模型正文：银发', evidence: ['A1'] },
        { field: '未知栏目', text: '被拒正文', evidence: ['A1'] },
        { field: 'age', text: '坏来源正文', evidence: ['A99'] },
      ] },
    }) });
    const result = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(result.status, 'ready');
    const attempt = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt;
    assert.equal(attempt.schemaVersion, 1); assert.equal(attempt.status, 'ready'); assert.equal(attempt.aiCalled, true); assert.equal(attempt.targetIdentityId, C1);
    assert.equal(attempt.sourceCount, 6); assert.deepEqual(attempt.sourceKinds, { card: 2, greeting: 1, worldbook: 1, chat: 2 });
    assert.equal(attempt.acceptedFields, 1); assert.equal(attempt.rejectedFields, 2); assert.deepEqual(new Set(attempt.rejectionCodes), new Set(['unknown_field', 'unknown_evidence']));
    assert.equal(attempt.emptyResult, false); assert.equal(attempt.profileWrites, 1); assert.equal(attempt.apiSource, 'local'); assert.equal(attempt.model, 'diag-model'); assert.equal(attempt.finishReason, 'stop');
    assert.doesNotMatch(JSON.stringify(attempt), /模型正文|被拒正文|坏来源正文|钟楼|银发/);
  });

  await t.test('empty', async () => {
    const h = await makeHarness({ generate: async () => ({ jsonData: { fields: [] } }) });
    const result = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(result.status, 'ready'); assert.equal(result.zeroWrite, true);
    const attempt = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt;
    assert.equal(attempt.status, 'ready'); assert.equal(attempt.emptyResult, true); assert.equal(attempt.acceptedFields, 0); assert.equal(attempt.rejectedFields, 0); assert.equal(attempt.profileWrites, 0);
  });

  await t.test('all_rejected', async () => {
    const h = await makeHarness({ generate: async () => ({ jsonData: { fields: [{ field: '动态新字段', text: '拒绝正文', evidence: ['A1'] }, { field: 'age', text: '坏证据', evidence: ['A99'] }] } }) });
    const result = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(result.status, 'ready'); assert.equal(result.emptyResult, false); assert.equal(result.acceptedFields, 0); assert.equal(result.rejectedFields, 2); assert.equal(result.zeroWrite, true);
    const attempt = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt;
    assert.equal(attempt.status, 'ready'); assert.equal(attempt.emptyResult, false); assert.equal(attempt.acceptedFields, 0); assert.equal(attempt.rejectedFields, 2); assert.equal(attempt.profileWrites, 0);
    assert.doesNotMatch(JSON.stringify(attempt), /拒绝正文|坏证据/);
  });

  await t.test('generation_failed', async () => {
    const h = await makeHarness({ generate: async () => { throw new Error('模型原始失败正文'); } });
    const result = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(result.status, 'storage_error');
    const attempt = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt;
    assert.equal(attempt.status, 'failed'); assert.equal(attempt.aiCalled, true); assert.equal(attempt.profileWrites, 0); assert.doesNotMatch(JSON.stringify(attempt), /模型原始失败正文/);
  });
});

test('lastBasicAttempt 诊断 CAS 失败不回滚已成功的 profile 写入', async () => {
  const h = await makeHarness({ generate: async () => ({ jsonData: { fields: [{ field: '性别', text: '女', evidence: ['A1'] }] } }) });
  const original = h.client.put.bind(h.client);
  h.client.put = async (collection, id, data, revision) => {
    if (collection === `chat-${CHAT}` && id === 'people-state' && data.lastBasicAttempt) throw httpError(409);
    return original(collection, id, data, revision);
  };
  const result = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(result.status, 'ready');
  assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.basicFields.gender.value, '女');
  assert.equal(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt, undefined);
});

test('AI 等待期间权威 baseline 变化后失败，不写入或覆盖旧 lastBasicAttempt', async t => {
  const cases = {
    async route(h) { await changeCurrentRoute(h); },
    async canon_runtime(h) { h.records.get(h.key(`chat-${CHAT}`, 'runtime')).data.stableFloorLedger.entries[0].signature = 'changed-runtime-signature'; },
    async selected_c(h) { h.records.get(h.key(`chat-${CHAT}`, 'people-index')).data.confirmed[0].selection = { status: 'unselected' }; },
    async profile_revision(h) {
      const key = h.key(`chat-${CHAT}-people`, C1), current = h.records.get(key);
      h.records.set(key, envelope(current.data, current.revision + 1));
    },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    let release, markStarted; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { markStarted = resolve; });
    const h = await makeHarness({ generate: async () => { markStarted(); await gate; throw new Error('原始 AI 失败'); } });
    const oldAttempt = { schemaVersion: 1, attemptedAt: '2026-08-30T00:00:00.000Z', status: 'ready', marker: 'old-diagnostic' };
    h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt = clone(oldAttempt);
    const pending = h.adapter.extractBasicInfo({ identityId: C1 }); await started;
    const before = h.calls.put.filter(([collection, id]) => collection === `chat-${CHAT}` && id === 'people-state').length;
    await mutate(h); release(); const result = await pending;
    assert.equal(result.status, 'storage_error');
    assert.deepEqual(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt, oldAttempt);
    assert.equal(h.calls.put.filter(([collection, id]) => collection === `chat-${CHAT}` && id === 'people-state').length, before);
  });
});

test('基础信息 profile CAS 冲突只记 conflict 诊断，不覆盖胜出者', async () => {
  const h = await makeHarness({ generate: async () => ({ jsonData: { fields: [{ field: '性别', text: '女', evidence: ['A1'] }] } }) });
  const original = h.client.put.bind(h.client); let raced = false;
  h.client.put = async (collection, id, data, revision) => {
    if (!raced && collection === `chat-${CHAT}-people` && id === C1 && data.basicFields) {
      raced = true; const current = h.records.get(h.key(collection, id)); h.records.set(h.key(collection, id), envelope({ ...current.data, externalWinner: true }, revision + 1)); throw httpError(409);
    }
    return original(collection, id, data, revision);
  };
  const result = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(result.status, 'conflict');
  const profile = h.records.get(h.key(`chat-${CHAT}-people`, C1)).data, attempt = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt;
  assert.equal(profile.externalWinner, true); assert.equal(profile.basicFields, undefined);
  assert.equal(attempt.status, 'conflict'); assert.equal(attempt.acceptedFields, 1); assert.equal(attempt.profileWrites, 0);
});

test('基础信息只使用目标 C 的 Registry、正文名称与锚点来源，首次关系仍保留完整来源', async () => {
  const h = await makeHarness({ generate: async options => options.jsonSchema?.name === 'qianqianjie_basic_info_v1'
    ? { jsonData: { fields: [
      { field: 'abilities', text: '擅长剑术', evidence: ['A3'] },
      { field: 'likes', text: '喜欢甜食', evidence: ['A4'] },
      { field: 'dislikes', text: '厌恶失信', evidence: ['A5'] },
      { field: 'relationships', text: '郑柠：亲生妹妹', evidence: ['A6'] },
      { field: 'principles', text: '伪造已过滤作者来源', evidence: ['A7'] },
      { field: 'age', text: '伪造已过滤聊天来源', evidence: ['H3'] },
    ] } }
    : { jsonData: { items: [] } } });
  const sourceItems = [
    { world: 'a-target', uid: '1', content: 'skills: 剑术。' },
    { world: 'b-prefixed', uid: '2', content: 'likes: 甜食。' },
    { world: 'c-name', uid: '3', content: '林岚明确厌恶失信。' },
    { world: 'd-anchor', uid: '4', content: '林岚锚点；relationships: 郑柠是亲生妹妹。' },
    { world: 'e-other', uid: '5', content: '白榆的 values_and_drives 是追求权势。' },
  ];
  const entries = [];
  for (const item of sourceItems) entries.push({ ...item, fingerprint: `sha256:${await sha256(item.content)}` });
  const meta = h.records.get(h.key(`chat-${CHAT}`, 'meta'));
  meta.data.route.worldInfoEntries = entries.map(({ world, uid, fingerprint }) => ({ world, uid, fingerprint }));
  h.routeState.currentRoute = { ...h.routeState.currentRoute, worldInfoEntries: clone(entries) };
  const binding = h.records.get(h.key(`chat-${CHAT}`, 'people-index')).data.confirmed[0];
  binding.sourceAnchor = '林岚锚点';
  binding.primarySourceRef = { kind: 'worldbook', locator: 'a-target:1' };
  binding.sourceRefs = [binding.primarySourceRef, { kind: 'worldbook', locator: 'worldbook:b-prefixed:2' }];

  assert.equal((await h.adapter.start()).status, 'ready');
  const initialPrompt = h.calls.ai[0].taskMessages[0].content;
  assert.match(initialPrompt, /白榆的 values_and_drives 是追求权势/);
  assert.match(initialPrompt, /我收下钥匙，并答应明天再来/);

  const result = await h.adapter.extractBasicInfo({ identityId: C1 });
  assert.equal(result.status, 'ready'); assert.equal(result.acceptedFields, 4); assert.equal(result.rejectedFields, 2);
  assert.deepEqual(result.rejectionCodes, ['unknown_evidence']);
  const basicPrompt = h.calls.ai[1].taskMessages[0].content;
  for (const included of ['skills: 剑术', 'likes: 甜食', '林岚明确厌恶失信', '林岚锚点；relationships']) assert.match(basicPrompt, new RegExp(included));
  assert.doesNotMatch(basicPrompt, /白榆的 values_and_drives 是追求权势/);
  assert.doesNotMatch(basicPrompt, /我收下钥匙，并答应明天再来/);
  const fields = h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.basicFields;
  assert.equal(fields.abilities.sourceRefs[0].locator, 'worldbook:a-target:1');
  assert.equal(fields.likes.sourceRefs[0].locator, 'worldbook:b-prefixed:2');
  assert.equal(fields.dislikes.sourceRefs[0].locator, 'worldbook:c-name:3');
  assert.equal(fields.relationships.sourceRefs[0].locator, 'worldbook:d-anchor:4');
  assert.equal(fields.principles, undefined); assert.equal(fields.age, undefined);
});

test('基础信息筛不到目标来源时不回退全量，合法空结果零写', async () => {
  const h = await makeHarness({ generate: async options => {
    assert.equal(options.jsonSchema?.name, 'qianqianjie_basic_info_v1');
    const prompt = options.taskMessages[0].content;
    assert.doesNotMatch(prompt, /林岚是霜城钟楼的守门人|冻结开场|钟楼钥匙|叫住了林岚|林岚回头/);
    return { jsonData: { fields: [] } };
  } });
  const binding = h.records.get(h.key(`chat-${CHAT}`, 'people-index')).data.confirmed[0];
  binding.displayName = '无来源者'; binding.sourceAnchor = '无来源锚点';
  binding.primarySourceRef = { kind: 'worldbook', locator: '不存在:99' }; binding.sourceRefs = [binding.primarySourceRef];
  const before = h.calls.put.filter(([collection]) => collection.endsWith('-people')).length;
  const result = await h.adapter.extractBasicInfo({ identityId: C1 });
  assert.equal(result.status, 'ready'); assert.equal(result.emptyResult, true); assert.equal(result.zeroWrite, true); assert.equal(h.calls.ai.length, 1);
  assert.equal(h.calls.put.filter(([collection]) => collection.endsWith('-people')).length, before);
});

test('模拟器卡永不作为 C 基础来源，其他允许来源与非模拟器卡类型保持原规则', async t => {
  await t.test('simulator_keeps_only_allowed_sources', async () => {
    const h = await makeHarness({ generate: async options => {
      const prompt = options.taskMessages[0].content;
      assert.doesNotMatch(prompt, /林岚是霜城钟楼的守门人|寡言但守信/);
      assert.match(prompt, /冻结开场：霜城的钟声响起/); assert.match(prompt, /钟楼钥匙只交给可信之人/); assert.match(prompt, /叫住了林岚/);
      return { jsonData: { fields: [{ field: '能力', text: '维护钟楼机关', evidence: ['A2'] }] } };
    } });
    h.records.get(h.key(`chat-${CHAT}`, 'meta')).data.cardType = 'simulator';
    const result = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(result.status, 'ready'); assert.equal(result.acceptedFields, 1);
    const attempt = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt;
    assert.equal(attempt.sourceKinds.card, 0); assert.equal(attempt.sourceKinds.greeting, 1); assert.equal(attempt.sourceKinds.worldbook, 1); assert.equal(attempt.sourceKinds.chat, 2);
    assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.basicFields.abilities.sourceRefs[0].kind, 'worldbook');
  });

  await t.test('simulator_empty_does_not_fallback_to_card', async () => {
    const h = await makeHarness({ generate: async options => {
      assert.doesNotMatch(options.taskMessages[0].content, /林岚是霜城钟楼的守门人|寡言但守信|冻结开场|钟楼钥匙|叫住了林岚|林岚回头/);
      return { jsonData: { fields: [] } };
    } });
    h.records.get(h.key(`chat-${CHAT}`, 'meta')).data.cardType = 'simulator';
    const binding = h.records.get(h.key(`chat-${CHAT}`, 'people-index')).data.confirmed[0];
    binding.displayName = '无来源模拟对象'; binding.sourceAnchor = '无来源模拟锚'; binding.primarySourceRef = { kind: 'worldbook', locator: '不存在:99' }; binding.sourceRefs = [binding.primarySourceRef];
    const result = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(result.status, 'ready'); assert.equal(result.emptyResult, true); assert.equal(result.zeroWrite, true);
    assert.deepEqual(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt.sourceKinds, { card: 0, greeting: 0, worldbook: 0, chat: 0 });
  });

  for (const cardType of ['single', 'multi', 'open_world']) await t.test(cardType, async () => {
    const h = await makeHarness({ generate: async options => {
      assert.match(options.taskMessages[0].content, /林岚是霜城钟楼的守门人/); return { jsonData: { fields: [] } };
    } });
    h.records.get(h.key(`chat-${CHAT}`, 'meta')).data.cardType = cardType;
    const result = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(result.status, 'ready');
    assert.equal(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt.sourceKinds.card, 2);
  });
});

test('用户基础字段最高权威：自由文本保存、清空与重提取均使用单 profile CAS', async () => {
  const h = await makeHarness({ generate: async options => options.jsonSchema?.name === 'qianqianjie_basic_info_v1'
    ? { jsonData: { fields: [{ field: 'appearance', text: 'AI 新外貌', evidence: ['A1'] }, { field: 'age', text: '二十多岁', evidence: ['A1'] }, { field: 'abilities', text: 'AI 能力', evidence: ['A1'] }, { field: 'likes', text: 'AI 喜好', evidence: ['A1'] }, { field: 'dislikes', text: 'AI 厌恶', evidence: ['A1'] }, { field: 'principles', text: 'AI 原则', evidence: ['A1'] }, { field: 'relationships', text: 'AI 人际关系', evidence: ['A1'] }] } }
    : { jsonData: { items: [] } } });
  assert.equal((await h.adapter.saveBasicField({ identityId: C1, field: 'appearance', value: '用户写的外貌（自由文本）' })).status, 'ready');
  assert.equal((await h.adapter.saveBasicField({ identityId: C1, field: 'likes', value: '用户喜欢雨声' })).status, 'ready');
  assert.equal((await h.adapter.saveBasicField({ identityId: C1, field: 'principles', value: '用户原则' })).status, 'ready');
  assert.equal((await h.adapter.saveBasicField({ identityId: C1, field: 'relationships', value: '郑柠：亲生妹妹' })).status, 'ready');
  const extracted = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(extracted.status, 'ready'); assert.equal(extracted.skippedUserFields, 4);
  let fields = h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.basicFields;
  assert.equal(fields.appearance.value, '用户写的外貌（自由文本）'); assert.equal(fields.appearance.provenance, 'user'); assert.equal(fields.age.value, '二十多岁'); assert.equal(fields.abilities.value, 'AI 能力');
  assert.equal(fields.likes.value, '用户喜欢雨声'); assert.equal(fields.likes.provenance, 'user'); assert.equal(fields.dislikes.value, 'AI 厌恶'); assert.equal(fields.principles.value, '用户原则'); assert.equal(fields.relationships.value, '郑柠：亲生妹妹'); assert.equal(fields.relationships.provenance, 'user');
  assert.equal((await h.adapter.saveBasicField({ identityId: C1, field: 'appearance', value: '   ' })).status, 'ready');
  assert.equal((await h.adapter.saveBasicField({ identityId: C1, field: 'dislikes', value: '' })).status, 'ready');
  fields = h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.basicFields; assert.equal(fields.appearance, undefined); assert.equal(fields.dislikes, undefined); assert.equal(fields.age.value, '二十多岁');
});

test('基础信息合法空结果完成；Persona/取消选择/主动取消的迟到结果零写', async t => {
  await t.test('empty', async () => {
    const h = await makeHarness({ generate: async () => ({ jsonData: { fields: [] } }) });
    const before = h.calls.put.filter(([collection]) => collection.endsWith('-people')).length;
    const result = await h.adapter.extractBasicInfo({ identityId: C1 }); assert.equal(result.status, 'ready'); assert.equal(result.emptyResult, true); assert.equal(result.zeroWrite, true);
    assert.equal(h.calls.put.filter(([collection]) => collection.endsWith('-people')).length, before);
  });
  for (const mode of ['persona', 'unselect', 'cancel']) await t.test(mode, async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const h = await makeHarness({ generate: async () => { await gate; return { jsonData: { fields: [{ field: 'gender', text: '女', evidence: ['A1'] }] } }; } });
    const before = h.calls.put.filter(([collection]) => collection.endsWith('-people')).length;
    const pending = h.adapter.extractBasicInfo({ identityId: C1 }); await new Promise(resolve => setImmediate(resolve));
    if (mode === 'persona') h.ctx.userAvatar = 'other.png';
    if (mode === 'unselect') h.records.get(h.key(`chat-${CHAT}`, 'people-index')).data.confirmed[0].selection = { status: 'unselected' };
    if (mode === 'cancel') h.adapter.cancel();
    release(); const result = await pending; assert.equal(mode === 'unselect' ? result.status : 'stale', mode === 'unselect' ? 'mismatch' : result.status);
    assert.equal(h.calls.put.filter(([collection]) => collection.endsWith('-people')).length, before);
    assert.equal(h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.lastBasicAttempt, undefined);
  });
});

test('基础信息遇到未来 people-state schema 时诊断与 profile 均零写', async () => {
  const h = await makeHarness(); const state = h.records.get(h.key(`chat-${CHAT}`, 'people-state')); state.data.contractVersion = 2;
  const before = h.calls.put.length, result = await h.adapter.extractBasicInfo({ identityId: C1 });
  assert.equal(result.status, 'future_schema_readonly'); assert.equal(h.calls.put.length, before); assert.equal(state.data.lastBasicAttempt, undefined);
});

test('基础字段保存遇到未来 schema 或 CAS 胜出者时不覆盖', async t => {
  await t.test('future', async () => {
    const h = await makeHarness(); h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.peopleContractVersion = 2;
    assert.equal((await h.adapter.saveBasicField({ identityId: C1, field: 'gender', value: '女' })).status, 'future_schema_readonly');
  });
  await t.test('cas', async () => {
    const h = await makeHarness(); const original = h.client.put.bind(h.client); let raced = false;
    h.client.put = async (collection, id, data, revision) => {
      if (!raced && collection.endsWith('-people') && id === C1) { raced = true; const current = h.records.get(h.key(collection, id)); h.records.set(h.key(collection, id), envelope({ ...current.data, external: true }, revision + 1)); throw httpError(409); }
      return original(collection, id, data, revision);
    };
    assert.equal((await h.adapter.saveBasicField({ identityId: C1, field: 'gender', value: '女' })).status, 'conflict');
    assert.equal(h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.basicFields?.gender, undefined);
  });
});

test('外层 draft operationId 被篡改后原子停为 mismatch，清除 draft 且重复 resume 零 profile PUT', async () => {
  const h = await makeHarness({ profilePutFailure: ({ id, failedProfile }) => id === C1 && !failedProfile });
  assert.equal((await h.adapter.start()).status, 'storage_error');
  const stateRecord = h.records.get(h.key(`chat-${CHAT}`, 'people-state'));
  stateRecord.data.initialGeneration.draft.operationId = '66666666-6666-4666-8666-666666666666';
  const before = h.calls.put.filter(([collection]) => collection.endsWith('-people')).length;
  assert.equal((await h.adapter.resume()).status, 'mismatch');
  const stopped = h.records.get(h.key(`chat-${CHAT}`, 'people-state')).data.initialGeneration;
  assert.equal(stopped.status, 'mismatch'); assert.equal(stopped.errorCode, 'corrupt_draft'); assert.equal(stopped.draft, undefined);
  assert.equal(h.adapter.getState().status, 'mismatch'); assert.equal((await h.adapter.resume()).status, 'mismatch');
  assert.equal(h.calls.put.filter(([collection]) => collection.endsWith('-people')).length, before);
});

test('完成后新实例 resume 复用 loadPlan 检出 sourceBinding 错绑，零 AI零 PUT且不宣告 ready', async () => {
  const h = await makeHarness(); assert.equal((await h.adapter.start()).status, 'ready');
  h.records.get(h.key(`chat-${CHAT}-people`, C1)).data.sourceBinding.identityId = C2;
  let ai = 0; const puts = h.calls.put.length;
  const adapter = createInitialRelationGenerationAdapter({
    client: h.client, contextProvider: () => h.ctx,
    routeSource: { collectFrozenAnalysisSources: async () => ({ status: 'ready', warnings: [], sources: { greeting: h.route.greeting, worldInfoEntries: [{ world: '霜城', uid: '7', fingerprint: h.route.worldInfoEntries[0].fingerprint, content: '钟楼钥匙只交给可信之人。' }] } }) },
    generateRelationTask: async () => { ai += 1; throw new Error('不应调用 AI'); },
  });
  const result = await adapter.resume(); assert.equal(result.status, 'mismatch'); assert.equal(ai, 0); assert.equal(h.calls.put.length, puts);
});
