import { isUuid, readHostState } from './host-context.js';
import { sha256 } from './identity.js';

export const ARCHIVE_V2_MEMORY_SCHEMA_VERSION = 1;
export const ARCHIVE_V2_MEMORY_MANIFEST_KIND = 'myriad-knots-memory-manifest';
export const ARCHIVE_V2_MEMORY_BATCH_KIND = 'myriad-knots-memory-batch';

export const ARCHIVE_V2_MEMORY_DEFAULTS = Object.freeze({
  maxFloorsPerBatch: 20,
  maxCharactersPerBatch: 80000,
});

export const ARCHIVE_V2_MEMORY_WARNING = Object.freeze({
  ROLE_UNKNOWN: 'ROLE_UNKNOWN',
  SWIPE_UNSTABLE: 'SWIPE_UNSTABLE',
  CONTENT_INVALID: 'CONTENT_INVALID',
});

const SNAPSHOT_KIND = 'myriad-knots-memory-snapshot';
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_STATUSES = new Set(['scanning', 'interrupted', 'ready']);
const FACT_CATEGORIES = new Set(['identity', 'appearance', 'personality', 'ability', 'preference', 'principle', 'status', 'other']);
const RELATION_CATEGORIES = new Set(['attitude', 'bond', 'commitment', 'conflict', 'boundary', 'goal', 'other']);
const OBJECT_KINDS = new Set(['user', 'person']);
const EVENT_SIGNIFICANCE = new Set(['supporting', 'major']);

const LIMITS = Object.freeze({
  maxFloorsPerBatch: 1000,
  maxCharactersPerBatch: 10000000,
  scanId: 256,
  recordId: 512,
  localId: 128,
  name: 512,
  alias: 512,
  title: 1000,
  value: 10000,
  summary: 20000,
  people: 500,
  facts: 5000,
  relations: 5000,
  events: 2000,
  aliases: 100,
  participantIds: 500,
});

function fail(code) {
  throw new TypeError(code);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function safeJsonClone(value, code = 'MEMORY_JSON_INVALID') {
  const active = new WeakSet();
  const visit = current => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail(code);
      return current;
    }
    if (typeof current !== 'object') fail(code);
    if (active.has(current)) fail(code);
    const isArray = Array.isArray(current);
    if (!isArray && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) fail(code);
    active.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key === 'symbol')) fail(code);
    let clone;
    if (isArray) {
      if (keys.some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) fail(code);
      clone = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(code);
        clone.push(visit(descriptor.value));
      }
    } else {
      clone = {};
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!('value' in descriptor) || !descriptor.enumerable) fail(code);
        clone[key] = visit(descriptor.value);
      }
    }
    active.delete(current);
    return clone;
  };
  return visit(value);
}

function assertExactKeys(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function requireString(value, code, maxLength, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') fail(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) fail(code);
  return normalized;
}

function requireInteger(value, code, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function requireFingerprint(value, code) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) fail(code);
  return value;
}

function requireTimestamp(value, code) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) fail(code);
  return value;
}

function requireUuid(value, code) {
  if (!isUuid(value)) fail(code);
  return value;
}

function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, '\n');
}

function normalizeOptions(options) {
  if (options === undefined) return { ...ARCHIVE_V2_MEMORY_DEFAULTS };
  const clone = safeJsonClone(options, 'MEMORY_OPTIONS_INVALID');
  if (!clone || Array.isArray(clone)) fail('MEMORY_OPTIONS_INVALID');
  for (const key of Object.keys(clone)) {
    if (!(key in ARCHIVE_V2_MEMORY_DEFAULTS)) fail('MEMORY_OPTIONS_INVALID');
  }
  return {
    maxFloorsPerBatch: requireInteger(
      clone.maxFloorsPerBatch ?? ARCHIVE_V2_MEMORY_DEFAULTS.maxFloorsPerBatch,
      'MEMORY_OPTIONS_INVALID',
      1,
      LIMITS.maxFloorsPerBatch,
    ),
    maxCharactersPerBatch: requireInteger(
      clone.maxCharactersPerBatch ?? ARCHIVE_V2_MEMORY_DEFAULTS.maxCharactersPerBatch,
      'MEMORY_OPTIONS_INVALID',
      1,
      LIMITS.maxCharactersPerBatch,
    ),
  };
}

