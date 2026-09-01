import { createArchiveV2MemorySnapshot } from './archive-v2-memory-foundation.js';

export async function readArchiveV2ReadyMemory({ raw, memoryStore, operation } = {}) {
  if (!Array.isArray(raw?.chat)) throw new TypeError('当前聊天正文不可用');
  if (typeof memoryStore?.readManifest !== 'function'
    || typeof memoryStore?.readReadyBatches !== 'function'
    || typeof memoryStore?.readPeopleResult !== 'function') {
    throw new TypeError('memoryStore 无效');
  }
  if (typeof operation?.current !== 'function' || typeof operation?.status !== 'function') {
    throw new TypeError('operation 无效');
  }

  const read = await memoryStore.readManifest();
  if (!operation.current()) return { status: operation.status() };
  if (read?.status !== 'ready' || read.manifest.status !== 'ready') {
    return { status: read?.status === 'ready' ? 'memory_not_ready' : (read?.status ?? 'memory_not_ready') };
  }
  const snapshot = await createArchiveV2MemorySnapshot({
    ...raw,
    chat: raw.chat.slice(0, read.manifest.targetFloor + 1),
  });
  if (!operation.current()) return { status: operation.status() };
  if (snapshot.sourceFingerprint !== read.manifest.sourceFingerprint
    || snapshot.batches.length !== read.manifest.totalBatches) return { status: 'source_changed' };
  const ready = await memoryStore.readReadyBatches({ manifest: read.manifest, plans: snapshot.batches });
  if (!operation.current()) return { status: operation.status() };
  if (ready?.status !== 'ready') return { status: ready?.status ?? 'memory_not_ready' };
  const people = await memoryStore.readPeopleResult(ready);
  if (!operation.current()) return { status: operation.status() };
  if (people?.status !== 'ready') {
    return { status: people?.status === 'missing' ? 'people_missing' : (people?.status ?? 'people_missing') };
  }
  return { ...ready, peopleResult: people.result };
}
