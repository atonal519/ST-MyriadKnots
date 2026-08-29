import { readHostState } from './host-context.js';
import { isUuid } from './identity.js';
import { createStableLedger, compareStableLedgers, computeStableFloorSnapshot, sameStableLedger, STABLE_FLOOR_SCHEMA_VERSION } from './stable-floor.js';

const staleError = () => Object.assign(new Error('稳定楼运行已失效'), { stale: true });
const formalCollection = chatId => `chat-${chatId}`;
const RUNTIME_RECORD_ID = 'runtime';
const stableSummary = ledger => ledger ? { schemaVersion: ledger.schemaVersion, canonLength: ledger.entries.length, tailIdentity: ledger.entries.at(-1)?.identity ?? null, tailSignature: ledger.entries.at(-1)?.signature ?? null } : null;
const envelopeOk = record => Boolean(record && record.schemaVersion === 1 && Number.isInteger(record.revision) && record.revision > 0 && isUuid(record.generationId) && typeof record.createdAt === 'string' && record.createdAt && typeof record.updatedAt === 'string' && record.updatedAt && record.data && typeof record.data === 'object');
const recordMatches = (record, state) => Boolean(envelopeOk(record) && record.data.schemaVersion === 1 && record.data.kind === 'chat-profile' && record.data.chatId === state.chatId && isUuid(record.data.chatId) && isUuid(record.data.cardId) && isUuid(record.data.personaId) && record.data.source?.card?.locator === state.characterAvatar && record.data.source?.persona?.locator === state.personaAvatar && ['awaiting_card_type', 'ready'].includes(record.data.status) && record.data.rebuildState === 'idle');
const validStoredEntry = (entry, ordinal = null) => Boolean(entry && (ordinal === null || entry.ordinal === ordinal) && typeof entry.identity === 'string' && ['user', 'assistant'].includes(entry.role) && /^sha256:[0-9a-f]{64}$/.test(entry.contentHash) && /^sha256:[0-9a-f]{64}$/.test(entry.signature));
const validStoredLedger = (ledger, state) => {
  if (!ledger || ledger.schemaVersion !== STABLE_FLOOR_SCHEMA_VERSION || ledger.hostChatId !== state.hostChatId || ledger.personaLocator !== state.personaAvatar || !Array.isArray(ledger.entries) || !Array.isArray(ledger.checkpoints)) return false;
  if (!ledger.entries.every((entry, index) => validStoredEntry(entry, index + 1))) return false;
  let previousLength = -1;
  if (!ledger.checkpoints.every(item => {
    if (!item || !Number.isInteger(item.canonLength) || item.canonLength <= previousLength || item.canonLength < 0 || item.canonLength > ledger.entries.length) return false;
    const expectedTail = item.canonLength === 0 ? null : ledger.entries[item.canonLength - 1]?.signature;
    previousLength = item.canonLength;
    return item.tailSignature === expectedTail;
  })) return false;
  if (ledger.checkpoints[0]?.canonLength !== 0) return false;
  return ledger.provisional === null || validStoredEntry(ledger.provisional);
};
const committedResult = (status, record, change = null) => {
  const checkpoint = record?.data?.canonCheckpoint ?? null;
  return {
    status,
    revision: record?.revision ?? null,
    ledger: record?.data?.stableFloorLedger ?? null,
    provisional: record?.data?.provisional ?? null,
    checkpoint,
    changeKind: checkpoint?.changeKind ?? null,
    firstDifferenceFloor: checkpoint?.firstDifferenceFloor ?? null,
    rollbackBoundary: checkpoint?.rollbackBoundary ?? null,
    change,
  };
};
const runtimeMatches = (record, state, meta) => {
  if (!envelopeOk(record) || record.data.schemaVersion !== STABLE_FLOOR_SCHEMA_VERSION || record.data.kind !== 'stable-floor-runtime' || record.data.status !== 'ready' || record.data.chatId !== state.chatId || record.data.cardId !== meta.data.cardId || record.data.personaId !== meta.data.personaId || record.data.source?.card?.locator !== state.characterAvatar || record.data.source?.persona?.locator !== state.personaAvatar || !validStoredLedger(record.data.stableFloorLedger, state)) return false;
  const ledger = record.data.stableFloorLedger, checkpoint = record.data.canonCheckpoint;
  if (!checkpoint || checkpoint.schemaVersion !== STABLE_FLOOR_SCHEMA_VERSION || checkpoint.canonLength !== ledger.entries.length || checkpoint.tailIdentity !== (ledger.entries.at(-1)?.identity ?? null) || checkpoint.tailSignature !== (ledger.entries.at(-1)?.signature ?? null) || !Number.isInteger(checkpoint.rollbackBoundary) || checkpoint.rollbackBoundary < 0 || checkpoint.rollbackBoundary > ledger.entries.length) return false;
  return (record.data.provisional?.signature ?? null) === (ledger.provisional?.signature ?? null);
};

