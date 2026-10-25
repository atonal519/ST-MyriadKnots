import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BASE_PROCESSING_PROMPT, getSharedProcessingPrompt, initializeSharedProcessingPrompt, updateSharedProcessingPrompt, resolveSharedProcessingPrompt } from '../src/shared-processing-prompt.js';
import { createCompactApiClient } from '../src/compact-api-client.js';

test('共享破限：缺键只迁移一次，已有空值使用默认且不回灌旧自定义', () => {
  const settings = { qianqianjie: { processingPrompt: '  原自定义\n' }, 'schedule-planner': { unrelated: 7 } };
  let saves = 0;
  assert.equal(getSharedProcessingPrompt(settings), '  原自定义\n');
  assert.equal(initializeSharedProcessingPrompt(settings, () => saves++), true);
  assert.equal(getSharedProcessingPrompt(settings), '  原自定义\n');
  updateSharedProcessingPrompt(settings, ''); settings.qianqianjie.processingPrompt = '旧值不回灌';
  assert.equal(initializeSharedProcessingPrompt(settings, () => saves++), false);
  assert.equal(settings['schedule-planner'].processingPrompt, '');
  assert.equal(getSharedProcessingPrompt(settings), '');
  assert.equal(resolveSharedProcessingPrompt(getSharedProcessingPrompt(settings)), BASE_PROCESSING_PROMPT);
  assert.equal(settings['schedule-planner'].unrelated, 7); assert.equal(saves, 1);
  assert.equal(getSharedProcessingPrompt({}), BASE_PROCESSING_PROMPT);
});

test('共享破限：空串、空白和错型派发使用默认，原配置与非空自定义逐字保留', () => {
  for (const value of ['', ' \n\t ', null, 42, false, {}, '  自定义原文\n']) {
    const settings = { 'schedule-planner': { processingPrompt: value }, qianqianjie: { processingPrompt: '旧值' } };
    const before = JSON.stringify(settings);
    assert.equal(getSharedProcessingPrompt(settings), typeof value === 'string' ? value : '');
    assert.equal(resolveSharedProcessingPrompt(getSharedProcessingPrompt(settings)), typeof value === 'string' && value.trim() ? value : BASE_PROCESSING_PROMPT);
    assert.equal(JSON.stringify(settings), before, '只读不写回默认全文');
  }
});

test('共享破限：实际派发现读有效默认或自定义，首system与两指纹一致且每次仅一请求', async () => {
  const settings = { 'schedule-planner': { processingPrompt: '准备期旧值' } }, sent = [];
  const client = createCompactApiClient({ processingPrompt: () => getSharedProcessingPrompt(settings), fetchImpl: async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] });
  } });
  const config = { url: 'https://fixture.invalid/v1', key: 'fixture', model: 'fixture', stream: false, excludeParams: [] };
  for (const [index, value] of ['', ' \n ', '  新自定义\n'].entries()) {
    updateSharedProcessingPrompt(settings, value);
    const result = await client.generateTask({ config, systemPrompt: 'BUSINESS TASK', taskMessages: [{ role: 'user', content: 'SYNTHETIC BODY' }], parseMode: 'semantic' });
    const prefix = value.trim() ? value : BASE_PROCESSING_PROMPT, actual = prefix + '\n\nBUSINESS TASK';
    assert.equal(sent.length, index + 1); assert.equal(sent[index].messages[0].content, actual);
    assert.equal(sent[index].messages[1].content, 'SYNTHETIC BODY');
    assert.equal(result.taskMetadata.processingPromptFingerprint, `sha256:${createHash('sha256').update(prefix).digest('hex')}`);
    assert.equal(result.taskMetadata.systemPromptFingerprint, `sha256:${createHash('sha256').update(actual).digest('hex')}`);
  }
});