function selectedContent(message) {
  const swipes = message.swipes;
  if (swipes !== undefined) {
    if (!Array.isArray(swipes)) return { ok: false, code: ARCHIVE_V2_MEMORY_WARNING.SWIPE_UNSTABLE };
    const swipeId = message.swipe_id === undefined ? 0 : message.swipe_id;
    if (!Number.isSafeInteger(swipeId) || swipeId < 0 || swipeId >= swipes.length || typeof swipes[swipeId] !== 'string') {
      return { ok: false, code: ARCHIVE_V2_MEMORY_WARNING.SWIPE_UNSTABLE };
    }
    const selected = normalizeNewlines(swipes[swipeId]);
    const current = message.mes;
    if (typeof current === 'string' && normalizeNewlines(current) !== selected) {
      return { ok: false, code: ARCHIVE_V2_MEMORY_WARNING.SWIPE_UNSTABLE };
    }
    return { ok: true, swipeId, content: selected };
  }
  if (typeof message.mes !== 'string') return { ok: false, code: ARCHIVE_V2_MEMORY_WARNING.CONTENT_INVALID };
  return { ok: true, swipeId: 0, content: normalizeNewlines(message.mes) };
}

async function fingerprint(parts) {
  return `sha256:${await sha256(JSON.stringify(parts))}`;
}

async function makeBatchPlans(chatId, floors, options) {
  const groups = [];
  let current = [];
  let characters = 0;
  for (const floor of floors) {
    const wouldOverflowFloors = current.length >= options.maxFloorsPerBatch;
    const wouldOverflowCharacters = current.length > 0
      && characters + floor.content.length > options.maxCharactersPerBatch;
    if (wouldOverflowFloors || wouldOverflowCharacters) {
      groups.push(current);
      current = [];
      characters = 0;
    }
    current.push(floor);
    characters += floor.content.length;
  }
  if (current.length) groups.push(current);

  return Promise.all(groups.map(async (group, batchIndex) => {
    const sourceIndices = group.map(floor => floor.sourceIndex);
    const characterCount = group.reduce((sum, floor) => sum + floor.content.length, 0);
    return {
      batchIndex,
      floorStart: sourceIndices[0],
      floorEnd: sourceIndices.at(-1),
      floorCount: group.length,
      characterCount,
      sourceIndices,
      sourceFingerprint: await fingerprint([
        'myriad-knots-memory-batch-source-v1',
        chatId,
        batchIndex,
        options.maxFloorsPerBatch,
        options.maxCharactersPerBatch,
        group.map(floor => floor.fingerprint),
      ]),
      floors: group.map(floor => ({ ...floor })),
    };
  }));
}

