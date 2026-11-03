import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { QIANCHUANG_MAP_ASSETS, selectQianchuangMapAsset } from '../src/qianchuang-map-assets.js';
import { CITY_MAPS } from '../src/ui/qianchuang-city-maps.js';
import { createGenericMapLoader } from '../src/ui/qianchuang-map-loader.js';
import { createCityMapLoader } from '../src/ui/qianchuang-city-maps.js';
import * as catalogModule from '../src/qianchuang-map-catalog.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path d="M0 0H1"/></svg>';
const digest = text => createHash('sha256').update(text).digest('hex');
const generic = () => structuredClone(QIANCHUANG_MAP_ASSETS['modern-inland']);
const added = () => ({ ...generic(), id: 'modern-trial', file: 'modern-trial.svg', sha256: digest(svg) });
const response = value => ({ ok: true, json: async () => structuredClone(value), text: async () => value });
function harness({ rows = [], cities = [], fetchSvg = async () => response(svg), timeoutMs = 50 } = {}) {
  const assets = { 'modern-inland': generic() }, cityAssets = { seoul: structuredClone(CITY_MAPS.seoul) }, calls = [], sanitized = [];
  const client = catalogModule.createQianchuangMapCatalog({ genericAssets: assets, cityAssets, timeoutMs,
    sanitizeSvg: text => { sanitized.push(text); return text; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.endsWith('/maps-library/catalog.json') ? response(rows) : url.endsWith('/maps-real/catalog.json') ? response({ cities }) : fetchSvg(url, options);
    },
  });
  return { client, assets, cityAssets, calls, sanitized };
}

test('完整外部新图与城市几何进入同一目录，坏项局部跳过，准备仅一次', async () => {
  const city = { ...structuredClone(CITY_MAPS.seoul), id: 'trial-city', file: 'trial-city.svg', aliases: ['试行城'] };
  const h = harness({ rows: [added(), { ...added(), id: 'missing-geometry', regions: undefined }, { ...added(), id: 'external', file: 'https://wrong.invalid/map.svg' }], cities: [city] });
  await Promise.all([h.client.prepare(), h.client.prepare()]);
  assert.ok(h.assets['modern-trial']); assert.ok(h.cityAssets['trial-city']);
  assert.equal(h.assets['missing-geometry'], undefined); assert.equal(h.assets.external, undefined);
  assert.equal(h.calls.length, 2); assert.ok(h.calls.every(call => call.options.credentials === 'omit'));
  const original = generic(); assert.deepEqual(h.assets['modern-inland'], original);
});

test('坏分区或城市组位于合法新图前时仅跳坏条，后续新图仍接收', async () => {
  const bad = added(); bad.id = 'bad-null-region'; bad.regions.layouts[1] = [null];
  const city = { ...structuredClone(CITY_MAPS.seoul), id: 'good-new-city', file: 'good-new-city.svg', aliases: ['新城市'] }, badCity = { ...city, id: 'bad-null-group', groups: [null] };
  const h = harness({ rows: [bad, added()], cities: [badCity, city] }); await h.client.prepare();
  assert.equal(h.assets['bad-null-region'], undefined); assert.ok(h.assets['modern-trial']);
  assert.equal(h.cityAssets['bad-null-group'], undefined); assert.ok(h.cityAssets['good-new-city']);
});

test('线上轻目录仅同ID同SHA同尺寸补内置几何，旧ID不可改图或几何', async () => {
  const original = generic(), { regions, anchors, ...light } = original;
  const h = harness({ rows: [light, { ...light, id: 'unknown-light' }, { ...light, id: 'modern-inland', width: 42 }] });
  await h.client.prepare();
  let local = 0;
  assert.equal(await h.client.load('generic', h.assets['modern-inland'], async () => { local++; return 'local'; }), 'local');
  // The fixture SVG has another SHA, so the accepted light row must still use the original identity.
  assert.equal(local, 1); assert.equal(h.assets['unknown-light'], undefined); assert.deepEqual(h.assets['modern-inland'], original);
  const changed = { ...generic(), regions: { ...regions, neutral: { x: 1, y: 1, w: 2, h: 2 } } }, other = harness({ rows: [changed] });
  await other.client.prepare(); let reads = 0;
  assert.equal(await other.client.load('generic', other.assets['modern-inland'], async () => { reads++; return 'same-local'; }), 'same-local');
  assert.equal(other.calls.length, 2); assert.equal(reads, 1);
});

