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

test('切换聊天只刷新页面身份，不取消已有业务任务；消息新增不触发自动 AI', async () => {
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
  assert.equal(invalidations, 1, '切聊只让 session 准备新页面身份，不调用业务 aborter');
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

test('总开关启用意图绑定准备返回的目标，页面准备更新不能丢掉该意图', async () => {
  const handlers = new Map();
  let enabled = false, prepareCount = 0, enableContinuation = null;
  const first = deferred(), second = deferred();
  const lifecycle = createPluginLifecycle({
    session: { prepare: () => (++prepareCount === 1 ? first.promise : second.promise), invalidate() {} },
    isEnabled: () => enabled,
    onPrepared: input => { if (input.explicitEnable) enableContinuation = input; },
    logger: { warn() {} },
  });
  lifecycle.bind({ eventSource: { on: (name, handler) => handlers.set(name, handler) }, eventTypes: { CHAT_CHANGED: 'chat' } });
  enabled = true;
  const enabling = lifecycle.setEnabled(true);
  await new Promise(resolve => setImmediate(resolve));
  handlers.get('chat')();
  await new Promise(resolve => setImmediate(resolve));
  const originalIdentity = { chatId: 'target-a', hostChatId: 'host-a', characterLocator: 'char-a', personaLocator: 'persona-a' };
  first.resolve({ status: 'ready', identity: originalIdentity });
  await enabling;
  assert.equal(enableContinuation?.result.identity, originalIdentity, '启用继续使用准备时已捕获的目标身份');
  assert.equal(enableContinuation.explicitEnable, true, '页面变化不能抹去显式总开关意图');
  second.resolve({ status: 'ready', identity: { chatId: 'target-b', hostChatId: 'host-b' } });
  await waitFor(() => prepareCount === 2, '切页后的普通准备未启动');
});

test('启用界面刷新失败并回滚后，迟到的显式准备成功不会清除主启用错误', async () => {
  const continuation = deferred(), diagnostics = [];
  let enabled = false;
  const lifecycle = createPluginLifecycle({
    session: { prepare: async () => ({ status: 'ready', identity: { chatId: 'target-a' } }), invalidate() {} },
    isEnabled: () => enabled,
    getUi: () => ({ refresh: async () => { throw new TypeError('mobile refresh failed'); } }),
    onPrepared: () => continuation.promise,
    onDiagnostic: (error, phase) => diagnostics.push({ error, phase }),
  });
  enabled = true;
  await assert.rejects(lifecycle.setEnabled(true), /mobile refresh failed/u);
  enabled = false;
  await lifecycle.setEnabled(false);
  continuation.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(diagnostics.some(value => value.error === null), false, '迟到的显式成功不清除 panel 记录的主启用失败');
});

test('身份 snapshot 前置复制失败保留原始错误类型、步骤与安全插件位置', async () => {
  const context = { characterId: 0, groupId: null, chatId: 'host-chat', characters: [{ avatar: 'char.png' }], userAvatar: 'persona.png',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: '123e4567-e89b-42d3-a456-426614174000' } }, chat: [() => 'cannot clone'] };
  const session = createChatSession({ contextProvider: () => context,
    identityCoordinator: { prepare: async (_raw, _host, { getTaskInputs }) => { getTaskInputs(); return context.chatMetadata.qianqianjie.chatId; } },
    captureTaskInputs: ({ raw }) => structuredClone(raw.chat) });
  await assert.rejects(session.prepare(), error => error.name === 'DataCloneError');
  const state = session.getState();
  assert.equal(state.status, 'error', 'preparing 前的拒绝也进入可复制诊断状态');
  assert.equal(state.preparationFailure.prepareStep, 'snapshotClone');
  assert.equal(state.preparationFailure.name, 'DataCloneError');
  assert.equal(state.preparationFailure.code, 25);
  assert.match(state.preparationFailure.location, /^src\/chat-session\.js:/u);
  assert.doesNotMatch(JSON.stringify(state), /cannot clone|host-chat|123e4567|https?:/u);

  const cause = Object.assign(new TypeError('PRIVATE_CHAT https://example.test/?token=secret'), { code: 'CHAT_SESSION_NOT_READY' });
  const brokenContext = createChatSession({ contextProvider: () => { throw cause; } });
  await assert.rejects(brokenContext.prepare());
  const broken = brokenContext.getState();
  assert.equal(broken.preparationFailure.name, 'TypeError', '包装器不能覆盖原始 contextProvider 错误类型');
  assert.equal(broken.preparationFailure.code, 'CHAT_SESSION_NOT_READY');
  assert.doesNotMatch(JSON.stringify(broken), /PRIVATE_CHAT|secret|https?:/u);
});

