import { isUuid, sha256 } from '../identity.js';
import { validateFoundationGraph } from './foundation-schema.js';

export const FLOOR_MEMORY_ITEM_LIMIT = 80;
export const EXACT_ANCHOR_LIMIT = 60;

const RECORD_STATUSES = new Set(['active', 'superseded', 'invalidated']);
const ENTITY_TYPES = new Set(['person', 'organization', 'place', 'object', 'creature', 'concept', 'unknown']);
const ARRAY_FIELDS = Object.freeze([
  'chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers',
  'privateCognition', 'commitments', 'eventFragments', 'exactAnchors', 'openLoops', 'ambiguities', 'cseSignals',
]);
const HASH = /^sha256:[0-9a-f]{64}$/;

function fail(code, path = '') {
  const error = new TypeError(path ? `${code}:${path}` : code);
  error.code = code;
  error.validationPath = path;
  throw error;
}
function object(value, code, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, path); return value; }
function array(value, code, path) { if (!Array.isArray(value)) fail(code, path); return value; }
function exact(value, keys, code, path) {
  object(value, code, path);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code, path);
}
function text(value, code, path, { nullable = false, max = 12000 } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(code, path);
  return value;
}
function uuid(value, code, path, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!isUuid(value)) fail(code, path);
  return value;
}
function timestamp(value, code, path) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(code, path); }
function enumValue(value, values, code, path) { if (!values.includes(value)) fail(code, path); return value; }
function boundedArray(value, code, path, maximum = 80) { const result = array(value, code, path); if (result.length > maximum) fail(code, path); return result; }
function clone(value) {
  try { return structuredClone(value); }
  catch { fail('V3_MEMORY_JSON_INVALID'); }
}
function common(value, type, expectedChatId) {
  if (value.schemaVersion !== 3 || value.recordType !== type) fail(`V3_${type.toUpperCase()}_INVALID`);
  uuid(value.id, `V3_${type.toUpperCase()}_INVALID`, 'id');
  uuid(value.chatId, `V3_${type.toUpperCase()}_INVALID`, 'chatId');
  if (expectedChatId && value.chatId !== expectedChatId) fail(`V3_${type.toUpperCase()}_INVALID`, 'chatId');
  uuid(value.narrativeGeneration, `V3_${type.toUpperCase()}_INVALID`, 'narrativeGeneration');
  timestamp(value.createdAt, `V3_${type.toUpperCase()}_INVALID`, 'createdAt');
  timestamp(value.updatedAt, `V3_${type.toUpperCase()}_INVALID`, 'updatedAt');
  enumValue(value.recordStatus, [...RECORD_STATUSES], `V3_${type.toUpperCase()}_INVALID`, 'recordStatus');
  uuid(value.supersedes, `V3_${type.toUpperCase()}_INVALID`, 'supersedes', { nullable: true });
}

export function validateEvidenceRef(input, { floorId = null, path = 'evidence' } = {}) {
  const value = clone(input);
  exact(value, ['floorId', 'anchorId', 'quotedText', 'occurrence', 'evidenceMode', 'supports', 'sourceEntityId'], 'V3_EVIDENCE_INVALID', path);
  uuid(value.floorId, 'V3_EVIDENCE_INVALID', `${path}.floorId`);
  if (floorId && value.floorId !== floorId) fail('V3_EVIDENCE_INVALID', `${path}.floorId`);
  uuid(value.anchorId, 'V3_EVIDENCE_INVALID', `${path}.anchorId`, { nullable: true });
  text(value.quotedText, 'V3_EVIDENCE_INVALID', `${path}.quotedText`, { max: 2000 });
  if (!Number.isSafeInteger(value.occurrence) || value.occurrence < 1) fail('V3_EVIDENCE_INVALID', `${path}.occurrence`);
  enumValue(value.evidenceMode, ['explicit', 'witnessed', 'reported', 'privateCognition', 'interpretation'], 'V3_EVIDENCE_INVALID', `${path}.evidenceMode`);
  text(value.supports, 'V3_EVIDENCE_INVALID', `${path}.supports`, { max: 2000 });
  uuid(value.sourceEntityId, 'V3_EVIDENCE_INVALID', `${path}.sourceEntityId`, { nullable: true });
  return value;
}