export async function createArchiveV2MemorySnapshot(context, options) {
  if (!context || typeof context !== 'object') fail('MEMORY_CONTEXT_INVALID');
  const state = readHostState(context);
  if (!state.ok) fail('MEMORY_HOST_STATE_INVALID');
  if (!isUuid(state.chatId)) fail('MEMORY_STABLE_CHAT_ID_REQUIRED');
  const chat = context.chat;
  if (!Array.isArray(chat)) fail('MEMORY_CHAT_INVALID');
  const normalizedOptions = normalizeOptions(options);
  const targetFloor = chat.length - 1;
  const collectedFloors = [];
  const warnings = [];

  // Freeze every host-derived primitive before the first asynchronous hash.
  for (let sourceIndex = 0; sourceIndex <= targetFloor; sourceIndex += 1) {
    const message = chat[sourceIndex];
    if (!message || typeof message !== 'object') {
      warnings.push({ code: ARCHIVE_V2_MEMORY_WARNING.ROLE_UNKNOWN, sourceIndex });
      continue;
    }
    const isUser = message.is_user;
    if (isUser === true) continue;
    if (isUser !== false) {
      warnings.push({ code: ARCHIVE_V2_MEMORY_WARNING.ROLE_UNKNOWN, sourceIndex });
      continue;
    }
    const selected = selectedContent(message);
    if (!selected.ok) {
      warnings.push({ code: selected.code, sourceIndex });
      continue;
    }
    if (!selected.content.trim()) {
      warnings.push({ code: ARCHIVE_V2_MEMORY_WARNING.CONTENT_INVALID, sourceIndex });
      continue;
    }
    collectedFloors.push({
      sourceIndex,
      swipeId: selected.swipeId,
      hidden: message.is_system === true || message.is_hidden === true || message.extra?.is_hidden === true,
      content: selected.content,
    });
  }

  const floors = await Promise.all(collectedFloors.map(async floor => ({
    ...floor,
    fingerprint: await fingerprint([
        'myriad-knots-memory-floor-v1',
        state.chatId,
        floor.sourceIndex,
        floor.swipeId,
        floor.content,
      ]),
  })));

  const batches = await makeBatchPlans(state.chatId, floors, normalizedOptions);
  const sourceFingerprint = await fingerprint([
    'myriad-knots-memory-source-v1',
    state.chatId,
    targetFloor,
    normalizedOptions.maxFloorsPerBatch,
    normalizedOptions.maxCharactersPerBatch,
    floors.map(floor => floor.fingerprint),
  ]);
  return deepFreeze({
    schemaVersion: ARCHIVE_V2_MEMORY_SCHEMA_VERSION,
    kind: SNAPSHOT_KIND,
    chatId: state.chatId,
    hostChatId: state.hostChatId,
    characterLocator: state.characterAvatar,
    personaLocator: state.personaAvatar,
    targetFloor,
    eligibleFloorCount: floors.length,
    batchSize: normalizedOptions.maxFloorsPerBatch,
    sourceFingerprint,
    floors,
    batches,
    warnings,
  });
}

const MANIFEST_KEYS = [
  'schemaVersion', 'kind', 'chatId', 'scanId', 'targetFloor', 'sourceFingerprint', 'batchSize',
  'totalBatches', 'completedBatchIndexes', 'status', 'batchRefs', 'createdAt', 'updatedAt',
];

