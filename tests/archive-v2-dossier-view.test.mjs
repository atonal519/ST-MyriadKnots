import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ARCHIVE_V2_DOSSIER_FIELD_KEYS } from '../src/archive-v2-dossier-composition.js';
import { createArchiveV2DossierView } from '../src/ui/archive-v2-dossier-view.js';

function matches(node, selector) {
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.value = '';
    this.type = '';
    this.disabled = false;
    this._text = '';
  }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
  fire(type) { for (const handler of this.listeners.get(type) ?? []) handler({ target: this, currentTarget: this, preventDefault() {} }); }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => { for (const child of node.children) { if (matches(child, selector)) result.push(child); visit(child); } };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class FakeDocument { createElement(tag) { return new FakeElement(tag); } }
const settle = async () => { await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
const owned = (value, kind = 'chat') => ({
  value, origin: 'ai', userProtected: false,
  sourceRefs: [{ kind, locator: 'SECRET_LOCATOR', fingerprint: `sha256:${'a'.repeat(64)}` }],
});

function archiveFixture({ followedCount = 1, omitFollowedIndex = null, withProfileFields = true } = {}) {
  const byId = {};
  const order = [];
  for (let index = 0; index < 10; index += 1) {
    const identityId = `person-${index + 1}`;
    order.push(identityId);
    byId[identityId] = {
      identityId,
      displayName: owned(index === 0 ? '林少白' : `静默人物${index + 1}`, index === 0 ? 'card' : 'chat'),
      fields: index === 0 && withProfileFields ? Object.fromEntries(ARCHIVE_V2_DOSSIER_FIELD_KEYS.map((key, fieldIndex) => [
        key,
        owned(fieldIndex === 3 ? '' : `字段-${key}`, fieldIndex % 3 === 0 ? 'worldbook' : 'chat'),
      ])) : {},
      aliases: owned([]),
      sourceRefs: [],
    };
    if (index !== omitFollowedIndex) byId[identityId].followed = index < followedCount;
  }
  return { people: { order, byId }, events: [], bonds: {}, nextSteps: { items: [] } };
}

function harness({ followedCount = 1, omitFollowedIndex = null, withProfileFields = true, actionStatus = 'saved' } = {}) {
  const documentRef = new FakeDocument();
  const container = documentRef.createElement('div');
  let archive = archiveFixture({ followedCount, omitFollowedIndex, withProfileFields });
  let revision = 2;
  let followedProfileResult = { status: 'ready', followedCount: 1, enrichedCount: withProfileFields ? 1 : 0 };
  const calls = { update: [], rename: [], followed: [], generate: 0, commit: 0 };
  const saved = (identityId, mutate) => {
    archive = structuredClone(archive);
    mutate(archive.people.byId[identityId]);
    revision += 1;
    return { status: 'saved', archive, revision, warnings: [], changed: true, identityId };
  };
  const actions = {
    async updatePerson(options) {
      calls.update.push(structuredClone(options));
      if (actionStatus !== 'saved') return { status: actionStatus };
      return saved(options.identityId, person => {
        person.displayName = { value: options.displayName, origin: 'user', userProtected: true, sourceRefs: [] };
        for (const [key, value] of Object.entries(options.fields)) {
          person.fields[key] = { value, origin: 'user', userProtected: true, sourceRefs: [] };
        }
      });
    },
    async renamePerson(options) {
      calls.rename.push(structuredClone(options));
      if (actionStatus !== 'saved') return { status: actionStatus };
      return saved(options.identityId, person => { person.displayName = { value: options.displayName, origin: 'user', userProtected: true, sourceRefs: [] }; });
    },
    async setFollowed(options) {
      calls.followed.push(structuredClone(options));
      if (actionStatus !== 'saved') return { status: actionStatus };
      return saved(options.identityId, person => { person.followed = options.followed; });
    },
  };
  const view = createArchiveV2DossierView({ actions, documentRef });
  const render = () => container.replaceChildren(view.render({
    readResult: { status: 'ready', archive, revision, warnings: [] },
    followedProfileResult,
    requestRender: render,
    onArchiveChange(result) { archive = result.archive; revision = result.revision; },
    generateFollowedProfiles() { calls.generate += 1; },
    commitFollowedProfiles() { calls.commit += 1; },
  }));
  render();
  return {
    container,
    view,
    calls,
    render,
    get archive() { return archive; },
    setFollowedProfileResult(value) { followedProfileResult = value; render(); },
    setPersonFields(identityId, fields) {
      archive = structuredClone(archive);
      archive.people.byId[identityId].fields = fields;
      revision += 1;
      render();
    },
  };
}

const findButton = (root, label) => root.querySelectorAll('button').find(item => item.textContent === label) ?? null;

test('ready 使用 V2 rail/dossier/basic-info 并展示 11 字段与安全来源标签', () => {
  const h = harness();
  assert.ok(h.container.querySelector('.profile-rail-shell'));
  assert.ok(h.container.querySelector('.dossier-card'));
  assert.ok(h.container.querySelector('.profile-summary'));
  assert.ok(h.container.querySelector('.basic-info'));
  assert.match(h.container.textContent, /林少白/);
  for (const label of ['性别', '年龄', '外貌', '性格', '身份', '能力', '喜欢', '讨厌', '原则', '关系', '亲密偏好']) assert.match(h.container.textContent, new RegExp(label));
  assert.match(h.container.textContent, /未提及/);
  assert.match(h.container.textContent, /角色卡|世界书|历史记忆/);
  assert.doesNotMatch(h.container.textContent, /SECRET_LOCATOR|sha256:/);
  assert.match(h.container.textContent, /动态状态尚未接入/);
  assert.equal(h.container.querySelector('.generation-banner'), null);
  assert.doesNotMatch(h.container.textContent, /重新生成基础人设/);
});

test('编辑姓名与多字段只调用一次原子 update action', async () => {
  const h = harness();
  findButton(h.container, '编辑').fire('click');
  const inputs = h.container.querySelectorAll('input');
  const textareas = h.container.querySelectorAll('textarea');
  const name = inputs.find(input => input.dataset.field === 'displayName');
  const gender = inputs.find(input => input.dataset.field === 'gender');
  const personality = textareas.find(input => input.dataset.field === 'personality');
  const appearance = textareas.find(input => input.dataset.field === 'appearance');
  name.value = '林少白·改'; name.fire('input');
  gender.value = '男性·改'; gender.fire('input');
  personality.value = '更沉稳'; personality.fire('input');
  appearance.value = ''; appearance.fire('input');
  findButton(h.container, '保存修改').fire('click');
  await settle();
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.calls.update[0].displayName, '林少白·改');
  assert.equal(h.calls.update[0].fields.gender, '男性·改');
  assert.equal(h.calls.update[0].fields.personality, '更沉稳');
  assert.equal(h.calls.update[0].fields.appearance, '');
  assert.deepEqual(Object.keys(h.calls.update[0].fields).sort(), ['appearance', 'gender', 'personality']);
  assert.match(h.container.textContent, /基础信息已保存/);
});

