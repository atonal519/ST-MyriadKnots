import { readHostState } from './host-context.js';
import { isUuid, sha256 } from './identity.js';
import { INITIAL_RELATION_WRITER_ID } from './initial-relation-generation.js';

const PROFILE_LAYERS = ['sourceFacts', 'userFacts', 'interpretations', 'pendingReview'];
const TARGET_LAYERS = ['sourceFacts', 'interpretations'];
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const clone = value => value === undefined ? undefined : structuredClone(value);
const same = (left, right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
};
const stableJson = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const envelope = value => Boolean(object(value) && value.schemaVersion === 1 && Number.isInteger(value.revision) && value.revision > 0
  && isUuid(value.generationId) && typeof value.createdAt === 'string' && value.createdAt
  && typeof value.updatedAt === 'string' && value.updatedAt && object(value.data));
const fail = (status, message) => Object.assign(new Error(message), { reviewStatus: status });
const stale = () => Object.assign(new Error('待确认操作已失效'), { stale: true });
const chatCollection = chatId => `chat-${chatId}`;
const profileCollection = chatId => `chat-${chatId}-people`;
const selectionStatus = value => typeof value === 'string' ? value : value?.status;

export async function pendingReviewDigest(item) {
  if (!object(item)) throw fail('mismatch', '待确认项目无效');
  return `sha256:${await sha256(stableJson(item))}`;
}

function validateRecord(record, kind, chatId, futureKey = 'schemaVersion') {
  if (!envelope(record) || record.data.kind !== kind || record.data.chatId !== chatId) throw fail('mismatch', `${kind} 与当前聊天不一致`);
  if (Number(record.data[futureKey] || 1) > 1) throw fail('future_schema_readonly', `${kind} 来自未来版本`);
  return record.data;
}

function validatePendingItem(item, identityIds) {
  const optionalRelation = item?.relationToIdentityId === undefined ? [] : ['relationToIdentityId'];
  const optionalConfidence = item?.confidence === undefined ? [] : ['confidence'];
  const allowed = ['id', 'value', 'sourceRefs', 'proposedLayer', 'reason', 'writerId', 'operationId', 'baselineDigest', 'provenance', 'state', ...optionalRelation, ...optionalConfidence].sort();
  if (!object(item) || Object.keys(item).sort().join(',') !== allowed.join(',')) throw fail('mismatch', '待确认项目字段无效');
  if (typeof item.id !== 'string' || !/^qqj-initial-v1:[0-9a-f]{64}$/.test(item.id)
    || typeof item.value !== 'string' || !item.value.trim() || item.value.length > 1200
    || item.confidence !== undefined && (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)
    || !Array.isArray(item.sourceRefs) || item.sourceRefs.length < 1
    || item.writerId !== INITIAL_RELATION_WRITER_ID || !isUuid(item.operationId)
    || !/^sha256:[0-9a-f]{64}$/.test(item.baselineDigest)
    || item.provenance !== 'ai' || item.state !== 'pending_review'
    || !TARGET_LAYERS.includes(item.proposedLayer) || typeof item.reason !== 'string' || !item.reason.trim()) throw fail('mismatch', '待确认项目所有权或状态无效');
  if (item.relationToIdentityId !== undefined && !identityIds.has(item.relationToIdentityId)) throw fail('mismatch', '待确认项目引用未知人物');
  return item;
}

function acceptedItem(item) {
  const next = clone(item);
  delete next.proposedLayer;
  delete next.reason;
  next.provenance = item.proposedLayer === 'sourceFacts' ? 'source' : 'ai';
  next.state = 'canon';
  return next;
}

