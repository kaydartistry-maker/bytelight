import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost } from './usage-pricing.js';

describe('Opus 5 pricing', () => {
  test('uses the published $5 input / $25 output rates', () => {
    assert.equal(estimateCost({
      model: 'claude-opus-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }), 30);
  });
});
