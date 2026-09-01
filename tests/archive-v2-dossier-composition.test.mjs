import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyArchiveV2, validateArchiveV2 } from '../src/archive-v2.js';
import { createArchiveV2DossierComposition } from '../src/archive-v2-dossier-composition.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PERSON = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TIME = '2026-09-01T01:02:03.000Z';
const owned = (value, origin = 'ai', userProtected = false) => ({ value, origin, sourceRefs: [], userProtected });
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });

function envelope(data, revision = 4) {
  return { schemaVersion: 1, revision, generationId: '33333333-3333-4333-8333-333333333333', createdAt: TIME, updatedAt: TIME, data: structuredClone(data) };
}

function fixture() {
  const archive = createEmptyArchiveV2({ chatId: CHAT, characterLocator: 'character.png', personaLocator: 'persona.png' });
  archive.people = {
    order: [PERSON, OTHER],
    byId: {
      [PERSON]: {
        identityId: PERSON, followed: true, displayName: owned('林少白'), aliases: owned(['Charles']),
        fields: { gender: owned('男性'), personality: owned('冷静'), principles: owned('不伤害用户', 'user', true) }, sourceRefs: [],
      },
      [OTHER]: {
        identityId: OTHER, followed: false, displayName: owned('陆离'), aliases: owned([]), fields: {}, sourceRefs: [],
      },
    },
  };
  return validateArchiveV2(archive);
}

function harness({ enabled = () => true, pendingPut = false, conflictOnPut = false } = {}) {
  let current = {
    characterId: 0, characters: [{ avatar: 'character.png' }], userAvatar: 'persona.png', chatId: 'host-chat',
    chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: CHAT } },
  };
  let record = envelope(fixture());
  const calls = [];
  let observedSignal;
  let releasePut;
  const client = {
    async get(collection, recordId) {
      calls.push(['get', collection, recordId]);
      return structuredClone(record);
    },
    async put(collection, recordId, data, expectedRevision, options) {
      calls.push(['put', collection, recordId, structuredClone(data), expectedRevision, options]);
      observedSignal = options?.signal;
      if (pendingPut) {
        return new Promise((resolve, reject) => {
          releasePut = () => resolve(structuredClone(record));
          observedSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      }
      if (conflictOnPut) {
        conflictOnPut = false;
        record = envelope(record.data, record.revision + 1);
      }
      if (expectedRevision !== record.revision) throw httpError(409);
      record = envelope(data, expectedRevision + 1);
      return structuredClone(record);
    },
  };
  const composition = createArchiveV2DossierComposition({ client, contextProvider: () => current, isEnabled: enabled });
  return {
    composition, calls,
    get record() { return record; },
    get observedSignal() { return observedSignal; },
    get releasePut() { return releasePut; },
    changeChat() { current = { ...current, chatId: 'other-host', chatMetadata: { qianqianjie: { schemaVersion: 1, chatId: OTHER_CHAT } } }; },
  };
}

test('多字段与姓名一次 CAS PUT，只改动变化项并写入用户 ownership', async () => {
  const h = harness();
  const beforePerson = structuredClone(h.record.data.people.byId[PERSON]);
  const result = await h.composition.updatePerson({
    identityId: PERSON,
    displayName: '林少白·改',
    fields: { gender: '男性', personality: '沉稳', abilities: '', principles: '不伤害用户' },
  });
  assert.equal(result.status, 'saved');
  assert.equal(h.calls.filter(call => call[0] === 'put').length, 1);
  const person = h.record.data.people.byId[PERSON];
  assert.deepEqual(person.displayName, owned('林少白·改', 'user', true));
  assert.deepEqual(person.fields.personality, owned('沉稳', 'user', true));
  assert.deepEqual(person.fields.abilities, owned('', 'user', true));
  assert.deepEqual(person.fields.gender, beforePerson.fields.gender);
  assert.deepEqual(person.fields.principles, beforePerson.fields.principles);
  assert.deepEqual(person.aliases, beforePerson.aliases);
  assert.deepEqual(h.record.data.people.byId[OTHER], fixture().people.byId[OTHER]);
});

test('关注/静默与因缘簿改名各使用一次 CAS', async () => {
  const h = harness();
  assert.equal((await h.composition.setFollowed({ identityId: OTHER, followed: true })).status, 'saved');
  assert.equal(h.record.data.people.byId[OTHER].followed, true);
  assert.equal((await h.composition.setFollowed({ identityId: PERSON, followed: false })).status, 'saved');
  assert.equal(h.record.data.people.byId[PERSON].followed, false);
  assert.equal((await h.composition.renamePerson({ identityId: OTHER, displayName: '陆离·改' })).status, 'saved');
  assert.deepEqual(h.record.data.people.byId[OTHER].displayName, owned('陆离·改', 'user', true));
  assert.equal(h.calls.filter(call => call[0] === 'put').length, 3);
});

test('无变化时零 PUT，CAS 冲突不覆盖现场', async () => {
  const h = harness();
  const unchanged = await h.composition.updatePerson({ identityId: PERSON, displayName: '林少白', fields: { gender: '男性' } });
  assert.equal(unchanged.status, 'ready');
  assert.equal(unchanged.changed, false);
  assert.equal(h.calls.filter(call => call[0] === 'put').length, 0);

  const conflict = harness({ conflictOnPut: true });
  const result = await conflict.composition.renamePerson({ identityId: PERSON, displayName: '冲突改名' });
  assert.equal(result.status, 'conflict');
  assert.equal(conflict.record.data.people.byId[PERSON].displayName.value, '林少白');
  assert.equal(conflict.calls.filter(call => call[0] === 'put').length, 1);
});

test('写入等待时 invalidate/切聊天/禁用都 abort 且不假报 saved', async () => {
  for (const mode of ['invalidate', 'chat', 'disabled']) {
    let enabled = true;
    const h = harness({ enabled: () => enabled, pendingPut: true });
    const pending = h.composition.updatePerson({ identityId: PERSON, fields: { identity: '调查员' } });
    while (!h.observedSignal) await new Promise(resolve => setImmediate(resolve));
    if (mode === 'chat') h.changeChat();
    if (mode === 'disabled') enabled = false;
    h.composition.invalidate();
    assert.equal(h.observedSignal.aborted, true);
    assert.equal((await pending).status, mode === 'disabled' ? 'disabled' : 'stale');
    assert.notEqual(h.composition.getState().status, 'saved');
  }
});
