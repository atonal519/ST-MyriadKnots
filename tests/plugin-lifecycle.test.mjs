import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginLifecycle } from '../src/plugin-lifecycle.js';
import { createChatSession } from '../src/chat-session.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

test('只绑定聊天与 Persona；消息新增零自动失效、零自动 AI', async () => {
  const handlers = new Map();
  let prepares = 0;
  let invalidations = 0;
  let refreshes = 0;
  const lifecycle = createPluginLifecycle({
    session: { prepare: async () => { prepares += 1; return { status: 'ready' }; }, invalidate: () => { invalidations += 1; } },
    aborters: [{ abortAll: () => { invalidations += 1; } }],
    getUi: () => ({ refresh: async () => { refreshes += 1; } }),
  });
  lifecycle.bind({ eventSource: { on: (name, handler) => handlers.set(name, handler) }, eventTypes: { CHAT_CHANGED: 'chat', PERSONA_CHANGED: 'persona', MESSAGE_SENT: 'sent', MESSAGE_RECEIVED: 'received' } });
  assert.deepEqual([...handlers.keys()], ['chat', 'persona']);
  assert.equal(handlers.has('sent'), false);
  handlers.get('chat')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(invalidations, 2);
  assert.equal(prepares, 1);
  assert.equal(refreshes, 1);
});

test('禁用立即 invalidate 全链；重新启用只准备身份与刷新 UI', async () => {
  let enabled = true;
  const calls = [];
  const ui = { setEnabled: value => calls.push(`ui:${value}`), refresh: async () => calls.push('refresh') };
  const lifecycle = createPluginLifecycle({
    session: { prepare: async () => { calls.push('prepare'); return { status: 'ready' }; }, invalidate: () => calls.push('session:invalidate') },
    aborters: [{ abortAll: () => calls.push('api:abort') }],
    isEnabled: () => enabled,
    getUi: () => ui,
  });
  enabled = false;
  assert.equal((await lifecycle.setEnabled(false)).status, 'disabled');
  assert.deepEqual(calls, ['api:abort', 'session:invalidate', 'ui:false']);
  calls.length = 0;
  enabled = true;
  assert.equal((await lifecycle.setEnabled(true)).status, 'ready');
  assert.deepEqual(calls, ['api:abort', 'session:invalidate', 'ui:true', 'prepare', 'refresh']);
});

test('主页关闭后重新启用保持 idle，随后 CHAT_CHANGED 用真实 session 正常准备', async () => {
  const handlers = new Map();
  let enabled = true;
  let identityPrepares = 0;
  let backgroundStarts = 0;
  const context = { characterId: undefined, groupId: null, chatId: '', characters: [], userAvatar: '', chatMetadata: {} };
  const session = createChatSession({
    contextProvider: () => context,
    isEnabled: () => enabled,
    identityCoordinator: { async prepare(raw, host) { identityPrepares += 1; return host.chatId; } },
  });
  const lifecycle = createPluginLifecycle({
    session,
    isEnabled: () => enabled,
    onPrepared: () => { backgroundStarts += 1; },
  });
  lifecycle.bind({ eventSource: { on: (name, handler) => handlers.set(name, handler) }, eventTypes: { CHAT_CHANGED: 'chat' } });

  assert.equal((await lifecycle.start()).status, 'idle');
  enabled = false;
  assert.equal((await lifecycle.setEnabled(false)).status, 'disabled');
  enabled = true;
  assert.equal((await lifecycle.setEnabled(true)).status, 'idle');
  assert.equal(identityPrepares, 0);
  assert.equal(backgroundStarts, 0);

  context.characterId = 0;
  context.chatId = 'host-chat';
  context.characters = [{ avatar: 'char.png' }];
  context.userAvatar = 'me.png';
  context.chatMetadata = { qianqianjie: { schemaVersion: 2, chatId: '123e4567-e89b-42d3-a456-426614174000' } };
  handlers.get('chat')();
  await waitFor(() => backgroundStarts === 1, '打开聊天后既有 CHAT_CHANGED 未继续准备');
  assert.equal(session.getState().status, 'ready');
  assert.equal(identityPrepares, 1);
});

