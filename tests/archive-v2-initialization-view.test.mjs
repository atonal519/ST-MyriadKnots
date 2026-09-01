import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveV2InitializationView } from '../src/ui/archive-v2-initialization-view.js';

class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.type = ''; this._text = ''; }
  append(...children) { this.children.push(...children); for (const child of children) if (child instanceof Node) child.parentNode = this; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  async fire(name) { for (const handler of this.events[name] || []) await handler({ currentTarget: this, target: this }); }
  get textContent() { return this._text || this.children.map(child => child?.textContent ?? '').join(''); }
  set textContent(value) { this._text = String(value); }
  descendants() { return this.children.flatMap(child => child instanceof Node ? [child, ...child.descendants()] : []); }
}
const documentRef = { createElement: tag => new Node(tag), defaultView: { setInterval, clearInterval } };
const dossierViewFactory = ({ documentRef: doc }) => ({ render: () => { const node = doc.createElement('section'); node.textContent = '档案已显示'; return node; }, invalidate() {} });
const followedProfiles = { inspect: async () => ({ status: 'empty' }), generate: async () => ({ status: 'empty' }), commit: async () => ({ status: 'empty' }), getState: () => ({ status: 'empty' }) };

test('已有 archive-v2 打开立即显示，零 memory 初始化、零自动 AI', async () => {
  let memoryReads = 0;
  const view = createArchiveV2InitializationView({
    composition: { readArchive: async () => ({ status: 'ready', archive: { people: { order: [], byId: {} } }, revision: 1 }) },
    memory: { inspect: async () => { memoryReads += 1; }, start() {}, consolidatePeople() {}, confirmPeople() {}, getState: () => ({}) },
    followedProfiles,
    dossier: {},
    dossierViewFactory,
    documentRef,
  });
  const container = new Node();
  view.mount(container);
  assert.equal((await view.activate()).status, 'ready');
  assert.match(container.textContent, /档案已显示/);
  assert.equal(memoryReads, 0);
});

test('关闭面板只停止视图轮询，后台 memory 扫描继续且重开恢复状态', async () => {
  let release;
  let starts = 0;
  let invalidations = 0;
  let state = { status: 'uninitialized', targetFloor: 120, eligibleFloorCount: 120, completedBatches: 0, totalBatches: 13, peopleStatus: 'idle' };
  const memory = {
    inspect: async () => state,
    getState: () => state,
    start: () => {
      starts += 1;
      state = { ...state, status: 'running' };
      return new Promise(resolve => { release = () => { state = { ...state, status: 'ready', completedBatches: 13, peopleStatus: 'uninitialized' }; resolve(state); }; });
    },
    consolidatePeople: async () => ({}),
    confirmPeople: async () => ({}),
    invalidate: () => { invalidations += 1; },
  };
  const view = createArchiveV2InitializationView({
    composition: { readArchive: async () => ({ status: 'uninitialized' }) },
    memory,
    followedProfiles,
    dossier: {},
    dossierViewFactory,
    documentRef,
  });
  const container = new Node();
  view.mount(container);
  await view.activate();
  const start = container.descendants().find(node => node.tagName === 'button' && node.textContent === '开始扫描');
  assert.ok(start);
  await start.fire('click');
  assert.equal(starts, 1);
  view.deactivate();
  assert.equal(invalidations, 0);
  release();
  await new Promise(resolve => setImmediate(resolve));
  await view.activate();
  assert.match(container.textContent, /整理人物/);
  assert.equal(starts, 1);
  assert.equal(invalidations, 0);
});

test('新聊天初始化前只做声明确认且不强制验证；确认后才开始扫描', async () => {
  let confirmed = false;
  let starts = 0;
  const memory = {
    inspect: async () => ({ status: 'uninitialized', targetFloor: 5, eligibleFloorCount: 5 }),
    getState: () => ({ status: 'uninitialized' }),
    start: async () => { starts += 1; return { status: 'ready' }; },
    consolidatePeople: async () => ({}), confirmPeople: async () => ({}),
  };
  const sourcePermissions = { isCurrentConfirmed: () => confirmed, confirmCurrent: () => { confirmed = true; } };
  const sourcePermissionView = { renderPreflight: ({ onContinue }) => {
    const node = new Node('section'); node.append(Object.assign(new Node('button'), { textContent: '我已完成筛选，继续' }));
    node.children[0].addEventListener('click', onContinue); return node;
  } };
  const view = createArchiveV2InitializationView({
    composition: { readArchive: async () => ({ status: 'uninitialized' }) }, memory, followedProfiles, dossier: {}, dossierViewFactory, documentRef,
    sourcePermissions, sourcePermissionView,
  });
  const container = new Node(); view.mount(container); await view.activate();
  assert.equal(starts, 0);
  const confirm = container.descendants().find(node => node.tagName === 'button' && node.textContent === '我已完成筛选，继续');
  await confirm.fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, true);
  assert.equal(starts, 1);
});

