/**
 * Recall as the optional passenger — budget + trims-first.
 *
 * After the delivery model changed (core memory rides the session CLAUDE.md,
 * not the per-message payload), recall/whisper cards ride the payload under a
 * hard budget. These tests pin the two guards in `fitRecallToCap`:
 *
 *   1. Combined recall may never exceed RECALL_BUDGET_CHARS; the whisper card
 *      yields before the noticings card.
 *   2. When the WHOLE payload would blow the delivery cap, recall trims FIRST
 *      — before the hook ever reaches for the bridge floor or the conversation
 *      middle. Recall is the passenger; the owner's message and the bridge are
 *      not.
 *
 * Pure-function tests: fitRecallToCap is deterministic and side-effect-free,
 * so this exercises the exact arithmetic the runtime runs, no HTTP harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitRecallToCap, RECALL_BUDGET_CHARS } from './runtime.js';
import { DELIVERY_CAP } from './provision.js';

test('recall budget is small — a few cards, never a payload', () => {
  // Sanity floor/ceiling: the budget must stay well under the delivery cap so
  // recall can never crowd out the bridge or the message.
  assert.ok(RECALL_BUDGET_CHARS > 0);
  assert.ok(RECALL_BUDGET_CHARS <= 12_000, 'combined recall budget must be ≤ 12K');
  assert.ok(RECALL_BUDGET_CHARS < DELIVERY_CAP / 2);
});

test('under budget and under cap — both cards ride untouched', () => {
  const whisper = 'w'.repeat(1200);
  const unfiled = 'u'.repeat(400);
  const out = fitRecallToCap(whisper, unfiled, 10_000);
  assert.equal(out.whisper, whisper);
  assert.equal(out.unfiled, unfiled);
  assert.equal(out.trimmed, 'none');
});

test('over combined budget — whisper yields first, noticings survive', () => {
  const whisper = 'w'.repeat(RECALL_BUDGET_CHARS); // alone blows the budget
  const unfiled = 'u'.repeat(500);
  const out = fitRecallToCap(whisper, unfiled, 10_000);
  assert.equal(out.whisper, '', 'whisper is the first to go');
  assert.equal(out.unfiled, unfiled, 'the smaller noticings card still fits');
  assert.equal(out.trimmed, 'budget');
});

test('over budget on both — even noticings yields when it alone exceeds budget', () => {
  const whisper = 'w'.repeat(2000);
  const unfiled = 'u'.repeat(RECALL_BUDGET_CHARS + 1);
  const out = fitRecallToCap(whisper, unfiled, 10_000);
  assert.equal(out.whisper, '');
  assert.equal(out.unfiled, '');
  assert.equal(out.trimmed, 'budget');
});

test('recall trims FIRST under cap pressure — drops whisper before the bridge', () => {
  // Base (bridge + orientation + message) is already close to the cap; the
  // whisper is what pushes it over. Recall must yield so the hook never has to
  // touch the base at all.
  const base = DELIVERY_CAP - 300;
  const whisper = 'w'.repeat(1000); // 300 headroom, whisper is 1000 → over
  const unfiled = '';
  const out = fitRecallToCap(whisper, unfiled, base);
  assert.equal(out.whisper, '', 'whisper yields to save the base');
  assert.equal(out.trimmed, 'cap');
  assert.ok(base + out.whisper.length + out.unfiled.length <= DELIVERY_CAP);
});

test('recall trims FIRST — keeps the smaller noticings card if it still fits', () => {
  // Dropping the whisper alone brings the payload back under the cap; the
  // noticings card is allowed to stay.
  const unfiled = 'u'.repeat(200);
  const base = DELIVERY_CAP - 300; // room for unfiled (200) but not +whisper
  const whisper = 'w'.repeat(1000);
  const out = fitRecallToCap(whisper, unfiled, base);
  assert.equal(out.whisper, '');
  assert.equal(out.unfiled, unfiled, 'noticings survives when it alone fits');
  assert.equal(out.trimmed, 'cap');
  assert.ok(base + out.unfiled.length <= DELIVERY_CAP);
});

test('recall trims FIRST — both yield when the base alone leaves no room', () => {
  const base = DELIVERY_CAP - 50;
  const out = fitRecallToCap('w'.repeat(1000), 'u'.repeat(1000), base);
  assert.equal(out.whisper, '');
  assert.equal(out.unfiled, '');
  assert.equal(out.trimmed, 'cap');
  assert.ok(base <= DELIVERY_CAP, 'the base itself is left for the hook to handle');
});

test('base already over cap — recall yields entirely, base untouched for the hook', () => {
  // If the base ALONE exceeds the cap (a huge recycle bridge), recall must not
  // add a single char — the bridge-floor logic downstream owns that turn.
  const base = DELIVERY_CAP + 5000;
  const out = fitRecallToCap('w'.repeat(500), 'u'.repeat(500), base);
  assert.equal(out.whisper, '');
  assert.equal(out.unfiled, '');
  assert.equal(out.trimmed, 'cap');
});
