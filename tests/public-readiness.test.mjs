import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicMemoryBridge} from '../src/v3/public-memory-bridge.js';
const floor=(messageIndex,extra={})=>({floorId:'f'+messageIndex,messageIndex,assistantSeq:100+messageIndex,memory:{recordStatus:'active'},cse:{status:'ready',deltaId:'d'+messageIndex},...extra});
function fixture(floors){let state={chatId:'q',memorySnapshotStatus:'ready',floors},id={hostChatId:'h',chatId:'q'},reads=0;const listeners=new Set();
 const bridge=createPublicMemoryBridge({session:{getState:()=>({status:'ready',identity:id}),identity:()=>id},store:{readReachable(){throw Error('no backend');}},hostAdapter:{snapshot:()=>({chatId:id.hostChatId})},peopleRuntime:{getState(){throw Error('not a readiness dependency');}},memoryRuntime:{getState(){reads++;return state;},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}}});
 return{bridge,listeners,get reads(){return reads;},emit(next){state=next;for(const fn of listeners)fn(state);},state:()=>state,identity(next){id=next;}};
}
test('readiness waits for per-floor committed CSE, while a later unrelated busy workspace does not hide ready prefix',()=>{
 const f=fixture([floor(2),floor(4,{cse:{status:'pending'}}),floor(6)]);assert.equal(typeof f.bridge.getReadiness,'function');
 let r=f.bridge.getReadiness();assert.equal(r.status,'ready');assert.equal(r.identity.qqjChatId,'q');assert.equal(r.readyThroughMessageIndex,2);assert.equal(r.pendingMessageIndex,4);
 f.emit({...f.state(),status:'running',busy:true,floors:[floor(2),floor(4,{cse:{status:'noChange',deltaId:'saved'}}),floor(6,{cse:{status:'running'}})]});r=f.bridge.getReadiness();assert.equal(r.readyThroughMessageIndex,4);
});
test('aggregate locators, explicit exclusions and frozen archived CSE use runtime semantics without AI ordinal adjacency',()=>{
 const f=fixture([floor(8,{sourceMessageIndexes:[2,4,8],sourceAssistantSeqs:[1,2,99]}),floor(10,{memoryExcluded:true,status:'excluded',memory:null,cse:null}),floor(12,{frozen:true,cse:{status:'archived',deltaId:null}})]);
 assert.equal(typeof f.bridge.getReadiness,'function');assert.equal(f.bridge.getReadiness().readyThroughMessageIndex,12);
 f.emit({...f.state(),floors:[floor(2,{memory:null,cse:{status:'notApplicable'}}),floor(4)]});assert.equal(f.bridge.getReadiness().readyThroughMessageIndex,null);
 assert.equal(f.bridge.getReadiness({afterMessageIndex:2}).readyThroughMessageIndex,4);
});
test('readiness notification consumes existing payload without deep cloning or another runtime read and unsubscribes cleanly',()=>{
 const f=fixture([floor(2)]),seen=[];assert.equal(typeof f.bridge.subscribeReadiness,'function');const off=f.bridge.subscribeReadiness(r=>seen.push(r));const bad=f.bridge.subscribeReadiness(()=>{throw Error('listener');});const reads=f.reads;
 const next={...f.state(),busy:true,floors:[floor(2),floor(4)]};Object.defineProperty(next,'cseSubjects',{get(){throw Error('no full state projection');}});
 const clone=globalThis.structuredClone;try{globalThis.structuredClone=()=>{throw Error('no clone');};f.emit(next);assert.equal(f.bridge.getReadiness().readyThroughMessageIndex,4);}finally{globalThis.structuredClone=clone;}
 assert.equal(f.reads,reads);assert.equal(seen.at(-1).readyThroughMessageIndex,4);assert.doesNotMatch(JSON.stringify(seen),/recordStatus|summary|cseSubjects|deltaId/);bad();off();assert.equal(f.listeners.size,0);
});
test('missing CSE, unavailable sources, source mismatch and malformed locators never report false completion',()=>{
 for(const extra of [{cse:null},{cse:{status:'ready'}},{cse:{status:'notApplicable'}},{cse:{status:'archived'}},{sourceUnavailable:true}]){const f=fixture([floor(2,extra)]);assert.equal(typeof f.bridge.getReadiness,'function');assert.equal(f.bridge.getReadiness().readyThroughMessageIndex,null);}
 const f=fixture([floor(2)]);f.emit({...f.state(),chatId:'other'});assert.notEqual(f.bridge.getReadiness().status,'ready');f.emit({...f.state(),chatId:'q',memorySnapshotStatus:'error'});assert.notEqual(f.bridge.getReadiness().status,'ready');
 f.emit({...f.state(),chatId:'q',memorySnapshotStatus:'ready',floors:[floor(2,{sourceMessageIndexes:[2,'4']})]});assert.notEqual(f.bridge.getReadiness().status,'ready');
});
