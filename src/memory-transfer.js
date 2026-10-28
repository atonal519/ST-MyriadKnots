import { sha256, isUuid } from './identity.js';
import { CHAT_IDENTITY_COLLECTION } from './chat-identity.js';
import { chatFileFromHost, cloneHostJsonMetadata } from './host-context.js';
import { createFoundationStore } from './v3/foundation-store.js';
import { captureTargetChatDescriptor } from './v3/host-adapter.js';
import { readTargetChat, sameChatQqjData, sameQqjChatMetadata } from './v3/message-floor-anchor.js';
import { validatePeopleWorkspace } from './v3/people-workspace.js';
import { vectorRecordOwned } from './v3/vector-index.js';
import { normalizeStoryCalendar } from './v3/calendar-rules.js';
import { scanAssistantCandidates, selectAssistantMessage } from './v3/foundation-domain.js';
import { matchFloorCandidates } from './v3/floor-binding.js';
import { partitionScannedCandidates } from './v3/migration-prefix.js';
import { MESSAGE_MEMORY_EXCLUSION_KEY } from './v3/memory-exclusion.js';
import { stableJson } from './memory-transfer-json.js';
import { createActivitySignal } from './plugin-activity.js';
import { createAvatarImageStore } from './avatar-image-store.js';
import { createMemoryVolumes, openMemoryVolumes, MEMORY_VOLUME_BYTES } from './memory-transfer-volumes.js';
import { openMemoryBundle } from './memory-transfer-bundle.js';
import { validateTransferGraph, transferRecordKey } from './memory-transfer-graph.js';

export const MEMORY_PACKAGE_LIMIT = 64 * 1024 * 1024;
const FORMAT = 'qqj-core-chat-memory', VERSION = 2, ROLLBACK = 'self-use-memory-transfer-rollback-v1';
const ANCHOR = 'qianqianjie_floor', HIDDEN = 'qianqianjieAutoHide', RECEIPT = 'qqj_v3_recall_receipt';
const clone = value => structuredClone(value);
const fail = message => Object.assign(new Error(message), { code: 'QQJ_MEMORY_TRANSFER' });
const check = (condition, message) => { if (!condition) throw fail(message); };
const same = (a, b) => stableJson(a) === stableJson(b);
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
const coreTypes = new Set(['root', 'floor', 'run', 'checkpoint', 'floorMemory', 'entity', 'baseline', 'stateDelta', 'currentState', 'migrationDescriptor', 'index']);
const isAux = id => id === 'v3-people-workspace' || /^v3-people-snapshot-[\da-f-]{36}$/i.test(id)
  || id === 'v3-time-head' || /^v3-time-batch-[\da-f]{32}$/.test(id)
  || (id.startsWith('v3-time-batch-') && isUuid(id.slice('v3-time-batch-'.length)))
  || id === 'qqj-vector-index' || /^qqj-vector-shard-[\da-f]{40}$/.test(id);
const peopleWorkspaces = records => records.flatMap(item => item.id === 'v3-people-workspace' ? [item.data]
  : item.id.startsWith('v3-people-snapshot-') ? [item.data.workspace] : []);
const MESSAGE_KEYS = [ANCHOR, HIDDEN, RECEIPT, 'qianqianjie_migration_alias', MESSAGE_MEMORY_EXCLUSION_KEY];
const HEADER_KEYS = ['qianqianjie', 'qianqianjiePrequel'];
function validateVolumeRecord(item, chatId) {
  check(item && typeof item.id === 'string' && item.data?.chatId === chatId, '记忆记录归属不一致。');
  if (coreTypes.has(item.data.recordType)) {
    check(transferRecordKey(item.data) === item.id, '记忆记录编号不匹配。');
    return;
  }
  check(isAux(item.id), '记忆包包含不支持的记录类型。');
  if (item.id === 'v3-people-workspace') validatePeopleWorkspace(item.data, chatId);
  else if (item.id.startsWith('v3-people-snapshot-')) {
    check(item.data.kind === 'qqj-v3-frozen-people-snapshot' && isUuid(item.data.sourceChatId), '人物历史副本无效。');
    validatePeopleWorkspace(item.data.workspace, chatId);
  } else if (item.id.startsWith('qqj-vector-')) check(vectorRecordOwned({ recordId: item.id, data: item.data }), '向量记录无效。');
  else check(item.data.schemaVersion === 1 && (item.id === 'v3-time-head' ? Array.isArray(item.data.batchIds) : item.data.id === item.id), '时间记录无效。');
}
function storyProjection(message) {
  const normalize = text => String(text ?? '').replace(/\r\n?/g, '\n');
  const selected = selectAssistantMessage(message);
  return { user: message.is_user === true, type: message.extra?.type ?? null,
    text: normalize(message.mes), selectedText: selected ? normalize(selected.rawContent) : null };
}
function sameConversation(left, right) {
  const selectedIndex = message => { const selected = selectAssistantMessage(message); return selected ? selected.selectedSwipeIndex ?? 0 : null; };
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((message, index) => same(storyProjection(message), storyProjection(right[index]))
      && selectedIndex(message) === selectedIndex(right[index]));
}
const sameMetadata = (left, right) => sameQqjChatMetadata(left, right, { includeFile: true, includePrequel: true });
const sameInputs = (left, right) => sameConversation(left.chat, right.chat) && sameChatQqjData(left.chat, right.chat)
  && sameMetadata(left.header.chat_metadata, right.header.chat_metadata);
function hasColdSwipes(message) {
  const reference = message?.tt_swipe_cold, selected = message?.swipe_id;
  return Number.isSafeInteger(reference?.sourceId) && reference.sourceId >= 0 && Number.isSafeInteger(reference.record) && reference.record > 0
    && Number.isSafeInteger(selected) && selected >= 0 && Array.isArray(message.swipes) && Array.isArray(message.swipe_info)
    && message.swipes.length === message.swipe_info.length && typeof message.swipes[selected] === 'string'
    && message.swipe_info[selected] !== null && typeof message.swipe_info[selected] === 'object'
    && message.swipe_info.some((swipe, index) => index !== selected && swipe === null && message.swipes[index] === null);
}
function sameCapturedInputs(saved, captured) {
  // TT leaves unloaded alternative slots null. Compare their saved ownership
  // without loading their bodies into the live chat or replacing loaded edits.
  const chat = captured.chat.map((message, index) => hasColdSwipes(message) ? { ...message,
    swipe_info: message.swipe_info.map((swipe, n) => swipe === null && message.swipes[n] === null
      ? { extra: mergeOwned({}, saved.chat[index]?.swipe_info?.[n]?.extra, MESSAGE_KEYS) } : swipe) } : message);
  const page = { chat, header: { chat_metadata: captured.metadata } };
  if (sameInputs(saved, page)) return true;
  // Session preparation refreshes this derived file hint before the next host save.
  const metadata = saved.header.chat_metadata;
  if (![1, 2].includes(metadata.qianqianjie?.schemaVersion)) return false;
  const prepared = { ...metadata, qianqianjie: { ...metadata.qianqianjie, schemaVersion: 2,
    file: chatFileFromHost(captured.identity) } };
  return sameInputs({ chat: saved.chat, header: { chat_metadata: prepared } }, page);
}
function mergeOwned(base, expected, keys) {
  const result = { ...base };
  for (const key of keys) {
    if (Object.hasOwn(expected ?? {}, key)) result[key] = clone(expected[key]);
    else delete result[key];
  }
  return result;
}
function mergeMessage(base, expected) {
  return { ...base, extra: mergeOwned(base.extra, expected?.extra, MESSAGE_KEYS),
    ...(Array.isArray(base.swipe_info) ? { swipe_info: base.swipe_info.map((swipe, index) => ({ ...swipe,
      extra: mergeOwned(swipe?.extra, expected?.swipe_info?.[index]?.extra, MESSAGE_KEYS) })) } : {}) };
}