export function validateArchiveV2MemoryManifest(value, { expectedChatId } = {}) {
  const clone = safeJsonClone(value, 'MEMORY_MANIFEST_JSON_INVALID');
  assertExactKeys(clone, MANIFEST_KEYS, 'MEMORY_MANIFEST_KEYS_INVALID');
  if (clone.schemaVersion !== ARCHIVE_V2_MEMORY_SCHEMA_VERSION || clone.kind !== ARCHIVE_V2_MEMORY_MANIFEST_KIND) {
    fail('MEMORY_MANIFEST_IDENTITY_INVALID');
  }
  requireUuid(clone.chatId, 'MEMORY_MANIFEST_CHAT_ID_INVALID');
  if (expectedChatId !== undefined && clone.chatId !== expectedChatId) fail('MEMORY_MANIFEST_CHAT_ID_MISMATCH');
  clone.scanId = requireString(clone.scanId, 'MEMORY_MANIFEST_SCAN_ID_INVALID', LIMITS.scanId);
  requireInteger(clone.targetFloor, 'MEMORY_MANIFEST_TARGET_INVALID', -1);
  requireFingerprint(clone.sourceFingerprint, 'MEMORY_MANIFEST_FINGERPRINT_INVALID');
  requireInteger(clone.batchSize, 'MEMORY_MANIFEST_BATCH_SIZE_INVALID', 1, LIMITS.maxFloorsPerBatch);
  requireInteger(clone.totalBatches, 'MEMORY_MANIFEST_TOTAL_INVALID', 0, 100000);
  if (!Array.isArray(clone.completedBatchIndexes)) fail('MEMORY_MANIFEST_COMPLETED_INVALID');
  let previous = -1;
  for (const index of clone.completedBatchIndexes) {
    requireInteger(index, 'MEMORY_MANIFEST_COMPLETED_INVALID', 0, clone.totalBatches - 1);
    if (index <= previous) fail('MEMORY_MANIFEST_COMPLETED_INVALID');
    previous = index;
  }
  if (!MANIFEST_STATUSES.has(clone.status)) fail('MEMORY_MANIFEST_STATUS_INVALID');
  if (!Array.isArray(clone.batchRefs)) fail('MEMORY_MANIFEST_REFS_INVALID');
  const completed = new Set(clone.completedBatchIndexes);
  previous = -1;
  for (const ref of clone.batchRefs) {
    assertExactKeys(ref, ['batchIndex', 'recordId', 'sourceFingerprint'], 'MEMORY_MANIFEST_REF_KEYS_INVALID');
    requireInteger(ref.batchIndex, 'MEMORY_MANIFEST_REFS_INVALID', 0, clone.totalBatches - 1);
    if (ref.batchIndex <= previous || !completed.has(ref.batchIndex)) fail('MEMORY_MANIFEST_REFS_INVALID');
    previous = ref.batchIndex;
    ref.recordId = requireString(ref.recordId, 'MEMORY_MANIFEST_REFS_INVALID', LIMITS.recordId);
    requireFingerprint(ref.sourceFingerprint, 'MEMORY_MANIFEST_REFS_INVALID');
  }
  if (clone.batchRefs.length !== clone.completedBatchIndexes.length
    || clone.batchRefs.some((ref, index) => ref.batchIndex !== clone.completedBatchIndexes[index])) {
    fail('MEMORY_MANIFEST_REFS_INVALID');
  }
  requireTimestamp(clone.createdAt, 'MEMORY_MANIFEST_TIME_INVALID');
  requireTimestamp(clone.updatedAt, 'MEMORY_MANIFEST_TIME_INVALID');
  if (Date.parse(clone.updatedAt) < Date.parse(clone.createdAt)) fail('MEMORY_MANIFEST_TIME_INVALID');
  if (clone.status === 'ready') {
    if (clone.completedBatchIndexes.length !== clone.totalBatches || clone.batchRefs.length !== clone.totalBatches) {
      fail('MEMORY_MANIFEST_READY_INVALID');
    }
    for (let index = 0; index < clone.totalBatches; index += 1) {
      if (clone.completedBatchIndexes[index] !== index || clone.batchRefs[index].batchIndex !== index) {
        fail('MEMORY_MANIFEST_READY_INVALID');
      }
    }
  }
  return deepFreeze(clone);
}

export function createArchiveV2MemoryManifest({ snapshot, scanId, createdAt }) {
  if (!snapshot || snapshot.kind !== SNAPSHOT_KIND || snapshot.schemaVersion !== ARCHIVE_V2_MEMORY_SCHEMA_VERSION) {
    fail('MEMORY_SNAPSHOT_INVALID');
  }
  return validateArchiveV2MemoryManifest({
    schemaVersion: ARCHIVE_V2_MEMORY_SCHEMA_VERSION,
    kind: ARCHIVE_V2_MEMORY_MANIFEST_KIND,
    chatId: snapshot.chatId,
    scanId,
    targetFloor: snapshot.targetFloor,
    sourceFingerprint: snapshot.sourceFingerprint,
    batchSize: snapshot.batchSize,
    totalBatches: snapshot.batches.length,
    completedBatchIndexes: [],
    status: 'scanning',
    batchRefs: [],
    createdAt,
    updatedAt: createdAt,
  }, { expectedChatId: snapshot.chatId });
}

