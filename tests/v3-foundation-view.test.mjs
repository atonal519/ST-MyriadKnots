import test from 'node:test';
import assert from 'node:assert/strict';
import { createV3FoundationView } from '../src/ui/v3-foundation-view.js';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.className = ''; this.disabled = false; this.replaceCount = 0; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.replaceCount += 1; this.children = [...nodes]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  click() { return this.listeners.click?.(); }
}
const documentRef = { createElement: tag => new Node(tag) };
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];

test('诊断视图先显示壳，再异步刷新；确认操作有反馈且不调用 AI', async () => {
  let release;
  let refreshes = 0;
  let confirms = 0;
  const base = {
    status: 'idle', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT,
    foundationStatus: 'uninitialized', stableCount: 2, pending: { assistantSeq: 3, messageIndex: 5 },
    stableBoundary: { assistantSeq: 2 }, headCheckpointId: null, activeRun: null, lastRun: null,
    lastError: null, unreachableCount: 0, metrics: {},
  };
  const runtime = {
    getState: () => base,
    refreshStatus: () => { refreshes += 1; return new Promise(resolve => { release = () => resolve({ ...base, status: 'ready', foundationStatus: 'ready' }); }); },
    confirmLatest: async () => { confirms += 1; return { ...base, status: 'ready', stableCount: 3, pending: null }; },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /千结 · V3 地基/);
  const activation = view.activate();
  assert.equal(refreshes, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /正在读取并对账/);
  release();
  await activation;
  const confirm = flatten(container).find(node => node.textContent === '确认最新 AI 楼');
  confirm.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirms, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /确认完成/);
});

test('完整诊断必须显式确认，clipboard 不可用时显示可选择文本框', async () => {
  let confirmed = false;
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'ai', aiSummary: '摘要', extractorVersion: 'v', counts: {}, api: null, memory }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, copySafeDiagnostic: () => '{"safe":true}', copyFullDiagnostic: () => '{"canonicalContent":"原文"}' };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef, navigatorRef: {}, confirmImpl: () => confirmed }); view.mount(container);
  let full = flatten(container).find(node => node.textContent === '复制完整诊断 JSON'); full.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(flatten(container).some(node => node.className === 'v3-diagnostic-fallback'), false);
  confirmed = true; full = flatten(container).find(node => node.textContent === '复制完整诊断 JSON'); full.click(); await new Promise(resolve => setImmediate(resolve));
  const fallback = flatten(container).find(node => node.className === 'v3-diagnostic-fallback'); assert.match(fallback.value, /canonicalContent/);
});

test('Extractor 失败且尚无 FloorMemory 时仍可复制安全/完整会话诊断', () => {
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 0, unprocessedCount: 1, failedCount: 1, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, lastRun: null, lastError: null, lastExtractorError: { message: '失败' }, unreachableCount: 0, metrics: {}, floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'failed', memoryId: null, summary: '', counts: {}, error: '失败', memory: null }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, copySafeDiagnostic: () => '{"safe":true}', copyFullDiagnostic: () => '{"sessionCandidate":{}}' };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef, navigatorRef: {} }); view.mount(container);
  const copy = flatten(container).map(node => node.textContent); assert.ok(copy.includes('复制安全诊断 JSON')); assert.ok(copy.includes('复制完整诊断 JSON'));
});

test('面板顶部显示 CSE 分层状态、原因/来源与待分析重试入口，不创建楼内聊天渲染', async () => {
  let nextCalls = 0, retryCalls = 0;
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 1, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [{ displayName: '林岚', core: [{ text: '谨慎', reason: '角色设定', visibility: 'authorial', sourceAssistantSeq: 1 }], adaptive: [{ text: '保持戒备', reason: '发生冲突', visibility: 'observable', towardDisplayName: '裴晚生', sourceAssistantSeq: 1 }], situational: [{ text: '紧张', reason: '雨夜危险', visibility: 'private', sourceAssistantSeq: 1 }] }], floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'ai', aiSummary: '摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'pending', deltaId: null } }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, analyzeNextState: async () => { nextCalls += 1; return state; }, retryStateAnalysis: async () => { retryCalls += 1; return state; } };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef }); view.mount(container);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /CSE 当前状态|Core · 核心|Adaptive · 长期适应|Situational · 当前情境|发生冲突|来源 AI #1|对 裴晚生/);
  assert.equal(flatten(container).some(node => String(node.className).includes('qqj-v3-floor-card')), false);
  flatten(container).find(node => node.textContent === '分析下一楼状态').click();
  flatten(container).find(node => node.textContent === '分析本楼状态').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextCalls, 1); assert.equal(retryCalls, 1);
});

