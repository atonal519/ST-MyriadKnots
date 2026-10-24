import { replaceCseSourceMacros } from '../cse-source-selection.js';

const labelKey = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();

function inFloorPrefix(entity, floorIds) {
  return entity?.firstSeenFloorId === null || floorIds === null || floorIds.has(entity?.firstSeenFloorId);
}

function aliasNames(entity) {
  return [entity?.displayName, ...(entity?.aliases ?? []).map(alias => alias?.name)]
    .filter(value => typeof value === 'string' && value.trim());
}

export function identityLabelKey(value) {
  return labelKey(value);
}

export function entitiesThroughFloorIds(entities = [], floorIds = null, identityProjection = null) {
  const allowed = floorIds instanceof Set ? floorIds : (Array.isArray(floorIds) ? new Set(floorIds) : null);
  const userEntityId = identityProjection?.userEntityId;
  const scoped = [];
  for (const entity of entities) {
    if (inFloorPrefix(entity, allowed)) scoped.push(entity);
    else if (userEntityId ? entity.id === userEntityId : entity.specialRole === 'user') {
      // Only carry the role identity into an earlier floor, not its later story brief.
      const { identityBrief, ...identity } = entity;
      scoped.push(identity);
    }
  }
  return scoped;
}

function manualAliasProjection(value) {
  // 人工别名是既有档案的全集决定；空清单也必须覆盖自动累计。
  const source = Object.hasOwn(value ?? {}, 'profilesByEntityId')
    ? Object.fromEntries(Object.entries(value.profilesByEntityId ?? {}).filter(([, profile]) => profile?.manualFields?.includes('aliases')).map(([id, profile]) => [id, profile.aliases]))
    : value?.manualAliasesByEntityId ?? {};
  return normalizeAliasLists(source);
}

function normalizeAliasLists(source) {
  return Object.fromEntries(Object.entries(source).filter(([id]) => id).map(([id, aliases]) => {
    const seen = new Set();
    const names = (Array.isArray(aliases) ? aliases : typeof aliases === 'string' ? aliases.split(/[、，,\r\n]+/) : []).flatMap(value => {
      const name = typeof value === 'string' ? value.trim() : '', key = labelKey(name);
      if (!key || seen.has(key)) return [];
      seen.add(key); return [name];
    });
    return [id, Object.freeze(names)];
  }));
}

function reviewedAliasProjection(value) {
  const source = Object.hasOwn(value ?? {}, 'profilesByEntityId')
    ? Object.fromEntries(Object.entries(value.profilesByEntityId ?? {}).filter(([, profile]) => profile?.aliasesComplete === true).map(([id, profile]) => [id, profile.aliases]))
    : value?.reviewedAliasesByEntityId ?? {};
  return normalizeAliasLists(source);
}

export function normalizeIdentityProjection(value = {}, macros = null) {
  const redirects = value?.identityRedirectsByEntityId && typeof value.identityRedirectsByEntityId === 'object' && !Array.isArray(value.identityRedirectsByEntityId)
    ? Object.fromEntries(Object.entries(value.identityRedirectsByEntityId).filter(([source, target]) => typeof source === 'string' && typeof target === 'string' && source && target && source !== target))
    : {};
  const deleted = [...new Set(Array.isArray(value?.deletedEntityIds) ? value.deletedEntityIds.filter(id => typeof id === 'string' && id) : [])];
  const manualAliases = manualAliasProjection(value);
  const reviewedAliases = reviewedAliasProjection(value);
  const profileNames = Object.hasOwn(value ?? {}, 'profilesByEntityId')
    ? Object.fromEntries(Object.entries(value.profilesByEntityId ?? {}).map(([id, profile]) => [id, profile?.name])) : value?.currentNamesByEntityId ?? {};
  const currentNames = Object.fromEntries(Object.entries(profileNames).filter(([id, name]) => id && typeof name === 'string' && name.trim())
    .map(([id, name]) => [id, replaceCseSourceMacros(name.trim(), macros)]));
  return Object.freeze({ identityRedirectsByEntityId: Object.freeze(redirects), deletedEntityIds: Object.freeze(deleted),
    ...(Object.hasOwn(value ?? {}, 'userEntityId') ? { userEntityId: typeof value.userEntityId === 'string' && value.userEntityId ? value.userEntityId : null } : {}),
    ...(Object.keys(manualAliases).length ? { manualAliasesByEntityId: Object.freeze(manualAliases) } : {}),
    ...(Object.keys(reviewedAliases).length ? { reviewedAliasesByEntityId: Object.freeze(reviewedAliases) } : {}),
    ...(Object.keys(currentNames).length ? { currentNamesByEntityId: Object.freeze(currentNames) } : {}) });
}

