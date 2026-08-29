import { isUuid } from './identity.js';
import { readHostState } from './host-context.js';

export const PEOPLE_FOUNDATION_SCHEMA_VERSION = 1;
export const PEOPLE_FOUNDATION_CONTRACT_VERSION = 1;
export const PEOPLE_STATE_RECORD_ID = 'people-state';
export const BASIC_FIELD_KEYS = Object.freeze(['gender', 'age', 'appearance', 'personality', 'identity', 'nsfwPreferences', 'abilities', 'likes', 'dislikes', 'principles', 'relationships']);

const INDEX_RECORD_ID = 'people-index';
const PROFILE_KIND = 'people-profile';
const STATE_KIND = 'people-foundation-state';
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const positiveRevision = value => Number.isInteger(value) && value > 0;
const envelope = record => Boolean(object(record) && record.schemaVersion === 1 && positiveRevision(record.revision) && isUuid(record.generationId)
  && typeof record.createdAt === 'string' && record.createdAt && typeof record.updatedAt === 'string' && record.updatedAt && object(record.data));
const staleError = () => Object.assign(new Error('千人初始化已失效'), { stale: true });
const fail = (status, message) => Object.assign(new Error(message), { foundationStatus: status });
const profileCollection = chatId => `chat-${chatId}-people`;
const chatCollection = chatId => `chat-${chatId}`;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const same = (left, right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
};
const clone = value => value === undefined ? undefined : structuredClone(value);

function schemaVersion(value, label) {
  if (value === undefined || value === null || value === '' || value === '1') return 1;
  if (!Number.isInteger(value) || value < 1) throw fail('invalid_record', `${label}版本无效`);
  if (value > PEOPLE_FOUNDATION_SCHEMA_VERSION) throw fail('future_schema_readonly', `${label}版本高于当前写入器`);
  return value;
}

function contractVersion(value, label) {
  if (value === undefined || value === null || value === '' || value === '1') return PEOPLE_FOUNDATION_CONTRACT_VERSION;
  if (!Number.isInteger(value) || value < 1) throw fail('invalid_record', `${label}合同版本无效`);
  if (value > PEOPLE_FOUNDATION_CONTRACT_VERSION) throw fail('future_schema_readonly', `${label}合同版本高于当前写入器`);
  return value;
}

function looseList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return clone(value);
  return [clone(value)];
}

const canonicalRef = value => object(value) && typeof value.kind === 'string' && value.kind.trim() && typeof value.locator === 'string' && value.locator.trim()
  ? { ...clone(value), kind: value.kind.trim(), locator: value.locator.trim() } : null;
const refKey = value => `${value.kind}\u0000${value.locator}`;
function mergeSourceRefs(current, required) {
  const output = looseList(current);
  const known = new Set(output.map(canonicalRef).filter(Boolean).map(refKey));
  for (const raw of required) {
    const item = canonicalRef(raw);
    if (!item || known.has(refKey(item))) continue;
    output.push(item);
    known.add(refKey(item));
  }
  return output;
}

function normalizeSubject(value, expected) {
  if (value === undefined || value === null || value === '') return expected;
  const normalized = String(value).trim().toLowerCase();
  if (expected === 'user' && ['user', 'u', 'persona'].includes(normalized)) return 'user';
  if (expected === 'character' && ['character', 'c'].includes(normalized)) return 'character';
  throw fail('identity_mismatch', '人物 subject 与当前身份不一致');
}

function mergeSourceBinding(current, required) {
  if (current === undefined || current === null) return clone(required);
  if (!object(current)) throw fail('identity_mismatch', '人物来源绑定无效');
  const criticalKeys = required.kind === 'persona' ? ['kind', 'identityId', 'locator'] : ['kind', 'identityId'];
  for (const key of criticalKeys) {
    if (current[key] !== undefined && required[key] !== undefined && current[key] !== required[key]) throw fail('identity_mismatch', '人物来源绑定冲突');
  }
  return { ...clone(current), ...clone(required) };
}

