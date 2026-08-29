/**
 * Tripwire: the builtin sensitive-path deny lists must stay EMPTY.
 *
 * Operator Phase 0.5 directive (Slice 3a "empty-socket" port of
 * tools/sensitive-paths.ts): this is a single-user sovereign
 * deployment, and every builtin deny pattern / fragment was removed
 * by explicit operator decision. Repopulating the builtin deny
 * patterns is an operator-gated decision — if a future port or merge
 * reintroduces them, this test fails loudly so the change gets a
 * human gate instead of sliding in silently.
 *
 * The operator-supplied custom-pattern path (cfg.agent.tool_deny_patterns
 * → compilePatterns) remains fully functional and is asserted below.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __TEST_INTERNALS__,
  isSensitivePath,
  bashOrGlobTargetsSensitive,
} from './sensitive-paths.js';

describe('sensitive-paths empty-socket tripwire', () => {
  test('BUILTIN_DENY_PATTERNS is empty (operator-gated to repopulate)', () => {
    assert.equal(__TEST_INTERNALS__.BUILTIN_DENY_PATTERNS.length, 0);
  });

  test('SENSITIVE_FRAGMENTS is empty (operator-gated to repopulate)', () => {
    assert.equal(__TEST_INTERNALS__.SENSITIVE_FRAGMENTS.length, 0);
  });

  test('with no custom patterns, nothing is denied', () => {
    assert.equal(isSensitivePath('/scope/anything.txt', '/scope'), null);
    assert.equal(bashOrGlobTargetsSensitive('cat anything.txt'), null);
  });

  test('operator custom patterns still compile and deny', () => {
    const hit = isSensitivePath('/scope/private/notes.txt', '/scope', [
      '(^|/)private(/|$)',
    ]);
    // isSensitivePath returns the matching pattern's RegExp `source`
    // (which escapes slashes) — assert it hit, not the exact escaping.
    assert.equal(hit, new RegExp('(^|/)private(/|$)').source);
    assert.equal(
      isSensitivePath('/scope/public/notes.txt', '/scope', ['(^|/)private(/|$)']),
      null,
    );
  });
});
