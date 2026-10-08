import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildPeopleProfileSystemPrompt, createPeopleWorkspaceStore, createPeopleWorkspaceRuntime, DEFAULT_PROFILE_GUIDANCE, PEOPLE_PROFILE_INPUT_CHAR_BUDGET, PEOPLE_WORKSPACE_RECORD_ID, PROFILE_FIXED_CONTRACT, projectAnnualPeople, selectRelevantWorldInfoCandidates, validatePeopleWorkspace } from '../src/v3/people-workspace.js';
import { PEOPLE_PROFILE_DEFINITIONS, PEOPLE_PROFILE_FIELDS, PEOPLE_PROFILE_LABELS } from '../src/v3/people-profile-fields.js';
import { filterSourcesByPermission, filterWorldInfoSourcesByPermission } from '../src/source-permission.js';
import { BASE_PROCESSING_PROMPT } from '../src/internal-processing-prompt.js';
import { createCompactApiClient } from '../src/compact-api-client.js';
import { scanWorldInfo } from '../src/world-info-scanner.js';

const CHAT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHAT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ids = Array.from({ length: 16 }, (_, index) => `${String(index + 1).padStart(8, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`);
const USER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SYNTHETIC_CHAR = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function failure(status) { return Object.assign(new Error(`HTTP ${status}`), { status }); }
function backend() {
  const records = new Map(), calls = [], hooks = { beforeGet: null, beforePut: null };
  return {
    records, calls, hooks,
    client: {
      async get(collection, key) { calls.push(['get', collection, key]); await hooks.beforeGet?.(collection, key); const value = records.get(`${collection}/${key}`); if (!value) throw failure(404); return structuredClone(value); },
      async put(collection, key, data, expectedRevision, options = {}) {
        calls.push(['put', collection, key, expectedRevision]); await hooks.beforePut?.(collection, key); if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const mapKey = `${collection}/${key}`, previous = records.get(mapKey); if ((previous?.revision ?? 0) !== expectedRevision) throw failure(409);
        const envelope = { revision: expectedRevision + 1, data: structuredClone(data) }; records.set(mapKey, envelope); return structuredClone(envelope);
      },
    },
  };
}
function entity(id, name, extra = {}) {
  return { id, entityType: 'person', displayName: name, aliases: [{ name: `${name}别名` }], specialRole: 'none', firstSeenFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', lastSeenFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'established', recordStatus: 'active', ...extra };
}
function harness({ generate = async () => ({ jsonData: { profiles: [] } }), many = false, permissionSettings = null, sourceCandidates = null, scanner = null, profilePromptGuidance = () => '', processingPrompt = () => '', prequel = '', foundationState = null } = {}) {
  const db = backend(), foundationRecords = new Map(); let hostChat = [], foundationReadHook = null, mainGenerationActive = true, identity = { chatId: CHAT_A, hostChatId: 'host-a', characterLocator: 'char.png', personaLocator: 'persona.png' }, currentPrequel = prequel;
  const peopleEntities = ids.slice(0, many ? 12 : 4).map((id, index) => entity(id, `人物${index + 1}`));
  let reachable = {
    entities: [...peopleEntities, entity(USER, '用户', { specialRole: 'user' }), entity(SYNTHETIC_CHAR, '剧情标题', { specialRole: 'char', firstSeenFloorId: null, lastSeenFloorId: null })],
    floorMemories: peopleEntities.map((person, index) => ({ recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: `${person.displayName}在第${index + 1}楼出现。` }, participants: [{ entityId: person.id }] })),
    baseline: { characterCard: { entityId: SYNTHETIC_CHAR, name: '剧情标题', description: '角色卡描述', personality: '角色卡性格', scenario: '场景' } },
  };
  let memoryState = { cseSubjects: peopleEntities.map((person, index) => ({ subjectEntityId: person.id, displayName: person.displayName, core: index === 0 ? [{ text: '谨慎', origin: 'delta', sourceFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] : [], adaptive: [], situational: [] })) };
  const listeners = new Set(), foundationListeners = new Set();
  let memoryRefreshes = 0, memoryStateReads = 0;
  const memoryRuntime = { getState: () => { memoryStateReads += 1; return memoryState; }, refreshStatus: async () => { memoryRefreshes += 1; return memoryState; }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const sourceTrace = [];
  const runtime = createPeopleWorkspaceRuntime({
    store: createPeopleWorkspaceStore({ client: db.client }), session: { identity: () => structuredClone(identity) },
    foundationRuntime: { getReachable: () => reachable, getState: () => foundationState, subscribe(fn) { foundationListeners.add(fn); return () => foundationListeners.delete(fn); } }, memoryRuntime, generateUtilityTask: generate, profilePromptGuidance, processingPrompt,
    foundationStore: { async readRecord(type, id) { await foundationReadHook?.(type, id); const value = foundationRecords.get(`${type}/${id}`); return value ? { status: 'ready', data: structuredClone(value) } : { status: 'missing' }; } },
    hostAdapter: { snapshot: () => ({ context: { chatMetadata: { qianqianjie: { chatId: identity.chatId } } }, chat: hostChat }) },
    sourcePermissions: {
      filterCandidates({ chatId, candidates }) { sourceTrace.push(['filter', chatId, candidates.map(item => item.id)]); return permissionSettings ? filterSourcesByPermission({ chatId, candidates, settings: permissionSettings }) : candidates.filter(item => item.id !== 'worldbook:excluded'); },
      filterWorldInfoSources(sources) { return filterWorldInfoSourcesByPermission({ sources, settings: permissionSettings ?? {} }); },
    },
    contextProvider: () => ({ chat: [], marker: identity.chatId, chatMetadata: currentPrequel ? { qianqianjiePrequel: currentPrequel } : {} }),
    isMainGenerationActive: () => mainGenerationActive,
    scanner: scanner ?? (async (context, options) => { sourceTrace.push(['scan', context.marker, options]); return { entries: [{ content: '<secret>DROP</secret><content>ALLOWED</content>' }, { content: 'EXCLUDED' }] }; }),
    sourceCandidateFactory: async catalog => { sourceTrace.push(['candidates', catalog.entries.length]); return sourceCandidates ?? [{ id: 'worldbook:allowed', kind: 'worldbook', world: '允许书', label: '允许条目', content: catalog.entries[0].content }, { id: 'worldbook:excluded', kind: 'worldbook', world: '排除书', label: '排除条目', content: catalog.entries[1].content }]; },
    now: () => new Date('2026-09-06T00:00:00.000Z'),
    logger: { warn() {} },
  });
  return { db, runtime, peopleEntities, sourceTrace, foundationRecords, memoryStateReads: () => memoryStateReads,
    emitMemory(value) { memoryState = value; for (const listener of listeners) listener(value); },
    setFoundationReadHook(value) { foundationReadHook = value; }, setHostChat(value) { hostChat = value; }, setMainGenerationActive(value) { mainGenerationActive = value; if (!value) runtime.wakeAutomaticMaintenance(); }, async seedSelectedWithoutProgress(entityIds) {
      const timestamp = '2026-09-06T00:00:00.000Z';
      db.records.set(`chat-${identity.chatId}/${PEOPLE_WORKSPACE_RECORD_ID}`, { revision: 1, data: {
        schemaVersion: 3, kind: 'qqj-v3-people-workspace', chatId: identity.chatId, selectedEntityIds: Array.isArray(entityIds) ? entityIds : [entityIds],
        personOrderEntityIds: [], profilesByEntityId: {}, avatarsByEntityId: {}, identityRedirectsByEntityId: {}, deletedEntityIds: [],
        profileMaterialProgressByEntityId: {}, createdAt: timestamp, updatedAt: timestamp,
      } });
      await runtime.refresh({ refreshMemory: false });
    }, async markProfileInitialized(entityIds, { material = true, profileExists = true } = {}) {
      const record = db.records.get(`chat-${identity.chatId}/${PEOPLE_WORKSPACE_RECORD_ID}`);
      for (const entityId of Array.isArray(entityIds) ? entityIds : [entityIds]) {
        record.data.profileMaterialProgressByEntityId[entityId] = {
          processedHistoryCount: 0, materialSignature: 'people-material-v1:2:0000000000000000',
          contextSignature: 'people-material-v1:2:0000000000000000', updatedAt: '2026-09-06T00:00:00.000Z',
        };
        if (!profileExists) { delete record.data.profilesByEntityId[entityId]; continue; }
        const previous = record.data.profilesByEntityId[entityId] ?? {};
        const profile = Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, previous[field] ?? '']));
        profile.entityId = entityId; profile.name ||= '仅有姓名'; profile.aliases ||= '仅有别名';
        if (material && !PEOPLE_PROFILE_FIELDS.slice(2).some(field => String(profile[field]).trim())) profile.notes = '已有基础资料';
        if (!material) for (const field of PEOPLE_PROFILE_FIELDS.slice(2)) profile[field] = '';
        record.data.profilesByEntityId[entityId] = { ...profile, manualFields: previous.manualFields ?? [], source: previous.source ?? 'generated',
          createdAt: previous.createdAt ?? '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
      }
      record.revision += 1; runtime.invalidate(); await runtime.refresh({ refreshMemory: false });
    }, get identity() { return identity; }, setIdentity(value) { identity = value; }, get reachable() { return reachable; }, setReachable(value) { reachable = value; }, setFoundationState(value) { foundationState = value; },
    notifyFoundation() { for (const listener of foundationListeners) listener({ status: 'ready', chatId: identity.chatId }); },
    get memoryState() { return memoryState; }, setMemoryState(value, notify = true) { memoryState = value; if (notify) for (const listener of listeners) listener(memoryState); },
    notifyMemory() { for (const listener of listeners) listener(memoryState); }, setPrequel(value) { currentPrequel = value; }, get memoryRefreshes() { return memoryRefreshes; } };
}

