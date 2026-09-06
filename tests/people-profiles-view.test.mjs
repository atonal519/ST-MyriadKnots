import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeopleProfilesView } from '../src/ui/people-profiles-view.js';
import { createPeopleWorkspaceStore, createPeopleWorkspaceRuntime, PEOPLE_WORKSPACE_RECORD_ID } from '../src/v3/people-workspace.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHAT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.className = ''; this.textContent = ''; this.value = ''; this.open = false; this.disabled = false; this.tabIndex = 0; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  click() { if (this.disabled) return undefined; return this.listeners.click?.({ currentTarget: this }); }
  fire(name, extra = {}) { return this.listeners[name]?.({ currentTarget: this, preventDefault() {}, ...extra }); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelector(selector) { return flatten(this).find(node => selector === '.qqj-profile-tab.active' && node.className === 'qqj-profile-tab active') ?? null; }
  focus() { documentRef.activeElement = this; }
}
const documentRef = { activeElement: null, createElement: tag => new Node(tag) };
const flatten = node => [node, ...node.children.flatMap(flatten)];
const visible = node => flatten(node).map(item => item.textContent).filter(Boolean).join('|');
function person(entityId, name, selected, profile = null, recommended = false) {
  return { entityId, displayName: profile?.name || name, entityDisplayName: name, aliases: [`${name}别名`], selected, profiled: Boolean(profile), profile, recommended, appearanceCount: recommended ? 3 : 1 };
}
function runtimeHarness({ profile = null, profiles = null, selected = [A], failSave = false, generatedProfile = null, generateGate = null } = {}) {
  const initialProfiles = profiles ?? (profile ? { [A]: profile } : {});
  let state = { status: 'ready', chatId: CHAT, revision: 1, selectedEntityIds: [...selected], profilesByEntityId: initialProfiles,
    people: [person(A, '甲', selected.includes(A), initialProfiles[A] ?? null, true), person(B, '乙', selected.includes(B), initialProfiles[B] ?? null)], active: null,
    unprofiledSelectedCount: selected.filter(id => !initialProfiles[id]).length, lastError: null };
  const listeners = new Set(), calls = { select: [], save: [], generate: 0 };
  const emit = () => { for (const listener of listeners) listener(state); return state; };
  const runtime = {
    getState: () => state, refresh: async () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async setSelectedEntityIds(ids) { calls.select.push(ids); state = { ...state, selectedEntityIds: ids, people: state.people.map(item => ({ ...item, selected: ids.includes(item.entityId) })) }; return emit(); },
    async saveProfile(entityId, fields) {
      calls.save.push([entityId, structuredClone(fields)]); if (failSave) throw new Error('CAS失败');
      const saved = { entityId, ...fields, source: 'manual', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
      state = { ...state, profilesByEntityId: { ...state.profilesByEntityId, [entityId]: saved }, people: state.people.map(item => item.entityId === entityId ? { ...item, displayName: saved.name || item.entityDisplayName, profiled: true, profile: saved } : item), unprofiledSelectedCount: state.people.filter(item => item.selected && item.entityId !== entityId && !item.profiled).length }; return emit();
    },
    async generateMissingProfiles() {
      calls.generate += 1; if (generateGate) await generateGate;
      if (generatedProfile) {
        state = {
          ...state,
          profilesByEntityId: { ...state.profilesByEntityId, [A]: generatedProfile },
          people: state.people.map(item => item.entityId === A ? { ...item, displayName: generatedProfile.name || item.entityDisplayName, profiled: true, profile: generatedProfile } : item),
          unprofiledSelectedCount: 0,
        };
        emit();
      }
      return state;
    },
  };
  return { runtime, calls, get state() { return state; } };
}

async function waitFor(predicate, message = '等待条件超时') {
  const end = Date.now() + 1000;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail(message);
}
function trueRuntimeHarness() {
  const records = new Map(), calls = [], control = { gate: null, failNextPut: false };
  let identity = { chatId: CHAT, hostChatId: 'host-a', characterLocator: 'char.png', personaLocator: 'persona.png' };
  const client = {
    async get(collection, key) {
      calls.push(['get', collection, key]); const value = records.get(`${collection}/${key}`);
      if (!value) throw Object.assign(new Error('HTTP 404'), { status: 404 }); return structuredClone(value);
    },
    async put(collection, key, data, expectedRevision, { signal } = {}) {
      calls.push(['put', collection, key, expectedRevision]);
      if (control.gate) { const gate = control.gate; control.gate = null; await gate; }
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (control.failNextPut) { control.failNextPut = false; throw new Error('模拟保存失败'); }
      const mapKey = `${collection}/${key}`, previous = records.get(mapKey);
      if ((previous?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('HTTP 409'), { status: 409 });
      const envelope = { revision: expectedRevision + 1, data: structuredClone(data) }; records.set(mapKey, envelope); return structuredClone(envelope);
    },
  };
  const entities = [
    { id: A, entityType: 'person', displayName: '甲', aliases: [{ name: '甲别名' }], specialRole: 'none', firstSeenFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', lastSeenFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'established', recordStatus: 'active' },
    { id: B, entityType: 'person', displayName: '乙', aliases: [{ name: '乙别名' }], specialRole: 'none', firstSeenFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', lastSeenFloorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'established', recordStatus: 'active' },
  ];
  const reachable = { entities, floorMemories: [{ recordStatus: 'active', summary: { effectiveSource: 'ai', aiText: '甲与乙出现。' }, participants: [{ entityId: A }, { entityId: B }] }], baseline: null };
  const memoryState = { cseSubjects: [] };
  const runtime = createPeopleWorkspaceRuntime({
    store: createPeopleWorkspaceStore({ client }), session: { identity: () => structuredClone(identity) }, foundationRuntime: { getReachable: () => reachable },
    memoryRuntime: { getState: () => memoryState, refreshStatus: async () => memoryState }, generateUtilityTask: async () => ({ jsonData: { profiles: [] } }),
    sourcePermissions: { filterCandidates: ({ candidates }) => candidates }, contextProvider: () => ({ chat: [] }), now: () => new Date('2026-09-06T00:00:00.000Z'),
  });
  return {
    runtime, records, calls,
    blockNextPut() { let release; control.gate = new Promise(resolve => { release = resolve; }); return release; },
    failNextPut() { control.failNextPut = true; },
    switchChat(chatId) { identity = { ...identity, chatId, hostChatId: `host-${chatId}` }; runtime.invalidate(); },
  };
}

test('真实 activate 完成后不回画旧 loading，禁用整理不触发且更多选择仍可用', async () => {
  const h = trueRuntimeHarness(); await h.runtime.refresh();
  const container = new Node('main'), view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container); await view.activate();
  assert.equal(h.runtime.getState().status, 'ready');
  const generate = flatten(container).find(node => node.textContent === '整理基础资料'); assert.equal(generate.disabled, true); generate.click();
  assert.equal(h.calls.filter(call => call[0] === 'put').length, 0, '浏览器中的 disabled 按钮不会触发动作');
  flatten(container).find(node => node.textContent === '更多人物（2）').click();
  const choose = flatten(container).filter(node => node.textContent === '设为重要'); assert.equal(choose.length, 2); assert.equal(choose.every(node => node.disabled === false), true);
  choose[0].click(); await waitFor(() => h.runtime.getState().selectedEntityIds.includes(A));
  assert.equal(flatten(container).find(node => node.textContent === '设为重要')?.disabled, false, '再次绘制更多人物仍保持可选择');
});

test('千人页横向切换只显示一份常显资料，草稿跨人物保留且移出当前后选择邻位', async () => {
  const h = runtimeHarness({ selected: [A, B] }), container = new Node('main'); const view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container);
  assert.equal(flatten(container).filter(node => node.className === 'qqj-profile-card').length, 1);
  const tabs = flatten(container).filter(node => node.attributes.role === 'tab'); assert.deepEqual(tabs.map(node => node.textContent), ['甲', '乙']);
  assert.equal(tabs[0].attributes['aria-selected'], 'true'); assert.match(visible(container), /姓名.*甲.*别名.*甲别名/);
  assert.deepEqual(flatten(container).find(node => node.className === 'qqj-profile-summary').children.map(node => node.textContent), ['甲', '推荐', '待建档']);
  assert.deepEqual(flatten(container).find(node => node.className === 'qqj-profile-save-row').children.map(node => node.textContent), ['编辑资料', '移出关注']);
  flatten(container).find(node => node.textContent === '编辑资料').click();
  assert.deepEqual(flatten(container).find(node => node.className === 'qqj-profile-save-row').children.slice(0, 3).map(node => node.textContent), ['保存资料', '取消', '移出关注']);
  assert.equal(flatten(container).find(node => node.tag === 'input').value, '甲');
  const notes = flatten(container).filter(node => node.tag === 'textarea').at(-1); notes.value = '甲的未保存草稿'; notes.fire('input');
  tabs[1].click(); assert.match(visible(container), /姓名.*乙/); assert.equal(flatten(container).some(node => node.tag === 'input'), false);
  flatten(container).find(node => node.textContent === '编辑资料').click(); const bNotes = flatten(container).filter(node => node.tag === 'textarea').at(-1); bNotes.value = '取消的草稿'; bNotes.fire('input');
  flatten(container).find(node => node.textContent === '取消').click(); assert.doesNotMatch(visible(container), /取消的草稿/); assert.match(visible(container), /编辑资料/);
  flatten(container).find(node => node.textContent === '甲').click(); assert.equal(flatten(container).filter(node => node.tag === 'textarea').at(-1).value, '甲的未保存草稿');
  flatten(container).find(node => node.textContent === '移出关注').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.select.at(-1), [B]); assert.match(visible(container), /姓名.*乙/);
});

test('更多人物入口固定在顶部并切换为独立选择视图，零选择仍可进入', async () => {
  const h = runtimeHarness({ selected: [] }), container = new Node('main'); const view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container);
  assert.match(visible(container), /尚未选择重要人物.*更多人物（2）/); assert.equal(flatten(container).some(node => node.className === 'qqj-profile-card'), false);
  flatten(container).find(node => node.textContent === '更多人物（2）').click();
  assert.equal(flatten(container).filter(node => node.className === 'qqj-profile-picker').length, 1); assert.equal(flatten(container).filter(node => node.textContent === '设为重要').length, 2);
  flatten(container).find(node => node.textContent === '设为重要').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.select.at(-1), [A]); assert.match(visible(container), /已选重要.*移出关注/); assert.match(visible(container), /返回资料/);
  flatten(container).find(node => node.textContent === '返回资料').click(); assert.match(visible(container), /姓名.*甲/);
});

