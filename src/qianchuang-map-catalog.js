import { sha256 } from './identity.js';
import { validQianchuangMapStyle, validQianchuangMapLayout } from './qianchuang-display-hints.js';

export const QIANCHUANG_MAP_BASE_URL = 'https://st-myriadknots.pages.dev/';
const own = (value, key) => Object.hasOwn(value, key);
const point = value => Array.isArray(value) && value.length === 2 && value.every(n => Number.isFinite(n) && n >= 0 && n <= 100);
const points = value => Array.isArray(value) && value.length > 0 && value.every(point);
const box = value => value && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(value[key])) && value.x >= 0 && value.y >= 0 && value.w > 0 && value.h > 0 && value.x + value.w <= 100.001 && value.y + value.h <= 100.001;
const strings = value => Array.isArray(value) && value.length > 0 && value.every(text => typeof text === 'string' && text.trim());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function geometryValid(asset, kind) {
  if (kind === 'city') return strings(asset.aliases) && points(asset.slots) && Array.isArray(asset.groups) && asset.groups.length > 0
    && asset.groups.every(group => group && box(group.labelBox) && points(group.slots));
  const { regions, anchors } = asset;
  return !!regions && !!anchors && box(regions.neutral) && Array.isArray(anchors.neutral) && anchors.neutral.every(point) && points(anchors.all)
    && [1, 2, 3, 4, 5].every(count => Array.isArray(regions.layouts?.[count]) && regions.layouts[count].length === count
      && Array.isArray(anchors.layouts?.[count]) && anchors.layouts[count].length === count
      && regions.layouts[count].every(region => region && box(region.inset) && Array.isArray(region.contours) && region.contours.length > 0
        && region.contours.every(contour => points(contour) && contour.length >= 3)) && anchors.layouts[count].every(points));
}
function descriptorValid(asset, kind) {
  return asset && /^[a-z0-9][a-z0-9-]*$/u.test(asset.id) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.svg$/u.test(asset.file)
    && typeof asset.label === 'string' && asset.label.trim() && Number.isFinite(asset.width) && asset.width > 0 && Number.isFinite(asset.height) && asset.height === asset.width
    && /^[a-f0-9]{64}$/u.test(asset.sha256) && (kind === 'city' || asset.family !== 'town' && validQianchuangMapStyle(asset.family) && validQianchuangMapLayout(asset.layout, asset.family));
}
function metadataFor(row, kind, bundled) {
  if (!descriptorValid(row, kind)) return null;
  const geometryKeys = kind === 'city' ? ['aliases', 'slots', 'groups'] : ['regions', 'anchors'];
  if (bundled) {
    if (['file', 'sha256', 'width', 'height', ...(kind === 'generic' ? ['family', 'layout'] : [])].some(key => row[key] !== bundled[key])
      || geometryKeys.some(key => own(row, key) && !same(row[key], bundled[key]))) return null;
    // The first deployed catalogs omit display geometry; only an exact bundled image can supply it.
    return bundled;
  }
  if (!geometryValid(row, kind)) return null;
  const keys = ['id', 'label', 'file', 'width', 'height', 'sha256', ...geometryKeys, ...(kind === 'generic' ? ['family', 'layout', 'shortTags', 'origin'] : [])];
  return Object.fromEntries(keys.filter(key => own(row, key)).map(key => [key, structuredClone(row[key])]));
}
export function qianchuangMapCatalogEntries(value) {
  if (Array.isArray(value)) return value;
  if (value?.schemaVersion !== 1 || !value.assets || !Array.isArray(value.points) || !Array.isArray(value.contours)) return [];
  const contours = value.contours.map(ring => Array.isArray(ring) ? ring.map(index => Number.isInteger(index) ? value.points[index] : null) : null);
  return Object.values(value.assets).flatMap(raw => {
    try {
      const profile = { ...raw.regions, layouts: Object.fromEntries(Object.entries(raw.regions.layouts).map(([count, rows]) => [count, rows.map(region => {
        const rings = region.contours.map(index => Number.isInteger(index) ? contours[index] : null);
        return { ...region, contours: rings, ...(region.contour === null ? { contour: rings[0] } : {}) };
      })])) };
      if (profile.regions === null) profile.regions = profile.layouts[5];
      return [{ ...raw, regions: profile }];
    } catch { return []; }
  });
}
function displaySvgValid(svg, asset) {
  if (typeof svg !== 'string' || !/^\s*(?:<\?xml\s[^?]*\?>\s*)?<svg\b/iu.test(svg)) return false;
  const viewBox = /<svg\b[^>]*\bviewBox\s*=\s*["']([^"']+)["']/iu.exec(svg)?.[1]?.trim().split(/[\s,]+/u).map(Number);
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0 || Math.abs(viewBox[2] / viewBox[3] - asset.width / asset.height) > 0.000001) return false;
  // Static SVG may contain its own PNG masks and fragment references, never network resources or imported CSS.
  const references = [...svg.matchAll(/\b(?:href|src)\s*=\s*["']([^"']*)["']/giu)].map(match => match[1].trim());
  const urls = [...svg.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/giu)].map(match => (match[1] ?? match[2] ?? match[3]).trim());
  return !/@import\b/iu.test(svg) && references.every(value => /^(?:#|data:image\/(?:png|jpeg|webp);base64,)/iu.test(value)) && urls.every(value => value.startsWith('#'));
}

export function createQianchuangMapCatalog({ genericAssets, cityAssets, fetchImpl = globalThis.fetch, sanitizeSvg,
  baseUrl = QIANCHUANG_MAP_BASE_URL, timeoutMs = 8000 } = {}) {
  const registries = { generic: genericAssets, city: cityAssets }, bundled = { generic: { ...genericAssets }, city: { ...cityAssets } };
  const remote = new Map(), loaded = new Map();
  let preparation;
  async function request(url, read, cache) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => fetchImpl(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache, signal: controller.signal }))
          .then(response => { if (!response.ok) throw Error('地图素材暂时无法读取。'); return read(response); }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('地图素材读取超时。')); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  const folder = kind => kind === 'city' ? 'maps-real/' : 'maps-library/';
  async function readCatalog(kind) {
    const value = await request(new URL(folder(kind) + 'catalog.json', baseUrl).href, response => response.json(), 'no-cache');
    const rows = kind === 'city' ? value?.cities : qianchuangMapCatalogEntries(value);
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const asset = metadataFor(row, kind, own(bundled[kind], row?.id) ? bundled[kind][row.id] : null);
      if (!asset || remote.has(kind + ':' + asset.id)) continue;
      if (!own(registries[kind], asset.id)) registries[kind][asset.id] = asset;
      remote.set(kind + ':' + asset.id, asset);
    }
  }
  function prepare() {
    return preparation ??= Promise.allSettled([readCatalog('generic'), readCatalog('city')]).then(() => undefined);
  }
  async function load(kind, asset, readLocal) {
    await prepare();
    const key = kind + ':' + asset.id, metadata = remote.get(key);
    if (!metadata) return readLocal();
    if (!loaded.has(key)) loaded.set(key, (async () => {
      try {
        const url = new URL(folder(kind) + metadata.file, baseUrl); url.searchParams.set('v', metadata.sha256);
        const svg = await request(url.href, response => response.text(), 'force-cache');
        if (await sha256(svg) !== metadata.sha256 || !displaySvgValid(svg, metadata) || typeof sanitizeSvg !== 'function') throw Error('地图素材内容无效。');
        const clean = sanitizeSvg(svg);
        if (!displaySvgValid(clean, metadata)) throw Error('地图素材内容无效。');
        return clean;
      } catch (error) {
        if (own(bundled[kind], asset.id)) return readLocal();
        throw error;
      }
    })());
    return loaded.get(key);
  }
  return Object.freeze({ prepare, load });
}

let current = null;
const listeners = new Set();
export function startQianchuangMapCatalog(options) {
  if (current) return current;
  current = createQianchuangMapCatalog(options);
  void current.prepare().then(() => { for (const listener of listeners) listener(); });
  return current;
}
export function subscribeQianchuangMapCatalog(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function loadQianchuangMapAsset(kind, asset, readLocal) { return current ? current.load(kind, asset, readLocal) : readLocal(); }