test('CSE 失败数、本楼错误与最近错误在 V3 面板可见，并保留独立重试', async () => {
  let retries = 0;
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: { message: '安全 CSE 错误' }, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 0, cseFailedCount: 1, baselineId: 'baseline', cseSubjects: [], floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'ai', aiSummary: '摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'failed', deltaId: null, error: '本楼状态失败' } }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, analyzeNextState: async () => state, retryStateAnalysis: async () => { retries += 1; return state; } };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef }); view.mount(container);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /CSE 待分析 \/ 失败\|0 \/ 1/);
  assert.match(copy, /最近 CSE 错误\|安全 CSE 错误/);
  assert.match(copy, /CSE：本楼状态失败/);
  flatten(container).find(node => node.textContent === '重试状态分析').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retries, 1);
});

test('自动批次活跃时面板提取、CSE 与修订入口统一禁用，结束后恢复', () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const base = { status: 'running', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 1, failedCount: 0, reviewCount: 0, pending: { assistantSeq: 2, messageIndex: 3 }, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: true, activeAutoMemory: { phase: 'reconciling', floorIds: ['floor'] }, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 1, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [], floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'user', aiSummary: 'AI 摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'pending', deltaId: null } }] };
  let state = base;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractNext: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, analyzeNextState: async () => state, retryStateAnalysis: async () => state };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef }); view.mount(container);
  const controlled = ['刷新地基状态', '确认最新 AI 楼', '提取下一楼', '分析下一楼状态', '重新提取', '保存摘要', '恢复 AI', '标记错误', '分析本楼状态'];
  for (const label of controlled) assert.equal(flatten(container).find(node => node.textContent === label)?.disabled, true, label);
  state = { ...base, status: 'ready', memoryWorkBusy: false, activeAutoMemory: null };
  view.render(state);
  for (const label of controlled) assert.equal(flatten(container).find(node => node.textContent === label)?.disabled, false, label);
});

test('历史欠账按钮显式开始/继续，运行中可暂停且不依赖自动维护开关', async () => {
  const base = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 5, rememberedCount: 2, unprocessedCount: 3, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, autoMemoryEnabled: false, autoMemoryBatchSize: 2, rebuildStatus: 'pendingRebuild', rebuildCompletedCount: 2, rebuildTotalCount: 5, rebuildNextAssistantSeq: 3, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  let state = base, starts = 0, pauses = 0;
  const runtime = {
    getState: () => state,
    refreshStatus: async () => state,
    confirmLatest: async () => state,
    startHistoricalRebuild: async () => { starts += 1; return state; },
    pauseHistoricalRebuild: () => { pauses += 1; return state; },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.mount(container);
  state = { ...base, rememberedCount: 0, rebuildCompletedCount: 0, rebuildNextAssistantSeq: 1 };
  view.render(state);
  assert.equal(flatten(container).find(node => node.textContent === '开始重建现有聊天')?.disabled, false);
  state = base;
  view.render(state);
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /自动维护新楼\|已关闭/);
  assert.match(copy, /最早缺口 AI #3/);
  assert.match(copy, /记忆未完整，本轮不会注入千千结记忆.*刷新页面不会自动续跑/);
  const resume = flatten(container).find(node => node.textContent === '继续重建');
  assert.equal(resume.disabled, false);
  resume.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);

  state = { ...base, status: 'running', memoryWorkBusy: true, rebuildStatus: 'rebuilding', activeAutoMemory: { phase: 'extracting', mode: 'historical', floorIds: ['floor-3'] } };
  view.render(state);
  const pause = flatten(container).find(node => node.textContent === '暂停重建');
  assert.equal(pause.disabled, false);
  pause.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pauses, 1);
});

