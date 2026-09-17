import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPeopleProfileSystemPrompt, createPeopleWorkspaceStore, createPeopleWorkspaceRuntime, DEFAULT_PROFILE_GUIDANCE, PEOPLE_PROFILE_FULL_REWRITE_CHAR_BUDGET, PEOPLE_PROFILE_INPUT_CHAR_BUDGET, PEOPLE_WORKSPACE_RECORD_ID, PROFILE_FIXED_CONTRACT, validatePeopleWorkspace } from '../src/v3/people-workspace.js';
import { PEOPLE_PROFILE_DEFINITIONS, PEOPLE_PROFILE_FIELDS, PEOPLE_PROFILE_LABELS } from '../src/v3/people-profile-fields.js';
import { filterSourcesByPermission } from '../src/source-permission.js';
import { BASE_PROCESSING_PROMPT } from '../src/internal-processing-prompt.js';
import { createCompactApiClient } from '../src/compact-api-client.js';

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
function harness({ generate = async () => ({ jsonData: { profiles: [] } }), many = false, permissionSettings = null, sourceCandidates = null, profilePromptGuidance = () => '', processingPrompt = () => '', prequel = '' } = {}) {
  const db = backend(); let identity = { chatId: CHAT_A, hostChatId: 'host-a', characterLocator: 'char.png', personaLocator: 'persona.png' }, currentPrequel = prequel;
  const peopleEntities = ids.slice(0, many ? 12 : 4).map((id, index) => entity(id, `人物${index + 1}`));
  let reachable = {
    entities: [...peopleEntities, entity(USER, '用户', { specialRole: 'user' }), entity(SYNTHETIC_CHAR, '剧情标题', { specialRole: 'char', firstSeenFloorId: null, lastSeenFloorId: null })],
    floorMemories: peopleEntities.map((person, index) => ({ recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: `${person.displayName}在第${index + 1}楼出现。` }, participants: [{ entityId: person.id }] })),
    baseline: { characterCard: { entityId: SYNTHETIC_CHAR, name: '剧情标题', description: '角色卡描述', personality: '角色卡性格', scenario: '场景' } },
  };
  let memoryState = { cseSubjects: peopleEntities.map((person, index) => ({ subjectEntityId: person.id, displayName: person.displayName, core: index === 0 ? [{ text: '谨慎', origin: 'delta', sourceFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] : [], adaptive: [], situational: [] })) };
  const listeners = new Set();
  let memoryRefreshes = 0;
  const memoryRuntime = { getState: () => memoryState, refreshStatus: async () => { memoryRefreshes += 1; return memoryState; }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const sourceTrace = [];
  const runtime = createPeopleWorkspaceRuntime({
    store: createPeopleWorkspaceStore({ client: db.client }), session: { identity: () => structuredClone(identity) },
    foundationRuntime: { getReachable: () => reachable }, memoryRuntime, generateUtilityTask: generate, profilePromptGuidance, processingPrompt,
    sourcePermissions: { filterCandidates({ chatId, candidates }) { sourceTrace.push(['filter', chatId, candidates.map(item => item.id)]); return permissionSettings ? filterSourcesByPermission({ chatId, candidates, settings: permissionSettings }) : candidates.filter(item => item.id !== 'worldbook:excluded'); } },
    contextProvider: () => ({ chat: [], marker: identity.chatId, chatMetadata: currentPrequel ? { qianqianjiePrequel: currentPrequel } : {} }),
    scanner: async context => { sourceTrace.push(['scan', context.marker]); return { entries: [{ content: '<secret>DROP</secret><content>ALLOWED</content>' }, { content: 'EXCLUDED' }] }; },
    sourceCandidateFactory: async catalog => { sourceTrace.push(['candidates', catalog.entries.length]); return sourceCandidates ?? [{ id: 'worldbook:allowed', kind: 'worldbook', world: '允许书', label: '允许条目', content: catalog.entries[0].content }, { id: 'worldbook:excluded', kind: 'worldbook', world: '排除书', label: '排除条目', content: catalog.entries[1].content }]; },
    sanitizerOptions: () => ({ keepTags: 'content' }), now: () => new Date('2026-09-06T00:00:00.000Z'),
    logger: { warn() {} },
  });
  return { db, runtime, peopleEntities, sourceTrace, get identity() { return identity; }, setIdentity(value) { identity = value; }, get reachable() { return reachable; }, setReachable(value) { reachable = value; },
    get memoryState() { return memoryState; }, setMemoryState(value, notify = true) { memoryState = value; if (notify) for (const listener of listeners) listener(memoryState); },
    notifyMemory() { for (const listener of listeners) listener(memoryState); }, setPrequel(value) { currentPrequel = value; }, get memoryRefreshes() { return memoryRefreshes; } };
}

async function waitFor(check, message = '等待后台人物整理超时') {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
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
  assert.match(custom, /summaryUpdates 是本次新摘要/);
  assert.match(custom, /聚合多楼 history 可省略 storyContent/);
  assert.match(custom, /不得猜测未提供的正文/);
  assert.match(custom, /没有新信息时省略字段/);
  assert.match(custom, /本批可能只包含该来源的一部分/);
  assert.match(custom, /明确要求删除旧资料且没有替代值/);
  assert.match(custom, /build（体型）：身体骨架、体态、比例/);
  assert.match(custom, /occupation（职业）：人物从事的职业/);
  assert.match(custom, /personality（核心性格）：跨情境较稳定/);
  assert.equal(PEOPLE_PROFILE_FIELDS.length, 27);
  assert.deepEqual(Object.keys(PEOPLE_PROFILE_DEFINITIONS), PEOPLE_PROFILE_FIELDS);
  assert.ok(PEOPLE_PROFILE_FIELDS.every(field => PEOPLE_PROFILE_LABELS[field] && PEOPLE_PROFILE_DEFINITIONS[field]));
  assert.equal(custom.split(BASE_PROCESSING_PROMPT).length - 1, 1);
});

