// Browse state is local UI state; the parent graph remains authoritative and unchanged.
export function projectQianchuangBrowse(snapshot, requestedScope) {
  const places = snapshot.places ?? [], byId = new Map(places.map(place => [place.entityId, place]));
  const roots = (snapshot.mapRootIds ?? []).filter(id => byId.has(id));
  const hinted = places.some(place => ['area','site'].includes(place.mapRole));
  const areaContainer = node => node && (node.mapRole === 'area' || !node.mapRole && (node.childEntityIds ?? []).some(id => byId.get(id)?.mapRole === 'area'));
  let scopeId = requestedScope;
  if (scopeId && (!byId.has(scopeId) || byId.get(scopeId).mapRole === 'interior')) scopeId = undefined;
  if (scopeId === undefined) {
    const root=roots.length===1?byId.get(roots[0]):null;
    scopeId = hinted && areaContainer(root) ? root.entityId : null;
    while (scopeId) {
      const children = byId.get(scopeId).childEntityIds ?? [];
      if (children.length !== 1 || byId.get(children[0])?.mapRole !== 'area') break;
      scopeId = children[0];
    }
  }
  const scope = byId.get(scopeId), ids = scope ? scope.childEntityIds ?? [] : roots;
  const groups = [];
  const sitesBelow = id => {
    const node = byId.get(id); if (!node || node.mapRole === 'interior') return [];
    if (!areaContainer(node)) return [id];
    return (node.childEntityIds ?? []).flatMap(sitesBelow);
  };
  if (!hinted) {
    groups.push({ entityId: null, siteIds: ids.filter(id => byId.has(id) && byId.get(id).mapRole !== 'interior') });
  } else if (scope?.mapRole === 'site') {
    groups.push({ entityId: null, siteIds: [scopeId] });
  } else {
    const direct = [];
    for (const id of ids) {
      const node = byId.get(id); if (!node) continue;
      if (node.mapRole === 'interior') continue;
      if (areaContainer(node)) groups.push({ entityId: id, siteIds: sitesBelow(id) });
      else direct.push(id); // Untyped legacy places keep their map presence in mixed trees.

    }
    // An area with child regions is the map scope, not an extra child region.
    if (direct.length) groups.push({ entityId: scope?.mapRole === 'area' && !groups.length ? scopeId : null, siteIds: direct });
  }
  const pinIds = [...new Set(groups.flatMap(group => group.siteIds))];
  const trail = []; let ancestor = scope;
  while (ancestor) { trail.unshift(ancestor.entityId); ancestor = byId.get(ancestor.parentEntityId); }
  return { scopeId, groups, pinIds, treeRootIds: (scope?.mapRole === 'site' ? [scopeId] : ids).filter(id => byId.has(id)), trail };
}
