import { selectUserStabilityAnchor, selectAssistantMessage } from './foundation-domain.js';
import { sanitizeMemoryContent } from '../memory-content-sanitizer.js';

function selectedUserInput(message) {
  if (!selectUserStabilityAnchor(message)) return null;
  if (Array.isArray(message.swipes)) {
    const selectedSwipeIndex = Number.isSafeInteger(message.swipe_id) ? message.swipe_id : 0;
    const content = message.swipes[selectedSwipeIndex];
    if (typeof content !== 'string') return null;
    return Object.freeze({ content: content.replace(/\r\n?/g, '\n'), swipeId: message.swipe_id ?? selectedSwipeIndex, selectedSwipeIndex });
  }
  if (typeof message.mes !== 'string') return null;
  return Object.freeze({ content: message.mes.replace(/\r\n?/g, '\n'), swipeId: message.swipe_id ?? null, selectedSwipeIndex: null });
}

export function capturePrecedingUserInputFromSnapshot(snapshot, floor, options) {
  const expectedChatId = floor?.chatId;
  if (String(snapshot.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim() !== expectedChatId) return null;
  const targetIndex = floor?.hostLocator?.messageIndex;
  if (!Number.isSafeInteger(targetIndex) || !selectAssistantMessage(snapshot.chat?.[targetIndex])) return null;
  const messages = [];
  for (let messageIndex = targetIndex - 1; messageIndex >= 0; messageIndex -= 1) {
    const selected = selectedUserInput(snapshot.chat?.[messageIndex]);
    if (!selected) break;
    const content = sanitizeMemoryContent(selected.content, options);
    if (!content) break;
    messages.push(Object.freeze({ content, messageIndex, swipeId: selected.swipeId, selectedSwipeIndex: selected.selectedSwipeIndex }));
    if (messages.length >= 40) break;
  }
  messages.reverse();
  return messages.length ? Object.freeze({ messages: Object.freeze(messages) }) : null;
}

// A history source only owns the USER snapshot saved for that exact source floor.
export function storedSourceUserInput(memory, floorId = memory?.floorId) {
  if (!memory) return null;
  const ids = memory.sourceFloorIds ?? [memory.floorId];
  if (ids.length > 1) return memory.sourceFloorSnapshots?.find(source => source.floorId === floorId)?.sourceUserInputSnapshot ?? null;
  return ids[0] === floorId ? memory.sourceUserInputSnapshot ?? null : null;
}

export function memoriesBySourceFloor(memories = []) {
  return new Map(memories.filter(memory => memory.recordStatus === 'active')
    .flatMap(memory => (memory.sourceFloorIds ?? [memory.floorId]).map(floorId => [floorId, memory])));
}
