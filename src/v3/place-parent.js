const parentOf = value => value?.parents?.size === 1 ? value.parents.keys().next().value : null;

// A batch describes containment constraints. Resolve their nearest supported parent
// before ranking genuinely different ownership claims against the previous tree.
export function resolvePlaceParentBatch(intents, { previous = new Map(), manual = new Map(), preservePreviousRefinements = true } = {}) {
  const groups = new Map();
  for (const intent of intents) {
    if (!intent.placeEntityId || intent.parentEntityId === undefined) continue;
    const rows = groups.get(intent.placeEntityId) ?? [];
    rows.push(intent); groups.set(intent.placeEntityId, rows);
  }
  const graph = new Map();
  for (const [id, value] of previous) graph.set(id, new Set(value.parents.keys()));
  for (const [id, rows] of groups) {
    const revisions = rows.filter(row => row.identityChange === 'ownershipChanged');
    graph.set(id, new Set([...(revisions.length ? [] : graph.get(id) ?? []), ...(revisions.length ? revisions : rows).map(row => row.parentEntityId)].filter(Boolean)));
  }
  for (const [id, parents] of manual) graph.set(id, new Set(parents.keys()));
  const reaches = (start, target, excluded) => {
    const pending = [start], seen = new Set([excluded]);
    while (pending.length) {
      const current = pending.pop();
      if (!current || seen.has(current)) continue;
      if (current === target) return true;
      seen.add(current); pending.push(...graph.get(current) ?? []);
    }
    return false;
  };
  const updates = new Map(), rejected = new Set();
  for (const [child, rows] of groups) {
    const revisions = rows.filter(row => row.identityChange === 'ownershipChanged');
    const prior = previous.get(child);
    const candidates = [...(revisions.length ? revisions : rows)];
    if (preservePreviousRefinements && !revisions.length && prior?.parents.size === 1) candidates.push({ placeEntityId: child, parentEntityId: parentOf(prior), prior: true });
    const nearest = candidates.filter(candidate => !candidate.parentEntityId || !candidates.some(other => other.parentEntityId
      && other.parentEntityId !== candidate.parentEntityId && reaches(other.parentEntityId, candidate.parentEntityId, child)
      && !reaches(candidate.parentEntityId, other.parentEntityId, child)));
    const fresh = nearest.filter(row => !row.prior);
    if (!fresh.length) { updates.set(child, prior); continue; }
    const authority = Math.max(...fresh.map(row => row.authority ?? 0));
    const selected = fresh.filter(row => (row.authority ?? 0) === authority);
    const parents = new Map(selected.map(row => [row.parentEntityId, row.origin ?? row]));
    if (parents.size !== 1 || parents.has(child)) {
      rejected.add(child); updates.set(child, prior ?? { parents: new Map() });
    } else updates.set(child, parents.has(null) ? { parents: new Map(), cleared: true } : { parents });
  }
  // Reject every new edge in a cycle together. Replaying a different array order
  // must not choose a different winner or erase the previous legal branch.
  let changed = true;
  while (changed) {
    changed = false;
    const current = new Map([...previous, ...updates, ...[...manual].map(([id, parents]) => [id, { parents }])]);
    for (const start of updates.keys()) {
      const path = [], offsets = new Map(); let id = start;
      while (id && current.has(id)) {
        if (offsets.has(id)) {
          for (const child of path.slice(offsets.get(id))) if (groups.has(child) && !manual.has(child) && !rejected.has(child)) {
            rejected.add(child); updates.set(child, previous.get(child) ?? { parents: new Map() }); changed = true;
          }
          break;
        }
        offsets.set(id, path.length); path.push(id); id = parentOf(current.get(id));
      }
    }
  }
  const compatible = new Set(intents.filter(intent => {
    if (rejected.has(intent.placeEntityId)) return false;
    const selected = updates.get(intent.placeEntityId);
    const parent = parentOf(selected);
    if (intent.parentEntityId === null) return selected?.cleared === true;
    return parent === intent.parentEntityId || Boolean(parent && reaches(parent, intent.parentEntityId, intent.placeEntityId)
      && !reaches(intent.parentEntityId, parent, intent.placeEntityId));
  }));
  return { updates, rejected, compatible };
}
