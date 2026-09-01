import {
  ARCHIVE_V2_KIND,
  ARCHIVE_V2_SCHEMA_VERSION,
  validateArchiveV2,
} from './archive-v2.js';
import { isUuid } from './identity.js';
import { validateArchiveV2MemoryPeopleResult } from './archive-v2-memory-people-foundation.js';

export class ArchiveV2MemoryPeopleCommitError extends Error {
  constructor(message, code = 'ARCHIVE_V2_MEMORY_PEOPLE_COMMIT_INVALID') {
    super(message);
    this.name = 'ArchiveV2MemoryPeopleCommitError';
    this.code = code;
  }
}

function fail(message, code = 'ARCHIVE_V2_MEMORY_PEOPLE_COMMIT_INVALID') {
  throw new ArchiveV2MemoryPeopleCommitError(message, code);
}

function sourceRef(batch) {
  return {
    kind: 'chat',
    locator: `memory-batch:${batch.batchIndex}`,
    fingerprint: batch.sourceFingerprint,
  };
}

function owned(value, refs) {
  return {
    value,
    origin: 'ai',
    sourceRefs: refs.map(ref => ({ ...ref })),
    userProtected: false,
  };
}

function safeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('identity 无效');
  const identity = {
    characterLocator: value.characterLocator,
    personaLocator: value.personaLocator,
    personaSummary: value.personaSummary ?? '',
  };
  if (typeof identity.characterLocator !== 'string' || !identity.characterLocator.trim()
    || typeof identity.personaLocator !== 'string' || !identity.personaLocator.trim()
    || typeof identity.personaSummary !== 'string') fail('identity 无效');
  return identity;
}

function selectedSet(value, people) {
  if (!Array.isArray(value)) fail('selectedLocalIds 必须是数组');
  const known = new Set(people.map(person => person.localId));
  const selected = new Set();
  for (const localId of value) {
    if (typeof localId !== 'string' || !known.has(localId) || selected.has(localId)) {
      fail('selectedLocalIds 无效');
    }
    selected.add(localId);
  }
  return selected;
}

function buildArchive({ manifest, batches, result, selectedLocalIds, identity, confirmedAt, createIdentityId }) {
  const safeResult = validateArchiveV2MemoryPeopleResult(result, { manifest, batches });
  const selected = selectedSet(selectedLocalIds, safeResult.people);
  if (typeof confirmedAt !== 'string' || !Number.isFinite(Date.parse(confirmedAt))) fail('confirmedAt 无效');
  const safeIdentityValue = safeIdentity(identity);
  const batchByIndex = new Map(batches.map(batch => [batch.batchIndex, batch]));
  const ids = new Set();
  const byId = {};
  const order = [];
  for (const person of safeResult.people) {
    const identityId = createIdentityId({ localId: person.localId, chatId: safeResult.chatId });
    if (!isUuid(identityId) || ids.has(identityId)) fail('本地 identityId 无效');
    ids.add(identityId);
    order.push(identityId);
    const refs = [...new Set(person.sourcePeopleRefs.map(ref => ref.batchIndex))].map(batchIndex => {
      const batch = batchByIndex.get(batchIndex);
      if (!batch) fail('人物来源批次不存在');
      return sourceRef(batch);
    });
    Object.defineProperty(byId, identityId, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        identityId,
        followed: selected.has(person.localId),
        displayName: owned(person.displayName, refs),
        aliases: owned([...person.aliases], refs),
        fields: {},
        sourceRefs: refs.map(ref => ({ ...ref })),
        recognitionReason: owned(person.recognitionReason, refs),
        recommendation: owned(person.recommendation, refs),
        recommendationReason: owned(person.recommendationReason, refs),
      },
    });
  }
  const archive = {
    schemaVersion: ARCHIVE_V2_SCHEMA_VERSION,
    kind: ARCHIVE_V2_KIND,
    chatId: safeResult.chatId,
    identity: safeIdentityValue,
    initialization: {
      confirmedAt,
      sourceFingerprint: safeResult.sourceFingerprint,
      sources: batches.map(batch => ({ ...sourceRef(batch), content: '' })),
    },
    people: { order, byId },
    events: [],
    bonds: {},
    nextSteps: { items: [] },
    progress: { lastConfirmedFloor: safeResult.targetFloor < 0 ? null : safeResult.targetFloor },
  };
  try { return { archive: validateArchiveV2(archive, { expectedChatId: safeResult.chatId }), selected }; }
  catch { fail('正式 archive-v2 组装失败', 'ARCHIVE_V2_MEMORY_PEOPLE_COMMIT_ASSEMBLY'); }
}

export function createArchiveV2MemoryPeopleCommitter({
  archiveAdapter,
  createIdentityId,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof archiveAdapter?.read !== 'function' || typeof archiveAdapter?.create !== 'function') {
    throw new TypeError('archiveAdapter 必须提供 read 和 create');
  }
  if (typeof createIdentityId !== 'function') throw new TypeError('createIdentityId 必须是函数');
  if (typeof now !== 'function') throw new TypeError('now 必须是函数');
  let active = null;

  function commit(options = {}) {
    if (active) return active;
    const operation = (async () => {
      const current = await archiveAdapter.read();
      if (current?.status === 'ready') return { status: 'conflict' };
      if (current?.status !== 'uninitialized') return { status: current?.status ?? 'stale' };
      const { archive, selected } = buildArchive({
        ...options,
        confirmedAt: now(),
        createIdentityId,
      });
      const created = await archiveAdapter.create({ archive });
      if (created?.status !== 'created') return { status: created?.status ?? 'conflict' };
      return {
        ...created,
        followedCount: selected.size,
        silentCount: archive.people.order.length - selected.size,
      };
    })();
    active = operation;
    operation.then(
      () => { if (active === operation) active = null; },
      () => { if (active === operation) active = null; },
    );
    return operation;
  }

  return Object.freeze({ commit });
}
