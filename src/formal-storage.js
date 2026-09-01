import { collections } from './constants.js';
import { identityIds, isUuid } from './identity.js';
import { readHostState } from './host-context.js';
import { compareRouteKey, ROUTE_DIAGNOSTICS, sameRouteSnapshot } from './route-source.js';

export const CARD_TYPES = Object.freeze(['single', 'multi', 'open_world', 'simulator']);
const DEMO_SOURCE = 'qianqianjie-demo-v1';
const staleError = () => Object.assign(new Error('正式运行已失效'), { stale: true });
const validationError = message => Object.assign(new Error(message), { failClosed: true });
const safeDiagnostic = value => ROUTE_DIAGNOSTICS.includes(value) ? value : 'UNKNOWN';
const routeUnavailable = (diagnosticCode, cardType) => ({ status: 'route_unavailable', diagnosticCode: safeDiagnostic(diagnosticCode), ...(cardType ? { cardType } : {}) });
const positiveRevision = value => Number.isInteger(value) && value > 0;
const validTimestamp = value => typeof value === 'string' && value.length > 0;
const validEnvelope = record => Boolean(record && record.schemaVersion === 1 && positiveRevision(record.revision) && isUuid(record.generationId) && validTimestamp(record.createdAt) && validTimestamp(record.updatedAt) && record.data && typeof record.data === 'object');
const assertUuid = (value, label) => { if (!isUuid(value)) throw validationError(`${label} UUID 无效`); return value; };
const assertPathPart = (value, label) => { assertUuid(value, label); if (value.includes('/') || value.length > 128) throw validationError(`${label} 路径无效`); return value; };
const formalCollection = chatId => `chat-${assertPathPart(chatId, '聊天')}`;

export function formalKeys(chatId, cardId) {
  const keys = { chatCollection: formalCollection(chatId), metaRecordId: 'meta', cardCollection: 'cards' };
  if (cardId !== undefined) keys.cardRecordId = assertPathPart(cardId, '卡');
  return keys;
}

function validMetaShape(data, expected, requestedType) {
  if (!data || data.schemaVersion !== 1 || data.kind !== 'chat-profile') return false;
  if (data.chatId !== expected.chatId || !isUuid(data.chatId) || !isUuid(data.cardId) || !isUuid(data.personaId)) return false;
  if (data.source?.card?.locator !== expected.characterAvatar || data.source?.persona?.locator !== expected.personaAvatar) return false;
  if (!['uninitialized', 'ready'].includes(data.route?.state) || data.rebuildState !== 'idle') return false;
  if (data.route?.state === 'ready' && !validRoute(data.route)) return false;
  if (data.migration?.source !== DEMO_SOURCE || data.migration?.state !== 'complete') return false;
  const revisions = data.migration.sourceRevisions;
  if (!positiveRevision(revisions?.chatMeta) || !positiveRevision(revisions?.cardMapping) || !positiveRevision(revisions?.personaMapping)) return false;
  if (data.status === 'awaiting_card_type') { if (data.cardType !== null) return false; }
  else if (data.status === 'ready') { if (!CARD_TYPES.includes(data.cardType)) return false; }
  else return false;
  return requestedType === undefined || (data.status === 'ready' && data.cardType === requestedType);
}
function validRoute(route) {
  const greeting = route?.greeting;
  if (!greeting || greeting.floor !== 0 || !Number.isInteger(greeting.swipeId) || greeting.swipeId < 0 || typeof greeting.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(greeting.fingerprint)) return false;
  if (!Array.isArray(route.worldInfoEntries)) return false;
  let previous = '';
  for (const entry of route.worldInfoEntries) {
    if (!entry || typeof entry.world !== 'string' || !entry.world || typeof entry.uid !== 'string' || !entry.uid || typeof entry.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entry.fingerprint)) return false;
    const key = `${entry.world}\u0000${entry.uid}`;
    if (compareRouteKey(key, previous) <= 0) return false;
    previous = key;
  }
  return true;
}
const validMetaRecord = (record, expected, requestedType) => validEnvelope(record) && validMetaShape(record.data, expected, requestedType);
const isPersonaOnlyMismatch = (record, expected, requestedType) => {
  if (!validEnvelope(record)) return false;
  const boundLocator = typeof record.data?.source?.persona?.locator === 'string' ? record.data.source.persona.locator : '';
  if (!boundLocator || boundLocator === expected.personaAvatar) return false;
  return validMetaShape(record.data, { ...expected, personaAvatar: boundLocator }, requestedType);
};
const validMetaWinner = (record, expected, base, authority, requestedType) => validMetaRecord(record, expected, requestedType) && record.data.chatId === base.chatId && record.data.cardId === base.cardId && record.data.personaId === base.personaId && record.data.source.card.locator === base.source.card.locator && record.data.source.persona.locator === base.source.persona.locator && (!authority || (record.data.chatId === authority.demo.data.chatId && record.data.cardId === authority.demo.data.cardId && record.data.personaId === authority.demo.data.personaId && record.data.source.card.locator === expected.characterAvatar && record.data.source.persona.locator === expected.personaAvatar));
const validRouteWinner = (record, expected, base, authority, route) => validMetaWinner(record, expected, base, authority) && record.data.route?.state === 'ready' && sameRouteSnapshot(record.data.route, route);