test('外链图按完整SHA读取并净化，同图并发仅下载一次', async () => {
  const h = harness({ rows: [added()] }); await h.client.prepare(); let local = 0;
  const values = await Promise.all([h.client.load('generic', h.assets['modern-trial'], async () => { local++; }), h.client.load('generic', h.assets['modern-trial'], async () => { local++; })]);
  assert.deepEqual(values, [svg, svg]); assert.equal(local, 0); assert.deepEqual(h.sanitized, [svg]);
  assert.equal(h.calls[2].url, 'https://st-myriadknots.pages.dev/maps-library/modern-trial.svg?v=' + digest(svg));
});

test('已知图网络或SHA失败回本地，新图没有本地时保读取失败', async () => {
  const original = generic(), h = harness({ rows: [original, added()], fetchSvg: async () => response('<svg viewBox="0 0 1000 1000"/>') });
  await h.client.prepare(); assert.equal(await h.client.load('generic', original, async () => 'local-known'), 'local-known');
  let read = 0; await assert.rejects(h.client.load('generic', h.assets['modern-trial'], async () => { read++; throw Error('no local asset'); }));
  assert.equal(read, 0, '未知远程ID不能假读不存在的本地文件'); assert.equal(h.sanitized.length, 0);
});

test('目录与响应正文超时均有界，只发一次且不自动重试', async () => {
  let count = 0;
  const client = catalogModule.createQianchuangMapCatalog({ genericAssets: {}, cityAssets: {}, timeoutMs: 5, sanitizeSvg: text => text,
    fetchImpl: async () => { count++; return { ok: true, json: () => new Promise(() => {}) }; } });
  await client.prepare(); await client.prepare(); assert.equal(count, 2);
  const h = harness({ rows: [generic()], timeoutMs: 5, fetchSvg: async () => ({ ok: true, text: () => new Promise(() => {}) }) });
  await h.client.prepare(); assert.equal(await h.client.load('generic', h.assets['modern-inland'], async () => 'local-timeout'), 'local-timeout'); assert.equal(h.calls.length, 3);
});

test('已保存远程ID目录离线仍保留，原题材改变仍可选新图', () => {
  assert.equal(selectQianchuangMapAsset({ entityId: 'same', style: 'modern', previousAssetId: 'remote-existing' }), 'remote-existing');
  assert.equal(QIANCHUANG_MAP_ASSETS[selectQianchuangMapAsset({ entityId: 'same', style: 'sci-fi', previousAssetId: 'modern-inland' })].family, 'sci-fi');
});

test('全部20种现成几何克隆新ID都可独立入库', async () => {
  const rows = Object.values(QIANCHUANG_MAP_ASSETS).map(asset => ({ ...structuredClone(asset), id: asset.id + '-next', file: asset.id + '-next.svg' }));
  const h = harness({ rows, timeoutMs: 2000 }); await h.client.prepare();
  assert.deepEqual(Object.keys(h.assets).filter(id => id.endsWith('-next')), rows.map(row => row.id));
});

test('SVG保合法非零裁窗和XML声明，片段引用允许空白与配对引号', async () => {
  const text = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="120 150 2000 2000"><defs><mask id="mask"/></defs><use href=" #shape"/><path fill="url( \'#mask\' )"/></svg>';
  const asset = { ...added(), sha256: digest(text) }, h = harness({ rows: [asset], fetchSvg: async () => response(text) }); await h.client.prepare();
  assert.equal(await h.client.load('generic', h.assets[asset.id], async () => { throw Error('no local'); }), text);
  for (const change of [value => value.replace(' #shape', 'https://outside.invalid/a.svg#shape'), value => value.replace("'#mask'", "'https://outside.invalid/mask'")]) {
    const unsafe = change(text), other = harness({ rows: [{ ...asset, sha256: digest(unsafe) }], fetchSvg: async () => response(unsafe) }); await other.client.prepare();
    await assert.rejects(other.client.load('generic', other.assets[asset.id], async () => { throw Error('no local'); })); assert.equal(other.sanitized.length, 0);
  }
});

test('公共完整目录含全部当前几何，SVG仍与登记SHA逐字一致', () => {
  const rows = catalogModule.qianchuangMapCatalogEntries(JSON.parse(readFileSync(new URL('../assets/maps-library/catalog.json', import.meta.url))));
  for (const asset of Object.values(QIANCHUANG_MAP_ASSETS)) {
    assert.deepEqual(rows.find(row => row.id === asset.id), asset);
    assert.equal(digest(readFileSync(new URL('../assets/maps-library/' + asset.file, import.meta.url))), asset.sha256);
  }
  const cities = JSON.parse(readFileSync(new URL('../assets/maps-real/catalog.json', import.meta.url))).cities;
  for (const city of Object.values(CITY_MAPS)) for (const key of ['aliases', 'slots', 'groups']) assert.deepEqual(cities.find(row => row.id === city.id)[key], city[key]);
});


