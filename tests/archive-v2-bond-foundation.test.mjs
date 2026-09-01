import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyArchiveV2, validateArchiveV2 } from '../src/archive-v2.js';
import {
  applyArchiveV2BondDraft,
  ARCHIVE_V2_BOND_STAGES,
  archiveV2BondBatchPrompt,
  createArchiveV2BondBatchDraft,
  createArchiveV2BondDraft,
  mergeArchiveV2BondDraftEdits,
  splitArchiveV2BondPeople,
} from '../src/archive-v2-bond-foundation.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const hash = digit => `sha256:${digit.repeat(64)}`;
const ref = (kind = 'chat', digit = 'a') => ({ kind, locator: `${kind}:1`, fingerprint: hash(digit) });
const owned = (value, origin = 'ai', sourceRefs = [ref()], userProtected = false) => ({ value, origin, sourceRefs, userProtected });

function archiveFixture() {
  const archive = createEmptyArchiveV2({ chatId: CHAT, characterLocator: 'char.png', personaLocator: 'me.png' });
  archive.people = {
    order: [ID1, ID2],
    byId: {
      [ID1]: { identityId: ID1, followed: true, displayName: owned('林少白'), aliases: owned([]), fields: {}, sourceRefs: [ref()] },
      [ID2]: { identityId: ID2, followed: true, displayName: owned('陆离'), aliases: owned([]), fields: {}, sourceRefs: [ref()] },
    },
  };
  return validateArchiveV2(archive);
}

function batch() {
  return {
    chatId: CHAT,
    baseRevision: 7,
    updatedThroughFloor: 8,
    people: [
      { person: 'P1', identityId: ID1, displayName: '林少白', sourceCodes: ['M1', 'N1'], nativeSignalCodes: ['N1'] },
      { person: 'P2', identityId: ID2, displayName: '陆离', sourceCodes: ['M2'], nativeSignalCodes: [] },
    ],
    sources: [
      { code: 'M1', kind: 'memory', refKind: 'chat', locator: 'memory-batch:0', fingerprint: hash('1'), content: '林少白与用户', people: ['P1'] },
      { code: 'M2', kind: 'memory', refKind: 'chat', locator: 'memory-batch:0', fingerprint: hash('2'), content: '陆离与用户', people: ['P2'] },
      { code: 'N1', kind: 'native', locator: 'message:8:variables[0].stat_data.好感', fingerprint: hash('3'), signal: { label: '好感', path: 'variables[0].stat_data.好感', value: 99 }, people: ['P1'] },
    ],
  };
}

function output() {
  return { people: [
    {
      person: 'P1',
      fields: [
        { field: 'stage', text: '熟悉', evidence: ['N1'] },
        { field: 'cView', text: '值得信任', evidence: ['M1'] },
        { field: 'unknown', text: '丢弃', evidence: ['M1'] },
      ],
      nativeSignals: ['N1'],
    },
    { person: 'P2', fields: [{ field: 'uBoundary', text: '保持距离', evidence: ['M2'] }], nativeSignals: [] },
  ] };
}

test('1/4/5/10 人严格拆成 1/1/2/3 批且每人恰好一次', () => {
  for (const [count, expected] of [[1, 1], [4, 1], [5, 2], [10, 3]]) {
    const people = Array.from({ length: count }, (_, index) => ({ identityId: `person-${index}` }));
    const batches = splitArchiveV2BondPeople(people);
    assert.equal(batches.length, expected);
    assert.deepEqual(batches.flat(), people);
    assert.ok(batches.every(items => items.length >= 1 && items.length <= 4));
  }
});

test('纯 JSON prompt 不暴露 locator/fingerprint，合法输出回填真实原生路径和值并区分来源所有权', () => {
  const value = batch();
  const prompt = archiveV2BondBatchPrompt(value);
  assert.match(prompt, /nativeSignalCandidates|N1|好感/);
  assert.doesNotMatch(prompt, /sha256:|memory-batch:|message:8/);
  const bonds = createArchiveV2BondBatchDraft({ batch: value, output: output() });
  assert.equal(bonds[0].stage.origin, 'ai');
  assert.equal(bonds[0].cToU.view.origin, 'ai');
  assert.deepEqual(bonds[0].nativeSignals[0], {
    label: '好感', path: 'variables[0].stat_data.好感', value: 99,
    sourceRefs: [{ kind: 'native', locator: 'message:8:variables[0].stat_data.好感', fingerprint: hash('3') }],
  });
  assert.equal(Object.hasOwn(bonds[0].cToU, 'unknown'), false);
});

