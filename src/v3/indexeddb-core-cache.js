import { sha256 } from '../identity.js';
import { API_BASE, NAMESPACE } from '../constants.js';

const FORMAT = 'qqj-v3-core-cache-1';
const CORE_TYPES = new Set(['floor', 'floorMemory', 'entity', 'stateDelta', 'index']);
const MAX_BYTES = 128 * 1024 * 1024;
const IO_TIMEOUT_MS = 900;
const WRITE_CONCURRENCY = 16;
const encoder = new TextEncoder();
const DB_NAME = 'qqj-v3-core-cache';
const STORE_NAME = 'core_records';
const DIRECTORY_FORMAT = `${FORMAT}-directory-1`;
const DIRECTORY_MARKER_KEY = 'g:core-directory-v1';
const BUDGET_KEY = 'b:core-cache';
const RECORD_ID_PREFIX = Object.freeze({ floor: 'v3-floor-', floorMemory: 'v3-floor-memory-', entity: 'v3-entity-', stateDelta: 'v3-state-delta-' });

function bounded(promise, timeoutMs = IO_TIMEOUT_MS, phase = 'storage-io', onFailure = null, onLate = null) {
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const startedAt = now(), deadlineAt = startedAt + timeoutMs;
  let timer, timeoutFired = false, diagnosticToken = null, lateSettlement = null, lateSettlementElapsedMs = null, lateSettlementAt = null;
  const operation = Promise.resolve(promise);
  // The observer records settlement scalars only; the bounded cache read/write still rejects at its original deadline.
  const observed = operation.then(value => {
    if (timeoutFired) {
      lateSettlement = 'fulfilled';
      lateSettlementElapsedMs = Math.max(0, Math.round(now() - startedAt)); lateSettlementAt = Date.now();
      if (diagnosticToken !== null) onLate?.(diagnosticToken, lateSettlement, lateSettlementElapsedMs, lateSettlementAt);
      return undefined;
    }
    return value;
  }, error => {
    if (timeoutFired) {
      lateSettlement = 'rejected';
      lateSettlementElapsedMs = Math.max(0, Math.round(now() - startedAt)); lateSettlementAt = Date.now();
      if (diagnosticToken !== null) onLate?.(diagnosticToken, lateSettlement, lateSettlementElapsedMs, lateSettlementAt);
      return undefined;
    }
    throw error;
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timeoutFired = true;
      const firedAt = now();
      reject(Object.assign(new Error('IDB_CACHE_TIMEOUT'), {
        code: 'IDB_CACHE_TIMEOUT', cacheIoPhase: phase,
        cacheIoElapsedMs: Math.max(0, Math.round(firedAt - startedAt)),
        cacheIoDeadlineLatenessMs: Math.max(0, Math.round(firedAt - deadlineAt)),
      }));
    }, timeoutMs);
  });
  return Promise.race([observed, timeout]).catch(error => {
    const elapsedMs = Math.max(0, Math.round(now() - startedAt));
    if (error?.code === 'IDB_CACHE_TIMEOUT' && error?.cacheIoPhase === phase) {
      diagnosticToken = onFailure?.(phase, error, error.cacheIoElapsedMs, error.cacheIoDeadlineLatenessMs, lateSettlement ?? 'pending') ?? null;
      if (lateSettlement && diagnosticToken !== null) onLate?.(diagnosticToken, lateSettlement, lateSettlementElapsedMs, lateSettlementAt);
    } else {
      onFailure?.(phase, error, elapsedMs, 0, 'rejected');
    }
    throw error;
  }).finally(() => clearTimeout(timer));
}