async function waitFor(check, message = '等待后台人物整理超时') {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

test('人物资料业务指导可替换，固定合同与基础处理层始终恰好一次', () => {
  const builtIn = buildPeopleProfileSystemPrompt();
  assert.match(builtIn, new RegExp(DEFAULT_PROFILE_GUIDANCE.slice(0, 20)));
  assert.match(builtIn, /人物卡和世界书属于明确设定/);
  assert.match(builtIn, /appearance 只填写无法归入细分外貌字段/); assert.match(builtIn, /不写来源说明、整理过程、核验过程/);
  assert.equal(builtIn.split(BASE_PROCESSING_PROMPT).length - 1, 1);
  const custom = buildPeopleProfileSystemPrompt('用户自定人物整理风格');
  assert.match(custom, /用户自定人物整理风格/);
  assert.doesNotMatch(custom, /人物卡和世界书属于明确设定/);
  assert.match(custom, new RegExp(PROFILE_FIXED_CONTRACT.slice(0, 16)));
  assert.match(custom, /personKey 必须逐字使用/);
  assert.match(custom, /根对象必须包含 profiles 数组/);
  assert.match(custom, /\{"profiles":\[\{"personKey":"person-1","name":"示例姓名"\}\]\}/);
  assert.match(custom, /recentFloors 是最近稳定AI楼/);
  assert.match(custom, /自动粗扫每约十个新增稳定AI楼/);
  assert.match(custom, /聚合多楼 history 可省略 storyContent/);
  assert.match(custom, /不得猜测未提供的正文/);
  assert.match(custom, /没有新信息时省略字段/);
  assert.match(custom, /自动粗扫不得用空字符串或空 aliases 表示清除/);
  assert.match(custom, /当前批可能只包含该来源的一部分/);
  assert.match(custom, /明确要求删除旧资料且没有替代值/);
  assert.match(custom, /build（体型）：身体骨架、体态、比例/);
  assert.match(custom, /occupation（职业）：人物从事的职业/);
  assert.match(custom, /personality（核心性格）：跨情境较稳定/);
  assert.equal(PEOPLE_PROFILE_FIELDS.length, 27);
  assert.deepEqual(Object.keys(PEOPLE_PROFILE_DEFINITIONS), PEOPLE_PROFILE_FIELDS);
  assert.ok(PEOPLE_PROFILE_FIELDS.every(field => PEOPLE_PROFILE_LABELS[field] && PEOPLE_PROFILE_DEFINITIONS[field]));
  assert.equal(custom.split(BASE_PROCESSING_PROMPT).length - 1, 1);
});

test('v1/v2 人工资料与头像无损归一到 v3，只有旧人工六字段获得保护', () => {
  const profile = source => ({ entityId: ids[0], name: '旧名', aliases: '旧别名', background: '旧背景', appearance: '旧外貌', personality: '旧性格', notes: '旧补充', source, createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' });
  const workspace = source => ({ schemaVersion: 1, kind: 'qqj-v3-people-workspace', chatId: CHAT_A, selectedEntityIds: [ids[0]], profilesByEntityId: { [ids[0]]: profile(source) }, createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' });
  const manual = validatePeopleWorkspace(workspace('manual'), CHAT_A), generated = validatePeopleWorkspace(workspace('generated'), CHAT_A);
  assert.equal(manual.schemaVersion, 3); assert.equal(manual.profilesByEntityId[ids[0]].notes, '旧补充'); assert.equal(manual.profilesByEntityId[ids[0]].gender, '');
  assert.deepEqual(manual.profilesByEntityId[ids[0]].manualFields, ['name', 'aliases', 'background', 'appearance', 'personality', 'notes']);
  assert.deepEqual(generated.profilesByEntityId[ids[0]].manualFields, []); assert.deepEqual(manual.avatarsByEntityId, {});
  const avatar = 'data:image/png;base64,AAAA';
  const v2 = validatePeopleWorkspace({ ...workspace('manual'), schemaVersion: 2, profilesByEntityId: { [ids[0]]: { ...profile('manual'), manualFields: ['notes'] } }, avatarsByEntityId: { [ids[0]]: avatar } }, CHAT_A);
  assert.equal(v2.avatarsByEntityId[ids[0]], avatar); assert.deepEqual(v2.profilesByEntityId[ids[0]].manualFields, ['notes']);
  assert.deepEqual(v2.identityRedirectsByEntityId, {}); assert.deepEqual(v2.deletedEntityIds, []); assert.deepEqual(v2.personOrderEntityIds, []);
});

test('身份成功续接可复用已准备的记忆，只读加载一次人物 workspace', async () => {
  const h = harness();
  await h.runtime.refresh({ refreshMemory: false });
  assert.equal(h.memoryRefreshes, 0, '人物续接不得重复刷新刚准备完成的记忆');
  assert.equal(h.db.calls.filter(call => call[0] === 'get' && call[2] === PEOPLE_WORKSPACE_RECORD_ID).length, 1);
  assert.equal(h.runtime.getState().status, 'ready');
});

test('人物工作区复用 memory 通知携带的同次状态，不在订阅回调重复读取完整状态', async () => {
  const h = harness();
  await h.runtime.refresh({ refreshMemory: false });
  const beforeReads = h.memoryStateReads();
  h.emitMemory({ cseSubjects: [{ subjectEntityId: ids[0], core: [{ text: '通知中的新状态', origin: 'delta', sourceFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }], adaptive: [], situational: [] }] });
  assert.equal(h.memoryStateReads(), beforeReads, 'subscriber 直接消费 memoryRuntime 提供的 snapshot');
  assert.equal(h.runtime.getState().people.find(person => person.entityId === ids[0]).cse.core[0].text, '通知中的新状态');
});

test('ready checkpoint 刷新只移出失联旧 ID，保留同名新人物选择与旧档案', async () => {
  const oldId = ids[0], newId = ids[1], otherId = ids[2];
  const h = harness();
  const oldPerson = entity(oldId, '同名人物'), newPerson = entity(newId, '同名人物'), otherPerson = entity(otherId, '未选人物');
  h.setReachable({ ...h.reachable, entities: [...h.reachable.entities, oldPerson, newPerson, otherPerson] });
  await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([oldId, newId]);
  await h.runtime.saveProfile(oldId, { name: '旧档生日：旧日期' });
  await h.runtime.saveProfile(newId, { name: '新档生日：新日期' });
  await h.runtime.saveProfile(otherId, { name: '未选人物生日：有效日期' });
  const root = { status: 'ready', chatId: CHAT_A, headCheckpointId: 'checkpoint-2', narrativeGeneration: 'generation-1' };
  h.setReachable({ ...h.reachable, status: 'ready', entities: h.reachable.entities.filter(item => item.id !== oldId), root,
    checkpoint: { id: root.headCheckpointId, capabilities: { foundationReady: true } } });
  h.setFoundationState({ status: 'ready', foundationStatus: 'ready', chatId: CHAT_A, activeRun: null, pending: null });
  const refreshed = await h.runtime.refresh({ refreshMemory: false });
  assert.deepEqual(refreshed.selectedEntityIds, [newId]);
  assert.equal(refreshed.profilesByEntityId[oldId].name, '旧档生日：旧日期', '失联人物资料仍保留供用户处理');
  assert.equal(refreshed.profilesByEntityId[newId].name, '新档生日：新日期');
  const annual = projectAnnualPeople(h.reachable, refreshed);
  assert.deepEqual(annual.map(person => person.entityId).sort(), [newId, otherId].sort(), '年度来源包括当前有效但未选人物，排除旧 ID');
});

test('pending 尾楼期间只清除来源楼已被确认替换的失联选择', async () => {
  const oldId = ids[0], newId = ids[1], oldFloorId = ids[4], replacementFloorId = ids[5], pendingFloorId = ids[6];
  const anchor = (floorId, chatId = CHAT_A) => ({ is_user: false, mes: '合成测试消息', extra: { qianqianjie_floor: { schemaVersion: 1, chatId, floorId } } });
  for (const { label, sourceAvailable, oldAnchorInPending, replacementAnchorValid, shouldPrune } of [
    { label: '确认前缀同位置已有新楼锚且全聊天无旧锚', sourceAvailable: true, oldAnchorInPending: false, replacementAnchorValid: true, shouldPrune: true },
    { label: '旧来源楼移到待处理尾部', sourceAvailable: true, oldAnchorInPending: true, replacementAnchorValid: true, shouldPrune: false },
    { label: '旧人物或来源楼记录缺失', sourceAvailable: false, oldAnchorInPending: false, replacementAnchorValid: true, shouldPrune: false },
    { label: '替换位置没有可靠有效锚', sourceAvailable: true, oldAnchorInPending: false, replacementAnchorValid: false, shouldPrune: false },
  ]) {
    const h = harness();
    const oldPerson = entity(oldId, '旧人物', { firstSeenFloorId: oldFloorId });
    const newPerson = entity(newId, '新人物', { firstSeenFloorId: replacementFloorId });
    h.setReachable({ ...h.reachable, entities: [...h.reachable.entities.filter(item => ![oldId, newId].includes(item.id)), oldPerson, newPerson] });
    await h.runtime.refresh({ refreshMemory: false });
    await h.runtime.setSelectedEntityIds([oldId, newId]);
    await h.runtime.saveProfile(oldId, { name: '仍保留的旧档生日' });
    const root = { status: 'ready', chatId: CHAT_A, headCheckpointId: `pending-${label}`, narrativeGeneration: 'generation-1' };
    const replacement = { id: replacementFloorId, hostLocator: { messageIndex: 4 }, assistantSeq: 5 };
    h.setReachable({ ...h.reachable, status: 'ready', entities: h.reachable.entities.filter(item => item.id !== oldId), floors: [replacement],
      root, checkpoint: { id: root.headCheckpointId, capabilities: { foundationReady: true } } });
    h.setFoundationState({ status: 'ready', foundationStatus: 'ready', activeRun: null, pending: { floorId: pendingFloorId }, chatId: CHAT_A });
    const currentReplacement = replacementAnchorValid ? anchor(replacementFloorId) : { is_user: false, mes: '无效锚', extra: { qianqianjie_floor: { schemaVersion: 9, chatId: CHAT_A, floorId: replacementFloorId } } };
    h.setHostChat([{}, {}, {}, {}, currentReplacement, {}, oldAnchorInPending ? anchor(oldFloorId) : { is_user: false, mes: '待处理尾楼' }]);
    if (sourceAvailable) {
      h.foundationRecords.set(`entity/${oldId}`, { id: oldId, chatId: CHAT_A, entityType: 'person', firstSeenFloorId: oldFloorId, recordStatus: 'active' });
      h.foundationRecords.set(`floor/${oldFloorId}`, { id: oldFloorId, chatId: CHAT_A, hostLocator: { messageIndex: 4 } });
    }
    const state = await h.runtime.refresh({ refreshMemory: false });
    assert.deepEqual(state.selectedEntityIds, shouldPrune ? [newId] : [oldId, newId], label);
    assert.equal(state.profilesByEntityId[oldId].name, '仍保留的旧档生日', '清选择不删除旧人物资料');
  }
});

test('pending 楼层来源读取期间 root/head 改变时不清旧人物选择', async () => {
  const oldId = ids[0], newId = ids[1], oldFloorId = ids[4], replacementFloorId = ids[5], h = harness();
  const anchor = floorId => ({ is_user: false, mes: '合成测试消息', extra: { qianqianjie_floor: { schemaVersion: 1, chatId: CHAT_A, floorId } } });
  const oldPerson = entity(oldId, '旧人物', { firstSeenFloorId: oldFloorId });
  const newPerson = entity(newId, '新人物', { firstSeenFloorId: replacementFloorId });
  h.setReachable({ ...h.reachable, entities: [...h.reachable.entities.filter(item => ![oldId, newId].includes(item.id)), oldPerson, newPerson] });
  await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([oldId, newId]);
  const root = { status: 'ready', chatId: CHAT_A, headCheckpointId: 'pending-before-read', narrativeGeneration: 'generation-1' };
  h.setReachable({ ...h.reachable, status: 'ready', entities: h.reachable.entities.filter(item => item.id !== oldId), floors: [{ id: replacementFloorId, hostLocator: { messageIndex: 4 } }],
    root, checkpoint: { id: root.headCheckpointId, capabilities: { foundationReady: true } } });
  h.setFoundationState({ status: 'ready', foundationStatus: 'ready', activeRun: null, pending: { floorId: ids[6] }, chatId: CHAT_A });
  h.setHostChat([{}, {}, {}, {}, anchor(replacementFloorId), {}, { is_user: false, mes: '待处理尾楼' }]);
  h.foundationRecords.set(`entity/${oldId}`, { id: oldId, chatId: CHAT_A, entityType: 'person', firstSeenFloorId: oldFloorId, recordStatus: 'active' });
  h.foundationRecords.set(`floor/${oldFloorId}`, { id: oldFloorId, chatId: CHAT_A, hostLocator: { messageIndex: 4 } });
  h.setFoundationReadHook(async type => {
    if (type !== 'floor') return;
    const changedRoot = { ...root, headCheckpointId: 'pending-after-read' };
    h.setReachable({ ...h.reachable, root: changedRoot, checkpoint: { id: changedRoot.headCheckpointId, capabilities: { foundationReady: true } } });
  });
  const state = await h.runtime.refresh({ refreshMemory: false });
  assert.deepEqual(state.selectedEntityIds, [oldId, newId], '根或 head 变化后应放弃旧证据');
});

test('workspace CAS 重读期间出现 pending 且 root/head 不变时不按无 pending 路径清选择', async () => {
  const oldId = ids[0], newId = ids[1], h = harness();
  h.setReachable({ ...h.reachable, status: 'ready', entities: h.reachable.entities.map(item => item.id === oldId
    ? entity(oldId, '待处理尾楼人物') : item), root: { status: 'ready', chatId: CHAT_A, headCheckpointId: 'same-head', narrativeGeneration: 'generation-1' },
    checkpoint: { id: 'same-head', capabilities: { foundationReady: true } } });
  h.setFoundationState({ status: 'ready', foundationStatus: 'ready', activeRun: null, pending: null, chatId: CHAT_A });
  await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([oldId, newId]);
  h.setReachable({ ...h.reachable, entities: h.reachable.entities.filter(item => item.id !== oldId) });
  let reads = 0;
  h.db.hooks.beforeGet = async (collection, key) => {
    if (key !== PEOPLE_WORKSPACE_RECORD_ID || ++reads !== 2) return;
    h.setFoundationState({ status: 'ready', foundationStatus: 'ready', activeRun: null, pending: { floorId: ids[7] }, chatId: CHAT_A });
  };
  const state = await h.runtime.refresh({ refreshMemory: false });
  assert.equal(h.reachable.root.headCheckpointId, 'same-head');
  assert.ok(h.runtime.getState().selectedEntityIds.includes(oldId), 'pending 在异步 workspace 重读期间出现，旧清理必须放弃');
  assert.deepEqual(state.selectedEntityIds, [oldId, newId]);
});

test('foundation 非 ready、运行中、待确认或 root/head 不一致时不清理人物选择', async () => {
  const unsafeStates = [
    { label: '运行中', state: { status: 'running', foundationStatus: 'ready', activeRun: { id: 'run' }, pending: null, chatId: CHAT_A } },
    { label: '状态过期', state: { status: 'stale', foundationStatus: 'ready', activeRun: null, pending: null, chatId: CHAT_A } },
    { label: '待人工核对', state: { status: 'needsReview', foundationStatus: 'ready', activeRun: null, pending: null, chatId: CHAT_A } },
    { label: '有待确认楼层', state: { status: 'ready', foundationStatus: 'ready', activeRun: null, pending: { floorId: ids[3] }, chatId: CHAT_A } },
    { label: '读取错误', state: { status: 'ready', foundationStatus: 'error', activeRun: null, pending: null, chatId: CHAT_A } },
    { label: 'foundation 属于另一聊天', state: { status: 'ready', foundationStatus: 'ready', activeRun: null, pending: null, chatId: CHAT_B } },
  ];
  for (const { label, state } of unsafeStates) {
    const oldId = ids[0], newId = ids[1];
    const h = harness();
    h.setReachable({ ...h.reachable, entities: [...h.reachable.entities, entity(oldId, '同名人物'), entity(newId, '同名人物')] });
    await h.runtime.refresh({ refreshMemory: false });
    await h.runtime.setSelectedEntityIds([oldId, newId]);
    const root = { status: 'ready', chatId: CHAT_A, headCheckpointId: 'checkpoint-2', narrativeGeneration: 'generation-1' };
    h.setReachable({ ...h.reachable, status: 'ready', entities: h.reachable.entities.filter(item => item.id !== oldId), root,
      checkpoint: { id: root.headCheckpointId, capabilities: { foundationReady: true } } });
    h.setFoundationState(state);
    const result = await h.runtime.refresh({ refreshMemory: false });
    assert.deepEqual(result.selectedEntityIds, [oldId, newId], `${label} 时应保留选择`);
  }
});

test('workspace CAS 冲突期间保留并发加入的有效人物选择，再移除失联旧 ID', async () => {
  const oldId = ids[0], newId = ids[1], concurrentId = ids[2], h = harness();
  h.setReachable({ ...h.reachable, entities: [...h.reachable.entities, entity(oldId, '同名人物'), entity(newId, '同名人物'), entity(concurrentId, '并发新选')] });
  await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([oldId, newId]);
  const root = { status: 'ready', chatId: CHAT_A, headCheckpointId: 'checkpoint-2', narrativeGeneration: 'generation-1' };
  h.setReachable({ ...h.reachable, status: 'ready', entities: h.reachable.entities.filter(item => item.id !== oldId), root,
    checkpoint: { id: root.headCheckpointId, capabilities: { foundationReady: true } } });
  h.setFoundationState({ status: 'ready', foundationStatus: 'ready', chatId: CHAT_A, activeRun: null, pending: null });
  let injectConflict = true;
  h.db.hooks.beforePut = async (collection, key) => {
    if (!injectConflict || key !== PEOPLE_WORKSPACE_RECORD_ID) return;
    injectConflict = false;
    const stored = h.db.records.get(`${collection}/${key}`);
    stored.revision += 1;
    stored.data.selectedEntityIds = [oldId, newId, concurrentId];
  };
  const result = await h.runtime.refresh({ refreshMemory: false });
  assert.deepEqual(result.selectedEntityIds, [newId, concurrentId]);
});

test('CAS 读取期间 root/head 改变时保留原选择', async () => {
  const oldId = ids[0], newId = ids[1], h = harness();
  h.setReachable({ ...h.reachable, entities: [...h.reachable.entities, entity(oldId, '同名人物'), entity(newId, '同名人物')] });
  await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([oldId, newId]);
  const root = { status: 'ready', chatId: CHAT_A, headCheckpointId: 'checkpoint-2', narrativeGeneration: 'generation-1' };
  h.setReachable({ ...h.reachable, status: 'ready', entities: h.reachable.entities.filter(item => item.id !== oldId), root,
    checkpoint: { id: root.headCheckpointId, capabilities: { foundationReady: true } } });
  h.setFoundationState({ status: 'ready', foundationStatus: 'ready', chatId: CHAT_A, activeRun: null, pending: null });
  let workspaceReads = 0;
  h.db.hooks.beforeGet = async (collection, key) => {
    if (key !== PEOPLE_WORKSPACE_RECORD_ID || ++workspaceReads !== 2) return;
    const changedRoot = { ...root, headCheckpointId: 'checkpoint-3' };
    h.setReachable({ ...h.reachable, root: changedRoot, checkpoint: { id: changedRoot.headCheckpointId, capabilities: { foundationReady: true } } });
  };
  const result = await h.runtime.refresh({ refreshMemory: false });
  assert.deepEqual(result.selectedEntityIds, [oldId, newId]);
});

test('刷新读取 workspace 时切聊天，不触发旧聊天的失联清理', async () => {
  const oldId = ids[0], newId = ids[1], h = harness();
  h.setReachable({ ...h.reachable, entities: [...h.reachable.entities, entity(oldId, '同名人物'), entity(newId, '同名人物')] });
  await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([oldId, newId]);
  const root = { status: 'ready', chatId: CHAT_A, headCheckpointId: 'checkpoint-2', narrativeGeneration: 'generation-1' };
  h.setReachable({ ...h.reachable, status: 'ready', entities: h.reachable.entities.filter(item => item.id !== oldId), root,
    checkpoint: { id: root.headCheckpointId, capabilities: { foundationReady: true } } });
  h.setFoundationState({ status: 'ready', foundationStatus: 'ready', chatId: CHAT_A, activeRun: null, pending: null });
  h.db.hooks.beforeGet = async (collection, key) => {
    if (key === PEOPLE_WORKSPACE_RECORD_ID) h.setIdentity({ chatId: CHAT_B, hostChatId: 'host-b', characterLocator: 'char.png', personaLocator: 'persona.png' });
  };
  await assert.rejects(h.runtime.refresh({ refreshMemory: false }), error => error.code === 'QQJ_PEOPLE_STALE');
  assert.deepEqual(h.db.records.get(`chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`).data.selectedEntityIds, [oldId, newId]);
});

test('redirect 到当前有效 canonical 人物时保留重要人物选择', async () => {
  const oldId = ids[0], newId = ids[1], h = harness();
  h.setReachable({ ...h.reachable, entities: [...h.reachable.entities, entity(oldId, '旧称'), entity(newId, '新称')] });
  await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([oldId]);
  const stored = h.db.records.get(`chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`);
  const redirected = structuredClone(stored);
  redirected.revision += 1;
  redirected.data.identityRedirectsByEntityId = { [oldId]: newId };
  h.db.records.set(`chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`, redirected);
  const root = { status: 'ready', chatId: CHAT_A, headCheckpointId: 'checkpoint-3', narrativeGeneration: 'generation-1' };
  h.setReachable({ ...h.reachable, status: 'ready', entities: h.reachable.entities.filter(item => item.id !== oldId), root,
    checkpoint: { id: root.headCheckpointId, capabilities: { foundationReady: true } } });
  h.setFoundationState({ status: 'ready', foundationStatus: 'ready', chatId: CHAT_A, activeRun: null, pending: null });
  const result = await h.runtime.refresh({ refreshMemory: false });
  assert.deepEqual(result.selectedEntityIds, [oldId], 'redirect 解析到有效新 ID 后，原选择仍有效');
});

test('年度人物资料只投影当前有效人物，不读取失联旧人物档案', () => {
  const oldId = ids[0], currentId = ids[1], unselectedId = ids[2], invalidatedId = ids[3], inactiveId = ids[4];
  const workspace = { selectedEntityIds: [currentId], profilesByEntityId: {
    [oldId]: { entityId: oldId, name: '旧同名生日', birthday: '旧日期' },
    [currentId]: { entityId: currentId, name: '新同名生日', birthday: '新日期' },
    [unselectedId]: { entityId: unselectedId, name: '未选生日', birthday: '有效日期' },
    [invalidatedId]: { entityId: invalidatedId, name: '失效生日', birthday: '失效日期' },
    [inactiveId]: { entityId: inactiveId, name: '非活动生日', birthday: '非活动日期' },
  }, identityRedirectsByEntityId: {}, deletedEntityIds: [] };
  const reachable = { entities: [
    entity(oldId, '旧同名人物', { status: 'merged', mergedIntoEntityId: currentId }),
    entity(currentId, '新同名人物'), entity(unselectedId, '未选人物'),
    entity(invalidatedId, '已失效人物', { status: 'invalidated' }), entity(inactiveId, '非活动人物', { recordStatus: 'superseded' }),
  ] };
  assert.deepEqual(projectAnnualPeople(reachable, workspace).map(person => person.entityId).sort(), [currentId, unselectedId].sort());
});

test('人物资料运行时冻结本次业务与破限提示词，设置变化只在下一次整理生效', async () => {
  let guidance = '第一版人物资料要求';
  let processing = '  第一版破限\n';
  let processingReads = 0;
  const prompts = [];
  const h = harness({
    profilePromptGuidance: () => guidance,
    processingPrompt: () => { processingReads += 1; return processing; },
    generate: async options => {
      prompts.push(options.systemPrompt);
      if (prompts.length === 1) { guidance = '第二版人物资料要求'; processing = '第二版破限'; }
      const request = JSON.parse(options.taskMessages[0].content);
      return { jsonData: { profiles: request.people.map(person => ({ personKey: person.personKey, name: person.currentName, aliases: [], background: '', appearance: '', personality: '', notes: '' })) } };
    },
  });
  await h.runtime.refresh();
  await h.runtime.setSelectedEntityIds([h.peopleEntities[0].id]);
  await h.runtime.generateMissingProfiles();
  await h.runtime.setSelectedEntityIds([h.peopleEntities[0].id, h.peopleEntities[1].id]);
  await h.runtime.generateMissingProfiles();
  processing = ' \n\t ';
  await h.runtime.setSelectedEntityIds([h.peopleEntities[0].id, h.peopleEntities[1].id, h.peopleEntities[2].id]);
  await h.runtime.generateMissingProfiles();
  assert.match(prompts[0], /第一版人物资料要求/); assert.doesNotMatch(prompts[0], /第二版人物资料要求/);
  assert.match(prompts[1], /第二版人物资料要求/); assert.doesNotMatch(prompts[1], /第一版人物资料要求/);
  assert.ok(prompts[0].startsWith('  第一版破限\n\n\n')); assert.equal(prompts[0].includes(BASE_PROCESSING_PROMPT), false);
  assert.ok(prompts[1].startsWith('第二版破限\n\n')); assert.equal(prompts[1].includes(BASE_PROCESSING_PROMPT), false);
  assert.equal(prompts[2].split(BASE_PROCESSING_PROMPT).length - 1, 1);
  assert.ok(prompts.every(prompt => prompt.includes(PROFILE_FIXED_CONTRACT)));
  assert.ok(prompts.every(prompt => /未执行的条件原文/u.test(prompt)));
  assert.equal(processingReads, 3);
  assert.equal(Object.keys(h.runtime.getState().profilesByEntityId).length, 3, '设置变化不得使已保存人物资料撤销或自动重算');
});

test('人物资料真实 strict 生成链使用共享符号修复后仍校验 personKey 绑定', async () => {
  const client = createCompactApiClient({
    fetchImpl: async (_url, options) => {
      const requestBody = JSON.parse(options.body);
      const envelope = JSON.parse(requestBody.messages.at(-1).content);
      const person = envelope.people[0];
      const malformed = `{"profiles":[{"personKey":${JSON.stringify(person.personKey)},name:${JSON.stringify(person.currentName)},"aliases":[],"background":"","appearance":"","personality":"","notes":""}]}`;
      return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: malformed } }] }) };
    },
  });
  const h = harness({
    generate: options => client.generateTask({
      ...options,
      config: { url: 'https://api.example.test/v1', key: 'TEST_KEY', model: 'mock-model', excludeParams: [], timeoutSec: 5, stream: false },
    }),
  });
  await h.runtime.refresh();
  const person = h.peopleEntities[0];
  await h.runtime.setSelectedEntityIds([person.id]);
  await h.runtime.generateMissingProfiles();
  assert.equal(h.runtime.getState().profilesByEntityId[person.id].name, person.displayName);
});

