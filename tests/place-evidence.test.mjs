import test from 'node:test';
import assert from 'node:assert/strict';
import { locatePlaceQuote, collectMissingPlaceSources } from '../src/v3/place-evidence.js';
import * as placeEvidence from '../src/v3/place-evidence.js';

test('194地点引用保原有省略号及空白匹配，恢复只保唯一正序短片段', () => {
  const content = '甲楼有客房。' + '中间剧情。'.repeat(500) + '客房里有书桌。';
  assert.deepEqual(locatePlaceQuote(content, '甲楼有客房。……客房里有书桌。', { allowOmission: true }).map(item => item.quote), ['甲楼有客房。', '客房里有书桌。']);
  for (const quote of ['甲楼……客房', '甲楼...客房']) assert.deepEqual(locatePlaceQuote(quote, quote, { allowOmission: true }).map(item => item.quote), [quote]);
  assert.deepEqual(locatePlaceQuote('甲楼\n\n有客房。', '甲楼 有客房。', { allowWhitespace: true, allowOmission: true }).map(item => item.quote), ['甲楼\n\n有客房。']);
});

test('整理来源覆盖已挂父地点的原始段落并吸收同源短句，角色和楼次不互吸收', async () => {
  assert.equal(typeof placeEvidence.collectPlaceOrganizationSources,'function');
  const text='第一段铺垫。\n\n甲城北边的旅店有客房。\n\n门口亮着灯。\n\n下一段过渡。\n\n无关人物闲聊。\n\n更远的闲聊。';
  const floors=[{id:'f1',assistantSeq:1,content:{canonicalContent:text}},{id:'f2',assistantSeq:2,content:{canonicalContent:'门口亮着灯。'}}];
  const m1={id:'m1',floorId:'f1',sourceCanonicalContent:text,sourceUserInputSnapshot:{messages:[{content:'旅店这次在甲城北边。',messageIndex:0}]}};
  const m2={id:'m2',floorId:'f2',sourceCanonicalContent:floors[1].content.canonicalContent};
  const args={entities:[{id:'room',entityType:'place',firstSeenFloorId:'f1'}],entityKeys:new Map([['room','place-1']]),places:[{entityId:'room',displayName:'旅店',aliases:[],parentEntityId:'wrong-parent'}],
    bodySources:[{evidenceKey:'old-1',floorId:'f1',sourceType:'assistant',canonicalContent:'门口亮着灯。',placeKeys:['place-1']},{evidenceKey:'old-2',floorId:'f2',sourceType:'assistant',canonicalContent:'门口亮着灯。',placeKeys:['place-1']}],
    floors,memoriesByFloor:new Map([['f1',m1],['f2',m2]]),parentFacts:[]};
  const before=JSON.stringify(args.bodySources),rows=await placeEvidence.collectPlaceOrganizationSources(args);
  const assistant=rows.filter(row=>row.floorId==='f1'&&row.sourceType==='assistant');assert.equal(assistant.length,1);assert.ok(assistant[0].canonicalContent.includes('甲城北边'));assert.ok(assistant[0].canonicalContent.includes('门口亮着灯。'));
  assert.ok(text.includes(assistant[0].canonicalContent),'只返回原连续文字');assert.ok(assistant[0].canonicalContent.length<text.length);assert.equal(assistant[0].requiresExactQuote,true);
  assert.equal(rows.filter(row=>row.floorId==='f1'&&row.canonicalContent==='门口亮着灯。').length,0,'同楼短quote被原连续上下文吸收');
  assert.ok(rows.some(row=>row.floorId==='f2'&&row.canonicalContent==='门口亮着灯。'),'跨楼同文仍保');
  const user=rows.find(row=>row.sourceType==='precedingUser');assert.equal(user.sourceSnapshotIndex,0);assert.equal(user.canonicalContent,'旅店这次在甲城北边。');assert.equal(JSON.stringify(args.bodySources),before);
  const finite=await placeEvidence.collectPlaceOrganizationSources({...args,floors:[floors[1]],memoriesByFloor:new Map([['f2',m2]])});assert.equal(finite.some(row=>row.floorId==='f1'&&row.requiresExactQuote),false);
});

