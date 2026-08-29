import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRecentlyActive, ACTIVE_WINDOW_MS } from './threadRecency';

const NOW = new Date('2026-07-15T12:00:00.000Z').getTime();

test('recent daily thread → Active (within window)', () => {
  const oneHourAgo = new Date(NOW - 60 * 60 * 1000).toISOString();
  assert.equal(isRecentlyActive(oneHourAgo, NOW), true);
});

test('thread touched just under the window boundary → Active', () => {
  const justInside = new Date(NOW - (ACTIVE_WINDOW_MS - 1000)).toISOString();
  assert.equal(isRecentlyActive(justInside, NOW), true);
});

test('old daily thread → not recent (falls to month bucket)', () => {
  const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isRecentlyActive(threeDaysAgo, NOW), false);
});

test('old named thread → not recent (falls to named section)', () => {
  const oneWeekAgo = new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isRecentlyActive(oneWeekAgo, NOW), false);
});

test('exactly at the window boundary → not recent (strict <)', () => {
  const atBoundary = new Date(NOW - ACTIVE_WINDOW_MS).toISOString();
  assert.equal(isRecentlyActive(atBoundary, NOW), false);
});

test('missing timestamp (null) → not recent, no crash', () => {
  assert.equal(isRecentlyActive(null, NOW), false);
});

test('undefined timestamp → not recent, no crash', () => {
  assert.equal(isRecentlyActive(undefined, NOW), false);
});

test('invalid timestamp string → not recent, no crash', () => {
  assert.equal(isRecentlyActive('not-a-date', NOW), false);
});

// The active-thread and pinned-Home rules live in the component's grouping
// pass, not this pure predicate: active thread is OR'd in explicitly, and
// pinned threads (including Home) are collected before the recency check runs.
