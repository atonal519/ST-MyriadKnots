import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveV2BondView } from '../src/ui/archive-v2-bond-view.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

class Node {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.events = {};
    this.attributes = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this._text = '';
  }
  append(...children) { this.children.push(...children); for (const child of children) if (child instanceof Node) child.parentNode = this; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  async fire(name) { for (const handler of this.events[name] || []) await handler({ currentTarget: this, target: this }); }
  get textContent() { return this._text || this.children.map(child => child?.textContent ?? '').join(''); }
  set textContent(value) { this._text = String(value); }
  descendants() { return this.children.flatMap(child => child instanceof Node ? [child, ...child.descendants()] : []); }
}

const documentRef = { createElement: tag => new Node(tag), defaultView: { setInterval, clearInterval } };
const owned = value => ({ value, origin: 'ai', sourceRefs: [], userProtected: false });

function archiveWithBond() {
  const rootRef = { kind: 'worldbook', locator: '关系书:7', fingerprint: `sha256:${'a'.repeat(64)}` };
  const fieldRef = { kind: 'chat', locator: 'memory-batch:0', fingerprint: `sha256:${'b'.repeat(64)}` };
  const nativeRef = { kind: 'native', locator: 'variables[0].stat_data.好感', fingerprint: `sha256:${'c'.repeat(64)}` };
  return {
    people: {
      order: [ID],
      byId: { [ID]: { identityId: ID, followed: true, displayName: owned('林少白') } },
    },
    bonds: {
      [ID]: {
        identityId: ID,
        stage: { ...owned('熟悉'), sourceRefs: [fieldRef] },
        nativeSignals: [{ label: '好感', path: 'variables[0].stat_data.好感', value: 18, sourceRefs: [nativeRef] }],
        cToU: { view: owned('信任用户') },
        uToC: { boundary: owned('不越界') },
        recentChanges: owned('雨夜坦白'),
        sourceRefs: [rootRef],
        updatedThroughFloor: 8,
      },
    },
  };
}

function archiveWithTwoBonds() {
  const archive = archiveWithBond();
  archive.people.order.push(ID2);
  archive.people.byId[ID2] = { identityId: ID2, followed: true, displayName: owned('陆离') };
  archive.bonds[ID2] = {
    ...structuredClone(archive.bonds[ID]), identityId: ID2, stage: owned('试探'),
    nativeSignals: [], recentChanges: owned('保持距离'), sourceRefs: [],
  };
  return archive;
}