test('整档整理一次请求覆盖全部已选人物，材料不含逐楼历史，合法人物部分替换并迁移人工字段', async () => {
  let calls = 0, request, systemPrompt;
  const complete = (personKey, name, manualFields = []) => ({ personKey, manualFields,
    ...Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, field === 'name' ? name : ''])),
  });
  const h = harness({ generate: async options => {
    calls += 1; systemPrompt = options.systemPrompt; request = JSON.parse(options.taskMessages[0].content);
    const first = complete('person-1', '人物1新档', ['background']); first.background = '人工说明被整理到背景';
    const invalidSecond = complete('person-2', '人物2新档'); delete invalidSecond.notes;
    return { jsonData: { profiles: [first, invalidSecond] } };
  } });
  const [first, second] = h.peopleEntities;
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([first.id, second.id]);
  await h.runtime.saveProfile(first.id, { ...Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, ''])), name: '人物1旧档', notes: '{{char}}人工说明' }, { manualFields: ['notes'] });
  const putsBefore = h.db.calls.filter(call => call[0] === 'put').length;
  await h.runtime.rewriteSelectedProfiles();
  assert.equal(calls, 1); assert.equal(h.db.calls.filter(call => call[0] === 'put').length, putsBefore + 1);
  assert.deepEqual(request.people.map(person => person.currentName), ['人物1', '人物2']);
  assert.equal(request.people[0].existingProfile.notes, '剧情标题人工说明'); assert.deepEqual(request.people[0].manualFields, ['notes']);
  assert.equal(JSON.stringify(request).includes('history'), false); assert.equal(JSON.stringify(request).includes('priorContext'), false);
  assert.equal(request.allowedWorldInfo.length, 1); assert.ok(Array.isArray(request.characterCards));
  assert.match(systemPrompt, /完整结果会整体替换旧档案/); assert.match(systemPrompt, /manualFields/);
  assert.doesNotMatch(systemPrompt, /上次 AI 档案中本轮未生成的字段不保留/);
  const state = h.runtime.getState(); assert.equal(state.profilesByEntityId[first.id].name, '人物1新档');
  assert.equal(state.profilesByEntityId[first.id].background, '人工说明被整理到背景'); assert.deepEqual(state.profilesByEntityId[first.id].manualFields, ['background']);
  assert.equal(state.profilesByEntityId[second.id], undefined, '字段不完整的人物保留原档案');
  assert.deepEqual(state.profileMaterialProgressByEntityId, {}, '整档整理不冒充逐楼历史进度');
  assert.deepEqual(state.lastGenerationReport, { requested: 2, saved: 1, missing: 0, conflicts: 0, invalid: 1, unknown: 0, skipped: 0 });
});

