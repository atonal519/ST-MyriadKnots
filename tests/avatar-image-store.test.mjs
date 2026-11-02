import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarImageStore, normalizeAvatarSource } from '../src/avatar-image-store.js';

test('头像原图复用宿主upload保存原字节、独有目录和每图唯一文件，不经canvas',async()=>{
  let sequence=0;const calls=[];
  const store=createAvatarImageStore({headers:()=>({'X-CSRF-Token':'mock'}),uuid:()=>`asset-${++sequence}`,fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,options,body});return {ok:true,json:async()=>({path:`/user/images/${body.ch_name}/${body.filename}`})};
  }});
  const bytes=new Uint8Array([137,80,78,71,0,255,16]),file=new Blob([bytes],{type:'image/png'}),controller=new AbortController();
  const first=await store.upload(file,{signal:controller.signal}),second=await store.upload(file);
  assert.equal(calls[0].url,'/api/images/upload');assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.signal,controller.signal);
  assert.equal(calls[0].options.headers['X-CSRF-Token'],'mock');assert.deepEqual(Buffer.from(calls[0].body.image,'base64'),Buffer.from(bytes));
  assert.equal(calls[0].body.ch_name,'qqj-avatars');assert.equal(calls[0].body.format,'png');assert.notEqual(first.path,second.path);
  assert.deepEqual(first,{path:'/user/images/qqj-avatars/qqj-avatar-asset-1.png',mimeType:'image/png'});assert.equal(calls.length,2);
});

test('生成头像原图确认时按角色卡归组，手选默认保留原目录',async()=>{
  const calls=[];
  const store=createAvatarImageStore({uuid:()=> 'generated',fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);return {ok:true,json:async()=>({path:`/user/images/${body.ch_name}/${body.filename}`})};
  }});
  const file=new Blob(['original'],{type:'image/png'});
  const source=await store.upload(file,{generated:true,galleryCharacterName:'  ECLIPSE  '});
  assert.equal(calls[0].ch_name,'柏宝绘_ECLIPSE');
  assert.deepEqual(normalizeAvatarSource({...source,crop:null}),{path:'/user/images/'+encodeURIComponent('柏宝绘_ECLIPSE')+'/qqj-avatar-generated.png',mimeType:'image/png',crop:null});
  await store.upload(file);assert.equal(calls[1].ch_name,'qqj-avatars');
  await store.upload(file,{generated:true,galleryCharacterName:'  '});assert.equal(calls[2].ch_name,'柏宝绘_未命名角色');
  assert.equal(normalizeAvatarSource({...source,path:'/user/images/柏宝绘_千千结头像/qqj-avatar-generated.png'}).path,'/user/images/柏宝绘_千千结头像/qqj-avatar-generated.png');
});

test('宿主raw卡目录只编码一次，保留字面%20和特殊字符且已存URL归一幂等',async()=>{
  const rawFolder='柏宝绘_卡 名 %20 # 100%',calls=[];
  const store=createAvatarImageStore({uuid:()=> 'special',fetchImpl:async(_url,options)=>{
    calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({path:`/user/images/${rawFolder}/qqj-avatar-special.png`})};
  }});
  const source=await store.upload(new Blob(['original'],{type:'image/png'}),{generated:true,galleryCharacterName:'卡:名 / %20 # 100%'});
  assert.equal(calls[0].ch_name,'柏宝绘_卡:名 / %20 # 100%','宿主负责清洗目录，客户端不要求清洗后等于卡名');
  assert.equal(source.path,`/user/images/${encodeURIComponent(rawFolder)}/qqj-avatar-special.png`);
  assert.ok(source.path.includes('%2520'));assert.ok(source.path.includes('%23'));
  const normalized=normalizeAvatarSource(source);assert.equal(normalized.path,source.path);assert.deepEqual(normalizeAvatarSource(normalized),normalized);
  assert.equal(decodeURIComponent(source.path.split('/')[3]),rawFolder);
  for(const folder of ['柏宝绘_Mr...Smith','柏宝绘_甲..乙','柏宝绘_..','柏宝绘_%2e%2e']){
    const path=`/user/images/${encodeURIComponent(folder)}/qqj-avatar-special.png`;
    assert.equal(normalizeAvatarSource({path,mimeType:'image/png'}).path,path,'有固定前缀的单级点号卡名不是父目录段');
  }
  for(const folder of ['柏宝绘_../x','柏宝绘_A\\B','柏宝绘_A/B','柏宝绘_A%2FB']){
    assert.throws(()=>normalizeAvatarSource({path:`/user/images/${encodeURIComponent(folder)}/qqj-avatar-special.png`,mimeType:'image/png'}),/头像原图记录无效/);
  }
  assert.throws(()=>normalizeAvatarSource({path:'/user/images/'+encodeURIComponent('柏宝绘_合法')+'/other.png',mimeType:'image/png'}),/头像原图记录无效/);
});

test('原图失败不自动重试，描述只接QQJ宿主图片与有限取景且旧空值无需补档',async()=>{
  let calls=0;const store=createAvatarImageStore({fetchImpl:async()=>{calls++;return {ok:false,status:503};}});
  await assert.rejects(store.upload(new Blob(['original'],{type:'image/jpeg'})),/原图保存失败/);assert.equal(calls,1);
  const source=normalizeAvatarSource({path:'user/images/qqj-avatars/qqj-avatar-existing.webp',mimeType:'image/webp',crop:{aspectRatio:1,zoom:2,offsetX:-10,offsetY:5}});
  assert.equal(source.path,'/user/images/qqj-avatars/qqj-avatar-existing.webp');assert.ok(Object.isFrozen(source.crop));
  for(const path of ['https://example.invalid/image.png','/user/images/other/image.png','/user/images/qqj-avatars/../image.png'])assert.throws(()=>normalizeAvatarSource({...source,path}),/头像原图记录无效/);
  assert.throws(()=>normalizeAvatarSource({...source,crop:{aspectRatio:1,zoom:9,offsetX:0,offsetY:0}}),/取景记录无效/);
});
