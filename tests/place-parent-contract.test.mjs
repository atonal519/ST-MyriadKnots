import assert from 'node:assert/strict';
import test from 'node:test';

const root = new URL('../', import.meta.url).pathname.replace(/\/$/u, '');

const { createExtractorEnvelope, normalizeExtractorResponse } = await import(`${root}/src/v3/extractor.js`);
const { expandPlacePaths, mergePlaceFoundation, projectPlaceParentLinks } = await import(`${root}/src/v3/place-foundation.js`);
const { emptyPlaceWorkspace } = await import(`${root}/src/v3/place-workspace.js`);
const id = n => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const now = '2026-11-08T00:00:00.000Z';
const names = new Map([[id(1), '甲馆'], [id(2), '乙馆'], [id(3), '客房'], [id(4), '原二楼'], [id(5), '别院'], [id(6), '别院书房']]);
const seeds = [...names].map(([entityId, name]) => ({ schemaVersion: 3, recordType: 'entity', id: entityId,
  chatId: id(90), narrativeGeneration: id(91), entityType: 'place', displayName: name, aliases: [], specialRole: 'none',
  firstSeenFloorId: null, lastSeenFloorId: null, status: 'established', mergedIntoEntityId: null,
  mergeEvidenceRefs: [], baselineClaimIds: [], createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: null }));
const source = { kind: 'worldbook', sourceName: '地图', locator: '地图:old', fingerprint: 'sha256:old', quote: '甲馆原二楼内有客房，别院内有书房。' };
const baseWorkspace = () => ({ ...emptyPlaceWorkspace(id(90)), foundation: { schemaVersion: 1, entities: structuredClone(seeds), facts: [
  [3, 4], [4, 1], [6, 5],
].map(([child, parent], index) => ({ itemId: id(110 + index), kind: 'containment', placeEntityId: id(child), parentEntityId: id(parent), knownFromFloorId: id(94), source })) } });
const parentNames = (parents, entities) => {
  const labels = new Map(entities.map(entity => [entity.id, entity.displayName]));
  return Object.fromEntries([...parents].map(([child, value]) => [labels.get(child) ?? child,
    [...value.parents.keys()].map(parent => labels.get(parent) ?? parent)]).sort(([a], [b]) => a.localeCompare(b)));
};
let mixedSourceParents;

async function increment(label, { body, book, paths, oldParents = new Map(), rawMiddle = false }) {
  const floor = { id: id(93), chatId: id(90), narrativeGeneration: id(91), assistantSeq: 2, content: { canonicalContent: body } };
  const envelope = await createExtractorEnvelope({ batchId: id(92), chatId: id(90), narrativeGeneration: id(91), floor, entities: seeds,
    previousFloorContext: { parentEntityIdsByPlaceId: oldParents },
    placeWorldbookSources: book ? [{ sourceKey: 'worldbook-1', sourceName: '地图', locator: '地图:1', fingerprint: 'sha256:probe', content: book }] : [] });
  const key = name => envelope.request.payload.knownPlaces.find(place => place.displayName === name).entityKey;
  const evidence = { source: 'canonicalContent', sourceFloorKey: 'floor-1', exactQuote: body };
  const packet = { summary: body, spatialFacts: { places: [{ key: 'place-mention-1', name: '客房', identity: 'existing', sameAsPlaceKey: key('客房'), ...evidence }], containments: [], positions: [] }, placePaths: paths(key) };
  if (rawMiddle) {
    packet.spatialFacts.places.push({ key: 'place-mention-2', name: '甲馆', identity: 'existing', sameAsPlaceKey: key('甲馆'), ...evidence },
      { key: 'place-mention-3', name: '二楼', identity: 'new', ...evidence });
    packet.spatialFacts.containments.push({ placeKey: 'place-mention-1', parentPlaceKey: 'place-mention-3', ...evidence },
      { placeKey: 'place-mention-3', parentPlaceKey: 'place-mention-2', ...evidence });
  }
  const normalized = await normalizeExtractorResponse({ response: packet, envelope, floor, existingEntities: seeds, now, expectedScope: envelope.scope });
  const entities = [...seeds, ...normalized.newEntities];
  const workspace = mergePlaceFoundation(emptyPlaceWorkspace(id(90)), normalized.foundationPatch);
  const parents = projectPlaceParentLinks([normalized.memory], workspace, new Map([[floor.id, 2]]));
  const labels = new Map(entities.map(entity => [entity.id, entity.displayName]));
  const result = { label, isolated: normalized.isolated, roomRetained: entities.some(entity => entity.id === id(3)),
    coreEdges: (normalized.memory.spatialFacts?.containments ?? []).map(edge => [labels.get(edge.placeEntityId), labels.get(edge.parentEntityId)]),
    foundationEdges: normalized.foundationPatch.facts.filter(fact => fact.kind === 'containment').map(fact => [labels.get(fact.placeEntityId), labels.get(fact.parentEntityId)]),
    parents: parentNames(parents, entities) };
  return result;
}

