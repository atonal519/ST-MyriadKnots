import test from 'node:test';
import assert from 'node:assert/strict';
import { createV3FoundationView } from '../src/ui/v3-foundation-view.js';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ''; this.className = ''; this.disabled = false; this.replaceCount = 0; this.value = ''; this.open = false; this.selectionStart = 0; this.selectionEnd = 0; this.scrollLeft = 0; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.replaceCount += 1; this.children = [...nodes]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  click() { return this.listeners.click?.({ target: this, currentTarget: this, stopPropagation() {}, preventDefault() {} }); }
  fire(name, event = {}) { return this.listeners[name]?.({ target: this, currentTarget: this, stopPropagation() {}, preventDefault() {}, ...event }); }
  focus(options) { documentRef.activeElement = this; this.focusOptions = options; }
  contains(target) { return target === this || flatten(this).includes(target); }
  get classList() { return { add: value => { if (!this.className.split(' ').includes(value)) this.className += `${this.className ? ' ' : ''}${value}`; }, remove: value => { this.className = this.className.split(' ').filter(item => item && item !== value).join(' '); } }; }
}
const documentRef = { activeElement: null, createElement: tag => new Node(tag) };
function eventDocument() {
  const clicks = new Set();
  return {
    activeElement: null,
    createElement: tag => new Node(tag),
    addEventListener(name, handler) { if (name === 'click') clicks.add(handler); },
    removeEventListener(name, handler) { if (name === 'click') clicks.delete(handler); },
    click(event) { for (const handler of clicks) handler(event); },
    clickListenerCount: () => clicks.size,
  };
}
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
function peopleRuntime(candidates, selected = candidates.map(item => item.entityId)) {
  let state = { status: 'ready', selectedEntityIds: [...selected], people: candidates.map(item => ({ aliases: [], appearanceCount: 1, recommended: false, ...item, selected: selected.includes(item.entityId) })), active: null };
  return { getState: () => state, refresh: async () => state, setSelectedEntityIds: async ids => { state = { ...state, selectedEntityIds: [...ids], people: state.people.map(item => ({ ...item, selected: ids.includes(item.entityId) })) }; return state; } };
}

test('管理视图先显示壳并在激活时自动刷新，只在管理页提供手工刷新', async () => {
  let release;
  let refreshes = 0;
  const base = {
    status: 'idle', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT,
    foundationStatus: 'uninitialized', stableCount: 2, pending: { assistantSeq: 3, messageIndex: 5 },
    stableBoundary: { assistantSeq: 2 }, headCheckpointId: null, activeRun: null, lastRun: null,
    lastError: null, unreachableCount: 0, metrics: {},
  };
  const runtime = {
    getState: () => base,
    refreshStatus: () => { refreshes += 1; return new Promise(resolve => { release = () => resolve({ ...base, status: 'ready', foundationStatus: 'ready' }); }); },
    confirmLatest: async () => ({ ...base, status: 'ready', stableCount: 3, pending: null }),
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /记忆管理/);
  const activation = view.activate();
  assert.equal(refreshes, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /记忆管理/);
  release();
  await activation;
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /刷新状态/);
  assert.doesNotMatch(copy, /确认最新 AI 楼|提取下一个未处理楼|分析下一楼人物状态/);
  assert.match(copy, /继续.*完全重构/);
});

test('needsReview 终态显示准确中文和安全原因，不向页面泄露内部状态值', async () => {
  const memory = { chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = { status: 'needsReview', pluginEnabled: true, chatId: CHAT, foundationStatus: 'needsReview', reviewReason: { code: 'fingerprintMismatch', assistantSeq: 12, messageIndex: 23, expectedCount: 12, actualCount: 12 }, stableCount: 1, rememberedCount: 1, unprocessedCount: 0, pending: null, headCheckpointId: null, lastError: null, lastExtractorError: null, lastCseError: null, floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: 'needsReview 下仍可见的摘要', summarySource: 'ai', aiSummary: 'needsReview 下仍可见的摘要', counts: {}, memory }], memoryEntities: [{ entityId: 'p1', displayName: '裴晚生' }], cseSubjects: [{ subjectEntityId: 'p1', displayName: '裴晚生', core: [], adaptive: [], situational: [{ text: 'needsReview 下仍可见的人物状态', visibility: 'private', reason: '当时证据', sourceAssistantSeq: 1 }] }], memoryWorkBusy: false, cseReady: true, csePendingCount: 0, cseFailedCount: 0 };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, peopleRuntime: peopleRuntime([{ entityId: 'p1', displayName: '裴晚生' }]), documentRef }); view.mount(container); await view.activate();
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /需要核对当前聊天记忆/); assert.match(copy, /待核对原因.*楼正文指纹不一致.*第 23 楼.*记录 12 \/ 当前 12/); assert.match(copy, /最近记忆错误.*无/); assert.doesNotMatch(copy, /needsReview|fingerprintMismatch|AI序号/);
  view.setPage('memories'); assert.match(flatten(container).map(node => node.textContent).join('|'), /needsReview 下仍可见的摘要/);
  view.setPage('people'); assert.match(flatten(container).map(node => node.textContent).join('|'), /needsReview 下仍可见的人物状态/);
});

test('完整诊断必须显式确认，clipboard 不可用时显示可选择文本框', async () => {
  let confirmed = false;
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'ai', aiSummary: '摘要', extractorVersion: 'v', counts: {}, api: null, memory }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, copySafeDiagnostic: () => '{"safe":true}', copyFullDiagnostic: () => '{"canonicalContent":"原文"}' };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef, navigatorRef: {}, confirmImpl: () => confirmed }); view.mount(container);
  let full = flatten(container).find(node => node.textContent === '复制完整诊断'); full.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(flatten(container).some(node => node.className === 'v3-diagnostic-fallback'), false);
  confirmed = true; full = flatten(container).find(node => node.textContent === '复制完整诊断'); full.click(); await new Promise(resolve => setImmediate(resolve));
  const fallback = flatten(container).find(node => node.className === 'v3-diagnostic-fallback'); assert.match(fallback.value, /canonicalContent/);
});

test('没有摘要楼时仍可复制界面滚动诊断，并复用只读文本框fallback', async () => {
  const state = { status: 'idle', pluginEnabled: true, chatId: null, foundationStatus: 'uninitialized', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null, lastError: null, floors: [], rebuildStatus: 'caughtUp' };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let reads = 0;
  const uiDiagnosticProvider = () => { reads += 1; return '{"schemaVersion":1,"records":[]}'; };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, uiDiagnosticProvider, documentRef, navigatorRef: { clipboard: { writeText: async () => { throw new Error('clipboard denied'); } } } }); view.mount(container);
  const button = flatten(container).find(node => node.textContent === '复制界面诊断');
  assert.ok(button, '界面诊断入口不应依赖已存在的摘要楼');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /不含聊天正文或输入内容/);
  button.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  const fallback = flatten(container).find(node => node.className === 'v3-diagnostic-fallback');
  assert.equal(fallback?.readOnly, true); assert.match(fallback?.value ?? '', /"records":\[\]/);
});

test('四项破坏性记忆操作等待异步确认，取消时零业务动作', async () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'ai', aiSummary: '摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'ready', deltaId: 'delta' } };
  const state = { status: 'ready', pluginEnabled: true, chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: true, csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [], floors: [floor] };
  const calls = [];
  const runtime = {
    getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state,
    extractFloor: async () => { calls.push('extract'); return state; }, retryStateAnalysis: async () => { calls.push('cse'); return state; },
    fullRebuild: async () => { calls.push('rebuild'); return state; }, copyFullDiagnostic: () => { calls.push('full'); return '{}'; }, copySafeDiagnostic: () => '{}',
  };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef, confirmImpl: async () => false }); view.mount(container);
  view.setPage('memories'); flatten(container).find(node => node.textContent === '重新提取').click(); await new Promise(resolve => setImmediate(resolve));
  view.setPage('people'); flatten(container).find(node => node.textContent === '分析记录').click(); flatten(container).find(node => node.textContent === '重新分析').click(); await new Promise(resolve => setImmediate(resolve));
  view.setPage('management'); flatten(container).find(node => node.textContent === '完全重构').click(); await new Promise(resolve => setImmediate(resolve));
  flatten(container).find(node => node.textContent === '复制完整诊断').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
});

test('删除当前聊天记忆使用自绘异步确认，取消零写且确认说明保留边界', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'caughtUp', rebuildHasActionableWork: false, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let calls = 0, confirmation = null;
  const memoryManagement = { getState: () => ({ status: 'idle' }), deleteCurrent: async () => { calls += 1; return { status: 'completed' }; } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement, documentRef, confirmImpl: async options => { confirmation = options; return false; } });
  view.mount(container);
  flatten(container).find(node => node.textContent === '删除当前聊天记忆').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.match(confirmation.body, /摘要、人物状态、人物资料、召回记录及历史派生版本/);
  assert.match(confirmation.body, /聊天正文和全局 API、提示词设置会保留/);
  assert.match(confirmation.note, /移入回收站.*不代表永久擦除/);
});

test('删除按钮使用管理器统一忙碌投影', () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'caughtUp', rebuildHasActionableWork: false, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const memoryManagement = { getState: () => ({ status: 'idle', workBusy: true }), deleteCurrent: async () => ({ status: 'completed' }) };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement, documentRef }); view.mount(container);
  assert.equal(flatten(container).find(node => node.textContent === '删除当前聊天记忆').disabled, true);
});

