import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

test('生产入口只装配 V3 记忆与独立人物工作区，面板提供四个主页面且旧 V1/V2 入口不存在', async () => {
  const [entry, panel, html, bootstrap, bundle, manifest] = await Promise.all([
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/panel.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8'),
    readFile(new URL('../dist/qqj-app.js', import.meta.url), 'utf8'),
    readFile(new URL('../manifest.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  for (const factory of ['createChatSession', 'createPluginLifecycle', 'createHostAdapter', 'createFoundationStore', 'createFoundationRuntime', 'createV3MemoryRuntime', 'createV3RecallRuntime', 'createPeopleWorkspaceStore', 'createPeopleWorkspaceRuntime', 'installPublicMemoryBridge']) {
    assert.equal((entry.match(new RegExp(`${factory}\\s*\\(`, 'g')) || []).length, 1, factory);
  }
  assert.match(entry, /filterWorldInfoSources:\s*sourcePermissions\.filterWorldInfoSources/, '生产入口必须把共享整本排除过滤器注入 V3 memory runtime');
  assert.match(entry, /import\s*\{\s*version\s+as\s+pluginVersion\s*\}\s*from\s*['"]\.\/manifest\.json['"]/, '生产回执版本必须只从 manifest.version 导入');
  assert.match(entry, /createV3RecallRuntime\([\s\S]*?pluginVersion,\s*\n\}\)/);
  assert.equal(manifest.version, '0.1.16');
  for (const marker of ['createArchiveV2', 'archiveV2', 'archive-v2', 'myriad-knots-bond-draft', '首次建立双丝网']) {
    assert.doesNotMatch(entry + panel + bootstrap + bundle, new RegExp(marker, 'i'));
  }
  assert.deepEqual([...html.matchAll(/data-tab="([^"]+)">([^<]+)/g)].map(match => [match[1], match[2]]), [['profiles', '千人'], ['events', '千结'], ['people', '双丝网'], ['settings', '设置']]);
  assert.match(panel, /activeTab === 'profiles'/, '千人必须使用独立人物资料视图');
  assert.match(panel, /setPage\?\.\(activeTab === 'people' \? 'people' : 'memories'\)/, '真实内容入口必须显式选择千结或双丝网页，不能落入视图默认管理页');
  assert.match(panel, /setPage\?\.\('management'\)/, '设置页必须挂载记忆管理视图');
  for (const path of [
    '../src/archive-v2.js',
    '../src/archive-v2-memory-composition.js',
    '../src/archive-v2-bond-composition.js',
    '../src/route-source.js',
    '../src/ui/archive-v2-initialization-view.js',
    '../src/ui/archive-v2-bond-view.js',
  ]) await assert.rejects(access(new URL(path, import.meta.url)));
});
