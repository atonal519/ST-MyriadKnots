import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { createMigrationDescriptor } from '../src/v3/migration-prefix.js';
import { createV3FoundationView } from '../src/ui/v3-foundation-view.js';
import { projectInlineMemoryFloor } from '../src/ui/inline-projection.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const OLD_TIME = '2026年8月3日 09:10';
const LIVE_TIME = '2026年10月15日 14:20';
const FROZEN_ID = '33333333-3333-4333-8333-333333333333';
const LIVE_ID = '44444444-4444-4444-8444-444444444444';

class ViewNode {
  constructor(tag, documentRef) {
    this.tag = tag; this.documentRef = documentRef; this.children = []; this.listeners = {}; this.textContent = '';
    this.className = ''; this.disabled = false; this.value = ''; this.open = false; this.attributes = {};
  }
  append(...nodes) { for (const node of nodes) { this.children.push(node); if (node instanceof ViewNode) node.parentNode = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  fire(name, event = {}) { let result; for (const handler of this.listeners[name] ?? []) result = handler({ target: this, currentTarget: this, stopPropagation() {}, preventDefault() {}, ...event }); return result; }
  click() { return this.fire('click'); }
  focus() { this.documentRef.activeElement = this; }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1))) return node; return null; }
  getBoundingClientRect() { return { top: 0, bottom: 100, height: 100 }; }
  descendants() { return this.children.flatMap(child => child instanceof ViewNode ? [child, ...child.descendants()] : []); }
  querySelector(selector) {
    const nodes = this.descendants();
    if (selector.startsWith('.')) return nodes.find(node => node.className.split(' ').includes(selector.slice(1))) ?? null;
    const attribute = selector.match(/^\[([^=]+)="([^"]*)"\]$/);
    return attribute ? nodes.find(node => node.attributes[attribute[1]] === attribute[2]) ?? null : null;
  }
}

const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
const documentHarness = () => ({ activeElement: null, createElement(tag) { return new ViewNode(tag, this); } });
const assistant = mes => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0 });
const user = mes => ({ is_user: true, is_system: false, mes });
const fingerprint = char => `sha256:${char.repeat(64)}`;

