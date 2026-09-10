import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMessageFloorAnchor, persistMessageFloorAnchors } from '../src/v3/message-floor-anchor.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FLOOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const assistant = extra => ({ is_user: false, mes: '正文', extra });

function harness({ persisted = true, save = async () => {}, extra } = {}) {
  const message = assistant(extra);
  const context = { chatMetadata: { qianqianjie: { chatId: CHAT } }, characters: [{ name: '角色', avatar: 'a.png' }], characterId: 0, saveChat: save, getRequestHeaders: () => ({}) };
  const snapshot = { chatId: 'host-chat', characterAvatar: 'a.png', context, chat: [message] };
  const hostAdapter = { snapshot: () => snapshot };
  const fetchImpl = async () => ({ ok: true, json: async () => [{ chat_metadata: context.chatMetadata }, persisted ? structuredClone(message) : assistant(extra)] });
  return { message, hostAdapter, fetchImpl };
}

test('消息锚保存后必须从宿主聊天真实读回，silent no-op 保持可重试', async () => {
  const h = harness({ persisted: false });
  await assert.rejects(persistMessageFloorAnchors({ hostAdapter: h.hostAdapter, chatId: CHAT, bindings: [{ messageIndex: 0, floorId: FLOOR }], fetchImpl: h.fetchImpl }), { code: 'V3_MESSAGE_ANCHOR_VERIFY_FAILED' });
  assert.equal(inspectMessageFloorAnchor(h.message, CHAT).status, 'none');
});

test('消息锚成功、同值幂等，并拒绝foreign/conflict/duplicate', async () => {
  const h = harness();
  assert.equal((await persistMessageFloorAnchors({ hostAdapter: h.hostAdapter, chatId: CHAT, bindings: [{ messageIndex: 0, floorId: FLOOR }], fetchImpl: h.fetchImpl })).status, 'persisted');
  assert.equal((await persistMessageFloorAnchors({ hostAdapter: h.hostAdapter, chatId: CHAT, bindings: [{ messageIndex: 0, floorId: FLOOR }], fetchImpl: h.fetchImpl })).status, 'unchanged');
  await assert.rejects(persistMessageFloorAnchors({ hostAdapter: h.hostAdapter, chatId: CHAT, bindings: [{ messageIndex: 0, floorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }], fetchImpl: h.fetchImpl }), { code: 'V3_MESSAGE_ANCHOR_CONFLICT' });
  await assert.rejects(persistMessageFloorAnchors({ hostAdapter: h.hostAdapter, chatId: CHAT, bindings: [{ messageIndex: 0, floorId: FLOOR }, { messageIndex: 0, floorId: FLOOR }], fetchImpl: h.fetchImpl }), { code: 'V3_MESSAGE_ANCHOR_BINDING_INVALID' });
});

test('失败回滚只撤销本插件marker，保留保存途中写入的其他extra', async () => {
  let message;
  const h = harness({ persisted: false, extra: { kept: 1 }, save: async () => { message.extra.concurrent = 2; } });
  message = h.message;
  await assert.rejects(persistMessageFloorAnchors({ hostAdapter: h.hostAdapter, chatId: CHAT, bindings: [{ messageIndex: 0, floorId: FLOOR }], fetchImpl: h.fetchImpl }));
  assert.deepEqual(h.message.extra, { kept: 1, concurrent: 2 });
});
