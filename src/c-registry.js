import { sha256 } from './identity.js';
import { newUuid, readHostState } from './host-context.js';
import { cleanAnalysisText } from './route-source.js';

export const REGISTRY_LIMITS = Object.freeze({ maxSources: 80, maxSourceChars: 24000, maxTotalChars: 120000, maxItems: 80, maxNameChars: 120, maxAnchorChars: 80, maxRefs: 12 });
export const REGISTRY_CONTRACT_VERSION = 3;
const INDEX = 'people-index', PROFILE = 'people-profile';
const SELECTIONS = ['selected', 'unselected'];
const IDENTITY_SNAPSHOT_KEYS = ['chatId', 'hostChatId', 'characterId', 'characterAvatar', 'personaId', 'personaAvatar', 'personaName', 'role'];
const C_REGISTRY_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['confirmed', 'candidate', 'discarded'],
  properties: {
    confirmed: { type: 'array', items: { $ref: '#/$defs/item' } },
    candidate: { type: 'array', items: { $ref: '#/$defs/item' } },
    discarded: { type: 'array', items: { $ref: '#/$defs/item' } },
  },
  $defs: {
    item: { type: 'object', additionalProperties: false, required: ['name', 'sourceAnchor', 'primarySourceRef', 'sourceRefs'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 }, sourceAnchor: { type: 'string', minLength: 1, maxLength: 80 },
      primarySourceRef: { $ref: '#/$defs/ref' }, sourceRefs: { type: 'array', minItems: 1, maxItems: 12, items: { $ref: '#/$defs/ref' } },
    } },
    ref: { type: 'object', additionalProperties: false, required: ['kind', 'locator'], properties: {
      kind: { type: 'string', enum: ['greeting', 'worldbook'] }, locator: { type: 'string', minLength: 1, maxLength: 300 },
    } },
  },
});
const fail = message => Object.assign(new Error(message), { failClosed: true });
const stale = () => Object.assign(new Error('C Registry 请求已失效'), { stale: true });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const normalizeName = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120;
const validSelection = value => object(value) && Object.keys(value).length === 1 && SELECTIONS.includes(value.status);
const selection = value => ({ status: validSelection(value) ? value.status : 'unselected' });
const refKey = value => `${value.kind}:${value.locator}`;
const ref = value => ({ kind: value.kind, locator: value.locator });
const validRef = value => object(value) && Object.keys(value).length === 2 && ['greeting', 'worldbook'].includes(value.kind) && typeof value.locator === 'string' && value.locator.length > 0 && value.locator.length <= 300;
const compatibleProfileRef = value => object(value) && ['greeting', 'worldbook'].includes(value.kind) && typeof value.locator === 'string' && value.locator.length > 0 && value.locator.length <= 300;
const futureProfile = record => envelope(record) && (Number.isInteger(record.data.schemaVersion) && record.data.schemaVersion > 1
  || Number.isInteger(record.data.peopleContractVersion) && record.data.peopleContractVersion > 1);
const readonlyProfile = () => ({ status: 'future_schema_readonly', readonly: true, recoverable: false });
const sourceKey = item => object(item) && typeof item.sourceAnchor === 'string' && validRef(item.primarySourceRef) ? `${refKey(item.primarySourceRef)}:${item.sourceAnchor.trim().toLocaleLowerCase()}` : null;
const envelope = record => object(record) && record.schemaVersion === 1 && Number.isInteger(record.revision) && record.revision > 0 && uuid(record.generationId) && typeof record.createdAt === 'string' && typeof record.updatedAt === 'string' && object(record.data);
const normalizeRefs = refs => [...new Map((Array.isArray(refs) ? refs : []).filter(validRef).map(item => [refKey(item), ref(item)])).values()].sort((a, b) => refKey(a).localeCompare(refKey(b)));
const sameRefs = (a, b) => JSON.stringify(normalizeRefs(a)) === JSON.stringify(normalizeRefs(b));
const bindingPrimary = item => item?.primarySourceRef ? refKey(item.primarySourceRef) : '';
const CATEGORY_ALIASES = Object.freeze({
  confirmed: ['confirmedPeople', 'confirmedCharacters', 'confirmed_people'],
  candidate: ['candidates', 'candidatePeople', 'candidateCharacters', 'candidate_people'],
  discarded: ['excluded', 'discardedPeople', 'discardedCharacters', 'discarded_people'],
});
const ITEM_ALIASES = Object.freeze({
  name: ['displayName'], sourceAnchor: ['anchor'], primarySourceRef: ['primarySource'], sourceRefs: ['refs'],
});
const NORMALIZATION_WARNING_LIMIT = 12;

const formatFailure = message => Object.assign(fail(message), { retryableRecognitionFormat: true });
const sameExternalValue = (left, right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
};
const warningCollector = () => {
  const counts = new Map();
  return {
    add(code, count = 1) { counts.set(code, Math.min(999, (counts.get(code) || 0) + count)); },
    list() { return [...counts].slice(0, NORMALIZATION_WARNING_LIMIT).map(([code, count]) => ({ code, count })); },
  };
};
const aliasedValue = (value, canonical, aliases, diagnostics) => {
  const keys = [canonical, ...aliases].filter(key => Object.prototype.hasOwnProperty.call(value, key));
  if (keys.length === 0) return { found: false, value: undefined };
  if (keys.length > 1 && keys.some(key => !sameExternalValue(value[key], value[keys[0]]))) return { ambiguous: true };
  if (keys[0] !== canonical || keys.length > 1) diagnostics.add('NORMALIZATION_ALIAS_USED');
  return { found: true, value: value[keys[0]] };
};

function normalizedTextMap(value) {
  const input = String(value ?? ''), clusters = [];
  for (let offset = 0; offset < input.length;) {
    const start = offset; let char = String.fromCodePoint(input.codePointAt(offset)); offset += char.length;
    while (offset < input.length) {
      const next = String.fromCodePoint(input.codePointAt(offset));
      if (!/^\p{Mark}$/u.test(next)) break;
      char += next; offset += next.length;
    }
    clusters.push({ text: char.normalize('NFKC'), start, end: offset });
  }
  const chars = [], starts = [], ends = [];
  for (const cluster of clusters) for (let index = 0; index < cluster.text.length; index += 1) {
    const char = cluster.text[index];
    if (/\s/u.test(char)) {
      if (!chars.length || chars.at(-1) === ' ') continue;
      chars.push(' '); starts.push(cluster.start); ends.push(cluster.end);
    } else { chars.push(char); starts.push(cluster.start); ends.push(cluster.end); }
  }
  if (chars.at(-1) === ' ') { chars.pop(); starts.pop(); ends.pop(); }
  return { text: chars.join(''), starts, ends };
}
const normalizedNeedle = value => normalizedTextMap(typeof value === 'string' ? value.trim() : '').text;
function normalizedMatches(content, value) {
  const haystack = normalizedTextMap(content), needle = normalizedNeedle(value), matches = [];
  if (!needle) return matches;
  for (let offset = 0;;) {
    const index = haystack.text.indexOf(needle, offset);
    if (index < 0) break;
    matches.push(content.slice(haystack.starts[index], haystack.ends[index + needle.length - 1]));
    offset = index + 1;
    if (matches.length > 2) break;
  }
  return matches;
}
const normalizeExternalRef = (value, diagnostics) => {
  if (!object(value)) return null;
  const kind = typeof value.kind === 'string' ? value.kind.trim().toLowerCase() : '';
  const locator = typeof value.locator === 'string' ? value.locator.trim() : '';
  if (Object.keys(value).some(key => !['kind', 'locator'].includes(key))) diagnostics.add('NORMALIZATION_EXTRA_FIELDS_IGNORED');
  const normalized = { kind, locator };
  if (!validRef(normalized)) return null;
  if (kind !== value.kind || locator !== value.locator) diagnostics.add('NORMALIZATION_VALUE_REPAIRED');
  return normalized;
};
const uniqueSourceMatch = (source, anchor, name) => {
  const anchorMatches = normalizedMatches(source.content, anchor);
  if (anchorMatches.length === 1) return true;
  return normalizedMatches(source.content, name).length === 1;
};

