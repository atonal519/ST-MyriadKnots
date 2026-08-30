import test from 'node:test';
import assert from 'node:assert/strict';
import { createBaiBaiBookMemoryAdapter } from '../src/baibai-book-memory.js';

test('柏宝书 adapter 只读取 getInjectedHistory().relativeText 并安全失败为空', () => {
  let legacyCalls = 0;
  const cases = [
    [{}, ''],
    [{ STBaiBaiBook: {} }, ''],
    [{ STBaiBaiBook: { getInjectedHistory: () => { throw new Error('私密正文'); } } }, ''],
    [{ STBaiBaiBook: { getInjectedHistory: () => ({ relativeText: '' }) } }, ''],
    [{ STBaiBaiBook: { getInjectedHistory: () => ({ relativeText: '  林岚旧伤未愈\r\n仍在守城  ' }), getHistory: () => { legacyCalls += 1; } } }, '林岚旧伤未愈\n仍在守城'],
  ];
  for (const [root, expected] of cases) assert.equal(createBaiBaiBookMemoryAdapter({ globalProvider: () => root }).readRelativeText(), expected);
  assert.equal(legacyCalls, 0);
});