test('整档整理在途人工修改优先，模型结果跳过该人物且不覆盖', async () => {
  let h;
  const complete = Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, ''])); complete.name = '模型结果';
  h = harness({ generate: async options => {
    const request = JSON.parse(options.taskMessages[0].content), target = h.peopleEntities[0];
    await h.runtime.saveProfile(target.id, { ...complete, name: '在途人工新值' }, { manualFields: ['name'] });
    return { jsonData: { profiles: [{ personKey: request.people[0].personKey, manualFields: [], ...complete }] } };
  } });
  const target = h.peopleEntities[0]; await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([target.id]);
  await h.runtime.rewriteSelectedProfiles();
  const state = h.runtime.getState(); assert.equal(state.profilesByEntityId[target.id].name, '在途人工新值');
  assert.equal(state.lastGenerationReport.saved, 0); assert.equal(state.lastGenerationReport.skipped, 1);
});

test('整档回复不得用空人工字段吞掉原非空人工内容', async () => {
  const fields = Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, ''])); fields.name = '模型结果';
  const h = harness({ generate: async () => ({ jsonData: { profiles: [{ personKey: 'person-1', manualFields: ['notes'], ...fields }] } }) });
  const target = h.peopleEntities[0]; await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([target.id]);
  await h.runtime.saveProfile(target.id, { ...fields, name: '原档案', notes: '不可丢的人工内容' }, { manualFields: ['notes'] });
  await assert.rejects(h.runtime.rewriteSelectedProfiles(), error => error.code === 'QQJ_PEOPLE_GENERATION_BINDING_INVALID');
  const state = h.runtime.getState(); assert.equal(state.profilesByEntityId[target.id].notes, '不可丢的人工内容'); assert.equal(state.lastGenerationReport.invalid, 1);
});