export function normalizePeopleProfile(data, binding) {
  if (!binding || !isUuid(binding.chatId) || !isUuid(binding.identityId) || !['user', 'character'].includes(binding.subject)) throw fail('identity_mismatch', '人物关键绑定无效');
  const input = data === null || data === undefined ? {} : data;
  if (!object(input)) throw fail('invalid_record', '人物档案不是对象');
  const next = clone(input);
  next.schemaVersion = schemaVersion(input.schemaVersion, '人物档案');
  next.peopleContractVersion = contractVersion(input.peopleContractVersion, '人物档案');
  if (input.kind !== undefined && input.kind !== PROFILE_KIND) throw fail('identity_mismatch', '人物档案 kind 冲突');
  if (input.identityId !== undefined && input.identityId !== binding.identityId) throw fail('identity_mismatch', '人物 identityId 冲突');
  if (input.chatId !== undefined && input.chatId !== binding.chatId) throw fail('identity_mismatch', '人物 chatId 冲突');
  next.kind = PROFILE_KIND;
  next.identityId = binding.identityId;
  next.chatId = binding.chatId;
  next.subject = normalizeSubject(input.subject, binding.subject);
  if (binding.displayName && (input.displayName === undefined || input.displayName === null || input.displayName === '')) next.displayName = binding.displayName;
  for (const key of ['sourceFacts', 'userFacts', 'interpretations', 'locks', 'pendingReview']) next[key] = looseList(input[key]);
  if (binding.subject === 'character') next.basicFields = object(input.basicFields) ? clone(input.basicFields) : {};
  next.sourceRefs = mergeSourceRefs(input.sourceRefs, binding.sourceRefs || []);
  next.sourceBinding = mergeSourceBinding(input.sourceBinding, binding.sourceBinding);
  if (input.lifecycle === undefined || input.lifecycle === null || input.lifecycle === '') next.lifecycle = 'active';
  return { data: next, changed: !same(input, next) };
}

function normalizeSelection(value) {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (object(value) && typeof value.status === 'string') return value.status.trim().toLowerCase();
  return 'unselected';
}

function normalizeRegistryIndex(record, expected) {
  if (!envelope(record)) throw fail('invalid_record', '人物池外壳无效');
  const data = record.data;
  schemaVersion(data.schemaVersion, '人物池');
  if (Number.isInteger(data.contractVersion) && data.contractVersion > 3) throw fail('future_schema_readonly', '人物池合同版本高于当前读取器');
  if (data.kind !== INDEX_RECORD_ID || data.chatId !== expected.chatId) throw fail('identity_mismatch', '人物池与当前聊天不一致');
  const confirmed = Array.isArray(data.confirmed) ? data.confirmed : [];
  const selected = [], selectedIds = new Set();
  for (const item of confirmed) {
    if (!object(item) || normalizeSelection(item.selection) !== 'selected') continue;
    if (!isUuid(item.identityId) || typeof item.displayName !== 'string' || !item.displayName.trim()) throw fail('identity_mismatch', '已选择人物缺少稳定身份');
    if (selectedIds.has(item.identityId)) throw fail('identity_mismatch', '已选择人物稳定身份重复');
    selectedIds.add(item.identityId);
    const sourceRefs = Array.isArray(item.sourceRefs) ? clone(item.sourceRefs) : item.sourceRefs == null ? [] : [clone(item.sourceRefs)];
    const primary = canonicalRef(item.primarySourceRef);
    if (primary && !sourceRefs.some(value => canonicalRef(value) && refKey(canonicalRef(value)) === refKey(primary))) sourceRefs.push(primary);
    selected.push({
      identityId: item.identityId,
      displayName: item.displayName.trim(),
      sourceRefs,
      sourceBinding: {
        kind: 'c-registry', identityId: item.identityId,
        ...(typeof item.sourceKey === 'string' && item.sourceKey ? { sourceKey: item.sourceKey } : {}),
      },
    });
  }
  return selected;
}

