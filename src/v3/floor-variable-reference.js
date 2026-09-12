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
