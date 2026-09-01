import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRerunEvents, createRerunOrchestrator, startInitialRun } from '../src/integration-port.js';
import { createPluginGate } from '../src/plugin-gate.js';
import { createRuntimeRunner } from '../src/runtime-runner.js';

test('初始关闭与宿主事件均零运行；启用后每个事件只运行一次且监听不重复', async () => {
  let enabled = false, runs = 0, invalidations = 0; const handlers = {};
  const controller = { invalidate: () => { invalidations += 1; }, run: async () => { runs += 1; } };
  assert.equal(startInitialRun(controller, console, () => enabled), false); await new Promise(resolve => setImmediate(resolve)); assert.equal(runs, 0);
  assert.equal(bindRerunEvents({ eventSource: { on: (name, fn) => { assert.equal(handlers[name], undefined); handlers[name] = fn; } }, eventTypes: { CHAT_CHANGED: 'chat', PERSONA_CHANGED: 'persona' }, controller, isEnabled: () => enabled }), true);
  handlers.chat(); handlers.persona(); await new Promise(resolve => setImmediate(resolve)); assert.equal(runs, 0); assert.equal(invalidations, 2);
  enabled = true; handlers.chat(); await new Promise(resolve => setImmediate(resolve)); assert.equal(runs, 1); assert.equal(invalidations, 3);
});

