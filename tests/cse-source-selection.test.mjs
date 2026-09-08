import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/identity.js';
import { captureCseAuthorNote, captureCseRequestSources, CSE_SECONDARY_LOGIC, cseWorldInfoKeyMatches, selectCseWorldInfoEntries } from '../src/cse-source-selection.js';
import { scanWorldInfo } from '../src/world-info-scanner.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const assistant = mes => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0 });
const user = mes => ({ is_user: true, is_system: false, mes });
const entry = (uid, patch = {}) => ({ uid: String(uid), source: '测试书', scope: 'global', content: `内容-${uid}`, hostEnabled: true, disabled: false, constant: false, primaryKeys: ['主键'], secondaryKeys: [], selective: false, selectiveLogic: 0, caseSensitive: null, matchWholeWords: null, ...patch });

test('蓝灯、禁用项与四种 secondary 数值枚举按宿主语义筛选', () => {
  assert.deepEqual(CSE_SECONDARY_LOGIC, { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 });
  const entries = [
    entry('constant', { constant: true, primaryKeys: [] }),
    entry('disabled', { constant: true, disabled: true, hostEnabled: false }),
    entry('primary'),
    entry('and-any', { selective: true, secondaryKeys: ['命中', '缺失'], selectiveLogic: 0 }),
    entry('not-all-yes', { selective: true, secondaryKeys: ['命中', '缺失'], selectiveLogic: 1 }),
    entry('not-all-no', { selective: true, secondaryKeys: ['命中', '另一个'], selectiveLogic: 1 }),
    entry('not-any-yes', { selective: true, secondaryKeys: ['甲', '乙'], selectiveLogic: 2 }),
    entry('not-any-no', { selective: true, secondaryKeys: ['命中'], selectiveLogic: 2 }),
    entry('and-all-yes', { selective: true, secondaryKeys: ['命中', '另一个'], selectiveLogic: 3 }),
    entry('and-all-no', { selective: true, secondaryKeys: ['命中', '缺失'], selectiveLogic: 3 }),
  ];
  const selected = selectCseWorldInfoEntries({ entries, scanText: '主键 命中 另一个' }).filter(item => item.decision.selected).map(item => item.entry.uid);
  assert.deepEqual(selected, ['constant', 'primary', 'and-any', 'not-all-yes', 'not-any-yes', 'and-all-yes']);
});

test('关键词匹配支持正则、安全 user/char 宏、大小写与宿主同义 whole-word 中文边界', () => {
  assert.equal(cseWorldInfoKeyMatches('Alpha 左佐 辛夷', '/alpha/iu'), true);
  assert.equal(cseWorldInfoKeyMatches('Alpha', 'alpha', { caseSensitive: true }), false);
  assert.equal(cseWorldInfoKeyMatches('Alpha', 'alpha', { caseSensitive: false }), true);
  assert.equal(cseWorldInfoKeyMatches('左佐看向辛夷', '{{char}}看向{{user}}', { macros: { char: '左佐', user: '辛夷' } }), true);
  assert.equal(cseWorldInfoKeyMatches('保留{{unknown}}', '{{unknown}}'), true, '未知宏必须保留字面，不编造替换值');
  assert.equal(cseWorldInfoKeyMatches('concatenate', 'cat', { matchWholeWords: true }), false);
  assert.equal(cseWorldInfoKeyMatches('小猫咪', '猫', { matchWholeWords: true }), true, '应保持宿主基于 JS \\W 的中文边界语义');
});

function scannerContexts() {
  const books = new Map([
    ['角色主书', { entries: { 1: { uid: 1, key: ['主'], content: '主书' } } }],
    ['角色附加', { entries: { 2: { uid: 2, key: ['附'], content: '附加' } } }],
    ['聊天书', { entries: { 3: { uid: 3, key: ['聊'], content: '聊天' } } }],
    ['人格书', { entries: { 4: { uid: 4, key: ['人'], content: '人格' } } }],
    ['全局书', { entries: { 5: { uid: 5, key: ['全'], content: '全局' } } }],
  ]);
  const base = {
    characterId: 0,
    characters: [{ avatar: 'char.png', data: { extensions: { world: '角色主书' }, character_book: { name: '内置书', entries: [
      { id: 6, keys: ['内'], secondary_keys: ['置'], selective: true, enabled: true, content: '内置', extensions: { selectiveLogic: 3, case_sensitive: true, match_whole_words: true } },
      { id: 7, keys: ['禁'], enabled: false, content: '内置禁用' },
    ] } } }],
    powerUserSettings: { persona_description_lorebook: '人格书' },
    chatMetadata: { world_info: '聊天书' },
  };
  const official = {
    ...structuredClone(base),
    async loadWorldInfo(name) { return books.get(name) ?? null; },
  };
  const officialBindings = {
    getSelectedWorldInfo: () => ['全局书'],
    getWorldInfoSettings: () => ({ charLore: [{ name: 'char', extraBooks: ['角色附加'] }] }),
    getDefaultCaseSensitive: () => false,
    getDefaultMatchWholeWords: () => false,
  };
  const luker = {
    ...structuredClone(base),
    chatWorldInfo: { getNames: () => ['聊天书'], globalSelection: ['全局书'] },
    getCharaFilename: () => 'char',
    getCharaAuxWorlds: () => ['角色附加'],
    async loadWorldInfoBatch(names) { return new Map(names.map(name => [name, books.get(name)])); },
  };
  return { official, officialBindings, luker };
}

