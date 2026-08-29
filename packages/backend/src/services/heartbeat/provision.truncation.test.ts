/**
 * Bridge-floor truncation tests — Slice A "the delivery fix".
 *
 * Exercises BOTH sides of the shared truncation definition:
 *   • the hook's `truncateContent` (extracted from the generated HOOK_SOURCE
 *     string, so the code under test is the exact code the session runs), and
 *   • `measureDelivery`, the backend mirror — asserting the two agree on
 *     delivered size and never drift apart.
 *
 * The floor invariant under test: the recycle bridge (cross-thread
 * continuity) is never compressed below BRIDGE_FLOOR while any other
 * compressible content remains; only when the fixed content ALONE exceeds
 * DELIVERY_CAP may it shrink further (bridge-minimal breadcrumb).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERY_CAP,
  BRIDGE_FLOOR,
  BRIDGE_HEAD_MARK,
  BRIDGE_TAIL_MARK,
  measureDelivery,
  __TEST_HOOK_SOURCES__,
} from './provision.js';
import { stripCoreMemoryFromOrientation } from './runtime.js';

// ─── Extract the hook's truncateContent (the real on-disk code) ─────────

function hookTruncate(): (content: string) => string {
  const src = __TEST_HOOK_SOURCES__.heartbeatHook;
  const start = src.indexOf('const DELIVERY_CAP');
  const end = src.indexOf('function formatMessage');
  assert.ok(start !== -1 && end > start, 'hook source shape changed — update the extractor');
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, end)}\nreturn truncateContent;`)() as (c: string) => string;
}

const truncateContent = hookTruncate();

// ─── Payload builders ───────────────────────────────────────────────────

function makeBridge(bodyChars: number): string {
  return `${BRIDGE_HEAD_MARK}\n${'h'.repeat(bodyChars)}\n${BRIDGE_TAIL_MARK}`;
}

const OWNER_MSG = 'OWNER-MESSAGE-TAIL: are you still with me in this thread?';

function makePayload(bridgeBody: number, orientationChars: number): string {
  const orientation = orientationChars > 0
    ? `[Context]\n${'o'.repeat(orientationChars)}\n[/Context]\n\n`
    : '';
  return `${makeBridge(bridgeBody)}\n${orientation}${OWNER_MSG}`;
}

/** Span of the surviving bridge (head mark through tail mark) in the output. */
function bridgeSpan(out: string): number {
  const h = out.indexOf(BRIDGE_HEAD_MARK);
  const t = out.indexOf(BRIDGE_TAIL_MARK);
  if (h === -1 || t <= h) return 0;
  return t + BRIDGE_TAIL_MARK.length - h;
}

// ─── Cases ──────────────────────────────────────────────────────────────

test('under cap — delivered whole, mirror agrees', () => {
  const content = makePayload(10_000, 5_000);
  assert.ok(content.length <= DELIVERY_CAP);
  assert.equal(truncateContent(content), content);
  const m = measureDelivery(content);
  assert.equal(m.stage, 'none');
  assert.equal(m.deliveredChars, content.length);
});

test('big bridge, small fixed — bridge trimmed but stays >= floor', () => {
  const content = makePayload(180_000, 5_000); // bridge is the overflow
  const out = truncateContent(content);
  assert.ok(out.length <= DELIVERY_CAP, `over cap: ${out.length}`);
  assert.ok(out.endsWith(OWNER_MSG), 'owner message tail must survive');
  assert.ok(bridgeSpan(out) >= BRIDGE_FLOOR, `bridge span ${bridgeSpan(out)} < floor`);
  const m = measureDelivery(content);
  assert.equal(m.stage, 'bridge');
  assert.equal(m.deliveredChars, out.length, 'mirror drifted from hook');
});

