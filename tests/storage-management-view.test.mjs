import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageManagementView } from '../src/ui/storage-management-view.js';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.className = ''; this._text = ''; this.hidden = false; this.disabled = false; this.checked = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  fire(name) { return this.listeners[name]?.({ currentTarget: this, target: this }); }
  setAttribute(name, value) { this[name] = String(value); }
  get textContent() { return this._text || this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = String(value); }
}
const documentRef = { createElement: tag => new Node(tag) };
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
const stats = {
  total: { count: 220, bytes: 20 * 1024 * 1024 }, active: { count: 20, bytes: 4 * 1024 * 1024 }, cleanup: { count: 180, bytes: 14 * 1024 * 1024 }, retained: { count: 20, bytes: 2 * 1024 * 1024 },
  breakdown: {
    active: { story: { count: 8, bytes: 1 }, people: { count: 7, bytes: 1 }, runtime: { count: 4, bytes: 1 } },
    cleanup: { story: { count: 80, bytes: 1 }, people: { count: 60, bytes: 1 }, runtime: { count: 40, bytes: 1 } },
  },
};

function fixture() {
  let state = { status: 'idle', stats: null, busy: false, autoEnabled: false, autoPending: false, error: null };
  const listeners = new Set(), calls = [];
  const publish = () => { for (const listener of listeners) listener(state); };
  const manager = {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async scan() { calls.push('scan'); state = { ...state, status: 'ready', stats }; publish(); return state; },
    async cleanup() { calls.push('cleanup'); state = { ...state, status: 'ready', stats: { ...stats, cleanup: { count: 0, bytes: 0 } } }; publish(); return { status: 'completed', deletedCount: 180, convergedCount: 0, remainingCount: 0 }; },
    setAutoEnabled(value) { calls.push(['auto', value]); state = { ...state, autoEnabled: value }; publish(); return state; },
  };
  return { manager, calls, setState(patch) { state = { ...state, ...patch }; publish(); } };
}

test('存储面板渲染约数、刷新、自动开关和危险清理确认；忙碌时按钮禁用', async () => {
  const f = fixture(); let confirm = false, confirmOptions = null;
  const container = new Node('div');
  const view = createStorageManagementView({ manager: f.manager, documentRef, confirmImpl: options => { confirmOptions = options; return confirm; } });
  view.mount(container); await view.activate();
  assert.deepEqual(f.calls, ['scan']);
  let text = container.textContent;
  for (const copy of ['当前聊天', '总记录', '当前有效基础数据', '可清理的旧版本', '约 20.00 MiB', '每新增 10 个稳定 AI 楼', '100 条', '约 8 MiB']) assert.match(text, new RegExp(copy));
  let nodes = flatten(container), refresh = nodes.find(node => node.tag === 'button' && node.textContent === '刷新统计');
  await refresh.fire('click'); assert.deepEqual(f.calls, ['scan', 'scan']);
  nodes = flatten(container); let clean = nodes.find(node => node.tag === 'button' && node.textContent === '清理旧版本');
  assert.equal(clean.disabled, false);
  await clean.fire('click'); assert.equal(f.calls.includes('cleanup'), false); assert.match(container.textContent, /已取消清理/);
  assert.match(confirmOptions.body, /摘要.*双丝网.*千人人物资料.*刻度.*聊天正文.*不可恢复/);
  nodes = flatten(container); const auto = nodes.find(node => node.tag === 'input'); auto.checked = true; auto.fire('change');
  assert.deepEqual(f.calls.at(-1), ['auto', true]); assert.match(container.textContent, /自动清理已开启/);
  confirm = true; clean = flatten(container).find(node => node.tag === 'button' && node.textContent === '清理旧版本'); await clean.fire('click');
  assert.ok(f.calls.includes('cleanup')); assert.match(container.textContent, /清理完成：删除 180 条/);
  f.setState({ busy: true, stats }); clean = flatten(container).find(node => node.tag === 'button' && node.textContent === '清理旧版本');
  assert.equal(clean.disabled, true);
  f.setState({ busy: false, status: 'scanning' }); nodes = flatten(container);
  refresh = nodes.find(node => node.tag === 'button' && node.textContent === '刷新统计');
  clean = nodes.find(node => node.tag === 'button' && node.textContent === '清理旧版本');
  assert.equal(refresh.disabled, true); assert.equal(clean.disabled, true);
});

test('确认弹窗等待期间停用视图，迟到确认不会执行清理或污染新界面', async () => {
  const f = fixture(); let resolveConfirm;
  const container = new Node('div');
  const view = createStorageManagementView({ manager: f.manager, documentRef, confirmImpl: () => new Promise(resolve => { resolveConfirm = resolve; }) });
  view.mount(container); await view.activate();
  const clean = flatten(container).find(node => node.tag === 'button' && node.textContent === '清理旧版本');
  const pending = clean.fire('click'); view.deactivate(); resolveConfirm(true); await pending;
  assert.equal(f.calls.includes('cleanup'), false);
});

test('旧白鳥不支持永久删除时显示明确更新提示', async () => {
  const f = fixture();
  f.manager.cleanup = async () => ({
    status: 'partial', deletedCount: 0, convergedCount: 0, remainingCount: 180,
    error: Object.assign(new Error('存储管理永久清理需要更新白鳥后端；本次没有删除任何文件。'), { code: 'QQJ_STORAGE_PERMANENT_DELETE_UNAVAILABLE' }),
  });
  const container = new Node('div');
  const view = createStorageManagementView({ manager: f.manager, documentRef, confirmImpl: () => true });
  view.mount(container); await view.activate();
  const clean = flatten(container).find(node => node.tag === 'button' && node.textContent === '清理旧版本');
  await clean.fire('click');
  assert.match(container.textContent, /永久清理需要更新白鳥后端/u);
});
