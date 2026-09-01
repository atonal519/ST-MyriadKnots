import { validateArchiveV2 } from './archive-v2.js';
import { validateArchiveV2MemoryPeopleResult } from './archive-v2-memory-people-foundation.js';

export const ARCHIVE_V2_FOLLOWED_PROFILE_FIELD_KEYS = Object.freeze([
  'gender',
  'age',
  'appearance',
  'personality',
  'identity',
  'abilities',
  'likes',
  'dislikes',
  'principles',
  'relationships',
  'nsfwPreferences',
]);

export const ARCHIVE_V2_FOLLOWED_PROFILE_DRAFT_KIND = 'myriad-knots-followed-profile-draft';

const FIELD_KEYS = new Set(ARCHIVE_V2_FOLLOWED_PROFILE_FIELD_KEYS);
const SOURCE_KINDS = new Set(['chat', 'card', 'greeting', 'worldbook']);
const AI_ROOT_KEYS = new Set(['people']);
const AI_PERSON_KEYS = new Set(['person', 'fields']);
const AI_FIELD_KEYS = new Set(['field', 'text', 'evidence']);
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const MEMORY_LOCATOR = /^memory-batch:(0|[1-9][0-9]*)$/;
const LIMITS = Object.freeze({
  fieldCharacters: 1200,
  totalFieldCharacters: 100000,
  sources: 200,
  sourceCharacters: 40000,
  totalSourceCharacters: 300000,
  evidence: 24,
});

export class ArchiveV2FollowedProfileFoundationError extends Error {
  constructor(message, code = 'ARCHIVE_V2_FOLLOWED_PROFILE_INVALID') {
    super(message);
    this.name = 'ArchiveV2FollowedProfileFoundationError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ArchiveV2FollowedProfileFoundationError(message, code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail(`${label} 必须是对象`);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some(key => !expected.has(key))) {
    fail(`${label} 字段无效`, 'ARCHIVE_V2_FOLLOWED_PROFILE_FORMAT');
  }
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-Hans-CN');
}

function sourceRef(source) {
  return { kind: source.kind, locator: source.locator, fingerprint: source.fingerprint };
}

