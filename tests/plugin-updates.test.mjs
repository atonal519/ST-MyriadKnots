import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginUpdates, resolvePluginInstallation } from '../src/plugin-updates.js';
import { createPluginUpdatesView } from '../src/ui/plugin-updates-view.js';
const info = { currentBranchName: 'feature/next', currentCommitHash: 'abc123', isUpToDate: false, remoteUrl: 'https://github.com/example/fork.git' };
const moduleUrl = 'https://host.invalid/scripts/extensions/third-party/ST-QianQianJie/dist/qqj-app.js?v=local';
const response = (data, status = 200) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status });
const fixture = (handler, options = {}) => {
  const requests = [];
  const updates = createPluginUpdates({ moduleUrl, extensionTypes: () => ({ 'third-party/ST-QianQianJie': 'global' }), noticePath: 'docs/updates-0.8.0.md', headers: () => ({ 'X-CSRF-Token': 'test-csrf' }), fetchImpl: async (url, init) => { requests.push({ url: String(url), init }); return handler(String(url), init); }, ...options });
  return { updates, requests };
};
test('首次打开才检查一次；并发首次打开与再次打开不重复，手动检查仍可用', async () => {
  const { updates, requests } = fixture(() => response(info));
  assert.equal(requests.length, 0); assert.equal(updates.getState().status, 'unchecked');
  await Promise.all([updates.ensureChecked(), updates.ensureChecked()]); await updates.ensureChecked();
  assert.equal(requests.length, 1); assert.equal(updates.getState().status, 'available');
  assert.equal(requests[0].url, '/api/extensions/version');
  assert.deepEqual(JSON.parse(requests[0].init.body), { extensionName: 'ST-QianQianJie', global: true });
  assert.equal(requests[0].init.headers['X-CSRF-Token'], 'test-csrf');
  await updates.check(); assert.equal(requests.length, 2);
});
test('实际运行目录识别旧/新名称及local/global，未识别安装类型不猜全局', () => {
  for (const name of ['ST-QianQianJie', 'ST-MyriadKnots']) for (const type of ['local', 'global']) {
    const install = resolvePluginInstallation({ moduleUrl: `https://h.invalid/scripts/extensions/third-party/${name}/index.js`, extensionTypes: { [`third-party/${name}`]: type } });
    assert.equal(install.extensionName, name); assert.equal(install.global, type === 'global');
  }
  assert.throws(() => resolvePluginInstallation({ moduleUrl, extensionTypes: {} }), /安装/);
});
test('原生/TT最小四字段版本有效，空Git元数据不能显示稳定版本', async () => {
  const { updates } = fixture(() => response({ ...info, isUpToDate: true })); await updates.check(); assert.equal(updates.getState().status, 'stable');
  const empty = fixture(() => response({ currentBranchName: '', currentCommitHash: '', remoteUrl: '', isUpToDate: true })); await empty.updates.check(); assert.equal(empty.updates.getState().status, 'error');
});
test('远端公告按原fork/分支惰性读取指针与同源正文，绝不传宿主头/凭证', async () => {
  const { updates, requests } = fixture((url) => url.startsWith('/api/') ? response(info) : url.endsWith('/manifest.json') ? response({ update_notice: 'docs/notes.md' }) : response('# 公告\n正文'));
  await updates.ensureChecked(); assert.equal(requests.length, 1);
  const notice = await updates.readNotice('available'); assert.equal(notice.ok, true); assert.equal(notice.markdown, '# 公告\n正文');
  assert.equal(requests[1].url, 'https://raw.githubusercontent.com/example/fork/feature%2Fnext/manifest.json');
  assert.equal(requests[2].url, 'https://raw.githubusercontent.com/example/fork/feature%2Fnext/docs/notes.md');
  assert.equal(requests[1].init.credentials, 'omit'); assert.equal(requests[2].init.headers, undefined);
});
test('本地公告用安装目录与现有指针；远端旧manifest无指针不拿本地冒充', async () => {
  const { updates, requests } = fixture(url => url.startsWith('/api/') ? response(info) : url.includes('raw.githubusercontent') ? response({ version: 'old' }) : response('# 已安装公告'));
  assert.equal((await updates.readNotice('installed')).markdown, '# 已安装公告');
  assert.equal(requests[0].url, 'https://host.invalid/scripts/extensions/third-party/ST-QianQianJie/docs/updates-0.8.0.md');
  await updates.check(); const notice = await updates.readNotice('available'); assert.equal(notice.ok, false); assert.match(notice.message, /未提供/);
  assert.equal(requests.filter(r => r.url.endsWith('/docs/updates-0.8.0.md')).length, 1);
});
test('不支持的远端或越界公告路径不改投官方来源，仍可普通更新', async () => {
  for (const remote of ['https://code.invalid/team/repo.git', info.remoteUrl]) {
    const { updates, requests } = fixture(url => url.startsWith('/api/extensions/version') ? response({ ...info, remoteUrl: remote }) : url.includes('/manifest.json') ? response({ update_notice: 'https://other.invalid/leak' }) : response({ isUpToDate: false, shortCommitHash: 'def5678' }));
    await updates.check(); assert.equal((await updates.readNotice('available')).ok, false); await updates.update();
    assert.equal(updates.getState().status, 'stable'); assert.ok(!requests.some(r => r.url.includes('other.invalid') || r.url.includes('atonal519')));
    const req = requests.find(r => r.url === '/api/extensions/update'); assert.deepEqual(JSON.parse(req.init.body), { extensionName: 'ST-QianQianJie', global: true });
  }
});
test('更新接受TT最小返回、无force/分支字段；冲突与403/404如实反馈，不自动重试', async () => {
  for (const status of [200, 409, 403, 404]) {
    const { updates, requests } = fixture(url => url.endsWith('/version') ? response(info) : response(status === 200 ? { isUpToDate: false, shortCommitHash: 'def5678' } : 'host-private-detail', status));
    await updates.check(); if (status === 200) { await updates.update(); assert.equal(updates.getState().status, 'stable'); }
    else { await assert.rejects(updates.update(), status === 409 ? /本地修改|冲突/ : status === 403 ? /管理员|权限/ : /扩展页/); assert.equal(updates.getState().status, 'available'); }
    assert.equal(requests.length, 2); assert.ok(!JSON.parse(requests[1].init.body).force); assert.ok(!updates.getState().error?.includes('host-private-detail'));
  }
});
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.textContent = ''; this.className = ''; this.hidden = false; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(k, v) { this.attributes[k] = String(v); } addEventListener(k, fn) { this.listeners[k] = fn; }
  click() { return this.listeners.click?.(); }
}
const documentRef = { createElement: tag => new Node(tag) };
const flatten = n => [n, ...n.children.flatMap(flatten)];
test('每次点击可更新弹公告；取消不更新，成功仅toast并稳定，公告失败也可更新', async () => {
  const { updates, requests } = fixture(url => url.endsWith('/version') ? response(info) : url.endsWith('/update') ? response({ isUpToDate: false, shortCommitHash: 'def5678' }) : response('', 404));
  await updates.check(); let confirmed = false; const dialogs = [], toasts = [];
  const view = createPluginUpdatesView({ updates, documentRef, dialog: { custom: async o => { dialogs.push(o); return confirmed ? o.submit() : null; } }, renderMarkdown: t => t, notifyUser: n => toasts.push(n) });
  assert.equal(view.controls.children.length, 1, '版本按钮是唯一检查与更新入口');
  const statusButton = view.controls.children[0]; assert.equal(statusButton.textContent, '可更新');
  const busyStates = []; const unsubscribe = updates.subscribe(state => { if (['checking', 'updating'].includes(state.status)) busyStates.push([state.status, statusButton.disabled]); });
  await statusButton.click(); await statusButton.click(); assert.equal(dialogs.length, 2); assert.equal(requests.filter(r => r.url.endsWith('/update')).length, 0);
  assert.equal(dialogs[0].cancelText, '暂不更新'); assert.equal(dialogs[0].confirmText, '更新');
  confirmed = true; await statusButton.click(); assert.equal(updates.getState().status, 'stable'); assert.equal(statusButton.textContent, '稳定版本');
  assert.deepEqual(toasts, [{ kind: 'success', text: '千千结已更新，请刷新酒馆后使用' }]);
  assert.ok(!flatten(view.controls).some(n => /待刷新|已刷新/.test(n.textContent)));
  assert.equal(statusButton.disabled, false);
  await statusButton.click();
  assert.equal(requests.filter(r => r.url.endsWith('/version')).length, 2, '稳定版本按钮仍可检查更新');
  assert.equal(dialogs.length, 3, '稳定版本点击不弹更新确认');
  assert.deepEqual(busyStates, [['updating', true], ['checking', true]]);
  assert.equal(statusButton.disabled, false); unsubscribe(); view.dispose();
});
test('设置组件释放订阅；查看已安装公告不检查远端，不显示更新按钮', async () => {
  let subscriptions = 0; const calls = [], dialogs = [];
  const updates = { getState: () => ({ status: 'unchecked', error: '' }), subscribe() { subscriptions++; return () => subscriptions--; }, readNotice: async type => { calls.push(type); return { ok: true, markdown: '# 已安装公告' }; } };
  const view = createPluginUpdatesView({ updates, documentRef, dialog: { custom: async o => { dialogs.push(o); return null; } }, renderMarkdown: t => '<h1>已安装公告</h1>' });
  await view.noticeRow.children[1].click(); assert.deepEqual(calls, ['installed']); assert.equal(dialogs[0].confirmText, '关闭'); assert.equal(dialogs[0].cancelText, '');
  assert.equal(subscriptions, 1); view.dispose(); assert.equal(subscriptions, 0);
});

test('HTTP200空对象或无有效提交信息不冒充更新成功', async () => {
  for (const result of [{}, { isUpToDate: true, shortCommitHash: '' }, { isUpToDate: 'false', shortCommitHash: 'def5678' }]) {
    const { updates } = fixture(url => response(url.endsWith('/version') ? info : result));
    await updates.check(); await assert.rejects(updates.update(), /无法确认/); assert.equal(updates.getState().status, 'available');
  }
});
