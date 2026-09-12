import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeopleProfilesView } from '../src/ui/people-profiles-view.js';
import { createPeopleWorkspaceStore, createPeopleWorkspaceRuntime, PEOPLE_WORKSPACE_RECORD_ID } from '../src/v3/people-workspace.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHAT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

class Node {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.className = ''; this.textContent = ''; this.value = ''; this.open = false; this.disabled = false; this.tabIndex = 0; this.scrollLeft = 0; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  click() { if (this.disabled) return undefined; return this.listeners.click?.({ currentTarget: this }); }
  fire(name, extra = {}) { return this.listeners[name]?.({ currentTarget: this, preventDefault() {}, ...extra }); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelector(selector) { return flatten(this).find(node => selector === '.qqj-profile-tab.active' && node.className === 'qqj-profile-tab active') ?? null; }
  focus() { documentRef.activeElement = this; }
}
function dialogHarness() {
  let active = null; const confirms = [];
  return {
    dialog: {
      async confirm(options) { confirms.push(options); return true; },
      custom(options) { return new Promise(resolve => { active = { ...options, resolve }; }); },
      cancelTop() { if (!active) return false; const current = active; active = null; current.onClose?.(); current.resolve(null); return true; },
    },
    get active() { return active; },
    confirms,
    async submit() { const current = active; const value = await current.submit(); active = null; current.onClose?.(); current.resolve(value); return value; },
  };
}
const documentRef = { activeElement: null, createElement: tag => new Node(tag) };
function eventDocument() {
  const clicks = new Set();
  return {
    activeElement: null,
    createElement: tag => new Node(tag),
    addEventListener(name, handler) { if (name === 'click') clicks.add(handler); },
    removeEventListener(name, handler) { if (name === 'click') clicks.delete(handler); },
    click(event) { for (const handler of clicks) handler(event); },
    clickListenerCount: () => clicks.size,
  };
}
const flatten = node => [node, ...node.children.flatMap(flatten)];
const visible = node => flatten(node).map(item => item.textContent).filter(Boolean).join('|');
function person(entityId, name, selected, profile = null, appearanceCount = 1) {
  return { entityId, displayName: profile?.name || name, entityDisplayName: name, aliases: [`${name}别名`], selected, profiled: Boolean(profile), profile, appearanceCount };
}
function runtimeHarness({ profile = null, profiles = null, selected = [A], failSave = false, generatedProfile = null, generateGate = null, generationReport = null } = {}) {
  const initialProfiles = profiles ?? (profile ? { [A]: profile } : {});
  let state = { status: 'ready', chatId: CHAT, revision: 1, selectedEntityIds: [...selected], profilesByEntityId: initialProfiles,
    people: [person(A, '甲', selected.includes(A), initialProfiles[A] ?? null, 3), person(B, '乙', selected.includes(B), initialProfiles[B] ?? null)], active: null,
    unprofiledSelectedCount: selected.filter(id => !initialProfiles[id]).length, lastError: null };
  const listeners = new Set(), calls = { select: [], save: [], avatar: [], merge: [], delete: [], generate: 0, regenerate: [] };
  const emit = () => { for (const listener of listeners) listener(state); return state; };
  const runtime = {
    getState: () => state, refresh: async () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async setSelectedEntityIds(ids) { calls.select.push(ids); state = { ...state, selectedEntityIds: ids, people: state.people.map(item => ({ ...item, selected: ids.includes(item.entityId) })) }; return emit(); },
    async saveProfile(entityId, fields, options = {}) {
      calls.save.push([entityId, structuredClone(fields), structuredClone(options)]); if (failSave) throw new Error('CAS失败');
      const saved = { entityId, ...fields, manualFields: options.manualFields ?? [], source: 'manual', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
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
          ...(generationReport ? { lastGenerationReport: generationReport } : {}),
        };
        emit();
      }
      return state;
    },
    async regenerateProfile(entityId) { calls.regenerate.push(entityId); return emit(); },
    async saveAvatar(entityId, avatar) { calls.avatar.push([entityId, avatar]); state = { ...state, people: state.people.map(item => item.entityId === entityId ? { ...item, avatar } : item) }; return emit(); },
    async mergePeople(sourceEntityId, targetEntityId, profileSource) {
      calls.merge.push([sourceEntityId, targetEntityId, profileSource]);
      const source = state.people.find(item => item.entityId === sourceEntityId), target = state.people.find(item => item.entityId === targetEntityId);
      const adopted = profileSource === 'source' ? source : target;
      state = { ...state, selectedEntityIds: [...new Set(state.selectedEntityIds.map(id => id === sourceEntityId ? targetEntityId : id))],
        people: state.people.filter(item => item.entityId !== sourceEntityId).map(item => item.entityId === targetEntityId ? { ...item, selected: source.selected || target.selected, profile: adopted.profile, profiled: adopted.profiled, avatar: adopted.avatar } : item) };
      return emit();
    },
    async deletePerson(entityId) { calls.delete.push(entityId); state = { ...state, selectedEntityIds: state.selectedEntityIds.filter(id => id !== entityId), people: state.people.filter(item => item.entityId !== entityId) }; return emit(); },
  };
  return { runtime, calls, emitState(next) { state = next; return emit(); }, get state() { return state; } };
}