export function createFoundationAwarePeopleAdapter({ people, foundation, stableFloors } = {}) {
  if (!people || typeof people.select !== 'function' || typeof people.unselect !== 'function') throw new Error('人物选择动作不可用');
  if (!foundation || typeof foundation.initialize !== 'function') throw new Error('千人收敛动作不可用');
  const converge = operation => async options => {
    const result = await operation(options);
    if (!result || ['stale', 'conflict', 'error'].includes(result.status)) return result;
    const stableFloorState = typeof stableFloors?.getCommittedState === 'function' ? stableFloors.getCommittedState() : undefined;
    const foundationState = await foundation.initialize({ stableFloorState });
    if (foundationState?.status !== 'ready') return { ...result, status: foundationState?.status === 'stale' ? 'stale' : 'conflict', recoverable: true, foundation: foundationState };
    return { ...result, foundation: foundationState };
  };
  const select = converge(people.select.bind(people));
  const unselect = converge(people.unselect.bind(people));
  return { ...people, select, unselect, selectPerson: select, unselectPerson: unselect };
}

function normalizeMeta(record, state) {
  if (!envelope(record)) throw fail('invalid_record', '正式聊天外壳无效');
  const data = record.data;
  schemaVersion(data.schemaVersion, '正式聊天');
  if (data.kind !== 'chat-profile' || data.status !== 'ready' || data.chatId !== state.chatId || !isUuid(data.cardId) || !isUuid(data.personaId)
    || data.source?.card?.locator !== state.characterAvatar || data.source?.persona?.locator !== state.personaAvatar) throw fail('identity_mismatch', '正式聊天身份不一致');
  return data;
}

function canonRef(stableFloorState) {
  const ledger = stableFloorState?.ledger;
  if (!ledger || !Array.isArray(ledger.entries)) return null;
  const tail = ledger.entries.at(-1);
  return {
    schemaVersion: Number.isInteger(ledger.schemaVersion) ? ledger.schemaVersion : 1,
    canonLength: ledger.entries.length,
    tailIdentity: typeof tail?.identity === 'string' ? tail.identity : null,
    tailSignature: typeof tail?.signature === 'string' ? tail.signature : null,
    runtimeRevision: positiveRevision(stableFloorState.revision) ? stableFloorState.revision : null,
  };
}

function memberFrom(value) {
  if (typeof value === 'string' && isUuid(value)) return { identityId: value, subject: 'character', active: false };
  if (!object(value) || !isUuid(value.identityId)) return null;
  const subject = ['user', 'character'].includes(value.subject) ? value.subject : 'character';
  return { ...clone(value), subject, active: value.active === true };
}

function desiredState(data, binding, selected, stableFloorState, status = 'ready') {
  const input = data === null || data === undefined ? {} : data;
  if (!object(input)) throw fail('invalid_record', '千人状态不是对象');
  const next = clone(input);
  next.schemaVersion = schemaVersion(input.schemaVersion, '千人状态');
  next.contractVersion = contractVersion(input.contractVersion, '千人状态');
  if (input.kind !== undefined && input.kind !== STATE_KIND) throw fail('identity_mismatch', '千人状态 kind 冲突');
  for (const [key, expected] of Object.entries({ chatId: binding.chatId, cardId: binding.cardId, personaId: binding.personaId })) {
    if (input[key] !== undefined && input[key] !== expected) throw fail('identity_mismatch', `千人状态 ${key} 冲突`);
    next[key] = expected;
  }
  next.kind = STATE_KIND;
  next.source = {
    ...(object(input.source) ? clone(input.source) : {}),
    card: { ...(object(input.source?.card) ? clone(input.source.card) : {}), locator: binding.characterAvatar },
    persona: { ...(object(input.source?.persona) ? clone(input.source.persona) : {}), locator: binding.personaAvatar },
  };
  if (input.source?.card?.locator !== undefined && input.source.card.locator !== binding.characterAvatar) throw fail('identity_mismatch', '千人状态角色来源冲突');
  if (input.source?.persona?.locator !== undefined && input.source.persona.locator !== binding.personaAvatar) throw fail('identity_mismatch', '千人状态 Persona 来源冲突');
  next.initializedMembers = selected.map(person => ({ identityId: person.identityId, subject: 'character', active: true, displayName: person.displayName }));
  next.activeMemberIds = selected.map(person => person.identityId);
  next.canonRef = canonRef(stableFloorState);
  next.status = status;
  return next;
}

