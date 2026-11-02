import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarGenerator, DEFAULT_AVATAR_PROMPT } from '../src/avatar-generation.js';

function harness({configured=true,separate=true,characters=[{name:'库中甲',tag:'appearance-a',nl:'外貌甲'}]}={}) {
  const calls=[];const api={apiVersion:1,getBackendStatus:()=>({configured,supportsCharacters:separate}),getCharacters:()=>({characters}),async generate(...args){calls.push(args);return {dataUrl:'data:image/png;base64,AAAA'};}};
  return {api,calls,generator:createAvatarGenerator({apiProvider:()=>api})};
}
test('柏宝绘头像只用姓名有效别名唯一匹配，同名或多个对应交显式选项',()=>{
  const h=harness();assert.equal(h.generator.prepare({displayName:'甲',aliases:['库中甲']}).selectedIndex,0);
  const multiple=harness({characters:[{name:'甲',tag:'a'},{name:'甲',tag:'b'},{name:'乙',tag:'c'}]});
  assert.equal(multiple.generator.prepare({displayName:'甲'}).selectedIndex,null);
  assert.equal(multiple.generator.prepare({displayName:'别的人'}).selectedIndex,null);
  assert.equal(multiple.generator.prepare({displayName:'甲',aliases:['乙']}).characters.length,3);
});
test('两种柏宝绘渠道实际请求同一库外貌，save false且每次只有一次生图',async()=>{
  for (const separate of [true,false]) {
    const h=harness({separate}),character=h.generator.prepare({displayName:'库中甲'}).characters[0];
    const result=await h.generator.generate({character,prompt:'custom composition'});assert.equal(result.dataUrl,'data:image/png;base64,AAAA');assert.equal(h.calls.length,1);
    const [request]=h.calls[0];assert.deepEqual(request.characters,[{name:'库中甲',tag:'appearance-a',nl:'外貌甲'}]);assert.equal(request.save,false);assert.equal(request.size,'portrait');
    assert.equal(request.prompt,separate?'custom composition':'custom composition, appearance-a');assert.equal(request.nl,separate?'custom composition':'custom composition. 外貌甲');
    await h.generator.generate({character,prompt:''});assert.ok(h.calls[1][0].prompt.startsWith(DEFAULT_AVATAR_PROMPT));
  }
});
test('未配置缺档或无图片时给实际错误，不自动改选或补生图',async()=>{
  assert.throws(()=>createAvatarGenerator({apiProvider:()=>null}).prepare({displayName:'甲'}),/安装并开启柏宝绘/);
  assert.throws(()=>harness({configured:false}).generator.prepare({displayName:'甲'}),/完成生图设置/);
  assert.throws(()=>harness({characters:[{name:'甲',tag:''}]}).generator.prepare({displayName:'甲'}),/补充人物外貌/);
  const h=harness();h.api.generate=async()=>{h.calls.push('failure');throw new Error('渠道拒绝');};
  await assert.rejects(h.generator.generate({character:{name:'甲',tag:'a'}}),/渠道拒绝/);assert.equal(h.calls.length,1);
  h.api.generate=async()=>({path:'saved-only'});await assert.rejects(h.generator.generate({character:{name:'甲',tag:'a'}}),/没有返回可用图片/);
});


test('头像衣着风格原文同次送达两种渠道，空值严格保旧payload且不损失无NL外貌',async()=>{
  for (const separate of [true,false]) {
    const h=harness({separate}),character=h.generator.prepare({displayName:'库中甲'}).characters[0];
    await h.generator.generate({character,prompt:'composition'});await h.generator.generate({character,prompt:'composition',clothingStyle:''});assert.deepEqual(h.calls[1][0],h.calls[0][0]);
    await h.generator.generate({character,prompt:'composition',clothingStyle:'青色长衫'});const request=h.calls[2][0];assert.equal(h.calls.length,3);
    assert.equal(request.characters[0].tag,'appearance-a');assert.ok(request.characters[0].nl.startsWith('Outfit for this image:'));assert.ok(request.characters[0].nl.endsWith('Clothing reference (verbatim): 青色长衫. 外貌甲'));
    const clothing=request.characters[0].nl.slice(0,-'. 外貌甲'.length);
    assert.equal(request.prompt,separate?'composition':clothing+', composition, appearance-a');assert.equal(request.nl,separate?'composition':clothing+'. composition. 外貌甲');
  }
  const h=harness({separate:false,characters:[{name:'甲',tag:'appearance-only',nl:''}]});await h.generator.generate({character:h.generator.prepare({displayName:'甲'}).characters[0],clothingStyle:'白色长袍'});assert.ok(h.calls[0][0].nl.startsWith('Outfit for this image:'));assert.ok(h.calls[0][0].nl.endsWith('Clothing reference (verbatim): 白色长袍. '+DEFAULT_AVATAR_PROMPT+'. appearance-only'));
});

test('本张衣着要求先于库NL，保完整多场景原文和构图；两种渠道各只发一次图片请求',async()=>{
 const clothing='  日常：蓝色风衣与便装。\n舞台：白色燕尾礼服；过去远征队时期穿防护制服。  ';
 for(const separate of [true,false]){
  const h=harness({separate}),character={name:'合成人物',tag:'silver hair, blue eyes',nl:'Stable library appearance'},before=structuredClone(character),controller=new AbortController();
  await h.generator.generate({character,prompt:'unchanged custom framing',clothingStyle:clothing,signal:controller.signal});assert.equal(h.calls.length,1);const [request,options]=h.calls[0];
  assert.ok(request.characters[0].nl.startsWith('Outfit for this image:'));assert.ok(request.characters[0].nl.includes(clothing));assert.ok(request.characters[0].nl.endsWith(character.nl));assert.equal(request.characters[0].tag,character.tag);
  assert.match(request.characters[0].nl,/current outfit|daily wear/u);assert.match(request.characters[0].nl,/past military service.*background/iu);assert.match(request.characters[0].nl,/one coherent outfit/u);assert.match(request.characters[0].nl,/techwear.*urban functional fashion/iu);assert.match(request.characters[0].nl,/unrequested.*weapons|weapons.*unrequested/iu);
  if(separate){assert.equal(request.prompt,'unchanged custom framing');assert.equal(request.nl,'unchanged custom framing');}
  else{assert.ok(request.prompt.startsWith('Outfit for this image:'));assert.ok(request.nl.startsWith('Outfit for this image:'));assert.ok(request.prompt.includes('unchanged custom framing'));assert.ok(request.nl.includes(clothing));assert.ok(request.prompt.endsWith(character.tag));assert.ok(request.nl.endsWith(character.nl));}
  assert.equal(request.save,false);assert.equal(request.size,'portrait');assert.deepEqual(Object.keys(request).sort(),['characters','nl','prompt','save','size']);assert.equal(options.signal,controller.signal);assert.deepEqual(character,before);
 }
});
