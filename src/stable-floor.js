import { sha256 } from './identity.js';

export const STABLE_FLOOR_SCHEMA_VERSION = 1;
const CHECKPOINT_INTERVAL = 25;
const MAX_CHECKPOINTS = 128;

const invalid = (sourceIndex, code) => ({ sourceIndex, code });
const text = value => typeof value === 'string' ? value : null;
const normalizedText = value => value.replace(/\r\n?/g, '\n');
const roleOf = message => message?.is_system ? 'system' : message?.is_user ? 'user' : 'assistant';
const normalizedDate = value => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return '';
};

function creationDateOf(message, role) {
  if (role === 'assistant' && Array.isArray(message.swipe_info)) {
    const first = message.swipe_info[0];
    const swipeDate = normalizedDate(first?.send_date);
    if (swipeDate) return swipeDate;
    return '';
  }
  return normalizedDate(message.send_date);
}

function selectedAssistantContent(message) {
  const swipeId = message.swipe_id === undefined ? 0 : Number(message.swipe_id);
  if (!Number.isInteger(swipeId) || swipeId < 0) return { error: 'INVALID_SWIPE_ID' };
  if (Array.isArray(message.swipes)) {
    const selected = text(message.swipes[swipeId]);
    if (selected === null) return { error: 'MISSING_SELECTED_SWIPE' };
    if (text(message.mes) !== null && normalizedText(message.mes) !== normalizedText(selected)) return { error: 'TRANSIENT_SWIPE_MISMATCH' };
    return { swipeId, content: selected };
  }
  const content = text(message.mes);
  return content === null ? { error: 'MISSING_CONTENT' } : { swipeId, content };
}

function sameEntries(left = [], right = []) {
  return left.length === right.length && left.every((entry, index) => entry.signature === right[index]?.signature);
}

function sameProvisional(left, right) {
  if (!left || !right) return left === right;
  return left.signature === right.signature;
}

function firstDifference(previous = [], current = []) {
  const limit = Math.min(previous.length, current.length);
  let index = 0;
  while (index < limit && previous[index].signature === current[index].signature) index += 1;
  return index;
}

function isDeletionAt(previous, current, index) {
  const count = previous.length - current.length;
  if (count <= 0) return false;
  return sameEntries(previous.slice(index + count), current.slice(index));
}

function classifyDifference(previous, current, index) {
  if (index === previous.length && index === current.length) return 'unchanged';
  if (index === previous.length && current.length > previous.length) return 'append';
  if (current.length < previous.length && isDeletionAt(previous, current, index)) return index === current.length ? 'tail_delete' : 'middle_delete';
  const before = previous[index], after = current[index];
  if (before?.identity === after?.identity) {
    if (before.swipeId !== after.swipeId) return 'stable_swipe';
    if (before.contentHash !== after.contentHash) return 'edit';
  }
  return 'history_changed';
}

export function buildCheckpoints(entries, interval = CHECKPOINT_INTERVAL) {
  const checkpoints = [{ canonLength: 0, tailSignature: null }];
  for (let length = interval; length < entries.length; length += interval) checkpoints.push({ canonLength: length, tailSignature: entries[length - 1].signature });
  if (entries.length > 0) checkpoints.push({ canonLength: entries.length, tailSignature: entries.at(-1).signature });
  if (checkpoints.length <= MAX_CHECKPOINTS) return checkpoints;
  return [checkpoints[0], ...checkpoints.slice(-(MAX_CHECKPOINTS - 1))];
}

export function findRollbackBoundary(checkpoints, firstDifferenceIndex) {
  const target = Math.max(0, Number.isInteger(firstDifferenceIndex) ? firstDifferenceIndex : 0);
  let boundary = 0;
  for (const checkpoint of Array.isArray(checkpoints) ? checkpoints : []) {
    if (Number.isInteger(checkpoint?.canonLength) && checkpoint.canonLength <= target && checkpoint.canonLength >= boundary) boundary = checkpoint.canonLength;
  }
  return boundary;
}

export function compareStableLedgers(previousLedger, currentSnapshot) {
  const previous = Array.isArray(previousLedger?.entries) ? previousLedger.entries : [];
  const current = Array.isArray(currentSnapshot?.canon) ? currentSnapshot.canon : [];
  const firstDifferenceIndex = firstDifference(previous, current);
  const kind = classifyDifference(previous, current, firstDifferenceIndex);
  const rollbackBoundary = ['unchanged', 'append'].includes(kind) ? previous.length : findRollbackBoundary(previousLedger?.checkpoints, firstDifferenceIndex);
  return {
    kind,
    firstDifferenceIndex: kind === 'unchanged' ? null : firstDifferenceIndex,
    firstDifferenceFloor: kind === 'unchanged' ? null : firstDifferenceIndex + 1,
    rollbackBoundary,
    appendedCount: kind === 'append' ? current.length - previous.length : 0,
    removedCount: ['tail_delete', 'middle_delete'].includes(kind) ? previous.length - current.length : 0,
    canonChanged: kind !== 'unchanged',
    provisionalChanged: !sameProvisional(previousLedger?.provisional ?? null, currentSnapshot?.provisional ?? null),
  };
}

