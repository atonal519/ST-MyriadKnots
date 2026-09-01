import test from 'node:test';
import assert from 'node:assert/strict';
import { createCRegistryAdapter, normalizeRegistrySources, normalizeExternalRecognitionResult, validateRecognitionResult, validateRegistryIndex, mapPeopleError, captureSnapshot, fingerprintRegistrySources, REGISTRY_CONTRACT_VERSION } from '../src/c-registry.js';
import { createRouteSourceAdapter } from '../src/route-source.js';
import { sha256 } from '../src/identity.js';
const id = '123e4567-e89b-12d3-a456-426614174000';
const context = () => ({ chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: id } }, chat: [{ mes: '开场' }, { mes: '后续不应进入来源' }] });
const route = { collectAnalysisSources: async () => ({ greeting: { swipeId: 0, fingerprint: 'sha256:' + '1'.repeat(64), content: '<script>alert(1)</script>重要人物' }, worldInfoEntries: [{ world: 'w', uid: '1', fingerprint: 'sha256:' + '2'.repeat(64), content: '候选人物' }] }) };
function fakeClient() { const records = new Map(); const calls = []; return { calls, records, get: async (c, k) => { calls.push(['get', c, k]); const value = records.get(`${c}/${k}`); if (!value) throw Object.assign(new Error('404'), { status: 404 }); return value; }, put: async (c, k, data, expectedRevision) => { calls.push(['put', c, k, data, expectedRevision]); const key = `${c}/${k}`; const prior = records.get(key); if ((prior?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('409'), { status: 409 }); const value = { schemaVersion: 1, revision: expectedRevision + 1, generationId: id, createdAt: 'x', updatedAt: 'x', data }; records.set(key, value); return value; } }; }
async function waitUntil(predicate, message = '等待异步 seam 超时') { const deadline = Date.now() + 1000; while (!predicate()) { if (Date.now() >= deadline) throw new Error(message); await new Promise(resolve => setImmediate(resolve)); } }
test('C Registry 动态 seam：边界、清理、candidate 可见与同源零 API', async () => { const client = fakeClient(); let calls = 0; const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async options => { calls++; assert.equal(options.includeCharacterCard, false); assert.equal(options.worldInfoSource, 'none'); assert.equal(options.substituteMacros, false); assert.equal(options.taskMessages[0].content.includes('后续不应进入来源'), false); return { confirmed: [{ name: '确认者', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [{ name: '候选者', sourceAnchor: '候选人物', primarySourceRef: { kind: 'worldbook', locator: 'w:1' }, sourceRefs: [{ kind: 'worldbook', locator: 'w:1' }] }], discarded: [] }; } }); const result = await adapter.identify(); assert.equal(result.index.candidate.length, 1); assert.equal(calls, 1); assert.equal((await adapter.identify()).reused, true); assert.equal(calls, 1); assert.equal(normalizeRegistrySources(await route.collectAnalysisSources())[0].content, '重要人物'); });

test('外部结果纯函数 seam：别名/缺分类/额外字段/Unicode 空白/引用补全与逐项 salvage', () => {
  const greeting = { kind: 'greeting', locator: 'greeting:0:0', content: 'Ａlice　同学；独有甲；重名；双生；双生' };
  const worldbook = { kind: 'worldbook', locator: '人物书:1', content: '重名；候选乙' };
  const invented = { kind: 'worldbook', locator: '虚构:999' };
  const result = normalizeExternalRecognitionResult({
    confirmedPeople: [
      { displayName: ' Alice ', anchor: 'Alice 同学', primarySource: { kind: ' greeting ', locator: ' greeting:0:0 ' }, extra: '不得透传' },
      { displayName: '独有甲', anchor: '完全错误锚点', primarySource: invented, refs: [invented] },
      { displayName: '重名', anchor: '错误锚点', primarySource: invented, refs: [invented] },
      { displayName: '双生', anchor: '仍是错误锚点', primarySource: greeting, refs: [greeting] },
    ],
    candidates: [{ displayName: '候选乙', anchor: '候选乙', refs: [worldbook, invented] }],
    diagnosticDump: '完整模型响应不得进入 warning',
  }, [greeting, worldbook]);
  assert.deepEqual(result.value.confirmed.map(item => item.name), ['Alice', '独有甲']);
  assert.equal(result.value.confirmed[0].sourceAnchor, 'Ａlice　同学');
  assert.deepEqual(result.value.confirmed[0].sourceRefs, [{ kind: 'greeting', locator: 'greeting:0:0' }]);
  assert.equal(result.value.confirmed[1].primarySourceRef.locator, 'greeting:0:0');
  assert.equal(result.value.candidate[0].sourceRefs.some(item => item.locator === '虚构:999'), false);
  assert.equal(result.value.discarded.length, 0); assert.equal(validateRecognitionResult(result.value, [greeting, worldbook]).confirmed.length, 2);
  assert.throws(() => validateRecognitionResult({ ...result.value, confirmed: [{ ...result.value.confirmed[0], extra: true }] }, [greeting, worldbook]), /字段无效/);
  assert.ok(result.warnings.some(item => item.code === 'NORMALIZATION_ITEM_SKIPPED'));
  assert.ok(result.warnings.some(item => item.code === 'NORMALIZATION_UNKNOWN_REF_DROPPED'));
  assert.ok(result.warnings.length <= 12); assert.doesNotMatch(JSON.stringify(result.warnings), /完整模型响应|不得透传|虚构:999|Alice/);
});

test('格式全坏最多同快照重试一次：formal/frozen 各读一次，v2 与旧列表零写保留，之后仍可成功升级', async () => {
  const client = fakeClient(); let formalReads = 0, frozenReads = 0, dynamicReads = 0, aiCalls = 0, mode = 'ready'; const prompts = [];
  const frozenSources = { greeting: { swipeId: 0, fingerprint: 'sha256:' + '7'.repeat(64), content: '旧人物在这里' }, worldInfoEntries: [] };
  const formalRoute = { state: 'ready', greeting: { floor: 0, ...frozenSources.greeting }, worldInfoEntries: [] };
  const adapter = createCRegistryAdapter({
    client,
    formal: { getFormalState: async () => { formalReads += 1; return { status: 'route_ready', route: formalRoute }; } },
    contextProvider: context,
    routeSource: {
      collectFrozenAnalysisSources: async () => { frozenReads += 1; return { status: 'ready', sources: frozenSources }; },
      collectAnalysisSources: async () => { dynamicReads += 1; return frozenSources; },
    },
    generateTask: async ({ taskMessages }) => {
      aiCalls += 1; prompts.push(taskMessages[0].content);
      if (mode === 'bad') return { confirmed: [{ name: '虚构人物', sourceAnchor: '不存在锚点', primarySourceRef: { kind: 'worldbook', locator: '虚构:999' }, sourceRefs: [{ kind: 'worldbook', locator: '虚构:999' }] }] };
      return { confirmed: [{ name: '旧人物', sourceAnchor: '旧人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] };
    },
  });
  const first = await adapter.identify(); const oldIdentity = first.index.confirmed[0].identityId, indexKey = `chat-${id}/people-index`;
  client.records.get(indexKey).data.contractVersion = 2; mode = 'bad'; const putsBefore = client.calls.filter(call => call[0] === 'put').length;
  const before = { formalReads, frozenReads, aiCalls };
  await assert.rejects(() => adapter.identify(), /无可用人物/);
  assert.equal(formalReads - before.formalReads, 1); assert.equal(frozenReads - before.frozenReads, 1); assert.equal(aiCalls - before.aiCalls, 2); assert.equal(dynamicReads, 0);
  assert.equal(prompts.at(-2), prompts.at(-1).replace(/\n\n上一次返回无法安全归一化。[^\n]+/, ''));
  assert.match(prompts.at(-1), /同一批锁定来源/); assert.equal(client.calls.filter(call => call[0] === 'put').length, putsBefore);
  const preserved = client.records.get(indexKey).data; assert.equal(preserved.contractVersion, 2); assert.equal(preserved.confirmed[0].identityId, oldIdentity);
  mode = 'ready'; const upgraded = await adapter.identify(); assert.equal(upgraded.index.contractVersion, 3); assert.equal(upgraded.index.confirmed[0].identityId, oldIdentity);
});

test('C Registry single-flight seam：并发只发一次且传输 Schema 完整；失败后可重试', async () => {
  const client = fakeClient(); let resolveTask; let calls = 0; let seen;
  const result = { confirmed: [], candidate: [], discarded: [] };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async options => { calls += 1; seen = options.jsonSchema; await new Promise(resolve => { resolveTask = resolve; }); return { jsonData: result }; } });
  const first = adapter.identify(); const second = adapter.identify(); assert.equal(first, second); await waitUntil(() => typeof resolveTask === 'function'); resolveTask(); const values = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.deepEqual(seen, { name: 'qianqianjie_c_registry', value: seen.value, strict: true }); assert.equal(seen.value.type, 'object'); assert.ok(seen.value.properties.confirmed);
  let attempts = 0; const retry = createCRegistryAdapter({ client: fakeClient(), contextProvider: context, routeSource: route, generateTask: async () => { attempts += 1; if (attempts === 1) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); return { jsonData: result }; } });
  await assert.rejects(() => retry.identify()); assert.equal((await retry.identify()).status, 'ready'); assert.equal(attempts, 2); assert.equal(values[0].status, 'ready');
});

test('来源许可识别遇到格式错误也只调用一次 AI，不进行隐式第二次修复', async () => {
  const sources = normalizeRegistrySources(await route.collectAnalysisSources()); let calls = 0;
  const adapter = createCRegistryAdapter({
    client: fakeClient(), contextProvider: context, routeSource: route,
    snapshotProvider: async () => ({ snapshot: captureSnapshot({ contextProvider: context, sourceStatus: 'ready' }), sources, strategy: { sourceCatalogPermit: true } }),
    generateTask: async () => { calls += 1; return { confirmed: 'invalid', candidate: [], discarded: [] }; },
  });
  await assert.rejects(adapter.identify(), error => error.retryableRecognitionFormat === true); assert.equal(calls, 1);
});

test('生产 catalog 人物识别必须消费真实一次性许可，缺失、伪造或复用均零 AI', async () => {
  const sources = normalizeRegistrySources(await route.collectAnalysisSources()); let calls = 0;
  const issued = { status: 'claimed', operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }; let available = true;
  const adapter = createCRegistryAdapter({
    client: fakeClient(), contextProvider: context, routeSource: route,
    sourceCatalog: {
      getConfirmedSources: async () => ({ sources }),
      consumeRecognitionClaim: claim => claim === issued && available ? (available = false, true) : false,
    },
    snapshotProvider: async () => ({ snapshot: captureSnapshot({ contextProvider: context, sourceStatus: 'ready' }), sources, strategy: { sourceCatalogPermit: true } }),
    generateTask: async () => { calls += 1; return { confirmed: [], candidate: [], discarded: [] }; },
  });
  await assert.rejects(adapter.identify(), /一次性来源许可/); assert.equal(calls, 0);
  await assert.rejects(adapter.identify({ sourceCatalogClaim: { ...issued } }), /一次性来源许可/); assert.equal(calls, 0);
  assert.equal((await adapter.identify({ sourceCatalogClaim: issued })).status, 'ready'); assert.equal(calls, 1);
  await assert.rejects(adapter.identify({ sourceCatalogClaim: issued }), /一次性来源许可/); assert.equal(calls, 1);
});

test('C Registry 实时身份快照变化：AI 迟到结果零写，并覆盖脱敏错误映射', async () => {
  const state = { characterId: 'old-role' }; const liveContext = () => ({ ...context(), ...state }); const client = fakeClient(); let release;
  const adapter = createCRegistryAdapter({ client, contextProvider: liveContext, routeSource: route, generateTask: async () => { await new Promise(resolve => { release = resolve; }); return { confirmed: [], candidate: [], discarded: [] }; } });
  const pending = adapter.identify(); await waitUntil(() => typeof release === 'function'); state.characterId = 'new-role'; release(); assert.equal((await pending).status, 'stale'); assert.equal(client.calls.filter(call => call[0] === 'put').length, 0);
  const secret = Object.assign(new Error('api_key=super-secret prompt=private'), { status: 401 }); assert.equal(mapPeopleError(secret), 'API 认证失败，请检查配置后重试'); assert.doesNotMatch(mapPeopleError(secret), /super-secret|private/); assert.equal(captureSnapshot({ contextProvider: liveContext }).characterId, 'new-role');
});

test('C Registry 快照中关闭：formal 释放后不再扫描来源、调用 AI 或读写后端', async () => {
  const client = fakeClient(); let formalRelease, formalStarted = false, scans = 0, ai = 0;
  const frozenRoute = { state: 'ready', greeting: { floor: 0, swipeId: 0, fingerprint: 'sha256:' + '1'.repeat(64) }, worldInfoEntries: [] };
  const adapter = createCRegistryAdapter({ client, contextProvider: context,
    formal: { getFormalState: async () => { formalStarted = true; await new Promise(resolve => { formalRelease = resolve; }); return { status: 'route_ready', route: frozenRoute }; } },
    routeSource: { collectFrozenAnalysisSources: async () => { scans += 1; return { status: 'ready', sources: { greeting: { ...frozenRoute.greeting, content: '人物' }, worldInfoEntries: [] } }; } },
    generateTask: async () => { ai += 1; return { confirmed: [], candidate: [], discarded: [] }; },
  });
  const pending = adapter.identify(); await waitUntil(() => formalStarted); adapter.invalidate(); formalRelease(); assert.equal((await pending).status, 'stale'); assert.equal(scans, 0); assert.equal(ai, 0); assert.equal(client.calls.length, 0);
});

test('C Registry AI 识别中关闭：abort 后迟到结果零 PUT 且最终 stale', async () => {
  const client = fakeClient(); let release, aiStarted = false;
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => { aiStarted = true; await new Promise(resolve => { release = resolve; }); return { confirmed: [], candidate: [], discarded: [] }; } });
  const pending = adapter.identify(); await waitUntil(() => aiStarted); adapter.invalidate(); release(); assert.equal((await pending).status, 'stale'); assert.equal(client.calls.filter(call => call[0] === 'put').length, 0);
});