test('删除部分失败后管理页保留同聊天继续入口，成功后呈空档反馈', async () => {
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, pending: null, activeRun: null, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'caughtUp', rebuildHasActionableWork: false, floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  let management = { status: 'idle', targetChatId: null, error: null }, attempts = 0;
  const listeners = new Set();
  const memoryManagement = {
    getState: () => management,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async deleteCurrent() {
      attempts += 1;
      if (attempts === 1) { management = { status: 'failed', targetChatId: CHAT, error: '版本冲突' }; for (const listener of listeners) listener(management); throw new Error('版本冲突'); }
      management = { status: 'completed', targetChatId: CHAT, error: null }; state = { ...state, status: 'idle', chatId: null, foundationStatus: 'uninitialized', stableCount: 0, rememberedCount: 0 }; for (const listener of listeners) listener(management); return management;
    },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, memoryManagement, documentRef, confirmImpl: async () => true }); view.mount(container);
  flatten(container).find(node => node.textContent === '删除当前聊天记忆').click(); await new Promise(resolve => setImmediate(resolve));
  assert.match(flatten(container).map(node => node.textContent).join('|'), /继续删除当前聊天记忆|已保留原聊天身份/);
  flatten(container).find(node => node.textContent === '继续删除当前聊天记忆').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /当前聊天记忆已清空/);
});

test('A删除失败后切到B重绘不会沿用A失败文案或禁用B的普通管理动作', () => {
  const stateA = { status: 'idle', pluginEnabled: true, chatId: CHAT, foundationStatus: 'uninitialized', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, activeRun: null, memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, rebuildStatus: 'pendingRebuild', rebuildHasActionableWork: true, floors: [] };
  const stateB = { ...stateA, status: 'ready', chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', foundationStatus: 'ready' };
  let current = stateA, currentManagement = { status: 'failed', targetChatId: CHAT, error: 'A版本冲突' };
  const runtime = { getState: () => current, refreshStatus: async () => current, confirmLatest: async () => current, startHistoricalRebuild: async () => current, fullRebuild: async () => current };
  const memoryManagement = { getState: () => currentManagement, deleteCurrent: async () => ({ status: 'completed' }) };
  const container = new Node('main'), view = createV3FoundationView({ runtime, memoryManagement, documentRef }); view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /继续删除当前聊天记忆|A版本冲突/);
  current = stateB; currentManagement = { status: 'idle', blockedByOtherChat: true }; view.render(current);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.doesNotMatch(copy, /继续删除当前聊天记忆|A版本冲突|已保留原聊天身份/);
  assert.equal(flatten(container).find(node => node.textContent === '继续').disabled, false, 'B普通记忆管理不应被A删除失败阻塞');
  assert.equal(flatten(container).find(node => node.textContent === '删除当前聊天记忆').disabled, true, '单一删除流程未收口前B不能另起删除');
});

test('Extractor 失败且尚无 FloorMemory 时仍可复制诊断并直接提取摘要', async () => {
  let extractedFloorId = null;
  let confirmations = 0;
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 0, unprocessedCount: 1, failedCount: 1, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, lastRun: null, lastError: null, lastExtractorError: { message: '失败' }, unreachableCount: 0, metrics: {}, floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'failed', memoryId: null, summary: '', counts: {}, error: '失败', memory: null }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async floorId => { extractedFloorId = floorId; return state; }, copySafeDiagnostic: () => '{"safe":true}', copyFullDiagnostic: () => '{"sessionCandidate":{}}' };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef, navigatorRef: {}, confirmImpl: () => { confirmations += 1; return true; } }); view.mount(container);
  const copy = flatten(container).map(node => node.textContent); assert.ok(copy.includes('复制安全诊断')); assert.ok(copy.includes('复制完整诊断'));
  view.setPage('memories');
  const card = flatten(container).find(node => String(node.className).includes('qqj-memory-card'));
  assert.equal(card.open, false);
  assert.match(flatten(card).map(node => node.textContent).join('|'), /第 2 楼.*时间未明确.*失败可重试.*暂无摘要.*⋮.*提取摘要.*失败/);
  const extract = flatten(container).find(node => node.textContent === '提取摘要');
  assert.ok(extract); assert.equal(extract.disabled, false);
  extract.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(extractedFloorId, 'floor');
  assert.equal(confirmations, 0, '无摘要楼的首次提取不是破坏性操作，不弹重提确认');
});

test('面板顶部显示 CSE 分层状态、原因/来源与待分析重试入口，不创建楼内聊天渲染', async () => {
  let nextCalls = 0, retryCalls = 0;
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 1, cseFailedCount: 0, baselineId: 'baseline', mainCharacterEntityId: 'character', mainCharacterDisplayName: '林岚', cseSubjects: [{ subjectEntityId: 'character', displayName: '林岚', core: [{ text: '谨慎', reason: '角色设定', visibility: 'authorial', sourceAssistantSeq: 1 }], adaptive: [{ text: '保持戒备', reason: '发生冲突', visibility: 'observable', towardDisplayName: '裴晚生', sourceAssistantSeq: 1 }], situational: [{ text: '紧张', reason: '雨夜危险', visibility: 'private', sourceAssistantSeq: 1 }] }], floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'ai', aiSummary: '摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'pending', deltaId: null } }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, analyzeNextState: async () => { nextCalls += 1; return state; }, retryStateAnalysis: async () => { retryCalls += 1; return state; } };
  const sharedPeople = peopleRuntime([{ entityId: 'character', displayName: '林岚', entityDisplayName: '林岚' }]);
  const container = new Node('main'); const view = createV3FoundationView({ runtime, peopleRuntime: sharedPeople, documentRef }); view.setPage('people'); view.mount(container);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /核心特质|长期倾向|当前情境|谨慎|保持戒备|紧张/);
  assert.equal(flatten(container).some(node => String(node.className).includes('qqj-v3-floor-card')), false);
  flatten(container).find(node => node.textContent === '分析记录').click();
  flatten(container).find(node => node.textContent === '分析本楼').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextCalls, 0); assert.equal(retryCalls, 1);
});

test('CSE 失败数、本楼错误与最近错误在 V3 面板可见，并保留独立重试', async () => {
  let retries = 0;
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: { message: '安全 CSE 错误' }, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 0, cseFailedCount: 1, baselineId: 'baseline', cseSubjects: [], floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'ai', aiSummary: '摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'failed', deltaId: null, error: '本楼状态失败' } }] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, analyzeNextState: async () => state, retryStateAnalysis: async () => { retries += 1; return state; } };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef }); view.setPage('people'); view.mount(container); flatten(container).find(node => node.textContent === '分析记录').click();
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /0 待分析 · 1 失败/);
  assert.match(copy, /安全 CSE 错误/);
  assert.match(copy, /本楼状态失败/);
  flatten(container).find(node => node.textContent === '重试分析').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retries, 1);
});

test('千结与双丝网健康提示只显示各自进度和错误', () => {
  const state = { status: 'running', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 4, rememberedCount: 3, unprocessedCount: 1,
    memoryWorkBusy: true, activeMemoryWork: { phase: 'analyzingCse' }, activeExtraction: null, activeCse: { floorId: 'floor', phase: 'analyzing' },
    lastError: null, lastExtractorError: { message: '摘要错误' }, lastCseError: { message: '状态错误' }, cseReady: false, csePendingCount: 2, cseFailedCount: 1,
    selectedEntityIds: [], cseSubjects: [], floors: [], rebuildStatus: 'pendingRebuild' };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: peopleRuntime([], []), documentRef });
  view.setPage('memories'); view.mount(container);
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /摘要提取失败 · 摘要错误/); assert.doesNotMatch(copy, /状态错误|正在分析人物状态/);
  view.setPage('people'); copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /正在分析人物状态 · 待分析 2 楼/); assert.doesNotMatch(copy, /摘要错误/);
  view.setPage('memories'); view.render({ ...state, activeMemoryWork: { phase: 'revising' }, activeCse: null, lastExtractorError: null, lastCseError: null });
  copy = flatten(container).map(node => node.textContent).join('|'); assert.match(copy, /正在处理摘要 · 3\/4 楼/);
  view.setPage('people'); view.render({ ...state, activeMemoryWork: null, activeCse: null, lastError: { message: '共享读取失败' }, lastCseError: null });
  copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /人物状态需要处理 · 共享记忆：共享读取失败/); assert.doesNotMatch(copy, /摘要错误/);
});

test('双丝网页会显示激活期间的共享刷新失败', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0,
    activeMemoryWork: null, activeExtraction: null, activeCse: null, lastError: null, lastExtractorError: null, lastCseError: null,
    cseReady: true, csePendingCount: 0, cseFailedCount: 0, selectedEntityIds: [], cseSubjects: [], floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => { throw new Error('共享暂不可用'); }, confirmLatest: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: peopleRuntime([], []), documentRef });
  view.setPage('people'); view.mount(container); await view.activate();
  assert.match(flatten(container).map(node => node.textContent).join('|'), /记忆读取失败：共享暂不可用；历史召回回执已独立处理/);
});

