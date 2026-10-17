import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/identity.js';
import { PREQUEL_PROMPT_SLOT, selectPrequel, splitPrequelText } from '../src/v3/recall-prequel.js';
import { createV3RecallRuntime, RECALL_PROMPT_SLOT, RECALL_RECEIPT_KEY } from '../src/v3/recall-runtime.js';
import { estimateRecallTokens, recallBudget, selectRecall } from '../src/v3/recall-selector.js';
import { projectRecallSource } from '../src/v3/recall-source.js';

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

  const noRoom = selectPrequel({ text: source, queryContext: { latestUserText: '继续' }, maxCharacters: 0, maxTokens: 0 });
  assert.equal(noRoom.injectionText, '', '没有剩余额度时不强塞前情片段');
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

const sharedBudgetChatId = 'a1111111-1111-4111-8111-111111111111';
const sharedBudgetGeneration = 'b2222222-2222-4222-8222-222222222222';
const sharedBudgetContextSize = 8192;
const sharedBudgetNow = () => new Date('2026-10-17T00:00:00.000Z');
const emptyRecallArrays = {
  participants: [], locations: [], commitments: [], openLoops: [], exactAnchors: [], eventFragments: [],
  actions: [], observations: [], privateCognition: [], informationTransfers: [],
};

async function sharedBudgetReachable(chat) {
  const floors = [], floorMemories = [], stateDeltas = [];
  for (let seq = 1; seq <= 12; seq += 1) {
    const floorId = `f1111111-1111-4111-8111-${String(seq).padStart(12, '0')}`;
    const memoryId = `c1111111-1111-4111-8111-${String(seq).padStart(12, '0')}`;
    const messageIndex = seq * 2 - 1;
    const bodyFingerprint = `sha256:${await sha256(chat[messageIndex].mes)}`;
    floors.push({ id: floorId, assistantSeq: seq,
      hostLocator: { messageIndex, swipeId: null, selectedSwipeIndex: null },
      content: { rawFingerprint: bodyFingerprint, canonicalFingerprint: bodyFingerprint } });
    const summary = Array.from({ length: 28 }, (_, index) =>
      `林岚在月台整理旧账，第${seq}份记录的第${index + 1}项已核对，信件编号${seq}-${index + 1}保留原样。`
    ).join('');
    floorMemories.push({ id: memoryId, floorId, recordStatus: 'active',
      summary: { effectiveSource: 'ai', aiText: summary }, ...structuredClone(emptyRecallArrays) });
    stateDeltas.push({ id: `e1111111-1111-4111-8111-${String(seq).padStart(12, '0')}`, floorId,
      floorMemoryId: memoryId, recordStatus: 'active', subjectSnapshots: [], fixedChanges: [] });
  }
  const checkpointId = 'd3333333-3333-4333-8333-333333333333';
  return { status: 'ready', rootRevision: 1,
    root: { chatId: sharedBudgetChatId, narrativeGeneration: sharedBudgetGeneration, headCheckpointId: checkpointId },
    checkpoint: { id: checkpointId }, baseline: null, floors, floorMemories, entities: [], stateDeltas, currentStates: [] };
}