test('投影姓名别名只填表单不算建档，首次保存与主动清空都会调用正式保存', async () => {
  const h = runtimeHarness(), container = new Node('main'); const view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container);
  assert.equal(h.state.profilesByEntityId[A], undefined);
  flatten(container).find(node => node.textContent === '编辑资料').click();
  let controls = flatten(container).filter(node => ['input', 'textarea'].includes(node.tag));
  assert.equal(controls[0].value, '甲'); assert.equal(controls[1].value, '甲别名');
  controls.forEach(control => { control.value = ''; control.fire('input'); });
  flatten(container).find(node => node.textContent === '保存资料').click(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.save.length, 1); assert.deepEqual(h.calls.save[0][1], { name: '', aliases: '', background: '', appearance: '', personality: '', notes: '' });
  assert.match(visible(container), /已建档/);
});

test('已有资料无改动在 view 层零保存，失败则保留用户草稿与错误', async () => {
  const profile = { entityId: A, name: '人工甲', aliases: '', background: '', appearance: '', personality: '', notes: '已有说明', source: 'manual', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
  const h = runtimeHarness({ profile }), container = new Node('main'); const view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑资料').click();
  flatten(container).find(node => node.textContent === '保存资料').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.save.length, 0); assert.match(visible(container), /未修改内容/); assert.match(visible(container), /编辑资料/); assert.equal(flatten(container).some(node => node.tag === 'textarea'), false);
  const failing = runtimeHarness({ profile, failSave: true }), failedContainer = new Node('main'); createPeopleProfilesView({ runtime: failing.runtime, documentRef }).mount(failedContainer);
  flatten(failedContainer).find(node => node.textContent === '编辑资料').click();
  const notes = flatten(failedContainer).filter(node => node.tag === 'textarea').at(-1); notes.value = '失败也要保留'; notes.fire('input');
  flatten(failedContainer).find(node => node.textContent === '保存资料').click(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(flatten(failedContainer).filter(node => node.tag === 'textarea').at(-1).value, '失败也要保留'); assert.match(visible(failedContainer), /保存失败：CAS失败/);
});

test('整理动作只在存在未建档重要人物时可用且每次点击只调用一次 runtime', async () => {
  const h = runtimeHarness(), container = new Node('main'); createPeopleProfilesView({ runtime: h.runtime, documentRef }).mount(container);
  const button = flatten(container).find(node => node.textContent === '整理基础资料（1）'); assert.equal(button.disabled, false);
  button.click(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.generate, 1);
  const profile = { entityId: A, name: '甲', aliases: '', background: '', appearance: '', personality: '', notes: '', source: 'manual', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
  const complete = runtimeHarness({ profile }), completeContainer = new Node('main'); createPeopleProfilesView({ runtime: complete.runtime, documentRef }).mount(completeContainer);
  assert.equal(flatten(completeContainer).find(node => node.textContent === '整理基础资料')?.disabled, true);
});

test('整理完成会刷新未触碰表单，用户整理期间已输入的草稿则保持原样', async () => {
  const generated = { entityId: A, name: '模型甲', aliases: '新别名', background: '生成背景', appearance: '', personality: '', notes: '', source: 'generated', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
  const untouched = runtimeHarness({ generatedProfile: generated }), untouchedContainer = new Node('main');
  createPeopleProfilesView({ runtime: untouched.runtime, documentRef }).mount(untouchedContainer);
  flatten(untouchedContainer).find(node => node.textContent === '整理基础资料（1）').click();
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.match(visible(untouchedContainer), /姓名.*模型甲.*生成背景/);

  let release; const gate = new Promise(resolve => { release = resolve; });
  const editing = runtimeHarness({ generatedProfile: generated, generateGate: gate }), editingContainer = new Node('main');
  createPeopleProfilesView({ runtime: editing.runtime, documentRef }).mount(editingContainer);
  flatten(editingContainer).find(node => node.textContent === '编辑资料').click();
  flatten(editingContainer).find(node => node.textContent === '整理基础资料（1）').click();
  const name = flatten(editingContainer).find(node => node.tag === 'input'); name.value = '我正在填写'; name.fire('input');
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(flatten(editingContainer).find(node => node.tag === 'input').value, '我正在填写');
});

test('真实 runtime 与 view 完成修改保存、新建档、no-op 与失败就地反馈', async () => {
  const h = trueRuntimeHarness(); await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([A, B]);
  const container = new Node('main'), view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑资料').click();
  let notes = flatten(container).filter(node => node.tag === 'textarea').at(-1); notes.value = '人工说明'; notes.fire('input');
  flatten(container).find(node => node.textContent === '保存资料').click();
  assert.match(visible(container), /保存中…/);
  await waitFor(() => visible(container).includes('已保存'), '真实修改保存未完成');
  assert.equal(flatten(container).some(node => node.tag === 'textarea'), false, '保存成功回到阅读状态');
  let stored = h.records.get(`chat-${CHAT}/${PEOPLE_WORKSPACE_RECORD_ID}`); assert.equal(stored.data.profilesByEntityId[A].notes, '人工说明'); assert.equal(stored.data.profilesByEntityId[A].source, 'manual');
  const puts = h.calls.filter(call => call[0] === 'put').length;
  flatten(container).find(node => node.textContent === '编辑资料').click();
  flatten(container).find(node => node.textContent === '保存资料').click(); assert.match(visible(container), /未修改内容/);
  assert.equal(flatten(container).some(node => node.tag === 'textarea'), false, 'no-op 回到阅读状态');
  assert.equal(h.calls.filter(call => call[0] === 'put').length, puts, '已有资料 no-op 不写存储');

  flatten(container).find(node => node.textContent === '乙').click();
  flatten(container).find(node => node.textContent === '编辑资料').click();
  flatten(container).find(node => node.textContent === '保存资料').click(); await waitFor(() => visible(container).includes('已保存'), '投影资料首次保存未建档');
  stored = h.records.get(`chat-${CHAT}/${PEOPLE_WORKSPACE_RECORD_ID}`); assert.equal(stored.data.profilesByEntityId[B].name, '乙'); assert.equal(stored.data.profilesByEntityId[B].source, 'manual');
  h.failNextPut(); flatten(container).find(node => node.textContent === '编辑资料').click(); notes = flatten(container).filter(node => node.tag === 'textarea').at(-1); notes.value = '失败草稿'; notes.fire('input');
  flatten(container).find(node => node.textContent === '保存资料').click(); await waitFor(() => visible(container).includes('保存失败：模拟保存失败'));
  assert.equal(flatten(container).filter(node => node.tag === 'textarea').at(-1).value, '失败草稿'); assert.ok(flatten(container).find(node => node.textContent === '保存资料'));
});

test('真实保存跨人物及停用重开保持归属，切聊天后的迟到结果不清新草稿', async () => {
  const h = trueRuntimeHarness(); await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([A, B]);
  const container = new Node('main'), view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑资料').click();
  let release = h.blockNextPut(), notes = flatten(container).filter(node => node.tag === 'textarea').at(-1); notes.value = '甲等待保存'; notes.fire('input');
  flatten(container).find(node => node.textContent === '保存资料').click(); flatten(container).find(node => node.textContent === '乙').click();
  assert.equal(flatten(container).find(node => node.textContent === '编辑资料').disabled, true, '另一人物在真实保存未完成时显示忙状态'); view.deactivate(); release();
  await waitFor(() => h.records.get(`chat-${CHAT}/${PEOPLE_WORKSPACE_RECORD_ID}`)?.data.profilesByEntityId[A]?.notes === '甲等待保存');
  view.mount(container); await view.activate(); flatten(container).find(node => node.textContent === '编辑资料').click();
  notes = flatten(container).filter(node => node.tag === 'textarea').at(-1); notes.value = '乙未保存'; notes.fire('input');
  flatten(container).find(node => node.textContent === '甲').click(); assert.match(visible(container), /已保存/);
  flatten(container).find(node => node.textContent === '乙').click(); assert.equal(flatten(container).filter(node => node.tag === 'textarea').at(-1).value, '乙未保存');
  flatten(container).find(node => node.textContent === '甲').click();

  release = h.blockNextPut(); flatten(container).find(node => node.textContent === '编辑资料').click(); notes = flatten(container).filter(node => node.tag === 'textarea').at(-1); notes.value = '旧聊天迟到'; notes.fire('input');
  const oldPutCount = h.calls.filter(call => call[0] === 'put').length; flatten(container).find(node => node.textContent === '保存资料').click();
  await waitFor(() => h.calls.filter(call => call[0] === 'put').length > oldPutCount, '旧聊天保存未进入受控 PUT');
  h.switchChat(CHAT_B); await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([A]); view.render(h.runtime.getState()); flatten(container).find(node => node.textContent === '编辑资料').click();
  notes = flatten(container).filter(node => node.tag === 'textarea').at(-1); notes.value = '新聊天草稿'; notes.fire('input'); release();
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(flatten(container).filter(node => node.tag === 'textarea').at(-1).value, '新聊天草稿');
  assert.equal(h.records.get(`chat-${CHAT_B}/${PEOPLE_WORKSPACE_RECORD_ID}`).data.profilesByEntityId[A], undefined, '迟到旧保存不得写新聊天');
});