test('所有用户可见楼号统一使用零基 messageIndex，非均匀楼层不猜 AI 序号', () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floors = [
    { floorId: 'floor-zero', assistantSeq: 1, messageIndex: 0, status: 'ready', memoryId: 'memory-zero', summary: '零楼摘要', summarySource: 'ai', aiSummary: '零楼摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'ready', deltaId: 'delta-zero' } },
    { floorId: 'floor-two', assistantSeq: 2, messageIndex: 2, status: 'ready', memoryId: 'memory-two', summary: '二楼摘要', summarySource: 'ai', aiSummary: '二楼摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'ready', deltaId: 'delta-two' } },
    { floorId: 'floor-five', assistantSeq: 3, messageIndex: 5, status: 'ready', memoryId: 'memory-five', summary: '五楼摘要', summarySource: 'ai', aiSummary: '五楼摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'ready', deltaId: 'delta-five' } },
  ];
  const state = {
    status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 3, rememberedCount: 3, unprocessedCount: 0, failedCount: 0, reviewCount: 0,
    pending: { assistantSeq: 3, messageIndex: 5 }, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: { floorId: 'floor-two', phase: 'extracting' }, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null,
    lastRun: null, lastAutoMemory: { status: 'completed', fromAssistantSeq: 1, toAssistantSeq: 3 }, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: true,
    csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', rebuildStatus: 'pendingRebuild', rebuildCompletedCount: 1, rebuildTotalCount: 3, rebuildNextAssistantSeq: 2,
    mainCharacterEntityId: 'character', mainCharacterDisplayName: '裴晚生', cseSubjects: [{ subjectEntityId: 'character', displayName: '裴晚生', core: [
      { text: '来源以 floorId 为准', reason: '证据', visibility: 'observable', origin: 'delta', sourceFloorId: 'floor-zero', sourceAssistantSeq: 3 },
      { text: '失配不能退回序号', reason: '证据', visibility: 'observable', origin: 'delta', sourceFloorId: 'missing-floor', sourceAssistantSeq: 2 },
    ], adaptive: [], situational: [] }], floors,
  };
  const recallRuntime = { getState: () => ({ recallStatus: 'ready', activeRecall: null, lastRecall: {
    status: 'ready', userMessageIndex: 4, createdAt: '2026-09-05T00:00:00.000Z', generationType: 'normal', receiptPersistence: 'persisted', selectedStates: [], injectionText: '已注入', skipReasons: [],
    selectedFloors: [{ floorId: 'floor-zero', assistantSeq: 99 }, { assistantSeq: 2 }, { floorId: 'missing-floor', assistantSeq: 3 }],
    coverage: { rememberedAiFloors: 3, stableAiFloors: 3, cseThroughAssistantSeq: 2 }, stages: null, timings: null,
  } }) };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state };
  const container = new Node('main');
  const selectedPeople = peopleRuntime([{ entityId: 'character', displayName: '裴晚生', entityDisplayName: '裴晚生' }]);
  const view = createV3FoundationView({ runtime, recallRuntime, peopleRuntime: selectedPeople, documentRef });
  view.setPage('memories'); view.mount(container);
  let visible = flatten(container).map(node => node.textContent).filter(Boolean);
  assert.deepEqual(flatten(container).filter(node => node.className === 'qqj-floor-number').map(node => node.textContent), ['第 5 楼', '第 2 楼', '第 0 楼']);
  view.setPage('people');
  visible = flatten(container).map(node => node.textContent).filter(Boolean);
  assert.ok(visible.includes('裴晚生'), '当前人物状态继续按人物实体显示');
  view.setPage('management');
  visible = flatten(container).map(node => node.textContent).filter(Boolean);
  assert.ok(visible.includes('第 4 楼'), '触发用户楼不得 +1');
  assert.ok(visible.includes('第 0 楼、第 2 楼、来源楼号未提供'));
  assert.ok(visible.includes('记忆 3/3 · CSE 到第 2 楼'));
  assert.equal(visible.some(value => /AI #|宿主楼|宿主索引/.test(value)), false);
});

test('已完成人物状态可确认后重新分析，取消不调用且忙碌时禁用', async () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floors = [
    { floorId: 'floor-ready', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory-ready', summary: '摘要一', summarySource: 'ai', aiSummary: '摘要一', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'ready', deltaId: 'delta-ready' } },
    { floorId: 'floor-no-change', assistantSeq: 2, messageIndex: 4, status: 'ready', memoryId: 'memory-no-change', summary: '摘要二', summarySource: 'ai', aiSummary: '摘要二', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'noChange', deltaId: 'delta-no-change' } },
  ];
  const base = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 2, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: true, csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [], floors };
  let state = base;
  const retries = [];
  const confirmations = [];
  let confirmed = true;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, retryStateAnalysis: async floorId => { retries.push(floorId); return state; } };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef, confirmImpl: message => { confirmations.push(message); return confirmed; } });
  view.setPage('people'); view.mount(container);
  flatten(container).find(node => node.textContent === '分析记录').click();

  let buttons = flatten(container).filter(node => node.textContent === '重新分析');
  assert.equal(buttons.length, 2, 'ready 与 noChange 楼层都应显示入口');
  buttons[0].click();
  await new Promise(resolve => setImmediate(resolve));
  buttons = flatten(container).filter(node => node.textContent === '重新分析');
  buttons[1].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(retries, ['floor-no-change', 'floor-ready'], '逐楼记录按最新楼在前操作同一 floorId');
  assert.equal(confirmations.length, 2);
  assert.match(`${confirmations[0].title} ${confirmations[0].body}`, /重新分析人物状态.*后续楼层人物状态需依次重算.*摘要保持不变/);

  confirmed = Promise.resolve(false);
  flatten(container).find(node => node.textContent === '重新分析').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(retries, ['floor-no-change', 'floor-ready'], '取消后不得调用 runtime');

  state = { ...base, memoryWorkBusy: true };
  view.render(state);
  buttons = flatten(container).filter(node => node.textContent === '重新分析');
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.equal(button.disabled, true);
});

test('自动批次活跃时面板提取、CSE 与修订入口统一禁用，结束后恢复', () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const base = { status: 'running', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 1, failedCount: 0, reviewCount: 0, pending: { assistantSeq: 2, messageIndex: 3 }, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: true, activeAutoMemory: { phase: 'reconciling', floorIds: ['floor'] }, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, cseReady: false, csePendingCount: 1, cseFailedCount: 0, baselineId: 'baseline', cseSubjects: [], floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 2, status: 'ready', memoryId: 'memory', summary: '摘要', summarySource: 'user', aiSummary: 'AI 摘要', extractorVersion: 'v', counts: {}, api: null, memory, cse: { status: 'pending', deltaId: null } }] };
  let state = base;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractNext: async () => state, extractFloor: async () => state, editSummary: async () => state, restoreAi: async () => state, markError: async () => state, analyzeNextState: async () => state, retryStateAnalysis: async () => state, fullRebuild: async () => state };
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef }); view.mount(container);
  assert.equal(flatten(container).find(node => node.textContent === '完全重构')?.disabled, true);
  view.setPage('memories');
  for (const label of ['编辑', '重新提取']) assert.equal(flatten(container).find(node => node.textContent === label)?.disabled, true, label);
  view.setPage('people');
  flatten(container).find(node => node.textContent === '分析记录').click();
  assert.equal(flatten(container).find(node => node.textContent === '分析本楼')?.disabled, true);
  state = { ...base, status: 'ready', memoryWorkBusy: false, activeAutoMemory: null };
  view.render(state);
  assert.equal(flatten(container).find(node => node.textContent === '分析本楼')?.disabled, false);
  view.setPage('memories');
  for (const label of ['编辑', '重新提取']) assert.equal(flatten(container).find(node => node.textContent === label)?.disabled, false, label);
  view.setPage('management');
  assert.equal(flatten(container).find(node => node.textContent === '完全重构')?.disabled, false);
});

test('历史欠账与 CSE 重构按钮各自开始暂停继续，CSE 同一位置显示进度', async () => {
  const base = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 5, rememberedCount: 2, unprocessedCount: 3, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: 'checkpoint', activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, autoMemoryEnabled: false, autoMemoryBatchSize: 2, rebuildStatus: 'pendingRebuild', rebuildCompletedCount: 2, rebuildTotalCount: 5, rebuildNextAssistantSeq: 3, cseRebuildStatus: 'idle', cseRebuildCompletedCount: 0, cseRebuildTotalCount: 2, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  let state = base, starts = 0, pauses = 0, resetChatId = null, cseChatId = null, csePauses = 0, cseResumes = 0;
  const confirmations = [];
  const runtime = {
    getState: () => state,
    refreshStatus: async () => state,
    confirmLatest: async () => state,
    startHistoricalRebuild: async () => { starts += 1; return state; },
    pauseHistoricalRebuild: () => { pauses += 1; return state; }, fullRebuild: async chatId => { resetChatId = chatId; return state; },
    rebuildCse: async chatId => { cseChatId = chatId; return state; },
    pauseCseRebuild: () => { csePauses += 1; return state; },
    resumeCseRebuild: async chatId => { cseResumes += 1; cseChatId = chatId; return state; },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef, confirmImpl: options => { confirmations.push(options); return true; } });
  view.mount(container);
  state = { ...base, rememberedCount: 0, rebuildCompletedCount: 0, rebuildNextAssistantSeq: 1 };
  view.render(state);
  assert.equal(flatten(container).find(node => node.textContent === '继续')?.disabled, false);
  state = base;
  view.render(state);
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /自动维护新楼\|已关闭/);
  assert.match(copy, /历史重建\|等待开始 · 2\/5/);
  assert.match(copy, /记忆尚未完整.*刷新页面不会自动续跑/);
  const resume = flatten(container).find(node => node.textContent === '继续');
  assert.equal(resume.disabled, false);
  resume.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  flatten(container).find(node => node.textContent === '完全重构').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resetChatId, CHAT, '完全重构必须携带用户当前看到的聊天 ID');
  const actionLabels = flatten(container).filter(node => node.tag === 'button').map(node => node.textContent);
  assert.ok(actionLabels.indexOf('CSE 重构') === actionLabels.indexOf('完全重构') + 1, 'CSE 重构固定放在完全重构旁边');
  flatten(container).find(node => node.textContent === 'CSE 重构').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cseChatId, CHAT);
  assert.match(`${confirmations.at(-1)?.body}`, /摘要及摘要人工修订都会保留.*CSE 人工纠正也会被覆盖.*未摘要楼不会处理/);

  state = { ...base, status: 'running', memoryWorkBusy: true, activeAutoMemory: { phase: 'analyzingCse', mode: 'cseRebuild', floorIds: ['floor-2'] }, cseRebuildStatus: 'running', cseRebuildCompletedCount: 1, cseRebuildTotalCount: 2 };
  view.render(state);
  const pauseCse = flatten(container).find(node => node.textContent === '暂停 CSE 重构');
  assert.equal(pauseCse.disabled, false); pauseCse.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(csePauses, 1); assert.match(flatten(container).map(node => node.textContent).join('|'), /CSE 重构中 · 1\/2/);
  state = { ...base, cseRebuildStatus: 'paused', cseRebuildCompletedCount: 1, cseRebuildTotalCount: 2 };
  view.render(state);
  assert.equal(flatten(container).filter(node => node.textContent === '继续 CSE 重构').length, 1, '暂停态只保留同一枚 CSE 按钮');
  assert.equal(flatten(container).some(node => node.textContent === '继续'), false, '通用历史继续不得接管 CSE 作业');
  flatten(container).find(node => node.textContent === '继续 CSE 重构').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(cseResumes, 1); assert.equal(cseChatId, CHAT);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /CSE 已暂停 · 1\/2/);

  state = { ...base, rebuildStatus: 'waitingRealtime', rebuildHasActionableWork: true };
  view.render(state);
  assert.equal(flatten(container).find(node => node.textContent === '继续')?.disabled, false, '等待新楼状态下仍有稳定欠账时继续必须可用');
  state = { ...state, status: 'running', memoryWorkBusy: true, activeMemoryWork: { phase: 'analyzingCse' } };
  view.render(state);
  const busyAction = flatten(container).find(node => node.textContent === '正在分析人物状态');
  assert.ok(busyAction); assert.equal(busyAction.disabled, true, '真实任务忙碌时仍保留并发锁并显示阶段');
  state = { ...base, rebuildStatus: 'waitingRealtime', rebuildHasActionableWork: false };
  view.render(state);
  assert.equal(flatten(container).find(node => node.textContent === '继续')?.disabled, true, '确实没有稳定待办时继续才置灰');

  state = { ...base, status: 'running', memoryWorkBusy: true, rebuildStatus: 'rebuilding', activeAutoMemory: { phase: 'extracting', mode: 'historical', floorIds: ['floor-3'] } };
  view.render(state);
  const pause = flatten(container).find(node => node.textContent === '暂停');
  assert.equal(pause.disabled, false);
  pause.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pauses, 1);
});