export function createStableFloorAdapter({ client, contextProvider, guard } = {}) {
  if (!client || typeof client.get !== 'function' || typeof client.put !== 'function') throw new Error('稳定楼后端客户端不可用');
  if (typeof contextProvider !== 'function') throw new Error('稳定楼宿主上下文不可用');
  let generation = 0;
  let invalidationEpoch = 0;
  let serial = Promise.resolve();
  const committed = new Map();
  const snapshot = () => {
    const ctx = contextProvider();
    const state = readHostState(ctx);
    return { ctx, state, fingerprint: state.ok ? `${state.hostChatId}|${state.chatId}|${state.characterAvatar}|${state.personaAvatar}` : 'invalid' };
  };
  const begin = () => ({ token: ++generation, ...snapshot() });
  const check = run => {
    const current = snapshot();
    if (run.token !== generation || !run.state.ok || current.fingerprint !== run.fingerprint) throw staleError();
    if (typeof guard === 'function') guard();
  };
  const readRecord = async (run, recordId, allowMissing = false) => {
    let record;
    try { record = await client.get(formalCollection(run.state.chatId), recordId); }
    catch (error) { if (allowMissing && error.status === 404) { check(run); return null; } throw error; }
    check(run);
    return record;
  };
  const remember = (state, record) => {
    if (envelopeOk(record) && record.data?.kind === 'stable-floor-runtime') committed.set(state.chatId, record);
    return record;
  };
  async function refreshRun(run) {
    if (!run.state.ok || !run.state.chatId) return { status: 'stopped', reason: run.state.reason ?? '正式聊天尚未初始化' };
    const stable = await computeStableFloorSnapshot(run.ctx.chat);
    check(run);
    const meta = await readRecord(run, 'meta');
    if (!recordMatches(meta, run.state)) return committedResult('mismatch', committed.get(run.state.chatId));
    const record = await readRecord(run, RUNTIME_RECORD_ID, true);
    if (record && !runtimeMatches(record, run.state, meta)) return committedResult('invalid_ledger', committed.get(run.state.chatId));
    if (record) remember(run.state, record);
    if (stable.status !== 'ready') return { ...committedResult('invalid_host_history', record ?? committed.get(run.state.chatId)), errors: stable.errors };
    const previous = record?.data?.stableFloorLedger ?? { entries: [], checkpoints: [], provisional: null };
    const change = compareStableLedgers(previous, stable);
    const nextLedger = createStableLedger(stable, run.state);
    if (sameStableLedger(previous, nextLedger)) return committedResult('unchanged', record, change);
    const canonCheckpoint = {
      schemaVersion: STABLE_FLOOR_SCHEMA_VERSION,
      ...stableSummary(nextLedger),
      changeKind: change.kind,
      firstDifferenceFloor: change.firstDifferenceFloor,
      rollbackBoundary: change.rollbackBoundary,
    };
    const nextData = { schemaVersion: STABLE_FLOOR_SCHEMA_VERSION, kind: 'stable-floor-runtime', chatId: run.state.chatId, cardId: meta.data.cardId, personaId: meta.data.personaId, source: { card: { locator: run.state.characterAvatar }, persona: { locator: run.state.personaAvatar } }, stableFloorLedger: nextLedger, canonCheckpoint, provisional: nextLedger.provisional, status: 'ready' };
    try {
      check(run);
      await client.put(formalCollection(run.state.chatId), RUNTIME_RECORD_ID, nextData, record?.revision ?? 0);
      check(run);
      const reread = await readRecord(run, RUNTIME_RECORD_ID);
      if (!runtimeMatches(reread, run.state, meta) || !sameStableLedger(reread.data.stableFloorLedger, nextLedger)) return committedResult('conflict', committed.get(run.state.chatId), change);
      remember(run.state, reread);
      return committedResult(change.kind === 'unchanged' ? 'provisional_updated' : 'ready', reread, change);
    } catch (error) {
      if (error.stale) throw error;
      if (error.status !== 409) throw error;
      check(run);
      const winner = await readRecord(run, RUNTIME_RECORD_ID);
      if (!runtimeMatches(winner, run.state, meta)) return committedResult('mismatch', committed.get(run.state.chatId), change);
      remember(run.state, winner);
      return sameStableLedger(winner.data.stableFloorLedger, nextLedger) ? committedResult('ready', winner, change) : committedResult('conflict', winner, change);
    }
  }
  const enqueue = operation => { const task = serial.then(operation, operation); serial = task.catch(() => {}); return task; };
  const refresh = () => {
    const entryEpoch = invalidationEpoch;
    return enqueue(async () => {
      if (entryEpoch !== invalidationEpoch) return { status: 'stale' };
      const run = begin();
      try { return await refreshRun(run); }
      catch (error) {
        if (error.stale) return { status: 'stale' };
        return { ...committedResult('storage_error', committed.get(run.state.chatId)), error: String(error?.message || error) };
      }
    });
  };
  return {
    refresh,
    getCommittedState: () => {
      const state = readHostState(contextProvider());
      return state.ok && state.chatId ? committedResult('cached', committed.get(state.chatId)) : { status: 'stopped' };
    },
    invalidate: () => { generation += 1; invalidationEpoch += 1; },
  };
}