export function normalizeExternalRecognitionResult(value, sources) {
  if (!object(value) || !Array.isArray(sources)) throw formatFailure('C 识别结果结构无效');
  const diagnostics = warningCollector(), lists = {}, usedTopKeys = new Set(); let rawItemCount = 0, recognizedCategoryCount = 0;
  for (const category of Object.keys(CATEGORY_ALIASES)) {
    const resolved = aliasedValue(value, category, CATEGORY_ALIASES[category], diagnostics);
    if (resolved.ambiguous || (resolved.found && !Array.isArray(resolved.value))) throw formatFailure('C 识别结果结构无效');
    const matchedKeys = [category, ...CATEGORY_ALIASES[category]].filter(key => Object.prototype.hasOwnProperty.call(value, key));
    matchedKeys.forEach(key => usedTopKeys.add(key));
    lists[category] = resolved.found ? resolved.value : [];
    if (resolved.found) recognizedCategoryCount += 1;
    if (!resolved.found) diagnostics.add('NORMALIZATION_MISSING_CATEGORY_FILLED');
    rawItemCount += lists[category].length;
  }
  if (recognizedCategoryCount === 0) throw formatFailure('C 识别结果结构无效');
  if (Object.keys(value).some(key => !usedTopKeys.has(key))) diagnostics.add('NORMALIZATION_EXTRA_FIELDS_IGNORED');

  const sourceByKey = new Map(sources.map(source => [refKey(source), source]));
  const seen = new Set(), output = { confirmed: [], candidate: [], discarded: [] };
  for (const category of Object.keys(output)) for (const rawItem of lists[category]) {
    if (Object.values(output).reduce((sum, list) => sum + list.length, 0) >= REGISTRY_LIMITS.maxItems) { diagnostics.add('NORMALIZATION_ITEM_SKIPPED'); continue; }
    if (!object(rawItem)) { diagnostics.add('NORMALIZATION_ITEM_SKIPPED'); continue; }
    const values = {}; let ambiguous = false; const usedItemKeys = new Set();
    for (const field of Object.keys(ITEM_ALIASES)) {
      const resolved = aliasedValue(rawItem, field, ITEM_ALIASES[field], diagnostics);
      if (resolved.ambiguous) ambiguous = true;
      values[field] = resolved.value;
      [field, ...ITEM_ALIASES[field]].filter(key => Object.prototype.hasOwnProperty.call(rawItem, key)).forEach(key => usedItemKeys.add(key));
    }
    if (Object.keys(rawItem).some(key => !usedItemKeys.has(key))) diagnostics.add('NORMALIZATION_EXTRA_FIELDS_IGNORED');
    const name = typeof values.name === 'string' ? values.name.trim() : '';
    const anchor = typeof values.sourceAnchor === 'string' ? values.sourceAnchor.trim() : '';
    if (name !== values.name || anchor !== values.sourceAnchor) diagnostics.add('NORMALIZATION_VALUE_REPAIRED');
    if (ambiguous || !normalizeName(name)) { diagnostics.add('NORMALIZATION_ITEM_SKIPPED'); continue; }

    const rawRefs = Array.isArray(values.sourceRefs) ? values.sourceRefs : [];
    if (values.sourceRefs !== undefined && !Array.isArray(values.sourceRefs)) diagnostics.add('NORMALIZATION_VALUE_REPAIRED');
    const normalizedRefs = rawRefs.map(item => normalizeExternalRef(item, diagnostics)).filter(Boolean);
    if (normalizedRefs.length < rawRefs.length) diagnostics.add('NORMALIZATION_UNKNOWN_REF_DROPPED', rawRefs.length - normalizedRefs.length);
    let refs = normalizeRefs(normalizedRefs.filter(item => sourceByKey.has(refKey(item))));
    if (refs.length < normalizedRefs.length) diagnostics.add('NORMALIZATION_UNKNOWN_REF_DROPPED', normalizedRefs.length - refs.length);
    let primary = normalizeExternalRef(values.primarySourceRef, diagnostics);
    const primaryKnown = primary && sourceByKey.has(refKey(primary));
    if (!primaryKnown) {
      if (!primary && refs.length === 1) { primary = refs[0]; diagnostics.add('NORMALIZATION_VALUE_REPAIRED'); }
      else {
        const matching = sources.filter(source => uniqueSourceMatch(source, anchor, name));
        if (matching.length === 1) { primary = ref(matching[0]); diagnostics.add('NORMALIZATION_VALUE_REPAIRED'); }
        else { diagnostics.add('NORMALIZATION_ITEM_SKIPPED'); continue; }
      }
    }
    if (!refs.some(item => refKey(item) === refKey(primary))) { refs = normalizeRefs([...refs, primary]); diagnostics.add('NORMALIZATION_VALUE_REPAIRED'); }
    if (refs.length > REGISTRY_LIMITS.maxRefs) { refs = refs.slice(0, REGISTRY_LIMITS.maxRefs); if (!refs.some(item => refKey(item) === refKey(primary))) refs[refs.length - 1] = ref(primary); refs = normalizeRefs(refs); diagnostics.add('NORMALIZATION_UNKNOWN_REF_DROPPED'); }

    const source = sourceByKey.get(refKey(primary)); let canonicalAnchor = anchor;
    if (!canonicalAnchor || !source.content.includes(canonicalAnchor)) {
      const anchorMatches = normalizedMatches(source.content, canonicalAnchor);
      if (anchorMatches.length === 1) canonicalAnchor = anchorMatches[0];
      else {
        const nameMatches = normalizedMatches(source.content, name);
        if (nameMatches.length !== 1) { diagnostics.add('NORMALIZATION_ITEM_SKIPPED'); continue; }
        canonicalAnchor = nameMatches[0];
      }
      diagnostics.add('NORMALIZATION_VALUE_REPAIRED');
    }
    canonicalAnchor = canonicalAnchor.trim();
    const canonical = { name, sourceAnchor: canonicalAnchor, primarySourceRef: ref(primary), sourceRefs: refs };
    const key = sourceKey(canonical);
    if (!canonicalAnchor || canonicalAnchor.length > REGISTRY_LIMITS.maxAnchorChars || !source.content.includes(canonicalAnchor) || seen.has(key)) { diagnostics.add(seen.has(key) ? 'NORMALIZATION_DUPLICATE_SKIPPED' : 'NORMALIZATION_ITEM_SKIPPED'); continue; }
    seen.add(key); output[category].push(canonical);
  }
  const usableCount = Object.values(output).reduce((sum, list) => sum + list.length, 0);
  if (rawItemCount > 0 && usableCount === 0) throw formatFailure('C 识别结果无可用人物');
  return { value: output, warnings: diagnostics.list(), rawItemCount, usableCount };
}

export function normalizeRegistrySources(input) {
  if (!input?.greeting || typeof input.greeting.content !== 'string' || !Number.isInteger(input.greeting.swipeId) || input.greeting.swipeId < 0 || !Array.isArray(input.worldInfoEntries)) throw fail('C 来源无效');
  const sources = [{ kind: 'greeting', locator: `greeting:0:${input.greeting.swipeId}`, fingerprint: input.greeting.fingerprint, content: cleanAnalysisText(input.greeting.content) }];
  for (const entry of input.worldInfoEntries) {
    if (!object(entry) || typeof entry.world !== 'string' || !entry.world || typeof entry.uid !== 'string' || !entry.uid || typeof entry.fingerprint !== 'string' || typeof entry.content !== 'string') throw fail('C 世界书来源无效');
    sources.push({ kind: 'worldbook', locator: `${entry.world}:${entry.uid}`, fingerprint: entry.fingerprint, content: cleanAnalysisText(entry.content) });
  }
  const total = sources.reduce((sum, item) => sum + item.content.length, 0);
  if (sources.length > 80 || sources.some(item => item.content.length > 24000) || total > 120000) throw fail('C 来源超过输入预算');
  return sources;
}