test('重要人物允许 0、多个和超过常见小上限，持久重载与聊天隔离且不改变 CSE 候选', async () => {
  const h = harness({ many: true });
  const refreshed = await h.runtime.refresh(); assert.equal(refreshed.status, 'ready'); assert.equal(refreshed.active, null, 'refresh Promise 必须返回 finally 清忙后的最终状态');
  assert.equal(h.runtime.getState().people.length, 12, '用户与无剧情证据的合成卡名不得进入候选');
  const cseBefore = structuredClone(h.memoryState.cseSubjects);
  const selected = h.peopleEntities.map(item => item.id);
  const selectedState = await h.runtime.setSelectedEntityIds(selected); assert.equal(selectedState.status, 'ready'); assert.equal(selectedState.active, null);
  assert.equal(h.runtime.getState().selectedEntityIds.length, 12, '不得设置业务人数上限');
  assert.deepEqual(h.memoryState.cseSubjects, cseBefore, '选择不得反向过滤 CSE');
  const stored = h.db.records.get(`chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`);
  assert.deepEqual(stored.data.selectedEntityIds, selected);
  assert.deepEqual(stored.data.profilesByEntityId, {}, '只点选姓名不得提前创建 profile');
  await h.runtime.setSelectedEntityIds([]);
  assert.deepEqual(h.runtime.getState().selectedEntityIds, [], '零选择合法且不得自动补主角');
  await h.runtime.setSelectedEntityIds(selected.slice(0, 2));
  h.runtime.invalidate(); await h.runtime.refresh();
  assert.deepEqual(h.runtime.getState().selectedEntityIds, selected.slice(0, 2), '刷新后恢复同一聊天选择');
  h.setIdentity({ ...h.identity, chatId: CHAT_B, hostChatId: 'host-b' }); h.runtime.invalidate(); await h.runtime.refresh();
  assert.deepEqual(h.runtime.getState().selectedEntityIds, [], '新聊天不得串入旧聊天选择');
  h.setIdentity({ ...h.identity, chatId: CHAT_A, hostChatId: 'host-a' }); h.runtime.invalidate(); await h.runtime.refresh();
  assert.deepEqual(h.runtime.getState().selectedEntityIds, selected.slice(0, 2));
});

test('旧人物暂时不可见时保留既有关注、允许显式移除但不允许重新添加', async () => {
  const h = harness(); await h.runtime.refresh({ refreshMemory: false });
  const [first, hidden, third] = h.peopleEntities;
  await h.runtime.setSelectedEntityIds([first.id, hidden.id]);
  await h.runtime.saveProfile(hidden.id, { name: '隐藏人物旧档', notes: '保留的资料' }, { manualFields: [] });
  h.setReachable({ ...h.reachable,
    entities: h.reachable.entities.filter(item => item.id !== hidden.id),
    floorMemories: h.reachable.floorMemories.filter(memory => !memory.participants?.some(item => item.entityId === hidden.id)),
  });
  await h.runtime.refresh({ refreshMemory: false });
  assert.deepEqual(h.runtime.getState().selectedEntityIds, [first.id, hidden.id]);
  assert.equal(h.runtime.getState().people.some(person => person.entityId === hidden.id), false);

  await h.runtime.setSelectedEntityIds([first.id, hidden.id, third.id]);
  assert.deepEqual(h.runtime.getState().selectedEntityIds, [first.id, hidden.id, third.id]);
  assert.equal(h.runtime.getState().profilesByEntityId[hidden.id].name, '隐藏人物旧档');
  await assert.rejects(h.runtime.setSelectedEntityIds([first.id, hidden.id, third.id, ids[10]]), error => error.code === 'QQJ_PEOPLE_SELECTION_INVALID');

  await h.runtime.setSelectedEntityIds([first.id, third.id]);
  assert.deepEqual(h.runtime.getState().selectedEntityIds, [first.id, third.id]);
  assert.equal(h.runtime.getState().profilesByEntityId[hidden.id].name, '隐藏人物旧档', '移除关注不删除人物旧档');
  await assert.rejects(h.runtime.setSelectedEntityIds([first.id, hidden.id, third.id]), error => error.code === 'QQJ_PEOPLE_SELECTION_INVALID');
  assert.deepEqual(h.runtime.getState().selectedEntityIds, [first.id, third.id]);
});

test('人物显示顺序独立持久化，新人物按原序追加且合并删除同步收敛', async () => {
  let modelCalls = 0;
  const h = harness({ generate: async () => { modelCalls += 1; return { jsonData: { profiles: [] } }; } });
  await h.runtime.refresh();
  const [a, b, c, d] = h.peopleEntities;
  const selectedBefore = h.runtime.getState().selectedEntityIds;
  await h.runtime.setPersonOrderEntityIds([c.id, a.id]);
  let state = h.runtime.getState();
  assert.deepEqual(state.people.map(person => person.entityId), [c.id, a.id, b.id, d.id], '未列入显式顺序的人物按原候选顺序追加');
  assert.deepEqual(state.selectedEntityIds, selectedBefore, '排序不得改变关注状态');
  assert.deepEqual(h.db.records.get(`chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`).data.personOrderEntityIds, [c.id, a.id]);
  h.runtime.invalidate(); await h.runtime.refresh();
  assert.deepEqual(h.runtime.getState().people.map(person => person.entityId), [c.id, a.id, b.id, d.id], '刷新后从同一 workspace 读回顺序');
  await h.runtime.mergePeople(a.id, b.id, 'target');
  state = h.runtime.getState(); assert.deepEqual(state.personOrderEntityIds, [c.id, b.id]);
  await h.runtime.deletePerson(c.id);
  state = h.runtime.getState(); assert.deepEqual(state.personOrderEntityIds, [b.id]);
  assert.equal(modelCalls, 0, '纯排序、合并和删除不得额外调用人物整理模型');
});

test('人工合并以目标身份汇集历史，整档头像二选一并支持链式收敛与删除隐藏成员', async () => {
  let modelCalls = 0, generatedRequest = null;
  const h = harness({ generate: async options => {
    modelCalls += 1; generatedRequest = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { profiles: [{ personKey: 'person-1', notes: '整理后' }] } };
  } });
  await h.runtime.refresh();
  const [a, b, c] = h.peopleEntities;
  await h.runtime.setSelectedEntityIds([a.id, b.id]);
  await h.runtime.saveProfile(a.id, { name: '甲档姓名', aliases: '旧称甲', notes: '采用甲档' });
  await h.runtime.saveProfile(b.id, { name: '乙档姓名', aliases: '旧称乙', notes: '乙档' });
  await h.runtime.saveAvatar(a.id, 'data:image/png;base64,AAAA');
  await h.runtime.mergePeople(a.id, b.id, 'source');
  let state = h.runtime.getState();
  assert.equal(modelCalls, 0); assert.equal(state.people.some(person => person.entityId === a.id), false);
  assert.equal(state.profilesByEntityId[b.id].name, '乙档姓名', '采用来源档案时仍保持用户选择的目标人物名');
  assert.equal(state.profilesByEntityId[b.id].notes, '采用甲档'); assert.equal(state.avatarsByEntityId[b.id], 'data:image/png;base64,AAAA');
  assert.deepEqual(state.selectedEntityIds, [b.id]); assert.equal(state.identityRedirectsByEntityId[a.id], b.id);
  assert.ok(state.people.find(person => person.entityId === b.id).aliases.includes('人物1'));
  await h.runtime.regenerateProfile(b.id);
  assert.equal(generatedRequest.people[0].sourceFragments.filter(item => item.kind === 'history').length, 2, '来源与目标的不同历史楼均归目标且不丢失');
  assert.ok(h.runtime.getState().profileMaterialProgressByEntityId[b.id], '整理成功后目标人物保存材料进度');
  await h.runtime.saveProfile(c.id, { name: '丙档姓名', aliases: '旧称丙', notes: '采用丙档' });
  await h.runtime.saveAvatar(c.id, 'data:image/png;base64,CCCC');
  await h.runtime.mergePeople(b.id, c.id, 'target');
  state = h.runtime.getState(); assert.equal(state.identityRedirectsByEntityId[a.id], c.id); assert.equal(state.identityRedirectsByEntityId[b.id], c.id);
  assert.equal(state.profilesByEntityId[c.id].notes, '采用丙档'); assert.equal(state.avatarsByEntityId[c.id], 'data:image/png;base64,CCCC');
  assert.equal(state.profileMaterialProgressByEntityId[b.id], undefined); assert.equal(state.profileMaterialProgressByEntityId[c.id], undefined, '合并不复用任一人的旧材料覆盖进度');
  await h.runtime.deletePerson(c.id);
  state = h.runtime.getState(); assert.equal(state.people.some(person => [a.id, b.id, c.id].includes(person.entityId)), false);
  h.runtime.invalidate(); await h.runtime.refresh();
  assert.equal(h.runtime.getState().people.some(person => [a.id, b.id, c.id].includes(person.entityId)), false, '刷新后已吸收成员不得复活');
});

test('删除只排除既有实体ID，同名新ID仍可再次成为人物候选', async () => {
  const h = harness(); await h.runtime.refresh(); const removed = h.peopleEntities[0];
  await h.runtime.deletePerson(removed.id);
  const replacement = entity('99999999-1111-4111-8111-999999999999', removed.displayName);
  h.setReachable({ ...h.runtime.getState(), entities: [...h.peopleEntities, replacement], floorMemories: [{ recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '同名新人出现。' }, participants: [{ entityId: replacement.id }] }], baseline: null });
  h.runtime.invalidate(); await h.runtime.refresh();
  assert.equal(h.runtime.getState().people.some(person => person.entityId === removed.id), false);
  assert.equal(h.runtime.getState().people.some(person => person.entityId === replacement.id), true);
});

test('首次人工保存包括全空资料才建档，已有资料无改动零写且资料名不改实体', async () => {
  const h = harness(); await h.runtime.refresh(); const id = h.peopleEntities[0].id;
  await h.runtime.setSelectedEntityIds([id]);
  const empty = { name: '', aliases: '', background: '', appearance: '', personality: '', notes: '' };
  await h.runtime.saveProfile(id, empty);
  let state = h.runtime.getState(), profile = state.profilesByEntityId[id];
  assert.equal(profile.source, 'manual'); assert.equal(profile.name, ''); assert.equal(state.people.find(item => item.entityId === id).profiled, true);
  const puts = h.db.calls.filter(call => call[0] === 'put').length;
  await h.runtime.saveProfile(id, empty);
  assert.equal(h.db.calls.filter(call => call[0] === 'put').length, puts, '已有空资料再次保存是语义 no-op');
  await h.runtime.saveProfile(id, { ...empty, name: '用户自定姓名', aliases: '别称', notes: '人工说明' });
  state = h.runtime.getState(); profile = state.profilesByEntityId[id];
  assert.equal(profile.name, '用户自定姓名'); assert.equal(profile.notes, '人工说明');
  assert.equal(h.peopleEntities[0].displayName, '人物1', 'profile 展示名不得反写实体身份');
});

test('缺档整理只覆盖未建档人物，原文保留并使用本次 personKey 绑定', async () => {
  let request, systemPrompt;
  const h = harness({ generate: async options => {
    systemPrompt = options.systemPrompt;
    request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { profiles: [{ personKey: 'person-1', name: '人物2资料名', aliases: ['小二'], background: '背景', appearance: '', personality: '沉稳', notes: '' }] } };
  } });
  await h.runtime.refresh(); const [first, second] = h.peopleEntities;
  await h.runtime.setSelectedEntityIds([first.id, second.id]);
  await h.runtime.saveProfile(first.id, { name: '', aliases: '', background: '', appearance: '', personality: '', notes: '' });
  await h.runtime.generateMissingProfiles();
  assert.deepEqual(request.people.map(item => item.currentName), ['人物2'], '已有资料包括人工清空都不得再交给模型补空');
  assert.equal(request.allowedWorldInfo.length, 1); assert.equal(request.allowedWorldInfo[0].source, '允许书');
  assert.equal(JSON.stringify(request).includes('EXCLUDED'), false); assert.equal(JSON.stringify(request).includes('DROP'), true); assert.equal(JSON.stringify(request).includes('ALLOWED'), true);
  assert.deepEqual(h.sourceTrace.map(item => item[0]), ['scan', 'candidates', 'filter']);
  assert.equal(h.sourceTrace[0][2].complete, true); assert.equal(h.sourceTrace[0][2].strict, true);
  assert.equal(systemPrompt.split(BASE_PROCESSING_PROMPT).length - 1, 1, '人物资料任务只携带一次基础处理层');
  assert.match(systemPrompt, /personKey 必须逐字使用/); assert.doesNotMatch(systemPrompt, /sanctuary_override_directive/);
  const state = h.runtime.getState(); assert.equal(state.profilesByEntityId[first.id].source, 'manual'); assert.equal(state.profilesByEntityId[second.id].source, 'generated');
  assert.deepEqual(state.selectedEntityIds, [first.id, second.id], '生成与选择保存必须分离');
});

