import { sha256 } from '../identity.js';
import { memorySourceFloorIds } from './memory-schema.js';

// 合并摘要的归档锚点与片段实际来源分开保存；人工摘要不从旧原文补回用户删去的内容。
export async function projectVectorSources(memories, floors) {
  const floorById = new Map(floors.map(floor => [floor.id, floor]));
  const sources = [];
  for (const memory of memories) {
    if (memory.summary?.effectiveSource === 'user') continue;
    const anchor = floorById.get(memory.floorId);
    if (!anchor) continue;
    for (const floorId of memorySourceFloorIds(memory)) {
      const floor = floorById.get(floorId);
      const snapshot = memory.sourceFloorSnapshots?.find(value => value.floorId === floorId);
      const canonicalContent = snapshot?.canonicalContent ?? (floorId === memory.floorId ? memory.sourceCanonicalContent : null);
      if (!floor || typeof canonicalContent !== 'string' || !canonicalContent.trim()
        || typeof floor.content?.canonicalContent === 'string' && canonicalContent !== floor.content.canonicalContent) continue;
      sources.push(Object.freeze({
        floorId, assistantSeq: floor.assistantSeq, floorMemoryId: memory.id,
        memoryFloorId: anchor.id, memoryAssistantSeq: anchor.assistantSeq, canonicalContent,
        fingerprint: `sha256:${await sha256(canonicalContent)}`,
      }));
    }
  }
  return Object.freeze(sources);
}

export function rawWitnessShape(value) {
  return Boolean(value && ['floorId', 'floorMemoryId', 'memoryFloorId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 500)
    && Number.isSafeInteger(value.assistantSeq) && value.assistantSeq > 0
    && Number.isSafeInteger(value.memoryAssistantSeq) && value.memoryAssistantSeq > 0
    && Number.isSafeInteger(value.offset) && value.offset >= 0
    && Number.isSafeInteger(value.length) && value.length > 0 && value.length <= 400
    && /^sha256:[a-f0-9]{64}$/u.test(value.fingerprint ?? '') && /^sha256:[a-f0-9]{64}$/u.test(value.textFingerprint ?? ''));
}

export async function rawWitnessValid(value, source) {
  if (!rawWitnessShape(value)) return false;
  const raw = (source?.rawSources ?? []).find(raw => raw.floorId === value.floorId && raw.assistantSeq === value.assistantSeq
    && raw.floorMemoryId === value.floorMemoryId && raw.memoryFloorId === value.memoryFloorId && raw.memoryAssistantSeq === value.memoryAssistantSeq && raw.fingerprint === value.fingerprint);
  if (!raw || value.offset + value.length > raw.canonicalContent.length) return false;
  return value.textFingerprint === `sha256:${await sha256(raw.canonicalContent.slice(value.offset, value.offset + value.length))}`;
}