test('C Registry GET 队列积压后关闭：释放前序时旧排队任务零新增 GET/PUT', async () => {
  let release, gets = 0; const client = { get: async () => { gets += 1; await new Promise(resolve => { release = resolve; }); throw Object.assign(new Error('404'), { status: 404 }); }, put: async () => { throw new Error('不应写入'); } };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => ({ confirmed: [], candidate: [], discarded: [] }) });
  const first = adapter.getPeople(); await waitUntil(() => gets === 1); const queued = adapter.getPeople(); adapter.invalidate(); release(); assert.equal((await first).status, 'stale'); assert.equal((await queued).status, 'stale'); assert.equal(gets, 1);
});

test('C Registry 识别排队后关闭：旧任务不重新生成 token，零来源扫描/AI/新增 GET/PUT', async () => {
  let release, gets = 0, scans = 0, ai = 0, enabled = true;
  const client = { get: async () => { gets += 1; await new Promise(resolve => { release = resolve; }); throw Object.assign(new Error('404'), { status: 404 }); }, put: async () => { throw new Error('不应写入'); } };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, isEnabled: () => enabled,
    snapshotProvider: async () => captureSnapshot({ contextProvider: context }),
    routeSource: { collectAnalysisSources: async () => { scans += 1; return route.collectAnalysisSources(); } },
    generateTask: async () => { ai += 1; return { confirmed: [], candidate: [], discarded: [] }; },
  });
  const first = adapter.getPeople(); await waitUntil(() => gets === 1); const queued = adapter.identify(); await new Promise(resolve => setImmediate(resolve));
  enabled = false; adapter.invalidate(); release();
  assert.equal((await first).status, 'stale'); assert.equal((await queued).status, 'stale'); assert.equal(gets, 1); assert.equal(scans, 0); assert.equal(ai, 0);
});

test('C Registry 持续关闭硬闸：invalidate 后迟到的新调用也零聊天读取/扫描/AI/GET/PUT', async () => {
  let enabled = true, contextReads = 0, scans = 0, ai = 0; const client = fakeClient();
  const adapter = createCRegistryAdapter({ client, isEnabled: () => enabled, contextProvider: () => { contextReads += 1; return context(); },
    routeSource: { collectAnalysisSources: async () => { scans += 1; return route.collectAnalysisSources(); } },
    generateTask: async () => { ai += 1; return { confirmed: [], candidate: [], discarded: [] }; },
  });
  enabled = false; adapter.invalidate();
  assert.equal((await adapter.identify()).status, 'stale'); assert.equal((await adapter.getPeople()).status, 'stale');
  assert.equal(contextReads, 0); assert.equal(scans, 0); assert.equal(ai, 0); assert.equal(client.calls.length, 0);
});

test('C Registry 快照 single-flight：A→B→A 时 A 共享，B 不错绑到 A', async () => {
  const idA = '123e4567-e89b-12d3-a456-426614174001'; const idB = '123e4567-e89b-12d3-a456-426614174002';
  const state = { chatId: idA }; const liveContext = () => ({ chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: state.chatId } } }); const client = fakeClient(); const releases = []; let calls = 0; let bSnapshotReady = false;
  const snapshotProvider = async () => { const snapshot = captureSnapshot({ contextProvider: liveContext, sourceStatus: 'ready' }); if (snapshot.chatId === idB) bSnapshotReady = true; return snapshot; };
  const adapter = createCRegistryAdapter({ client, contextProvider: liveContext, routeSource: route, snapshotProvider, generateTask: async () => { calls += 1; await new Promise(resolve => { releases.push(resolve); }); return { confirmed: [], candidate: [], discarded: [] }; } });
  const first = adapter.identify(); await waitUntil(() => releases.length === 1); state.chatId = idB; const second = adapter.identify(); await waitUntil(() => bSnapshotReady); state.chatId = idA; const third = adapter.identify(); assert.equal(first, third); state.chatId = idB; releases[0](); await waitUntil(() => releases.length === 2); releases[1]();
  const [a, b] = await Promise.all([first, second]); assert.equal(a.status, 'stale'); assert.equal(b.status, 'ready'); assert.equal(calls, 2); assert.equal(client.records.has(`chat-${idA}/people-index`), false); assert.equal(client.records.has(`chat-${idB}/people-index`), true);
});

test('C Registry legacy：snapshotProvider 挂起期间切 A→B，入口 A 直接 stale 且零写', async () => {
  const idA = '123e4567-e89b-12d3-a456-426614174001'; const idB = '123e4567-e89b-12d3-a456-426614174002'; const state = { chatId: idA }; const liveContext = () => ({ chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: state.chatId } } }); const client = fakeClient(); let release; let started = false;
  const snapshotProvider = async () => { started = true; await new Promise(resolve => { release = resolve; }); return captureSnapshot({ contextProvider: liveContext }); };
  const adapter = createCRegistryAdapter({ client, contextProvider: liveContext, routeSource: route, snapshotProvider, generateTask: async () => ({ confirmed: [], candidate: [], discarded: [] }) }); const pending = adapter.identify(); await waitUntil(() => started); state.chatId = idB; release(); assert.equal((await pending).status, 'stale'); assert.equal(client.calls.filter(call => call[0] === 'put').length, 0); assert.equal(client.records.has(`chat-${idB}/people-index`), false);
});

test('C Registry formal frozen：collectFrozenAnalysisSources 挂起期间切 A→B，入口 A 不归属 B', async () => {
  const idA = '123e4567-e89b-12d3-a456-426614174001'; const idB = '123e4567-e89b-12d3-a456-426614174002'; const state = { chatId: idA }; const liveContext = () => ({ chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: state.chatId } } }); const client = fakeClient(); let release; let started = false;
  const frozenRoute = { state: 'ready', greeting: { floor: 0, swipeId: 0, fingerprint: 'sha256:' + '1'.repeat(64), content: '冻结人物' }, worldInfoEntries: [] }; const routeSource = { collectFrozenAnalysisSources: async () => { started = true; await new Promise(resolve => { release = resolve; }); return { status: 'ready', sources: { greeting: frozenRoute.greeting, worldInfoEntries: [] } }; }, collectAnalysisSources: async () => ({ greeting: frozenRoute.greeting, worldInfoEntries: [] }) };
  const adapter = createCRegistryAdapter({ client, formal: { getFormalState: async () => ({ status: 'route_ready', route: frozenRoute }) }, contextProvider: liveContext, routeSource, generateTask: async () => ({ confirmed: [], candidate: [], discarded: [] }) }); const pending = adapter.identify(); await waitUntil(() => started); state.chatId = idB; release(); assert.equal((await pending).status, 'stale'); assert.equal(client.calls.filter(call => call[0] === 'put').length, 0); assert.equal(client.records.has(`chat-${idB}/people-index`), false);
});

test('C Registry 同步捕获窗口 A→B→A：A 调用共享，B 不返回 A Promise', async () => {
  const idA = '123e4567-e89b-12d3-a456-426614174001'; const idB = '123e4567-e89b-12d3-a456-426614174002'; const state = { chatId: idA }; const liveContext = () => ({ chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: state.chatId } } }); const gates = []; let providerCalls = 0;
  const snapshotProvider = async () => { providerCalls += 1; if (providerCalls <= 2) await new Promise(resolve => gates.push(resolve)); return captureSnapshot({ contextProvider: liveContext }); }; const adapter = createCRegistryAdapter({ client: fakeClient(), contextProvider: liveContext, routeSource: route, snapshotProvider, generateTask: async () => ({ confirmed: [], candidate: [], discarded: [] }) });
  const first = adapter.identify(); state.chatId = idB; const second = adapter.identify(); state.chatId = idA; const third = adapter.identify(); assert.equal(first, third); assert.notEqual(second, first); await waitUntil(() => gates.length === 2); state.chatId = idA; gates.forEach(resolve => resolve()); const [a, b] = await Promise.all([first, second]); assert.equal(a.status, 'ready'); assert.equal(b.status, 'stale');
});

test('C Registry AI 在途时来源内容/status 改变：使用起始快照完成且不重复读取', async () => {
  let source = '来源旧'; let status = 'ready'; let release; let scans = 0;
  const changingRoute = { collectAnalysisSources: async () => { scans += 1; return { greeting: { swipeId: 0, fingerprint: 'sha256:' + '1'.repeat(64), content: source }, worldInfoEntries: [] }; } }; const client = fakeClient();
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: changingRoute, generateTask: async ({ taskMessages }) => { assert.match(taskMessages[0].content, /来源旧/); await new Promise(resolve => { release = resolve; }); return { confirmed: [], candidate: [], discarded: [] }; } });
  const pending = adapter.identify(); await waitUntil(() => typeof release === 'function'); source = '来源新'; status = 'source_unavailable'; release(); assert.equal((await pending).status, 'ready'); assert.equal(scans, 1); assert.equal(status, 'source_unavailable');
});
test('C Registry CAS 409 后来源改变：仍使用起始快照完成', async () => { let source = '来源旧'; let puts = 0; const changingRoute = { collectAnalysisSources: async () => ({ greeting: { swipeId: 0, fingerprint: 'sha256:' + '1'.repeat(64), content: source }, worldInfoEntries: [] }) }; const client = fakeClient(); const originalPut = client.put; client.put = async (...args) => { puts += 1; source = '来源新'; return originalPut(...args); }; const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: changingRoute, generateTask: async () => ({ confirmed: [], candidate: [], discarded: [] }) }); const result = await adapter.identify(); assert.equal(result.status, 'ready'); assert.ok(puts >= 1); });
test('C Registry 稳定 UUID、selection 与可恢复搁置', async () => { const client = fakeClient(); const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => ({ confirmed: [{ name: '确认者', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] }) }); const first = await adapter.identify(); const identity = first.index.confirmed[0].identityId; const profile = await client.get(`chat-${id}-people`, identity); assert.equal(profile.data.selection.status, 'unselected'); await adapter.shelve({ identityId: identity }); const shelved = await adapter.getPeople(); assert.equal(shelved.shelved[0].identityId, identity); assert.equal(shelved.shelved[0].selection.status, 'unselected'); await adapter.restore({ identityId: identity }); const restored = await adapter.getPeople(); assert.equal(restored.confirmed[0].identityId, identity); assert.equal(restored.confirmed[0].selection.status, 'unselected'); });

test('C Registry 生产 writer 遇到未来 profile schema/合同只读暂停且零 PUT/零新增 AI', async () => {
  for (const futurePatch of [{ schemaVersion: 2 }, { peopleContractVersion: 2 }]) {
    const client = fakeClient(); let aiCalls = 0;
    const answer = { confirmed: [{ name: '确认者', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] };
    const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => { aiCalls += 1; return answer; } });
    const first = await adapter.identify(); const identity = first.index.confirmed[0].identityId;
    Object.assign(client.records.get(`chat-${id}-people/${identity}`).data, futurePatch);
    const writes = client.calls.filter(call => call[0] === 'put').length;
    const restored = await adapter.identify();
    assert.equal(restored.status, 'future_schema_readonly');
    assert.equal(restored.readonly, true);
    assert.equal(client.calls.filter(call => call[0] === 'put').length, writes);
    assert.equal(aiCalls, 1);
    const renamed = await adapter.editDisplayName({ identityId: identity, displayName: '不得写回未来档' });
    assert.equal(renamed.status, 'future_schema_readonly');
    assert.equal(client.calls.filter(call => call[0] === 'put').length, writes);
    assert.equal(client.records.get(`chat-${id}-people/${identity}`).data.displayName, '确认者');
  }
});

