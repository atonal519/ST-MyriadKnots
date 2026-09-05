import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemoryTagList, sanitizeMemoryContent } from '../src/memory-content-sanitizer.js';
import { findEarliestCanonicalDivergence, scanAssistantCandidates, sanitizerFingerprint } from '../src/v3/foundation-domain.js';

test('默认 content 去标签保留正文，并二次删除内部嵌套噪声', () => {
  const source = '<content class="story">开场<think>秘密<status>更深噪声</status></think>\n正文<reasoning>推理</reasoning></content>';
  assert.equal(sanitizeMemoryContent(source), '开场\n正文');
  assert.equal(source, '<content class="story">开场<think>秘密<status>更深噪声</status></think>\n正文<reasoning>推理</reasoning></content>');
});

test('成对 think/reasoning/status/snow/details 块连同内容删除，普通方括号保留', () => {
  const source = [
    '故事[保留这段]',
    '<think>思考</think><reasoning>推理</reasoning>',
    '<status>状态栏</status><snow>雪花组件</snow>',
    '<details><summary>标题</summary>详情</details>',
    '结尾',
  ].join('\n');
  assert.equal(sanitizeMemoryContent(source), '故事[保留这段]\n\n结尾');
});

test('注释、孤立与自闭合标签删除，空行收紧并 trim', () => {
  const source = '  <!-- SECRET -->\n正文<br/>\n\n\n<orphan attr="x">\n尾声</dangling>  ';
  assert.equal(sanitizeMemoryContent(source), '正文\n\n尾声');
});

test('标签列表规范化与 keep/extra 行为沿用构画合同', () => {
  assert.deepEqual(normalizeMemoryTagList(' Content, THINK,坏 标签,tag_2,foo~~,bar~, [[...]] '), ['content', 'think', 'tag_2', 'bar~', '[[...]]']);
  assert.equal(sanitizeMemoryContent('<story>保留故事<think>删除</think></story>', { keepTags: 'story', extraTags: 'think' }), '保留故事');
});

test('字面开始符...结束符只删除完整配对区间，并可与标签名混合', () => {
  const options = { keepTags: 'content', extraTags: 'think，reasoning\n[[...]]' };
  assert.equal(sanitizeMemoryContent('[[思维链]]\n正文', options), '正文');
  assert.equal(sanitizeMemoryContent('前[[第一段]]中[[第二段]]后', options), '前中后');
  assert.equal(sanitizeMemoryContent('<think>推理</think>[[思考]]<reasoning>分析</reasoning>故事', options), '故事');
  assert.equal(sanitizeMemoryContent('正文[[未闭合', options), '正文[[未闭合');
  assert.equal(sanitizeMemoryContent('[[未配置]]正文'), '[[未配置]]正文');
  assert.equal(sanitizeMemoryContent('正文[单个左括号]与单个右括号]', options), '正文[单个左括号]与单个右括号]');
});

test('真实形态短样本移除思考且保留正文，不改变既有 content 语义', () => {
  const source = '[[思考]]\n<meta>说明</meta>\n@@[正文]@@\n<content>故事</content>';
  const result = sanitizeMemoryContent(source, { keepTags: 'content', extraTags: '[[...]]' });
  assert.doesNotMatch(result, /思考|说明/u);
  assert.match(result, /@@\[正文\]@@/u);
  assert.match(result, /故事/u);
});

test('extraTags 字面规则改变 sanitizer 指纹并使旧楼识别为 canonical 分歧', async () => {
  const previousOptions = { keepTags: 'content', extraTags: '' };
  const nextOptions = { keepTags: 'content', extraTags: '[[...]]' };
  assert.notEqual(await sanitizerFingerprint(previousOptions), await sanitizerFingerprint(nextOptions));
  const chat = [{ is_user: false, is_system: false, mes: '[[思考]]正文' }, { is_user: false, is_system: false, mes: '确认楼' }];
  const previous = await scanAssistantCandidates(chat, { sanitizerOptions: previousOptions });
  const next = await scanAssistantCandidates(chat, { sanitizerOptions: nextOptions });
  assert.equal(previous[0].canonicalContent, '[[思考]]正文');
  assert.equal(next[0].canonicalContent, '正文');
  assert.equal(findEarliestCanonicalDivergence(previous.map(item => ({ content: { canonicalFingerprint: item.canonicalFingerprint } })), next), 1);
});

test('保留标签占位符不会与正文中的 KEEP 字样碰撞', () => {
  assert.equal(sanitizeMemoryContent('原文 KEEP0 <content>正文</content> KEEP1'), '原文 KEEP0 正文 KEEP1');
});

test('同名嵌套剔除使用成对边界，不泄漏内层尾部', () => {
  assert.equal(sanitizeMemoryContent('before<think>A<think>B</think>C</think>after', { extraTags: 'think' }), 'beforeafter');
});

test('同名嵌套 keep 只剥外壳并保留全部正文，孤儿标签只剥标签', () => {
  assert.equal(sanitizeMemoryContent('before<content>A<content>B</content>C</content>after'), 'beforeABCafter');
  assert.equal(sanitizeMemoryContent('<content>A<content>B</content>C</content>', { keepTags: 'content', extraTags: 'content' }), 'ABC');
  assert.equal(sanitizeMemoryContent('before<think>孤儿尾部', { extraTags: 'think' }), 'before孤儿尾部');
  assert.equal(sanitizeMemoryContent('before</think>孤儿开头after', { extraTags: 'think' }), 'before孤儿开头after');
});

test('空 keep 设置不保留 content，空 extra 不改变默认剔除语义', () => {
  assert.equal(sanitizeMemoryContent('before<content>正文</content>after', { keepTags: '', extraTags: '' }), 'beforeafter');
});