test('新 stage 只接受固定五阶段且归 AI；作者自定义关系只通过 nativeSignals 原样保留', () => {
  const value = batch();
  value.people[0].sourceCodes.push('N2');
  value.people[0].nativeSignalCodes.push('N2');
  value.sources.push({ code: 'N2', kind: 'native', locator: 'message:8:variables[0].stat_data.当前关系', fingerprint: hash('5'), signal: { label: '当前关系', path: 'variables[0].stat_data.当前关系', value: '第一内臣' }, people: ['P1'] });
  assert.deepEqual(ARCHIVE_V2_BOND_STAGES, ['陌生', '相识', '熟悉', '暧昧', '热恋']);
  for (const stage of ARCHIVE_V2_BOND_STAGES) {
    const accepted = output();
    accepted.people[0].fields[0] = { field: 'stage', text: stage, evidence: ['N2'] };
    accepted.people[0].nativeSignals = ['N2'];
    const bond = createArchiveV2BondBatchDraft({ batch: value, output: accepted })[0];
    assert.equal(bond.stage.value, stage);
    assert.equal(bond.stage.origin, 'ai');
    assert.equal(bond.nativeSignals[0].value, '第一内臣');
  }
  for (const invalid of ['第一内臣', '黏人玩物', '思想重塑', '试探', '恋爱']) {
    const rejected = output();
    rejected.people[0].fields[0] = { field: 'stage', text: invalid, evidence: ['N2'] };
    rejected.people[0].nativeSignals = ['N2'];
    const bond = createArchiveV2BondBatchDraft({ batch: value, output: rejected })[0];
    assert.equal(bond.nativeSignals[0].value, '第一内臣');
    assert.equal(Object.hasOwn(bond, 'stage'), false);
  }
});

test('漏人、重复人、交换/跨人物来源、陌生原生信号和未知 person 键均安全拒绝', () => {
  const value = batch();
  assert.throws(() => createArchiveV2BondBatchDraft({ batch: value, output: { people: output().people.slice(0, 1) } }), /数量/);
  const duplicate = output(); duplicate.people[1].person = 'P1';
  assert.throws(() => createArchiveV2BondBatchDraft({ batch: value, output: duplicate }), /人物代号/);
  const cross = output(); cross.people[1].fields[0].evidence = ['M1'];
  assert.throws(() => createArchiveV2BondBatchDraft({ batch: value, output: cross }), error => error?.code === 'ARCHIVE_V2_BOND_SOURCE_MISMATCH');
  const signal = output(); signal.people[0].nativeSignals = ['N999'];
  assert.throws(() => createArchiveV2BondBatchDraft({ batch: value, output: signal }), error => error?.code === 'ARCHIVE_V2_BOND_NATIVE_SIGNAL_INVALID');
  const otherSignal = output(); otherSignal.people[1].nativeSignals = ['N1'];
  assert.throws(() => createArchiveV2BondBatchDraft({ batch: value, output: otherSignal }), error => error?.code === 'ARCHIVE_V2_BOND_SOURCE_MISMATCH');
  const unknown = output(); unknown.people[0].extra = true;
  assert.throws(() => createArchiveV2BondBatchDraft({ batch: value, output: unknown }), /字段无效/);
});

