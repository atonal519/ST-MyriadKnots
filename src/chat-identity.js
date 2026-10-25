import { isUuid, newUuid, persistChatId, persistChatFile } from './host-context.js';
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
    throw errorWith('QQJ_CHAT_BINDING_INVALID', '聊天身份认领记录损坏，请复制状态诊断反馈。');
  }
  return Object.freeze({ data: value, revision: envelope.revision });
}

export function createChatIdentityCoordinator({ client, persist = persistChatId, persistFile = persistChatFile, readTargetFile = null,
  freshUuid = newUuid, listHostChats = null, initializeBranch = null, now = () => new Date() } = {}) {
  if (!client?.get || !client?.put || typeof persist !== 'function' || typeof freshUuid !== 'function') throw new TypeError('聊天身份协调器参数无效');
  const key = id => `${BINDING_PREFIX}${id}`;
  const nowIso = () => now().toISOString();
  const assertCurrent = signal => { if (signal?.aborted) throw Object.assign(new Error('聊天身份准备已停止。'), { name: 'AbortError' }); };
  let sequence = Promise.resolve();
  const serialized = (task, signal) => { const result = sequence.then(() => { assertCurrent(signal); return task(); }); sequence = result.catch(() => {}); return result; };
  async function read(id) {
    try { return validateBindingEnvelope(await client.get(CHAT_IDENTITY_COLLECTION, key(id)), id); }
    catch (error) { if (error?.status === 404) return null; throw error; }
  }
  async function auxiliaryRead(id) { try { return await read(id); } catch { return null; } }
  async function publishAuxiliary(record, previous = null) {
    try { return validateBindingEnvelope(await client.put(CHAT_IDENTITY_COLLECTION, key(record.chatId), record, previous?.revision ?? 0), record.chatId); }
    catch { return null; }
  }
  async function prepareNow(raw, host, { signal, getTaskInputs, taskInputs, onProgress } = {}) {
    const owner = ownerFrom(host);
    let initialTargetFile;
    let qqj = raw.chatMetadata?.qianqianjie;
    // A missing or legacy page capture is derived input; the fixed file header
    // decides the identity before any new identity or binding can be written.
    if (readTargetFile && (!isUuid(host.chatId) || qqj?.schemaVersion !== 2)) {
      try { initialTargetFile = await readTargetFile(raw, host, { signal }); }
      catch (error) {
        if (!(error?.missing === true || error?.status === 404) || isUuid(host.chatId)) throw error;
        initialTargetFile = null;
      }
      assertCurrent(signal);
      if (initialTargetFile) {
        qqj = initialTargetFile.header.chat_metadata.qianqianjie;
        raw.chatMetadata ??= {};
        if (qqj === undefined) delete raw.chatMetadata.qianqianjie;
        else raw.chatMetadata.qianqianjie = { ...qqj };
      }
    }
    const inputs = () => {
      const value = taskInputs ?? getTaskInputs?.() ?? null;
      if (value && initialTargetFile !== undefined) value.initialTargetFile = initialTargetFile;
      return value;
    };
    let storedId = isUuid(qqj?.chatId) && [1, 2].includes(qqj.schemaVersion) ? qqj.chatId : null;
    if (!storedId) {
      const id = freshUuid();
      await persist(raw, id, inputs(), signal);
      return id;
    }
    // A stale character locator alone is a character rename, not a branch.
    if (qqj.file?.hostChatId === owner.hostChatId) {
      await persistFile(raw, host);
      return storedId;
    }
    const binding = qqj.file?.hostChatId ? null : await auxiliaryRead(storedId);
    const hint = qqj.file ?? binding?.data?.owner;
    const resume = binding?.data?.state === 'preparing' && sameOwner(binding.data.owner, owner)
      && isUuid(binding.data.sourceChatId) && storedId === await deterministicUuid(['qqj-chat-independent-v2', binding.data.sourceChatId, owner.hostChatId, owner.characterLocator]);
    let branching = false, names;
    if (hint?.hostChatId && hint.hostChatId !== owner.hostChatId && listHostChats) {
      names = await listHostChats(owner.characterLocator, { signal });
      assertCurrent(signal);
      branching = Array.isArray(names) && names.includes(owner.hostChatId) && names.includes(hint.hostChatId);
    }
    if (branching && readTargetFile && initialTargetFile === undefined) {
      initialTargetFile = await readTargetFile(raw, host, { signal });
      assertCurrent(signal);
      const priorId = storedId;
      qqj = initialTargetFile.header.chat_metadata.qianqianjie;
      raw.chatMetadata ??= {};
      if (qqj === undefined) delete raw.chatMetadata.qianqianjie;
      else raw.chatMetadata.qianqianjie = { ...qqj };
      storedId = isUuid(qqj?.chatId) && [1, 2].includes(qqj.schemaVersion) ? qqj.chatId : null;
      if (!storedId) {
        const id = freshUuid(); await persist(raw, id, inputs(), signal); return id;
      }
      // A file already carrying its own identity is an ordinary read, even if
      // the page still carried a parent's identity before this fixed read.
      const sourceFile = qqj.file?.hostChatId ?? (storedId === priorId ? hint?.hostChatId : null);
      branching = Boolean(sourceFile && sourceFile !== owner.hostChatId && names.includes(sourceFile));
    }
    if (!branching && !resume) {
      await persistFile(raw, host);
      return storedId;
    }
    if (!initializeBranch) throw errorWith('QQJ_CHAT_BRANCH_INITIALIZER_UNAVAILABLE', '聊天分支记忆继承尚未接入。');
    const sourceId = resume ? binding.data.sourceChatId : storedId;
    let targetId = resume ? storedId : await deterministicUuid(['qqj-chat-independent-v2', sourceId, owner.hostChatId, owner.characterLocator]);
    let prepared = resume ? binding : await auxiliaryRead(targetId);
    if (!resume && prepared?.data.state === 'ready') { targetId = freshUuid(); prepared = null; }
    if (!prepared) prepared = await publishAuxiliary(bindingRecord({ chatId: targetId, owner, state: 'preparing', sourceChatId: sourceId, createdAt: nowIso() }));
    const initialized = await initializeBranch({ raw, host, sourceChatId: sourceId, targetChatId: targetId,
      createdAt: prepared?.data.createdAt ?? nowIso(), signal, taskInputs: inputs(), onProgress });
    assertCurrent(signal);
    if (initialized?.persistedIdentity !== targetId) await persist(raw, targetId, inputs(), signal);
    await publishAuxiliary(bindingRecord({ chatId: targetId, owner, sourceChatId: sourceId, createdAt: prepared?.data.createdAt ?? nowIso() }), prepared);
    return targetId;
  }
  function prepare(raw, host, options = {}) { return serialized(() => prepareNow(raw, host, options), options.signal); }
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

  function rename(raw, host, options = {}) { return prepare(raw, host, options); }
  return Object.freeze({ prepare, rename, renameCharacter, read });
}