test('第 50 楼才建档仍读取第 1 楼目标事实与近期变化，逐楼归属不混入他人私密资料', async () => {
  let request, calls = 0;
  const h = harness({ generate: async options => {
    calls += 1; request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { profiles: [{ personKey: 'person-1', name: '人物1', notes: '综合历史资料' }] } };
  } });
  const [target, other] = h.peopleEntities;
  const floorId = seq => `f${String(seq).padStart(7, '0')}-1111-4111-8111-${String(seq).padStart(12, '0')}`;
  const floors = Array.from({ length: 50 }, (_, index) => ({ id: floorId(index + 1), assistantSeq: index + 1 }));
  const floorMemories = floors.map(floor => ({
    floorId: floor.id, recordStatus: 'active',
    summary: { effectiveSource: 'ai', aiText: `无关人物第${floor.assistantSeq}楼资料。` },
    participants: [{ entityId: other.id }],
    actions: [{ actorEntityId: other.id, targetEntityIds: [], action: `他人动作${floor.assistantSeq}`, completion: 'completed', result: null }],
    observations: [], informationTransfers: [], commitments: [], locations: [], openLoops: [], cseSignals: [], exactAnchors: [],
    privateCognition: [{ ownerEntityId: other.id, kind: 'thought', content: `他人的秘密${floor.assistantSeq}` }],
  }));
  floorMemories[0].summary.aiText = '{{user}}在第1楼发现人物1左眉有一道旧疤。';
  floorMemories[0].observations.push({ subjectEntityId: target.id, kind: 'physical', description: '人物1左眉有一道旧疤' });
  floorMemories[49].summary.aiText = '人物1在第50楼换下礼服，恢复常穿的黑色长外套。';
  floorMemories[49].participants = [{ entityId: target.id }];
  floorMemories[49].actions.push({ actorEntityId: target.id, targetEntityIds: [], action: '恢复常穿的黑色长外套', completion: 'completed', result: '穿着风格得到再次印证' });
  floorMemories[49].privateCognition.push({ ownerEntityId: target.id, kind: 'privateDecision', content: '以后仍以低调耐用为先' });
  h.setReachable({
    entities: [...h.peopleEntities, entity(USER, '用户', { specialRole: 'user' }), entity(SYNTHETIC_CHAR, '剧情标题', { specialRole: 'char', firstSeenFloorId: null, lastSeenFloorId: null })],
    floors, floorMemories,
    baseline: { userPersona: { name: '辛夷' }, characterCard: { entityId: SYNTHETIC_CHAR, name: '剧情标题', description: '角色卡描述', personality: '角色卡性格', scenario: '场景' } },
  });
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([target.id]); await h.runtime.generateMissingProfiles();
  assert.equal(calls, 1, '扩大历史输入不得增加人物整理请求次数');
  assert.deepEqual(request.people[0].history.map(item => item.sourceFloor), [1, 50]);
  assert.match(request.people[0].history[0].summary, /辛夷在第1楼/);
  assert.deepEqual(request.people[0].history[0].facts.observations, [{ kind: 'physical', description: '人物1左眉有一道旧疤' }]);
  assert.equal(request.people[0].history[1].facts.actions[0].role, 'actor');
  assert.equal(request.people[0].history[1].facts.privateCognition[0].content, '以后仍以低调耐用为先');
  assert.equal(JSON.stringify(request.people[0].history).includes('他人的秘密'), false);
  assert.equal(JSON.stringify(request.people[0].history).includes('无关人物第25楼'), false);
});

test('人物输入优先使用与有效摘要同存正文，构造空串不回退且旧记录仍兼容楼正文', async () => {
  let request;
  const h = harness({ generate: async options => {
    request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { profiles: [{ personKey: 'person-1', name: '人物1' }] } };
  } });
  const target = h.peopleEntities[0];
  const freshFloor = ids[8], emptyFloor = ids[9], legacyFloor = ids[10];
  h.setReachable({
    ...h.reachable,
    floors: [
      { id: freshFloor, assistantSeq: 1, content: { canonicalContent: '人物1仍是蓝发。' } },
      { id: emptyFloor, assistantSeq: 2, content: { canonicalContent: '这段旧正文不得回退。' } },
      { id: legacyFloor, assistantSeq: 3, content: { canonicalContent: '人物1穿着绿色旧外套。' } },
    ],
    floorMemories: [
      { floorId: freshFloor, recordStatus: 'active', sourceCanonicalContent: '人物1已经改为红发。', summary: { effectiveSource: 'ai', aiText: '人物1现在是红发。' }, participants: [{ entityId: target.id }] },
      { floorId: emptyFloor, recordStatus: 'active', sourceCanonicalContent: '', summary: { effectiveSource: 'ai', aiText: '本楼清洗后正文为空。' }, participants: [{ entityId: target.id }] },
      { floorId: legacyFloor, recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '旧记录仍保留绿色外套。' }, participants: [{ entityId: target.id }] },
    ],
  });
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([target.id]); await h.runtime.generateMissingProfiles();
  assert.equal(request.people[0].history[0].storyContent, '人物1已经改为红发。');
  assert.equal(request.people[0].history[0].summary, '人物1现在是红发。');
  assert.equal(request.people[0].history[1].storyContent, '');
  assert.equal(request.people[0].history[2].storyContent, '人物1穿着绿色旧外套。');
  assert.equal(JSON.stringify(request).includes('人物1仍是蓝发'), false);
  assert.equal(JSON.stringify(request).includes('这段旧正文不得回退'), false);
});

test('聚合人物历史省略多楼正文但保留用户摘要、目标事实和原句，普通单楼正文不变', async () => {
  let request;
  const h = harness({ generate: async options => {
    request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { profiles: [{ personKey: 'person-1', name: '人物1' }] } };
  } });
  const [target, other] = h.peopleEntities;
  const aggregateFloorIds = Array.from({ length: 10 }, (_, index) => `a${String(index + 1).padStart(7, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`);
  const aggregateFloorId = aggregateFloorIds.at(-1), singletonFloorId = ids[12];
  h.setReachable({
    ...h.reachable,
    floors: [
      ...aggregateFloorIds.map((id, index) => ({ id, assistantSeq: index + 1, content: { canonicalContent: `聚合成员正文${index + 1}` } })),
      { id: singletonFloorId, assistantSeq: 11, content: { canonicalContent: '普通单楼正文保留。' } },
    ],
    floorMemories: [
      {
        floorId: aggregateFloorId, sourceFloorIds: aggregateFloorIds, recordStatus: 'active',
        sourceCanonicalContent: `聚合十楼全文${'甲'.repeat(6000)}`,
        summary: { effectiveSource: 'user', aiText: '旧AI摘要', userText: '用户修订后的聚合摘要。' },
        participants: [{ entityId: target.id }],
        actions: [
          { actorEntityId: target.id, targetEntityIds: [], action: '目标人物作出决定', completion: 'completed', result: null },
          { actorEntityId: other.id, targetEntityIds: [], action: '他人动作不应归入', completion: 'completed', result: null },
        ],
        exactAnchors: [{ speakerEntityId: target.id, kind: 'dialogue', exactText: '我会亲自处理。', whyPreserve: '关键承诺' }],
      },
      {
        floorId: singletonFloorId, recordStatus: 'active', sourceCanonicalContent: '普通单楼正文保留。',
        summary: { effectiveSource: 'ai', aiText: '普通单楼摘要。' }, participants: [{ entityId: target.id }],
      },
    ],
  });
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([target.id]); await h.runtime.generateMissingProfiles();
  const [aggregate, singleton] = request.people[0].history;
  assert.equal(Object.hasOwn(aggregate, 'storyContent'), false, '聚合记忆不再重复携带十楼全文');
  assert.equal(aggregate.summary, '用户修订后的聚合摘要。');
  assert.deepEqual(aggregate.facts.actions, [{ role: 'actor', action: '目标人物作出决定', completion: 'completed' }]);
  assert.deepEqual(aggregate.facts.exactAnchors, [{ kind: 'dialogue', exactText: '我会亲自处理。', whyPreserve: '关键承诺' }]);
  assert.equal(JSON.stringify(aggregate).includes('他人动作不应归入'), false, '目标事实归属边界不变');
  assert.equal(singleton.storyContent, '普通单楼正文保留。');
  assert.equal(singleton.summary, '普通单楼摘要。');
});

test('固定混合历史中聚合正文减量会收敛人物整理批数且普通正文仍计入', async () => {
  let calls = 0; const requests = [];
  const h = harness({ generate: async options => {
    calls += 1; requests.push(JSON.parse(options.taskMessages[0].content));
    return { jsonData: { profiles: [{ personKey: 'person-1', name: '人物1' }] } };
  } });
  const target = h.peopleEntities[0];
  const floorMemories = Array.from({ length: 67 }, (_, index) => {
    const floorId = `b${String(index + 1).padStart(7, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;
    const aggregate = index < 33;
    return {
      floorId, ...(aggregate ? { sourceFloorIds: [ids[14], floorId] } : {}), recordStatus: 'active',
      sourceCanonicalContent: `${aggregate ? '聚合正文不得进入' : '普通正文必须进入'}-${index}-${'文'.repeat(aggregate ? 20000 : 2000)}`,
      summary: { effectiveSource: 'ai', aiText: `人物1历史摘要-${index}-${'摘'.repeat(3000)}` },
      participants: [{ entityId: target.id }],
    };
  });
  h.setReachable({
    ...h.reachable,
    floors: floorMemories.map((memory, index) => ({ id: memory.floorId, assistantSeq: index + 1, content: { canonicalContent: memory.sourceCanonicalContent } })),
    floorMemories,
  });
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([target.id]); await h.runtime.generateMissingProfiles();
  const serialized = requests.map(request => JSON.stringify(request)).join('');
  assert.equal(calls, 14, '固定 33 聚合加 34 单楼材料在现有 24k 分批规则下收敛为 14 批');
  assert.equal(serialized.includes('聚合正文不得进入'), false);
  assert.equal(serialized.includes('普通正文必须进入'), true);
  assert.equal(requests.every(request => JSON.stringify(request).length <= PEOPLE_PROFILE_INPUT_CHAR_BUDGET + 1000), true);

  let fullTextCalls = 0;
  const fullText = harness({ generate: async options => {
    fullTextCalls += 1; const request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { profiles: [{ personKey: request.people[0].personKey, name: '人物1' }] } };
  } });
  fullText.setReachable({
    ...fullText.reachable,
    floors: floorMemories.map((memory, index) => ({ id: memory.floorId, assistantSeq: index + 1, content: { canonicalContent: memory.sourceCanonicalContent } })),
    floorMemories: floorMemories.map(memory => { const copy = structuredClone(memory); delete copy.sourceFloorIds; return copy; }),
  });
  await fullText.runtime.refresh(); await fullText.runtime.setSelectedEntityIds([fullText.peopleEntities[0].id]); await fullText.runtime.generateMissingProfiles();
  assert.equal(fullTextCalls, 42, '相同固定材料若把聚合正文按普通单楼投入会产生 42 批');
});

test('长历史按楼序连续分批，前批档案进入后批且覆盖首尾', async () => {
  let calls = 0; const requests = [];
  const h = harness({ generate: async options => {
    calls += 1; const request = JSON.parse(options.taskMessages[0].content); requests.push(request);
    return { jsonData: { profiles: [{ personKey: 'person-1', ...(calls === 1 ? { name: '人物1' } : {}), ...(request.batch.index === request.batch.total ? { notes: '末批完成' } : {}) }] } };
  } });
  const target = h.peopleEntities[0];
  const floorMemories = Array.from({ length: 80 }, (_, index) => ({
    floorId: `e${String(index + 1).padStart(7, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
    recordStatus: 'active', sourceCanonicalContent: `第${index + 1}楼最新正文${'乙'.repeat(3990)}`,
    summary: { effectiveSource: 'ai', aiText: `人物1${'甲'.repeat(3997)}` }, participants: [{ entityId: target.id }],
  }));
  h.setReachable({
    entities: [...h.peopleEntities, entity(USER, '用户', { specialRole: 'user' })],
    floors: floorMemories.map((memory, index) => ({ id: memory.floorId, assistantSeq: index + 1,
      content: { canonicalContent: `第${index + 1}楼旧正文${'丙'.repeat(3990)}` } })),
    floorMemories,
    baseline: { characterCard: { entityId: SYNTHETIC_CHAR, name: '剧情标题', description: '', personality: '', scenario: '' } },
  });
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([target.id]);
  await h.runtime.generateMissingProfiles();
  assert.ok(calls > 1); assert.ok(requests.every(request => JSON.stringify(request).length <= PEOPLE_PROFILE_INPUT_CHAR_BUDGET + 1000));
  assert.deepEqual(requests.flatMap(request => request.people[0].sourceFragments).filter(item => item.kind === 'history' && item.part === 1).map(item => item.sourceFloor), Array.from({ length: 80 }, (_, index) => index + 1));
  const firstHistory = requests.flatMap(request => request.people[0].sourceFragments).filter(item => item.kind === 'history' && item.sourceFloor === 1)
    .sort((left, right) => left.part - right.part).map(item => item.content).join('');
  assert.equal(JSON.parse(firstHistory).storyContent, `第1楼最新正文${'乙'.repeat(3990)}`, '与有效摘要同存的正文跨片后可按原顺序无损还原');
  assert.equal(firstHistory.includes('第1楼旧正文'), false);
  assert.equal(requests[1].people[0].existingProfile.name, '人物1', '前批已保存档案必须成为后批起点');
  assert.equal(h.runtime.getState().profilesByEntityId[target.id].notes, '末批完成');
  assert.equal(h.runtime.getState().lastGenerationReport.completedBatches, calls);
});

test('长资料后批失败时保留前批已保存档案，且大世界书片段按原顺序进入各批', async () => {
  let calls = 0; const requests = [];
  const hugeWorld = `世界书开头${'设'.repeat(PEOPLE_PROFILE_INPUT_CHAR_BUDGET * 2)}世界书结尾`;
  const h = harness({
    sourceCandidates: [{ id: 'worldbook:huge', kind: 'worldbook', world: '长设定', label: '人物条目', content: hugeWorld }],
    generate: async options => {
      calls += 1; const request = JSON.parse(options.taskMessages[0].content); requests.push(request);
      if (calls === 2) throw new Error('第二批失败');
      return { jsonData: { profiles: [{ personKey: 'person-1', name: '前批已存' }] } };
    },
  });
  const target = h.peopleEntities[0]; await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([target.id]);
  await assert.rejects(h.runtime.generateMissingProfiles(), /第二批失败/);
  assert.equal(calls, 2); assert.equal(h.runtime.getState().profilesByEntityId[target.id].name, '前批已存');
  assert.equal(h.runtime.getState().profileMaterialProgressByEntityId[target.id], undefined, '后批失败时不得把整轮材料误记为已覆盖');
  assert.equal(requests[1].people[0].existingProfile.name, '前批已存');
  const fragments = requests.flatMap(request => request.people[0].sourceFragments).filter(item => item.kind === 'allowedWorldInfo');
  assert.ok(fragments.length > 1); assert.equal(fragments[0].part, 1); assert.equal(fragments[0].total, fragments.at(-1).total);
});

test('人物前情按目标匹配，首次长资料复用分批且已有档案只取小量', async () => {
  const imported = Array.from({ length: 100 }, (_, index) => `人物1旧名 archive-${index} ${'A'.repeat(360)}。`).join('\n');
  const requests = [];
  const h = harness({ prequel: imported, generate: async options => {
    const request = JSON.parse(options.taskMessages[0].content); requests.push(request);
    return { jsonData: { profiles: request.people.map(person => ({ personKey: person.personKey, name: person.currentName || '人物1' })) } };
  } });
  const target = h.peopleEntities[0];
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([target.id]); await h.runtime.generateMissingProfiles();
  assert.ok(requests.length > 1, '首次相关长前情应复用既有人物长资料分批');
  assert.ok(requests.every(request => !Object.hasOwn(request.people[0], 'priorContext')), '分批公共 base 不得重复整份前情');
  const priorFragments = requests.flatMap(request => request.people[0].sourceFragments).filter(item => item.kind === 'priorContext');
  assert.ok(priorFragments.length > 1);
  assert.deepEqual(priorFragments.map(item => item.part), Array.from({ length: priorFragments[0].total }, (_, index) => index + 1));
  const firstImported = priorFragments.map(item => item.content).join('');
  assert.match(firstImported, /用户导入的过去经历资料/); assert.match(firstImported, /人物1旧名/);
  assert.equal(requests[1].people[0].existingProfile.name, '人物1', '后批继续读取前批已保存档案');

  requests.length = 0;
  await h.runtime.regenerateProfile(target.id);
  const laterPrior = requests.flatMap(request => request.people.flatMap(person => person.priorContext ? [person.priorContext] : (person.sourceFragments ?? []).filter(item => item.kind === 'priorContext').map(item => item.content))).join('');
  assert.ok(laterPrior.length > 0 && laterPrior.length <= 2400, '已有档案只附小量相关前情');

  const before = requests.length;
  h.setPrequel(`${imported}\n人物1新增但未触发的手工前情`); h.notifyMemory();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.length, before, '只编辑前情不进入人物 freshness/signature，不自动发请求');
});