test('整档整理约35705字符仍单次提交，超过60000字符才在模型调用前拒绝', async () => {
  let acceptedCalls = 0, acceptedLength = 0;
  const accepted = harness({ sourceCandidates: [{ id: 'worldbook:medium', kind: 'worldbook', world: '中长世界书', label: '中长条目', content: '中'.repeat(35000) }], generate: async options => {
    acceptedCalls += 1; const request = JSON.parse(options.taskMessages[0].content); acceptedLength = options.taskMessages[0].content.length;
    const fields = Object.fromEntries(PEOPLE_PROFILE_FIELDS.map(field => [field, field === 'name' ? request.people[0].currentName : '']));
    return { jsonData: { profiles: [{ personKey: request.people[0].personKey, manualFields: [], ...fields }] } };
  } });
  await accepted.runtime.refresh(); await accepted.runtime.setSelectedEntityIds([accepted.peopleEntities[0].id]); await accepted.runtime.rewriteSelectedProfiles();
  assert.equal(acceptedCalls, 1); assert.ok(acceptedLength > 35000 && acceptedLength <= PEOPLE_PROFILE_FULL_REWRITE_CHAR_BUDGET);

  let calls = 0;
  const h = harness({ sourceCandidates: [{ id: 'worldbook:large', kind: 'worldbook', world: '长世界书', label: '长条目', content: '长'.repeat(61000) }], generate: async () => { calls += 1; return { jsonData: { profiles: [] } }; } });
  await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([h.peopleEntities[0].id]);
  await assert.rejects(h.runtime.rewriteSelectedProfiles(), error => error.code === 'QQJ_PEOPLE_FULL_REWRITE_TOO_LARGE' && /60000 字符/.test(error.message));
  assert.equal(calls, 0);
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
  assert.equal(generatedRequest.people[0].history.length, 2, '来源与目标的不同历史楼均归目标且不丢失');
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

test('一次整理只覆盖未建档人物，严格过滤世界书并使用本次 personKey 绑定', async () => {
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
  assert.equal(JSON.stringify(request).includes('EXCLUDED'), false); assert.equal(JSON.stringify(request).includes('DROP'), false); assert.equal(JSON.stringify(request).includes('ALLOWED'), true);
  assert.deepEqual(h.sourceTrace.map(item => item[0]), ['scan', 'candidates', 'filter']);
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
      ? { requested: 2, saved: 1, missing: 1, conflicts: 0, invalid: 0, unknown: 0, skipped: 0 }
      : { requested: 3, saved: 1, missing: 1, conflicts: 1, invalid: 0, unknown: 1, skipped: 0 });
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

test('人物资料在展示、整理输入和模型输出统一解析当前聊天 user/char 宏且不改普通单词', async () => {
  let request;
  const h = harness({
    sourceCandidates: [{ id: 'worldbook:allowed', kind: 'worldbook', world: '设定书', label: '宏条目', content: '{{user}}信任{{char}}，普通 user char。' }],
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
  assert.equal(request.people[0].history[0].summary, '辛夷遇见主角，普通 user char。');
  assert.equal(request.people[0].history[0].sourceFloor, 1);
  assert.deepEqual(request.people[0].history[0].auxiliaryStateSnapshot, { stat_data: { 人物1: { 发色: '黑色' }, 另一人物: { 发色: '银色' } }, ejsSaved: { season: '秋' } });
  assert.equal(request.allowedWorldInfo[0].content, '辛夷信任主角，普通 user char。');
  assert.deepEqual(request.people[0].manualProfile, {});
  assert.equal(h.runtime.getState().profilesByEntityId[target.id].background, '辛夷与主角，普通 user char。');
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
  assert.deepEqual(h.runtime.getState().lastGenerationReport, { requested: 1, saved: 0, missing: 0, conflicts: 0, invalid: 0, unknown: 0, skipped: 1 }, 'CAS 重读后跳过的人工资料不能算作本次保存');
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

test('单次自动摘要只合并一次相关人物增量，不读取旧正文、世界书或写全历史进度', async () => {
  const requests = [];
  const h = harness({ many: true, generate: async options => {
    const request = JSON.parse(options.taskMessages[0].content); requests.push(request);
    return { jsonData: { profiles: request.people.map(person => ({ personKey: person.personKey })) } };
  } });
  const targets = h.peopleEntities.slice(0, 10);
  const oldFloors = ids.slice(0, 8).map((id, index) => ({ id, assistantSeq: index + 1, content: { canonicalContent: `旧正文${index}${'甲'.repeat(8000)}` } }));
  const oldMemories = oldFloors.map((floor, index) => ({ id: `${String(index + 20).padStart(8, '0')}-2222-4222-8222-${String(index + 20).padStart(12, '0')}`, floorId: floor.id, recordStatus: 'active',
    summary: { effectiveSource: 'ai', aiText: `旧摘要${index}` }, participants: targets.map(person => ({ entityId: person.id })) }));
  const floorId = ids[14], memoryId = ids[15];
  h.setReachable({ ...h.reachable,
    floors: [...oldFloors, { id: floorId, assistantSeq: 9, content: { canonicalContent: `本次正文${'乙'.repeat(30000)}` } }],
    floorMemories: [...oldMemories, { id: memoryId, floorId, recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '本次十人共同收到一封信。' }, participants: targets.map(person => ({ entityId: person.id })) }],
  });
  await h.runtime.refresh({ refreshMemory: false });
  await h.runtime.setSelectedEntityIds(targets.map(person => person.id));
  for (const target of targets) await h.runtime.saveProfile(target.id, { name: target.displayName, aliases: '', background: '', appearance: '', personality: '', notes: '已有档案' });
  h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId, memoryId });
  await waitFor(() => requests.length === 1 && h.runtime.getState().active === null);
  assert.equal(requests.length, 1); assert.equal(requests[0].people.length, 10); assert.equal(requests[0].summaryUpdates.length, 1);
  assert.equal(requests[0].summaryUpdates[0].summary, '本次十人共同收到一封信。');
  assert.ok(requests[0].people.every(person => person.summaryReferences.length === 1 && person.manualProfile.notes === '已有档案'));
  assert.equal(Object.hasOwn(requests[0], 'batch'), false); assert.deepEqual(requests[0].allowedWorldInfo, []);
  assert.equal(JSON.stringify(requests[0]).includes('旧正文'), false); assert.equal(JSON.stringify(requests[0]).includes('本次正文'), false);
  assert.deepEqual(h.runtime.getState().profileMaterialProgressByEntityId, {}, '自动增量不得伪写全历史覆盖进度');
});

test('自动摘要按归属和稳定内容本地去重，参与人物的自由摘要不会因 facts 为空丢失', async () => {
  const requests = [];
  const h = harness({ generate: async options => {
    const request = JSON.parse(options.taskMessages[0].content); requests.push(request);
    return { jsonData: { profiles: request.people.map(person => ({ personKey: person.personKey, notes: '已吸收生日' })) } };
  } });
  const [target, other] = h.peopleEntities;
  await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([target.id]);
  const unrelatedFloor = ids[8], unrelatedMemory = ids[9];
  h.setReachable({ ...h.reachable, floors: [{ id: unrelatedFloor, assistantSeq: 1, content: { canonicalContent: '无关正文' } }],
    floorMemories: [{ id: unrelatedMemory, floorId: unrelatedFloor, recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '另一人物出现。' }, participants: [{ entityId: other.id }] }] });
  h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId: unrelatedFloor, memoryId: unrelatedMemory });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(requests.length, 0);

  const firstFloor = ids[10], firstMemory = ids[11];
  const birthdayMemory = { id: firstMemory, floorId: firstFloor, recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '人物1说自己的生日是三月九日。' }, participants: [{ entityId: target.id }] };
  h.setReachable({ ...h.reachable, floors: [{ id: firstFloor, assistantSeq: 2, content: { canonicalContent: '生日正文' } }], floorMemories: [birthdayMemory] });
  h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId: firstFloor, memoryId: firstMemory });
  await waitFor(() => requests.length === 1 && h.runtime.getState().active === null);
  assert.equal(requests[0].summaryUpdates[0].summary, '人物1说自己的生日是三月九日。');
  assert.deepEqual(requests[0].people[0].summaryReferences, [{ summaryKey: 'summary-1' }], '只有 participants 也必须保留自由摘要归属');
  h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId: firstFloor, memoryId: firstMemory });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(requests.length, 1, '同一通知不重发');

  const secondFloor = ids[12], secondMemory = ids[13];
  h.setReachable({ ...h.reachable, floors: [{ id: secondFloor, assistantSeq: 99, content: { canonicalContent: '不同定位的相同事实' } }],
    floorMemories: [{ ...birthdayMemory, id: secondMemory, floorId: secondFloor }] });
  h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId: secondFloor, memoryId: secondMemory });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(requests.length, 1, '定位和版本变化但稳定来源相同不请求');
});

