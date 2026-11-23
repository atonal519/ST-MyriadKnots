import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryParticipantDirectory, memoryParticipantsForDisplay, parseMemoryParticipantNames } from '../src/v3/memory-participants.js';

const entity = (id, entityType, displayName, fields = {}) => ({ id, entityType, displayName, recordStatus: 'active', status: 'established', specialRole: 'none', aliases: [], ...fields });

test('参与者目录沿权威合并映射保旧成员、当前姓名，并排除删除与无效实体', () => {
  const entities = [entity('person', 'person', '原名'), entity('old-person', 'person', '旧人', { status: 'merged', mergedIntoEntityId: 'person' }),
    entity('group', 'group', '守夜组'), entity('old-group', 'group', '旧组', { status: 'merged', mergedIntoEntityId: 'group' }),
    entity('gone', 'group', '已删除组'), entity('invalid', 'group', '无效组', { status: 'invalidated' }), entity('place', 'place', '钟楼')];
  const directory = buildMemoryParticipantDirectory({ entities, identityProjection: { currentNamesByEntityId: { person: '当前名' }, deletedEntityIds: ['gone'] } });
  assert.deepEqual(directory.map(entry => [entry.entityId, entry.displayName, entry.memberEntityIds]), [
    ['person', '当前名', ['old-person', 'person']], ['group', '守夜组', ['group', 'old-group']],
  ]);
  assert.ok(directory.find(entry => entry.entityId === 'group').aliases.includes('旧组'));
});

test('参与者显示按身份保顺序与同名，旧成员只显示一次，归档来源姓名仍可读', () => {
  const state = { memoryEntities: [{ entityId: 'person', memberEntityIds: ['person', 'old'], displayName: '猎隼' }],
    memoryGroupEntities: [{ entityId: 'group', memberEntityIds: ['group', 'old-group'], displayName: '猎隼' }] };
  const memory = { participants: ['old-group', 'old', 'person', 'gone', 'group'].map(entityId => ({ entityId })) };
  assert.deepEqual(memoryParticipantsForDisplay(state, memory).map(entry => [entry.entityId, entry.displayName]), [['group', '猎隼'], ['person', '猎隼']]);
  const archived = { participants: [{ entityId: 'source-person' }] };
  assert.deepEqual(memoryParticipantsForDisplay(state, archived, { frozen: true, memoryEntityNames: { 'source-person': '来源人物' } }).map(entry => entry.displayName), ['来源人物']);
});

test('编辑名单保已有完整群体名、重复姓名与普通分隔输入', () => {
  assert.deepEqual(parseMemoryParticipantNames('值班员、甲、乙两组、守夜,巡逻组，猎隼、猎隼\n新路人', ['值班员', '甲、乙两组', '守夜,巡逻组', '猎隼', '猎隼']),
    ['值班员', '甲、乙两组', '守夜,巡逻组', '猎隼', '猎隼', '新路人']);
  assert.deepEqual(parseMemoryParticipantNames('甲、乙两组\n新同事', ['甲、乙两组']), ['甲、乙两组', '新同事']);
  assert.deepEqual(parseMemoryParticipantNames('  张三，李四\n 王五 、 赵六 '), ['张三', '李四', '王五', '赵六']);
  assert.deepEqual(parseMemoryParticipantNames(' 、 ， \n '), []);
});