const missingReloadField = Symbol('missing reload field');
function mergeReloadFields(saved, draft, latest) {
  const equal = (left, right) => left === missingReloadField || right === missingReloadField ? left === right : same(left, right);
  if (equal(draft, saved)) return latest;
  if (equal(latest, saved)) return draft;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (object(draft) && object(latest) && (saved === missingReloadField || object(saved))) {
    const keys = new Set([...Object.keys(saved === missingReloadField ? {} : saved), ...Object.keys(draft), ...Object.keys(latest)]);
    const field = (value, key) => Object.hasOwn(value, key) ? value[key] : missingReloadField;
    return Object.fromEntries([...keys].flatMap(key => {
      const value = mergeReloadFields(saved === missingReloadField ? saved : field(saved, key), field(draft, key), field(latest, key));
      return value === missingReloadField ? [] : [[key, value]];
    }));
  }
  return latest;
}
function mergeColdReloadMessage(saved, live, refreshed) {
  const merged = mergeReloadFields(saved, live, refreshed);
  const restored = { ...merged, extra: mergeOwned(merged.extra, refreshed.extra, MESSAGE_KEYS) };
  for (const key of ['swipes', 'swipe_info']) if (Array.isArray(live[key]) && Array.isArray(refreshed[key])) {
    const values = new Array(Math.max(live[key].length, refreshed[key].length));
    for (let index = 0; index < values.length; index++) {
      const beforeCold = live.swipes?.[index] === null && live.swipe_info?.[index] === null;
      const afterCold = refreshed.swipes?.[index] === null && refreshed.swipe_info?.[index] === null;
      // Cold nulls are unknown slots, not edits that delete a loaded reply.
      const field = message => Object.hasOwn(message[key] ?? {}, index) ? message[key][index] : missingReloadField;
      const base = field(saved);
      const value = beforeCold && afterCold ? null : mergeReloadFields(base, beforeCold ? base : field(live), afterCold ? base : field(refreshed));
      if (value !== missingReloadField) values[index] = key === 'swipe_info' && value !== null
        ? { ...value, extra: mergeOwned(value.extra, saved.swipe_info?.[index]?.extra, MESSAGE_KEYS) } : value;
    }
    while (values.length && !Object.hasOwn(values, values.length - 1)) values.pop();
    restored[key] = values;
  }
  delete restored.tt_swipe_cold;
  if (Object.hasOwn(refreshed, 'tt_swipe_cold')) restored.tt_swipe_cold = refreshed.tt_swipe_cold;
  return restored;
}

// V1 mixed body and host bookkeeping into one irreversible hash. Keep its exact
// reader for existing packages/undo records; V2 compares story content separately.
export async function transferWitness(chat, { version = VERSION } = {}) {
  check(Array.isArray(chat) && chat.length > 0 && chat.length <= 20000, '聊天内容为空或超过支持的楼数。');
  if (version === 2) return Promise.all(chat.map(message => sha256(stableJson(storyProjection(message)))));
  return Promise.all(chat.map(async message => sha256(stableJson({
    user: message.is_user === true, system: message.is_system === true && message.extra?.[HIDDEN]?.schemaVersion !== 1,
    text: String(message.mes ?? '').replace(/\r\n?/g, '\n'),
    swipe: message.swipe_id ?? null, swipes: message.swipes ?? null,
    sentAt: message.is_user ? message.send_date ?? null : null,
    userNameWithoutTimestamp: message.is_user && !message.send_date ? String(message.name ?? '').trim().slice(0, 200) : null,
    narrator: message.extra?.type === 'narrator',
  }))));
}

async function volumeWitness(chat) {
  check(Array.isArray(chat) && chat.length > 0, '聊天内容为空。');
  const witnesses = [];
  for (const message of chat) witnesses.push(await sha256(stableJson(storyProjection(message))));
  return witnesses;
}

function memoryClient(records, chatId) {
  const data = new Map(records.map(item => [item.id, clone(item.data)]));
  return {
    async get(collection, id) {
      if (collection !== `chat-${chatId}` || !data.has(id)) throw Object.assign(new Error('missing'), { status: 404 });
      return { data: clone(data.get(id)), revision: 1 };
    },
    async put(collection, id, value) { data.set(id, clone(value)); return { data: clone(value), revision: 1 }; },
  };
}

async function validateRecords(records, chatId) {
  check(Array.isArray(records) && records.length > 0 && records.length <= 50000, '记忆包记录数量无效。');
  const client = memoryClient(records, chatId), store = createFoundationStore({ client, contextProvider: () => ({ chatId }) });
  const seen = new Set();
  for (const item of records) {
    check(item && typeof item.id === 'string' && !seen.has(item.id) && item.data?.chatId === chatId, '记忆包有重复记录或归属不一致。');
    seen.add(item.id);
    if (coreTypes.has(item.data.recordType)) {
      check(store.recordKey(item.data) === item.id, '记忆记录编号不匹配。');
      await store.readRecord(item.data.recordType, item.id);
    } else {
      check(isAux(item.id), '记忆包包含不支持的记录类型。');
      if (item.id === 'v3-people-workspace') validatePeopleWorkspace(item.data, chatId);
      else if (item.id.startsWith('v3-people-snapshot-')) {
        check(item.data.kind === 'qqj-v3-frozen-people-snapshot' && isUuid(item.data.sourceChatId), '人物历史副本无效。');
        validatePeopleWorkspace(item.data.workspace, chatId);
      } else if (item.id.startsWith('qqj-vector-')) check(vectorRecordOwned({ recordId: item.id, data: item.data }), '向量记录无效。');
      else check(item.data.schemaVersion === 1 && (item.id === 'v3-time-head' ? Array.isArray(item.data.batchIds) : item.data.id === item.id), '时间记录无效。');
    }
  }
  const graph = await store.readReachable({ mode: 'full' });
  check(graph.status === 'ready' && graph.checkpoint && !graph.root.activeRunId, '记忆包的摘要或人物状态记录不完整，请等待旧设备处理完成后重新导出。');
  const byId = new Map(records.map(item => [item.id, item.data]));
  for (const id of [...(byId.get('v3-time-head')?.batchIds ?? []), ...(byId.get('qqj-vector-index')?.shardIds ?? []),
    ...(graph.migrationDescriptor?.recordRefs?.timeBatchIds ?? []), ...(graph.migrationDescriptor?.recordRefs?.peopleSnapshotIds ?? []),
    ...(graph.migrationDescriptor?.recordRefs?.vectorShardIds ?? [])]) check(byId.has(id), '记忆包缺少关联的时间、人物或向量记录。');
  return graph;
}

