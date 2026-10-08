import { projectVectorSources } from './vector-source.js';
import { selectRecallMemories } from './recall-source.js';

function sameRootVersion(rootResult, reachable, targetChatId) {
  const root = rootResult?.data, cachedRoot = reachable?.root;
  return rootResult?.status === 'ready' && ['ready', 'needsReseal'].includes(reachable?.status)
    && root?.chatId === targetChatId && cachedRoot?.chatId === targetChatId
    && rootResult.revision === reachable.rootRevision
    && root.headCheckpointId === cachedRoot.headCheckpointId
    && root.narrativeGeneration === cachedRoot.narrativeGeneration
    && root.sourceSnapshotFingerprint === cachedRoot.sourceSnapshotFingerprint;
}

// A fresh root read is cheap; only borrow a graph already validated for that exact root.
export async function readVectorSource({ store, targetIdentity, cachedReachable = null } = {}) {
  if (!store || typeof store.readRoot !== 'function' || typeof store.readReachable !== 'function') {
    throw new TypeError('V3 vector source store 无效');
  }
  const chatId = targetIdentity?.chatId;
  if (typeof chatId !== 'string' || !chatId) throw new TypeError('V3 vector source target 无效');
  const rootResult = await store.readRoot();
  let source, exitPoint;
  if (sameRootVersion(rootResult, cachedReachable, chatId)) {
    source = cachedReachable;
    exitPoint = 'validatedSnapshot';
  } else {
    source = await store.readReachable({ mode: 'projection', allowRecallCseFallback: true });
    exitPoint = source?.status === 'stale' ? 'stale' : ['ready', 'needsReseal'].includes(source?.status) ? 'ready' : 'unavailable';
  }
  const sourceReadAttempts = Object.freeze({ lightweightRootReads: 1,
    reachableReads: exitPoint === 'validatedSnapshot' ? 0 : 1, exitPoint });
  if (!['ready', 'needsReseal'].includes(source?.status) || !source.root || !source.checkpoint
    || source.root.chatId !== chatId) {
    return Object.freeze({ status: source?.status === 'stale' ? 'stale' : 'unavailable', sourceReadAttempts });
  }
  const { floors, activeMemories } = selectRecallMemories(source);
  const { rawSources } = await projectVectorSources(activeMemories, floors, { includeSummaries: false });
  return Object.freeze({ status: 'ready', chatId: source.root.chatId,
    narrativeGeneration: source.root.narrativeGeneration, headCheckpointId: source.root.headCheckpointId,
    rootRevision: source.rootRevision, sourceSnapshotFingerprint: source.root.sourceSnapshotFingerprint,
    rawSources, sourceReadAttempts });
}