export function deriveUserIdentityProjection({ entities = [], baseline = null, identityProjection = null } = {}) {
  const projection = normalizeIdentityProjection(identityProjection ?? {}, { user: baseline?.userPersona?.name, char: baseline?.characterCard?.name });
  const active = entities.filter(entity => (entity.recordStatus === undefined || entity.recordStatus === 'active') && entity.status !== 'invalidated');
  const users = active.filter(entity => entity.entityType === 'person' && entity.specialRole === 'user');
  const redirects = { ...Object.fromEntries(active.filter(entity => entity.status === 'merged' && entity.mergedIntoEntityId)
    .map(entity => [entity.id, entity.mergedIntoEntityId])), ...projection.identityRedirectsByEntityId };
  const userEntityId = resolveIdentityEntityId(baseline?.userPersona?.entityId ?? projection.userEntityId ?? users[0]?.id, { identityRedirectsByEntityId: redirects });
  if (!userEntityId) return normalizeIdentityProjection({ ...projection, userEntityId: null });
  // The host's user role is global identity, not an appearance in a particular story floor.
  // Explicit manual redirects remain authoritative, including a redirected baseline user.
  for (const user of users) if (user.id !== userEntityId && !Object.hasOwn(projection.identityRedirectsByEntityId, user.id)) redirects[user.id] = userEntityId;
  const aliases = {};
  for (const key of ['manualAliasesByEntityId', 'reviewedAliasesByEntityId']) {
    const lists = { ...(projection[key] ?? {}) };
    if (!Object.hasOwn(lists, userEntityId)) {
      const member = users.find(user => resolveIdentityEntityId(user.id, { identityRedirectsByEntityId: redirects }) === userEntityId && Object.hasOwn(lists, user.id));
      if (member) lists[userEntityId] = lists[member.id];
    }
    aliases[key] = lists;
  }
  const currentNames = { ...(projection.currentNamesByEntityId ?? {}) };
  if (!Object.hasOwn(currentNames, userEntityId)) {
    const member = users.find(user => resolveIdentityEntityId(user.id, { identityRedirectsByEntityId: redirects }) === userEntityId && Object.hasOwn(currentNames, user.id));
    if (member) currentNames[userEntityId] = currentNames[member.id];
  }
  return normalizeIdentityProjection({ ...projection, identityRedirectsByEntityId: redirects, userEntityId, ...aliases, currentNamesByEntityId: currentNames });
}

