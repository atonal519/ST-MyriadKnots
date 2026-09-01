import { validateArchiveV2MemoryManifest } from './archive-v2-memory-foundation.js';

export const ARCHIVE_V2_MEMORY_PEOPLE_SCHEMA_VERSION = 2;
export const ARCHIVE_V2_MEMORY_PEOPLE_KIND = 'myriad-knots-memory-people-result';
export const ARCHIVE_V2_MEMORY_PEOPLE_RECOMMENDATIONS = Object.freeze([
  'romance_candidate',
  'important_supporting',
  'background',
  'uncertain',
]);

const RECOMMENDATIONS = new Set(ARCHIVE_V2_MEMORY_PEOPLE_RECOMMENDATIONS);
const LEGACY_ROOT_KEYS = new Set([
  'schemaVersion', 'kind', 'chatId', 'scanId', 'sourceFingerprint', 'targetFloor', 'people', 'createdAt',
]);
const ROOT_KEYS = new Set([...LEGACY_ROOT_KEYS, 'userSourcePeopleRefs']);
const PERSON_KEYS = new Set([
  'localId', 'displayName', 'aliases', 'recognitionReason', 'sourcePeopleRefs',
  'recommendation', 'recommendationReason', 'statistics',
]);
const AI_PERSON_KEYS = new Set([...PERSON_KEYS].filter(key => key !== 'statistics'));
const AI_ROOT_KEYS = new Set(['people', 'userSourcePeopleRefs']);
const REF_KEYS = new Set(['batchIndex', 'localId']);
const STAT_KEYS = new Set([
  'appearanceBatchCount', 'sourceFloorCount', 'userRelationBatchCount', 'majorEventBatchCount',
]);
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const LOCAL_ID = /^C[1-9][0-9]*$/;
const LIMITS = Object.freeze({ people: 50000, name: 512, alias: 512, aliases: 100, reason: 4000 });

export class ArchiveV2MemoryPeopleFoundationError extends Error {
  constructor(message, code = 'ARCHIVE_V2_MEMORY_PEOPLE_INVALID') {
    super(message);
    this.name = 'ArchiveV2MemoryPeopleFoundationError';
    this.code = code;
  }
}

function fail(message, code = 'ARCHIVE_V2_MEMORY_PEOPLE_INVALID') {
  throw new ArchiveV2MemoryPeopleFoundationError(message, code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, active = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('结果不是合法 JSON');
    return value;
  }
  if (typeof value !== 'object' || active.has(value)) fail('结果不是合法 JSON');
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string')) fail('结果不是合法 JSON');
    if (Array.isArray(value)) {
      if (keys.some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) fail('数组结构无效');
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('数组结构无效');
        output.push(cloneJson(descriptor.value, active));
      }
      return output;
    }
    if (!isPlainObject(value)) fail('结果不是普通 JSON 对象');
    const output = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('对象结构无效');
      output[key] = cloneJson(descriptor.value, active);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail(`${label} 必须是对象`);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) fail(`${label} 字段无效`);
}

function string(value, label, maxLength, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) fail(`${label} 无效`);
  return value.trim();
}

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) fail('createdAt 无效');
  return value;
}

function refKey(batchIndex, localId) {
  return `${batchIndex}\u0000${localId}`;
}

