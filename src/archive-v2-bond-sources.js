import { splitArchiveV2BondPeople } from './archive-v2-bond-foundation.js';
import { validateArchiveV2 } from './archive-v2.js';
import { selectArchiveV2MemoryAssistantContent } from './archive-v2-memory-foundation.js';
import { validateArchiveV2MemoryPeopleResult } from './archive-v2-memory-people-foundation.js';
import { sha256 } from './identity.js';

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const MEMORY_LOCATOR = /^memory-batch:(0|[1-9][0-9]*)$/;
const ROUTE_KINDS = new Set(['card', 'greeting', 'worldbook']);
const LIMITS = Object.freeze({
  people: 100,
  sources: 300,
  sourceCharacters: 40000,
  totalSourceCharacters: 300000,
  personaCharacters: 20000,
  nativeDepth: 7,
  nativeLeaves: 120,
  nativeStringCharacters: 1200,
  nativePathCharacters: 1000,
  nativeArrayItems: 80,
  nativeNodes: 800,
});

const NATIVE_OWNER_KEYS = new Set([
  '姓名', '名字', '名称', '角色', '角色名', 'npc', 'npc名', 'name', 'displayname', 'alias', 'aliases', '别名', '称呼',
]);

export class ArchiveV2BondSourceError extends Error {
  constructor(message, code = 'ARCHIVE_V2_BOND_SOURCE_INVALID') {
    super(message);
    this.name = 'ArchiveV2BondSourceError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ArchiveV2BondSourceError(message, code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-Hans-CN');
}

function selectedAssistantMessage(message) {
  if (!message || typeof message !== 'object' || message.is_user !== false) return null;
  const selected = selectArchiveV2MemoryAssistantContent(message);
  if (!selected.ok || !selected.content.trim()) return null;
  return message;
}

export function stableArchiveV2BondBoundary(chat) {
  if (!Array.isArray(chat)) fail('当前聊天正文不可用');
  const valid = [];
  for (let floor = 0; floor < chat.length; floor += 1) {
    if (selectedAssistantMessage(chat[floor])) valid.push({ floor, message: chat[floor] });
  }
  const latest = valid.at(-1) ?? null;
  const stable = valid.at(-2) ?? null;
  return Object.freeze({
    latestFloor: latest?.floor ?? null,
    stableFloor: stable?.floor ?? null,
    stableMessage: stable?.message ?? null,
    validAiFloors: Object.freeze(valid.map(item => item.floor)),
  });
}

function safeScalar(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, LIMITS.nativeStringCharacters);
  return undefined;
}