async function waitFor(predicate, message = '等待条件超时') {
  const end = Date.now() + 1000;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail(message);
}
const fieldControl = (container, label) => flatten(container).find(node => node.className === 'qqj-profile-field' && node.children[0]?.textContent === label)?.children.at(-1);
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
  assert.equal(flatten(container).filter(node => node.className === 'qqj-page-status').length, 1);
  assert.match(visible(container), /人物资料读取完成/);
  const generate = flatten(container).find(node => node.textContent === '整理待建档人物'); assert.equal(generate.disabled, true); generate.click();
  assert.equal(h.calls.filter(call => call[0] === 'put').length, 0, '浏览器中的 disabled 按钮不会触发动作');
  flatten(container).find(node => node.textContent === '更多人物（2）').click();
  assert.match(visible(container), /人物资料读取完成/, '切换人物选择视图后保留最近一次真实反馈');
  const choose = flatten(container).filter(node => node.textContent === '设为重要'); assert.equal(choose.length, 2); assert.equal(choose.every(node => node.disabled === false), true);
  choose[0].click(); await waitFor(() => h.runtime.getState().selectedEntityIds.includes(A));
  assert.equal(flatten(container).find(node => node.textContent === '设为重要')?.disabled, false, '再次绘制更多人物仍保持可选择');
});