test('packed银行解包支持全部20种新ID，坏轮廓项不挡其余新图', async () => {
  const packed = JSON.parse(readFileSync(new URL('../assets/maps-library/catalog.json', import.meta.url)));
  packed.assets = Object.fromEntries(Object.values(packed.assets).map(row => [row.id + '-packed', { ...row, id: row.id + '-packed', file: row.id + '-packed.svg' }]));
  packed.assets.broken = { ...structuredClone(packed.assets['modern-inland-packed']), id: 'broken', regions: null };
  const h = harness({ rows: packed, timeoutMs: 2000 }); await h.client.prepare();
  assert.equal(Object.keys(h.assets).filter(id => id.endsWith('-packed')).length, 20); assert.equal(h.assets.broken, undefined);
  for (const asset of Object.values(QIANCHUANG_MAP_ASSETS)) assert.deepEqual(h.assets[asset.id + '-packed'].regions, asset.regions);
});

test('全部30张原SVG按目录远端读取通过，不触本地降级并保原始图文', async () => {
  const calls = [], client = catalogModule.createQianchuangMapCatalog({ genericAssets: { ...QIANCHUANG_MAP_ASSETS }, cityAssets: { ...CITY_MAPS }, sanitizeSvg: value => value,
    fetchImpl: async url => { const path = new URL(url).pathname; calls.push(path); const value = readFileSync(new URL('../assets' + path, import.meta.url), 'utf8'); return path.endsWith('.json') ? response(JSON.parse(value)) : response(value); },
  });
  await client.prepare(); let local = 0;
  for (const [kind, registry, folder] of [['generic', QIANCHUANG_MAP_ASSETS, 'maps-library'], ['city', CITY_MAPS, 'maps-real']]) for (const asset of Object.values(registry)) {
    const text = await client.load(kind, asset, async () => { local++; return 'local'; });
    assert.equal(text, readFileSync(new URL('../assets/' + folder + '/' + asset.file, import.meta.url), 'utf8'), asset.id);
  }
  assert.equal(local, 0); assert.equal(calls.length, 32);
});

test('正式两loader外链成功时不预读本地文件，保完整原图与单次下载', async () => {
  const source = generic(), text = readFileSync(new URL('../assets/maps-library/' + source.file, import.meta.url), 'utf8');
  const city = CITY_MAPS.seoul, cityText = readFileSync(new URL('../assets/maps-real/' + city.file, import.meta.url), 'utf8');
  const calls = [];
  const fetchImpl = async url => { calls.push(url); return url.endsWith('/maps-library/catalog.json') ? response([source]) : url.endsWith('/maps-real/catalog.json') ? response({ cities: [city] }) : response(url.includes('/maps-real/') ? cityText : text); };
  const client = catalogModule.startQianchuangMapCatalog({ genericAssets: QIANCHUANG_MAP_ASSETS, cityAssets: CITY_MAPS, fetchImpl, sanitizeSvg: value => value });
  await client.prepare(); let local = 0;
  const options = { moduleUrl: 'https://local.invalid/plugin/dist/qqj-app.js', fetchImpl: async () => { local++; throw Error('unexpected local read'); } };
  assert.equal(await createGenericMapLoader(options)(source.id), text);
  assert.equal(await createCityMapLoader(options)(city.id), cityText);
  assert.equal(local, 0); assert.equal(calls.length, 4);
});

test('旧远端目录缺新五图时保内置并读取各自本地SVG',async()=>{
 const ids=['palace-courtyard-garden','sci-fi-ring-life','chongqing','hong-kong','nagoya'],genericAssets={...QIANCHUANG_MAP_ASSETS},cityAssets={...CITY_MAPS},calls=[];
 const client=catalogModule.createQianchuangMapCatalog({genericAssets,cityAssets,sanitizeSvg:x=>x,fetchImpl:async url=>{calls.push(url);return url.endsWith('/maps-library/catalog.json')?response(Object.values(QIANCHUANG_MAP_ASSETS).filter(a=>!ids.includes(a.id))):response({cities:Object.values(CITY_MAPS).filter(a=>!ids.includes(a.id))});}});
 await client.prepare();let local=0;for(const id of ids){const kind=id==='chongqing'||id==='hong-kong'||id==='nagoya'?'city':'generic',asset=(kind==='city'?cityAssets:genericAssets)[id];assert.ok(asset,id);const text=await client.load(kind,asset,async()=>{local++;return readFileSync(new URL('../assets/'+(kind==='city'?'maps-real/':'maps-library/')+asset.file,import.meta.url),'utf8');});assert.equal(digest(text),asset.sha256);}
 assert.equal(local,5);assert.equal(calls.length,2);
});