function validCard(data, meta, characterAvatar, requestedType) {
  return Boolean(data && data.schemaVersion === 1 && data.kind === 'card-profile' && data.cardId === meta.cardId && isUuid(data.cardId) && data.sourceLocator === characterAvatar && data.boundPersonaId === meta.personaId && isUuid(data.boundPersonaId) && data.cardType === requestedType && CARD_TYPES.includes(data.cardType) && data.status === 'initialized' && data.lifecycle === 'active');
}
const validCardRecord = (record, meta, characterAvatar, requestedType) => validEnvelope(record) && validCard(record.data, meta, characterAvatar, requestedType);

const cleanState = (state, formal = null) => ({
  chatId: state.chatId,
  characterAvatar: state.characterAvatar,
  personaAvatar: state.personaAvatar,
  ...(formal?.data && isUuid(formal.data.cardId) ? { cardId: formal.data.cardId, personaId: formal.data.personaId, cardType: formal.data.cardType ?? null } : {}),
  formal: formal ? { status: formal.status, cardType: formal.data?.cardType ?? null } : null,
});

export function createFormalAdapter({ client, contextProvider, guard, routeSource } = {}) {
  if (!client || typeof client.get !== 'function' || typeof client.put !== 'function') throw new Error('正式后端客户端不可用');
  if (typeof contextProvider !== 'function') throw new Error('正式宿主上下文不可用');
  let generation = 0, invalidationEpoch = 0;
  let serial = Promise.resolve();
  const snapshot = () => { const state = readHostState(contextProvider()); return { state, fingerprint: state.ok ? `${state.hostChatId}|${state.chatId}|${state.characterAvatar}|${state.personaAvatar}` : 'invalid' }; };
  const begin = () => { const current = snapshot(); return { token: ++generation, ...current }; };
  const check = run => { const current = snapshot(); if (run.token !== generation || !run.state.ok || current.fingerprint !== run.fingerprint) throw staleError(); if (typeof guard === 'function') guard(); };
  const enqueue = operation => { const task = serial.then(operation, operation); serial = task.catch(() => {}); return task; };
  const enqueueCurrent = operation => {
    const entryEpoch = invalidationEpoch;
    return enqueue(() => entryEpoch === invalidationEpoch ? operation() : { status: 'stale' });
  };

  async function getDemoAuthority(run) {
    const ids = await identityIds(run.state); check(run);
    const settled = await Promise.allSettled([
      client.get(collections.chats, run.state.chatId),
      client.get(collections.cards, ids.cardRecordId),
      client.get(collections.personas, ids.personaRecordId),
    ]);
    check(run);
    // 请求并发发出，但裁决严格保持旧串行顺序：chat → card → persona。
    // 较早的 404 会终止旧路径，因此不得被较晚请求的 500 抢先覆盖。
    for (const result of settled) {
      if (result.status === 'fulfilled') continue;
      if (result.reason?.status === 404) return null;
      throw result.reason;
    }
    const [demo, cardMap, personaMap] = settled.map(result => result.value);
    const validMap = (r, kind, locator) => r?.data?.schemaVersion === 1 && r.data.kind === kind && r.data.avatar === locator && isUuid(r.data.identityId) && positiveRevision(r.revision);
    if (!validMap(cardMap, 'identity-card', run.state.characterAvatar) || !validMap(personaMap, 'identity-persona', run.state.personaAvatar) || demo?.data?.schemaVersion !== 1 || demo.data.kind !== 'chat-demo-profile' || demo.data.chatId !== run.state.chatId || !isUuid(demo.data.cardId) || !isUuid(demo.data.personaId) || demo.data.cardId !== cardMap.data.identityId || demo.data.personaId !== personaMap.data.identityId || demo.data.source?.characterAvatar !== run.state.characterAvatar || demo.data.source?.personaAvatar !== run.state.personaAvatar || !positiveRevision(demo.revision)) throw validationError('Demo 档案不可迁移');
    return { demo, cardMap, personaMap };
  }
  async function readMeta(run) { const keys = formalKeys(run.state.chatId); try { const record = await client.get(keys.chatCollection, keys.metaRecordId); check(run); return record; } catch (e) { if (e.status === 404) { check(run); return null; } throw e; } }
  async function initializeRouteRun(run, record, base = record.data, authority = null) {
    if (!routeSource?.collect || record.data.status !== 'ready') return { status: record.data.status, record };
    if (record.data.route?.state === 'ready') return { status: 'ready', record };
    let route;
    try { check(run); route = await routeSource.collect(); check(run); }
    catch (error) { if (error.stale) throw error; return routeUnavailable(error.diagnosticCode); }
    if (!validRoute(route)) return routeUnavailable('ROUTE_INVALID');
    const next = { ...record.data, route }; const keys = formalKeys(run.state.chatId);
    try {
      check(run); await client.put(keys.chatCollection, keys.metaRecordId, next, record.revision); check(run);
      const reread = await readMeta(run);
      if (!reread || !validRouteWinner(reread, run.state, base, authority, route)) return { status: 'route_mismatch', record: reread };
      return { status: 'route_ready', record: reread };
    } catch (error) {
      if (error.status !== 409) throw error;
      check(run); const winner = await readMeta(run);
      if (!winner || !validRouteWinner(winner, run.state, base, authority, route)) return { status: 'route_mismatch', record: winner };
      return { status: 'route_ready', record: winner };
    }
  }
  async function migrateMeta(run, authority) {
    if (!authority) throw validationError('Demo 档案不完整，无法迁移');
    const { demo, cardMap, personaMap } = authority;
    const data = { schemaVersion: 1, kind: 'chat-profile', chatId: run.state.chatId, cardId: demo.data.cardId, personaId: demo.data.personaId, source: { card: { locator: run.state.characterAvatar }, persona: { locator: run.state.personaAvatar } }, cardType: null, route: { state: 'uninitialized' }, parentChatId: null, forkFloor: null, canonCheckpoint: null, provisional: null, status: 'awaiting_card_type', rebuildState: 'idle', migration: { source: DEMO_SOURCE, state: 'complete', sourceRevisions: { chatMeta: demo.revision, cardMapping: cardMap.revision, personaMapping: personaMap.revision } } };
    if (!validMetaShape(data, run.state)) throw validationError('正式聊天档案无效');
    const keys = formalKeys(run.state.chatId);
    try { check(run); await client.put(keys.chatCollection, keys.metaRecordId, data, 0); check(run); const record = await readMeta(run); if (!record || !validMetaRecord(record, run.state) || record.data.chatId !== authority.demo.data.chatId || record.data.cardId !== authority.demo.data.cardId || record.data.personaId !== authority.demo.data.personaId) return { conflict: true }; return { record, migrated: true }; }
    catch (e) { if (e.status !== 409) throw e; check(run); const winner = await readMeta(run); if (!winner || !validMetaRecord(winner, run.state) || winner.data.chatId !== authority.demo.data.chatId || winner.data.cardId !== authority.demo.data.cardId || winner.data.personaId !== authority.demo.data.personaId || winner.data.source.card.locator !== run.state.characterAvatar || winner.data.source.persona.locator !== run.state.personaAvatar) return { conflict: true }; return { record: winner, migrated: false }; }
  }
  async function formalStateRun(run) {
    if (!run.state.ok || !run.state.chatId) return { status: 'stopped', reason: run.state.reason ?? '正式聊天尚未初始化' };
    const [metaResult, authorityResult] = await Promise.allSettled([readMeta(run), getDemoAuthority(run)]);
    if (metaResult.status === 'rejected') throw metaResult.reason;
    const record = metaResult.value; let result;
    if (record && !validMetaRecord(record, run.state)) return { status: 'mismatch', ...(isPersonaOnlyMismatch(record, run.state) ? { mismatchReason: 'persona' } : {}), ...cleanState(run.state) };
    if (authorityResult.status === 'rejected') throw authorityResult.reason;
    const authority = authorityResult.value;
    if (record) {
      if (authority && (record.data.cardId !== authority.demo.data.cardId || record.data.personaId !== authority.demo.data.personaId)) return { status: 'mismatch', ...cleanState(run.state) };
      result = { record, migrated: false };
    } else result = await migrateMeta(run, authority);
    if (result.conflict) return { status: 'mismatch', ...cleanState(run.state) };
    const routeResult = await initializeRouteRun(run, result.record, result.record.data, authority);
    if (routeResult.status === 'route_unavailable') return { ...routeResult, formal: { status: 'ready', cardType: result.record.data.cardType } };
    return { status: result.migrated ? 'migrated' : routeResult.status, ...cleanState(run.state, routeResult.record), route: routeResult.record?.data?.route ?? null };
  }
  async function initializeCardRun(run, cardType) {
    if (!CARD_TYPES.includes(cardType)) return { status: 'invalid_card_type' };
    if (!run.state.ok || !run.state.chatId) return { status: 'stopped', reason: run.state.reason ?? '正式聊天尚未初始化' };
    const [metaResult, authorityResult] = await Promise.allSettled([readMeta(run), getDemoAuthority(run)]);
    if (metaResult.status === 'rejected') throw metaResult.reason;
    const meta = metaResult.value;
    if (!meta || !validMetaRecord(meta, run.state)) return { status: meta ? 'mismatch' : 'not_initialized', ...(meta && isPersonaOnlyMismatch(meta, run.state) ? { mismatchReason: 'persona' } : {}) };
    if (authorityResult.status === 'rejected') throw authorityResult.reason;
    const authority = authorityResult.value;
    if (authority && (meta.data.cardId !== authority.demo.data.cardId || meta.data.personaId !== authority.demo.data.personaId)) return { status: 'mismatch' };
    const keys = formalKeys(run.state.chatId, meta.data.cardId); let card;
    try {
      card = await client.get(keys.cardCollection, keys.cardRecordId); check(run);
      if (!validCardRecord(card, meta.data, run.state.characterAvatar, cardType)) return { status: 'conflict' };
      if (meta.data.status === 'ready' && meta.data.cardType === cardType) { const routeResult = await initializeRouteRun(run, meta, meta.data, authority); if (routeResult.status === 'route_unavailable') return routeUnavailable(routeResult.diagnosticCode, cardType); return { status: routeResult.status, cardType, route: routeResult.record?.data?.route ?? null }; }
    } catch (e) {
      if (e.status !== 404) throw e;
      const data = { schemaVersion: 1, kind: 'card-profile', cardId: meta.data.cardId, cardType, boundPersonaId: meta.data.personaId, sourceLocator: run.state.characterAvatar, sourceFacts: [], userFacts: [], interpretations: [], status: 'initialized', lifecycle: 'active' };
      try { check(run); await client.put(keys.cardCollection, keys.cardRecordId, data, 0); check(run); try { card = await client.get(keys.cardCollection, keys.cardRecordId); check(run); } catch (rereadError) { if (rereadError.status === 404) return { status: 'conflict' }; throw rereadError; } if (!validCardRecord(card, meta.data, run.state.characterAvatar, cardType)) return { status: 'conflict' }; }
      catch (race) { if (race.status !== 409) throw race; check(run); card = await client.get(keys.cardCollection, keys.cardRecordId); check(run); if (!validCardRecord(card, meta.data, run.state.characterAvatar, cardType)) return { status: 'conflict' }; }
    }
    const next = { ...meta.data, cardType, status: 'ready' }; const metaKeys = formalKeys(run.state.chatId);
    try { check(run); await client.put(metaKeys.chatCollection, metaKeys.metaRecordId, next, meta.revision); check(run); const reread = await readMeta(run); if (!reread || !validMetaWinner(reread, run.state, meta.data, authority, cardType)) return { status: 'conflict' }; const routeResult = await initializeRouteRun(run, reread, meta.data, authority); if (routeResult.status === 'route_unavailable') return routeUnavailable(routeResult.diagnosticCode, cardType); return { status: routeResult.status, cardType, route: routeResult.record?.data?.route ?? null }; }
    catch (e) { if (e.status !== 409) throw e; check(run); const winner = await readMeta(run); if (!winner || !validMetaWinner(winner, run.state, meta.data, authority, cardType)) return { status: 'conflict' }; const routeResult = await initializeRouteRun(run, winner, meta.data, authority); if (routeResult.status === 'route_unavailable') return routeUnavailable(routeResult.diagnosticCode, cardType); return { status: routeResult.status, cardType, route: routeResult.record?.data?.route ?? null }; }
  }
  return {
    getFormalState: () => enqueueCurrent(async () => { const run = begin(); try { return await formalStateRun(run); } catch (e) { if (e.stale) return { status: 'stale' }; if (e.failClosed) return { status: 'mismatch' }; throw e; } }),
    initializeCard: ({ cardType } = {}) => enqueueCurrent(async () => { const run = begin(); try { return await initializeCardRun(run, cardType); } catch (e) { if (e.stale) return { status: 'stale' }; if (e.failClosed) return { status: 'mismatch' }; throw e; } }),
    invalidate: () => { generation += 1; invalidationEpoch += 1; },
    getInvalidation: () => generation,
  };
}