export function reuseIdentityProjection(previous, value) {
  const normalized = normalizeIdentityProjection(value);
  if (!previous) return normalized;
  if (previous.userEntityId !== normalized.userEntityId) return normalized;
  const previousRedirects = previous.identityRedirectsByEntityId ?? {};
  const nextRedirects = normalized.identityRedirectsByEntityId;
  const previousSources = Object.keys(previousRedirects), nextSources = Object.keys(nextRedirects);
  if (previousSources.length !== nextSources.length || nextSources.some(source => !Object.hasOwn(previousRedirects, source) || previousRedirects[source] !== nextRedirects[source])) return normalized;
  const previousDeleted = previous.deletedEntityIds ?? [], nextDeleted = normalized.deletedEntityIds;
  if (previousDeleted.length !== nextDeleted.length) return normalized;
  const previousDeletedSet = new Set(previousDeleted);
  if (!nextDeleted.every(id => previousDeletedSet.has(id))) return normalized;
  const beforeNames = previous.currentNamesByEntityId ?? {}, afterNames = normalized.currentNamesByEntityId ?? {};
  if (Object.keys(beforeNames).length !== Object.keys(afterNames).length || Object.entries(afterNames).some(([id, name]) => beforeNames[id] !== name)) return normalized;
  for (const key of ['manualAliasesByEntityId', 'reviewedAliasesByEntityId']) {
    const before = previous[key] ?? {}, after = normalized[key] ?? {};
    if (Object.keys(before).length !== Object.keys(after).length) return normalized;
    for (const [id, names] of Object.entries(after)) {
      if (!Object.hasOwn(before, id) || before[id].length !== names.length) return normalized;
      const oldNames = new Set(before[id]);
      if (!names.every(name => oldNames.has(name))) return normalized;
    }
  }
  return previous;
}

export function resolveIdentityEntityId(entityId, projection = {}) {
  if (typeof entityId !== 'string' || !entityId) return entityId ?? null;
  const redirects = projection?.identityRedirectsByEntityId ?? {};
  const seen = new Set();
  let current = entityId;
  while (typeof redirects[current] === 'string' && redirects[current] && redirects[current] !== current && !seen.has(current)) {
    seen.add(current);
    current = redirects[current];
  }
  return current;
}

export function identityProjectionMembers(entityId, projection = {}) {
  const canonical = resolveIdentityEntityId(entityId, projection);
  const ids = new Set([canonical]);
  for (const source of Object.keys(projection?.identityRedirectsByEntityId ?? {})) {
    if (resolveIdentityEntityId(source, projection) === canonical) ids.add(source);
  }
  return Object.freeze([...ids]);
}

export function isIdentityDeleted(entityId, projection = {}) {
  const canonical = resolveIdentityEntityId(entityId, projection);
  return new Set(projection?.deletedEntityIds ?? []).has(canonical);
}

const resolvedIds = (values, projection) => Object.freeze([...new Set((values ?? []).map(id => resolveIdentityEntityId(id, projection)).filter(Boolean))]);
const resolvedParticipants = (values, projection) => {
  const seen = new Set();
  return Object.freeze((values ?? []).flatMap(item => {
    const entityId = resolveIdentityEntityId(item.entityId, projection);
    if (!entityId || seen.has(entityId)) return [];
    seen.add(entityId);
    return [Object.freeze({ ...item, entityId })];
  }));
};