test('总开关关闭立即 invalidate；重复开启合并为一次初始化，快速关开仍只产生一个新初始化', async () => {
  let runs = 0, invalidations = 0, uiEnabled = true, release;
  const gate = createPluginGate({ initiallyEnabled: true, invalidate: () => { invalidations += 1; }, setUiEnabled: value => { uiEnabled = value; }, run: async () => { runs += 1; await new Promise(resolve => { release = resolve; }); return { status: 'ready' }; } });
  assert.equal((await gate.setEnabled(false)).status, 'disabled'); assert.equal(uiEnabled, false); assert.equal(invalidations, 1);
  const first = gate.setEnabled(true), duplicate = gate.setEnabled(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(runs, 1); release(); await Promise.all([first, duplicate]); assert.equal(uiEnabled, true);
  await gate.setEnabled(false); const second = gate.setEnabled(true), duplicateSecond = gate.setEnabled(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(runs, 2); release(); await Promise.all([second, duplicateSecond]); assert.equal(runs, 2);
});

test('真实 bootstrap 初始关闭：魔法棒和设置入口可用，打开面板零 formal/people 读取', async () => {
  const { bootstrap } = await import('../dist/index.js?master-switch-disabled=1');
  let wandOpen, formalReads = 0, peopleReads = 0; const states = [], appended = [];
  const documentRef = { activeElement: null, body: { append: node => appended.push(node) }, getElementById: () => null, addEventListener() {}, createElement: () => ({}) };
  const host = { id: 'qqj-panel-host', hidden: true, style: {} };
  const panelFactory = options => ({ host, root: { querySelector: () => null }, show() { host.hidden = false; }, close() {}, setState(value) { states.push(value); }, showSettings() { options.onPluginEnabledChange?.(true); } });
  const instance = bootstrap({ settings: { isEnabled: () => false }, formal: { getFormalState: async () => { formalReads += 1; } }, people: { getPeople: async () => { peopleReads += 1; } }, documentRef, panelFactory, wandInstaller: open => { wandOpen = open; } });
  assert.equal(typeof wandOpen, 'function'); assert.equal(instance.fab.host, null); wandOpen({}); await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.hidden, false); assert.equal(formalReads, 0); assert.equal(peopleReads, 0); assert.equal(states.at(-1).status, 'disabled'); assert.equal(appended.includes(host), true);
});

test('bootstrap 无 runtime fallback 读取 stale 旧档时只展示手动整理，零自动识别', async () => {
  const { bootstrap } = await import('../dist/index.js?master-switch-stale=1');
  let wandOpen, identifyCalls = 0; const states = [];
  const documentRef = { activeElement: null, body: { append() {} }, getElementById: () => null, addEventListener() {}, createElement: () => ({}) };
  const host = { id: 'qqj-panel-host', hidden: true, style: {} };
  const panelFactory = () => ({ host, root: { querySelector: () => null }, show() { host.hidden = false; }, close() {}, setState(value) { states.push(value); } });
  bootstrap({
    settings: { isEnabled: () => true }, formal: { getFormalState: async () => ({ status: 'route_ready' }) },
    people: { getPeople: async () => ({ status: 'stale', confirmed: [{ displayName: '旧人物' }] }), identify: async () => { identifyCalls += 1; return { status: 'ready' }; } },
    sourceCatalog: { getState: async () => ({ status: 'uninitialized', stage: 'uninitialized', candidates: [], permit: { status: 'none' } }) },
    documentRef, panelFactory, wandInstaller: open => { wandOpen = open; },
  });
  wandOpen({});
  while (!states.some(value => value.people?.recognitionRequired)) await new Promise(resolve => setImmediate(resolve));
  const ready = states.find(value => value.people?.recognitionRequired);
  assert.equal(ready.people.status, 'stale'); assert.equal(ready.people.confirmed[0].displayName, '旧人物'); assert.equal(ready.sourceCatalog.stage, 'uninitialized'); assert.equal(identifyCalls, 0);
});

test('编排队列积压后关闭：释放前序时旧排队任务零 demo/formal I/O', async () => {
  let demoCalls = 0, formalCalls = 0, release, enabled = true;
  const orchestrator = createRerunOrchestrator({ isEnabled: () => enabled, demo: { invalidate() {}, runDemo: async () => { demoCalls += 1; await new Promise(resolve => { release = resolve; }); return { status: 'ready' }; } }, formal: { invalidate() {}, getFormalState: async () => { formalCalls += 1; return { status: 'ready' }; } } });
  const first = orchestrator.run(); await new Promise(resolve => setImmediate(resolve)); const queued = orchestrator.run(); enabled = false; orchestrator.invalidate(); release();
  assert.equal((await first).status, 'stale'); assert.equal((await queued).status, 'stale'); assert.equal((await orchestrator.run()).status, 'stale'); assert.equal(demoCalls, 1); assert.equal(formalCalls, 0);
});

test('生产 runtime 识别在途关闭：迟到结果不覆盖 disabled UI', async () => {
  let enabled = true, release, identifyStarted = false, invalidations = 0; const states = [];
  const runtime = createRuntimeRunner({
    isEnabled: () => enabled, orchestrator: { run: async () => ({ status: 'route_ready' }) },
    people: { getPeople: async () => ({ status: 'uninitialized' }), identify: async () => { identifyStarted = true; await new Promise(resolve => { release = resolve; }); return { status: 'ready' }; } },
    invalidateDependencies: () => { invalidations += 1; }, setState: state => states.push(state), disabledState: () => ({ status: 'disabled' }),
  });
  const gate = createPluginGate({ initiallyEnabled: true, invalidate: runtime.invalidate, run: runtime.run, disabledState: () => ({ status: 'disabled' }), setUiEnabled: value => { enabled = value; if (!value) states.push({ status: 'disabled' }); } });
  const pending = runtime.run(); while (!identifyStarted) await new Promise(resolve => setImmediate(resolve)); await gate.setEnabled(false); release();
  assert.equal((await pending).status, 'disabled'); assert.equal(states.at(-1).status, 'disabled'); assert.equal(states.some(state => state.status === 'route_ready'), false); assert.equal(invalidations, 1);
});

test('空人物档普通运行零 AI；显式确认许可才恰好识别一次且双击合并', async () => {
  let identifyCalls = 0, claimCalls = 0, completed = 0, peopleReady = false, release;
  const sourceCatalog = {
    getState: async () => ({ status: 'ready', stage: 'confirmed', permit: { status: 'ready' } }),
    claimRecognition: async () => { claimCalls += 1; return { status: 'claimed', operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sources: [{ kind: 'card', locator: 'card:x#description', fingerprint: `sha256:${'1'.repeat(64)}`, content: '人物' }], binding: {} }; },
    completeRecognition: async () => { completed += 1; return { status: 'ready', stage: 'completed', permit: { status: 'consumed' } }; },
    failRecognition: async () => ({ status: 'ready', stage: 'failed', permit: { status: 'failed' } }),
  };
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => ({ status: 'ready' }) }, sourceCatalog,
    people: {
      getPeople: async () => peopleReady ? { status: 'ready' } : { status: 'uninitialized' },
      identify: async () => { identifyCalls += 1; await new Promise(resolve => { release = resolve; }); peopleReady = true; return { status: 'ready' }; },
    },
  });
  const passive = await runtime.run(); assert.equal(identifyCalls, 0); assert.equal(passive.people.recognitionRequired, true);
  const first = runtime.run({ allowIdentification: true }); while (!release) await new Promise(resolve => setImmediate(resolve));
  const double = runtime.run({ allowIdentification: true }); assert.equal(double, first); release();
  assert.equal((await first).people.status, 'ready'); assert.equal(identifyCalls, 1); assert.equal(claimCalls, 1); assert.equal(completed, 1);
});

