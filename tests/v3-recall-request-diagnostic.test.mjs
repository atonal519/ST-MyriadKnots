import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecallRequestDiagnostic } from '../src/v3/recall-request-diagnostic.js';

function harness() {
  const instances = [], performanceRef = { timeOrigin: Date.now() - 1000 };
  class Observer {
    constructor(callback) { this.callback = callback; this.pending = []; this.disconnected = false; instances.push(this); }
    observe(options) { assert.deepEqual(options, { type: 'resource' }); }
    takeRecords() { return this.pending.splice(0); }
    disconnect() { this.disconnected = true; }
    emit(entries) { this.callback({ getEntries: () => entries }); }
  }
  const diagnostic = createRecallRequestDiagnostic({ performanceRef, Observer, origin: 'https://tavern.example' });
  const entry = (id, overrides = {}) => {
    const startTime = diagnostic.snapshot(id).startedAt - performanceRef.timeOrigin + 5;
    return { name: 'https://tavern.example/api/chats/patch?key=SECRET#PRIVATE', initiatorType: 'fetch', startTime,
      requestStart: startTime + 10, responseStart: startTime + 100, responseEnd: startTime + 120, ...overrides };
  };
  return { diagnostic, instances, entry, performanceRef };
}

test('诊断只记录本轮同源指定请求的时间，不保留地址、查询参数或正文', () => {
  const { diagnostic, instances, entry } = harness(), id = diagnostic.start();
  instances[0].emit([
    entry(id, { body: 'BODY_SECRET', responseText: 'RESPONSE_SECRET' }),
    entry(id, { name: 'https://another.example/api/chats/patch' }),
    entry(id, { name: 'https://tavern.example/api/secrets/read' }),
    entry(id, { initiatorType: 'img' }), entry(id, { startTime: -1 }),
  ]);
  const snapshot = diagnostic.snapshot(id);
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.requests[0].label, '更新聊天');
  assert.equal(snapshot.requests[0].responseStartedAt - snapshot.requests[0].requestStartedAt, 90);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|PRIVATE|tavern\.example|api\/|body|responseText/);
  diagnostic.finish(id);
});

test('旧轮结束与迟到回调不影响新轮，结束时取待交付记录并只保留最近64条', () => {
  const { diagnostic, instances, entry } = harness(), oldId = diagnostic.start();
  const oldEntry = entry(oldId), id = diagnostic.start();
  instances[0].emit([oldEntry]); diagnostic.finish(oldId);
  assert.equal(instances[1].disconnected, false);
  assert.equal(diagnostic.snapshot(id).requests.length, 0);
  instances[1].emit(Array.from({ length: 69 }, (_, n) => entry(id, { name: 'https://tavern.example/api/tokenizers/openai/count-batch', startTime: entry(id).startTime + n })));
  instances[1].pending.push(entry(id, { name: 'https://tavern.example/api/backends/chat-completions/generate' }));
  diagnostic.finish(id);
  const snapshot = diagnostic.snapshot(id);
  assert.equal(snapshot.status, 'complete'); assert.equal(snapshot.requests.length, 64); assert.equal(snapshot.droppedCount, 6);
  assert.equal(snapshot.requests.at(-1).label, '生成请求');
  snapshot.requests[0].label = 'modified';
  assert.notEqual(diagnostic.snapshot(id).requests[0].label, 'modified');
  diagnostic.clear(); assert.equal(diagnostic.snapshot(id).status, 'unavailable');
});

test('不支持资源计时的宿主正常返回未支持状态，不阻止召回', () => {
  for (const Observer of [null, class { observe() { throw new Error('unsupported resource observer'); } disconnect() {} }]) {
    const diagnostic = createRecallRequestDiagnostic({ performanceRef: { timeOrigin: Date.now() }, Observer, origin: 'https://tavern.example' });
    const id = diagnostic.start(); diagnostic.finish(id);
    assert.equal(diagnostic.snapshot(id).status, 'unsupported');
    diagnostic.clear();
  }
});
