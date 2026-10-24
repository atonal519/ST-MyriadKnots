function jsonObjectCopy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const copy = JSON.parse(JSON.stringify(value));
    return copy && typeof copy === 'object' && !Array.isArray(copy) && Object.keys(copy).length
      ? copy
      : null;
  } catch {
    return null;
  }
}

export function copyFloorVariableReference(value) {
  return jsonObjectCopy(value);
}

export function captureFloorVariableReference(snapshot, floor) {
  const messageIndex = floor?.hostLocator?.messageIndex;
  if (!Number.isSafeInteger(messageIndex) || messageIndex < 0) return null;
  const message = snapshot?.chat?.[messageIndex];
  if (!message || typeof message !== 'object' || message.is_user !== false) return null;
  const selectedSwipeIndex = Number.isSafeInteger(message.swipe_id)
    ? message.swipe_id
    : (Number.isSafeInteger(floor?.hostLocator?.selectedSwipeIndex) ? floor.hostLocator.selectedSwipeIndex : 0);
  if (Number.isSafeInteger(floor?.hostLocator?.selectedSwipeIndex)
    && floor.hostLocator.selectedSwipeIndex !== selectedSwipeIndex) return null;
  const slots = message.variables;
  if (!slots || typeof slots !== 'object') return null;
  return jsonObjectCopy(slots[selectedSwipeIndex]);
}

export function auxiliaryStateSnapshotForPrompt(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const schema = snapshot.schema, statData = snapshot.stat_data;
  const structuralSchema = schema && typeof schema === 'object' && !Array.isArray(schema)
    && schema.type === 'object' && schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties);
  if (!statData || typeof statData !== 'object' || Array.isArray(statData) || !structuralSchema) return snapshot;
  // 仅将识别出的顶层 MVU schema 作为请求元数据省略；原变量快照和嵌套业务字段保持不变。
  const { schema: _schema, ...snapshotWithoutSchema } = snapshot;
  return snapshotWithoutSchema;
}
