import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRuntimeRunner } from '../src/runtime-runner.js';

class Node {
  constructor(tagName = '') {
    this.tagName = tagName; this.children = []; this.events = {}; this.style = {}; this.hidden = false; this.offsetParent = {};
    this.dataset = {}; this.attributes = {}; this.className = ''; this.disabled = false;
    this.classList = { toggle: (name, active) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); active ? names.add(name) : names.delete(name); this.className = [...names].join(' '); } };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; this._text = undefined; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  fire(name, event = {}) { for (const fn of this.events[name] || []) fn({ currentTarget: this, target: this, ...event }); }
  focus() { this.focused = true; }
  descendants() { return this.children.flatMap(item => item instanceof Node ? [item, ...item.descendants()] : []); }
  querySelectorAll(selector) {
    const nodes = this.descendants();
    if (selector === 'button') return nodes.filter(item => item.tagName === 'button');
    if (selector === 'button,input,select,textarea,[href],[tabindex]:not([tabindex="-1"])') return nodes.filter(item => ['button', 'input', 'select', 'textarea'].includes(item.tagName));
    if (selector.startsWith('[data-')) { const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); return nodes.filter(item => Object.hasOwn(item.dataset, key)); }
    if (selector.startsWith('.')) { const names = selector.slice(1).split('.'); return nodes.filter(item => names.every(name => item.className.split(/\s+/).includes(name))); }
    return [];
  }
  querySelector(selector) { return this.nodes?.[selector] || this.querySelectorAll(selector)[0] || null; }
  get textContent() { return this._text ?? this.children.map(item => item?.textContent ?? '').join(''); }
  set textContent(value) { this._text = String(value); }
  set innerHTML(value) { this.markup = String(value); this.children = []; }
  get innerHTML() { return this.markup || ''; }
  attachShadow() {
    const root = new Node();
    root.nodes = { '.view': new Node(), '.status-label': new Node(), '.status-meta': new Node(), '.status-dot': new Node(), '.close': new Node('button'), '.settings-btn': new Node('button') };
    this.shadowRoot = root; return root;
  }
}

const U = '123e4567-e89b-42d3-a456-426614174000';
const C = '223e4567-e89b-42d3-a456-426614174001';
const pending = { id: `qqj-initial-v1:${'a'.repeat(64)}`, value: '<img src=x onerror=alert(1)>待确认', reason: '证据还不够稳定', proposedLayer: 'interpretations', sourceRefs: [{ kind: 'chat' }] };
const authorityState = (relationStatus = 'uninitialized', pendingItems = [pending]) => ({
  status: 'route_ready', chatId: '323e4567-e89b-42d3-a456-426614174002',
  people: { status: 'ready', confirmed: [{ identityId: C, displayName: '林岚', selection: { status: 'selected' } }], candidate: [], shelved: [] },
  peopleFoundation: {
    status: 'ready', state: { personaId: U, activeMemberIds: [C], initialGeneration: { schemaVersion: 1, status: relationStatus, completedMemberIds: relationStatus === 'ready' ? [C] : [] } },
    profiles: [
      { identityId: C, subject: 'character', displayName: '旧 profile 名不作为姓名真相', basicFields: { appearance: { value: '银发', provenance: 'source', sourceRefs: [{ kind: 'card' }] }, personality: { value: '寡言', provenance: 'user', sourceRefs: [] }, abilities: { value: '维护机关', provenance: 'source', sourceRefs: [{ kind: 'card' }] }, likes: { value: '雨声', provenance: 'user', sourceRefs: [] }, dislikes: { value: '失信', provenance: 'source', sourceRefs: [{ kind: 'worldbook' }] }, principles: { value: '守诺', provenance: 'source', sourceRefs: [{ kind: 'worldbook' }] }, relationships: { value: '郑柠：亲生妹妹；U：自幼相识的至交', provenance: 'source', sourceRefs: [{ kind: 'worldbook' }] } }, dynamicFields: { personalityState: { value: '在压力下更为谨慎', provenance: 'ai', sourceRefs: [{ kind: 'chat' }] }, currentGoals: { value: '修复钟楼机关', provenance: 'user', sourceRefs: [] }, currentSecrets: { value: '<秘密不会成为 HTML>', provenance: 'source', sourceRefs: [{ kind: 'worldbook' }] }, wellbeing: { value: '旧伤仍限制行动', provenance: 'ai', sourceRefs: [{ kind: 'chat' }] } }, sourceFacts: [{ value: '<b>不会作为 HTML</b>', sourceRefs: [{ kind: 'card' }], relationToIdentityId: U }], interpretations: [{ value: '逐渐愿意坦白', sourceRefs: [{ kind: 'chat' }] }], pendingReview: pendingItems },
    ],
  },
  initialRelations: { schemaVersion: 1, status: relationStatus, completedMemberIds: relationStatus === 'ready' ? [C] : [] },
});

const multiAuthority = (count = 4, chatId = '423e4567-e89b-42d3-a456-426614174002') => {
  const base = authorityState('ready', []), template = base.peopleFoundation.profiles[0], ids = [];
  base.chatId = chatId; base.people.confirmed = []; base.peopleFoundation.profiles = [];
  for (let index = 0; index < count; index += 1) {
    const identityId = `${(index + 3).toString(16)}23e4567-e89b-42d3-a456-42661417400${index}`; ids.push(identityId);
    base.people.confirmed.push({ identityId, displayName: `人物${index + 1}`, selection: { status: 'selected' } });
    base.peopleFoundation.profiles.push({ ...structuredClone(template), identityId, displayName: `旧名${index + 1}`, dynamicFields: { ...structuredClone(template.dynamicFields), currentGoals: { value: `目标${index + 1}`, provenance: 'ai', sourceRefs: [{ kind: 'chat' }] } }, pendingReview: [] });
  }
  base.peopleFoundation.state.activeMemberIds = ids; base.peopleFoundation.state.initialGeneration.completedMemberIds = ids; base.initialRelations.completedMemberIds = ids;
  return { authority: base, ids };
};

function documentHarness() {
  const hosts = new Map();
  const documentRef = {
    activeElement: null,
    body: { append(node) { hosts.set(node.id, node); } },
    getElementById: id => hosts.get(id) || null,
    addEventListener() {},
    createElement: tag => new Node(tag),
  };
  globalThis.document = documentRef;
  return documentRef;
}