test('千人页横向切换只显示一份常显资料，草稿跨人物保留且移出当前后选择邻位', async () => {
  const menuDocument = eventDocument();
  const h = runtimeHarness({ selected: [A, B] }), container = new Node('main'); const view = createPeopleProfilesView({ runtime: h.runtime, documentRef: menuDocument }); view.mount(container);
  assert.equal(flatten(container).filter(node => node.className === 'qqj-profile-card').length, 1);
  const tabs = flatten(container).filter(node => node.attributes.role === 'tab'); assert.deepEqual(tabs.map(node => node.textContent), ['甲', '乙']);
  assert.deepEqual(tabs.map(node => node.attributes.title), ['甲', '乙'], '截断显示仍保留完整姓名提示');
  assert.equal(tabs[0].attributes['aria-selected'], 'true'); assert.match(visible(container), /甲.*别名 · 甲别名/);
  const summary = flatten(container).find(node => node.className === 'qqj-profile-summary');
  assert.deepEqual(summary.children.map(node => node.className), ['qqj-profile-mark has-alias', 'qqj-profile-identity', 'qqj-profile-badges']);
  assert.match(summary.children[0].innerHTML, /<svg[\s\S]*?<path/, '档案标记应复用千千结自己的结形图标');
  assert.match(visible(summary.children[1]), /甲.*别名 · 甲别名/); assert.match(visible(summary.children[2]), /待建档/); assert.doesNotMatch(visible(container), /推荐/);
  assert.deepEqual(flatten(container).filter(node => node.className?.includes?.('qqj-profile-section')).map(node => node.children[0].textContent), [], '空资料板块不显示');
  assert.deepEqual(flatten(container).find(node => node.className === 'qqj-profile-menu-pop').children.map(node => node.textContent), ['整理当前资料', '编辑资料', '上传头像', '', '移出关注', '', '合并到其他人物', '删除人物']);
  const profileMenu = flatten(container).find(node => node.className === 'qqj-profile-menu');
  profileMenu.open = true; menuDocument.click({ target: profileMenu.children[0], composedPath: () => [profileMenu.children[0], profileMenu] }); assert.equal(profileMenu.open, true, '千人菜单内部点击不提前关闭');
  menuDocument.click({ target: container, composedPath: () => [container] }); assert.equal(profileMenu.open, false, '千人菜单点击外部后关闭');
  flatten(container).find(node => node.textContent === '编辑资料').click();
  assert.deepEqual(flatten(container).find(node => node.className === 'qqj-profile-save-row').children.slice(0, 3).map(node => node.textContent), ['保存资料', '取消', '移出关注']);
  assert.equal(fieldControl(container, '姓名').value, '甲');
  const notes = fieldControl(container, '补充资料'); notes.value = '甲的未保存草稿'; notes.fire('input');
  tabs[1].click(); assert.match(visible(container), /乙.*别名 · 乙别名/); assert.equal(flatten(container).some(node => node.className === 'settings-input'), false);
  flatten(container).find(node => node.textContent === '编辑资料').click(); const bNotes = fieldControl(container, '补充资料'); bNotes.value = '取消的草稿'; bNotes.fire('input');
  flatten(container).find(node => node.textContent === '取消').click(); assert.doesNotMatch(visible(container), /取消的草稿/); assert.match(visible(container), /编辑资料/);
  flatten(container).find(node => node.textContent === '甲').click(); assert.equal(fieldControl(container, '补充资料').value, '甲的未保存草稿');
  flatten(container).find(node => node.textContent === '移出关注').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.select.at(-1), [B]); assert.match(visible(container), /乙.*别名 · 乙别名/);
  view.deactivate(); assert.equal(menuDocument.clickListenerCount(), 0, '页面停用时清理外部点击监听');
});

test('千人人名横条同聊天同列表重绘保留位置，列表或聊天变化重置', () => {
  const h = runtimeHarness({ selected: [A, B] }), container = new Node('main');
  const view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container);
  let switcher = flatten(container).find(node => node.className === 'qqj-profile-switcher');
  switcher.scrollLeft = 73;
  flatten(switcher).find(node => node.textContent === '乙').click();
  switcher = flatten(container).find(node => node.className === 'qqj-profile-switcher');
  assert.equal(switcher.scrollLeft, 73); assert.match(visible(container), /乙.*别名 · 乙别名/);

  switcher.scrollLeft = 81;
  h.emitState({ ...h.state, revision: h.state.revision + 1 });
  switcher = flatten(container).find(node => node.className === 'qqj-profile-switcher');
  assert.equal(switcher.scrollLeft, 81, '同人物列表的后台通知应保留横向位置');
  flatten(container).find(node => node.textContent === '更多人物（0）').click();
  assert.equal(flatten(container).find(node => node.className === 'qqj-profile-switcher').scrollLeft, 81);
  flatten(container).find(node => node.textContent === '返回资料').click();
  assert.equal(flatten(container).find(node => node.className === 'qqj-profile-switcher').scrollLeft, 81);

  h.emitState({ ...h.state, people: [...h.state.people].reverse() });
  switcher = flatten(container).find(node => node.className === 'qqj-profile-switcher');
  assert.equal(switcher.scrollLeft, 0, '人物有序列表变化后不得继承旧位置');
  switcher.scrollLeft = 49;
  h.emitState({ ...h.state, chatId: CHAT_B });
  assert.equal(flatten(container).find(node => node.className === 'qqj-profile-switcher').scrollLeft, 0, '切聊天必须重置横向位置');
});

