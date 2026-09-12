import test from 'node:test';
import assert from 'node:assert/strict';
import { PREQUEL_PROMPT_SLOT, selectPrequel, splitPrequelText } from '../src/v3/recall-prequel.js';
import { createV3RecallRuntime } from '../src/v3/recall-runtime.js';

test('前情按自然边界或有限长度切分，中文、英文与 emoji 可逐字拼回', () => {
  for (const source of [
    `${'无标点中文'.repeat(500)}🧭END`,
    '第一段。\n\nSecond paragraph asks why?\n第三段含 emoji 👩🏽‍🚀 与结尾！',
  ]) {
    const fragments = splitPrequelText(source, { maxCharacters: 120 });
    assert.equal(fragments.map(item => item.text).join(''), source);
    assert.ok(fragments.every(item => [...item.text].length <= 120));
  }
});

test('前情本地选段命中远端事实、无匹配接尾，并让格式开销受预算约束', () => {
  const source = `${'甲在港口整理旧账。'.repeat(100)}${'乙在钟楼等待。'.repeat(100)}最后，裴晚生把蓝铜钥匙藏在北塔钟摆后。`;
  const matched = selectPrequel({ text: source, queryContext: { latestUserText: '蓝铜钥匙藏在哪里？' }, contextSize: 12000 });
  assert.match(matched.injectionText, /蓝铜钥匙藏在北塔钟摆后/);
  assert.ok(matched.estimatedCharacters <= matched.characterBudget);
  assert.ok(matched.estimatedTokens <= matched.tokenBudget);
  assert.ok(matched.fragmentIndexes.every((value, index, values) => index === 0 || value > values[index - 1]));

  const tail = selectPrequel({ text: source, queryContext: { latestUserText: '继续' }, contextSize: 12000 });
  assert.match(tail.injectionText, /前情片段/);
  assert.match(tail.injectionText, /蓝铜钥匙藏在北塔钟摆后/);

  const unrelated = selectPrequel({ text: '甲只谈港口。', queryContext: { latestUserText: '裴晚生' }, maxCharacters: 6000, maxTokens: 2500, requireMatch: true, fallbackToTail: false });
  assert.equal(unrelated.injectionText, '');
});

function runtimeHarness({ prequel = '裴晚生曾把蓝铜钥匙藏在钟楼。', saveResult = true, saveError = null, saveMethod = 'saveChatMetadata', sourceStatus = 'uninitialized' } = {}) {
  const prompts = [], user = { is_user: true, is_system: false, mes: '阿裴，我们继续找蓝铜钥匙。' };
  let hostMetadata = { otherPlugin: { keep: true }, ...(prequel === null ? {} : { qianqianjiePrequel: prequel }) };
  let persistedMetadata = null;
  const context = {
    chatId: 'host-chat-a', chat: [user],
    constants: { promptTypes: { IN_CHAT: 23 }, promptRoles: { SYSTEM: 47 } },
    setExtensionPrompt(...args) { prompts.push(args); },
  };
  Object.defineProperty(context, 'chatMetadata', {
    get() { return hostMetadata; },
    set(value) { hostMetadata = { ...value }; },
  });
  context[saveMethod] = async () => {
    if (saveError) throw saveError;
    if (saveMethod === 'saveMetadata' || saveResult === true) persistedMetadata = structuredClone(hostMetadata);
    return saveMethod === 'saveMetadata' ? undefined : saveResult;
  };
  let sourceReads = 0, modelCalls = 0;
  const hostAdapter = { snapshot: () => ({ context, chat: context.chat, chatId: context.chatId }) };
  const runtime = createV3RecallRuntime({
    store: { readReachable: async () => ({ status: sourceStatus }) }, hostAdapter,
    sourceReader: async () => { sourceReads += 1; return { status: sourceStatus }; },
    generateUtilityTask: async () => { modelCalls += 1; throw new Error('不应调用'); },
    pluginVersion: 'test', logger: { warn() {} }, now: () => new Date('2026-09-12T00:00:00.000Z'),
  });
  return {
    runtime, context, prompts, user,
    get persistedMetadata() { return persistedMetadata; },
    get sourceReads() { return sourceReads; },
    get modelCalls() { return modelCalls; },
  };
}

