import { isUuid } from './host-context.js';
import { sha256 } from './identity.js';
import {
  validateArchiveV2MemoryBatch,
  validateArchiveV2MemoryManifest,
} from './archive-v2-memory-foundation.js';
import { validateArchiveV2MemoryPeopleResult } from './archive-v2-memory-people-foundation.js';

export const ARCHIVE_V2_MEMORY_MANIFEST_RECORD_ID = 'memory-manifest';

const BATCH_RECORD_PREFIX = 'memory-batch-';
const PEOPLE_RECORD_PREFIX = 'memory-people-';
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ENVELOPE_KEYS = ['schemaVersion', 'revision', 'generationId', 'createdAt', 'updatedAt', 'data'];

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeJsonClone(value, code = 'MEMORY_STORE_JSON_INVALID', active = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code);
    return value;
  }
  if (typeof value !== 'object' || active.has(value)) fail(code);
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string')) fail(code);
    if (Array.isArray(value)) {
      if (keys.some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) fail(code);
      const clone = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
        clone.push(safeJsonClone(descriptor.value, code, active));
      }
      return clone;
    }
    if (!isPlainObject(value)) fail(code);
    const clone = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
      clone[key] = safeJsonClone(descriptor.value, code, active);
    }
    return clone;
  } finally {
    active.delete(value);
  }
}

function exactKeys(value, expected, code) {
  if (!isPlainObject(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code);
}

function requiredString(value, code, maxLength = 512) {
  if (typeof value !== 'string') fail(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) fail(code);
  return normalized;
}

function safeIdentity(raw) {
  if (!isPlainObject(raw)) fail('MEMORY_STORE_CONTEXT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const read = (...names) => {
    for (const name of names) {
      const descriptor = descriptors[name];
      if (descriptor && Object.hasOwn(descriptor, 'value')) return descriptor.value;
      if (descriptor) fail('MEMORY_STORE_CONTEXT_INVALID');
    }
    return undefined;
  };
  const identity = {
    hostChatId: read('hostChatId'),
    chatId: read('chatId'),
    characterLocator: read('characterLocator', 'characterAvatar'),
    personaLocator: read('personaLocator', 'personaAvatar'),
  };
  identity.hostChatId = requiredString(identity.hostChatId, 'MEMORY_STORE_CONTEXT_INVALID');
  identity.chatId = requiredString(identity.chatId, 'MEMORY_STORE_CONTEXT_INVALID');
  identity.characterLocator = requiredString(identity.characterLocator, 'MEMORY_STORE_CONTEXT_INVALID');
  identity.personaLocator = requiredString(identity.personaLocator, 'MEMORY_STORE_CONTEXT_INVALID');
  if (!isUuid(identity.chatId)) fail('MEMORY_STORE_CHAT_ID_INVALID');
  return Object.freeze(identity);
}

function sameIdentity(left, right) {
  return left.hostChatId === right.hostChatId
    && left.chatId === right.chatId
    && left.characterLocator === right.characterLocator
    && left.personaLocator === right.personaLocator;
}

function safeEnvelope(value, validateData) {
  const envelope = safeJsonClone(value, 'MEMORY_STORE_ENVELOPE_INVALID');
  exactKeys(envelope, ENVELOPE_KEYS, 'MEMORY_STORE_ENVELOPE_INVALID');
  if (envelope.schemaVersion !== 1
    || !Number.isSafeInteger(envelope.revision)
    || envelope.revision < 1
    || typeof envelope.generationId !== 'string'
    || !envelope.generationId.trim()
    || typeof envelope.createdAt !== 'string'
    || !Number.isFinite(Date.parse(envelope.createdAt))
    || typeof envelope.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(envelope.updatedAt))
    || Date.parse(envelope.updatedAt) < Date.parse(envelope.createdAt)) {
    fail('MEMORY_STORE_ENVELOPE_INVALID');
  }
  return Object.freeze({ data: validateData(envelope.data), revision: envelope.revision });
}