test('原生单本读取与 Luker 批量读取产生等价 metadata，并含全局、角色附加和内置书', async () => {
  const { official, officialBindings, luker } = scannerContexts();
  const native = await scanWorldInfo(official, { bindings: officialBindings, strict: true, includeCatalog: false });
  const fork = await scanWorldInfo(luker, { strict: true, includeCatalog: false });
  const project = catalog => catalog.entries.map(item => ({ source: item.source, uid: item.uid, scope: item.scope, content: item.content, hostEnabled: item.hostEnabled, primaryKeys: item.primaryKeys, secondaryKeys: item.secondaryKeys, selective: item.selective, selectiveLogic: item.selectiveLogic, caseSensitive: item.caseSensitive, matchWholeWords: item.matchWholeWords }));
  assert.deepEqual(project(native), project(fork));
  assert.deepEqual(native.entries.map(item => item.source), ['角色主书', '角色附加', '聊天书', '人格书', '全局书', '内置书', '内置书']);
  assert.deepEqual(native.entries.filter(item => item.source === '内置书').map(item => [item.uid, item.hostEnabled, item.selectiveLogic]), [['6', true, 3], ['7', false, 0]]);
});

test('严格关联书读取失败明确报错，且不会调用 simulate 或加载无关全库', async () => {
  let simulated = 0, loaded = [];
  const ctx = {
    characterId: 0, characters: [{ data: { extensions: { world: '缺失书' } } }],
    async loadWorldInfo(name) { loaded.push(name); return null; },
    async simulateWorldInfoActivation() { simulated += 1; return []; },
    getWorldInfoNames: () => ['缺失书', '无关全库'],
  };
  await assert.rejects(scanWorldInfo(ctx, { strict: true, includeCatalog: false }), error => error.code === 'V3_CSE_SOURCE_READ_FAILED');
  assert.deepEqual(loaded, ['缺失书']);
  assert.equal(simulated, 0);
});

test('作者注释区分缺失与明确空值，角色禁用及 replace/before/after 合并均忽略 interval', () => {
  const base = {
    characterId: 0, characters: [{ avatar: 'char.png', name: '左佐' }], getCharaFilename: () => 'char', chatMetadata: {},
    extensionSettings: { note: { default: '默认注释', defaultInterval: 9, chara: [{ name: 'char', prompt: '角色注释', useChara: true, position: 0 }] } },
  };
  assert.equal(captureCseAuthorNote(base).content, '角色注释');
  base.extensionSettings.note.chara[0].position = 1;
  assert.equal(captureCseAuthorNote(base).content, '角色注释\n默认注释');
  base.extensionSettings.note.chara[0].position = 2;
  assert.equal(captureCseAuthorNote(base).content, '默认注释\n角色注释');
  base.extensionSettings.note.chara[0].useChara = false;
  assert.equal(captureCseAuthorNote(base).content, '默认注释');
  base.chatMetadata.note_prompt = '';
  assert.equal(captureCseAuthorNote(base).content, '', '明确空字符串不得 truthy 回退默认注释');
  assert.equal(captureCseAuthorNote(base).intervalIgnored, true);
});

async function sourceHarness({ onLoad } = {}) {
  const chat = [user('旧用户谈到旧钥匙'), assistant('旧 AI 回应'), user('目标用户让左佐开门'), assistant('目标 AI 提到钥匙'), user('未来用户提到禁词'), assistant('未来 AI 提到未来词')];
  const floor = { hostLocator: { messageIndex: 3 }, content: { rawFingerprint: `sha256:${await sha256(chat[3].mes)}` } };
  const context = {
    characterId: 0, characters: [{ avatar: 'char.png', name: '左佐', data: { description: '最新描述', personality: '最新性格', scenario: '最新场景', extensions: { world: '当前书' } } }],
    name1: '辛夷', name2: '左佐', powerUserSettings: { persona_description: '最新用户人设' },
    chatMetadata: { qianqianjie: { chatId: CHAT }, note_prompt: '持续作者参考' }, extensionSettings: { note: { default: '默认不该覆盖' } }, chat,
    async loadWorldInfo(name) {
      await onLoad?.({ context, chat, floor, name });
      return { entries: {
        1: { uid: 1, constant: true, content: '<背景>蓝灯 {{char}}</背景>' },
        2: { uid: 2, key: ['钥匙'], content: '绿灯 {{user}}' },
        3: { uid: 3, key: ['未来词'], content: '未来不得倒灌' },
        4: { uid: 4, constant: true, disable: true, content: '禁用不得进入' },
      } };
    },
  };
  const hostAdapter = { snapshot: () => ({ context, chat: context.chat }), getWorldInfoBindings: () => ({}) };
  const baseline = {
    userPersona: { entityId: 'user-id', name: '辛夷', description: '旧用户人设', aliases: ['辛夷'] },
    characterCard: { entityId: 'char-id', name: '左佐', description: '旧描述', personality: '旧性格', scenario: '旧场景' },
  };
  return { context, chat, floor, hostAdapter, baseline };
}