test('runtime 通知会自动呈现；deactivate 停止重绘，重新 activate 恢复且不重复订阅', async () => {
  const base = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 0, unprocessedCount: 1, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint-1', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  let state = base, subscriptions = 0;
  const listeners = new Set();
  const runtime = {
    getState: () => state,
    refreshStatus: async () => state,
    confirmLatest: async () => state,
    subscribe(listener) { subscriptions += 1; listeners.add(listener); return () => listeners.delete(listener); },
  };
  const emit = next => { state = next; for (const listener of [...listeners]) listener(next); };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.mount(container);
  assert.equal(subscriptions, 1);
  assert.equal(listeners.size, 1);
  emit({ ...base, status: 'stale', stableCount: 1, headCheckpointId: 'checkpoint-1' });
  emit({ ...base, status: 'running', stableCount: 1, headCheckpointId: 'checkpoint-1' });
  emit({ ...base, status: 'ready', stableCount: 2, headCheckpointId: 'checkpoint-2' });
  assert.equal(subscriptions, 1, 'stale/running/ready 连续通知不应重复订阅');
  assert.equal(listeners.size, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /稳定 AI 楼\|2|checkpoint-2/);
  view.deactivate();
  assert.equal(listeners.size, 0);
  const inactiveRenderCount = container.replaceCount;
  emit({ ...base, stableCount: 3, headCheckpointId: 'checkpoint-3' });
  assert.equal(container.replaceCount, inactiveRenderCount, '隐藏视图不应继续重绘');
  await view.activate();
  assert.equal(subscriptions, 2);
  assert.equal(listeners.size, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /稳定 AI 楼\|3|checkpoint-3/);
  await view.activate();
  assert.equal(subscriptions, 2, '重复 activate 不应重复订阅');
  assert.equal(listeners.size, 1);
  const beforeSingleNotification = container.replaceCount;
  emit({ ...base, stableCount: 4, headCheckpointId: 'checkpoint-4' });
  assert.equal(container.replaceCount, beforeSingleNotification + 1, '单次通知只重绘一次');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /稳定 AI 楼\|4|checkpoint-4/);
});

test('activate 初始 stale 使用中性暂态文案，订阅 ready 后原地恢复且不残留身份误报', async () => {
  const base = { status: 'stale', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 0, unprocessedCount: 1, failedCount: 0, reviewCount: 0, pending: { assistantSeq: 2, messageIndex: 2 }, headCheckpointId: 'checkpoint-1', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  let state = base;
  const listeners = new Set();
  const runtime = {
    getState: () => state,
    refreshStatus: async () => state,
    confirmLatest: async () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.mount(container);
  await view.activate();
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /状态暂未收敛，正在等待最新结果/);
  assert.doesNotMatch(copy, /聊天已切换|聊天身份/);

  state = { ...base, status: 'ready', stableCount: 2, pending: { assistantSeq: 3, messageIndex: 3 }, headCheckpointId: 'checkpoint-2' };
  for (const listener of listeners) listener(state);
  copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /稳定 AI 楼\|2|checkpoint-2/);
  assert.doesNotMatch(copy, /状态暂未收敛|聊天已切换|聊天身份/);
  assert.equal(listeners.size, 1);
});

test('旧 runtime 没有 subscribe 时继续使用手动刷新兼容路径', async () => {
  const base = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 0, unprocessedCount: 1, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'old-1', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, floors: [] };
  let state = base;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef }); view.mount(container);
  state = { ...base, stableCount: 2, headCheckpointId: 'old-2' };
  assert.doesNotMatch(flatten(container).map(node => node.textContent).join('|'), /old-2/);
  await view.activate();
  assert.match(flatten(container).map(node => node.textContent).join('|'), /稳定 AI 楼\|2|old-2/);
  view.deactivate();
});