export async function computeStableFloorSnapshot(messages) {
  if (!Array.isArray(messages)) return { status: 'invalid', errors: [invalid(null, 'CHAT_NOT_ARRAY')], canon: [], provisional: null };
  const errors = [];
  const candidates = [];
  const anchorCounts = new Map();
  let firstPlayableSeen = false;
  for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex += 1) {
    const message = messages[sourceIndex];
    if (!message || typeof message !== 'object') { errors.push(invalid(sourceIndex, 'MESSAGE_NOT_OBJECT')); continue; }
    if (typeof message.is_user !== 'boolean') { errors.push(invalid(sourceIndex, 'MISSING_ROLE')); continue; }
    const role = roleOf(message);
    if (role === 'system') continue;
    if (!firstPlayableSeen) {
      firstPlayableSeen = true;
      if (role === 'assistant') continue;
    }
    const creationDate = creationDateOf(message, role);
    if (!creationDate) { errors.push(invalid(sourceIndex, 'MISSING_CREATION_DATE')); continue; }
    const selected = role === 'assistant' ? selectedAssistantContent(message) : { swipeId: null, content: text(message.mes) };
    if (selected.error) { errors.push(invalid(sourceIndex, selected.error)); continue; }
    if (selected.content === null) { errors.push(invalid(sourceIndex, 'MISSING_CONTENT')); continue; }
    const content = normalizedText(selected.content);
    if (!content.trim()) { errors.push(invalid(sourceIndex, 'EMPTY_CONTENT')); continue; }
    const actor = [message.name, message.force_avatar, message.original_avatar].map(value => String(value ?? '').trim()).join('|');
    const baseAnchor = `${role}\u0000${creationDate}\u0000${actor}`;
    const occurrence = (anchorCounts.get(baseAnchor) ?? 0) + 1;
    anchorCounts.set(baseAnchor, occurrence);
    const [anchorHash, contentHash] = await Promise.all([sha256(baseAnchor), sha256(content)]);
    // Luker exposes only a mutable array index, not a permanent floor UUID.
    // The timestamp/role/actor anchor plus an occurrence discriminator is the
    // conservative fallback; sourceIndex is deliberately excluded.
    const identity = `composite:${anchorHash}:${occurrence}`;
    const signature = await sha256(`${identity}\u0000${role}\u0000${selected.swipeId ?? '-'}\u0000${contentHash}`);
    candidates.push({ identity, role, sourceIndex, ordinal: candidates.length + 1, creationDate, swipeId: selected.swipeId, contentHash: `sha256:${contentHash}`, signature: `sha256:${signature}` });
  }
  if (errors.length) return { status: 'invalid', errors, canon: [], provisional: null };
  const lastUserIndex = candidates.findLastIndex(entry => entry.role === 'user');
  const unaccepted = candidates.slice(lastUserIndex + 1);
  if (unaccepted.length > 1) return { status: 'invalid', errors: [invalid(unaccepted[0].sourceIndex, 'AMBIGUOUS_UNACCEPTED_TAIL')], canon: [], provisional: null };
  const provisional = unaccepted[0]?.role === 'assistant' ? unaccepted[0] : null;
  const canon = provisional ? candidates.slice(0, -1) : candidates;
  return { status: 'ready', canon, provisional };
}

export function createStableLedger(snapshot, context = {}) {
  const compact = (entry, ordinal) => ({ identity: entry.identity, role: entry.role, ordinal, creationDate: entry.creationDate, swipeId: entry.swipeId, contentHash: entry.contentHash, signature: entry.signature });
  const entries = snapshot.canon.map((entry, index) => compact(entry, index + 1));
  return {
    schemaVersion: STABLE_FLOOR_SCHEMA_VERSION,
    hostChatId: String(context.hostChatId ?? ''),
    personaLocator: String(context.personaAvatar ?? ''),
    entries,
    checkpoints: buildCheckpoints(entries),
    provisional: snapshot.provisional ? compact(snapshot.provisional, snapshot.provisional.ordinal) : null,
  };
}

export function sameStableLedger(left, right) {
  return Boolean(left && right && left.schemaVersion === STABLE_FLOOR_SCHEMA_VERSION && left.hostChatId === right.hostChatId && left.personaLocator === right.personaLocator && sameEntries(left.entries, right.entries) && sameProvisional(left.provisional, right.provisional));
}
