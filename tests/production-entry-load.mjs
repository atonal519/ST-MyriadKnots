import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
assert.match(manifest.js, /^dist\/qqj-app\.js\?(?:v|buildId)=[A-Za-z0-9._-]+$/);
assert.equal(manifest.js, 'dist/qqj-app.js?v=20260901.13');
assert.equal(manifest.version, '0.2.26');
const bundlePath = resolve(root, manifest.js.split('?')[0]);
const bundleSource = await readFile(bundlePath, 'utf8');
assert.equal([...bundleSource.matchAll(/\b(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)/g)].length, 0, 'production bundle must not retain plugin-relative imports');
const registrations = [];
const eventHandlers = new Map();
let aiCalls = 0;
const host = {
  characterId: 0,
  groupId: null,
  chatId: 'host-chat',
  characters: [{ avatar: 'char.png' }],
  userAvatar: 'me.png',
  chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: '123e4567-e89b-12d3-a456-426614174000' } },
  chat: [],
  getRequestHeaders: () => ({}),
  eventTypes: {
    CHAT_CHANGED: 'chat', PERSONA_CHANGED: 'persona', MESSAGE_SENT: 'sent', MESSAGE_RECEIVED: 'received',
    MESSAGE_EDITED: 'edited', MESSAGE_DELETED: 'deleted', MESSAGE_SWIPED: 'swiped', MESSAGE_SWIPE_DELETED: 'swipe-deleted',
  },
  eventSource: { on: (name, handler) => eventHandlers.set(name, handler) },
  registerExtensionApi: (name, api) => registrations.push({ name, api }),
  generateTask: async () => { aiCalls += 1; throw new Error('disabled isolation load must not call AI'); },
};
const context = createContext({
  console,
  crypto: globalThis.crypto,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  AbortController,
  DOMException,
  structuredClone,
  setTimeout,
  clearTimeout,
  fetch: async () => { throw new Error('disabled isolation load must not fetch'); },
  Luker: { getContext: () => host },
});
const cache = new Map();

function synthetic(identifier, exports) {
  const names = Object.keys(exports);
  return new SyntheticModule(names, function initialize() { for (const name of names) this.setExport(name, exports[name]); }, { context, identifier });
}

async function load(identifier) {
  if (cache.has(identifier)) return cache.get(identifier);
  const path = fileURLToPath(identifier);
  let module;
  if (path === '/scripts/personas.js') module = synthetic(identifier, { user_avatar: 'me.png' });
  else if (path === '/scripts/extensions.js') module = synthetic(identifier, { extension_settings: { qianqianjie: { pluginEnabled: false } } });
  else if (path === '/script.js') module = synthetic(identifier, { saveSettingsDebounced() {} });
  else {
    assert.equal(path === root || path.startsWith(`${root}/`), true, `unexpected import outside plugin: ${path}`);
    module = new SourceTextModule(await readFile(path, 'utf8'), { context, identifier });
  }
  cache.set(identifier, module);
  return module;
}

const entry = await load(pathToFileURL(bundlePath).href);
const dependencySpecifiers = (entry.moduleRequests || []).map(item => item.specifier);
assert.deepEqual(dependencySpecifiers, ['/scripts/personas.js', '/scripts/extensions.js', '/script.js']);
await entry.link((specifier, referencing) => load(new URL(specifier, referencing.identifier).href));
await entry.evaluate();
assert.equal(entry.status, 'evaluated');
assert.equal(aiCalls, 0);
assert.equal(registrations.length, 1);
assert.equal(registrations[0].name, 'qianqianjie-demo');
const expectedApis = [
  'runDemo', 'getState', 'getFormalState', 'initializeCard', 'getPeople', 'identifyPeople',
  'getPeopleSourceCatalog', 'startPeopleSourceCatalog', 'setPeopleSourceSelected', 'confirmPeopleSourceCatalog', 'retryPeopleRecognitionPermit', 'readCurrentPeopleRawSources', 'readPeopleRawSourcesByRefs',
  'selectPerson', 'unselectPerson', 'shelvePerson', 'restorePerson',
  'refreshStableFloors', 'getStableFloorState', 'initializePeopleFoundation', 'restorePeopleFoundation', 'getPeopleFoundationState',
  'startInitialRelationGeneration', 'resumeInitialRelationGeneration', 'getInitialRelationGenerationState', 'adoptCurrentInitialRelationSources',
  'extractSelectedCharacterBasicInfo', 'saveSelectedCharacterBasicField', 'updateSelectedCharacterDynamicFields', 'saveSelectedCharacterDynamicField',
  'cancelInitialRelationGeneration', 'resolvePendingReview',
];
assert.deepEqual(Object.keys(registrations[0].api), expectedApis);
for (const name of expectedApis) assert.equal(typeof registrations[0].api[name], 'function', `missing API: ${name}`);
for (const eventName of Object.values(host.eventTypes)) assert.equal(typeof eventHandlers.get(eventName), 'function', `missing event handler: ${eventName}`);
console.log(`production bundle isolation load passed (${expectedApis.length} APIs, ${cache.size} bundle/stub modules)`);
