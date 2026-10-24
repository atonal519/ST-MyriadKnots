import test from 'node:test';
import assert from 'node:assert/strict';
import { auxiliaryStateSnapshotForPrompt } from '../src/v3/floor-variable-reference.js';
import { collectPeopleHistory, compactPeopleHistory, createPeopleEvidenceProjection, peopleMaterialSignature, splitProfileSource } from '../src/v3/people-profile-material.js';

test('人物原句同来源只存一次，出现次数、归属和含义仍属于各条事实引用', () => {
  const projection = createPeopleEvidenceProjection({ floorSequence: new Map([['first', 1], ['second', 2]]), fallbackFloorId: 'second' });
  const ref = { floorId: 'first', quotedText: '已存原句', occurrence: 1, evidenceMode: 'reported', sourceEntityId: 'speaker', supports: '转述' };
  const first = projection.evidence([ref, { ...ref, occurrence: 2, evidenceMode: 'privateCognition', supports: '私密判断' }]);
  assert.equal(projection.sources.length, 1);
  assert.deepEqual(first, [
    { sourceIndex: 1, occurrence: 1, evidenceMode: 'reported', supports: '转述', sourceEntityId: 'speaker' },
    { sourceIndex: 1, occurrence: 2, evidenceMode: 'privateCognition', supports: '私密判断', sourceEntityId: 'speaker' },
  ]);
  assert.equal(projection.evidence([{ ...ref, floorId: 'second' }])[0].sourceIndex, 2);
  assert.equal(projection.evidence([{ ...ref, sourceType: 'precedingUser', sourceSnapshotIndex: 0 }])[0].sourceIndex, 3);
  assert.deepEqual(projection.sources[2], { sourceFloor: 1, sourceType: 'precedingUser', sourceSnapshotIndex: 0, quotedText: '已存原句' });
});

function replay(history) {
  let current;
  return history.map(item => {
    if (Object.hasOwn(item, 'auxiliaryStateSnapshot')) current = structuredClone(item.auxiliaryStateSnapshot);
    else if (item.auxiliaryStateChanges) for (const change of item.auxiliaryStateChanges.changes) {
      if (!change.path.length) { current = structuredClone(change.value); continue; }
      let parent = current;
      for (const key of change.path.slice(0, -1)) parent = parent[key];
      if (change.delete) delete parent[change.path.at(-1)];
      else Object.defineProperty(parent, change.path.at(-1), { value: structuredClone(change.value), enumerable: true, writable: true, configurable: true });
    }
    return Object.hasOwn(item, 'auxiliaryStateSnapshot') || item.auxiliaryStateChanges ? structuredClone(current) : undefined;
  });
}

test('变量精确路径差异保删除与所有JSON值，缺快照不推进，未知schema及嵌套schema保留', async () => {
  const schema = { type: 'object', properties: {} };
  const values = [
    { schema, stat_data: { gone: 'old', nil: null, zero: 0, yes: false, empty: '', object: {}, array: [], nested: { schema: '业务定义', 'a.b': 1 } }, other: '保留' },
    null,
    { schema, stat_data: { nil: '', zero: false, yes: 0, empty: null, object: [], array: {}, nested: { schema: '业务定义', 'a.b': 2 } }, other: '保留' },
    { schema: { meaning: '未知业务schema' }, stat_data: { field: ['整数组', { value: 1 }] } },
    { schema: { meaning: '未知业务schema' }, stat_data: { field: ['整数组', { value: 1 }] } },
    { schema, stat_data: {}, other: {} },
  ];
  const history = values.map((value, index) => ({ sourceFloor: [10, 11, 15, 20, 21, 25][index], summary: `摘要${index}`, ...(value ? { auxiliaryStateSnapshot: value } : {}) }));
  const original = JSON.stringify(history);
  const compacted = await compactPeopleHistory(history);
  assert.equal(compacted[2].auxiliaryStateChanges.fromSourceFloor, 10);
  assert.deepEqual(compacted[2].auxiliaryStateChanges.changes.find(item => item.delete), { path: ['stat_data', 'gone'], delete: true });
  assert.deepEqual(compacted[4].auxiliaryStateChanges.changes, []);
  const actual = replay(compacted);
  values.forEach((value, index) => assert.deepEqual(actual[index], value ? auxiliaryStateSnapshotForPrompt(value) : undefined));
  assert.equal(JSON.stringify(history), original);
  assert.deepEqual(compacted.map(item => item.summary), history.map(item => item.summary));
  assert.deepEqual(auxiliaryStateSnapshotForPrompt({ schema, business: 1 }), { schema, business: 1 }, '没有stat_data时不猜是MVU');
});

test('连续切片不拆代理对，空串/未配对代理与中文原样连续且无巨型字符数组', () => {
  for (const source of ['', 'abc', '甲😀乙\ud800丙', '😀'.repeat(32000)]) {
    for (const maximum of [1, 2, 12000]) {
      const parts = splitProfileSource(source, maximum);
      assert.equal(parts.join(''), source);
      assert.ok(parts.every(part => [...part].length <= maximum));
      for (let index = 0; index + 1 < parts.length; index++) assert.equal(/\ud83d$/u.test(parts[index]) && /^\ude00/u.test(parts[index + 1]), false);
    }
  }
});

test('历史收集在有界源楼间让出并保持同一原材料签名', async () => {
  const history = Array.from({ length: 35 }, (_, index) => index === 2 ? null : { sourceFloor: index + 1, summary: '😀', auxiliaryStateSnapshot: { value: index } });
  let yields = 0;
  const result = await collectPeopleHistory(history.values(), async () => { yields++; });
  assert.equal(yields, 2);
  assert.deepEqual(result.history, history.filter(Boolean));
  assert.equal(result.signature, peopleMaterialSignature(history.filter(Boolean)));
  const compacted = await compactPeopleHistory(result.history, async () => { yields++; });
  assert.deepEqual(replay(compacted), history.filter(Boolean).map(item => item.auxiliaryStateSnapshot));
});

test('流式签名保持旧生产people-material-v1的逐字节结果', () => {
  const cases = [
    [[], 'people-material-v1:2:741638a566682bbe'],
    [[{ sourceFloor: 1, summary: '😀', auxiliaryStateSnapshot: { x: null, n: 0, flag: false } }], 'people-material-v1:89:afa8812f9468fe8f'],
    [{ context: { name: '甲' }, characterCard: null }, 'people-material-v1:45:63d8a37d0fec566d'],
  ];
  for (const [value, expected] of cases) assert.equal(peopleMaterialSignature(value), expected);
});