test('自动摘要同批稳定内容去重且签名不受回执到达顺序影响', async () => {
  const requests = [];
  const h = harness({ generate: async options => {
    const request = JSON.parse(options.taskMessages[0].content); requests.push(request);
    return { jsonData: { profiles: request.people.map(person => ({ personKey: person.personKey, notes: `轮次${requests.length}` })) } };
  } });
  const target = h.peopleEntities[0];
  await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([target.id]);
  const uuids = Array.from({ length: 14 }, (_, index) => `${String(index + 40).padStart(8, '0')}-3333-4333-8333-${String(index + 40).padStart(12, '0')}`);
  const memory = (index, summary) => ({ id: uuids[index * 2 + 1], floorId: uuids[index * 2], recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: summary }, participants: [{ entityId: target.id }] });
  const all = [memory(0, '稳定摘要A')];
  const publish = entries => h.setReachable({ ...h.reachable,
    floors: entries.map((item, index) => ({ id: item.floorId, assistantSeq: index + 1 })), floorMemories: entries });
  const notify = item => h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId: item.floorId, memoryId: item.id });
  publish(all); notify(all[0]); await waitFor(() => requests.length === 1 && h.runtime.getState().active === null);

  const duplicateA = [memory(1, '稳定摘要A'), memory(2, '稳定摘要A')]; all.push(...duplicateA); publish(all);
  h.setMemoryState({ ...h.memoryState, memoryWorkBusy: true }); duplicateA.forEach(notify);
  h.setMemoryState({ ...h.memoryState, memoryWorkBusy: false }); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests.length, 1, '已处理 A 后合并到达 A/A 仍是相同稳定来源');

  const pairAB = [memory(3, '稳定摘要A'), memory(4, '稳定摘要B')]; all.push(...pairAB); publish(all);
  h.setMemoryState({ ...h.memoryState, memoryWorkBusy: true }); pairAB.forEach(notify);
  h.setMemoryState({ ...h.memoryState, memoryWorkBusy: false }); await waitFor(() => requests.length === 2 && h.runtime.getState().active === null);
  assert.equal(requests[1].summaryUpdates.length, 2);

  const pairBA = [memory(5, '稳定摘要B'), memory(6, '稳定摘要A')]; all.push(...pairBA); publish(all);
  h.setMemoryState({ ...h.memoryState, memoryWorkBusy: true }); pairBA.forEach(notify);
  h.setMemoryState({ ...h.memoryState, memoryWorkBusy: false }); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests.length, 2, '相同 A/B 内容仅回执到达顺序改变不请求');
});