test('批量整理按 personKey 独立接受合法项并准确报告遗漏、未知与冲突', async () => {
  for (const scenario of ['missing', 'mixed']) {
    const h = harness({ generate: async () => {
      const profiles = scenario === 'missing'
        ? [{ personKey: 'person-1', name: '唯一返回', aliases: [], background: '', appearance: '', personality: '', notes: '' }]
        : [
        { personKey: 'person-1', name: '合法甲', aliases: [], background: '', appearance: '', personality: '', notes: '' },
        { personKey: `unknown-${'x'.repeat(500)}`, name: '未知目标' },
        { personKey: 'person-2', name: '冲突乙一' },
        { personKey: 'person-2', name: '冲突乙二' },
        ];
      return { jsonData: { profiles } };
    } });
    await h.runtime.refresh();
    const targets = h.peopleEntities.slice(0, scenario === 'missing' ? 2 : 3);
    await h.runtime.setSelectedEntityIds(targets.map(person => person.id));
    const putsBefore = h.db.calls.filter(call => call[0] === 'put').length;
    const state = await h.runtime.generateMissingProfiles();
    assert.equal(h.db.calls.filter(call => call[0] === 'put').length, putsBefore + 1, `${scenario}：档案与成功材料进度同批 CAS 保存`);
    assert.equal(state.profilesByEntityId[targets[0].id].name, scenario === 'missing' ? '唯一返回' : '合法甲');
    assert.equal(state.profilesByEntityId[targets[1].id], undefined);
    if (targets[2]) assert.equal(state.profilesByEntityId[targets[2].id], undefined);
    assert.deepEqual(state.lastGenerationReport, scenario === 'missing'
      ? { requested: 2, saved: 1, worldInfoMatched: 1, missing: 1, conflicts: 0, invalid: 0, unknown: 0, skipped: 0 }
      : { requested: 3, saved: 1, worldInfoMatched: 1, missing: 1, conflicts: 1, invalid: 0, unknown: 1, skipped: 0 });
  }

  const invalid = harness({ generate: async () => ({ jsonData: { profiles: [{ personKey: 'unknown', name: '未知' }, { personKey: 'person-1', aliases: ['x'.repeat(501)] }] } }) });
  await invalid.runtime.refresh();
  await invalid.runtime.setSelectedEntityIds(invalid.peopleEntities.slice(0, 2).map(person => person.id));
  const putsBefore = invalid.db.calls.filter(call => call[0] === 'put').length;
  await assert.rejects(invalid.runtime.generateMissingProfiles(), error => error.code === 'QQJ_PEOPLE_GENERATION_BINDING_INVALID');
  assert.equal(invalid.db.calls.filter(call => call[0] === 'put').length, putsBefore, '零合法条目不得写入');
  assert.deepEqual(invalid.runtime.getState().profilesByEntityId, {});
});

test('当前人物重新整理仅请求一次且不带旧 AI 资料，最新人工字段与人工清空不会被模型覆盖', async () => {
  let calls = 0, request;
  const h = harness({ generate: async options => {
    calls += 1; request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { profiles: [{ personKey: 'person-1', name: '模型新名', aliases: ['模型别名'], gender: '女', background: '模型新背景', notes: '模型试图覆盖', appearance: '', personality: '' }] } };
  } });
  await h.runtime.refresh(); const [first, second] = h.peopleEntities; await h.runtime.setSelectedEntityIds([first.id, second.id]);
  await h.runtime.saveProfile(first.id, { name: '原名', aliases: '', background: '原背景', appearance: '', personality: '', notes: '人工旧补充' }, { manualFields: ['name', 'notes'] });
  await h.runtime.saveProfile(first.id, { name: '原名', aliases: '', background: '原背景', appearance: '', personality: '', notes: '' }, { manualFields: ['notes'] });
  await h.runtime.regenerateProfile(first.id);
  const profile = h.runtime.getState().profilesByEntityId[first.id];
  assert.equal(calls, 1); assert.deepEqual(request.people.map(item => item.personKey), ['person-1']);
  assert.deepEqual(request.people[0].existingProfile, {}); assert.deepEqual(request.people[0].manualProfile, { name: '原名', notes: '' }); assert.deepEqual(request.people[0].manualFields, ['name', 'notes']);
  assert.equal(Object.hasOwn(request.people[0].existingProfile, 'name'), false, '人工字段只走 manualProfile，不伪装成旧 AI 字段');
  assert.equal(Object.hasOwn(request.people[0].manualProfile, 'background'), false, '旧 AI 字段不混入人工资料');
  assert.equal(profile.name, '原名'); assert.equal(profile.notes, ''); assert.equal(profile.background, '模型新背景'); assert.equal(profile.gender, '女');
  assert.equal(h.runtime.getState().profilesByEntityId[second.id], undefined, '未授权的另一人物保持不变');
});

test('主动重整替换旧AI：缺省及错误字段不继承，合法字段和空值按本轮保存', async () => {
  let mode = 'initial', calls = 0, patchRequest;
  const h = harness({ generate: async options => {
    calls += 1;
    const request = JSON.parse(options.taskMessages[0].content);
    if (mode === 'failure') throw new Error('模型暂时失败');
    if (mode === 'initial') return { jsonData: { profiles: [{ personKey: 'person-1', name: '旧名', aliases: ['旧别名'], background: '旧背景', appearance: '旧外貌', personality: '旧性格', notes: '旧补充' }] } };
    patchRequest = request;
    if (mode === 'partial') return { jsonData: { profiles: [{ personKey: 'person-1', name: '新名', aliases: ['合法别名', 7], background: null, appearance: { text: '错误对象' }, personality: '', likes: '热茶', notes: null }] } };
    if (mode === 'clear') return { jsonData: { profiles: [{ personKey: 'person-1', aliases: [] }] } };
    return { jsonData: { profiles: [{ personKey: 'person-1', aliases: '小一、小幺' }] } };
  } });
  const id = h.peopleEntities[0].id;
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([id]); await h.runtime.generateMissingProfiles();
  mode = 'partial'; await h.runtime.regenerateProfile(id);
  let profile = h.runtime.getState().profilesByEntityId[id];
  assert.equal(profile.name, '新名'); assert.equal(profile.aliases, '', '重整不得因错误字段继承旧AI');
  assert.equal(profile.background, ''); assert.equal(profile.appearance, ''); assert.equal(profile.notes, '');
  assert.equal(profile.personality, '', '合法空字符串表示明确清除'); assert.equal(profile.likes, '热茶');
  assert.deepEqual(patchRequest.people[0].existingProfile, {});
  mode = 'clear'; await h.runtime.regenerateProfile(id);
  assert.equal(h.runtime.getState().profilesByEntityId[id].aliases, '', '合法空数组表示明确清除 aliases');
  mode = 'string'; await h.runtime.regenerateProfile(id);
  assert.equal(h.runtime.getState().profilesByEntityId[id].aliases, '小一、小幺', '兼容 aliases 字符串形式');
  const beforeFailure = structuredClone(h.runtime.getState().profilesByEntityId[id]);
  mode = 'failure'; await assert.rejects(h.runtime.regenerateProfile(id), /模型暂时失败/);
  assert.deepEqual(h.runtime.getState().profilesByEntityId[id], beforeFailure, '请求失败不得清除旧档案');
  assert.equal(calls, 5, '每次主动整理仍只调用一次人物模型');
});

test('模型 aliases 字符串沿用既有 20000 字符上限且保留同项其他合法字段', async () => {
  const aliases = '别'.repeat(501);
  const h = harness({ generate: async () => ({ jsonData: { profiles: [{
    personKey: 'person-1', name: '合法姓名', aliases, background: '合法背景',
  }] } }) });
  const id = h.peopleEntities[0].id;
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([id]); await h.runtime.generateMissingProfiles();
  const profile = h.runtime.getState().profilesByEntityId[id];
  assert.equal(profile.aliases, aliases);
  assert.equal(profile.name, '合法姓名'); assert.equal(profile.background, '合法背景');
});

test('模型 aliases 数组拼接超过 20000 字符时仅忽略别名字段并应用其他合法 patch', async () => {
  let mode = 'initial';
  const oversizedAliases = Array.from({ length: 45 }, (_, index) => `${String(index).padStart(2, '0')}${'别'.repeat(498)}`);
  const h = harness({ generate: async () => ({ jsonData: { profiles: [mode === 'initial'
    ? { personKey: 'person-1', name: '旧名', aliases: ['旧别名'], background: '旧背景' }
    : { personKey: 'person-1', name: '新名', aliases: oversizedAliases, background: '新背景' }] } }) });
  const id = h.peopleEntities[0].id;
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([id]); await h.runtime.generateMissingProfiles();
  mode = 'patch'; await h.runtime.regenerateProfile(id);
  const profile = h.runtime.getState().profilesByEntityId[id];
  assert.equal(profile.aliases, '');
  assert.equal(profile.name, '新名'); assert.equal(profile.background, '新背景');
});

test('人物卡与历史按现行合同解析宏，选中世界书原文则保留宏且其他资料不受影响', async () => {
  let request;
  const h = harness({
    sourceCandidates: [{ id: 'worldbook:allowed', kind: 'worldbook', world: '设定书', label: '设定书 · 人物1相关', entryLabel: '人物1相关', primaryKeys: ['人物1'], content: '{{user}}信任{{char}}，普通 user char。' }],
    generate: async options => {
      request = JSON.parse(options.taskMessages[0].content);
      return { jsonData: { profiles: [{ personKey: 'person-1', name: '人物1', aliases: [], background: '{{user}}与{{char}}，普通 user char。', appearance: '', personality: '', notes: '' }] } };
    },
  });
  const [target] = h.peopleEntities;
  h.setReachable({
    entities: [...h.peopleEntities, entity(USER, '用户', { specialRole: 'user' }), entity(SYNTHETIC_CHAR, '主角', { specialRole: 'char', firstSeenFloorId: null, lastSeenFloorId: null })],
    floorMemories: [{ recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '{{user}}遇见{{char}}，普通 user char。' }, participants: [{ entityId: target.id }],
      sourceVariableReference: { stat_data: { 人物1: { 发色: '黑色' }, 另一人物: { 发色: '银色' } }, ejsSaved: { season: '秋' } } }],
    baseline: { userPersona: { name: '辛夷' }, characterCard: { entityId: SYNTHETIC_CHAR, name: '主角', description: '', personality: '', scenario: '' } },
  });
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([target.id]);
  await h.runtime.saveProfile(target.id, { name: '人物1', aliases: '', background: '', appearance: '', personality: '', notes: '{{user}}认识{{char}}，普通 user char。' }, { manualFields: [] });
  assert.equal(h.runtime.getState().people.find(item => item.entityId === target.id).profile.notes, '辛夷认识主角，普通 user char。');
  const raw = h.db.records.get(`chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`).data.profilesByEntityId[target.id];
  assert.equal(raw.notes, '{{user}}认识{{char}}，普通 user char。', '旧记录只做展示投影，不迁移回写');
  await h.runtime.regenerateProfile(target.id);
  const history = JSON.parse(request.people[0].sourceFragments.find(item => item.kind === 'history').content);
  assert.equal(history.summary, '辛夷遇见主角，普通 user char。');
  assert.equal(history.sourceFloor, 1);
  assert.deepEqual(history.auxiliaryStateSnapshot, { stat_data: { 人物1: { 发色: '黑色' }, 另一人物: { 发色: '银色' } }, ejsSaved: { season: '秋' } });
  assert.equal(request.people[0].sourceFragments.find(item => item.kind === 'allowedWorldInfo').content, '{{user}}信任{{char}}，普通 user char。');
  assert.deepEqual(request.people[0].manualProfile, {});
  assert.equal(h.runtime.getState().profilesByEntityId[target.id].background, '辛夷与主角，普通 user char。');
});

test('完整重整按人物标题与主次关键词选材，原样保留条件脚本、标签及40k尾段', async () => {
  const raw = `<unknown>开头<inner>${'设'.repeat(41000)}尾端</inner></unknown><think>排除块</think>`;
  let request;
  const make = (id, entryLabel, primaryKeys, content, extra = {}) => ({ id: `worldbook:${id}`, kind: 'worldbook', world: '角色设定', uid: id,
    permissionKey: `角色设定::${id}`, label: `角色设定 · ${entryLabel}`, entryLabel, primaryKeys, secondaryKeys: [], content, hostEnabled: true, ...extra });
  const candidates = [
    make('title', '人物1的人物小传', [], '<profile>标题命中</profile>'),
    make('primary', '无归属小标题', ['人物1'], '<setting>主键命中</setting>'),
    make('secondary', '另一个条目', [], '<setting>次键命中</setting>', { secondaryKeys: ['人物1别名'] }),
    make('other', '人物10的资料', ['人物10'], '不应进入'),
    make('dynamic', '人物1条件资料', ['人物1'], '<% if (condition) { %>条件资料不可直接当成事实<% } %>'),
    make('disabled', '人物1禁用资料', ['人物1'], '禁用不应进入', { hostEnabled: false, availability: 'disabled' }),
    { ...make('excluded', '人物1排除书资料', ['人物1'], '排除书不应进入'), world: '排除书', permissionKey: '排除书::excluded' },
    make('long', '人物1完整资料', ['人物1'], raw),
  ];
  let scanOptions, prefilteredBooks;
  const h = harness({ permissionSettings: { sourceWorldInfoExcludedBooks: ['排除书'] }, sourceCandidates: candidates,
    scanner: async (_context, options) => { scanOptions = options; prefilteredBooks = options.filterBookNames(['角色设定', '排除书']); return { entries: [] }; },
    generate: async options => { request = JSON.parse(options.taskMessages[0].content); return { jsonData: { profiles: [{ personKey: 'person-1', name: '完整资料' }] } }; } });
  const id = h.peopleEntities[0].id;
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([id]); await h.runtime.regenerateProfile(id);
  assert.equal(scanOptions.complete, true); assert.equal(scanOptions.strict, true); assert.deepEqual(prefilteredBooks, ['角色设定']);
  const fragments = request.people[0].sourceFragments.filter(item => item.kind === 'allowedWorldInfo');
  const content = fragments.map(item => item.content).join('');
  assert.equal(request.allowedWorldInfo.length, 0);
  const expected = `<profile>标题命中</profile><setting>主键命中</setting><setting>次键命中</setting><% if (condition) { %>条件资料不可直接当成事实<% } %><unknown>开头<inner>${'设'.repeat(41000)}尾端</inner></unknown><think>排除块</think>`;
  assert.equal(content, expected);
  assert.doesNotMatch(content, /禁用不应进入|排除书不应进入|不应进入/u);
  assert.equal(h.runtime.getState().lastGenerationReport.worldInfoMatched, 5);
  assert.equal('worldInfoSkippedDynamic' in h.runtime.getState().lastGenerationReport, false);
});