for (const reverse of [false, true]) test(`同批冲突来源换序${reverse}`, async () => {
  const body = '客房位于乙馆内部。', book = '客房位于甲馆内部。';
  const result = await increment(`mixed-conflict-${reverse ? 'body-first' : 'book-first'}`, { body, book, paths: key => {
    const a = { placeKey: 'place-mention-1', path: [{ name: '甲馆', sameAsPlaceKey: key('甲馆') }, { name: '客房', sameAsPlaceKey: key('客房') }], evidence: [{ source: 'worldbook', sourceKey: 'worldbook-1', exactQuote: book }] };
    const b = { placeKey: 'place-mention-1', path: [{ name: '乙馆', sameAsPlaceKey: key('乙馆') }, { name: '客房', sameAsPlaceKey: key('客房') }], evidence: [{ source: 'canonicalContent', sourceFloorKey: 'floor-1', exactQuote: body }] };
    return reverse ? [b, a] : [a, b];
  } });
  assert.deepEqual(result.isolated, []);
  assert.deepEqual(result.parents['客房'], ['甲馆']);
  if (mixedSourceParents) assert.deepEqual(result.parents, mixedSourceParents);
  mixedSourceParents = result.parents;
});

for (const withBook of [false, true]) for (const reverse of [false, true]) test(`兼容细链保最近父${withBook}-${reverse}`, async () => {
  const body = '甲馆二楼内设有客房。', book = '甲馆内设有客房。';
  const result = await increment(`compatible-refinement-${withBook ? 'with-book' : 'body-only'}-${reverse ? 'body-first' : 'book-first'}`, {
    body, book: withBook ? book : null, oldParents: new Map([[id(3), new Set([id(1)])]]), paths: key => {
      const coarse = { placeKey: 'place-mention-1', path: [{ name: '甲馆', sameAsPlaceKey: key('甲馆') }, { name: '客房', sameAsPlaceKey: key('客房') }], evidence: [{ source: 'worldbook', sourceKey: 'worldbook-1', exactQuote: book }] };
      const fine = { placeKey: 'place-mention-1', path: [{ name: '甲馆', sameAsPlaceKey: key('甲馆') }, { name: '二楼' }, { name: '客房', sameAsPlaceKey: key('客房') }], evidence: [{ source: 'canonicalContent', sourceFloorKey: 'floor-1', exactQuote: body }] };
      return withBook ? reverse ? [fine, coarse] : [coarse, fine] : [fine];
    },
  });
  assert.equal(result.roomRetained, true);
  assert.deepEqual(result.parents['客房'], ['二楼']);
});

for (const coarsePath of [false, true]) test(`raw细链与粗path${coarsePath}`, async () => {
  const body = '甲馆二楼内设有客房。';
  const result = await increment(`raw-fine-${coarsePath ? 'with-coarse-body-path' : 'only'}`, {
    body, rawMiddle: true, oldParents: new Map([[id(3), new Set([id(1)])]]), paths: key => coarsePath ? [{
      placeKey: 'place-mention-1', path: [{ name: '甲馆', sameAsPlaceKey: key('甲馆') }, { name: '客房', sameAsPlaceKey: key('客房') }],
      evidence: [{ source: 'canonicalContent', sourceFloorKey: 'floor-1', exactQuote: body }],
    }] : [],
  });
  assert.deepEqual(result.isolated, []);
  assert.deepEqual(result.parents['客房'], ['二楼']);
});