test('地基视图固定显示每楼更新，旧批次 20 不再生效', () => {
  const base = { status: 'ready', pluginEnabled: true, compatibilityMode: 'standard', chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, failedCount: 0, reviewCount: 0, pending: null, headCheckpointId: null, activeRun: null, activeExtraction: null, activeCse: null, memoryWorkBusy: false, activeAutoMemory: null, lastAutoMemory: null, lastRun: null, lastError: null, lastExtractorError: null, lastCseError: null, unreachableCount: 0, metrics: {}, autoMemoryEnabled: true, rebuildStatus: 'caughtUp', rebuildCompletedCount: 0, rebuildTotalCount: 0, rebuildNextAssistantSeq: null, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: null, cseSubjects: [], floors: [] };
  const runtime = { getState: () => base, refreshStatus: async () => base, confirmLatest: async () => base };
  const container = new Node('main');
  const selectedPeople = peopleRuntime([{ entityId: 'character', displayName: '裴晚生', entityDisplayName: '裴晚生' }]);
  const view = createV3FoundationView({ runtime, peopleRuntime: selectedPeople, documentRef });
  view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /自动维护新楼\|已开启 · 每楼更新/);
  view.render({ ...base, autoMemoryBatchSize: 20 });
  assert.match(flatten(container).map(node => node.textContent).join('|'), /自动维护新楼\|已开启 · 每楼更新/);
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
  assert.match(flatten(container).map(node => node.textContent).join('|'), /checkpoint-2/);
  view.deactivate();
  assert.equal(listeners.size, 0);
  const inactiveRenderCount = container.replaceCount;
  emit({ ...base, stableCount: 3, headCheckpointId: 'checkpoint-3' });
  assert.equal(container.replaceCount, inactiveRenderCount, '隐藏视图不应继续重绘');
  await view.activate();
  assert.equal(subscriptions, 2);
  assert.equal(listeners.size, 1);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /checkpoint-3/);
  await view.activate();
  assert.equal(subscriptions, 2, '重复 activate 不应重复订阅');
  assert.equal(listeners.size, 1);
  const beforeSingleNotification = container.replaceCount;
  emit({ ...base, stableCount: 4, headCheckpointId: 'checkpoint-4' });
  assert.equal(container.replaceCount, beforeSingleNotification + 1, '单次通知只重绘一次');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /checkpoint-4/);
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
  assert.match(copy, /正在等待最新结果/);
  assert.doesNotMatch(copy, /聊天已切换|聊天身份/);

  state = { ...base, status: 'ready', stableCount: 2, pending: { assistantSeq: 3, messageIndex: 3 }, headCheckpointId: 'checkpoint-2' };
  for (const listener of listeners) listener(state);
  copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /checkpoint-2/);
  assert.doesNotMatch(copy, /聊天已切换|聊天身份/);
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
  assert.match(flatten(container).map(node => node.textContent).join('|'), /old-2/);
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
  assert.match(flatten(container).map(node => node.textContent).join('|'), /最近召回回执|下一次正文生成/);
  recall = {
    recallStatus: 'ready', activeRecall: null, lastRecallError: null,
    lastRecall: {
      status: 'ready', userMessageIndex: 67, createdAt: '2026-09-03T00:00:00.000Z', generationType: 'continue', reusedReceipt: true, receiptPersistence: 'persisted',
      selectedFloors: [{ assistantSeq: 2 }], selectedStates: [{ subject: '裴晚生', layer: 'core' }], selectedCseChanges: [{ subject: '裴晚生', layer: 'situational', action: 'remove', assistantSeq: 2 }],
      coverage: { rememberedAiFloors: 8, stableAiFloors: 8, cseThroughAssistantSeq: 8 },
      stages: { input: 3, candidates: 8, dropRecent: 3, dropVisibility: 0, selected: 1 }, timings: { totalMs: 12, sourceReadAttempts: { reachableReads: 1, exitPoint: 'ready' } }, skipReasons: ['recentRawWindow'],
      injectionText: '<qqj_recalled_context>\n旧约仍然有效\n</qqj_recalled_context>', error: null,
    },
  };
  for (const listener of listeners) listener(recall);
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /触发用户楼|第 67 楼|生成时间|生成类型|继续生成（continue）|复用 · persisted|来源楼号未提供|终点楼号未提供|裴晚生 \/ core|裴晚生 \/ situational \/ 移除/);
  assert.match(copy, /输入 3 → 记忆楼 8 → 去近期 3 → 去常驻重复 0 → 去越界 0 → 选中楼 1/);
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
  assert.match(copy, /触发用户楼\|旧记录未提供.*生成时间\|旧记录未提供.*重 Roll（swipe）.*旧格式仍展示/);
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
  assert.match(copy, /触发用户楼\|旧记录未提供.*生成时间\|旧记录未提供.*生成类型\|旧记录未提供/);
  assert.match(copy, /不会复用、注入或升级为当前 Schema 10 回执.*Schema 4 旧正文/);
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

test('三页职责分离，千结只保留摘要编辑/重提，双丝网归位人物与逐楼 CSE，管理页不混摘要', () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const state = {
    status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0,
    pending: null, headCheckpointId: 'head', lastError: null, lastExtractorError: null, lastCseError: null, cseReady: true, csePendingCount: 0, cseFailedCount: 0,
    baselineId: 'baseline', mainCharacterEntityId: 'character', mainCharacterDisplayName: '裴晚生',
    cseSubjects: [{ subjectEntityId: 'character', displayName: '裴晚生', core: [{ text: '克制', reason: '基线', visibility: 'authorial', origin: 'baseline' }], adaptive: [], situational: [] }],
    floors: [{ floorId: 'floor', assistantSeq: 1, messageIndex: 4, canonicalFingerprint: 'sha256:same', status: 'ready', memoryId: 'memory', summary: '剧情摘要', summarySource: 'ai', memory, cse: { status: 'ready', deltaId: 'delta' } }],
  };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, retryStateAnalysis: async () => state, copySafeDiagnostic: () => '{}', copyFullDiagnostic: () => '{}' };
  const container = new Node('main');
  const selectedPeople = peopleRuntime([{ entityId: 'character', displayName: '裴晚生', entityDisplayName: '裴晚生' }]);
  const view = createV3FoundationView({ runtime, peopleRuntime: selectedPeople, documentRef });
  view.setPage('memories'); view.mount(container);
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /已记忆 1\/1 楼.*第 4 楼.*剧情摘要.*编辑.*重新提取/);
  assert.doesNotMatch(copy, /逐楼校对故事摘要/);
  assert.equal(flatten(container).some(node => node.tag === 'h2' && node.textContent === '千结'), false);
  assert.doesNotMatch(copy, /状态分析记录|详细诊断|恢复 AI|标记错误/);
  assert.doesNotMatch(copy, /刷新状态/);
  view.setPage('people'); copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /关系往来.*裴晚生.*核心特质/);
  assert.doesNotMatch(copy, /剧情摘要|复制完整诊断/);
  assert.doesNotMatch(copy, /刷新状态/);
  flatten(container).find(node => node.textContent === '分析记录').click(); copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /分析记录.*重新分析/);
  view.setPage('management'); copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /记忆管理.*继续.*完全重构.*最近召回回执.*详细诊断/);
  assert.match(copy, /刷新状态/);
  assert.doesNotMatch(copy, /剧情摘要|重新提取/);
  for (const button of flatten(container).filter(node => node.tag === 'button')) assert.equal(button.type, 'button');
});

test('管理页刷新状态按钮只发起 fresh 读取', async () => {
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 0, rememberedCount: 0, unprocessedCount: 0, pending: null, headCheckpointId: 'head', lastError: null, lastExtractorError: null, lastCseError: null, floors: [], memoryWorkBusy: false };
  const calls = [];
  const runtime = { getState: () => state, refreshStatus: async options => { calls.push(options); return state; }, confirmLatest: async () => state };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef });
  view.setPage('management'); view.mount(container);
  const button = flatten(container).find(node => node.textContent === '刷新状态');
  assert.ok(button);
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [{ preferCached: false }]);
});