export function captureSnapshot({ contextProvider, routeFingerprint = '', sourceFingerprint = '', sourceStatus = '' } = {}) {
  const context = typeof contextProvider === 'function' ? contextProvider() || {} : {};
  const metadata = context.chatMetadata?.qianqianjie || {};
  const state = (() => { try { return readHostState(context); } catch { return null; } })();
  const character = Array.isArray(context.characters) ? context.characters[context.characterId] : context.characters?.[context.characterId];
  return Object.freeze({
    chatId: state?.chatId ?? metadata.chatId ?? context.chatId ?? '', hostChatId: state?.hostChatId ?? context.chatId ?? '',
    characterId: state?.characterId ?? String(context.characterId ?? ''), characterAvatar: state?.characterAvatar ?? String(character?.avatar ?? context.characterAvatar ?? '').trim(),
    personaId: context.personaId ?? context.userPersonaId ?? metadata.personaId ?? '', personaAvatar: state?.personaAvatar ?? String(context.userAvatar ?? context.personaAvatar ?? '').trim(),
    personaName: String(context.personaName ?? context.userPersonaName ?? metadata.personaName ?? context.userPersona?.name ?? '').trim(), role: context.role ?? '',
    routeFingerprint, sourceFingerprint, sourceStatus,
  });
}
export const isSnapshotCurrent = (expected, actual) => JSON.stringify(expected) === JSON.stringify(actual);

function withIdentifySingleFlight(adapter, contextProvider, snapshotProvider, isEnabled = () => true) {
  const active = new Map(), pending = new Map(); let epoch = 0;
  const identityKey = snapshot => JSON.stringify(snapshot);
  const identitySnapshot = () => captureSnapshot({ contextProvider });
  const identityMatches = (expected, actual) => IDENTITY_SNAPSHOT_KEYS.every(key => expected?.[key] === actual?.[key]);
  const invalidate = () => { epoch += 1; active.clear(); pending.clear(); adapter.invalidate?.(); };
  return { ...adapter, invalidate, identify: (options = {}) => {
    const mine = epoch, admitted = isEnabled();
    if (!admitted) return Promise.resolve({ status: 'stale' });
    const entryIdentity = identitySnapshot(), provisional = identityKey(entryIdentity);
    if (pending.has(provisional)) return pending.get(provisional);
    const promise = Promise.resolve().then(async () => {
      const current = () => admitted && isEnabled() && mine === epoch;
      if (!current()) return { status: 'stale' };
      options.onPhase?.('reading_sources');
      const captured = typeof snapshotProvider === 'function' ? await snapshotProvider({ guard: () => { if (!current()) throw stale(); } }) : captureSnapshot({ contextProvider });
      if (!current()) return { status: 'stale' };
      const asyncSnapshot = captured?.snapshot || captured;
      if (!identityMatches(entryIdentity, identitySnapshot())) return { status: 'stale' };
      const expectedSnapshot = Object.freeze({ ...asyncSnapshot, ...Object.fromEntries(IDENTITY_SNAPSHOT_KEYS.map(key => [key, entryIdentity[key]])) });
      const key = identityKey(expectedSnapshot);
      if (active.has(key)) return active.get(key);
      if (!current()) return { status: 'stale' };
      active.set(key, promise);
      return adapter.identify({ ...options, expectedSnapshot, expectedSources: captured?.sources, expectedWarnings: captured?.warnings });
    }).catch(error => { if (error?.stale) return { status: 'stale' }; throw error; });
    pending.set(provisional, promise);
    promise.finally(() => { if (pending.get(provisional) === promise) pending.delete(provisional); for (const [key, value] of active) if (value === promise) active.delete(key); }).catch(() => {});
    return promise;
  } };
}

export function createCRegistryAdapter(options = {}) {
  const { formal, routeSource } = options;
  const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true;
  const defaultSnapshotProvider = async ({ guard = () => {} } = {}) => {
    let route, frozen; let status = 'ready';
    if (formal?.getFormalState && routeSource?.collectFrozenAnalysisSources) {
      guard(); const state = await formal.getFormalState(); guard(); status = state?.status || 'source_unavailable'; route = state?.route;
      if (!route && ['ready', 'route_ready'].includes(status)) status = 'route_unavailable';
      if (!['ready', 'route_ready'].includes(status) || !route || route.state !== 'ready') return { snapshot: captureSnapshot({ contextProvider: options.contextProvider, routeFingerprint: JSON.stringify(route || null), sourceStatus: status }), sources: [], warnings: [] };
      guard(); frozen = await routeSource.collectFrozenAnalysisSources(route); guard();
    } else if (routeSource?.collectAnalysisSources) { guard(); frozen = { status: 'ready', sources: await routeSource.collectAnalysisSources() }; guard(); }
    if (!frozen?.sources) return { snapshot: captureSnapshot({ contextProvider: options.contextProvider, routeFingerprint: JSON.stringify(route || null), sourceStatus: frozen?.status || status }), sources: [], warnings: frozen?.warnings };
    let sources;
    try { sources = normalizeRegistrySources(frozen.sources); }
    catch { return { snapshot: captureSnapshot({ contextProvider: options.contextProvider, routeFingerprint: JSON.stringify(route || null), sourceStatus: frozen?.status || 'route_unavailable' }), sources: [], warnings: frozen?.warnings }; }
    return { snapshot: captureSnapshot({ contextProvider: options.contextProvider, routeFingerprint: JSON.stringify(route || null), sourceFingerprint: await fingerprintRegistrySources(sources), sourceStatus: frozen.status || status }), sources, warnings: frozen.warnings };
  };
  const snapshotProvider = typeof options.snapshotProvider === 'function' ? options.snapshotProvider : defaultSnapshotProvider;
  return withIdentifySingleFlight(createLegacyCRegistryAdapter({ ...options, isEnabled }), options.contextProvider, snapshotProvider, isEnabled);
}
export async function fingerprintRegistrySources(sources) { return `sha256:${await sha256(sources.map(item => `${item.kind}\n${item.locator}\n${item.fingerprint}\n${item.content}`).join('\n'))}`; }

const validBinding = (item, lifecycle = null) => object(item) && uuid(item.identityId) && normalizeName(item.displayName)
  && typeof item.sourceAnchor === 'string' && item.sourceAnchor.trim().length > 0 && item.sourceAnchor.trim().length <= 80
  && validRef(item.primarySourceRef) && Array.isArray(item.sourceRefs) && item.sourceRefs.length > 0 && item.sourceRefs.length <= 12 && item.sourceRefs.every(validRef)
  && item.sourceRefs.some(value => refKey(value) === refKey(item.primarySourceRef)) && item.sourceKey === sourceKey(item)
  && (item.selection === undefined || validSelection(item.selection)) && (!lifecycle || item.lifecycle === lifecycle);
const validProfile = (record, identityId, chatId) => envelope(record) && record.data.schemaVersion === 1 && [undefined, 1].includes(record.data.peopleContractVersion)
  && record.data.kind === PROFILE && record.data.identityId === identityId && record.data.chatId === chatId
  && record.data.subject === 'character' && normalizeName(record.data.displayName) && record.data.category === 'confirmed' && validSelection(record.data.selection)
  && Array.isArray(record.data.sourceFacts) && Array.isArray(record.data.userFacts) && Array.isArray(record.data.interpretations) && Array.isArray(record.data.locks) && Array.isArray(record.data.pendingReview)
  && typeof record.data.sourceAnchor === 'string' && record.data.sourceAnchor.trim().length > 0 && validRef(record.data.primarySourceRef)
  && Array.isArray(record.data.sourceRefs) && record.data.sourceRefs.length > 0
  && record.data.sourceRefs.some(value => compatibleProfileRef(value) && refKey(value) === refKey(record.data.primarySourceRef)) && record.data.sourceKey === sourceKey(record.data)
  && ['active', 'shelved', 'deleted'].includes(record.data.lifecycle);