function pathPart(path, key, isIndex = false) {
  if (isIndex) return `${path}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function dataEntries(value, limit) {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.keys(descriptors)
      .filter(key => key !== 'length' && descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'))
      .slice(0, limit)
      .map(key => [key, descriptors[key].value]);
  } catch {
    return [];
  }
}

function ownerNamesFromEntries(entries) {
  const names = [];
  for (const [key, value] of entries) {
    if (!NATIVE_OWNER_KEYS.has(normalized(key))) continue;
    if (typeof value === 'string' && value.trim()) names.push(value.trim());
    if (Array.isArray(value)) {
      for (const [, item] of dataEntries(value, LIMITS.nativeArrayItems)) {
        if (typeof item === 'string' && item.trim()) names.push(item.trim());
      }
    }
  }
  return [...new Set(names)];
}

function appendPending(pending, state, item) {
  if (state.scheduled >= LIMITS.nativeNodes) return false;
  pending.push(item);
  state.scheduled += 1;
  return true;
}

export async function extractArchiveV2NativeSignalCandidates(message, floor) {
  if (!selectedAssistantMessage(message) || !Number.isSafeInteger(floor) || floor < 0) return [];
  if (!Array.isArray(message.variables)) return [];
  const pending = [];
  const traversal = { scheduled: 0, visited: 0 };
  for (let index = 0; index < message.variables.length; index += 1) {
    const variable = message.variables[index];
    const descriptor = isPlainObject(variable) ? Object.getOwnPropertyDescriptor(variable, 'stat_data') : null;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
    if (!appendPending(pending, traversal, {
      value: descriptor.value,
      path: `variables[${index}].stat_data`,
      pathSegments: [],
      ownerNames: [],
      depth: 0,
    })) break;
  }
  const leaves = [];
  let cursor = 0;
  while (cursor < pending.length && leaves.length < LIMITS.nativeLeaves && traversal.visited < LIMITS.nativeNodes) {
    const current = pending[cursor];
    cursor += 1;
    traversal.visited += 1;
    const scalar = safeScalar(current.value);
    if (scalar !== undefined) {
      if (current.path.length <= LIMITS.nativePathCharacters) leaves.push({
        path: current.path,
        pathSegments: current.pathSegments,
        ownerNames: current.ownerNames,
        value: scalar,
      });
      continue;
    }
    if (current.depth >= LIMITS.nativeDepth) continue;
    if (Array.isArray(current.value)) {
      for (const [key, value] of dataEntries(current.value, LIMITS.nativeArrayItems)) {
        if (!/^(0|[1-9]\d*)$/.test(key)) continue;
        if (!appendPending(pending, traversal, {
          value,
          path: pathPart(current.path, Number(key), true),
          pathSegments: current.pathSegments,
          ownerNames: current.ownerNames,
          depth: current.depth + 1,
        })) break;
      }
      continue;
    }
    if (!isPlainObject(current.value)) continue;
    const entries = dataEntries(current.value, LIMITS.nativeArrayItems);
    const ownerNames = [...new Set([...current.ownerNames, ...ownerNamesFromEntries(entries)])];
    for (const [key, value] of entries) {
      if (!appendPending(pending, traversal, {
        value,
        path: pathPart(current.path, key),
        pathSegments: [...current.pathSegments, key],
        ownerNames,
        depth: current.depth + 1,
      })) break;
    }
  }
  return Promise.all(leaves.map(async (leaf, index) => {
    const labelPart = leaf.path.match(/(?:\.([^.[\]]+)|\["([^"]+)"\]|\[(\d+)\])$/u);
    const label = (labelPart?.[1] ?? labelPart?.[2] ?? labelPart?.[3] ?? leaf.path).slice(0, 240);
    return Object.freeze({
      code: `N${index + 1}`,
      label,
      path: leaf.path,
      pathSegments: Object.freeze([...leaf.pathSegments]),
      ownerNames: Object.freeze([...leaf.ownerNames]),
      value: leaf.value,
      floor,
      fingerprint: `sha256:${await sha256(JSON.stringify(['native-signal-v1', floor, leaf.path, leaf.value]))}`,
    });
  }));
}

function archiveBatchIndexes(person) {
  if (!Array.isArray(person?.sourceRefs)) fail('正式人物缺少 memory 来源');
  const indexes = [];
  for (const ref of person.sourceRefs) {
    const match = typeof ref?.locator === 'string' && ref.kind === 'chat' ? ref.locator.match(MEMORY_LOCATOR) : null;
    if (!match) continue;
    indexes.push(Number(match[1]));
  }
  return [...new Set(indexes)].sort((left, right) => left - right);
}

function resultBatchIndexes(person) {
  return [...new Set(person.sourcePeopleRefs.map(ref => ref.batchIndex))].sort((left, right) => left - right);
}

function sameNumbers(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function followedPeople(archive, peopleResult) {
  const ordered = archive.people.order.map(identityId => archive.people.byId[identityId]);
  const followed = ordered.filter(person => person?.followed === true);
  if (followed.length > LIMITS.people) fail('关注人物超过安全上限', 'ARCHIVE_V2_BOND_SOURCE_LIMIT');
  const used = new Set();
  return followed.map((person, index) => {
    const displayName = typeof person.displayName?.value === 'string' ? person.displayName.value.trim() : '';
    if (!displayName) fail('关注人物姓名无效');
    const batches = archiveBatchIndexes(person);
    const orderIndex = archive.people.order.indexOf(person.identityId);
    const orderedCandidate = archive.people.order.length === peopleResult.people.length
      ? peopleResult.people[orderIndex]
      : null;
    let matched = orderedCandidate
      && !used.has(orderedCandidate.localId)
      && sameNumbers(resultBatchIndexes(orderedCandidate), batches)
      ? orderedCandidate
      : null;
    if (!matched) {
      const archiveNames = [displayName, ...(Array.isArray(person.aliases?.value) ? person.aliases.value : [])]
        .map(normalized)
        .filter(Boolean);
      const matches = peopleResult.people.filter(candidate => {
        if (used.has(candidate.localId) || !sameNumbers(resultBatchIndexes(candidate), batches)) return false;
        const candidateNames = [candidate.displayName, ...(candidate.aliases ?? [])].map(normalized);
        return archiveNames.some(name => candidateNames.includes(name));
      });
      if (matches.length === 1) [matched] = matches;
    }
    if (!matched) fail('关注人物无法唯一对应 memory 人物', 'ARCHIVE_V2_BOND_PERSON_MISMATCH');
    used.add(matched.localId);
    const matchNames = [...new Set([
      displayName,
      ...(Array.isArray(person.aliases?.value) ? person.aliases.value : []),
      matched.displayName,
      ...(matched.aliases ?? []),
    ].map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean))];
    return {
      person: `P${index + 1}`,
      identityId: person.identityId,
      displayName,
      matchNames,
      profile: person,
      memoryPerson: matched,
      sourceCodes: [],
      nativeSignalCodes: [],
    };
  });
}

function nativeOwnerRecords(archive, peopleResult) {
  const sameOrder = archive.people.order.length === peopleResult.people.length;
  return archive.people.order.map((identityId, index) => {
    const person = archive.people.byId[identityId];
    const memoryPerson = sameOrder ? peopleResult.people[index] : null;
    return {
      identityId,
      names: [
        person?.displayName?.value,
        ...(Array.isArray(person?.aliases?.value) ? person.aliases.value : []),
        memoryPerson?.displayName,
        ...(memoryPerson?.aliases ?? []),
      ].map(normalized).filter(Boolean),
    };
  });
}

function stableRow(row, stableFloor) {
  if (!isPlainObject(row) || !Array.isArray(row.sourceFloors) || stableFloor === null) return null;
  if (!row.sourceFloors.length
    || row.sourceFloors.some(floor => !Number.isSafeInteger(floor) || floor < 0 || floor > stableFloor)) return null;
  return row;
}

function memoryForPerson(batch, memoryPerson, userRefs, stableFloor) {
  const cIds = new Set(memoryPerson.sourcePeopleRefs
    .filter(ref => ref.batchIndex === batch.batchIndex)
    .map(ref => ref.localId));
  const uIds = new Set(userRefs.filter(ref => ref.batchIndex === batch.batchIndex).map(ref => ref.localId));
  if (!cIds.size && !uIds.size) return null;
  const stable = key => batch.rows[key].map(row => stableRow(row, stableFloor)).filter(Boolean);
  const facts = stable('facts').filter(row => cIds.has(row.subjectLocalId) || uIds.has(row.subjectLocalId));
  const relations = stable('relations').filter(row => cIds.has(row.subjectLocalId)
    || (row.objectKind === 'person' && cIds.has(row.objectLocalId))
    || (row.objectKind === 'user' && cIds.has(row.subjectLocalId)));
  const events = stable('events').filter(row => row.participantLocalIds?.some(localId => cIds.has(localId)));
  const contextualIds = new Set([...cIds, ...uIds]);
  for (const row of relations) {
    contextualIds.add(row.subjectLocalId);
    if (row.objectKind === 'person') contextualIds.add(row.objectLocalId);
  }
  for (const row of events) for (const localId of row.participantLocalIds ?? []) contextualIds.add(localId);
  const people = stable('people').filter(row => contextualIds.has(row.localId));
  if (![people, facts, relations, events].some(rows => rows.length)) return null;
  return {
    batchIndex: batch.batchIndex,
    cSourcePeopleRefs: memoryPerson.sourcePeopleRefs.filter(ref => ref.batchIndex === batch.batchIndex),
    userSourcePeopleRefs: userRefs.filter(ref => ref.batchIndex === batch.batchIndex),
    people,
    facts,
    relations,
    events,
  };
}

function profileContent(person) {
  const fields = {};
  for (const [key, value] of Object.entries(person.profile.fields ?? {})) {
    if (typeof value?.value === 'string' && value.value.trim()) fields[key] = value.value.trim();
  }
  return JSON.stringify({ displayName: person.displayName, fields });
}

function currentPersonaDescription(raw) {
  const candidates = [
    raw?.powerUserSettings?.persona_description,
    raw?.personaDescription,
    raw?.persona?.description,
  ];
  const value = candidates.find(candidate => typeof candidate === 'string') ?? '';
  return value.trim().slice(0, LIMITS.personaCharacters);
}

function safeRouteSources(routeSources, people) {
  if (!Array.isArray(routeSources)) return [];
  const output = [];
  const seen = new Set();
  const ownersByName = new Map();
  for (const person of people) {
    for (const name of person.matchNames ?? [person.displayName]) {
      const key = normalized(name);
      if (!key) continue;
      const owners = ownersByName.get(key) ?? new Set();
      owners.add(person.identityId);
      ownersByName.set(key, owners);
    }
  }
  for (const source of routeSources) {
    if (!isPlainObject(source)
      || !ROUTE_KINDS.has(source.kind)
      || source.selected !== true
      || source.availability === 'disabled'
      || typeof source.locator !== 'string'
      || !source.locator
      || !FINGERPRINT.test(source.fingerprint)
      || typeof source.content !== 'string'
      || !source.content.trim()) continue;
    let assigned = people.map(person => person.identityId);
    if (source.kind === 'worldbook' && source.availability !== 'activated') {
      const content = normalized(source.content);
      assigned = people.filter(person => (person.matchNames ?? [person.displayName]).some(name => {
        const key = normalized(name);
        return key && ownersByName.get(key)?.size === 1 && content.includes(key);
      })).map(person => person.identityId);
      if (!assigned.length) continue;
    }
    const key = `${source.kind}\u0000${source.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      kind: source.kind,
      locator: source.locator,
      fingerprint: source.fingerprint,
      content: source.content.trim(),
      people: assigned,
    });
  }
  return output;
}