test('C Registry profile CAS 竞争胜出者升级为未来版本时不覆盖、不降级', async () => {
  const client = fakeClient(); let aiCalls = 0;
  const answer = { confirmed: [{ name: '确认者', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => { aiCalls += 1; return answer; } });
  const first = await adapter.identify(); const identity = first.index.confirmed[0].identityId;
  client.records.get(`chat-${id}/people-index`).data.confirmed[0].selection = { status: 'selected' };
  const originalPut = client.put; let raced = false;
  client.put = async (collection, key, data, revision) => {
    if (!raced && collection === `chat-${id}-people` && key === identity) {
      raced = true;
      const winner = structuredClone(client.records.get(`${collection}/${key}`));
      winner.revision += 1; winner.data.schemaVersion = 2; winner.data.futureField = { keep: true };
      client.records.set(`${collection}/${key}`, winner);
      throw Object.assign(new Error('409'), { status: 409 });
    }
    return originalPut(collection, key, data, revision);
  };
  const result = await adapter.identify();
  assert.equal(result.status, 'future_schema_readonly'); assert.equal(raced, true); assert.equal(aiCalls, 1);
  const winner = client.records.get(`chat-${id}-people/${identity}`).data;
  assert.equal(winner.schemaVersion, 2); assert.equal(winner.futureField.keep, true); assert.equal(winner.selection.status, 'unselected');
});

test('C Registry profile 来源引用采用稳定保序并集，历史与 future refs 均不删除', async () => {
  const client = fakeClient(); let aiCalls = 0;
  const answer = { confirmed: [{ name: '确认者', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => { aiCalls += 1; return answer; } });
  const first = await adapter.identify(); const identity = first.index.confirmed[0].identityId;
  const profile = client.records.get(`chat-${id}-people/${identity}`);
  profile.data.sourceRefs = [
    { kind: 'greeting', locator: 'greeting:legacy' },
    { kind: 'future-ref', locator: 'future:1', extension: true },
    { kind: 'greeting', locator: 'greeting:0:0', extension: '保留首项' },
    { kind: 'future-ref', locator: 'future:1', duplicate: true },
  ];
  const indexRecord = client.records.get(`chat-${id}/people-index`);
  indexRecord.data.confirmed[0].sourceRefs = [{ kind: 'greeting', locator: 'greeting:0:0' }, { kind: 'worldbook', locator: '人物书:2' }];
  const recovered = await adapter.identify();
  assert.equal(recovered.status, 'ready'); assert.equal(aiCalls, 1);
  const refs = client.records.get(`chat-${id}-people/${identity}`).data.sourceRefs;
  assert.deepEqual(refs, [
    { kind: 'greeting', locator: 'greeting:legacy' },
    { kind: 'future-ref', locator: 'future:1', extension: true },
    { kind: 'greeting', locator: 'greeting:0:0', extension: '保留首项' },
    { kind: 'worldbook', locator: '人物书:2' },
  ]);
});

test('profile 中 card ref 只允许严格 single-card-main 绑定；普通档案拒绝，合法 single 改名仍通过', async () => {
  const generic = fakeClient();
  const genericAdapter = createCRegistryAdapter({ client: generic, contextProvider: context, routeSource: route, generateTask: async () => ({
    confirmed: [{ name: '确认者', sourceAnchor: '重要人物', primarySourceRef: greetingRef, sourceRefs: [greetingRef] }], candidate: [], discarded: [],
  }) });
  const genericResult = await genericAdapter.identify(), genericIdentity = genericResult.index.confirmed[0].identityId;
  const genericProfile = generic.records.get(`chat-${id}-people/${genericIdentity}`).data, cardRef = singleRef('description');
  genericProfile.primarySourceRef = cardRef; genericProfile.sourceRefs = [cardRef]; genericProfile.sourceKey = `card:${cardRef.locator}:${genericProfile.sourceAnchor.toLocaleLowerCase()}`;
  const putsBefore = generic.calls.filter(call => call[0] === 'put').length;
  await assert.rejects(() => genericAdapter.editDisplayName({ identityId: genericIdentity, displayName: '不得改名' }), /人物档案无效/);
  assert.equal(generic.calls.filter(call => call[0] === 'put').length, putsBefore);
  genericProfile.sourceBinding = { kind: 'single-card-main', cardId: wrongIdentityId };
  await assert.rejects(() => genericAdapter.editDisplayName({ identityId: genericIdentity, displayName: '错槽仍不得改名' }), /人物档案无效/);
  assert.equal(generic.calls.filter(call => call[0] === 'put').length, putsBefore);

  const single = singleScenario({ cardData: { description: '本卡唯一主 C 是程砚舟。' }, generateTask: async () => ({
    confirmed: [singleItem('程砚舟', '程砚舟', singleRef('description'))], candidate: [], discarded: [],
  }) });
  const singleResult = await single.adapter.identify();
  assert.equal(singleResult.index.confirmed[0].identityId, singleCardId);
  const renamed = await single.adapter.editDisplayName({ identityId: singleCardId, displayName: '用户命名' });
  assert.equal(renamed.status, 'ready'); assert.equal(renamed.index.confirmed[0].displayName, '用户命名');
});

test('C Registry 来源指纹变化仍复用 UUID 和用户显示名，tombstone 不复活', async () => {
  const client = fakeClient(); let revision = 1; const changingRoute = { collectAnalysisSources: async () => ({ greeting: { swipeId: 0, fingerprint: `sha256:${String(revision).repeat(64)}`, content: `重要人物${revision}` }, worldInfoEntries: [] }) };
  const result = () => ({ confirmed: [{ name: '模型原名', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] });
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: changingRoute, generateTask: async () => result() });
  const first = await adapter.identify(); const identity = first.index.confirmed[0].identityId; await adapter.editDisplayName({ identityId: identity, displayName: '用户改名' }); revision = 2; const second = await adapter.identify(); assert.equal(second.index.confirmed[0].identityId, identity); assert.equal(second.index.confirmed[0].displayName, '用户改名'); await adapter.shelve({ identityId: identity }); revision = 3; const third = await adapter.identify(); assert.equal(third.index.confirmed.length, 0); assert.equal(third.index.shelved.some(x => x.identityId === identity), true);
});

test('C Registry 动态恢复：preparing 同指纹零生成，搁置为单记录原子操作', async () => {
  const client = fakeClient(); let calls = 0;
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => { calls++; return { confirmed: [{ name: '确认者', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] }; } });
  const first = await adapter.identify(); const identity = first.index.confirmed[0].identityId; const indexKey = `chat-${id}/people-index`;
  const stored = client.records.get(indexKey); stored.data.status = 'preparing';
  const recovered = await adapter.identify(); assert.equal(recovered.status, 'ready'); assert.equal(calls, 1);
  const putsBefore = client.calls.filter(call => call[0] === 'put').length;
  const shelved = await adapter.shelve({ identityId: identity });
  assert.equal(shelved.confirmed.some(item => item.identityId === identity), false); assert.equal(shelved.shelved.some(item => item.identityId === identity), true);
  assert.equal(client.calls.filter(call => call[0] === 'put').length, putsBefore + 1);
});

test('缺 selection 的旧全量人物合同不误恢复，手动识别可升级', async () => {
  const client = fakeClient(); let calls = 0; let prompt = '';
  const richRoute = { collectAnalysisSources: async () => ({ greeting: { swipeId: 0, fingerprint: 'sha256:' + '3'.repeat(64), content: '甲是核心人物；乙是重要配角；神秘客身份不明；路人甲路过' }, worldInfoEntries: [] }) };
  const answer = { confirmed: [
    { name: '甲', sourceAnchor: '甲是核心人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] },
    { name: '乙', sourceAnchor: '乙是重要配角', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] },
  ], candidate: [{ name: '神秘客', sourceAnchor: '神秘客身份不明', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], discarded: [{ name: '路人甲', sourceAnchor: '路人甲路过', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }] };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: richRoute, generateTask: async options => { calls += 1; prompt = options.taskMessages[0].content; return answer; } });
  const first = await adapter.identify(); assert.equal(first.index.confirmed.length, 2); assert.equal(first.index.candidate.length, 1); assert.equal(first.index.discarded.length, 1);
  for (const text of ['全部重要人物', '不得替用户挑选', 'confirmed：', 'candidate：', 'discarded：', '宁可把有证据的重要人物']) assert.match(prompt, new RegExp(text));
  const stored = client.records.get(`chat-${id}/people-index`); delete stored.data.contractVersion; stored.data.confirmed.forEach(item => { delete item.selection; }); delete stored.data.shelved;
  assert.equal((await adapter.getPeople()).status, 'uninitialized');
  const upgraded = await adapter.identify(); assert.equal(upgraded.status, 'ready'); assert.equal(calls, 2); assert.equal(upgraded.index.contractVersion, REGISTRY_CONTRACT_VERSION);
  assert.equal((await adapter.identify()).reused, true); assert.equal(calls, 2);
});

test('显式 contractVersion:1 但缺 selection 的旧索引不误恢复，手动识别可升级', async () => {
  const client = fakeClient(); let calls = 0;
  const result = { confirmed: [{ name: '旧人物', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => { calls += 1; return result; } });
  await adapter.identify(); const stored = client.records.get(`chat-${id}/people-index`);
  stored.data.contractVersion = 1; stored.data.confirmed.forEach(item => { delete item.selection; }); delete stored.data.shelved;
  assert.equal(validateRegistryIndex(stored, id), true); assert.equal((await adapter.getPeople()).status, 'uninitialized');
  const upgraded = await adapter.identify(); assert.equal(upgraded.status, 'ready'); assert.equal(upgraded.index.contractVersion, REGISTRY_CONTRACT_VERSION); assert.equal(calls, 2);
  assert.equal((await adapter.identify()).reused, true); assert.equal(calls, 2);
});

test('无 contractVersion 且缺 selection 的旧索引不误恢复，手动识别可升级', async () => {
  const client = fakeClient(); let calls = 0;
  const result = { confirmed: [{ name: '旧人物', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => { calls += 1; return result; } });
  await adapter.identify(); const stored = client.records.get(`chat-${id}/people-index`);
  delete stored.data.contractVersion; stored.data.confirmed.forEach(item => { delete item.selection; }); delete stored.data.shelved;
  assert.equal(validateRegistryIndex(stored, id), true); assert.equal((await adapter.getPeople()).status, 'uninitialized');
  const upgraded = await adapter.identify(); assert.equal(upgraded.index.contractVersion, REGISTRY_CONTRACT_VERSION); assert.equal(calls, 2); await adapter.identify(); assert.equal(calls, 2);
});

test('旧多人档案 confirmed/selected 与 profiles 合法时直接恢复基础/动态数据，零 AI 且仅建议手动刷新', async () => {
  const client = fakeClient(); let calls = 0;
  const result = { confirmed: [{ name: '旧人物', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => { calls += 1; return result; } });
  const created = await adapter.identify(); const identityId = created.index.confirmed[0].identityId;
  await adapter.select({ identityId });
  const index = client.records.get(`chat-${id}/people-index`); index.data.contractVersion = 2;
  const profile = client.records.get(`chat-${id}-people/${identityId}`); profile.data.sourceFacts = [{ field: 'appearance', value: '银发', provenance: 'source' }]; profile.data.dynamicFields = { currentSituation: { value: '守城', provenance: 'ai' } };
  const loaded = await adapter.getPeople();
  assert.equal(loaded.status, 'ready'); assert.equal(loaded.refreshRecommended, true); assert.equal(loaded.confirmed[0].selection.status, 'selected'); assert.equal(calls, 1);
  assert.equal(profile.data.sourceFacts[0].value, '银发'); assert.equal(profile.data.dynamicFields.currentSituation.value, '守城');
});

test('损坏旧档、confirmed 缺有效 profile 或身份不一致不误恢复，保持手动初始化且零 AI', async t => {
  for (const variant of ['missing_profile', 'identity_mismatch', 'broken_index']) await t.test(variant, async () => {
    const client = fakeClient(); let calls = 0;
    const result = { confirmed: [{ name: '旧人物', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] };
    const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => { calls += 1; return result; } });
    const created = await adapter.identify(); const identityId = created.index.confirmed[0].identityId;
    await adapter.select({ identityId });
    const index = client.records.get(`chat-${id}/people-index`); index.data.contractVersion = 2;
    const profileKey = `chat-${id}-people/${identityId}`;
    if (variant === 'missing_profile') client.records.delete(profileKey);
    if (variant === 'identity_mismatch') client.records.get(profileKey).data.chatId = '223e4567-e89b-12d3-a456-426614174001';
    if (variant === 'broken_index') index.data.confirmed[0].identityId = 'not-a-uuid';
    const loaded = await adapter.getPeople();
    assert.equal(loaded.status, 'uninitialized'); assert.equal(loaded.legacyInvalid, true); assert.equal(loaded.confirmed.length, 0); assert.equal(calls, 1);
  });
});

test('v2 超时后普通人物操作始终保留 v2，后续识别可重试且成功后才升级 v3', async () => {
  const client = fakeClient(); let mode = 'ready'; let aiCalls = 0;
  const answer = { confirmed: [{ name: '郑楠', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => { aiCalls += 1; if (mode === 'timeout') throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }); return answer; } });
  const indexKey = `chat-${id}/people-index`, currentRecord = () => client.records.get(indexKey);
  const first = await adapter.identify(); const identityId = first.index.confirmed[0].identityId; currentRecord().data.contractVersion = 2;
  mode = 'timeout'; await assert.rejects(() => adapter.identify(), /ETIMEDOUT/);
  assert.equal(currentRecord().data.contractVersion, 2); assert.equal(currentRecord().data.confirmed[0].identityId, identityId);
  await adapter.select({ identityId }); assert.equal(currentRecord().data.contractVersion, 2); assert.equal(currentRecord().data.confirmed[0].selection.status, 'selected');
  await adapter.unselect({ identityId }); assert.equal(currentRecord().data.contractVersion, 2); assert.equal(currentRecord().data.confirmed[0].selection.status, 'unselected');
  await adapter.editDisplayName({ identityId, displayName: '用户命名的郑楠' }); assert.equal(currentRecord().data.contractVersion, 2); assert.equal(currentRecord().data.confirmed[0].displayName, '用户命名的郑楠');
  await adapter.shelve({ identityId }); assert.equal(currentRecord().data.contractVersion, 2); assert.equal(currentRecord().data.confirmed.length, 0); assert.equal(currentRecord().data.shelved[0].identityId, identityId);
  await adapter.restore({ identityId }); assert.equal(currentRecord().data.contractVersion, 2); assert.equal(currentRecord().data.confirmed[0].identityId, identityId); assert.equal(currentRecord().data.shelved.length, 0);
  assert.equal((await adapter.getPeople()).status, 'uninitialized'); assert.equal(aiCalls, 2);
  mode = 'ready'; const upgraded = await adapter.identify(); assert.equal(aiCalls, 3); assert.equal(upgraded.index.contractVersion, 3); assert.equal(upgraded.index.confirmed[0].identityId, identityId); assert.equal(upgraded.index.confirmed[0].displayName, '用户命名的郑楠');
  await adapter.identify(); assert.equal(aiCalls, 3);
});

test('v2 郑楠升级 v3 多人识别保留 identity/选择/改名/userFacts/搁置并加入新人', async () => {
  const source = { collectAnalysisSources: async () => ({ greeting: { swipeId: 0, fingerprint: 'sha256:' + '4'.repeat(64), content: '郑楠是重要人物；宋遥是重要人物' }, worldInfoEntries: [{ world: '人物书', uid: '1', fingerprint: 'sha256:' + '5'.repeat(64), content: '林晚是重要人物' }] }) };
  const binding = (name, sourceAnchor, sourceRef = { kind: 'greeting', locator: 'greeting:0:0' }) => ({ name, sourceAnchor, primarySourceRef: sourceRef, sourceRefs: [sourceRef] });
  let upgraded = false; let aiCalls = 0; const client = fakeClient();
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: source, generateTask: async () => { aiCalls += 1; return { confirmed: upgraded ? [binding('郑楠', '郑楠是重要人物'), binding('宋遥', '宋遥是重要人物'), binding('林晚', '林晚是重要人物', { kind: 'worldbook', locator: '人物书:1' })] : [binding('郑楠', '郑楠是重要人物'), binding('宋遥', '宋遥是重要人物')], candidate: [], discarded: [] }; } });
  const first = await adapter.identify(); const zheng = first.index.confirmed.find(item => item.displayName === '郑楠'); const song = first.index.confirmed.find(item => item.displayName === '宋遥');
  await adapter.select({ identityId: zheng.identityId }); await adapter.editDisplayName({ identityId: zheng.identityId, displayName: '阿楠' }); await adapter.shelve({ identityId: song.identityId });
  const profile = client.records.get(`chat-${id}-people/${zheng.identityId}`); profile.data.userFacts.push({ value: '用户事实仍在', provenance: 'user.note', locked: true });
  const record = client.records.get(`chat-${id}/people-index`); record.data.contractVersion = 2; upgraded = true;
  const result = await adapter.identify(); const kept = result.index.confirmed.find(item => item.identityId === zheng.identityId);
  assert.equal(result.index.contractVersion, 3); assert.equal(aiCalls, 2); assert.equal(kept.displayName, '阿楠'); assert.equal(kept.selection.status, 'selected');
  assert.ok(result.index.confirmed.some(item => item.displayName === '林晚')); assert.ok(result.index.shelved.some(item => item.identityId === song.identityId));
  const keptProfile = client.records.get(`chat-${id}-people/${zheng.identityId}`).data; assert.ok(keptProfile.userFacts.some(item => item.value === '用户事实仍在')); assert.equal(keptProfile.selection.status, 'selected');
  await adapter.identify(); assert.equal(aiCalls, 2);
});

