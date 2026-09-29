import { sha256 } from './identity.js';
import { API_BASE } from './constants.js';

// This transport is private to the BaiNiao client; it never replaces window.fetch.
const STORAGE_NAMESPACE = 'qqj-bainiao-v1';
const LOCKS = Symbol.for('qqj.bainiao.tt.locks.v1');
const error = (status, message) => Object.assign(new Error(message), { status });
const copy = value => JSON.parse(JSON.stringify(value));
const abort = signal => { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); };
const encoder = new TextEncoder();

// Rust JSON maps may reorder object fields. Upstream fingerprints include their
// insertion order, so carry the complete JS serialization across the native ABI.
const encodeSlot = slot => ({ format: 'qqj-tt-json-v2', serialized: JSON.stringify(slot) });
function decodeSlot(value) {
  if (value?.format !== 'qqj-tt-json-v2') return { slot: value, legacy: true };
  if (typeof value.serialized !== 'string') throw error(500, 'Invalid stored serialization');
  try { return { slot: JSON.parse(value.serialized), legacy: false }; }
  catch { throw error(500, 'Invalid stored serialization'); }
}

async function recoverLegacyIndex(record) {
  if (record?.schemaVersion !== 3 || record.recordType !== 'index' || !Array.isArray(record.entries)) return;
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (!record.entries.every(entry => exactKeys(entry, ['key', 'refs']) && Array.isArray(entry.refs)
    && entry.refs.every(ref => exactKeys(ref, ['recordType', 'recordId', 'itemId'])))) return;
  const entries = record.entries.map(entry => ({ key: entry.key, refs: entry.refs.map(ref => ({
    recordType: ref.recordType, recordId: ref.recordId, itemId: ref.itemId,
  })) }));
  // Only restore the known upstream field order when the ORIGINAL checksum
  // matches. Never replace a fingerprint, ID, value, or array order to force it.
  if (`sha256:${await sha256(JSON.stringify([record.kind, record.shard, entries]))}` === record.contentFingerprint) record.entries = entries;
}

function abortable(operation, signal) {
  if (!signal) return operation();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function segment(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || encoder.encode(value).length > 512
    || value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/u.test(value)) throw error(400, 'Invalid record key');
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw error(400, 'Invalid expectedRevision');
  return value;
}
function envelope(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.generationId !== 'string' || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string' || !Object.hasOwn(value, 'data')) throw error(500, 'Invalid stored envelope');
  return value;
}

async function locked(globalRef, name, action) {
  // Share queues between all clients (including a second copy of the bundle).
  const queues = globalRef[LOCKS] ??= new Map();
  const previous = queues.get(name) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => {
    if (globalRef.navigator?.locks?.request) return globalRef.navigator.locks.request(name, action);
    return action();
  });
  const settled = pending.then(() => {}, () => {}).finally(() => {
    if (queues.get(name) === settled) queues.delete(name);
  });
  queues.set(name, settled);
  return pending;
}

export function isTauriTavern(globalRef = globalThis) {
  return Boolean(globalRef.__TAURITAVERN__ || globalRef.__TAURITAVERN_MAIN_READY__);
}