function validatePlan(value) {
  const plan = safeJsonClone(value, 'MEMORY_PLAN_JSON_INVALID');
  assertExactKeys(plan, [
    'batchIndex', 'floorStart', 'floorEnd', 'floorCount', 'characterCount', 'sourceIndices',
    'sourceFingerprint', 'floors',
  ], 'MEMORY_PLAN_KEYS_INVALID');
  requireInteger(plan.batchIndex, 'MEMORY_PLAN_INVALID', 0, 99999);
  requireInteger(plan.floorStart, 'MEMORY_PLAN_INVALID', 0);
  requireInteger(plan.floorEnd, 'MEMORY_PLAN_INVALID', plan.floorStart);
  requireInteger(plan.floorCount, 'MEMORY_PLAN_INVALID', 1, LIMITS.maxFloorsPerBatch);
  requireInteger(plan.characterCount, 'MEMORY_PLAN_INVALID', 1);
  requireFingerprint(plan.sourceFingerprint, 'MEMORY_PLAN_INVALID');
  if (!Array.isArray(plan.sourceIndices) || plan.sourceIndices.length !== plan.floorCount) fail('MEMORY_PLAN_INVALID');
  if (!Array.isArray(plan.floors) || plan.floors.length !== plan.floorCount) fail('MEMORY_PLAN_INVALID');
  let previous = -1;
  let characterCount = 0;
  for (let index = 0; index < plan.sourceIndices.length; index += 1) {
    const sourceIndex = requireInteger(plan.sourceIndices[index], 'MEMORY_PLAN_INVALID', 0);
    if (sourceIndex <= previous) fail('MEMORY_PLAN_INVALID');
    previous = sourceIndex;
    const floor = plan.floors[index];
    assertExactKeys(floor, ['sourceIndex', 'swipeId', 'hidden', 'content', 'fingerprint'], 'MEMORY_PLAN_FLOOR_INVALID');
    if (floor.sourceIndex !== sourceIndex) fail('MEMORY_PLAN_FLOOR_INVALID');
    requireInteger(floor.swipeId, 'MEMORY_PLAN_FLOOR_INVALID', 0);
    if (typeof floor.hidden !== 'boolean' || typeof floor.content !== 'string' || !floor.content.trim()) fail('MEMORY_PLAN_FLOOR_INVALID');
    requireFingerprint(floor.fingerprint, 'MEMORY_PLAN_FLOOR_INVALID');
    characterCount += floor.content.length;
  }
  if (plan.floorStart !== plan.sourceIndices[0]
    || plan.floorEnd !== plan.sourceIndices.at(-1)
    || plan.characterCount !== characterCount) fail('MEMORY_PLAN_INVALID');
  return plan;
}

function validateSourceFloors(value, allowedFloors, code) {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.maxFloorsPerBatch) fail(code);
  const result = [];
  let previous = -1;
  for (const floor of value) {
    requireInteger(floor, code, 0);
    if (floor <= previous || !allowedFloors.has(floor)) fail(code);
    previous = floor;
    result.push(floor);
  }
  return result;
}

function normalizedKey(value) {
  return value.normalize('NFKC').trim().toLowerCase();
}