test('身份 ready 后立即启动后台续接，隐藏面板刷新返回 closed 也不阻塞身份结果', async () => {
  const memory = deferred();
  const calls = [];
  const ready = { status: 'ready', identity: { chatId: 'chat-a' } };
  const lifecycle = createPluginLifecycle({
    session: { prepare: async () => ready, invalidate() {} },
    getUi: () => ({ refresh: async () => { calls.push('ui:closed'); return { status: 'closed' }; } }),
    onPrepared: async ({ result, isCurrent }) => {
      calls.push(`memory:${result.identity.chatId}`);
      await memory.promise;
      if (isCurrent()) calls.push(`people:${result.identity.chatId}`);
    },
  });

  assert.equal(await lifecycle.prepare(), ready, '后台读取不能覆盖 session ready 返回值');
  assert.deepEqual(calls, ['memory:chat-a', 'ui:closed'], '面板关闭时后台读取仍应已经启动，身份准备不等待长任务');
  memory.resolve();
  await waitFor(() => calls.includes('people:chat-a'), '记忆读取完成后未继续人物只读准备');
});

test('迟到身份、加载中切聊天与禁用都会阻止旧续接影响新聊天', async () => {
  const handlers = new Map();
  const firstPrepare = deferred();
  const fourthPrepare = deferred();
  const firstMemory = deferred();
  let enabled = true;
  let prepareCount = 0;
  const calls = [];
  const lifecycle = createPluginLifecycle({
    session: {
      prepare: () => {
        prepareCount += 1;
        if (prepareCount === 1) return firstPrepare.promise;
        if (prepareCount === 4) return fourthPrepare.promise;
        return Promise.resolve({ status: 'ready', identity: { chatId: `chat-${prepareCount}` } });
      },
      invalidate() {},
    },
    isEnabled: () => enabled,
    onPrepared: async ({ result, isCurrent }) => {
      calls.push(`memory:${result.identity.chatId}`);
      if (result.identity.chatId === 'chat-2') await firstMemory.promise;
      if (isCurrent()) calls.push(`people:${result.identity.chatId}`);
    },
  });
  lifecycle.bind({ eventSource: { on: (name, handler) => handlers.set(name, handler) }, eventTypes: { CHAT_CHANGED: 'chat' } });

  handlers.get('chat')();
  await waitFor(() => prepareCount === 1, '第一轮身份准备未启动');
  handlers.get('chat')();
  await waitFor(() => calls.includes('memory:chat-2'), '第二轮身份成功后未启动记忆读取');
  firstPrepare.resolve({ status: 'ready', identity: { chatId: 'chat-1' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.includes('memory:chat-1'), false, '迟到身份不得启动旧聊天读取');

  handlers.get('chat')();
  await waitFor(() => calls.includes('people:chat-3'), '第三轮有效聊天未完成后台续接');
  firstMemory.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.includes('people:chat-2'), false, '加载中切聊天后旧人物读取不得继续');

  handlers.get('chat')();
  await waitFor(() => prepareCount === 4, '禁用前的在途身份准备未启动');
  enabled = false;
  await lifecycle.setEnabled(false);
  fourthPrepare.resolve({ status: 'ready', identity: { chatId: 'chat-4' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.includes('memory:chat-4'), false, '禁用期间迟到身份不得启动后台读取');

  enabled = true;
  assert.equal((await lifecycle.setEnabled(true)).status, 'ready');
  assert.equal(calls.filter(call => call === 'memory:chat-5').length, 1, '重新启用只应启动一次当前记忆读取');
  assert.equal(calls.filter(call => call === 'people:chat-5').length, 1, '重新启用只应启动一次当前人物读取');
});

test('初始身份失败不启动读取，后续有效 CHAT_CHANGED 可恢复；后台失败不覆盖 ready', async () => {
  const handlers = new Map();
  const warnings = [];
  let attempts = 0;
  const ready = { status: 'ready', identity: { chatId: 'recovered' } };
  const lifecycle = createPluginLifecycle({
    session: {
      async prepare() { attempts += 1; if (attempts === 1) throw Object.assign(new Error('no chat'), { code: 'CHAT_SESSION_CONTEXT_INVALID' }); return ready; },
      invalidate() {},
    },
    onPrepared: () => { throw new Error('memory failed'); },
    logger: { warn: (...args) => warnings.push(args) },
  });
  lifecycle.bind({ eventSource: { on: (name, handler) => handlers.set(name, handler) }, eventTypes: { CHAT_CHANGED: 'chat' } });

  await assert.rejects(lifecycle.start(), /no chat/);
  handlers.get('chat')();
  await waitFor(() => warnings.some(args => String(args[0]).includes('后台加载失败')), '恢复后的后台错误未独立记录');
  assert.equal(attempts, 2);
  assert.equal((await lifecycle.prepare({ refresh: false })).status, 'ready', '后台失败不能把 session ready 伪装成身份失败');
});