test('旧合法档案普通加载直接恢复，catalog 未初始化时只建议手动刷新且零 AI、不强制整理', async () => {
  let identifyCalls = 0, catalogReads = 0;
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => ({ status: 'route_ready' }) },
    people: {
      getPeople: async () => ({ status: 'ready', refreshRecommended: true, confirmed: [{ displayName: '旧人物', selection: { status: 'selected' } }], profiles: [{ basicFields: { appearance: { value: '银发' } }, dynamicFields: { currentSituation: { value: '守城' } } }] }),
      identify: async () => { identifyCalls += 1; return { status: 'ready' }; },
    },
    sourceCatalog: {
      getState: async () => { catalogReads += 1; return { status: 'uninitialized', stage: 'uninitialized', candidates: [], permit: { status: 'none' } }; },
      claimRecognition: async () => ({ status: 'not_ready' }),
    },
  });
  const passive = await runtime.run();
  assert.equal(passive.people.status, 'ready'); assert.equal(passive.people.confirmed[0].displayName, '旧人物'); assert.equal(passive.people.refreshRecommended, true);
  assert.equal(passive.people.recognitionRequired, undefined); assert.equal(passive.people.profiles[0].basicFields.appearance.value, '银发'); assert.equal(catalogReads, 0);
  const explicit = await runtime.run({ allowIdentification: true });
  assert.equal(explicit.people.status, 'ready'); assert.equal(explicit.people.refreshRecommended, true); assert.equal(explicit.people.recognitionRequired, undefined);
  assert.equal(identifyCalls, 0); assert.ok(catalogReads >= 2);
});

test('旧合法档案保留手动重新识别：确认来源许可后显式刷新恰好调用一次 AI', async () => {
  let identifyCalls = 0, peopleReady = false, claims = 0, completed = 0;
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => ({ status: 'route_ready' }) },
    people: {
      getPeople: async () => peopleReady ? { status: 'ready', refreshRecommended: false, confirmed: [{ displayName: '新人物' }] } : { status: 'ready', refreshRecommended: true, confirmed: [{ displayName: '旧人物', selection: { status: 'selected' } }] },
      identify: async options => { identifyCalls += 1; assert.equal(options.sourceCatalogClaim.status, 'claimed'); peopleReady = true; return { status: 'ready' }; },
    },
    sourceCatalog: {
      getState: async () => ({ status: 'ready', stage: 'confirmed', permit: { status: 'ready' } }),
      claimRecognition: async () => { claims += 1; return { status: 'claimed', operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sources: [], binding: {} }; },
      completeRecognition: async () => { completed += 1; return { status: 'ready', stage: 'completed', permit: { status: 'consumed' } }; },
      failRecognition: async () => ({ status: 'ready', stage: 'failed', permit: { status: 'failed' } }),
    },
  });
  const passive = await runtime.run(); assert.equal(passive.people.confirmed[0].displayName, '旧人物'); assert.equal(identifyCalls, 0);
  const refreshed = await runtime.run({ allowIdentification: true });
  assert.equal(refreshed.people.confirmed[0].displayName, '新人物'); assert.equal(identifyCalls, 1); assert.equal(claims, 1); assert.equal(completed, 1);
});

