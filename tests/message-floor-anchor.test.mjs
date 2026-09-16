import test from 'node:test';
import assert from 'node:assert/strict';
import { clearExactMessageFloorAnchor, inspectMessageFloorAnchor, persistBranchedMessageMetadata, persistMessageFloorAnchors } from '../src/v3/message-floor-anchor.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FLOOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TARGET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DANGLING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
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

test('精确清理只移除外层及各 swipe 的同一孤儿锚，保留正文、其他锚和 extra', async () => {
  const target = { schemaVersion: 1, chatId: CHAT, floorId: DANGLING };
  const other = { schemaVersion: 1, chatId: CHAT, floorId: FLOOR };
  const message = assistant({ kept: 1, qianqianjie_floor: target });
  message.swipes = ['正文', '另一候选', '末候选']; message.swipe_id = 0;
  message.swipe_info = [
    { extra: { first: true, qianqianjie_floor: { ...target } } },
    { extra: { middle: true, qianqianjie_floor: other } },
    { extra: { last: true, qianqianjie_floor: { ...target } } },
  ];
  const beforeBody = structuredClone({ mes: message.mes, swipes: message.swipes, swipe_id: message.swipe_id });
  const context = { chatMetadata: { qianqianjie: { chatId: CHAT } }, characters: [{ name: '角色', avatar: 'a.png' }], characterId: 0, saveChat: async () => true, getRequestHeaders: () => ({}) };
  const snapshot = { chatId: 'host-chat', characterAvatar: 'a.png', context, chat: [message] };
  const result = await clearExactMessageFloorAnchor({
    hostAdapter: { snapshot: () => snapshot }, chatId: CHAT, floorId: DANGLING, messageIndex: 0,
    fetchImpl: async () => ({ ok: true, json: async () => [{ chat_metadata: context.chatMetadata }, structuredClone(message)] }),
  });
  assert.equal(result.status, 'persisted');
  assert.deepEqual({ mes: message.mes, swipes: message.swipes, swipe_id: message.swipe_id }, beforeBody);
  assert.deepEqual(message.extra, { kept: 1 });
  assert.deepEqual(message.swipe_info.map(item => item.extra), [
    { first: true },
    { middle: true, qianqianjie_floor: other },
    { last: true },
  ]);
});

test('孤儿锚清理保存失败时恢复同一锚且保留并发写入的其他 extra', async () => {
  const target = { schemaVersion: 1, chatId: CHAT, floorId: DANGLING };
  const message = assistant({ kept: 1, qianqianjie_floor: target });
  message.swipe_info = [{ extra: { swipeKept: 1, qianqianjie_floor: { ...target } } }];
  const context = { chatMetadata: { qianqianjie: { chatId: CHAT } }, characters: [{ name: '角色', avatar: 'a.png' }], characterId: 0,
    saveChat: async () => { message.extra.concurrent = 2; return false; }, getRequestHeaders: () => ({}) };
  const snapshot = { chatId: 'host-chat', characterAvatar: 'a.png', context, chat: [message] };
  await assert.rejects(clearExactMessageFloorAnchor({ hostAdapter: { snapshot: () => snapshot }, chatId: CHAT, floorId: DANGLING, messageIndex: 0 }),
    { code: 'V3_MESSAGE_ANCHOR_SAVE_FAILED' });
  assert.deepEqual(message.extra, { kept: 1, concurrent: 2, qianqianjie_floor: target });
  assert.deepEqual(message.swipe_info[0].extra, { swipeKept: 1, qianqianjie_floor: target });
});