test('缺档整理完整读取并逐字符发送许可世界书，不按人物关键词缩小原有范围', async () => {
  const raw = `  <mvu>保留 {{user}} 与 {{char}} </mvu>\n<% if (truthy) { %>条件原文<% } %>${'尾'.repeat(40005)}  `;
  const requests = []; let scanOptions;
  const h = harness({ many: false,
    scanner: async (_context, options) => { scanOptions = options; return { entries: [{ content: raw }] }; },
    sourceCandidates: [{ id: 'worldbook:unrelated', kind: 'worldbook', world: '无关设定书', uid: 'one', label: '与人物无关键词关系', content: raw }],
    generate: async options => { requests.push(JSON.parse(options.taskMessages[0].content)); return { jsonData: { profiles: [{ personKey: 'person-1', name: '人物1' }] } }; },
  });
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([h.peopleEntities[0].id]); await h.runtime.generateMissingProfiles();
  const selected = requests.flatMap(request => request.people[0].sourceFragments.filter(item => item.kind === 'allowedWorldInfo')).map(item => item.content).join('');
  assert.equal(selected.length, raw.length);
  assert.equal(createHash('sha256').update(selected).digest('hex'), createHash('sha256').update(raw).digest('hex'));
  assert.equal(scanOptions.complete, true); assert.equal(scanOptions.strict, true);
  assert.match(requests[0].people[0].sourceFragments.find(item => item.kind === 'allowedWorldInfo').label, /无关设定书/u,
    '缺档入口继续发送许可范围内的全部条目，不按人物关键词筛选');
  assert.equal(h.runtime.getState().lastGenerationReport.worldInfoMatched, 1);
});

test('完整重整世界书读取不完整时零写档，且相关关键词避免单字与相邻数字误命中', async () => {
  const selected = selectRelevantWorldInfoCandidates([
    { entryLabel: '人物1个人设' }, { entryLabel: '人物10个人设' }, { entryLabel: '人物性格' },
  ], [{ currentName: '人物1', aliases: ['甲'] }]);
  assert.deepEqual(selected.map(item => item.entryLabel), ['人物1个人设']);
  const h = harness({ scanner: async () => { throw Object.assign(new Error('不完整'), { code: 'QQJ_PEOPLE_WORLDBOOK_INCOMPLETE' }); },
    generate: async () => assert.fail('世界书读取失败不得调用模型') });
  const id = h.peopleEntities[0].id;
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([id]);
  await h.runtime.saveProfile(id, { name: '原档' }, { manualFields: [] });
  const before = structuredClone(h.runtime.getState().profilesByEntityId[id]);
  const putsBefore = h.db.calls.filter(call => call[0] === 'put').length;
  await assert.rejects(h.runtime.regenerateProfile(id), /读取不完整/);
  assert.deepEqual(h.runtime.getState().profilesByEntityId[id], before);
  assert.equal(h.db.calls.filter(call => call[0] === 'put').length, putsBefore);
});

test('头像独立保存于当前聊天，不把未建档人物误算为已整理且文字保存不会覆盖头像', async () => {
  const h = harness(); await h.runtime.refresh(); const id = h.peopleEntities[0].id; await h.runtime.setSelectedEntityIds([id]);
  const avatar = 'data:image/png;base64,AAAA'; await h.runtime.saveAvatar(id, avatar);
  let state = h.runtime.getState(); assert.equal(state.people.find(item => item.entityId === id).avatar, avatar); assert.equal(state.profilesByEntityId[id], undefined); assert.equal(state.unprofiledSelectedCount, 1);
  await h.runtime.saveProfile(id, { name: '人工名', notes: '文字', aliases: '', background: '', appearance: '', personality: '' }, { manualFields: ['name', 'notes'] });
  assert.equal(h.runtime.getState().avatarsByEntityId[id], avatar);
  h.runtime.invalidate(); await h.runtime.refresh(); assert.equal(h.runtime.getState().avatarsByEntityId[id], avatar);
  await h.runtime.saveAvatar(id, null); assert.equal(h.runtime.getState().avatarsByEntityId[id], undefined);
});

test('千人整理沿用现行来源边界，忽略退役逐条设置并守住宿主禁用与整本排除', async () => {
  let request;
  const worldbook = (id, world, content, hostEnabled = true) => ({
    id: `worldbook:${id}`, kind: 'worldbook', world, uid: id, permissionKey: `${world}::${id}`,
    label: `${world}条目`, content, hostEnabled, availability: hostEnabled ? 'enabled' : 'disabled',
  });
  const candidates = [
    worldbook('normal', '保留书', '普通启用'),
    worldbook('legacy-disabled', '保留书', '旧 disabled 仍应进入'),
    worldbook('legacy-false', '保留书', '旧 false 仍应进入'),
    worldbook('host-disabled', '保留书', '宿主禁用不得进入', false),
    worldbook('excluded', '排除书', '整本排除不得进入'),
  ];
  const permissionSettings = {
    sourceWorldInfoDisabledByChat: { [CHAT_A]: ['保留书::legacy-disabled'] },
    sourceWorldInfoOverridesByChat: { [CHAT_A]: {
      '保留书::legacy-false': false,
      '保留书::host-disabled': true,
      '排除书::excluded': true,
    } },
    sourceWorldInfoExcludedBooks: ['排除书'],
  };
  const h = harness({
    permissionSettings,
    sourceCandidates: candidates,
    generate: async options => {
      request = JSON.parse(options.taskMessages[0].content);
      return { jsonData: { profiles: [{ personKey: 'person-1', name: '人物1', aliases: [], background: '', appearance: '', personality: '', notes: '' }] } };
    },
  });
  await h.runtime.refresh();
  await h.runtime.setSelectedEntityIds([h.peopleEntities[0].id]);
  await h.runtime.generateMissingProfiles();
  assert.deepEqual(request.allowedWorldInfo.map(item => item.content), ['普通启用', '旧 disabled 仍应进入', '旧 false 仍应进入']);
  assert.deepEqual(h.sourceTrace.map(item => item[0]), ['scan', 'candidates', 'filter']);
});

test('坏回复不串人物且可重试，API 失败保留选择', async () => {
  let mode = 'bad';
  const h = harness({ generate: async () => {
    if (mode === 'api') throw new Error('上游失败');
    if (mode === 'bad') return { jsonData: { profiles: [{ personKey: 'unknown', name: '串档' }] } };
    return { jsonData: { profiles: [{ personKey: 'person-1', name: '正确', aliases: [], background: '', appearance: '', personality: '', notes: '' }] } };
  } });
  await h.runtime.refresh(); const id = h.peopleEntities[0].id; await h.runtime.setSelectedEntityIds([id]);
  await assert.rejects(h.runtime.generateMissingProfiles(), error => error.code === 'QQJ_PEOPLE_GENERATION_BINDING_INVALID');
  assert.equal(h.runtime.getState().profilesByEntityId[id], undefined); assert.deepEqual(h.runtime.getState().selectedEntityIds, [id]);
  mode = 'api'; await assert.rejects(h.runtime.generateMissingProfiles(), /上游失败/); assert.deepEqual(h.runtime.getState().selectedEntityIds, [id]);
  mode = 'ok'; await h.runtime.generateMissingProfiles(); assert.equal(h.runtime.getState().profilesByEntityId[id].name, '正确');
});

test('生成在途时人工保存优先，结束重读 CAS 不覆盖人工资料', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ generate: async () => { await gate; return { jsonData: { profiles: [{ personKey: 'person-1', name: '模型名', aliases: [], background: '模型背景', appearance: '', personality: '', notes: '' }] } }; } });
  await h.runtime.refresh(); const id = h.peopleEntities[0].id; await h.runtime.setSelectedEntityIds([id]);
  const pending = h.runtime.generateMissingProfiles();
  await new Promise(resolve => setImmediate(resolve));
  await h.runtime.saveProfile(id, { name: '人工名', aliases: '', background: '', appearance: '', personality: '', notes: '人工保存' });
  release(); await pending;
  const profile = h.runtime.getState().profilesByEntityId[id]; assert.equal(profile.name, '人工名'); assert.equal(profile.source, 'manual'); assert.equal(profile.notes, '人工保存');
  assert.deepEqual(h.runtime.getState().lastGenerationReport, { requested: 1, saved: 0, worldInfoMatched: 1, missing: 0, conflicts: 0, invalid: 0, unknown: 0, skipped: 1 }, 'CAS 重读后跳过的人工资料不能算作本次保存');
});

test('重新整理在途时新增的人工修改与人工清空仍以最新 CAS 档案为准', async () => {
  let mode = 'initial', release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ generate: async () => {
    if (mode === 'initial') return { jsonData: { profiles: [{ personKey: 'person-1', name: '旧名', background: '旧背景', notes: '旧补充' }] } };
    await gate;
    return { jsonData: { profiles: [{ personKey: 'person-1', name: '模型新名', background: '模型新背景', notes: '模型新补充', likes: '雨天' }] } };
  } });
  await h.runtime.refresh(); const id = h.peopleEntities[0].id; await h.runtime.setSelectedEntityIds([id]); await h.runtime.generateMissingProfiles();
  mode = 'regenerate';
  const pending = h.runtime.regenerateProfile(id); await new Promise(resolve => setImmediate(resolve));
  await h.runtime.saveProfile(id, { background: '人工新背景', notes: '' }, { manualFields: ['background', 'notes'] });
  release(); await pending;
  const profile = h.runtime.getState().profilesByEntityId[id];
  assert.equal(profile.name, '模型新名'); assert.equal(profile.likes, '雨天');
  assert.equal(profile.background, '人工新背景'); assert.equal(profile.notes, '');
  assert.deepEqual(profile.manualFields, ['background', 'notes']);
});

test('单人重整没有有效字段时不清空旧AI档案', async () => {
  let mode = 'initial';
  const h = harness({ generate: async () => ({ jsonData: { profiles: [mode === 'initial'
    ? { personKey: 'person-1', name: '旧AI姓名', background: '旧AI背景' }
    : { personKey: 'person-1' }] } }) });
  const id = h.peopleEntities[0].id; await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([id]);
  await h.runtime.generateMissingProfiles(); const before = structuredClone(h.runtime.getState().profilesByEntityId[id]);
  mode = 'empty'; await h.runtime.regenerateProfile(id);
  assert.deepEqual(h.runtime.getState().profilesByEntityId[id], before);
});

test('删除目标后到达的生成人物结果不复活档案', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ generate: async () => { await gate; return { jsonData: { profiles: [{ personKey: 'person-1', name: '迟到档案' }] } }; } });
  const id = h.peopleEntities[0].id; await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([id]);
  const pending = h.runtime.generateMissingProfiles(); await new Promise(resolve => setImmediate(resolve));
  const key = `chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`;
  const latest = structuredClone(h.db.records.get(key)); latest.revision += 1; latest.data.selectedEntityIds = [];
  latest.data.deletedEntityIds = [id]; delete latest.data.profilesByEntityId[id]; h.db.records.set(key, latest);
  release(); await pending;
  assert.equal(h.db.records.get(key).data.profilesByEntityId[id], undefined);
  assert.deepEqual(h.runtime.getState().deletedEntityIds, [id]);
});

test('切聊天会取消在途整理，迟到结果不写旧聊天也不串入新聊天', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ generate: async () => { await gate; return { jsonData: { profiles: [{ personKey: 'person-1', name: '迟到', aliases: [], background: '', appearance: '', personality: '', notes: '' }] } }; } });
  await h.runtime.refresh(); const id = h.peopleEntities[0].id; await h.runtime.setSelectedEntityIds([id]);
  const pending = h.runtime.generateMissingProfiles(); await new Promise(resolve => setImmediate(resolve));
  h.setIdentity({ ...h.identity, chatId: CHAT_B, hostChatId: 'host-b' }); h.runtime.invalidate(); release();
  await assert.rejects(pending, error => ['QQJ_PEOPLE_STALE', 'AbortError'].includes(error.code || error.name));
  assert.equal(h.db.records.get(`chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`).data.profilesByEntityId[id], undefined);
  assert.equal(h.db.records.has(`chat-${CHAT_B}/${PEOPLE_WORKSPACE_RECORD_ID}`), false);
});

test('外部页面改过同一选择或同一人物资料时拒绝静默覆盖', async () => {
  const h = harness(); await h.runtime.refresh(); const [first, second] = h.peopleEntities;
  await h.runtime.setSelectedEntityIds([first.id]);
  const key = `chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`;
  let envelope = h.db.records.get(key); envelope = structuredClone(envelope); envelope.revision += 1; envelope.data.selectedEntityIds = [second.id]; envelope.data.updatedAt = '2026-09-06T00:00:01.000Z'; h.db.records.set(key, envelope);
  await assert.rejects(h.runtime.setSelectedEntityIds([first.id, second.id]), error => error.code === 'QQJ_PEOPLE_SELECTION_CONFLICT');
  h.runtime.invalidate(); await h.runtime.refresh();
  await h.runtime.saveProfile(second.id, { name: '原资料', aliases: '', background: '', appearance: '', personality: '', notes: '' });
  envelope = structuredClone(h.db.records.get(key)); envelope.revision += 1; envelope.data.profilesByEntityId[second.id].name = '其他页面资料'; envelope.data.profilesByEntityId[second.id].updatedAt = '2026-09-06T00:00:02.000Z'; envelope.data.updatedAt = '2026-09-06T00:00:02.000Z'; h.db.records.set(key, envelope);
  await assert.rejects(h.runtime.saveProfile(second.id, { name: '本页迟到资料', aliases: '', background: '', appearance: '', personality: '', notes: '' }), error => error.code === 'QQJ_PEOPLE_PROFILE_CONFLICT');
  assert.equal(h.db.records.get(key).data.profilesByEntityId[second.id].name, '其他页面资料');
});

test('切聊天期间迟到的关注保存仍被身份守卫拦截', async () => {
  let releasePut, markPut;
  const putGate = new Promise(resolve => { releasePut = resolve; });
  const putStarted = new Promise(resolve => { markPut = resolve; });
  const h = harness(); await h.runtime.refresh({ refreshMemory: false });
  h.db.hooks.beforePut = async () => { markPut(); await putGate; };
  const pending = h.runtime.setSelectedEntityIds([h.peopleEntities[0].id]);
  await putStarted;
  h.setIdentity({ ...h.identity, chatId: CHAT_B, hostChatId: 'host-b' }); h.runtime.invalidate(); releasePut();
  await assert.rejects(pending, error => ['AbortError', 'QQJ_PEOPLE_STALE'].includes(error.name === 'AbortError' ? error.name : error.code));
  assert.equal(h.db.records.has(`chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`), false);
  assert.equal(h.db.records.has(`chat-${CHAT_B}/${PEOPLE_WORKSPACE_RECORD_ID}`), false);
});

test('每十个稳定AI楼触发一次共享原文粗扫，摘要不参与筛楼', async () => {
  const requests = [];
  const h = harness({ generate: async options => { const request = JSON.parse(options.taskMessages[0].content); requests.push(request); return { jsonData: { profiles: request.people.map(person => ({ personKey: person.personKey, appearance: '有明确新事实' })) } }; } });
  await h.runtime.refresh({ refreshMemory: false });
  const [first, second] = h.peopleEntities;
  await h.runtime.setSelectedEntityIds([first.id, second.id]);
  await h.markProfileInitialized([first.id, second.id]); h.setMainGenerationActive(false);
  for (const target of [first, second]) await h.runtime.saveProfile(target.id, { name: target.displayName, aliases: '', background: '既有基础资料', appearance: '', personality: '', notes: '' });
  const floors = Array.from({ length: 9 }, (_, index) => ({ id: ids[index], assistantSeq: index + 1, content: { canonicalContent: `第${index + 1}楼正文外貌` } }));
  h.setReachable({ ...h.reachable, floors, floorMemories: [] });
  h.notifyFoundation(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.length, 0, '前九个稳定楼不请求');
  h.setReachable({ ...h.reachable, floors: [...floors, { id: ids[9], assistantSeq: 10, content: { canonicalContent: '第十楼正文，摘要失败也有外貌' } }], floorMemories: [] });
  h.notifyFoundation(); h.notifyFoundation();
  await waitFor(() => requests.length === 1 && h.runtime.getState().active === null);
  assert.equal(requests.length, 1); assert.equal(requests[0].people.length, 2, '多个选中人物共用一次请求');
  assert.equal(requests[0].recentFloors.length, 10);
  assert.match(JSON.stringify(requests[0].recentFloors), /第十楼正文，摘要失败也有外貌/);
  assert.match(JSON.stringify(requests[0].recentFloors), /第1楼正文外貌/);
  assert.equal(Object.hasOwn(requests[0], 'summaryUpdates'), false);
  assert.equal(Object.hasOwn(requests[0], 'allowedWorldInfo'), false);
});

