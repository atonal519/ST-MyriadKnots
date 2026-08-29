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
      { identityId: C, subject: 'character', displayName: '旧 profile 名不作为姓名真相', basicFields: { appearance: { value: '银发', provenance: 'source', sourceRefs: [{ kind: 'card' }] }, personality: { value: '寡言', provenance: 'user', sourceRefs: [] }, abilities: { value: '维护机关', provenance: 'source', sourceRefs: [{ kind: 'card' }] }, likes: { value: '雨声', provenance: 'user', sourceRefs: [] }, dislikes: { value: '失信', provenance: 'source', sourceRefs: [{ kind: 'worldbook' }] }, principles: { value: '守诺', provenance: 'source', sourceRefs: [{ kind: 'worldbook' }] }, relationships: { value: '郑柠：亲生妹妹；U：自幼相识的至交', provenance: 'source', sourceRefs: [{ kind: 'worldbook' }] } }, sourceFacts: [{ value: '<b>不会作为 HTML</b>', sourceRefs: [{ kind: 'card' }], relationToIdentityId: U }], interpretations: [{ value: '逐渐愿意坦白', sourceRefs: [{ kind: 'chat' }] }], pendingReview: pendingItems },
    ],
  },
  initialRelations: { schemaVersion: 1, status: relationStatus, completedMemberIds: relationStatus === 'ready' ? [C] : [] },
});

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

test('生产 bootstrap 打开只调用一次权威 loadState，不并行读取旧 formal/people', async () => {
  const { bootstrap } = await import('../dist/index.js?people-authority=1');
  const documentRef = documentHarness(); let loads = 0, formalReads = 0, peopleReads = 0;
  const instance = bootstrap({ documentRef, loadState: async () => { loads += 1; return authorityState('ready'); }, formal: { getFormalState: async () => { formalReads += 1; } }, people: { getPeople: async () => { peopleReads += 1; } }, wandInstaller() {} });
  instance.show(); await settle();
  assert.equal(loads, 1); assert.equal(formalReads, 0); assert.equal(peopleReads, 0);
  assert.match(instance.host.shadowRoot.nodes['.view'].textContent, /林岚/); assert.doesNotMatch(instance.host.shadowRoot.nodes['.view'].textContent, /旅人|旧 profile 名/);
});

test('千人只展示 selected C，冻结十二项、来源事实、AI 归纳与 pending 均安全 DOM 渲染', async () => {
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
  assert.match(view.textContent, /来源事实/); assert.match(view.textContent, /AI 归纳/); assert.match(view.textContent, /需要确认/); assert.match(view.textContent, /管理人物池/);
  const tabs = view.querySelectorAll('.profile-tab'); assert.equal(tabs.length, 1); assert.doesNotMatch(view.textContent, /旅人|tag-u/);
  assert.match(view.textContent, /<b>不会作为 HTML<\/b>/); assert.match(view.textContent, /<img src=x onerror=alert\(1\)>待确认/);
  assert.equal(view.innerHTML, '');
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

test('没有 selected C 时不回退展示 legacy profile，并给出人物池引导', async () => {
  const { bootstrap } = await import('../dist/index.js?people-no-selected=1');
  const documentRef = documentHarness(); const instance = bootstrap({ documentRef, wandInstaller() {} });
  const empty = authorityState('uninitialized'); empty.people.confirmed[0].selection = { status: 'unselected' }; empty.peopleFoundation.state.activeMemberIds = [];
  instance.setState(empty); const view = instance.host.shadowRoot.nodes['.view'];
  assert.equal(view.querySelectorAll('.profile-tab').length, 0); assert.match(view.textContent, /还没有已选择的 C/); assert.match(view.textContent, /管理人物池/); assert.doesNotMatch(view.textContent, /银发|寡言/);
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

test('pending UI 固定动作调用 digest + production seam，操作中同卡禁用并从权威状态刷新', async () => {
  const { bootstrap } = await import('../dist/index.js?people-review=1');
  const documentRef = documentHarness(); let authority = authorityState('ready'), calls = [], loads = 0;
  const instance = bootstrap({ documentRef, wandInstaller() {}, loadState: async () => { loads += 1; return authority; }, reviewActions: {
    itemDigest: async value => { calls.push(['digest', value.id]); return `sha256:${'d'.repeat(64)}`; },
    resolvePendingReview: async options => { calls.push(['resolve', options]); authority = authorityState('ready', []); return { status: 'ready' }; },
  } });
  instance.show(); await settle(); const view = instance.host.shadowRoot.nodes['.view'];
  const accept = view.querySelector('.pending-actions').querySelectorAll('button')[0]; accept.fire('click'); assert.equal(accept.disabled, true); await settle();
  assert.equal(loads, 2); assert.equal(calls[1][1].identityId, C); assert.equal(calls[1][1].decision, 'accept'); assert.equal(calls[1][1].pendingItemId, pending.id); assert.match(calls[1][1].expectedItemDigest, /^sha256:/);
  assert.match(view.textContent, /当前没有需要你确认的内容/);
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

test('未生成骨架与 ready 无 Canon 的合法空态使用不同文案', async () => {
  const { bootstrap } = await import('../dist/index.js?people-empty-copy=1');
  const documentRef = documentHarness(); const instance = bootstrap({ documentRef, wandInstaller() {} });
  const uninitialized = authorityState('uninitialized');
  for (const profile of uninitialized.peopleFoundation.profiles) { profile.sourceFacts = []; profile.interpretations = []; }
  instance.setState(uninitialized); assert.match(instance.host.shadowRoot.nodes['.view'].textContent, /首次档案尚未生成/);
  const ready = authorityState('ready');
  for (const profile of ready.peopleFoundation.profiles) { profile.sourceFacts = []; profile.interpretations = []; }
  ready.initialRelations.lastAttempt = { action: 'initial_start', status: 'ready', canonCount: 0 }; ready.peopleFoundation.state.lastAttempt = ready.initialRelations.lastAttempt;
  instance.setState(ready); const text = instance.host.shadowRoot.nodes['.view'].textContent;
  assert.match(text, /当前作者来源没有可展示的明确事实/); assert.match(text, /当前没有稳定聊天可供归纳/); assert.doesNotMatch(text, /首次档案尚未生成/);
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

test('源码包含320/390短屏、横向切换、aria-live、键盘焦点与 reduced-motion 约束', async () => {
  const [panel, css, shell] = await Promise.all([
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'), readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8'), readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
  ]);
  assert.match(css, /@media\(max-width:390px\)/); assert.match(css, /overflow-x:auto/); assert.match(css, /profile-tab:focus-visible/); assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /basic-row-three\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/); assert.match(css, /basic-row-two\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/); assert.match(css, /basic-row-one\{grid-template-columns:minmax\(0,1fr\)/); assert.match(css, /basic-field\{[^}]*min-width:0[^}]*overflow:hidden/);
  assert.match(css, /basic-info\{padding:10px\}/); assert.doesNotMatch(css, /@media\(max-width:390px\)[\s\S]*basic-row-three\{grid-template-columns:1fr/);
  assert.match(panel, /aria-live/); assert.match(panel, /aria-busy/); assert.match(shell, /100dvh/); assert.match(shell, /overflow-y:auto/);
});