async function exerciseSharedBudgetSaveMethod(saveMethod, { contextSize = sharedBudgetContextSize, initialPrequel = null } = {}) {
  const prompts = [];
  const user = { is_user: true, is_system: false, mes: '请继续整理月台旧账。', extra: {} };
  const chat = [];
  for (let seq = 1; seq <= 12; seq += 1) {
    chat.push({ is_user: true, is_system: false, mes: `继续整理第${seq}份记录。` });
    chat.push({ is_user: false, is_system: false, mes: `林岚在月台核对旧账，第${seq}楼记录已归档。` });
  }
  chat.push(user);
  const metadata = { qianqianjie: { chatId: sharedBudgetChatId }, otherPluginDisplay: { keep: 'unchanged' },
    ...(initialPrequel === null ? {} : { qianqianjiePrequel: initialPrequel }) };
  let metadataSaves = 0, receiptChatSaves = 0, sourceReads = 0, selectorCalls = 0, utilityCalls = 0;
  const context = {
    chatId: 'host-chat-prequel-budget', chat, chatMetadata: metadata,
    constants: { promptTypes: { IN_CHAT: 23 }, promptRoles: { SYSTEM: 47 } },
    setExtensionPrompt(...args) { prompts.push(args); },
    async saveChat() { receiptChatSaves += 1; },
  };
  context[saveMethod] = async () => { metadataSaves += 1; return saveMethod === 'saveMetadata' ? undefined : true; };
  const reachable = await sharedBudgetReachable(chat);
  const hostAdapter = { snapshot: () => ({ context, chat: context.chat, chatId: context.chatId }) };
  const runtime = createV3RecallRuntime({
    store: { readReachable: async () => structuredClone(reachable) },
    sourceReader: async ({ hostSnapshot }) => {
      sourceReads += 1;
      return projectRecallSource(structuredClone(reachable), sharedBudgetNow,
        Object.freeze({ reachableReads: 1, exitPoint: 'ready' }), hostSnapshot);
    },
    hostAdapter,
    selector: input => { selectorCalls += 1; return selectRecall(input); },
    generateUtilityTask: async () => { utilityCalls += 1; throw new Error('此冻结回执复用不应调用模型'); },
    pluginVersion: 'runtime-budget-test', now: sharedBudgetNow, logger: { warn() {} },
  });

  const initial = await runtime.intercept(chat, contextSize, null, 'normal');
  await new Promise(resolve => setImmediate(resolve));
  const firstReceiptText = JSON.stringify(user.extra[RECALL_RECEIPT_KEY]);
  const firstSnapshot = runtime.getPromptSnapshot();
  const firstRecall = firstSnapshot?.recall?.text ?? '';
  assert.equal(initial.lastRecall.status, 'ready', `${saveMethod}: 首轮普通回执应可用`);
  assert.equal(firstRecall, prompts.filter(call => call[0] === RECALL_PROMPT_SLOT).at(-1)?.[1] ?? '');
  const firstPrequel = firstSnapshot?.prequel?.text ?? '';
  assert.equal(firstPrequel, initialPrequel ? prompts.filter(call => call[0] === PREQUEL_PROMPT_SLOT).at(-1)?.[1] ?? '' : '');
  if (initialPrequel === null) assert.equal(firstPrequel, '');
  else assert.ok(firstPrequel.includes(initialPrequel), `${saveMethod}: 首轮格式化槽应包含原前情文本`);
  assert.equal(selectorCalls, 1);

  const budget = recallBudget(contextSize);
  assert.ok(firstRecall.length <= budget.totalCharacters);
  assert.ok(estimateRecallTokens(firstRecall) <= budget.totalTokens);
  const prequelText = initialPrequel ?? Array.from({ length: 90 }, (_, index) =>
    `此前林岚在月台整理旧账，第${index + 1}段记下了信件交接和编号核对。`
  ).join('\n');
  assert.equal((await runtime.savePrequel(prequelText)).text, prequelText);
  assert.equal(metadata.qianqianjiePrequel, prequelText);
  const readsBeforeReuse = sourceReads;
  const metadataSavesBeforeReuse = metadataSaves;
  const receiptSavesBeforeReuse = receiptChatSaves;

  const reused = await runtime.intercept(chat, contextSize, null, 'regenerate');
  await new Promise(resolve => setImmediate(resolve));
  const reusedSnapshot = runtime.getPromptSnapshot();
  const reusedRecall = reusedSnapshot?.recall?.text ?? '';
  const reusedPrequel = reusedSnapshot?.prequel?.text ?? '';
  assert.equal(reused.lastRecall.status, 'ready', `${saveMethod}: 重生成仍应就绪`);
  assert.equal(reused.lastRecall.reusedReceipt, true, `${saveMethod}: 应复用原USER回执`);
  assert.equal(JSON.stringify(user.extra[RECALL_RECEIPT_KEY]), firstReceiptText, `${saveMethod}: 原回执签名材料逐字保留`);
  assert.equal(reusedRecall, prompts.filter(call => call[0] === RECALL_PROMPT_SLOT).at(-1)?.[1] ?? '');
  assert.equal(reusedPrequel, prompts.filter(call => call[0] === PREQUEL_PROMPT_SLOT).at(-1)?.[1] ?? '');
  assert.equal(reusedPrequel.length > 0, true, `${saveMethod}: 保留可用前情片段`);
  assert.equal(selectorCalls, 1, `${saveMethod}: 冻结复用不重跑召回选择器`);
  assert.equal(utilityCalls, 0, `${saveMethod}: 不新增模型调用`);
  assert.ok(sourceReads - readsBeforeReuse <= 1, `${saveMethod}: 不因预算收紧增加来源读取`);
  assert.equal(metadataSaves, metadataSavesBeforeReuse, `${saveMethod}: 复用回执不重复保存宿主前情元数据`);
  assert.equal(receiptChatSaves, receiptSavesBeforeReuse, `${saveMethod}: 复用回执不重写原回执`);
  assert.equal(metadata.otherPluginDisplay.keep, 'unchanged');
  assert.equal(runtime.getPrequel().text, prequelText, `${saveMethod}: 前情原文保持不变`);
  assert.ok(reusedRecall.length + reusedPrequel.length <= budget.totalCharacters,
    `${saveMethod}: 普通召回+前情字符 ${reusedRecall.length + reusedPrequel.length} <= ${budget.totalCharacters}`);
  assert.ok(estimateRecallTokens(reusedRecall) + estimateRecallTokens(reusedPrequel) <= budget.totalTokens,
    `${saveMethod}: 普通召回+前情token不超过共同额度`);
  const emptyPrequel = await runtime.savePrequel(' \n\t ');
  assert.equal(emptyPrequel.text, '');
  assert.equal(Object.hasOwn(metadata, 'qianqianjiePrequel'), false, `${saveMethod}: 清空前情仍删除本字段`);
  const afterClear = await runtime.intercept(chat, contextSize, null, 'regenerate');
  const clearedSnapshot = runtime.getPromptSnapshot();
  assert.equal(afterClear.lastRecall.reusedReceipt, true, `${saveMethod}: 清空前情不使普通回执失效`);
  assert.equal(clearedSnapshot?.recall?.text ?? '', reusedRecall);
  assert.equal(clearedSnapshot?.prequel?.text ?? '', '');
  assert.equal(prompts.filter(call => call[0] === PREQUEL_PROMPT_SLOT).at(-1)?.[1] ?? '', '');
  assert.equal(JSON.stringify(user.extra[RECALL_RECEIPT_KEY]), firstReceiptText);
  assert.equal(selectorCalls, 1);
  return { saveMethod, reusedReceipt: true, selectorCalls, extraSourceReads: sourceReads - readsBeforeReuse,
    characters: reusedRecall.length + reusedPrequel.length, characterBudget: budget.totalCharacters,
    tokens: estimateRecallTokens(reusedRecall) + estimateRecallTokens(reusedPrequel), tokenBudget: budget.totalTokens,
    firstPrequel, reusedPrequel, adequateSelectionPreserved: firstPrequel === reusedPrequel };
}

test('真实冻结回执复用会在普通召回之后收紧前情，两个宿主保存合同都不越共同预算', async () => {
  const results = [await exerciseSharedBudgetSaveMethod('saveMetadata'), await exerciseSharedBudgetSaveMethod('saveChatMetadata')];
  assert.deepEqual(results.map(result => result.saveMethod), ['saveMetadata', 'saveChatMetadata']);
});

test('足额前情的冻结复用保持首轮选段不变并与双提示槽快照一致', async () => {
  const initialPrequel = '林岚此前在月台整理旧账，当前继续核对同一组信件编号。';
  const result = await exerciseSharedBudgetSaveMethod('saveMetadata', { contextSize: 16384, initialPrequel });
  assert.equal(result.adequateSelectionPreserved, true);
});