test('轻量召回运行结果自动显示实际注入、收据、阶段与覆盖；deactivate 后解除独立订阅', () => {
  const foundation = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 8, rememberedCount: 8, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'head', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: true, csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [], floors: [] };
  const foundationRuntime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  let recall = { recallStatus: 'idle', activeRecall: null, lastRecall: null, lastRecallError: null };
  const listeners = new Set();
  const recallRuntime = { getState: () => recall, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime: foundationRuntime, recallRuntime, documentRef });
  view.mount(container);
  assert.equal(listeners.size, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /轻量召回 · 本轮召回结果|下一次正文生成/);
  recall = {
    recallStatus: 'ready', activeRecall: null, lastRecallError: null,
    lastRecall: {
      status: 'ready', userMessageIndex: 67, createdAt: '2026-09-03T00:00:00.000Z', generationType: 'continue', reusedReceipt: true, receiptPersistence: 'persisted',
      selectedFloors: [{ assistantSeq: 2 }], selectedStates: [{ subject: '裴晚生', layer: 'core' }],
      coverage: { rememberedAiFloors: 8, stableAiFloors: 8, cseThroughAssistantSeq: 8 },
      stages: { input: 3, candidates: 8, dropRecent: 3, dropVisibility: 0, selected: 1 }, timings: { totalMs: 12, sourceReadAttempts: { reachableReads: 1, exitPoint: 'ready' } }, skipReasons: ['recentRawWindow'],
      injectionText: '<qqj_recalled_context>\n旧约仍然有效\n</qqj_recalled_context>', error: null,
    },
  };
  for (const listener of listeners) listener(recall);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /触发 user 楼|第 68 楼（user，宿主索引 67）|生成时间|生成类型|继续生成（continue）|复用 · persisted|AI #2|裴晚生 \/ core/);
  assert.match(copy, /输入 3 → 候选 8 → 去近期 3 → 去常驻重复 0 → 去越界 0 → 选中 1/);
  assert.match(copy, /完整快照 1 次 · 退出 读取成功/);
  assert.match(copy, /旧约仍然有效/);
  view.deactivate();
  assert.equal(listeners.size, 0);
});

test('召回区分无可靠命中与来源更新/不可用的安全跳过', () => {
  const foundation = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 1, unprocessedCount: 1, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'head', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  const runtime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  const container = new Node('main');
  let recall = { recallStatus: 'empty', activeRecall: null, lastRecallError: null, lastRecall: { status: 'empty', generationType: 'continue', reusedReceipt: false, receiptPersistence: 'none', selectedFloors: [], selectedStates: [], coverage: null, stages: null, timings: null, skipReasons: [], injectionText: '', error: null } };
  const listeners = new Set();
  const recallRuntime = { getState: () => recall, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const view = createV3FoundationView({ runtime, recallRuntime, documentRef });
  view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /完成 · 无需注入.*本轮没有需要注入的记忆/);
  for (const [reasons, copy] of [[['sourceStale'], '记忆来源正在更新'], [['sourceUnavailable'], '记忆来源暂不可用'], [['memoryRebuilding'], '历史记忆正在后台重建'], [['memoryNotReady', 'historicalRebuildRequired'], '当前存在历史记忆缺口']]) {
    recall = { recallStatus: 'skipped', activeRecall: null, lastRecallError: null, lastRecall: { ...recall.lastRecall, status: 'skipped', skipReasons: reasons } };
    for (const listener of listeners) listener(recall);
    const text = flatten(container).map(node => node.textContent).join('|');
    assert.match(text, new RegExp(copy));
    assert.doesNotMatch(text, /聊天身份/);
  }
});

test('召回归属旧字段缺失自然降级，重 Roll 使用中文标签且不拒绝正文', () => {
  const foundation = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 2, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'head', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, floors: [] };
  const runtime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  const recallState = { recallStatus: 'ready', activeRecall: null, lastRecallError: null, lastRecall: { status: 'ready', generationType: 'swipe', reusedReceipt: false, receiptPersistence: 'sessionOnly', selectedFloors: [], selectedStates: [], coverage: null, stages: null, timings: null, skipReasons: [], injectionText: '<qqj_recalled_context>旧格式仍展示</qqj_recalled_context>', error: null } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime: { getState: () => recallState }, documentRef });
  view.mount(container);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /触发 user 楼\|旧记录未提供.*生成时间\|旧记录未提供.*重 Roll（swipe）.*旧格式仍展示/);
});