test('因缘簿显示 1 关注 + 9 静默，关注切换与改名都走 actions', async () => {
  const h = harness();
  findButton(h.container, '因缘簿').fire('click');
  assert.ok(h.container.querySelector('.fate-book-view'));
  assert.match(h.container.textContent, /当前关注 1 人 · 静默 9 人/);
  assert.match(h.container.textContent, /不代表恋爱关系已经成立/);
  assert.equal(h.container.querySelectorAll('.person-card').length, 10);
  findButton(h.container, '设为关注').fire('click');
  await settle();
  assert.deepEqual(h.calls.followed[0], { identityId: 'person-2', followed: true });
  const fateInputs = h.container.querySelectorAll('input');
  fateInputs[1].value = '静默人物2·改'; fateInputs[1].fire('input');
  h.container.querySelectorAll('button').filter(item => item.textContent === '保存名称')[1].fire('click');
  await settle();
  assert.deepEqual(h.calls.rename[0], { identityId: 'person-2', displayName: '静默人物2·改' });
});

test('followed 缺省人物严格视为静默，不进入 rail 或关注计数', async () => {
  const h = harness({ followedCount: 2, omitFollowedIndex: 1 });
  const railNames = h.container.querySelectorAll('.profile-tab-name').map(node => node.textContent);
  assert.deepEqual(railNames, ['林少白']);
  findButton(h.container, '因缘簿').fire('click');
  assert.match(h.container.textContent, /当前关注 1 人 · 静默 9 人/);
  const missingFollowedCard = h.container.querySelectorAll('.person-card')[1];
  assert.match(missingFollowedCard.textContent, /静默人物/);
  assert.doesNotMatch(missingFollowedCard.textContent, /转为静默/);
  findButton(missingFollowedCard, '设为关注').fire('click');
  await settle();
  assert.deepEqual(h.calls.followed[0], { identityId: 'person-2', followed: true });
});