test('v2 的顶层不可解析/深校验失败、stale 与 index CAS 409 均不升级或清空旧列表', async () => {
  const state = { characterId: 'role-a' }; const liveContext = () => ({ ...context(), characterId: state.characterId }); const client = fakeClient(); let mode = 'ready'; let release;
  const valid = { confirmed: [{ name: '旧人物', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] };
  const adapter = createCRegistryAdapter({ client, contextProvider: liveContext, routeSource: route, generateTask: async () => {
    if (mode === 'schema') return { jsonData: { assistantText: '没有任何人物分类' } };
    if (mode === 'deep') return { ...valid, confirmed: [{ ...valid.confirmed[0], sourceAnchor: '来源中不存在' }] };
    if (mode === 'stale') await new Promise(resolve => { release = resolve; });
    return valid;
  } });
  const first = await adapter.identify(); const identityId = first.index.confirmed[0].identityId; const key = `chat-${id}/people-index`; const record = client.records.get(key); record.data.contractVersion = 2;
  const unchanged = () => { assert.equal(record.data.contractVersion, 2); assert.equal(record.data.confirmed.length, 1); assert.equal(record.data.confirmed[0].identityId, identityId); };
  mode = 'schema'; await assert.rejects(() => adapter.identify(), /结构无效/); unchanged();
  mode = 'deep'; await assert.rejects(() => adapter.identify(), /无可用人物/); unchanged();
  mode = 'stale'; const pending = adapter.identify(); await waitUntil(() => typeof release === 'function'); state.characterId = 'role-b'; release(); assert.equal((await pending).status, 'stale'); unchanged(); state.characterId = 'role-a';
  mode = 'ready'; const originalPut = client.put; let raced = false; client.put = async (collection, itemKey, data, revision) => {
    if (!raced && collection === `chat-${id}` && itemKey === 'people-index' && data.status === 'preparing') { raced = true; record.revision += 1; record.data = structuredClone(data); throw Object.assign(new Error('409'), { status: 409 }); }
    return originalPut(collection, itemKey, data, revision);
  };
  assert.equal((await adapter.identify()).status, 'conflict'); unchanged();
});

test('v2 升级在 profile 中途失败时旧列表仍是权威，恢复完成前不写 v3', async () => {
  const source = { collectAnalysisSources: async () => ({ greeting: { swipeId: 0, fingerprint: 'sha256:' + '6'.repeat(64), content: '旧人物；新增人物' }, worldInfoEntries: [] }) };
  const binding = (name, sourceAnchor) => ({ name, sourceAnchor, primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] });
  const client = fakeClient(); let upgraded = false; let aiCalls = 0;
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: source, generateTask: async () => { aiCalls += 1; return { confirmed: upgraded ? [binding('旧人物', '旧人物'), binding('新增人物', '新增人物')] : [binding('旧人物', '旧人物')], candidate: [], discarded: [] }; } });
  const first = await adapter.identify(); const oldIdentity = first.index.confirmed[0].identityId; const indexRecord = client.records.get(`chat-${id}/people-index`); indexRecord.data.contractVersion = 2; const writesBeforeUpgrade = client.calls.filter(call => call[0] === 'put' && call[1] === `chat-${id}`).length; upgraded = true;
  const originalPut = client.put; let failProfile = true; client.put = async (collection, key, data, revision) => {
    if (failProfile && collection === `chat-${id}-people` && key !== oldIdentity) { failProfile = false; throw Object.assign(new Error('profile write failed'), { status: 500 }); }
    return originalPut(collection, key, data, revision);
  };
  await assert.rejects(() => adapter.identify(), /profile write failed/);
  const failedRecord = client.records.get(`chat-${id}/people-index`);
  assert.equal(failedRecord.data.status, 'preparing'); assert.equal(failedRecord.data.contractVersion, 2); assert.equal(failedRecord.data.confirmed.length, 1); assert.equal(failedRecord.data.confirmed[0].identityId, oldIdentity);
  assert.equal((await adapter.getPeople()).confirmed[0].identityId, oldIdentity);
  const indexWritesBeforeRecovery = client.calls.filter(call => call[0] === 'put' && call[1] === `chat-${id}`).slice(writesBeforeUpgrade).map(call => call[3]);
  assert.equal(indexWritesBeforeRecovery.some(data => data.contractVersion === 3), false);
  const recovered = await adapter.identify(); assert.equal(recovered.index.contractVersion, 3); assert.equal(recovered.index.confirmed.length, 2); assert.equal(aiCalls, 2);
});

test('三分类 jsonData 中虚构次要 sourceRef 均被丢弃且绝不落盘', async () => {
  const realRef = { kind: 'greeting', locator: 'greeting:0:0' }, inventedRef = { kind: 'worldbook', locator: '不存在:999' };
  const oldAnswer = { confirmed: [{ name: '旧人物', sourceAnchor: '重要人物', primarySourceRef: realRef, sourceRefs: [realRef] }], candidate: [], discarded: [] };
  for (const category of ['confirmed', 'candidate', 'discarded']) {
    const client = fakeClient(); let invalid = false;
    const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => invalid
      ? { jsonData: { confirmed: [], candidate: [], discarded: [], [category]: [{ name: `${category}人物`, sourceAnchor: '重要人物', primarySourceRef: realRef, sourceRefs: [realRef, inventedRef] }] } }
      : oldAnswer });
    await adapter.identify(); const indexKey = `chat-${id}/people-index`;
    client.records.get(indexKey).data.contractVersion = 2; invalid = true;
    const result = await adapter.identify();
    assert.equal(result.index.contractVersion, 3); assert.ok(result.warnings.some(item => item.code === 'NORMALIZATION_UNKNOWN_REF_DROPPED'));
    const stored = client.records.get(indexKey); assert.equal(validateRegistryIndex(stored, id), true);
    assert.equal(JSON.stringify(stored.data).includes('不存在:999'), false);
  }
});

test('选择/取消、改名、搁置、AI 不复活与恢复完整保留 identity，恢复为 unselected', async () => {
  const client = fakeClient(); let revision = 1; let calls = 0;
  const changingRoute = { collectAnalysisSources: async () => ({ greeting: { swipeId: 0, fingerprint: `sha256:${String(revision).repeat(64)}`, content: `人物甲 v${revision}` }, worldInfoEntries: [] }) };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: changingRoute, generateTask: async () => { calls += 1; return { confirmed: [{ name: '人物甲', sourceAnchor: '人物甲', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] }; } });
  const first = await adapter.identify(), identity = first.index.confirmed[0].identityId;
  await adapter.select({ identityId: identity }); assert.equal((await adapter.getPeople()).confirmed[0].selection.status, 'selected');
  await adapter.unselect({ identityId: identity }); assert.equal((await adapter.getPeople()).confirmed[0].selection.status, 'unselected');
  await adapter.editDisplayName({ identityId: identity, displayName: '用户命名' }); await adapter.select({ identityId: identity }); await adapter.shelve({ identityId: identity });
  const shelved = await adapter.getPeople(); assert.equal(shelved.confirmed.length, 0); assert.equal(shelved.shelved[0].identityId, identity); assert.equal(shelved.shelved[0].displayName, '用户命名');
  revision = 2; const rescanned = await adapter.identify(); assert.equal(calls, 2); assert.equal(rescanned.index.confirmed.length, 0); assert.equal(rescanned.index.shelved[0].identityId, identity);
  await adapter.restore({ identityId: identity }); const restored = await adapter.getPeople(); assert.equal(restored.confirmed[0].identityId, identity); assert.equal(restored.confirmed[0].displayName, '用户命名'); assert.equal(restored.confirmed[0].selection.status, 'unselected');
  const profile = await client.get(`chat-${id}-people`, identity); assert.ok(profile.data.userFacts.some(item => item.provenance === 'user.displayName' && item.value === '用户命名'));
});

test('旧 tombstones/deleted 动态迁移为可恢复搁置且不丢档案', async () => {
  const client = fakeClient(), adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => ({ confirmed: [{ name: '旧人物', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] }) });
  const first = await adapter.identify(), identity = first.index.confirmed[0].identityId, indexRecord = client.records.get(`chat-${id}/people-index`), profileRecord = client.records.get(`chat-${id}-people/${identity}`);
  const legacy = { ...indexRecord.data.confirmed[0], lifecycle: 'deleted' }; delete legacy.selection;
  indexRecord.data.confirmed = []; indexRecord.data.tombstones = [legacy]; delete indexRecord.data.shelved;
  profileRecord.data.lifecycle = 'deleted';
  assert.equal(validateRegistryIndex(indexRecord, id), true);
  const migrated = await adapter.identify(); assert.equal(migrated.index.shelved[0].identityId, identity); assert.equal(migrated.index.tombstones.length, 0);
  assert.equal(client.records.get(`chat-${id}-people/${identity}`).data.lifecycle, 'shelved');
  await adapter.restore({ identityId: identity }); assert.equal((await adapter.getPeople()).confirmed[0].identityId, identity);
});

test('AI 重识别保留已搁置人物，同时同一来源新增重要人物可进入主列表', async () => {
  const client = fakeClient(); let revision = 1;
  const changingRoute = { collectAnalysisSources: async () => ({ greeting: { swipeId: 0, fingerprint: `sha256:${String(revision).repeat(64)}`, content: revision === 1 ? '人物甲' : '人物甲；人物乙' }, worldInfoEntries: [] }) };
  const binding = (name, anchor) => ({ name, sourceAnchor: anchor, primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] });
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: changingRoute, generateTask: async () => ({ confirmed: revision === 1 ? [binding('甲', '人物甲')] : [binding('甲', '人物甲'), binding('乙', '人物乙')], candidate: [], discarded: [] }) });
  const first = await adapter.identify(), shelvedId = first.index.confirmed[0].identityId; await adapter.shelve({ identityId: shelvedId }); revision = 2;
  const changed = await adapter.identify(); assert.equal(changed.index.shelved[0].identityId, shelvedId); assert.equal(changed.index.confirmed.length, 1); assert.equal(changed.index.confirmed[0].displayName, '乙');
});

test('改名 saga：profile 成功后 index 完成 CAS 409，重载 adapter 可幂等恢复一致状态', async () => {
  const client = fakeClient(); const generateTask = async () => ({ confirmed: [{ name: '原名', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] });
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask });
  const first = await adapter.identify(), identity = first.index.confirmed[0].identityId, originalPut = client.put; client.records.get(`chat-${id}/people-index`).data.contractVersion = 2; let finalConflict = true;
  client.put = async (collection, key, data, revision) => {
    const current = client.records.get(`${collection}/${key}`);
    if (finalConflict && collection === `chat-${id}` && current?.data?.status === 'renaming' && data.status === 'ready' && data.pendingRename === undefined) {
      finalConflict = false; current.revision += 1; throw Object.assign(new Error('409'), { status: 409 });
    }
    return originalPut(collection, key, data, revision);
  };
  const interrupted = await adapter.editDisplayName({ identityId: identity, displayName: '新名' }); assert.deepEqual(interrupted, { status: 'conflict', recoverable: true, pending: 'rename' });
  assert.equal((await adapter.getPeople()).status, 'stale'); assert.equal(client.records.get(`chat-${id}/people-index`).data.contractVersion, 2); assert.equal(client.records.get(`chat-${id}/people-index`).data.confirmed[0].displayName, '原名'); assert.equal(client.records.get(`chat-${id}-people/${identity}`).data.displayName, '新名');
  const reloaded = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask }); const recovered = await reloaded.identify();
  assert.ok(client.calls.some(call => call[0] === 'put' && call[1] === `chat-${id}` && call[3]?.status === 'ready' && call[3]?.contractVersion === 2 && call[3]?.confirmed?.[0]?.displayName === '新名'));
  assert.equal(recovered.status, 'ready'); assert.equal(recovered.index.contractVersion, 3); assert.equal(recovered.index.confirmed[0].displayName, '新名'); const profile = client.records.get(`chat-${id}-people/${identity}`).data;
  assert.equal(profile.displayName, '新名'); assert.deepEqual(profile.userFacts.filter(item => item.provenance === 'user.displayName'), [{ value: '新名', provenance: 'user.displayName', locked: true }]);
});