test('同聊天记忆同步保留千结与双丝网已确认文字，确认结果或切聊后再替换', () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 4, canonicalFingerprint: 'sha256:same', status: 'ready', memoryId: 'memory', summary: '同步期间必须保留的摘要', summarySource: 'ai', memory, cse: { status: 'ready', deltaId: 'delta' } };
  const ready = {
    status: 'ready', memorySnapshotStatus: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0,
    memoryWorkBusy: false, activeAutoMemory: null, activeExtraction: null, activeCse: null, cseReady: true, csePendingCount: 0, cseFailedCount: 0,
    mainCharacterEntityId: 'character', mainCharacterDisplayName: '裴晚生',
    cseSubjects: [{ subjectEntityId: 'character', displayName: '裴晚生', core: [{ text: '同步期间必须保留的人物状态', reason: '已确认', visibility: 'authorial', origin: 'baseline' }], adaptive: [], situational: [] }],
    floors: [floor],
  };
  let state = ready;
  const listeners = new Set();
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, retryStateAnalysis: async () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const emit = next => { state = next; for (const listener of listeners) listener(next); };
  const selectedPeople = peopleRuntime([{ entityId: 'character', displayName: '裴晚生', entityDisplayName: '裴晚生' }]);
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: selectedPeople, documentRef });
  view.setPage('memories'); view.mount(container);
  const memoryTree = container.children[0];
  emit({ ...ready, status: 'ready', memorySnapshotStatus: 'syncing', memoryWorkBusy: false, floors: [], cseSubjects: [] });
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.equal(container.children[0], memoryTree, '同步通知不得重建或清空当前页面 DOM');
  assert.match(copy, /已记忆 1\/1 楼.*后台同步中.*同步期间必须保留的摘要/);
  assert.equal(flatten(container).find(node => node.textContent === '重新提取').disabled, true, '依赖快照的动作必须禁用');

  view.setPage('people');
  copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /同步期间必须保留的人物状态/, '同步期间切换到双丝网页仍显示同聊天上次确认结果');

  const confirmedEmpty = { ...ready, memorySnapshotStatus: 'ready', stableCount: 0, rememberedCount: 0, floors: [], cseSubjects: [] };
  emit(confirmedEmpty); copy = flatten(container).map(node => node.textContent).join('|');
  assert.doesNotMatch(copy, /同步期间必须保留的人物状态|同步期间必须保留的摘要/, '已确认覆盖回退后必须替换旧显示');

  emit({ ...ready, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', memorySnapshotStatus: 'syncing', floors: [], cseSubjects: [] });
  copy = flatten(container).map(node => node.textContent).join('|');
  assert.doesNotMatch(copy, /同步期间必须保留的人物状态|同步期间必须保留的摘要/, '切聊天时不得保留上一聊天投影');
});

test('摘要楼默认折叠，折叠条显示楼号/时间/真实状态，展开后显示正文与人物地点并从内联菜单编辑', async () => {
  const entityId = '11111111-1111-4111-8111-111111111111';
  const memory = { summaryEvidenceRefs: [], chronology: [{ itemId: 'time-1', time: { sourceText: '10月4日 周二 15:30' }, description: '开场' }], locations: [{ itemId: 'place-1', name: '钟楼' }], participants: [{ entityId, presence: 'present' }], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  let saved = null;
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 2, canonicalFingerprint: 'sha256:canonical', rawFingerprint: 'sha256:raw', status: 'ready', memoryId: 'memory', summary: '钟楼相见', summarySource: 'ai', memory, cse: { status: 'ready', deltaId: 'delta' } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, memoryEntities: [{ entityId, displayName: '裴晚生' }], floors: [floor] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editMemory: async (...args) => { saved = args; return state; } };
  const menuDocument = eventDocument();
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef: menuDocument }); view.setPage('memories'); view.mount(container);
  const card = flatten(container).find(node => String(node.className).includes('qqj-memory-card'));
  assert.equal(card.tag, 'details'); assert.equal(card.open, false);
  const copy = flatten(card).map(node => node.textContent).join('|');
  assert.match(copy, /第 2 楼.*10月4日 周二 15:30.*可用.*钟楼相见.*人物.*裴晚生.*地点.*钟楼.*⋮.*编辑.*重新提取/);
  assert.ok(copy.indexOf('钟楼相见') < copy.indexOf('人物') && copy.indexOf('人物') < copy.indexOf('地点'));
  assert.doesNotMatch(copy, /在场|远程参与|被提及/);
  const menu = flatten(card).find(node => node.className === 'qqj-memory-menu'); assert.equal(menu.tag, 'details'); assert.equal(menu.open, false);
  menu.open = true; menuDocument.click({ target: menu, composedPath: () => [menu] }); assert.equal(menu.open, true, '菜单内部点击不提前关闭');
  menuDocument.click({ target: container, composedPath: () => [container] }); assert.equal(menu.open, false, '千结菜单点击外部后关闭');
  card.open = true; card.fire('toggle'); flatten(card).find(node => node.textContent === '编辑').click();
  const summary = flatten(container).find(node => node.placeholder === '输入用户修订摘要'); summary.value = '修订后摘要'; summary.fire('input');
  const time = flatten(container).find(node => node.placeholder === '日期、时间范围或相对时间'); time.value = '次日'; time.fire('input'); time.value = '10月4日 周二 15:30'; time.fire('input');
  flatten(container).find(node => node.textContent === '保存').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved[0], 'floor'); assert.equal(saved[1].summary, '修订后摘要');
  assert.equal(saved[1].timeText, '10月4日 周二 15:30'); assert.equal(saved[1].originalTimeText, '10月4日 周二 15:30'); assert.equal(saved[1].timeChanged, false); assert.equal(saved[1].locations[0].itemId, 'place-1');
  assert.deepEqual(saved[1].participantNames, ['裴晚生']);
  assert.equal(flatten(container).find(node => String(node.className).includes('qqj-memory-card')).open, true);
  view.deactivate(); assert.equal(menuDocument.clickListenerCount(), 0, '页面停用时清理外部点击监听');
});

test('未处理空楼保留恢复入口，长时间仅由样式省略且长摘要原文完整保留', () => {
  const longTime = `冬至后的第七个雨夜 · ${'很长的时间描述'.repeat(12)}`;
  const longSummary = `开头。${'这是一段必须完整保留的楼层摘要。'.repeat(80)}结尾。`;
  const memory = { summaryEvidenceRefs: [], chronology: [{ time: { sourceText: longTime } }], locations: [], participants: [] };
  const floors = [
    { floorId: 'ready', messageIndex: 8, status: 'ready', memoryId: 'memory', summary: longSummary, memory, cse: { status: 'ready' } },
    { floorId: 'empty', messageIndex: 6, status: 'unprocessed', memoryId: null, summary: '', timeFallback: '时间仍待提取', memory: null },
  ];
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 1, unprocessedCount: 1, cseReady: false, csePendingCount: 0, cseFailedCount: 0, floors };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  const cards = flatten(container).filter(node => String(node.className).split(' ').includes('qqj-memory-card'));
  const readyCard = cards.find(node => flatten(node).some(child => child.textContent === '第 8 楼'));
  const emptyCard = cards.find(node => flatten(node).some(child => child.textContent === '第 6 楼'));
  assert.equal(flatten(readyCard).find(node => node.className === 'qqj-floor-time').textContent, longTime);
  assert.equal(flatten(readyCard).find(node => node.className === 'qqj-memory-main').textContent, longSummary);
  assert.match(flatten(emptyCard).map(node => node.textContent).join('|'), /未处理.*这一楼尚未生成摘要.*提取摘要/);
});

test('未修改、改回原值与未动时间 fallback 直接退出编辑并保持展开，零保存调用', async () => {
  const memory = { summary: { revisionNote: '旧说明' }, summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floor = { floorId: 'floor', messageIndex: 18, canonicalFingerprint: 'sha256:content', rawFingerprint: 'sha256:raw', memoryId: 'memory', status: 'ready', summary: '原摘要', timeFallback: '10月4日 15:30', memory, cse: { status: 'ready', deltaId: 'delta' } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor] };
  let saves = 0;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, editMemory: async () => { saves += 1; return state; } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  let card = flatten(container).find(node => String(node.className).includes('qqj-memory-card')); card.open = true; card.fire('toggle');
  flatten(container).find(node => node.textContent === '编辑').click();
  const summary = flatten(container).find(node => node.placeholder === '输入用户修订摘要'); summary.value = '临时修改'; summary.fire('input'); summary.value = '原摘要'; summary.fire('input');
  assert.equal(flatten(container).find(node => node.placeholder === '日期、时间范围或相对时间').value, '10月4日 15:30');
  flatten(container).find(node => node.textContent === '保存').click(); await new Promise(resolve => setImmediate(resolve));
  card = flatten(container).find(node => String(node.className).includes('qqj-memory-card'));
  assert.equal(saves, 0); assert.equal(card.open, true); assert.equal(flatten(container).some(node => node.placeholder === '输入用户修订摘要'), false);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /未修改内容/);
});

test('保存等待中用户主动收起时，完成后退出编辑但不重新展开', async () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floor = { floorId: 'floor', messageIndex: 18, canonicalFingerprint: 'sha256:content', rawFingerprint: 'sha256:raw', memoryId: 'memory', status: 'ready', summary: '原摘要', memory, cse: { status: 'ready', deltaId: 'delta' } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor] };
  let resolveSave;
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, editMemory: () => new Promise(resolve => { resolveSave = resolve; }) };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  let card = flatten(container).find(node => String(node.className).includes('qqj-memory-card')); card.open = true; card.fire('toggle');
  flatten(container).find(node => node.textContent === '编辑').click();
  const summary = flatten(container).find(node => node.placeholder === '输入用户修订摘要'); summary.value = '新摘要'; summary.fire('input');
  flatten(container).find(node => node.textContent === '保存').click();
  card = flatten(container).find(node => String(node.className).includes('qqj-memory-card')); card.open = false; card.fire('toggle');
  resolveSave(state); await new Promise(resolve => setImmediate(resolve));
  card = flatten(container).find(node => String(node.className).includes('qqj-memory-card'));
  assert.equal(card.open, false); assert.equal(flatten(container).some(node => node.placeholder === '输入用户修订摘要'), false);
});

