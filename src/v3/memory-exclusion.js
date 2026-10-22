export const MESSAGE_MEMORY_EXCLUSION_KEY = 'qianqianjie_memory_excluded';

export function isMemoryExcludedMessage(message) {
  return message?.extra?.[MESSAGE_MEMORY_EXCLUSION_KEY] === true;
}

export function isMemoryExcludedFloor(floor, chat, checkpoint = null, { frozen = false } = {}) {
  const witness = checkpoint?.inputFingerprints?.[Number.isSafeInteger(floor?.assistantSeq) ? floor.assistantSeq - 1 : -1];
  if (frozen) return witness?.floorId === floor?.id && witness.memoryExcluded === true;
  const messageIndex = floor?.hostLocator?.messageIndex;
  if (Array.isArray(chat) && Number.isSafeInteger(messageIndex) && messageIndex >= 0 && messageIndex < chat.length) {
    return isMemoryExcludedMessage(chat[messageIndex]);
  }
  return witness?.floorId === floor?.id && witness.memoryExcluded === true;
}