export function projectFloorMemoryIdentityReferences(memory, projection = {}) {
  const resolve = id => resolveIdentityEntityId(id, projection);
  const spatialFacts = memory?.spatialFacts ? (() => {
    const edges = (memory.spatialFacts.containments ?? []).flatMap(item => {
      const placeEntityId = resolve(item.placeEntityId), parentEntityId = resolve(item.parentEntityId);
      return !placeEntityId || !parentEntityId || isIdentityDeleted(placeEntityId, projection) || isIdentityDeleted(parentEntityId, projection)
        ? [] : [{ item, placeEntityId, parentEntityId }];
    });
    const edgesBySource = new Map(), invalidChildrenBySource = new Map();
    for (const edge of edges) for (const sourceFloorId of new Set((edge.item.evidenceRefs ?? []).map(ref => ref.floorId))) {
      const current = invalidChildrenBySource.get(sourceFloorId) ?? new Set();
      if (edge.placeEntityId === edge.parentEntityId) { current.add(edge.placeEntityId); invalidChildrenBySource.set(sourceFloorId, current); continue; }
      const sourceEdges = edgesBySource.get(sourceFloorId) ?? [];
      sourceEdges.push(edge); edgesBySource.set(sourceFloorId, sourceEdges);
    }
    for (const [sourceFloorId, sourceEdges] of edgesBySource) {
      const parentSets = new Map();
      for (const edge of sourceEdges) {
        const parents = parentSets.get(edge.placeEntityId) ?? new Set();
        parents.add(edge.parentEntityId); parentSets.set(edge.placeEntityId, parents);
      }
      const invalidChildren = invalidChildrenBySource.get(sourceFloorId) ?? new Set();
      for (const [placeId, parents] of parentSets) if (parents.size > 1) invalidChildren.add(placeId);
      const singleParent = new Map([...parentSets].filter(([placeId, parents]) => parents.size === 1 && !invalidChildren.has(placeId)).map(([placeId, parents]) => [placeId, [...parents][0]]));
      for (const start of singleParent.keys()) {
        const path = [], offsetByPlace = new Map(); let current = start;
        while (singleParent.has(current)) {
          if (offsetByPlace.has(current)) { for (const placeId of path.slice(offsetByPlace.get(current))) invalidChildren.add(placeId); break; }
          offsetByPlace.set(current, path.length); path.push(current); current = singleParent.get(current);
        }
      }
      if (invalidChildren.size) invalidChildrenBySource.set(sourceFloorId, invalidChildren);
    }
    const containments = edges.flatMap(({ item, placeEntityId, parentEntityId }) => {
      const evidenceRefs = (item.evidenceRefs ?? []).filter(ref => !invalidChildrenBySource.get(ref.floorId)?.has(placeEntityId));
      return evidenceRefs.length ? [Object.freeze({ ...item, placeEntityId, parentEntityId, evidenceRefs: Object.freeze(evidenceRefs) })] : [];
    });
    const positionRows = [];
    for (const item of memory.spatialFacts.positions ?? []) {
      const subjectEntityId = resolve(item.subjectEntityId);
      let placeEntityId = item.placeEntityId ? resolve(item.placeEntityId) : null;
      if (!subjectEntityId || isIdentityDeleted(subjectEntityId, projection)) continue;
      if (placeEntityId && isIdentityDeleted(placeEntityId, projection)) placeEntityId = null;
      if (item.status !== 'leftUnknown' && !placeEntityId) continue;
      positionRows.push({ item, subjectEntityId, placeEntityId });
    }
    const invalidPositionSubjects = new Set(), signatureBySourceSubject = new Map();
    for (const row of positionRows) for (const sourceFloorId of new Set((row.item.evidenceRefs ?? []).map(ref => ref.floorId))) {
      const key = `${sourceFloorId}|${row.subjectEntityId}`, signature = JSON.stringify([row.placeEntityId, row.item.status]);
      const previous = signatureBySourceSubject.get(key);
      if (previous && previous !== signature) invalidPositionSubjects.add(key);
      else signatureBySourceSubject.set(key, signature);
    }
    const positions = positionRows.flatMap(({ item, subjectEntityId, placeEntityId }) => {
      const evidenceRefs = (item.evidenceRefs ?? []).filter(ref => !invalidPositionSubjects.has(`${ref.floorId}|${subjectEntityId}`));
      return evidenceRefs.length ? [Object.freeze({ ...item, subjectEntityId, placeEntityId, evidenceRefs: Object.freeze(evidenceRefs) })] : [];
    });
    return Object.freeze({ ...memory.spatialFacts, containments: Object.freeze(containments), positions: Object.freeze(positions) });
  })() : undefined;
  return Object.freeze({ ...memory,
    participants: resolvedParticipants(memory?.participants, projection),
    locations: Object.freeze((memory?.locations ?? []).map(item => Object.freeze({ ...item, entityId: item.entityId ? resolve(item.entityId) : null, participantEntityIds: resolvedIds(item.participantEntityIds, projection) }))),
    actions: Object.freeze((memory?.actions ?? []).map(item => Object.freeze({ ...item, actorEntityId: resolve(item.actorEntityId), targetEntityIds: resolvedIds(item.targetEntityIds, projection) }))),
    observations: Object.freeze((memory?.observations ?? []).map(item => Object.freeze({ ...item, subjectEntityId: item.subjectEntityId ? resolve(item.subjectEntityId) : null }))),
    informationTransfers: Object.freeze((memory?.informationTransfers ?? []).map(item => Object.freeze({ ...item, fromEntityId: item.fromEntityId ? resolve(item.fromEntityId) : null, toEntityIds: resolvedIds(item.toEntityIds, projection) }))),
    privateCognition: Object.freeze((memory?.privateCognition ?? []).map(item => Object.freeze({ ...item, ownerEntityId: resolve(item.ownerEntityId) }))),
    commitments: Object.freeze((memory?.commitments ?? []).map(item => Object.freeze({ ...item, speakerEntityId: resolve(item.speakerEntityId), targetEntityIds: resolvedIds(item.targetEntityIds, projection) }))),
    openLoops: Object.freeze((memory?.openLoops ?? []).map(item => Object.freeze({ ...item, ownerEntityIds: resolvedIds(item.ownerEntityIds, projection) }))),
    exactAnchors: Object.freeze((memory?.exactAnchors ?? []).map(item => Object.freeze({ ...item,
      speakerEntityId: item.speakerEntityId ? resolve(item.speakerEntityId) : null,
      ...(item.manual === true ? { knownEntityIds: Object.freeze(resolvedIds(item.knownEntityIds, projection).filter(id => !isIdentityDeleted(id, projection))) } : {}),
    }))),
    cseSignals: Object.freeze((memory?.cseSignals ?? []).map(item => Object.freeze({ ...item, subjectEntityId: resolve(item.subjectEntityId), objectEntityId: item.objectEntityId ? resolve(item.objectEntityId) : null }))),
    ...(spatialFacts ? { spatialFacts } : {}),
  });
}

