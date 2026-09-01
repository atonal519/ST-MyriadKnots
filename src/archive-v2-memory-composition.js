import { isUuid, readHostState } from './host-context.js';
import { createArchiveV2Adapter } from './archive-v2.js';
import { newIdentityUuid } from './identity.js';
import { createArchiveV2MemorySnapshot } from './archive-v2-memory-foundation.js';
import { createArchiveV2MemoryBatchExtractor } from './archive-v2-memory-extraction.js';
import { createArchiveV2MemoryPeopleCommitter } from './archive-v2-memory-people-commit.js';
import { createArchiveV2MemoryPeopleConsolidator } from './archive-v2-memory-people-consolidation.js';
import { createArchiveV2MemoryStore } from './archive-v2-memory-store.js';
import { createArchiveV2MemoryRunner } from './archive-v2-memory-runner.js';

export class ArchiveV2MemoryCompositionError extends Error {
  constructor(message, code = 'ARCHIVE_V2_MEMORY_COMPOSITION_CONTEXT_INVALID') {
    super(message);
    this.name = 'ArchiveV2MemoryCompositionError';
    this.code = code;
  }
}

function contextError() {
  return new ArchiveV2MemoryCompositionError('当前聊天缺少可用的千千结稳定身份');
}

function sameIdentity(left, right) {
  return left.hostChatId === right.hostChatId
    && left.chatId === right.chatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}

function frozenProgress(value) {
  return Object.freeze({ ...value });
}

