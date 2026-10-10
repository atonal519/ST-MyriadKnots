import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMemoryCoverageFromHost, coverageHostGuardCurrent } from '../src/v3/memory-coverage.js';
import { MIGRATION_ALIAS_KEY } from '../src/v3/migration-prefix.js';
import { projectEntityFloorBounds } from '../src/v3/memory-schema.js';
import { validateFoundationRoot } from '../src/v3/foundation-schema.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FLOOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMORY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DELTA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ENTITY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const GENERATION_1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION_2 = '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const anchor = floorId => ({ qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId } });
const floor = (id, seq, narrativeGeneration = GENERATION_1) => ({ id, narrativeGeneration, assistantSeq: seq, hostLocator: { messageIndex: (seq - 1) * 2, swipeId: null, selectedSwipeIndex: null }, content: { rawFingerprint: 'sha256:old', canonicalFingerprint: 'sha256:old' } });

test('普通旧root保持未迁移格式，迁移descriptor仅在实际搬家root上存在', () => {
  const oldRoot = { schemaVersion: 3, recordType: 'root', id: 'root', chatId: CHAT, narrativeGeneration: GENERATION_1, status: 'ready',
    capabilities: { foundationReady: true, memoryReady: false, cseReady: false, recallReady: false }, headCheckpointId: null,
    sourceSnapshotFingerprint: null, stableBoundary: { assistantSeq: 0, floorId: null, canonicalFingerprint: null }, baselineId: null,
    activeRunId: null, indexManifest: { floor: [], entity: [], event: [], claim: [], knowledge: [], episode: [], thread: [], state: [], anchor: [], reverseRef: [] },
    activeStateRefs: [], activeThreadRefs: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', recordStatus: 'active', supersedes: null };
  const accepted = validateFoundationRoot(oldRoot);
  assert.equal(Object.hasOwn(accepted, 'migrationDescriptorId'), false);
  const migrated = validateFoundationRoot({ ...oldRoot, migrationDescriptorId: 'v3-migration-archive' });
  assert.equal(migrated.migrationDescriptorId, 'v3-migration-archive');
});

test('已挂标摘要在正文变化后coverage仍确认，最终guard按marker而非正文', async () => {
  const message = { is_user: false, is_system: false, mes: '已经编辑的新正文', extra: anchor(FLOOR) };
  const reachable = { root: { chatId: CHAT }, floors: [floor(FLOOR, 1)], floorMemories: [{ id: MEMORY, floorId: FLOOR, recordStatus: 'active' }], stateDeltas: [{ id: DELTA, floorId: FLOOR, floorMemoryId: MEMORY, recordStatus: 'active', subjectSnapshots: [] }] };
  const snapshot = { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: [message] };
  const coverage = await assessMemoryCoverageFromHost({ reachable, snapshot, captureGuard: true });
  assert.equal(coverage.status, 'caughtUp');
  message.mes = '再次编辑';
  assert.equal(coverageHostGuardCurrent(coverage, snapshot), true);
});

test('未摘要楼可用严格正文启动coverage，外来marker与正文漂移仍返回unknown', async () => {
  const raw = '等待摘要正文';
  const crypto = await import('../src/identity.js');
  const fingerprint = `sha256:${await crypto.sha256(raw)}`;
  const pendingFloor = { ...floor(FLOOR, 1), content: { rawFingerprint: fingerprint, canonicalFingerprint: fingerprint } };
  const reachable = { root: { chatId: CHAT }, floors: [pendingFloor], floorMemories: [], stateDeltas: [] };
  const snapshot = { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: [{ is_user: false, is_system: false, mes: raw, extra: {} }] };
  assert.equal((await assessMemoryCoverageFromHost({ reachable, snapshot })).status, 'historicalDebt');
  snapshot.chat[0].mes = '漂移';
  assert.equal((await assessMemoryCoverageFromHost({ reachable, snapshot })).status, 'unknown');
  snapshot.chat[0].extra = anchor(FLOOR); snapshot.chat[0].extra.qianqianjie_floor.chatId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  assert.equal((await assessMemoryCoverageFromHost({ reachable, snapshot })).status, 'unknown');
});

test('无 marker 时同位置 canonical 相同可跨包装确认，移动位置则要求唯一原始指纹', async () => {
  const crypto = await import('../src/identity.js');
  const raw = '永久正文<!--旧包装-->';
  const live = '永久正文<!--新包装-->';
  const rawFingerprint = `sha256:${await crypto.sha256(raw)}`;
  const canonicalFingerprint = `sha256:${await crypto.sha256('永久正文')}`;
  const storedFloor = { ...floor(FLOOR, 1), content: { rawFingerprint, canonicalFingerprint } };
  const reachable = { root: { chatId: CHAT }, floors: [storedFloor], floorMemories: [{ id: MEMORY, floorId: FLOOR, recordStatus: 'active' }], stateDeltas: [{ id: DELTA, floorId: FLOOR, floorMemoryId: MEMORY, recordStatus: 'active', subjectSnapshots: [] }] };
  const samePosition = { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: [{ is_user: false, is_system: false, mes: live, extra: {} }] };
  const wrapped = await assessMemoryCoverageFromHost({ reachable, snapshot: samePosition, captureGuard: true });
  assert.equal(wrapped.status, 'caughtUp');
  assert.equal(coverageHostGuardCurrent(wrapped, samePosition), true);

  const movedReachable = { ...reachable, floors: [{ ...storedFloor, hostLocator: { messageIndex: 0, swipeId: null, selectedSwipeIndex: null } }] };
  const moved = { context: samePosition.context, chat: [{ is_user: true, is_system: false, mes: '前置' }, { is_user: false, is_system: false, mes: raw, extra: {} }] };
  const movedCoverage = await assessMemoryCoverageFromHost({ reachable: movedReachable, snapshot: moved, captureGuard: true });
  assert.equal(movedCoverage.status, 'caughtUp');
  assert.deepEqual(movedCoverage.visibleSummaryFloorIds, [FLOOR]);
  assert.equal(coverageHostGuardCurrent(movedCoverage, moved), true);
});

test('重复或冲突 marker 不得取得 coverage 证明', async () => {
  const crypto = await import('../src/identity.js');
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  const fingerprint = `sha256:${await crypto.sha256('正文')}`;
  const floors = [
    { ...floor(firstId, 1), content: { rawFingerprint: fingerprint, canonicalFingerprint: fingerprint } },
    { ...floor(secondId, 2), content: { rawFingerprint: fingerprint, canonicalFingerprint: fingerprint } },
  ];
  const reachable = { root: { chatId: CHAT }, floors, floorMemories: [], stateDeltas: [] };
  const duplicate = { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: [
    { is_user: false, is_system: false, mes: '正文', extra: anchor(firstId) },
    { is_user: false, is_system: false, mes: '正文', extra: anchor(firstId) },
  ] };
  assert.equal((await assessMemoryCoverageFromHost({ reachable, snapshot: duplicate })).status, 'unknown');
  duplicate.chat[1].extra = anchor('33333333-3333-4333-8333-333333333333');
  assert.equal((await assessMemoryCoverageFromHost({ reachable, snapshot: duplicate })).status, 'unknown');
});

test('迁移coverage在完整归档图上证明冻结前缀，只计算B真实活动段并沿完整assistantSeq续号', async () => {
  const crypto = await import('../src/identity.js');
  const carriedId = '33333333-3333-4333-8333-333333333333';
  const carriedText = 'A里已完成并携带到B的AI';
  const liveText = 'B里的新AI';
  const tailText = 'B最新待处理AI';
  const carriedFingerprint = `sha256:${await crypto.sha256(carriedText)}`;
  const liveFingerprint = `sha256:${await crypto.sha256(liveText)}`;
  const tailFingerprint = `sha256:${await crypto.sha256(tailText)}`;
  const frozen = { ...floor(FLOOR, 1), hostLocator: { messageIndex: 808, swipeId: 1, selectedSwipeIndex: 1 }, content: { rawFingerprint: carriedFingerprint, canonicalFingerprint: carriedFingerprint } };
  const live = { ...floor(MEMORY, 2), hostLocator: { messageIndex: 2, swipeId: null, selectedSwipeIndex: null }, content: { rawFingerprint: liveFingerprint, canonicalFingerprint: liveFingerprint } };
  const reachable = {
    root: { chatId: CHAT }, floors: [frozen, live], floorMemories: [], stateDeltas: [],
    migrationDescriptor: { id: '44444444-4444-4444-8444-444444444444', frozenFloorIds: [FLOOR], floorOrigins: [], carriedAliases: [{ aliasId: carriedId, floorId: FLOOR, targetMessageIndex: 1, rawFingerprint: carriedFingerprint, canonicalFingerprint: carriedFingerprint }] },
  };
  const snapshot = { context: { chatMetadata: { qianqianjie: { chatId: CHAT } } }, chat: [
    { is_user: true, mes: '被携带的USER', extra: {} },
    { is_user: false, is_system: false, mes: carriedText, extra: { [MIGRATION_ALIAS_KEY]: carriedId } },
    { is_user: false, is_system: false, mes: liveText, extra: {} },
    { is_user: false, is_system: false, mes: tailText, extra: {} },
  ] };
  const coverage = await assessMemoryCoverageFromHost({ reachable, snapshot, captureGuard: true });
  assert.equal(coverage.status, 'historicalDebt');
  assert.equal(coverage.total, 1);
  assert.equal(coverage.completed, 0);
  assert.equal(coverage.nextAssistantSeq, 2, 'coverage继续当前已建floor的工作');
  assert.deepEqual(coverage.pendingFloorIds, [MEMORY, `host-tail:3:${tailFingerprint}`]);
  assert.equal(coverage.unregisteredSummaryRefs[0].assistantSeq, 3, '未建floor的B候选沿完整冻结前缀序号续号');
  assert.deepEqual(coverage.summaryPendingFloorIds, [MEMORY, `host-tail:3:${tailFingerprint}`]);
  assert.equal(coverageHostGuardCurrent(coverage, snapshot), true);
});

test('实体首末楼按全部存活memory/CSE结构化引用投影', () => {
  const f1 = floor('11111111-1111-4111-8111-111111111111', 1);
  const f2 = floor('22222222-2222-4222-8222-222222222222', 2);
  const entity = { id: ENTITY, narrativeGeneration: GENERATION_1, firstSeenFloorId: '33333333-3333-4333-8333-333333333333', lastSeenFloorId: '33333333-3333-4333-8333-333333333333' };
  const memories = [{ floorId: f1.id, summaryEvidenceRefs: [], locations: [], participants: [{ entityId: ENTITY }], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], exactAnchors: [], openLoops: [], cseSignals: [], chronology: [], eventFragments: [], ambiguities: [] }];
  const deltas = [{ floorId: f2.id, subjectSnapshots: [{ subjectEntityId: ENTITY, core: [], adaptive: [], situational: [] }] }];
  assert.deepEqual(projectEntityFloorBounds([entity], [f1, f2], memories, deltas)[0], { ...entity, firstSeenFloorId: f1.id, lastSeenFloorId: f2.id });
});