test('更多人物入口固定在顶部并切换为独立选择视图，零选择仍可进入', async () => {
  const h = runtimeHarness({ selected: [] }), container = new Node('main'); const view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container);
  assert.match(visible(container), /尚未选择重要人物.*更多人物（2）/); assert.equal(flatten(container).some(node => node.className === 'qqj-profile-card'), false);
  flatten(container).find(node => node.textContent === '更多人物（2）').click();
  assert.equal(flatten(container).filter(node => node.className === 'qqj-profile-picker').length, 1); assert.equal(flatten(container).filter(node => node.textContent === '设为重要').length, 2);
  flatten(container).find(node => node.textContent === '设为重要').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.select.at(-1), [A]); assert.match(visible(container), /已选重要.*移出关注/); assert.match(visible(container), /返回资料/);
  flatten(container).find(node => node.textContent === '返回资料').click(); assert.match(visible(container), /甲.*别名 · 甲别名/);
});

test('人物菜单以两个内联选择完成整档合并，目标变化时资料人名同步且不生成原生选择器', async () => {
  const profileA = { entityId: A, name: '甲档', aliases: '', notes: '甲资料', manualFields: ['notes'], source: 'manual', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
  const h = runtimeHarness({ profiles: { [A]: profileA }, selected: [A, B] }), dialogs = dialogHarness(), container = new Node('main');
  createPeopleProfilesView({ runtime: h.runtime, dialog: dialogs.dialog, documentRef }).mount(container);
  h.emitState({ ...h.state, people: [...h.state.people, person(C, '一位名字很长也必须完整可读的丙', false)] });
  flatten(container).find(node => node.textContent === '合并到其他人物').click();
  assert.equal(dialogs.active.title, '合并人物 · 甲档'); assert.match(visible(dialogs.active.content), /聊天楼.*历史摘要和 CSE.*统一归到合并目标/);
  assert.equal(flatten(dialogs.active.content).filter(node => node.tag === 'select').length, 0, '合并窗不得唤起系统原生选择器');
  let selects = flatten(dialogs.active.content).filter(node => node.className === 'qqj-inline-select');
  assert.equal(selects.length, 2); assert.equal(selects[0].value, B); assert.match(visible(selects[1]), /保留「乙」的资料与头像（尚未建档）/);
  selects[1].children[0].click(); selects[1].children[1].children[1].click(); assert.equal(selects[1].value, 'source');
  selects[0].children[0].click(); selects[0].children[1].children[1].click();
  selects = flatten(dialogs.active.content).filter(node => node.className === 'qqj-inline-select');
  assert.equal(selects[0].value, C); assert.equal(selects[1].value, 'source', '切换合并目标不得重置用户已选的资料来源');
  assert.match(visible(selects[1]), /保留「一位名字很长也必须完整可读的丙」的资料与头像（尚未建档）/);
  await dialogs.submit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.merge, [[A, C, 'source']]); assert.match(visible(container), /人物已合并.*历史摘要与 CSE 归属已汇集/);
});

test('人物菜单删除继续复用现有确认弹窗并说明历史不会删除', async () => {
  const h = runtimeHarness({ selected: [A, B] }), dialogs = dialogHarness(), container = new Node('main');
  createPeopleProfilesView({ runtime: h.runtime, dialog: dialogs.dialog, documentRef }).mount(container);
  flatten(container).find(node => node.textContent === '删除人物').click(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialogs.confirms.length, 1); assert.equal(dialogs.confirms[0].title, '删除人物 · 甲'); assert.equal(dialogs.confirms[0].confirmText, '删除人物');
  assert.match(dialogs.confirms[0].body, /删除该人物的千人档案、头像和重要人物选择/); assert.match(dialogs.confirms[0].note, /聊天楼、历史摘要和 CSE 记录不会删除/);
  assert.deepEqual(h.calls.delete, [A]);
});

