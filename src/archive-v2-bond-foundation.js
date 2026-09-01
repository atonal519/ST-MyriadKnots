import { validateArchiveV2 } from './archive-v2.js';

export const ARCHIVE_V2_BOND_DRAFT_KIND = 'myriad-knots-bond-draft';
export const ARCHIVE_V2_BOND_STAGES = Object.freeze(['陌生', '相识', '熟悉', '暧昧', '热恋']);
export const ARCHIVE_V2_BOND_FIELD_KEYS = Object.freeze([
  'stage',
  'cView',
  'cEmotion',
  'cDesire',
  'cGoal',
  'cConcern',
  'cSecret',
  'uView',
  'uEmotion',
  'uPlan',
  'uBoundary',
  'uExpectation',
  'recentChanges',
]);

const FIELD_KEYS = new Set(ARCHIVE_V2_BOND_FIELD_KEYS);
const BOND_STAGES = new Set(ARCHIVE_V2_BOND_STAGES);
const AI_ROOT_KEYS = new Set(['people']);
const AI_PERSON_KEYS = new Set(['person', 'fields', 'nativeSignals']);
const AI_FIELD_KEYS = new Set(['field', 'text', 'evidence']);
const SOURCE_ORIGINS = new Set(['card', 'greeting', 'worldbook', 'native']);
const LIMITS = Object.freeze({
  peoplePerBatch: 4,
  fieldCharacters: 2000,
  totalFieldCharacters: 50000,
  evidencePerField: 20,
  nativeSignalsPerPerson: 40,
});

const FIELD_TARGETS = Object.freeze({
  stage: ['stage'],
  cView: ['cToU', 'view'],
  cEmotion: ['cToU', 'emotion'],
  cDesire: ['cToU', 'desire'],
  cGoal: ['cToU', 'goal'],
  cConcern: ['cToU', 'concern'],
  cSecret: ['cToU', 'secret'],
  uView: ['uToC', 'view'],
  uEmotion: ['uToC', 'emotion'],
  uPlan: ['uToC', 'plan'],
  uBoundary: ['uToC', 'boundary'],
  uExpectation: ['uToC', 'expectation'],
  recentChanges: ['recentChanges'],
});

export class ArchiveV2BondFoundationError extends Error {
  constructor(message, code = 'ARCHIVE_V2_BOND_INVALID') {
    super(message);
    this.name = 'ArchiveV2BondFoundationError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ArchiveV2BondFoundationError(message, code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail(`${label} 必须是对象`, 'ARCHIVE_V2_BOND_FORMAT');
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some(key => !expected.has(key))) {
    fail(`${label} 字段无效`, 'ARCHIVE_V2_BOND_FORMAT');
  }
}

function sourceRef(source) {
  return { kind: source.refKind ?? source.kind, locator: source.locator, fingerprint: source.fingerprint };
}

