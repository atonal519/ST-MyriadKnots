import {loadQianchuangMapAsset} from '../qianchuang-map-catalog.js';
import {QIANCHUANG_MAP_ASSETS} from '../qianchuang-map-assets.js';
export function createGenericMapLoader({moduleUrl=import.meta.url,fetchImpl=globalThis.fetch}={}){
 const url=new URL(moduleUrl),base=new URL(url.pathname.includes('/src/ui/')?'../../assets/maps-library/':'../assets/maps-library/',url),cache=new Map();
 return id=>{
  const asset=QIANCHUANG_MAP_ASSETS[id];if(!asset)throw Error('底图不可用。');
  return loadQianchuangMapAsset('generic',asset,()=>{
  if(!cache.has(id)){const request=Promise.resolve().then(()=>fetchImpl(new URL(asset.file+'?v='+asset.sha256.slice(0,16),base).href)).then(response=>{if(!response.ok)throw Error('底图暂时无法读取。');return response.text();}).catch(error=>{cache.delete(id);throw error;});cache.set(id,request);}
  return cache.get(id);});
 };
}
