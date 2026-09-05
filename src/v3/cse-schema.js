import { isUuid, sha256 } from '../identity.js';
import { validateMemoryGraph } from './memory-schema.js';

export const CSE_VISIBILITIES = Object.freeze(['private', 'expressed', 'observable', 'shared', 'authorial']);
export const CSE_ORIGINS = Object.freeze(['baseline', 'floor', 'reasonableProgression']);
const HASH = /^sha256:[0-9a-f]{64}$/;
const STATUSES = new Set(['active', 'superseded', 'invalidated']);

function fail(code, path = '') {
  const error = new TypeError(path ? `${code}:${path}` : code);
  error.code = code;
  error.validationPath = path;
  throw error;
}
function clone(value) { try { return structuredClone(value); } catch { fail('V3_CSE_JSON_INVALID'); } }
function object(value, code, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, path); return value; }
function array(value, code, path, maximum = 160) { if (!Array.isArray(value) || value.length > maximum) fail(code, path); return value; }
function text(value, code, path, { nullable = false, maximum = 12000 } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(code, path);
  return value;
}
function uuid(value, code, path, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!isUuid(value)) fail(code, path);
  return value;
}
function timestamp(value, code, path) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(code, path); }
function fingerprint(value, code, path) { if (typeof value !== 'string' || !HASH.test(value)) fail(code, path); }
function common(value, type, expectedChatId) {
  if (value.schemaVersion !== 3 || value.recordType !== type) fail(`V3_${type.toUpperCase()}_INVALID`);
  uuid(value.id, `V3_${type.toUpperCase()}_INVALID`, 'id');
  uuid(value.chatId, `V3_${type.toUpperCase()}_INVALID`, 'chatId');
  if (expectedChatId && value.chatId !== expectedChatId) fail(`V3_${type.toUpperCase()}_INVALID`, 'chatId');
  uuid(value.narrativeGeneration, `V3_${type.toUpperCase()}_INVALID`, 'narrativeGeneration');
  timestamp(value.createdAt, `V3_${type.toUpperCase()}_INVALID`, 'createdAt');
  timestamp(value.updatedAt, `V3_${type.toUpperCase()}_INVALID`, 'updatedAt');
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) fail(`V3_${type.toUpperCase()}_INVALID`, 'updatedAt');
  if (!STATUSES.has(value.recordStatus)) fail(`V3_${type.toUpperCase()}_INVALID`, 'recordStatus');
  uuid(value.supersedes, `V3_${type.toUpperCase()}_INVALID`, 'supersedes', { nullable: true });
}

function validateStateItem(value, path) {
  object(value, 'V3_CSE_STATE_ITEM_INVALID', path);
  uuid(value.id, 'V3_CSE_STATE_ITEM_INVALID', `${path}.id`);
  text(value.text, 'V3_CSE_STATE_ITEM_INVALID', `${path}.text`, { maximum: 4000 });
  if (!CSE_VISIBILITIES.includes(value.visibility)) fail('V3_CSE_STATE_ITEM_INVALID', `${path}.visibility`);
  text(value.reason, 'V3_CSE_STATE_ITEM_INVALID', `${path}.reason`, { maximum: 4000 });
  if (!CSE_ORIGINS.includes(value.origin)) fail('V3_CSE_STATE_ITEM_INVALID', `${path}.origin`);
  uuid(value.towardEntityId, 'V3_CSE_STATE_ITEM_INVALID', `${path}.towardEntityId`, { nullable: true });
  uuid(value.sourceFloorId, 'V3_CSE_STATE_ITEM_INVALID', `${path}.sourceFloorId`, { nullable: true });
  uuid(value.sourceDeltaId, 'V3_CSE_STATE_ITEM_INVALID', `${path}.sourceDeltaId`, { nullable: true });
  return value;
}

function validateSubject(value, path, { current = false } = {}) {
  object(value, 'V3_CSE_SUBJECT_INVALID', path);
  uuid(value.subjectEntityId, 'V3_CSE_SUBJECT_INVALID', `${path}.subjectEntityId`);
  for (const field of ['core', 'adaptive', 'situational']) {
    array(value[field], 'V3_CSE_SUBJECT_INVALID', `${path}.${field}`, 120)
      .forEach((item, index) => validateStateItem(item, `${path}.${field}[${index}]`));
  }
  if (!current) {
    array(value.changeSummary, 'V3_CSE_SUBJECT_INVALID', `${path}.changeSummary`, 40)
      .forEach((item, index) => text(item, 'V3_CSE_SUBJECT_INVALID', `${path}.changeSummary[${index}]`, { maximum: 2000 }));
    array(value.coreChallenges, 'V3_CSE_SUBJECT_INVALID', `${path}.coreChallenges`, 40)
      .forEach((item, index) => text(item, 'V3_CSE_SUBJECT_INVALID', `${path}.coreChallenges[${index}]`, { maximum: 2000 }));
  }
  return value;
}

