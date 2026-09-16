import { isUuid, newUuid, persistChatId } from './host-context.js';
import { deterministicUuid } from './v3/foundation-domain.js';

export const CHAT_IDENTITY_COLLECTION = 'chat-identity-bindings';
const BINDING_PREFIX = 'binding-';

function errorWith(code, message) { return Object.assign(new Error(message), { code }); }
function ownerFrom(host) {
  return Object.freeze({
    hostChatId: String(host.hostChatId ?? ''),
    characterLocator: String(host.characterAvatar ?? ''),
    personaLocator: String(host.personaAvatar ?? ''),
  });
}
function sameOwner(left, right) {
  return left?.hostChatId === right?.hostChatId
    && left?.characterLocator === right?.characterLocator;
}
function sameExactOwner(left, right) {
  return sameOwner(left, right) && left?.personaLocator === right?.personaLocator;
}
function hostFileName(value) { return String(value ?? '').trim().replace(/\.jsonl$/i, ''); }
function bindingRecord({ chatId, owner, state = 'ready', sourceChatId = null, createdAt }) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'qqj-chat-identity-binding',
    chatId,
    owner: { ...owner },
    state,
    sourceChatId,
    createdAt,
    updatedAt: createdAt,
  });
}
function validateBindingEnvelope(envelope, expectedChatId) {
  const value = envelope?.data;
  if (!Number.isSafeInteger(envelope?.revision) || envelope.revision < 1
    || !value || value.schemaVersion !== 1 || value.kind !== 'qqj-chat-identity-binding'
    || value.chatId !== expectedChatId || !isUuid(value.chatId)
    || !value.owner || typeof value.owner !== 'object'
    || !String(value.owner.hostChatId ?? '') || !String(value.owner.characterLocator ?? '') || !String(value.owner.personaLocator ?? '')
    || !['preparing', 'ready'].includes(value.state)
    || (value.sourceChatId !== null && !isUuid(value.sourceChatId))) {
    throw errorWith('QQJ_CHAT_BINDING_INVALID', '聊天身份认领记录损坏，已停止读写以避免串档。');
  }
  return Object.freeze({ data: value, revision: envelope.revision });
}