function acceptedWinner(record, identityId, item, expectedProfile) {
  if (!envelope(record) || record.data.kind !== 'people-profile' || record.data.chatId !== expectedProfile.chatId
    || record.data.identityId !== identityId || record.data.subject !== expectedProfile.subject
    || Number(record.data.schemaVersion || 1) > 1 || Number(record.data.peopleContractVersion || 1) > 1
    || !same(record.data.sourceBinding, expectedProfile.sourceBinding)) return false;
  const pending = Array.isArray(record.data.pendingReview) ? record.data.pendingReview : [];
  const target = Array.isArray(record.data[item.proposedLayer]) ? record.data[item.proposedLayer] : [];
  const occurrences = PROFILE_LAYERS.flatMap(layer => Array.isArray(record.data[layer]) ? record.data[layer] : []).filter(candidate => candidate?.id === item.id);
  const expected = acceptedItem(item);
  return pending.every(candidate => candidate?.id !== item.id)
    && occurrences.length === 1
    && target.filter(candidate => candidate?.id === item.id).length === 1
    && target.some(candidate => same(candidate, expected));
}

export function createPendingReviewAdapter({ client, contextProvider, isEnabled = () => true } = {}) {
  if (!client?.get || !client?.put || typeof contextProvider !== 'function') throw new Error('待确认动作依赖不可用');
  let generation = 0, invalidationEpoch = 0, serial = Promise.resolve();
  const snapshot = () => {
    const state = readHostState(contextProvider());
    return { state, fingerprint: state.ok ? `${state.hostChatId}|${state.chatId}|${state.characterAvatar}|${state.personaAvatar}` : 'invalid' };
  };
  const check = run => {
    const now = snapshot();
    if (!isEnabled() || run.token !== generation || !run.state.ok || now.fingerprint !== run.fingerprint) throw stale();
  };
  const read = async (run, collection, recordId) => { const value = await client.get(collection, recordId); check(run); return value; };

  async function loadAuthority(run, identityId) {
    if (!run.state.ok || !run.state.chatId || !isUuid(identityId)) throw fail('mismatch', '当前人物身份无效');
    const collection = chatCollection(run.state.chatId);
    const [metaRecord, indexRecord, stateRecord, profileRecord] = await Promise.all([
      read(run, collection, 'meta'), read(run, collection, 'people-index'), read(run, collection, 'people-state'), read(run, profileCollection(run.state.chatId), identityId),
    ]);
    const meta = validateRecord(metaRecord, 'chat-profile', run.state.chatId);
    const index = validateRecord(indexRecord, 'people-index', run.state.chatId);
    const foundation = validateRecord(stateRecord, 'people-foundation-state', run.state.chatId);
    const profile = validateRecord(profileRecord, 'people-profile', run.state.chatId);
    if (Number(index.contractVersion || 1) > 3 || Number(foundation.contractVersion || 1) > 1 || Number(profile.peopleContractVersion || 1) > 1) throw fail('future_schema_readonly', '人物数据来自未来版本');
    if (object(foundation.initialGeneration) && Number(foundation.initialGeneration.schemaVersion || 1) > 1) throw fail('future_schema_readonly', '首次生成状态来自未来版本');
    if (meta.status !== 'ready' || foundation.status !== 'ready' || meta.source?.card?.locator !== run.state.characterAvatar
      || meta.source?.persona?.locator !== run.state.personaAvatar || foundation.cardId !== meta.cardId || foundation.personaId !== meta.personaId
      || foundation.source?.card?.locator !== run.state.characterAvatar || foundation.source?.persona?.locator !== run.state.personaAvatar) throw fail('mismatch', '当前 chat/card/Persona 绑定不一致');
    const members = Array.isArray(foundation.initializedMembers) ? foundation.initializedMembers : [];
    const memberMatches = members.filter(item => item?.identityId === identityId && item.active === true);
    if (memberMatches.length !== 1 || !(foundation.activeMemberIds || []).includes(identityId)) throw fail('mismatch', '人物不是当前活跃成员');
    const subject = identityId === meta.personaId ? 'user' : 'character';
    if (memberMatches[0].subject !== subject || profile.identityId !== identityId || profile.subject !== subject) throw fail('mismatch', '人物身份或 subject 不一致');
    if (subject === 'user') {
      if (profile.sourceBinding?.kind !== 'persona' || profile.sourceBinding.identityId !== identityId || profile.sourceBinding.locator !== run.state.personaAvatar) throw fail('mismatch', 'U 来源绑定不一致');
    } else {
      const selected = (index.confirmed || []).filter(item => item?.identityId === identityId && selectionStatus(item.selection) === 'selected');
      if (selected.length !== 1 || profile.sourceBinding?.kind !== 'c-registry' || profile.sourceBinding.identityId !== identityId) throw fail('mismatch', 'C 不在当前已选择人物中');
    }
    const identityIds = new Set((foundation.initializedMembers || []).filter(item => item?.active === true).map(item => item.identityId));
    return { profileRecord, profile, identityIds };
  }

  async function resolveRun(run, { identityId, pendingItemId, decision, expectedItemDigest } = {}) {
    if (!['accept', 'reject'].includes(decision) || typeof pendingItemId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(expectedItemDigest || '')) throw fail('mismatch', '待确认动作参数无效');
    const authority = await loadAuthority(run, identityId);
    const pending = Array.isArray(authority.profile.pendingReview) ? authority.profile.pendingReview : [];
    const targets = pending.filter(item => item?.id === pendingItemId);
    const allOccurrences = PROFILE_LAYERS.flatMap(layer => Array.isArray(authority.profile[layer]) ? authority.profile[layer] : []).filter(item => item?.id === pendingItemId);
    if (targets.length !== 1 || allOccurrences.length !== 1) throw fail('mismatch', '待确认项目 ID 重复或不存在');
    const item = validatePendingItem(targets[0], authority.identityIds);
    if (await pendingReviewDigest(item) !== expectedItemDigest) throw fail('conflict', '待确认项目已经变化');
    const next = clone(authority.profile);
    next.pendingReview = pending.filter(candidate => candidate !== targets[0]);
    if (decision === 'accept') {
      const target = Array.isArray(next[item.proposedLayer]) ? next[item.proposedLayer] : [];
      if (target.some(candidate => candidate?.id === item.id)) throw fail('conflict', '目标层已有冲突项目');
      target.push(acceptedItem(item));
      next[item.proposedLayer] = target;
    }
    check(run);
    try {
      const result = await client.put(profileCollection(run.state.chatId), identityId, next, authority.profileRecord.revision);
      check(run);
      if (!envelope(result) || !same(result.data, next)) {
        if (decision !== 'accept') throw fail('conflict', '拒绝动作写入响应不确定');
        const winner = await read(run, profileCollection(run.state.chatId), identityId);
        if (!acceptedWinner(winner, identityId, item, authority.profile)) throw fail('conflict', '确认动作写入响应不确定');
      }
      return { status: 'ready', decision, identityId, pendingItemId };
    } catch (error) {
      if (error.stale || error.reviewStatus) throw error;
      if (decision === 'accept') {
        try {
          const winner = await read(run, profileCollection(run.state.chatId), identityId);
          if (acceptedWinner(winner, identityId, item, authority.profile)) return { status: 'ready', decision, identityId, pendingItemId, recovered: true };
        } catch (readError) { if (readError.stale) throw readError; }
      }
      throw fail('conflict', error.status === 409 ? '待确认项目发生并发冲突' : '待确认动作结果不确定');
    }
  }

  const enqueue = options => {
    const entryEpoch = invalidationEpoch;
    const task = serial.then(async () => {
      if (entryEpoch !== invalidationEpoch || !isEnabled()) return { status: 'stale' };
      const run = { token: ++generation, ...snapshot() };
      try { return await resolveRun(run, options); }
      catch (error) {
        if (error.stale) return { status: 'stale' };
        return { status: error.reviewStatus || 'conflict', recoverable: true };
      }
    });
    serial = task.catch(() => {});
    return task;
  };
  const invalidate = () => { generation += 1; invalidationEpoch += 1; };
  return { resolvePendingReview: enqueue, invalidate, itemDigest: pendingReviewDigest };
}