test('CSE 历史每楼只显示实际变化，并可折叠查看该楼结束状态与部分隔离提示', () => {
  const memory = { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [] };
  const floor = { floorId: 'floor', messageIndex: 2, memoryId: 'memory', status: 'ready', summary: '摘要', memory, cse: { status: 'ready', deltaId: 'delta', record: { noMaterialChange: false, isolationSummary: { count: 2, codes: ['V3_CSE_REVIEW_TARGET_AMBIGUOUS'] }, subjects: [{ displayName: '裴晚生', changeSummary: ['被拒的模型自报'], changes: [
    { category: 'adaptive', action: 'refine', beforeText: '会谨慎回应', afterText: '会谨慎回应', before: { text: '会谨慎回应', towardDisplayName: '甲', visibility: 'private', reason: '旧依据', origin: 'floor' }, after: { text: '会谨慎回应', towardDisplayName: '乙', visibility: 'observable', reason: '新依据', origin: 'floor' } },
    { category: 'situational', action: 'update', beforeText: '仍在门边', afterText: '已经落座', before: { text: '仍在门边', visibility: 'observable', reason: '站在门边', origin: 'floor' }, after: { text: '已经落座', visibility: 'observable', reason: '坐到桌旁', origin: 'floor' } },
    { category: 'situational', action: 'remove', beforeText: '仍在等雨停', afterText: null, before: { text: '仍在等雨停', visibility: 'observable', reason: '雨还没停', origin: 'floor' }, after: null },
  ] }], endStateSubjects: [{ displayName: '裴晚生', core: [{ text: '重视承诺', visibility: 'authorial', reason: '角色卡设定', origin: 'baseline', sourceFloorId: null }], adaptive: [{ text: '会谨慎回应', towardDisplayName: '乙', visibility: 'observable', reason: '新依据', origin: 'floor', sourceFloorId: 'floor' }], situational: [{ text: '已经落座', visibility: 'observable', reason: '坐到桌旁', origin: 'floor', sourceFloorId: 'floor' }] }] } } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, cseSubjects: [], floors: [floor] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, retryStateAnalysis: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('people'); view.mount(container);
  flatten(container).find(node => node.textContent === '分析记录').click();
  const rowNode = flatten(container).find(node => node.className === 'qqj-cse-history-row');
  assert.equal(rowNode.tag, 'details'); assert.equal(rowNode.open, false);
  const copy = flatten(rowNode).map(node => node.textContent).join('|');
  const resultCopy = flatten(rowNode).find(node => node.className === 'qqj-cse-floor-result').children[1];
  assert.match(flatten(resultCopy).map(node => node.textContent).join('|'), /长期倾向：会谨慎回应.*当前情境：已经落座/);
  assert.doesNotMatch(flatten(resultCopy).map(node => node.textContent).join('|'), /重视承诺|仍在门边|仍在等雨停|甲/);
  assert.match(copy, /裴晚生.*当前情境更新：仍在门边 → 已经落座/);
  assert.match(copy, /长期倾向属性更新：会谨慎回应.*对象：甲 → 乙.*信息范围：私密 → 可观察.*依据：旧依据 → 新依据/);
  assert.match(copy, /移除当前情境：仍在等雨停/);
  assert.match(copy, /部分内容未通过校验，已保留有效结果（2 项校验记录）/);
  assert.match(copy, /查看本楼完整状态.*核心特质.*重视承诺.*长期倾向.*对 乙.*会谨慎回应.*当前情境.*已经落座/);
  assert.equal(flatten(rowNode).find(node => node.className === 'qqj-cse-floor-state').open, false);
  assert.doesNotMatch(copy, /被拒的模型自报/);
  rowNode.open = true; rowNode.fire('toggle'); view.setPage('memories'); view.setPage('people');
  assert.equal(flatten(container).find(node => node.className === 'qqj-cse-history-row').open, true);
});

test('CSE 完整隔离不伪造成功，旧楼缺诊断字段不冒充零隔离', () => {
  const memory = { summaryEvidenceRefs: [] };
  const isolatedFloor = { floorId: 'isolated', messageIndex: 4, memoryId: 'memory-1', status: 'ready', summary: '摘要', memory, cse: { status: 'noChange', deltaId: 'delta-1', record: { noMaterialChange: true, isolationSummary: { count: 1, codes: ['V3_CSE_SUBJECT_UNBOUND'] }, subjects: [], endStateSubjects: [] } } };
  const legacyFloor = { floorId: 'legacy', messageIndex: 2, memoryId: 'memory-2', status: 'ready', summary: '摘要', memory, cse: { status: 'noChange', deltaId: 'delta-2', record: { noMaterialChange: true, isolationSummary: null, subjects: [], endStateSubjects: [] } } };
  const state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 2, rememberedCount: 2, cseReady: true, csePendingCount: 0, cseFailedCount: 0, cseSubjects: [], floors: [legacyFloor, isolatedFloor] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, retryStateAnalysis: async () => state };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('people'); view.mount(container);
  flatten(container).find(node => node.textContent === '分析记录').click();
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /有内容未通过校验；本楼未产生人物状态变化（1 项校验记录）/);
  assert.equal((copy.match(/校验记录/g) ?? []).length, 1, '旧楼缺诊断字段应保持未知，不显示为零');
});

test('摘要编辑时后台通知只更新健康栏并保留原节点、焦点与光标；取消使用后台最新状态，切聊天清草稿', () => {
  const memory = { summaryEvidenceRefs: [] };
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 2, canonicalFingerprint: 'sha256:same', status: 'ready', memoryId: 'memory', summary: '原摘要', summarySource: 'ai', memory, cse: { status: 'ready', deltaId: 'delta' } };
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor] };
  const listeners = new Set();
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editSummary: async () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const emit = next => { state = next; for (const listener of listeners) listener(next); };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑').click();
  const input = flatten(container).find(node => node.tag === 'textarea');
  input.value = '未保存草稿'; input.selectionStart = 4; input.selectionEnd = 4; input.fire('input'); input.focus();
  const replaceCount = container.replaceCount;
  emit({ ...state, status: 'running', stableCount: 2, memoryWorkBusy: true, activeMemoryWork: { phase: 'extracting' }, rebuildCompletedCount: 1, rebuildTotalCount: 2, floors: [{ ...floor, summary: '后台新摘要' }] });
  assert.equal(container.replaceCount, replaceCount, '同楼后台通知不能替换编辑中的摘要 DOM');
  assert.equal(documentRef.activeElement, input); assert.equal(input.selectionStart, 4); assert.equal(input.value, '未保存草稿');
  for (const label of ['保存', '取消']) assert.equal(flatten(container).find(node => node.textContent === label).disabled, true, `busy 时原 ${label} 按钮必须及时禁用`);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /正在处理摘要 · 1\/2 楼/);
  emit({ ...state, status: 'ready', memoryWorkBusy: false });
  for (const label of ['保存', '取消']) assert.equal(flatten(container).find(node => node.textContent === label).disabled, false, `busy 结束后原 ${label} 按钮必须恢复`);
  flatten(container).find(node => node.textContent === '取消').click();
  assert.equal(flatten(container).some(node => node.tag === 'textarea'), false);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /后台新摘要/);

  flatten(container).find(node => node.textContent === '编辑').click();
  const chatTwo = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  emit({ ...state, chatId: chatTwo, floors: [{ ...floor, summary: '新聊天摘要' }] });
  assert.equal(flatten(container).some(node => node.tag === 'textarea'), false, '切聊天后旧草稿不可串档');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /新聊天摘要/);
});

test('视图停用期间同聊天正文改变后，重新激活仍按永久楼身份保留编辑草稿', async () => {
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 2, canonicalFingerprint: 'sha256:old', status: 'ready', memoryId: 'memory', summary: '旧正文摘要', summarySource: 'ai', memory: { summaryEvidenceRefs: [] }, cse: { status: 'ready', deltaId: 'delta' } };
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor] };
  const saves = [];
  const runtime = {
    getState: () => state,
    refreshStatus: async () => state,
    confirmLatest: async () => state,
    extractFloor: async () => state,
    editSummary: async (...args) => { saves.push(args); return state; },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑').click();
  const staleInput = flatten(container).find(node => node.tag === 'textarea');
  staleInput.value = '不可错存的旧草稿'; staleInput.fire('input');
  view.deactivate();
  state = { ...state, floors: [{ ...floor, canonicalFingerprint: 'sha256:new', summary: '重 Roll 后的新摘要' }] };
  await view.activate();
  assert.equal(flatten(container).some(node => node.tag === 'textarea'), true);
  assert.equal(flatten(container).find(node => node.tag === 'textarea').value, '不可错存的旧草稿');
  assert.equal(saves.length, 0);
});

test('隐藏时间戳改变但永久楼身份相同时保留编辑草稿', async () => {
  const floor = { floorId: 'floor', assistantSeq: 1, messageIndex: 2, canonicalFingerprint: 'sha256:same', rawFingerprint: 'sha256:old', status: 'ready', memoryId: 'memory', summary: '旧时间摘要', summarySource: 'ai', memory: { summaryEvidenceRefs: [], chronology: [], locations: [], participants: [] }, cse: { status: 'ready', deltaId: 'delta' } };
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [floor] };
  const listeners = new Set(), runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, extractFloor: async () => state, editMemory: async () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const container = new Node('main'), view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑').click(); assert.ok(flatten(container).some(node => node.tag === 'textarea'));
  state = { ...state, floors: [{ ...floor, rawFingerprint: 'sha256:new' }] };
  for (const listener of listeners) listener(state);
  assert.equal(flatten(container).some(node => node.tag === 'textarea'), true);
});