const settle = async () => { for (let index = 0; index < 6; index += 1) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('生产 bootstrap 打开只调用一次权威 loadState，不并行读取旧 formal/people', async () => {
  const { bootstrap } = await import('../dist/index.js?people-authority=1');
  const documentRef = documentHarness(); let loads = 0, formalReads = 0, peopleReads = 0;
  const instance = bootstrap({ documentRef, loadState: async () => { loads += 1; return authorityState('ready'); }, formal: { getFormalState: async () => { formalReads += 1; } }, people: { getPeople: async () => { peopleReads += 1; } }, wandInstaller() {} });
  instance.show(); await settle();
  assert.equal(loads, 1); assert.equal(formalReads, 0); assert.equal(peopleReads, 0);
  assert.match(instance.host.shadowRoot.nodes['.view'].textContent, /林岚/); assert.doesNotMatch(instance.host.shadowRoot.nodes['.view'].textContent, /旅人|旧 profile 名/);
});

test('千人档案只展示基础与动态字段，旧三板块及底部人物池不再渲染', async () => {
  const { bootstrap } = await import('../dist/index.js?people-render=1');
  const documentRef = documentHarness();
  const instance = bootstrap({ documentRef, wandInstaller() {}, reviewActions: { itemDigest: async () => `sha256:${'d'.repeat(64)}`, resolvePendingReview: async () => ({ status: 'ready' }) } });
  instance.setState(authorityState('ready'));
  const view = instance.host.shadowRoot.nodes['.view'];
  assert.match(view.textContent, /基础信息/); assert.match(view.textContent, /姓名林岚/); assert.match(view.textContent, /外貌银发/); assert.match(view.textContent, /性格寡言/); assert.match(view.textContent, /性别未提及/);
  assert.match(view.textContent, /能力维护机关/); assert.match(view.textContent, /原则守诺/); assert.match(view.textContent, /喜好雨声/); assert.match(view.textContent, /厌恶失信/);
  assert.match(view.textContent, /人际关系郑柠：亲生妹妹；U：自幼相识的至交/); assert.equal(view.querySelectorAll('.basic-field').length, 12);
  const rows = view.querySelectorAll('.basic-row'); assert.equal(rows.length, 5); assert.deepEqual(rows.map(row => row.children.length), [3, 3, 3, 2, 1]);
  assert.match(rows[0].textContent, /^姓名林岚性别未提及年龄未提及$/); assert.match(rows[1].textContent, /^外貌银发角色卡性格寡言用户填写身份未提及$/);
  assert.match(rows[2].textContent, /^能力维护机关角色卡原则守诺世界书NSFW 喜好未提及$/); assert.match(rows[3].textContent, /^喜好雨声用户填写厌恶失信世界书$/); assert.equal(rows[3].className.includes('basic-preference-row'), true);
  assert.match(rows[4].textContent, /^人际关系郑柠：亲生妹妹；U：自幼相识的至交世界书$/); assert.equal(rows[4].className.includes('basic-relationships-row'), true);
  assert.match(view.textContent, /当前状态/); assert.match(view.textContent, /当前性格状态在压力下更为谨慎稳定聊天/); assert.match(view.textContent, /当前目标修复钟楼机关用户填写/); assert.match(view.textContent, /当前处境未提及/); assert.match(view.textContent, /<秘密不会成为 HTML>/);
  assert.equal(view.querySelectorAll('.dynamic-field').length, 6); const dynamicRows = view.querySelectorAll('.dynamic-row'); assert.deepEqual(dynamicRows.map(row => row.children.length), [1, 2, 1, 2]);
  assert.doesNotMatch(view.textContent, /来源事实|AI 归纳|需要确认|管理人物池/); assert.equal(view.querySelectorAll('.pending-section').length, 0); assert.equal(view.querySelectorAll('.people-pool').length, 0);
  const tabs = view.querySelectorAll('.profile-tab'); assert.equal(tabs.length, 1); assert.doesNotMatch(view.textContent, /旅人|tag-u/);
  assert.doesNotMatch(view.textContent, /<b>不会作为 HTML<\/b>|<img src=x onerror=alert\(1\)>待确认/); assert.match(view.textContent, /<秘密不会成为 HTML>/);
  assert.deepEqual(view.querySelector('.profile-tools').children.map(button => button.textContent), ['更多', '因缘簿']);
  assert.equal(view.innerHTML, '');
});

test('生产 dist 将动态 memory 来源明确显示为柏宝书记忆', async () => {
  const { bootstrap } = await import('../dist/index.js?people-memory-source=1');
  const documentRef = documentHarness(), authority = authorityState('ready');
  authority.peopleFoundation.profiles[0].dynamicFields.wellbeing = { value: '旧伤仍限制行动', provenance: 'ai', sourceRefs: [{ kind: 'memory' }] };
  const instance = bootstrap({ documentRef, wandInstaller() {} });
  instance.setState(authority);
  assert.match(instance.host.shadowRoot.nodes['.view'].textContent, /当前身心状态旧伤仍限制行动柏宝书记忆/);
  assert.match(await readFile(new URL('../dist/index.js', import.meta.url), 'utf8'), /柏宝书记忆/);
});

test('基础信息提取与编辑按钮有进行中/成功反馈，姓名走 Registry、六字段走 profile 动作', async () => {
  const { bootstrap } = await import('../dist/index.js?people-basic=1');
  const documentRef = documentHarness(); let authority = authorityState('ready'), extracts = 0, saves = [], renames = [];
  const instance = bootstrap({ documentRef, wandInstaller() {}, loadState: async () => authority, people: { editDisplayName: async options => { renames.push(options); return { status: 'ready' }; } }, initialRelations: {
    extractBasicInfo: async () => { extracts += 1; authority.peopleFoundation.profiles[0].basicFields.gender = { value: '女', provenance: 'source', sourceRefs: [{ kind: 'card' }] }; return { status: 'ready', acceptedFields: 1 }; },
    saveBasicField: async options => { saves.push(options); authority.peopleFoundation.profiles[0].basicFields[options.field] = { value: options.value, provenance: 'user', sourceRefs: [] }; return { status: 'ready' }; },
  } });
  instance.show(); await settle(); const view = instance.host.shadowRoot.nodes['.view'];
  view.querySelector('.basic-info-actions').querySelectorAll('button')[0].fire('click'); assert.match(view.textContent, /正在提取/); await settle(); assert.equal(extracts, 1); assert.match(view.textContent, /提取完成/); assert.match(view.textContent, /性别女/);
  view.querySelector('.basic-info-actions').querySelectorAll('button')[1].fire('click');
  const editRows = view.querySelectorAll('.basic-row'); assert.deepEqual(editRows.map(row => row.children.length), [3, 3, 3, 2, 1]); assert.equal(editRows[3].className.includes('basic-preference-row'), true); assert.equal(editRows[4].className.includes('basic-relationships-row'), true);
  const fields = view.querySelectorAll('[data-basic-field]'), name = fields.find(item => item.dataset.basicField === 'name'), age = fields.find(item => item.dataset.basicField === 'age'), abilities = fields.find(item => item.dataset.basicField === 'abilities'), likes = fields.find(item => item.dataset.basicField === 'likes'), dislikes = fields.find(item => item.dataset.basicField === 'dislikes'), principles = fields.find(item => item.dataset.basicField === 'principles'), relationships = fields.find(item => item.dataset.basicField === 'relationships');
  name.value = '林岚新名'; age.value = '二十余岁'; abilities.value = '开锁'; likes.value = '旧书'; dislikes.value = ''; principles.value = '不失约'; relationships.value = '郑柠：妹妹'; view.querySelector('.basic-edit-actions').querySelectorAll('button')[0].fire('click'); await settle();
  assert.deepEqual(renames, [{ identityId: C, displayName: '林岚新名' }]);
  for (const [field, value] of [['age', '二十余岁'], ['abilities', '开锁'], ['likes', '旧书'], ['dislikes', ''], ['principles', '不失约'], ['relationships', '郑柠：妹妹']]) assert.equal(saves.some(item => item.field === field && item.value === value), true);
  assert.match(view.textContent, /基础信息已保存/);
});

test('基础信息反馈区分 AI 合法空结果与非空全拒', async () => {
  const { bootstrap } = await import('../dist/index.js?people-basic-empty-vs-rejected=1');
  const documentRef = documentHarness(), authority = authorityState('ready');
  const results = [
    { status: 'ready', acceptedFields: 0, rejectedFields: 0, emptyResult: true, zeroWrite: true },
    { status: 'ready', acceptedFields: 0, rejectedFields: 2, emptyResult: false, zeroWrite: true },
  ];
  const instance = bootstrap({ documentRef, wandInstaller() {}, loadState: async () => authority, initialRelations: { extractBasicInfo: async () => results.shift() } });
  instance.show(); await settle(); const view = instance.host.shadowRoot.nodes['.view'];
  view.querySelector('.basic-info-actions').querySelectorAll('button')[0].fire('click'); await settle();
  assert.match(view.textContent, /没有发现可可靠填写的新信息/); assert.doesNotMatch(view.textContent, /格式未能采用/);
  view.querySelector('.basic-info-actions').querySelectorAll('button')[0].fire('click'); await settle();
  assert.match(view.textContent, /AI 返回了 2 项，但格式未能采用/); assert.match(view.textContent, /原有基础信息保持不变/);
});

test('当前状态固定六项布局、更新与用户编辑保存均为单 C 动作', async () => {
  const { bootstrap } = await import('../dist/index.js?people-dynamic=1');
  const documentRef = documentHarness(); let authority = authorityState('ready'), updates = 0; const saves = [];
  const instance = bootstrap({ documentRef, wandInstaller() {}, loadState: async () => authority, initialRelations: {
    updateDynamicFields: async options => { updates += 1; assert.deepEqual(options, { identityId: C }); authority.peopleFoundation.profiles[0].dynamicFields.currentSituation = { value: '守城压力持续', provenance: 'ai', sourceRefs: [{ kind: 'chat' }] }; return { status: 'ready', acceptedFields: 1, rejectedFields: 0 }; },
    saveDynamicField: async options => { saves.push(options); if (options.value) authority.peopleFoundation.profiles[0].dynamicFields[options.field] = { value: options.value, provenance: 'user', sourceRefs: [] }; else delete authority.peopleFoundation.profiles[0].dynamicFields[options.field]; return { status: 'ready' }; },
  } });
  instance.show(); await settle(); const view = instance.host.shadowRoot.nodes['.view'];
  assert.deepEqual(view.querySelectorAll('.dynamic-row').map(row => row.children.length), [1, 2, 1, 2]);
  view.querySelector('.dynamic-info-actions').querySelectorAll('button')[0].fire('click'); assert.match(view.textContent, /正在更新动态状态/); await settle();
  assert.equal(updates, 1); assert.match(view.textContent, /更新完成，采用了 1 项动态状态/); assert.match(view.textContent, /当前处境守城压力持续/);
  view.querySelector('.dynamic-info-actions').querySelectorAll('button')[1].fire('click');
  assert.deepEqual(view.querySelectorAll('.dynamic-row').map(row => row.children.length), [1, 2, 1, 2]); const fields = view.querySelectorAll('[data-dynamic-field]'); assert.equal(fields.length, 6);
  fields.find(item => item.dataset.dynamicField === 'currentSituation').value = '用户填写的新处境'; fields.find(item => item.dataset.dynamicField === 'currentSecrets').value = ''; fields.find(item => item.dataset.dynamicField === 'stableChanges').value = '已稳定养成先观察的习惯';
  view.querySelector('.dynamic-edit-actions').querySelectorAll('button')[0].fire('click'); await settle();
  for (const [field, value] of [['currentSituation', '用户填写的新处境'], ['currentSecrets', ''], ['stableChanges', '已稳定养成先观察的习惯']]) assert.equal(saves.some(item => item.identityId === C && item.field === field && item.value === value), true);
  assert.match(view.textContent, /当前状态已保存/); assert.match(view.textContent, /用户填写内容不会被 AI 更新覆盖/);
});

test('当前状态反馈区分合法空结果、非空全拒与失败', async () => {
  const { bootstrap } = await import('../dist/index.js?people-dynamic-feedback=1');
  const documentRef = documentHarness(), authority = authorityState('ready');
  const results = [
    { status: 'ready', acceptedFields: 0, rejectedFields: 0, emptyResult: true, zeroWrite: true },
    { status: 'ready', acceptedFields: 0, rejectedFields: 2, emptyResult: false, zeroWrite: true },
    { status: 'storage_error' },
  ];
  const instance = bootstrap({ documentRef, wandInstaller() {}, loadState: async () => authority, initialRelations: { updateDynamicFields: async () => results.shift() } });
  instance.show(); await settle(); const view = instance.host.shadowRoot.nodes['.view'];
  view.querySelector('.dynamic-info-actions').querySelectorAll('button')[0].fire('click'); await settle(); assert.match(view.textContent, /没有发现可可靠填写的当前状态/);
  view.querySelector('.dynamic-info-actions').querySelectorAll('button')[0].fire('click'); await settle(); assert.match(view.textContent, /AI 返回了 2 项动态状态，但格式或范围未能采用/);
  view.querySelector('.dynamic-info-actions').querySelectorAll('button')[0].fire('click'); await settle(); assert.match(view.textContent, /动态状态更新失败，原有内容保持不变/);
});

test('没有 selected C 时不回退展示 legacy profile，并给出人物池引导', async () => {
  const { bootstrap } = await import('../dist/index.js?people-no-selected=1');
  const documentRef = documentHarness(); const instance = bootstrap({ documentRef, wandInstaller() {} });
  const empty = authorityState('uninitialized'); empty.people.confirmed[0].selection = { status: 'unselected' }; empty.peopleFoundation.state.activeMemberIds = [];
  instance.setState(empty); const view = instance.host.shadowRoot.nodes['.view'];
  assert.equal(view.querySelectorAll('.profile-tab').length, 0); assert.match(view.textContent, /还没有已选择的 C/); assert.match(view.textContent, /因缘簿/); assert.doesNotMatch(view.textContent, /管理人物池|银发|寡言/);
});

test('首次生成防双击，取消保留本地停止状态且迟到结果不显示成功', async () => {
  const { bootstrap } = await import('../dist/index.js?people-cancel=1');
  const documentRef = documentHarness(); let starts = 0, cancels = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const instance = bootstrap({ documentRef, wandInstaller() {}, initialRelations: { start: async () => { starts += 1; await gate; return { status: 'ready' }; }, cancel: () => { cancels += 1; } } });
  instance.setState(authorityState('uninitialized'));
  const view = instance.host.shadowRoot.nodes['.view']; const start = view.querySelector('.generation-actions').querySelectorAll('button')[0];
  start.fire('click'); start.fire('click'); await settle(); assert.equal(starts, 1);
  const cancel = view.querySelector('.generation-actions').querySelectorAll('button')[0]; cancel.fire('click'); assert.equal(cancels, 1); assert.match(view.textContent, /已停止/);
  release(); await settle(); assert.match(view.textContent, /已停止/); assert.doesNotMatch(view.textContent, /关系档案已保存/);
});

test('pending 数据仍在权威 profile 中，但人物档案没有 pending DOM 与操作出口', async () => {
  const { bootstrap } = await import('../dist/index.js?people-review-hidden=1');
  const documentRef = documentHarness(), authority = authorityState('ready'); let reviewCalls = 0;
  const instance = bootstrap({ documentRef, wandInstaller() {}, reviewActions: { itemDigest: async () => { reviewCalls += 1; }, resolvePendingReview: async () => { reviewCalls += 1; } } });
  instance.setState(authority); const view = instance.host.shadowRoot.nodes['.view'];
  assert.equal(authority.peopleFoundation.profiles[0].pendingReview[0].id, pending.id); assert.equal(view.querySelectorAll('.pending-actions').length, 0); assert.doesNotMatch(view.textContent, /需要确认|确认加入|拒绝/); assert.equal(reviewCalls, 0);
});

test('来源阻断显示安全摘要与采用按钮；采用成功只重载状态，不自动 start AI', async () => {
  const { bootstrap } = await import('../dist/index.js?people-adopt=1');
  const documentRef = documentHarness(); let adopts = 0, starts = 0, loads = 0;
  let authority = authorityState('blocked_source_changed');
  const blockedAttempt = { schemaVersion: 1, action: 'initial_start', attemptedAt: '2026-08-29T00:00:00.000Z', status: 'blocked_source_changed', stage: 'collecting_sources', errorCode: 'blocked_source_changed', aiCalled: false, profileWrites: 0, targetCount: 2, canonCount: 0, sourceDiagnostics: { greeting: 'changed', worldbookTotal: 30, worldbookChanged: 19, worldbookMissing: 0, worldbookUnreadable: 2, codes: ['GREETING_VERSION_CHANGED', 'WORLDBOOK_VERSION_CHANGED', 'WORLDBOOK_READ_FAILED'] } };
  authority.peopleFoundation.state.lastAttempt = blockedAttempt; authority.initialRelations.lastAttempt = blockedAttempt;
  const instance = bootstrap({ documentRef, wandInstaller() {}, loadState: async () => { loads += 1; return authority; }, initialRelations: {
    start: async () => { starts += 1; return { status: 'ready' }; },
    adoptCurrentSources: async () => {
      adopts += 1;
      const adopted = { ...blockedAttempt, action: 'adopt_current_sources', status: 'ready', stage: 'complete', errorCode: 'none' };
      authority = authorityState('blocked_source_changed'); authority.peopleFoundation.state.lastAttempt = adopted; authority.initialRelations.lastAttempt = adopted;
      return { status: 'ready', adopted: true };
    },
  } });
  instance.show(); await settle(); const view = instance.host.shadowRoot.nodes['.view'];
  assert.match(view.textContent, /开场白已变化；世界书 19 条变化，0 条缺失，暂时无法读取 2 条/); assert.match(view.textContent, /采用当前作者来源/); assert.match(view.textContent, /重新读取状态/);
  view.querySelector('.generation-actions').querySelectorAll('button')[0].fire('click'); await settle();
  assert.equal(adopts, 1); assert.equal(starts, 0); assert.equal(loads, 2); assert.match(view.textContent, /作者来源已更新/); assert.match(view.textContent, /生成首次档案/);
});

test('旧来源与归纳层即使为空也不再产生档案 DOM 文案', async () => {
  const { bootstrap } = await import('../dist/index.js?people-empty-copy=1');
  const documentRef = documentHarness(); const instance = bootstrap({ documentRef, wandInstaller() {} });
  const uninitialized = authorityState('uninitialized');
  for (const profile of uninitialized.peopleFoundation.profiles) { profile.sourceFacts = []; profile.interpretations = []; }
  instance.setState(uninitialized); assert.match(instance.host.shadowRoot.nodes['.view'].textContent, /生成首次档案/); assert.doesNotMatch(instance.host.shadowRoot.nodes['.view'].textContent, /首次档案尚未生成/);
  const ready = authorityState('ready');
  for (const profile of ready.peopleFoundation.profiles) { profile.sourceFacts = []; profile.interpretations = []; }
  ready.initialRelations.lastAttempt = { action: 'initial_start', status: 'ready', canonCount: 0 }; ready.peopleFoundation.state.lastAttempt = ready.initialRelations.lastAttempt;
  instance.setState(ready); const text = instance.host.shadowRoot.nodes['.view'].textContent;
  assert.doesNotMatch(text, /当前作者来源没有可展示的明确事实|当前没有稳定聊天可供归纳|首次档案尚未生成/);
});

test('轻量 AI 合法空结果显示安全完成文案且不提供重复生成按钮', async () => {
  const { bootstrap } = await import('../dist/index.js?people-empty-result=1');
  const documentRef = documentHarness(); const instance = bootstrap({ documentRef, wandInstaller() {} });
  const ready = authorityState('ready');
  const attempt = { schemaVersion: 1, action: 'initial_start', status: 'ready', stage: 'complete', errorCode: 'none', acceptedItems: 0, rejectedItems: 0, rejectionCodes: [], emptyResult: true };
  ready.initialRelations.lastAttempt = attempt; ready.peopleFoundation.state.lastAttempt = attempt;
  instance.setState(ready); const view = instance.host.shadowRoot.nodes['.view'];
  assert.match(view.textContent, /首次整理已完成/); assert.match(view.textContent, /没有可靠结果/);
  assert.doesNotMatch(view.textContent, /生成首次档案|为新人物补充档案/);
});

test('adopt 后权威 runtime.run → resume → UI 保留 adopt/ready 并显示生成入口，AI 为零', async () => {
  const { bootstrap } = await import('../dist/index.js?people-adopt-runtime=1');
  const documentRef = documentHarness(); let aiCalls = 0, adoptCalls = 0, resumeCalls = 0;
  const blockedAttempt = { schemaVersion: 1, action: 'initial_start', attemptedAt: '2026-08-29T00:00:00.000Z', status: 'blocked_source_changed', stage: 'collecting_sources', errorCode: 'blocked_source_changed', aiCalled: false, profileWrites: 0, targetCount: 2, canonCount: 0, sourceDiagnostics: { greeting: 'changed', worldbookTotal: 1, worldbookChanged: 1, worldbookMissing: 0, codes: ['WORLDBOOK_VERSION_CHANGED'] } };
  let relation = { schemaVersion: 1, status: 'blocked_source_changed', completedMemberIds: [], lastAttempt: blockedAttempt };
  const relationActions = {
    async adoptCurrentSources() {
      adoptCalls += 1;
      relation = { schemaVersion: 1, status: 'uninitialized', completedMemberIds: [], lastAttempt: { ...blockedAttempt, action: 'adopt_current_sources', status: 'ready', stage: 'complete', errorCode: 'none' } };
      return { status: 'ready', adopted: true, zeroAi: true };
    },
    async resume() { resumeCalls += 1; return { status: relation.status, zeroAi: true, completedMemberIds: relation.completedMemberIds }; },
    getState: () => structuredClone(relation),
    async start() { aiCalls += 1; return { status: 'ready' }; },
  };
  const base = authorityState('blocked_source_changed');
  const runtime = createRuntimeRunner({
    orchestrator: { run: async () => ({ status: 'route_ready' }) },
    people: { getPeople: async () => base.people },
    stableFloors: { refresh: async () => ({ status: 'ready', ledger: { entries: [] } }) },
    peopleFoundation: { initialize: async () => ({ ...base.peopleFoundation, state: { ...base.peopleFoundation.state, initialGeneration: { schemaVersion: 1, status: relation.status, completedMemberIds: relation.completedMemberIds }, lastAttempt: relation.lastAttempt } }) },
    initialRelations: relationActions,
  });
  const instance = bootstrap({ documentRef, wandInstaller() {}, loadState: runtime.run, initialRelations: relationActions });
  instance.show(); await settle(); const view = instance.host.shadowRoot.nodes['.view'];
  assert.match(view.textContent, /采用当前作者来源/); view.querySelector('.generation-actions').querySelectorAll('button')[0].fire('click'); await settle();
  assert.equal(adoptCalls, 1); assert.equal(resumeCalls, 2); assert.equal(aiCalls, 0);
  assert.equal(relation.lastAttempt.action, 'adopt_current_sources'); assert.equal(relation.lastAttempt.status, 'ready'); assert.equal(relation.lastAttempt.aiCalled, false);
  assert.match(view.textContent, /作者来源已更新/); assert.match(view.textContent, /生成首次档案/); assert.doesNotMatch(view.textContent, /采用当前作者来源/);
});

test('真实 dist 人物轨道：双人永久保留，多人物竞争才收敛且当前人物不消散', async () => {
  const { bootstrap } = await import('../dist/index.js?people-rail-layout=1');
  const documentRef = documentHarness(), pair = multiAuthority(2);
  const instance = bootstrap({ documentRef, wandInstaller() {} }); instance.setState(pair.authority);
  assert.equal(instance.host.shadowRoot.nodes['.view'].querySelectorAll('.profile-tab').length, 2);
  instance.settlePeopleRail({ availableWidth: 40, itemWidths: Object.fromEntries(pair.ids.map(id => [id, 90])) });
  assert.equal(instance.host.shadowRoot.nodes['.view'].querySelectorAll('.profile-tab').length, 2);

  const many = multiAuthority(10); many.authority.people.confirmed[0].displayName = '名字很长但不能挤走工具按钮的人物一'; instance.setState(many.authority);
  const widths = Object.fromEntries(many.ids.map((id, index) => [id, index === 0 ? 140 : 60])); instance.settlePeopleRail({ availableWidth: 127, itemWidths: widths });
  const view = instance.host.shadowRoot.nodes['.view'], railIds = view.querySelectorAll('.profile-tab').map(button => button.dataset.profileId);
  assert.equal(railIds.length, 2); assert.equal(railIds.includes(many.ids[0]), true);
  view.querySelector('.profile-tools').children[0].fire('click'); assert.match(view.textContent, /更多人物（8）/); assert.equal(view.querySelectorAll('.more-person').length, 8);
  const returning = view.querySelectorAll('.more-person')[0], returningId = returning.dataset.profileId, returningName = returning.textContent; returning.fire('click'); assert.equal(view.querySelectorAll('.profile-tab').find(button => button.dataset.profileId === returningId).focused, true);
  instance.settlePeopleRail({ availableWidth: 127, itemWidths: widths });
  assert.match(view.querySelector('.profile-summary').textContent, new RegExp(returningName)); assert.equal(view.querySelectorAll('.profile-tab').some(button => button.dataset.profileId === returningId), true);
});

test('真实 dist 轨道在扩宽或关注人数降到无竞争后回补仍关注人物', async () => {
  const { bootstrap } = await import('../dist/index.js?people-rail-refill=1');
  const documentRef = documentHarness(), data = multiAuthority(6), widths = Object.fromEntries(data.ids.map(id => [id, 60]));
  const instance = bootstrap({ documentRef, wandInstaller() {} }); instance.setState(data.authority); instance.settlePeopleRail({ availableWidth: 127, itemWidths: widths });
  let view = instance.host.shadowRoot.nodes['.view']; assert.equal(view.querySelectorAll('.profile-tab').length, 2); assert.equal(view.querySelectorAll('.profile-tab').some(button => button.dataset.profileId === data.ids[5]), false);
  instance.settlePeopleRail({ availableWidth: 500, itemWidths: {} }); view = instance.host.shadowRoot.nodes['.view']; assert.equal(view.querySelectorAll('.profile-tab').length, 6); assert.equal(view.querySelectorAll('.profile-tab').some(button => button.dataset.profileId === data.ids[5]), true);
  instance.settlePeopleRail({ availableWidth: 127, itemWidths: {} }); const partial = structuredClone(data.authority), partialKeep = new Set([data.ids[0], data.ids[2], data.ids[3], data.ids[5]]);
  partial.people.confirmed = partial.people.confirmed.filter(item => partialKeep.has(item.identityId)); partial.peopleFoundation.profiles = partial.peopleFoundation.profiles.filter(item => partialKeep.has(item.identityId)); partial.peopleFoundation.state.activeMemberIds = [...partialKeep]; instance.setState(partial); view = instance.host.shadowRoot.nodes['.view']; assert.equal(view.querySelectorAll('.profile-tab').length, 2); assert.equal(view.querySelectorAll('.profile-tab').some(button => button.dataset.profileId === data.ids[0]), true);
  const reduced = structuredClone(partial), keep = new Set([data.ids[0], data.ids[5]]);
  reduced.people.confirmed = reduced.people.confirmed.filter(item => keep.has(item.identityId)); reduced.peopleFoundation.profiles = reduced.peopleFoundation.profiles.filter(item => keep.has(item.identityId)); reduced.peopleFoundation.state.activeMemberIds = [...keep]; instance.setState(reduced); view = instance.host.shadowRoot.nodes['.view'];
  assert.deepEqual(view.querySelectorAll('.profile-tab').map(button => button.dataset.profileId), [data.ids[0], data.ids[5]]);
});

test('真实 dist 进行中基础/动态操作在切人物、切 chat 后失效并立即解锁', async () => {
  const { bootstrap } = await import('../dist/index.js?people-action-invalidation=1');
  const documentRef = documentHarness(), a = multiAuthority(2, 'c23e4567-e89b-42d3-a456-426614174002'), b = multiAuthority(2, 'd23e4567-e89b-42d3-a456-426614174002');
  const basicGate = deferred(), dynamicGate = deferred();
  const instance = bootstrap({ documentRef, wandInstaller() {}, initialRelations: { extractBasicInfo: async () => basicGate.promise, updateDynamicFields: async () => dynamicGate.promise } }); instance.setState(a.authority);
  let view = instance.host.shadowRoot.nodes['.view']; view.querySelector('.basic-info-actions').children[0].fire('click'); assert.match(view.textContent, /正在提取基础信息/);
  view.querySelectorAll('.profile-tab')[1].fire('click'); view = instance.host.shadowRoot.nodes['.view']; assert.match(view.querySelector('.profile-summary').textContent, /人物2/); assert.equal(view.querySelector('.basic-info-actions').children[0].disabled, false); assert.doesNotMatch(view.textContent, /正在提取基础信息/);
  basicGate.resolve({ status: 'ready', acceptedFields: 1 }); await settle(); assert.doesNotMatch(view.textContent, /提取完成，采用了 1 项。|正在提取基础信息/);
  view.querySelector('.dynamic-info-actions').children[0].fire('click'); assert.match(view.textContent, /正在更新动态状态/); instance.setState(b.authority); view = instance.host.shadowRoot.nodes['.view'];
  assert.match(view.querySelector('.profile-summary').textContent, /人物1/); assert.equal(view.querySelector('.dynamic-info-actions').children[0].disabled, false); assert.doesNotMatch(view.textContent, /正在更新动态状态/);
  dynamicGate.resolve({ status: 'ready', acceptedFields: 1 }); await settle(); assert.doesNotMatch(view.textContent, /更新完成，采用了|正在更新动态状态/);
});

test('真实 dist 关闭重开会清理进行中操作，迟到结果不串提示也不永久锁按钮', async () => {
  const { bootstrap } = await import('../dist/index.js?people-action-close=1');
  const documentRef = documentHarness(), data = multiAuthority(2), gate = deferred(); let authority = data.authority;
  const instance = bootstrap({ documentRef, wandInstaller() {}, loadState: async () => authority, initialRelations: { updateDynamicFields: async () => gate.promise } }); instance.show(); await settle(); let view = instance.host.shadowRoot.nodes['.view'];
  view.querySelector('.dynamic-info-actions').children[0].fire('click'); assert.match(view.textContent, /正在更新动态状态/); instance.close(); instance.show(); await settle(); view = instance.host.shadowRoot.nodes['.view'];
  assert.equal(view.querySelector('.dynamic-info-actions').children[0].disabled, false); assert.doesNotMatch(view.textContent, /正在更新动态状态/); gate.resolve({ status: 'ready', acceptedFields: 1 }); await settle();
  assert.equal(view.querySelector('.dynamic-info-actions').children[0].disabled, false); assert.doesNotMatch(view.textContent, /更新完成，采用了|正在更新动态状态/);
});

test('真实 dist profile 更新只提优先级与加静态圆点，不跳当前档案或当前内容视图', async () => {
  const { bootstrap } = await import('../dist/index.js?people-rail-update=1');
  const documentRef = documentHarness(), data = multiAuthority(4), instance = bootstrap({ documentRef, wandInstaller() {} }); instance.setState(data.authority);
  let view = instance.host.shadowRoot.nodes['.view']; view.querySelectorAll('.profile-tab')[1].fire('click');
  const selectedId = data.ids[1], selectedName = data.authority.people.confirmed[1].displayName;
  instance.settlePeopleRail({ availableWidth: 127, itemWidths: Object.fromEntries(data.ids.map(id => [id, 60])) });
  data.authority.peopleFoundation.profiles[2].dynamicFields.currentSituation = { value: '刚刚获得新线索', provenance: 'ai', sourceRefs: [{ kind: 'chat' }] };
  instance.setState(data.authority); view = instance.host.shadowRoot.nodes['.view'];
  assert.equal(view.querySelector('.profile-summary').textContent.includes(selectedName), true); assert.equal(view.querySelectorAll('.profile-tab').find(button => button.dataset.profileId === selectedId).tabIndex, 0);
  const updated = view.querySelectorAll('.profile-tab').find(button => button.dataset.profileId === data.ids[2]); assert.ok(updated); assert.match(updated.className, /has-update/); assert.match(updated.attributes['aria-label'], /有新更新/); assert.equal(updated.querySelectorAll('.profile-update-dot').length, 1);
  updated.fire('click'); view = instance.host.shadowRoot.nodes['.view']; assert.match(view.querySelector('.profile-summary').textContent, /人物3/); assert.equal(view.querySelectorAll('.profile-update-dot').length, 0);

  view.querySelector('.profile-tools').children[1].fire('click'); data.authority.peopleFoundation.profiles[3].dynamicFields.currentGoals.value = '不会强行切页的新目标'; instance.setState(data.authority); view = instance.host.shadowRoot.nodes['.view'];
  assert.ok(view.querySelector('.fate-book-view')); assert.equal(view.querySelector('.profile-summary'), null); assert.ok(view.querySelectorAll('.profile-tab').find(button => button.dataset.profileId === data.ids[3]).querySelector('.profile-update-dot'));
});

test('真实 dist 因缘簿复用完整人物池操作，操作后不跳视图且新选择进入轨道', async () => {
  const { bootstrap } = await import('../dist/index.js?people-fate-book=1');
  const documentRef = documentHarness(), data = multiAuthority(1), extraId = 'f23e4567-e89b-42d3-a456-426614174009';
  data.authority.people.confirmed.push({ identityId: extraId, displayName: '候选新 C', selection: { status: 'unselected' } });
  data.authority.peopleFoundation.profiles.push({ ...structuredClone(data.authority.peopleFoundation.profiles[0]), identityId: extraId });
  let currentPeople = data.authority.people, selects = 0;
  const people = { getPeople: async () => currentPeople, select: async ({ identityId }) => { selects += 1; currentPeople = { ...currentPeople, confirmed: currentPeople.confirmed.map(item => item.identityId === identityId ? { ...item, selection: { status: 'selected' } } : item) }; return currentPeople; } };
  const instance = bootstrap({ documentRef, people, wandInstaller() {} }); instance.setState(data.authority); let view = instance.host.shadowRoot.nodes['.view']; view.querySelector('.profile-tools').children[1].fire('click'); assert.equal(view.querySelector('.profile-tools').children[1].focused, true);
  assert.match(view.textContent, /因缘簿[\s\S]*明确人物/); const select = view.querySelector('[data-select]'); assert.ok(select); select.fire('click'); await settle(); view = instance.host.shadowRoot.nodes['.view'];
  assert.equal(selects, 1); assert.ok(view.querySelector('.fate-book-view')); assert.equal(view.querySelectorAll('.profile-tab').some(button => button.dataset.profileId === extraId), true); assert.equal(view.querySelector('.profile-summary'), null);
});

test('真实 dist 更多与因缘簿首次进入工具页，二次点击各自回到此前 C；无有效 C 时安全留在工具页', async () => {
  const { bootstrap } = await import('../dist/index.js?people-tool-toggle=1');
  const documentRef = documentHarness(), data = multiAuthority(3), instance = bootstrap({ documentRef, wandInstaller() {} }); instance.setState(data.authority);
  let view = instance.host.shadowRoot.nodes['.view']; view.querySelectorAll('.profile-tab')[1].fire('click'); const selectedName = data.authority.people.confirmed[1].displayName;
  let tools = view.querySelector('.profile-tools'); tools.children[0].fire('click'); assert.ok(view.querySelector('.more-view')); view.querySelector('.profile-tools').children[0].fire('click'); assert.match(view.querySelector('.profile-summary').textContent, new RegExp(selectedName));
  tools = view.querySelector('.profile-tools'); tools.children[1].fire('click'); assert.ok(view.querySelector('.fate-book-view')); view.querySelector('.profile-tools').children[1].fire('click'); assert.match(view.querySelector('.profile-summary').textContent, new RegExp(selectedName));

  const empty = authorityState('uninitialized'); empty.people.confirmed[0].selection = { status: 'unselected' }; empty.peopleFoundation.state.activeMemberIds = []; instance.setState(empty); view = instance.host.shadowRoot.nodes['.view'];
  view.querySelector('.profile-tools').children[0].fire('click'); assert.ok(view.querySelector('.more-view')); view.querySelector('.profile-tools').children[0].fire('click'); assert.ok(view.querySelector('.more-view')); assert.equal(view.querySelector('.profile-summary'), null);
  view.querySelector('.profile-tools').children[1].fire('click'); assert.ok(view.querySelector('.fate-book-view')); view.querySelector('.profile-tools').children[1].fire('click'); assert.ok(view.querySelector('.fate-book-view')); assert.equal(view.querySelector('.profile-summary'), null);
});

test('真实 dist 按 chatId 记住人物与内容视图，关闭重开恢复且无效人物安全回退', async () => {
  const { bootstrap } = await import('../dist/index.js?people-view-buckets=1');
  const documentRef = documentHarness(), a = multiAuthority(3, 'a23e4567-e89b-42d3-a456-426614174002'), b = multiAuthority(2, 'b23e4567-e89b-42d3-a456-426614174002'); let authority = a.authority;
  const instance = bootstrap({ documentRef, wandInstaller() {}, loadState: async () => authority }); instance.show(); await settle(); let view = instance.host.shadowRoot.nodes['.view'];
  view.querySelectorAll('.profile-tab')[1].fire('click'); view.querySelector('.profile-tools').children[1].fire('click'); instance.close(); instance.show(); await settle(); view = instance.host.shadowRoot.nodes['.view']; assert.ok(view.querySelector('.fate-book-view'));
  authority = b.authority; instance.setState(authority); view = instance.host.shadowRoot.nodes['.view']; assert.equal(view.querySelectorAll('.profile-tab')[0].dataset.profileId, b.ids[0]);
  authority = a.authority; instance.setState(authority); view = instance.host.shadowRoot.nodes['.view']; assert.ok(view.querySelector('.fate-book-view')); view.querySelectorAll('.profile-tab').find(button => button.dataset.profileId === a.ids[1]).fire('click'); assert.match(view.querySelector('.profile-summary').textContent, /人物2/);
  const reduced = structuredClone(a.authority); reduced.people.confirmed = reduced.people.confirmed.filter(item => item.identityId !== a.ids[1]); reduced.peopleFoundation.profiles = reduced.peopleFoundation.profiles.filter(item => item.identityId !== a.ids[1]); instance.setState(reduced); view = instance.host.shadowRoot.nodes['.view'];
  assert.equal(view.querySelectorAll('.profile-tab').some(button => button.dataset.profileId === a.ids[1]), false); assert.match(view.querySelector('.profile-summary').textContent, /人物1/);
});

test('真实 dist 人物 tab 不接管方向/Home/End，只保留原生 Tab 与按钮激活', async () => {
  const { bootstrap } = await import('../dist/index.js?people-rail-keyboard-pass-through=1');
  const documentRef = documentHarness(), data = multiAuthority(3), instance = bootstrap({ documentRef, wandInstaller() {} }); instance.setState(data.authority); const view = instance.host.shadowRoot.nodes['.view'];
  const tabs = view.querySelectorAll('.profile-tab'); assert.deepEqual(tabs.map(tab => tab.tabIndex), [0, 0, 0]); assert.equal(tabs.every(tab => tab.type === 'button'), true); assert.equal(tabs[0].events.keydown, undefined);
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    let defaultPrevented = false, propagationStopped = false, immediateStopped = false;
    tabs[0].fire('keydown', { key, preventDefault: () => { defaultPrevented = true; }, stopPropagation: () => { propagationStopped = true; }, stopImmediatePropagation: () => { immediateStopped = true; } });
    assert.equal(defaultPrevented, false, `${key} 不应 preventDefault`); assert.equal(propagationStopped, false, `${key} 不应 stopPropagation`); assert.equal(immediateStopped, false, `${key} 不应 stopImmediatePropagation`);
    assert.match(view.querySelector('.profile-summary').textContent, /人物1/); assert.deepEqual(view.querySelectorAll('.profile-tab').map(tab => tab.tabIndex), [0, 0, 0]);
  }
});