function sourcePrefix(kind) {
  return { memory: 'M', profile: 'F', persona: 'U', card: 'C', greeting: 'G', worldbook: 'W', native: 'N' }[kind];
}

export async function createArchiveV2BondSourcePlan({
  raw,
  archive,
  revision,
  manifest,
  batches,
  peopleResult,
  routeSources = [],
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
  const boundary = stableArchiveV2BondBoundary(raw?.chat);
  const people = followedPeople(safeArchive, safePeopleResult);
  const nativeOwners = nativeOwnerRecords(safeArchive, safePeopleResult);
  const sources = [];
  const counters = {};
  let totalCharacters = 0;
  const addSource = source => {
    const characters = typeof source.content === 'string' ? source.content.length : 0;
    if (sources.length >= LIMITS.sources
      || characters > LIMITS.sourceCharacters
      || totalCharacters + characters > LIMITS.totalSourceCharacters) {
      fail('双丝网来源超过安全上限', 'ARCHIVE_V2_BOND_SOURCE_LIMIT');
    }
    totalCharacters += characters;
    const prefix = sourcePrefix(source.kind);
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    const prepared = { ...source, code: source.kind === 'native' ? source.signal.code : `${prefix}${counters[prefix]}` };
    sources.push(prepared);
    for (const person of people) {
      if (!prepared.people.includes(person.identityId)) continue;
      person.sourceCodes.push(prepared.code);
      if (prepared.kind === 'native') person.nativeSignalCodes.push(prepared.code);
    }
  };

  for (const person of people) {
    for (const batchIndex of resultBatchIndexes(person.memoryPerson)) {
      const batch = batches[batchIndex];
      if (!batch || batch.batchIndex !== batchIndex) fail('人物 memory batch 不存在');
      const content = memoryForPerson(
        batch,
        person.memoryPerson,
        safePeopleResult.userSourcePeopleRefs,
        boundary.stableFloor,
      );
      if (!content) continue;
      addSource({
        kind: 'memory',
        refKind: 'chat',
        locator: `memory-batch:${batchIndex}`,
        fingerprint: batch.sourceFingerprint,
        content: JSON.stringify(content),
        people: [person.identityId],
      });
    }
    const content = profileContent(person);
    addSource({
      kind: 'profile',
      locator: `archive-profile:${person.identityId}`,
      fingerprint: `sha256:${await sha256(content)}`,
      content,
      people: [person.identityId],
    });
  }

  const persona = currentPersonaDescription(raw);
  if (persona) addSource({
    kind: 'persona',
    locator: `persona:${safeArchive.identity.personaLocator}`,
    fingerprint: `sha256:${await sha256(persona)}`,
    content: persona,
    people: people.map(person => person.identityId),
  });

  for (const source of safeRouteSources(routeSources, people)) addSource(source);

  const nativeSignals = boundary.stableMessage
    ? await extractArchiveV2NativeSignalCandidates(boundary.stableMessage, boundary.stableFloor)
    : [];
  for (const signal of nativeSignals) {
    const pathNames = new Set(signal.pathSegments.map(normalized).filter(Boolean));
    const ownerNames = new Set(signal.ownerNames.map(normalized).filter(Boolean));
    const matchedOwners = nativeOwners.filter(owner => {
      return owner.names.some(name => pathNames.has(name) || ownerNames.has(name));
    });
    const assigned = matchedOwners.length === 1
      ? people.filter(person => person.identityId === matchedOwners[0].identityId)
      : (people.length === 1 && matchedOwners.length === 0 && ownerNames.size === 0 ? people : []);
    if (!assigned.length) continue;
    addSource({
      kind: 'native',
      locator: `message:${signal.floor}:${signal.path}`,
      fingerprint: signal.fingerprint,
      signal,
      people: assigned.map(person => person.identityId),
    });
  }

  return Object.freeze({
    chatId: safeArchive.chatId,
    baseRevision: revision,
    updatedThroughFloor: boundary.stableFloor,
    boundary,
    people: Object.freeze(people.map(({ profile: _profile, memoryPerson: _memoryPerson, ...person }) => Object.freeze({
      ...person,
      matchNames: Object.freeze([...person.matchNames]),
      sourceCodes: Object.freeze([...person.sourceCodes]),
      nativeSignalCodes: Object.freeze([...person.nativeSignalCodes]),
    }))),
    sources: Object.freeze(sources.map(source => Object.freeze({
      ...source,
      people: Object.freeze([...source.people]),
    }))),
  });
}

export function createArchiveV2BondBatches(plan) {
  if (!isPlainObject(plan) || !Array.isArray(plan.people) || !Array.isArray(plan.sources)) fail('双丝网计划无效');
  return splitArchiveV2BondPeople(plan.people).map(group => {
    const mapping = new Map(group.map((person, index) => [person.identityId, `P${index + 1}`]));
    const sources = plan.sources
      .filter(source => source.people.some(identityId => mapping.has(identityId)))
      .map(source => ({
        ...source,
        people: source.people.filter(identityId => mapping.has(identityId)).map(identityId => mapping.get(identityId)),
      }));
    const allowedCodes = new Set(sources.map(source => source.code));
    return Object.freeze({
      chatId: plan.chatId,
      baseRevision: plan.baseRevision,
      updatedThroughFloor: plan.updatedThroughFloor,
      people: Object.freeze(group.map(person => Object.freeze({
        ...person,
        person: mapping.get(person.identityId),
        sourceCodes: Object.freeze(person.sourceCodes.filter(code => allowedCodes.has(code))),
        nativeSignalCodes: Object.freeze(person.nativeSignalCodes.filter(code => allowedCodes.has(code))),
      }))),
      sources: Object.freeze(sources.map(source => Object.freeze(source))),
    });
  });
}