function safeInputs(manifestValue, batchesValue) {
  let manifest;
  try { manifest = validateArchiveV2MemoryManifest(manifestValue); }
  catch { fail('manifest 无效', 'ARCHIVE_V2_MEMORY_PEOPLE_SOURCE_INVALID'); }
  if (manifest.status !== 'ready') fail('manifest 尚未 ready', 'ARCHIVE_V2_MEMORY_PEOPLE_SOURCE_NOT_READY');
  const batches = cloneJson(batchesValue);
  if (!Array.isArray(batches) || batches.length !== manifest.totalBatches) {
    fail('memory batches 不完整', 'ARCHIVE_V2_MEMORY_PEOPLE_SOURCE_INVALID');
  }
  const knownPeople = new Map();
  const floorSets = new Map();
  const userRelationBatches = new Map();
  const majorEventBatches = new Map();
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const ref = manifest.batchRefs[batchIndex];
    if (!isPlainObject(batch)
      || batch.batchIndex !== batchIndex
      || batch.chatId !== manifest.chatId
      || batch.scanId !== manifest.scanId
      || batch.sourceFingerprint !== ref?.sourceFingerprint
      || !isPlainObject(batch.rows)) {
      fail('memory batch 绑定无效', 'ARCHIVE_V2_MEMORY_PEOPLE_SOURCE_INVALID');
    }
    for (const key of ['people', 'facts', 'relations', 'events']) {
      if (!Array.isArray(batch.rows[key])) fail('memory batch rows 无效', 'ARCHIVE_V2_MEMORY_PEOPLE_SOURCE_INVALID');
    }
    const batchPersonIds = new Set();
    for (const person of batch.rows.people) {
      if (!isPlainObject(person) || typeof person.localId !== 'string' || !person.localId
        || !Array.isArray(person.sourceFloors) || batchPersonIds.has(person.localId)) {
        fail('memory person 无效', 'ARCHIVE_V2_MEMORY_PEOPLE_SOURCE_INVALID');
      }
      batchPersonIds.add(person.localId);
      const key = refKey(batchIndex, person.localId);
      knownPeople.set(key, { batchIndex, localId: person.localId });
      floorSets.set(key, new Set(person.sourceFloors));
      userRelationBatches.set(key, new Set());
      majorEventBatches.set(key, new Set());
    }
    const addFloors = (localId, floors) => {
      const set = floorSets.get(refKey(batchIndex, localId));
      if (!set || !Array.isArray(floors)) fail('memory 行引用无效', 'ARCHIVE_V2_MEMORY_PEOPLE_SOURCE_INVALID');
      for (const floor of floors) {
        if (!Number.isSafeInteger(floor) || floor < 0 || floor > manifest.targetFloor) {
          fail('memory 楼层无效', 'ARCHIVE_V2_MEMORY_PEOPLE_SOURCE_INVALID');
        }
        set.add(floor);
      }
    };
    for (const fact of batch.rows.facts) addFloors(fact.subjectLocalId, fact.sourceFloors);
    for (const relation of batch.rows.relations) {
      addFloors(relation.subjectLocalId, relation.sourceFloors);
      if (relation.objectKind === 'person') addFloors(relation.objectLocalId, relation.sourceFloors);
      if (relation.objectKind === 'user') userRelationBatches.get(refKey(batchIndex, relation.subjectLocalId))?.add(batchIndex);
    }
    for (const event of batch.rows.events) for (const localId of event.participantLocalIds ?? []) {
      addFloors(localId, event.sourceFloors);
      if (event.significance === 'major') majorEventBatches.get(refKey(batchIndex, localId))?.add(batchIndex);
    }
  }
  return { manifest, batches, knownPeople, floorSets, userRelationBatches, majorEventBatches };
}

function normalizedKey(value) {
  return value.normalize('NFKC').trim().toLowerCase();
}

function validatePerson(value, expectedKeys, knownPeople, claimed) {
  exactKeys(value, expectedKeys, 'person');
  const localId = string(value.localId, 'localId', 128);
  if (!LOCAL_ID.test(localId)) fail('localId 必须是 C1...Cn');
  const displayName = string(value.displayName, 'displayName', LIMITS.name);
  if (!Array.isArray(value.aliases) || value.aliases.length > LIMITS.aliases) fail('aliases 无效');
  const aliasKeys = new Set([normalizedKey(displayName)]);
  const aliases = value.aliases.map(alias => {
    const normalized = string(alias, 'alias', LIMITS.alias);
    const key = normalizedKey(normalized);
    if (aliasKeys.has(key)) fail('aliases 重复');
    aliasKeys.add(key);
    return normalized;
  });
  const recognitionReason = string(value.recognitionReason, 'recognitionReason', LIMITS.reason);
  const recommendationReason = string(value.recommendationReason, 'recommendationReason', LIMITS.reason);
  if (!RECOMMENDATIONS.has(value.recommendation)) fail('recommendation 枚举无效');
  if (!Array.isArray(value.sourcePeopleRefs) || value.sourcePeopleRefs.length < 1) fail('sourcePeopleRefs 无效');
  const localRefs = new Set();
  const sourcePeopleRefs = value.sourcePeopleRefs.map(ref => {
    exactKeys(ref, REF_KEYS, 'sourcePeopleRef');
    if (!Number.isSafeInteger(ref.batchIndex) || ref.batchIndex < 0) fail('sourcePeopleRef.batchIndex 无效');
    const sourceLocalId = string(ref.localId, 'sourcePeopleRef.localId', 128);
    const key = refKey(ref.batchIndex, sourceLocalId);
    if (!knownPeople.has(key) || localRefs.has(key) || claimed.has(key)) fail('sourcePeopleRef 引用、重复归属或归并无效');
    localRefs.add(key);
    claimed.add(key);
    return { batchIndex: ref.batchIndex, localId: sourceLocalId };
  });
  return {
    localId, displayName, aliases, recognitionReason, sourcePeopleRefs,
    recommendation: value.recommendation, recommendationReason,
  };
}

