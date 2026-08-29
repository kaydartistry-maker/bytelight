import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { unexpectedExitDelay } from './supervisor.js';

describe('heartbeat fast-exit backoff', () => {
  test('keeps one quick retry, then backs off repeated code-1 crashes', () => {
    assert.equal(unexpectedExitDelay(1), 2_000);
    assert.equal(unexpectedExitDelay(2), 10_000);
    assert.equal(unexpectedExitDelay(3), 30_000);
    assert.equal(unexpectedExitDelay(4), 60_000);
  });

  test('caps a sustained crash loop at five minutes', () => {
    assert.equal(unexpectedExitDelay(5), 300_000);
    assert.equal(unexpectedExitDelay(500), 300_000);
  });
});