test('改名 saga：profile 成功后 Persona 切换留下持久 intent，重载后同操作可恢复', async () => {
  const state = { personaId: 'persona-a' }, liveContext = () => ({ ...context(), personaId: state.personaId }); const client = fakeClient();
  const generateTask = async () => ({ confirmed: [{ name: '原名', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] });
  const adapter = createCRegistryAdapter({ client, contextProvider: liveContext, routeSource: route, generateTask }); const first = await adapter.identify(), identity = first.index.confirmed[0].identityId, originalPut = client.put; let switched = false;
  client.put = async (collection, key, data, revision) => { const value = await originalPut(collection, key, data, revision); if (!switched && collection.endsWith('-people') && data.displayName === '新名') { switched = true; state.personaId = 'persona-b'; } return value; };
  await assert.rejects(() => adapter.editDisplayName({ identityId: identity, displayName: '新名' }), error => error.stale === true);
  assert.equal(client.records.get(`chat-${id}/people-index`).data.status, 'renaming'); assert.equal(client.records.get(`chat-${id}-people/${identity}`).data.displayName, '新名');
  const reloaded = createCRegistryAdapter({ client, contextProvider: liveContext, routeSource: route, generateTask }); assert.equal((await reloaded.getPeople()).status, 'renaming');
  const recovered = await reloaded.editDisplayName({ identityId: identity, displayName: '新名' }); assert.equal(recovered.status, 'ready');
  const index = client.records.get(`chat-${id}/people-index`).data, profile = client.records.get(`chat-${id}-people/${identity}`).data;
  assert.equal(index.status, 'ready'); assert.equal(index.pendingRename, undefined); assert.equal(index.confirmed[0].displayName, '新名'); assert.equal(profile.displayName, '新名'); assert.equal(profile.userFacts.filter(item => item.provenance === 'user.displayName' && item.value === '新名').length, 1);
});

test('改名 saga：profile CAS winner 为异值时不覆盖，重载仍返回明确 recoverable 冲突', async () => {
  const client = fakeClient(); const generateTask = async () => ({ confirmed: [{ name: '原名', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] });
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask }); const first = await adapter.identify(), identity = first.index.confirmed[0].identityId, originalPut = client.put; client.records.get(`chat-${id}/people-index`).data.contractVersion = 2; let conflict = true;
  client.put = async (collection, key, data, revision) => {
    if (conflict && collection.endsWith('-people') && data.displayName === '目标名') {
      conflict = false; const winner = client.records.get(`${collection}/${key}`); winner.revision += 1; winner.data = { ...winner.data, displayName: '外部异值', userFacts: [{ value: '外部异值', provenance: 'user.displayName', locked: true }] }; throw Object.assign(new Error('409'), { status: 409 });
    }
    return originalPut(collection, key, data, revision);
  };
  assert.deepEqual(await adapter.editDisplayName({ identityId: identity, displayName: '目标名' }), { status: 'conflict', recoverable: true, pending: 'rename' });
  assert.equal(client.records.get(`chat-${id}/people-index`).data.status, 'renaming'); assert.equal(client.records.get(`chat-${id}/people-index`).data.contractVersion, 2); assert.equal(client.records.get(`chat-${id}-people/${identity}`).data.displayName, '外部异值');
  const putsBefore = client.calls.filter(call => call[0] === 'put').length, reloaded = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask });
  assert.deepEqual(await reloaded.identify(), { status: 'conflict', recoverable: true, pending: 'rename' }); assert.equal(client.records.get(`chat-${id}-people/${identity}`).data.displayName, '外部异值'); assert.equal(client.calls.filter(call => call[0] === 'put').length, putsBefore);
});

test('改名 saga：final index 409 的 ready 外部异值 winner 持久 fail-closed，重载读与识别均零写冲突', async () => {
  const client = fakeClient(); const generateTask = async () => ({ confirmed: [{ name: '原名', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] });
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask }); const first = await adapter.identify(), identity = first.index.confirmed[0].identityId, originalPut = client.put; client.records.get(`chat-${id}/people-index`).data.contractVersion = 2; let conflict = true;
  client.put = async (collection, key, data, revision) => {
    const winner = client.records.get(`${collection}/${key}`);
    if (conflict && collection === `chat-${id}` && winner?.data?.status === 'renaming' && data.status === 'ready' && data.pendingRename === undefined) {
      conflict = false; winner.revision += 1; winner.data = { ...winner.data, status: 'ready', pendingRename: undefined, confirmed: winner.data.confirmed.map(item => item.identityId === identity ? { ...item, displayName: '外部 index 异值' } : item) }; throw Object.assign(new Error('409'), { status: 409 });
    }
    return originalPut(collection, key, data, revision);
  };
  assert.deepEqual(await adapter.editDisplayName({ identityId: identity, displayName: '目标名' }), { status: 'conflict', recoverable: true, pending: 'rename' });
  const indexBefore = structuredClone(client.records.get(`chat-${id}/people-index`).data), profileBefore = structuredClone(client.records.get(`chat-${id}-people/${identity}`).data), putsBefore = client.calls.filter(call => call[0] === 'put').length;
  assert.equal(indexBefore.status, 'ready'); assert.equal(indexBefore.contractVersion, 2); assert.equal(indexBefore.pendingRename, undefined); assert.equal(indexBefore.confirmed[0].displayName, '外部 index 异值'); assert.equal(profileBefore.displayName, '目标名');
  const reloaded = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask }); const read = await reloaded.getPeople();
  assert.equal(read.status, 'conflict'); assert.equal(read.recoverable, true); assert.equal(read.pending, 'rename');
  assert.deepEqual(await reloaded.identify(), { status: 'conflict', recoverable: true, pending: 'rename' }); assert.equal(client.calls.filter(call => call[0] === 'put').length, putsBefore);
  assert.deepEqual(client.records.get(`chat-${id}/people-index`).data, indexBefore); assert.deepEqual(client.records.get(`chat-${id}-people/${identity}`).data, profileBefore);
});

test('无 pendingRename 的任意 ready 名称分裂持续 fail-closed，getPeople/identify 零写保留双方', async () => {
  const client = fakeClient(); const generateTask = async () => ({ confirmed: [{ name: '原名', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] });
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask }); const first = await adapter.identify(), identity = first.index.confirmed[0].identityId;
  const indexRecord = client.records.get(`chat-${id}/people-index`); indexRecord.revision += 1; indexRecord.data.confirmed[0].displayName = '无意图 index 异值';
  const indexBefore = structuredClone(indexRecord.data), profileBefore = structuredClone(client.records.get(`chat-${id}-people/${identity}`).data), putsBefore = client.calls.filter(call => call[0] === 'put').length;
  const reloaded = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask }); assert.equal((await reloaded.getPeople()).status, 'conflict');
  assert.deepEqual(await reloaded.identify(), { status: 'conflict', recoverable: true, pending: 'rename' }); assert.equal(client.calls.filter(call => call[0] === 'put').length, putsBefore);
  assert.deepEqual(indexRecord.data, indexBefore); assert.deepEqual(client.records.get(`chat-${id}-people/${identity}`).data, profileBefore);
});

test('选择 CAS 冲突与 Persona 切换均不产生半状态', async () => {
  const state = { personaId: 'persona-a' }, liveContext = () => ({ ...context(), personaId: state.personaId });
  const client = fakeClient(), adapter = createCRegistryAdapter({ client, contextProvider: liveContext, routeSource: route, generateTask: async () => ({ confirmed: [{ name: '确认者', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] }], candidate: [], discarded: [] }) });
  const first = await adapter.identify(), identity = first.index.confirmed[0].identityId, originalPut = client.put; let conflictOnce = true;
  client.put = async (collection, key, data, revision) => {
    if (conflictOnce && collection === `chat-${id}` && data.confirmed?.[0]?.selection?.status === 'selected') { conflictOnce = false; const record = client.records.get(`${collection}/${key}`); record.revision += 1; throw Object.assign(new Error('409'), { status: 409 }); }
    return originalPut(collection, key, data, revision);
  };
  assert.equal((await adapter.select({ identityId: identity })).status, 'conflict'); assert.equal((await adapter.getPeople()).confirmed[0].selection.status, 'unselected');
  const originalGet = client.get; let release; client.get = async (collection, key) => { if (collection === `chat-${id}` && key === 'people-index') await new Promise(resolve => { release = resolve; }); return originalGet(collection, key); };
  const beforePuts = client.calls.filter(call => call[0] === 'put').length, pending = adapter.select({ identityId: identity }); await waitUntil(() => typeof release === 'function'); state.personaId = 'persona-b'; release();
  await assert.rejects(() => pending, error => error.stale === true); assert.equal(client.calls.filter(call => call[0] === 'put').length, beforePuts);
});

test('生产索引深校验拒绝 candidate/discarded 空白锚点', () => {
  const envelope = data => ({ schemaVersion: 1, revision: 1, generationId: id, createdAt: 'x', updatedAt: 'x', data });
  const base = { schemaVersion: 1, kind: 'people-index', chatId: id, sourceFingerprint: 'sha256:x', status: 'ready', confirmed: [], candidate: [], discarded: [], tombstones: [] };
  const candidate = { name: '候选', sourceAnchor: '   ', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }], sourceKey: 'greeting:greeting:0:0:' };
  assert.equal(validateRegistryIndex(envelope({ ...base, candidate: [candidate] }), id), false);
  const discarded = { ...candidate, lifecycle: 'discarded' };
  assert.equal(validateRegistryIndex(envelope({ ...base, discarded: [discarded] }), id), false);
});

test('formal-aware 冻结路线生产 seam：动态条目、后续楼不进 prompt，来源变化 warning 但仍生成', async () => {
  const frozen = { world: '清夜星辉', uid: '1', content: '冻结人物：雎酒' };
  const dynamic = { world: '后续动态世界书', uid: '9', content: '动态人物：不应进入 prompt' };
  const context = { chat: [{ mes: '欢迎，雎酒', swipe_id: 0 }, { mes: '第1楼不应进入来源', is_user: false }], simulateWorldInfoActivation: async () => ({ activatedEntries: [frozen, dynamic] }) };
  const routeSource = createRouteSourceAdapter({ contextProvider: () => context });
  const initial = await routeSource.collect();
  const route = { ...initial, worldInfoEntries: initial.worldInfoEntries.filter(entry => entry.world === frozen.world) };
  context.simulateWorldInfoActivation = async ({ coreChat }) => { assert.equal(coreChat.length, 1); return { activatedEntries: [frozen, dynamic] }; };
  let formalReads = 0; let aiCalls = 0; const client = fakeClient();
  const formal = { getFormalState: async () => { formalReads += 1; return { status: 'route_ready', route }; } };
  const generateTask = async ({ taskMessages }) => { aiCalls += 1; const prompt = taskMessages[0].content; assert.match(prompt, /冻结人物：(雎酒|已变化)/); assert.doesNotMatch(prompt, /动态人物|第1楼/); const anchor = prompt.includes('已变化') ? '冻结人物：已变化' : '冻结人物：雎酒'; return { confirmed: [{ name: '雎酒', sourceAnchor: anchor, primarySourceRef: { kind: 'worldbook', locator: '清夜星辉:1' }, sourceRefs: [{ kind: 'worldbook', locator: '清夜星辉:1' }]}], candidate: [], discarded: [] }; };
  const adapter = createCRegistryAdapter({ client, formal, contextProvider: () => ({ chatMetadata: { qianqianjie: { chatId: id } }, chat: context.chat }), routeSource, generateTask });
  const first = await adapter.identify(); assert.equal(first.status, 'ready'); assert.equal(formalReads, 1); assert.equal(aiCalls, 1);
  const putsAfterFirst = client.calls.filter(call => call[0] === 'put').length;
  const recovered = await adapter.identify(); assert.equal(recovered.status, 'ready'); assert.equal(aiCalls, 1); assert.equal(formalReads, 2);
  assert.equal(client.calls.filter(call => call[0] === 'put').length >= putsAfterFirst, true);
  const putsBeforeStale = client.calls.filter(call => call[0] === 'put').length;
  context.simulateWorldInfoActivation = async ({ coreChat }) => { assert.equal(coreChat.length, 1); return { activatedEntries: [{ ...frozen, content: '冻结人物：已变化' }, dynamic] }; };
  const changed = await adapter.identify(); assert.equal(changed.status, 'ready'); assert.equal(aiCalls, 2); assert.ok(Array.isArray(changed.warnings)); assert.equal(client.calls.filter(call => call[0] === 'put').length > putsBeforeStale, true);
  context.simulateWorldInfoActivation = async ({ coreChat }) => { assert.equal(coreChat.length, 1); return { activatedEntries: [frozen, dynamic] }; };
  context.chat[0] = { ...context.chat[0], mes: '欢迎，已变化' };
  const greetingChanged = await adapter.identify(); assert.equal(greetingChanged.status, 'ready'); assert.equal(aiCalls, 3); assert.ok(greetingChanged.warnings.some(item => item.code === 'GREETING_VERSION_CHANGED'));
});

test('来源变化发生在 AI 前：已捕获快照继续识别且只扫描一次', async () => {
  const content = '冻结人物：雎酒'; const route = { state: 'ready', greeting: { floor: 0, swipeId: 0, fingerprint: 'sha256:' + '0'.repeat(64), content: '欢迎' }, worldInfoEntries: [{ world: '清夜星辉', uid: '1', fingerprint: 'sha256:' + '0'.repeat(64) }] };
  const context = { chat: [{ mes: '欢迎' }], chatMetadata: { qianqianjie: { chatId: id } } }; let scans = 0;
  context.simulateWorldInfoActivation = async () => { scans += 1; return { activatedEntries: [{ world: '清夜星辉', uid: '1', content }] }; };
  const routeSource = createRouteSourceAdapter({ contextProvider: () => context }); const client = fakeClient();
  const adapter = createCRegistryAdapter({ client, formal: { getFormalState: async () => ({ status: 'route_ready', route }) }, contextProvider: () => context, routeSource, generateTask: async () => ({ confirmed: [], candidate: [], discarded: [] }) });
  const result = await adapter.identify(); assert.equal(result.status, 'ready'); assert.equal(scans, 1); assert.equal(client.calls.filter(call => call[0] === 'put').length > 0, true);
});

test('C Registry 阶段状态按来源、AI、写入顺序发出', async () => {
  const phases = []; const client = fakeClient();
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => ({ confirmed: [], candidate: [], discarded: [] }) });
  const result = await adapter.identify({ onPhase: phase => phases.push(phase) });
  assert.equal(result.status, 'ready'); assert.deepEqual(phases, ['reading_sources', 'waiting_ai', 'saving_people']);
});
test('C Registry 归一化稳定跳过重复 sourceKey，内部索引仍通过严格校验', async () => {
  const client = fakeClient(); let puts = 0; const original = client.put; client.put = async (...args) => { puts++; return original(...args); };
  const duplicate = { name: '重复', sourceAnchor: '重要人物', primarySourceRef: { kind: 'greeting', locator: 'greeting:0:0' }, sourceRefs: [{ kind: 'greeting', locator: 'greeting:0:0' }] };
  const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => ({ confirmed: [duplicate, { ...duplicate }], candidate: [], discarded: [] }) });
  const result = await adapter.identify(); assert.equal(result.index.confirmed.length, 1); assert.ok(result.warnings.some(item => item.code === 'NORMALIZATION_DUPLICATE_SKIPPED')); assert.ok(puts > 0); assert.equal(validateRegistryIndex(client.records.get(`chat-${id}/people-index`), id), true);
});