function plainRecord(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function encoded(value) { return encodeURIComponent(String(value)); }
function witnessKey(witness) { return JSON.stringify([
  witness.formatVersion, witness.generationId, witness.revision, witness.headCheckpointId,
  witness.narrativeGeneration, witness.sourceSnapshotFingerprint,
]); }

export function createIndexedDbCoreRecordCache({
  localForage,
  accountHandleProvider,
  originProvider = () => globalThis.location?.origin ?? '',
  apiBase = API_BASE,
  namespace = NAMESPACE,
  indexedDBProvider = () => globalThis.indexedDB,
  keyRangeProvider = () => globalThis.IDBKeyRange,
  maxBytes = MAX_BYTES,
  ioTimeoutMs = IO_TIMEOUT_MS,
  logger = console,
} = {}) {
  const stats = { available: false, hits: 0, misses: 0, corruptions: 0, writes: 0, writeFailures: 0, evictedRecords: 0, estimatedBytes: 0, firstFailure: null, lastFailure: null };
  // Tokens tie one late settlement to its own first/last diagnostic row without retaining the Error or cache payload.
  const diagnosedErrors = new WeakSet();
  let failureToken = 0;
  const safeCodes = new Set(['IDB_CACHE_TIMEOUT']);
  const safeNames = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError',
    'AbortError', 'ConstraintError', 'DataError', 'InvalidAccessError', 'InvalidStateError', 'NotAllowedError', 'NotFoundError',
    'QuotaExceededError', 'ReadOnlyError', 'TimeoutError', 'TransactionInactiveError', 'UnknownError', 'VersionError', 'SecurityError']);
  const safeCode = value => safeCodes.has(value) ? value : null;
  const safeName = value => safeNames.has(value) ? value : null;
  const recordIoFailure = (phase, error, elapsedMs, deadlineLatenessMs, lateResult) => {
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      if (diagnosedErrors.has(error)) return null;
      diagnosedErrors.add(error);
    }
    const token = ++failureToken;
    const row = Object.freeze({ token, phase, code: safeCode(error?.code), name: safeName(error?.name) ?? (error ? 'Error' : null),
      elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0,
      deadlineLatenessMs: Number.isFinite(deadlineLatenessMs) ? Math.max(0, Math.round(deadlineLatenessMs)) : 0,
      lateResult: ['pending', 'fulfilled', 'rejected'].includes(lateResult) ? lateResult : 'rejected', lateElapsedMs: null, lateAt: null, at: Date.now() });
    stats.firstFailure ??= row;
    stats.lastFailure = row;
    return token;
  };
  const updateLateResult = (token, lateResult, lateElapsedMs, lateAt) => {
    for (const key of ['firstFailure', 'lastFailure']) {
      const previous = stats[key];
      if (previous?.token === token) stats[key] = Object.freeze({ ...previous, lateResult, lateElapsedMs, lateAt });
    }
  };
  const boundedIo = (promise, phase) => bounded(promise, ioTimeoutMs, phase, recordIoFailure, updateLateResult);
  const publicFailure = value => {
    if (!value) return null;
    const { token, ...fields } = value;
    return Object.freeze(fields);
  };
  let instance = null;
  let readyPromise = null;
  let nativeDatabase = null;
  let nativeReadyPromise = null;
  let budgetReady = false;
  let budgetPromise = null;
  let ioUnavailable = false;
  let publishUnavailable = false;
  const disableIo = () => { ioUnavailable = true; publishUnavailable = true; stats.available = false; };
  const publishers = new Map();
  const publishingScopes = new Map();
  const scopeVersions = new Map();
  const identityVersions = new Map();

  const ensureReady = () => {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      try {
        if (typeof localForage?.createInstance !== 'function' || !localForage?.INDEXEDDB) return null;
        const created = localForage.createInstance({
          name: DB_NAME,
          storeName: STORE_NAME,
          driver: localForage.INDEXEDDB,
        });
        if (!created || typeof created.getItem !== 'function' || typeof created.setItem !== 'function'
          || typeof created.removeItem !== 'function' || typeof created.keys !== 'function' || typeof created.ready !== 'function') return null;
        await boundedIo(created.ready(), 'ready');
        nativeDatabase = await openNativeDatabase();
        if (!nativeDatabase) return null;
        instance = created;
        stats.available = true;
        try {
          const budget = await nativeTransaction('budget-bootstrap', (store, transaction, setResult) => {
            const request = store.get(BUDGET_KEY);
            request.onsuccess = () => setResult(request.result);
          });
          if (Number.isSafeInteger(budget?.estimatedBytes) && budget.estimatedBytes >= 0) {
            stats.estimatedBytes = budget.estimatedBytes;
            budgetReady = true;
          }
        } catch { /* a missing or delayed diagnostic count never blocks cache reads */ }
        return instance;
      } catch (error) {
        recordIoFailure('ready', error, 0, 0, 'rejected');
        stats.available = false;
        return null;
      }
    })();
    return readyPromise;
  };

  async function scopeFor(identity) {
    try {
      const handle = String(accountHandleProvider?.() ?? '').trim();
      const origin = String(originProvider?.() ?? '').trim();
      if (!handle || !origin || !identity?.chatId) return null;
      return sha256(JSON.stringify([origin, apiBase, namespace, handle, identity.chatId]));
    } catch { return null; }
  }

  function openNativeDatabase() {
    if (nativeDatabase) return Promise.resolve(nativeDatabase);
    if (nativeReadyPromise) return nativeReadyPromise;
    nativeReadyPromise = new Promise((resolve, reject) => {
      let request;
      try {
        const factory = indexedDBProvider?.();
        if (typeof factory?.open !== 'function') { resolve(null); return; }
        request = factory.open(DB_NAME);
      } catch (error) { reject(error); return; }
      request.onblocked = () => reject(Object.assign(new Error('IDB_CACHE_DATABASE_BLOCKED'), { code: 'IDB_CACHE_DATABASE_BLOCKED' }));
      request.onerror = () => reject(request.error ?? new Error('IDB_CACHE_DATABASE_OPEN_FAILED'));
      request.onsuccess = () => {
        const database = request.result;
        if (!database?.objectStoreNames?.contains?.(STORE_NAME)) {
          database?.close?.(); resolve(null); return;
        }
        database.onversionchange = () => { database.close(); if (nativeDatabase === database) nativeDatabase = null; nativeReadyPromise = null; };
        nativeDatabase = database; resolve(database);
      };
    }).catch(error => { recordIoFailure('native-open', error, 0, 0, 'rejected'); return null; }).finally(() => { if (!nativeDatabase) nativeReadyPromise = null; });
    return nativeReadyPromise;
  }

  function nativeTransaction(phase, begin) {
    return boundedIo(new Promise((resolve, reject) => {
      const database = nativeDatabase;
      if (!database) { resolve({ ok: false, unavailable: true }); return; }
      let transaction;
      let value;
      try { transaction = database.transaction(STORE_NAME, 'readwrite'); }
      catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('IDB_CACHE_TRANSACTION_FAILED'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IDB_CACHE_TRANSACTION_ABORTED'));
      try { begin(transaction.objectStore(STORE_NAME), transaction, result => { value = result; }); }
      catch (error) { try { transaction.abort(); } catch { /* transaction already ended */ } reject(error); }
    }), phase);
  }

  function entryBytes(key, value, metadataKey, metadata) {
    const dataBytes = encoder.encode(JSON.stringify(value)).byteLength + encoder.encode(key).byteLength;
    let total = dataBytes;
    for (let index = 0; index < 3; index += 1) {
      const sized = { ...metadata, bytes: total };
      total = dataBytes + encoder.encode(metadataKey).byteLength + encoder.encode(JSON.stringify(sized)).byteLength;
    }
    return total;
  }

  let directoryMigrationPromise = null;
  async function migrateLegacyDirectories() {
    if (directoryMigrationPromise) return directoryMigrationPromise;
    directoryMigrationPromise = nativeTransaction('directory-migration', (store, transaction, setResult) => {
      const markerRequest = store.get(DIRECTORY_MARKER_KEY);
      markerRequest.onsuccess = () => {
        if (markerRequest.result?.format === DIRECTORY_FORMAT) { setResult({ migrated: false }); return; }
        const range = keyRangeProvider?.()?.bound?.('v:', 'v:\uffff');
        if (!range) throw new Error('IDB_CACHE_KEY_RANGE_UNAVAILABLE');
        const groups = new Map();
        const cursorRequest = store.openCursor(range);
        cursorRequest.onerror = () => { try { transaction.abort(); } catch { /* transaction already ended */ } };
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            const key = String(cursor.primaryKey ?? cursor.key ?? '');
            const match = /^v:([a-f0-9]{64}):/u.exec(key);
            if (match) {
              const scope = match[1], value = cursor.value;
              let group = groups.get(scope);
              if (!group) { group = { keys: [], generations: new Set(), newest: [] }; groups.set(scope, group); }
              group.keys.push(key);
              const witness = value?.witness;
              if (value?.format === FORMAT && value.scope === scope && typeof witness?.generationId === 'string' && Number.isSafeInteger(witness.revision)) {
                group.generations.add(witness.generationId);
                const candidate = { manifestKey: key, generationId: witness.generationId, revision: witness.revision,
                  headCheckpointId: String(witness.headCheckpointId ?? ''), manifestBytes: encoder.encode(JSON.stringify(value)).byteLength,
                  updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now() };
                group.newest.push(candidate);
                group.newest.sort((left, right) => right.revision - left.revision);
                if (group.newest.length > 2) group.newest.length = 2;
              }
            }
            cursor.continue(); return;
          }
          const retainedByScope = new Map();
          for (const [scope, group] of groups) {
            const oneGeneration = group.generations.size === 1;
            const generationId = oneGeneration ? [...group.generations][0] : null;
            const retained = oneGeneration ? group.newest.filter(item => item.generationId === generationId) : [];
            retainedByScope.set(scope, new Set(retained.map(item => item.manifestKey)));
            const directory = { format: DIRECTORY_FORMAT, scope, generationId, items: retained.map(({ manifestKey, generationId: itemGeneration, revision, headCheckpointId }) => ({ manifestKey, generationId: itemGeneration, revision, headCheckpointId })) };
            const directoryKey = `d:${scope}`, directoryMetadataKey = `s:${directoryKey}`;
            const directoryMetadata = { cacheKey: directoryKey, kind: 'directory', createdAt: Date.now() };
            const bytes = entryBytes(directoryKey, directory, directoryMetadataKey, directoryMetadata);
            store.put(directory, directoryKey);
            store.put({ ...directoryMetadata, bytes }, directoryMetadataKey);
            for (const item of retained) {
              const metadataKey = `s:${item.manifestKey}`;
              const metadata = { cacheKey: item.manifestKey, kind: 'manifest', createdAt: item.updatedAt };
              const manifestBytes = item.manifestBytes + encoder.encode(item.manifestKey).byteLength;
              let estimate = manifestBytes;
              for (let index = 0; index < 3; index += 1) estimate = manifestBytes + encoder.encode(metadataKey).byteLength + encoder.encode(JSON.stringify({ ...metadata, bytes: estimate })).byteLength;
              store.put({ ...metadata, bytes: estimate }, metadataKey);
            }
            for (const key of group.keys) if (!retainedByScope.get(scope).has(key)) { store.delete(key); store.delete(`s:${key}`); }
          }
          const metadataRange = keyRangeProvider?.()?.bound?.('s:', 's:\uffff');
          const rawKeyRange = keyRangeProvider?.()?.bound?.('r:', 'r:\uffff');
          if (!metadataRange || !rawKeyRange) throw new Error('IDB_CACHE_KEY_RANGE_UNAVAILABLE');
          const rawRecordKeys = new Set(), metadataRecordKeys = new Set();
          const finalize = total => {
            store.put({ format: FORMAT, estimatedBytes: total }, BUDGET_KEY);
            store.put({ format: DIRECTORY_FORMAT, migratedAt: Date.now() }, DIRECTORY_MARKER_KEY);
            setResult({ migrated: true, scopes: groups.size, estimatedBytes: total });
          };
          const scanMetadata = () => {
            let total = 0;
            const metadataCursor = store.openCursor(metadataRange);
            metadataCursor.onerror = () => { try { transaction.abort(); } catch { /* transaction already ended */ } };
            metadataCursor.onsuccess = () => {
              const cursorItem = metadataCursor.result;
              if (cursorItem) {
                const key = String(cursorItem.primaryKey ?? cursorItem.key ?? ''), value = cursorItem.value;
                if (key.startsWith('s:v:')) {
                  const manifestKey = key.slice(2), match = /^v:([a-f0-9]{64}):/u.exec(manifestKey);
                  if (!match || !retainedByScope.get(match[1])?.has(manifestKey)) { cursorItem.delete(); cursorItem.continue(); return; }
                }
                if (key.startsWith('s:r:')) {
                  const recordKey = typeof value?.recordKey === 'string' ? value.recordKey : key.slice(2);
                  if (!rawRecordKeys.has(recordKey)) { cursorItem.delete(); cursorItem.continue(); return; }
                  if (!Number.isSafeInteger(value?.bytes) || value.bytes < 0) { cursorItem.delete(); store.delete(recordKey); cursorItem.continue(); return; }
                  metadataRecordKeys.add(recordKey);
                }
                if (Number.isSafeInteger(value?.bytes) && value.bytes >= 0) {
                  total += value.bytes;
                  if (key.startsWith('s:r:') && value.recordKey && !value.kind) {
                    // Legacy .49 metadata counted only the envelope; include a conservative wrapper/key allowance without rereading it.
                    const upgraded = { ...value, cacheKey: value.recordKey, kind: 'record', bytes: value.bytes + encoder.encode(value.recordKey).byteLength + 512 };
                    total += upgraded.bytes - value.bytes;
                    cursorItem.update(upgraded);
                  }
                }
                cursorItem.continue(); return;
              }
              const missingMetadataKeys = [...rawRecordKeys].filter(key => !metadataRecordKeys.has(key));
              let pending = missingMetadataKeys.length;
              if (!pending) { finalize(total); return; }
              missingMetadataKeys.forEach(recordKey => {
                const request = store.get(`s:${recordKey}`);
                request.onsuccess = () => {
                  const metadata = request.result;
                  if (Number.isSafeInteger(metadata?.bytes) && metadata.bytes >= 0) total += metadata.bytes;
                  else store.delete(recordKey);
                  if (--pending === 0) finalize(total);
                };
              });
            };
          };
          const rawKeyCursor = store.openKeyCursor(rawKeyRange);
          rawKeyCursor.onerror = () => { try { transaction.abort(); } catch { /* transaction already ended */ } };
          rawKeyCursor.onsuccess = () => {
            const cursor = rawKeyCursor.result;
            if (cursor) { rawRecordKeys.add(String(cursor.primaryKey ?? cursor.key)); cursor.continue(); return; }
            scanMetadata();
          };
        };
      };
    }).then(value => {
      if (value?.unavailable) return false;
      return true;
    }).catch(error => {
      recordIoFailure('directory-migration', error, 0, 0, 'rejected');
      return false;
    }).finally(() => { directoryMigrationPromise = null; });
    return directoryMigrationPromise;
  }

  function identityVersionKey(identity) {
    try {
      const handle = String(accountHandleProvider?.() ?? '').trim();
      const origin = String(originProvider?.() ?? '').trim();
      if (!handle || !origin || !identity?.chatId) return null;
      return JSON.stringify([origin, apiBase, namespace, handle, identity.chatId]);
    } catch { return null; }
  }
  function captureIdentityVersion(identity) {
    const key = identityVersionKey(identity);
    return key ? Object.freeze({ key, version: identityVersions.get(key) ?? 0 }) : null;
  }
  function identityVersionIsCurrent(token) {
    return !token || token.version === (identityVersions.get(token.key) ?? 0);
  }

  async function readManifest(scope, witness) {
    const db = await ensureReady();
    if (!db || ioUnavailable || !scope || !witness?.generationId) return false;
    const key = `v:${scope}:${await sha256(witnessKey(witness))}`;
    try {
      if (await boundedIo(db.getItem(`x:${scope}`), 'manifest-invalidation-read')) return null;
      const value = await boundedIo(db.getItem(key), 'manifest-read');
      if (value?.format !== FORMAT || value.scope !== scope || witnessKey(value.witness) !== witnessKey(witness)
        || !value.recordRefs || typeof value.recordRefs !== 'object' || Array.isArray(value.recordRefs)
        || [...CORE_TYPES].some(type => !Array.isArray(value.recordRefs[type]) || value.recordRefs[type].some(id => typeof id !== 'string'))) return null;
      return value;
    } catch (error) { recordIoFailure('manifest-read', error, 0, 0, 'rejected'); disableIo(); return false; }
  }

  async function readRecord(scope, witness, recordType, recordId, recordRefs = null) {
    const db = await ensureReady();
    if (!db || ioUnavailable || !scope || !CORE_TYPES.has(recordType) || !witness?.generationId || typeof recordId !== 'string') return null;
    const refs = recordRefs?.recordRefs ?? recordRefs;
    if (!Array.isArray(refs?.[recordType]) || !refs[recordType].includes(recordId)) { stats.misses += 1; return null; }
    const key = `r:${scope}:${encoded(witness.generationId)}:${recordType}:${encoded(recordId)}`;
    try {
      const value = await boundedIo(db.getItem(key), 'record-read');
      if (!value) { stats.misses += 1; return null; }
      if (value.format !== FORMAT || value.scope !== scope || value.rootGenerationId !== witness.generationId
        || value.recordType !== recordType || value.recordId !== recordId
        || !Number.isSafeInteger(value.revision) || value.revision < 1 || !plainRecord(value.envelope)
        || value.envelope.generationId !== value.recordGenerationId || value.envelope.revision !== value.revision
        || value.envelope.data?.recordType !== recordType || (recordType !== 'index'
          && value.envelope.data?.id !== (recordId.startsWith(RECORD_ID_PREFIX[recordType] ?? '\u0000') ? recordId.slice(RECORD_ID_PREFIX[recordType].length) : recordId))
        || await sha256(JSON.stringify(value.envelope)) !== value.digest) {
        stats.corruptions += 1;
        await removeRecord(scope, witness, recordType, recordId).catch(() => {});
        return null;
      }
      stats.hits += 1;
      return value.envelope;
    } catch (error) {
      stats.misses += 1;
      recordIoFailure('record-read', error, 0, 0, 'rejected');
      disableIo();
      return null;
    }
  }

  async function removeRecord(scope, witness, recordType, recordId) {
    const db = await ensureReady();
    if (!db || !scope || !CORE_TYPES.has(recordType) || !witness?.generationId || typeof recordId !== 'string') return false;
    const key = `r:${scope}:${encoded(witness.generationId)}:${recordType}:${encoded(recordId)}`;
    try {
      const removed = await nativeTransaction('record-remove-transaction', (store, transaction, setResult) => {
        const metadataRequest = store.get(`s:${key}`), budgetRequest = store.get(BUDGET_KEY);
        let metadataReady = false, budgetReady = false, metadata, budget;
        const finish = () => {
          if (!metadataReady || !budgetReady) return;
          store.delete(key); store.delete(`s:${key}`);
          const estimatedBytes = Math.max(0, (Number.isSafeInteger(budget?.estimatedBytes) ? budget.estimatedBytes : 0)
            - (Number.isSafeInteger(metadata?.bytes) ? metadata.bytes : 0));
          store.put({ format: FORMAT, estimatedBytes }, BUDGET_KEY);
          setResult({ removed: true, estimatedBytes });
        };
        metadataRequest.onsuccess = () => { metadata = metadataRequest.result; metadataReady = true; finish(); };
        budgetRequest.onsuccess = () => { budget = budgetRequest.result; budgetReady = true; finish(); };
      });
      if (removed?.unavailable) return false;
      if (Number.isSafeInteger(removed?.estimatedBytes)) stats.estimatedBytes = removed.estimatedBytes;
      return true;
    } catch (error) { recordIoFailure('record-remove', error, 0, 0, 'rejected'); return false; }
  }

  async function hydrateBudget(db) {
    if (budgetReady) return;
    if (budgetPromise) return budgetPromise;
    budgetPromise = (async () => {
      const currentBudget = await nativeTransaction('budget-read', (store, transaction, setResult) => {
        const request = store.get(BUDGET_KEY);
        request.onsuccess = () => setResult(request.result);
      });
      if (Number.isSafeInteger(currentBudget?.estimatedBytes) && currentBudget.estimatedBytes >= 0) {
        stats.estimatedBytes = currentBudget.estimatedBytes;
        budgetReady = true;
        return;
      }
      let total = 0;
      const keys = await boundedIo(db.keys(), 'budget-key-list');
      const metadataKeys = Array.isArray(keys) ? keys.filter(key => typeof key === 'string' && key.startsWith('s:')) : [];
      for (let offset = 0; offset < metadataKeys.length; offset += WRITE_CONCURRENCY) {
        const values = await boundedIo(Promise.all(metadataKeys.slice(offset, offset + WRITE_CONCURRENCY).map(key => db.getItem(key))), 'budget-metadata-read');
        for (const value of values) if (Number.isSafeInteger(value?.bytes) && value.bytes >= 0) total += value.bytes;
      }
      const result = await nativeTransaction('budget-initialize', (store, transaction, setResult) => {
        const request = store.get(BUDGET_KEY);
        request.onsuccess = () => {
          const current = request.result;
          if (Number.isSafeInteger(current?.estimatedBytes) && current.estimatedBytes >= 0) {
            setResult(current.estimatedBytes);
          } else {
            store.put({ format: FORMAT, estimatedBytes: total }, BUDGET_KEY);
            setResult(total);
          }
        };
      });
      if (!result?.unavailable) stats.estimatedBytes = Number.isSafeInteger(result) ? result : stats.estimatedBytes;
      budgetReady = true;
    })().catch(error => { recordIoFailure('budget-scan', error, 0, 0, 'rejected'); }).finally(() => { budgetPromise = null; });
    return budgetPromise;
  }

  async function evictToBudget(db) {
    try {
      await hydrateBudget(db);
      const result = await nativeTransaction('eviction-transaction', (store, transaction, setResult) => {
        const budgetRequest = store.get(BUDGET_KEY);
        budgetRequest.onsuccess = () => {
          let total = Number.isSafeInteger(budgetRequest.result?.estimatedBytes) ? budgetRequest.result.estimatedBytes : 0;
          if (total <= maxBytes) { setResult({ estimatedBytes: total, evictedRecords: 0 }); return; }
          const range = keyRangeProvider?.()?.bound?.('s:', 's:\uffff');
          if (!range) throw new Error('IDB_CACHE_KEY_RANGE_UNAVAILABLE');
          const rows = [], removedKeys = new Set();
          let evictedRecords = 0;
          const cursorRequest = store.openCursor(range);
          cursorRequest.onerror = () => { try { transaction.abort(); } catch { /* transaction already ended */ } };
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              const value = cursor.value;
              if (Number.isSafeInteger(value?.bytes) && value.bytes >= 0 && typeof value.cacheKey === 'string') {
                rows.push({ metadataKey: String(cursor.primaryKey ?? cursor.key), ...value });
              }
              cursor.continue(); return;
            }
            total = rows.reduce((sum, row) => sum + row.bytes, 0);
            rows.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
            let index = 0;
            const finish = () => {
              store.put({ format: FORMAT, estimatedBytes: Math.max(0, total) }, BUDGET_KEY);
              setResult({ estimatedBytes: Math.max(0, total), evictedRecords });
            };
            const removeRow = row => {
              if (removedKeys.has(row.cacheKey)) return;
              const request = store.delete(row.cacheKey);
              store.delete(row.metadataKey); removedKeys.add(row.cacheKey);
              total -= row.bytes;
              if (row.kind === 'record') evictedRecords += 1;
              request.onsuccess = () => next();
            };
            const removeScopeManifests = (scope, directory) => {
              const directoryKey = `d:${scope}`;
              const manifestKeys = Array.isArray(directory?.items) ? directory.items.map(item => item.manifestKey).filter(key => typeof key === 'string') : [];
              const scopeRows = rows.filter(row => row.kind === 'manifest' && row.cacheKey.startsWith(`v:${scope}:`));
              for (const row of scopeRows) {
                if (!removedKeys.has(row.cacheKey)) { store.delete(row.cacheKey); store.delete(row.metadataKey); removedKeys.add(row.cacheKey); total -= row.bytes; }
              }
              for (const manifestKey of manifestKeys) store.delete(manifestKey);
              const directoryRow = rows.find(row => row.cacheKey === directoryKey);
              if (!removedKeys.has(directoryKey)) {
                store.delete(directoryKey); store.delete(`s:${directoryKey}`); removedKeys.add(directoryKey);
                if (directoryRow) total -= directoryRow.bytes;
              }
              next();
            };
            const next = () => {
              while (index < rows.length && (total <= maxBytes || removedKeys.has(rows[index].cacheKey))) index += 1;
              if (total <= maxBytes || index >= rows.length) { finish(); return; }
              const row = rows[index++];
              if (row.kind !== 'manifest' && row.kind !== 'directory') { removeRow(row); return; }
              const scope = row.kind === 'directory' ? row.cacheKey.slice(2) : /^v:([a-f0-9]{64}):/u.exec(row.cacheKey)?.[1];
              if (!scope) { removeRow(row); return; }
              const request = store.get(`d:${scope}`);
              request.onsuccess = () => {
                if (row.kind === 'directory') { removeScopeManifests(scope, request.result); return; }
                const directory = request.result;
                const items = Array.isArray(directory?.items) ? directory.items.filter(item => item?.manifestKey !== row.cacheKey) : [];
                store.delete(row.cacheKey); store.delete(row.metadataKey); removedKeys.add(row.cacheKey); total -= row.bytes;
                if (!directory || items.length === 0) { removeScopeManifests(scope, directory); return; }
                const nextDirectory = { ...directory, items, updatedAt: Date.now() };
                const directoryKey = `d:${scope}`, metadataKey = `s:${directoryKey}`;
                const previousDirectoryRow = rows.find(item => item.cacheKey === directoryKey);
                const metadataBase = { cacheKey: directoryKey, kind: 'directory', createdAt: previousDirectoryRow?.createdAt ?? Date.now() };
                const bytes = entryBytes(directoryKey, nextDirectory, metadataKey, metadataBase);
                const previousBytes = previousDirectoryRow?.bytes ?? 0;
                store.put(nextDirectory, directoryKey); store.put({ ...metadataBase, bytes }, metadataKey);
                total += bytes - previousBytes;
                next();
              };
            };
            next();
          };
        };
      });
      if (result?.unavailable) return;
      if (Number.isSafeInteger(result?.estimatedBytes)) stats.estimatedBytes = result.estimatedBytes;
      if (Number.isSafeInteger(result?.evictedRecords)) stats.evictedRecords += result.evictedRecords;
    } catch (error) { recordIoFailure('eviction', error, 0, 0, 'rejected'); /* capacity cleanup is best effort and cannot affect a committed record */ }
  }

  function normalizeRecordRefs(recordRefs = {}) {
    const normalized = {};
    for (const type of CORE_TYPES) {
      const values = Array.isArray(recordRefs[type]) ? recordRefs[type].filter(value => typeof value === 'string') : [];
      normalized[type] = [...new Set(values)].sort();
    }
    return normalized;
  }

  async function upsertRecord(scope, witness, recordType, recordId, envelope) {
    const key = `r:${scope}:${encoded(witness.generationId)}:${recordType}:${encoded(recordId)}`;
    const metadataKey = `s:${key}`;
    const digest = await sha256(JSON.stringify(envelope));
    const recordValue = { format: FORMAT, scope, rootGenerationId: witness.generationId, recordGenerationId: envelope.generationId,
      recordType, recordId, revision: envelope.revision, digest, envelope };
    const metadataBase = { cacheKey: key, recordKey: key, kind: 'record', createdAt: Date.now() };
    const bytes = entryBytes(key, recordValue, metadataKey, metadataBase);
    return nativeTransaction('publish-record-transaction', (store, transaction, setResult) => {
      const requests = [store.get(key), store.get(metadataKey), store.get(BUDGET_KEY)];
      const values = new Array(requests.length), ready = new Set();
      const finish = index => {
        values[index] = requests[index].result;
        ready.add(index);
        if (ready.size !== requests.length) return;
        const [previous, previousMetadata, budget] = values;
        const sameRecord = previous?.format === FORMAT && previous.digest === digest && previous.revision === envelope.revision;
        const metadataMatches = Number.isSafeInteger(previousMetadata?.bytes) && previousMetadata.bytes === bytes
          && previousMetadata.cacheKey === key && previousMetadata.kind === 'record';
        if (!sameRecord) store.put(recordValue, key);
        if (!metadataMatches) store.put({ ...metadataBase, createdAt: previousMetadata?.createdAt ?? metadataBase.createdAt, bytes }, metadataKey);
        const previousBytes = Number.isSafeInteger(previousMetadata?.bytes) && previousMetadata.bytes >= 0 ? previousMetadata.bytes : 0;
        const nextBytes = (Number.isSafeInteger(budget?.estimatedBytes) ? budget.estimatedBytes : 0) + (metadataMatches ? 0 : bytes - previousBytes);
        if (!sameRecord || !metadataMatches) store.put({ format: FORMAT, estimatedBytes: Math.max(0, nextBytes) }, BUDGET_KEY);
        setResult({ wrote: !sameRecord, repairedMetadata: !metadataMatches, estimatedBytes: Math.max(0, nextBytes) });
      };
      requests.forEach((request, index) => { request.onsuccess = () => finish(index); });
    });
  }

  async function commitManifest(scope, witness, manifestKey, requestedRefs, observedDirectory, observedInvalidation, expectedVersion) {
    const directoryKey = `d:${scope}`, directoryMetadataKey = `s:d:${scope}`, manifestMetadataKey = `s:${manifestKey}`;
    const manifestValue = { format: FORMAT, scope, witness, recordRefs: requestedRefs, updatedAt: Date.now() };
    const nextVersionIsCurrent = () => publicationVersionIsCurrent(scope, expectedVersion);
    return nativeTransaction('manifest-directory-transaction', (store, transaction, setResult) => {
      const keys = [directoryKey, `x:${scope}`, manifestKey, directoryMetadataKey, manifestMetadataKey, BUDGET_KEY];
      const requests = keys.map(key => store.get(key));
      const values = new Array(requests.length), ready = new Set();
      const finishRead = index => {
        values[index] = requests[index].result;
        ready.add(index);
        if (ready.size !== requests.length) return;
        const [currentDirectory, currentInvalidation, currentManifest, currentDirectoryMetadata, currentManifestMetadata, budget] = values;
        if (!nextVersionIsCurrent()) { setResult({ committed: false, stale: true }); return; }
        const currentGenerationChanged = Boolean(currentDirectory?.generationId && currentDirectory.generationId !== witness.generationId);
        if (JSON.stringify(currentInvalidation ?? null) !== JSON.stringify(observedInvalidation ?? null)) {
          setResult({ committed: false, changed: true }); return;
        }
        if (currentGenerationChanged && (!observedDirectory?.generationId || currentDirectory.generationId !== observedDirectory.generationId)) {
          setResult({ committed: false, changed: true }); return;
        }
        const currentRefs = normalizeRecordRefs(currentManifest?.recordRefs);
        for (const type of CORE_TYPES) manifestValue.recordRefs[type] = [...new Set([...manifestValue.recordRefs[type], ...currentRefs[type]])].sort();
        const oldDirectoryItems = currentDirectory?.format === DIRECTORY_FORMAT && currentDirectory.scope === scope ? currentDirectory.items : [];
        const sameGenerationItems = currentGenerationChanged ? [] : oldDirectoryItems.filter(item => item?.generationId === witness.generationId && typeof item.manifestKey === 'string');
        const mergedItems = sameGenerationItems.filter(item => item.manifestKey !== manifestKey);
        mergedItems.push({ manifestKey, generationId: witness.generationId, revision: witness.revision, headCheckpointId: witness.headCheckpointId });
        mergedItems.sort((left, right) => right.revision - left.revision || String(left.headCheckpointId).localeCompare(String(right.headCheckpointId)));
        const retained = mergedItems.slice(0, 2);
        const retainedKeys = new Set(retained.map(item => item.manifestKey));
        if (!retainedKeys.has(manifestKey)) { setResult({ committed: false, obsolete: true }); return; }
        const directory = { format: DIRECTORY_FORMAT, scope, generationId: witness.generationId, items: retained, updatedAt: Date.now() };
        const removeKeys = [...new Set([...oldDirectoryItems.map(item => item.manifestKey), ...sameGenerationItems.map(item => item.manifestKey)])]
          .filter(key => key !== manifestKey && !retainedKeys.has(key) && typeof key === 'string');
        const staleMetaRequests = removeKeys.map(key => store.get(`s:${key}`));
        let pending = staleMetaRequests.length;
        const staleMetadata = new Array(staleMetaRequests.length);
        const commit = () => {
          const previousManifestBytes = Number.isSafeInteger(currentManifestMetadata?.bytes) ? currentManifestMetadata.bytes : 0;
          const previousDirectoryBytes = Number.isSafeInteger(currentDirectoryMetadata?.bytes) ? currentDirectoryMetadata.bytes : 0;
          const manifestMetadataBase = { cacheKey: manifestKey, kind: 'manifest', createdAt: currentManifestMetadata?.createdAt ?? manifestValue.updatedAt };
          const directoryMetadataBase = { cacheKey: directoryKey, kind: 'directory', createdAt: directory.updatedAt };
          const manifestBytes = entryBytes(manifestKey, manifestValue, manifestMetadataKey, manifestMetadataBase);
          const directoryBytes = entryBytes(directoryKey, directory, directoryMetadataKey, directoryMetadataBase);
          store.put(manifestValue, manifestKey);
          store.put({ ...manifestMetadataBase, bytes: manifestBytes }, manifestMetadataKey);
          store.put(directory, directoryKey);
          store.put({ ...directoryMetadataBase, bytes: directoryBytes }, directoryMetadataKey);
          let removedBytes = 0;
          for (let index = 0; index < removeKeys.length; index += 1) {
            const key = removeKeys[index];
            store.delete(key); store.delete(`s:${key}`);
            if (Number.isSafeInteger(staleMetadata[index]?.bytes)) removedBytes += staleMetadata[index].bytes;
          }
          if (currentInvalidation) store.delete(`x:${scope}`);
          const previousBudget = Number.isSafeInteger(budget?.estimatedBytes) ? budget.estimatedBytes : 0;
          const nextBudget = Math.max(0, previousBudget - previousManifestBytes - previousDirectoryBytes - removedBytes + manifestBytes + directoryBytes);
          store.put({ format: FORMAT, estimatedBytes: nextBudget }, BUDGET_KEY);
          setResult({ committed: true, wroteManifest: true, estimatedBytes: nextBudget });
        };
        if (!pending) { commit(); return; }
        staleMetaRequests.forEach((request, index) => { request.onsuccess = () => { staleMetadata[index] = request.result; if (--pending === 0) commit(); }; });
      };
      requests.forEach((request, index) => { request.onsuccess = () => finishRead(index); });
    });
  }

  function captureScopeVersion(scope) { return scopeVersions.get(scope) ?? 0; }
  function publicationVersionIsCurrent(scope, version) {
    return version?.key ? identityVersionIsCurrent(version) : version === captureScopeVersion(scope);
  }

  async function publish(scope, witness, records, recordRefs = {}, expectedVersion = captureScopeVersion(scope), verifyRoot = null) {
    const lockKey = scope;
    if (ioUnavailable || publishUnavailable) return false;
    const current = publishers.get(lockKey);
    if (current) return current;
    if (publishingScopes.has(scope)) return false;
    if (!publicationVersionIsCurrent(scope, expectedVersion)) return false;
    const task = publishNow(scope, witness, records, recordRefs, expectedVersion, verifyRoot);
    publishers.set(lockKey, task);
    publishingScopes.set(scope, lockKey);
    try { return await task; }
    finally {
      if (publishers.get(lockKey) === task) publishers.delete(lockKey);
      if (publishingScopes.get(scope) === lockKey) publishingScopes.delete(scope);
    }
  }

  async function publishNow(scope, witness, records, recordRefs, expectedVersion, verifyRoot) {
    const db = await ensureReady();
    if (!db || !scope || !witness?.generationId || !Array.isArray(records)) return false;
    if (!await migrateLegacyDirectories() || ioUnavailable || publishUnavailable) return false;
    const requestedRefs = normalizeRecordRefs(recordRefs);
    let observedDirectory, observedInvalidation;
    try {
      observedDirectory = await boundedIo(db.getItem(`d:${scope}`), 'publish-directory-read');
      observedInvalidation = await boundedIo(db.getItem(`x:${scope}`), 'publish-invalidation-read');
    } catch (error) { recordIoFailure('publish-directory-read', error, 0, 0, 'rejected'); disableIo(); return false; }
    const directoryMismatch = Boolean(observedDirectory?.generationId && observedDirectory.generationId !== witness.generationId);
    if (directoryMismatch || observedInvalidation) {
      let proof = null;
      try { proof = await verifyRoot?.(); } catch { return false; }
      if (proof?.generationId !== witness.generationId) return false;
      if (observedInvalidation && proof.revision !== witness.revision) return false;
    }
    let previousManifest = null;
    try {
      const manifestKey = `v:${scope}:${await sha256(witnessKey(witness))}`;
      previousManifest = await boundedIo(db.getItem(manifestKey), 'publish-manifest-read');
      if (previousManifest?.format !== FORMAT || previousManifest.scope !== scope || witnessKey(previousManifest.witness) !== witnessKey(witness)) previousManifest = null;
    } catch (error) { recordIoFailure('publish-manifest-read', error, 0, 0, 'rejected'); disableIo(); return false; }
    const existingRefs = normalizeRecordRefs(previousManifest?.recordRefs);
    for (const type of CORE_TYPES) requestedRefs[type] = [...new Set([...existingRefs[type], ...requestedRefs[type]])].sort();
    let wroteRecords = false;
    await hydrateBudget(db);
    let cursor = 0;
    async function worker() {
      while (!publishUnavailable && cursor < records.length) {
        const record = records[cursor++];
        const recordType = record?.envelope?.data?.recordType;
        const recordId = record?.recordId;
        const envelope = record?.envelope;
        if (!CORE_TYPES.has(recordType) || typeof recordId !== 'string' || !plainRecord(envelope)
          || typeof envelope.generationId !== 'string' || !Number.isSafeInteger(envelope.revision)) continue;
        try {
          const outcome = await upsertRecord(scope, witness, recordType, recordId, envelope);
          if (outcome?.unavailable) throw new Error('IDB_CACHE_TRANSACTION_UNAVAILABLE');
          if (Number.isSafeInteger(outcome?.estimatedBytes)) stats.estimatedBytes = outcome.estimatedBytes;
          if (outcome?.wrote) { stats.writes += 1; wroteRecords = true; }
          if (outcome?.repairedMetadata) wroteRecords = true;
        } catch (error) { stats.writeFailures += 1; recordIoFailure('publish-record', error, 0, 0, 'rejected'); disableIo(); }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, records.length) }, worker));
      if (ioUnavailable || publishUnavailable) return false;
      const manifestKey = `v:${scope}:${await sha256(witnessKey(witness))}`;
      if (!publicationVersionIsCurrent(scope, expectedVersion)) return false;
      const committed = await commitManifest(scope, witness, manifestKey, requestedRefs, observedDirectory, observedInvalidation, expectedVersion);
      if (!committed?.committed) return false;
      if (Number.isSafeInteger(committed.estimatedBytes)) stats.estimatedBytes = committed.estimatedBytes;
      if (wroteRecords || committed.wroteManifest) await evictToBudget(db);
      return true;
    } catch (error) {
      stats.writeFailures += 1;
      recordIoFailure('publish', error, 0, 0, 'rejected');
      disableIo();
      try { logger?.debug?.('[qianqianjie] core cache publish skipped', { code: error?.code ?? 'IDB_CACHE_WRITE_FAILED' }); } catch { /* cache diagnostics are optional */ }
      return false;
    }
  }

  async function invalidateScope(scope) {
    if (typeof scope !== 'string' || !scope) return false;
    scopeVersions.set(scope, captureScopeVersion(scope) + 1);
    const active = publishers.get(scope);
    if (!await ensureReady()) return false;
    try {
      const invalidated = await nativeTransaction('invalidate-scope-transaction', (store, transaction, setResult) => {
        store.put({ invalidatedAt: Date.now() }, `x:${scope}`);
        store.delete(`d:${scope}`); store.delete(`s:d:${scope}`);
        const range = keyRangeProvider?.()?.bound?.(`v:${scope}:`, `v:${scope}:\uffff`);
        if (!range) throw new Error('IDB_CACHE_KEY_RANGE_UNAVAILABLE');
        const cursorRequest = store.openCursor(range);
        cursorRequest.onerror = () => { try { transaction.abort(); } catch { /* transaction already ended */ } };
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) {
            const key = String(cursor.primaryKey ?? cursor.key);
            cursor.delete(); store.delete(`s:${key}`); cursor.continue(); return;
          }
          const metadataRange = keyRangeProvider?.()?.bound?.('s:', 's:\uffff');
          if (!metadataRange) throw new Error('IDB_CACHE_KEY_RANGE_UNAVAILABLE');
          let total = 0;
          const metadataCursor = store.openCursor(metadataRange);
          metadataCursor.onerror = () => { try { transaction.abort(); } catch { /* transaction already ended */ } };
          metadataCursor.onsuccess = () => {
            const item = metadataCursor.result;
            if (item) {
              if (Number.isSafeInteger(item.value?.bytes) && item.value.bytes >= 0) total += item.value.bytes;
              item.continue(); return;
            }
            store.put({ format: FORMAT, estimatedBytes: total }, BUDGET_KEY);
            setResult({ invalidated: true, estimatedBytes: total });
          };
        };
      });
      if (!invalidated?.invalidated) return false;
      stats.estimatedBytes = invalidated.estimatedBytes;
      if (active) await Promise.race([active.catch(() => {}), new Promise(resolve => setTimeout(resolve, ioTimeoutMs + 50))]);
      return true;
    } catch (error) { recordIoFailure('invalidate', error, 0, 0, 'rejected'); return false; }
  }

  async function invalidateIdentity(identity) {
    const token = captureIdentityVersion(identity);
    if (!token) return false;
    identityVersions.set(token.key, token.version + 1);
    const scope = await scopeFor(identity);
    return scope ? invalidateScope(scope) : false;
  }

  async function maintain() {
    const db = await ensureReady();
    if (!db || ioUnavailable || publishUnavailable) return false;
    if (!await migrateLegacyDirectories() || ioUnavailable) return false;
    await hydrateBudget(db);
    if (!ioUnavailable && stats.estimatedBytes > maxBytes) await evictToBudget(db);
    return !ioUnavailable;
  }

  return Object.freeze({ scopeFor, captureScopeVersion, captureIdentityVersion, readManifest, readRecord, removeRecord, publish, invalidateScope, invalidateIdentity,
    maintain,
    getStats: () => Object.freeze({ ...stats, firstFailure: publicFailure(stats.firstFailure), lastFailure: publicFailure(stats.lastFailure) }) });
}

export const V3_CORE_CACHE_RECORD_TYPES = Object.freeze([...CORE_TYPES]);