const validCandidate = item => object(item) && Object.keys(item).sort().join(',') === 'name,primarySourceRef,sourceAnchor,sourceKey,sourceRefs'
  && normalizeName(item.name) && typeof item.sourceAnchor === 'string' && item.sourceAnchor.trim().length >= 1 && item.sourceAnchor.trim().length <= 80
  && item.sourceKey === sourceKey(item) && validRef(item.primarySourceRef) && Array.isArray(item.sourceRefs) && item.sourceRefs.length > 0 && item.sourceRefs.length <= 12
  && item.sourceRefs.every(validRef) && item.sourceRefs.some(value => refKey(value) === refKey(item.primarySourceRef));
const validDiscarded = item => object(item)
  && (Object.keys(item).sort().join(',') === 'lifecycle,name,primarySourceRef,sourceAnchor,sourceKey,sourceRefs' || Object.keys(item).sort().join(',') === 'identityId,lifecycle,name,primarySourceRef,sourceAnchor,sourceKey,sourceRefs')
  && (!item.identityId || uuid(item.identityId)) && item.lifecycle === 'discarded'
  && validCandidate(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'lifecycle' && key !== 'identityId')));
const validRegistryLists = data => {
  if (!Array.isArray(data?.confirmed) || !Array.isArray(data?.candidate) || !Array.isArray(data?.discarded) || !Array.isArray(data?.shelved)
    || !data.confirmed.every(item => validBinding(item)) || !data.candidate.every(validCandidate) || !data.discarded.every(validDiscarded)
    || !data.shelved.every(item => validBinding(item, 'shelved')) || data.confirmed.length + data.candidate.length + data.discarded.length + data.shelved.length > 80) return false;
  const keys = new Set(), ids = new Set();
  for (const item of data.confirmed) { if (keys.has(item.sourceKey) || ids.has(item.identityId)) return false; keys.add(item.sourceKey); ids.add(item.identityId); }
  for (const item of data.candidate) { if (keys.has(item.sourceKey)) return false; keys.add(item.sourceKey); }
  for (const item of data.discarded) { if (keys.has(item.sourceKey)) return false; keys.add(item.sourceKey); }
  for (const item of data.shelved) { if (ids.has(item.identityId)) return false; ids.add(item.identityId); }
  return true;
};
const validPendingRecognition = value => object(value) && Object.keys(value).sort().join(',') === 'candidate,confirmed,contractVersion,discarded,shelved,sourceFingerprint'
  && Number.isInteger(value.contractVersion) && value.contractVersion >= 1 && value.contractVersion <= REGISTRY_CONTRACT_VERSION
  && typeof value.sourceFingerprint === 'string' && validRegistryLists(value);
const currentBinding = (item, lifecycle) => ({
  identityId: item.identityId, displayName: item.displayName, sourceAnchor: item.sourceAnchor, primarySourceRef: ref(item.primarySourceRef),
  sourceKey: item.sourceKey || sourceKey(item), sourceRefs: normalizeRefs(item.sourceRefs), selection: lifecycle === 'shelved' ? { status: 'unselected' } : selection(item.selection),
  ...(lifecycle ? { lifecycle } : {}),
});
const legacyShelved = data => {
  const values = [...(Array.isArray(data?.shelved) ? data.shelved : []), ...(Array.isArray(data?.tombstones) ? data.tombstones : [])], seen = new Set();
  return values.filter(item => validBinding(item) && !seen.has(item.identityId) && seen.add(item.identityId)).map(item => currentBinding(item, 'shelved'));
};
const presentationIndex = data => ({ ...data, status: data.contractVersion === REGISTRY_CONTRACT_VERSION ? data.status : 'stale', confirmed: data.confirmed.map(item => currentBinding(item)), shelved: legacyShelved(data) });
const validPendingRename = value => object(value) && Object.keys(value).sort().join(',') === 'identityId,newDisplayName,oldDisplayName'
  && uuid(value.identityId) && normalizeName(value.oldDisplayName) && normalizeName(value.newDisplayName) && value.oldDisplayName !== value.newDisplayName;

export function validateRegistryIndex(record, chatId) {
  if (!envelope(record)) return false;
  const data = record.data;
  if (data.schemaVersion !== 1 || data.kind !== INDEX || data.chatId !== chatId || !uuid(chatId) || !['preparing', 'deleting', 'restoring', 'renaming', 'ready', 'stale'].includes(data.status)
    || typeof data.sourceFingerprint !== 'string' || ![undefined, 1, 2, REGISTRY_CONTRACT_VERSION].includes(data.contractVersion)
    || !Array.isArray(data.confirmed) || !Array.isArray(data.candidate) || !Array.isArray(data.discarded) || !Array.isArray(data.tombstones) || (data.shelved !== undefined && !Array.isArray(data.shelved))) return false;
  if (data.status === 'deleting' ? !validBinding(data.pendingDelete) : data.pendingDelete !== undefined) return false;
  if (data.status === 'restoring' ? !validBinding(data.pendingRestore) : data.pendingRestore !== undefined) return false;
  if (data.status === 'renaming' ? !validPendingRename(data.pendingRename) : data.pendingRename !== undefined) return false;
  if (data.status !== 'preparing' && data.pendingRecognition !== undefined) return false;
  if (data.pendingRecognition !== undefined && !validPendingRecognition(data.pendingRecognition)) return false;
  const shelved = legacyShelved(data), all = [...data.confirmed, ...data.candidate, ...data.discarded, ...shelved];
  if (all.length > 80 || !data.confirmed.every(item => validBinding(item)) || !data.candidate.every(validCandidate) || !data.discarded.every(validDiscarded)) return false;
  if (!(data.shelved || []).every(item => validBinding(item, 'shelved'))) return false;
  if (!data.tombstones.every(item => validBinding(item) && ['deleted', 'shelved'].includes(item.lifecycle))) return false;
  const keys = new Set(), ids = new Set();
  for (const item of data.confirmed) { if (keys.has(item.sourceKey) || ids.has(item.identityId)) return false; keys.add(item.sourceKey); ids.add(item.identityId); }
  for (const item of data.candidate) { if (keys.has(item.sourceKey)) return false; keys.add(item.sourceKey); }
  for (const item of data.discarded) { if (keys.has(item.sourceKey)) return false; keys.add(item.sourceKey); }
  for (const item of shelved) { if (ids.has(item.identityId)) return false; ids.add(item.identityId); }
  if (data.pendingDelete && !data.confirmed.some(item => item.identityId === data.pendingDelete.identityId)) return false;
  if (data.pendingRestore && !shelved.some(item => item.identityId === data.pendingRestore.identityId)) return false;
  if (data.pendingRename && !data.confirmed.some(item => item.identityId === data.pendingRename.identityId && item.displayName === data.pendingRename.oldDisplayName)) return false;
  return true;
}