function validateRows(value, plan) {
  assertExactKeys(value, ['people', 'facts', 'relations', 'events'], 'MEMORY_ROWS_KEYS_INVALID');
  const allowedFloors = new Set(plan.sourceIndices);
  const people = value.people;
  const facts = value.facts;
  const relations = value.relations;
  const events = value.events;
  if (!Array.isArray(people) || people.length > LIMITS.people
    || !Array.isArray(facts) || facts.length > LIMITS.facts
    || !Array.isArray(relations) || relations.length > LIMITS.relations
    || !Array.isArray(events) || events.length > LIMITS.events) fail('MEMORY_ROWS_COUNT_INVALID');

  const personIds = new Set();
  for (const person of people) {
    assertExactKeys(person, ['localId', 'displayName', 'aliases', 'sourceFloors'], 'MEMORY_PERSON_KEYS_INVALID');
    person.localId = requireString(person.localId, 'MEMORY_PERSON_INVALID', LIMITS.localId);
    person.displayName = requireString(person.displayName, 'MEMORY_PERSON_INVALID', LIMITS.name);
    if (personIds.has(person.localId)) fail('MEMORY_PERSON_INVALID');
    personIds.add(person.localId);
    if (!Array.isArray(person.aliases) || person.aliases.length > LIMITS.aliases) fail('MEMORY_PERSON_INVALID');
    const aliasKeys = new Set([normalizedKey(person.displayName)]);
    person.aliases = person.aliases.map(alias => {
      const normalized = requireString(alias, 'MEMORY_PERSON_INVALID', LIMITS.alias);
      const key = normalizedKey(normalized);
      if (aliasKeys.has(key)) fail('MEMORY_PERSON_INVALID');
      aliasKeys.add(key);
      return normalized;
    });
    person.sourceFloors = validateSourceFloors(person.sourceFloors, allowedFloors, 'MEMORY_PERSON_INVALID');
  }

  for (const fact of facts) {
    assertExactKeys(fact, ['subjectLocalId', 'category', 'value', 'sourceFloors'], 'MEMORY_FACT_KEYS_INVALID');
    fact.subjectLocalId = requireString(fact.subjectLocalId, 'MEMORY_FACT_INVALID', LIMITS.localId);
    if (!personIds.has(fact.subjectLocalId) || !FACT_CATEGORIES.has(fact.category)) fail('MEMORY_FACT_INVALID');
    fact.value = requireString(fact.value, 'MEMORY_FACT_INVALID', LIMITS.value);
    fact.sourceFloors = validateSourceFloors(fact.sourceFloors, allowedFloors, 'MEMORY_FACT_INVALID');
  }

  for (const relation of relations) {
    assertExactKeys(relation, [
      'subjectLocalId', 'objectKind', 'objectLocalId', 'category', 'summary', 'sourceFloors',
    ], 'MEMORY_RELATION_KEYS_INVALID');
    relation.subjectLocalId = requireString(relation.subjectLocalId, 'MEMORY_RELATION_INVALID', LIMITS.localId);
    if (!personIds.has(relation.subjectLocalId) || !OBJECT_KINDS.has(relation.objectKind)
      || !RELATION_CATEGORIES.has(relation.category)) fail('MEMORY_RELATION_INVALID');
    if (relation.objectKind === 'user') {
      if (relation.objectLocalId !== null) fail('MEMORY_RELATION_INVALID');
    } else {
      relation.objectLocalId = requireString(relation.objectLocalId, 'MEMORY_RELATION_INVALID', LIMITS.localId);
      if (!personIds.has(relation.objectLocalId)) fail('MEMORY_RELATION_INVALID');
    }
    relation.summary = requireString(relation.summary, 'MEMORY_RELATION_INVALID', LIMITS.summary);
    relation.sourceFloors = validateSourceFloors(relation.sourceFloors, allowedFloors, 'MEMORY_RELATION_INVALID');
  }

  const eventIds = new Set();
  for (const event of events) {
    assertExactKeys(event, [
      'localId', 'title', 'summary', 'participantLocalIds', 'involvesUser', 'significance', 'sourceFloors',
    ], 'MEMORY_EVENT_KEYS_INVALID');
    event.localId = requireString(event.localId, 'MEMORY_EVENT_INVALID', LIMITS.localId);
    if (eventIds.has(event.localId)) fail('MEMORY_EVENT_INVALID');
    eventIds.add(event.localId);
    event.title = requireString(event.title, 'MEMORY_EVENT_INVALID', LIMITS.title);
    event.summary = requireString(event.summary, 'MEMORY_EVENT_INVALID', LIMITS.summary);
    if (!Array.isArray(event.participantLocalIds) || event.participantLocalIds.length > LIMITS.participantIds) fail('MEMORY_EVENT_INVALID');
    const participants = new Set();
    event.participantLocalIds = event.participantLocalIds.map(localId => {
      const normalized = requireString(localId, 'MEMORY_EVENT_INVALID', LIMITS.localId);
      if (!personIds.has(normalized) || participants.has(normalized)) fail('MEMORY_EVENT_INVALID');
      participants.add(normalized);
      return normalized;
    });
    if (typeof event.involvesUser !== 'boolean' || !EVENT_SIGNIFICANCE.has(event.significance)) fail('MEMORY_EVENT_INVALID');
    event.sourceFloors = validateSourceFloors(event.sourceFloors, allowedFloors, 'MEMORY_EVENT_INVALID');
  }
  return value;
}

