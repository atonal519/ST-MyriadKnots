import { buildEntityIdentityDirectory } from './entity-identity.js';

// 摘要参与者包括个人和群体；知情人物等个人专用目录由调用方另行筛选。
export function buildMemoryParticipantDirectory({ entities = [], identityProjection = null } = {}) {
  return Object.freeze(buildEntityIdentityDirectory({ entities, identityProjection, includeMemberEntityIds: true })
    .filter(entry => ['person', 'group'].includes(entry.entityType) && entry.entity.recordStatus === 'active'));
}

export function memoryParticipantsForDisplay(state, memory, floor = null) {
  const entries = [...(state?.memoryEntities ?? []), ...(state?.memoryGroupEntities ?? [])];
  const byId = new Map(entries.flatMap(entry => [entry.entityId, ...(entry.memberEntityIds ?? [])].map(id => [id, entry])));
  const seen = new Set();
  return (memory?.participants ?? []).flatMap(item => {
    const entry = byId.get(item.entityId) ?? (floor?.frozen && floor.memoryEntityNames?.[item.entityId]
      ? { entityId: item.entityId, displayName: floor.memoryEntityNames[item.entityId] } : null);
    if (!entry?.displayName || seen.has(entry.entityId)) return [];
    seen.add(entry.entityId); return [entry];
  });
}

export function parseMemoryParticipantNames(value, originalNames = []) {
  const separator = /^[、,，\n]/u;
  const names = [...new Set(originalNames)].filter(name => typeof name === 'string' && name.trim()).sort((a, b) => b.length - a.length);
  const result = [];
  let rest = String(value ?? '').trim();
  while (rest) {
    if (separator.test(rest)) { rest = rest.slice(1).trimStart(); continue; }
    // 已显示的姓名可能自带顿号或逗号，编辑其他参与者时保留其完整身份名称。
    const known = names.find(name => rest.startsWith(name) && /^\s*(?:[、,，\n]|$)/u.test(rest.slice(name.length)));
    const field = known ?? rest.split(/[、,，\n]/u, 1)[0];
    const next = field.trim();
    if (next) result.push(next);
    rest = rest.slice(field.length).trimStart();
  }
  return result;
}
