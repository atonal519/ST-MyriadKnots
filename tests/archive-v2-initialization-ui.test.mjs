import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEmptyArchiveV2 } from '../src/archive-v2.js';
import { createArchiveV2InitializationView } from '../src/ui/archive-v2-initialization-view.js';

const FIELD_KEYS = [
  'gender', 'age', 'appearance', 'personality', 'identity',
  'abilities', 'likes', 'dislikes', 'principles', 'relationships',
];

function matches(node, selector) {
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  const attribute = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attribute) {
    const value = node.getAttribute(attribute[1]);
    return attribute[2] === undefined ? value !== null : value === attribute[2];
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

class FakeElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.selected = false;
    this.open = false;
    this.value = '';
    this.type = '';
    this.tabIndex = 0;
    this._text = '';
  }

  set textContent(value) {
    this._text = String(value ?? '');
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) {
      this.children.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === 'id') this.id = stringValue;
  }

  getAttribute(name) {
    if (name === 'id' && this.id) return this.id;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  fire(type) {
    const event = { type, target: this, currentTarget: this, preventDefault() {} };
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
  }

  createElement(tag) {
    return new FakeElement(tag, this);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = async () => {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
};

function profilePerson(identityId, displayName) {
  return {
    identityId,
    displayName,
    fields: Object.fromEntries(FIELD_KEYS.map(key => [key, { value: `${displayName}-${key}` }])),
  };
}

function sourceState() {
  return {
    stage: 'sources',
    sources: [
      {
        id: 'card:1', kind: 'card', label: '角色卡资料', selected: true,
        availability: 'card', content: '绝不能展示的角色正文', locator: 'secret-locator', fingerprint: 'secret-fingerprint',
      },
      {
        id: 'worldbook:1', kind: 'worldbook', label: '世界书资料', selected: false,
        availability: 'disabled', content: '绝不能展示的世界书正文', locator: 'hidden-locator', fingerprint: 'hidden-fingerprint',
      },
    ],
    warnings: [{ code: 'unknown_private_warning' }],
    candidateReview: null,
    profileReview: null,
    result: null,
  };
}

function candidateState() {
  return {
    ...sourceState(),
    stage: 'candidates',
    candidateReview: {
      candidates: [
        { candidateId: 'candidate-1', displayName: '沈砚', aliases: ['阿砚'], reason: '角色卡明确出现', selected: false },
        { candidateId: 'candidate-2', displayName: '陆离', aliases: [], reason: '聊天中出现', selected: false },
      ],
    },
  };
}

function profileState() {
  return {
    ...candidateState(),
    stage: 'profiles',
    profileReview: { people: [profilePerson('person-1', '沈砚'), profilePerson('person-2', '陆离')] },
  };
}

function findButton(root, label) {
  return root.querySelectorAll('button').find(button => button.textContent === label) ?? null;
}

function createHarness({
  readResult = { status: 'uninitialized' },
  readGate = null,
  recognizeGate = null,
  generateGate = null,
  commitStatus = 'created',
  initialState = null,
  memory = null,
  followedProfiles = null,
  dossier = null,
} = {}) {
  const documentRef = new FakeDocument();
  const container = documentRef.createElement('div');
  let flowBusy = false;
  let state = initialState ?? {
    stage: 'idle', sources: [], warnings: [], candidateReview: null, profileReview: null, result: null,
  };
  const calls = {
    read: 0, load: [], recognize: 0, generate: 0, sourceSelect: [], candidateSelect: [],
    rename: [], aliases: [], merge: [], remove: [], backSources: 0, backCandidates: 0,
    setField: [], identity: 0, commit: [], order: [], ready: [], completed: [],
  };
  const flow = {
    getState() { return { ...state, busy: flowBusy }; },
    async loadSources(options) {
      calls.load.push(options);
      flowBusy = true;
      try {
        state = sourceState();
        return { status: 'ready' };
      } finally {
        flowBusy = false;
      }
    },
    setSourceSelected(id, selected) {
      calls.sourceSelect.push([id, selected]);
      state.sources.find(source => source.id === id).selected = selected;
    },
    async recognizeCandidates() {
      calls.recognize += 1;
      flowBusy = true;
      try {
        if (recognizeGate) await recognizeGate.promise;
        state = candidateState();
        return { status: 'ready' };
      } finally {
        flowBusy = false;
      }
    },
    setCandidateSelected(id, selected) {
      calls.candidateSelect.push([id, selected]);
      state.candidateReview.candidates.find(candidate => candidate.candidateId === id).selected = selected;
    },
    renameCandidate(id, value) {
      calls.rename.push([id, value]);
      state.candidateReview.candidates.find(candidate => candidate.candidateId === id).displayName = value.trim();
    },
    setCandidateAliases(id, aliases) {
      calls.aliases.push([id, aliases]);
      state.candidateReview.candidates.find(candidate => candidate.candidateId === id).aliases = aliases;
    },
    mergeCandidates(options) { calls.merge.push(options); },
    removeCandidate(id) {
      calls.remove.push(id);
      state.candidateReview.candidates = state.candidateReview.candidates.filter(candidate => candidate.candidateId !== id);
    },
    async generateProfiles() {
      calls.generate += 1;
      flowBusy = true;
      try {
        if (generateGate) await generateGate.promise;
        state = profileState();
        return { status: 'ready' };
      } finally {
        flowBusy = false;
      }
    },
    setProfileField(options) {
      calls.order.push('setProfileField');
      calls.setField.push(options);
      state.profileReview.people.find(person => person.identityId === options.identityId).fields[options.field].value = options.value;
    },
    backToSources() { calls.backSources += 1; state = sourceState(); },
    backToCandidates() { calls.backCandidates += 1; state = candidateState(); },
    async commitInitialization(options) {
      calls.order.push('commit');
      calls.commit.push(options);
      flowBusy = true;
      try {
        if (commitStatus === 'created' || commitStatus === 'already_initialized') {
          const archive = {
            people: {
              order: ['person-1', 'person-2'],
              byId: {
                'person-1': { displayName: { value: '沈砚' } },
                'person-2': { displayName: { value: '陆离' } },
              },
            },
          };
          state = { ...state, stage: 'completed', result: { status: commitStatus, archive, revision: 1, warnings: [] } };
          return state.result;
        }
        return { status: commitStatus };
      } finally {
        flowBusy = false;
      }
    },
  };
  const composition = {
    flow,
    async readArchive() {
      calls.read += 1;
      if (readGate) return readGate.promise;
      if (readResult instanceof Error) throw readResult;
      return readResult;
    },
    currentIdentity() {
      calls.order.push('currentIdentity');
      calls.identity += 1;
      return { characterLocator: 'character.png', personaLocator: 'persona.png', personaSummary: '' };
    },
  };
  const view = createArchiveV2InitializationView({
    composition,
    ...(memory ? { memory } : {}),
    ...(followedProfiles ? { followedProfiles } : {}),
    ...(dossier ? { dossier } : {}),
    documentRef,
    onArchiveReady: result => calls.ready.push(result),
    onCompleted: result => calls.completed.push(result),
  });
  const root = view.mount(container);
  return {
    documentRef, container, root, view, flow, composition, calls,
    getState: () => state,
    setState: next => { state = next; },
    setFlowBusy: value => { flowBusy = value; },
  };
}

function createFollowedProfileHarness({
  generateGate = null,
  failGenerate = false,
  commitStatus = 'saved',
  initialProfileState = null,
} = {}) {
  const archive = {
    people: {
      order: ['followed', 'silent'],
      byId: {
        followed: { followed: true, displayName: { value: '林少白' }, fields: {} },
        silent: { followed: false, displayName: { value: '陆离' }, fields: {} },
      },
    },
  };
  const draft = {
    people: [{
      identityId: 'followed', displayName: '林少白',
      fields: {
        identity: { value: '调查员' },
        personality: { value: '冷静克制' },
        nsfwPreferences: { value: '尊重边界' },
      },
    }],
  };
  let profileState = initialProfileState ?? { status: 'ready', followedCount: 1, enrichedCount: 0 };
  const profileCalls = { inspect: 0, generate: 0, commit: 0 };
  const followedProfiles = {
    async inspect() { profileCalls.inspect += 1; return profileState; },
    async generate() {
      profileCalls.generate += 1;
      profileState = { status: 'running', followedCount: 1 };
      if (generateGate) await generateGate.promise;
      if (failGenerate && profileCalls.generate === 1) {
        profileState = { status: 'error' };
        throw new Error('SECRET model output');
      }
      profileState = { status: 'draft', followedCount: 1, draft };
      return profileState;
    },
    async commit() {
      profileCalls.commit += 1;
      profileState = { status: 'saving', followedCount: 1, draft };
      if (commitStatus === 'conflict') {
        profileState = { status: 'conflict', followedCount: 1, draft };
        return { status: 'conflict' };
      }
      const savedArchive = structuredClone(archive);
      savedArchive.people.byId.followed.fields = {
        identity: { value: '调查员' }, personality: { value: '冷静克制' }, nsfwPreferences: { value: '尊重边界' },
      };
      profileState = { status: 'saved', followedCount: 1, savedFieldCount: 3, protectedFieldCount: 1 };
      return { status: 'saved', archive: savedArchive, revision: 2, warnings: [], savedFieldCount: 3, protectedFieldCount: 1 };
    },
    getState() { return profileState; },
  };
  const harness = createHarness({ readResult: { status: 'ready', archive, revision: 1, warnings: [] }, followedProfiles });
  return { ...harness, followedProfiles, profileCalls };
}

function createMemoryHarness({
  inspectResult = {
    status: 'uninitialized', targetFloor: 12, eligibleFloorCount: 9,
    completedBatches: 0, totalBatches: 3, currentBatchIndex: null, overRecommendedLimit: false,
  },
  readResult = { status: 'uninitialized' },
  startGate = null,
  startGates = null,
} = {}) {
  let memoryState = inspectResult;
  let poll = null;
  const backgroundWrites = { batch: 0, manifest: 0 };
  const calls = { inspect: 0, start: 0, getState: 0 };
  const memory = {
    async inspect() { calls.inspect += 1; return memoryState; },
    start() {
      calls.start += 1;
      memoryState = {
        status: 'scanning', targetFloor: 12, completedBatches: 1,
        totalBatches: 3, currentBatchIndex: 1,
      };
      const gate = Array.isArray(startGates) ? startGates[calls.start - 1] : startGate;
      if (gate) return gate.promise.then(
        result => {
          backgroundWrites.batch += 1; backgroundWrites.manifest += 1; memoryState = result; return result;
        },
        error => {
          memoryState = { ...memoryState, status: 'error', currentBatchIndex: null }; throw error;
        },
      );
      return Promise.resolve({
        status: 'ready', targetFloor: 12, completedBatches: 3,
        totalBatches: 3, currentBatchIndex: null,
      });
    },
    getState() { calls.getState += 1; return memoryState; },
  };
  const harness = createHarness({ readResult, memory });
  harness.documentRef.defaultView = {
    setInterval(callback) { poll = callback; return { unref() {} }; },
    clearInterval() { poll = null; },
  };
  return {
    ...harness,
    memory,
    memoryCalls: calls,
    backgroundWrites,
    setMemoryState(value) { memoryState = value; },
    poll() { poll?.(); },
  };
}

function memoryPeopleResult() {
  const statistics = {
    appearanceBatchCount: 2, sourceFloorCount: 3, userRelationBatchCount: 1, majorEventBatchCount: 1,
  };
  return {
    scanId: 'scan-people', sourceFingerprint: `sha256:${'a'.repeat(64)}`,
    people: [
      {
        localId: 'C1', displayName: '沈砚', aliases: ['阿砚'], recognitionReason: '跨批记录属于同一人物',
        recommendation: 'romance_candidate', recommendationReason: '存在明确关系证据', statistics,
      },
      {
        localId: 'C2', displayName: '陆离', aliases: [], recognitionReason: '独立配角',
        recommendation: 'background', recommendationReason: '只有工作往来',
        statistics: { ...statistics, userRelationBatchCount: 0, majorEventBatchCount: 0 },
      },
    ],
  };
}

function memoryPeopleArchive() {
  const archive = createEmptyArchiveV2({
    chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    characterLocator: 'character.png',
    personaLocator: 'persona.png',
  });
  const owned = value => ({ value, origin: 'ai', sourceRefs: [], userProtected: false });
  archive.people = {
    order: ['person-1', 'person-2'],
    byId: {
      'person-1': {
        identityId: 'person-1', followed: true, displayName: owned('沈砚'),
        aliases: owned(['阿砚']), fields: {}, sourceRefs: [],
      },
      'person-2': {
        identityId: 'person-2', followed: false, displayName: owned('陆离'),
        aliases: owned([]), fields: {}, sourceRefs: [],
      },
    },
  };
  return archive;
}

function createMemoryPeopleHarness({
  consolidationGate = null,
  commitGate = null,
  failConsolidation = false,
  confirmResult = null,
  followedProfiles = null,
  dossier = null,
} = {}) {
  let memoryState = {
    status: 'ready', targetFloor: 12, eligibleFloorCount: null,
    completedBatches: 3, totalBatches: 3, currentBatchIndex: null,
    peopleStatus: 'uninitialized',
  };
  let poll = null;
  const calls = { inspect: 0, start: 0, getState: 0, consolidate: 0, confirm: [] };
  const memory = {
    async inspect() { calls.inspect += 1; return memoryState; },
    start() { calls.start += 1; return Promise.resolve(memoryState); },
    getState() { calls.getState += 1; return memoryState; },
    async consolidatePeople() {
      calls.consolidate += 1;
      memoryState = { ...memoryState, peopleStatus: 'running' };
      if (consolidationGate) await consolidationGate.promise;
      if (failConsolidation) {
        failConsolidation = false;
        memoryState = { ...memoryState, peopleStatus: 'error' };
        throw new Error('SECRET model output');
      }
      memoryState = { ...memoryState, peopleStatus: 'ready', peopleResult: memoryPeopleResult() };
      return { status: 'ready', result: memoryState.peopleResult };
    },
    async confirmPeople(options) {
      calls.confirm.push(options);
      memoryState = { ...memoryState, peopleStatus: 'committing' };
      if (commitGate) await commitGate.promise;
      const selected = options.selectedLocalIds.length;
      memoryState = {
        ...memoryState,
        peopleStatus: 'committed',
        followedCount: selected,
        silentCount: memoryState.peopleResult.people.length - selected,
      };
      return confirmResult ?? {
        status: 'created', archive: memoryPeopleArchive(), revision: 1, warnings: [],
        followedCount: selected, silentCount: memoryState.silentCount,
      };
    },
  };
  const harness = createHarness({
    readResult: { status: 'uninitialized' }, memory, followedProfiles, dossier,
  });
  harness.documentRef.defaultView = {
    setInterval(callback) { poll = callback; return { unref() {} }; },
    clearInterval() { poll = null; },
  };
  return { ...harness, memory, memoryCalls: calls, getMemoryState: () => memoryState, poll: () => poll?.() };
}

async function reachSources(harness) {
  await harness.view.activate();
  findButton(harness.root, '选择建档来源').fire('click');
  await settle();
}

async function reachCandidates(harness) {
  await reachSources(harness);
  findButton(harness.root, '识别人选').fire('click');
  await settle();
}

async function reachProfiles(harness) {
  await reachCandidates(harness);
  const first = harness.root.querySelectorAll('.qqj-v2-candidate')[0];
  const checkbox = first.querySelector('.qqj-v2-checkbox');
  checkbox.checked = true;
  checkbox.fire('change');
  findButton(harness.root, '生成基础档案').fire('click');
  await settle();
}

test('构造、mount 与冻结窄接口只接受所需依赖', () => {
  const valid = createHarness();
  assert.equal(Object.isFrozen(valid.view), true);
  assert.deepEqual(Object.keys(valid.view).sort(), ['activate', 'deactivate', 'destroy', 'mount']);
  assert.equal(valid.root.parentNode, valid.container);
  assert.equal(valid.root.getAttribute('role'), 'region');
  assert.equal(valid.root.getAttribute('aria-label'), '千千结初次建档');
  const second = valid.documentRef.createElement('div');
  const nextRoot = valid.view.mount(second);
  assert.equal(valid.container.children.length, 0);
  assert.equal(nextRoot.parentNode, second);
  assert.throws(() => valid.view.mount(null), TypeError);
  const options = {
    composition: { ...valid.composition, readArchive: null },
    documentRef: valid.documentRef,
  };
  assert.throws(() => createArchiveV2InitializationView(options), TypeError);
  assert.throws(() => createArchiveV2InitializationView({ composition: valid.composition, documentRef: {} }), TypeError);
  assert.throws(() => createArchiveV2InitializationView({ composition: valid.composition, documentRef: valid.documentRef, onCompleted: 1 }), TypeError);
});

test('activate 只读一次，未点击时零采集零 AI', async () => {
  const harness = createHarness();
  const first = harness.view.activate();
  const second = harness.view.activate();
  assert.equal(first, second);
  await first;
  assert.equal(harness.calls.read, 1);
  assert.equal(harness.calls.load.length, 0);
  assert.equal(harness.calls.recognize, 0);
  assert.match(harness.root.textContent, /AI 只识别人选/);
  assert.equal(harness.root.getAttribute('aria-busy'), 'false');
  assert.equal(harness.root.querySelector('.qqj-v2-progress').hidden, false);
});

test('memory 模式构造期零动作，activate 只读预览并显示简化完整聊天摘要', async () => {
  const harness = createMemoryHarness();
  assert.deepEqual(harness.memoryCalls, { inspect: 0, start: 0, getState: 0 });
  await harness.view.activate();
  assert.deepEqual(harness.memoryCalls, { inspect: 1, start: 0, getState: 0 });
  assert.match(harness.root.textContent, /截至第 12 楼/);
  assert.match(harness.root.textContent, /共 9 个 AI 正文楼层/);
  assert.match(harness.root.textContent, /预计 3 批/);
  assert.ok(findButton(harness.root, '开始扫描记忆'));
  for (const legacy of ['选择建档来源', '开始楼层', '结束楼层', '隐藏', '用户楼层', '系统楼层']) {
    assert.equal(harness.root.textContent.includes(legacy), false, legacy);
  }
});

test('memory 主按钮只 start 一次，原生进度轮询更新并在完成后显示等待人物整理', async () => {
  const gate = deferred();
  const harness = createMemoryHarness({ startGate: gate });
  await harness.view.activate();
  findButton(harness.root, '开始扫描记忆').fire('click');
  await Promise.resolve();
  assert.equal(harness.memoryCalls.start, 1);
  assert.match(harness.root.textContent, /已完成 1 \/ 3 批/);
  assert.match(harness.root.textContent, /正在处理第 2 批/);
  const meter = harness.root.querySelector('progress');
  assert.equal(meter.getAttribute('aria-valuenow'), '1');
  assert.equal(meter.getAttribute('aria-valuemax'), '3');

  harness.setMemoryState({
    status: 'scanning', targetFloor: 12, completedBatches: 2,
    totalBatches: 3, currentBatchIndex: 2,
  });
  harness.poll();
  assert.match(harness.root.textContent, /已完成 2 \/ 3 批/);
  assert.equal(harness.memoryCalls.start, 1);
  gate.resolve({
    status: 'ready', targetFloor: 12, completedBatches: 3,
    totalBatches: 3, currentBatchIndex: null,
  });
  await settle();
  assert.match(harness.root.textContent, /记忆扫描完成，等待人物整理/);
  assert.equal(harness.root.textContent.includes('人物名单'), true);
});

test('memory deactivate 只停止 UI 观察，不取消后台；重开 inspect 恢复最终状态', async () => {
  const gate = deferred();
  const harness = createMemoryHarness({ startGate: gate });
  await harness.view.activate();
  findButton(harness.root, '开始扫描记忆').fire('click');
  await Promise.resolve();
  const before = harness.root.textContent;
  harness.view.deactivate();
  gate.resolve({
    status: 'ready', targetFloor: 12, completedBatches: 3,
    totalBatches: 3, currentBatchIndex: null,
  });
  harness.setMemoryState({
    status: 'ready', targetFloor: 12, eligibleFloorCount: null,
    completedBatches: 3, totalBatches: 3, currentBatchIndex: null,
  });
  await settle();
  assert.deepEqual(harness.backgroundWrites, { batch: 1, manifest: 1 });
  assert.equal(harness.root.hidden, true);
  assert.equal(harness.root.textContent, before);
  await harness.view.activate();
  assert.equal(harness.memoryCalls.inspect, 2);
  assert.match(harness.root.textContent, /记忆扫描完成，等待人物整理/);
});

test('memory 后台失败时关闭页不吞 runner error，同页重开优先显示安全失败状态', async () => {
  const gate = deferred();
  const harness = createMemoryHarness({ startGate: gate });
  await harness.view.activate();
  findButton(harness.root, '开始扫描记忆').fire('click');
  await Promise.resolve();
  harness.view.deactivate();
  gate.reject(new Error('SECRET 模型输出 /private/key'));
  await settle();
  assert.equal(harness.root.hidden, true);
  await harness.view.activate();
  assert.equal(harness.memoryCalls.inspect, 2);
  assert.match(harness.root.textContent, /暂时无法扫描记忆/);
  assert.doesNotMatch(harness.root.textContent, /SECRET|private|key|模型输出/);
});

test('memory error 只允许手动单次重扫；在途禁用，失败恢复按钮，再次成功进入 ready', async () => {
  const first = deferred();
  const second = deferred();
  const harness = createMemoryHarness({
    inspectResult: { status: 'error', message: 'SECRET initial failure' },
    startGates: [first, second],
  });
  await harness.view.activate();
  let retry = findButton(harness.root, '重新扫描');
  assert.ok(retry);
  assert.equal(retry.disabled, false);
  assert.equal(harness.memoryCalls.start, 0);

  retry.fire('click');
  retry.fire('click');
  await Promise.resolve();
  assert.equal(harness.memoryCalls.start, 1);
  harness.setMemoryState({
    status: 'error', targetFloor: 12, completedBatches: 1,
    totalBatches: 3, currentBatchIndex: null,
  });
  harness.poll();
  retry = findButton(harness.root, '重新扫描');
  assert.ok(retry);
  assert.equal(retry.disabled, true);
  retry.fire('click');
  assert.equal(harness.memoryCalls.start, 1);

  first.reject(new Error('SECRET api key https://private.example request body'));
  await settle();
  retry = findButton(harness.root, '重新扫描');
  assert.ok(retry);
  assert.equal(retry.disabled, false);
  assert.equal(harness.memoryCalls.start, 1);
  assert.doesNotMatch(harness.root.textContent, /SECRET|api key|private\.example|request body/i);

  retry.fire('click');
  retry.fire('click');
  await Promise.resolve();
  assert.equal(harness.memoryCalls.start, 2);
  second.resolve({
    status: 'ready', targetFloor: 12, completedBatches: 3,
    totalBatches: 3, currentBatchIndex: null,
  });
  await settle();
  assert.match(harness.root.textContent, /记忆扫描完成，等待人物整理/);
  assert.equal(findButton(harness.root, '重新扫描'), null);
});

test('memory 重扫、整理与确认操作在 flow 权威 busy 时明确禁用', async () => {
  const retry = createMemoryHarness({ inspectResult: { status: 'error' } });
  retry.setFlowBusy(true);
  await retry.view.activate();
  assert.equal(retry.root.getAttribute('aria-busy'), 'true');
  assert.equal(findButton(retry.root, '重新扫描').disabled, true);
  findButton(retry.root, '重新扫描').fire('click');
  assert.equal(retry.memoryCalls.start, 0);

  const people = createMemoryPeopleHarness();
  people.setFlowBusy(true);
  await people.view.activate();
  assert.equal(findButton(people.root, '整理人物').disabled, true);
  findButton(people.root, '整理人物').fire('click');
  assert.equal(people.memoryCalls.consolidate, 0);

  people.setFlowBusy(false);
  people.view.deactivate();
  await people.view.activate();
  findButton(people.root, '整理人物').fire('click');
  await settle();
  people.setFlowBusy(true);
  people.view.deactivate();
  await people.view.activate();
  assert.ok(people.root.querySelectorAll('.qqj-v2-checkbox').every(checkbox => checkbox.disabled));
  assert.equal(findButton(people.root, '确认关注人物').disabled, true);
  findButton(people.root, '确认关注人物').fire('click');
  assert.deepEqual(people.memoryCalls.confirm, []);
});

test('memory start 在途时关闭后立刻重开不并发 inspect，最终 ready 不被旧进度覆盖', async () => {
  const gate = deferred();
  const harness = createMemoryHarness({ startGate: gate });
  await harness.view.activate();
  assert.equal(harness.memoryCalls.inspect, 1);
  findButton(harness.root, '开始扫描记忆').fire('click');
  await Promise.resolve();
  harness.view.deactivate();
  await harness.view.activate();
  assert.equal(harness.memoryCalls.inspect, 1);
  assert.match(harness.root.textContent, /正在扫描聊天记忆/);
  assert.equal(findButton(harness.root, '继续扫描'), null);

  gate.resolve({
    status: 'ready', targetFloor: 12, completedBatches: 3,
    totalBatches: 3, currentBatchIndex: null,
  });
  await settle();
  assert.match(harness.root.textContent, /记忆扫描完成，等待人物整理/);
  assert.equal(findButton(harness.root, '继续扫描'), null);
});

test('memory ready 只显示手动整理按钮，重开后候选仅显示姓名与带姓名标签的复选框', async () => {
  const gate = deferred();
  const harness = createMemoryPeopleHarness({ consolidationGate: gate });
  await harness.view.activate();
  assert.ok(findButton(harness.root, '整理人物'));
  assert.equal(harness.memoryCalls.consolidate, 0);
  findButton(harness.root, '整理人物').fire('click');
  await Promise.resolve();
  assert.equal(harness.memoryCalls.consolidate, 1);
  assert.match(harness.root.textContent, /正在整理千人/);
  harness.view.deactivate();
  gate.resolve();
  await settle();
  assert.equal(harness.root.hidden, true);
  await harness.view.activate();
  assert.equal(harness.memoryCalls.inspect, 2);
  assert.match(harness.root.textContent, /请选择要关注的人物，其余人物将暂时静默/);
  assert.doesNotMatch(
    harness.root.textContent,
    /AI 建议攻略对象|其他人物|阿砚|跨批记录属于同一人物|romance_candidate|存在明确关系证据|出现 2 批|来源 3 楼|与用户关系|重大事件/,
  );
  const cards = harness.root.querySelectorAll('.qqj-v2-memory-person');
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(card => card.textContent), ['沈砚', '陆离']);
  for (const card of cards) {
    assert.equal(card.children.length, 1);
    const label = card.querySelector('label');
    const checkbox = card.querySelector('.qqj-v2-checkbox');
    assert.ok(label);
    assert.ok(checkbox);
    assert.equal(label.htmlFor, checkbox.id);
    assert.equal(label.textContent, card.textContent);
  }
  assert.equal(cards[0].querySelector('.qqj-v2-checkbox').checked, true);
  assert.equal(cards[1].querySelector('.qqj-v2-checkbox').checked, false);
});

test('memory 人物整理失败不泄露异常且可人工重试；统一多选确认写入 true/false 并显示静默入口', async () => {
  const harness = createMemoryPeopleHarness({ failConsolidation: true });
  await harness.view.activate();
  findButton(harness.root, '整理人物').fire('click');
  await settle();
  assert.match(harness.root.textContent, /人物整理没有完成/);
  assert.ok(findButton(harness.root, '重新整理'));
  assert.doesNotMatch(harness.root.textContent, /SECRET|model output/);
  findButton(harness.root, '重新整理').fire('click');
  await settle();
  const cards = harness.root.querySelectorAll('.qqj-v2-memory-person');
  const second = cards[1].querySelector('.qqj-v2-checkbox');
  second.checked = true;
  second.fire('change');
  const first = harness.root.querySelectorAll('.qqj-v2-memory-person')[0].querySelector('.qqj-v2-checkbox');
  first.checked = false;
  first.fire('change');
  findButton(harness.root, '确认关注人物').fire('click');
  await settle();
  assert.deepEqual(harness.memoryCalls.confirm, [{ selectedLocalIds: ['C2'] }]);
  assert.match(harness.root.textContent, /关注 1 人 · 静默 1 人/);
  assert.match(harness.root.textContent, /静默人物（1）/);
  assert.doesNotMatch(harness.root.textContent, /人物已经写入档案/);
  assert.equal(harness.calls.completed.length, 1);
  assert.equal(harness.calls.ready.length, 1);
});

test('memory 人物确认成功后直接进入正式档案，并显示首次基础人设入口', async () => {
  const followedProfiles = {
    async inspect() { throw new Error('本次成功结果无需重新读取档案'); },
    async generate() { return { status: 'running' }; },
    async commit() { return { status: 'saved' }; },
    getState() { return { status: 'ready', followedCount: 1, enrichedCount: 0 }; },
  };
  const dossier = {
    async updatePerson() { return { status: 'saved' }; },
    async renamePerson() { return { status: 'saved' }; },
    async setFollowed() { return { status: 'saved' }; },
  };
  const harness = createMemoryPeopleHarness({ followedProfiles, dossier });
  await harness.view.activate();
  findButton(harness.root, '整理人物').fire('click');
  await settle();
  findButton(harness.root, '确认关注人物').fire('click');
  await settle();

  assert.ok(harness.root.querySelector('.archive-v2-dossier'));
  assert.ok(harness.root.querySelector('.dossier-card'));
  assert.match(harness.root.textContent, /沈砚/);
  assert.doesNotMatch(harness.root.textContent, /人物已经写入档案/);
  const generate = findButton(harness.root, '生成基础人设');
  assert.ok(generate);
  assert.equal(generate.disabled, false);
  assert.equal(harness.calls.completed.length, 1);
  assert.equal(harness.calls.ready.length, 1);
});

test('memory 人物确认非成功或缺少可用 archive/revision 时不得进入 ready', async () => {
  const validArchive = memoryPeopleArchive();
  for (const confirmResult of [
    { status: 'conflict' },
    { status: 'stale' },
    { status: 'disabled' },
    { status: 'created', revision: 1, warnings: [] },
    { status: 'created', archive: { people: {} }, revision: 1, warnings: [] },
    { status: 'created', archive: validArchive, revision: 0, warnings: [] },
  ]) {
    const harness = createMemoryPeopleHarness({ confirmResult });
    await harness.view.activate();
    findButton(harness.root, '整理人物').fire('click');
    await settle();
    findButton(harness.root, '确认关注人物').fire('click');
    await settle();
    assert.equal(harness.root.querySelector('.qqj-v2-ready'), null, confirmResult.status);
    assert.equal(harness.root.querySelector('.archive-v2-dossier'), null, confirmResult.status);
    assert.equal(harness.calls.completed.length, 0, confirmResult.status);
    assert.equal(harness.calls.ready.length, 0, confirmResult.status);
  }
});

test('memory 人物确认迟到时 inactive 页面不跳转也不发完成回调', async () => {
  const gate = deferred();
  const harness = createMemoryPeopleHarness({ commitGate: gate });
  await harness.view.activate();
  findButton(harness.root, '整理人物').fire('click');
  await settle();
  findButton(harness.root, '确认关注人物').fire('click');
  await Promise.resolve();
  const before = harness.root.textContent;
  harness.view.deactivate();
  gate.resolve();
  await settle();
  assert.equal(harness.root.hidden, true);
  assert.equal(harness.root.textContent, before);
  assert.equal(harness.calls.completed.length, 0);
  assert.equal(harness.calls.ready.length, 0);
});

test('memory 恢复与终止状态只显示固定安全中文，异常内容不进入 DOM', async () => {
  for (const [result, expected] of [
    [{ status: 'scanning', targetFloor: 8, completedBatches: 1, totalBatches: 5, currentBatchIndex: null }, '继续扫描'],
    [{ status: 'interrupted', targetFloor: 8, completedBatches: 2, totalBatches: 5, currentBatchIndex: null }, '继续扫描'],
    [{ status: 'conflict' }, '扫描进度保存发生冲突'],
    [{ status: 'source_changed' }, '聊天正文已经变化'],
    [{ status: 'stale' }, '当前聊天已经变化'],
    [{ status: 'disabled' }, '千千结当前未启用'],
    [{ status: 'error', message: 'SECRET 正文 /tmp/private' }, '暂时无法扫描记忆'],
  ]) {
    const harness = createMemoryHarness({ inspectResult: result });
    await harness.view.activate();
    assert.ok(harness.root.textContent.includes(expected));
    assert.doesNotMatch(harness.root.textContent, /SECRET|\/tmp\/private|fingerprint|模型|Key/);
    if (['scanning', 'interrupted'].includes(result.status)) assert.ok(findButton(harness.root, '继续扫描'));
    if (result.status === 'error') assert.ok(findButton(harness.root, '重新扫描'));
  }
});

test('memory 超过 500 个有效 AI 楼层只提示性能与精度，不禁止开始', async () => {
  const harness = createMemoryHarness({ inspectResult: {
    status: 'uninitialized', targetFloor: 700, eligibleFloorCount: 501,
    completedBatches: 0, totalBatches: 26, currentBatchIndex: null, overRecommendedLimit: true,
  } });
  await harness.view.activate();
  assert.match(harness.root.textContent, /超过 500 层/);
  assert.match(harness.root.textContent, /耗时较长/);
  assert.equal(findButton(harness.root, '开始扫描记忆').disabled, false);
});

test('正式 archive ready 时 memory 零 inspect/start，仍显示既有安全摘要', async () => {
  const archive = { people: { order: [], byId: {} } };
  const harness = createMemoryHarness({ readResult: { status: 'ready', archive, warnings: [] } });
  await harness.view.activate();
  assert.deepEqual(harness.memoryCalls, { inspect: 0, start: 0, getState: 0 });
  assert.match(harness.root.textContent, /档案已建立/);
  assert.equal(findButton(harness.root, '开始扫描记忆'), null);
});

test('正式 archive ready 可一次生成关注人物草稿，按人物字段展示并确认保存', async () => {
  const gate = deferred();
  const harness = createFollowedProfileHarness({ generateGate: gate });
  await harness.view.activate();
  assert.equal(harness.profileCalls.inspect, 1);
  assert.equal(harness.root.querySelector('.qqj-v2-progress').hidden, true);
  assert.equal(harness.root.querySelector('.qqj-v2-status').hidden, true);
  assert.match(harness.root.className, /is-ready-quiet/);
  assert.ok(findButton(harness.root, '生成基础人设'));
  findButton(harness.root, '生成基础人设').fire('click');
  await Promise.resolve();
  assert.equal(harness.profileCalls.generate, 1);
  assert.equal(harness.root.querySelector('.qqj-v2-status').hidden, false);
  assert.match(harness.root.querySelector('.qqj-v2-status').textContent, /正在生成关注人物的基础人设/);
  assert.doesNotMatch(harness.root.className, /is-ready-quiet/);
  assert.match(harness.root.textContent, /正在为全部关注人物生成基础人设/);
  gate.resolve();
  await settle();
  assert.match(harness.root.textContent, /林少白/);
  assert.match(harness.root.textContent, /身份调查员/);
  assert.match(harness.root.textContent, /性格冷静克制/);
  assert.match(harness.root.textContent, /亲密偏好尊重边界/);
  assert.ok(findButton(harness.root, '保存基础人设'));
  findButton(harness.root, '保存基础人设').fire('click');
  await settle();
  assert.equal(harness.profileCalls.commit, 1);
  assert.match(harness.root.textContent, /已保存 3 个字段/);
  assert.match(harness.root.textContent, /1 个用户保护字段保持不变/);
});

test('ready 基础人设 saving、draft、error 均显示顶部状态且不进入静默态', async () => {
  for (const [initialProfileState, expected] of [
    [{ status: 'saving', followedCount: 1 }, '正在保存基础人设'],
    [{ status: 'draft', followedCount: 1, draft: { people: [] } }, '基础人设草稿已生成'],
    [{ status: 'error', followedCount: 1 }, '基础人设操作没有完成'],
  ]) {
    const harness = createFollowedProfileHarness({ initialProfileState });
    await harness.view.activate();
    const status = harness.root.querySelector('.qqj-v2-status');
    assert.equal(status.hidden, false);
    assert.match(status.textContent, new RegExp(expected));
    assert.doesNotMatch(harness.root.className, /is-ready-quiet/);
  }
});

test('基础人设失败可人工重试，CAS 冲突不显示假成功', async () => {
  const retry = createFollowedProfileHarness({ failGenerate: true });
  await retry.view.activate();
  findButton(retry.root, '生成基础人设').fire('click');
  await settle();
  assert.match(retry.root.textContent, /基础人设操作没有完成/);
  assert.doesNotMatch(retry.root.textContent, /SECRET|model output/);
  findButton(retry.root, '重新生成基础人设').fire('click');
  await settle();
  assert.ok(findButton(retry.root, '保存基础人设'));
  assert.equal(retry.profileCalls.generate, 2);

  const conflict = createFollowedProfileHarness({ commitStatus: 'conflict' });
  await conflict.view.activate();
  findButton(conflict.root, '生成基础人设').fire('click');
  await settle();
  findButton(conflict.root, '保存基础人设').fire('click');
  await settle();
  assert.match(conflict.root.textContent, /档案在草稿生成后已经变化/);
  assert.doesNotMatch(conflict.root.textContent, /基础人设已经保存|已保存 \d+ 个字段/);
  assert.ok(findButton(conflict.root, '重新生成基础人设'));
});

test('ready 只以纯文本显示安全摘要并只回调一次', async () => {
  const payload = '<img src=x onerror=steal()>沈砚';
  const archive = {
    people: {
      order: ['person-1', 'person-without-name'],
      byId: { 'person-1': { displayName: { value: payload } }, 'person-without-name': {} },
    },
  };
  const harness = createHarness({ readResult: { status: 'ready', archive, warnings: [{ code: '<svg/onload=steal()>' }] } });
  await harness.view.activate();
  assert.match(harness.root.textContent, /关注 2 人 · 静默 0 人/);
  assert.match(harness.root.textContent, /未命名人物/);
  assert.equal(harness.root.textContent.includes('person-without-name'), false);
  assert.ok(harness.root.textContent.includes(payload));
  assert.equal(harness.root.querySelectorAll('img').length, 0);
  assert.equal(harness.root.querySelectorAll('svg').length, 0);
  assert.equal(harness.calls.ready.length, 1);
  await harness.view.activate();
  assert.equal(harness.calls.read, 1);
  assert.equal(harness.calls.ready.length, 1);
});

test('ready 有 dossier actions 时委托 V1 风格正式页，未建档时仍保留原 V2 流程', async () => {
  const archive = {
    people: {
      order: ['followed', 'silent'],
      byId: {
        followed: {
          identityId: 'followed', followed: true,
          displayName: { value: '林少白', origin: 'ai', sourceRefs: [], userProtected: false },
          fields: {},
        },
        silent: {
          identityId: 'silent', followed: false,
          displayName: { value: '陆离', origin: 'ai', sourceRefs: [], userProtected: false },
          fields: {},
        },
      },
    },
  };
  const dossier = {
    async updatePerson() { throw new Error('未点击时不应调用'); },
    async renamePerson() { throw new Error('未点击时不应调用'); },
    async setFollowed() { throw new Error('未点击时不应调用'); },
  };
  const ready = createHarness({ readResult: { status: 'ready', archive, revision: 2, warnings: [] }, dossier });
  await ready.view.activate();
  assert.ok(ready.root.querySelector('.profile-rail-shell'));
  assert.ok(ready.root.querySelector('.dossier-card'));
  assert.ok(ready.root.querySelector('.basic-info'));
  assert.equal(ready.root.querySelector('.qqj-v2-ready'), null);
  assert.equal(ready.root.querySelector('.qqj-v2-progress').hidden, true);
  assert.equal(ready.root.querySelector('.qqj-v2-status').hidden, true);
  assert.match(ready.root.className, /is-ready-quiet/);

  const uninitialized = createHarness({ dossier });
  await uninitialized.view.activate();
  assert.ok(findButton(uninitialized.root, '选择建档来源'));
  assert.equal(uninitialized.root.querySelector('.dossier-card'), null);
  assert.equal(uninitialized.root.querySelector('.qqj-v2-progress').hidden, false);
});

test('正式 archive 摘要默认只列 followed 人物，静默人物仅在折叠入口显示', async () => {
  const archive = {
    people: {
      order: ['followed', 'silent'],
      byId: {
        followed: { followed: true, displayName: { value: '沈砚' } },
        silent: { followed: false, displayName: { value: '陆离' } },
      },
    },
  };
  const harness = createHarness({ readResult: { status: 'ready', archive, warnings: [] } });
  await harness.view.activate();
  assert.match(harness.root.textContent, /关注 1 人 · 静默 1 人/);
  const topList = harness.root.querySelectorAll('.qqj-v2-name-list')[0];
  assert.match(topList.textContent, /沈砚/);
  assert.doesNotMatch(topList.textContent, /陆离/);
  assert.match(harness.root.querySelector('.qqj-v2-memory-silent').textContent, /陆离/);
});

test('disabled、stale 与读取异常只显示安全文案', async () => {
  for (const [result, expected] of [
    [{ status: 'disabled' }, '千千结当前未启用'],
    [{ status: 'stale' }, '当前聊天已经变化'],
    [new Error('机密后端响应：正文全文'), '暂时无法读取档案'],
  ]) {
    const harness = createHarness({ readResult: result });
    await harness.view.activate();
    assert.ok(harness.root.textContent.includes(expected));
    assert.equal(harness.root.textContent.includes('机密后端响应'), false);
    assert.equal(findButton(harness.root, '选择建档来源'), null);
    assert.equal(harness.calls.load.length, 0);
  }
});

test('可选 chatRange 分别处理空、合法和非法输入', async () => {
  const empty = createHarness();
  await empty.view.activate();
  findButton(empty.root, '选择建档来源').fire('click');
  await settle();
  assert.deepEqual(empty.calls.load, [undefined]);

  const valid = createHarness();
  await valid.view.activate();
  const validInputs = valid.root.querySelectorAll('.qqj-v2-number-input');
  validInputs[0].value = '2'; validInputs[0].fire('input');
  validInputs[1].value = '7'; validInputs[1].fire('input');
  findButton(valid.root, '选择建档来源').fire('click');
  await settle();
  assert.deepEqual(valid.calls.load, [{ chatRange: { start: 2, end: 7 } }]);

  const invalid = createHarness();
  await invalid.view.activate();
  const invalidInputs = invalid.root.querySelectorAll('.qqj-v2-number-input');
  invalidInputs[0].value = '8'; invalidInputs[0].fire('input');
  invalidInputs[1].value = '3'; invalidInputs[1].fire('input');
  findButton(invalid.root, '选择建档来源').fire('click');
  await settle();
  assert.equal(invalid.calls.load.length, 0);
  assert.match(invalid.root.textContent, /开始不能晚于结束/);
});

test('来源选择不暴露正文位置指纹，禁用来源不可选且识别有 busy 守卫', async () => {
  const gate = deferred();
  const harness = createHarness({ recognizeGate: gate });
  await reachSources(harness);
  for (const secret of ['绝不能展示的角色正文', 'secret-locator', 'secret-fingerprint']) {
    assert.equal(harness.root.textContent.includes(secret), false);
  }
  assert.match(harness.root.textContent, /部分来源未读取/);
  const boxes = harness.root.querySelectorAll('.qqj-v2-checkbox');
  assert.equal(boxes.length, 2);
  assert.equal(boxes[1].disabled, true);
  boxes[0].checked = false;
  boxes[0].fire('change');
  assert.deepEqual(harness.calls.sourceSelect.at(-1), ['card:1', false]);
  assert.equal(findButton(harness.root, '识别人选').disabled, true);
  const selected = harness.root.querySelectorAll('.qqj-v2-checkbox')[0];
  selected.checked = true;
  selected.fire('change');
  const recognize = findButton(harness.root, '识别人选');
  recognize.fire('click');
  await Promise.resolve();
  assert.equal(harness.root.getAttribute('aria-busy'), 'true');
  assert.equal(findButton(harness.root, '识别人选').disabled, true);
  findButton(harness.root, '识别人选').fire('click');
  assert.equal(harness.calls.recognize, 1);
  gate.resolve();
  await settle();
  assert.match(harness.root.textContent, /确认要收入档案的人物/);
});

test('渲染与操作守卫合并 flow.getState 的权威 busy', async () => {
  const harness = createHarness({ initialState: sourceState() });
  harness.setFlowBusy(true);
  await harness.view.activate();
  assert.equal(harness.root.getAttribute('aria-busy'), 'true');
  assert.equal(findButton(harness.root, '识别人选').disabled, true);
  assert.equal(harness.root.querySelectorAll('.qqj-v2-checkbox')[0].disabled, true);
  harness.setFlowBusy(false);
  harness.view.deactivate();
  await harness.view.activate();
  assert.equal(harness.root.getAttribute('aria-busy'), 'false');
  assert.equal(findButton(harness.root, '识别人选').disabled, false);
});

test('候选支持选择、保存、移除、合并、返回和生成', async () => {
  const harness = createHarness();
  await reachCandidates(harness);
  const first = harness.root.querySelectorAll('.qqj-v2-candidate')[0];
  const selected = first.querySelector('.qqj-v2-checkbox');
  selected.focus();
  selected.checked = true;
  selected.fire('change');
  assert.deepEqual(harness.calls.candidateSelect, [['candidate-1', true]]);
  assert.equal(harness.documentRef.activeElement.dataset.focusKey, 'candidate:candidate-1:selected');
  assert.notEqual(harness.documentRef.activeElement, selected);
  const refreshedFirst = harness.root.querySelectorAll('.qqj-v2-candidate')[0];
  const name = refreshedFirst.querySelector('.qqj-v2-text-input');
  const aliases = refreshedFirst.querySelector('.qqj-v2-alias-input');
  name.value = ' 沈砚新名 '; name.fire('input');
  aliases.value = '阿砚， 小沈\n\n'; aliases.fire('input');
  const save = refreshedFirst.querySelectorAll('button').find(button => button.textContent === '保存名称');
  save.focus();
  save.fire('click');
  assert.deepEqual(harness.calls.rename, [['candidate-1', ' 沈砚新名 ']]);
  assert.deepEqual(harness.calls.aliases, [['candidate-1', ['阿砚', '小沈']]]);
  assert.equal(harness.documentRef.activeElement.dataset.focusKey, 'candidate:candidate-1:save');
  assert.notEqual(harness.documentRef.activeElement, save);

  const firstAgain = harness.root.querySelectorAll('.qqj-v2-candidate')[0];
  const mergeSelect = firstAgain.querySelector('.qqj-v2-select');
  mergeSelect.value = 'candidate-2'; mergeSelect.fire('change');
  const mergeCard = harness.root.querySelectorAll('.qqj-v2-candidate')[0];
  mergeCard.querySelectorAll('button').find(button => button.textContent === '确认合并').fire('click');
  assert.deepEqual(harness.calls.merge, [{ targetId: 'candidate-2', sourceIds: ['candidate-1'] }]);

  const second = harness.root.querySelectorAll('.qqj-v2-candidate')[1];
  second.querySelectorAll('button').find(button => button.textContent === '移除').fire('click');
  assert.deepEqual(harness.calls.remove, ['candidate-2']);
  findButton(harness.root, '返回来源').fire('click');
  assert.equal(harness.calls.backSources, 1);

  const generate = createHarness();
  await reachCandidates(generate);
  assert.equal(findButton(generate.root, '生成基础档案').disabled, true);
  const box = generate.root.querySelectorAll('.qqj-v2-candidate')[0].querySelector('.qqj-v2-checkbox');
  box.checked = true; box.fire('change');
  findButton(generate.root, '生成基础档案').fire('click');
  await settle();
  assert.equal(generate.calls.generate, 1);
  assert.match(generate.root.textContent, /审核基础档案/);
});

test('档案固定十字段且确认只保存变化，然后取身份并 commit', async () => {
  const harness = createHarness();
  await reachProfiles(harness);
  const inputs = harness.root.querySelectorAll('.qqj-v2-profile-input');
  assert.equal(inputs.length, 20);
  assert.equal(harness.root.querySelectorAll('.qqj-v2-profile')[0].open, true);
  const labels = harness.root.querySelectorAll('.qqj-v2-field-label');
  for (const input of inputs) assert.ok(labels.some(label => label.htmlFor === input.id));
  inputs[0].value = '新性别文本';
  inputs[0].fire('input');
  findButton(harness.root, '确认并建立档案').fire('click');
  await settle();
  assert.deepEqual(harness.calls.setField, [{ identityId: 'person-1', field: 'gender', value: '新性别文本' }]);
  assert.deepEqual(harness.calls.order, ['setProfileField', 'currentIdentity', 'commit']);
  assert.equal(harness.calls.commit.length, 1);
  assert.equal(harness.calls.completed.length, 1);
  assert.equal(harness.calls.ready.length, 1);
  assert.match(harness.root.textContent, /档案已经建立/);
  assert.match(harness.root.textContent, /已建立 2 人的档案/);
  harness.flow.getState();
  assert.equal(harness.calls.completed.length, 1);
});

test('profile 的未提交 DOM 草稿跨 deactivate/activate 保留，返回人物后清理', async () => {
  const harness = createHarness();
  await reachProfiles(harness);
  const input = harness.root.querySelectorAll('.qqj-v2-profile-input')[0];
  input.value = '尚未提交的用户编辑';
  input.fire('input');
  harness.view.deactivate();
  await harness.view.activate();
  assert.equal(harness.root.querySelectorAll('.qqj-v2-profile-input')[0].value, '尚未提交的用户编辑');

  findButton(harness.root, '返回人物').fire('click');
  harness.setState(profileState());
  harness.view.deactivate();
  await harness.view.activate();
  assert.equal(harness.root.querySelectorAll('.qqj-v2-profile-input')[0].value, '沈砚-gender');
});

test('commit 的 conflict、stale、disabled 均保留 profile 且不假完成', async () => {
  for (const status of ['conflict', 'stale', 'disabled']) {
    const harness = createHarness({ commitStatus: status, initialState: profileState() });
    await harness.view.activate();
    findButton(harness.root, '确认并建立档案').fire('click');
    await settle();
    assert.equal(harness.getState().stage, 'profiles');
    assert.ok(harness.root.querySelectorAll('.qqj-v2-profile-input').length > 0);
    assert.equal(harness.calls.completed.length, 0);
    assert.equal(harness.calls.ready.length, 0);
    assert.ok(harness.root.textContent.includes(status === 'conflict' ? '发生冲突' : status === 'stale' ? '聊天已经变化' : '当前未启用'));
  }
});

test('already_initialized 同样进入真实完成态且回调不重复', async () => {
  const harness = createHarness({ commitStatus: 'already_initialized', initialState: profileState() });
  await harness.view.activate();
  findButton(harness.root, '确认并建立档案').fire('click');
  await settle();
  assert.equal(harness.getState().stage, 'completed');
  assert.equal(harness.calls.completed.length, 1);
  assert.equal(harness.calls.ready.length, 1);
  assert.equal(harness.calls.completed[0].status, 'already_initialized');

  harness.setState(profileState());
  harness.view.deactivate();
  await harness.view.activate();
  findButton(harness.root, '确认并建立档案').fire('click');
  await settle();
  assert.equal(harness.calls.completed.length, 2);
  assert.equal(harness.calls.ready.length, 2);
});

test('deactivate/destroy 让迟到 read 失效，重新 activate 恢复 flow 中间态且不 reset', async () => {
  const readGate = deferred();
  const harness = createHarness({ readGate });
  const late = harness.view.activate();
  assert.equal(harness.root.getAttribute('aria-busy'), 'true');
  harness.view.deactivate();
  readGate.resolve({ status: 'uninitialized' });
  await late;
  assert.equal(harness.root.hidden, true);
  assert.equal(harness.calls.ready.length, 0);
  assert.equal(harness.root.textContent.includes('档案已建立'), false);

  harness.setState(candidateState());
  await harness.view.activate();
  assert.match(harness.root.textContent, /确认要收入档案的人物/);
  assert.equal(harness.calls.backSources, 0);
  assert.equal(harness.calls.backCandidates, 0);

  const destroyGate = deferred();
  const destroyed = createHarness({ readGate: destroyGate });
  const pending = destroyed.view.activate();
  destroyed.view.destroy();
  destroyGate.resolve({ status: 'ready', archive: { people: { order: [], byId: {} } }, warnings: [] });
  await pending;
  assert.equal(destroyed.container.children.length, 0);
  assert.equal(destroyed.calls.ready.length, 0);
});

test('AI 在途时 deactivate 后立即 activate 仍 busy，settle 后自动进入新阶段', async () => {
  const gate = deferred();
  const harness = createHarness({ recognizeGate: gate });
  await reachSources(harness);
  findButton(harness.root, '识别人选').fire('click');
  await Promise.resolve();
  harness.view.deactivate();
  await harness.view.activate();
  assert.equal(harness.root.hidden, false);
  assert.equal(harness.root.getAttribute('aria-busy'), 'true');
  assert.equal(findButton(harness.root, '识别人选').disabled, true);
  gate.resolve();
  await settle();
  assert.equal(harness.root.getAttribute('aria-busy'), 'false');
  assert.match(harness.root.textContent, /确认要收入档案的人物/);
});

test('AI 在途时重复 mount 不残留 local busy，settle 后新根节点自动更新', async () => {
  const gate = deferred();
  const harness = createHarness({ recognizeGate: gate });
  await reachSources(harness);
  findButton(harness.root, '识别人选').fire('click');
  await Promise.resolve();
  const nextContainer = harness.documentRef.createElement('div');
  const nextRoot = harness.view.mount(nextContainer);
  await harness.view.activate();
  assert.equal(nextRoot.getAttribute('aria-busy'), 'true');
  gate.resolve();
  await settle();
  assert.equal(nextRoot.getAttribute('aria-busy'), 'false');
  assert.match(nextRoot.textContent, /确认要收入档案的人物/);
});

test('关键可访问性与阶段焦点策略有效', async () => {
  const harness = createHarness();
  await harness.view.activate();
  assert.equal(harness.root.querySelector('[role="status"]').getAttribute('aria-live'), 'polite');
  assert.equal(harness.documentRef.activeElement.tagName, 'H2');
  findButton(harness.root, '选择建档来源').fire('click');
  await settle();
  const stageHeading = harness.root.querySelector('h2');
  assert.equal(harness.documentRef.activeElement, stageHeading);
  const checkbox = harness.root.querySelector('.qqj-v2-checkbox');
  checkbox.focus();
  checkbox.checked = false; checkbox.fire('change');
  assert.equal(harness.documentRef.activeElement.dataset.focusKey, 'source:card:1:selected');
  assert.notEqual(harness.documentRef.activeElement, checkbox);
  for (const control of harness.root.querySelectorAll('input')) {
    const label = harness.root.querySelectorAll('label').find(item => item.htmlFor === control.id);
    assert.ok(label, `缺少 ${control.id} 对应 label`);
  }
});

test('CSS 有前缀、窄屏、焦点、减弱动画且无远程资源', async () => {
  const css = await readFile(new URL('../src/ui/archive-v2-initialization.css', import.meta.url), 'utf8');
  assert.match(css, /\.qqj-v2-/);
  assert.match(css, /@media \(max-width:\s*520px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.qqj-v2-source-copy\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.qqj-v2-source-copy strong\s*\{[^}]*(overflow-wrap|word-break)/s);
  assert.match(css, /\.qqj-v2-initialization\.is-ready-quiet\s*\{[^}]*padding-block-start:\s*0/s);
  assert.match(css, /\.qqj-v2-progress\[hidden\][^{]*\.qqj-v2-status\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(css, /https?:|@import|url\s*\(/i);
  const selectorLines = css.split('\n').map(line => line.trim())
    .filter(line => line.endsWith('{') && !line.startsWith('@'));
  for (const selector of selectorLines) assert.ok(selector.includes('.qqj-v2-'), `未加前缀的选择器: ${selector}`);
});