test('新增选择只为真实空档自动首次整理，并排除宿主关闭世界书条目', async () => {
  const requests = [];
  const h = harness({ generate: async options => {
    const request = JSON.parse(options.taskMessages[0].content); requests.push(request);
    return { jsonData: { profiles: [{ personKey: 'person-1' }] } };
  }, sourceCandidates: [
    { id: 'worldbook:open', kind: 'worldbook', world: '人物设定', label: '人物1经历', primaryKeys: ['人物1'], hostEnabled: true, availability: 'enabled', content: '允许的设定片段' },
    { id: 'worldbook:closed', kind: 'worldbook', world: '人物设定', label: '人物1隐藏', primaryKeys: ['人物1'], hostEnabled: false, availability: 'disabled', content: '宿主已关闭的秘密' },
  ], permissionSettings: {} });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([target.id]); h.setMainGenerationActive(false);
  await waitFor(() => Boolean(h.runtime.getState().profileMaterialProgressByEntityId[target.id]) && h.runtime.getState().active === null);
  assert.equal(requests.length, 1); assert.match(JSON.stringify(requests[0]), /允许的设定片段/);
  assert.doesNotMatch(JSON.stringify(requests[0]), /宿主已关闭的秘密/);
  assert.equal(h.runtime.getState().profilesByEntityId[target.id], undefined, '合法空结果只留下完成见证，不创建空壳档案');
  await h.runtime.setSelectedEntityIds([]); await h.runtime.setSelectedEntityIds([target.id]);
  h.runtime.invalidate(); await h.runtime.refresh({ refreshMemory: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.length, 1, '取消再选与普通重载不重复首次整理');
});

test('新增选择遇到非空档案时不自动首次整理，即使没有完成见证', async () => {
  let calls = 0;
  const h = harness({ generate: async () => { calls++; return { jsonData: { profiles: [{ personKey: 'person-1', notes: '不应覆盖' }] } }; } });
  const [alreadyNonempty, filledWhileQueued] = h.peopleEntities; await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.saveProfile(alreadyNonempty.id, { notes: '已有基础资料' });
  h.setMainGenerationActive(true); await h.runtime.setSelectedEntityIds([alreadyNonempty.id, filledWhileQueued.id]);
  await h.runtime.saveProfile(filledWhileQueued.id, { notes: '排队期间人工建档' });
  h.setMainGenerationActive(false); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 0);
  assert.equal(h.runtime.getState().profilesByEntityId[alreadyNonempty.id].notes, '已有基础资料');
  assert.equal(h.runtime.getState().profilesByEntityId[filledWhileQueued.id].notes, '排队期间人工建档');
  assert.equal(h.runtime.getState().profileMaterialProgressByEntityId[alreadyNonempty.id], undefined);
  assert.equal(h.runtime.getState().profileMaterialProgressByEntityId[filledWhileQueued.id], undefined);
});

test('首次自动请求等待期间人工建成非空档时，跳过迟到 patch 和完成见证', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const h = harness({ generate: async () => {
    calls++; await gate;
    return { jsonData: { profiles: [{ personKey: 'person-1', notes: '迟到自动资料' }] } };
  } });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([target.id]); h.setMainGenerationActive(false);
  await waitFor(() => h.runtime.getState().active?.kind === 'generating');
  await h.runtime.saveProfile(target.id, { notes: '请求期间人工建档' }, { manualFields: ['notes'] });
  release(); await waitFor(() => h.runtime.getState().active === null);
  assert.equal(calls, 1);
  assert.equal(h.runtime.getState().profilesByEntityId[target.id].notes, '请求期间人工建档');
  assert.equal(h.runtime.getState().profileMaterialProgressByEntityId[target.id], undefined);
});

test('十楼粗扫跳过无档、全空和仅姓名别名头像档，空档窗口不重试也不写入', async () => {
  let calls = 0;
  const h = harness({ generate: async () => { calls++; return { jsonData: { profiles: [{ personKey: 'person-1', notes: '不应收到请求' }] } }; } });
  const [missing, empty, avatarOnly] = h.peopleEntities; await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([missing.id, empty.id, avatarOnly.id]);
  await h.markProfileInitialized(missing.id, { profileExists: false });
  await h.markProfileInitialized(empty.id, { material: false });
  await h.markProfileInitialized(avatarOnly.id, { material: false });
  await h.runtime.saveAvatar(avatarOnly.id, 'data:image/png;base64,AAAA');
  h.setMainGenerationActive(false);
  const floors = Array.from({ length: 10 }, (_, index) => ({ id: ids[index], assistantSeq: index + 1, content: { canonicalContent: `稳定原文${index}` } }));
  h.setReachable({ ...h.reachable, floors, floorMemories: [] });
  const putsBefore = h.db.calls.filter(call => call[0] === 'put').length;
  h.notifyFoundation(); h.notifyFoundation(); await new Promise(resolve => setTimeout(resolve, 25));
  h.notifyFoundation(); h.notifyFoundation(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 0, '无基础资料目标不得发起粗扫');
  assert.equal(h.runtime.getState().profilesByEntityId[missing.id], undefined, '只有完成进度但无档案仍为空档');
  for (const person of [empty, avatarOnly]) {
    const profile = h.runtime.getState().profilesByEntityId[person.id];
    assert.ok(profile.name.trim() && profile.aliases.trim());
    assert.ok(PEOPLE_PROFILE_FIELDS.slice(2).every(field => !profile[field].trim()), '姓名和别名不能代替基础资料');
  }
  assert.ok(h.runtime.getState().avatarsByEntityId[avatarOnly.id]);
  assert.equal(h.db.calls.filter(call => call[0] === 'put').length, putsBefore, '空档粗扫不做存档写入');
});

test('十楼粗扫混合池只发送有实际基础资料的人物', async () => {
  let request, calls = 0;
  const h = harness({ generate: async options => {
    calls++; request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { profiles: [{ personKey: 'person-1', notes: '补充现有资料' }] } };
  } });
  const [hasMaterial, identityOnly, missing] = h.peopleEntities; await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([hasMaterial.id, identityOnly.id, missing.id]);
  await h.markProfileInitialized(hasMaterial.id);
  await h.markProfileInitialized(identityOnly.id, { material: false });
  await h.markProfileInitialized(missing.id, { profileExists: false });
  h.setMainGenerationActive(false);
  h.setReachable({ ...h.reachable, floors: Array.from({ length: 10 }, (_, index) => ({
    id: ids[index], assistantSeq: index + 1, content: { canonicalContent: `稳定原文${index}` },
  })), floorMemories: [] });
  h.notifyFoundation(); h.notifyFoundation(); await waitFor(() => calls === 1 && h.runtime.getState().active === null);
  assert.equal(request.people.length, 1);
  assert.equal(request.people[0].currentName, hasMaterial.displayName);
  assert.equal(calls, 1);
  assert.equal(h.runtime.getState().profilesByEntityId[identityOnly.id].notes, '');
  assert.equal(h.runtime.getState().profilesByEntityId[missing.id], undefined);
  assert.equal(h.runtime.getState().profilesByEntityId[hasMaterial.id].notes, '补充现有资料');
});

test('粗扫等待期间基础资料被人工清空时，迟到回复不得重新建档', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const h = harness({ generate: async () => {
    calls++; await gate;
    return { jsonData: { profiles: [{ personKey: 'person-1', background: '迟到补建' }] } };
  } });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([target.id]); await h.markProfileInitialized(target.id); h.setMainGenerationActive(false);
  h.setReachable({ ...h.reachable, floors: Array.from({ length: 10 }, (_, index) => ({
    id: ids[index], assistantSeq: index + 1, content: { canonicalContent: `稳定原文${index}` },
  })), floorMemories: [] });
  h.notifyFoundation(); h.notifyFoundation(); await waitFor(() => h.runtime.getState().active?.kind === 'generating');
  await h.runtime.saveProfile(target.id, { notes: '' }, { manualFields: ['notes'] });
  release(); await waitFor(() => h.runtime.getState().active === null);
  const profile = h.runtime.getState().profilesByEntityId[target.id];
  assert.equal(calls, 1); assert.equal(profile.notes, ''); assert.equal(profile.background, '');
  assert.equal(h.runtime.getState().lastGenerationReport.saved, 0);
});

test('首次自动和手动完整整理仍能从空档建立人物资料', async () => {
  const automatic = harness({ generate: async () => ({ jsonData: { profiles: [{ personKey: 'person-1', notes: '首次完整整理' }] } }) });
  const target = automatic.peopleEntities[0]; await automatic.runtime.refresh({ refreshMemory: false });
  await automatic.runtime.setSelectedEntityIds([target.id]); automatic.setMainGenerationActive(false);
  await waitFor(() => automatic.runtime.getState().active === null && Boolean(automatic.runtime.getState().profileMaterialProgressByEntityId[target.id]));
  assert.equal(automatic.runtime.getState().profilesByEntityId[target.id].notes, '首次完整整理');

  const manual = harness({ generate: async () => ({ jsonData: { profiles: [{ personKey: 'person-1', notes: '手动完整整理' }] } }) });
  const manualTarget = manual.peopleEntities[0]; await manual.runtime.refresh({ refreshMemory: false });
  await manual.runtime.setSelectedEntityIds([manualTarget.id]); await manual.markProfileInitialized(manualTarget.id, { material: false });
  await manual.runtime.regenerateProfile(manualTarget.id);
  assert.equal(manual.runtime.getState().profilesByEntityId[manualTarget.id].notes, '手动完整整理');
});

test('多人首次整理排队串行执行，并在 memoryWorkBusy 解除时接续', async () => {
  let releaseFirst, active = 0, maximumActive = 0;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const requests = [];
  const h = harness({ generate: async options => {
    active++; maximumActive = Math.max(maximumActive, active);
    const request = JSON.parse(options.taskMessages[0].content); requests.push(request);
    if (requests.length === 1) await firstGate;
    active--;
    return { jsonData: { profiles: [{ personKey: request.people[0].personKey, notes: '首档完成' }] } };
  } });
  const [first, second] = h.peopleEntities;
  h.setMemoryState({ memoryWorkBusy: true }, false); await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([first.id, second.id]); h.setMainGenerationActive(false);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(requests.length, 0, '记忆整理忙时保持待办');
  h.setMemoryState({ memoryWorkBusy: false });
  await waitFor(() => requests.length === 1);
  assert.equal(requests[0].people.length, 1);
  releaseFirst();
  await waitFor(() => requests.length === 2 && h.runtime.getState().active === null);
  assert.equal(maximumActive, 1, '多个新人物逐个调用模型');
  assert.deepEqual(new Set(requests.map(request => request.people[0].currentName)), new Set([first.displayName, second.displayName]));
  assert.ok(h.runtime.getState().profileMaterialProgressByEntityId[first.id]);
  assert.ok(h.runtime.getState().profileMaterialProgressByEntityId[second.id]);
});

test('旧聊天已有选择但没有首次整理见证时，刷新与空闲都不补扫', async () => {
  let calls = 0;
  const h = harness({ generate: async () => { calls++; return { jsonData: { profiles: [{ personKey: 'person-1' }] } }; } });
  const target = h.peopleEntities[0]; await h.seedSelectedWithoutProgress(target.id); h.setMainGenerationActive(false);
  await new Promise(resolve => setTimeout(resolve, 25));
  await h.runtime.setSelectedEntityIds([target.id]); await h.runtime.refresh({ refreshMemory: false });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 0, '仅新增选择触发首次自动整理，旧选择不后台补扫');
});

test('首次整理期间正文增长仍保存本次成功见证，取消再选不重复请求', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const h = harness({ generate: async options => {
    calls++; await gate;
    return { jsonData: { profiles: [{ personKey: 'person-1', background: '首次整理结果' }] } };
  } });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([target.id]); h.setMainGenerationActive(false);
  await waitFor(() => h.runtime.getState().active?.kind === 'generating');
  h.setReachable({ ...h.reachable, floors: [{ id: ids[10], assistantSeq: 11, content: { canonicalContent: '首次请求开始后新增正文' } }] });
  release(); await waitFor(() => h.runtime.getState().active === null && Boolean(h.runtime.getState().profileMaterialProgressByEntityId[target.id]));
  await h.runtime.setSelectedEntityIds([]); await h.runtime.setSelectedEntityIds([target.id]);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 1); assert.equal(h.runtime.getState().profilesByEntityId[target.id].background, '首次整理结果');
});

test('取消选择会阻止首次整理迟到结果与完成进度落档', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const h = harness({ generate: async () => { calls++; await gate; return { jsonData: { profiles: [{ personKey: 'person-1', name: '迟到结果' }] } }; } });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([target.id]); h.setMainGenerationActive(false);
  await waitFor(() => h.runtime.getState().active?.kind === 'generating');
  await h.runtime.setSelectedEntityIds([]); release(); await waitFor(() => h.runtime.getState().active === null);
  assert.equal(calls, 1); assert.equal(h.runtime.getState().profilesByEntityId[target.id], undefined);
  assert.equal(h.runtime.getState().profileMaterialProgressByEntityId[target.id], undefined);
});

test('首次整理切聊天或关闭时丢弃迟到结果与完成进度', async () => {
  for (const lifecycle of ['chat-change', 'disable']) {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const h = harness({ generate: async () => { await gate; return { jsonData: { profiles: [{ personKey: 'person-1', name: '迟到资料' }] } }; } });
    const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false });
    await h.runtime.setSelectedEntityIds([target.id]); h.setMainGenerationActive(false);
    await waitFor(() => h.runtime.getState().active?.kind === 'generating');
    if (lifecycle === 'chat-change') {
      h.setIdentity({ ...h.identity, chatId: CHAT_B, hostChatId: 'host-b' }); h.runtime.invalidate();
    } else await h.runtime.setEnabled(false);
    release(); await new Promise(resolve => setImmediate(resolve));
    const record = h.db.records.get(`chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`);
    assert.equal(record.data.profilesByEntityId[target.id], undefined, `${lifecycle} 后不保存迟到资料`);
    assert.equal(record.data.profileMaterialProgressByEntityId[target.id], undefined, `${lifecycle} 后不记录完成见证`);
  }
});

test('排队中的首次整理随合并或删除取消', async () => {
  const requests = [];
  const h = harness({ generate: async options => { requests.push(options); return { jsonData: { profiles: [{ personKey: 'person-1', name: '不应保存' }] } }; } });
  await h.runtime.refresh({ refreshMemory: false }); const [source, target, removed] = h.peopleEntities;
  await h.runtime.setSelectedEntityIds([source.id, target.id, removed.id]);
  await h.runtime.mergePeople(source.id, target.id, 'target');
  await h.runtime.deletePerson(removed.id);
  h.setMainGenerationActive(false); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests.length, 0, '合并双方与删除人物的待办都被清除');
  assert.equal(h.runtime.getState().profilesByEntityId[target.id], undefined);
});

test('首次整理失败只提示一次，用户仍可手动重整恢复', async () => {
  let calls = 0;
  const h = harness({ generate: async () => {
    calls++;
    if (calls === 1) throw new Error('模拟首次整理失败');
    return { jsonData: { profiles: [{ personKey: 'person-1', background: '手动恢复成功' }] } };
  } });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds([target.id]); h.setMainGenerationActive(false);
  await waitFor(() => calls === 1 && h.runtime.getState().active === null);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1); assert.match(h.runtime.getState().lastError?.message ?? '', /模拟首次整理失败/);
  await h.runtime.regenerateProfile(target.id);
  assert.equal(calls, 2); assert.equal(h.runtime.getState().profilesByEntityId[target.id].background, '手动恢复成功');
  assert.ok(h.runtime.getState().profileMaterialProgressByEntityId[target.id]);
});

test('轻量原文预算优先保留最新楼，单楼超限时明确标记截取', async () => {
  let request;
  const h = harness({ generate: async options => { request = JSON.parse(options.taskMessages[0].content); return { jsonData: { profiles: [{ personKey: 'person-1' }] } }; } });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([target.id]);
  await h.markProfileInitialized(target.id); h.setMainGenerationActive(false);
  const before = structuredClone(h.runtime.getState().profilesByEntityId[target.id]);
  const floors = Array.from({ length: 10 }, (_, index) => ({ id: ids[index], assistantSeq: index + 1, content: { canonicalContent: `${index === 9 ? '最新楼' : '旧楼'}${'甲'.repeat(index === 9 ? 25000 : 100)}` } }));
  h.setReachable({ ...h.reachable, floors, floorMemories: [] }); h.notifyFoundation(); h.notifyFoundation();
  await waitFor(() => Boolean(request) && h.runtime.getState().active === null, () => JSON.stringify(h.runtime.getState()));
  assert.equal(request.recentFloors.length, 1); assert.equal(request.recentFloors[0].sourceFloor, 10);
  assert.match(request.recentFloors[0].excerpt, /后文省略/); assert.ok(request.recentFloors[0].content.length <= 19000);
});