const BATCH_KEYS = [
  'schemaVersion', 'kind', 'chatId', 'scanId', 'batchIndex', 'floorStart', 'floorEnd', 'floorCount',
  'sourceFingerprint', 'rows', 'createdAt',
];

export function validateArchiveV2MemoryBatch(value, { plan, expectedChatId, expectedScanId } = {}) {
  if (plan === undefined) fail('MEMORY_PLAN_REQUIRED');
  const safePlan = validatePlan(plan);
  const clone = safeJsonClone(value, 'MEMORY_BATCH_JSON_INVALID');
  assertExactKeys(clone, BATCH_KEYS, 'MEMORY_BATCH_KEYS_INVALID');
  if (clone.schemaVersion !== ARCHIVE_V2_MEMORY_SCHEMA_VERSION || clone.kind !== ARCHIVE_V2_MEMORY_BATCH_KIND) {
    fail('MEMORY_BATCH_IDENTITY_INVALID');
  }
  requireUuid(clone.chatId, 'MEMORY_BATCH_CHAT_ID_INVALID');
  if (expectedChatId !== undefined && clone.chatId !== expectedChatId) fail('MEMORY_BATCH_CHAT_ID_MISMATCH');
  clone.scanId = requireString(clone.scanId, 'MEMORY_BATCH_SCAN_ID_INVALID', LIMITS.scanId);
  if (expectedScanId !== undefined && clone.scanId !== expectedScanId) fail('MEMORY_BATCH_SCAN_ID_MISMATCH');
  if (clone.batchIndex !== safePlan.batchIndex
    || clone.floorStart !== safePlan.floorStart
    || clone.floorEnd !== safePlan.floorEnd
    || clone.floorCount !== safePlan.floorCount
    || clone.sourceFingerprint !== safePlan.sourceFingerprint) fail('MEMORY_BATCH_PLAN_MISMATCH');
  validateRows(clone.rows, safePlan);
  requireTimestamp(clone.createdAt, 'MEMORY_BATCH_TIME_INVALID');
  return deepFreeze(clone);
}

export function createArchiveV2MemoryBatch({ manifest, plan, rows, createdAt }) {
  const safeManifest = validateArchiveV2MemoryManifest(manifest);
  const safePlan = validatePlan(plan);
  if (safePlan.batchIndex >= safeManifest.totalBatches) fail('MEMORY_BATCH_PLAN_MISMATCH');
  const existingRef = safeManifest.batchRefs.find(ref => ref.batchIndex === safePlan.batchIndex);
  if (existingRef && existingRef.sourceFingerprint !== safePlan.sourceFingerprint) fail('MEMORY_BATCH_PLAN_MISMATCH');
  return validateArchiveV2MemoryBatch({
    schemaVersion: ARCHIVE_V2_MEMORY_SCHEMA_VERSION,
    kind: ARCHIVE_V2_MEMORY_BATCH_KIND,
    chatId: safeManifest.chatId,
    scanId: safeManifest.scanId,
    batchIndex: safePlan.batchIndex,
    floorStart: safePlan.floorStart,
    floorEnd: safePlan.floorEnd,
    floorCount: safePlan.floorCount,
    sourceFingerprint: safePlan.sourceFingerprint,
    rows,
    createdAt,
  }, {
    plan: safePlan,
    expectedChatId: safeManifest.chatId,
    expectedScanId: safeManifest.scanId,
  });
}
