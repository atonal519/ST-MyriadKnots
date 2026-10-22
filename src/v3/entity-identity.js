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

export function entitiesThroughFloorIds(entities = [], floorIds = null) {
  const allowed = floorIds instanceof Set ? floorIds : (Array.isArray(floorIds) ? new Set(floorIds) : null);
  return entities.filter(entity => inFloorPrefix(entity, allowed));
}

function manualAliasProjection(value) {
  // 人工别名是既有档案的全集决定；空清单也必须覆盖自动累计。
  const source = Object.hasOwn(value ?? {}, 'profilesByEntityId')
    ? Object.fromEntries(Object.entries(value.profilesByEntityId ?? {}).filter(([, profile]) => profile?.manualFields?.includes('aliases')).map(([id, profile]) => [id, profile.aliases]))
    : value?.manualAliasesByEntityId ?? {};
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

export function normalizeIdentityProjection(value = {}) {
  const redirects = value?.identityRedirectsByEntityId && typeof value.identityRedirectsByEntityId === 'object' && !Array.isArray(value.identityRedirectsByEntityId)
    ? Object.fromEntries(Object.entries(value.identityRedirectsByEntityId).filter(([source, target]) => typeof source === 'string' && typeof target === 'string' && source && target && source !== target))
    : {};
  const deleted = [...new Set(Array.isArray(value?.deletedEntityIds) ? value.deletedEntityIds.filter(id => typeof id === 'string' && id) : [])];
  const manualAliases = manualAliasProjection(value);
  return Object.freeze({ identityRedirectsByEntityId: Object.freeze(redirects), deletedEntityIds: Object.freeze(deleted),
    ...(Object.keys(manualAliases).length ? { manualAliasesByEntityId: Object.freeze(manualAliases) } : {}) });
}

export function reuseIdentityProjection(previous, value) {
  const normalized = normalizeIdentityProjection(value);
  if (!previous) return normalized;
  const previousRedirects = previous.identityRedirectsByEntityId ?? {};
  const nextRedirects = normalized.identityRedirectsByEntityId;
  const previousSources = Object.keys(previousRedirects), nextSources = Object.keys(nextRedirects);
  if (previousSources.length !== nextSources.length || nextSources.some(source => !Object.hasOwn(previousRedirects, source) || previousRedirects[source] !== nextRedirects[source])) return normalized;
  const previousDeleted = previous.deletedEntityIds ?? [], nextDeleted = normalized.deletedEntityIds;
  if (previousDeleted.length !== nextDeleted.length) return normalized;
  const previousDeletedSet = new Set(previousDeleted);
  if (!nextDeleted.every(id => previousDeletedSet.has(id))) return normalized;
  const before = previous.manualAliasesByEntityId ?? {}, after = normalized.manualAliasesByEntityId ?? {};
  if (Object.keys(before).length !== Object.keys(after).length) return normalized;
  for (const [id, names] of Object.entries(after)) {
    if (!Object.hasOwn(before, id) || before[id].length !== names.length) return normalized;
    const oldNames = new Set(before[id]);
    if (!names.every(name => oldNames.has(name))) return normalized;
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
  const scoped = entitiesThroughFloorIds(entities, floorIds);
  const projection = normalizeIdentityProjection(identityProjection ?? { identityRedirectsByEntityId, deletedEntityIds });
  const isActive = entity => entity?.recordStatus === undefined || entity.recordStatus === 'active';
  const foundationRedirects = Object.fromEntries(scoped
    .filter(entity => isActive(entity) && entity.status === 'merged' && typeof entity.mergedIntoEntityId === 'string')
    .map(entity => [entity.id, entity.mergedIntoEntityId]));
  const combinedProjection = normalizeIdentityProjection({
    identityRedirectsByEntityId: { ...foundationRedirects, ...projection.identityRedirectsByEntityId },
    deletedEntityIds: projection.deletedEntityIds,
    manualAliasesByEntityId: projection.manualAliasesByEntityId,
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
    const names = entity.entityType === 'person' && Object.hasOwn(manual ?? {}, entity.id)
      ? [entity.displayName, ...manual[entity.id]] : [...aliasNames(entity), ...(learned.get(entity.id) ?? [])];
    for (const label of names) {
      const key = labelKey(label);
      if (!key || seen.has(key)) continue;
      seen.add(key); labels.push(label.trim());
    }
    return Object.freeze({
      entity,
      entityId: entity.id,
      entityType: entity.entityType,
      specialRole: entity.specialRole,
      displayName: entity.displayName,
      aliases: Object.freeze(labels.filter(label => labelKey(label) !== labelKey(entity.displayName))),
      labels: Object.freeze(labels),
      ...(identityBriefRecords.has(entity.id) ? { identityBrief: identityBriefRecords.get(entity.id).identityBrief } : {}),
    });
  }));
}
