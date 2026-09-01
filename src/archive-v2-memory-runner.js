import {
  createArchiveV2MemoryManifest,
  validateArchiveV2MemoryManifest,
} from './archive-v2-memory-foundation.js';
import { isUuid } from './host-context.js';
import { createArchiveV2MemoryBatchRecordId } from './archive-v2-memory-store.js';

const RUNNER_STATUSES = new Set([
  'idle', 'checking', 'scanning', 'ready', 'stale', 'disabled', 'conflict', 'source_changed', 'error',
]);
const FALLBACK_DIAGNOSTIC_CODE = 'ARCHIVE_V2_MEMORY_RUNNER_FAILED';
const INTERNAL_DIAGNOSTIC_CODES = new Set([
  FALLBACK_DIAGNOSTIC_CODE,
  'ARCHIVE_V2_MEMORY_RUNNER_CONTEXT_INVALID',
  'ARCHIVE_V2_MEMORY_RUNNER_DEPENDENCY_INVALID',
  'ARCHIVE_V2_MEMORY_RUNNER_EXTRACT_INVALID',
  'ARCHIVE_V2_MEMORY_RUNNER_JSON_INVALID',
  'ARCHIVE_V2_MEMORY_RUNNER_SCAN_ID_INVALID',
  'ARCHIVE_V2_MEMORY_RUNNER_SCAN_ID_UNAVAILABLE',
  'ARCHIVE_V2_MEMORY_RUNNER_SNAPSHOT_INVALID',
  'ARCHIVE_V2_MEMORY_RUNNER_STATE_INVALID',
  'ARCHIVE_V2_MEMORY_RUNNER_STORE_INVALID',
  'ARCHIVE_V2_MEMORY_RUNNER_TIME_INVALID',
]);

export class ArchiveV2MemoryRunnerError extends Error {
  constructor(message, code = 'ARCHIVE_V2_MEMORY_RUNNER_FAILED') {
    super(message);
    this.name = 'ArchiveV2MemoryRunnerError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ArchiveV2MemoryRunnerError(message, code);
}

function safeDiagnosticCode(error) {
  try {
    return error instanceof ArchiveV2MemoryRunnerError
      && typeof error.code === 'string'
      && INTERNAL_DIAGNOSTIC_CODES.has(error.code)
      ? error.code
      : FALLBACK_DIAGNOSTIC_CODE;
  } catch {
    return FALLBACK_DIAGNOSTIC_CODE;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeJsonClone(value, code = 'ARCHIVE_V2_MEMORY_RUNNER_JSON_INVALID', active = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('后台扫描数据无效', code);
    return value;
  }
  if (typeof value !== 'object' || active.has(value)) fail('后台扫描数据无效', code);
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string')) fail('后台扫描数据无效', code);
    if (Array.isArray(value)) {
      if (keys.some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) {
        fail('后台扫描数据无效', code);
      }
      const clone = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          fail('后台扫描数据无效', code);
        }
        clone.push(safeJsonClone(descriptor.value, code, active));
      }
      return clone;
    }
    if (!isPlainObject(value)) fail('后台扫描数据无效', code);
    const clone = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('后台扫描数据无效', code);
      }
      clone[key] = safeJsonClone(descriptor.value, code, active);
    }
    return clone;
  } finally {
    active.delete(value);
  }
}

function requiredString(value, code, maxLength = 512) {
  if (typeof value !== 'string') fail('后台扫描身份无效', code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) fail('后台扫描身份无效', code);
  return normalized;
}

function safeIdentity(raw) {
  if (!isPlainObject(raw)) fail('宿主身份不可用', 'ARCHIVE_V2_MEMORY_RUNNER_CONTEXT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const read = (...names) => {
    for (const name of names) {
      const descriptor = descriptors[name];
      if (descriptor && Object.hasOwn(descriptor, 'value')) return descriptor.value;
      if (descriptor) fail('宿主身份不可用', 'ARCHIVE_V2_MEMORY_RUNNER_CONTEXT_INVALID');
    }
    return undefined;
  };
  const identity = {
    hostChatId: requiredString(read('hostChatId'), 'ARCHIVE_V2_MEMORY_RUNNER_CONTEXT_INVALID'),
    chatId: requiredString(read('chatId'), 'ARCHIVE_V2_MEMORY_RUNNER_CONTEXT_INVALID'),
    characterLocator: requiredString(
      read('characterLocator', 'characterAvatar'), 'ARCHIVE_V2_MEMORY_RUNNER_CONTEXT_INVALID',
    ),
    personaLocator: requiredString(
      read('personaLocator', 'personaAvatar'), 'ARCHIVE_V2_MEMORY_RUNNER_CONTEXT_INVALID',
    ),
  };
  if (!isUuid(identity.chatId)) fail('宿主身份不可用', 'ARCHIVE_V2_MEMORY_RUNNER_CONTEXT_INVALID');
  return Object.freeze(identity);
}

