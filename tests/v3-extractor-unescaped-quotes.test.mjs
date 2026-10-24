import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonWithSymbolRepair } from '../src/json-symbol-repair.js';
import { createExtractorEnvelope, runExtractorRequest } from '../src/v3/extractor.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-09-02T00:00:00.000Z';

test('符号修复转义字符串内未转义的台词引号，含紧贴收尾引号（后接下一个键）与引号后接逗号正文', () => {
  const cases = [
    ['{"summary":"林岚靠在门边念叨"再等等"。随后离开。","people":[]}', '林岚靠在门边念叨"再等等"。随后离开。'],
    ['{"summary":"林岚说"好",然后关上门。","people":[]}', '林岚说"好",然后关上门。'],
    ['{"summary":"林岚写下缩写"L. L."", "people":[]}', '林岚写下缩写"L. L."'],
  ];
  for (const [input, summary] of cases) {
    assert.throws(() => JSON.parse(input));
    const repaired = parseJsonWithSymbolRepair(input, { finishReason: 'stop' });
    assert.equal(repaired?.value.summary, summary, input);
    assert.deepEqual(repaired.value.people, []);
    assert.equal(repaired.operations.every(item => item.type === 'escape-string-quote'), true);
  }

  const valid = '{"summary":"林岚说\\"好\\",然后关上门。","people":[]}';
  const unchanged = parseJsonWithSymbolRepair(valid, { finishReason: 'stop' });
  assert.equal(unchanged.repaired, false);
  assert.equal(unchanged.text, valid);
  assert.equal(unchanged.value.summary, '林岚说"好",然后关上门。');

  for (const value of ['{"summary":"林岚低声说"等等": 然后离开。"}', '["a""b"]', '{"summary":"林岚说"好"', '{"summary":"他说"路径""}']) {
    assert.equal(parseJsonWithSymbolRepair(value, { finishReason: 'stop' }), null, value);
  }
  assert.equal(parseJsonWithSymbolRepair(cases[0][0], { finishReason: 'length' }), null);
});

test('高楼摘要容忍代码框与未转义台词引号，无法修复时仍报摘要无效', async () => {
  const floor = { id: '11111111-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GENERATION,
    assistantSeq: 1, content: { canonicalContent: '林岚走进书房。' } };
  const envelope = await createExtractorEnvelope({ batchId: '37373737-3737-4737-8737-373737373737', chatId: CHAT,
    narrativeGeneration: GENERATION, floor, userIdentity: { displayName: '林岚' } });
  const run = (textData, finishReason = 'stop') => runExtractorRequest({
    generateUtilityTask: async () => ({ textData, taskMetadata: { finishReason } }),
    envelope, floor, expectedScope: envelope.scope, now: NOW,
  });
  const packet = summary => `{\n  "summary": "${summary}",\n  "people": [{"name": "林岚", "role": "user", "presence": "present"}],\n  "qianshi": {"events": [], "order": []}\n}`;
  const clean = '林岚走进书房，准备继续阅读。';
  const quoted = '林岚走进书房，小声说"先看一章"，又在扉页写下缩写"L. L."';
  const fence = text => `\`\`\`json\n${text}\n\`\`\``;

  for (const [textData, summary] of [[packet(clean), clean], [fence(packet(clean)), clean], [packet(quoted), quoted], [fence(packet(quoted)), quoted]]) {
    const result = await run(textData);
    assert.equal(result.memory.summary.aiText, summary);
  }

  for (const textData of [fence(packet('林岚低声说"等等": 然后离开。')), fence(packet(quoted).slice(0, -20))]) {
    await assert.rejects(run(textData), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
  }
  await assert.rejects(run(fence(packet(quoted)), 'length'), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
});
