import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registrations = [];
const eventHandlers = new Map();
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
  if (path === '/home/admin/sillytavern/public/scripts/personas.js') module = synthetic(identifier, { user_avatar: 'me.png' });
  else if (path === '/home/admin/sillytavern/public/scripts/extensions.js') module = synthetic(identifier, { extension_settings: { qianqianjie: { pluginEnabled: false } } });
  else if (path === '/home/admin/sillytavern/public/script.js') module = synthetic(identifier, { saveSettingsDebounced() {} });
  else {
    assert.equal(path === root || path.startsWith(`${root}/`), true, `unexpected import outside plugin: ${path}`);
    module = new SourceTextModule(await readFile(path, 'utf8'), { context, identifier });
  }
  cache.set(identifier, module);
  if (module instanceof SourceTextModule) await module.link((specifier, referencing) => load(new URL(specifier, referencing.identifier).href));
  return module;
}

const entry = await load(pathToFileURL(resolve(root, 'index.js')).href);
await entry.evaluate();
assert.equal(entry.status, 'evaluated');
assert.equal(registrations.length, 1);
assert.equal(registrations[0].name, 'qianqianjie-demo');
assert.equal(typeof registrations[0].api.refreshStableFloors, 'function');
assert.equal(typeof registrations[0].api.getStableFloorState, 'function');
assert.equal(typeof registrations[0].api.initializePeopleFoundation, 'function');
assert.equal(typeof registrations[0].api.restorePeopleFoundation, 'function');
assert.equal(typeof registrations[0].api.getPeopleFoundationState, 'function');
assert.equal(typeof registrations[0].api.startInitialRelationGeneration, 'function');
assert.equal(typeof registrations[0].api.resumeInitialRelationGeneration, 'function');
assert.equal(typeof registrations[0].api.getInitialRelationGenerationState, 'function');
assert.equal(typeof registrations[0].api.adoptCurrentInitialRelationSources, 'function');
assert.equal(typeof registrations[0].api.cancelInitialRelationGeneration, 'function');
assert.equal(typeof registrations[0].api.resolvePendingReview, 'function');
for (const eventName of Object.values(host.eventTypes)) assert.equal(typeof eventHandlers.get(eventName), 'function', `missing event handler: ${eventName}`);
console.log(`production entry isolation load passed (${cache.size} real/stub modules)`);