test('memory-bloat shape: huge fixed mass — bridge held at floor, middle cut instead', () => {
  // Pre-fix, a ~130K orientation squeezed the bridge to ~20K. Now the bridge
  // holds the floor and the orientation middle pays instead.
  const content = makePayload(60_000, 130_000);
  const out = truncateContent(content);
  assert.ok(out.length <= DELIVERY_CAP, `over cap: ${out.length}`);
  assert.ok(out.endsWith(OWNER_MSG), 'owner message tail must survive');
  const span = bridgeSpan(out);
  assert.ok(span >= BRIDGE_FLOOR, `bridge span ${span} < floor ${BRIDGE_FLOOR}`);
  const m = measureDelivery(content);
  assert.equal(m.stage, 'bridge-floor');
  assert.ok(m.middleDropped > 0, 'the non-bridge middle mass should pay');
  assert.equal(m.deliveredChars, out.length, 'mirror drifted from hook');
});

test('bridge smaller than floor, huge fixed — bridge kept whole, middle cut', () => {
  const content = makePayload(20_000, 140_000);
  const out = truncateContent(content);
  assert.ok(out.length <= DELIVERY_CAP);
  assert.ok(out.endsWith(OWNER_MSG));
  // Bridge under the floor is never trimmed at all in the floor branch.
  const span = bridgeSpan(out);
  const originalSpan = makeBridge(20_000).length;
  assert.equal(span, originalSpan, 'a bridge under the floor must ride whole');
  const m = measureDelivery(content);
  assert.equal(m.stage, 'bridge-floor');
  assert.equal(m.bridgeDropped, 0);
  assert.equal(m.deliveredChars, out.length, 'mirror drifted from hook');
});

test('fixed alone exceeds cap — last resort: bridge below floor is allowed', () => {
  const content = makePayload(50_000, 170_000); // fixed > DELIVERY_CAP by itself
  const out = truncateContent(content);
  assert.ok(out.length <= DELIVERY_CAP);
  assert.ok(out.endsWith(OWNER_MSG), 'owner message tail must survive even here');
  const m = measureDelivery(content);
  assert.ok(m.stage === 'bridge-minimal' || m.stage === 'middle', `unexpected stage ${m.stage}`);
  assert.equal(m.deliveredChars, out.length, 'mirror drifted from hook');
});

test('no bridge, over cap — stage-2 middle cut, tail survives', () => {
  const content = `${'x'.repeat(DELIVERY_CAP + 30_000)}${OWNER_MSG}`;
  const out = truncateContent(content);
  assert.ok(out.length <= DELIVERY_CAP);
  assert.ok(out.endsWith(OWNER_MSG));
  const m = measureDelivery(content);
  assert.equal(m.stage, 'middle');
  assert.equal(m.deliveredChars, out.length, 'mirror drifted from hook');
});

// ─── Core-memory strip (blocks ride CLAUDE.md, not the payload) ─────────

test('stripCoreMemoryFromOrientation removes the span and counts it', () => {
  const mem = `\n<core-memory>\n## [shared] human\nName: the operator\n</core-memory>\n`;
  const orientation = `Time: 12:00\n${mem}\nCHAT TOOLS: ...`;
  const { text, stripped } = stripCoreMemoryFromOrientation(orientation);
  assert.ok(!text.includes('<core-memory>'));
  assert.ok(!text.includes('</core-memory>'));
  assert.ok(text.includes('Time: 12:00'));
  assert.ok(text.includes('CHAT TOOLS: ...'));
  const expectedSpan =
    orientation.indexOf('</core-memory>') + '</core-memory>'.length - orientation.indexOf('<core-memory>');
  assert.equal(stripped, expectedSpan);
});

test('stripCoreMemoryFromOrientation is a pass-through without a span', () => {
  const orientation = 'Time: 12:00\nCHAT TOOLS: ...';
  const { text, stripped } = stripCoreMemoryFromOrientation(orientation);
  assert.equal(text, orientation);
  assert.equal(stripped, 0);
});
