import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginActivity, createActivitySignal } from '../src/plugin-activity.js';
import { createCompactApiClient } from '../src/compact-api-client.js';
import { createChatSession } from '../src/chat-session.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('真实 API 结束后保存仍忙，重叠源全部settled后才熄灯', async () => {
  const response = deferred();
  const client = createCompactApiClient({ fetchImpl: () => response.promise });
  let saving = true;
  const save = createActivitySignal(() => ({ busy: saving, phase: saving ? 'committing' : null }));
  const activity = createPluginActivity([save, client]);
  const changes = []; activity.subscribe(value => changes.push(value));
  const request = client.generateTask({ config: { url: 'https://example.test', key: 'mock', model: 'mock' }, systemPrompt: 'JSON', taskMessages: [] });
  assert.equal(activity.getState().busy, true);
  response.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }) });
  await request;
  assert.equal(client.getActivityState().busy, false);
  assert.equal(activity.getState().busy, true);
  assert.equal(activity.getState().copy, '正在保存记忆');
  saving = false; save.notifyActivity();
  assert.equal(activity.getState().busy, false);
  activity.dispose();
});

test('身份准备真实Promise开始亮灯，失败后自然熄灯，新聊天空等待不假亮', async () => {
  const pending = deferred();
  const context = { characterId: 0, chatId: 'host', name2: '角色', characters: [{ avatar: 'card.png' }], userAvatar: 'me.png', chatMetadata: {}, chat: [] };
  const session = createChatSession({ contextProvider: () => context, identityCoordinator: { prepare: () => pending.promise } });
  const activity = createPluginActivity([session]);
  assert.equal(activity.getState().busy, false);
  const operation = session.prepare(); await tick();
  assert.equal(activity.getState().busy, true);
  pending.reject(new Error('mock identity failure'));
  await assert.rejects(operation, /mock identity failure/u); await tick();
  assert.equal(activity.getState().busy, false);
  activity.dispose();
});