test('识别失败与普通刷新不自动重试；人工 retry 一次只再调用一次', async () => {
  let identifyCalls = 0, retryCalls = 0, permit = 'ready', peopleReady = false;
  const sourceCatalog = {
    getState: async () => ({ status: 'ready', stage: permit === 'failed' ? 'failed' : 'confirmed', permit: { status: permit } }),
    retry: async () => { retryCalls += 1; permit = 'ready'; return { status: 'ready', stage: 'confirmed', permit: { status: 'ready' } }; },
    claimRecognition: async () => { if (permit !== 'ready') return { status: 'not_ready' }; permit = 'in_flight'; return { status: 'claimed', operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sources: [], binding: {} }; },
    failRecognition: async () => { permit = 'failed'; return { status: 'ready', stage: 'failed', permit: { status: 'failed' } }; },
    completeRecognition: async () => { permit = 'consumed'; return { status: 'ready', stage: 'completed', permit: { status: 'consumed' } }; },
  };
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => ({ status: 'ready' }) }, sourceCatalog,
    people: { getPeople: async () => peopleReady ? { status: 'ready' } : { status: 'uninitialized' }, identify: async () => { identifyCalls += 1; if (identifyCalls === 1) throw new Error('expected'); peopleReady = true; return { status: 'ready' }; } },
  });
  assert.equal((await runtime.run({ allowIdentification: true })).peopleRecognitionFailed, true); assert.equal(identifyCalls, 1);
  await runtime.run(); await runtime.run(); assert.equal(identifyCalls, 1); assert.equal(retryCalls, 0);
  assert.equal((await runtime.run({ allowIdentification: true, retryRecognition: true })).people.status, 'ready'); assert.equal(identifyCalls, 2); assert.equal(retryCalls, 1);
});

test('后台只读加载与确认重叠时保留显式许可，合并后仍只识别一次', async () => {
  let releaseOrchestrator, identifyCalls = 0, claimed = false, peopleReady = false;
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => { await new Promise(resolve => { releaseOrchestrator = resolve; }); return { status: 'route_ready' }; } },
    people: {
      getPeople: async () => peopleReady ? { status: 'ready', confirmed: [] } : { status: 'uninitialized', confirmed: [] },
      identify: async () => { identifyCalls += 1; peopleReady = true; return { status: 'ready' }; },
    },
    sourceCatalog: {
      getState: async () => ({ status: 'ready', stage: 'confirmed', permit: { status: claimed ? 'in_flight' : 'ready' } }),
      claimRecognition: async () => { if (claimed) return { status: 'not_ready' }; claimed = true; return { status: 'claimed', operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sources: [], binding: {} }; },
      completeRecognition: async () => ({ status: 'ready', stage: 'completed', permit: { status: 'consumed' } }),
      failRecognition: async () => ({ status: 'ready', stage: 'failed', permit: { status: 'failed' } }),
    },
  });
  const passive = runtime.run(); while (!releaseOrchestrator) await new Promise(resolve => setImmediate(resolve));
  const confirmed = runtime.run({ allowIdentification: true });
  const duplicate = runtime.run({ allowIdentification: true });
  assert.equal(confirmed, duplicate);
  releaseOrchestrator();
  assert.equal((await passive).people.status, 'ready');
  assert.equal((await confirmed).people.status, 'ready');
  assert.equal(identifyCalls, 1);
});

test('runtime background 在途后 foreground 接管同一底层 flight 与安全阶段', async () => {
  let firstRelease, calls = 0; const backgroundStates = [], foregroundStates = [], snapshots = [];
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => { calls += 1; if (calls === 1) await new Promise(resolve => { firstRelease = resolve; }); return { status: 'route_ready', chatId: 'safe-chat' }; } },
    people: {
      getPeople: async options => { snapshots.push(options.runtimeSnapshot); return snapshots.length < 2 ? { status: 'uninitialized' } : { status: 'ready' }; },
      identify: async options => { snapshots.push(options.runtimeSnapshot); for (const phase of ['reading_sources', 'waiting_ai', 'saving_people']) options.onPhase(phase); return { status: 'ready' }; },
    },
    setState: value => backgroundStates.push(value),
  });
  const background = runtime.run(); while (!firstRelease) await new Promise(resolve => setImmediate(resolve));
  const foreground = runtime.run({ setState: value => foregroundStates.push(value), isCurrent: () => true });
  assert.equal(background, foreground); assert.equal(calls, 1);
  firstRelease(); assert.equal((await background).status, 'route_ready'); assert.equal((await foreground).status, 'route_ready');
  assert.deepEqual(foregroundStates.slice(0, 3).map(value => value.runtimePhase), [
    { code: 'reading_sources', label: '正在读取路线来源' },
    { code: 'waiting_ai', label: '正在等待 AI 识别' },
    { code: 'saving_people', label: '正在写入人物档案' },
  ]);
  assert.equal(foregroundStates.at(-1).status, 'route_ready'); assert.equal(backgroundStates.length, 0);
  assert.equal(new Set(snapshots).size, 1); assert.doesNotMatch(JSON.stringify(foregroundStates), /正文|api[_-]?key|full_request/i);
});