function statisticsFor(person, sources) {
  const batches = new Set();
  const floors = new Set();
  const userRelationBatches = new Set();
  const majorEventBatches = new Set();
  for (const ref of person.sourcePeopleRefs) {
    const key = refKey(ref.batchIndex, ref.localId);
    batches.add(ref.batchIndex);
    for (const floor of sources.floorSets.get(key) ?? []) floors.add(floor);
    for (const index of sources.userRelationBatches.get(key) ?? []) userRelationBatches.add(index);
    for (const index of sources.majorEventBatches.get(key) ?? []) majorEventBatches.add(index);
  }
  return {
    appearanceBatchCount: batches.size,
    sourceFloorCount: floors.size,
    userRelationBatchCount: userRelationBatches.size,
    majorEventBatchCount: majorEventBatches.size,
  };
}

function comparePeople(left, right) {
  const order = new Map(ARCHIVE_V2_MEMORY_PEOPLE_RECOMMENDATIONS.map((value, index) => [value, index]));
  return order.get(left.recommendation) - order.get(right.recommendation)
    || right.statistics.userRelationBatchCount - left.statistics.userRelationBatchCount
    || right.statistics.appearanceBatchCount - left.statistics.appearanceBatchCount
    || left.displayName.localeCompare(right.displayName, 'zh-Hans-CN');
}

function validateUserSourcePeopleRefs(value, sources, claimed) {
  if (!Array.isArray(value) || value.length > sources.knownPeople.size) {
    fail('userSourcePeopleRefs 无效');
  }
  return value.map(ref => {
    exactKeys(ref, REF_KEYS, 'userSourcePeopleRef');
    if (!Number.isSafeInteger(ref.batchIndex) || ref.batchIndex < 0) fail('userSourcePeopleRef.batchIndex 无效');
    const sourceLocalId = string(ref.localId, 'userSourcePeopleRef.localId', 128);
    const key = refKey(ref.batchIndex, sourceLocalId);
    if (!sources.knownPeople.has(key) || claimed.has(key)) {
      fail('userSourcePeopleRef 引用或重复归属无效');
    }
    claimed.add(key);
    return { batchIndex: ref.batchIndex, localId: sourceLocalId };
  });
}

function validatedAiOutput(output, sources) {
  exactKeys(output, AI_ROOT_KEYS, 'AI root');
  if (!Array.isArray(output.people) || output.people.length > LIMITS.people) fail('AI people 无效');
  const ids = new Set();
  const claimed = new Set();
  const people = output.people.map(value => {
    const person = validatePerson(value, AI_PERSON_KEYS, sources.knownPeople, claimed);
    if (ids.has(person.localId)) fail('AI localId 重复');
    ids.add(person.localId);
    return { ...person, statistics: statisticsFor(person, sources) };
  });
  const userSourcePeopleRefs = validateUserSourcePeopleRefs(output.userSourcePeopleRefs, sources, claimed);
  for (let index = 0; index < people.length; index += 1) {
    if (!ids.has(`C${index + 1}`)) fail('AI localId 必须连续覆盖 C1...Cn');
  }
  if (claimed.size !== sources.knownPeople.size) fail('输入人物必须恰好覆盖一次');
  return { people: people.sort(comparePeople), userSourcePeopleRefs };
}