for (const status of ['scanning', 'interrupted']) test(`持久化 ${status} 扫描显示进度并允许手动续跑`, async () => {
  let starts = 0;
  const state = { status, targetFloor: 148, eligibleFloorCount: 75, completedBatches: 3, totalBatches: 8 };
  const memory = {
    inspect: async () => state,
    getState: () => state,
    start: async () => { starts += 1; return { status: 'ready' }; },
    consolidatePeople: async () => ({}), confirmPeople: async () => ({}),
  };
  const view = createArchiveV2InitializationView({
    composition: { readArchive: async () => ({ status: 'uninitialized' }) }, memory, followedProfiles, dossier: {}, dossierViewFactory, documentRef,
  });
  const container = new Node(); view.mount(container); await view.activate();
  assert.match(container.textContent, /3 \/ 8 批/);
  const resume = container.descendants().find(node => node.tagName === 'button' && node.textContent === '继续扫描');
  assert.ok(resume);
  assert.equal(starts, 0);
  await resume.fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
});

test('持久化扫描续跑后活跃 Promise 只显示后台运行态且不能重复调用', async () => {
  let starts = 0;
  let state = { status: 'scanning', targetFloor: 148, eligibleFloorCount: 75, completedBatches: 3, totalBatches: 8 };
  const memory = {
    inspect: async () => state,
    getState: () => state,
    start: () => { starts += 1; return new Promise(() => {}); },
    consolidatePeople: async () => ({}), confirmPeople: async () => ({}),
  };
  const view = createArchiveV2InitializationView({
    composition: { readArchive: async () => ({ status: 'uninitialized' }) }, memory, followedProfiles, dossier: {}, dossierViewFactory, documentRef,
  });
  const container = new Node(); view.mount(container); await view.activate();
  const resume = container.descendants().find(node => node.tagName === 'button' && node.textContent === '继续扫描');
  assert.ok(resume);
  await resume.fire('click');
  assert.match(container.textContent, /正在扫描历史正文/);
  assert.equal(container.descendants().some(node => node.tagName === 'button' && node.textContent === '继续扫描'), false);
  await resume.fire('click');
  assert.equal(starts, 1);
});

test('source_changed 仍保持终止语义且不能续跑', async () => {
  let starts = 0;
  const state = { status: 'source_changed', completedBatches: 3, totalBatches: 8 };
  const memory = {
    inspect: async () => state,
    getState: () => state,
    start: async () => { starts += 1; },
    consolidatePeople: async () => ({}), confirmPeople: async () => ({}),
  };
  const view = createArchiveV2InitializationView({
    composition: { readArchive: async () => ({ status: 'uninitialized' }) }, memory, followedProfiles, dossier: {}, dossierViewFactory, documentRef,
  });
  const container = new Node(); view.mount(container); await view.activate();
  assert.match(container.textContent, /初始化快照与已保存批次不一致/);
  assert.equal(container.descendants().some(node => node.tagName === 'button' && node.textContent === '继续扫描'), false);
  assert.equal(starts, 0);
});

for (const [status, copy] of [
  ['source_changed', /初始化快照与已保存批次不一致/],
  ['conflict', /正式档案已经存在/],
]) test(`续跑返回 ${status} 后不被旧 scanning manifest 覆盖`, async () => {
  let starts = 0;
  let inspections = 0;
  const persisted = { status: 'scanning', completedBatches: 3, totalBatches: 8 };
  const memory = {
    inspect: async () => { inspections += 1; return persisted; },
    getState: () => persisted,
    start: async () => { starts += 1; return { status }; },
    consolidatePeople: async () => ({}), confirmPeople: async () => ({}),
  };
  const view = createArchiveV2InitializationView({
    composition: { readArchive: async () => ({ status: 'uninitialized' }) }, memory, followedProfiles, dossier: {}, dossierViewFactory, documentRef,
  });
  const container = new Node(); view.mount(container); await view.activate();
  const resume = container.descendants().find(node => node.tagName === 'button' && node.textContent === '继续扫描');
  assert.ok(resume);
  await resume.fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(inspections, 1);
  assert.match(container.textContent, copy);
  assert.equal(container.descendants().some(node => node.tagName === 'button' && node.textContent === '继续扫描'), false);
});