test('formal-aware 真实 batch→generateTask seam：不调用 scanner 且额外条目不入 prompt', async () => {
  let scans = 0; const frozen = '冻结人物：甲'; const context = { chat: [{ mes: '开场' }, { mes: '第1楼禁止' }], chatMetadata: { qianqianjie: { chatId: id } }, loadWorldInfoBatch: async () => new Map([['书', { entries: { '1': { content: frozen }, '9': { content: '额外人物' } } }]]), simulateWorldInfoActivation: async () => { scans++; return { activatedEntries: [] }; } };
  const routeSource = createRouteSourceAdapter({ contextProvider: () => context }); const route = { state: 'ready', greeting: { floor: 0, swipeId: 0, fingerprint: `sha256:${await sha256('floor=0\nswipe=0\ncontent=开场')}`, content: '开场' }, worldInfoEntries: [{ world: '书', uid: '1', fingerprint: `sha256:${await sha256(frozen)}` }] }; let ai = 0;
  const adapter = createCRegistryAdapter({ client: fakeClient(), formal: { getFormalState: async () => ({ status: 'route_ready', route }) }, contextProvider: () => context, routeSource, generateTask: async ({ taskMessages }) => { ai++; assert.match(taskMessages[0].content, /冻结人物：甲/); assert.doesNotMatch(taskMessages[0].content, /额外人物|第1楼/); return { confirmed: [], candidate: [], discarded: [] }; } });
  assert.equal((await adapter.identify()).status, 'ready'); assert.equal(ai, 1); assert.equal(scans, 0);
});

function formalAwareWorldbookScenario({ initialContent, changedContent, generateResults }) {
  let batchContent = initialContent;
  let scannerCalls = 0;
  const context = {
    chat: [{ mes: '开场路线锚', swipe_id: 0 }, { mes: '第1楼绝不进入来源' }],
    chatMetadata: { qianqianjie: { chatId: id } },
    simulateWorldInfoActivation: async ({ coreChat }) => {
      scannerCalls += 1;
      assert.equal(coreChat.length, 1);
      return { activatedEntries: [{ world: '人物书', uid: '1', content: batchContent === initialContent ? initialContent : changedContent }] };
    },
    loadWorldInfoBatch: async worlds => {
      assert.deepEqual(worlds, ['人物书']);
      return new Map([['人物书', { entries: { '1': { uid: '1', content: batchContent }, '9': { uid: '9', content: '不在冻结清单的额外条目' } } }]]);
    },
  };
  const routeSource = createRouteSourceAdapter({ contextProvider: () => context });
  const formalRoute = routeSource.collect();
  const client = fakeClient();
  let aiCalls = 0;
  const adapter = createCRegistryAdapter({
    client,
    formal: { getFormalState: async () => ({ status: 'route_ready', route: await formalRoute }) },
    contextProvider: () => context,
    routeSource,
    generateTask: async ({ taskMessages }) => {
      aiCalls += 1;
      assert.doesNotMatch(taskMessages[0].content, /第1楼|不在冻结清单/);
      return generateResults[aiCalls - 1](taskMessages[0].content);
    },
  });
  return { adapter, client, context, setBatchContent: value => { batchContent = value; }, get scannerCalls() { return scannerCalls; }, get aiCalls() { return aiCalls; } };
}

const worldRef = { kind: 'worldbook', locator: '人物书:1' };
const worldBinding = (name, anchor) => ({ name, sourceAnchor: anchor, primarySourceRef: worldRef, sourceRefs: [worldRef] });

test('真实 generateTask 外壳宽容解包，顶层不可解析时仅重试一次且零 PUT', async () => {
  const payload = { confirmed: [], candidate: [], discarded: [] };
  const cases = [
    { response: { jsonData: payload, assistantText: '诊断文本' }, ok: true },
    { response: { assistantText: '没有结构化结果' }, ok: false },
    { response: { jsonData: null, assistantText: '无效结果' }, ok: false },
    { response: { confirmed: [], candidate: [], discarded: [], extra: true }, ok: true },
  ];
  for (const item of cases) {
    const client = fakeClient(); let calls = 0;
    const adapter = createCRegistryAdapter({ client, contextProvider: context, routeSource: route, generateTask: async () => { calls += 1; return item.response; } });
    if (item.ok) assert.equal((await adapter.identify()).status, 'ready');
    else await assert.rejects(() => adapter.identify(), /人物识别失败|识别结果结构无效/);
    assert.equal(client.calls.filter(call => call[0] === 'put').length > 0, item.ok);
    assert.equal(calls, item.ok ? 1 : 2);
  }
});

test('真实生产 seam：同 primary 混合 exact/改锚保留旧甲乙 UUID，改锚仅 candidate 并 warning', async () => {
  const scenario = formalAwareWorldbookScenario({
    initialContent: '甲锚点；乙锚点',
    changedContent: '甲锚点；乙改锚',
    generateResults: [
      () => ({ confirmed: [worldBinding('甲', '甲锚点'), worldBinding('乙', '乙锚点')], candidate: [], discarded: [] }),
      () => ({ confirmed: [worldBinding('甲', '甲锚点'), worldBinding('乙新名', '乙改锚')], candidate: [], discarded: [] }),
    ],
  });
  const first = await scenario.adapter.identify();
  const old = new Map(first.index.confirmed.map(item => [item.sourceAnchor, item.identityId]));
  scenario.setBatchContent('甲锚点；乙改锚');
  const changed = await scenario.adapter.identify();
  assert.equal(changed.status, 'ready');
  assert.equal(changed.index.confirmed.length, 2);
  assert.deepEqual(new Map(changed.index.confirmed.map(item => [item.sourceAnchor, item.identityId])), old);
  assert.equal(changed.index.candidate.length, 1);
  assert.equal(changed.index.candidate[0].sourceAnchor, '乙改锚');
  assert.ok(changed.warnings.some(item => item.code === 'WORLDBOOK_VERSION_CHANGED'));
  assert.equal([...scenario.client.records.keys()].filter(key => key.startsWith(`chat-${id}-people/`)).length, 2);
  assert.equal([...scenario.client.records.keys()].filter(key => key.startsWith(`chat-${id}-people/`)).some(key => !changed.index.confirmed.some(item => key.endsWith(item.identityId))), false);
  assert.equal(validateRegistryIndex(scenario.client.records.get(`chat-${id}/people-index`), id), true);
  assert.equal(scenario.scannerCalls, 2);
});

test('真实生产 seam：全部 anchor 改变时旧 confirmed/UUID 保留，新结果进入 candidate 且索引有效', async () => {
  const scenario = formalAwareWorldbookScenario({
    initialContent: '旧甲锚；旧乙锚',
    changedContent: '新甲锚；新乙锚',
    generateResults: [
      () => ({ confirmed: [worldBinding('甲', '旧甲锚'), worldBinding('乙', '旧乙锚')], candidate: [], discarded: [] }),
      () => ({ confirmed: [worldBinding('甲新', '新甲锚'), worldBinding('乙新', '新乙锚')], candidate: [], discarded: [] }),
    ],
  });
  const first = await scenario.adapter.identify();
  const oldIds = new Set(first.index.confirmed.map(item => item.identityId));
  scenario.setBatchContent('新甲锚；新乙锚');
  const changed = await scenario.adapter.identify();
  assert.equal(changed.status, 'ready');
  assert.deepEqual(new Set(changed.index.confirmed.map(item => item.identityId)), oldIds);
  assert.deepEqual(changed.index.confirmed.map(item => item.sourceAnchor).sort(), ['旧乙锚', '旧甲锚'].sort());
  assert.deepEqual(changed.index.candidate.map(item => item.sourceAnchor).sort(), ['新乙锚', '新甲锚'].sort());
  assert.equal(changed.index.candidate.length, 2);
  assert.ok(changed.warnings.some(item => item.code === 'WORLDBOOK_VERSION_CHANGED'));
  assert.equal(validateRegistryIndex(scenario.client.records.get(`chat-${id}/people-index`), id), true);
});

test('真实生产 seam：唯一已搁置人物 anchor 改变不复活，confirmed 为零且档案保持 shelved', async () => {
  const scenario = formalAwareWorldbookScenario({
    initialContent: '唯一旧锚',
    changedContent: '唯一新锚',
    generateResults: [
      () => ({ confirmed: [worldBinding('唯一人物', '唯一旧锚')], candidate: [], discarded: [] }),
      () => ({ confirmed: [worldBinding('唯一人物新锚', '唯一新锚')], candidate: [], discarded: [] }),
    ],
  });
  const first = await scenario.adapter.identify();
  const identity = first.index.confirmed[0].identityId;
  await scenario.adapter.shelve({ identityId: identity });
  scenario.setBatchContent('唯一新锚');
  const changed = await scenario.adapter.identify();
  assert.equal(changed.status, 'ready');
  assert.equal(changed.index.confirmed.length, 0);
  assert.equal(changed.index.shelved.filter(item => item.identityId === identity).length, 1);
  assert.equal(scenario.client.records.get(`chat-${id}-people/${identity}`).data.lifecycle, 'shelved');
  assert.equal(changed.index.candidate.some(item => item.sourceAnchor === '唯一新锚'), false);
  assert.ok(changed.warnings.some(item => item.code === 'WORLDBOOK_VERSION_CHANGED'));
  assert.equal(validateRegistryIndex(scenario.client.records.get(`chat-${id}/people-index`), id), true);
});

test('真实生产 seam：混合 ambiguity 场景不增加 profile 且不存在孤儿档案', async () => {
  const scenario = formalAwareWorldbookScenario({
    initialContent: '甲旧；乙旧',
    changedContent: '甲新；乙新',
    generateResults: [
      () => ({ confirmed: [worldBinding('甲', '甲旧'), worldBinding('乙', '乙旧')], candidate: [], discarded: [] }),
      () => ({ confirmed: [worldBinding('甲新', '甲新'), worldBinding('乙新', '乙新')], candidate: [], discarded: [] }),
    ],
  });
  const first = await scenario.adapter.identify();
  const profileKeysBefore = [...scenario.client.records.keys()].filter(key => key.startsWith(`chat-${id}-people/`));
  scenario.setBatchContent('甲新；乙新');
  const changed = await scenario.adapter.identify();
  const profileKeysAfter = [...scenario.client.records.keys()].filter(key => key.startsWith(`chat-${id}-people/`));
  assert.equal(changed.status, 'ready');
  assert.equal(profileKeysAfter.length, profileKeysBefore.length);
  assert.equal(changed.index.confirmed.length, first.index.confirmed.length);
  assert.equal(changed.index.candidate.length, 2);
  assert.equal(profileKeysAfter.some(key => !changed.index.confirmed.some(item => key.endsWith(item.identityId))), false);
  assert.equal(validateRegistryIndex(scenario.client.records.get(`chat-${id}/people-index`), id), true);
});

test('formal 能力存在但路线不可用时严格 fail-closed，不回退动态来源', async () => {
  let formalReads = 0; let frozenReads = 0; let dynamicReads = 0; let aiCalls = 0; const client = fakeClient();
  const routeSource = { collectFrozenAnalysisSources: async () => { frozenReads += 1; return { status: 'route_unavailable' }; }, collectAnalysisSources: async () => { dynamicReads += 1; return await route.collectAnalysisSources(); } };
  const adapter = createCRegistryAdapter({ client, formal: { getFormalState: async () => { formalReads += 1; return { status: 'route_unavailable' }; } }, contextProvider: context, routeSource, generateTask: async () => { aiCalls += 1; return { confirmed: [], candidate: [], discarded: [] }; } });
  const result = await adapter.identify(); assert.equal(result.status, 'route_unavailable'); assert.equal(formalReads, 1); assert.equal(frozenReads, 0); assert.equal(dynamicReads, 0); assert.equal(aiCalls, 0); assert.equal(client.calls.filter(call => call[0] === 'put').length, 0);
});

test('formal route 存在但 frozen sources 无效时不调用动态扫描或 AI', async () => {
  let dynamicReads = 0; let aiCalls = 0; const client = fakeClient(); const formalRoute = { state: 'ready' };
  const routeSource = { collectFrozenAnalysisSources: async () => ({ status: 'route_unavailable', sources: null }), collectAnalysisSources: async () => { dynamicReads += 1; return await route.collectAnalysisSources(); } };
  const adapter = createCRegistryAdapter({ client, formal: { getFormalState: async () => ({ status: 'route_ready', route: formalRoute }) }, contextProvider: context, routeSource, generateTask: async () => { aiCalls += 1; return { confirmed: [], candidate: [], discarded: [] }; } });
  assert.equal((await adapter.identify()).status, 'route_unavailable'); assert.equal(dynamicReads, 0); assert.equal(aiCalls, 0); assert.equal(client.calls.filter(call => call[0] === 'put').length, 0);
});

for (const status of ['route_unavailable', 'mismatch', 'stale']) test(`formal ${status} 携带旧 route 仍严格 fail-closed`, async () => {
  let frozenReads = 0; let dynamicReads = 0; let aiCalls = 0; const client = fakeClient();
  const routeSource = { collectFrozenAnalysisSources: async () => { frozenReads += 1; return { status: 'ready', sources: { greeting: { swipeId: 0, fingerprint: 'sha256:' + '1'.repeat(64), content: '旧路线' }, worldInfoEntries: [] } }; }, collectAnalysisSources: async () => { dynamicReads += 1; return await route.collectAnalysisSources(); } };
  const adapter = createCRegistryAdapter({ client, formal: { getFormalState: async () => ({ status, route: { state: 'ready' } }) }, contextProvider: context, routeSource, generateTask: async () => { aiCalls += 1; return { confirmed: [], candidate: [], discarded: [] }; } });
  assert.equal((await adapter.identify()).status, status); assert.equal(frozenReads, 0); assert.equal(dynamicReads, 0); assert.equal(aiCalls, 0); assert.equal(client.calls.filter(call => call[0] === 'put').length, 0);
});

const singleCardId = '223e4567-e89b-12d3-a456-426614174001';
const wrongIdentityId = '423e4567-e89b-12d3-a456-426614174003';
const singleRef = field => ({ kind: 'card', locator: `card:hero.png#${field}` });
const greetingRef = { kind: 'greeting', locator: 'greeting:0:0' };
const singleItem = (name, sourceAnchor, primarySourceRef, sourceRefs = [primarySourceRef]) => ({ name, sourceAnchor, primarySourceRef, sourceRefs });

