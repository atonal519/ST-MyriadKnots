import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveV2Session } from '../src/archive-v2-session.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('新聊天只持久化稳定 chatId，不读取或写入任何 V1/后端记录', async () => {
  let saves = 0;
  const context = {
    characterId: 0,
    chatId: 'host-chat',
    characters: [{ avatar: 'char.png' }],
    userAvatar: 'me.png',
    chatMetadata: {},
    async saveMetadata() { saves += 1; },
  };
  const session = createArchiveV2Session({ contextProvider: () => context });
    const first = await session.prepare();
    assert.equal(first.status, 'ready');
    assert.match(first.identity.chatId, UUID_PATTERN);
    assert.deepEqual(context.chatMetadata.qianqianjie, { schemaVersion: 1, chatId: first.identity.chatId });
    assert.equal(saves, 1);
    assert.equal((await session.prepare()).identity.chatId, first.identity.chatId);
    assert.equal(saves, 1);
    assert.deepEqual(Object.keys(context.chatMetadata), ['qianqianjie']);
});

test('禁用时零元数据操作；切聊天后旧 prepare 返回 stale', async () => {
  let enabled = false;
  let release;
  const firstMetadata = {};
  const context = {
    characterId: 0,
    chatId: 'first',
    characters: [{ avatar: 'char.png' }],
    userAvatar: 'me.png',
    chatMetadata: firstMetadata,
    saveMetadata: () => new Promise(resolve => { release = resolve; }),
  };
  const session = createArchiveV2Session({
    contextProvider: () => context,
    isEnabled: () => enabled,
    ensureChatId: async raw => { raw.chatMetadata.qianqianjie = { schemaVersion: 1, chatId: UUID }; await raw.saveMetadata(); return UUID; },
  });
    assert.equal((await session.prepare()).status, 'disabled');
    assert.equal(release, undefined);
    enabled = true;
    const pending = session.prepare();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    context.chatId = 'second';
    context.chatMetadata = { qianqianjie: { schemaVersion: 1, chatId: '223e4567-e89b-42d3-a456-426614174000' } };
    session.invalidate();
    release();
    assert.equal((await pending).status, 'stale');
});