test('runtime foreground 在途时 background join 不抢 owner', async () => {
  let release, calls = 0; const foregroundStates = [], backgroundStates = [];
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => { calls += 1; await new Promise(resolve => { release = resolve; }); return { status: 'ready' }; } },
    people: { getPeople: async () => ({ status: 'ready' }) }, setState: value => backgroundStates.push(value),
  });
  const foreground = runtime.run({ setState: value => foregroundStates.push(value), isCurrent: () => true });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const background = runtime.run(); assert.equal(background, foreground); assert.equal(calls, 1); release();
  assert.equal((await background).status, 'ready'); assert.equal(foregroundStates.at(-1).status, 'ready'); assert.equal(backgroundStates.length, 0);
});

test('runtime close/reopen 只转移动态 UI owner，旧 UI 零迟到且新 UI 收到 ready', async () => {
  let release, calls = 0, oldCurrent = true; const oldStates = [], newStates = [];
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => { calls += 1; await new Promise(resolve => { release = resolve; }); return { status: 'ready' }; } },
    people: { getPeople: async () => ({ status: 'ready' }) },
  });
  const oldOpen = runtime.run({ setState: value => oldStates.push(value), isCurrent: () => oldCurrent });
  while (!release) await new Promise(resolve => setImmediate(resolve)); oldCurrent = false;
  const reopened = runtime.run({ setState: value => newStates.push(value), isCurrent: () => true });
  assert.equal(reopened, oldOpen); assert.equal(calls, 1); release();
  assert.equal((await reopened).status, 'ready'); assert.equal(oldStates.length, 0); assert.equal(newStates.at(-1).status, 'ready');
});

test('runtime invalidate 后旧 flight 不清新 flight，正常 resolve 会释放 active', async () => {
  const releases = []; let calls = 0;
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => { calls += 1; if (calls <= 2) await new Promise(resolve => releases.push(resolve)); return { status: 'ready', run: calls }; } },
    people: { getPeople: async () => ({ status: 'ready' }) },
  });
  const oldFlight = runtime.run(); while (releases.length < 1) await new Promise(resolve => setImmediate(resolve));
  runtime.invalidate(); const newFlight = runtime.run(); while (releases.length < 2) await new Promise(resolve => setImmediate(resolve));
  releases[0](); assert.equal((await oldFlight).status, 'stale');
  const joinedNew = runtime.run(); assert.equal(joinedNew, newFlight); assert.equal(calls, 2); releases[1](); assert.equal((await newFlight).status, 'ready');
  const afterResolve = await runtime.run(); assert.equal(afterResolve.status, 'ready'); assert.equal(calls, 3);
});

test('runtime reject 后也释放 activeFlight，下一次可重新运行', async () => {
  let rejectFirst, calls = 0;
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => { calls += 1; if (calls === 1) await new Promise((_resolve, reject) => { rejectFirst = reject; }); return { status: 'ready' }; } },
    people: { getPeople: async () => ({ status: 'ready' }) },
  });
  const first = runtime.run(); while (!rejectFirst) await new Promise(resolve => setImmediate(resolve)); rejectFirst(new Error('expected failure'));
  await assert.rejects(first, /expected failure/); assert.equal((await runtime.run()).status, 'ready'); assert.equal(calls, 2);
});