function singleScenario({ cardData = {}, greeting = '开场', worldInfoEntries = [], generateTask, cardType = 'single' } = {}) {
  const client = fakeClient();
  let frozenReads = 0, formalReads = 0;
  const characterData = { name: '作品线路【代号】', ...cardData };
  const host = {
    groupId: null, characterId: 0, chatId: 'host-single-chat', name2: '酒馆回退名', userAvatar: 'persona.png',
    characters: [{ avatar: 'hero.png', name: '角色列表名', data: characterData }],
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: id } },
    chat: [{ mes: greeting, swipe_id: 0 }, { mes: '后续聊天正文绝不进入 single 来源' }],
  };
  const formalState = { status: 'route_ready', cardType, cardId: singleCardId, route: { state: 'ready', greeting: { floor: 0, swipeId: 0, fingerprint: 'sha256:greeting' }, worldInfoEntries: worldInfoEntries.map(item => ({ world: item.world, uid: item.uid, fingerprint: item.fingerprint })) } };
  const frozen = { greeting: { swipeId: 0, fingerprint: 'sha256:greeting', content: greeting }, worldInfoEntries: structuredClone(worldInfoEntries) };
  const adapter = createCRegistryAdapter({
    client,
    formal: { getFormalState: async () => { formalReads += 1; return structuredClone(formalState); } },
    contextProvider: () => host,
    routeSource: { collectFrozenAnalysisSources: async () => { frozenReads += 1; return { status: 'ready', sources: structuredClone(frozen) }; } },
    generateTask,
  });
  return { adapter, client, host, characterData, formalState, frozen, get frozenReads() { return frozenReads; }, get formalReads() { return formalReads; } };
}

test('single 单次 runtimeSnapshot 在 get→identify→final read 复用同一份 formal/卡/冻结来源，下一次运行重新读取', async () => {
  const phases = [];
  const scenario = singleScenario({
    cardData: { description: '本卡唯一主 C 是沈砚。', personality: '沈砚沉静克制。' },
    generateTask: async () => ({ confirmed: [singleItem('沈砚', '沈砚', singleRef('description'))], candidate: [], discarded: [] }),
  });
  const runtimeSnapshot = { formalState: structuredClone(scenario.formalState) };
  assert.equal((await scenario.adapter.getPeople({ runtimeSnapshot })).status, 'uninitialized');
  assert.equal((await scenario.adapter.identify({ runtimeSnapshot, onPhase: phase => phases.push(phase) })).status, 'ready');
  assert.equal((await scenario.adapter.getPeople({ runtimeSnapshot })).status, 'ready');
  assert.equal(scenario.formalReads, 0); assert.equal(scenario.frozenReads, 1);
  assert.deepEqual(phases, ['reading_sources', 'waiting_ai', 'saving_people']);

  const nextRuntimeSnapshot = { formalState: structuredClone(scenario.formalState) };
  assert.equal((await scenario.adapter.getPeople({ runtimeSnapshot: nextRuntimeSnapshot })).status, 'ready');
  assert.equal(scenario.formalReads, 0); assert.equal(scenario.frozenReads, 2);
  assert.notEqual(nextRuntimeSnapshot.prepared, runtimeSnapshot.prepared);
});

test('single-main-v1：作品名仅作弱提示，正文真名成为全新 cardId 已选主槽且配角不顶替、不持久化正文', async () => {
  const cardText = '本卡实际扮演人物是沈砚，别名阿砚；负责与旅人共同推进剧情。';
  let calls = 0; let request;
  const scenario = singleScenario({
    cardData: { description: `<b>${cardText}</b>`, personality: '沈砚性格沉静。' },
    greeting: '跑堂阿福先来传话；后续聊天秘密不应出现。',
    generateTask: async options => {
      calls += 1; request = options;
      return {
        confirmed: [singleItem('沈砚', '沈砚，别名阿砚', singleRef('description'))],
        candidate: [{ name: '阿福', sourceAnchor: '阿福', primarySourceRef: greetingRef, sourceRefs: [greetingRef] }],
        discarded: [],
      };
    },
  });
  const result = await scenario.adapter.identify();
  assert.equal(result.status, 'ready'); assert.equal(calls, 1);
  assert.equal(request.includeCharacterCard, false); assert.equal(request.worldInfoSource, 'none'); assert.equal(request.substituteMacros, false);
  assert.equal(request.jsonSchema.name, 'qianqianjie_single_main_registry_v1'); assert.ok(request.jsonSchema.value.$defs.ref.properties.kind.enum.includes('card'));
  assert.equal(request.jsonSchema.value.properties.confirmed.minItems, 1); assert.equal(request.jsonSchema.value.properties.confirmed.maxItems, 1);
  assert.match(request.taskMessages[0].content, /卡文件\/酒馆显示名弱提示：作品线路【代号】/); assert.match(request.taskMessages[0].content, /本卡实际扮演人物是沈砚/);
  assert.doesNotMatch(request.taskMessages[0].content, /后续聊天正文绝不进入 single 来源/);
  assert.equal(result.index.confirmed.length, 1); assert.equal(result.index.confirmed[0].identityId, singleCardId); assert.equal(result.index.confirmed[0].displayName, '沈砚');
  assert.deepEqual(result.index.confirmed[0].selection, { status: 'selected' });
  assert.deepEqual(result.index.recognitionPolicy, { kind: 'single-main', version: 1 }); assert.equal(result.index.candidate[0].name, '阿福');
  const profile = scenario.client.records.get(`chat-${id}-people/${singleCardId}`).data;
  assert.deepEqual(profile.sourceBinding, { kind: 'single-card-main', cardId: singleCardId }); assert.equal(profile.selection.status, 'selected');
  assert.equal('aliases' in result.index.confirmed[0], false); assert.equal('sourceSignature' in result.index.confirmed[0], false);
  assert.equal('aliases' in profile, false); assert.equal('sourceSignature' in profile, false);
  const writes = scenario.client.calls.filter(call => call[0] === 'put');
  assert.deepEqual(writes.map(call => [call[1], call[2], call[3].status]), [[`chat-${id}`, 'people-index', 'preparing'], [`chat-${id}-people`, singleCardId, undefined], [`chat-${id}`, 'people-index', 'ready']]);
  assert.deepEqual(writes[0][3].pendingRecognition.recognitionPolicy, { kind: 'single-main', version: 1 }); assert.equal('previousStatus' in writes[0][3].pendingRecognition, false);
  assert.equal(JSON.stringify(result.index).includes(cardText), false); assert.equal(JSON.stringify(profile).includes(cardText), false);
  assert.equal((await scenario.adapter.getPeople()).status, 'ready'); assert.equal((await scenario.adapter.identify()).reused, true); assert.equal(calls, 1);
});

test('single-main-v1：主 C 只在冻结 worldbook 出现仍可 ready，card 来源不被强制引用', async () => {
  const world = { world: '人物密卷', uid: '7', fingerprint: 'sha256:world', content: '本卷明确记载主角顾临川；顾临川是当前角色卡实际扮演者。' };
  const worldRef = { kind: 'worldbook', locator: '人物密卷:7' };
  const scenario = singleScenario({
    cardData: { description: '这是一条未在正文写出真名的单人线路。' }, worldInfoEntries: [world],
    generateTask: async () => ({ confirmed: [singleItem('顾临川', '主角顾临川', worldRef)], candidate: [], discarded: [] }),
  });
  const result = await scenario.adapter.identify();
  assert.equal(result.status, 'ready'); assert.equal(result.index.confirmed[0].identityId, singleCardId);
  assert.deepEqual(result.index.confirmed[0].sourceRefs, [worldRef]); assert.equal(result.index.confirmed[0].sourceRefs.some(item => item.kind === 'card'), false);
});

test('single-main-v1：现场外形的对象 confirmed、locator 字符串 refs 与 candidates 别名可归一化后进入标准 pending', async () => {
  const locator = 'card:hero.png#description';
  const scenario = singleScenario({
    cardData: { description: '本卡实际扮演人物是程砚舟；程砚舟是唯一主 C。' },
    greeting: '韩叙只是负责递信的配角。',
    generateTask: async () => ({
      confirmed: { name: '程砚舟', sourceAnchor: '程砚舟', primarySourceRef: locator, sourceRefs: locator },
      candidates: [],
      discarded: [{ name: '韩叙', sourceAnchor: '韩叙', primarySourceRef: 'greeting:0:0', sourceRefs: ['greeting:0:0'] }],
    }),
  });
  const result = await scenario.adapter.identify();
  assert.equal(result.status, 'ready'); assert.equal(result.index.confirmed.length, 1); assert.equal(result.index.confirmed[0].displayName, '程砚舟');
  assert.equal(result.index.discarded.some(item => item.name === '韩叙'), true);
  const preparing = scenario.client.calls.find(call => call[0] === 'put' && call[3].status === 'preparing')[3].pendingRecognition;
  assert.deepEqual(preparing.confirmed[0].primarySourceRef, singleRef('description'));
  assert.deepEqual(preparing.confirmed[0].sourceRefs, [singleRef('description')]);
  assert.equal(Array.isArray(preparing.confirmed), true); assert.equal(validateRegistryIndex(scenario.client.records.get(`chat-${id}/people-index`), id), true);
});

test('single-main-v1：对象 confirmed 的字符串 locator 仅接受当前来源唯一匹配，未知、歧义与错 anchor 都拒绝', () => {
  const card = { kind: 'card', locator: 'card:hero.png#description', content: '本卡唯一主 C 是程砚舟。' };
  const make = (primarySourceRef, sourceAnchor = '程砚舟') => ({
    confirmed: { name: '程砚舟', sourceAnchor, primarySourceRef, sourceRefs: [primarySourceRef] }, candidate: [], discarded: [],
  });
  assert.deepEqual(normalizeExternalRecognitionResult(make(card.locator), [card], { singleMain: true }).value.confirmed[0], {
    name: '程砚舟', sourceAnchor: '程砚舟', primarySourceRef: singleRef('description'), sourceRefs: [singleRef('description')],
  });
  assert.throws(() => normalizeExternalRecognitionResult(make('card:hero.png#unknown'), [card], { singleMain: true }), /无可用人物/);
  assert.throws(() => normalizeExternalRecognitionResult(make(card.locator), [card, { ...card, kind: 'worldbook', content: '程砚舟' }], { singleMain: true }), /无可用人物/);
  assert.throws(() => normalizeExternalRecognitionResult(make(card.locator, '不存在的锚点'), [card], { singleMain: true }), /无可用人物/);
  assert.throws(() => normalizeExternalRecognitionResult(make(singleRef('description'), '不存在的锚点'), [card], { singleMain: true }), /无可用人物/);
});

test('single-main-v1：confirmed 单元素数组仍通过，空对象、空数组、非法字符串与两条数组仍拒绝；非 single 不接受对象分类', () => {
  const card = { kind: 'card', locator: 'card:hero.png#description', content: '程砚舟是主 C。' };
  const main = singleItem('程砚舟', '程砚舟', singleRef('description'));
  assert.equal(normalizeExternalRecognitionResult({ confirmed: [main], candidate: [], discarded: [] }, [card], { singleMain: true }).value.confirmed.length, 1);
  for (const confirmed of [{}, [], '非法字符串', [main, structuredClone(main)]]) {
    assert.throws(() => normalizeExternalRecognitionResult({ confirmed, candidate: [], discarded: [] }, [card], { singleMain: true }), /结构无效|原始 confirmed|无可用人物/);
  }
  assert.throws(() => normalizeExternalRecognitionResult({ confirmed: main, candidate: [], discarded: [] }, [card]), /结构无效/);
  for (const category of ['candidate', 'discarded']) {
    assert.throws(() => normalizeExternalRecognitionResult({ confirmed: [main], candidate: [], discarded: [], [category]: main }, [card], { singleMain: true }), /结构无效/);
  }
});

test('single-main-v1：漏主 C、两个 confirmed、姓名无显式证据均各纠错一次，两轮仍失败零写', async () => {
  const invalidResults = [
    () => ({ confirmed: [], candidate: [{ name: '阿福', sourceAnchor: '阿福', primarySourceRef: greetingRef, sourceRefs: [greetingRef] }], discarded: [] }),
    () => ({ confirmed: [singleItem('沈砚', '沈砚', singleRef('description')), singleItem('阿福', '阿福', greetingRef)], candidate: [], discarded: [] }),
    () => ({ confirmed: [singleItem('虚构真名', '本卡实际扮演人物', singleRef('description'))], candidate: [], discarded: [] }),
  ];
  for (const result of invalidResults) {
    let calls = 0; const prompts = [];
    const scenario = singleScenario({ cardData: { description: '本卡实际扮演人物沈砚；沈砚是唯一主 C。' }, greeting: 'NPC 阿福只负责传话。', generateTask: async ({ taskMessages }) => { calls += 1; prompts.push(taskMessages[0].content); return result(); } });
    await assert.rejects(() => scenario.adapter.identify(), /single 主 C|姓名/);
    assert.equal(calls, 2); assert.match(prompts[1], /上一次结果没有满足 single 主 C 策略/);
    assert.equal(scenario.client.calls.filter(call => call[0] === 'put').length, 0); assert.equal(scenario.client.records.size, 0);
  }
});

test('single-main-v1：已有 ready 权威索引在新来源两轮纠错仍失败时保持原样且失败阶段零 PUT', async () => {
  let mode = 'ready'; let calls = 0;
  const scenario = singleScenario({
    cardData: { description: '第一版唯一主 C 沈砚。' }, greeting: 'NPC 阿福传话。',
    generateTask: async () => { calls += 1; return mode === 'ready'
      ? { confirmed: [singleItem('沈砚', '沈砚', singleRef('description'))], candidate: [], discarded: [] }
      : { confirmed: [], candidate: [{ name: '阿福', sourceAnchor: '阿福', primarySourceRef: greetingRef, sourceRefs: [greetingRef] }], discarded: [] }; },
  });
  await scenario.adapter.identify(); const indexKey = `chat-${id}/people-index`;
  const before = structuredClone(scenario.client.records.get(indexKey)); const putsBefore = scenario.client.calls.filter(call => call[0] === 'put').length;
  mode = 'bad'; scenario.characterData.description = '第二版仍然明确唯一主 C 沈砚。';
  await assert.rejects(() => scenario.adapter.identify(), /single 主 C/);
  assert.equal(calls, 3); assert.equal(scenario.client.calls.filter(call => call[0] === 'put').length, putsBefore); assert.deepEqual(scenario.client.records.get(indexKey), before);
});