function sameNumbers(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function archiveBatchIndexes(person) {
  if (!Array.isArray(person?.sourceRefs)) fail('正式人物缺少 memory 来源');
  const indexes = [];
  for (const ref of person.sourceRefs) {
    const match = typeof ref?.locator === 'string' && ref.kind === 'chat'
      ? ref.locator.match(MEMORY_LOCATOR)
      : null;
    if (!match) fail('正式人物 memory 来源无效');
    indexes.push(Number(match[1]));
  }
  return [...new Set(indexes)].sort((a, b) => a - b);
}

function resultBatchIndexes(person) {
  return [...new Set(person.sourcePeopleRefs.map(ref => ref.batchIndex))].sort((a, b) => a - b);
}

function matchFollowedPeople(archive, peopleResult) {
  const followed = archive.people.order
    .map((identityId, archiveIndex) => ({ person: archive.people.byId[identityId], archiveIndex }))
    .filter(item => item.person.followed === true);
  const used = new Set();
  return followed.map(({ person, archiveIndex }, index) => {
    const displayName = typeof person.displayName?.value === 'string' ? person.displayName.value.trim() : '';
    if (!displayName) fail('关注人物姓名无效');
    const batches = archiveBatchIndexes(person);
    const stableCandidate = peopleResult.people[archiveIndex];
    const stableMatch = stableCandidate && !used.has(stableCandidate.localId)
      && sameNumbers(resultBatchIndexes(stableCandidate), batches) ? stableCandidate : null;
    const matches = peopleResult.people.filter(candidate => !used.has(candidate.localId)
      && normalized(candidate.displayName) === normalized(displayName)
      && sameNumbers(resultBatchIndexes(candidate), batches));
    const memoryPerson = stableMatch ?? (matches.length === 1 ? matches[0] : null);
    if (!memoryPerson) {
      fail('关注人物无法唯一对应 memory 人物', 'ARCHIVE_V2_FOLLOWED_PROFILE_PERSON_MISMATCH');
    }
    used.add(memoryPerson.localId);
    const matchNames = [...new Set([
      displayName,
      ...(Array.isArray(person.aliases) ? person.aliases : []),
      memoryPerson.displayName,
      ...(Array.isArray(memoryPerson.aliases) ? memoryPerson.aliases : []),
    ].map(value => String(value ?? '').trim()).filter(Boolean))];
    return {
      person: `P${index + 1}`,
      identityId: person.identityId,
      displayName,
      memoryPerson,
      matchNames,
    };
  });
}

function relevantMemoryRows(batch, memoryPerson) {
  const ref = memoryPerson.sourcePeopleRefs.find(item => item.batchIndex === batch.batchIndex);
  if (!ref || !batch.rows.people.some(row => row.localId === ref.localId)) return null;
  const confirmedLocalId = ref.localId;
  const relations = batch.rows.relations.filter(row => row.subjectLocalId === confirmedLocalId
    || (row.objectKind === 'person' && row.objectLocalId === confirmedLocalId));
  const events = batch.rows.events.filter(row => row.participantLocalIds.includes(confirmedLocalId));
  const contextualLocalIds = new Set([confirmedLocalId]);
  for (const row of relations) {
    contextualLocalIds.add(row.subjectLocalId);
    if (row.objectKind === 'person') contextualLocalIds.add(row.objectLocalId);
  }
  for (const row of events) for (const localId of row.participantLocalIds) contextualLocalIds.add(localId);
  return {
    batchIndex: batch.batchIndex,
    people: batch.rows.people.filter(row => contextualLocalIds.has(row.localId)),
    facts: batch.rows.facts.filter(row => row.subjectLocalId === confirmedLocalId),
    relations,
    events,
  };
}

function safeRouteSources(sources, people) {
  if (!Array.isArray(sources)) fail('当前角色来源无效');
  const output = [];
  const seen = new Set();
  for (const candidate of sources) {
    if (!isPlainObject(candidate)
      || !SOURCE_KINDS.has(candidate.kind)
      || candidate.kind === 'chat'
      || candidate.selected !== true
      || candidate.availability === 'disabled'
      || typeof candidate.locator !== 'string'
      || !candidate.locator
      || !FINGERPRINT.test(candidate.fingerprint)
      || typeof candidate.content !== 'string'
      || !candidate.content.trim()) continue;
    let assignedPeople = people.map(person => person.person);
    if (candidate.kind === 'worldbook' && candidate.availability !== 'activated') {
      const content = normalized(candidate.content);
      assignedPeople = people
        .filter(person => person.matchNames.some(name => content.includes(normalized(name))))
        .map(person => person.person);
      if (assignedPeople.length !== 1) continue;
    }
    const key = `${candidate.kind}\u0000${candidate.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      kind: candidate.kind,
      locator: candidate.locator,
      fingerprint: candidate.fingerprint,
      content: candidate.content.trim(),
      people: assignedPeople,
    });
  }
  return output;
}

function assignSourceCode(source, counters) {
  const prefix = { chat: 'M', card: 'C', greeting: 'G', worldbook: 'W' }[source.kind];
  counters[prefix] = (counters[prefix] ?? 0) + 1;
  return `${prefix}${counters[prefix]}`;
}

export function createArchiveV2FollowedProfilePlan({
  archive,
  revision,
  manifest,
  batches,
  peopleResult,
  sources,
} = {}) {
  if (!Number.isSafeInteger(revision) || revision < 1) fail('正式档案 revision 无效');
  let safeArchive;
  let safePeopleResult;
  try {
    safeArchive = validateArchiveV2(archive);
    safePeopleResult = validateArchiveV2MemoryPeopleResult(peopleResult, {
      manifest,
      batches,
      expectedChatId: safeArchive.chatId,
    });
  } catch {
    fail('正式档案或 memory 人物结果无效');
  }
  if (!Array.isArray(batches)) fail('memory batches 无效');
  const people = matchFollowedPeople(safeArchive, safePeopleResult);
  const counters = {};
  const preparedSources = [];
  let totalSourceCharacters = 0;
  const addSource = source => {
    if (preparedSources.length >= LIMITS.sources
      || source.content.length > LIMITS.sourceCharacters
      || totalSourceCharacters + source.content.length > LIMITS.totalSourceCharacters) {
      fail('基础人设来源超过安全上限', 'ARCHIVE_V2_FOLLOWED_PROFILE_SOURCE_LIMIT');
    }
    totalSourceCharacters += source.content.length;
    const prepared = { ...source, code: assignSourceCode(source, counters) };
    preparedSources.push(prepared);
    return prepared.code;
  };

  for (const person of people) {
    person.sourceCodes = [];
    for (const batchIndex of resultBatchIndexes(person.memoryPerson)) {
      const batch = batches[batchIndex];
      if (!batch || batch.batchIndex !== batchIndex) fail('人物 memory batch 不存在');
      const rows = relevantMemoryRows(batch, person.memoryPerson);
      if (!rows) continue;
      const content = JSON.stringify(rows);
      person.sourceCodes.push(addSource({
        kind: 'chat',
        locator: `memory-batch:${batchIndex}`,
        fingerprint: batch.sourceFingerprint,
        content,
        people: [person.person],
      }));
    }
  }

  for (const source of safeRouteSources(sources, people)) {
    const code = addSource(source);
    for (const person of people) if (source.people.includes(person.person)) person.sourceCodes.push(code);
  }

  return Object.freeze({
    chatId: safeArchive.chatId,
    baseRevision: revision,
    people: Object.freeze(people.map(({ memoryPerson: _memoryPerson, matchNames: _matchNames, ...person }) => Object.freeze({
      ...person,
      sourceCodes: Object.freeze([...person.sourceCodes]),
    }))),
    sources: Object.freeze(preparedSources.map(source => Object.freeze({
      ...source,
      people: Object.freeze([...source.people]),
    }))),
  });
}

export function archiveV2FollowedProfilePrompt(plan) {
  const people = plan.people.map(person => ({
    person: person.person,
    displayName: person.displayName,
    sources: person.sourceCodes,
  }));
  const sources = plan.sources.map(source => ({
    source: source.code,
    kind: source.kind === 'chat' ? 'memory' : source.kind,
    people: source.people,
    content: source.content,
  }));
  return JSON.stringify({ people, sources });
}

function safeField(item, personCode, sourceByCode) {
  try { exactKeys(item, AI_FIELD_KEYS, 'AI field'); }
  catch { return null; }
  if (!FIELD_KEYS.has(item.field)
    || typeof item.text !== 'string'
    || !item.text.trim()
    || item.text.length > LIMITS.fieldCharacters
    || !Array.isArray(item.evidence)
    || item.evidence.length < 1
    || item.evidence.length > LIMITS.evidence) return null;
  const evidence = [];
  const seen = new Set();
  for (const code of item.evidence) {
    const source = typeof code === 'string' ? sourceByCode.get(code) : null;
    if (!source || seen.has(code)) return null;
    if (!source.people.includes(personCode)) {
      fail('AI 引用了未分配给当前人物的来源', 'ARCHIVE_V2_FOLLOWED_PROFILE_SOURCE_MISMATCH');
    }
    seen.add(code);
    evidence.push(code);
  }
  return { field: item.field, text: item.text.trim(), evidence };
}

export function createArchiveV2FollowedProfileDraft({ plan, output } = {}) {
  exactKeys(output, AI_ROOT_KEYS, 'AI root');
  if (!Array.isArray(output.people) || output.people.length !== plan.people.length) {
    fail('AI 人物数量无效', 'ARCHIVE_V2_FOLLOWED_PROFILE_FORMAT');
  }
  const planned = new Map(plan.people.map(person => [person.person, person]));
  const sourceByCode = new Map(plan.sources.map(source => [source.code, source]));
  const fieldsByPerson = new Map();
  let totalCharacters = 0;
  for (const item of output.people) {
    exactKeys(item, AI_PERSON_KEYS, 'AI person');
    if (typeof item.person !== 'string' || !planned.has(item.person) || fieldsByPerson.has(item.person)) {
      fail('AI 人物代号无效', 'ARCHIVE_V2_FOLLOWED_PROFILE_PERSON_MISMATCH');
    }
    if (!Array.isArray(item.fields)) fail('AI fields 无效', 'ARCHIVE_V2_FOLLOWED_PROFILE_FORMAT');
    const fields = {};
    for (const rawField of item.fields) {
      const field = safeField(rawField, item.person, sourceByCode);
      if (!field || Object.hasOwn(fields, field.field)) continue;
      totalCharacters += field.text.length;
      if (totalCharacters > LIMITS.totalFieldCharacters) {
        fail('AI 字段总长度超限', 'ARCHIVE_V2_FOLLOWED_PROFILE_FORMAT');
      }
      fields[field.field] = {
        value: field.text,
        origin: 'ai',
        sourceRefs: field.evidence.map(code => sourceRef(sourceByCode.get(code))),
        userProtected: false,
      };
    }
    fieldsByPerson.set(item.person, fields);
  }
  if (fieldsByPerson.size !== plan.people.length) {
    fail('AI 人物覆盖不完整', 'ARCHIVE_V2_FOLLOWED_PROFILE_PERSON_MISMATCH');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: ARCHIVE_V2_FOLLOWED_PROFILE_DRAFT_KIND,
    chatId: plan.chatId,
    baseRevision: plan.baseRevision,
    people: Object.freeze(plan.people.map(person => Object.freeze({
      person: person.person,
      identityId: person.identityId,
      displayName: person.displayName,
      fields: Object.freeze(fieldsByPerson.get(person.person)),
    }))),
  });
}

export function applyArchiveV2FollowedProfileDraft({ archive, revision, draft } = {}) {
  if (!Number.isSafeInteger(revision) || revision < 1 || draft?.baseRevision !== revision) {
    fail('正式档案 revision 已变化', 'ARCHIVE_V2_FOLLOWED_PROFILE_CONFLICT');
  }
  const safeArchive = validateArchiveV2(archive, { expectedChatId: draft?.chatId });
  if (draft?.kind !== ARCHIVE_V2_FOLLOWED_PROFILE_DRAFT_KIND || !Array.isArray(draft.people)) {
    fail('基础人设草稿无效');
  }
  let savedFieldCount = 0;
  let protectedFieldCount = 0;
  for (const personDraft of draft.people) {
    const person = safeArchive.people.byId[personDraft.identityId];
    if (!person || person.followed === false) {
      fail('草稿人物已变化', 'ARCHIVE_V2_FOLLOWED_PROFILE_PERSON_MISMATCH');
    }
    person.fields ??= {};
    for (const key of ARCHIVE_V2_FOLLOWED_PROFILE_FIELD_KEYS) {
      const incoming = personDraft.fields?.[key];
      if (!incoming) continue;
      if (person.fields[key]?.userProtected === true) {
        protectedFieldCount += 1;
        continue;
      }
      person.fields[key] = {
        value: incoming.value,
        origin: 'ai',
        sourceRefs: incoming.sourceRefs.map(ref => ({ ...ref })),
        userProtected: false,
      };
      savedFieldCount += 1;
    }
  }
  return {
    archive: validateArchiveV2(safeArchive, { expectedChatId: draft.chatId }),
    savedFieldCount,
    protectedFieldCount,
  };
}