test('自动原文请求失败不因同一通知重试，新增十楼后再尝试', async () => {
  let calls = 0;
  const h = harness({ generate: async () => { calls++; if (calls === 1) throw new Error('模拟失败'); return { jsonData: { profiles: [{ personKey: 'person-1' }] } }; } });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([target.id]);
  await h.markProfileInitialized(target.id); h.setMainGenerationActive(false);
  const publish = count => { h.setReachable({ ...h.reachable, floors: Array.from({ length: count }, (_, index) => ({ id: ids[index], assistantSeq: index + 1, content: { canonicalContent: `稳定原文${index}` } })), floorMemories: [] }); h.notifyFoundation(); h.notifyFoundation(); };
  publish(10); await waitFor(() => calls === 1 && h.runtime.getState().active === null);
  h.notifyFoundation(); h.notifyFoundation(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1);
  publish(20); await waitFor(() => calls === 2 && h.runtime.getState().active === null);
});

test('粗扫请求期间原文变化时丢弃迟到结果', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ generate: async () => { await gate; return { jsonData: { profiles: [{ personKey: 'person-1', name: '基于旧正文的迟到名' }] } }; } });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([target.id]);
  await h.markProfileInitialized(target.id); h.setMainGenerationActive(false);
  const before = structuredClone(h.runtime.getState().profilesByEntityId[target.id]);
  const floors = Array.from({ length: 10 }, (_, index) => ({ id: ids[index], assistantSeq: index + 1, content: { canonicalContent: `稳定原文${index}` } }));
  h.setReachable({ ...h.reachable, floors, floorMemories: [] }); h.notifyFoundation();
  await waitFor(() => h.runtime.getState().active?.kind === 'generating');
  h.setReachable({ ...h.reachable, floors: floors.map((floor, index) => index === 9
    ? { ...floor, content: { canonicalContent: '请求期间被用户修改的新正文' } } : floor), floorMemories: [] });
  release(); await waitFor(() => h.runtime.getState().active === null);
  assert.deepEqual(h.runtime.getState().profilesByEntityId[target.id], before, '资料档案保持原样，迟到姓名未写入');
});

test('未选择人物不自动建档，已选人物的人工填写与人工清空优先', async () => {
  let calls = 0;
  const h = harness({ generate: async options => {
    calls++;
    const request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { profiles: request.people.map(person => ({ personKey: person.personKey, name: `模型名${calls}`, notes: `模型笔记${calls}` })) } };
  } });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false });
  const publish = count => { h.setReachable({ ...h.reachable, floors: Array.from({ length: count }, (_, index) => ({ id: ids[index], assistantSeq: index + 1, content: { canonicalContent: `稳定原文${index}` } })), floorMemories: [] }); h.notifyFoundation(); };
  publish(10); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 0, '未选人物不请求');
  await h.runtime.saveProfile(target.id, { background: '稳定基础资料' });
  await h.runtime.saveProfile(target.id, { name: '旧AI名', notes: '人工笔记' }, { manualFields: ['notes'] });
  await h.runtime.setSelectedEntityIds([target.id]); h.setMainGenerationActive(false);
  publish(20); await waitFor(() => calls === 1 && h.runtime.getState().active === null);
  let profile = h.runtime.getState().profilesByEntityId[target.id];
  assert.equal(profile.name, '模型名1'); assert.equal(profile.notes, '人工笔记'); assert.equal(profile.background, '稳定基础资料'); assert.deepEqual(profile.manualFields, ['background', 'notes']);
  await h.runtime.saveProfile(target.id, { notes: '' }, { manualFields: ['notes'] });
  publish(30); await waitFor(() => calls === 2 && h.runtime.getState().active === null);
  profile = h.runtime.getState().profilesByEntityId[target.id];
  assert.equal(profile.name, '模型名2'); assert.equal(profile.notes, ''); assert.equal(profile.background, '稳定基础资料'); assert.deepEqual(profile.manualFields, ['background', 'notes']);
});

test('自动粗扫把空字符串和空 aliases 当作无更新，且纯空结果不写存档', async () => {
  let calls = 0;
  const h = harness({ generate: async options => {
    calls++;
    const request = JSON.parse(options.taskMessages[0].content);
    const values = calls === 1 ? { name: '稳定姓名', aliases: ['稳定别名'] }
      : calls === 2 ? { name: '', aliases: [], background: '新背景' }
        : { name: '', aliases: [], background: '' };
    return { jsonData: { profiles: request.people.map(person => ({ personKey: person.personKey, ...values })) } };
  } });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([target.id]);
  await h.markProfileInitialized(target.id); h.setMainGenerationActive(false);
  await h.runtime.saveProfile(target.id, { name: '旧姓名', aliases: '旧别名', background: '旧背景' }, { manualFields: [] });
  const publish = count => {
    h.setReachable({ ...h.reachable, floors: Array.from({ length: count }, (_, index) => ({
      id: `${String(index + 1).padStart(8, '0')}-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
      assistantSeq: index + 1, content: { canonicalContent: `稳定原文${index}` },
    })), floorMemories: [] });
    h.notifyFoundation(); h.notifyFoundation();
  };
  publish(10); await waitFor(() => calls === 1 && h.runtime.getState().active === null);
  publish(20); await waitFor(() => calls === 2 && h.runtime.getState().active === null);
  let profile = h.runtime.getState().profilesByEntityId[target.id];
  assert.equal(profile.name, '稳定姓名'); assert.equal(profile.aliases, '稳定别名'); assert.equal(profile.background, '新背景');
  const putsBeforeEmptyRound = h.db.calls.filter(call => call[0] === 'put').length;
  publish(30); await waitFor(() => calls === 3 && h.runtime.getState().active === null);
  profile = h.runtime.getState().profilesByEntityId[target.id];
  assert.equal(profile.name, '稳定姓名'); assert.equal(profile.aliases, '稳定别名'); assert.equal(profile.background, '新背景');
  assert.equal(h.db.calls.filter(call => call[0] === 'put').length, putsBeforeEmptyRound, '没有非空变更时零写入');
});

test('原文在人物存档 read 等待期间变化时，CAS updater 拒绝迟到 patch', async () => {
  let releaseRead, markRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const readStarted = new Promise(resolve => { markRead = resolve; });
  const h = harness({ generate: async () => ({ jsonData: { profiles: [{ personKey: 'person-1', name: '迟到旧名' }] } }) });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([target.id]);
  await h.runtime.saveProfile(target.id, { name: '保留旧名' }, { manualFields: [] });
  await h.markProfileInitialized(target.id); h.setMainGenerationActive(false);
  const floors = Array.from({ length: 10 }, (_, index) => ({ id: ids[index], assistantSeq: index + 1, content: { canonicalContent: `稳定原文${index}` } }));
  h.setReachable({ ...h.reachable, floors, floorMemories: [] });
  let waitForRead = true;
  h.db.hooks.beforeGet = async () => { if (!waitForRead) return; waitForRead = false; markRead(); await readGate; };
  h.notifyFoundation(); await readStarted;
  h.setReachable({ ...h.reachable, floors: floors.map((floor, index) => index === 9
    ? { ...floor, content: { canonicalContent: 'read等待时的新正文' } } : floor), floorMemories: [] });
  releaseRead(); await waitFor(() => h.runtime.getState().active === null);
  assert.equal(h.runtime.getState().profilesByEntityId[target.id].name, '保留旧名');
  assert.equal(h.db.calls.filter(call => call[0] === 'put').length, 2, '自动迟到 patch 未进入 CAS put');
});

test('人物选择在 CAS 冲突期间变化后，重试 updater 不写已取消人物', async () => {
  let releasePut, markPut;
  const putGate = new Promise(resolve => { releasePut = resolve; });
  const putStarted = new Promise(resolve => { markPut = resolve; });
  const h = harness({ generate: async () => ({ jsonData: { profiles: [{ personKey: 'person-1', name: '取消后的迟到名' }] } }) });
  const target = h.peopleEntities[0]; await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([target.id]);
  await h.runtime.saveProfile(target.id, { name: '保留旧名' }, { manualFields: [] });
  await h.markProfileInitialized(target.id); h.setMainGenerationActive(false);
  const floors = Array.from({ length: 10 }, (_, index) => ({ id: ids[index], assistantSeq: index + 1, content: { canonicalContent: `稳定原文${index}` } }));
  h.setReachable({ ...h.reachable, floors, floorMemories: [] });
  let waitForPut = true;
  h.db.hooks.beforePut = async () => { if (!waitForPut) return; waitForPut = false; markPut(); await putGate; };
  h.notifyFoundation(); await putStarted;
  const key = `chat-${CHAT_A}/${PEOPLE_WORKSPACE_RECORD_ID}`;
  const latest = structuredClone(h.db.records.get(key)); latest.revision += 1; latest.data.selectedEntityIds = [];
  h.db.records.set(key, latest);
  releasePut(); await waitFor(() => h.runtime.getState().active === null);
  await h.runtime.refresh({ refreshMemory: false });
  assert.equal(h.db.records.get(key).data.profilesByEntityId[target.id].name, '保留旧名');
  assert.deepEqual(h.runtime.getState().selectedEntityIds, []);
});

test('长于24k的单人主动重整一次发送全部已选片段并只保存一次', async () => {
  const selectedSource = `开头${'设'.repeat(PEOPLE_PROFILE_INPUT_CHAR_BUDGET * 2)}结尾`;
  let calls = 0, request;
  const h = harness({ sourceCandidates: [{ id: 'worldbook:long', kind: 'worldbook', world: '长资料', label: '长资料 · 人物1', entryLabel: '人物1', primaryKeys: ['人物1'], content: selectedSource }],
    generate: async options => {
      calls += 1; request = JSON.parse(options.taskMessages[0].content);
      return { jsonData: { profiles: [{ personKey: 'person-1', name: '本轮新名', likes: '本轮喜好' }] }, taskMetadata: { finishReason: 'stop' } };
    } });
  await h.runtime.refresh(); const id = h.peopleEntities[0].id;
  await h.runtime.setSelectedEntityIds([id]); await h.runtime.setPersonOrderEntityIds([id]);
  await h.runtime.saveProfile(id, { name: '上次AI名', gender: '上次AI性别', background: '上次AI背景', notes: '人工保留' }, { manualFields: ['notes'] });
  await h.runtime.saveAvatar(id, 'data:image/png;base64,AAAA');
  const putsBefore = h.db.calls.filter(call => call[0] === 'put').length;
  await h.runtime.regenerateProfile(id);
  const fragments = request.people[0].sourceFragments.filter(item => item.kind === 'allowedWorldInfo');
  assert.equal(calls, 1); assert.equal(request.people.length, 1); assert.equal(Object.hasOwn(request, 'batch'), false);
  assert.ok(JSON.stringify(request).length > PEOPLE_PROFILE_INPUT_CHAR_BUDGET);
  assert.deepEqual(request.people[0].existingProfile, {}); assert.equal(request.people[0].manualProfile.notes, '人工保留');
  assert.equal(fragments.map(item => item.content).join(''), selectedSource, '首尾和中间已选材料完整保留');
  assert.equal(h.db.calls.filter(call => call[0] === 'put').length, putsBefore + 1, '档案与材料进度同一次原子保存');
  const state = h.runtime.getState(), profile = state.profilesByEntityId[id];
  assert.equal(profile.name, '本轮新名'); assert.equal(profile.likes, '本轮喜好'); assert.equal(profile.gender, ''); assert.equal(profile.background, '');
  assert.equal(profile.notes, '人工保留'); assert.deepEqual(profile.manualFields, ['notes']);
  assert.equal(state.avatarsByEntityId[id], 'data:image/png;base64,AAAA');
  assert.deepEqual(state.selectedEntityIds, [id]); assert.deepEqual(state.personOrderEntityIds, [id]);
  assert.ok(state.profileMaterialProgressByEntityId[id]);
});

test('单人主动重整超窗、其他参数错误、输出截断或拒绝时零写入', async () => {
  let mode = 'ok';
  const h = harness({ generate: async () => {
    if (mode === 'inputLimit') throw Object.assign(new Error('HTTP 400'), { code: 'QQJ_REQUEST_FORMAT', status: 400,
      providerError: { code: 'context_length_exceeded', message: '上游认为请求内容超过限制' } });
    if (mode === 'other400') throw Object.assign(new Error('参数不兼容'), { code: 'QQJ_REQUEST_FORMAT', status: 400,
      providerError: { code: 'invalid_request', message: '上游拒绝了请求参数' } });
    if (mode === 'truncated') return { jsonData: { profiles: [{ personKey: 'person-1', name: '不应写入' }] }, taskMetadata: { finishReason: 'length' } };
    if (mode === 'refusal') return { jsonData: { profiles: [{ personKey: 'person-1', name: '不应写入' }] }, taskMetadata: { finishReason: 'content_filter' } };
    return { jsonData: { profiles: [{ personKey: 'person-1', name: '成功新名' }] }, taskMetadata: { finishReason: 'stop' } };
  } });
  await h.runtime.refresh(); const id = h.peopleEntities[0].id; await h.runtime.setSelectedEntityIds([id]);
  await h.runtime.saveProfile(id, { name: '旧AI姓名', background: '旧AI背景', notes: '人工资料' }, { manualFields: ['notes'] });
  const original = structuredClone(h.runtime.getState().profilesByEntityId[id]);
  for (const [scenario, expected] of [['inputLimit', '本次材料超过所选模型可接收范围，未保存。'], ['other400', '参数不兼容'], ['truncated', '模型输出疑似被截断'], ['refusal', '模型未能完成']]) {
    mode = scenario; const putsBefore = h.db.calls.filter(call => call[0] === 'put').length;
    await assert.rejects(h.runtime.regenerateProfile(id), message => String(message.message).includes(expected));
    assert.equal(h.db.calls.filter(call => call[0] === 'put').length, putsBefore, `${scenario} 不写档案或材料进度`);
    assert.deepEqual(h.runtime.getState().profilesByEntityId[id], original);
  }
  mode = 'ok'; await h.runtime.regenerateProfile(id);
  assert.equal(h.runtime.getState().profilesByEntityId[id].name, '成功新名');
  assert.equal(h.runtime.getState().profilesByEntityId[id].notes, '人工资料');
});

test('单人重整返回空结果或无法绑定人物时明确报告本次未保存', async () => {
  let mode = 'empty';
  const h = harness({ generate: async () => ({ jsonData: { profiles: mode === 'empty' ? [] : [{ personKey: 'unknown-person', name: '不应写入' }] } }) });
  await h.runtime.refresh(); const id = h.peopleEntities[0].id; await h.runtime.setSelectedEntityIds([id]);
  await h.runtime.saveProfile(id, { name: '旧 AI 姓名', notes: '人工资料' }, { manualFields: ['notes'] });
  const original = structuredClone(h.runtime.getState().profilesByEntityId[id]);
  for (const scenario of ['empty', 'unbound']) {
    mode = scenario; const putsBefore = h.db.calls.filter(call => call[0] === 'put').length;
    await assert.rejects(h.runtime.regenerateProfile(id), error => error.code === 'QQJ_PEOPLE_GENERATION_BINDING_INVALID'
      && /本次未保存/u.test(error.message) && !/此前批次已保存/u.test(error.message));
    assert.equal(h.db.calls.filter(call => call[0] === 'put').length, putsBefore, `${scenario} 不产生档案或进度写入`);
    assert.deepEqual(h.runtime.getState().profilesByEntityId[id], original);
  }
});

test('单人主动重整等待期间取消人物选择时拒绝迟到结果', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  const h = harness({ generate: async () => {
    started(); await gate;
    return { jsonData: { profiles: [{ personKey: 'person-1', name: '迟到姓名' }] }, taskMetadata: { finishReason: 'stop' } };
  } });
  await h.runtime.refresh(); const id = h.peopleEntities[0].id; await h.runtime.setSelectedEntityIds([id]);
  await h.runtime.saveProfile(id, { name: '保留姓名', notes: '人工资料' }, { manualFields: ['notes'] });
  const original = structuredClone(h.runtime.getState().profilesByEntityId[id]);
  const pending = h.runtime.regenerateProfile(id); await requestStarted;
  await h.runtime.setSelectedEntityIds([]);
  const putsBeforeResult = h.db.calls.filter(call => call[0] === 'put').length;
  release(); await assert.rejects(pending, error => error.code === 'QQJ_PEOPLE_STALE');
  assert.equal(h.db.calls.filter(call => call[0] === 'put').length, putsBeforeResult, '迟到的模型结果没有额外落盘');
  assert.deepEqual(h.runtime.getState().profilesByEntityId[id], original);
  assert.deepEqual(h.runtime.getState().selectedEntityIds, []);
});