export function createTauriBackendFetch({ globalRef = globalThis } = {}) {
  const ready = async () => {
    await (globalRef.__TAURITAVERN__?.ready ?? globalRef.__TAURITAVERN_MAIN_READY__);
    const store = globalRef.__TAURITAVERN__?.api?.extension?.store;
    for (const method of ['tryGetJson', 'setJson', 'deleteJson', 'listKeys', 'listTables']) {
      if (typeof store?.[method] !== 'function') throw new Error('TT 本地存储接口不可用，请确认 TauriTavern 版本并重启应用');
    }
    return store;
  };
  const options = (table, key) => ({ namespace: STORAGE_NAMESPACE, table, key });
  const tableFor = async (namespace, collection) => `r-${await sha256(JSON.stringify([namespace, collection]))}`;
  const keyFor = async recordId => `r-${await sha256(recordId)}`;
  const validateSlot = (value, namespace, collection, recordId) => {
    if (!value || value.format !== 'qqj-tt-record-v1' || value.namespace !== namespace
      || (collection !== undefined && value.collection !== collection)
      || (recordId !== undefined && value.recordId !== recordId) || !Array.isArray(value.trash)
      || !Object.hasOwn(value, 'current')) throw error(500, 'Invalid stored record');
    segment(value.collection); segment(value.recordId);
    if (value.current !== null) envelope(value.current);
    for (const item of value.trash) {
      envelope(item?.envelope);
      if (item.namespace !== value.namespace || item.collection !== value.collection || item.recordId !== value.recordId
        || item.trashId !== `${item.envelope.generationId}-${item.envelope.revision}`) throw error(500, 'Invalid trash record');
    }
    return value;
  };
  const unpack = async (value, namespace, collection, recordId) => {
    const decoded = decodeSlot(value);
    const slot = validateSlot(decoded.slot, namespace, collection, recordId);
    if (decoded.legacy) {
      await recoverLegacyIndex(slot.current?.data);
      for (const item of slot.trash) await recoverLegacyIndex(item.envelope.data);
    }
    return slot;
  };
  const read = async (store, table, key, namespace, collection, recordId) => {
    const result = await store.tryGetJson(options(table, key));
    if (result?.found === false) return null;
    if (result?.found !== true) throw error(500, 'Invalid storage response');
    return unpack(result.value, namespace, collection, recordId);
  };
  const scan = async (store, table, namespace, collection) => {
    const keys = await store.listKeys({ namespace: STORAGE_NAMESPACE, table });
    if (!Array.isArray(keys)) throw error(500, 'Invalid storage listing');
    const slots = [];
    for (const key of keys) {
      const slot = await read(store, table, key, namespace, collection);
      if (!slot || key !== await keyFor(slot.recordId) || table !== await tableFor(namespace, slot.collection)) throw error(500, 'Stored record identity mismatch');
      slots.push({ table, key, slot });
    }
    return slots;
  };

  const dispatch = async (url, init) => {
    if (typeof url !== 'string' || !url.startsWith(`${API_BASE}/v1/`)) throw error(400, 'Unsupported local backend URL');
    const parts = url.slice(`${API_BASE}/v1/`.length).split('/').map(value => {
      try { return decodeURIComponent(value); } catch { throw error(400, 'Invalid URL'); }
    });
    const method = init.method ?? 'GET';
    const signal = init.signal;
    abort(signal);
    const store = await ready();
    abort(signal);
    if (parts.length === 1 && parts[0] === 'health' && method === 'GET') {
      await store.listTables({ namespace: STORAGE_NAMESPACE });
      return { ok: true, plugin: { id: 'st-bainiaodata', name: 'Bainiao Data (TT)', version: '0.1.0-tt.3' },
        api: { current: 1, supported: [1] }, storage: { scope: 'tauritavern-data-root', envelopeSchemaVersion: 1 },
        capabilities: { records: true, recordList: true, optimisticRevision: true, atomicReplace: true, trash: true,
          trashRestore: true, permanentDelete: true, pagination: false, batchTransactions: false, trashGc: false },
        adapter: { version: 3, revisionScope: 'single-app-runtime' } };
    }
    const namespace = segment(parts[1]);
    if (namespace === 'system-trash') throw error(400, 'Reserved namespace');
    // Namespace lock also protects collection/trash scans against concurrent mutation.
    return locked(globalRef, `${STORAGE_NAMESPACE}:${namespace}`, async () => {
      abort(signal);
      const permanent = parts.length === 5 && parts[4] === 'permanent';
      if (parts[0] === 'records' && ([3, 4].includes(parts.length) || permanent)) {
        if (permanent && method !== 'DELETE') throw error(405, 'Unsupported method');
        const collection = segment(parts[2]);
        const table = await tableFor(namespace, collection);
        if (parts.length === 3 && method === 'GET') {
          const slots = await scan(store, table, namespace, collection);
          return slots.filter(({ slot }) => slot.current).map(({ slot }) => ({ recordId: slot.recordId, ...slot.current }))
            .sort((a, b) => a.recordId.localeCompare(b.recordId));
        }
        const recordId = segment(parts[3]);
        const key = await keyFor(recordId);
        const slot = await read(store, table, key, namespace, collection, recordId)
          ?? { format: 'qqj-tt-record-v1', namespace, collection, recordId, current: null, trash: [] };
        if (method === 'GET') {
          if (!slot.current) throw error(404, 'Record not found');
          return slot.current;
        }
        if (!['PUT', 'DELETE'].includes(method)) throw error(405, 'Unsupported method');
        let body;
        try { body = JSON.parse(init.body); } catch { throw error(400, 'Invalid JSON'); }
        const expected = revision(body?.expectedRevision);
        if (method === 'DELETE' && !slot.current) throw error(404, 'Record not found');
        const actual = slot.current?.revision ?? 0;
        if (actual !== expected) throw error(409, 'Revision conflict');
        if (permanent) {
          // Upstream permanent deletion removes only the current generation;
          // older soft-deleted generations in the same slot remain restorable.
          slot.current = null;
          abort(signal);
          if (slot.trash.length) await store.setJson({ ...options(table, key), value: encodeSlot(slot) });
          else await store.deleteJson(options(table, key));
          return { permanentlyDeleted: true, deletedRevision: actual };
        }
        const timestamp = new Date().toISOString();
        let result;
        if (method === 'PUT') {
          if (!Object.hasOwn(body, 'data') || actual === Number.MAX_SAFE_INTEGER) throw error(400, 'Invalid record data or revision');
          const generationId = slot.current?.generationId ?? globalRef.SillyTavern?.getContext?.()?.uuidv4?.() ?? globalRef.crypto?.randomUUID?.();
          if (!generationId) throw error(500, 'UUID unavailable');
          slot.current = { schemaVersion: 1, revision: actual + 1, generationId,
            createdAt: slot.current?.createdAt ?? timestamp, updatedAt: timestamp, data: body.data };
          result = slot.current;
        } else {
          const current = slot.current;
          const trashId = `${current.generationId}-${current.revision}`;
          const trash = { trashId, namespace, collection, recordId, generationId: current.generationId, revision: current.revision,
            originalPath: `${namespace}/${collection}/${recordId}.json`, deletedAt: timestamp, deletedRevision: current.revision,
            expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), envelope: current };
          const existing = slot.trash.find(item => item.trashId === trashId);
          if (existing && JSON.stringify(existing.envelope) !== JSON.stringify(current)) throw error(409, 'Trash conflict');
          if (!existing) slot.trash.push(trash);
          slot.current = null;
          result = { trashId, deletedAt: (existing ?? trash).deletedAt, deletedRevision: current.revision };
        }
        // Current record and deleted generations live in ONE file: delete cannot
        // lose data between a separate trash write and an unlink on iOS suspension.
        abort(signal);
        await store.setJson({ ...options(table, key), value: encodeSlot(slot) });
        return result;
      }
      if (parts[0] === 'trash' && ((parts.length === 2 && method === 'GET')
        || (parts.length === 4 && parts[3] === 'restore' && method === 'POST'))) {
        const tables = await store.listTables({ namespace: STORAGE_NAMESPACE });
        if (!Array.isArray(tables)) throw error(500, 'Invalid storage listing');
        const entries = [];
        // Tables from other BaiNiao namespaces are not part of this query.
        for (const table of tables) {
          const keys = await store.listKeys({ namespace: STORAGE_NAMESPACE, table });
          if (!Array.isArray(keys)) throw error(500, 'Invalid storage listing');
          for (const key of keys) {
            const found = await store.tryGetJson(options(table, key));
            if (found?.found !== true) throw error(500, 'Missing stored record');
            if (decodeSlot(found.value).slot?.namespace !== namespace) continue;
            const slot = await unpack(found.value, namespace);
            if (key !== await keyFor(slot.recordId) || table !== await tableFor(namespace, slot.collection)) throw error(500, 'Stored record identity mismatch');
            for (const trash of slot.trash) entries.push({ table, key, slot, trash });
          }
        }
        if (method === 'GET') return entries.map(({ trash: { envelope: unused, ...rest } }) => rest)
          .sort((a, b) => a.trashId.localeCompare(b.trashId));
        const trashId = segment(parts[2]);
        const entry = entries.find(item => item.trash.trashId === trashId);
        if (!entry) throw error(404, 'Trash record not found');
        const { table, key, slot, trash } = entry;
        if (slot.current && JSON.stringify(slot.current) !== JSON.stringify(trash.envelope)) throw error(409, 'Record already exists');
        slot.current = trash.envelope;
        slot.trash = slot.trash.filter(item => item.trashId !== trashId);
        abort(signal);
        await store.setJson({ ...options(table, key), value: encodeSlot(slot) });
        return slot.current;
      }
      throw error(404, 'Unsupported local backend route');
    });
  };
  return async (url, init = {}) => {
    try {
      // Native writes already submitted cannot be cancelled. Keep their lock
      // until completion even if the caller times out, as with an HTTP write.
      const value = copy(await abortable(() => dispatch(url, init), init.signal));
      return { ok: true, status: 200, json: async () => value };
    } catch (cause) {
      if (!Number.isInteger(cause?.status)) throw cause;
      return { ok: false, status: cause.status, json: async () => ({ message: cause.message }) };
    }
  };
}
