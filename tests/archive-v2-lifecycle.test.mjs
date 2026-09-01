import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveV2Lifecycle } from '../src/archive-v2-lifecycle.js';

test('只绑定聊天与 Persona；消息新增零自动失效、零自动 AI', async () => {
  const handlers = new Map();
  let prepares = 0;
  let invalidations = 0;
  let refreshes = 0;
  const lifecycle = createArchiveV2Lifecycle({
    session: { prepare: async () => { prepares += 1; return { status: 'ready' }; }, invalidate: () => { invalidations += 1; } },
    compositions: [{ invalidate: () => { invalidations += 1; } }],
    aborters: [{ abortAll: () => { invalidations += 1; } }],
    getUi: () => ({ refresh: async () => { refreshes += 1; } }),
  });
  lifecycle.bind({ eventSource: { on: (name, handler) => handlers.set(name, handler) }, eventTypes: { CHAT_CHANGED: 'chat', PERSONA_CHANGED: 'persona', MESSAGE_SENT: 'sent', MESSAGE_RECEIVED: 'received' } });
  assert.deepEqual([...handlers.keys()], ['chat', 'persona']);
  assert.equal(handlers.has('sent'), false);
  handlers.get('chat')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(invalidations, 3);
  assert.equal(prepares, 1);
  assert.equal(refreshes, 1);
});

test('禁用立即 invalidate 全链；重新启用只准备身份与刷新 UI', async () => {
  let enabled = true;
  const calls = [];
  const ui = { setEnabled: value => calls.push(`ui:${value}`), refresh: async () => calls.push('refresh') };
  const lifecycle = createArchiveV2Lifecycle({
    session: { prepare: async () => { calls.push('prepare'); return { status: 'ready' }; }, invalidate: () => calls.push('session:invalidate') },
    compositions: [{ invalidate: () => calls.push('composition:invalidate') }],
    aborters: [{ abortAll: () => calls.push('api:abort') }],
    isEnabled: () => enabled,
    getUi: () => ui,
  });
  enabled = false;
  assert.equal((await lifecycle.setEnabled(false)).status, 'disabled');
  assert.deepEqual(calls, ['composition:invalidate', 'api:abort', 'session:invalidate', 'ui:false']);
  calls.length = 0;
  enabled = true;
  assert.equal((await lifecycle.setEnabled(true)).status, 'ready');
  assert.deepEqual(calls, ['composition:invalidate', 'api:abort', 'session:invalidate', 'ui:true', 'prepare', 'refresh']);
});