test('保存等待期间切换聊天会使旧响应失效，不回绘旧聊天', async () => {
  const oldFloor = { floorId: 'old-floor', assistantSeq: 1, messageIndex: 2, canonicalFingerprint: 'sha256:old', status: 'ready', memoryId: 'old-memory', summary: '旧聊天摘要', summarySource: 'ai', memory: { summaryEvidenceRefs: [] }, cse: { status: 'ready', deltaId: 'old-delta' } };
  const newFloor = { ...oldFloor, floorId: 'new-floor', memoryId: 'new-memory', canonicalFingerprint: 'sha256:new', summary: '新聊天摘要' };
  const oldState = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, unprocessedCount: 0, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [oldFloor] };
  const newState = { ...oldState, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', floors: [newFloor] };
  let state = oldState, resolveSave;
  const listeners = new Set();
  const runtime = {
    getState: () => state,
    refreshStatus: async () => state,
    confirmLatest: async () => state,
    extractFloor: async () => state,
    editSummary: () => new Promise(resolve => { resolveSave = resolve; }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const container = new Node('main');
  const view = createV3FoundationView({ runtime, documentRef }); view.setPage('memories'); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑').click();
  const summary = flatten(container).find(node => node.placeholder === '输入用户修订摘要'); summary.value = '未保存草稿'; summary.fire('input');
  flatten(container).find(node => node.textContent === '保存').click();
  state = newState; for (const listener of [...listeners]) listener(newState);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /新聊天摘要/);
  flatten(container).find(node => node.textContent === '编辑').click();
  const newDraft = flatten(container).find(node => node.placeholder === '输入用户修订摘要'); newDraft.value = '新聊天未保存草稿'; newDraft.fire('input');
  resolveSave(oldState); await new Promise(resolve => setImmediate(resolve));
  const copy = flatten(container).map(node => node.textContent).join('|');
  assert.equal(flatten(container).find(node => node.placeholder === '输入用户修订摘要').value, '新聊天未保存草稿');
  assert.doesNotMatch(copy, /旧聊天摘要/);
});

test('重要人物缺少 CSE 时显示常显空态，更多人物同行入口与选择跨切页保留', async () => {
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: false, csePendingCount: 0, cseFailedCount: 0, baselineId: 'baseline', mainCharacterEntityId: 'character', mainCharacterDisplayName: '裴晚生', cseSubjects: [], floors: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const sharedPeople = peopleRuntime([{ entityId: 'character', displayName: '裴晚生', entityDisplayName: '裴晚生' }, { entityId: 'npc', displayName: '旁人', entityDisplayName: '旁人' }], ['character']);
  const container = new Node('main'); const view = createV3FoundationView({ runtime, peopleRuntime: sharedPeople, documentRef }); view.setPage('people'); view.mount(container);
  assert.match(flatten(container).map(node => node.textContent).join('|'), /裴晚生.*还没有已保存的状态分析/);
  const own = flatten(container).find(node => node.className === 'qqj-relation-note');
  assert.equal(own.tag, 'section'); assert.equal(flatten(own).some(node => node.tag === 'summary'), false, '选中人物自身状态常显且没有无用箭头');
  const switchRow = flatten(container).find(node => node.className === 'qqj-relation-switch-row');
  assert.ok(flatten(switchRow).find(node => node.textContent === '更多人物（1）'), '更多人物入口与关注人物在同一行');
  flatten(switchRow).find(node => node.textContent === '更多人物（1）').click();
  assert.equal(flatten(container).filter(node => node.className === 'qqj-profile-picker qqj-cse-more').length, 1);
  state = { ...state, cseSubjects: [
    { subjectEntityId: 'character', displayName: '裴晚生', core: [], adaptive: [], situational: [] },
    { subjectEntityId: 'npc', displayName: '旁人', core: [], adaptive: [], situational: [] },
  ] };
  view.render(state);
  flatten(container).find(node => node.textContent === '设为重要').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sharedPeople.getState().selectedEntityIds, ['character', 'npc']);
  flatten(container).find(node => node.textContent === '返回关系').click();
  view.setPage('memories'); view.setPage('people');
  assert.match(flatten(container).map(node => node.textContent).join('|'), /裴晚生.*旁人/);
  assert.equal(flatten(container).find(node => node.className === 'qqj-relation-note').tag, 'section');
});

test('双丝网人名横条同聊天同列表重绘保留位置，列表或聊天变化重置', async () => {
  const userId = '10000000-0000-4000-8000-000000000001';
  const aId = '20000000-0000-4000-8000-000000000002';
  const bId = '30000000-0000-4000-8000-000000000003';
  const cId = '40000000-0000-4000-8000-000000000004';
  let state = { status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [], memoryEntities: [{ entityId: userId, displayName: '你', specialRole: 'user' }], cseSubjects: [] };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const sharedPeople = peopleRuntime([{ entityId: aId, displayName: '甲' }, { entityId: bId, displayName: '乙' }, { entityId: cId, displayName: '丙' }], [aId, bId, cId]);
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: sharedPeople, documentRef }); view.setPage('people'); view.mount(container);
  let switcher = flatten(container).find(node => node.className === 'qqj-relation-switcher');
  switcher.scrollLeft = 67;
  flatten(switcher).find(node => node.textContent === '丙').click();
  switcher = flatten(container).find(node => node.className === 'qqj-relation-switcher');
  assert.equal(switcher.scrollLeft, 67); assert.match(flatten(container).find(node => node.className === 'qqj-relation-card').textContent + flatten(container).map(node => node.textContent).join('|'), /丙/);

  switcher.scrollLeft = 79; state = { ...state, stableCount: 2 }; view.render(state);
  switcher = flatten(container).find(node => node.className === 'qqj-relation-switcher');
  assert.equal(switcher.scrollLeft, 79, '同人物列表的后台刷新应保留横向位置');
  flatten(container).find(node => node.textContent === '更多人物（0）').click();
  assert.equal(flatten(container).find(node => node.className === 'qqj-relation-switcher').scrollLeft, 79);
  flatten(container).find(node => node.textContent === '返回关系').click();
  assert.equal(flatten(container).find(node => node.className === 'qqj-relation-switcher').scrollLeft, 79);

  await sharedPeople.setSelectedEntityIds([aId, cId]); view.render(state);
  switcher = flatten(container).find(node => node.className === 'qqj-relation-switcher');
  assert.equal(switcher.scrollLeft, 0, '人物有序列表变化后不得继承旧位置');
  switcher.scrollLeft = 43; state = { ...state, chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }; view.render(state);
  assert.equal(flatten(container).find(node => node.className === 'qqj-relation-switcher').scrollLeft, 0, '切聊天必须重置横向位置');
});

test('双丝网精确区分双方关系、自身状态与选中 NPC 的其他关系', () => {
  const userId = '10000000-0000-4000-8000-000000000001', aId = '20000000-0000-4000-8000-000000000002', bId = '30000000-0000-4000-8000-000000000003', cId = '40000000-0000-4000-8000-000000000004';
  const state = {
    status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [],
    currentStateId: '50000000-0000-4000-8000-000000000005', currentStateFingerprint: `sha256:${'a'.repeat(64)}`,
    memoryEntities: [{ entityId: userId, displayName: '你', specialRole: 'user' }, { entityId: aId, displayName: '左佐' }, { entityId: bId, displayName: '乙' }, { entityId: cId, displayName: '一个非常非常长的未关注人物名字' }],
    cseSubjects: [
      { subjectEntityId: userId, displayName: '你', core: [], adaptive: [{ text: '你对乙的态度不应重复在左佐页', towardEntityId: bId }], situational: [{ text: '此刻担心左佐', towardEntityId: aId }, { text: '用户自身疲惫', towardEntityId: null }] },
      { subjectEntityId: aId, displayName: '左佐', core: [{ text: '谨慎' }], adaptive: [{ text: '会保护你', towardEntityId: userId }, { text: '会偿还你的恩情', towardEntityId: userId }, { text: '对乙保持警惕', towardEntityId: bId }, { text: '习惯独自复盘', towardEntityId: null }], situational: [{ text: '正在门外等候', towardEntityId: null }, { text: '此刻等你回应', towardEntityId: userId }, { text: '正在观察乙', towardEntityId: bId }] },
      { subjectEntityId: bId, displayName: '乙', core: [], adaptive: [{ text: '乙对左佐的态度不应混入', towardEntityId: aId }], situational: [] },
    ],
  };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state, correctSubjectState: async () => state };
  const sharedPeople = peopleRuntime([{ entityId: aId, displayName: '左佐' }, { entityId: bId, displayName: '乙' }, { entityId: cId, displayName: '一个非常非常长的未关注人物名字' }], [aId, bId]);
  const menuDocument = eventDocument();
  const container = new Node('main'), view = createV3FoundationView({ runtime, peopleRuntime: sharedPeople, documentRef: menuDocument }); view.setPage('people'); view.mount(container);
  const userAnchorCopy = flatten(container).find(node => node.className === 'qqj-user-anchor').children.flatMap(flatten).map(node => node.textContent).join('|');
  assert.match(userAnchorCopy, /用户自身疲惫/); assert.doesNotMatch(userAnchorCopy, /此刻担心左佐/, '有对象的用户情境只显示在关系方向中');
  const pair = flatten(container).find(node => node.className === 'qqj-relation-card'), pairCopy = flatten(pair).map(node => node.textContent).join('|');
  assert.match(pairCopy, /你 → 左佐.*当前态度.*此刻担心左佐.*左佐 → 你.*当前态度.*此刻等你回应.*长期相处方式.*会保护你.*会偿还你的恩情/);
  const pairHead = flatten(pair).find(node => node.className === 'qqj-relation-head'), pairMenu = pairHead.children.at(-1);
  assert.equal(pairMenu.tag, 'details'); assert.equal(pairMenu.className, 'qqj-memory-menu qqj-relation-menu');
  assert.equal(pairMenu.children[0].tag, 'summary'); assert.equal(pairMenu.children[0].textContent, '⋮'); assert.equal(pairMenu.children[0].attributes['aria-label'], '关系操作');
  assert.deepEqual(flatten(pairMenu).filter(node => node.tag === 'button').map(node => node.textContent), ['编辑状态', '移出重要']);
  pairMenu.open = true; menuDocument.click({ target: pairMenu.children[0], composedPath: () => [pairMenu.children[0], pairMenu] }); assert.equal(pairMenu.open, true, '关系菜单内部点击不提前关闭');
  menuDocument.click({ target: container, composedPath: () => [container] }); assert.equal(pairMenu.open, false, '关系菜单点击外部后关闭');
  const own = flatten(container).find(node => node.className === 'qqj-relation-note'), ownCopy = flatten(own).map(node => node.textContent).join('|');
  assert.equal(own.tag, 'section'); assert.match(ownCopy, /谨慎.*习惯独自复盘.*正在门外等候/); assert.doesNotMatch(ownCopy, /会保护你|会偿还你的恩情|对乙保持警惕|此刻等你回应|正在观察乙/);
  const others = flatten(container).find(node => node.className === 'qqj-other-relations'), otherCopy = flatten(others).map(node => node.textContent).join('|');
  assert.match(otherCopy, /左佐与其他人物.*左佐 → 乙.*当前态度.*正在观察乙.*长期相处方式.*对乙保持警惕/); assert.doesNotMatch(otherCopy, /你对乙|乙对左佐/);
  assert.equal(pair.children.at(-1), own, '自身状态融入关系卡内部底部');
  assert.equal(flatten(own).some(node => node.className === 'v3-memory-status'), false, '页脚不再重复状态胶囊');
  flatten(pairMenu).find(node => node.textContent === '编辑状态').click();
  assert.equal(flatten(container).some(node => node.className === 'qqj-memory-menu qqj-relation-menu'), false, '编辑态没有操作项时不保留空菜单');
  assert.deepEqual(flatten(container).filter(node => node.tag === 'button' && ['保存', '取消'].includes(node.textContent)).map(node => node.textContent), ['保存', '取消']);
  flatten(container).find(node => node.textContent === '取消').click();
  const switchRow = flatten(container).find(node => node.className === 'qqj-relation-switch-row'); flatten(switchRow).find(node => node.textContent === '更多人物（1）').click();
  assert.match(flatten(container).find(node => node.className === 'qqj-profile-picker qqj-cse-more').textContent + flatten(container).map(node => node.textContent).join('|'), /一个非常非常长的未关注人物名字/);
  view.deactivate(); assert.equal(menuDocument.clickListenerCount(), 0);
});

