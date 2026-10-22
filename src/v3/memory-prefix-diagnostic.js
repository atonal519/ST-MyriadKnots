// 只在既有依赖比较失败后解释已持有的快照；结果不参与保存判定。
// bodyVersion 是实时或已存正文版本依据不一致，不断言原文确实被改；memoryRecord 也可能只是记录表示不同。
// snapshotUnavailable 的楼序只能作为原目标上下文，不能当成已定位的变化来源。
const CATEGORIES = new Set(['bodyVersion', 'replySelection', 'timeEvidence', 'summaryContent', 'memoryRecord', 'entityDirectory', 'entityRecord', 'userIdentity', 'identityProjection', 'promptGuidance', 'referenceConfiguration', 'sourceMapping', 'recordInformation', 'sourceUnavailable', 'snapshotUnavailable']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const json = value => JSON.stringify(value);
const names = values => [...new Set((values ?? []).map(value => typeof value === 'string' ? value : value?.name).filter(value => typeof value === 'string'))].sort();
const userMeaning = value => [typeof value?.displayName === 'string' ? value.displayName : null, names(value?.aliases), typeof value?.personaIdentifier === 'string' ? value.personaIdentifier : null];
const directoryMeaning = value => [value.entityType, value.displayName, value.specialRole, value.status, value.mergedIntoEntityId, names(value.aliases)];
const projectionMeaning = value => [Object.entries(value?.identityRedirectsByEntityId ?? {}).sort(([a], [b]) => a.localeCompare(b)), names(value?.deletedEntityIds), Object.entries(value?.manualAliasesByEntityId ?? {}).map(([id, aliases]) => [id, names(aliases)]).sort(([a], [b]) => a.localeCompare(b))];
const summaryMeaning = value => [value?.aiText, value?.userText, value?.effectiveSource];
const memoryWithoutMetadata = value => {
  if (!value) return value;
  const { id, createdAt, updatedAt, supersedes, recordStatus, ...business } = value;
  return business;
};

export function safePrefixDifference(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.categories)) return null;
  const categories = [...new Set(value.categories.slice(0, CATEGORIES.size).filter(category => CATEGORIES.has(category)))];
  if (!categories.length) return null;
  const seqs = [];
  for (const seq of Array.isArray(value.assistantSeqs) ? value.assistantSeqs : []) {
    if (positive(seq) && !seqs.includes(seq)) seqs.push(seq);
    if (seqs.length > 3) break;
  }
  const relatedFloorCount = Number.isSafeInteger(value.relatedFloorCount) && value.relatedFloorCount >= 0
    ? Math.min(value.relatedFloorCount, 1000000) : 0;
  return Object.freeze({ categories: Object.freeze(categories), assistantSeqs: Object.freeze(seqs.slice(0, 3)), relatedFloorCount,
    truncated: value.truncated === true || seqs.length > 3 || relatedFloorCount > 3 });
}

export function describePrefixDifference(before, current, unavailable = null) {
  const categories = new Set(), floors = new Set();
  const mark = (category, seq) => { categories.add(category); if (positive(seq)) floors.add(seq); };
  const targetSeq = before?.floorDependencies?.at(-1)?.assistantSeq;
  if (!before || !current) {
    mark(unavailable?.kind === 'sourceUnavailable' ? 'sourceUnavailable' : 'snapshotUnavailable', unavailable?.assistantSeq ?? targetSeq);
  } else {
    const currentFloors = new Map(current.floorDependencies.map(value => [value.id, value]));
    for (const old of before.floorDependencies) {
      const live = currentFloors.get(old.id);
      currentFloors.delete(old.id);
      if (!live) { mark('sourceMapping', old.assistantSeq); continue; }
      if (['rawFingerprint', 'canonicalFingerprint', 'liveRawFingerprint'].some(key => typeof old[key] === 'string' && typeof live[key] === 'string' && old[key] !== live[key])) mark('bodyVersion', old.assistantSeq);
      if (old.hostLocator && live.hostLocator && ['swipeId', 'selectedSwipeIndex'].some(key => Object.hasOwn(old.hostLocator, key) && Object.hasOwn(live.hostLocator, key) && old.hostLocator[key] !== live.hostLocator[key])) mark('replySelection', old.assistantSeq);
      if (old.storyClockSignature !== live.storyClockSignature) mark('timeEvidence', old.assistantSeq);
      if (['chatId', 'narrativeGeneration', 'assistantSeq', 'predecessorFloorId'].some(key => old[key] !== live[key])) mark('sourceMapping', old.assistantSeq);
    }
    for (const live of currentFloors.values()) mark('sourceMapping', live.assistantSeq);
    if (['chatId', 'targetFloorId', 'targetFloorGeneration'].some(key => before[key] !== current[key])) mark('sourceMapping', targetSeq);
    if (json(before.targetMemory) !== json(current.targetMemory)) {
      if (json(summaryMeaning(before.targetMemory?.summary)) !== json(summaryMeaning(current.targetMemory?.summary))) mark('summaryContent', targetSeq);
      else mark(json(memoryWithoutMetadata(before.targetMemory)) === json(memoryWithoutMetadata(current.targetMemory)) ? 'recordInformation' : 'memoryRecord', targetSeq);
    }
    const entities = new Map(current.scopedEntities.map(value => [value.id, value]));
    for (const old of before.scopedEntities) {
      const live = entities.get(old.id); entities.delete(old.id);
      if (!live) mark('entityRecord');
      else if (json(directoryMeaning(old)) !== json(directoryMeaning(live))) mark('entityDirectory');
    }
    if (entities.size) mark('entityRecord');
    if (json(userMeaning(before.userIdentity)) !== json(userMeaning(current.userIdentity))) mark('userIdentity');
    if (json(projectionMeaning(before.identityProjection)) !== json(projectionMeaning(current.identityProjection))) mark('identityProjection');
    if (before.promptGuidance !== current.promptGuidance) mark('promptGuidance');
    if (json(before.storyClockReferenceTags) !== json(current.storyClockReferenceTags)) mark('referenceConfiguration');
    if (!categories.size) mark('recordInformation');
  }
  const assistantSeqs = [...floors].sort((a, b) => a - b);
  return safePrefixDifference({ categories: [...categories], assistantSeqs: assistantSeqs.slice(0, 3), relatedFloorCount: floors.size, truncated: floors.size > 3 });
}