function evidenceList(value, floorId, path, { required = false } = {}) {
  const list = boundedArray(value, 'V3_FLOORMEMORY_INVALID', path, 40).map((item, index) => validateEvidenceRef(item, { floorId, path: `${path}[${index}]` }));
  if (required && !list.length) fail('V3_FLOORMEMORY_INVALID', path);
  return list;
}
function uuidList(value, path, maximum = 40) { return boundedArray(value, 'V3_FLOORMEMORY_INVALID', path, maximum).map((item, index) => uuid(item, 'V3_FLOORMEMORY_INVALID', `${path}[${index}]`)); }
function itemCommon(item, keys, path) {
  exact(item, keys, 'V3_FLOORMEMORY_INVALID', path);
  uuid(item.itemId, 'V3_FLOORMEMORY_INVALID', `${path}.itemId`);
}

export function validateFloorMemory(input, { expectedChatId } = {}) {
  const value = clone(input);
  exact(value, ['schemaVersion', 'recordType', 'id', 'chatId', 'narrativeGeneration', 'floorId', 'extractorVersion', 'summary', 'summaryEvidenceRefs', ...ARRAY_FIELDS, 'createdAt', 'updatedAt', 'recordStatus', 'supersedes'], 'V3_FLOORMEMORY_INVALID');
  common(value, 'floorMemory', expectedChatId);
  uuid(value.floorId, 'V3_FLOORMEMORY_INVALID', 'floorId');
  text(value.extractorVersion, 'V3_FLOORMEMORY_INVALID', 'extractorVersion', { max: 160 });
  exact(value.summary, ['aiText', 'userText', 'effectiveSource', 'revisionNote'], 'V3_FLOORMEMORY_INVALID', 'summary');
  text(value.summary.aiText, 'V3_FLOORMEMORY_INVALID', 'summary.aiText', { max: 4000 });
  if (value.summary.userText !== null) text(value.summary.userText, 'V3_FLOORMEMORY_INVALID', 'summary.userText', { max: 4000 });
  enumValue(value.summary.effectiveSource, ['ai', 'user'], 'V3_FLOORMEMORY_INVALID', 'summary.effectiveSource');
  if (value.summary.effectiveSource === 'user' && !value.summary.userText?.trim()) fail('V3_FLOORMEMORY_INVALID', 'summary.effectiveSource');
  if (value.summary.revisionNote !== null) text(value.summary.revisionNote, 'V3_FLOORMEMORY_INVALID', 'summary.revisionNote', { max: 1000 });
  value.summaryEvidenceRefs = evidenceList(value.summaryEvidenceRefs, value.floorId, 'summaryEvidenceRefs', { required: false });
  for (const field of ARRAY_FIELDS) boundedArray(value[field], 'V3_FLOORMEMORY_INVALID', field, field === 'exactAnchors' ? EXACT_ANCHOR_LIMIT : FLOOR_MEMORY_ITEM_LIMIT);

  value.chronology.forEach((item, index) => {
    const path = `chronology[${index}]`; itemCommon(item, ['itemId', 'time', 'description', 'evidenceRefs'], path);
    exact(item.time, ['kind', 'sourceText', 'normalized', 'precision', 'relativeToFloorId'], 'V3_FLOORMEMORY_INVALID', `${path}.time`);
    enumValue(item.time.kind, ['explicit', 'relative', 'sequenceOnly', 'unknown'], 'V3_FLOORMEMORY_INVALID', `${path}.time.kind`);
    if (item.time.sourceText !== null) text(item.time.sourceText, 'V3_FLOORMEMORY_INVALID', `${path}.time.sourceText`, { max: 500 });
    if (item.time.normalized !== null) text(item.time.normalized, 'V3_FLOORMEMORY_INVALID', `${path}.time.normalized`, { max: 500 });
    enumValue(item.time.precision, ['exact', 'approximate', 'unresolved'], 'V3_FLOORMEMORY_INVALID', `${path}.time.precision`);
    uuid(item.time.relativeToFloorId, 'V3_FLOORMEMORY_INVALID', `${path}.time.relativeToFloorId`, { nullable: true });
    text(item.description, 'V3_FLOORMEMORY_INVALID', `${path}.description`, { max: 2000 }); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`);
  });
  value.locations.forEach((item, index) => {
    const path = `locations[${index}]`; itemCommon(item, ['itemId', 'entityId', 'name', 'change', 'participantEntityIds', 'evidenceRefs'], path);
    uuid(item.entityId, 'V3_FLOORMEMORY_INVALID', `${path}.entityId`, { nullable: true }); text(item.name, 'V3_FLOORMEMORY_INVALID', `${path}.name`, { max: 500 });
    enumValue(item.change, ['present', 'entered', 'left', 'movedThrough', 'mentioned'], 'V3_FLOORMEMORY_INVALID', `${path}.change`); uuidList(item.participantEntityIds, `${path}.participantEntityIds`); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`);
  });
  value.participants.forEach((item, index) => {
    const path = `participants[${index}]`; exact(item, ['entityId', 'presence', 'evidenceRefs'], 'V3_FLOORMEMORY_INVALID', path);
    uuid(item.entityId, 'V3_FLOORMEMORY_INVALID', `${path}.entityId`); enumValue(item.presence, ['present', 'remote', 'mentioned', 'privateCognitionOnly'], 'V3_FLOORMEMORY_INVALID', `${path}.presence`); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`);
  });
  value.actions.forEach((item, index) => {
    const path = `actions[${index}]`; itemCommon(item, ['itemId', 'actorEntityId', 'targetEntityIds', 'action', 'completion', 'result', 'evidenceRefs'], path);
    uuid(item.actorEntityId, 'V3_FLOORMEMORY_INVALID', `${path}.actorEntityId`); uuidList(item.targetEntityIds, `${path}.targetEntityIds`); text(item.action, 'V3_FLOORMEMORY_INVALID', `${path}.action`, { max: 2000 });
    enumValue(item.completion, ['intended', 'attempted', 'completed', 'interrupted', 'uncertain'], 'V3_FLOORMEMORY_INVALID', `${path}.completion`); if (item.result !== null) text(item.result, 'V3_FLOORMEMORY_INVALID', `${path}.result`, { max: 2000 }); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`);
  });
  value.observations.forEach((item, index) => {
    const path = `observations[${index}]`; itemCommon(item, ['itemId', 'subjectEntityId', 'kind', 'description', 'evidenceRefs'], path);
    uuid(item.subjectEntityId, 'V3_FLOORMEMORY_INVALID', `${path}.subjectEntityId`, { nullable: true }); enumValue(item.kind, ['physical', 'injury', 'object', 'environment', 'situational', 'other'], 'V3_FLOORMEMORY_INVALID', `${path}.kind`); text(item.description, 'V3_FLOORMEMORY_INVALID', `${path}.description`, { max: 2000 }); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`);
  });
  value.informationTransfers.forEach((item, index) => {
    const path = `informationTransfers[${index}]`; itemCommon(item, ['itemId', 'fromEntityId', 'toEntityIds', 'claimText', 'channel', 'evidenceRefs'], path);
    uuid(item.fromEntityId, 'V3_FLOORMEMORY_INVALID', `${path}.fromEntityId`, { nullable: true }); uuidList(item.toEntityIds, `${path}.toEntityIds`); text(item.claimText, 'V3_FLOORMEMORY_INVALID', `${path}.claimText`, { max: 2000 }); enumValue(item.channel, ['told', 'shown', 'written', 'overheard', 'discovered'], 'V3_FLOORMEMORY_INVALID', `${path}.channel`); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`);
  });
  value.privateCognition.forEach((item, index) => {
    const path = `privateCognition[${index}]`; itemCommon(item, ['itemId', 'ownerEntityId', 'kind', 'content', 'expressedPublicly', 'evidenceRefs'], path);
    uuid(item.ownerEntityId, 'V3_FLOORMEMORY_INVALID', `${path}.ownerEntityId`); enumValue(item.kind, ['thought', 'emotion', 'intention', 'dream', 'privateDecision', 'suspicion'], 'V3_FLOORMEMORY_INVALID', `${path}.kind`); text(item.content, 'V3_FLOORMEMORY_INVALID', `${path}.content`, { max: 2000 }); if (item.expressedPublicly !== false) fail('V3_FLOORMEMORY_INVALID', `${path}.expressedPublicly`); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`);
  });
  value.commitments.forEach((item, index) => {
    const path = `commitments[${index}]`; itemCommon(item, ['itemId', 'speakerEntityId', 'targetEntityIds', 'kind', 'content', 'status', 'exactAnchorId', 'evidenceRefs'], path);
    uuid(item.speakerEntityId, 'V3_FLOORMEMORY_INVALID', `${path}.speakerEntityId`); uuidList(item.targetEntityIds, `${path}.targetEntityIds`); enumValue(item.kind, ['promise', 'agreement', 'command', 'codePhrase', 'plan', 'boundary'], 'V3_FLOORMEMORY_INVALID', `${path}.kind`); text(item.content, 'V3_FLOORMEMORY_INVALID', `${path}.content`, { max: 2000 }); enumValue(item.status, ['made', 'accepted', 'refused', 'uncertain'], 'V3_FLOORMEMORY_INVALID', `${path}.status`); uuid(item.exactAnchorId, 'V3_FLOORMEMORY_INVALID', `${path}.exactAnchorId`, { nullable: true }); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`);
  });
  value.eventFragments.forEach((item, index) => {
    const path = `eventFragments[${index}]`; itemCommon(item, ['itemId', 'title', 'description', 'candidateStatus', 'eventId', 'evidenceRefs'], path); text(item.title, 'V3_FLOORMEMORY_INVALID', `${path}.title`, { max: 500 }); text(item.description, 'V3_FLOORMEMORY_INVALID', `${path}.description`, { max: 2000 }); enumValue(item.candidateStatus, ['candidate', 'promoted', 'rejected'], 'V3_FLOORMEMORY_INVALID', `${path}.candidateStatus`); uuid(item.eventId, 'V3_FLOORMEMORY_INVALID', `${path}.eventId`, { nullable: true }); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`);
  });
  value.exactAnchors.forEach((item, index) => {
    const path = `exactAnchors[${index}]`; exact(item, ['anchorId', 'kind', 'exactText', 'occurrence', 'speakerEntityId', 'whyPreserve'], 'V3_FLOORMEMORY_INVALID', path); uuid(item.anchorId, 'V3_FLOORMEMORY_INVALID', `${path}.anchorId`); enumValue(item.kind, ['promise', 'codePhrase', 'wording', 'number', 'date', 'riddle', 'title', 'other'], 'V3_FLOORMEMORY_INVALID', `${path}.kind`); text(item.exactText, 'V3_FLOORMEMORY_INVALID', `${path}.exactText`, { max: 2000 }); if (!Number.isSafeInteger(item.occurrence) || item.occurrence < 1) fail('V3_FLOORMEMORY_INVALID', `${path}.occurrence`); uuid(item.speakerEntityId, 'V3_FLOORMEMORY_INVALID', `${path}.speakerEntityId`, { nullable: true }); text(item.whyPreserve, 'V3_FLOORMEMORY_INVALID', `${path}.whyPreserve`, { max: 1000 });
  });
  value.openLoops.forEach((item, index) => {
    const path = `openLoops[${index}]`; itemCommon(item, ['itemId', 'description', 'ownerEntityIds', 'candidateThreadId', 'evidenceRefs'], path); text(item.description, 'V3_FLOORMEMORY_INVALID', `${path}.description`, { max: 2000 }); uuidList(item.ownerEntityIds, `${path}.ownerEntityIds`); uuid(item.candidateThreadId, 'V3_FLOORMEMORY_INVALID', `${path}.candidateThreadId`, { nullable: true }); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`);
  });
  value.ambiguities.forEach((item, index) => {
    const path = `ambiguities[${index}]`; itemCommon(item, ['itemId', 'question', 'possibleReadings', 'evidenceRefs'], path); text(item.question, 'V3_FLOORMEMORY_INVALID', `${path}.question`, { max: 2000 }); boundedArray(item.possibleReadings, 'V3_FLOORMEMORY_INVALID', `${path}.possibleReadings`, 12).forEach((reading, readIndex) => text(reading, 'V3_FLOORMEMORY_INVALID', `${path}.possibleReadings[${readIndex}]`, { max: 1000 })); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`, { required: false });
  });
  value.cseSignals.forEach((item, index) => {
    const path = `cseSignals[${index}]`; itemCommon(item, ['itemId', 'subjectEntityId', 'objectEntityId', 'signalType', 'description', 'evidenceRefs'], path); uuid(item.subjectEntityId, 'V3_FLOORMEMORY_INVALID', `${path}.subjectEntityId`); uuid(item.objectEntityId, 'V3_FLOORMEMORY_INVALID', `${path}.objectEntityId`, { nullable: true }); enumValue(item.signalType, ['emotion', 'boundary', 'conflict', 'reconciliation', 'vulnerability', 'trust', 'betrayal', 'repeatedPattern', 'relationDefinition', 'persistentCondition', 'other'], 'V3_FLOORMEMORY_INVALID', `${path}.signalType`); text(item.description, 'V3_FLOORMEMORY_INVALID', `${path}.description`, { max: 2000 }); evidenceList(item.evidenceRefs, value.floorId, `${path}.evidenceRefs`);
  });
  const itemIds = new Set();
  for (const field of ARRAY_FIELDS.filter(name => !['participants', 'exactAnchors'].includes(name))) {
    for (const [index, item] of value[field].entries()) {
      if (itemIds.has(item.itemId)) fail('V3_FLOORMEMORY_DUPLICATE_ITEM_ID', `${field}[${index}].itemId`);
      itemIds.add(item.itemId);
    }
  }
  const anchorIds = new Set();
  const anchorOccurrences = new Set();
  for (const [index, anchor] of value.exactAnchors.entries()) {
    if (anchorIds.has(anchor.anchorId)) fail('V3_FLOORMEMORY_DUPLICATE_ANCHOR_ID', `exactAnchors[${index}].anchorId`);
    const occurrenceKey = JSON.stringify([anchor.exactText, anchor.occurrence]);
    if (anchorOccurrences.has(occurrenceKey)) fail('V3_FLOORMEMORY_DUPLICATE_ANCHOR_OCCURRENCE', `exactAnchors[${index}].occurrence`);
    anchorIds.add(anchor.anchorId); anchorOccurrences.add(occurrenceKey);
  }
  value.commitments.forEach((item, index) => { if (item.exactAnchorId && !anchorIds.has(item.exactAnchorId)) fail('V3_FLOORMEMORY_ANCHOR_REF_INVALID', `commitments[${index}].exactAnchorId`); });
  return Object.freeze(value);
}

export function validateEntityRecord(input, { expectedChatId } = {}) {
  const value = clone(input);
  exact(value, ['schemaVersion', 'recordType', 'id', 'chatId', 'narrativeGeneration', 'entityType', 'displayName', 'aliases', 'specialRole', 'firstSeenFloorId', 'lastSeenFloorId', 'status', 'mergedIntoEntityId', 'mergeEvidenceRefs', 'baselineClaimIds', 'createdAt', 'updatedAt', 'recordStatus', 'supersedes'], 'V3_ENTITY_INVALID');
  common(value, 'entity', expectedChatId);
  enumValue(value.entityType, [...ENTITY_TYPES], 'V3_ENTITY_INVALID', 'entityType'); text(value.displayName, 'V3_ENTITY_INVALID', 'displayName', { max: 500 }); enumValue(value.specialRole, ['char', 'user', 'none'], 'V3_ENTITY_INVALID', 'specialRole');
  uuid(value.firstSeenFloorId, 'V3_ENTITY_INVALID', 'firstSeenFloorId', { nullable: true }); uuid(value.lastSeenFloorId, 'V3_ENTITY_INVALID', 'lastSeenFloorId', { nullable: true }); enumValue(value.status, ['provisional', 'established', 'merged', 'invalidated'], 'V3_ENTITY_INVALID', 'status'); uuid(value.mergedIntoEntityId, 'V3_ENTITY_INVALID', 'mergedIntoEntityId', { nullable: true });
  boundedArray(value.aliases, 'V3_ENTITY_INVALID', 'aliases', 80).forEach((alias, index) => { const path = `aliases[${index}]`; exact(alias, ['name', 'normalized', 'kind', 'evidenceRefs', 'baselineClaimIds'], 'V3_ENTITY_INVALID', path); text(alias.name, 'V3_ENTITY_INVALID', `${path}.name`, { max: 500 }); text(alias.normalized, 'V3_ENTITY_INVALID', `${path}.normalized`, { max: 500 }); enumValue(alias.kind, ['canonical', 'nickname', 'title', 'disguise', 'uncertain'], 'V3_ENTITY_INVALID', `${path}.kind`); boundedArray(alias.evidenceRefs, 'V3_ENTITY_INVALID', `${path}.evidenceRefs`, 40).forEach((evidence, evidenceIndex) => validateEvidenceRef(evidence, { path: `${path}.evidenceRefs[${evidenceIndex}]` })); boundedArray(alias.baselineClaimIds, 'V3_ENTITY_INVALID', `${path}.baselineClaimIds`, 40).forEach((id, idIndex) => uuid(id, 'V3_ENTITY_INVALID', `${path}.baselineClaimIds[${idIndex}]`)); });
  boundedArray(value.mergeEvidenceRefs, 'V3_ENTITY_INVALID', 'mergeEvidenceRefs', 40).forEach((evidence, index) => validateEvidenceRef(evidence, { path: `mergeEvidenceRefs[${index}]` })); boundedArray(value.baselineClaimIds, 'V3_ENTITY_INVALID', 'baselineClaimIds', 40).forEach((id, index) => uuid(id, 'V3_ENTITY_INVALID', `baselineClaimIds[${index}]`));
  return Object.freeze(value);
}

export function collectFloorMemoryEntityIds(memory) {
  const result = new Set();
  const add = value => { if (isUuid(value)) result.add(value); };
  const addMany = values => (Array.isArray(values) ? values : []).forEach(add);
  memory.summaryEvidenceRefs.forEach(addEvidence => add(addEvidence.sourceEntityId));
  memory.locations.forEach(item => { add(item.entityId); addMany(item.participantEntityIds); });
  memory.participants.forEach(item => add(item.entityId));
  memory.actions.forEach(item => { add(item.actorEntityId); addMany(item.targetEntityIds); });
  memory.observations.forEach(item => add(item.subjectEntityId));
  memory.informationTransfers.forEach(item => { add(item.fromEntityId); addMany(item.toEntityIds); });
  memory.privateCognition.forEach(item => add(item.ownerEntityId));
  memory.commitments.forEach(item => { add(item.speakerEntityId); addMany(item.targetEntityIds); });
  memory.exactAnchors.forEach(item => add(item.speakerEntityId));
  memory.openLoops.forEach(item => addMany(item.ownerEntityIds));
  memory.cseSignals.forEach(item => { add(item.subjectEntityId); add(item.objectEntityId); });
  for (const field of ['chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'openLoops', 'ambiguities', 'cseSignals']) {
    memory[field].forEach(item => (item.evidenceRefs ?? []).forEach(evidence => add(evidence.sourceEntityId)));
  }
  return result;
}

export async function validateMemoryGraph({ root = null, checkpoint, run = null, floors = [], floorMemories = [], entities = [], indexes = [], indexKeys = [], allowMissingIndexes = false, allowLegacySnapshot = false } = {}) {
  const chatId = root?.chatId ?? checkpoint?.chatId;
  const safeMemories = floorMemories.map(memory => validateFloorMemory(memory, { expectedChatId: chatId }));
  const safeEntities = entities.map(entity => validateEntityRecord(entity, { expectedChatId: chatId }));
  const entityIds = safeEntities.map(entity => entity.id);
  await validateFoundationGraph({ root, checkpoint, run, floors, indexes, indexKeys, entityIds, allowMissingIndexes, allowLegacySnapshot });
  if (checkpoint.producedRefs.floorMemories.length !== safeMemories.length || checkpoint.producedRefs.floorMemories.some((id, index) => id !== safeMemories[index]?.id)) fail('V3_MEMORY_GRAPH_MEMORY_LIST_INVALID');
  if (checkpoint.producedRefs.entities.length !== safeEntities.length || checkpoint.producedRefs.entities.some((id, index) => id !== safeEntities[index]?.id)) fail('V3_MEMORY_GRAPH_ENTITY_LIST_INVALID');
  const floorIds = new Set(floors.map(floor => floor.id));
  const entityIdSet = new Set(entityIds);
  const seenFloors = new Set();
  for (const memory of safeMemories) {
    const memoryFloor = floors.find(item => item.id === memory.floorId);
    if (!memoryFloor || memory.narrativeGeneration !== memoryFloor.narrativeGeneration || seenFloors.has(memory.floorId)) fail('V3_MEMORY_GRAPH_FLOOR_REF_INVALID');
    seenFloors.add(memory.floorId);
    for (const entityId of collectFloorMemoryEntityIds(memory)) if (!entityIdSet.has(entityId)) fail('V3_MEMORY_GRAPH_ENTITY_REF_INVALID');
    const floor = memoryFloor;
    const checkQuote = evidence => {
      let occurrence = 0, offset = -1;
      while ((offset = floor.content.canonicalContent.indexOf(evidence.quotedText, offset + 1)) !== -1) { occurrence += 1; if (occurrence === evidence.occurrence) return true; }
      return false;
    };
    const evidence = [...memory.summaryEvidenceRefs];
    for (const field of ['chronology', 'locations', 'participants', 'actions', 'observations', 'informationTransfers', 'privateCognition', 'commitments', 'eventFragments', 'openLoops', 'ambiguities', 'cseSignals']) memory[field].forEach(item => evidence.push(...(item.evidenceRefs ?? [])));
    if (evidence.some(item => !checkQuote(item))) fail('V3_MEMORY_GRAPH_EVIDENCE_INVALID');
    for (const anchor of memory.exactAnchors) {
      let occurrence = 0, offset = -1, found = false;
      while ((offset = floor.content.canonicalContent.indexOf(anchor.exactText, offset + 1)) !== -1) { occurrence += 1; if (occurrence === anchor.occurrence) { found = true; break; } }
      if (!found) fail('V3_MEMORY_GRAPH_ANCHOR_INVALID');
    }
  }
  for (const entity of safeEntities) {
    if (entity.firstSeenFloorId && !floorIds.has(entity.firstSeenFloorId)) fail('V3_MEMORY_GRAPH_ENTITY_FLOOR_INVALID');
    const firstFloor = entity.firstSeenFloorId ? floors.find(item => item.id === entity.firstSeenFloorId) : null;
    if (firstFloor && entity.narrativeGeneration !== firstFloor.narrativeGeneration) fail('V3_MEMORY_GRAPH_ENTITY_GENERATION_INVALID');
  }
  const activeCount = safeMemories.filter(memory => memory.recordStatus === 'active').length;
  const memoryReady = activeCount > 0;
  if (checkpoint.capabilities.memoryReady !== memoryReady || (root && root.capabilities.memoryReady !== memoryReady)) fail('V3_MEMORY_GRAPH_CAPABILITY_INVALID');
  return Object.freeze({ schemaValid: true, referencesValid: true, orderedReplayValid: true });
}

export async function entityIndexKey(value) {
  return `sha256:${await sha256(String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase())}`;
}

export const FLOOR_MEMORY_ARRAY_FIELDS = ARRAY_FIELDS;