function fixture({ host = 'SillyTavern', frozenContent = `<StatusBar>当前状态：${OLD_TIME}</StatusBar>旧档正文`,
  frozenChronology = [], frozenTimeEdited = false, liveMessage = `<StatusBar>当前状态：${LIVE_TIME}</StatusBar>当前正文`, referenceTags = '', rebound = false,
  migration = true, firstCurrentMessage = `<StatusBar>当前状态：${LIVE_TIME}</StatusBar>当前聊天首楼` } = {}) {
  const context = { chatId: 'host-chat', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
    name1: '用户', personaId: 'persona', characters: [{ avatar: 'character.png' }], userAvatar: 'persona.png',
    chat: [user('开始'), assistant(firstCurrentMessage), user('继续'), assistant(liveMessage)] };
  if (rebound) context.chat[3].extra = { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: LIVE_ID } };
  const globalRef = host === 'Luker' ? { Luker: { getContext: () => context } } : { SillyTavern: { getContext: () => context } };
  const hostAdapter = createHostAdapter({ globalRef });
  const floors = [
    { id: FROZEN_ID, chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: 1, predecessorFloorId: null,
      hostLocator: { messageIndex: 1, swipeId: 0, selectedSwipeIndex: 0 },
      content: { canonicalContent: frozenContent, canonicalFingerprint: fingerprint('a'), rawFingerprint: fingerprint('b'), sanitizerFingerprint: fingerprint('c'), formatVersion: 1 },
      stability: { status: 'stable', stabilizedAt: '2026-10-15T00:00:00.000Z', stabilizedBy: 'manual' }, recordStatus: 'active' },
    { id: LIVE_ID, chatId: CHAT, narrativeGeneration: GENERATION, assistantSeq: 2, predecessorFloorId: FROZEN_ID,
      hostLocator: { messageIndex: rebound ? 2 : 3, swipeId: 0, selectedSwipeIndex: 0 },
      content: { canonicalContent: '当前正文', canonicalFingerprint: fingerprint('d'), rawFingerprint: fingerprint('e'), sanitizerFingerprint: fingerprint('f'), formatVersion: 1 },
      stability: { status: 'stable', stabilizedAt: '2026-10-15T00:00:00.000Z', stabilizedBy: 'manual' }, recordStatus: 'active' },
  ];
  const memories = floors.map((floor, index) => ({ id: `memory-${index}`, floorId: floor.id, chatId: CHAT,
    recordStatus: 'active', sourceFloorIds: [floor.id], summary: { effectiveSource: 'ai', aiText: '短摘要', userText: null },
    chronology: index === 0 ? frozenChronology : [], locations: [], participants: [], extractorVersion: 'offline' }));
  const reachable = { status: 'ready', rootRevision: 1,
    root: { chatId: CHAT, narrativeGeneration: GENERATION, headCheckpointId: '55555555-5555-4555-8555-555555555555',
      baselineId: null, sourceSnapshotFingerprint: fingerprint('7'), status: 'ready', capabilities: { cseReady: false },
      indexManifest: { floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] },
      activeStateRefs: [], activeThreadRefs: [], stableBoundary: { assistantSeq: 2, floorId: LIVE_ID, canonicalFingerprint: floors[1].content.canonicalFingerprint } },
    checkpoint: { producedRefs: {} }, migrationDescriptor: null, floors, floorMemories: memories,
    run: frozenTimeEdited ? { diagnostics: { floorProvenance: { [FROZEN_ID]: { timeEdited: true } } } } : null,
    entities: [], stateDeltas: [], currentStates: [], baseline: null };
  const frozenPrefix = { ...reachable, floors: [floors[0]], floorMemories: [memories[0]] };
  reachable.migrationDescriptor = migration ? createMigrationDescriptor({ id: '66666666-6666-4666-8666-666666666666', chatId: CHAT,
    source: { chatId: '77777777-7777-4777-8777-777777777777', hostChatId: 'old-host-chat', characterLocator: 'old-character.png',
      personaLocator: 'old-persona.png', narrativeGeneration: GENERATION, headCheckpointId: '88888888-8888-4888-8888-888888888888',
      sourceSnapshotFingerprint: fingerprint('8'), rootRevision: 1 }, reachable: frozenPrefix,
    recordRefs: { floors: [FROZEN_ID], floorMemories: [memories[0].id], entities: [], baselineId: null, stateDeltas: [],
      currentStateIds: [], indexKeys: [], timeBatchIds: [], vectorShardIds: [], peopleWorkspaceId: null, peopleSnapshotIds: [] },
    createdAt: '2026-10-15T00:00:00.000Z' }) : null;
  if (migration) reachable.run = null;
  const foundationState = { status: 'ready', foundationStatus: 'ready', pluginEnabled: true, chatId: CHAT,
    pending: null, canInitialize: false, inspectedStableCount: 1, stableCount: 1, lastError: null };
  const foundationRuntime = { start() {}, setEnabled() {}, bind() {}, getState: () => foundationState, getReachable: () => reachable,
    inspect: async () => ({ ...foundationState, status: 'ready' }), refreshStatus: async () => foundationState, confirmLatest: async () => foundationState };
  const calls = { putRecord: 0, commitRoot: 0, generateAnalysisTask: 0, generateUtilityTask: 0 };
  const store = { readReachable: async () => reachable, readRecord: async () => null,
    async putRecord() { calls.putRecord++; throw new Error('unexpected record write'); },
    async commitRoot() { calls.commitRoot++; throw new Error('unexpected root write'); }, recordKey: () => 'probe', invalidate: async () => {} };
  const runtime = createV3MemoryRuntime({ foundationRuntime, store, hostAdapter,
    async generateAnalysisTask() { calls.generateAnalysisTask++; throw new Error('unexpected model request'); },
    async generateUtilityTask() { calls.generateUtilityTask++; throw new Error('unexpected model request'); },
    automationSettings: () => ({ enabled: false }), storyClockReferenceTags: () => referenceTags });
  return { runtime, hostAdapter, context, reachable, calls };
}

async function project(h, floorId = FROZEN_ID) {
  await h.runtime.refreshStatus();
  assert.deepEqual(h.calls, { putRecord: 0, commitRoot: 0, generateAnalysisTask: 0, generateUtilityTask: 0 });
  const state = h.runtime.getState();
  const floor = state.floors.find(item => item.floorId === floorId);
  // Inline projection represents the current chat only; frozen source floors are
  // shown by the management view and must not be projected at their old locator.
  const liveFloor = state.floors.find(item => item.floorId === LIVE_ID);
  const inline = projectInlineMemoryFloor(state, liveFloor.messageIndex);
  const documentRef = documentHarness(), container = documentRef.createElement('main');
  const view = createV3FoundationView({ runtime: h.runtime, documentRef, pluginVersion: 'frozen-time-test' });
  view.setPage('memories'); view.mount(container);
  const card = flatten(container).find(node => node.attributes?.['data-qqj-floor-id'] === floorId);
  const viewTime = flatten(card).find(node => node.className === 'qqj-floor-time')?.textContent;
  view.deactivate();
  return { floor, inline, viewTime };
}