test('用户编辑成为 userProtected；应用和再次应用都不覆盖保护字段', () => {
  const value = batch();
  const plan = { chatId: CHAT, baseRevision: 7, updatedThroughFloor: 8, people: value.people };
  const draft = createArchiveV2BondDraft({ plan, batchDrafts: [createArchiveV2BondBatchDraft({ batch: value, output: output() })] });
  const edited = mergeArchiveV2BondDraftEdits({ draft, edits: { [ID1]: { stage: '热恋', cView: '用户亲自确认' } } });
  assert.deepEqual(edited.people[0].bond.stage, owned('热恋', 'user', [], true));
  let archive = applyArchiveV2BondDraft({ archive: archiveFixture(), revision: 7, draft: edited });
  assert.equal(archive.bonds[ID1].stage.value, '热恋');
  const nextOutput = output(); nextOutput.people[0].fields[0].text = '暧昧'; nextOutput.people[0].fields[1].text = 'AI 新看法';
  const nextDraft = createArchiveV2BondDraft({ plan, batchDrafts: [createArchiveV2BondBatchDraft({ batch: value, output: nextOutput })] });
  archive = applyArchiveV2BondDraft({ archive, revision: 7, draft: nextDraft });
  assert.equal(archive.bonds[ID1].stage.value, '热恋');
  assert.equal(archive.bonds[ID1].cToU.view.value, '用户亲自确认');
});

test('已有/草稿字段禁止清空保存，拒绝后原草稿与保护内容均不被改写', () => {
  const value = batch();
  const plan = { chatId: CHAT, baseRevision: 7, updatedThroughFloor: 8, people: value.people };
  const draft = createArchiveV2BondDraft({ plan, batchDrafts: [createArchiveV2BondBatchDraft({ batch: value, output: output() })] });
  const before = structuredClone(draft);
  assert.throws(
    () => mergeArchiveV2BondDraftEdits({ draft, edits: { [ID1]: { stage: '   ' } } }),
    error => error?.code === 'ARCHIVE_V2_BOND_FIELD_EMPTY' && /不能保存为空/.test(error.message),
  );
  assert.deepEqual(draft, before);

  assert.throws(
    () => mergeArchiveV2BondDraftEdits({ draft, edits: { [ID1]: { stage: '用户保护阶段' } } }),
    error => error?.code === 'ARCHIVE_V2_BOND_STAGE_INVALID',
  );
  const protectedDraft = mergeArchiveV2BondDraftEdits({ draft, edits: { [ID1]: { stage: '暧昧' } } });
  const archive = applyArchiveV2BondDraft({ archive: archiveFixture(), revision: 7, draft: protectedDraft });
  assert.equal(archive.bonds[ID1].stage.value, '暧昧');
  assert.equal(archive.bonds[ID1].stage.userProtected, true);
});

test('archive 接受 bonds:{} 与合法 bond，拒绝陌生人物、未知键、非法所有权、循环和非 JSON 值', () => {
  assert.deepEqual(validateArchiveV2(archiveFixture()).bonds, {});
  const value = batch();
  const plan = { chatId: CHAT, baseRevision: 7, updatedThroughFloor: 8, people: value.people };
  const draft = createArchiveV2BondDraft({ plan, batchDrafts: [createArchiveV2BondBatchDraft({ batch: value, output: output() })] });
  const valid = applyArchiveV2BondDraft({ archive: archiveFixture(), revision: 7, draft });
  assert.equal(validateArchiveV2(valid).bonds[ID1].identityId, ID1);

  const strangers = structuredClone(valid); strangers.bonds.unknown = structuredClone(strangers.bonds[ID1]);
  assert.throws(() => validateArchiveV2(strangers), error => error?.code === 'ARCHIVE_V2_BOND_PERSON_UNKNOWN');
  const unknown = structuredClone(valid); unknown.bonds[ID1].extra = true;
  assert.throws(() => validateArchiveV2(unknown), error => error?.code === 'ARCHIVE_V2_BOND_INVALID');
  const ownership = structuredClone(valid); ownership.bonds[ID1].stage.origin = 'invented';
  assert.throws(() => validateArchiveV2(ownership), error => error?.code === 'ARCHIVE_V2_BOND_INVALID');
  const circular = structuredClone(valid); circular.bonds[ID1].cToU.loop = circular.bonds[ID1];
  assert.throws(() => validateArchiveV2(circular), /循环/);
  const nonJson = structuredClone(valid); nonJson.bonds[ID1].nativeSignals[0].value = undefined;
  assert.throws(() => validateArchiveV2(nonJson), /合法 JSON/);
});