test('single-main-v1：原始两个 confirmed 即使同 sourceKey 也必须纠错，不能靠去重静默变成一个', async () => {
  let calls = 0; const prompts = [];
  const scenario = singleScenario({
    cardData: { description: '本卡唯一主 C 沈砚。' },
    generateTask: async ({ taskMessages }) => {
      calls += 1; prompts.push(taskMessages[0].content);
      const main = singleItem('沈砚', '沈砚', singleRef('description'));
      return calls === 1 ? { confirmed: [main, structuredClone(main)], candidate: [], discarded: [] } : { confirmed: [main], candidate: [], discarded: [] };
    },
  });
  const result = await scenario.adapter.identify();
  assert.equal(result.status, 'ready'); assert.equal(calls, 2); assert.match(prompts[1], /上一次结果没有满足 single 主 C 策略/);
  assert.equal(result.index.confirmed.length, 1); assert.equal(result.index.confirmed[0].identityId, singleCardId);
});

test('single-main-v1：getPeople 重新读取当前显式来源，card/greeting/worldbook 任一变化都只报 stale、不调用 AI', async t => {
  const world = { world: '人物书', uid: '1', fingerprint: 'sha256:world', content: '沈砚载于人物书。' };
  const cases = {
    card(s) { s.characterData.description = '卡正文已变化，主 C 仍为沈砚。'; },
    greeting(s) { s.frozen.greeting.content = '冻结开场已变化，沈砚仍在。'; },
    worldbook(s) { s.frozen.worldInfoEntries[0].content = '世界书已变化，沈砚仍在。'; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    let aiCalls = 0;
    const scenario = singleScenario({
      cardData: { description: '初始卡正文，唯一主 C 沈砚。' }, greeting: '初始开场沈砚。', worldInfoEntries: [world],
      generateTask: async () => { aiCalls += 1; return { confirmed: [singleItem('沈砚', '沈砚', singleRef('description'))], candidate: [], discarded: [] }; },
    });
    assert.equal((await scenario.adapter.identify()).status, 'ready');
    assert.equal((await scenario.adapter.getPeople()).status, 'ready');
    const puts = scenario.client.calls.filter(call => call[0] === 'put').length;
    mutate(scenario);
    assert.equal((await scenario.adapter.getPeople()).status, 'stale');
    assert.equal(aiCalls, 1); assert.equal(scenario.client.calls.filter(call => call[0] === 'put').length, puts);
  });
});

test('single-main-v1：同 fingerprint 的旧 generic preparing 不得恢复随机人物，必须重新识别并建立 cardId 主槽', async () => {
  const greeting = '旧错人物只是 NPC；当前单人卡实际扮演的主 C 是沈砚。'; let aiCalls = 0;
  const scenario = singleScenario({
    greeting,
    generateTask: async () => { aiCalls += 1; return { confirmed: [singleItem('沈砚', '主 C 是沈砚', greetingRef)], candidate: [], discarded: [] }; },
  });
  const fingerprint = await fingerprintRegistrySources(normalizeRegistrySources({
    greeting: { swipeId: 0, fingerprint: 'sha256:greeting', content: greeting }, worldInfoEntries: [],
  }));
  const wrongBinding = { identityId: wrongIdentityId, displayName: '旧错人物', sourceAnchor: '旧错人物', primarySourceRef: greetingRef, sourceKey: 'greeting:greeting:0:0:旧错人物', sourceRefs: [greetingRef], selection: { status: 'selected' } };
  const pendingRecognition = { contractVersion: 3, sourceFingerprint: fingerprint, confirmed: [wrongBinding], candidate: [], discarded: [], shelved: [] };
  const oldIndex = { schemaVersion: 1, kind: 'people-index', chatId: id, contractVersion: 3, sourceFingerprint: fingerprint, status: 'preparing', confirmed: [wrongBinding], candidate: [], discarded: [], shelved: [], tombstones: [], pendingRecognition };
  const wrongProfile = { schemaVersion: 1, peopleContractVersion: 1, kind: 'people-profile', identityId: wrongIdentityId, subject: 'character', displayName: '旧错人物', category: 'confirmed', selection: { status: 'selected' }, sourceFacts: [], userFacts: [{ value: '旧档不得改写', provenance: 'user', locked: true }], interpretations: [], locks: [], pendingReview: [], sourceAnchor: '旧错人物', primarySourceRef: greetingRef, sourceKey: wrongBinding.sourceKey, sourceRefs: [greetingRef], lifecycle: 'active', chatId: id };
  const envelope = data => ({ schemaVersion: 1, revision: 1, generationId: id, createdAt: 'x', updatedAt: 'x', data });
  scenario.client.records.set(`chat-${id}/people-index`, envelope(oldIndex)); scenario.client.records.set(`chat-${id}-people/${wrongIdentityId}`, envelope(wrongProfile));
  const wrongBefore = structuredClone(scenario.client.records.get(`chat-${id}-people/${wrongIdentityId}`));
  const result = await scenario.adapter.identify();
  assert.equal(aiCalls, 1); assert.equal(result.status, 'ready'); assert.equal(result.index.confirmed[0].identityId, singleCardId);
  assert.deepEqual(result.index.recognitionPolicy, { kind: 'single-main', version: 1 }); assert.deepEqual(scenario.client.records.get(`chat-${id}-people/${wrongIdentityId}`), wrongBefore);
  assert.deepEqual(scenario.client.records.get(`chat-${id}-people/${singleCardId}`).data.sourceBinding, { kind: 'single-card-main', cardId: singleCardId });
});

test('旧 single 缺 recognitionPolicy 但 selected/profile 合法时先直接恢复，手动识别后再切严格 cardId 槽', async () => {
  let aiCalls = 0;
  const scenario = singleScenario({ cardData: { description: '当前卡实际扮演者是沈砚。' }, greeting: '李承赫只是旧识别错误样本。', generateTask: async () => { aiCalls += 1; return { confirmed: [singleItem('沈砚', '沈砚', singleRef('description'))], candidate: [], discarded: [] }; } });
  const wrongBinding = { identityId: wrongIdentityId, displayName: '用户改过的李承赫', sourceAnchor: '李承赫', primarySourceRef: greetingRef, sourceKey: 'greeting:greeting:0:0:李承赫', sourceRefs: [greetingRef], selection: { status: 'selected' } };
  const wrongIndex = { schemaVersion: 1, kind: 'people-index', chatId: id, contractVersion: 3, sourceFingerprint: 'sha256:legacy', status: 'ready', confirmed: [wrongBinding], candidate: [], discarded: [], shelved: [], tombstones: [] };
  const wrongProfile = { schemaVersion: 1, peopleContractVersion: 1, kind: 'people-profile', identityId: wrongIdentityId, subject: 'character', displayName: '用户改过的李承赫', category: 'confirmed', selection: { status: 'selected' }, sourceFacts: [{ field: 'appearance', value: '黑发', provenance: 'source' }], dynamicFields: { currentSituation: { value: '正在远行', provenance: 'ai' } }, userFacts: [{ value: '旧错误事实', provenance: 'user' }, { value: '用户改过的李承赫', provenance: 'user.displayName', locked: true }], interpretations: [], locks: [], pendingReview: [], sourceAnchor: '李承赫', primarySourceRef: greetingRef, sourceKey: 'greeting:greeting:0:0:李承赫', sourceRefs: [greetingRef], lifecycle: 'active', chatId: id };
  const envelope = data => ({ schemaVersion: 1, revision: 1, generationId: id, createdAt: 'x', updatedAt: 'x', data });
  scenario.client.records.set(`chat-${id}/people-index`, envelope(wrongIndex)); scenario.client.records.set(`chat-${id}-people/${wrongIdentityId}`, envelope(wrongProfile));
  const wrongProfileBefore = structuredClone(scenario.client.records.get(`chat-${id}-people/${wrongIdentityId}`));
  const legacy = await scenario.adapter.getPeople();
  assert.equal(legacy.status, 'ready'); assert.equal(legacy.refreshRecommended, true); assert.equal(legacy.confirmed[0].displayName, '用户改过的李承赫'); assert.equal(aiCalls, 0); assert.equal(scenario.frozenReads, 0);
  assert.equal(scenario.client.records.get(`chat-${id}-people/${wrongIdentityId}`).data.sourceFacts[0].value, '黑发');
  assert.equal(scenario.client.records.get(`chat-${id}-people/${wrongIdentityId}`).data.dynamicFields.currentSituation.value, '正在远行');
  const migrated = await scenario.adapter.identify(); const main = migrated.index.confirmed[0], profile = scenario.client.records.get(`chat-${id}-people/${singleCardId}`).data;
  assert.equal(aiCalls, 1);
  assert.equal(main.identityId, singleCardId); assert.equal(main.displayName, '沈砚'); assert.equal(main.selection.status, 'selected');
  assert.equal(profile.displayName, '沈砚'); assert.deepEqual(profile.userFacts, []); assert.equal(profile.selection.status, 'selected');
  assert.deepEqual(scenario.client.records.get(`chat-${id}-people/${wrongIdentityId}`), wrongProfileBefore);
});

test('single-main-v1：同 cardId 主槽重识别严格保留权威 selection、用户改名与 userFacts', async () => {
  let generation = 1;
  const scenario = singleScenario({
    cardData: { description: '第一版主 C 名为沈砚。' },
    generateTask: async () => generation === 1
      ? { confirmed: [singleItem('沈砚', '沈砚', singleRef('description'))], candidate: [], discarded: [] }
      : generation === 2
        ? { confirmed: [singleItem('沈砚本名', '沈砚本名', singleRef('description'))], candidate: [], discarded: [] }
        : { confirmed: [singleItem('沈砚真名', '沈砚真名', singleRef('description'))], candidate: [], discarded: [] },
  });
  const first = await scenario.adapter.identify(); assert.equal(first.index.confirmed[0].identityId, singleCardId); assert.equal(first.index.confirmed[0].selection.status, 'selected');
  await scenario.adapter.editDisplayName({ identityId: singleCardId, displayName: '用户命名' });
  scenario.client.records.get(`chat-${id}-people/${singleCardId}`).data.userFacts.push({ value: '用户锁定事实', provenance: 'user', locked: true });
  generation = 2; scenario.characterData.description = '第二版确认沈砚本名，也使用阿砚这个别名。';
  const changed = await scenario.adapter.identify(); let main = changed.index.confirmed[0], profile = scenario.client.records.get(`chat-${id}-people/${singleCardId}`).data;
  assert.equal(main.identityId, singleCardId); assert.equal(main.displayName, '用户命名'); assert.equal(main.selection.status, 'selected');
  assert.equal(profile.displayName, '用户命名'); assert.equal(profile.selection.status, 'selected'); assert.ok(profile.userFacts.some(item => item.value === '用户锁定事实')); assert.ok(profile.userFacts.some(item => item.provenance === 'user.displayName'));
  await scenario.adapter.unselect({ identityId: singleCardId });
  scenario.client.records.get(`chat-${id}-people/${singleCardId}`).data.selection = { status: 'selected' };
  generation = 3; scenario.characterData.description = '第三版确认沈砚真名，来源再次变化。';
  const unselected = await scenario.adapter.identify(); main = unselected.index.confirmed[0]; profile = scenario.client.records.get(`chat-${id}-people/${singleCardId}`).data;
  assert.equal(main.selection.status, 'unselected'); assert.equal(profile.selection.status, 'unselected'); assert.equal(main.displayName, '用户命名'); assert.ok(profile.userFacts.some(item => item.value === '用户锁定事实'));
});

test('非 single 路径继续使用原 Schema、广泛多个 confirmed、随机身份复用且不读取 card 正文', async () => {
  let calls = 0; let request;
  const scenario = singleScenario({
    cardType: 'multi', cardData: { description: 'multi 卡正文秘密不应进入原 C Registry prompt。' }, greeting: '甲人物；乙人物',
    generateTask: async options => { calls += 1; request = options; return { confirmed: [{ name: '甲', sourceAnchor: '甲人物', primarySourceRef: greetingRef, sourceRefs: [greetingRef] }, { name: '乙', sourceAnchor: '乙人物', primarySourceRef: greetingRef, sourceRefs: [greetingRef] }], candidate: [], discarded: [] }; },
  });
  const first = await scenario.adapter.identify(); const identities = first.index.confirmed.map(item => item.identityId);
  assert.equal(request.jsonSchema.name, 'qianqianjie_c_registry'); assert.equal(request.jsonSchema.value.$defs.ref.properties.kind.enum.includes('card'), false); assert.doesNotMatch(request.taskMessages[0].content, /multi 卡正文秘密/);
  assert.equal(first.index.confirmed.length, 2); assert.equal(identities.includes(singleCardId), false); assert.equal(new Set(identities).size, 2);
  const readsBeforeGet = scenario.frozenReads; assert.equal((await scenario.adapter.getPeople()).status, 'ready'); assert.equal(scenario.frozenReads, readsBeforeGet);
  const second = await scenario.adapter.identify(); assert.equal(second.reused, true); assert.deepEqual(second.index.confirmed.map(item => item.identityId), identities); assert.equal(calls, 1);
});

test('无 single recognitionPolicy 的旧索引继续拒绝 card ref，不放宽非 single 持久化合同', () => {
  const cardRef = singleRef('description');
  const binding = { identityId: wrongIdentityId, displayName: '甲', sourceAnchor: '甲', primarySourceRef: cardRef, sourceKey: 'card:card:hero.png#description:甲', sourceRefs: [cardRef], selection: { status: 'unselected' } };
  const record = { schemaVersion: 1, revision: 1, generationId: id, createdAt: 'x', updatedAt: 'x', data: { schemaVersion: 1, kind: 'people-index', chatId: id, contractVersion: 3, sourceFingerprint: 'sha256:x', status: 'ready', confirmed: [binding], candidate: [], discarded: [], shelved: [], tombstones: [] } };
  assert.equal(validateRegistryIndex(record, id), false);
});