function stateMatches(record, binding) {
  if (!envelope(record)) throw fail('invalid_record', '千人状态外壳无效');
  desiredState(record.data, binding, [], null, record.data.status);
  if (!['initializing', 'ready'].includes(record.data.status)) throw fail('invalid_record', '千人状态状态值无效');
  return record;
}

export function createPeopleFoundationAdapter({ client, contextProvider, guard } = {}) {
  if (!client?.get || !client?.put) throw new Error('千人后端客户端不可用');
  if (typeof contextProvider !== 'function') throw new Error('千人宿主上下文不可用');
  let generation = 0, invalidationEpoch = 0, serial = Promise.resolve();
  const committed = new Map();
  const snapshot = () => {
    const state = readHostState(contextProvider());
    return { state, fingerprint: state.ok ? `${state.hostChatId}|${state.chatId}|${state.characterAvatar}|${state.personaAvatar}` : 'invalid' };
  };
  const check = run => {
    const current = snapshot();
    if (run.token !== generation || !run.state.ok || current.fingerprint !== run.fingerprint) throw staleError();
    guard?.();
  };
  const read = async (run, collection, id, optional = false) => {
    try { const value = await client.get(collection, id); check(run); return value; }
    catch (error) { if (optional && error.status === 404) { check(run); return null; } throw error; }
  };
  const put = async (run, collection, id, data, revision) => {
    check(run);
    const result = await client.put(collection, id, data, revision);
    check(run);
    if (!envelope(result)) throw fail('storage_error', '千人写入响应外壳无效');
    return result;
  };
  const bindingFor = (state, meta) => ({ ...state, cardId: meta.cardId, personaId: meta.personaId });
  const clean = (status, record = null, profiles = [], extra = {}) => {
    const state = record?.data ? clone(record.data) : null;
    if (state) {
      state.initializedMembers = (Array.isArray(state.initializedMembers) ? state.initializedMembers : []).map(memberFrom).filter(item => item?.subject === 'character' && item.active === true);
      state.activeMemberIds = state.initializedMembers.map(item => item.identityId);
    }
    return {
      status, revision: record?.revision ?? null, state,
      profiles: profiles.map(value => value?.data).filter(value => value?.subject === 'character'), ...extra,
    };
  };
  const remember = (chatId, record, profiles) => {
    if (record?.data?.status === 'ready') committed.set(chatId, clean('ready', record, profiles));
  };

  async function plan(run, stableFloorState) {
    if (!run.state.ok || !run.state.chatId) throw fail('blocked', run.state.reason || '正式聊天尚未初始化');
    const collection = chatCollection(run.state.chatId);
    const metaRecord = await read(run, collection, 'meta');
    const meta = normalizeMeta(metaRecord, run.state);
    const binding = bindingFor(run.state, meta);
    const indexRecord = await read(run, collection, INDEX_RECORD_ID, true);
    if (!indexRecord) throw fail('paused_people_pool', '人物池尚未初始化');
    const selected = normalizeRegistryIndex(indexRecord, binding);
    if (selected.some(item => item.identityId === meta.personaId)) throw fail('identity_mismatch', 'U 与已选择 C 稳定身份冲突');
    const stateRecord = await read(run, collection, PEOPLE_STATE_RECORD_ID, true);
    if (stateRecord) stateMatches(stateRecord, binding);
    const profileBindings = new Map();
    for (const person of selected) profileBindings.set(person.identityId, { chatId: binding.chatId, identityId: person.identityId, subject: 'character', ...person });
    const profiles = [];
    for (const item of profileBindings.values()) {
      const record = await read(run, profileCollection(binding.chatId), item.identityId, true);
      if (record && !envelope(record)) throw fail('invalid_record', '人物档案外壳无效');
      const normalized = normalizePeopleProfile(record?.data, item);
      profiles.push({ binding: item, record, normalized });
    }
    const readyData = desiredState(stateRecord?.data, binding, selected, stableFloorState, 'ready');
    const initializingData = { ...clone(readyData), status: 'initializing' };
    const profilesChanged = profiles.some(item => item.normalized.changed);
    const stateChanged = !stateRecord || !same(stateRecord.data, readyData);
    return { binding, selected, stateRecord, profiles, readyData, initializingData, changed: profilesChanged || stateChanged };
  }

  async function initializeRun(run, stableFloorState) {
    const pending = await plan(run, stableFloorState);
    if (pending.stateRecord?.data?.status === 'ready') remember(pending.binding.chatId, pending.stateRecord, pending.profiles.map(item => item.record));
    if (!pending.changed && pending.stateRecord?.data?.status === 'ready') {
      const profileRecords = pending.profiles.map(item => item.record);
      remember(pending.binding.chatId, pending.stateRecord, profileRecords);
      return clean('ready', pending.stateRecord, profileRecords, { reused: true });
    }
    let stateRecord = pending.stateRecord;
    try {
      stateRecord = await put(run, chatCollection(pending.binding.chatId), PEOPLE_STATE_RECORD_ID, pending.initializingData, stateRecord?.revision ?? 0);
    } catch (error) {
      if (error.status !== 409) throw error;
      const winner = await read(run, chatCollection(pending.binding.chatId), PEOPLE_STATE_RECORD_ID);
      stateMatches(winner, pending.binding);
      return clean('conflict', committed.get(pending.binding.chatId)?.state ? { data: committed.get(pending.binding.chatId).state, revision: committed.get(pending.binding.chatId).revision } : winner, [], { recoverable: true });
    }
    const savedProfiles = [];
    for (const item of pending.profiles) {
      if (!item.normalized.changed) { if (item.record) savedProfiles.push(item.record); continue; }
      try {
        const saved = await put(run, profileCollection(pending.binding.chatId), item.binding.identityId, item.normalized.data, item.record?.revision ?? 0);
        const verified = normalizePeopleProfile(saved.data, item.binding);
        if (verified.changed) throw fail('storage_error', '人物档案写入结果不完整');
        savedProfiles.push(saved);
      } catch (error) {
        if (error.status !== 409) throw error;
        const winner = await read(run, profileCollection(pending.binding.chatId), item.binding.identityId);
        const verified = normalizePeopleProfile(winner.data, item.binding);
        if (!verified.changed) { savedProfiles.push(winner); continue; }
        return clean('conflict', stateRecord, savedProfiles, { recoverable: true });
      }
    }
    let finalRecord;
    try { finalRecord = await put(run, chatCollection(pending.binding.chatId), PEOPLE_STATE_RECORD_ID, pending.readyData, stateRecord.revision); }
    catch (error) {
      if (error.status !== 409) throw error;
      const winner = await read(run, chatCollection(pending.binding.chatId), PEOPLE_STATE_RECORD_ID);
      stateMatches(winner, pending.binding);
      if (!same(winner.data, pending.readyData)) return clean('conflict', winner, savedProfiles, { recoverable: true });
      finalRecord = winner;
    }
    remember(pending.binding.chatId, finalRecord, savedProfiles);
    return clean('ready', finalRecord, savedProfiles, { reused: false });
  }

  async function restoreRun(run) {
    if (!run.state.ok || !run.state.chatId) throw fail('blocked', run.state.reason || '正式聊天尚未初始化');
    const collection = chatCollection(run.state.chatId);
    const metaRecord = await read(run, collection, 'meta');
    const meta = normalizeMeta(metaRecord, run.state);
    const binding = bindingFor(run.state, meta);
    const stateRecord = await read(run, collection, PEOPLE_STATE_RECORD_ID, true);
    if (!stateRecord) return clean('uninitialized');
    if (!envelope(stateRecord)) throw fail('invalid_record', '千人状态外壳无效');
    if (Number.isInteger(stateRecord.data?.schemaVersion) && stateRecord.data.schemaVersion > PEOPLE_FOUNDATION_SCHEMA_VERSION
      || Number.isInteger(stateRecord.data?.contractVersion) && stateRecord.data.contractVersion > PEOPLE_FOUNDATION_CONTRACT_VERSION) {
      return clean('future_schema_readonly', stateRecord, [], { readonly: true, restored: true });
    }
    stateMatches(stateRecord, binding);
    const profiles = [];
    for (const member of (stateRecord.data.initializedMembers || []).map(memberFrom).filter(item => item?.subject === 'character' && item.active === true)) {
      const record = await read(run, profileCollection(binding.chatId), member.identityId, true);
      if (!record || !envelope(record)) return clean('recoverable', stateRecord, profiles, { missingIdentityId: member.identityId });
      if (Number.isInteger(record.data?.schemaVersion) && record.data.schemaVersion > PEOPLE_FOUNDATION_SCHEMA_VERSION
        || Number.isInteger(record.data?.peopleContractVersion) && record.data.peopleContractVersion > PEOPLE_FOUNDATION_CONTRACT_VERSION) {
        return clean('future_schema_readonly', stateRecord, [...profiles, record], { readonly: true, restored: true });
      }
      const normalized = normalizePeopleProfile(record.data, { chatId: binding.chatId, identityId: member.identityId, subject: member.subject, sourceRefs: [], sourceBinding: { kind: member.subject === 'user' ? 'persona' : 'c-registry', identityId: member.identityId } });
      profiles.push({ ...record, data: normalized.data });
    }
    const status = stateRecord.data.status === 'ready' ? 'ready' : 'recoverable';
    if (status === 'ready') remember(binding.chatId, stateRecord, profiles);
    return clean(status, stateRecord, profiles, { restored: true });
  }

  const enqueue = operation => {
    const entryEpoch = invalidationEpoch;
    const task = serial.then(() => {
      if (entryEpoch !== invalidationEpoch) return { status: 'stale' };
      const current = snapshot();
      const run = { token: ++generation, ...current };
      return operation(run);
    }, () => operation({ token: ++generation, ...snapshot() }));
    serial = task.catch(() => {});
    return task;
  };
  const safe = operation => enqueue(async run => {
    try { return await operation(run); }
    catch (error) {
      if (error.stale) return { status: 'stale' };
      if (error.foundationStatus) return { status: error.foundationStatus, readonly: error.foundationStatus === 'future_schema_readonly', error: error.message };
      const cached = run.state?.chatId ? committed.get(run.state.chatId) : null;
      return { ...(cached || {}), status: 'storage_error', error: String(error?.message || error) };
    }
  });
  return {
    initialize: ({ stableFloorState } = {}) => safe(run => initializeRun(run, stableFloorState)),
    restore: () => safe(restoreRun),
    getState: () => {
      const state = readHostState(contextProvider());
      return state.ok && state.chatId ? committed.get(state.chatId) || { status: 'uninitialized' } : { status: 'blocked', reason: state.reason };
    },
    invalidate: () => { generation += 1; invalidationEpoch += 1; },
  };
}