test('投影姓名别名只填表单不算建档，首次保存与主动清空都会调用正式保存', async () => {
  const h = runtimeHarness(), container = new Node('main'); const view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container);
  assert.equal(h.state.profilesByEntityId[A], undefined);
  flatten(container).find(node => node.textContent === '编辑资料').click();
  const controls = flatten(container).filter(node => node.className === 'settings-input');
  assert.equal(fieldControl(container, '姓名').value, '甲'); assert.equal(fieldControl(container, '别名').value, '甲别名');
  controls.forEach(control => { control.value = ''; control.fire('input'); });
  flatten(container).find(node => node.textContent === '保存资料').click(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.save.length, 1); assert.equal(Object.values(h.calls.save[0][1]).every(value => value === ''), true); assert.deepEqual(h.calls.save[0][2].manualFields.sort(), ['aliases', 'name']);
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
  const notes = fieldControl(failedContainer, '补充资料'); notes.value = '失败也要保留'; notes.fire('input');
  flatten(failedContainer).find(node => node.textContent === '保存资料').click(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fieldControl(failedContainer, '补充资料').value, '失败也要保留'); assert.match(visible(failedContainer), /保存失败：CAS失败/);
});

test('基础资料四项按紧凑行分组且空字段隐藏；头像弹窗裁剪独立保存并保留文字草稿', async () => {
  const profile = { entityId: A, name: '无别名人物', aliases: '', gender: '女', age: '28', birthday: '3月8日', species: '人类', background: '旧背景', appearance: '', personality: '', notes: '旧补充', source: 'manual', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
  const h = runtimeHarness({ profile }), canvasDraws = [];
  const avatarDocument = {
    activeElement: null,
    createElement(tag) {
      if (tag !== 'canvas') return new Node(tag);
      return { width: 0, height: 0, getContext: () => ({ clearRect() {}, drawImage(...args) { canvasDraws.push(args); } }), toDataURL: () => 'data:image/webp;base64,AAAA' };
    },
  };
  let revoked = 0, sequence = 0;
  const urlApi = { createObjectURL: () => `blob:${++sequence}`, revokeObjectURL: () => { revoked += 1; } };
  const imageFactory = () => ({ naturalWidth: 800, naturalHeight: 600, onload: null, onerror: null, _src: '', set src(value) { this._src = value; if (value) queueMicrotask(() => this.onload?.()); }, get src() { return this._src; } });
  const dialogs = dialogHarness();
  const container = new Node('main'), view = createPeopleProfilesView({ runtime: h.runtime, dialog: dialogs.dialog, documentRef: avatarDocument, imageFactory, urlApi }); view.mount(container);
  assert.equal(flatten(container).find(node => String(node.className).startsWith('qqj-profile-mark')).className, 'qqj-profile-mark', '无别名头像保持方框标记');
  assert.equal(flatten(container).some(node => node.className === 'qqj-profile-alias'), false, '无别名不保留空行');
  assert.deepEqual(flatten(container).filter(node => String(node.className).includes('qqj-profile-section')).map(node => node.children[0].textContent), ['基础信息', '身份']);
  const basic = flatten(container).find(node => node.className.includes('qqj-profile-section-basic'));
  assert.deepEqual(basic.children.slice(1).map(node => node.className), ['qqj-profile-read-row qqj-profile-read-gender', 'qqj-profile-read-row qqj-profile-read-age', 'qqj-profile-read-row qqj-profile-read-birthday', 'qqj-profile-read-row qqj-profile-read-species', 'qqj-profile-read-row qqj-profile-read-notes']);
  assert.doesNotMatch(visible(container), /NSFW/);
  flatten(container).find(node => node.textContent === '编辑资料').click(); const notes = fieldControl(container, '补充资料'); notes.value = '尚未保存的文字'; notes.fire('input');
  let file = flatten(container).find(node => node.className === 'qqj-avatar-file'); file.fire('change', { target: { files: [{ type: 'image/png', size: 1024 }], value: 'chosen' } }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialogs.active.title, '裁剪头像'); assert.ok(flatten(dialogs.active.content).find(node => node.className === 'qqj-avatar-crop-frame')); assert.equal(fieldControl(container, '补充资料').value, '尚未保存的文字');
  dialogs.dialog.cancelTop(); assert.equal(revoked, 1); assert.equal(h.calls.avatar.length, 0);
  file = flatten(container).find(node => node.className === 'qqj-avatar-file'); file.fire('change', { target: { files: [{ type: 'image/webp', size: 2048 }], value: 'chosen' } }); await new Promise(resolve => setImmediate(resolve));
  await dialogs.submit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.avatar[0], [A, 'data:image/webp;base64,AAAA']); assert.equal(canvasDraws.length, 1); assert.equal(fieldControl(container, '补充资料').value, '尚未保存的文字'); assert.equal(revoked, 2);
  view.deactivate();
});