test('整理父边来源使用聚合成员的专属AI与USER快照，不借锚楼或当前宿主补历史',async()=>{
  assert.equal(typeof placeEvidence.collectPlaceOrganizationSources,'function');
  const floors=[{id:'f1',assistantSeq:1,content:{canonicalContent:'甲城旅店旧址。'}},{id:'f2',assistantSeq:2,content:{canonicalContent:'甲城旅店迁入新楼。'}}];
  const memory={id:'aggregate',floorId:'f2',sourceFloorIds:['f1','f2'],sourceCanonicalContent:'不作为成员使用的全文',sourceUserInputSnapshot:{messages:[{content:'不能倒灌的锚USER'}]},sourceFloorSnapshots:[{floorId:'f1',canonicalContent:floors[0].content.canonicalContent},{floorId:'f2',canonicalContent:floors[1].content.canonicalContent,sourceUserInputSnapshot:{messages:[{content:'甲城旅店搬家了。'}]}}]};
  const args={entities:[{id:'room',entityType:'place',firstSeenFloorId:'f1'}],entityKeys:new Map([['room','place-1']]),places:[{entityId:'room',displayName:'旅店',aliases:[],parentEntityId:'building'}],bodySources:[],floors,memoriesByFloor:new Map([['f1',memory],['f2',memory]]),parentFacts:[{placeEntityId:'room',evidenceRefs:[{floorId:'f2',quotedText:'甲城旅店迁入新楼。'}]}]};
  const rows=await placeEvidence.collectPlaceOrganizationSources(args);assert.ok(rows.some(row=>row.floorId==='f2'&&row.sourceType==='assistant'));assert.ok(rows.some(row=>row.floorId==='f2'&&row.sourceType==='precedingUser'));
  assert.equal(rows.some(row=>row.floorId==='f1'&&row.sourceType==='precedingUser'),false);assert.equal(rows.some(row=>row.canonicalContent.includes('不能倒灌')),false);
  const missing={...memory,sourceFloorSnapshots:memory.sourceFloorSnapshots.slice(1)};
  const result=await placeEvidence.collectPlaceOrganizationSources({...args,memoriesByFloor:new Map([['f1',missing],['f2',missing]])});assert.equal(result.some(row=>row.floorId==='f1'),false);
});

test('整理上下文只由本来源关联地点与引文定位，保相邻新上级及无命中首见全文', async () => {
  const text = '甲楼门厅。\n\n这座楼位于新增城区，二层有尚未登记的资料室。\n\n过渡一。\n\n过渡二。\n\n乙城的无关旧人物闲聊。\n\n过渡三。\n\n过渡四。\n\n甲楼内室有投影仪。';
  const unknown = '只有尚未命名的建筑及地下室描述。\n\n入口在楼后，尚无已存名称。';
  const floors = [{ id: 'f1', assistantSeq: 1, content: { canonicalContent: text } }, { id: 'f2', assistantSeq: 2, content: { canonicalContent: '乙城有旅店。' } }, { id: 'f3', assistantSeq: 3, content: { canonicalContent: unknown } }];
  const places = [{ entityId: 'a', displayName: '甲楼', aliases: [] }, { entityId: 'b', displayName: '乙城', aliases: [] }, { entityId: 'c', displayName: '甲楼内室', aliases: [] }, { entityId: 'd', displayName: '旧名', aliases: [] }];
  const args = { entities: places.map((place, index) => ({ id: place.entityId, entityType: 'place', firstSeenFloorId: index === 1 ? 'f2' : index === 3 ? 'f3' : 'f1' })),
    entityKeys: new Map(places.map((place, index) => [place.entityId, `place-${index + 1}`])), places, bodySources: [], floors,
    memoriesByFloor: new Map(floors.map(floor => [floor.id, { id: `m-${floor.id}`, floorId: floor.id, sourceCanonicalContent: floor.content.canonicalContent }])), parentFacts: [] };
  const rows = await placeEvidence.collectPlaceOrganizationSources(args);
  const first = rows.filter(row => row.floorId === 'f1');
  assert.ok(first.some(row => row.canonicalContent.includes('新增城区，二层')));
  assert.ok(first.some(row => row.canonicalContent.includes('甲楼内室有投影仪')));
  assert.ok(first.every(row => !row.canonicalContent.includes('乙城的无关旧人物闲聊')));
  for (const row of rows) assert.equal(args.memoriesByFloor.get(row.floorId).sourceCanonicalContent.slice(row.sourceOffset, row.sourceOffset + row.canonicalContent.length), row.canonicalContent);
  assert.equal(rows.find(row => row.floorId === 'f3').canonicalContent, unknown);
});