export function createArchiveV2MemoryComposition({
  client,
  contextProvider,
  generatePrimaryTask,
  generateUtilityTask,
  isEnabled = true,
  now,
  createScanId,
  createIdentityId = () => newIdentityUuid(),
} = {}) {
  if (typeof client?.get !== 'function' || typeof client?.put !== 'function') {
    throw new TypeError('memory composition client 必须提供 get 和 put');
  }
  if (typeof contextProvider !== 'function') throw new TypeError('memory composition contextProvider 必须是函数');
  if (typeof generatePrimaryTask !== 'function') {
    throw new TypeError('memory composition generatePrimaryTask 必须是函数');
  }
  if (typeof generateUtilityTask !== 'function') {
    throw new TypeError('memory composition generateUtilityTask 必须是函数');
  }
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') {
    throw new TypeError('memory composition isEnabled 必须是布尔值或函数');
  }
  if (now !== undefined && typeof now !== 'function') throw new TypeError('memory composition now 必须是函数');
  if (createScanId !== undefined && typeof createScanId !== 'function') {
    throw new TypeError('memory composition createScanId 必须是函数');
  }
  if (typeof createIdentityId !== 'function') throw new TypeError('memory composition createIdentityId 必须是函数');

  let epoch = 0;
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };
  function normalizedContext() {
    let raw;
    let state;
    try {
      raw = contextProvider();
      state = readHostState(raw);
    } catch {
      throw contextError();
    }
    if (state?.ok !== true || !isUuid(state.chatId)) throw contextError();
    return {
      raw,
      identity: Object.freeze({
        hostChatId: state.hostChatId,
        chatId: state.chatId,
        characterLocator: state.characterAvatar,
        personaLocator: state.personaAvatar,
      }),
    };
  }

  const identityContextProvider = () => ({ ...normalizedContext().identity });
  const snapshotProvider = async ({ targetFloor } = {}) => {
    if (targetFloor !== null
      && (!Number.isSafeInteger(targetFloor) || targetFloor < -1)) {
      throw new TypeError('targetFloor 无效');
    }
    const { raw } = normalizedContext();
    if (!Array.isArray(raw.chat)) throw contextError();
    const chat = targetFloor === null ? raw.chat : raw.chat.slice(0, targetFloor + 1);
    return createArchiveV2MemorySnapshot({ ...raw, chat });
  };

  const store = createArchiveV2MemoryStore({ client, contextProvider: identityContextProvider, isEnabled });
  const archiveAdapter = createArchiveV2Adapter({ client, contextProvider: identityContextProvider, isEnabled });
  const extractor = createArchiveV2MemoryBatchExtractor({
    contextProvider: identityContextProvider,
    generateTask: generateUtilityTask,
    isEnabled,
  });
  const runnerStore = Object.freeze({
    readManifest: (...args) => store.readManifest(...args),
    createManifest: (...args) => store.createManifest(...args),
    saveManifest: (...args) => store.saveManifest(...args),
    readBatch: (...args) => store.readBatch(...args),
    putBatch: (...args) => store.putBatch(...args),
  });
  const runnerOptions = {
    store: runnerStore,
    snapshotProvider,
    extractBatch: options => extractor.extract(options),
    contextProvider: identityContextProvider,
    isEnabled,
  };
  if (now !== undefined) runnerOptions.now = now;
  if (createScanId !== undefined) runnerOptions.createScanId = createScanId;
  const runner = createArchiveV2MemoryRunner(runnerOptions);
  const effectiveNow = now ?? (() => new Date().toISOString());
  const consolidator = createArchiveV2MemoryPeopleConsolidator({
    contextProvider: identityContextProvider,
    generateTask: generatePrimaryTask,
    isEnabled,
    now: effectiveNow,
  });
  const committer = createArchiveV2MemoryPeopleCommitter({
    archiveAdapter,
    createIdentityId,
    now: effectiveNow,
  });
  let peopleState = Object.freeze({ status: 'idle' });
  let activePeople = null;
  let activeCommit = null;
  let lastProgress = null;

  const peopleProgress = progress => frozenProgress({
    ...progress,
    peopleStatus: peopleState.status,
    ...(peopleState.result ? { peopleResult: peopleState.result } : {}),
    ...(peopleState.followedCount !== undefined ? {
      followedCount: peopleState.followedCount,
      silentCount: peopleState.silentCount,
    } : {}),
  });

  async function readyData(manifest, operation) {
    const snapshot = await snapshotProvider({ targetFloor: manifest.targetFloor });
    if (operation && !operation.current()) return { status: operation.status() };
    if (snapshot.sourceFingerprint !== manifest.sourceFingerprint
      || snapshot.batches.length !== manifest.totalBatches) return { status: 'source_changed' };
    return store.readReadyBatches({ manifest, plans: snapshot.batches });
  }

  function operationFor(identity) {
    const operationEpoch = epoch;
    return {
      current: () => {
        if (operationEpoch !== epoch || !enabled()) return false;
        try { return sameIdentity(identity, normalizedContext().identity); }
        catch { return false; }
      },
      status: () => enabled() ? 'stale' : 'disabled',
    };
  }

  async function inspect() {
    if (!enabled()) return frozenProgress({ status: 'disabled' });
    const inspectOperation = { epoch, identity: normalizedContext().identity };
    const current = () => {
      if (inspectOperation.epoch !== epoch) return 'stale';
      if (!enabled()) return 'disabled';
      try { return sameIdentity(inspectOperation.identity, normalizedContext().identity) ? 'current' : 'stale'; }
      catch { return 'stale'; }
    };
    const runnerState = runner.getState();
    if (runnerState.status === 'error') {
      const status = current();
      return status === 'current' ? frozenProgress(runnerState) : frozenProgress({ status });
    }
    const read = await store.readManifest();
    let status = current();
    if (status !== 'current') return frozenProgress({ status });
    if (read?.status === 'disabled' || read?.status === 'stale') return frozenProgress({ status: read.status });
    if (read?.status === 'ready') {
      const manifest = read.manifest;
      const progress = {
        status: manifest.status,
        targetFloor: manifest.targetFloor,
        eligibleFloorCount: null,
        completedBatches: manifest.completedBatchIndexes.length,
        totalBatches: manifest.totalBatches,
        currentBatchIndex: null,
      };
      if (manifest.status === 'ready') {
        const peopleOperation = operationFor(inspectOperation.identity);
        if (['running', 'error', 'committing', 'conflict', 'committed'].includes(peopleState.status)) {
          lastProgress = progress;
          return peopleProgress(progress);
        }
        const data = await readyData(manifest, peopleOperation);
        status = current();
        if (status !== 'current') return frozenProgress({ status });
        if (data.status !== 'ready') return frozenProgress({ ...progress, status: data.status });
        const saved = await store.readPeopleResult(data);
        status = current();
        if (status !== 'current') return frozenProgress({ status });
        if (saved.status === 'ready') peopleState = Object.freeze({ status: 'ready', result: saved.result });
        else if (saved.status === 'missing') peopleState = Object.freeze({ status: 'uninitialized' });
        else return frozenProgress({ ...progress, status: saved.status });
      }
      lastProgress = progress;
      return peopleProgress(progress);
    }
    if (read?.status !== 'uninitialized') {
      throw new ArchiveV2MemoryCompositionError(
        '记忆存储返回无效', 'ARCHIVE_V2_MEMORY_COMPOSITION_STORE_INVALID',
      );
    }
    const snapshot = await snapshotProvider({ targetFloor: null });
    status = current();
    if (status !== 'current') return frozenProgress({ status });
    const preview = {
      status: 'uninitialized',
      targetFloor: snapshot.targetFloor,
      eligibleFloorCount: snapshot.eligibleFloorCount,
      completedBatches: 0,
      totalBatches: snapshot.batches.length,
      currentBatchIndex: null,
      overRecommendedLimit: snapshot.eligibleFloorCount > 500,
    };
    lastProgress = preview;
    return peopleProgress(preview);
  }

  function consolidatePeople() {
    if (activePeople) return activePeople;
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    let identity;
    try { identity = normalizedContext().identity; }
    catch (error) { return Promise.reject(error); }
    const operation = operationFor(identity);
    peopleState = Object.freeze({ status: 'running' });
    const promise = (async () => {
      try {
        const read = await store.readManifest();
        if (!operation.current()) return { status: operation.status() };
        if (read?.status !== 'ready' || read.manifest.status !== 'ready') {
          throw new ArchiveV2MemoryCompositionError(
            '记忆扫描尚未完成', 'ARCHIVE_V2_MEMORY_COMPOSITION_NOT_READY',
          );
        }
        const data = await readyData(read.manifest, operation);
        if (!operation.current()) return { status: operation.status() };
        if (data.status !== 'ready') {
          peopleState = Object.freeze({ status: data.status === 'disabled' ? 'disabled' : 'error' });
          return { status: data.status };
        }
        const existing = await store.readPeopleResult(data);
        if (!operation.current()) return { status: operation.status() };
        if (existing.status === 'ready') {
          peopleState = Object.freeze({ status: 'ready', result: existing.result });
          return { status: 'ready', result: existing.result, reused: true };
        }
        if (existing.status !== 'missing') {
          peopleState = Object.freeze({ status: existing.status === 'disabled' ? 'disabled' : 'error' });
          return { status: existing.status };
        }
        const generated = await consolidator.consolidate(data);
        if (!operation.current()) return { status: operation.status() };
        if (generated.status !== 'ready') return { status: generated.status };
        const saved = await store.putPeopleResult({ ...data, result: generated.result });
        if (!operation.current()) return { status: operation.status() };
        if (!['saved', 'reused'].includes(saved.status)) {
          peopleState = Object.freeze({ status: saved.status === 'disabled' ? 'disabled' : 'error' });
          return { status: saved.status };
        }
        peopleState = Object.freeze({ status: 'ready', result: saved.result });
        return { status: 'ready', result: saved.result, reused: saved.status === 'reused' };
      } catch (error) {
        if (!operation.current()) return { status: operation.status() };
        peopleState = Object.freeze({ status: 'error' });
        throw error;
      }
    })();
    activePeople = promise;
    promise.finally(() => { if (activePeople === promise) activePeople = null; }).catch(() => {});
    return promise;
  }

  function confirmPeople({ selectedLocalIds } = {}) {
    if (activeCommit) return activeCommit;
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    let identity;
    try { identity = normalizedContext().identity; }
    catch (error) { return Promise.reject(error); }
    const operation = operationFor(identity);
    const retainedResult = peopleState.result;
    peopleState = Object.freeze({ status: 'committing', ...(retainedResult ? { result: retainedResult } : {}) });
    const promise = (async () => {
      try {
        const read = await store.readManifest();
        if (!operation.current()) return { status: operation.status() };
        if (read?.status !== 'ready' || read.manifest.status !== 'ready') {
          throw new ArchiveV2MemoryCompositionError(
            '记忆扫描尚未完成', 'ARCHIVE_V2_MEMORY_COMPOSITION_NOT_READY',
          );
        }
        const data = await readyData(read.manifest, operation);
        if (!operation.current()) return { status: operation.status() };
        if (data.status !== 'ready') {
          peopleState = Object.freeze({ status: data.status === 'disabled' ? 'disabled' : 'error', ...(retainedResult ? { result: retainedResult } : {}) });
          return { status: data.status };
        }
        const saved = await store.readPeopleResult(data);
        if (!operation.current()) return { status: operation.status() };
        if (saved.status !== 'ready') throw new ArchiveV2MemoryCompositionError(
          '人物候选尚未整理', 'ARCHIVE_V2_MEMORY_COMPOSITION_PEOPLE_MISSING',
        );
        const result = await committer.commit({
          ...data,
          result: saved.result,
          selectedLocalIds,
          identity: {
            characterLocator: identity.characterLocator,
            personaLocator: identity.personaLocator,
            personaSummary: '',
          },
        });
        if (!operation.current()) return { status: operation.status() };
        if (result.status === 'created') {
          peopleState = Object.freeze({
            status: 'committed',
            result: saved.result,
            followedCount: result.followedCount,
            silentCount: result.silentCount,
          });
        } else {
          peopleState = Object.freeze({ status: result.status === 'conflict' ? 'conflict' : result.status, result: saved.result });
        }
        return result;
      } catch (error) {
        if (!operation.current()) return { status: operation.status() };
        peopleState = Object.freeze({ status: 'error', ...(retainedResult ? { result: retainedResult } : {}) });
        throw error;
      }
    })();
    activeCommit = promise;
    promise.finally(() => { if (activeCommit === promise) activeCommit = null; }).catch(() => {});
    return promise;
  }

  function invalidate() {
    epoch += 1;
    let firstError;
    peopleState = Object.freeze({ status: enabled() ? 'idle' : 'disabled' });
    lastProgress = null;
    for (const dependency of [runner, extractor, consolidator, store, archiveAdapter]) {
      try { dependency.invalidate(); }
      catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
  }

  return Object.freeze({
    inspect,
    start: options => {
      const promise = runner.start(options);
      promise.then(result => { lastProgress = result; }, () => {}).catch(() => {});
      return promise;
    },
    consolidatePeople,
    confirmPeople,
    getState: () => {
      const runnerState = runner.getState();
      const progress = lastProgress?.status === 'ready' || ['running', 'ready', 'error', 'committing', 'conflict', 'committed'].includes(peopleState.status)
        ? (lastProgress ?? runnerState)
        : runnerState;
      return progress.status === 'ready' ? peopleProgress(progress) : progress;
    },
    invalidate,
  });
}