function draft() {
  return {
    kind: 'myriad-knots-bond-draft',
    people: [{ identityId: ID, displayName: '林少白', bond: archiveWithBond().bonds[ID] }],
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('UI 覆盖未建立→批次进度→草稿编辑→保存→已有 bonds 展示', async () => {
  let state = { status: 'ready', followedCount: 1, savedCount: 0, archive: { people: { order: [ID], byId: { [ID]: { identityId: ID, followed: true, displayName: owned('林少白') } } }, bonds: {} } };
  let release;
  let committed;
  const composition = {
    inspect: async () => state,
    getState: () => state,
    generate: () => new Promise(resolve => {
      state = { status: 'running', batchIndex: 2, totalBatches: 3, followedCount: 10 };
      release = () => { state = { status: 'draft', draft: draft(), followedCount: 1 }; resolve(state); };
    }),
    commit: async options => {
      committed = structuredClone(options);
      state = { status: 'saved', archive: archiveWithBond(), followedCount: 1, savedCount: 1 };
      return { status: 'saved', archive: state.archive };
    },
  };
  const view = createArchiveV2BondView({ composition, documentRef });
  const container = new Node();
  view.mount(container);
  assert.equal((await view.activate()).status, 'ready');
  const create = container.descendants().find(node => node.tagName === 'button' && node.textContent === '建立双丝网');
  assert.ok(create);
  await create.fire('click');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.match(container.textContent, /第 2 \/ 3 批/);
  release();
  await flush();
  assert.match(container.textContent, /双丝网草稿/);
  assert.match(container.textContent, /将保存的作者原生关系信息（只读）|好感：18/);
  assert.match(container.textContent, /将保存的截止楼层：8（只读）/);
  const stage = container.descendants().find(node => node.dataset?.field === 'stage');
  assert.ok(stage);
  assert.equal(stage.tagName, 'select');
  assert.deepEqual(stage.children.map(option => option.value), ['陌生', '相识', '熟悉', '暧昧', '热恋']);
  stage.value = '热恋';
  await stage.fire('change');
  const save = container.descendants().find(node => node.tagName === 'button' && node.textContent === '确认并保存双丝网');
  await save.fire('click');
  await flush();
  assert.deepEqual(committed, { edits: { [ID]: { stage: '热恋' } } });
  assert.match(container.textContent, /熟悉|作者原生关系信息|雨夜坦白/);
  assert.match(container.textContent, /截止楼层：8/);
  assert.match(container.textContent, /worldbook · 关系书:7|chat · memory-batch:0|native · variables\[0\]/);
  view.deactivate();
});

test('多人物 saved/error 均只渲染 focused 卡并可切换，error 重试正确消费来源确认', async () => {
  const archive = archiveWithTwoBonds();
  let state = { status: 'error', archive, savedCount: 2, followedCount: 2 };
  let confirmed = false;
  let generates = 0;
  const composition = {
    inspect: async () => state, getState: () => state,
    generate: async () => { generates += 1; return state; }, commit: async () => state,
  };
  const sourcePermissions = { isCurrentConfirmed: () => confirmed, confirmCurrent: () => { confirmed = true; } };
  const sourcePermissionView = { renderPreflight: ({ onContinue }) => {
    const box = new Node('section'); box.textContent = '来源确认';
    const next = new Node('button'); next.textContent = '确认来源并继续'; next.addEventListener('click', onContinue); box.append(next); return box;
  } };
  const view = createArchiveV2BondView({ composition, documentRef, sourcePermissions, sourcePermissionView });
  const container = new Node(); view.mount(container); await view.activate();
  const classes = container.descendants().map(node => node.className);
  assert.ok(classes.includes('bond-stage-axis'));
  assert.ok(classes.includes('bond-central-thread'));
  assert.ok(classes.includes('bond-side bond-weave-side side-u'));
  assert.ok(classes.includes('bond-side bond-weave-side side-c'));
  const steps = container.descendants().filter(node => String(node.className).startsWith('bond-stage-step'));
  assert.equal(steps.length, 5);
  assert.deepEqual(steps.map(node => node.textContent), ['陌生', '相识', '熟悉', '暧昧', '热恋']);
  assert.deepEqual(steps.filter(node => node.attributes['aria-current'] === 'step').map(node => node.textContent), ['熟悉']);
  assert.equal(container.descendants().filter(node => node.className === 'bond-card').length, 1);
  assert.match(container.textContent, /林少白/); assert.doesNotMatch(container.textContent, /旧档案阶段原文试探/);
  const second = container.descendants().find(node => node.tagName === 'button' && node.textContent === '陆离');
  await second.fire('click');
  assert.equal(container.descendants().filter(node => node.className === 'bond-card').length, 1);
  assert.match(container.textContent, /旧档案阶段原文试探/);
  assert.equal(container.descendants().filter(node => node.attributes?.['aria-current'] === 'step').length, 0);
  const retry = container.descendants().find(node => node.tagName === 'button' && node.textContent === '重新生成');
  await retry.fire('click');
  assert.match(container.textContent, /来源确认/);
  const confirm = container.descendants().find(node => node.tagName === 'button' && node.textContent === '确认来源并继续');
  await confirm.fire('click'); await flush();
  assert.equal(confirmed, true); assert.equal(generates, 1);
  view.deactivate();
});

test('旧长 stage 完整原文诚实展示，不截字、不改档也不自动调用 AI', async () => {
  const archive = archiveWithBond();
  const longStage = '两人经历长期拉扯后形成尚未命名但彼此默认的复杂亲密关系';
  archive.bonds[ID].stage = owned(longStage);
  let generateCalls = 0;
  const state = { status: 'saved', archive, savedCount: 1, followedCount: 1 };
  const composition = { inspect: async () => state, getState: () => state, generate: async () => { generateCalls += 1; return state; }, commit: async () => state };
  const view = createArchiveV2BondView({ composition, documentRef });
  const container = new Node(); view.mount(container); await view.activate();
  assert.match(container.textContent, new RegExp(longStage));
  assert.match(container.textContent, /旧档案阶段原文|不会伪造高亮，也不会自动改写或调用 AI/);
  assert.equal(generateCalls, 0);
  assert.equal(archive.bonds[ID].stage.value, longStage);
  view.deactivate();
});

test('多人物草稿切换后编辑分别归属各自人物', async () => {
  const archive = archiveWithTwoBonds();
  const state = { status: 'draft', followedCount: 2, draft: { kind: 'myriad-knots-bond-draft', people: [
    { identityId: ID, displayName: '林少白', bond: archive.bonds[ID] },
    { identityId: ID2, displayName: '陆离', bond: archive.bonds[ID2] },
  ] } };
  let committed;
  const composition = { inspect: async () => state, getState: () => state, generate: async () => state, commit: async value => { committed = value; return state; } };
  const view = createArchiveV2BondView({ composition, documentRef });
  const container = new Node(); view.mount(container); await view.activate();
  let stage = container.descendants().find(node => node.dataset?.field === 'stage'); stage.value = '热恋'; await stage.fire('change');
  await container.descendants().find(node => node.tagName === 'button' && node.textContent === '陆离').fire('click');
  stage = container.descendants().find(node => node.dataset?.field === 'stage'); stage.value = '陌生'; await stage.fire('change');
  await container.descendants().find(node => node.tagName === 'button' && node.textContent === '确认并保存双丝网').fire('click');
  await flush();
  assert.deepEqual(committed, { edits: { [ID]: { stage: '热恋' }, [ID2]: { stage: '陌生' } } });
  view.deactivate();
});

test('UI 清空草稿字段时给出明确错误且不调用保存', async () => {
  let commitCalls = 0;
  const emptySignalDraft = structuredClone(draft());
  emptySignalDraft.people[0].bond.nativeSignals = [];
  const state = { status: 'draft', draft: emptySignalDraft, followedCount: 1 };
  const composition = {
    inspect: async () => state,
    getState: () => state,
    generate: async () => state,
    commit: async () => { commitCalls += 1; return state; },
  };
  const view = createArchiveV2BondView({ composition, documentRef });
  const container = new Node();
  view.mount(container);
  await view.activate();
  assert.match(container.textContent, /本卡没有作者原生关系信息，千千结不伪造分数或标签/);
  const stage = container.descendants().find(node => node.dataset?.field === 'stage');
  stage.value = '   ';
  await stage.fire('change');
  const save = container.descendants().find(node => node.tagName === 'button' && node.textContent === '确认并保存双丝网');
  await save.fire('click');
  await flush();
  assert.equal(commitCalls, 0);
  assert.match(container.textContent, /字段不能清空保存/);
  assert.match(container.textContent, /熟悉|当前关系阶段/);
  view.deactivate();
});

test('AI 非五档 stage 被丢弃后，草稿常显空轴并要求用户五选一才能保存', async () => {
  let commitCalls = 0;
  let committed;
  const missingStageDraft = structuredClone(draft());
  delete missingStageDraft.people[0].bond.stage;
  const state = { status: 'draft', draft: missingStageDraft, followedCount: 1 };
  const composition = {
    inspect: async () => state,
    getState: () => state,
    generate: async () => state,
    commit: async value => { commitCalls += 1; committed = value; return state; },
  };
  const view = createArchiveV2BondView({ composition, documentRef });
  const container = new Node();
  view.mount(container);
  await view.activate();
  assert.equal(container.descendants().filter(node => String(node.className).startsWith('bond-stage-step')).length, 5);
  assert.equal(container.descendants().filter(node => node.attributes?.['aria-current'] === 'step').length, 0);
  await container.descendants().find(node => node.tagName === 'button' && node.textContent === '确认并保存双丝网').fire('click');
  assert.equal(commitCalls, 0);
  assert.match(container.textContent, /选择固定关系阶段/);
  const stage = container.descendants().find(node => node.dataset?.field === 'stage');
  assert.equal(stage.children[0].value, '');
  assert.equal(stage.children[0].disabled, true);
  stage.value = '相识';
  await stage.fire('change');
  await container.descendants().find(node => node.tagName === 'button' && node.textContent === '确认并保存双丝网').fire('click');
  await flush();
  assert.equal(commitCalls, 1);
  assert.deepEqual(committed, { edits: { [ID]: { stage: '相识' } } });
  view.deactivate();
});

test('UI 对 empty/persona/error 给出可理解状态，error 提供重试且旧 bonds 可继续显示', async () => {
  for (const status of ['empty', 'persona_mismatch', 'error']) {
    let state = { status, archive: status === 'error' ? archiveWithBond() : undefined, savedCount: status === 'error' ? 1 : 0 };
    const composition = {
      inspect: async () => state,
      getState: () => state,
      generate: async () => { state = { status: 'error', archive: archiveWithBond(), savedCount: 1 }; throw new Error('boom'); },
      commit: async () => state,
    };
    const view = createArchiveV2BondView({ composition, documentRef });
    const container = new Node();
    view.mount(container);
    await view.activate();
    if (status === 'empty') assert.match(container.textContent, /没有关注人物/);
    if (status === 'persona_mismatch') assert.match(container.textContent, /Persona/);
    if (status === 'error') {
      assert.match(container.textContent, /没有完成/);
      assert.match(container.textContent, /陌生相识熟悉暧昧热恋/);
      assert.ok(container.descendants().some(node => node.tagName === 'button' && node.textContent === '重新生成'));
    }
    view.deactivate();
  }
});