export function createChatIdentityCoordinator({
  client,
  persist = persistChatId,
  freshUuid = newUuid,
  listHostChats = null,
  initializeBranch = null,
  now = () => new Date(),
} = {}) {
  if (!client || typeof client.get !== 'function' || typeof client.put !== 'function') throw new TypeError('聊天身份协调器需要 record/CAS client');
  if (typeof persist !== 'function' || typeof freshUuid !== 'function') throw new TypeError('聊天身份协调器参数无效');
  if (initializeBranch !== null && typeof initializeBranch !== 'function') throw new TypeError('聊天分支初始化器无效');
  const key = chatId => `${BINDING_PREFIX}${chatId}`;
  const nowIso = () => {
    const value = now()?.toISOString?.() ?? String(now());
    if (!Number.isFinite(Date.parse(value))) throw errorWith('QQJ_CHAT_BINDING_TIME_INVALID', '聊天身份认领时间无效。');
    return value;
  };
  async function read(chatId) {
    try { return validateBindingEnvelope(await client.get(CHAT_IDENTITY_COLLECTION, key(chatId)), chatId); }
    catch (error) { if (error?.status === 404) return null; throw error; }
  }
  async function create(record) {
    try { return validateBindingEnvelope(await client.put(CHAT_IDENTITY_COLLECTION, key(record.chatId), record, 0), record.chatId); }
    catch (error) {
      if (error?.status !== 409) throw error;
      const winner = await read(record.chatId);
      if (!winner) throw errorWith('QQJ_CHAT_BINDING_CONFLICT', '聊天身份认领冲突且无法读取胜出记录。');
      return winner;
    }
  }
  async function legacyRootExists(chatId) {
    try { await client.get(`chat-${chatId}`, 'v3-root'); return true; }
    catch (error) { if (error?.status === 404) return false; throw error; }
  }
  async function abandonedBranchTarget(error, chatId, signal) {
    if (error?.code !== 'V3_BRANCH_RECORD_CONFLICT') return false;
    assertCurrent(signal);
    let rootExists;
    try { rootExists = await legacyRootExists(chatId); }
    catch { assertCurrent(signal); return false; }
    assertCurrent(signal);
    return !rootExists;
  }
  let sequence = Promise.resolve();
  const assertCurrent = signal => {
    if (signal?.aborted) throw errorWith('QQJ_CHAT_PREPARE_STALE', '聊天身份准备已过期。');
  };
  function serialized(task, signal) {
    const run = sequence.then(async () => {
      assertCurrent(signal);
      return task();
    });
    sequence = run.then(() => undefined, () => undefined);
    return run;
  }
  async function claimReady(raw, owner, chatId, sourceChatId = null) {
    const claimed = await create(bindingRecord({ chatId, owner, sourceChatId, createdAt: nowIso() }));
    if (!sameOwner(claimed.data.owner, owner) || claimed.data.state !== 'ready') return null;
    await persist(raw, chatId);
    return chatId;
  }
  async function updateOwnerHost(binding, owner, { signal, matches = sameExactOwner } = {}) {
    if (matches(binding.data.owner, owner)) return binding;
    assertCurrent(signal);
    const next = Object.freeze({
      ...binding.data,
      owner: { ...binding.data.owner, hostChatId: owner.hostChatId },
      updatedAt: nowIso(),
    });
    let updated;
    try {
      updated = validateBindingEnvelope(await client.put(CHAT_IDENTITY_COLLECTION, key(binding.data.chatId), next, binding.revision, { signal }), binding.data.chatId);
    } catch (error) {
      if (error?.status !== 409) throw error;
      const winner = await read(binding.data.chatId);
      assertCurrent(signal);
      if (!winner || winner.data.state !== 'ready' || !matches(winner.data.owner, owner)) {
        throw errorWith('QQJ_CHAT_RENAME_CONFLICT', '聊天身份改名时发生冲突，未覆盖胜出记录。');
      }
      updated = winner;
    }
    assertCurrent(signal);
    if (!matches(updated.data.owner, owner)) throw errorWith('QQJ_CHAT_RENAME_CONFLICT', '聊天身份未能安全更新，已停止恢复。');
    return updated;
  }
  async function completePreparingBranch(raw, host, claimed, signal) {
    const owner = ownerFrom(host);
    if (!sameExactOwner(claimed.data.owner, owner) || claimed.data.state !== 'preparing' || !isUuid(claimed.data.sourceChatId)) return null;
    if (!initializeBranch) throw errorWith('QQJ_CHAT_BRANCH_INITIALIZER_UNAVAILABLE', '聊天副本继承尚未接入，未冒报准备完成。');
    assertCurrent(signal);
    await initializeBranch({ raw, host, sourceChatId: claimed.data.sourceChatId, targetChatId: claimed.data.chatId, createdAt: claimed.data.createdAt, signal });
    assertCurrent(signal);
    const ready = Object.freeze({ ...claimed.data, state: 'ready', updatedAt: nowIso() });
    let completed;
    try {
      completed = validateBindingEnvelope(await client.put(CHAT_IDENTITY_COLLECTION, key(claimed.data.chatId), ready, claimed.revision, { signal }), claimed.data.chatId);
    } catch (error) {
      if (error?.status !== 409) throw error;
      completed = await read(claimed.data.chatId);
    }
    assertCurrent(signal);
    if (!completed || completed.data.state !== 'ready' || completed.data.sourceChatId !== claimed.data.sourceChatId
      || !sameExactOwner(completed.data.owner, owner)) throw errorWith('QQJ_CHAT_BRANCH_BINDING_CONFLICT', '聊天副本身份发生冲突，未覆盖已有认领。');
    await persist(raw, completed.data.chatId);
    return completed.data.chatId;
  }
  async function independent(raw, host, carriedChatId, { inherit = false, signal, skipChatIds = [] } = {}) {
    const owner = ownerFrom(host);
    const sourceChatId = isUuid(carriedChatId) ? carriedChatId : null;
    const deterministicChatId = await deterministicUuid(['qqj-chat-independent-v2', carriedChatId, owner.hostChatId, owner.characterLocator]);
    const attempted = new Set(skipChatIds);
    const claim = async chatId => {
      if (!inherit) return claimReady(raw, owner, chatId, sourceChatId);
      const claimed = await create(bindingRecord({ chatId, owner, state: 'preparing', sourceChatId, createdAt: nowIso() }));
      if (!sameExactOwner(claimed.data.owner, owner) || claimed.data.sourceChatId !== sourceChatId) return null;
      if (claimed.data.state === 'ready') { await persist(raw, chatId); return chatId; }
      return completePreparingBranch(raw, host, claimed, signal);
    };
    const tryClaim = async chatId => {
      if (attempted.has(chatId)) return null;
      attempted.add(chatId);
      try { return await claim(chatId); }
      catch (error) {
        if (!inherit || !await abandonedBranchTarget(error, chatId, signal)) throw error;
        return null;
      }
    };
    const claimed = await tryClaim(deterministicChatId);
    if (claimed) return claimed;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const fallback = freshUuid();
      if (fallback === carriedChatId) continue;
      const fallbackClaim = await tryClaim(fallback);
      if (fallbackClaim) return fallbackClaim;
    }
    throw errorWith('QQJ_CHAT_BINDING_CONFLICT', '无法为当前聊天建立独立身份，请刷新后重试。');
  }
  async function prepareNow(raw, host, signal) {
    const owner = ownerFrom(host);
    if (!isUuid(host.chatId)) {
      const claimed = await claimReady(raw, owner, freshUuid());
      if (claimed) return claimed;
      return independent(raw, host, 'new-chat');
    }
    let claimed = await read(host.chatId);
    if (!claimed) {
      if (await legacyRootExists(host.chatId)) return independent(raw, host, host.chatId);
      const wanted = bindingRecord({ chatId: host.chatId, owner, createdAt: nowIso() });
      claimed = await create(wanted);
    }
    if (sameOwner(claimed.data.owner, owner) && claimed.data.state === 'ready') {
      assertCurrent(signal);
      await persist(raw, claimed.data.chatId);
      return claimed.data.chatId;
    }
    const expectedPreparingChatId = claimed.data.state === 'preparing' && isUuid(claimed.data.sourceChatId)
      ? await deterministicUuid(['qqj-chat-independent-v2', claimed.data.sourceChatId, owner.hostChatId, owner.characterLocator])
      : null;
    if (sameExactOwner(claimed.data.owner, owner) && claimed.data.state === 'preparing'
      && claimed.data.chatId === host.chatId && claimed.data.chatId === expectedPreparingChatId) {
      try { return await completePreparingBranch(raw, host, claimed, signal); }
      catch (error) {
        if (!await abandonedBranchTarget(error, claimed.data.chatId, signal)) throw error;
        return independent(raw, host, claimed.data.sourceChatId, { inherit: true, signal, skipChatIds: [claimed.data.chatId] });
      }
    }
    if (listHostChats && claimed.data.state === 'ready'
      && claimed.data.owner.characterLocator === owner.characterLocator
      && claimed.data.owner.hostChatId !== owner.hostChatId) {
      const names = await listHostChats(owner.characterLocator, { signal });
      assertCurrent(signal);
      if (names.includes(owner.hostChatId) && !names.includes(claimed.data.owner.hostChatId)) {
        claimed = await updateOwnerHost(claimed, owner, { signal, matches: sameOwner });
        assertCurrent(signal);
        await persist(raw, claimed.data.chatId);
        return claimed.data.chatId;
      }
      if (names.includes(owner.hostChatId) && names.includes(claimed.data.owner.hostChatId)) {
        return independent(raw, host, host.chatId, { inherit: true, signal });
      }
    }
    return independent(raw, host, host.chatId);
  }
  function prepare(raw, host, { signal } = {}) { return serialized(() => prepareNow(raw, host, signal), signal); }

  async function renameCharacterNow(oldValue, newValue, signal) {
    const oldLocator = String(oldValue ?? '');
    const newLocator = String(newValue ?? '');
    if (!oldLocator || !newLocator || oldLocator === newLocator) {
      throw errorWith('QQJ_CHARACTER_RENAME_EVIDENCE_INVALID', '角色改名证据无效，未修改聊天身份。');
    }
    if (typeof client.list !== 'function') throw errorWith('QQJ_CHARACTER_RENAME_UNAVAILABLE', '聊天身份后端不支持角色改名迁移。');
    const listed = await client.list(CHAT_IDENTITY_COLLECTION, { signal });
    assertCurrent(signal);
    if (!Array.isArray(listed)) throw errorWith('QQJ_CHARACTER_RENAME_LIST_INVALID', '角色改名时无法读取聊天身份列表。');
    let migratedCount = 0;
    let skippedCount = 0;
    for (const envelope of listed) {
      if (envelope?.data?.owner?.characterLocator !== oldLocator) continue;
      const chatId = envelope?.data?.chatId;
      const binding = validateBindingEnvelope(envelope, chatId);
      if (envelope.recordId !== undefined && envelope.recordId !== key(chatId)) {
        throw errorWith('QQJ_CHAT_BINDING_INVALID', '聊天身份认领记录损坏，已停止读写以避免串档。');
      }
      const write = current => {
        const next = Object.freeze({
          ...current.data,
          owner: { ...current.data.owner, characterLocator: newLocator },
          updatedAt: nowIso(),
        });
        return client.put(CHAT_IDENTITY_COLLECTION, key(chatId), next, current.revision, { signal });
      };
      try {
        validateBindingEnvelope(await write(binding), chatId);
        migratedCount += 1;
        continue;
      } catch (error) {
        if (error?.status !== 409) throw error;
      }
      let winner = await read(chatId);
      assertCurrent(signal);
      if (!winner) throw errorWith('QQJ_CHARACTER_RENAME_CONFLICT', '角色改名迁移冲突且无法读取胜出记录。');
      if (winner.data.owner.characterLocator === newLocator) continue;
      if (winner.data.owner.characterLocator !== oldLocator) {
        skippedCount += 1;
        continue;
      }
      try {
        validateBindingEnvelope(await write(winner), chatId);
        migratedCount += 1;
        continue;
      } catch (error) {
        if (error?.status !== 409) throw error;
      }
      winner = await read(chatId);
      assertCurrent(signal);
      if (winner?.data.owner.characterLocator === newLocator) continue;
      if (winner && winner.data.owner.characterLocator !== oldLocator) {
        skippedCount += 1;
        continue;
      }
      throw errorWith('QQJ_CHARACTER_RENAME_CONFLICT', '角色改名迁移持续冲突，未覆盖胜出记录。');
    }
    return Object.freeze({ status: 'migrated', migratedCount, skippedCount });
  }
  function renameCharacter(oldLocator, newLocator, { signal } = {}) {
    return serialized(() => renameCharacterNow(oldLocator, newLocator, signal), signal);
  }

  const nonEmpty = value => Array.isArray(value) ? value.length > 0
    : value && typeof value === 'object' ? Object.keys(value).length > 0 : Boolean(value);
  async function assertTemporaryHasNoBusinessData(chatId) {
    let rootEnvelope;
    try { rootEnvelope = await client.get(`chat-${chatId}`, 'v3-root'); }
    catch (error) { if (error?.status === 404) return; throw error; }
    const root = rootEnvelope?.data;
    if (!root || root.chatId !== chatId || root.recordType !== 'root') {
      throw errorWith('QQJ_CHAT_RENAME_TEMP_INVALID', '改名期间建立的临时记忆档无法安全核验，已停止自动恢复。');
    }
    if (root.baselineId || root.activeRunId || nonEmpty(root.activeStateRefs) || nonEmpty(root.activeThreadRefs)) {
      throw errorWith('QQJ_CHAT_RENAME_TEMP_HAS_MEMORY', '改名期间的新档已经产生业务记忆，请先人工确认后再恢复旧档。');
    }
    if (!root.headCheckpointId) return;
    let checkpointEnvelope;
    try { checkpointEnvelope = await client.get(`chat-${chatId}`, `v3-checkpoint-${root.headCheckpointId}`); }
    catch (error) {
      if (error?.status === 404) throw errorWith('QQJ_CHAT_RENAME_TEMP_INVALID', '改名期间的新档缺少 checkpoint，已停止自动恢复。');
      throw error;
    }
    const checkpoint = checkpointEnvelope?.data;
    if (!checkpoint || checkpoint.chatId !== chatId || checkpoint.id !== root.headCheckpointId || checkpoint.recordType !== 'checkpoint') {
      throw errorWith('QQJ_CHAT_RENAME_TEMP_INVALID', '改名期间的新档 checkpoint 无法安全核验，已停止自动恢复。');
    }
    const refs = checkpoint.producedRefs;
    const businessKinds = ['floorMemories', 'entities', 'events', 'claims', 'knowledge', 'stateDeltas', 'currentStates', 'stateProjections', 'episodes', 'threads'];
    if (!refs || businessKinds.some(kind => !Array.isArray(refs[kind]) || refs[kind].length > 0)) {
      throw errorWith('QQJ_CHAT_RENAME_TEMP_HAS_MEMORY', '改名期间的新档已经产生业务记忆，请先人工确认后再恢复旧档。');
    }
  }
  async function renameNow(raw, host, event, previousIdentity, preparedIdentity, signal) {
    const owner = ownerFrom(host);
    const oldChatId = previousIdentity?.chatId;
    const oldHostChatId = String(previousIdentity?.hostChatId ?? '');
    const eventOld = hostFileName(event?.oldFileName);
    if (!isUuid(oldChatId) || !oldHostChatId || !eventOld || eventOld !== oldHostChatId
      || event?.groupId || hostFileName(event?.newFileName) === ''
      || owner.hostChatId === oldHostChatId
      || owner.characterLocator !== previousIdentity?.characterLocator
      || owner.personaLocator !== previousIdentity?.personaLocator
      || (event?.avatarId !== undefined && event?.avatarId !== null && String(event.avatarId) !== owner.characterLocator)) {
      throw errorWith('QQJ_CHAT_RENAME_EVIDENCE_INVALID', '聊天改名证据与当前身份不一致，已保持独立档案。');
    }
    if (preparedIdentity?.hostChatId !== owner.hostChatId
      || preparedIdentity?.chatId !== host.chatId
      || preparedIdentity?.characterLocator !== owner.characterLocator
      || preparedIdentity?.personaLocator !== owner.personaLocator) {
      throw errorWith('QQJ_CHAT_RENAME_RECEIPT_INVALID', '当前聊天身份不是本次切换准备的结果，已保持独立档案。');
    }
    const oldBinding = await read(oldChatId);
    const previousOwner = {
      hostChatId: oldHostChatId,
      characterLocator: previousIdentity.characterLocator,
      personaLocator: previousIdentity.personaLocator,
    };
    if (!oldBinding || oldBinding.data.state !== 'ready'
      || (!sameExactOwner(oldBinding.data.owner, previousOwner) && !sameExactOwner(oldBinding.data.owner, owner))) {
      throw errorWith('QQJ_CHAT_RENAME_SOURCE_INVALID', '原聊天身份已变化，已停止改名恢复以避免覆盖其它档案。');
    }
    const currentChatId = host.chatId;
    if (currentChatId !== null && currentChatId !== oldChatId) {
      if (!isUuid(currentChatId)) throw errorWith('QQJ_CHAT_RENAME_TARGET_INVALID', '当前聊天身份无效，已停止改名恢复。');
      const temporaryBinding = await read(currentChatId);
      if (!temporaryBinding || temporaryBinding.data.state !== 'ready'
        || temporaryBinding.data.sourceChatId !== oldChatId
        || !sameExactOwner(temporaryBinding.data.owner, owner)) {
        throw errorWith('QQJ_CHAT_RENAME_TARGET_INVALID', '当前聊天并非本次改名产生的临时身份，已保持独立档案。');
      }
      await assertTemporaryHasNoBusinessData(currentChatId);
    }
    await updateOwnerHost(oldBinding, owner, { signal, matches: sameExactOwner });
    assertCurrent(signal);
    await persist(raw, oldChatId);
    return oldChatId;
  }
  function rename(raw, host, { event, previousIdentity, preparedIdentity, signal } = {}) {
    return serialized(() => renameNow(raw, host, event, previousIdentity, preparedIdentity, signal), signal);
  }
  return Object.freeze({ prepare, rename, renameCharacter, read });
}
