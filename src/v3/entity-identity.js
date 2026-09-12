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

export function normalizeIdentityProjection(value = {}) {
  const redirects = value?.identityRedirectsByEntityId && typeof value.identityRedirectsByEntityId === 'object' && !Array.isArray(value.identityRedirectsByEntityId)
    ? Object.fromEntries(Object.entries(value.identityRedirectsByEntityId).filter(([source, target]) => typeof source === 'string' && typeof target === 'string' && source && target && source !== target))
    : {};
  const deleted = [...new Set(Array.isArray(value?.deletedEntityIds) ? value.deletedEntityIds.filter(id => typeof id === 'string' && id) : [])];
  return Object.freeze({ identityRedirectsByEntityId: Object.freeze(redirects), deletedEntityIds: Object.freeze(deleted) });
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
  return Object.freeze({ ...memory,
    participants: resolvedParticipants(memory?.participants, projection),
    locations: Object.freeze((memory?.locations ?? []).map(item => Object.freeze({ ...item, entityId: item.entityId ? resolve(item.entityId) : null, participantEntityIds: resolvedIds(item.participantEntityIds, projection) }))),
    actions: Object.freeze((memory?.actions ?? []).map(item => Object.freeze({ ...item, actorEntityId: resolve(item.actorEntityId), targetEntityIds: resolvedIds(item.targetEntityIds, projection) }))),
    observations: Object.freeze((memory?.observations ?? []).map(item => Object.freeze({ ...item, subjectEntityId: item.subjectEntityId ? resolve(item.subjectEntityId) : null }))),
    informationTransfers: Object.freeze((memory?.informationTransfers ?? []).map(item => Object.freeze({ ...item, fromEntityId: item.fromEntityId ? resolve(item.fromEntityId) : null, toEntityIds: resolvedIds(item.toEntityIds, projection) }))),
    privateCognition: Object.freeze((memory?.privateCognition ?? []).map(item => Object.freeze({ ...item, ownerEntityId: resolve(item.ownerEntityId) }))),
    commitments: Object.freeze((memory?.commitments ?? []).map(item => Object.freeze({ ...item, speakerEntityId: resolve(item.speakerEntityId), targetEntityIds: resolvedIds(item.targetEntityIds, projection) }))),
    openLoops: Object.freeze((memory?.openLoops ?? []).map(item => Object.freeze({ ...item, ownerEntityIds: resolvedIds(item.ownerEntityIds, projection) }))),
    exactAnchors: Object.freeze((memory?.exactAnchors ?? []).map(item => Object.freeze({ ...item, speakerEntityId: item.speakerEntityId ? resolve(item.speakerEntityId) : null }))),
    cseSignals: Object.freeze((memory?.cseSignals ?? []).map(item => Object.freeze({ ...item, subjectEntityId: resolve(item.subjectEntityId), objectEntityId: item.objectEntityId ? resolve(item.objectEntityId) : null }))),
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
  });
  const canonical = scoped.filter(entity => isActive(entity) && entity.status !== 'merged' && entity.status !== 'invalidated'
    && resolveIdentityEntityId(entity.id, combinedProjection) === entity.id && !isIdentityDeleted(entity.id, combinedProjection));
  const canonicalById = new Map(canonical.map(entity => [entity.id, entity]));
  const learned = new Map(canonical.map(entity => [entity.id, []]));
  for (const aliasEntity of scoped) {
    if (!isActive(aliasEntity) || aliasEntity.status === 'invalidated') continue;
    const target = canonicalById.get(resolveIdentityEntityId(aliasEntity.id, combinedProjection));
    if (!target || target.id === aliasEntity.id || target.entityType !== aliasEntity.entityType
      || target.chatId !== aliasEntity.chatId || target.narrativeGeneration !== aliasEntity.narrativeGeneration) continue;
    learned.get(target.id).push(...aliasNames(aliasEntity));
  }
  return Object.freeze(canonical.map(entity => {
    const seen = new Set();
    const labels = [];
    for (const label of [...aliasNames(entity), ...(learned.get(entity.id) ?? [])]) {
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
    });
  }));
}
