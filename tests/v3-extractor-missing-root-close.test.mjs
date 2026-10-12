import assert from 'node:assert/strict';
import test from 'node:test';
import { createExtractorEnvelope, runExtractorRequest } from '../src/v3/extractor.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-09-02T00:00:00.000Z';

test('raw/fenced JSON 唯一缺少根对象闭括号时完成语义归一，坏字符串与非 stop 仍拒绝', async () => {
  const floor = { id: '11111111-1111-4111-8111-111111111111', chatId: CHAT, narrativeGeneration: GENERATION,
    assistantSeq: 1, content: { canonicalContent: '林岚走进书房。' } };
  const envelope = await createExtractorEnvelope({ batchId: '36363636-3636-4636-8636-363636363636', chatId: CHAT,
    narrativeGeneration: GENERATION, floor, userIdentity: { displayName: '林岚' } });
  const complete = JSON.stringify({
    summary: '林岚走进书房，准备继续阅读。',
    people: [{ name: '林岚', role: 'user', presence: 'present' }],
    locations: [{ name: '书房', change: 'entered', people: ['林岚'] }],
    spatialFacts: {
      places: [{ key: 'place-mention-1', name: '书房', identity: 'new', exactQuote: '林岚走进书房。', source: 'canonicalContent', sourceFloorKey: 'floor-1' }],
      containments: [],
      positions: [{ subject: '林岚', placeKey: 'place-mention-1', status: 'confirmed', exactQuote: '林岚走进书房。', source: 'canonicalContent', sourceFloorKey: 'floor-1' }],
    },
    qianshi: { events: [], order: [] },
  });
  const missingRootClose = complete.slice(0, -1);
  const run = (textData, finishReason = 'stop') => runExtractorRequest({
    generateUtilityTask: async () => ({ textData, taskMetadata: { finishReason } }),
    envelope, floor, expectedScope: envelope.scope, now: NOW,
  });

  for (const textData of [missingRootClose, `\`\`\`json\n${missingRootClose}\n\`\`\``]) {
    const result = await run(textData);
    assert.equal(result.memory.summary.aiText, '林岚走进书房，准备继续阅读。');
    assert.equal(result.memory.locations[0].name, '书房');
    assert.equal(result.memory.spatialFacts.positions[0].status, 'confirmed');
    assert.deepEqual(result.memory.qianshiDelta.events, []);
  }

  const truncatedString = '{"summary":"林岚走进书房，准备继续阅读。","qianshi":{"events":[{"title":"';
  await assert.rejects(run(truncatedString), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
  await assert.rejects(run(missingRootClose, 'length'), error => error.code === 'V3_EXTRACTOR_SUMMARY_INVALID');
});
