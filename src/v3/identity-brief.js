import { isUuid } from '../identity.js';

export const IDENTITY_FACT_KINDS = Object.freeze(['identity', 'occupation', 'relation']);
export const IDENTITY_FACT_LIMIT = 20;
const EVIDENCE_LIMIT = 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const fieldsOnly = (value, fields) => Object.keys(value).every(key => fields.includes(key));
const evidenceFields = ['source', 'kind', 'quotedText', 'floorId', 'sourceType', 'sourceSnapshotIndex', 'occurrence', 'evidenceMode', 'supports', 'sourceEntityId', 'locator', 'fingerprint'];

export function validateIdentityBriefSource(value) {
  const fail = () => { throw Object.assign(new TypeError('V3_ENTITY_INVALID:identityBriefSource'), { code: 'V3_ENTITY_INVALID', validationPath: 'identityBriefSource' }); };
  if (!object(value) || !fieldsOnly(value, ['sourceFloorId', 'origin', 'sourceDeltaId', 'facts'])
    || !isUuid(value.sourceFloorId) || !['extractor', 'cse'].includes(value.origin)
    || Object.hasOwn(value, 'sourceDeltaId') && (value.origin !== 'cse' || !isUuid(value.sourceDeltaId))
    || !Array.isArray(value.facts) || !value.facts.length || value.facts.length > IDENTITY_FACT_LIMIT) fail();
  let count = 0;
  for (const fact of value.facts) {
    if (!object(fact) || !fieldsOnly(fact, ['kind', 'text', 'evidence']) || !IDENTITY_FACT_KINDS.includes(fact.kind)
      || !nonempty(fact.text, 400) || !Array.isArray(fact.evidence) || !fact.evidence.length) fail();
    count += fact.evidence.length;
    for (const ref of fact.evidence) {
      if (!object(ref) || !fieldsOnly(ref, evidenceFields) || !nonempty(ref.source, 160) || !isUuid(ref.floorId)
        || !['story', 'userInput', 'authorialSetting', 'authorialReference'].includes(ref.kind) || !nonempty(ref.quotedText, 2000)) fail();
      if (Object.hasOwn(ref, 'sourceType') && !['assistant', 'precedingUser'].includes(ref.sourceType)) fail();
      if (Object.hasOwn(ref, 'sourceSnapshotIndex') && (ref.sourceType !== 'precedingUser' || !Number.isSafeInteger(ref.sourceSnapshotIndex) || ref.sourceSnapshotIndex < 0)) fail();
      if (ref.sourceType === 'precedingUser' && !Number.isSafeInteger(ref.sourceSnapshotIndex)) fail();
      if (Object.hasOwn(ref, 'occurrence') && (!Number.isSafeInteger(ref.occurrence) || ref.occurrence < 1)) fail();
      if (Object.hasOwn(ref, 'evidenceMode') && !['explicit', 'witnessed', 'reported', 'privateCognition', 'interpretation'].includes(ref.evidenceMode)) fail();
      if (Object.hasOwn(ref, 'sourceEntityId') && ref.sourceEntityId !== null && !isUuid(ref.sourceEntityId)) fail();
      for (const [key, max] of [['supports', 2000], ['locator', 2000], ['fingerprint', 200]]) if (Object.hasOwn(ref, key) && !nonempty(ref[key], max)) fail();
    }
  }
  if (count > EVIDENCE_LIMIT || identityFactsText(value.facts).length > 400) fail();
  return value;
}

export function identityFactsText(facts) {
  return facts.map(fact => fact.text).join('；');
}

export function identityFactsForPrompt(source, targetKey) {
  return (source?.facts ?? []).map((fact, index) => ({ existingKey: `${targetKey}-identity-${index + 1}`, kind: fact.kind, text: fact.text }));
}

export function identityFactBindings(source, targetKey) {
  return Object.fromEntries(identityFactsForPrompt(source, targetKey).map((fact, index) => [fact.existingKey, source.facts[index]]));
}

// A replacement is atomic: dropping one bad fact must not silently erase a retained identity.
export function compileIdentityFacts({ raw, existingFacts = {}, compileEvidence, legacyEvidence = null }) {
  let submitted;
  if (Object.hasOwn(raw ?? {}, 'identityFacts')) submitted = raw.identityFacts;
  else if (nonempty(raw?.identityBrief, 400)) submitted = [{ kind: 'identity', text: raw.identityBrief, evidence: legacyEvidence }];
  else return null;
  if (!Array.isArray(submitted) || submitted.length > IDENTITY_FACT_LIMIT) throw new TypeError('identityFacts');
  if (!submitted.length) return null;
  const facts = [], seen = new Set();
  let count = 0;
  for (const item of submitted) {
    if (!object(item)) throw new TypeError('identityFacts');
    let fact;
    if (Object.hasOwn(item, 'existingKey')) {
      if (!fieldsOnly(item, ['existingKey'])) throw new TypeError('identityFacts.existingKey');
      fact = typeof item.existingKey === 'string' && Object.hasOwn(existingFacts, item.existingKey) ? existingFacts[item.existingKey] : null;
      if (!fact) throw new TypeError('identityFacts.existingKey');
    } else {
      if (!IDENTITY_FACT_KINDS.includes(item.kind) || !nonempty(item.text, 400)) throw new TypeError('identityFacts.text');
      const evidence = compileEvidence(item.evidence);
      if (!evidence.length) throw new TypeError('identityFacts.evidence');
      fact = { kind: item.kind, text: item.text.trim(), evidence };
    }
    const key = JSON.stringify(fact);
    if (seen.has(key)) continue;
    seen.add(key); facts.push(fact); count += fact.evidence.length;
    if (count > EVIDENCE_LIMIT || identityFactsText(facts).length > 400) throw new TypeError('identityFacts.limit');
  }
  return Object.freeze(facts.map(fact => Object.freeze({ ...fact, evidence: Object.freeze([...fact.evidence]) })));
}

export function sameIdentityFacts(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function identityBriefFields(entry) {
  if (!entry?.identityBrief) return {};
  return { identityBrief: entry.identityBrief, identityBriefSource: entry.identityBriefSource };
}

export function identityBriefSourceForRecord(entity) {
  return entity.identityBriefSource ? { ...entity.identityBriefSource, entityRecordId: entity.id, legacy: false }
    : { entityRecordId: entity.id, sourceFloorId: entity.firstSeenFloorId ?? null, origin: 'legacy', legacy: true, facts: [] };
}