test('基础人设仍先生成草稿再确认保存，超出轨道的人物使用更多页', () => {
  const h = harness({ withProfileFields: false });
  h.setFollowedProfileResult({ status: 'idle', followedCount: 1, enrichedCount: 0 });
  assert.ok(h.container.querySelector('.generation-banner'));
  findButton(h.container, '生成基础人设').fire('click');
  assert.equal(h.calls.generate, 1);
  h.setFollowedProfileResult({ status: 'draft', followedCount: 1, draft: { people: [{ displayName: '林少白', fields: { identity: { value: '调查员' } } }] } });
  assert.match(h.container.textContent, /以下只是内存草稿/);
  findButton(h.container, '保存基础人设').fire('click');
  assert.equal(h.calls.commit, 1);

  const many = harness({ followedCount: 6 });
  findButton(many.container, '更多').fire('click');
  assert.ok(many.container.querySelector('.more-view'));
  assert.equal(many.container.querySelectorAll('.more-person').length, 2);
});

test('生成进行中、草稿和错误保留区块，保存并写入字段后隐藏', () => {
  const h = harness({ withProfileFields: false });
  h.setPersonFields('person-1', { gender: owned('', 'card') });
  h.setFollowedProfileResult({ status: 'ready', followedCount: 1, enrichedCount: 1 });
  assert.ok(h.container.querySelector('.generation-banner'));
  assert.ok(findButton(h.container, '生成基础人设'));
  assert.doesNotMatch(h.container.textContent, /重新生成基础人设/);

  h.setFollowedProfileResult({ status: 'saved', followedCount: 1, enrichedCount: 1, savedFieldCount: 0, protectedFieldCount: 0 });
  assert.ok(h.container.querySelector('.generation-banner'));
  assert.ok(findButton(h.container, '生成基础人设'));
  assert.doesNotMatch(h.container.textContent, /重新生成基础人设/);

  h.setFollowedProfileResult({ status: 'running', followedCount: 1 });
  assert.ok(h.container.querySelector('.generation-banner'));
  assert.match(h.container.textContent, /正在生成基础人设/);

  h.setFollowedProfileResult({ status: 'draft', followedCount: 1, draft: { people: [{ displayName: '林少白', fields: { gender: { value: '男性' } } }] } });
  assert.ok(h.container.querySelector('.generation-banner'));
  assert.ok(findButton(h.container, '保存基础人设'));

  h.setFollowedProfileResult({ status: 'error', followedCount: 1 });
  assert.ok(h.container.querySelector('.generation-banner'));
  assert.ok(findButton(h.container, '重新生成基础人设'));

  h.setPersonFields('person-1', { gender: owned('男性', 'card') });
  h.setFollowedProfileResult({ status: 'saved', followedCount: 1, savedFieldCount: 1, protectedFieldCount: 0 });
  assert.equal(h.container.querySelector('.generation-banner'), null);
  assert.doesNotMatch(h.container.textContent, /重新生成基础人设/);
});

test('CAS 冲突、切聊天或禁用时不误报保存成功', async () => {
  for (const [status, copy] of [
    ['conflict', '档案已在其他操作中变化，本次没有覆盖。'],
    ['stale', '当前聊天已经变化，迟到结果不会保存。'],
    ['disabled', '千千结当前未启用，本次没有保存。'],
  ]) {
    const h = harness({ actionStatus: status });
    findButton(h.container, '编辑').fire('click');
    const gender = h.container.querySelectorAll('input').find(input => input.dataset.field === 'gender');
    gender.value = `${status}-value`;
    gender.fire('input');
    findButton(h.container, '保存修改').fire('click');
    await settle();
    assert.equal(h.calls.update.length, 1);
    assert.match(h.container.textContent, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(h.container.textContent, /基础信息已保存/);
  }
});

test('V2 档案视图保留人物轨道、因缘簿与窄屏单列布局', async () => {
  const css = await readFile(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.profile-rail-shell/);
  assert.match(css, /\.dossier-card/);
  assert.match(css, /\.people-content/);
  assert.match(css, /@media\(max-width:390px\)[^{]*\{[\s\S]*?\.basic-row-three\{grid-template-columns:1fr/);
});
