import test from 'node:test';
import assert from 'node:assert/strict';
import { peoplePickerProjection } from '../src/ui/people-visibility.js';

test('两入口展示只收起语义明确且单来源的临时人物，重要及稳定人物不受影响', () => {
 const temporary={entityId:'temporary',displayName:'门口保安',aliases:[],nameKind:'temporary',appearanceCount:1};
 const retained=[{}, {nameKind:'named'}, {nameKind:'stable'}, {appearanceCount:2}, {appearanceCount:0}, {selected:true}, {specialRole:'char'}, {mainCharacter:true}, {profiled:true}, {aliases:['老赵']}].map((patch,i)=>({...temporary,...patch,entityId:`keep-${i}`}));
 delete retained[0].nameKind;
 const people=[temporary,...retained];
 assert.deepEqual(peoplePickerProjection(people).visible,retained);
 assert.equal(peoplePickerProjection(people).collapsedCount,1);
 assert.deepEqual(peoplePickerProjection(people,{showTemporary:true}).visible,people);
 assert.deepEqual(peoplePickerProjection(people,{query:'门口保安'}).visible,people);
 assert.equal(people.length,11);
});
