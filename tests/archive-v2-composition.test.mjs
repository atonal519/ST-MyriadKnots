import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveV2Composition } from '../src/archive-v2-composition.js';
import { createEmptyArchiveV2 } from '../src/archive-v2.js';

const CHAT = '123e4567-e89b-42d3-a456-426614174000';
const context = () => ({
  characterId: 0,
  chatId: 'host-chat',
  characters: [{ avatar: 'char.png' }],
  userAvatar: 'me.png',
  chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
});

test('薄 facade 只读取 archive-v2，已有档案零 AI、零 V1 record', async () => {
  const calls = [];
  const archive = createEmptyArchiveV2({ chatId: CHAT, characterLocator: 'char.png', personaLocator: 'me.png' });
  const composition = createArchiveV2Composition({
    client: {
      async get(collection, recordId) { calls.push(['get', collection, recordId]); return { revision: 1, data: archive }; },
      async put() { calls.push(['put']); },
    },
    contextProvider: context,
  });
  const result = await composition.readArchive();
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, [['get', `chat-${CHAT}`, 'archive-v2']]);
  assert.deepEqual(composition.currentIdentity(), { characterLocator: 'char.png', personaLocator: 'me.png', personaSummary: '' });
  assert.equal(Object.hasOwn(composition, 'flow'), false);
});

test('invalidate 使迟到 archive 读取失效', async () => {
  let release;
  const archive = createEmptyArchiveV2({ chatId: CHAT, characterLocator: 'char.png', personaLocator: 'me.png' });
  const composition = createArchiveV2Composition({
    client: { get: () => new Promise(resolve => { release = () => resolve({ revision: 1, data: archive }); }), async put() {} },
    contextProvider: context,
  });
  const pending = composition.readArchive();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  composition.invalidate();
  release();
  assert.equal((await pending).status, 'stale');
});