const profileData = (binding, chatId, identityId, displayName = binding.name, userFacts = [], lifecycle = 'active', selected = { status: 'unselected' }) => ({
  schemaVersion: 1, peopleContractVersion: 1, kind: PROFILE, identityId, subject: 'character', displayName, category: 'confirmed', selection: selection(selected), sourceFacts: [], userFacts,
  interpretations: [], locks: [], pendingReview: [], sourceAnchor: binding.sourceAnchor, primarySourceRef: ref(binding.primarySourceRef), sourceKey: binding.sourceKey || sourceKey(binding),
  sourceRefs: normalizeRefs(binding.sourceRefs), lifecycle, chatId,
});
const stableRefKey = value => {
  if (object(value) && typeof value.kind === 'string' && value.kind.trim() && typeof value.locator === 'string' && value.locator.trim()) return `ref:${value.kind.trim()}\u0000${value.locator.trim()}`;
  try { return `raw:${JSON.stringify(value)}`; } catch { return `raw:${String(value)}`; }
};
const mergeProfileSourceRefs = (existing, current) => {
  const output = [], seen = new Set();
  for (const item of [...(Array.isArray(existing) ? existing : []), ...normalizeRefs(current)]) {
    const key = stableRefKey(item);
    if (seen.has(key)) continue;
    seen.add(key); output.push(item);
  }
  return output;
};
const asCandidate = item => ({ name: item.name.trim(), sourceAnchor: item.sourceAnchor.trim(), primarySourceRef: ref(item.primarySourceRef), sourceRefs: normalizeRefs(item.sourceRefs), sourceKey: sourceKey(item) });
const asDiscarded = item => ({ ...asCandidate(item), lifecycle: 'discarded' });

export function mapPeopleError(error) {
  const status = Number(error?.status || error?.statusCode || 0), code = String(error?.code || error?.name || '').toLowerCase(), message = String(error?.message || '');
  if (error?.name === 'AbortError' || /timeout|timed.?out|etimedout|abort/.test(code) || /timeout|timed.?out|超时/i.test(message) || [408, 504].includes(status)) return 'API 请求超时，请稍后重试';
  if ([401, 403].includes(status) || /unauthori[sz]ed|forbidden|认证|api.?key/.test(`${code} ${message}`.toLowerCase())) return 'API 认证失败，请检查配置后重试';
  if (status === 429 || /rate.?limit|too many requests|限流/.test(`${code} ${message}`.toLowerCase())) return 'API 请求过于频繁，请稍后重试';
  if (/jsonData|generateTask 返回值无效|未返回 jsonData|结果不是 json|结果结构|结构无效|字段无效|来源锚点无效|无可用人物|schema/i.test(message)) return '人物识别结果格式无效';
  return '人物识别失败，请稍后重试';
}
function unwrapGenerateTaskResult(response) {
  let value = response;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw formatFailure('人物识别失败：C 结果不是 JSON'); } }
  if (!object(value)) throw formatFailure('人物识别失败：generateTask 返回值无效');
  if (Object.prototype.hasOwnProperty.call(value, 'jsonData')) {
    value = value.jsonData;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw formatFailure('人物识别失败：jsonData 缺失或无效'); } }
    if (!object(value)) throw formatFailure('人物识别失败：jsonData 缺失或无效');
  }
  return value;
}
export function validateRecognitionResult(value, sources) {
  if (!object(value) || Object.keys(value).length !== 3 || !['confirmed', 'candidate', 'discarded'].every(key => Array.isArray(value[key]))) throw fail('C 识别结果结构无效');
  const known = new Set(sources.map(refKey)), seen = new Set(), output = { confirmed: [], candidate: [], discarded: [] };
  for (const category of Object.keys(output)) for (const item of value[category]) {
    if (!object(item) || Object.keys(item).sort().join(',') !== 'name,primarySourceRef,sourceAnchor,sourceRefs' || !normalizeName(item.name) || typeof item.sourceAnchor !== 'string' || !item.sourceAnchor.trim() || item.sourceAnchor.trim().length > 80
      || !validRef(item.primarySourceRef) || !known.has(refKey(item.primarySourceRef)) || !Array.isArray(item.sourceRefs) || item.sourceRefs.length < 1 || item.sourceRefs.length > 12 || !item.sourceRefs.every(value => validRef(value) && known.has(refKey(value)))
      || !item.sourceRefs.some(value => refKey(value) === refKey(item.primarySourceRef))) throw fail('C 项字段无效');
    const source = sources.find(value => refKey(value) === refKey(item.primarySourceRef)), key = sourceKey(item);
    if (!source || !source.content.includes(item.sourceAnchor.trim()) || seen.has(key)) throw fail('C 来源锚点无效');
    seen.add(key); output[category].push(category === 'confirmed' ? { name: item.name.trim(), sourceAnchor: item.sourceAnchor.trim(), primarySourceRef: ref(item.primarySourceRef), sourceRefs: normalizeRefs(item.sourceRefs) } : category === 'candidate' ? asCandidate(item) : asDiscarded(item));
  }
  if (Object.values(output).reduce((sum, list) => sum + list.length, 0) > 80) throw fail('C 项目超过上限');
  return output;
}
const promptForSources = (sources, retry = false) => [
  '仅根据当前锁定路线来源识别人物；不得读取或推断后续聊天正文。',
  '必须尽量列出来源中的全部重要人物、核心配角、重要关系人物与潜在关系对象，不得替用户挑选或缩成唯一攻略对象。恋爱是否已经发生不影响分类。',
  'confirmed：来源中能确定为具体人物，并且属于重要人物、核心配角、重要关系人物或潜在关系对象。应广泛列出所有符合者。',
  'candidate：来源提到但身份指向仍有歧义、别名尚不能安全归并，或重要性暂不能确定的人物。不得悄悄丢弃。',
  'discarded：明确属于普通路人、无稳定身份的群体称呼、纯设定名词等。',
  '宁可把有证据的重要人物放入 confirmed 或 candidate，也不要替用户缩成唯一攻略对象。',
  '每项必须返回 name、sourceAnchor、primarySourceRef、sourceRefs；sourceAnchor 必须逐字出现在 primarySourceRef 对应来源中。',
  ...(retry ? ['上一次返回无法安全归一化。请只修正 JSON 分类、字段名、来源引用和锚点格式；仍只使用下列同一批锁定来源，不补充任何聊天正文或新事实。'] : []),
  ...sources.map(item => `[${item.kind}] ${item.locator}\n${item.content}`),
].join('\n\n');