test('整理旧位置quote保原句，只有当前事实来源quote扩相邻段落', async () => {
  const oldQuote = '她站在此前的位置。', currentQuote = '投影仪固定在天花板。';
  const text = ['甲楼门厅。', '入口相邻段。', '过渡一。', '过渡二。', '旧位置外围人物闲聊。', oldQuote, '旧位置另一段人物闲聊。', '过渡三。', '过渡四。', '新上级建筑的二层设有资料室。', currentQuote, '设备旁有控制台。'].join('\n\n');
  const old = { floorId: 'f1', sourceType: 'assistant', canonicalContent: oldQuote, placeKeys: ['place-1'] };
  const current = { floorId: 'f1', sourceType: 'assistant', canonicalContent: currentQuote, placeKeys: ['place-1'] };
  const rows = await placeEvidence.collectPlaceOrganizationSources({ entities: [{ id: 'a', entityType: 'place', firstSeenFloorId: 'f1' }], entityKeys: new Map([['a', 'place-1']]),
    places: [{ entityId: 'a', displayName: '甲楼', aliases: [] }], floors: [{ id: 'f1', assistantSeq: 1, content: { canonicalContent: text } }],
    memoriesByFloor: new Map([['f1', { id: 'm1', floorId: 'f1', sourceCanonicalContent: text }]]), bodySources: [old, current], contextSources: [current] });
  assert.ok(rows.some(row => row.canonicalContent === oldQuote && row.requiresExactQuote !== true));
  assert.ok(rows.every(row => !row.canonicalContent.includes('旧位置外围人物闲聊')));
  assert.ok(rows.some(row => row.requiresExactQuote && row.canonicalContent.includes('新上级建筑的二层') && row.canonicalContent.includes(currentQuote)));
  for (const original of [old, current]) assert.ok(rows.some(row => row.sourceType === original.sourceType && row.canonicalContent.includes(original.canonicalContent)));
});

test('旧在场引文增长只增加短原句，当前事实和父链上下文不随外围剧情增长', async () => {
  const currentQuote = '设备固定在墙上。';
  const oldQuotes = Array.from({length:20}, (_, index) => `她停在旧位置${index + 1}旁。`);
  const text = ['甲楼入口。','当前父链相邻段。',currentQuote,'当前设施相邻段。','过渡一。','过渡二。',
    ...oldQuotes.flatMap((quote, index) => [`旧人物外围剧情${index + 1}。`, quote, `旧人物后续闲聊${index + 1}。`, '过渡。', '继续过渡。'])].join('\n\n');
  const source = quote => ({floorId:'f1',sourceType:'assistant',canonicalContent:quote,placeKeys:['place-1']});
  const args = {entities:[{id:'a',entityType:'place',firstSeenFloorId:'f1'}],entityKeys:new Map([['a','place-1']]),places:[{entityId:'a',displayName:'甲楼',aliases:[]}],
    floors:[{id:'f1',assistantSeq:1,content:{canonicalContent:text}}],memoriesByFloor:new Map([['f1',{id:'m1',floorId:'f1',sourceCanonicalContent:text}]]),
    parentFacts:[{placeEntityId:'a',parentEntityId:null,evidenceRefs:[{floorId:'f1'}]}],contextSources:[source(currentQuote)]};
  let baseline;
  for (const count of [0, 3, 20]) {
    const original = [source(currentQuote), ...oldQuotes.slice(0,count).map(source)];
    const rows = await placeEvidence.collectPlaceOrganizationSources({...args,bodySources:original});
    const contexts = rows.filter(row=>row.requiresExactQuote).map(row=>row.canonicalContent);
    baseline ??= contexts;
    assert.deepEqual(contexts,baseline);
    for (const quote of oldQuotes.slice(0,count)) assert.ok(rows.some(row=>row.sourceType==='assistant'&&row.canonicalContent===quote&&row.requiresExactQuote!==true));
    assert.ok(rows.every(row=>!row.canonicalContent.includes('旧人物外围剧情')));
    assert.equal(rows.reduce((sum,row)=>sum+row.canonicalContent.length,0),baseline.reduce((sum,text)=>sum+text.length,0)+oldQuotes.slice(0,count).reduce((sum,text)=>sum+text.length,0));
    for (const originalSource of original) assert.ok(rows.some(row=>row.floorId===originalSource.floorId&&row.sourceType===originalSource.sourceType&&locatePlaceQuote(row.canonicalContent,originalSource.canonicalContent)));
  }
});

