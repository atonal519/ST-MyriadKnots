import test from 'node:test';import assert from 'node:assert/strict';import * as icons from '../src/ui/qianchuang-icons.js';
test('完整Lucide库的1958名称均可取图，并保留1712份独立几何',()=>{
 assert.ok(Array.isArray(icons.qianchuangIconNames));assert.equal(icons.qianchuangIconNames.length,1958);const rendered=new Set();for(const name of icons.qianchuangIconNames){const svg=icons.qianchuangIcon(name);assert.match(svg,/<(?:path|rect|circle|line|ellipse|polygon|polyline)\b/u,name);rendered.add(svg);}assert.equal(rendered.size,1712);
});
test('完整图标名称支持Pascal、kebab、space，原九个调用别名保持可用',()=>{
 for(const name of ['WashingMachine','MirrorRectangular','AirVent','ShieldCheck']){const words=name.replace(/([a-z0-9])([A-Z])/g,'$1 $2');assert.equal(icons.qianchuangIcon(name),icons.qianchuangIcon(words.toLowerCase()));assert.equal(icons.qianchuangIcon(name),icons.qianchuangIcon(words.toLowerCase().replaceAll(' ','-')));}
 for(const key of ['bath','laundry','kitchen','dining','rest','storage','work','building','place'])assert.match(icons.qianchuangIcon(key),/<svg\b/u);assert.notEqual(icons.qianchuangIcon('Sofa'),icons.qianchuangIcon('place'));assert.equal(icons.qianchuangIcon('unknown-missing-icon'),icons.qianchuangIcon('place'));
});