function uniqueRefs(refs) {
  const seen = new Set();
  return refs.filter(ref => {
    const key = `${ref.kind}\u0000${ref.locator}\u0000${ref.fingerprint}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeAiField(raw, personCode, sourceByCode) {
  try { exactKeys(raw, AI_FIELD_KEYS, 'AI field'); }
  catch { return null; }
  if (!FIELD_KEYS.has(raw.field)
    || typeof raw.text !== 'string'
    || !raw.text.trim()
    || raw.text.length > LIMITS.fieldCharacters
    || !Array.isArray(raw.evidence)
    || raw.evidence.length < 1
    || raw.evidence.length > LIMITS.evidencePerField) return null;
  const evidence = [];
  const seen = new Set();
  for (const code of raw.evidence) {
    const source = typeof code === 'string' ? sourceByCode.get(code) : null;
    if (!source || seen.has(code)) return null;
    if (!source.people.includes(personCode)) {
      fail('AI 引用了其他人物的来源', 'ARCHIVE_V2_BOND_SOURCE_MISMATCH');
    }
    seen.add(code);
    evidence.push(source);
  }
  const value = raw.text.trim();
  if (raw.field === 'stage' && !BOND_STAGES.has(value)) return null;
  return { field: raw.field, text: value, evidence };
}

function owned(text, evidence, field = '') {
  const sourceOwned = field !== 'stage' && evidence.some(source => SOURCE_ORIGINS.has(source.kind));
  return {
    value: text,
    origin: sourceOwned ? 'source' : 'ai',
    sourceRefs: uniqueRefs(evidence.map(sourceRef)),
    userProtected: false,
  };
}

function assignField(bond, field, value) {
  const target = FIELD_TARGETS[field];
  if (target.length === 1) bond[target[0]] = value;
  else bond[target[0]][target[1]] = value;
}

function fieldValue(bond, field) {
  const target = FIELD_TARGETS[field];
  return target.length === 1 ? bond[target[0]] : bond[target[0]]?.[target[1]];
}

export function splitArchiveV2BondPeople(people, size = LIMITS.peoplePerBatch) {
  if (!Array.isArray(people) || !Number.isSafeInteger(size) || size < 1 || size > LIMITS.peoplePerBatch) {
    fail('双丝网人物分批参数无效');
  }
  const output = [];
  for (let index = 0; index < people.length; index += size) output.push(people.slice(index, index + size));
  return output;
}

export function archiveV2BondBatchPrompt(batch) {
  if (!isPlainObject(batch) || !Array.isArray(batch.people) || !Array.isArray(batch.sources)) {
    fail('双丝网批次无效');
  }
  const people = batch.people.map(person => ({
    person: person.person,
    displayName: person.displayName,
    sources: person.sourceCodes,
    nativeSignalCandidates: person.nativeSignalCodes,
  }));
  const sources = batch.sources.map(source => source.kind === 'native' ? {
    source: source.code,
    kind: 'native-signal',
    people: source.people,
    label: source.signal.label,
    path: source.signal.path,
    value: source.signal.value,
  } : {
    source: source.code,
    kind: source.kind,
    people: source.people,
    content: source.content,
  });
  return JSON.stringify({ updatedThroughFloor: batch.updatedThroughFloor, people, sources });
}

export function createArchiveV2BondBatchDraft({ batch, output } = {}) {
  exactKeys(output, AI_ROOT_KEYS, 'AI root');
  if (!Array.isArray(output.people) || output.people.length !== batch.people.length) {
    fail('AI 人物数量无效', 'ARCHIVE_V2_BOND_PERSON_MISMATCH');
  }
  const planned = new Map(batch.people.map(person => [person.person, person]));
  const sourceByCode = new Map(batch.sources.map(source => [source.code, source]));
  const resultByCode = new Map();
  let totalCharacters = 0;

  for (const rawPerson of output.people) {
    exactKeys(rawPerson, AI_PERSON_KEYS, 'AI person');
    if (typeof rawPerson.person !== 'string'
      || !planned.has(rawPerson.person)
      || resultByCode.has(rawPerson.person)) {
      fail('AI 人物代号无效', 'ARCHIVE_V2_BOND_PERSON_MISMATCH');
    }
    if (!Array.isArray(rawPerson.fields) || !Array.isArray(rawPerson.nativeSignals)
      || rawPerson.nativeSignals.length > LIMITS.nativeSignalsPerPerson) {
      fail('AI 双丝网字段无效', 'ARCHIVE_V2_BOND_FORMAT');
    }
    const bond = {
      identityId: planned.get(rawPerson.person).identityId,
      nativeSignals: [],
      cToU: {},
      uToC: {},
      sourceRefs: [],
      updatedThroughFloor: batch.updatedThroughFloor,
    };
    const seenFields = new Set();
    for (const rawField of rawPerson.fields) {
      const field = safeAiField(rawField, rawPerson.person, sourceByCode);
      if (!field || seenFields.has(field.field)) continue;
      seenFields.add(field.field);
      totalCharacters += field.text.length;
      if (totalCharacters > LIMITS.totalFieldCharacters) {
        fail('AI 双丝网字段总长度超限', 'ARCHIVE_V2_BOND_FORMAT');
      }
      const value = owned(field.text, field.evidence, field.field);
      assignField(bond, field.field, value);
      bond.sourceRefs.push(...value.sourceRefs);
    }
    const seenSignals = new Set();
    for (const code of rawPerson.nativeSignals) {
      const source = typeof code === 'string' ? sourceByCode.get(code) : null;
      if (!source || source.kind !== 'native' || seenSignals.has(code)) {
        fail('AI 原生信号引用无效', 'ARCHIVE_V2_BOND_NATIVE_SIGNAL_INVALID');
      }
      if (!source.people.includes(rawPerson.person)) {
        fail('AI 引用了其他人物的原生信号', 'ARCHIVE_V2_BOND_SOURCE_MISMATCH');
      }
      seenSignals.add(code);
      const ref = sourceRef(source);
      bond.nativeSignals.push({
        label: source.signal.label,
        path: source.signal.path,
        value: source.signal.value,
        sourceRefs: [ref],
      });
      bond.sourceRefs.push(ref);
    }
    bond.sourceRefs = uniqueRefs(bond.sourceRefs);
    resultByCode.set(rawPerson.person, bond);
  }
  if (resultByCode.size !== batch.people.length) {
    fail('AI 人物覆盖不完整', 'ARCHIVE_V2_BOND_PERSON_MISMATCH');
  }
  return batch.people.map(person => resultByCode.get(person.person));
}

export function createArchiveV2BondDraft({ plan, batchDrafts } = {}) {
  if (!isPlainObject(plan)
    || !Number.isSafeInteger(plan.baseRevision)
    || plan.baseRevision < 1
    || !Array.isArray(plan.people)
    || !Array.isArray(batchDrafts)) fail('双丝网计划无效');
  const bonds = batchDrafts.flat();
  if (bonds.length !== plan.people.length) fail('双丝网草稿人物覆盖无效');
  const byId = new Map(bonds.map(bond => [bond.identityId, bond]));
  if (byId.size !== plan.people.length
    || plan.people.some(person => !byId.has(person.identityId))) {
    fail('双丝网草稿人物覆盖无效', 'ARCHIVE_V2_BOND_PERSON_MISMATCH');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: ARCHIVE_V2_BOND_DRAFT_KIND,
    chatId: plan.chatId,
    baseRevision: plan.baseRevision,
    updatedThroughFloor: plan.updatedThroughFloor,
    people: Object.freeze(plan.people.map(person => Object.freeze({
      person: person.person,
      identityId: person.identityId,
      displayName: person.displayName,
      bond: Object.freeze(byId.get(person.identityId)),
    }))),
  });
}

export function mergeArchiveV2BondDraftEdits({ draft, edits = {} } = {}) {
  if (draft?.kind !== ARCHIVE_V2_BOND_DRAFT_KIND || !Array.isArray(draft.people) || !isPlainObject(edits)) {
    fail('双丝网草稿或修改无效');
  }
  const clone = structuredClone(draft);
  const known = new Set(clone.people.map(person => person.identityId));
  for (const [identityId, personEdits] of Object.entries(edits)) {
    if (!known.has(identityId) || !isPlainObject(personEdits)) fail('双丝网修改人物无效');
    const person = clone.people.find(item => item.identityId === identityId);
    for (const [field, rawValue] of Object.entries(personEdits)) {
      if (!FIELD_KEYS.has(field) || typeof rawValue !== 'string' || rawValue.length > LIMITS.fieldCharacters) {
        fail('双丝网修改字段无效');
      }
      const text = rawValue.trim();
      const previous = fieldValue(person.bond, field);
      if (String(previous?.value ?? '') === text) continue;
      if (!text) {
        fail('双丝网字段不能保存为空；如不修改请保留原文', 'ARCHIVE_V2_BOND_FIELD_EMPTY');
      }
      if (field === 'stage' && !BOND_STAGES.has(text)) {
        fail('关系阶段必须从固定五阶段中选择', 'ARCHIVE_V2_BOND_STAGE_INVALID');
      }
      assignField(person.bond, field, {
        value: text,
        origin: 'user',
        sourceRefs: [],
        userProtected: true,
      });
    }
  }
  return Object.freeze(clone);
}

function mergeProtected(existing, incoming) {
  if (existing?.userProtected === true) return existing;
  return incoming ?? existing;
}

export function applyArchiveV2BondDraft({ archive, revision, draft } = {}) {
  if (!Number.isSafeInteger(revision) || revision < 1 || draft?.baseRevision !== revision) {
    fail('正式档案 revision 已变化', 'ARCHIVE_V2_BOND_CONFLICT');
  }
  const safeArchive = validateArchiveV2(archive, { expectedChatId: draft?.chatId });
  if (draft?.kind !== ARCHIVE_V2_BOND_DRAFT_KIND || !Array.isArray(draft.people)) {
    fail('双丝网草稿无效');
  }
  for (const personDraft of draft.people) {
    const person = safeArchive.people.byId[personDraft.identityId];
    if (!person || person.followed !== true) {
      fail('草稿关注人物已变化', 'ARCHIVE_V2_BOND_PERSON_MISMATCH');
    }
    const incoming = structuredClone(personDraft.bond);
    const existing = safeArchive.bonds[personDraft.identityId];
    if (existing) {
      for (const field of ARCHIVE_V2_BOND_FIELD_KEYS) {
        const previous = fieldValue(existing, field);
        const next = fieldValue(incoming, field);
        const merged = mergeProtected(previous, next);
        if (merged) assignField(incoming, field, merged);
      }
    }
    safeArchive.bonds[personDraft.identityId] = incoming;
  }
  return validateArchiveV2(safeArchive, { expectedChatId: draft.chatId });
}