test('请求来源使用最新人设/角色/note和目标最近两轮，排除未来、禁用、旧 CSE 与共享整本排除', async () => {
  const h = await sourceHarness();
  h.chat[0].is_system = true; h.chat[0].extra = { type: 'narrator' };
  h.chat[2].is_system = true; h.chat[2].extra = { qianqianjieAutoHide: true };
  h.chat[1].mes = '<qqj-cse>旧 CSE 不可自激活</qqj-cse>旧 AI 回应'; h.chat[1].swipes = [h.chat[1].mes];
  const result = await captureCseRequestSources({
    hostAdapter: h.hostAdapter, baseline: h.baseline, floor: h.floor, expectedChatId: CHAT,
    filterWorldInfoSources: sources => sources, sanitizerOptions: {},
  });
  assert.equal(result.userPersona.description, '最新用户人设');
  assert.deepEqual([result.characterCard.description, result.characterCard.personality, result.characterCard.scenario], ['最新描述', '最新性格', '最新场景']);
  assert.equal(result.authorNote.content, '持续作者参考');
  assert.deepEqual(result.worldInfoSources.map(source => [source.locator, source.content, source.triggerReason]), [
    ['当前书:1', '<背景>蓝灯 左佐</背景>', 'constant'], ['当前书:2', '绿灯 辛夷', 'primary'],
  ]);
  assert.doesNotMatch(result.targetWindow.scanText, /未来|旧 CSE/);
  assert.doesNotMatch(result.targetWindow.scanText, /旧用户谈到旧钥匙/, '带宿主 extra.type 的真实系统 user 消息必须排除');
  assert.match(result.targetWindow.scanText, /目标用户让左佐开门/, '自动隐藏但仍是 user 的正常楼必须进入扫描窗');
  assert.equal(h.baseline.userPersona.description, '旧用户人设');
  assert.equal(result.diagnostics.selectedEntries, 2);
  assert.equal(JSON.stringify(result.diagnostics).includes('蓝灯 左佐'), false, '内部诊断不得复制正文');

  const excluded = await captureCseRequestSources({
    hostAdapter: h.hostAdapter, baseline: h.baseline, floor: h.floor, expectedChatId: CHAT,
    filterWorldInfoSources: sources => sources.filter(source => source.sourceName !== '当前书'), sanitizerOptions: {},
  });
  assert.deepEqual(excluded.worldInfoSources, [], '共享整本排除必须在发送前作用于最终选择条目');
  assert.equal(excluded.diagnostics.excludedSelectedEntries, 2);
});

test('来源异步读取期间切聊天或改目标窗口会 stale，修改目标后的无关尾楼不会作废冻结请求', async () => {
  const switched = await sourceHarness({ onLoad: ({ context }) => { context.chatMetadata.qianqianjie.chatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; } });
  await assert.rejects(captureCseRequestSources({ hostAdapter: switched.hostAdapter, baseline: switched.baseline, floor: switched.floor, expectedChatId: CHAT }), error => error.code === 'V3_CSE_STALE');

  const changedTarget = await sourceHarness({ onLoad: ({ chat }) => { chat[3].mes = '目标正文被改'; chat[3].swipes = ['目标正文被改']; } });
  await assert.rejects(captureCseRequestSources({ hostAdapter: changedTarget.hostAdapter, baseline: changedTarget.baseline, floor: changedTarget.floor, expectedChatId: CHAT }), error => error.code === 'V3_CSE_STALE');

  const changedTail = await sourceHarness({ onLoad: ({ chat }) => { chat[5].mes = '无关尾楼被改'; chat[5].swipes = ['无关尾楼被改']; } });
  const frozen = await captureCseRequestSources({ hostAdapter: changedTail.hostAdapter, baseline: changedTail.baseline, floor: changedTail.floor, expectedChatId: CHAT });
  assert.equal(frozen.worldInfoSources.length, 2);
});