function planIdentity(plan) {
  const clone = safeJsonClone(plan, 'MEMORY_STORE_PLAN_INVALID');
  if (!isPlainObject(clone)
    || !Number.isSafeInteger(clone.batchIndex)
    || clone.batchIndex < 0
    || !FINGERPRINT_PATTERN.test(clone.sourceFingerprint)) {
    fail('MEMORY_STORE_PLAN_INVALID');
  }
  return { plan: clone, batchIndex: clone.batchIndex, sourceFingerprint: clone.sourceFingerprint };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function createArchiveV2MemoryBatchRecordId({ scanId, batchIndex, sourceFingerprint } = {}) {
  const safeScanId = requiredString(scanId, 'MEMORY_STORE_SCAN_ID_INVALID', 256);
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex > 99999) {
    fail('MEMORY_STORE_BATCH_INDEX_INVALID');
  }
  if (typeof sourceFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(sourceFingerprint)) {
    fail('MEMORY_STORE_FINGERPRINT_INVALID');
  }
  const digest = await sha256(JSON.stringify([
    'myriad-knots-memory-batch-record-v1', safeScanId, batchIndex, sourceFingerprint,
  ]));
  return `${BATCH_RECORD_PREFIX}${batchIndex}-${digest}`;
}

export async function createArchiveV2MemoryPeopleRecordId({ scanId, sourceFingerprint } = {}) {
  const safeScanId = requiredString(scanId, 'MEMORY_STORE_SCAN_ID_INVALID', 256);
  if (typeof sourceFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(sourceFingerprint)) {
    fail('MEMORY_STORE_FINGERPRINT_INVALID');
  }
  const digest = await sha256(JSON.stringify([
    'myriad-knots-memory-people-record-v1', safeScanId, sourceFingerprint,
  ]));
  return `${PEOPLE_RECORD_PREFIX}${digest}`;
}

