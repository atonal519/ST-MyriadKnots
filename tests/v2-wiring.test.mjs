import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('生产入口只装配 V2，面板四 Tab 收敛且无 V1 integration API', async () => {
  const [entry, panel, html, bootstrap, bundle] = await Promise.all([
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/panel.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8'),
    readFile(new URL('../dist/qqj-app.js', import.meta.url), 'utf8'),
  ]);
  for (const factory of ['createArchiveV2Session', 'createArchiveV2Lifecycle', 'createArchiveV2Composition', 'createArchiveV2MemoryComposition', 'createArchiveV2FollowedProfileComposition', 'createArchiveV2DossierComposition', 'createArchiveV2BondComposition']) {
    assert.equal((entry.match(new RegExp(`${factory}\\s*\\(`, 'g')) || []).length, 1, factory);
  }
  for (const marker of ['registerIntegration', 'startInitialRun', 'createRuntimeRunner', 'createFormalAdapter', 'createCRegistryAdapter', 'createInitialRelationGenerationAdapter']) assert.doesNotMatch(entry, new RegExp(marker));
  assert.doesNotMatch(panel, /formal|sourceCatalog|initialRelations|reviewActions|peopleFoundation/);
  assert.match(bootstrap, /archiveV2ViewFactory/);
  assert.match(bootstrap, /archiveV2BondViewFactory/);
  assert.match(bundle, /myriad-knots-bond-draft/);
  assert.match(bundle, /首次建立双丝网/);
  assert.deepEqual([...html.matchAll(/data-tab="([^"]+)">([^<]+)/g)].map(match => [match[1], match[2]]), [['people', '千人'], ['events', '千事'], ['bonds', '双丝网'], ['next', '下一步']]);
});
