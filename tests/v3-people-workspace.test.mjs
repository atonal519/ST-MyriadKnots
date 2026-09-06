import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeopleWorkspaceStore, createPeopleWorkspaceRuntime, PEOPLE_WORKSPACE_RECORD_ID } from '../src/v3/people-workspace.js';
import { filterSourcesByPermission } from '../src/source-permission.js';

const CHAT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHAT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ids = Array.from({ length: 16 }, (_, index) => `${String(index + 1).padStart(8, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`);
const USER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SYNTHETIC_CHAR = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function failure(status) { return Object.assign(new Error(`HTTP ${status}`), { status }); }
function backend() {
  const records = new Map(), calls = [];
  return {
    records, calls,
    client: {
      async get(collection, key) { calls.push(['get', collection, key]); const value = records.get(`${collection}/${key}`); if (!value) throw failure(404); return structuredClone(value); },
      async put(collection, key, data, expectedRevision, options = {}) {
        calls.push(['put', collection, key, expectedRevision]); if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const mapKey = `${collection}/${key}`, previous = records.get(mapKey); if ((previous?.revision ?? 0) !== expectedRevision) throw failure(409);
        const envelope = { revision: expectedRevision + 1, data: structuredClone(data) }; records.set(mapKey, envelope); return structuredClone(envelope);
      },
    },
  };
}
function entity(id, name, extra = {}) {
  return { id, entityType: 'person', displayName: name, aliases: [{ name: `${name}别名` }], specialRole: 'none', firstSeenFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', lastSeenFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'established', recordStatus: 'active', ...extra };
}
function harness({ generate = async () => ({ jsonData: { profiles: [] } }), many = false, permissionSettings = null, sourceCandidates = null } = {}) {
  const db = backend(); let identity = { chatId: CHAT_A, hostChatId: 'host-a', characterLocator: 'char.png', personaLocator: 'persona.png' };
  const peopleEntities = ids.slice(0, many ? 12 : 4).map((id, index) => entity(id, `人物${index + 1}`));
  let reachable = {
    entities: [...peopleEntities, entity(USER, '用户', { specialRole: 'user' }), entity(SYNTHETIC_CHAR, '剧情标题', { specialRole: 'char', firstSeenFloorId: null, lastSeenFloorId: null })],
    floorMemories: peopleEntities.map((person, index) => ({ recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: `${person.displayName}在第${index + 1}楼出现。` }, participants: [{ entityId: person.id }] })),
    baseline: { characterCard: { entityId: SYNTHETIC_CHAR, name: '剧情标题', description: '角色卡描述', personality: '角色卡性格', scenario: '场景' } },
  };
  let memoryState = { cseSubjects: peopleEntities.map((person, index) => ({ subjectEntityId: person.id, displayName: person.displayName, core: index === 0 ? [{ text: '谨慎', origin: 'delta', sourceFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] : [], adaptive: [], situational: [] })) };
  const listeners = new Set();
  const memoryRuntime = { getState: () => memoryState, refreshStatus: async () => memoryState, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const sourceTrace = [];
  const runtime = createPeopleWorkspaceRuntime({
    store: createPeopleWorkspaceStore({ client: db.client }), session: { identity: () => structuredClone(identity) },
    foundationRuntime: { getReachable: () => reachable }, memoryRuntime, generateUtilityTask: generate,
    sourcePermissions: { filterCandidates({ chatId, candidates }) { sourceTrace.push(['filter', chatId, candidates.map(item => item.id)]); return permissionSettings ? filterSourcesByPermission({ chatId, candidates, settings: permissionSettings }) : candidates.filter(item => item.id !== 'worldbook:excluded'); } },
    contextProvider: () => ({ chat: [], marker: identity.chatId }),
    scanner: async context => { sourceTrace.push(['scan', context.marker]); return { entries: [{ content: '<secret>DROP</secret><content>ALLOWED</content>' }, { content: 'EXCLUDED' }] }; },
    sourceCandidateFactory: async catalog => { sourceTrace.push(['candidates', catalog.entries.length]); return sourceCandidates ?? [{ id: 'worldbook:allowed', kind: 'worldbook', world: '允许书', label: '允许条目', content: catalog.entries[0].content }, { id: 'worldbook:excluded', kind: 'worldbook', world: '排除书', label: '排除条目', content: catalog.entries[1].content }]; },
    sanitizerOptions: () => ({ keepTags: 'content' }), now: () => new Date('2026-09-06T00:00:00.000Z'),
  });
  return { db, runtime, peopleEntities, sourceTrace, get identity() { return identity; }, setIdentity(value) { identity = value; }, setReachable(value) { reachable = value; }, get memoryState() { return memoryState; } };
}

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

test('一次整理只覆盖未建档人物，严格过滤世界书并使用本次 personKey 绑定', async () => {
  let request;
  const h = harness({ generate: async options => {
    request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { profiles: [{ personKey: 'person-1', name: '人物2资料名', aliases: ['小二'], background: '背景', appearance: '', personality: '沉稳', notes: '' }] } };
  } });
  await h.runtime.refresh(); const [first, second] = h.peopleEntities;
  await h.runtime.setSelectedEntityIds([first.id, second.id]);
  await h.runtime.saveProfile(first.id, { name: '', aliases: '', background: '', appearance: '', personality: '', notes: '' });
  await h.runtime.generateMissingProfiles();
  assert.deepEqual(request.people.map(item => item.currentName), ['人物2'], '已有资料包括人工清空都不得再交给模型补空');
  assert.equal(request.allowedWorldInfo.length, 1); assert.equal(request.allowedWorldInfo[0].source, '允许书');
  assert.equal(JSON.stringify(request).includes('EXCLUDED'), false); assert.equal(JSON.stringify(request).includes('DROP'), false); assert.equal(JSON.stringify(request).includes('ALLOWED'), true);
  assert.deepEqual(h.sourceTrace.map(item => item[0]), ['scan', 'candidates', 'filter']);
  const state = h.runtime.getState(); assert.equal(state.profilesByEntityId[first.id].source, 'manual'); assert.equal(state.profilesByEntityId[second.id].source, 'generated');
  assert.deepEqual(state.selectedEntityIds, [first.id, second.id], '生成与选择保存必须分离');
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
