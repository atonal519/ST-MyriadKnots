import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemoryTagList, sanitizeMemoryContent } from '../src/memory-content-sanitizer.js';

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
  assert.deepEqual(normalizeMemoryTagList(' Content, THINK,坏 标签,tag_2,foo~~,bar~ '), ['content', 'think', 'tag_2', 'bar~']);
  assert.equal(sanitizeMemoryContent('<story>保留故事<think>删除</think></story>', { keepTags: 'story', extraTags: 'think' }), '保留故事');
});
