import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markPreparationFailure,
  preparationFailureDiagnostic,
  storedPreparationDiagnostic,
} from '../src/v3/preparation-diagnostic.js';

test('准备诊断独立保留 DataCloneError 数字 code、TypeError 与内部 code', () => {
  let cloneError;
  try { structuredClone(() => {}); } catch (error) { cloneError = error; }
  markPreparationFailure(cloneError, 'snapshotClone');
  assert.deepEqual({ ...preparationFailureDiagnostic(cloneError), location: null }, {
    prepareStep: 'snapshotClone', name: 'DataCloneError', code: 25, detail: '结构化复制失败。', location: null,
  });

  const typeError = new TypeError('PRIVATE_BODY');
  markPreparationFailure(typeError, 'identityDirectory');
  assert.deepEqual({ ...preparationFailureDiagnostic(typeError), location: null }, {
    prepareStep: 'identityDirectory', name: 'TypeError', code: null, detail: '类型检查失败。', location: null,
  });

  const internal = Object.assign(new Error('PRIVATE_BODY'), { code: 'V3_MEMORY_FOUNDATION_NOT_READY' });
  markPreparationFailure(internal, 'synchronizing');
  assert.deepEqual({ ...preparationFailureDiagnostic(internal), location: null }, {
    prepareStep: 'synchronizing', name: 'Error', code: 'V3_MEMORY_FOUNDATION_NOT_READY', detail: '插件内部错误码已记录。', location: null,
  });
});

test('未知错误与 primitive 安全退化，不公开自由 message、任意 code 或伪步骤', () => {
  const unknown = Object.assign(new Error('PRIVATE_BODY https://api.example.test/v1?key=SECRET'), { code: 'PRIVATE_CODE' });
  const diagnostic = preparationFailureDiagnostic(unknown);
  assert.deepEqual({ ...diagnostic, location: null }, { prepareStep: null, name: 'Error', code: null, detail: '未分类错误。', location: null });
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE|SECRET|https?:/u);
  assert.deepEqual(preparationFailureDiagnostic('primitive failure'), { prepareStep: null, name: null, code: null, detail: '未分类错误。', location: null });
});

test('旧失败记录恢复数字 code 或 Error 名，新增位置仅接受插件相对帧', () => {
  assert.deepEqual(storedPreparationDiagnostic({ code: '25' }), { prepareStep: null, name: null, code: 25, detail: null, location: null });
  assert.deepEqual(storedPreparationDiagnostic({ code: 'UsageGraphError' }), { prepareStep: null, name: 'UsageGraphError', code: null, detail: null, location: null });
  const chrome = preparationFailureDiagnostic({ name: 'Error', stack: 'Error: private\n    at thirdParty (https://cdn.example/x.js:1:2)\n    at prepare (https://host/extensions/ST-QianQianJie/src/v3/memory-runtime.js?cache=secret:123:45)' });
  assert.equal(chrome.location, 'src/v3/memory-runtime.js:123:45');
  const safari = preparationFailureDiagnostic({ name: 'Error', stack: 'Error: private\nthirdParty@https://cdn.example/x.js:1:2\nprepare@https://host/extensions/ST-QianQianJie/dist/qqj-app.js?v=private:1:678' });
  assert.equal(safari.location, 'dist/qqj-app.js:1:678');
  assert.equal(storedPreparationDiagnostic({ location: '/home/admin/src/v3/memory-runtime.js:1:2?secret' }).location, null);
});
