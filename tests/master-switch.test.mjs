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
    people: { getPeople: async () => ({ status: 'uninitialized' }), identify: async () => { identifyStarted = true; await new Promise((_, reject) => { rejectIdentify = reject; }); } },
    documentRef, panelFactory, wandInstaller() {},
  });
  instance.show({}); while (!identifyStarted) await new Promise(resolve => setImmediate(resolve)); enabled = false; instance.setEnabled(false); rejectIdentify(new Error('late failure'));
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.at(-1).status, 'disabled'); assert.equal(states.slice(states.findIndex(state => state.status === 'disabled') + 1).some(state => state.status !== 'disabled'), false);
});