export async function parseMemoryPackage(input) {
  check(bytes(input) <= MEMORY_PACKAGE_LIMIT, '记忆包不能超过 64 MB。');
  let value;
  try { value = typeof input === 'string' ? JSON.parse(input) : clone(input); } catch { throw fail('文件不是有效的 JSON 记忆包。'); }
  check(value?.format === FORMAT && [1, VERSION].includes(value.formatVersion) && isUuid(value.source?.chatId), '这不是支持的千千结记忆包。请用“导出当前聊天记忆”生成文件。');
  const { checksum, ...payload } = value;
  check(typeof checksum === 'string' && checksum === await sha256(stableJson(payload)), '记忆包完整性校验失败，文件可能损坏。');
  check(Array.isArray(value.messages) && value.messages.length > 0 && value.messages.length <= 20000
    && value.messages.every(hash => /^[a-f0-9]{64}$/.test(hash)), '聊天核对信息无效。');
  check(Array.isArray(value.markers) && value.markers.length === value.messages.length, '楼层标记数量不匹配。');
  check(value.prequel === null || typeof value.prequel === 'string', '前情内容无效。');
  check(value.calendar === null || normalizeStoryCalendar(value.calendar), '故事历法设置无效。');
  const graph = await validateRecords(value.records, value.source.chatId);
  validateMarkers(value, graph);
  return { value, graph };
}

function validateMarkers(value, graph) {
  const aliases = new Set((graph.migrationDescriptor?.carriedAliases ?? []).map(alias => alias.aliasId));
  for (const markers of value.markers) {
    check(markers && typeof markers.extra === 'object' && Array.isArray(markers.swipes), '楼层标记格式无效。');
    for (const extra of [markers.extra, ...markers.swipes]) {
      check(extra && typeof extra === 'object' && !Array.isArray(extra), '楼层标记格式无效。');
      const anchor = extra[ANCHOR], hidden = extra[HIDDEN], alias = extra.qianqianjie_migration_alias;
      if (anchor) check(anchor.schemaVersion === 1 && anchor.chatId === value.source.chatId && isUuid(anchor.floorId), '楼层锚点无效。');
      if (hidden) check(hidden.schemaVersion === 1 && hidden.chatId === value.source.chatId, '隐藏楼层标记无效。');
      if (alias) check(aliases.has(alias), '搬家楼层标记无效。');
    }
  }
}

async function verifyConversation(graph, chat, sanitizerOptions) {
  const scanned = await scanAssistantCandidates(chat, { chatId: graph.root.chatId, sanitizerOptions });
  const candidates = partitionScannedCandidates(graph, chat, graph.root.chatId, scanned).all;
  const bindings = matchFloorCandidates(graph.floors, candidates);
  const missing = graph.floors.findIndex((_, index) => !bindings.floorMatches.has(index));
  check(!bindings.issue && missing < 0,
    `记忆中的楼层无法确认绑定：第 ${bindings.issue?.messageIndex ?? graph.floors[missing]?.hostLocator.messageIndex} 楼（从 0 开始）。请核对楼层标识、正文或清洗设置。`);
  return bindings;
}

function ownedMarkers(message, chatId, aliases) {
  const select = extra => Object.fromEntries([ANCHOR, HIDDEN, 'qianqianjie_migration_alias', MESSAGE_MEMORY_EXCLUSION_KEY].filter(key => key === MESSAGE_MEMORY_EXCLUSION_KEY
    ? extra?.[key] === true : key === 'qianqianjie_migration_alias' ? aliases.has(extra?.[key])
      : extra?.[key]?.schemaVersion === 1 && extra[key].chatId === chatId).map(key => [key, clone(extra[key])]));
  return { extra: select(message.extra), swipes: (message.swipe_info ?? []).map(item => select(item?.extra)) };
}
function exportMarkers(chat, graph, bindings) {
  const chatId = graph.root.chatId;
  const aliases = new Set((graph.migrationDescriptor?.carriedAliases ?? []).map(alias => alias.aliasId));
  const markers = chat.map(message => ownedMarkers(message, chatId, aliases));
  // Match the host's current positions; persisted floor content stays historical.
  for (const { floor, candidate } of bindings.matches) if (!candidate.archiveCandidate) {
    markers[candidate.hostLocator.messageIndex].extra[ANCHOR] = { schemaVersion: 1, chatId, floorId: floor.id };
  }
  return markers;
}
function rehomeRecord(item, chatId) {
  const data = { ...clone(item.data), chatId };
  if (data.workspace) data.workspace.chatId = chatId;
  return { id: item.id, data };
}