// The index is the atomic UI authority. Profiles retain identity/user facts and are reconciled during identify/recovery.
function createLegacyCRegistryAdapter({ client, contextProvider, routeSource, generatePeopleTask, generateTask, onPhase, isEnabled = () => true } = {}) {
  if (!client?.get || !client?.put || typeof contextProvider !== 'function') throw Error('C Registry 依赖不可用');
  const generatePeople = generatePeopleTask ?? generateTask;
  let generation = 0, invalidationEpoch = 0, queue = Promise.resolve(), liveGuard = null;
  const enqueue = operation => {
    const entryEpoch = invalidationEpoch, admitted = isEnabled();
    if (!admitted) return Promise.resolve({ status: 'stale' });
    const current = () => admitted && isEnabled() && entryEpoch === invalidationEpoch;
    const guarded = async () => {
      if (!current()) return { status: 'stale' };
      const entryGuard = async () => { if (!current()) throw stale(); };
      liveGuard = entryGuard;
      try { return await operation(entryEpoch, current); }
      finally { if (liveGuard === entryGuard) liveGuard = null; }
    };
    const next = queue.then(guarded, guarded); queue = next.catch(() => {}); return next;
  };
  const chatId = () => { const value = contextProvider()?.chatMetadata?.qianqianjie; if (!uuid(value?.chatId)) throw fail('聊天 UUID 无效'); return value.chatId; };
  const getIndex = async id => { if (liveGuard) await liveGuard(); try { return await client.get(`chat-${id}`, INDEX); } catch (error) { if (error.status === 404) return null; throw error; } };
  const getProfile = async (id, identityId) => { if (liveGuard) await liveGuard(); try { return await client.get(`chat-${id}-people`, identityId); } catch (error) { if (error.status === 404) return null; throw error; } };
  const guard = (token, id, current = () => true) => { if (!current() || token !== generation || chatId() !== id) throw stale(); };
  const guardIdentity = (token, id, expected, current = () => true) => { guard(token, id, current); const actual = captureSnapshot({ contextProvider }); if (!IDENTITY_SNAPSHOT_KEYS.every(key => expected[key] === actual[key])) throw stale(); };
  const readSources = async () => normalizeRegistrySources(await routeSource.collectAnalysisSources());
  const guardSources = async (token, id) => { if (liveGuard) await liveGuard(); else guard(token, id); };
  const put = async (collection, key, data, revision, validate) => {
    try {
      if (liveGuard) await liveGuard();
      if (validate && !validate({ schemaVersion: 1, revision: Math.max(1, revision + 1), generationId: '123e4567-e89b-12d3-a456-426614174000', createdAt: 'x', updatedAt: 'x', data })) throw fail('C 写入 payload 校验失败');
      const result = await client.put(collection, key, data, revision);
      if (!envelope(result) || (validate && !validate(result))) throw fail('C CAS 写入校验失败');
      return result;
    } catch (error) {
      if (error.status !== 409) throw error;
      if (liveGuard) await liveGuard();
      const winner = await client.get(collection, key);
      if (collection.endsWith('-people') && futureProfile(winner)) return { ...winner, conflict: true, futureReadonly: true };
      if (!envelope(winner) || (validate && !validate(winner))) throw Object.assign(fail('C CAS winner 校验失败'), { conflict: true });
      if (liveGuard) await liveGuard();
      return { ...winner, conflict: true };
    }
  };
  const normalizedData = data => ({ ...data, confirmed: data.confirmed.map(item => currentBinding(item)), shelved: legacyShelved(data), tombstones: [] });
  const sameRenameIntent = (left, right) => validPendingRename(left) && validPendingRename(right)
    && left.identityId === right.identityId && left.oldDisplayName === right.oldDisplayName && left.newDisplayName === right.newDisplayName;
  const desiredRenameFacts = (facts, name) => [...facts.filter(item => item?.provenance !== 'user.displayName'), { value: name, provenance: 'user.displayName', locked: true }];
  const profileHasRename = (profile, intent, id) => {
    if (!validProfile(profile, intent.identityId, id) || profile.data.displayName !== intent.newDisplayName || profile.data.lifecycle !== 'active') return false;
    const facts = profile.data.userFacts.filter(item => item?.provenance === 'user.displayName');
    return facts.length === 1 && facts[0].value === intent.newDisplayName && facts[0].locked === true;
  };
  const indexHasRename = (record, intent) => validateRegistryIndex(record, record?.data?.chatId) && record.data.status === 'ready'
    && record.data.pendingRename === undefined && record.data.confirmed.some(item => item.identityId === intent.identityId && item.displayName === intent.newDisplayName);
  const renameConflict = () => ({ status: 'conflict', recoverable: true, pending: 'rename' });
  const renameConflictPeople = data => ({ ...presentationIndex(data), ...renameConflict(), peopleError: '人物显示名存在未完成冲突，请稍后重试' });

  async function hasUnintendedNameSplit(id, data, check = async () => {}) {
    if (data.status !== 'ready' || validPendingRename(data.pendingRename)) return false;
    for (const binding of [...data.confirmed, ...legacyShelved(data)]) {
      const profile = await getProfile(id, binding.identityId); await check();
      if (profile && validProfile(profile, binding.identityId, id) && profile.data.displayName !== binding.displayName) return true;
    }
    return false;
  }

  async function hasFutureProfile(id, data, check = async () => {}) {
    for (const binding of [...(data?.confirmed || []), ...legacyShelved(data)]) {
      const profile = await getProfile(id, binding.identityId); await check();
      if (profile && futureProfile(profile)) return true;
    }
    return false;
  }

  async function recoverRename(token, id, record, expected = null) {
    const check = async () => { if (liveGuard) await liveGuard(); if (expected) guardIdentity(token, id, expected); else if (!liveGuard) await guardSources(token, id); };
    await check();
    if (!record || !validateRegistryIndex(record, id) || record.data.status !== 'renaming' || !validPendingRename(record.data.pendingRename)) return renameConflict();
    const intent = record.data.pendingRename;
    let profile = await getProfile(id, intent.identityId); await check();
    if (futureProfile(profile)) return readonlyProfile();
    if (!profile || !validProfile(profile, intent.identityId, id)) throw fail('人物档案无效');
    if (!profileHasRename(profile, intent, id)) {
      if (profile.data.displayName !== intent.oldDisplayName) return renameConflict();
      const desired = { ...profile.data, displayName: intent.newDisplayName, userFacts: desiredRenameFacts(profile.data.userFacts, intent.newDisplayName), lifecycle: 'active' };
      const updated = await put(`chat-${id}-people`, intent.identityId, desired, profile.revision, value => validProfile(value, intent.identityId, id));
      await check();
      if (updated.futureReadonly) return readonlyProfile();
      if (updated.conflict && !profileHasRename(updated, intent, id)) return renameConflict();
      profile = updated;
    }
    if (!profileHasRename(profile, intent, id)) return renameConflict();
    const current = await getIndex(id); await check();
    if (!current || !validateRegistryIndex(current, id)) throw fail('people-index 校验失败');
    if (indexHasRename(current, intent)) return { status: 'ready', index: current.data, reused: true };
    if (current.data.status !== 'renaming' || !sameRenameIntent(current.data.pendingRename, intent)) return renameConflict();
    const data = normalizedData(current.data);
    const finalData = { ...data, status: 'ready', pendingRename: undefined, confirmed: data.confirmed.map(item => item.identityId === intent.identityId ? { ...item, displayName: intent.newDisplayName } : item) };
    const saved = await put(`chat-${id}`, INDEX, finalData, current.revision, value => validateRegistryIndex(value, id));
    await check();
    if (saved.conflict) return indexHasRename(saved, intent) ? { status: 'ready', index: saved.data, reused: true } : renameConflict();
    return { status: 'ready', index: saved.data, reused: true };
  }

  async function syncProfile(token, id, binding, lifecycle) {
    await guardSources(token, id); const existing = await getProfile(id, binding.identityId); await guardSources(token, id);
    const selected = lifecycle === 'shelved' ? { status: 'unselected' } : selection(binding.selection);
    if (!existing) {
      const created = await put(`chat-${id}-people`, binding.identityId, profileData(binding, id, binding.identityId, binding.displayName, [], lifecycle, selected), 0, value => validProfile(value, binding.identityId, id));
      await guardSources(token, id); return created.futureReadonly ? { readonly: true } : created.conflict ? { conflict: true } : { profile: created };
    }
    if (futureProfile(existing)) return { readonly: true };
    if (!validProfile(existing, binding.identityId, id)) throw fail('人物档案与索引绑定不一致');
    if (existing.data.displayName !== binding.displayName) return { conflict: true, pending: 'rename' };
    const next = { ...existing.data, selection: selected, sourceAnchor: binding.sourceAnchor, primarySourceRef: ref(binding.primarySourceRef), sourceKey: binding.sourceKey, sourceRefs: mergeProfileSourceRefs(existing.data.sourceRefs, binding.sourceRefs), lifecycle };
    const unchanged = existing.data.lifecycle === next.lifecycle && existing.data.selection.status === next.selection.status && existing.data.sourceKey === next.sourceKey && existing.data.sourceAnchor === next.sourceAnchor
      && refKey(existing.data.primarySourceRef) === refKey(next.primarySourceRef) && sameRefs(existing.data.sourceRefs, next.sourceRefs);
    if (unchanged) return { profile: existing };
    const updated = await put(`chat-${id}-people`, binding.identityId, next, existing.revision, value => validProfile(value, binding.identityId, id));
    await guardSources(token, id); return updated.futureReadonly ? { readonly: true } : updated.conflict ? { conflict: true } : { profile: updated };
  }

  async function recover(token, id, record) {
    if (record.data.status === 'renaming') return recoverRename(token, id, record);
    const pendingRecognition = record.data.status === 'preparing' && validPendingRecognition(record.data.pendingRecognition) ? record.data.pendingRecognition : null;
    let data = pendingRecognition ? {
      ...normalizedData(record.data),
      sourceFingerprint: pendingRecognition.sourceFingerprint,
      confirmed: pendingRecognition.confirmed.map(item => currentBinding(item)),
      candidate: pendingRecognition.candidate,
      discarded: pendingRecognition.discarded,
      shelved: pendingRecognition.shelved.map(item => currentBinding(item, 'shelved')),
    } : normalizedData(record.data);
    if (record.data.status === 'deleting' && record.data.pendingDelete) {
      const binding = currentBinding(record.data.pendingDelete, 'shelved');
      data = { ...data, status: 'ready', pendingDelete: undefined, confirmed: data.confirmed.filter(item => item.identityId !== binding.identityId), shelved: [...data.shelved.filter(item => item.identityId !== binding.identityId), binding] };
    } else if (record.data.status === 'restoring' && record.data.pendingRestore) {
      const binding = currentBinding(record.data.pendingRestore);
      data = { ...data, status: 'ready', pendingRestore: undefined, confirmed: [...data.confirmed.filter(item => item.identityId !== binding.identityId), { ...binding, selection: { status: 'unselected' } }], shelved: data.shelved.filter(item => item.identityId !== binding.identityId) };
    }
    for (let index = 0; index < data.confirmed.length; index += 1) {
      const binding = data.confirmed[index], synced = await syncProfile(token, id, binding, 'active');
      if (synced.readonly) return readonlyProfile();
      if (synced.conflict) return synced.pending === 'rename' ? renameConflict() : { status: 'conflict', recoverable: true };
      data.confirmed[index] = { ...binding, displayName: synced.profile.data.displayName, selection: selection(binding.selection ?? synced.profile.data.selection) };
    }
    for (let index = 0; index < data.shelved.length; index += 1) {
      const binding = currentBinding(data.shelved[index], 'shelved'), synced = await syncProfile(token, id, binding, 'shelved');
      if (synced.readonly) return readonlyProfile();
      if (synced.conflict) return synced.pending === 'rename' ? renameConflict() : { status: 'conflict', recoverable: true };
      data.shelved[index] = { ...binding, displayName: synced.profile.data.displayName };
    }
    await guardSources(token, id);
    const readyData = { ...data, status: 'ready', contractVersion: pendingRecognition?.contractVersion ?? data.contractVersion, pendingDelete: undefined, pendingRestore: undefined, pendingRecognition: undefined };
    if (JSON.stringify(readyData) === JSON.stringify(record.data)) return { status: 'ready', index: readyData, reused: true };
    const ready = await put(`chat-${id}`, INDEX, readyData, record.revision, value => validateRegistryIndex(value, id) && value.data.status === 'ready');
    await guardSources(token, id); return ready.conflict ? { status: 'conflict', recoverable: true } : { status: 'ready', index: ready.data, reused: true };
  }

  const createBindingResolver = (incoming, old, shelved) => {
    const pool = [...(old?.data?.confirmed || []), ...shelved];
    const exact = new Map(incoming.map(item => [item, pool.find(value => value.sourceKey === sourceKey(item)) || null]));
    const consumed = new Set([...exact.values()].filter(Boolean).map(item => item.identityId));
    const originalPrior = item => pool.filter(value => bindingPrimary(value) === bindingPrimary(item));
    const remainingPrior = item => pool.filter(value => bindingPrimary(value) === bindingPrimary(item) && !consumed.has(value.identityId));
    const remainingIncoming = item => incoming.filter(value => bindingPrimary(value) === bindingPrimary(item) && !exact.get(value));
    const prior = item => {
      if (exact.get(item)) return exact.get(item);
      if (originalPrior(item).length > 1) return null;
      const candidates = remainingPrior(item);
      return candidates.length === 1 && remainingIncoming(item).length === 1 ? candidates[0] : null;
    };
    const ambiguous = item => {
      if (exact.get(item) || prior(item)) return false;
      if (originalPrior(item).length > 1) return true;
      const candidates = remainingPrior(item);
      return candidates.length > 1 || (candidates.length === 1 && remainingIncoming(item).length > 1);
    };
    return { prior, ambiguous };
  };
  const dedupeConfirmed = items => { const identities = new Set(), keys = new Set(); return items.filter(item => { const key = sourceKey(item); if (identities.has(item.identityId) || keys.has(key)) return false; identities.add(item.identityId); keys.add(key); return true; }); };

  async function identify(token, expectedSnapshot, expectedSources, expectedWarnings, callPhase, current) {
    const expected = expectedSnapshot || captureSnapshot({ contextProvider }), id = expected.chatId;
    if (!uuid(id)) throw fail('聊天 UUID 无效');
    if (expectedSources && (!['ready', 'route_ready'].includes(expected.sourceStatus) || expectedSources.length === 0)) return { status: expected.sourceStatus || 'route_unavailable' };
    liveGuard = async () => { guard(token, id, current); const actual = captureSnapshot({ contextProvider }); if (!IDENTITY_SNAPSHOT_KEYS.every(key => expected[key] === actual[key])) throw stale(); };
    await liveGuard(); const sources = expectedSources || await readSources(); const fingerprint = await fingerprintRegistrySources(sources);
    if (expected.sourceFingerprint && expected.sourceFingerprint !== fingerprint) throw stale();
    await liveGuard(); let old = await getIndex(id); await liveGuard();
    if (old && !validateRegistryIndex(old, id)) throw fail('people-index 校验失败');
    if (old && await hasFutureProfile(id, old.data, liveGuard)) return readonlyProfile();
    if (old?.data?.status === 'renaming') {
      const renamed = await recoverRename(token, id, old);
      if (renamed.status !== 'ready') return renamed;
      old = await getIndex(id); await liveGuard();
      if (!old || !validateRegistryIndex(old, id)) throw fail('people-index 校验失败');
    }
    if (old?.data?.status === 'preparing' && validPendingRecognition(old.data.pendingRecognition)
      && old.data.pendingRecognition.contractVersion === REGISTRY_CONTRACT_VERSION && old.data.pendingRecognition.sourceFingerprint === fingerprint) {
      const recovered = await recover(token, id, old);
      return expectedWarnings?.length && recovered?.index ? { ...recovered, warnings: expectedWarnings.slice(0, 80) } : recovered;
    }
    if (old && ['preparing', 'deleting', 'restoring'].includes(old.data.status) && old.data.pendingRecognition === undefined) {
      const recovered = await recover(token, id, old);
      if (recovered.status !== 'ready') return recovered;
      old = await getIndex(id); await liveGuard();
      if (!old || !validateRegistryIndex(old, id)) throw fail('people-index 校验失败');
    }
    if (old?.data?.status === 'ready' && await hasUnintendedNameSplit(id, old.data, liveGuard)) return renameConflict();
    if (old?.data?.sourceFingerprint === fingerprint && old.data.contractVersion === REGISTRY_CONTRACT_VERSION && ['ready', 'preparing', 'deleting', 'restoring', 'renaming'].includes(old.data.status)) return recover(token, id, old);
    if (typeof generatePeople !== 'function') throw fail('宿主不支持结构化生成');
    await guardSources(token, id); (callPhase || onPhase)?.('waiting_ai');
    let normalized;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await generatePeople({ includeCharacterCard: false, worldInfoSource: 'none', substituteMacros: false, taskMessages: [{ role: 'user', content: promptForSources(sources, attempt === 1) }], jsonSchema: { name: 'qianqianjie_c_registry', value: C_REGISTRY_SCHEMA, strict: true } });
        await liveGuard(); await guardSources(token, id);
        normalized = normalizeExternalRecognitionResult(unwrapGenerateTaskResult(response), sources);
        validateRecognitionResult(normalized.value, sources);
        break;
      } catch (error) {
        await liveGuard(); await guardSources(token, id);
        if (!error?.retryableRecognitionFormat || attempt === 1) throw error;
      }
    }
    const result = validateRecognitionResult(normalized.value, sources), shelved = legacyShelved(old?.data), resolver = createBindingResolver(result.confirmed, old, shelved);
    const preserved = (old?.data?.confirmed || []).filter(oldItem => result.confirmed.some(item => resolver.ambiguous(item) && bindingPrimary(item) === bindingPrimary(oldItem)));
    const confirmed = dedupeConfirmed([
      ...preserved.map(item => currentBinding(item)),
      ...result.confirmed.filter(item => !resolver.ambiguous(item) && !shelved.some(value => value.identityId === resolver.prior(item)?.identityId)).map(item => {
        const prior = resolver.prior(item);
        return currentBinding({ identityId: prior?.identityId || newUuid(), displayName: prior?.displayName || item.name, sourceAnchor: item.sourceAnchor, primarySourceRef: item.primarySourceRef, sourceKey: sourceKey(item), sourceRefs: item.sourceRefs, selection: selection(prior?.selection) });
      }),
    ]);
    const candidate = [...result.candidate, ...result.confirmed.filter(item => resolver.ambiguous(item)).map(asCandidate)];
    const base = old ? normalizedData(old.data) : { schemaVersion: 1, kind: INDEX, chatId: id, sourceFingerprint: fingerprint, status: 'ready', confirmed: [], candidate: [], discarded: [], shelved: [], tombstones: [] };
    const preparing = { ...base, status: 'preparing', pendingDelete: undefined, pendingRestore: undefined, pendingRename: undefined, pendingRecognition: { contractVersion: REGISTRY_CONTRACT_VERSION, sourceFingerprint: fingerprint, confirmed, candidate, discarded: result.discarded, shelved } };
    (callPhase || onPhase)?.('saving_people'); await guardSources(token, id);
    const saved = await put(`chat-${id}`, INDEX, preparing, old?.revision || 0, value => validateRegistryIndex(value, id) && value.data.status === 'preparing');
    if (saved.conflict) return { status: 'conflict', recoverable: true };
    await guardSources(token, id); const final = await recover(token, id, saved);
    const warnings = [...new Map([...(expectedWarnings || []), ...(normalized.warnings || [])].map(item => [item.code || JSON.stringify(item), item])).values()].slice(0, 80);
    return warnings.length && final?.index ? { ...final, warnings } : final;
  }

  const mutateIndex = (identityId, mutate) => enqueue(async (_entryEpoch, current) => {
    const token = ++generation, expected = captureSnapshot({ contextProvider }), id = expected.chatId;
    if (!uuid(identityId) || !uuid(id)) throw fail('人物或聊天 UUID 无效');
    const index = await getIndex(id); guardIdentity(token, id, expected, current);
    if (!index || !validateRegistryIndex(index, id) || index.data.status !== 'ready') throw fail('people-index 校验失败');
    const next = mutate(normalizedData(index.data));
    if (!next) throw fail('人物不存在');
    guardIdentity(token, id, expected, current);
    const saved = await put(`chat-${id}`, INDEX, next, index.revision, value => validateRegistryIndex(value, id) && value.data.status === 'ready');
    guardIdentity(token, id, expected, current); return saved.conflict ? { status: 'conflict', recoverable: true } : saved.data;
  });
  const setSelection = (identityId, status) => mutateIndex(identityId, data => data.confirmed.some(item => item.identityId === identityId)
    ? { ...data, confirmed: data.confirmed.map(item => item.identityId === identityId ? { ...item, selection: { status } } : item) } : null);
  const shelve = ({ identityId } = {}) => mutateIndex(identityId, data => {
    const binding = data.confirmed.find(item => item.identityId === identityId);
    if (!binding) return data.shelved.some(item => item.identityId === identityId) ? data : null;
    return { ...data, confirmed: data.confirmed.filter(item => item.identityId !== identityId), shelved: [...data.shelved, currentBinding(binding, 'shelved')] };
  });
  const restore = ({ identityId } = {}) => mutateIndex(identityId, data => {
    const binding = data.shelved.find(item => item.identityId === identityId);
    if (!binding) return data.confirmed.some(item => item.identityId === identityId) ? data : null;
    return { ...data, shelved: data.shelved.filter(item => item.identityId !== identityId), confirmed: [...data.confirmed, currentBinding({ ...binding, selection: { status: 'unselected' } })] };
  });

  return {
    getPeople: () => enqueue(async (entryEpoch, current) => {
      try {
        if (!current()) throw stale();
        const expected = captureSnapshot({ contextProvider }), id = chatId(), check = async () => { if (!current()) throw stale(); const actual = captureSnapshot({ contextProvider }); if (!IDENTITY_SNAPSHOT_KEYS.every(key => expected[key] === actual[key])) throw stale(); };
        await check(); const record = await getIndex(id); await check();
        if (!record) return { schemaVersion: 1, kind: INDEX, chatId: id, status: 'uninitialized', confirmed: [], candidate: [], discarded: [], shelved: [], tombstones: [] };
        if (!validateRegistryIndex(record, id)) throw fail('people-index 校验失败');
        if (await hasUnintendedNameSplit(id, record.data, check)) return renameConflictPeople(record.data);
        return presentationIndex(record.data);
      } catch (error) { if (error.stale) return { status: 'stale' }; throw error; }
    }),
    identify: (options = {}) => enqueue(async (_entryEpoch, current) => { if (!current()) return { status: 'stale' }; const token = ++generation; try { return await identify(token, options.expectedSnapshot, options.expectedSources, options.expectedWarnings, options.onPhase, current); } catch (error) { if (error.stale) return { status: 'stale' }; throw error; } finally { liveGuard = null; } }),
    editDisplayName: ({ identityId, displayName } = {}) => enqueue(async (_entryEpoch, current) => {
      const token = ++generation, expected = captureSnapshot({ contextProvider }), id = expected.chatId, name = typeof displayName === 'string' ? displayName.trim() : '';
      if (!uuid(identityId) || name.length < 1 || name.length > 120) throw fail('显示名长度必须为 1..120');
      const index = await getIndex(id); guardIdentity(token, id, expected, current);
      if (!index || !validateRegistryIndex(index, id)) throw fail('people-index 校验失败');
      if (index.data.status === 'renaming') {
        const pending = index.data.pendingRename;
        return pending?.identityId === identityId && pending.newDisplayName === name ? recoverRename(token, id, index, expected) : renameConflict();
      }
      if (index.data.status !== 'ready') return renameConflict();
      const binding = index.data.confirmed.find(item => item.identityId === identityId);
      if (!binding) throw fail('人物不存在');
      if (binding.displayName === name) return index.data;
      const existingProfile = await getProfile(id, identityId); guardIdentity(token, id, expected, current);
      if (futureProfile(existingProfile)) return readonlyProfile();
      if (!existingProfile || !validProfile(existingProfile, identityId, id)) throw fail('人物档案无效');
      const intent = { identityId, oldDisplayName: binding.displayName, newDisplayName: name };
      const data = normalizedData(index.data);
      const started = await put(`chat-${id}`, INDEX, { ...data, status: 'renaming', pendingRename: intent }, index.revision, value => validateRegistryIndex(value, id));
      guardIdentity(token, id, expected, current);
      if (started.conflict) {
        if (started.data.status === 'renaming' && sameRenameIntent(started.data.pendingRename, intent)) return recoverRename(token, id, started, expected);
        return renameConflict();
      }
      return recoverRename(token, id, started, expected);
    }),
    select: ({ identityId } = {}) => setSelection(identityId, 'selected'),
    unselect: ({ identityId } = {}) => setSelection(identityId, 'unselected'),
    selectPerson: ({ identityId } = {}) => setSelection(identityId, 'selected'),
    unselectPerson: ({ identityId } = {}) => setSelection(identityId, 'unselected'),
    shelve, restore, remove: shelve,
    invalidate: () => { generation += 1; invalidationEpoch += 1; },
  };
}
