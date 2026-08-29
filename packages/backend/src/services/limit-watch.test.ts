// Pins for the KNOW layer's warn-once discipline: a hot meter warns exactly
// once per (window, tier), escalation at 95 earns exactly one more, a new
// reset window re-arms, and expired state keys are pruned.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLimitWarnings, type WatchedWindow } from './limit-watch.js';

const FUTURE = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
const PAST = new Date(Date.now() - 3600_000).toISOString();

function win(percent: number, overrides: Partial<WatchedWindow> = {}): WatchedWindow {
  return { lane: 'claude', kind: 'weekly_all/weekly · all models', label: 'Claude weekly', percent, resetsAt: FUTURE, ...overrides };
}

describe('evaluateLimitWarnings', () => {
  test('crossing the threshold warns once; the next sweep is silent', () => {
    const first = evaluateLimitWarnings([win(85)], {}, 80);
    assert.equal(first.warnings.length, 1);
    assert.equal(first.warnings[0].tier, 80);

    const second = evaluateLimitWarnings([win(88)], first.state, 80);
    assert.equal(second.warnings.length, 0);
  });

  test('95 escalation fires exactly one additional warning', () => {
    const base = evaluateLimitWarnings([win(85)], {}, 80);
    const hot = evaluateLimitWarnings([win(96)], base.state, 80);
    assert.equal(hot.warnings.length, 1);
    assert.equal(hot.warnings[0].tier, 95);
    const again = evaluateLimitWarnings([win(97)], hot.state, 80);
    assert.equal(again.warnings.length, 0);
  });

  test('a jump straight past both tiers fires both, escalation first', () => {
    const { warnings } = evaluateLimitWarnings([win(97)], {}, 80);
    assert.equal(warnings.length, 2);
    assert.equal(warnings[0].tier, 95);
    assert.equal(warnings[1].tier, 80);
  });

  test('a new reset window re-arms the warning', () => {
    const first = evaluateLimitWarnings([win(85)], {}, 80);
    const nextWindow = new Date(Date.now() + 10 * 24 * 3600_000).toISOString();
    const second = evaluateLimitWarnings([win(85, { resetsAt: nextWindow })], first.state, 80);
    assert.equal(second.warnings.length, 1);
  });

  test('expired state keys are pruned', () => {
    const stale = { [`claude|weekly_all/weekly · all models|${PAST}|80`]: PAST };
    const { state } = evaluateLimitWarnings([win(10)], stale, 80);
    assert.deepEqual(state, {});
  });

  test('below threshold and non-finite percents stay silent', () => {
    const { warnings } = evaluateLimitWarnings(
      [win(79), win(Number.NaN)],
      {},
      80,
    );
    assert.equal(warnings.length, 0);
  });

  test('ISO colons in resetsAt survive the key round-trip (no false prune)', () => {
    const first = evaluateLimitWarnings([win(85)], {}, 80);
    const { state } = evaluateLimitWarnings([win(85)], first.state, 80);
    assert.equal(Object.keys(state).length, 1);
  });
});