function freezeResult(sources, people, userSourcePeopleRefs, createdAt) {
  return Object.freeze({
    schemaVersion: ARCHIVE_V2_MEMORY_PEOPLE_SCHEMA_VERSION,
    kind: ARCHIVE_V2_MEMORY_PEOPLE_KIND,
    chatId: sources.manifest.chatId,
    scanId: sources.manifest.scanId,
    sourceFingerprint: sources.manifest.sourceFingerprint,
    targetFloor: sources.manifest.targetFloor,
    people: Object.freeze(people.map(person => Object.freeze({
      ...person,
      aliases: Object.freeze([...person.aliases]),
      sourcePeopleRefs: Object.freeze(person.sourcePeopleRefs.map(ref => Object.freeze({ ...ref }))),
      statistics: Object.freeze({ ...person.statistics }),
    }))),
    userSourcePeopleRefs: Object.freeze(userSourcePeopleRefs.map(ref => Object.freeze({ ...ref }))),
    createdAt: timestamp(createdAt),
  });
}

function validateStatistics(value) {
  exactKeys(value, STAT_KEYS, 'statistics');
  const output = {};
  for (const key of STAT_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail(`statistics.${key} 无效`);
    output[key] = value[key];
  }
  return output;
}

export function createArchiveV2MemoryPeopleResult({ manifest, batches, output, createdAt } = {}) {
  const sources = safeInputs(manifest, batches);
  const safeOutput = cloneJson(output);
  const { people, userSourcePeopleRefs } = validatedAiOutput(safeOutput, sources);
  return freezeResult(sources, people, userSourcePeopleRefs, createdAt);
}

export function validateArchiveV2MemoryPeopleResult(value, { manifest, batches, expectedChatId } = {}) {
  const sources = safeInputs(manifest, batches);
  const result = cloneJson(value);
  const isLegacy = result?.schemaVersion === 1;
  exactKeys(result, isLegacy ? LEGACY_ROOT_KEYS : ROOT_KEYS, 'result');
  if ((!isLegacy && result.schemaVersion !== ARCHIVE_V2_MEMORY_PEOPLE_SCHEMA_VERSION)
    || result.kind !== ARCHIVE_V2_MEMORY_PEOPLE_KIND
    || result.chatId !== sources.manifest.chatId
    || (expectedChatId !== undefined && result.chatId !== expectedChatId)
    || result.scanId !== sources.manifest.scanId
    || result.sourceFingerprint !== sources.manifest.sourceFingerprint
    || !FINGERPRINT.test(result.sourceFingerprint)
    || result.targetFloor !== sources.manifest.targetFloor
    || !Array.isArray(result.people)
    || result.people.length > LIMITS.people) {
    fail('result 绑定无效');
  }
  const claimed = new Set();
  const ids = new Set();
  const people = result.people.map(value => {
    const person = validatePerson(value, PERSON_KEYS, sources.knownPeople, claimed);
    if (ids.has(person.localId)) fail('result localId 重复');
    ids.add(person.localId);
    const statistics = validateStatistics(value.statistics);
    const expected = statisticsFor(person, sources);
    if (JSON.stringify(statistics) !== JSON.stringify(expected)) fail('result statistics 不是本地派生值');
    return { ...person, statistics };
  });
  for (let index = 0; index < people.length; index += 1) {
    if (!ids.has(`C${index + 1}`)) fail('result localId 必须连续覆盖 C1...Cn');
  }
  const userSourcePeopleRefs = validateUserSourcePeopleRefs(
    isLegacy ? [] : result.userSourcePeopleRefs,
    sources,
    claimed,
  );
  if (claimed.size !== sources.knownPeople.size) fail('result 来源覆盖不完整');
  const sorted = [...people].sort(comparePeople);
  if (sorted.some((person, index) => person.localId !== people[index].localId)) fail('result 排序无效');
  timestamp(result.createdAt);
  return freezeResult(sources, people, userSourcePeopleRefs, result.createdAt);
}
