import {isUuid} from '../identity.js';

export function validatePlaceSource(source) {
 const valid=ref=>ref&&typeof ref==='object'&&['body','worldbook','characterCard'].includes(ref.kind)&&typeof ref.quote==='string'&&ref.quote.length>0&&(ref.kind!=='body'||isUuid(ref.floorId));
 if(!valid(source)||source.references!==undefined&&(!Array.isArray(source.references)||source.references.some(ref=>!valid(ref)||ref.references!==undefined))||source.replacesItemIds!==undefined&&(!Array.isArray(source.replacesItemIds)||source.replacesItemIds.some(id=>!isUuid(id)))||source.knownFromFloorId!==undefined&&!isUuid(source.knownFromFloorId))throw new TypeError('地点来源格式无效。');
 return source;
}

export function locatePlaceQuote(content, quote, { allowWhitespace = false, allowOmission = false } = {}) {
  if (typeof content !== 'string' || typeof quote !== 'string' || !quote.trim()) return null;
  const offset = content.indexOf(quote);
  if (offset >= 0) return [{ quote, start: offset, end: offset + quote.length }];
  if (allowWhitespace) {
    const pattern = quote.trim().split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const matches = [...content.matchAll(new RegExp(pattern, 'gu'))];
    if (matches.length === 1) return [{ quote: matches[0][0], start: matches[0].index, end: matches[0].index + matches[0][0].length }];
  }
  if (!allowOmission) return null;
  const segments = quote.split(/\u2026+|\.{3,}/u).map(segment => segment.trim());
  if (segments.length < 2 || segments.length > 8 || segments.some(segment => !segment || segment.length > 2000)) return null;
  const located = [];
  for (const segment of segments) {
    const start = content.indexOf(segment);
    if (start < 0 || content.indexOf(segment, start + 1) >= 0 || start < (located.at(-1)?.end ?? 0)) return null;
    located.push({ quote: segment, start, end: start + segment.length });
  }
  return located;
}
import { projectVectorSources } from './vector-source.js';


export async function collectMissingPlaceSources({ entities, entityKeys, bodySources, floors, memoriesByFloor }) {
  const covered = new Set(bodySources.flatMap(source => source.placeKeys ?? []));
  const places = entities.filter(entity => entity.entityType === 'place' && entityKeys.has(entity.id));
  const needed = new Set(places.filter(entity => !covered.has(entityKeys.get(entity.id)) && entity.firstSeenFloorId).map(entity => entity.firstSeenFloorId));
  if (!needed.size) return [];
  const memories = [...new Map([...needed].flatMap(floorId => { const memory = memoriesByFloor.get(floorId); return memory ? [[memory.id, memory]] : []; })).values()];
  const { rawSources } = await projectVectorSources(memories, floors, { includeSummaries: false });
  const seen = new Set();
  return rawSources.flatMap(source => {
    if (!needed.has(source.floorId) || seen.has(source.floorId)) return [];
    seen.add(source.floorId);
    return [{ floorId: source.floorId, memoryId: source.floorMemoryId, sourceType: 'assistant', rawFingerprint: source.floorMemoryId,
      canonicalContent: source.canonicalContent, requiresExactQuote: true,
      placeKeys: places.filter(entity => entity.firstSeenFloorId === source.floorId).map(entity => entityKeys.get(entity.id)) }];
  });
}