export function validateBaselineRecord(input, { expectedChatId } = {}) {
  const value = clone(input);
  common(value, 'baseline', expectedChatId);
  object(value.userPersona, 'V3_BASELINE_INVALID', 'userPersona');
  uuid(value.userPersona.entityId, 'V3_BASELINE_INVALID', 'userPersona.entityId');
  text(value.userPersona.name, 'V3_BASELINE_INVALID', 'userPersona.name', { maximum: 500 });
  if (typeof value.userPersona.description !== 'string' || value.userPersona.description.length > 40000) fail('V3_BASELINE_INVALID', 'userPersona.description');
  array(value.userPersona.aliases, 'V3_BASELINE_INVALID', 'userPersona.aliases', 40)
    .forEach((item, index) => text(item, 'V3_BASELINE_INVALID', `userPersona.aliases[${index}]`, { maximum: 500 }));
  object(value.characterCard, 'V3_BASELINE_INVALID', 'characterCard');
  uuid(value.characterCard.entityId, 'V3_BASELINE_INVALID', 'characterCard.entityId');
  text(value.characterCard.name, 'V3_BASELINE_INVALID', 'characterCard.name', { maximum: 500 });
  for (const field of ['description', 'personality', 'scenario']) if (typeof value.characterCard[field] !== 'string' || value.characterCard[field].length > 40000) fail('V3_BASELINE_INVALID', `characterCard.${field}`);
  array(value.worldInfoSources, 'V3_BASELINE_INVALID', 'worldInfoSources', 5000).forEach((item, index) => {
    const path = `worldInfoSources[${index}]`; object(item, 'V3_BASELINE_INVALID', path);
    for (const field of ['sourceKind', 'sourceName', 'scope', 'locator', 'content']) text(item[field], 'V3_BASELINE_INVALID', `${path}.${field}`, { maximum: field === 'content' ? 40000 : 512 });
    if (item.enabled !== true || typeof item.activated !== 'boolean') fail('V3_BASELINE_INVALID', `${path}.enabled`);
    fingerprint(item.fingerprint, 'V3_BASELINE_INVALID', `${path}.fingerprint`);
    if (item.visibility !== 'authorial') fail('V3_BASELINE_INVALID', `${path}.visibility`);
  });
  fingerprint(value.fingerprint, 'V3_BASELINE_INVALID', 'fingerprint');
  return Object.freeze(value);
}

export function validateStateDeltaRecord(input, { expectedChatId } = {}) {
  const value = clone(input);
  common(value, 'stateDelta', expectedChatId);
  for (const field of ['floorId', 'floorMemoryId', 'baselineId']) uuid(value[field], 'V3_STATEDELTA_INVALID', field);
  uuid(value.previousCurrentStateId, 'V3_STATEDELTA_INVALID', 'previousCurrentStateId', { nullable: true });
  array(value.subjectSnapshots, 'V3_STATEDELTA_INVALID', 'subjectSnapshots', 80).forEach((subject, index) => validateSubject(subject, `subjectSnapshots[${index}]`));
  if (typeof value.noMaterialChange !== 'boolean') fail('V3_STATEDELTA_INVALID', 'noMaterialChange');
  fingerprint(value.fingerprint, 'V3_STATEDELTA_INVALID', 'fingerprint');
  object(value.source, 'V3_STATEDELTA_INVALID', 'source');
  text(value.source.promptVersion, 'V3_STATEDELTA_INVALID', 'source.promptVersion', { maximum: 160 });
  text(value.source.compilerVersion, 'V3_STATEDELTA_INVALID', 'source.compilerVersion', { maximum: 160 });
  return Object.freeze(value);
}

export function validateCurrentStateRecord(input, { expectedChatId } = {}) {
  const value = clone(input);
  common(value, 'currentState', expectedChatId);
  uuid(value.baselineId, 'V3_CURRENTSTATE_INVALID', 'baselineId');
  array(value.subjects, 'V3_CURRENTSTATE_INVALID', 'subjects', 80).forEach((subject, index) => validateSubject(subject, `subjects[${index}]`, { current: true }));
  array(value.appliedDeltaIds, 'V3_CURRENTSTATE_INVALID', 'appliedDeltaIds', 10000).forEach((id, index) => uuid(id, 'V3_CURRENTSTATE_INVALID', `appliedDeltaIds[${index}]`));
  uuid(value.headFloorId, 'V3_CURRENTSTATE_INVALID', 'headFloorId', { nullable: true });
  fingerprint(value.fingerprint, 'V3_CURRENTSTATE_INVALID', 'fingerprint');
  return Object.freeze(value);
}

export async function stateFingerprint(subjects, appliedDeltaIds, headFloorId) {
  return `sha256:${await sha256(JSON.stringify([subjects, appliedDeltaIds, headFloorId]))}`;
}

