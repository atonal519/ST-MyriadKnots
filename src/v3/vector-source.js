import { sha256 } from '../identity.js';
import { memorySourceFloorIds } from './memory-schema.js';

// 合并摘要的归档锚点与片段实际来源分开保存；人工摘要不从旧原文补回用户删去的内容。
export async function projectVectorSources(memories, floors) {
  const floorById = new Map(floors.map(floor => [floor.id, floor]));
  const sources = [], summarySources = [];
  for (const memory of memories) {
    const anchor = floorById.get(memory.floorId);
    if (!anchor) continue;
    if (memory.summary?.effectiveSource === 'user') {
      const userText = String(memory.summary.userText ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
      const canonicalContent = summaryCandidateText(userText);
      if (canonicalContent) summarySources.push(Object.freeze({
        sourceKind: 'userSummary', floorId: anchor.id, assistantSeq: anchor.assistantSeq, floorMemoryId: memory.id,
        memoryFloorId: anchor.id, memoryAssistantSeq: anchor.assistantSeq, canonicalContent,
        fingerprint: `sha256:${await sha256(canonicalContent)}`,
      }));
      continue;
    }
    const sourceFloorIds = memorySourceFloorIds(memory);
    for (const floorId of sourceFloorIds) {
      const floor = floorById.get(floorId);
      const snapshot = memory.sourceFloorSnapshots?.find(value => value.floorId === floorId);
      // 旧单楼可用同楼已保存原文补缺；聚合楼仍只信各成员的专用快照。
      const canonicalContent = snapshot?.canonicalContent ?? (floorId === memory.floorId
        ? memory.sourceCanonicalContent ?? (sourceFloorIds.length === 1 ? floor?.content?.canonicalContent : null)
        : null);
      if (!floor || typeof canonicalContent !== 'string' || !canonicalContent.trim()
        || typeof floor.content?.canonicalContent === 'string' && canonicalContent !== floor.content.canonicalContent) continue;
      sources.push(Object.freeze({
        floorId, assistantSeq: floor.assistantSeq, floorMemoryId: memory.id,
        memoryFloorId: anchor.id, memoryAssistantSeq: anchor.assistantSeq, canonicalContent,
        fingerprint: `sha256:${await sha256(canonicalContent)}`,
      }));
    }
  }
  return Object.freeze({ rawSources: Object.freeze(sources), summarySources: Object.freeze(summarySources) });
}

export function summaryCandidateText(value) {
  const fullText = String(value ?? '').normalize('NFKC').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12000);
  return fullText.length > 2000 ? `${fullText.slice(0, 1988)}…（摘要已截断）` : fullText;
}

export function rawWitnessShape(value) {
  return Boolean(value && ['floorId', 'floorMemoryId', 'memoryFloorId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 500)
    && Number.isSafeInteger(value.assistantSeq) && value.assistantSeq > 0
    && Number.isSafeInteger(value.memoryAssistantSeq) && value.memoryAssistantSeq > 0
    && Number.isSafeInteger(value.offset) && value.offset >= 0
    && Number.isSafeInteger(value.length) && value.length > 0 && value.length <= 400
    && /^sha256:[a-f0-9]{64}$/u.test(value.fingerprint ?? '') && /^sha256:[a-f0-9]{64}$/u.test(value.textFingerprint ?? ''));
}

export function summaryWitnessShape(value) {
  return Boolean(value && value.sourceKind === 'userSummary'
    && ['floorId', 'floorMemoryId', 'memoryFloorId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 500)
    && Number.isSafeInteger(value.assistantSeq) && value.assistantSeq > 0
    && Number.isSafeInteger(value.memoryAssistantSeq) && value.memoryAssistantSeq > 0
    && Number.isSafeInteger(value.offset) && value.offset >= 0
    && Number.isSafeInteger(value.length) && value.length > 0 && value.length <= 400
    && /^sha256:[a-f0-9]{64}$/u.test(value.fingerprint ?? '') && /^sha256:[a-f0-9]{64}$/u.test(value.textFingerprint ?? ''));
}

export const vectorWitnessShape = value => rawWitnessShape(value) || summaryWitnessShape(value);

export async function rawWitnessValid(value, source) {
  if (!rawWitnessShape(value)) return false;
  const raw = (source?.rawSources ?? []).find(raw => raw.floorId === value.floorId && raw.assistantSeq === value.assistantSeq
    && raw.floorMemoryId === value.floorMemoryId && raw.memoryFloorId === value.memoryFloorId && raw.memoryAssistantSeq === value.memoryAssistantSeq && raw.fingerprint === value.fingerprint);
  if (!raw || value.offset + value.length > raw.canonicalContent.length) return false;
  return value.textFingerprint === `sha256:${await sha256(raw.canonicalContent.slice(value.offset, value.offset + value.length))}`;
}

export async function summaryWitnessValid(value, source) {
  if (!summaryWitnessShape(value)) return false;
  const summary = (source?.summarySources ?? []).find(item => item.sourceKind === value.sourceKind && item.floorId === value.floorId
    && item.assistantSeq === value.assistantSeq && item.floorMemoryId === value.floorMemoryId && item.memoryFloorId === value.memoryFloorId
    && item.memoryAssistantSeq === value.memoryAssistantSeq && item.fingerprint === value.fingerprint);
  if (!summary || value.offset + value.length > summary.canonicalContent.length) return false;
  return value.textFingerprint === `sha256:${await sha256(summary.canonicalContent.slice(value.offset, value.offset + value.length))}`;
}
