import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { usageOrEstimate } from './api-router.js';

describe('ApiRouter usage selection', () => {
  test('passes through provider-reported tokens and cost, including zero cost', () => {
    const exact = { type: 'usage' as const, input: 100, output: 5, cacheRead: 20, cost: 0 };
    assert.strictEqual(usageOrEstimate(exact, [{ role: 'user', content: 'ignored' }], 999), exact);
  });

  test('keeps the char/token heuristic when provider usage is missing', () => {
    assert.deepEqual(
      usageOrEstimate(undefined, [{ role: 'user', content: '12345678' }], 9),
      { type: 'usage', input: 2, output: 3 },
    );
  });
});