test('关闭功能时角色改名仍只迁移身份绑定，不启动准备或后台续接', async () => {
  const handlers = new Map();
  const calls = [];
  const lifecycle = createPluginLifecycle({
    session: {
      prepare: async () => { calls.push('prepare'); return { status: 'ready' }; },
      invalidate: () => calls.push('session:invalidate'),
      renameCharacter: async (oldLocator, newLocator) => {
        calls.push(`rename:${oldLocator}->${newLocator}`);
        return { status: 'migrated', migratedCount: 2, skippedCount: 0 };
      },
    },
    aborters: [{ abortAll: () => calls.push('api:abort') }],
    isEnabled: () => false,
    onPrepared: () => calls.push('background'),
  });
  lifecycle.bind({ eventSource: { on: (name, handler) => handlers.set(name, handler) }, eventTypes: { CHAT_CHANGED: 'chat', CHARACTER_RENAMED: 'character-renamed' } });

  const result = await handlers.get('character-renamed')('old.png', 'new.png');
  assert.deepEqual(result, { status: 'migrated', migratedCount: 2, skippedCount: 0 });
  assert.deepEqual(calls, ['api:abort', 'session:invalidate', 'rename:old.png->new.png']);
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
  context.characters = [{ avatar: 'char.png', name: '角色' }];
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


test('身份准备将现有启动与人物事件入口传给会话诊断，不改变事件准备流程', async () => {
  const entries = [], handlers = new Map();
  let enabled = true;
  const lifecycle = createPluginLifecycle({ isEnabled: () => enabled, session: { prepare: async options => { entries.push(options.entryPoint); return { status: 'ready' }; }, invalidate() {} } });
  lifecycle.bind({ eventSource: { on: (name, callback) => handlers.set(name, callback) }, eventTypes: { CHAT_CHANGED: 'chat', PERSONA_CHANGED: 'persona' } });
  await lifecycle.start();
  handlers.get('chat')(); await new Promise(resolve => setImmediate(resolve));
  handlers.get('persona')(); await new Promise(resolve => setImmediate(resolve));
  enabled = false; await lifecycle.setEnabled(false);
  enabled = true; await lifecycle.setEnabled(true);
  assert.deepEqual(entries, ['startup', 'chatChanged', 'personaChanged', 'pluginEnable']);
});

test('人物固定任务与上下文aborters分离，Persona改名只取消原其它任务而禁用仍全量', async () => {
  const calls = []; let enabled = true;
  const shared = { abortAll() { calls.push('shared'); } }, peopleRouter = { abortAll() { calls.push('people-router'); } }, people = { invalidate() { calls.push('people'); } };
  const lifecycle = createPluginLifecycle({ session: { prepare: async () => ({ status: 'ready' }), invalidate() { calls.push('session'); }, renameCharacter: async () => ({ status: 'ready' }) },
    aborters: [shared, peopleRouter, people], contextAborters: [shared], isEnabled: () => enabled, logger: { warn() {} } });
  lifecycle.onIdentityChange(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['shared', 'session']); calls.length = 0;
  await lifecycle.onCharacterRenamed('old', 'new'); assert.deepEqual(calls, ['shared', 'session']); calls.length = 0;
  await lifecycle.onChatChanged(); assert.deepEqual(calls, ['session']); calls.length = 0;
  enabled = false; await lifecycle.setEnabled(false);
  assert.deepEqual(calls, ['shared', 'people-router', 'people', 'session']);
});