export function projectCseStateIdentityReferences(state, projection = {}) {
  if (!state) return null;
  const grouped = new Map();
  for (const subject of state.subjects ?? []) {
    const subjectEntityId = resolveIdentityEntityId(subject.subjectEntityId, projection);
    if (isIdentityDeleted(subjectEntityId, projection)) continue;
    const target = grouped.get(subjectEntityId) ?? { subjectEntityId, core: [], adaptive: [], situational: [] };
    for (const category of ['core', 'adaptive', 'situational']) {
      for (const raw of subject[category] ?? []) {
        const item = Object.freeze({ ...raw, towardEntityId: raw.towardEntityId ? resolveIdentityEntityId(raw.towardEntityId, projection) : null });
        if (!target[category].some(existing => existing.id === item.id)) target[category].push(item);
      }
    }
    grouped.set(subjectEntityId, target);
  }
  return Object.freeze({ ...state, subjects: Object.freeze([...grouped.values()].map(subject => Object.freeze({ ...subject,
    core: Object.freeze(subject.core), adaptive: Object.freeze(subject.adaptive), situational: Object.freeze(subject.situational) }))) });
}

export function buildEntityIdentityDirectory({ entities = [], floorIds = null, identityProjection = null, identityRedirectsByEntityId = null, deletedEntityIds = null } = {}) {
  const supplied = identityProjection ?? { identityRedirectsByEntityId, deletedEntityIds };
  const projection = Object.hasOwn(supplied, 'userEntityId') ? normalizeIdentityProjection(supplied)
    : deriveUserIdentityProjection({ entities, identityProjection: supplied });
  const scoped = entitiesThroughFloorIds(entities, floorIds, projection);
  const isActive = entity => entity?.recordStatus === undefined || entity.recordStatus === 'active';
  const foundationRedirects = Object.fromEntries(scoped
    .filter(entity => isActive(entity) && entity.status === 'merged' && typeof entity.mergedIntoEntityId === 'string')
    .map(entity => [entity.id, entity.mergedIntoEntityId]));
  const combinedProjection = normalizeIdentityProjection({
    identityRedirectsByEntityId: { ...foundationRedirects, ...projection.identityRedirectsByEntityId },
    deletedEntityIds: projection.deletedEntityIds,
    userEntityId: projection.userEntityId,
    manualAliasesByEntityId: projection.manualAliasesByEntityId,
    reviewedAliasesByEntityId: projection.reviewedAliasesByEntityId,
    currentNamesByEntityId: projection.currentNamesByEntityId,
  });
  const canonical = scoped.filter(entity => isActive(entity) && entity.status !== 'merged' && entity.status !== 'invalidated'
    && resolveIdentityEntityId(entity.id, combinedProjection) === entity.id && !isIdentityDeleted(entity.id, combinedProjection));
  const canonicalById = new Map(canonical.map(entity => [entity.id, entity]));
  const learned = new Map(canonical.map(entity => [entity.id, []]));
  const identityBriefRecords = new Map(canonical.filter(entity => typeof entity.identityBrief === 'string').map(entity => [entity.id, entity]));
  for (const aliasEntity of scoped) {
    if (!isActive(aliasEntity) || aliasEntity.status === 'invalidated') continue;
    const target = canonicalById.get(resolveIdentityEntityId(aliasEntity.id, combinedProjection));
    if (!target || target.id === aliasEntity.id || target.entityType !== aliasEntity.entityType
      || target.chatId !== aliasEntity.chatId || target.narrativeGeneration !== aliasEntity.narrativeGeneration) continue;
    learned.get(target.id).push(...aliasNames(aliasEntity));
    if (typeof aliasEntity.identityBrief === 'string' && aliasEntity.identityBrief.trim()) {
      const prior = identityBriefRecords.get(target.id);
      const priorTime = Date.parse(prior?.updatedAt ?? prior?.createdAt ?? '') || 0;
      const nextTime = Date.parse(aliasEntity.updatedAt ?? aliasEntity.createdAt ?? '') || 0;
      if (!prior || nextTime > priorTime || nextTime === priorTime && aliasEntity.id.localeCompare(prior.id) > 0) identityBriefRecords.set(target.id, aliasEntity);
    }
  }
  return Object.freeze(canonical.map(entity => {
    const seen = new Set();
    const labels = [];
    const manual = combinedProjection.manualAliasesByEntityId;
    const reviewed = combinedProjection.reviewedAliasesByEntityId;
    const displayName = entity.entityType === 'person' ? combinedProjection.currentNamesByEntityId?.[entity.id] || entity.displayName : entity.displayName;
    const names = entity.entityType === 'person' && Object.hasOwn(manual ?? {}, entity.id)
      ? manual[entity.id]
      : entity.entityType === 'person' && Object.hasOwn(reviewed ?? {}, entity.id)
        ? reviewed[entity.id] : [...aliasNames(entity), ...(learned.get(entity.id) ?? [])].filter(name => labelKey(name) !== labelKey(entity.displayName));
    for (const label of [displayName, ...names]) {
      const key = labelKey(label);
      if (!key || seen.has(key)) continue;
      seen.add(key); labels.push(label.trim());
    }
    const aliases = Object.freeze(labels.filter(label => labelKey(label) !== labelKey(displayName)));
    if (!seen.has(labelKey(entity.displayName))) labels.push(entity.displayName);
    const specialRole = entity.id === projection.userEntityId ? 'user' : entity.specialRole;
    return Object.freeze({
      entity: displayName !== entity.displayName || specialRole !== entity.specialRole ? Object.freeze({ ...entity, displayName, specialRole }) : entity,
      entityId: entity.id,
      entityType: entity.entityType,
      specialRole,
      displayName,
      ...(displayName !== entity.displayName ? { originalDisplayName: entity.displayName } : {}),
      aliases,
      labels: Object.freeze(labels),
      ...(identityBriefRecords.has(entity.id) ? { identityBrief: identityBriefRecords.get(entity.id).identityBrief } : {}),
    });
  }));
}