test('冻结楼 locator 与当前聊天楼重合时，ST 和 Luker 都使用冻结正文自身时间', async () => {
  for (const host of ['SillyTavern', 'Luker']) {
    const h = fixture({ host });
    const { floor, inline, viewTime } = await project(h);
    assert.equal(floor.frozen, true);
    assert.equal(floor.timeFallback, OLD_TIME);
    assert.equal(inline.time, LIVE_TIME);
    assert.equal(viewTime, OLD_TIME);
  }
});

test('冻结正文没有可确认时间或有冲突时间时，不借当前聊天时间填充', async () => {
  const noTime = fixture({ frozenContent: '回忆里提到8月3日，但没有本楼当前时间。' });
  const missing = await project(noTime);
  assert.equal(missing.floor.frozen, true);
  assert.equal(missing.floor.timeFallback, '');
  assert.equal(missing.inline.time, LIVE_TIME);
  assert.equal(missing.viewTime, '时间未明确');

  const conflict = fixture({ frozenContent: '<StatusBar>当前状态：2026年8月3日 09:10</StatusBar><StatusBar>当前状态：2026年8月4日 10:20</StatusBar>' });
  const ambiguous = await project(conflict);
  assert.equal(ambiguous.floor.timeFallback, '');
  assert.equal(ambiguous.inline.time, LIVE_TIME);
  assert.equal(ambiguous.viewTime, '时间未明确');
});

test('冻结楼保留人工 chronology 优先级、清空和 date-only 精度', async () => {
  const manual = fixture({ frozenChronology: [{ time: { sourceText: '人工校准：次日清晨' } }], frozenTimeEdited: true });
  assert.deepEqual(manual.reachable.migrationDescriptor.sourceFloorProvenance, [{ floorId: FROZEN_ID, timeEdited: true, storyClockSignature: null }]);
  const manualResult = await project(manual);
  assert.equal(manualResult.floor.manualTime, true);
  assert.equal(manualResult.floor.timeFallback, '');
  assert.equal(manualResult.inline.time, LIVE_TIME);
  assert.equal(manualResult.viewTime, '人工校准：次日清晨');

  const automated = fixture({ frozenChronology: [{ time: { sourceText: 'AI估计：次日清晨' } }] });
  const automatedResult = await project(automated);
  assert.equal(automatedResult.floor.manualTime, false);
  assert.equal(automatedResult.viewTime, OLD_TIME);

  const cleared = fixture({ frozenChronology: [{ time: { sourceText: '时间未明确' } }], frozenTimeEdited: true });
  const clearedResult = await project(cleared);
  assert.equal(clearedResult.floor.manualTime, true);
  assert.equal(clearedResult.floor.timeFallback, '');
  assert.equal(clearedResult.inline.time, LIVE_TIME);
  assert.equal(clearedResult.viewTime, '时间未明确');

  const dateOnly = fixture({ frozenContent: '<StatusBar>当前状态：2026年8月3日</StatusBar>' });
  const dateResult = await project(dateOnly);
  assert.equal(dateResult.floor.timeFallback, '2026年8月3日');
  assert.equal(dateResult.inline.time, LIVE_TIME);
  assert.equal(dateResult.viewTime, '2026年8月3日');
});

test('当前楼仍读取 host clock、配置时间标签和 floor anchor 重绑', async () => {
  const direct = fixture();
  const directResult = await project(direct, LIVE_ID);
  assert.notEqual(directResult.floor.frozen, true);
  assert.equal(directResult.floor.timeFallback, LIVE_TIME);

  const referenced = fixture({ host: 'Luker', rebound: true, referenceTags: 'Ti',
    liveMessage: '<Ti>0081年10月20日·清晨·06:12</Ti><content>当前正文</content>' });
  const reboundResult = await project(referenced, LIVE_ID);
  assert.notEqual(reboundResult.floor.frozen, true);
  assert.equal(reboundResult.floor.timeFallback, '0081年10月20日·清晨·06:12');
  assert.equal(reboundResult.inline.time, '0081年10月20日·清晨·06:12');
  assert.equal(reboundResult.viewTime, '0081年10月20日·清晨·06:12');
});

test('普通聊天没有迁移前缀时仍读取 host clock，无 host 时间时沿用 canonical fallback', async () => {
  const hostClock = await project(fixture({ migration: false }));
  assert.notEqual(hostClock.floor.frozen, true);
  assert.equal(hostClock.floor.timeFallback, LIVE_TIME);
  assert.equal(hostClock.viewTime, LIVE_TIME);

  const canonicalFallback = await project(fixture({ migration: false, firstCurrentMessage: '普通当前聊天正文，没有时间信息。' }));
  assert.notEqual(canonicalFallback.floor.frozen, true);
  assert.equal(canonicalFallback.floor.timeFallback, OLD_TIME);
  assert.equal(canonicalFallback.viewTime, OLD_TIME);
});
