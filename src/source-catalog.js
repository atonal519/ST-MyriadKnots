import { newUuid, readHostState } from './host-context.js';
import { sha256 } from './identity.js';

export const SOURCE_CATALOG_SCHEMA_VERSION = 1;
export const SOURCE_CATALOG_RECORD_ID = 'people-source-catalog';
const KIND = 'people-source-catalog';
const STAGES = new Set(['draft', 'confirmed', 'completed', 'failed']);
const PERMITS = new Set(['none', 'ready', 'in_flight', 'consumed', 'failed']);
const SOURCE_KINDS = new Set(['card', 'greeting', 'worldbook']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const envelope = record => object(record) && record.schemaVersion === 1 && Number.isInteger(record.revision) && record.revision > 0 && uuid(record.generationId) && object(record.data);
const clone = value => JSON.parse(JSON.stringify(value));
const stale = () => Object.assign(new Error('来源整理请求已失效'), { stale: true });
const fail = (message, code = 'SOURCE_CATALOG_INVALID') => Object.assign(new Error(message), { failClosed: true, code });
const collection = chatId => `chat-${chatId}`;
const sourceKey = source => `${source.kind}:${source.locator}`;

const validSource = source => object(source) && SOURCE_KINDS.has(source.kind)
  && typeof source.locator === 'string' && source.locator.length > 0 && source.locator.length <= 300
  && typeof source.fingerprint === 'string' && /^sha256:[0-9a-f]{64}$/.test(source.fingerprint)
  && typeof source.content === 'string';
const validCandidate = candidate => object(candidate) && typeof candidate.id === 'string' && candidate.id === sourceKey(candidate)
  && validSource(candidate) && typeof candidate.label === 'string' && candidate.label.length > 0 && candidate.label.length <= 240
  && ['card', 'greeting', 'activated', 'enabled', 'disabled'].includes(candidate.availability)
  && typeof candidate.selected === 'boolean' && typeof candidate.activated === 'boolean' && typeof candidate.linked === 'boolean'
  && (candidate.availability !== 'disabled' || candidate.selected === false);
const validBinding = (data, state, formalState = null) => data.chatId === state.chatId && data.hostChatId === state.hostChatId
  && data.characterAvatar === state.characterAvatar && data.personaAvatar === state.personaAvatar
  && (!formalState?.cardId || data.cardId === formalState.cardId) && (!formalState?.personaId || data.personaId === formalState.personaId);
const validData = data => object(data) && data.schemaVersion === SOURCE_CATALOG_SCHEMA_VERSION && data.kind === KIND
  && uuid(data.chatId) && uuid(data.cardId) && uuid(data.personaId) && typeof data.hostChatId === 'string'
  && typeof data.characterAvatar === 'string' && data.characterAvatar.length > 0 && typeof data.personaAvatar === 'string' && data.personaAvatar.length > 0
  && STAGES.has(data.stage) && Array.isArray(data.candidates) && data.candidates.every(validCandidate)
  && new Set(data.candidates.map(item => item.id)).size === data.candidates.length
  && Array.isArray(data.confirmedSources) && data.confirmedSources.every(validSource)
  && new Set(data.confirmedSources.map(sourceKey)).size === data.confirmedSources.length
  && object(data.permit) && PERMITS.has(data.permit.status)
  && (data.permit.operationId === undefined || uuid(data.permit.operationId))
  && (data.overallFingerprint === '' || /^sha256:[0-9a-f]{64}$/.test(data.overallFingerprint));

async function fingerprintSources(sources) {
  return `sha256:${await sha256(sources.map(item => `${item.kind}\n${item.locator}\n${item.fingerprint}\n${item.content}`).join('\n'))}`;
}

function stateView(record) {
  if (!record) return { status: 'uninitialized', stage: 'uninitialized', candidates: [], confirmedSources: [], permit: { status: 'none' } };
  return { status: 'ready', revision: record.revision, ...clone(record.data) };
}

export function createSourceCatalogAdapter({ client, contextProvider, formal, routeSource, isEnabled = () => true } = {}) {
  if (!client?.get || !client?.put || typeof contextProvider !== 'function' || typeof routeSource?.collectSourceCatalogCandidates !== 'function') throw new Error('人物来源资料库依赖不可用');
  let generation = 0, serial = Promise.resolve(), observedBinding = null;
  const issuedClaims = new WeakMap();
  const snapshot = () => {
    const ctx = contextProvider() || {}, state = readHostState(ctx);
    return { ctx, state, fingerprint: state.ok ? `${state.hostChatId}|${state.chatId}|${state.characterAvatar}|${state.personaAvatar}` : 'invalid' };
  };
  const begin = () => {
    const current = snapshot();
    const binding = observedBinding?.fingerprint === current.fingerprint
      ? { cardId: observedBinding.cardId, personaId: observedBinding.personaId }
      : null;
    return { token: generation, ...current, binding };
  };
  const check = run => { const now = snapshot(); if (!isEnabled() || run.token !== generation || !run.state.ok || now.fingerprint !== run.fingerprint) throw stale(); };
  const enqueue = operation => { const task = serial.then(operation, operation); serial = task.catch(() => {}); return task; };
  const read = async run => {
    try { const record = await client.get(collection(run.state.chatId), SOURCE_CATALOG_RECORD_ID); check(run); return record; }
    catch (error) { if (error.status === 404) { check(run); return null; } throw error; }
  };
  const formalState = async (run, supplied = null) => {
    const value = supplied || await formal?.getFormalState?.(); check(run);
    const personaId = value?.formal?.personaId ?? value?.personaId ?? run.ctx?.chatMetadata?.qianqianjie?.personaId;
    if (!['ready', 'route_ready'].includes(value?.status) || !uuid(value?.cardId) || !uuid(personaId)) throw fail('正式档案尚未准备好', 'SOURCE_CATALOG_FORMAL_UNAVAILABLE');
    if (run.binding && (run.binding.cardId !== value.cardId || run.binding.personaId !== personaId)) throw stale();
    observedBinding = { fingerprint: run.fingerprint, cardId: value.cardId, personaId };
    return { ...value, personaId };
  };
  const assertRecord = (record, run, currentFormal = null) => {
    if (!envelope(record) || !validData(record.data) || !validBinding(record.data, run.state, currentFormal)) throw fail('人物来源资料记录与当前聊天不一致');
    if (run.binding && (run.binding.cardId !== record.data.cardId || run.binding.personaId !== record.data.personaId)) throw stale();
    observedBinding = { fingerprint: run.fingerprint, cardId: record.data.cardId, personaId: record.data.personaId };
    return record;
  };
  const put = async (run, data, revision) => {
    check(run); const record = await client.put(collection(run.state.chatId), SOURCE_CATALOG_RECORD_ID, data, revision); check(run);
    return assertRecord(record, run, { cardId: data.cardId, personaId: data.personaId });
  };

  async function getStateRun(run, suppliedFormal = null) {
    if (!run.state.ok) return { status: 'mismatch', stage: 'uninitialized' };
    const record = await read(run);
    if (!record) return stateView(null);
    const currentFormal = suppliedFormal?.cardId ? suppliedFormal : null;
    return stateView(assertRecord(record, run, currentFormal));
  }

  async function startRun(run, suppliedFormal = null) {
    if (!run.state.ok) return { status: 'mismatch', stage: 'uninitialized' };
    const currentFormal = await formalState(run, suppliedFormal), existing = await read(run);
    if (existing) return stateView(assertRecord(existing, run, currentFormal));
    const collected = await routeSource.collectSourceCatalogCandidates(); check(run);
    const candidates = Array.isArray(collected?.candidates) ? collected.candidates : [];
    if (!candidates.length || !candidates.every(validCandidate)) throw fail('没有可用于人物识别的本地来源', 'SOURCE_CATALOG_EMPTY');
    const data = {
      schemaVersion: SOURCE_CATALOG_SCHEMA_VERSION, kind: KIND, chatId: run.state.chatId, hostChatId: run.state.hostChatId,
      cardId: currentFormal.cardId, personaId: currentFormal.personaId, characterAvatar: run.state.characterAvatar, personaAvatar: run.state.personaAvatar,
      stage: 'draft', candidates: clone(candidates), confirmedSources: [], overallFingerprint: '', permit: { status: 'none' },
      warnings: Array.isArray(collected.warnings) ? collected.warnings.slice(0, 40) : [],
    };
    try { return stateView(await put(run, data, 0)); }
    catch (error) { if (error.status !== 409) throw error; const winner = await read(run); return stateView(assertRecord(winner, run, currentFormal)); }
  }

  async function selectRun(run, id, selected) {
    const currentFormal = await formalState(run), record = assertRecord(await read(run), run, currentFormal);
    if (record.data.stage !== 'draft') return stateView(record);
    const candidate = record.data.candidates.find(item => item.id === id);
    if (!candidate || candidate.availability === 'disabled') return stateView(record);
    const data = { ...clone(record.data), candidates: record.data.candidates.map(item => item.id === id ? { ...item, selected: selected === true } : item) };
    try { return stateView(await put(run, data, record.revision)); }
    catch (error) { if (error.status !== 409) throw error; return stateView(assertRecord(await read(run), run)); }
  }

  async function confirmRun(run) {
    const currentFormal = await formalState(run), record = assertRecord(await read(run), run, currentFormal);
    if (record.data.stage !== 'draft') return stateView(record);
    const confirmedSources = record.data.candidates.filter(item => item.selected && item.availability !== 'disabled').map(({ kind, locator, fingerprint, content }) => ({ kind, locator, fingerprint, content }));
    if (!confirmedSources.length) throw fail('请至少勾选一份来源资料', 'SOURCE_CATALOG_EMPTY_SELECTION');
    const overallFingerprint = await fingerprintSources(confirmedSources); check(run);
    const data = { ...clone(record.data), stage: 'confirmed', confirmedSources, overallFingerprint, permit: { status: 'ready', operationId: newUuid() }, errorCode: undefined };
    try { return stateView(await put(run, data, record.revision)); }
    catch (error) { if (error.status !== 409) throw error; return stateView(assertRecord(await read(run), run)); }
  }

  async function retryRun(run) {
    const currentFormal = await formalState(run), record = assertRecord(await read(run), run, currentFormal);
    if (!['failed', 'confirmed'].includes(record.data.stage) || !['failed', 'in_flight'].includes(record.data.permit.status)) return stateView(record);
    const data = { ...clone(record.data), stage: 'confirmed', permit: { status: 'ready', operationId: newUuid() }, errorCode: undefined };
    try { return stateView(await put(run, data, record.revision)); }
    catch (error) { if (error.status !== 409) throw error; return stateView(assertRecord(await read(run), run)); }
  }

  async function claimRun(run) {
    const currentFormal = await formalState(run), record = assertRecord(await read(run), run, currentFormal);
    if (record.data.stage !== 'confirmed' || record.data.permit.status !== 'ready' || !uuid(record.data.permit.operationId)) return { status: 'not_ready', catalog: stateView(record) };
    const operationId = record.data.permit.operationId;
    const data = { ...clone(record.data), permit: { status: 'in_flight', operationId } };
    try {
      const saved = await put(run, data, record.revision);
      const claim = { status: 'claimed', operationId, revision: saved.revision, sources: clone(saved.data.confirmedSources), overallFingerprint: saved.data.overallFingerprint, binding: { chatId: saved.data.chatId, cardId: saved.data.cardId, personaId: saved.data.personaId } };
      issuedClaims.set(claim, { token: run.token, fingerprint: run.fingerprint, operationId });
      return claim;
    } catch (error) {
      if (error.status !== 409) throw error;
      return { status: 'not_ready', catalog: stateView(assertRecord(await read(run), run)) };
    }
  }

  async function finishRun(run, operationId, success, errorCode = '') {
    const currentFormal = await formalState(run), record = assertRecord(await read(run), run, currentFormal);
    if (record.data.permit.status !== 'in_flight' || record.data.permit.operationId !== operationId) return stateView(record);
    const data = {
      ...clone(record.data), stage: success ? 'completed' : 'failed', permit: { status: success ? 'consumed' : 'failed', operationId },
      ...(success ? { errorCode: undefined } : { errorCode: String(errorCode || 'identify_failed').slice(0, 80) }),
    };
    try { return stateView(await put(run, data, record.revision)); }
    catch (error) { if (error.status !== 409) throw error; return stateView(assertRecord(await read(run), run)); }
  }

  async function confirmedRun(run, suppliedFormal = null) {
    const record = await read(run);
    if (!record) return null;
    assertRecord(record, run, suppliedFormal);
    if (!['confirmed', 'completed', 'failed'].includes(record.data.stage) || !record.data.confirmedSources.length) return null;
    return { sources: clone(record.data.confirmedSources), overallFingerprint: record.data.overallFingerprint, binding: { chatId: record.data.chatId, cardId: record.data.cardId, personaId: record.data.personaId }, stage: record.data.stage, permit: clone(record.data.permit) };
  }

  const execute = operation => {
    const run = begin();
    return enqueue(async () => { try { return await operation(run); } catch (error) { if (error.stale) return { status: 'stale' }; throw error; } });
  };
  return {
    getState: ({ formalState: supplied } = {}) => execute(run => getStateRun(run, supplied)),
    start: ({ formalState: supplied } = {}) => execute(run => startRun(run, supplied)),
    setSelected: ({ id, selected } = {}) => execute(run => selectRun(run, String(id || ''), selected)),
    confirm: () => execute(confirmRun), retry: () => execute(retryRun), claimRecognition: () => execute(claimRun),
    completeRecognition: ({ operationId } = {}) => execute(run => finishRun(run, operationId, true)),
    failRecognition: ({ operationId, errorCode } = {}) => execute(run => finishRun(run, operationId, false, errorCode)),
    getConfirmedSources: ({ formalState: supplied } = {}) => execute(run => confirmedRun(run, supplied)),
    readCurrentRawSources: () => execute(run => confirmedRun(run)),
    readRawSourcesByRefs: ({ refs } = {}) => execute(async run => { const value = await confirmedRun(run); if (!value) return []; const keys = new Set((Array.isArray(refs) ? refs : []).map(item => typeof item === 'string' ? item : sourceKey(item))); return value.sources.filter(item => keys.has(sourceKey(item))); }),
    consumeRecognitionClaim: claim => {
      const issued = object(claim) ? issuedClaims.get(claim) : null;
      if (object(claim)) issuedClaims.delete(claim);
      const now = snapshot();
      return Boolean(issued && isEnabled() && issued.token === generation && issued.fingerprint === now.fingerprint
        && claim.status === 'claimed' && claim.operationId === issued.operationId);
    },
    invalidate: () => { generation += 1; observedBinding = null; },
  };
}
