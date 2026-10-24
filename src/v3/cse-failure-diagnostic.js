import { sanitizeSensitiveText } from './safe-metadata.js';

const LABEL_LIMIT = 80;
const PERSON_LIMIT = 40;
const ALIAS_LIMIT = 8;
const ISOLATION_LIMIT = 32;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = value => typeof value === 'string' ? sanitizeSensitiveText(value.slice(0, LABEL_LIMIT)) : null;
const codes = new Set([
  'V3_CSE_SUBJECT_UNBOUND', 'V3_CSE_SUBJECT_DUPLICATE', 'V3_CSE_TOWARD_UNBOUND',
  'V3_CSE_OPTIONAL_ITEM_INVALID', 'V3_CSE_EVIDENCE_UNLOCATED', 'V3_CSE_EVIDENCE_SUBJECT_MISMATCH',
  'V3_CSE_IDENTITY_BRIEF_TARGET_UNBOUND', 'V3_CSE_IDENTITY_BRIEF_INVALID',
  'V3_CSE_IDENTITY_BRIEF_EVIDENCE_INSUFFICIENT', 'V3_CSE_IDENTITY_BRIEF_TARGET_AMBIGUOUS',
  'V3_CSE_CATEGORY_PROTOCOL_MIXED', 'V3_CSE_REVIEW_INVALID', 'V3_CSE_REVIEW_TARGET_AMBIGUOUS',
  'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT', 'V3_CSE_USER_HISTORY_CURRENT_CONFIRMATION_MISSING',
]);

function boundedList(value, maximum, project) {
  const items = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(items)) return { status: 'notRecorded' };
  const total = Math.max(items.length, count(value?.total) ?? 0);
  return { status: 'recorded', total, items: items.slice(0, maximum).map(project),
    truncated: value?.truncated === true || total > maximum };
}

function personDiagnostic(person) {
  const aliases = Array.isArray(person?.aliases) ? person.aliases : [];
  const aliasCount = Math.max(aliases.length, count(person?.aliasCount) ?? 0);
  return { name: label(person?.name), nameTruncated: person?.nameTruncated === true || (person?.name?.length ?? 0) > LABEL_LIMIT,
    aliases: aliases.slice(0, ALIAS_LIMIT).map(label), aliasCount,
    aliasesTruncated: person?.aliasesTruncated === true || aliasCount > ALIAS_LIMIT,
    aliasLabelsTruncated: person?.aliasLabelsTruncated === true || aliases.slice(0, ALIAS_LIMIT).some(value => typeof value === 'string' && value.length > LABEL_LIMIT) };
}

function isolationDiagnostic(item) {
  return {
    field: typeof item?.field === 'string' && /^(?:subjects|identityBriefUpdates|core|adaptive|situational)(?:\.(?:review|additions)|\.\d{1,3}\.evidence\.\d{1,3})?$/u.test(item.field) ? item.field : null,
    index: count(item?.index), subjectIndex: count(item?.subjectIndex),
    code: codes.has(item?.code) ? item.code : null,
    label: label(item?.label), labelTruncated: item?.labelTruncated === true || (item?.label?.length ?? 0) > LABEL_LIMIT,
    matchCount: count(item?.matchCount),
  };
}

// This is a failure-only copy of the actual request scope, never today's person directory.
// Reuse the same whitelist when persisting a hint and when copying it out of the UI.
export function projectCseSubjectDiagnostic(value) {
  if (!value || value.status === 'notRecorded') return { status: 'notRecorded' };
  const trackedSubjects = boundedList(value.trackedSubjects, PERSON_LIMIT, personDiagnostic);
  const knownPeople = boundedList(value.knownPeople, PERSON_LIMIT, personDiagnostic);
  const isolated = boundedList(value.isolated, ISOLATION_LIMIT, isolationDiagnostic);
  if ([trackedSubjects, knownPeople, isolated].every(list => list.status === 'notRecorded')) return { status: 'notRecorded' };
  return { status: 'recorded', trackedSubjects, knownPeople, isolated };
}