test('无 QQJ 身份或普通记忆来源时仍注入前情，且不新增模型调用', async () => {
  const h = runtimeHarness({ sourceStatus: 'uninitialized' });
  const result = await h.runtime.intercept([h.user], 12000, null, 'normal');
  assert.equal(result.lastRecall.status, 'skipped');
  assert.equal(result.lastPrequel.status, 'ready');
  assert.match(result.lastPrequel.injectionText, /蓝铜钥匙/);
  assert.ok(h.prompts.some(call => call[0] === PREQUEL_PROMPT_SLOT && /蓝铜钥匙/.test(call[1])));
  assert.equal(h.modelCalls, 0);
});

test('前情 metadata 逐字保存、独立清空并在失败时回滚', async () => {
  const h = runtimeHarness({ prequel: null });
  assert.deepEqual(h.runtime.getPrequel(), { hostChatId: 'host-chat-a', text: '' });
  const raw = '  第一行\n第二行 👩🏽‍🚀  ';
  assert.deepEqual(await h.runtime.savePrequel(raw), { hostChatId: 'host-chat-a', text: raw });
  assert.deepEqual(h.runtime.getPrequel(), { hostChatId: 'host-chat-a', text: raw });
  assert.equal(h.context.chatMetadata.qianqianjiePrequel, raw);
  assert.equal(h.persistedMetadata.qianqianjiePrequel, raw);
  assert.deepEqual(h.context.chatMetadata.otherPlugin, { keep: true });
  assert.deepEqual(h.persistedMetadata.otherPlugin, { keep: true });
  assert.equal(h.sourceReads, 0); assert.equal(h.modelCalls, 0);
  await h.runtime.savePrequel(' \n\t ');
  assert.equal(Object.hasOwn(h.context.chatMetadata, 'qianqianjiePrequel'), false);
  assert.equal(Object.hasOwn(h.persistedMetadata, 'qianqianjiePrequel'), false);
  assert.deepEqual(h.runtime.getPrequel(), { hostChatId: 'host-chat-a', text: '' });
  assert.deepEqual(h.context.chatMetadata.otherPlugin, { keep: true });
  assert.deepEqual(h.persistedMetadata.otherPlugin, { keep: true });

  const failed = runtimeHarness({ prequel: '旧前情', saveResult: false });
  await assert.rejects(failed.runtime.savePrequel('新草稿'), /未能持久化/);
  assert.equal(failed.context.chatMetadata.qianqianjiePrequel, '旧前情');
  assert.deepEqual(failed.runtime.getPrequel(), { hostChatId: 'host-chat-a', text: '旧前情' });
  assert.deepEqual(failed.context.chatMetadata.otherPlugin, { keep: true });
  assert.equal(failed.persistedMetadata, null);

  const thrown = runtimeHarness({ prequel: '旧前情', saveError: new Error('宿主保存失败') });
  await assert.rejects(thrown.runtime.savePrequel('新草稿'), /宿主保存失败/);
  assert.equal(thrown.context.chatMetadata.qianqianjiePrequel, '旧前情');
  assert.deepEqual(thrown.context.chatMetadata.otherPlugin, { keep: true });
  assert.equal(thrown.persistedMetadata, null);

  const absent = runtimeHarness({ prequel: null, saveResult: false });
  await assert.rejects(absent.runtime.savePrequel('新草稿'), /未能持久化/);
  assert.equal(Object.hasOwn(absent.context.chatMetadata, 'qianqianjiePrequel'), false);
  assert.deepEqual(absent.context.chatMetadata.otherPlugin, { keep: true });
  assert.equal(absent.sourceReads, 0); assert.equal(absent.modelCalls, 0);

  const native = runtimeHarness({ prequel: null, saveMethod: 'saveMetadata' });
  await native.runtime.savePrequel('原生前情');
  assert.deepEqual(native.runtime.getPrequel(), { hostChatId: 'host-chat-a', text: '原生前情' });
  assert.equal(native.context.chatMetadata.qianqianjiePrequel, '原生前情');
  assert.equal(native.persistedMetadata.qianqianjiePrequel, '原生前情');
  assert.deepEqual(native.persistedMetadata.otherPlugin, { keep: true });
  assert.equal(native.sourceReads, 0); assert.equal(native.modelCalls, 0);
});