test('194地点省略引用不接受重复、倒序、重叠、空片段、缺字或超出原预算', () => {
  for (const [content, quote] of [
    ['甲。甲。乙。', '甲。……乙。'], ['甲。乙。', '乙。……甲。'], ['甲乙丙', '甲乙……乙丙'],
    ['甲。乙。', '……甲。……乙。'], ['甲。乙。', '甲。……乙。……'], ['甲。乙。', '甲。……丙。'],
    ['甲。乙。', '甲。..乙。'], ['甲。乙。', '甲。……'],
    [Array.from({length:9},(_,i)=>`段${i}。`).join(''), Array.from({length:9},(_,i)=>`段${i}。`).join('……')],
    ['甲'.repeat(2001)+'乙。', '甲'.repeat(2001)+'……乙。'],
  ]) assert.equal(locatePlaceQuote(content, quote, { allowOmission: true }), null, quote.slice(0,40));
  assert.equal(locatePlaceQuote('甲。中间。乙。', '甲。……乙。'), null, '普通引用通道不默认恢复省略');
});

test('196只补缺证据地点精确firstSeen已存成员来源，同楼去重且不借聚合锚楼或失效原文',async()=>{
 const floors=[{id:'f1',assistantSeq:1,content:{canonicalContent:'第一楼地点原文。'}},{id:'f2',assistantSeq:2,content:{canonicalContent:'第二楼地点原文。'}}],memory={id:'memory-aggregate',floorId:'f2',sourceFloorIds:['f1','f2'],sourceCanonicalContent:'不可借用的聚合全文',sourceFloorSnapshots:[{floorId:'f1',canonicalContent:floors[0].content.canonicalContent},{floorId:'f2',canonicalContent:floors[1].content.canonicalContent}]};
 const entities=[{id:'e1',entityType:'place',firstSeenFloorId:'f1'},{id:'e2',entityType:'place',firstSeenFloorId:'f2'},{id:'e3',entityType:'place',firstSeenFloorId:'f1'}],entityKeys=new Map([['e1','place-1'],['e2','place-2'],['e3','place-3']]),bodySources=[{placeKeys:['place-2','place-3']}],memoriesByFloor=new Map([['f1',memory],['f2',memory]]);
 const result=await collectMissingPlaceSources({entities,entityKeys,bodySources,floors,memoriesByFloor});assert.equal(result.length,1);assert.equal(result[0].floorId,'f1');assert.equal(result[0].canonicalContent,'第一楼地点原文。');assert.deepEqual(result[0].placeKeys,['place-1','place-3']);assert.equal(result[0].requiresExactQuote,true);
 const unavailable=await collectMissingPlaceSources({entities,entityKeys,bodySources,floors:[{...floors[0],content:{canonicalContent:'已编辑的新正文'}},floors[1]],memoriesByFloor});assert.deepEqual(unavailable,[]);
 const missingMember={...memory,sourceFloorSnapshots:memory.sourceFloorSnapshots.slice(1)};assert.deepEqual(await collectMissingPlaceSources({entities,entityKeys,bodySources,floors,memoriesByFloor:new Map([['f1',missingMember]])}),[]);
 assert.deepEqual(await collectMissingPlaceSources({entities,entityKeys,bodySources,floors:[floors[1]],memoriesByFloor}),[]);
});

test('无首见楼地点按已存location、position和containment引用补相邻上下文', async t => {
  const text = ['开头闲谈。', '远处闲谈。', '楼层入口。', '甲楼二层设有借阅室。', '门边有导览牌。', '后续过渡。', '更远的无关人物闲聊。'].join('\n\n');
  for (const field of ['location', 'position', 'containment']) await t.test(field, async () => {
    const item = field === 'location' ? { entityId: 'room' } : { placeEntityId: 'room', ...(field === 'containment' ? { parentEntityId: 'building' } : {}) };
    const memory = { id: 'memory', floorId: 'f1', sourceCanonicalContent: text, sourceUserInputSnapshot: { messages: [{ content: '借阅室位于甲楼二层。' }] },
      ...(field === 'location' ? { locations: [item] } : { spatialFacts: { [field === 'position' ? 'positions' : 'containments']: [item] } }) };
    const args = { entities: [{ id: 'room', entityType: 'place', firstSeenFloorId: null }], entityKeys: new Map([['room', 'place-1']]),
      places: [{ entityId: 'room', displayName: '借阅室', aliases: [] }], bodySources: [], floors: [{ id: 'f1', assistantSeq: 1, content: { canonicalContent: text } }], memoriesByFloor: new Map([['f1', memory]]) };
    const before = JSON.stringify(memory), rows = await placeEvidence.collectPlaceOrganizationSources(args);
    assert.ok(rows.some(row => row.requiresExactQuote && row.sourceType === 'assistant' && row.canonicalContent.includes('甲楼二层设有借阅室')));
    assert.ok(rows.some(row => row.sourceType === 'precedingUser' && row.canonicalContent === '借阅室位于甲楼二层。'));
    assert.ok(rows.every(row => !row.canonicalContent.includes('更远的无关人物闲聊')));
    assert.equal(rows.filter(row => row.sourceType === 'assistant').length, 1);
    assert.equal(JSON.stringify(memory), before);
  });
});