function sameIdentity(left, right) {
  return left.hostChatId === right.hostChatId
    && left.chatId === right.chatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    fail('后台扫描时间无效', 'ARCHIVE_V2_MEMORY_RUNNER_TIME_INVALID');
  }
  return value;
}

function defaultScanId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    fail('宿主缺少扫描 ID 生成能力', 'ARCHIVE_V2_MEMORY_RUNNER_SCAN_ID_UNAVAILABLE');
  }
  return globalThis.crypto.randomUUID();
}

function progressState(value) {
  const state = {
    status: value.status,
    targetFloor: value.targetFloor,
    completedBatches: value.completedBatches,
    totalBatches: value.totalBatches,
    currentBatchIndex: value.currentBatchIndex,
  };
  if (!RUNNER_STATUSES.has(state.status)
    || (state.targetFloor !== null && (!Number.isSafeInteger(state.targetFloor) || state.targetFloor < -1))
    || !Number.isSafeInteger(state.completedBatches)
    || state.completedBatches < 0
    || !Number.isSafeInteger(state.totalBatches)
    || state.totalBatches < 0
    || state.completedBatches > state.totalBatches
    || (state.currentBatchIndex !== null
      && (!Number.isSafeInteger(state.currentBatchIndex) || state.currentBatchIndex < 0))) {
    fail('后台扫描状态无效', 'ARCHIVE_V2_MEMORY_RUNNER_STATE_INVALID');
  }
  return Object.freeze(state);
}

function snapshotResult(value) {
  if (isPlainObject(value) && typeof value.status === 'string') {
    if (value.status === 'stale' || value.status === 'disabled') return { status: value.status };
    if (value.status === 'ready' && Object.hasOwn(value, 'snapshot')) return { status: 'ready', snapshot: value.snapshot };
  }
  return { status: 'ready', snapshot: value };
}

function dependencyStatus(value) {
  if (!isPlainObject(value) || typeof value.status !== 'string') {
    fail('后台扫描依赖返回无效', 'ARCHIVE_V2_MEMORY_RUNNER_DEPENDENCY_INVALID');
  }
  return value.status;
}

function invokeCancellation(dependency) {
  try {
    if (typeof dependency?.cancel === 'function') dependency.cancel();
    else if (typeof dependency?.invalidate === 'function') dependency.invalidate();
  } catch { /* cancellation is best effort */ }
}