test('孤儿锚清理等待期间 swipe 前插和重排时按对象恢复，不把旧锚挂到新槽', async () => {
  const target = { schemaVersion: 1, chatId: CHAT, floorId: DANGLING };
  const message = assistant({ qianqianjie_floor: target });
  message.swipes = ['目标', '普通']; message.swipe_id = 0;
  message.swipe_info = [
    { id: 'target', extra: { targetKept: true, qianqianjie_floor: { ...target } } },
    { id: 'plain', extra: { plainKept: true } },
  ];
  const inserted = { id: 'inserted', extra: { insertedKept: true } };
  const context = { chatMetadata: { qianqianjie: { chatId: CHAT } }, characters: [{ name: '角色', avatar: 'a.png' }], characterId: 0,
    saveChat: async () => { message.swipe_info = [inserted, message.swipe_info[1], message.swipe_info[0]]; return false; }, getRequestHeaders: () => ({}) };
  const snapshot = { chatId: 'host-chat', characterAvatar: 'a.png', context, chat: [message] };
  await assert.rejects(clearExactMessageFloorAnchor({ hostAdapter: { snapshot: () => snapshot }, chatId: CHAT, floorId: DANGLING, messageIndex: 0 }),
    { code: 'V3_MESSAGE_ANCHOR_SAVE_FAILED' });
  assert.deepEqual(message.swipe_info.map(item => item.id), ['inserted', 'plain', 'target']);
  assert.deepEqual(message.swipe_info[0].extra, { insertedKept: true });
  assert.deepEqual(message.swipe_info[1].extra, { plainKept: true });
  assert.deepEqual(message.swipe_info[2].extra, { targetKept: true, qianqianjie_floor: target });
});

test('孤儿锚清理等待期间切换候选并替换 outer extra 时不向新候选注入旧锚', async () => {
  const target = { schemaVersion: 1, chatId: CHAT, floorId: DANGLING };
  const message = assistant({ originalKept: true, qianqianjie_floor: target });
  message.swipes = ['原候选', '新候选']; message.swipe_id = 0; message.mes = '原候选';
  const context = { chatMetadata: { qianqianjie: { chatId: CHAT } }, characters: [{ name: '角色', avatar: 'a.png' }], characterId: 0,
    saveChat: async () => {
      message.swipe_id = 1; message.mes = '新候选'; message.extra = { replacementKept: true };
      return false;
    }, getRequestHeaders: () => ({}) };
  const snapshot = { chatId: 'host-chat', characterAvatar: 'a.png', context, chat: [message] };
  await assert.rejects(clearExactMessageFloorAnchor({ hostAdapter: { snapshot: () => snapshot }, chatId: CHAT, floorId: DANGLING, messageIndex: 0 }),
    { code: 'V3_MESSAGE_ANCHOR_SAVE_FAILED' });
  assert.deepEqual(message.extra, { replacementKept: true });
  assert.equal(message.swipe_id, 1);
  assert.equal(message.mes, '新候选');
});

test('已确认副本会换绑外层和可达 swipe marker/自动隐藏标记，清除旧 receipt 与悬空 swipe 标识', async () => {
  const message = assistant({ kept: 1, qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT }, qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: FLOOR }, qqj_v3_recall_receipt: { old: true } });
  message.swipe_info = [
    { extra: { swipeKept: 1, qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT }, qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: FLOOR }, qqj_v3_recall_receipt: { old: true } } },
    { extra: { swipeKept: 2, qianqianjieAutoHide: { schemaVersion: 1, chatId: CHAT }, qianqianjie_floor: { schemaVersion: 1, chatId: CHAT, floorId: DANGLING }, qqj_v3_recall_receipt: { old: true } } },
  ];
  const context = { chatMetadata: { qianqianjie: { chatId: CHAT } }, characters: [{ name: '角色', avatar: 'a.png' }], characterId: 0, saveChat: async () => true, getRequestHeaders: () => ({}) };
  const snapshot = { chatId: '复制聊天', characterAvatar: 'a.png', context, chat: [message] };
  const result = await persistBranchedMessageMetadata({
    hostAdapter: { snapshot: () => snapshot }, hostChatId: '复制聊天', sourceChatId: CHAT, targetChatId: TARGET,
    bindings: [{ messageIndex: 0, floorId: FLOOR }], retainedFloorIds: [FLOOR],
    fetchImpl: async () => ({ ok: true, async json() { return [{ chat_metadata: context.chatMetadata }, structuredClone(message)]; } }),
  });
  assert.equal(result.status, 'persisted');
  assert.deepEqual(message.extra, { kept: 1, qianqianjieAutoHide: { schemaVersion: 1, chatId: TARGET }, qianqianjie_floor: { schemaVersion: 1, chatId: TARGET, floorId: FLOOR } });
  assert.deepEqual(message.swipe_info[0].extra, { swipeKept: 1, qianqianjieAutoHide: { schemaVersion: 1, chatId: TARGET }, qianqianjie_floor: { schemaVersion: 1, chatId: TARGET, floorId: FLOOR } });
  assert.deepEqual(message.swipe_info[1].extra, { swipeKept: 2, qianqianjieAutoHide: { schemaVersion: 1, chatId: TARGET } });
});