test('自动摘要在记忆忙态和人物生成中保留新通知，并将后续通知合成一次调用', async () => {
  const requests = []; let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const h = harness({ generate: async options => {
    const request = JSON.parse(options.taskMessages[0].content); requests.push(request);
    if (requests.length === 1) await firstGate;
    return { jsonData: { profiles: request.people.map(person => ({ personKey: person.personKey, notes: `轮次${requests.length}` })) } };
  } });
  const target = h.peopleEntities[0];
  await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([target.id]);
  const memories = [0, 1, 2].map(index => ({ id: ids[index + 9], floorId: ids[index + 5], recordStatus: 'active',
    summary: { effectiveSource: 'ai', aiText: `新增摘要${index + 1}` }, participants: [{ entityId: target.id }] }));
  h.setReachable({ ...h.reachable, floors: memories.map((memory, index) => ({ id: memory.floorId, assistantSeq: index + 1, content: { canonicalContent: `正文${index + 1}` } })), floorMemories: memories });
  h.setMemoryState({ ...h.memoryState, memoryWorkBusy: true });
  h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId: memories[0].floorId, memoryId: memories[0].id });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(requests.length, 0);
  h.setMemoryState({ ...h.memoryState, memoryWorkBusy: false });
  await waitFor(() => requests.length === 1 && h.runtime.getState().active?.kind === 'generating');
  h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId: memories[1].floorId, memoryId: memories[1].id });
  h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId: memories[2].floorId, memoryId: memories[2].id });
  releaseFirst();
  await waitFor(() => requests.length === 2 && h.runtime.getState().active === null);
  assert.equal(requests[1].summaryUpdates.length, 2); assert.equal(requests.length, 2, '生成中到达的两条通知只形成后一轮一次调用');
});

test('自动增量失败不自我重排，invalidate 后旧 finally 不复活待办', async () => {
  let calls = 0, fail = true, release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ generate: async options => {
    calls += 1;
    if (fail) throw new Error('模拟自动失败');
    await gate;
    const request = JSON.parse(options.taskMessages[0].content);
    return { jsonData: { profiles: request.people.map(person => ({ personKey: person.personKey })) } };
  } });
  const target = h.peopleEntities[0], firstFloor = ids[7], firstMemory = ids[8], secondFloor = ids[9], secondMemory = ids[10];
  const makeMemory = (id, floorId, text) => ({ id, floorId, recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: text }, participants: [{ entityId: target.id }] });
  h.setReachable({ ...h.reachable, floors: [{ id: firstFloor, assistantSeq: 1 }, { id: secondFloor, assistantSeq: 2 }],
    floorMemories: [makeMemory(firstMemory, firstFloor, '失败摘要'), makeMemory(secondMemory, secondFloor, '迟到摘要')] });
  await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([target.id]);
  h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId: firstFloor, memoryId: firstMemory });
  await waitFor(() => calls === 1 && h.runtime.getState().active === null);
  h.notifyMemory(); h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId: firstFloor, memoryId: firstMemory });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1, '失败材料不因状态通知或重复回执重试');

  fail = false;
  h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId: secondFloor, memoryId: secondMemory });
  await waitFor(() => calls === 2 && h.runtime.getState().active?.kind === 'generating');
  h.runtime.invalidate(); release();
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(calls, 2, '失效后的旧收尾不得创建新任务');
});

