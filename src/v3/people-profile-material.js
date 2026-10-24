import { auxiliaryStateSnapshotForPrompt } from './floor-variable-reference.js';

export const yieldProfileWork = () => new Promise(resolve => setTimeout(resolve, 0));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Quotes are shared, while each fact keeps its own attribution and meaning.
export function createPeopleEvidenceProjection({ floorSequence, fallbackFloorId, resolveEntityId = id => id, onEntityReference = () => {} } = {}) {
  const sources = [], indexes = new Map();
  const addSource = (source, quotedText, manual = null) => {
    if (typeof quotedText !== 'string' || !quotedText.trim()) return null;
    const floorId = source.floorId ?? source.sourceFloorId ?? fallbackFloorId;
    const knownEntityIds = manual ? (manual.knownEntityIds ?? []).map(resolveEntityId) : [];
    knownEntityIds.forEach(onEntityReference);
    const location = manual ? { manual: true, carrier: manual.carrier, knownEntityIds }
      : { sourceType: source.sourceType ?? 'assistant', ...(source.sourceType === 'precedingUser' ? { sourceSnapshotIndex: source.sourceSnapshotIndex } : {}) };
    const key = JSON.stringify([floorId, location, quotedText]);
    if (!indexes.has(key)) {
      indexes.set(key, sources.length + 1);
      sources.push(Object.freeze({ sourceFloor: floorSequence?.get(floorId) ?? null, ...location, quotedText }));
    }
    return indexes.get(key);
  };
  const evidence = refs => (refs ?? []).flatMap(ref => {
    const sourceIndex = addSource(ref, ref.quotedText);
    const sourceEntityId = resolveEntityId(ref.sourceEntityId ?? null);
    onEntityReference(sourceEntityId);
    return sourceIndex === null ? [] : [{ sourceIndex, occurrence: ref.occurrence,
      evidenceMode: ref.evidenceMode, supports: ref.supports, sourceEntityId }];
  });
  const anchor = item => {
    const sourceIndex = addSource(item, item.exactText, item.manual === true ? item : null);
    return sourceIndex === null ? null : { sourceIndex, occurrence: item.occurrence };
  };
  return { sources, evidence, anchor };
}

function variableChanges(previous, current, path = [], changes = []) {
  if (previous === current) return changes;
  if (object(previous) && object(current)) {
    for (const key of Object.keys(previous)) if (!Object.hasOwn(current, key)) changes.push({ path: [...path, key], delete: true });
    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(previous, key)) changes.push({ path: [...path, key], value: current[key] });
      else variableChanges(previous[key], current[key], [...path, key], changes);
    }
  } else if (!Array.isArray(previous) || !Array.isArray(current) || JSON.stringify(previous) !== JSON.stringify(current)) {
    changes.push({ path, value: current });
  }
  return changes;
}

// 基准只沿真正有快照的原材料推进；空changes也保留当楼的来源关系。
export async function compactPeopleHistory(history, yieldWork = yieldProfileWork) {
  const output = [];
  let previous, previousFloor, hasPrevious = false;
  for (let index = 0; index < history.length; index++) {
    const item = history[index];
    if (Object.hasOwn(item, 'auxiliaryStateSnapshot')) {
      const current = auxiliaryStateSnapshotForPrompt(item.auxiliaryStateSnapshot);
      const { auxiliaryStateSnapshot: _snapshot, ...rest } = item;
      output.push(hasPrevious ? { ...rest, auxiliaryStateChanges: { fromSourceFloor: previousFloor, changes: variableChanges(previous, current) } }
        : { ...rest, auxiliaryStateSnapshot: current });
      previous = current; previousFloor = item.sourceFloor; hasPrevious = true;
    } else output.push(item);
    if ((index + 1) % 16 === 0) await yieldWork();
  }
  return output;
}

export function splitProfileSource(value, maximum) {
  const text = String(value ?? ''), parts = [];
  let start = 0, characters = 0, end = 0;
  while (end < text.length) {
    const high = text.charCodeAt(end), low = text.charCodeAt(end + 1);
    end += high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
    if (++characters === maximum) { parts.push(text.slice(start, end)); start = end; characters = 0; }
  }
  if (start < text.length || !parts.length) parts.push(text.slice(start));
  return parts;
}

function signatureWriter() {
  let length = 0, left = 0x811c9dc5, right = 0x9e3779b9;
  return {
    append(text) {
      for (let index = 0; index < text.length; index++, length++) {
        const code = text.charCodeAt(index);
        left = Math.imul(left ^ code, 0x01000193) >>> 0;
        right = Math.imul((right + code + length) >>> 0, 0x85ebca6b) >>> 0;
      }
    },
    value: () => `people-material-v1:${length}:${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`,
  };
}

// 已保存JSON材料的原签名字节/顺序不变，只避免先生成一份整包长字符串。
export function peopleMaterialSignature(value) {
  const writer = signatureWriter();
  if (Array.isArray(value)) {
    writer.append('[');
    value.forEach((item, index) => { if (index) writer.append(','); writer.append(JSON.stringify(item) ?? 'null'); });
    writer.append(']');
  } else writer.append(JSON.stringify(value));
  return writer.value();
}

export async function collectPeopleHistory(entries, yieldWork = yieldProfileWork) {
  const history = [], writer = signatureWriter();
  writer.append('[');
  let visited = 0;
  for (const entry of entries) {
    if (entry) {
      if (history.length) writer.append(',');
      writer.append(JSON.stringify(entry)); history.push(entry);
    }
    if (++visited % 16 === 0) await yieldWork();
  }
  writer.append(']');
  return { history: Object.freeze(history), signature: writer.value() };
}