test('整理动作只在存在未建档重要人物时可用且每次点击只调用一次 runtime', async () => {
  const h = runtimeHarness(), container = new Node('main'); createPeopleProfilesView({ runtime: h.runtime, documentRef }).mount(container);
  const button = flatten(container).find(node => node.textContent === '整理待建档人物（1）'); assert.equal(button.disabled, false);
  button.click(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.generate, 1);
  const profile = { entityId: A, name: '甲', aliases: '', background: '', appearance: '', personality: '', notes: '', source: 'manual', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
  const complete = runtimeHarness({ profile }), completeContainer = new Node('main'); createPeopleProfilesView({ runtime: complete.runtime, documentRef }).mount(completeContainer);
  assert.equal(flatten(completeContainer).find(node => node.textContent === '整理待建档人物')?.disabled, true);

  const partial = runtimeHarness({ generatedProfile: { entityId: A, name: '甲', aliases: '', background: '', appearance: '', personality: '', notes: '', source: 'generated', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' }, generationReport: { requested: 3, saved: 1, missing: 1, conflicts: 1, invalid: 0, unknown: 1, skipped: 0 } });
  const partialContainer = new Node('main'); createPeopleProfilesView({ runtime: partial.runtime, documentRef }).mount(partialContainer);
  flatten(partialContainer).find(node => node.textContent === '整理待建档人物（1）').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(visible(partialContainer), /保存 1\/3 位；遗漏 1 位；冲突 1 位；未知目标 1 项/);
  flatten(partialContainer).find(node => node.textContent === '移出关注').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(visible(partialContainer), /移出关注人物完成/);
  assert.doesNotMatch(visible(partialContainer), /保存 1\/3 位/, '后续非整理操作不得复用旧批次报告');
});

test('整理完成会刷新未触碰表单，用户整理期间已输入的草稿则保持原样', async () => {
  const generated = { entityId: A, name: '模型甲', aliases: '新别名', background: '生成背景', appearance: '', personality: '', notes: '', source: 'generated', createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
  const untouched = runtimeHarness({ generatedProfile: generated }), untouchedContainer = new Node('main');
  createPeopleProfilesView({ runtime: untouched.runtime, documentRef }).mount(untouchedContainer);
  flatten(untouchedContainer).find(node => node.textContent === '整理待建档人物（1）').click();
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.match(visible(untouchedContainer), /模型甲.*生成背景/);

  let release; const gate = new Promise(resolve => { release = resolve; });
  const editing = runtimeHarness({ generatedProfile: generated, generateGate: gate }), editingContainer = new Node('main');
  createPeopleProfilesView({ runtime: editing.runtime, documentRef }).mount(editingContainer);
  flatten(editingContainer).find(node => node.textContent === '编辑资料').click();
  flatten(editingContainer).find(node => node.textContent === '整理待建档人物（1）').click();
  const name = fieldControl(editingContainer, '姓名'); name.value = '我正在填写'; name.fire('input');
  release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fieldControl(editingContainer, '姓名').value, '我正在填写');
});

test('真实 runtime 与 view 完成修改保存、新建档、no-op 与失败就地反馈', async () => {
  const h = trueRuntimeHarness(); await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([A, B]);
  const container = new Node('main'), view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑资料').click();
  let notes = fieldControl(container, '补充资料'); notes.value = '人工说明'; notes.fire('input');
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
  h.failNextPut(); flatten(container).find(node => node.textContent === '编辑资料').click(); notes = fieldControl(container, '补充资料'); notes.value = '失败草稿'; notes.fire('input');
  flatten(container).find(node => node.textContent === '保存资料').click(); await waitFor(() => visible(container).includes('保存失败：模拟保存失败'));
  assert.equal(fieldControl(container, '补充资料').value, '失败草稿'); assert.ok(flatten(container).find(node => node.textContent === '保存资料'));
});

test('真实保存跨人物及停用重开保持归属，切聊天后的迟到结果不清新草稿', async () => {
  const h = trueRuntimeHarness(); await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([A, B]);
  const container = new Node('main'), view = createPeopleProfilesView({ runtime: h.runtime, documentRef }); view.mount(container);
  flatten(container).find(node => node.textContent === '编辑资料').click();
  let release = h.blockNextPut(), notes = fieldControl(container, '补充资料'); notes.value = '甲等待保存'; notes.fire('input');
  flatten(container).find(node => node.textContent === '保存资料').click(); flatten(container).find(node => node.textContent === '乙').click();
  assert.equal(flatten(container).find(node => node.textContent === '编辑资料').disabled, true, '另一人物在真实保存未完成时显示忙状态'); view.deactivate(); release();
  await waitFor(() => h.records.get(`chat-${CHAT}/${PEOPLE_WORKSPACE_RECORD_ID}`)?.data.profilesByEntityId[A]?.notes === '甲等待保存');
  view.mount(container); await view.activate(); flatten(container).find(node => node.textContent === '编辑资料').click();
  notes = fieldControl(container, '补充资料'); notes.value = '乙未保存'; notes.fire('input');
  flatten(container).find(node => node.textContent === '甲').click(); assert.match(visible(container), /已保存/);
  flatten(container).find(node => node.textContent === '乙').click(); assert.equal(fieldControl(container, '补充资料').value, '乙未保存');
  flatten(container).find(node => node.textContent === '甲').click();

  release = h.blockNextPut(); flatten(container).find(node => node.textContent === '编辑资料').click(); notes = fieldControl(container, '补充资料'); notes.value = '旧聊天迟到'; notes.fire('input');
  const oldPutCount = h.calls.filter(call => call[0] === 'put').length; flatten(container).find(node => node.textContent === '保存资料').click();
  await waitFor(() => h.calls.filter(call => call[0] === 'put').length > oldPutCount, '旧聊天保存未进入受控 PUT');
  h.switchChat(CHAT_B); await h.runtime.refresh(); await h.runtime.setSelectedEntityIds([A]); view.render(h.runtime.getState()); flatten(container).find(node => node.textContent === '编辑资料').click();
  notes = fieldControl(container, '补充资料'); notes.value = '新聊天草稿'; notes.fire('input'); release();
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fieldControl(container, '补充资料').value, '新聊天草稿');
  assert.equal(h.records.get(`chat-${CHAT_B}/${PEOPLE_WORKSPACE_RECORD_ID}`).data.profilesByEntityId[A], undefined, '迟到旧保存不得写新聊天');
});
