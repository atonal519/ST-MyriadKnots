export const QIANSHI_SCHEMA_VERSION = 1;

const STATUSES = new Set(['planned', 'inProgress', 'completed', 'cancelled', 'occurred', 'unknown']);
const DELTA_STATUSES = new Set(['ready', 'empty', 'partial', 'pending']);
const clean = (value, maximum = 2000) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);

function fail(path = '') {
  const error = new TypeError(path ? `QIANSHI_DELTA_INVALID:${path}` : 'QIANSHI_DELTA_INVALID');
  error.code = 'QIANSHI_DELTA_INVALID';
  error.validationPath = path;
  throw error;
}

function exactKeys(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(path);
}

function exactKeysWithOptional(value, keys, optionalKeys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path);
  const allowed = new Set([...keys, ...optionalKeys]);
  if (keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) fail(path);
}

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

export function validateQianshiDelta(input, { floorId = null, floorIds = null } = {}) {
  const value = structuredClone(input);
  exactKeys(value, ['schemaVersion', 'status', 'reason', 'compiledAt', 'candidateStats', 'events', 'relations'], 'qianshiDelta');
  if (value.schemaVersion !== QIANSHI_SCHEMA_VERSION || !DELTA_STATUSES.has(value.status)) fail('qianshiDelta.status');
  if (value.reason !== null && (!clean(value.reason, 500) || value.reason.length > 500)) fail('qianshiDelta.reason');
  if (!Number.isFinite(Date.parse(value.compiledAt))) fail('qianshiDelta.compiledAt');
  exactKeys(value.candidateStats, ['count', 'characters'], 'qianshiDelta.candidateStats');
  if (!Number.isSafeInteger(value.candidateStats.count) || value.candidateStats.count < 0
    || !Number.isSafeInteger(value.candidateStats.characters) || value.candidateStats.characters < 0) fail('qianshiDelta.candidateStats');
  if (!Array.isArray(value.events) || !Array.isArray(value.relations) || value.events.length > 160 || value.relations.length > 320) fail('qianshiDelta');
  const eventIds = new Set();
  for (const [index, event] of value.events.entries()) {
    const path = `qianshiDelta.events[${index}]`;
    exactKeysWithOptional(event, ['id', 'matterId', 'updatesMatter', 'title', 'description', 'status', 'storyTime', 'scheduledTime', 'people', 'object', 'sourceFloorId', 'continuesFromEventIds'], ['important'], path);
    if (!uuid(event.id) || eventIds.has(event.id) || event.matterId !== null && !uuid(event.matterId) || typeof event.updatesMatter !== 'boolean') fail(`${path}.id`);
    if (Object.hasOwn(event, 'important') && typeof event.important !== 'boolean') fail(`${path}.important`);
    if (event.updatesMatter && event.matterId === null) fail(`${path}.updatesMatter`);
    eventIds.add(event.id);
    if (!clean(event.title, 500) || !clean(event.description, 4000) || !STATUSES.has(event.status)) fail(path);
    if (event.storyTime !== null && (!clean(event.storyTime, 500) || event.storyTime.length > 500)) fail(`${path}.storyTime`);
    if (event.scheduledTime !== null && (!clean(event.scheduledTime, 500) || event.scheduledTime.length > 500)) fail(`${path}.scheduledTime`);
    if (event.object !== null && (!clean(event.object, 1000) || event.object.length > 1000)) fail(`${path}.object`);
    if (!uuid(event.sourceFloorId) || (floorIds ? !floorIds.includes(event.sourceFloorId) : floorId && event.sourceFloorId !== floorId) || !Array.isArray(event.people) || event.people.length > 40 || !Array.isArray(event.continuesFromEventIds) || event.continuesFromEventIds.length > 40) fail(path);
    for (const [personIndex, person] of event.people.entries()) {
      exactKeys(person, ['entityId', 'name'], `${path}.people[${personIndex}]`);
      if (person.entityId !== null && !uuid(person.entityId) || !clean(person.name, 500)) fail(`${path}.people[${personIndex}]`);
    }
    if (event.continuesFromEventIds.some(id => !uuid(id))) fail(`${path}.continuesFromEventIds`);
  }
  const relationIds = new Set();
  for (const [index, relation] of value.relations.entries()) {
    const path = `qianshiDelta.relations[${index}]`;
    exactKeys(relation, ['id', 'type', 'fromEventId', 'toEventId', 'certainty'], path);
    if (!uuid(relation.id) || relationIds.has(relation.id) || !['progress', 'before'].includes(relation.type)
      || !uuid(relation.fromEventId) || !uuid(relation.toEventId) || relation.fromEventId === relation.toEventId
      || !['explicit', 'strong'].includes(relation.certainty)) fail(path);
    relationIds.add(relation.id);
  }
  if (value.status === 'empty' && value.events.length || value.status === 'ready' && !value.events.length
    || value.status === 'pending' && value.events.length || value.status === 'partial' && !value.events.length) fail('qianshiDelta.status');
  return Object.freeze(value);
}