test('双丝网按实体 ID 展示已有 user 状态，且空状态关系卡仍可从菜单移出重要', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const characterId = '22222222-2222-4222-8222-222222222222';
  let state = {
    status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1,
    cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [],
    memoryEntities: [{ entityId: userId, displayName: '林岚', specialRole: 'user' }, { entityId: characterId, displayName: '裴晚生', specialRole: 'char' }],
    cseSubjects: [{ subjectEntityId: userId, displayName: '林岚', core: [{ text: '冷静', reason: '已有状态', visibility: 'authorial' }], adaptive: [], situational: [] }],
  };
  const runtime = { getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state };
  const sharedPeople = peopleRuntime([{ entityId: characterId, displayName: '裴晚生', entityDisplayName: '裴晚生' }], []);
  const container = new Node('main'); const view = createV3FoundationView({ runtime, peopleRuntime: sharedPeople, documentRef }); view.setPage('people'); view.mount(container);
  let copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /林岚.*冷静.*尚未选择重要人物.*更多人物（1）/);
  const anchor = flatten(container).find(node => node.className === 'qqj-user-anchor');
  assert.equal(flatten(anchor).some(node => ['设为重要', '移出重要'].includes(node.textContent)), false, 'user 状态不提供千人选择操作');

  state = { ...state, cseSubjects: [] }; view.render(state); copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /尚未选择重要人物/); assert.doesNotMatch(copy, /林岚.*人物状态/);
  sharedPeople.setSelectedEntityIds([characterId]);
  state = { ...state, cseSubjects: [{ subjectEntityId: userId, displayName: '林岚', core: [], adaptive: [], situational: [] }] };
  view.render(state); copy = flatten(container).map(node => node.textContent).join('|');
  assert.match(copy, /林岚.*裴晚生/); assert.doesNotMatch(copy, /尚未选择重要人物|暂无人物状态/);
  const menu = flatten(container).find(node => node.className === 'qqj-memory-menu qqj-relation-menu');
  assert.deepEqual(flatten(menu).filter(node => node.tag === 'button').map(node => node.textContent), ['移出重要']);
  flatten(menu).find(node => node.textContent === '移出重要').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sharedPeople.getState().selectedEntityIds, []); assert.match(flatten(container).map(node => node.textContent).join('|'), /尚未选择重要人物/);
});

test('人物状态编辑保存期间冻结全部草稿控件并复制输入，成功留在抽屉、失败保留草稿', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const targetId = '55555555-5555-4555-8555-555555555555';
  let state = {
    status: 'ready', pluginEnabled: true, chatId: CHAT, foundationStatus: 'ready', stableCount: 1, rememberedCount: 1,
    memoryWorkBusy: false, activeMemoryWork: null, activeCse: null, cseReady: true, csePendingCount: 0, cseFailedCount: 0, floors: [],
    currentStateId: '22222222-2222-4222-8222-222222222222', currentStateFingerprint: `sha256:${'a'.repeat(64)}`,
    cseTowardCandidates: [{ entityId: userId, displayName: '林岚' }, { entityId: targetId, displayName: '左佐' }],
    memoryEntities: [{ entityId: userId, displayName: '林岚', specialRole: 'user' }, { entityId: targetId, displayName: '左佐' }],
    cseSubjects: [{ subjectEntityId: userId, displayName: '林岚', core: [], adaptive: [], situational: [{ id: '33333333-3333-4333-8333-333333333333', text: '紧张', reason: '正文', visibility: 'private', towardEntityId: null }] }],
  };
  let pending = null;
  const calls = [];
  const runtime = {
    getState: () => state, refreshStatus: async () => state, confirmLatest: async () => state,
    correctSubjectState: (subjectEntityId, payload) => {
      calls.push({ subjectEntityId, payload });
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    },
  };
  const infoCalls = [];
  const container = new Node('main'); const view = createV3FoundationView({ runtime, documentRef, infoImpl: options => { infoCalls.push(options); return true; } }); view.setPage('people'); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑我的状态').click();
  let editor = flatten(container).find(node => node.className === 'qqj-cse-edit');
  assert.equal(flatten(editor).some(node => node.tag === 'select'), false, 'CSE 信息范围与对象不得使用手机原生选择器');
  let situational = flatten(editor).find(node => node.placeholder === '当前情境内容');
  situational.value = '已经平静'; situational.fire('input');
  const situationalTarget = flatten(editor).find(node => node.attributes?.['aria-label'] === '当前情境对象');
  situationalTarget.click(); flatten(editor).find(node => node.attributes?.['data-value'] === targetId).click();
  flatten(editor).find(node => node.className === 'qqj-cse-help').click();
  assert.equal(infoCalls.length, 1); assert.match(`${infoCalls[0].body}\n${infoCalls[0].note}`, /不是上传或隐私权限.*私密：.*已表达：.*可观察：.*共享：.*作者设定：/s);
  assert.equal(situational.value, '已经平静', '打开信息范围帮助不得重建或清空编辑草稿');
  flatten(editor).find(node => node.textContent === '保存').click();
  assert.equal(calls.length, 1); assert.equal(calls[0].subjectEntityId, userId);
  assert.equal(calls[0].payload.situational[0].towardEntityId, targetId, '当前情境对象下拉须进入同一保存 payload');
  assert.ok(flatten(editor).filter(node => ['textarea', 'select', 'button'].includes(node.tag)).every(node => node.disabled === true), '异步保存期间全部输入、选择与增删按钮都应禁用');
  situational.value = '迟到改动'; situational.fire('input');
  assert.equal(calls[0].payload.situational[0].text, '已经平静', '本次保存使用点击时复制的草稿，不被迟到输入改写');
  state = { ...state, currentStateId: '44444444-4444-4444-8444-444444444444', currentStateFingerprint: `sha256:${'b'.repeat(64)}`, cseSubjects: [{ ...state.cseSubjects[0], situational: [{ ...state.cseSubjects[0].situational[0], text: '已经平静', towardEntityId: targetId, origin: 'manual', reason: '用户纠正当前状态' }] }] };
  pending.resolve(state); await new Promise(resolve => setImmediate(resolve));
  assert.equal(flatten(container).some(node => node.className === 'qqj-cse-edit'), false);
  assert.ok(flatten(container).find(node => node.className === 'qqj-user-anchor'), '保存成功后用户状态仍常显');

  flatten(container).find(node => node.textContent === '编辑我的状态').click();
  editor = flatten(container).find(node => node.className === 'qqj-cse-edit');
  situational = flatten(editor).find(node => node.placeholder === '当前情境内容');
  situational.value = '失败时保留'; situational.fire('input');
  flatten(editor).find(node => node.textContent === '保存').click();
  pending.reject(new Error('模拟写入失败')); await new Promise(resolve => setImmediate(resolve));
  editor = flatten(container).find(node => node.className === 'qqj-cse-edit');
  assert.ok(editor); assert.match(flatten(editor).map(node => node.textContent).join('|'), /保存失败：模拟写入失败/);
  assert.equal(flatten(editor).find(node => node.placeholder === '当前情境内容').value, '失败时保留');
  assert.ok(flatten(editor).filter(node => ['textarea', 'select', 'button'].includes(node.tag)).every(node => node.disabled === false), '保存失败后同一草稿恢复可编辑');
});

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
  assert.match(copy, /记忆读取失败：模拟地基失败；历史召回回执已独立处理/);
  assert.match(copy, /最近一次召回结果/);
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
  assert.match(copy, /记忆状态已刷新/);
  assert.match(copy, /历史召回回执恢复失败：模拟回执失败；不影响记忆读取/);
  assert.match(copy, /已记忆 0\/2 楼/);
});