test('Schema 4 只读历史缺少归属显示字段仍展示正文，并明确不代表本轮已注入', () => {
  const foundation = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 2, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'head', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, floors: [] };
  const runtime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  const recallState = { recallStatus: 'ready', activeRecall: null, lastRecallError: null, lastRecall: { status: 'ready', userMessageIndex: null, createdAt: null, generationType: null, reusedReceipt: false, restoredReceipt: true, legacyReadOnly: true, receiptPersistence: 'legacyReadOnly', selectedFloors: [], selectedStates: [], coverage: null, stages: null, timings: null, skipReasons: [], injectionText: '<qqj_recalled_context>Schema 4 旧正文</qqj_recalled_context>', error: null } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime: { getState: () => recallState }, documentRef });
  view.mount(container);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /旧版只读记录 · 不代表本轮已注入/);
  assert.match(copy, /触发 user 楼\|旧记录未提供.*生成时间\|旧记录未提供.*生成类型\|旧记录未提供/);
  assert.match(copy, /不会复用、注入或升级为当前 Schema 5 回执.*Schema 4 旧正文/);
});

test('activate 请求恢复已落盘回执，并明确标注历史展示、不重新注入与来源读取', async () => {
  const foundation = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 8, rememberedCount: 8, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'new-head', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: true, csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [], floors: [] };
  const runtime = { getState: () => foundation, refreshStatus: async () => foundation, confirmLatest: async () => foundation };
  let restores = 0;
  const recallState = {
    recallStatus: 'ready', activeRecall: null, lastRecallError: null,
    lastRecall: {
      status: 'ready', generationType: 'normal', reusedReceipt: false, restoredReceipt: true, receiptPersistence: 'persisted',
      selectedFloors: [{ assistantSeq: 2 }], selectedStates: [], coverage: { rememberedAiFloors: 6, stableAiFloors: 6, cseThroughAssistantSeq: 6 },
      stages: { input: 3, candidates: 6, dropRecent: 3, dropPersistent: 0, dropVisibility: 0, selected: 1 }, timings: null, skipReasons: [],
      injectionText: '<qqj_recalled_context>历史实际注入</qqj_recalled_context>', error: null,
    },
  };
  const recallRuntime = { getState: () => recallState, restorePersistedReceipt: async () => { restores += 1; return recallState; } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime, documentRef });
  view.mount(container);
  await view.activate();
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.equal(restores, 1);
  assert.match(copy, /最近一次召回结果|已落盘回执 · 恢复显示/);
  assert.match(copy, /仅恢复历史展示，不会再次注入|历史回执不重新读取来源|历史实际注入/);
});

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('地基刷新失败不吞掉已恢复回执，错误文案明确两条链独立', async () => {
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: null, activeRun: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => { throw new Error('模拟地基失败'); }, confirmLatest: async () => state };
  const receipt = { recallStatus: 'completed-empty', lastRecall: { status: 'completed-empty', restoredReceipt: true, selectedFloorIds: [], selectedFloors: [], skipReasons: [], coverage: null, stages: null, timings: null } };
  const recallRuntime = { getState: () => receipt, restorePersistedReceipt: async () => receipt };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime, documentRef });
  view.mount(container);
  await view.activate();
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /地基读取失败：模拟地基失败；历史召回回执已独立处理/);
  assert.match(copy, /轻量召回 · 最近一次召回结果/);
});

test('回执恢复失败只显示在召回区，不妨碍地基 ready', async () => {
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 0, unprocessedCount: 2, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const recallRuntime = { getState: () => ({ recallStatus: 'idle', lastRecall: null }), restorePersistedReceipt: async () => { throw new Error('模拟回执失败'); } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, recallRuntime, documentRef });
  view.mount(container);
  await view.activate();
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /地基与记忆状态已刷新/);
  assert.match(copy, /历史召回回执恢复失败：模拟回执失败；不影响地基读取/);
  assert.match(copy, /稳定 AI 楼\|2/);
});