export async function validateCseGraph({ root = null, checkpoint, run = null, floors = [], floorMemories = [], entities = [], indexes = [], indexKeys = [], baseline = null, stateDeltas = [], currentStates = [], allowMissingIndexes = false, allowLegacySnapshot = false } = {}) {
  await validateMemoryGraph({ root, checkpoint, run, floors, floorMemories, entities, indexes, indexKeys, allowMissingIndexes, allowLegacySnapshot });
  const chatId = root?.chatId ?? checkpoint?.chatId;
  const safeBaseline = baseline ? validateBaselineRecord(baseline, { expectedChatId: chatId }) : null;
  const deltas = stateDeltas.map(value => validateStateDeltaRecord(value, { expectedChatId: chatId }));
  const states = currentStates.map(value => validateCurrentStateRecord(value, { expectedChatId: chatId }));
  if ((root?.baselineId ?? null) !== (safeBaseline?.id ?? null)) fail('V3_CSE_GRAPH_BASELINE_REF_INVALID');
  if (checkpoint.producedRefs.stateDeltas.length !== deltas.length || checkpoint.producedRefs.stateDeltas.some((id, index) => id !== deltas[index]?.id)) fail('V3_CSE_GRAPH_DELTA_LIST_INVALID');
  if (checkpoint.producedRefs.currentStates.length !== states.length || checkpoint.producedRefs.currentStates.some((id, index) => id !== states[index]?.id)) fail('V3_CSE_GRAPH_CURRENT_LIST_INVALID');
  const floorsById = new Map(floors.map(value => [value.id, value]));
  const floorOrder = new Map(floors.map((value, index) => [value.id, index]));
  const memoryRecordsByFloor = new Map();
  for (const memory of floorMemories) memoryRecordsByFloor.set(memory.floorId, [...(memoryRecordsByFloor.get(memory.floorId) ?? []), memory]);
  const memoriesByFloor = new Map();
  for (const [floorId, records] of memoryRecordsByFloor) {
    const active = records.filter(value => value.recordStatus === 'active');
    if (active.length === 1) memoriesByFloor.set(floorId, active[0]);
  }
  const entityIds = new Set(entities.map(value => value.id));
  const deltaIds = new Set(deltas.map(value => value.id));
  const activeMemoryFloors = [];
  for (const floor of floors) {
    const records = memoryRecordsByFloor.get(floor.id) ?? [];
    if (!records.length) continue;
    const active = records.filter(value => value.recordStatus === 'active');
    if (active.length !== 1) break;
    activeMemoryFloors.push(floor);
  }
  if (deltas.length > activeMemoryFloors.length || deltas.some((delta, index) => delta.floorId !== activeMemoryFloors[index]?.id)) fail('V3_CSE_GRAPH_DELTA_PREFIX_INVALID');
  const seenFloors = new Set();
  const acceptedDeltaIds = new Set();
  for (const delta of deltas) {
    if (!safeBaseline || delta.baselineId !== safeBaseline.id || !floorsById.has(delta.floorId) || memoriesByFloor.get(delta.floorId)?.id !== delta.floorMemoryId || seenFloors.has(delta.floorId)) fail('V3_CSE_GRAPH_DELTA_REF_INVALID');
    seenFloors.add(delta.floorId);
    acceptedDeltaIds.add(delta.id);
    for (const subject of delta.subjectSnapshots) {
      if (!entityIds.has(subject.subjectEntityId)) fail('V3_CSE_GRAPH_ENTITY_REF_INVALID');
      for (const item of [...subject.core, ...subject.adaptive, ...subject.situational]) {
        if (item.towardEntityId && !entityIds.has(item.towardEntityId)) fail('V3_CSE_GRAPH_ENTITY_REF_INVALID');
        if (item.sourceFloorId && (!floorsById.has(item.sourceFloorId) || floorOrder.get(item.sourceFloorId) > floorOrder.get(delta.floorId))) fail('V3_CSE_GRAPH_SOURCE_REF_INVALID');
        if (item.sourceDeltaId && (!deltaIds.has(item.sourceDeltaId) || !acceptedDeltaIds.has(item.sourceDeltaId))) fail('V3_CSE_GRAPH_SOURCE_REF_INVALID');
      }
    }
  }
  const current = states.at(-1) ?? null;
  if (states.length > 1 || (current && (!safeBaseline || current.baselineId !== safeBaseline.id || current.appliedDeltaIds.some(id => !deltas.some(delta => delta.id === id))))) fail('V3_CSE_GRAPH_CURRENT_REF_INVALID');
  if (current && current.fingerprint !== await stateFingerprint(current.subjects, current.appliedDeltaIds, current.headFloorId)) fail('V3_CSE_GRAPH_CURRENT_FINGERPRINT_INVALID');
  const activeMemories = floorMemories.filter(value => value.recordStatus === 'active');
  const ready = activeMemories.length > 0 && activeMemories.every(memory => deltas.some(delta => delta.floorId === memory.floorId && delta.floorMemoryId === memory.id));
  if (checkpoint.capabilities.cseReady !== ready || (root && root.capabilities.cseReady !== ready)) fail('V3_CSE_GRAPH_CAPABILITY_INVALID');
  return Object.freeze({ schemaValid: true, referencesValid: true, orderedReplayValid: true });
}