test('baseline 保留人物在唯一来源楼删除后清空悬空首末楼', () => {
  const deletedFloorId = '33333333-3333-4333-8333-333333333333';
  const entity = { id: ENTITY, narrativeGeneration: GENERATION_1, firstSeenFloorId: deletedFloorId, lastSeenFloorId: deletedFloorId };
  assert.deepEqual(projectEntityFloorBounds([entity], [], [], [])[0], { ...entity, firstSeenFloorId: null, lastSeenFloorId: null });
});

test('实体首见边界跨代迁移时只投影视图代次，无引用时保留原代次', () => {
  const currentFloor = floor(FLOOR, 1, GENERATION_2);
  const referenced = { id: ENTITY, narrativeGeneration: GENERATION_1, firstSeenFloorId: null, lastSeenFloorId: null };
  const memories = [{ floorId: FLOOR, summaryEvidenceRefs: [], locations: [], participants: [{ entityId: ENTITY }], actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], exactAnchors: [], openLoops: [], cseSignals: [], chronology: [], eventFragments: [], ambiguities: [] }];
  assert.deepEqual(projectEntityFloorBounds([referenced], [currentFloor], memories, [])[0], {
    ...referenced, narrativeGeneration: GENERATION_2, firstSeenFloorId: FLOOR, lastSeenFloorId: FLOOR,
  });
  assert.deepEqual(projectEntityFloorBounds([referenced], [], [], [])[0], referenced, '无存活引用时只清边界规则生效，不改原始代次');
});