async function organize(label, paths, workspace = baseWorkspace()) {
  const bindings = seeds.map((entity, index) => ({ entityKey: `place-${index + 1}`, entityId: entity.id, labels: [entity.displayName] }));
  const key = name => bindings.find(binding => binding.labels[0] === name).entityKey;
  const book = '甲馆原二楼内有客房，别院内有书房。甲馆二楼内设有客房。别院内设有画室。甲馆在乙馆内部。乙馆在甲馆内部。';
  const parents = new Map([[id(3), new Set([id(4)])], [id(4), new Set([id(1)])], [id(6), new Set([id(5)])]]);
  const expanded = await expandPlacePaths({ packet: { placePaths: paths(key).map(entry => ({ ...entry, evidence: [{ source: 'worldbook', sourceKey: 'worldbook-1', exactQuote: book }] })) },
    envelope: { request: { task: 'organizePlaces', payload: { knownPlaces: bindings.map(binding => ({ entityKey: binding.entityKey, displayName: binding.labels[0] })) } },
      scope: { chatId: id(90), narrativeGeneration: id(91), batchId: id(92), floorId: id(93), identityProjection: { placeWorkspace: workspace },
        placeCatalogBindings: bindings, parentEntityIdsByPlaceId: parents, placeWorldbookSources: [{ sourceKey: 'worldbook-1', sourceName: '地图', locator: '地图:1', fingerprint: 'sha256:probe', content: book }] } }, existingEntities: seeds, now, persistBodyPaths: true });
  const merged = mergePlaceFoundation(workspace, expanded.foundationPatch);
  const final = projectPlaceParentLinks([], merged, new Map([[id(94), 1], [id(93), 2]]));
  const result = { label, isolated: expanded.isolated, parents: parentNames(final, expanded.entities), addedContainments: expanded.foundationPatch.facts.filter(fact => fact.kind === 'containment').length };
  return result;
}

const before = parentNames(projectPlaceParentLinks([], baseWorkspace(), new Map([[id(94), 1]])), seeds);
for (const mapLevel of ['scope', 'city', null]) test(`mapLevel独立${mapLevel}`, async () => {
  const result = await organize(`organize-mapLevel-${mapLevel}`, key => [{ path: [{ sameAsPlaceKey: key('客房'), mapLevel }] }]);
  assert.deepEqual(result.parents, before); assert.equal(result.addedContainments, 0);
});
for (const manualParent of [null, id(2)]) test(`人工父优先${manualParent}`, async () => {
  const workspace = baseWorkspace();
  workspace.placesByEntityId[id(3)] = { parentEntityId: manualParent, scopes: { parentEntityId: { knownThroughFloorId: id(94), coveredFloorIds: [id(94)], coveredItemIds: [] } } };
  const result = await organize(`organize-manual-${manualParent === null ? 'null' : '乙馆'}`, key => [{ path: [{ sameAsPlaceKey: key('甲馆') }, { name: '二楼' }, { sameAsPlaceKey: key('客房') }] }], workspace);
  assert.deepEqual(result.parents['客房'], manualParent ? ['乙馆'] : []);
  assert.deepEqual(result.parents['别院书房'], ['别院']);
});
let independentParents;
for (const reverse of [false, true]) test(`独立枝换序${reverse}`, async () => {
  const result = await organize(`organize-independent-${reverse ? 'reverse' : 'forward'}`, key => {
    const a = { path: [{ sameAsPlaceKey: key('原二楼') }, { sameAsPlaceKey: key('客房') }] };
    const b = { path: [{ sameAsPlaceKey: key('别院') }, { name: '画室' }] };
    return reverse ? [b, a] : [a, b];
  });
  assert.deepEqual(result.isolated, []);
  if (independentParents) assert.deepEqual(result.parents, independentParents);
  independentParents = result.parents;
});
for (const reverse of [false, true]) test(`同批循环保旧树${reverse}`, async () => {
  const result = await organize(`organize-cycle-${reverse ? 'BA-first' : 'AB-first'}`, key => {
    const a = { path: [{ sameAsPlaceKey: key('甲馆') }, { sameAsPlaceKey: key('乙馆') }] };
    const b = { path: [{ sameAsPlaceKey: key('乙馆') }, { sameAsPlaceKey: key('甲馆') }] };
    return reverse ? [b, a] : [a, b];
  });
  assert.equal(result.addedContainments, 0);
  assert.deepEqual(result.parents, before);
  assert.ok(result.isolated.length > 0);
});