test('主动重整多批只累计本轮AI，失败不提前清旧档，重试从空重新开始', async () => {
  let mode = 'failure', calls = 0; const requests = [];
  const h = harness({ sourceCandidates: [{ id: 'worldbook:long', kind: 'worldbook', world: '长资料', label: '人物资料', content: '设'.repeat(PEOPLE_PROFILE_INPUT_CHAR_BUDGET * 2) }],
    generate: async options => {
      const request = JSON.parse(options.taskMessages[0].content); requests.push(request); calls++;
      if (mode === 'failure') throw new Error('首批失败');
      if (mode === 'laterFailure' && calls === 2) throw new Error('后批失败');
      return { jsonData: { profiles: [{ personKey: 'person-1', ...(calls === 1 ? { name: '本轮新名' } : { likes: '本轮喜好' }) }] } };
    } });
  await h.runtime.refresh(); const id = h.peopleEntities[0].id;
  await h.runtime.setSelectedEntityIds([id]); await h.runtime.setPersonOrderEntityIds([id]);
  await h.runtime.saveProfile(id, { name: '上次AI名', gender: '上次AI性别', background: '上次AI背景', notes: '人工保留' }, { manualFields: ['notes'] });
  await h.runtime.saveAvatar(id, 'data:image/png;base64,AAAA');
  const original = structuredClone(h.runtime.getState().profilesByEntityId[id]);
  await assert.rejects(h.runtime.regenerateProfile(id), /首批失败/);
  assert.deepEqual(h.runtime.getState().profilesByEntityId[id], original);
  assert.deepEqual(requests[0].people[0].existingProfile, {});
  mode = 'laterFailure'; calls = 0; requests.length = 0;
  await assert.rejects(h.runtime.regenerateProfile(id), /后批失败/);
  assert.deepEqual(requests[0].people[0].existingProfile, {});
  assert.deepEqual(requests[1].people[0].existingProfile, { name: '本轮新名' });
  assert.equal(h.runtime.getState().profilesByEntityId[id].background, '');
  mode = 'success'; calls = 0; requests.length = 0;
  await h.runtime.regenerateProfile(id);
  assert.ok(calls > 1); assert.deepEqual(requests[0].people[0].existingProfile, {}, '失败后用户重试仍从空重新开始');
  assert.ok(requests.every(request => !JSON.stringify(request).includes('上次AI')));
  assert.ok(requests.every(request => request.people[0].manualProfile.notes === '人工保留'));
  assert.equal(requests[1].people[0].existingProfile.name, '本轮新名');
  const state = h.runtime.getState(), profile = state.profilesByEntityId[id];
  assert.equal(profile.name, '本轮新名'); assert.equal(profile.likes, '本轮喜好'); assert.equal(profile.gender, ''); assert.equal(profile.background, '');
  assert.equal(profile.notes, '人工保留'); assert.deepEqual(profile.manualFields, ['notes']);
  assert.equal(state.avatarsByEntityId[id], 'data:image/png;base64,AAAA');
  assert.deepEqual(state.selectedEntityIds, [id]); assert.deepEqual(state.personOrderEntityIds, [id]);
});

test('自动增量仍输入旧AI档案，模型缺省字段与人工字段继续保留', async () => {
  let request, calls = 0;
  const h = harness({ generate: async options => { calls++; request = JSON.parse(options.taskMessages[0].content); return { jsonData: { profiles: [{ personKey: 'person-1', likes: '新的爱好' }] } }; } });
  const id = h.peopleEntities[0].id, floorId = ids[14], memoryId = ids[15];
  h.setReachable({ ...h.reachable, floors: [{ id: floorId, assistantSeq: 1, content: { canonicalContent: '正文' } }],
    floorMemories: [{ id: memoryId, floorId, recordStatus: 'active', summary: { aiText: '人物1新增一项爱好。' }, participants: [{ entityId: id }] }] });
  await h.runtime.refresh({ refreshMemory: false }); await h.runtime.setSelectedEntityIds([id]);
  await h.runtime.saveProfile(id, { name: '旧AI姓名', gender: '旧AI性别', background: '旧AI背景', notes: '人工补充' }, { manualFields: ['notes'] });
  h.runtime.requestAutomaticMaintenance({ chatId: CHAT_A, floorId, memoryId });
  await waitFor(() => calls === 1 && h.runtime.getState().active === null);
  assert.deepEqual(request.people[0].existingProfile, { name: '旧AI姓名', gender: '旧AI性别', background: '旧AI背景' });
  const profile = h.runtime.getState().profilesByEntityId[id];
  assert.equal(profile.name, '旧AI姓名'); assert.equal(profile.gender, '旧AI性别'); assert.equal(profile.background, '旧AI背景');
  assert.equal(profile.likes, '新的爱好'); assert.equal(profile.notes, '人工补充'); assert.equal(calls, 1);
});
