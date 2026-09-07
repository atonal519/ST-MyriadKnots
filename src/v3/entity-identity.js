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

export function buildEntityIdentityDirectory({ entities = [], floorIds = null } = {}) {
  const scoped = entitiesThroughFloorIds(entities, floorIds);
  const isActive = entity => entity?.recordStatus === undefined || entity.recordStatus === 'active';
  const canonical = scoped.filter(entity => isActive(entity) && entity.status !== 'merged' && entity.status !== 'invalidated');
  const canonicalById = new Map(canonical.map(entity => [entity.id, entity]));
  const learned = new Map(canonical.map(entity => [entity.id, []]));
  for (const aliasEntity of scoped) {
    if (!isActive(aliasEntity) || aliasEntity.status !== 'merged') continue;
    const target = canonicalById.get(aliasEntity.mergedIntoEntityId);
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