export function createArchiveV2MemoryStore({ client, contextProvider, isEnabled = true } = {}) {
  if (typeof client?.get !== 'function' || typeof client?.put !== 'function') {
    throw new TypeError('memory store client 必须提供 get 和 put');
  }
  if (typeof contextProvider !== 'function') throw new TypeError('memory store contextProvider 必须是函数');
  if (typeof isEnabled !== 'boolean' && typeof isEnabled !== 'function') {
    throw new TypeError('memory store isEnabled 必须是布尔值或函数');
  }

  let epoch = 0;
  const enabled = () => {
    try { return (typeof isEnabled === 'function' ? isEnabled() : isEnabled) === true; }
    catch { return false; }
  };
  const captureIdentity = () => safeIdentity(contextProvider());
  const operationState = operation => {
    if (operation.epoch !== epoch) return 'stale';
    if (!enabled()) return 'disabled';
    try { return sameIdentity(operation.identity, captureIdentity()) ? 'current' : 'stale'; }
    catch { return 'stale'; }
  };

  function execute(prepare, run) {
    if (!enabled()) return Promise.resolve({ status: 'disabled' });
    let operation;
    try { operation = { epoch, identity: captureIdentity() }; }
    catch (error) { return Promise.reject(error); }
    return (async () => {
      const prepared = await prepare(operation.identity);
      const before = operationState(operation);
      if (before !== 'current') return { status: before };
      try {
        const result = await run(operation.identity, prepared);
        const after = operationState(operation);
        return after === 'current' ? result : { status: after };
      } catch (error) {
        const after = operationState(operation);
        if (after !== 'current') return { status: after };
        throw error;
      }
    })();
  }

  const collection = identity => `chat-${identity.chatId}`;
  const manifestEnvelope = identity => envelope => safeEnvelope(
    envelope,
    data => validateArchiveV2MemoryManifest(data, { expectedChatId: identity.chatId }),
  );
  const batchEnvelope = (identity, plan, scanId) => envelope => safeEnvelope(
    envelope,
    data => validateArchiveV2MemoryBatch(data, {
      plan,
      expectedChatId: identity.chatId,
      expectedScanId: scanId,
    }),
  );
  const peopleEnvelope = (identity, manifest, batches) => envelope => safeEnvelope(
    envelope,
    data => validateArchiveV2MemoryPeopleResult(data, {
      manifest,
      batches,
      expectedChatId: identity.chatId,
    }),
  );

  return Object.freeze({
    readManifest() {
      return execute(async () => undefined, async identity => {
        let envelope;
        try { envelope = await client.get(collection(identity), ARCHIVE_V2_MEMORY_MANIFEST_RECORD_ID); }
        catch (error) {
          if (error?.status === 404) return { status: 'uninitialized' };
          throw error;
        }
        const safe = manifestEnvelope(identity)(envelope);
        return Object.freeze({ status: 'ready', manifest: safe.data, revision: safe.revision });
      });
    },

    createManifest({ manifest } = {}) {
      return execute(
        async identity => validateArchiveV2MemoryManifest(manifest, { expectedChatId: identity.chatId }),
        async (identity, safeManifest) => {
          let envelope;
          try {
            envelope = await client.put(
              collection(identity), ARCHIVE_V2_MEMORY_MANIFEST_RECORD_ID, safeManifest, 0,
            );
          } catch (error) {
            if (error?.status === 409) return { status: 'conflict' };
            throw error;
          }
          const safe = manifestEnvelope(identity)(envelope);
          if (!sameJson(safe.data, safeManifest)) fail('MEMORY_STORE_MANIFEST_RESPONSE_MISMATCH');
          return Object.freeze({ status: 'created', manifest: safe.data, revision: safe.revision });
        },
      );
    },

    saveManifest({ manifest, expectedRevision } = {}) {
      return execute(
        async identity => {
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
            fail('MEMORY_STORE_REVISION_INVALID');
          }
          return validateArchiveV2MemoryManifest(manifest, { expectedChatId: identity.chatId });
        },
        async (identity, safeManifest) => {
          let envelope;
          try {
            envelope = await client.put(
              collection(identity), ARCHIVE_V2_MEMORY_MANIFEST_RECORD_ID, safeManifest, expectedRevision,
            );
          } catch (error) {
            if (error?.status === 409) return { status: 'conflict' };
            throw error;
          }
          const safe = manifestEnvelope(identity)(envelope);
          if (!sameJson(safe.data, safeManifest)) fail('MEMORY_STORE_MANIFEST_RESPONSE_MISMATCH');
          return Object.freeze({ status: 'saved', manifest: safe.data, revision: safe.revision });
        },
      );
    },

    readBatch({ recordId, plan, expectedScanId } = {}) {
      return execute(
        async () => {
          const safeRecordId = requiredString(recordId, 'MEMORY_STORE_RECORD_ID_INVALID', 128);
          const safeScanId = requiredString(expectedScanId, 'MEMORY_STORE_SCAN_ID_INVALID', 256);
          const safePlan = planIdentity(plan);
          const expectedRecordId = await createArchiveV2MemoryBatchRecordId({
            scanId: safeScanId,
            batchIndex: safePlan.batchIndex,
            sourceFingerprint: safePlan.sourceFingerprint,
          });
          if (safeRecordId !== expectedRecordId) fail('MEMORY_STORE_RECORD_ID_MISMATCH');
          return { recordId: safeRecordId, scanId: safeScanId, plan: safePlan.plan };
        },
        async (identity, prepared) => {
          let envelope;
          try { envelope = await client.get(collection(identity), prepared.recordId); }
          catch (error) {
            if (error?.status === 404) return { status: 'missing' };
            throw error;
          }
          const safe = batchEnvelope(identity, prepared.plan, prepared.scanId)(envelope);
          return Object.freeze({ status: 'ready', batch: safe.data, revision: safe.revision });
        },
      );
    },

    readReadyBatches({ manifest, plans } = {}) {
      return execute(
        async identity => {
          const safeManifest = validateArchiveV2MemoryManifest(manifest, { expectedChatId: identity.chatId });
          if (safeManifest.status !== 'ready') fail('MEMORY_STORE_MANIFEST_NOT_READY');
          const safePlans = safeJsonClone(plans, 'MEMORY_STORE_PLANS_INVALID');
          if (!Array.isArray(safePlans) || safePlans.length !== safeManifest.totalBatches) {
            fail('MEMORY_STORE_PLANS_INVALID');
          }
          const reads = [];
          for (let batchIndex = 0; batchIndex < safePlans.length; batchIndex += 1) {
            const safePlan = planIdentity(safePlans[batchIndex]);
            const ref = safeManifest.batchRefs[batchIndex];
            if (safePlan.batchIndex !== batchIndex || safePlan.sourceFingerprint !== ref.sourceFingerprint) {
              fail('MEMORY_STORE_PLANS_INVALID');
            }
            const expectedRecordId = await createArchiveV2MemoryBatchRecordId({
              scanId: safeManifest.scanId,
              batchIndex,
              sourceFingerprint: safePlan.sourceFingerprint,
            });
            if (ref.recordId !== expectedRecordId) fail('MEMORY_STORE_RECORD_ID_MISMATCH');
            reads.push({ recordId: ref.recordId, plan: safePlan.plan });
          }
          return { manifest: safeManifest, reads };
        },
        async (identity, prepared) => {
          const batches = [];
          for (const read of prepared.reads) {
            let envelope;
            try { envelope = await client.get(collection(identity), read.recordId); }
            catch (error) {
              if (error?.status === 404) return { status: 'missing' };
              throw error;
            }
            batches.push(batchEnvelope(identity, read.plan, prepared.manifest.scanId)(envelope).data);
          }
          return Object.freeze({
            status: 'ready',
            manifest: prepared.manifest,
            batches: Object.freeze(batches),
          });
        },
      );
    },

    readPeopleResult({ manifest, batches } = {}) {
      return execute(
        async identity => {
          const safeManifest = validateArchiveV2MemoryManifest(manifest, { expectedChatId: identity.chatId });
          const recordId = await createArchiveV2MemoryPeopleRecordId(safeManifest);
          return { manifest: safeManifest, batches: safeJsonClone(batches), recordId };
        },
        async (identity, prepared) => {
          let envelope;
          try { envelope = await client.get(collection(identity), prepared.recordId); }
          catch (error) {
            if (error?.status === 404) return { status: 'missing', recordId: prepared.recordId };
            throw error;
          }
          const safe = peopleEnvelope(identity, prepared.manifest, prepared.batches)(envelope);
          return Object.freeze({
            status: 'ready', result: safe.data, revision: safe.revision, recordId: prepared.recordId,
          });
        },
      );
    },

    putPeopleResult({ manifest, batches, result } = {}) {
      return execute(
        async identity => {
          const safeManifest = validateArchiveV2MemoryManifest(manifest, { expectedChatId: identity.chatId });
          const safeBatches = safeJsonClone(batches);
          const safeResult = validateArchiveV2MemoryPeopleResult(result, {
            manifest: safeManifest,
            batches: safeBatches,
            expectedChatId: identity.chatId,
          });
          const recordId = await createArchiveV2MemoryPeopleRecordId(safeManifest);
          return { manifest: safeManifest, batches: safeBatches, result: safeResult, recordId };
        },
        async (identity, prepared) => {
          let envelope;
          try {
            envelope = await client.put(collection(identity), prepared.recordId, prepared.result, 0);
          } catch (error) {
            if (error?.status !== 409) throw error;
            let winnerEnvelope;
            try { winnerEnvelope = await client.get(collection(identity), prepared.recordId); }
            catch (readError) {
              if (readError?.status === 404) return { status: 'conflict' };
              throw readError;
            }
            const winner = peopleEnvelope(identity, prepared.manifest, prepared.batches)(winnerEnvelope);
            return Object.freeze({
              status: 'reused', result: winner.data, revision: winner.revision, recordId: prepared.recordId,
            });
          }
          const safe = peopleEnvelope(identity, prepared.manifest, prepared.batches)(envelope);
          if (!sameJson(safe.data, prepared.result)) fail('MEMORY_STORE_PEOPLE_RESPONSE_MISMATCH');
          return Object.freeze({
            status: 'saved', result: safe.data, revision: safe.revision, recordId: prepared.recordId,
          });
        },
      );
    },

    putBatch({ recordId, batch, plan } = {}) {
      return execute(
        async identity => {
          const safePlan = planIdentity(plan);
          const safeBatch = validateArchiveV2MemoryBatch(batch, {
            plan: safePlan.plan,
            expectedChatId: identity.chatId,
          });
          const safeRecordId = requiredString(recordId, 'MEMORY_STORE_RECORD_ID_INVALID', 128);
          const expectedRecordId = await createArchiveV2MemoryBatchRecordId({
            scanId: safeBatch.scanId,
            batchIndex: safePlan.batchIndex,
            sourceFingerprint: safePlan.sourceFingerprint,
          });
          if (safeRecordId !== expectedRecordId) fail('MEMORY_STORE_RECORD_ID_MISMATCH');
          return { recordId: safeRecordId, plan: safePlan.plan, batch: safeBatch };
        },
        async (identity, prepared) => {
          let envelope;
          try {
            envelope = await client.put(collection(identity), prepared.recordId, prepared.batch, 0);
          } catch (error) {
            if (error?.status !== 409) throw error;
            let winnerEnvelope;
            try { winnerEnvelope = await client.get(collection(identity), prepared.recordId); }
            catch (readError) {
              if (readError?.status === 404) return { status: 'conflict' };
              throw readError;
            }
            const winner = batchEnvelope(identity, prepared.plan, prepared.batch.scanId)(winnerEnvelope);
            if (!sameJson(winner.data, prepared.batch)) return { status: 'conflict' };
            return Object.freeze({ status: 'reused', batch: winner.data, revision: winner.revision });
          }
          const safe = batchEnvelope(identity, prepared.plan, prepared.batch.scanId)(envelope);
          if (!sameJson(safe.data, prepared.batch)) fail('MEMORY_STORE_BATCH_RESPONSE_MISMATCH');
          return Object.freeze({ status: 'saved', batch: safe.data, revision: safe.revision });
        },
      );
    },

    invalidate() {
      epoch += 1;
    },
  });
}