export function createMemoryTransfer({ client, session, hostAdapter, isBusy = () => false, quiesce = async () => {},
  onSettled = async () => {}, captureCalendar = () => null, persistCalendar = async () => {}, sanitizerOptions = () => ({}),
  fetchImpl = globalThis.fetch, freshUuid = () => globalThis.crypto.randomUUID(), now = () => new Date(), pluginVersion = '0.7.8' } = {}) {
  let active = false;
  const activity = createActivitySignal(() => ({ busy: active, phase: active ? 'migrating' : null }));
  const previews = new WeakMap();
  const capture = () => {
    const snapshot = hostAdapter.snapshot(), identity = session.identity();
    return { identity, target: captureTargetChatDescriptor(snapshot, identity), persona: clone(snapshot.userIdentity), chat: clone(snapshot.chat), metadata: cloneHostJsonMetadata(snapshot.context.chatMetadata) };
  };
  const current = captured => {
    const snap = hostAdapter.snapshot();
    const character = snap.context.characters?.[snap.context.characterId];
    check(snap.chatId === captured.identity.hostChatId && character?.avatar === captured.target.avatarUrl
      && same(snap.userIdentity, captured.persona)
      && snap.context.chatMetadata?.qianqianjie?.chatId === captured.identity.chatId
      && sameConversation(snap.chat, captured.chat) && sameChatQqjData(snap.chat, captured.chat)
      && sameMetadata(snap.context.chatMetadata, captured.metadata), '聊天已切换或内容有变化，请重新选择记忆包并预览。');
  };
  async function exclusive(captured, task, options = {}) {
    check(!active && !isBusy(), '请等待聊天生成和记忆任务完成后再操作。'); current(captured);
    active = true;
    activity.notifyActivity();
    let suspended = false;
    try {
      session.suspend(captured.identity.chatId); suspended = true;
      await quiesce(); current(captured);
      return await task();
    } finally {
      if (suspended) session.resume(captured.identity.chatId);
      try { await onSettled({ streaming: options.streaming === true }); } catch { /* Saved state can be reloaded from the host. */ }
      active = false;
      activity.notifyActivity();
    }
  }
  async function exportCurrent() {
    const captured = capture();
    return exclusive(captured, async () => {
      const collected = new Map(); let collectedBytes = 0;
      const collect = (id, result) => {
        if (!collected.has(id)) collectedBytes += bytes({ id, data: result.data });
        check(collectedBytes <= MEMORY_PACKAGE_LIMIT, '普通记忆包超过 64 MB，请使用“自动导出大记忆包”。');
        collected.set(id, result);
      };
      const tracking = { ...client, async get(collection, id) { const result = await client.get(collection, id); collect(id, result); return result; } };
      if (client.getMany) tracking.getMany = async (collection, ids) => {
        const results = await client.getMany(collection, ids);
        for (const item of results) if (item.status === 200) collect(item.recordId, item.envelope);
        return results;
      };
      const store = createFoundationStore({ client: tracking, contextProvider: () => captured.identity });
      const graph = await store.readReachable({ mode: 'full' });
      check(graph.status === 'ready' && graph.checkpoint && !graph.root.activeRunId, '当前记忆尚未准备好，请先刷新状态或补齐缺失。');
      let auxiliaryCount = 0;
      for await (const record of iterateCollection(`chat-${captured.identity.chatId}`)) if (isAux(record.recordId)) {
        auxiliaryCount++;
        if (record.data?.chatId === captured.identity.chatId) collect(record.recordId, record);
      }
      const records = [...collected].map(([id, record]) => ({ id, data: clone(record.data) }));
      await validateRecords(records, captured.identity.chatId);
      const bindings = await verifyConversation(graph, captured.chat, sanitizerOptions());
      const avatarImages = [];
      const sources = new Map(peopleWorkspaces(records).flatMap(workspace => Object.values(workspace.avatarSourcesByEntityId ?? {})).map(source => [source.path, source]));
      for (const source of sources.values()) {
        const response = await fetchImpl(source.path, { headers: captured.target.requestHeaders });
        check(response?.ok, '人物头像原图读取失败，请检查原图后重新导出。');
        const data = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < data.length; offset += 32768) binary += String.fromCharCode(...data.subarray(offset, offset + 32768));
        avatarImages.push({ path: source.path, mimeType: source.mimeType, data: btoa(binary) });
      }
      let verified = 0, verifiedAuxiliary = 0;
      for await (const item of iterateCollection(`chat-${captured.identity.chatId}`)) {
        if (isAux(item.recordId)) verifiedAuxiliary++;
        const old = collected.get(item.recordId); if (!old) continue;
        check(item.revision === old.revision && same(item.data, old.data), '导出期间记忆发生变化，请重试。'); verified++;
      }
      check(verified === collected.size && verifiedAuxiliary === auxiliaryCount, '导出期间记忆发生变化，请重试。');
      current(captured);
      const payload = { format: FORMAT, formatVersion: VERSION, pluginVersion, exportedAt: now().toISOString(),
        source: { chatId: captured.identity.chatId, character: captured.target.characterName },
        messages: await transferWitness(captured.chat), markers: exportMarkers(captured.chat, graph, bindings), records,
        prequel: typeof captured.metadata.qianqianjiePrequel === 'string' ? captured.metadata.qianqianjiePrequel : null,
        calendar: clone(captureCalendar(captured.identity.chatId)), ...(avatarImages.length ? { avatarImages } : {}) };
      const value = { ...payload, checksum: await sha256(stableJson(payload)) };
      check(bytes(value) <= MEMORY_PACKAGE_LIMIT, '普通记忆包超过 64 MB，请使用“自动导出大记忆包”。');
      return { filename: `千千结记忆-${now().toISOString().replace(/[:.]/g, '-')}.qqj-memory.json`, text: JSON.stringify(value) };
    });
  }
  async function* iterateCollection(collection) {
    if (typeof client.iterRecords === 'function') { yield* client.iterRecords(collection); return; }
    const records = await client.list(collection);
    check(Array.isArray(records), '存储接口未返回记录清单。'); yield* records;
  }
  async function preview(input) {
    check(!active && !isBusy(), '请等待聊天生成和记忆任务完成后再导入。');
    const captured = capture(), { value, graph } = await parseMemoryPackage(input);
    check(captured.chat.length === value.messages.length,
      `当前聊天与记忆包不一致：当前 ${captured.chat.length} 条，记忆包 ${value.messages.length} 条。请打开对应的完整聊天记录。`);
    const actual = await transferWitness(captured.chat, { version: value.formatVersion });
    const mismatch = actual.findIndex((hash, index) => hash !== value.messages[index]);
    check(mismatch < 0, value.formatVersion === 1
      ? `旧版记忆包在第 ${mismatch} 楼的综合校验不同，可能只是时间戳、候选编号或隐藏标记变化，不能据此判断正文不同。请两边更新插件，在旧设备重新导出记忆包后再试，无需重做摘要。`
      : `当前聊天与记忆包不一致：第 ${mismatch} 楼的发言方、正文或当前选中的回复不同（楼号从 0 开始）。请核对该楼；本次未写入记忆。`);
    const sourceChat = captured.chat.map((message, index) => ({ ...message,
      extra: mergeOwned(message.extra, value.markers[index].extra, MESSAGE_KEYS) }));
    await verifyConversation(graph, sourceChat, sanitizerOptions());
    current(captured);
    const oldRoot = await optionalGet(`chat-${captured.identity.chatId}`, 'v3-root'); current(captured);
    const result = Object.freeze({ character: value.source.character, messages: value.messages.length,
      summaries: graph.floorMemories.filter(item => item.recordStatus === 'active' && item.summary).length,
      states: graph.stateDeltas.filter(item => item.recordStatus === 'active').length,
      replacesMemory: Boolean(oldRoot?.data?.headCheckpointId), exportedAt: value.exportedAt });
    previews.set(result, { captured, value, graph, oldRoot });
    return result;
  }
  async function checkAuxiliaryLinks(graph, ids, readRecord) {
    const present = new Set(ids), refs = graph.migrationDescriptor?.recordRefs;
    const time = present.has('v3-time-head') ? await readRecord('v3-time-head') : null;
    const vector = present.has('qqj-vector-index') ? await readRecord('qqj-vector-index') : null;
    for (const id of [...(time?.batchIds ?? []), ...(vector?.shardIds ?? []), ...(refs?.timeBatchIds ?? []),
      ...(refs?.peopleSnapshotIds ?? []), ...(refs?.vectorShardIds ?? [])]) {
      check(present.has(id), '记忆包缺少关联的时间、人物或向量记录。');
    }
  }
  async function* volumeEntries(captured, signal, onProgress) {
    const collection = `chat-${captured.identity.chatId}`;
    const report = (phase, completed, total = null) => onProgress?.({ phase, completed, total });
    report('records', 0);
    const rootEnvelope = await optionalGet(collection, 'v3-root', { signal }), root = rootEnvelope?.data;
    check(root?.headCheckpointId && !root.activeRunId, '当前记忆尚未准备好，请先刷新状态或补齐缺失。');
    const checkpoint = (await client.get(collection, `v3-checkpoint-${root.headCheckpointId}`, { signal })).data;
    const refs = checkpoint.producedRefs;
    const coreIds = new Set(['v3-root', `v3-checkpoint-${root.headCheckpointId}`, `v3-run-${checkpoint.runId}`,
      ...(root.baselineId ? [`v3-baseline-${root.baselineId}`] : []),
      ...(root.migrationDescriptorId ? [`v3-migration-${root.migrationDescriptorId}`] : []),
      ...refs.floors.map(id => `v3-floor-${id}`), ...refs.floorMemories.map(id => `v3-floor-memory-${id}`),
      ...refs.entities.map(id => `v3-entity-${id}`), ...refs.stateDeltas.map(id => `v3-state-delta-${id}`),
      ...refs.currentStates.map(id => `v3-current-state-${id}`), ...refs.indexes]);
    const revisions = new Map(), sources = new Map();
    let scanned = 0;
    check(typeof client.iterRecords === 'function', '请更新白鸟数据后端后使用分卷导出。');
    for await (const envelope of client.iterRecords(collection, { signal, requireStreaming: true })) {
      report('records', ++scanned);
      if (!coreIds.has(envelope.recordId) && !(isAux(envelope.recordId) && envelope.data?.chatId === captured.identity.chatId)) continue;
      const item = { id: envelope.recordId, data: envelope.data };
      validateVolumeRecord(item, captured.identity.chatId);
      check(!revisions.has(item.id), '存储清单含有重复记录。');
      revisions.set(item.id, { revision: envelope.revision, bytes: bytes(item.data) });
      for (const workspace of peopleWorkspaces([item])) for (const source of Object.values(workspace.avatarSourcesByEntityId ?? {})) sources.set(source.path, source);
      yield { kind: 'record', ...item };
    }
    check([...coreIds].every(id => revisions.has(id)) && revisions.get('v3-root')?.revision === rootEnvelope.revision,
      '导出期间记忆发生变化，请重新导出。');
    let readPhase = 'graph', readCount = 0;
    report(readPhase, readCount);
    const checkedData = (id, envelope) => {
      check(envelope && envelope.revision === revisions.get(id)?.revision, '导出期间记忆发生变化，请重新导出。');
      report(readPhase, ++readCount);
      return envelope.data;
    };
    const readRecord = async id => {
      const envelope = await client.get(collection, id, { signal });
      return checkedData(id, envelope);
    };
    const readRecords = async function* (ids) {
      if (typeof client.getMany !== 'function') { for (const id of ids) yield await readRecord(id); return; }
      let batch = [], batchBytes = 0;
      const readBatch = async function* () {
        const result = await client.getMany(collection, batch, { signal });
        check(Array.isArray(result) && result.length === batch.length, '存储批量读取结果无效。');
        for (let index = 0; index < batch.length; index++) {
          const item = result[index], id = batch[index];
          check(item?.recordId === id, '存储批量读取结果无效。');
          if (item.status !== 200) throw Object.assign(new Error(item.message || '读取记忆记录失败。'), { status: item.status });
          try { yield checkedData(id, item.envelope); }
          finally { result[index] = null; }
        }
      };
      for (const id of ids) {
        const size = revisions.get(id)?.bytes;
        check(Number.isSafeInteger(size), '导出期间记忆发生变化，请重新导出。');
        if (batch.length && (batch.length === 64 || batchBytes + size > MEMORY_VOLUME_BYTES)) {
          yield* readBatch(); batch = []; batchBytes = 0;
        }
        if (size > MEMORY_VOLUME_BYTES) { yield await readRecord(id); continue; }
        batch.push(id); batchBytes += size;
      }
      if (batch.length) yield* readBatch();
    };
    const graph = await validateTransferGraph({ chatId: captured.identity.chatId, recordIds: revisions.keys(), readRecord, readRecords });
    readPhase = 'auxiliary'; readCount = 0; report(readPhase, readCount);
    await checkAuxiliaryLinks(graph, revisions.keys(), readRecord);
    report('conversation', 0, captured.chat.length);
    const bindings = await verifyConversation(graph, captured.chat, sanitizerOptions());
    report('conversation', captured.chat.length, captured.chat.length);
    let avatars = 0; report('avatars', avatars, sources.size);
    for (const source of sources.values()) {
      const response = await fetchImpl(source.path, { headers: captured.target.requestHeaders, signal });
      check(response?.ok, '人物头像原图读取失败，请检查原图后重新导出。');
      const data = new Uint8Array(await response.arrayBuffer()); let binary = '';
      for (let offset = 0; offset < data.length; offset += 32768) binary += String.fromCharCode(...data.subarray(offset, offset + 32768));
      report('avatars', ++avatars, sources.size);
      yield { kind: 'avatar', path: source.path, mimeType: source.mimeType, data: btoa(binary) };
    }
    let verified = 0; scanned = 0; report('verify', scanned);
    for await (const envelope of client.iterRecords(collection, { signal, requireStreaming: true })) {
      report('verify', ++scanned);
      if (!coreIds.has(envelope.recordId) && !(isAux(envelope.recordId) && envelope.data?.chatId === captured.identity.chatId)) continue;
      check(revisions.get(envelope.recordId)?.revision === envelope.revision, '导出期间记忆发生变化，请重新导出。'); verified++;
    }
    check(verified === revisions.size, '导出期间记忆发生变化，请重新导出。'); current(captured);
    report('manifest', 0, 1);
    yield { kind: 'header', value: { format: FORMAT, formatVersion: 3, pluginVersion, exportedAt: now().toISOString(),
      source: { chatId: captured.identity.chatId, character: captured.target.characterName }, messages: await volumeWitness(captured.chat),
      markers: exportMarkers(captured.chat, graph, bindings),
      prequel: typeof captured.metadata.qianqianjiePrequel === 'string' ? captured.metadata.qianqianjiePrequel : null,
      calendar: clone(captureCalendar(captured.identity.chatId)) } };
  }
  async function* exportVolumeIterator({ partBytes, signal, onProgress } = {}) {
    const captured = capture();
    check(!active && !isBusy(), '请等待聊天生成和记忆任务完成后再操作。'); current(captured);
    active = true; activity.notifyActivity(); let suspended = false;
    try {
      session.suspend(captured.identity.chatId); suspended = true; await quiesce(); current(captured);
      for await (const part of createMemoryVolumes(volumeEntries(captured, signal, onProgress), { archiveId: freshUuid(), partBytes,
        source: { chatId: captured.identity.chatId, character: captured.target.characterName }, exportedAt: now().toISOString() })) {
        current(captured);
        if (part.manifest) onProgress?.({ phase: 'manifest', completed: 1, total: 1 });
        yield part;
      }
    } finally {
      if (suspended) session.resume(captured.identity.chatId);
      try { await onSettled({ streaming: true }); } catch { /* Saved state can be reloaded from the host. */ }
      active = false; activity.notifyActivity();
    }
  }
  function exportVolumes(options = {}) {
    const controller = new AbortController(), iterator = exportVolumeIterator({ ...options, signal: controller.signal });
    return { next: () => iterator.next(), return() { controller.abort(); return iterator.return(); }, [Symbol.asyncIterator]() { return this; } };
  }
  async function previewVolumes(files) {
    check(!active && !isBusy(), '请等待聊天生成和记忆任务完成后再导入。');
    const captured = capture();
    const selected = Array.from(files), options = { onRecord: (item, chatId) => validateVolumeRecord(item, chatId) };
    const archive = selected.length === 1 && /\.qqj-memory$/i.test(selected[0].name ?? '')
      ? await openMemoryBundle(selected[0], options) : await openMemoryVolumes(selected, options);
    const value = archive.header;
    check(value.format === FORMAT && value.formatVersion === 3 && value.source.chatId === archive.manifest.source.chatId,
      '分卷聊天说明无效。');
    check(Array.isArray(value.messages) && Array.isArray(value.markers) && value.messages.length === value.markers.length
      && value.messages.every(hash => /^[a-f0-9]{64}$/.test(hash)), '聊天核对信息无效。');
    check(value.prequel === null || typeof value.prequel === 'string', '前情内容无效。');
    check(value.calendar === null || normalizeStoryCalendar(value.calendar), '故事历法设置无效。');
    check(captured.chat.length === value.messages.length, '当前聊天与分卷的聊天数量不同，请打开对应的完整聊天。');
    const actual = await volumeWitness(captured.chat), mismatch = actual.findIndex((hash, index) => hash !== value.messages[index]);
    check(mismatch < 0, `当前聊天与记忆包不一致：第 ${mismatch} 楼的发言方、正文或当前选中的回复不同（楼号从 0 开始）。`);
    const graph = await validateTransferGraph({ chatId: value.source.chatId, recordIds: archive.recordIds, readRecord: archive.readRecord });
    await checkAuxiliaryLinks(graph, archive.recordIds, archive.readRecord);
    validateMarkers(value, graph);
    const sourceChat = captured.chat.map((message, index) => ({ ...message, extra: mergeOwned(message.extra, value.markers[index].extra, MESSAGE_KEYS) }));
    await verifyConversation(graph, sourceChat, sanitizerOptions()); current(captured);
    const oldRoot = await optionalGet(`chat-${captured.identity.chatId}`, 'v3-root'); current(captured);
    const result = Object.freeze({ character: value.source.character, messages: value.messages.length,
      summaries: graph.summaryCount, states: graph.stateCount, replacesMemory: Boolean(oldRoot?.data?.headCheckpointId), exportedAt: value.exportedAt });
    previews.set(result, { captured, value, graph, oldRoot, archive }); return result;
  }
  async function optionalGet(collection, id, options = {}) {
    try {
      if (id === 'v3-root' && typeof client.getMany === 'function') {
        const [item] = await client.getMany(collection, [id], options);
        check(item?.recordId === id && [200, 404].includes(item.status), '当前记忆根读取失败，请稍后重试。');
        return item.status === 404 ? null : item.envelope;
      }
      return await client.get(collection, id, options);
    } catch (error) { if (error.status === 404) return null; throw error; }
  }
  async function auxiliaryRevisions(chatId, streaming = false) {
    if (!streaming) return Object.fromEntries((await client.list(`chat-${chatId}`)).filter(item => isAux(item.recordId))
      .map(item => [item.recordId, item.revision]));
    const revisions = {};
    for await (const item of client.iterRecords(`chat-${chatId}`, { requireStreaming: true })) {
      if (isAux(item.recordId)) revisions[item.recordId] = item.revision;
    }
    return revisions;
  }
  async function publish(captured, initial, header, messages, chatId) {
    current(captured);
    const latest = await readTargetChat(captured.target, { fetchImpl });
    check(sameInputs(initial, latest), '聊天文件在导入期间有变化，已停止，原记忆保留。');
    const expectedHeader = { ...latest.header, chat_metadata: mergeOwned(latest.header.chat_metadata, header.chat_metadata, HEADER_KEYS) };
    const expectedMessages = latest.chat.map((message, index) => mergeMessage(message, messages[index]));
    current(captured);
    const response = await fetchImpl('/api/chats/save', { method: 'POST', cache: 'no-cache', headers: captured.target.requestHeaders,
      body: JSON.stringify({ ch_name: captured.target.characterName, file_name: captured.target.hostChatId,
        avatar_url: captured.target.avatarUrl, chat: [expectedHeader, ...expectedMessages], force: false }) });
    check(response?.ok, '聊天文件未能保存。原记忆数据仍保留，请重新打开聊天核对状态。');
    const saved = await readTargetChat({ ...captured.target, chatId }, { fetchImpl });
    check(sameMetadata(saved.header.chat_metadata, expectedHeader.chat_metadata) && sameChatQqjData(saved.chat, expectedMessages)
      && sameConversation(saved.chat, expectedMessages), '保存后的聊天未通过核对。请重新打开聊天；原记忆仍可通过撤销导入恢复。');
    // Never refresh a different chat or overwrite an edit made while saving.
    try {
      current(captured);
      const snapshot = hostAdapter.snapshot();
      if (snapshot.chat.some(hasColdSwipes)) {
        // Its source holds the old opened file even after the saved path changes.
        // The host reload cancels pending saves and binds a fresh cold source.
        const liveMessages = clone(snapshot.chat), liveMetadata = cloneHostJsonMetadata(snapshot.context.chatMetadata);
        await snapshot.context.reloadCurrentChat();
        const refreshed = hostAdapter.snapshot(), character = refreshed.context.characters?.[refreshed.context.characterId];
        if (refreshed.chatId !== captured.identity.hostChatId || character?.avatar !== captured.target.avatarUrl
          || !same(refreshed.userIdentity, captured.persona) || refreshed.context.chatMetadata?.qianqianjie?.chatId !== chatId
          || !sameCapturedInputs(saved, { ...captured, identity: { ...captured.identity, chatId }, chat: refreshed.chat, metadata: refreshed.context.chatMetadata })) return { reload: true };
        // Merge unsaved drafts against the published copy; later reload listeners
        // own their new changes, including deletions of individual nested fields.
        refreshed.chat.forEach((message, index) => {
          const restored = mergeColdReloadMessage(saved.chat[index], liveMessages[index], message);
          for (const key of Object.keys(message)) delete message[key];
          Object.assign(message, restored);
        });
        const metadata = refreshed.context.chatMetadata;
        const restoredMetadata = mergeOwned(mergeReloadFields(saved.header.chat_metadata, liveMetadata, metadata), metadata, [...HEADER_KEYS, 'integrity']);
        for (const key of Object.keys(metadata)) delete metadata[key];
        Object.assign(metadata, restoredMetadata);
        return { reload: false };
      }
      snapshot.chat.forEach((message, index) => {
        const expected = saved.chat[index];
        message.extra = mergeOwned(message.extra, expected?.extra, MESSAGE_KEYS);
        message.swipe_info?.forEach((swipe, n) => { swipe.extra = mergeOwned(swipe.extra, expected?.swipe_info?.[n]?.extra, MESSAGE_KEYS); });
      });
      const metadata = snapshot.context.chatMetadata;
      for (const key of [...HEADER_KEYS, 'integrity']) {
        if (Object.hasOwn(saved.header.chat_metadata, key)) metadata[key] = clone(saved.header.chat_metadata[key]);
        else delete metadata[key];
      }
    } catch { return { reload: true }; }
    return { reload: false };
  }
  async function completeImport(captured, initial, value, chatId, root, importedAuxiliaryRevisions, summaries, streaming = false) {
    if (value.calendar) await persistCalendar(chatId, value.calendar);
    const createdAt = now().toISOString();
    await client.put(CHAT_IDENTITY_COLLECTION, `binding-${chatId}`, { schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId,
      owner: { hostChatId: captured.identity.hostChatId, characterLocator: captured.identity.characterLocator, personaLocator: captured.identity.personaLocator },
      state: 'ready', sourceChatId: value.source.chatId, createdAt, updatedAt: createdAt }, 0);
    const header = clone(initial.header), messages = clone(initial.chat);
    header.chat_metadata.qianqianjie = { ...header.chat_metadata.qianqianjie, schemaVersion: 2, chatId, file: chatFileFromHost(captured.identity) };
    if (value.prequel === null) delete header.chat_metadata.qianqianjiePrequel; else header.chat_metadata.qianqianjiePrequel = value.prequel;
    messages.forEach((message, index) => {
      const apply = (extra, markers) => {
        const next = { ...extra }; delete next[RECEIPT]; delete next[ANCHOR]; delete next[HIDDEN]; delete next.qianqianjie_migration_alias; delete next[MESSAGE_MEMORY_EXCLUSION_KEY];
        for (const key of [ANCHOR, HIDDEN, 'qianqianjie_migration_alias', MESSAGE_MEMORY_EXCLUSION_KEY]) if (key === MESSAGE_MEMORY_EXCLUSION_KEY ? markers?.[key] === true : markers?.[key] !== undefined) {
          next[key] = clone(markers[key]);
          if (next[key]?.chatId === value.source.chatId) next[key].chatId = chatId;
        }
        return next;
      };
      message.extra = apply(message.extra, value.markers[index].extra);
      if (Array.isArray(message.swipe_info)) message.swipe_info.forEach((swipe, n) => {
        // V2 permits a different history/order of unselected alternatives.
        // Never transplant an old alternative's anchor onto an unrelated one.
        swipe.extra = apply(swipe.extra, value.formatVersion === 1 ? value.markers[index].swipes?.[n] : null);
      });
    });
    await client.put(`chat-${chatId}`, ROLLBACK, { schemaVersion: 1, chatId, previousChatId: captured.identity.chatId,
      header: initial.header, messages: initial.chat, witnessVersion: 2, ...(streaming ? { streaming: true } : {}),
      importedMessages: streaming ? await volumeWitness(messages) : await transferWitness(messages, { version: 2 }), importedRoot: root,
      importedAuxiliaryRevisions, importedCalendar: clone(captureCalendar(chatId)), importedPrequel: value.prequel }, 0);
    const result = await publish(captured, initial, header, messages, chatId);
    return { ...result, chatId, summaries };
  }
  async function importVolumePlan({ captured, value, graph, oldRoot, archive }, previewValue) {
    return exclusive(captured, async () => {
      previews.delete(previewValue);
      check(same(oldRoot, await optionalGet(`chat-${captured.identity.chatId}`, 'v3-root')), '预览后记忆发生变化，请重新预览。');
      const initial = await readTargetChat(captured.target, { fetchImpl });
      check(sameCapturedInputs(initial, captured), '当前聊天尚未保存完成，请稍后重新预览。');
      const sourceChat = captured.chat.map((message, index) => ({ ...message,
        extra: mergeOwned(message.extra, value.markers[index].extra, MESSAGE_KEYS) }));
      await verifyConversation(graph, sourceChat, sanitizerOptions());
      await archive.verify(); current(captured);
      const chatId = freshUuid(); check(isUuid(chatId) && chatId !== captured.identity.chatId && chatId !== value.source.chatId, '新记忆编号无效。');
      for await (const unused of client.iterRecords(`chat-${chatId}`, { requireStreaming: true })) {
        throw fail('新记忆编号已存在，请重试。');
      }
      const uploaded = new Map(), avatarStore = createAvatarImageStore({ fetchImpl, headers: () => captured.target.requestHeaders });
      for (const path of archive.avatarPaths) {
        current(captured);
        const image = await archive.readAvatar(path), binary = atob(image.data);
        const data = Uint8Array.from(binary, char => char.charCodeAt(0));
        uploaded.set(path, await avatarStore.upload(new Blob([data], { type: image.mimeType })));
      }
      const importedAuxiliaryRevisions = {}, ids = archive.recordIds.filter(id => id !== 'v3-root');
      // At most four record bodies are being decoded/saved. No foundation-store
      // instance is used here because its confirmed-content cache retains a graph.
      for (let offset = 0; offset < ids.length; offset += 64) {
        current(captured);
        const batch = ids.slice(offset, offset + 64); let cursor = 0, failure = null;
        await Promise.all(Array.from({ length: Math.min(4, batch.length) }, async () => {
          while (!failure) {
            const index = cursor++; if (index >= batch.length) return;
            try {
              const item = rehomeRecord({ id: batch[index], data: await archive.readRecord(batch[index]) }, chatId);
              for (const workspace of peopleWorkspaces([item])) for (const source of Object.values(workspace.avatarSourcesByEntityId ?? {})) {
                if (uploaded.has(source.path)) source.path = uploaded.get(source.path).path;
              }
              const saved = await client.put(`chat-${chatId}`, item.id, item.data, 0);
              check(same(saved.data, item.data), '新副本的存储返回内容不一致，未切换当前记忆。');
              if (isAux(item.id)) importedAuxiliaryRevisions[item.id] = saved.revision;
            } catch (error) { failure ??= error; }
          }
        }));
        if (failure) throw failure;
      }
      current(captured);
      const root = rehomeRecord({ id: 'v3-root', data: await archive.readRecord('v3-root') }, chatId).data;
      const committed = await client.put(`chat-${chatId}`, 'v3-root', root, 0);
      check(same(committed.data, root), '新副本的存储返回内容不一致，未切换当前记忆。');
      return completeImport(captured, initial, value, chatId, committed.data, importedAuxiliaryRevisions, previewValue.summaries, true);
    }, { streaming: true });
  }
  async function importPreview(previewValue) {
    const plan = previews.get(previewValue);
    check(plan, '预览已失效，请重新选择文件。');
    if (plan.archive) return importVolumePlan(plan, previewValue);
    const { captured, value, graph, oldRoot } = plan;
    return exclusive(captured, async () => {
      previews.delete(previewValue);
      check(same(oldRoot, await optionalGet(`chat-${captured.identity.chatId}`, 'v3-root')), '预览后记忆发生变化，请重新预览。');
      const initial = await readTargetChat(captured.target, { fetchImpl });
      check(sameCapturedInputs(initial, captured), '当前聊天尚未保存完成，请稍后重新预览。');
      const sourceChat = captured.chat.map((message, index) => ({ ...message,
        extra: mergeOwned(message.extra, value.markers[index].extra, MESSAGE_KEYS) }));
      await verifyConversation(graph, sourceChat, sanitizerOptions());
      current(captured);
      const chatId = freshUuid(); check(isUuid(chatId) && chatId !== captured.identity.chatId && chatId !== value.source.chatId, '新记忆编号无效。');
      check((await client.list(`chat-${chatId}`)).length === 0, '新记忆编号已存在，请重试。');
      const records = value.records.map(item => rehomeRecord(item, chatId));
      await validateRecords(records, chatId);
      const avatarImages = new Map((value.avatarImages ?? []).map(image => [image.path, image]));
      const uploaded = new Map(), avatarStore = createAvatarImageStore({ fetchImpl, headers: () => captured.target.requestHeaders });
      for (const workspace of peopleWorkspaces(records)) for (const source of Object.values(workspace.avatarSourcesByEntityId ?? {})) {
        const image = avatarImages.get(source.path);
        if (!image) continue;
        current(captured);
        if (!uploaded.has(source.path)) {
          const binary = atob(image.data), data = Uint8Array.from(binary, char => char.charCodeAt(0));
          uploaded.set(source.path, await avatarStore.upload(new Blob([data], { type: source.mimeType })));
        }
        source.path = uploaded.get(source.path).path;
      }
      // Everything is staged in a fresh collection. The old collection is never overwritten.
      const store = createFoundationStore({ client, contextProvider: () => ({ ...captured.identity, chatId }) });
      const core = records.filter(item => item.id !== 'v3-root' && coreTypes.has(item.data.recordType));
      for (let offset = 0; offset < core.length; offset += 64) {
        current(captured);
        const batch = core.slice(offset, offset + 64);
        const saved = await store.putRecords(batch.map(item => item.data));
        check(saved.length === batch.length && saved.every(item => ['saved', 'reused'].includes(item.status)), '新副本的存储返回内容不一致，未切换当前记忆。');
      }
      const importedAuxiliaryRevisions = {};
      for (const item of records.filter(item => !coreTypes.has(item.data.recordType))) {
        current(captured);
        const saved = await client.put(`chat-${chatId}`, item.id, item.data, 0);
        check(same(saved.data, item.data), '新副本的存储返回内容不一致，未切换当前记忆。');
        importedAuxiliaryRevisions[item.id] = saved.revision;
      }
      current(captured);
      const root = records.find(item => item.id === 'v3-root').data;
      const committed = await store.commitRoot(root, 0);
      check(committed.status === 'saved', '新副本写入冲突，未切换当前记忆。');
      return completeImport(captured, initial, value, chatId, committed.data ?? root, importedAuxiliaryRevisions, previewValue.summaries);
    });
  }
  async function undo() {
    const captured = capture(), settled = { streaming: false };
    return exclusive(captured, async () => {
      const rollback = (await optionalGet(`chat-${captured.identity.chatId}`, ROLLBACK))?.data;
      settled.streaming = rollback?.streaming === true;
      check(rollback?.schemaVersion === 1 && rollback.chatId === captured.identity.chatId, '当前聊天没有可撤销的导入。');
      const witness = rollback.streaming ? await volumeWitness(captured.chat) : await transferWitness(captured.chat, { version: rollback.witnessVersion ?? 1 });
      check(same(witness, rollback.importedMessages), '导入后已继续聊天或修改正文。请先导出当前记忆；本次不覆盖新剧情。');
      const currentRoot = await optionalGet(`chat-${captured.identity.chatId}`, 'v3-root');
      check(rollback.importedRoot && same(currentRoot?.data, rollback.importedRoot), '导入后的记忆已变化，请先导出当前记忆；本次没有撤销。');
      if (rollback.importedAuxiliaryRevisions) {
        check(same(await auxiliaryRevisions(captured.identity.chatId, rollback.streaming === true), rollback.importedAuxiliaryRevisions)
          && same(captureCalendar(captured.identity.chatId), rollback.importedCalendar)
          && (typeof captured.metadata.qianqianjiePrequel === 'string' ? captured.metadata.qianqianjiePrequel : null) === rollback.importedPrequel,
        '导入后的记忆已变化，请先导出当前记忆；本次没有撤销。');
      }
      const initial = await readTargetChat(captured.target, { fetchImpl });
      check(sameCapturedInputs(initial, captured), '当前聊天尚未保存完成，请稍后重试。');
      const header = clone(initial.header), messages = clone(initial.chat);
      header.chat_metadata.qianqianjie = clone(rollback.header.chat_metadata.qianqianjie);
      if (rollback.header.chat_metadata.qianqianjiePrequel === undefined) delete header.chat_metadata.qianqianjiePrequel;
      else header.chat_metadata.qianqianjiePrequel = rollback.header.chat_metadata.qianqianjiePrequel;
      messages.forEach((message, index) => {
        const restore = (extra, previous) => { const result = { ...extra }; for (const key of [ANCHOR, HIDDEN, RECEIPT, 'qianqianjie_migration_alias', MESSAGE_MEMORY_EXCLUSION_KEY]) {
          delete result[key]; if (previous?.[key] !== undefined) result[key] = clone(previous[key]);
        } return result; };
        const previous = rollback.messages[index];
        message.extra = restore(message.extra, previous.extra);
        message.swipe_info?.forEach((swipe, n) => {
          const currentReply = Array.isArray(message.swipes) ? message.swipes[n] : n === 0 ? message.mes : undefined;
          const previousReply = Array.isArray(previous.swipes) ? previous.swipes[n] : n === 0 ? previous.mes : undefined;
          const sameReply = typeof currentReply === 'string' && currentReply === previousReply;
          swipe.extra = restore(swipe.extra, sameReply ? previous.swipe_info?.[n]?.extra : undefined);
        });
      });
      return publish(captured, initial, header, messages, rollback.previousChatId);
    }, settled);
  }
  return Object.freeze({ exportCurrent, exportVolumes, preview, previewVolumes, importPreview, undo, getState: () => ({ active }),
    getActivityState: activity.getActivityState, subscribeActivity: activity.subscribeActivity });
}
