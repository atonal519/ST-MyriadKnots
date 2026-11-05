import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemoryTagList, readMemoryTagBlocks, sanitizeMemoryContent, stripMemoryTagBlocks } from '../src/memory-content-sanitizer.js';
import { scanAssistantCandidates, sanitizerFingerprint } from '../src/v3/foundation-domain.js';

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

test('仅时间标签读取把 br 当 void，旧正文清洗保留原配对语义', () => {
  assert.equal(sanitizeMemoryContent('甲<br>乙</br>丙'), '甲丙');
  assert.equal(sanitizeMemoryContent('<meta>说明</meta>'), '');
  const source = '<StatusBar>当前状态：2026年5月10日<br><content>后文</content></StatusBar>';
  assert.equal(stripMemoryTagBlocks(source, 'content'), '<StatusBar>当前状态：2026年5月10日<br> </StatusBar>');
  assert.deepEqual(readMemoryTagBlocks(source).map(block => [block.name, block.ancestors]), [['statusbar', []], ['content', ['statusbar']]]);
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
  assert.notEqual(previous[0].canonicalFingerprint, next[0].canonicalFingerprint);
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

test('HTML正文仅完整文档、html围栏或明确keep内保排版文字及段落分隔', () => {
 const body = '<p>她递出<strong>钥匙</strong>。</p><div>他点头。<br>两人离开。</div>';
 const expected = '她递出钥匙。\n\n他点头。\n两人离开。';
 for (const [raw, options] of [
  ['<!doctype html><html><head><title>页面标题</title></head><body>'+body+'</body></html>', {}],
  ['```html\n'+body+'\n```', {}],
  ['<ZM>'+body+'</ZM>', { keepTags: 'ZM' }],
 ]) assert.equal(sanitizeMemoryContent(raw, options), expected);
 assert.equal(sanitizeMemoryContent('<p>旧未知XML</p>'), '');
 assert.equal(sanitizeMemoryContent('<content><p>不应救回</p></content>', { keepTags: '' }), '');
});

test('HTML正文不救回噪声或显式剔除，raw-text脚本伪正文和样式始终不混入', () => {
 const raw = '<!doctype html><html><body><p>故事。</p><think><p>思考</p><content><p>明确正文</p></content></think><details><summary>标题</summary><p>状态</p></details><unknown><p>未知块</p></unknown><script>const x="<content>伪正文</content></body>";</script><style>.x:after{content:"<content>伪样式</content>"}</style><div>尾声。</div></body></html>';
 const text = sanitizeMemoryContent(raw);
 assert.match(text, /故事。/u);assert.match(text, /明确正文/u);assert.match(text, /尾声。/u);
 assert.doesNotMatch(text, /思考|标题|状态|未知块|伪正文|伪样式|const|content:/u);
 assert.equal(sanitizeMemoryContent('<content><p>删除段落</p><div>留下</div></content>', { extraTags: 'p' }), '留下');
 assert.equal(sanitizeMemoryContent('前[[<content><p>不救回</p></content>]]后', { extraTags: '[[...]]' }), '前后');
 assert.equal(sanitizeMemoryContent('<content><p>保留优先</p></content>', { keepTags: 'content,p', extraTags: 'p' }), '保留优先');
 assert.equal(sanitizeMemoryContent('甲<br>乙</br>丙'), '甲丙');
});

test('HTML正文纯doctype围栏和空排版壳清空，新壳不进入候选', async () => {
 for (const raw of ['<!doctype html>', '```html\n\u00a0\u00a0\u00a0\u00a0<!doctype html>\n```', '```\u00a0\u00a0<!doctype html>\u00a0\u00a0```', '```  <!doctype html>  ```', '<!doctype html><html><head><style>body{color:red}</style></head><body><div></div></body></html>']) {
  assert.equal(sanitizeMemoryContent(raw), '');
  assert.equal((await scanAssistantCandidates([{ is_user: false, is_system: false, mes: raw }])).length, 0);
 }
 assert.equal(sanitizeMemoryContent('记录文字 <!doctype html> 和代码 `x=1`。'), '记录文字 <!doctype html> 和代码 `x=1`。');
 assert.equal(sanitizeMemoryContent('```  代码x=1与剧情事实  ```'), '```  代码x=1与剧情事实  ```');
});

test('HTML正文属性内单双引号大于号不截标签，不混入属性代码', () => {
 assert.equal(sanitizeMemoryContent('<content><p title="a > b">正文</p></content>'), '正文');
 assert.equal(sanitizeMemoryContent("<!doctype html><html><body><p onclick='if (a > b) alert(1)'>正文</p></body></html>"), '正文');
});