export function createArchiveV2MemoryRunner({
  store,
  snapshotProvider,
  extractBatch,
  createScanId = defaultScanId,
  now = () => new Date().toISOString(),
  contextProvider,
  isEnabled = true,
  logger = globalThis.console,
} = {}) {
  for (const name of ['readManifest', 'createManifest', 'saveManifest', 'readBatch', 'putBatch']) {
    if (typeof store?.[name] !== 'function') throw new TypeError(`memory runner store.${name} 必须是函数`);
  }
  if (typeof snapshotProvider !== 'function') throw new TypeError('memory runner snapshotProvider 必须是函数');
  if (typeof extractBatch !== 'function') throw new TypeError('memory runner extractBatch 必须是函数');
  if (typeof createScanId !== 'function') throw new TypeError('memory runner createScanId 必须是函数');
  if (typeof now !== 'function') throw new TypeError('memory runner now 必须是函数');
  if (typeof contextProvider !== 'function') throw new TypeError('memory runner contextProvider 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') {
    throw new TypeError('memory runner isEnabled 必须是布尔值或函数');
  }
  if (logger !== null && logger !== undefined && typeof logger?.warn !== 'function') {
    throw new TypeError('memory runner logger.warn 必须是函数');
  }

  let epoch = 0;
  let active = null;
  let state = progressState({
    status: 'idle', targetFloor: null, completedBatches: 0, totalBatches: 0, currentBatchIndex: null,
  });
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };
  const warnFailure = code => {
    try {
      logger?.warn?.('[ST-QianQianJie] archive-v2 memory scan failed', {
        code: INTERNAL_DIAGNOSTIC_CODES.has(code) ? code : FALLBACK_DIAGNOSTIC_CODE,
      });
    } catch { /* diagnostics must never alter runner behavior */ }
  };
  const publicFailure = error => {
    const code = safeDiagnosticCode(error);
    warnFailure(code);
    return new ArchiveV2MemoryRunnerError('后台记忆扫描失败', code);
  };
  const captureIdentity = () => safeIdentity(contextProvider());
  const updateState = patch => {
    state = progressState({ ...state, ...patch });
    return state;
  };
  const operationStatus = operation => {
    if (operation.epoch !== epoch || operation.controller.signal.aborted) return 'stale';
    if (!enabled()) return 'disabled';
    try { return sameIdentity(operation.identity, captureIdentity()) ? 'current' : 'stale'; }
    catch { return 'stale'; }
  };
  const stopForOperation = operation => {
    const status = operationStatus(operation);
    if (status === 'current') return null;
    return updateState({ status, currentBatchIndex: null });
  };
  const stopForDependency = (operation, result) => {
    const stopped = stopForOperation(operation);
    if (stopped) return stopped;
    const status = dependencyStatus(result);
    if (status === 'stale' || status === 'disabled' || status === 'conflict') {
      return updateState({ status, currentBatchIndex: null });
    }
    return null;
  };

  function cancelOperation(operation) {
    if (operation.cancelled) return;
    operation.cancelled = true;
    epoch += 1;
    operation.controller.abort();
    invokeCancellation(extractBatch);
    invokeCancellation(snapshotProvider);
    invokeCancellation(store);
    updateState({ status: enabled() ? 'stale' : 'disabled', currentBatchIndex: null });
  }

  async function safeSnapshot(targetFloor, operation) {
    const rawResult = await snapshotProvider({ targetFloor });
    const stopped = stopForOperation(operation);
    if (stopped) return { stopped };
    const result = snapshotResult(rawResult);
    if (result.status !== 'ready') {
      return { stopped: updateState({ status: result.status, currentBatchIndex: null }) };
    }
    return { snapshot: safeJsonClone(result.snapshot, 'ARCHIVE_V2_MEMORY_RUNNER_SNAPSHOT_INVALID') };
  }

  function sourceMatches(manifest, snapshot) {
    return snapshot.chatId === manifest.chatId
      && snapshot.targetFloor === manifest.targetFloor
      && snapshot.sourceFingerprint === manifest.sourceFingerprint
      && snapshot.batchSize === manifest.batchSize
      && Array.isArray(snapshot.batches)
      && snapshot.batches.length === manifest.totalBatches;
  }

  async function completedRefsMatch(manifest, snapshot) {
    for (let index = 0; index < manifest.completedBatchIndexes.length; index += 1) {
      const batchIndex = manifest.completedBatchIndexes[index];
      const plan = snapshot.batches[batchIndex];
      const ref = manifest.batchRefs[index];
      if (!isPlainObject(plan) || ref.sourceFingerprint !== plan.sourceFingerprint) return false;
      const recordId = await createArchiveV2MemoryBatchRecordId({
        scanId: manifest.scanId,
        batchIndex,
        sourceFingerprint: plan.sourceFingerprint,
      });
      if (ref.recordId !== recordId) return false;
    }
    return true;
  }

  async function readyManifest(manifest, revision, operation) {
    let stopped = stopForOperation(operation);
    if (stopped) return stopped;
    const updatedAt = safeTimestamp(await now());
    stopped = stopForOperation(operation);
    if (stopped) return stopped;
    const ready = validateArchiveV2MemoryManifest({
      ...safeJsonClone(manifest),
      status: 'ready',
      updatedAt,
    }, { expectedChatId: operation.identity.chatId });
    const saved = await store.saveManifest({ manifest: ready, expectedRevision: revision });
    stopped = stopForDependency(operation, saved);
    if (stopped) return stopped;
    if (saved.status !== 'saved') {
      fail('manifest 保存结果无效', 'ARCHIVE_V2_MEMORY_RUNNER_STORE_INVALID');
    }
    return updateState({ status: 'ready', currentBatchIndex: null });
  }

  async function run(operation) {
    updateState({
      status: 'checking', targetFloor: null, completedBatches: 0, totalBatches: 0, currentBatchIndex: null,
    });
    const stoppedAtStart = stopForOperation(operation);
    if (stoppedAtStart) return stoppedAtStart;

    const read = await store.readManifest();
    let stopped = stopForDependency(operation, read);
    if (stopped) return stopped;
    let manifest;
    let revision;
    let snapshot;

    if (read.status === 'ready') {
      manifest = read.manifest;
      revision = read.revision;
      updateState({
        targetFloor: manifest.targetFloor,
        completedBatches: manifest.completedBatchIndexes.length,
        totalBatches: manifest.totalBatches,
        currentBatchIndex: null,
      });
      if (manifest.status === 'ready') return updateState({ status: 'ready' });
      const snap = await safeSnapshot(manifest.targetFloor, operation);
      if (snap.stopped) return snap.stopped;
      snapshot = snap.snapshot;
      const matches = sourceMatches(manifest, snapshot) && await completedRefsMatch(manifest, snapshot);
      stopped = stopForOperation(operation);
      if (stopped) return stopped;
      if (!matches) {
        return updateState({ status: 'source_changed', currentBatchIndex: null });
      }
    } else if (read.status === 'uninitialized') {
      const snap = await safeSnapshot(null, operation);
      if (snap.stopped) return snap.stopped;
      snapshot = snap.snapshot;
      const scanId = requiredString(
        await createScanId(), 'ARCHIVE_V2_MEMORY_RUNNER_SCAN_ID_INVALID', 256,
      );
      const createdAt = safeTimestamp(await now());
      try {
        manifest = createArchiveV2MemoryManifest({ snapshot, scanId, createdAt });
      } catch {
        fail('后台扫描快照无效', 'ARCHIVE_V2_MEMORY_RUNNER_SNAPSHOT_INVALID');
      }
      stopped = stopForOperation(operation);
      if (stopped) return stopped;
      const created = await store.createManifest({ manifest });
      stopped = stopForDependency(operation, created);
      if (stopped) return stopped;
      if (created.status !== 'created') {
        fail('manifest 创建结果无效', 'ARCHIVE_V2_MEMORY_RUNNER_STORE_INVALID');
      }
      manifest = created.manifest;
      revision = created.revision;
      updateState({
        targetFloor: manifest.targetFloor,
        completedBatches: 0,
        totalBatches: manifest.totalBatches,
        currentBatchIndex: null,
      });
      if (!sourceMatches(manifest, snapshot)) {
        fail('manifest 创建响应与快照不一致', 'ARCHIVE_V2_MEMORY_RUNNER_STORE_INVALID');
      }
    } else {
      fail('manifest 读取结果无效', 'ARCHIVE_V2_MEMORY_RUNNER_STORE_INVALID');
    }

    if (manifest.totalBatches === 0) return readyManifest(manifest, revision, operation);
    if (manifest.completedBatchIndexes.length === manifest.totalBatches) {
      return readyManifest(manifest, revision, operation);
    }
    updateState({ status: 'scanning' });
    const completed = new Set(manifest.completedBatchIndexes);

    for (let batchIndex = 0; batchIndex < manifest.totalBatches; batchIndex += 1) {
      if (completed.has(batchIndex)) continue;
      stopped = stopForOperation(operation);
      if (stopped) return stopped;
      const plan = snapshot.batches[batchIndex];
      const recordId = await createArchiveV2MemoryBatchRecordId({
        scanId: manifest.scanId,
        batchIndex,
        sourceFingerprint: plan?.sourceFingerprint,
      });
      stopped = stopForOperation(operation);
      if (stopped) return stopped;
      updateState({ status: 'scanning', currentBatchIndex: batchIndex });

      const existing = await store.readBatch({ recordId, plan, expectedScanId: manifest.scanId });
      stopped = stopForDependency(operation, existing);
      if (stopped) return stopped;
      let batch;
      if (existing.status === 'ready') {
        batch = existing.batch;
      } else if (existing.status === 'missing') {
        const createdAt = safeTimestamp(await now());
        const extracted = await extractBatch({
          manifest,
          plan,
          createdAt,
          signal: operation.controller.signal,
        });
        stopped = stopForDependency(operation, extracted);
        if (stopped) return stopped;
        if (extracted.status !== 'ready' || !Object.hasOwn(extracted, 'batch')) {
          fail('抽取器返回无效', 'ARCHIVE_V2_MEMORY_RUNNER_EXTRACT_INVALID');
        }
        batch = extracted.batch;
        stopped = stopForOperation(operation);
        if (stopped) return stopped;
        const stored = await store.putBatch({ recordId, batch, plan });
        stopped = stopForDependency(operation, stored);
        if (stopped) return stopped;
        if (stored.status !== 'saved' && stored.status !== 'reused') {
          fail('batch 保存结果无效', 'ARCHIVE_V2_MEMORY_RUNNER_STORE_INVALID');
        }
      } else {
        fail('batch 读取结果无效', 'ARCHIVE_V2_MEMORY_RUNNER_STORE_INVALID');
      }

      stopped = stopForOperation(operation);
      if (stopped) return stopped;
      const nextCompleted = [...completed, batchIndex].sort((left, right) => left - right);
      const refsByIndex = new Map(manifest.batchRefs.map(ref => [ref.batchIndex, ref]));
      refsByIndex.set(batchIndex, { batchIndex, recordId, sourceFingerprint: plan.sourceFingerprint });
      const batchRefs = nextCompleted.map(index => refsByIndex.get(index));
      const updatedAt = safeTimestamp(await now());
      stopped = stopForOperation(operation);
      if (stopped) return stopped;
      const nextManifest = validateArchiveV2MemoryManifest({
        ...safeJsonClone(manifest),
        completedBatchIndexes: nextCompleted,
        status: nextCompleted.length === manifest.totalBatches ? 'ready' : 'scanning',
        batchRefs,
        updatedAt,
      }, { expectedChatId: operation.identity.chatId });
      const saved = await store.saveManifest({ manifest: nextManifest, expectedRevision: revision });
      stopped = stopForDependency(operation, saved);
      if (stopped) return stopped;
      if (saved.status !== 'saved') {
        fail('manifest 保存结果无效', 'ARCHIVE_V2_MEMORY_RUNNER_STORE_INVALID');
      }
      manifest = saved.manifest;
      revision = saved.revision;
      completed.add(batchIndex);
      let nextBatchIndex = null;
      for (let candidate = batchIndex + 1; candidate < manifest.totalBatches; candidate += 1) {
        if (!completed.has(candidate)) {
          nextBatchIndex = candidate;
          break;
        }
      }
      updateState({
        status: manifest.status === 'ready' ? 'ready' : 'scanning',
        completedBatches: manifest.completedBatchIndexes.length,
        currentBatchIndex: manifest.status === 'ready' ? null : nextBatchIndex,
      });
    }
    stopped = stopForOperation(operation);
    return stopped ?? updateState({ status: 'ready', currentBatchIndex: null });
  }

  function start({ signal } = {}) {
    if (active) return active.promise;
    if (!enabled()) {
      return Promise.resolve(updateState({ status: 'disabled', currentBatchIndex: null }));
    }
    let identity;
    try { identity = captureIdentity(); }
    catch (error) {
      updateState({ status: 'error', currentBatchIndex: null });
      return Promise.reject(publicFailure(error));
    }
    const controller = new AbortController();
    const operation = { epoch, identity, controller, promise: null, cancelled: false, externalSignal: signal };
    const onExternalAbort = () => cancelOperation(operation);
    operation.onExternalAbort = onExternalAbort;
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener?.('abort', onExternalAbort, { once: true });
    operation.promise = run(operation).catch(error => {
      const status = operationStatus(operation);
      if (status !== 'current') return updateState({ status, currentBatchIndex: null });
      updateState({ status: 'error', currentBatchIndex: null });
      throw publicFailure(error);
    }).finally(() => {
      signal?.removeEventListener?.('abort', onExternalAbort);
      if (active === operation) active = null;
    });
    active = operation;
    return operation.promise;
  }

  function invalidate() {
    if (active) cancelOperation(active);
    else {
      epoch += 1;
      invokeCancellation(extractBatch);
      invokeCancellation(snapshotProvider);
      invokeCancellation(store);
      updateState({ status: enabled() ? 'stale' : 'disabled', currentBatchIndex: null });
    }
  }

  return Object.freeze({
    start,
    cancel: invalidate,
    invalidate,
    getState: () => progressState(state),
  });
}