test('补地点来源沿canonical引用，已有首见或父边上下文不被旧位置引用扩大', async () => {
  const text = '甲楼二层有借阅室。', other = '旧位置只有人物闲谈。';
  const m1 = { id: 'm1', floorId: 'f1', sourceCanonicalContent: text };
  const m2 = { id: 'm2', floorId: 'f2', sourceCanonicalContent: other, locations: [{ entityId: 'old-room' }] };
  const args = { entities: [{ id: 'room', entityType: 'place', firstSeenFloorId: 'f1' }], entityKeys: new Map([['room', 'place-1']]), places: [{ entityId: 'room', displayName: '借阅室', aliases: [] }], bodySources: [],
    floors: [{ id: 'f1', assistantSeq: 1, content: { canonicalContent: text } }, { id: 'f2', assistantSeq: 2, content: { canonicalContent: other } }],
    memoriesByFloor: new Map([['f1', m1], ['f2', m2]]), resolveEntityId: id => id === 'old-room' ? 'room' : id };
  const first = await placeEvidence.collectPlaceOrganizationSources(args);
  assert.ok(first.every(row => row.floorId === 'f1'));
  const parent = await placeEvidence.collectPlaceOrganizationSources({ ...args, entities: [], parentFacts: [{ placeEntityId: 'room', evidenceRefs: [{ floorId: 'f1' }] }] });
  assert.deepEqual(parent, first);
  const missing = await placeEvidence.collectPlaceOrganizationSources({ ...args, entities: [], memoriesByFloor: new Map([['f1', { ...m1, locations: [{ entityId: 'old-room' }] }]]) });
  assert.ok(missing.some(row => row.floorId === 'f1' && row.requiresExactQuote));
  assert.equal(missing.filter(row => row.sourceType === 'assistant').length, 1);
});

test('缺首见地点的聚合引用只展开有证据的成员，不借锚楼、外楼或缺失快照', async () => {
  const first = '甲楼二层有借阅室。', second = '乙楼里有展厅。';
  const memory = { id: 'aggregate', floorId: 'f2', sourceFloorIds: ['f1', 'f2'], sourceCanonicalContent: '不可借用的聚合全文', sourceUserInputSnapshot: { messages: [{ content: '不可借用的锚楼USER。' }] },
    locations: [{ entityId: 'room', evidenceRefs: [{ floorId: 'f1' }] }, { entityId: 'unknown' }], spatialFacts: { positions: [{ placeEntityId: 'room', evidenceRefs: [{ floorId: 'foreign' }] }] },
    sourceFloorSnapshots: [{ floorId: 'f1', canonicalContent: first, sourceUserInputSnapshot: { messages: [{ content: '借阅室在甲楼。' }] } }, { floorId: 'f2', canonicalContent: second, sourceUserInputSnapshot: { messages: [{ content: '展厅在乙楼。' }] } }] };
  const args = { entities: [], entityKeys: new Map([['room', 'place-1'], ['unknown', 'place-2']]), places: [{ entityId: 'room', displayName: '借阅室', aliases: [] }, { entityId: 'unknown', displayName: '未定位地点', aliases: [] }], bodySources: [],
    floors: [{ id: 'f1', assistantSeq: 1, content: { canonicalContent: first } }, { id: 'f2', assistantSeq: 2, content: { canonicalContent: second } }, { id: 'foreign', assistantSeq: 3, content: { canonicalContent: '异源借阅室。' } }], memoriesByFloor: new Map([['f1', memory], ['f2', memory]]) };
  const rows = await placeEvidence.collectPlaceOrganizationSources(args);
  assert.ok(rows.some(row => row.requiresExactQuote && row.sourceType === 'assistant' && row.floorId === 'f1'));
  assert.ok(rows.some(row => row.sourceType === 'precedingUser' && row.canonicalContent === '借阅室在甲楼。'));
  assert.ok(rows.every(row => row.floorId === 'f1' && !row.placeKeys.includes('place-2')));
  for (const changed of [{ ...memory, sourceFloorSnapshots: memory.sourceFloorSnapshots.slice(1) }, { ...memory, sourceFloorSnapshots: [{ ...memory.sourceFloorSnapshots[0], canonicalContent: '被替换的旧原文。' }, memory.sourceFloorSnapshots[1]] }]) {
    assert.deepEqual(await placeEvidence.collectPlaceOrganizationSources({ ...args, memoriesByFloor: new Map([['f1', changed], ['f2', changed]]) }), []);
  }
});