test('同批新地点显式key在粗细path换序后仍用同一身份和最近父', async () => {
  const body = '甲馆二楼内设有客房。';
  const floor = { id: id(93), chatId: id(90), narrativeGeneration: id(91), assistantSeq: 1, content: { canonicalContent: body } };
  const envelope = await createExtractorEnvelope({ batchId: id(92), chatId: id(90), narrativeGeneration: id(91), floor, entities: [] });
  const evidence = { source: 'canonicalContent', sourceFloorKey: 'floor-1', exactQuote: body };
  const coarse = { path: [{ name: '甲馆', placeKey: 'place-mention-1' }, { name: '客房', placeKey: 'place-mention-2' }], ...evidence };
  const fine = { path: [{ name: '甲馆', placeKey: 'place-mention-1' }, { name: '二楼' }, { name: '客房', placeKey: 'place-mention-2' }], ...evidence };
  const outputs = [];
  for (const placePaths of [[coarse, fine], [fine, coarse]]) {
    const result = await normalizeExtractorResponse({ response: { summary: body, spatialFacts: {
      places: ['甲馆', '客房'].map((name, index) => ({ key: `place-mention-${index + 1}`, name, identity: 'new', ...evidence })), containments: [], positions: [],
    }, placePaths }, envelope, floor, existingEntities: [], now, expectedScope: envelope.scope });
    assert.deepEqual(result.isolated, []);
    const parents = projectPlaceParentLinks([result.memory], mergePlaceFoundation(emptyPlaceWorkspace(id(90)), result.foundationPatch), new Map([[floor.id, 1]]));
    assert.deepEqual(parentNames(parents, result.newEntities)['客房'], ['二楼']);
    outputs.push(Object.fromEntries(result.newEntities.map(entity => [entity.displayName, entity.id])));
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

test('身份归一后的同源粗细包含仍保最近父及独立来源', async () => {
  const { projectFloorMemoryIdentityReferences } = await import('../src/v3/entity-identity.js');
  const floorId = id(93), evidenceRefs = [{ floorId }];
  const memory = { floorId, recordStatus: 'active', spatialFacts: { containments: [
    [3, 1], [3, 4], [4, 1],
  ].map(([child, parent], index) => ({ itemId: id(130 + index), placeEntityId: id(child), parentEntityId: id(parent), evidenceRefs })), positions: [] } };
  const projected = projectFloorMemoryIdentityReferences(memory);
  assert.ok(projected.spatialFacts.containments.some(edge => edge.placeEntityId === id(3) && edge.parentEntityId === id(4)));
  const parents = projectPlaceParentLinks([projected], null, new Map([[floorId, 1]]));
  assert.deepEqual([...parents.get(id(3)).parents.keys()], [id(4)]);
});

test('增量同批循环整条隔离并保无关枝，不将孤立新节点写进地点库', async () => {
  const body = '继续整理地点。', book = '甲馆内部有新楼层，新楼层内部有乙馆。乙馆内部有甲馆。别院内部有画室。';
  const floor = { id: id(93), chatId: id(90), narrativeGeneration: id(91), assistantSeq: 1, content: { canonicalContent: body } };
  const envelope = await createExtractorEnvelope({ batchId: id(92), chatId: id(90), narrativeGeneration: id(91), floor, entities: seeds,
    placeWorldbookSources: [{ sourceKey: 'worldbook-1', sourceName: '地图', locator: '地图:1', fingerprint: 'sha256:probe', content: book }] });
  const key = name => envelope.request.payload.knownPlaces.find(place => place.displayName === name).entityKey;
  const evidence = { source: 'worldbook', sourceKey: 'worldbook-1', exactQuote: book };
  const result = await normalizeExtractorResponse({ response: { summary: body, placePaths: [
    { path: [{ name: '甲馆', sameAsPlaceKey: key('甲馆') }, { name: '新楼层' }, { name: '乙馆', sameAsPlaceKey: key('乙馆') }], ...evidence },
    { path: [{ name: '乙馆', sameAsPlaceKey: key('乙馆') }, { name: '甲馆', sameAsPlaceKey: key('甲馆') }], ...evidence },
    { path: [{ name: '别院', sameAsPlaceKey: key('别院') }, { name: '画室' }], ...evidence },
  ] }, envelope, floor, existingEntities: seeds, now, expectedScope: envelope.scope });
  assert.ok(result.isolated.some(issue => issue.code === 'QQJ_PLACE_PATH_SCOPE_CONFLICT'));
  assert.equal(result.foundationPatch.entities.some(entity => entity.displayName === '新楼层'), false);
  assert.ok(result.foundationPatch.entities.some(entity => entity.displayName === '画室'));
});
