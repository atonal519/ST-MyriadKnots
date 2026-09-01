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