test('源码包含320/390短屏、横向切换、aria-live、键盘焦点与 reduced-motion 约束', async () => {
  const [panel, css, shell] = await Promise.all([
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'), readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8'), readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
  ]);
  assert.match(css, /@media\(max-width:390px\)/); assert.match(css, /overflow-x:auto/); assert.match(css, /profile-tab:focus-visible/); assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /basic-row-three\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/); assert.match(css, /basic-row-two\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/); assert.match(css, /basic-row-one\{grid-template-columns:minmax\(0,1fr\)/); assert.match(css, /basic-field\{[^}]*min-width:0[^}]*overflow:hidden/);
  assert.match(css, /basic-info\{padding:10px\}/); assert.doesNotMatch(css, /@media\(max-width:390px\)[\s\S]*basic-row-three\{grid-template-columns:1fr/);
  assert.match(css, /dynamic-row-two\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/); assert.match(css, /dynamic-field\{[^}]*min-width:0[^}]*overflow:hidden/); assert.match(css, /@media\(max-width:390px\)[\s\S]*dynamic-row-two\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /dynamic-value\{[^}]*overflow-wrap:anywhere/); assert.match(css, /dynamic-field textarea\{[^}]*max-width:100%/);
  assert.match(css, /profile-rail-shell\{display:grid;grid-template-columns:minmax\(0,1fr\) auto/); assert.match(css, /profile-tools\{display:grid;grid-template-columns:repeat\(2,54px\)/); assert.match(css, /profile-update-dot\{position:absolute/); assert.doesNotMatch(css, /profile-update-dot\{[^}]*animation/);
  assert.match(panel, /\[\['more', '更多'\], \['fateBook', '因缘簿'\]\]/); assert.doesNotMatch(panel, /ArrowLeft|ArrowRight|event\.key === 'Home'|event\.key === 'End'/); assert.doesNotMatch(panel, /profile-tab[^\n]*addEventListener\('keydown'/); assert.match(panel, /settlePeopleRail/);
  assert.match(panel, /button\.tabIndex = 0/); assert.doesNotMatch(panel, /profile\.identityId === bucket\.selectedProfileId \? 0 : -1/);
  assert.match(panel, /aria-live/); assert.match(panel, /aria-busy/); assert.match(shell, /100dvh/); assert.match(shell, /overflow-y:auto/);
});