test('生产 runtime 在正式状态后调用 stableFloors seam 并公开嵌套结果', async () => {
  let stableCalls = 0; const states = [];
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => ({ status: 'ready' }) },
    people: { getPeople: async () => ({ status: 'ready' }) },
    stableFloors: { refresh: async () => { stableCalls += 1; return { status: 'unchanged', changeKind: 'append', firstDifferenceFloor: 2, rollbackBoundary: 1 }; } },
    setState: state => states.push(state),
  });
  const result = await runtime.run();
  assert.equal(stableCalls, 1);
  assert.equal(result.people.status, 'ready');
  assert.equal(result.stableFloors.changeKind, 'append');
  assert.equal(states.at(-1).stableFloors.rollbackBoundary, 1);
});

test('生产 runtime 只恢复已有首次生成 draft，不主动开始新 AI', async () => {
  let resumeCalls = 0; const states = [];
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => ({ status: 'ready' }) }, people: { getPeople: async () => ({ status: 'ready' }) },
    stableFloors: { refresh: async () => ({ status: 'unchanged' }) }, peopleFoundation: { initialize: async () => ({ status: 'ready' }) },
    initialRelations: { resume: async () => { resumeCalls += 1; return { status: 'ready', zeroAi: true }; } }, setState: state => states.push(state),
  });
  const result = await runtime.run(); assert.equal(resumeCalls, 1); assert.equal(result.initialRelations.zeroAi, true); assert.equal(states.at(-1).initialRelations.status, 'ready');
});

test('runtime 新实例以 foundation 持久首次状态为权威，并在 resume 完成前显示 generating/applying', async t => {
  for (const status of ['generating', 'applying']) await t.test(status, async () => {
    let release, resumeStarted = false; const states = [];
    const runtime = createRuntimeRunner({
      orchestrator: { run: async () => ({ status: 'ready' }) }, people: { getPeople: async () => ({ status: 'ready' }) },
      stableFloors: { refresh: async () => ({ status: 'unchanged' }) },
      peopleFoundation: { initialize: async () => ({ status: 'ready', state: { initialGeneration: { schemaVersion: 1, status, operationId: 'persisted-operation' } }, profiles: [] }) },
      initialRelations: {
        getState: () => ({ schemaVersion: 1, status: 'uninitialized' }),
        resume: async () => { resumeStarted = true; await new Promise(resolve => { release = resolve; }); return { status, zeroAi: true }; },
      },
      setState: value => states.push(value),
    });
    const pending = runtime.run(); while (!resumeStarted) await new Promise(resolve => setImmediate(resolve));
    assert.equal(states.at(-1).initialRelations.status, status); assert.equal(states.at(-1).initialRelations.operationId, 'persisted-operation');
    release(); const result = await pending; assert.equal(result.initialRelations.status, status);
  });
});

test('真实 bootstrap 识别异常迟到：关闭后的最终 UI 仍为 disabled', async () => {
  const { bootstrap } = await import('../dist/index.js?identify-close-ui=1');
  let enabled = true, rejectIdentify, identifyStarted = false; const states = [];
  const documentRef = { activeElement: null, body: { append() {} }, getElementById: () => null, addEventListener() {}, createElement: () => ({}) };
  const host = { id: 'qqj-panel-host', hidden: true, style: {} };
  const panelFactory = () => ({ host, root: { querySelector: () => null }, show() { host.hidden = false; }, close() {}, setState(value) { states.push(value); } });
  const instance = bootstrap({ settings: { isEnabled: () => enabled }, formal: { getFormalState: async () => ({ status: 'route_ready' }) },
    people: { getPeople: async () => ({ status: 'stale', confirmed: [{ identityId: '123e4567-e89b-42d3-a456-426614174000' }] }), identify: async () => { identifyStarted = true; await new Promise((_, reject) => { rejectIdentify = reject; }); } },
    documentRef, panelFactory, wandInstaller() {},
  });
  instance.show({}); while (!identifyStarted) await new Promise(resolve => setImmediate(resolve)); enabled = false; instance.setEnabled(false); rejectIdentify(new Error('late failure'));
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.at(-1).status, 'disabled'); assert.equal(states.slice(states.findIndex(state => state.status === 'disabled') + 1).some(state => state.status !== 'disabled'), false);
});
