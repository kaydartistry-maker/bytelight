/**
 * Idle outbox watcher tests (heartbeat lane).
 *
 * Pins the fix for the July 22 "operator was the delivery mechanism"
 * incident: outbox lines written OUTSIDE any turn (background-task findings)
 * must be delivered proactively, exactly once, without waiting for the next
 * operator message.
 *
 *   1. classifyOutboxLines — the single classifier shared by the turn-start
 *      sweep and the idle watcher: late-reply ledger rules are unchanged
 *      (matching turn_id resolves it; id-less lines answer the oldest owed
 *      turn), not-owed content lines are `proactive` deliveries, and
 *      silent-sentinels / non-JSON / content-less lines never post.
 *   2. idleWatchTick race safety — one consumer at a time on the shared
 *      consumedOffset: no double delivery across ticks, no reads while a
 *      turn is active or a delivery is in flight, offset clamp on a
 *      truncated outbox.
 *   3. Chunk grace — a batch ending `more:true` is held (one reply, one
 *      message), delivered whole once the final chunk lands, or partially
 *      after the grace window expires.
 *
 * The delivery function is stubbed via __setIdleDeliveryForTests so no DB,
 * websocket registry, or live claude session is needed; the tick still runs
 * against a real on-disk outbox under data/heartbeat/<test key>/.
 *
 * Run with:
 *   npx tsx --test packages/backend/src/services/heartbeat/runtime.idle-watcher.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.CLAUDE_CLI_HEARTBEAT_ENABLED = 'true';

import {
  __TEST_INTERNALS__,
  __resetLaneStateForTests,
  __setIdleDeliveryForTests,
  __getLaneStateForTests,
  __bindLaneForTests,
  type OutboxDelivery,
} from './runtime.js';
import { getHeartbeatSession, shutdownAllHeartbeats } from './supervisor.js';

const { classifyOutboxLines, idleWatchTick, IDLE_MORE_GRACE_MS } = __TEST_INTERNALS__;

const KEY = 'idle-watch-test';
const THREAD = 'thread-under-test';

// ─── classifyOutboxLines (pure) ──────────────────────────────────────

test('late reply: matching turn_id resolves the ledger entry', () => {
  const out = classifyOutboxLines(
    [JSON.stringify({ turn_id: 't1', content: 'late answer', thinking: 'notes' })],
    ['t1', 't2'],
  );
  assert.equal(out.deliveries.length, 1);
  assert.equal(out.deliveries[0].kind, 'late');
  assert.equal(out.deliveries[0].content, 'late answer');
  assert.equal(out.deliveries[0].thinking, 'notes');
  assert.deepEqual(out.unresolved, ['t2']);
});

test('id-less line answers the oldest owed turn (sweep parity)', () => {
  const out = classifyOutboxLines(
    [JSON.stringify({ content: 'who am I answering' })],
    ['oldest', 'newer'],
  );
  assert.equal(out.deliveries.length, 1);
  assert.equal(out.deliveries[0].kind, 'late');
  assert.deepEqual(out.unresolved, ['newer']);
});

test('not-owed lines are proactive deliveries — the July 22 shape', () => {
  // turn_id of a turn that completed cleanly (not on the ledger) — this is
  // exactly what background-task findings look like.
  const owedElsewhere = classifyOutboxLines(
    [JSON.stringify({ turn_id: 'completed-turn', content: 'agent findings' })],
    [],
  );
  assert.equal(owedElsewhere.deliveries.length, 1);
  assert.equal(owedElsewhere.deliveries[0].kind, 'proactive');
  assert.deepEqual(owedElsewhere.unresolved, []);

  // No turn_id, empty ledger — also proactive, not dropped.
  const idLess = classifyOutboxLines([JSON.stringify({ content: 'follow-up' })], []);
  assert.equal(idLess.deliveries.length, 1);
  assert.equal(idLess.deliveries[0].kind, 'proactive');
});

test('silent sentinels, non-JSON, and content-less lines never post', () => {
  const out = classifyOutboxLines(
    [
      JSON.stringify({ turn_id: 't1', silent: true }),
      'not json at all',
      JSON.stringify({ turn_id: 't1' }),
      JSON.stringify({ turn_id: 't1', content: '' }),
      // Malformed sentinel that carries content: still intentional silence.
      JSON.stringify({ turn_id: 't1', silent: true, content: 'oops' }),
    ],
    ['t1'],
  );
  assert.equal(out.deliveries.length, 0);
  // Nothing consumed the ledger either.
  assert.deepEqual(out.unresolved, ['t1']);
});

test('endsWithMore reflects the last deliverable line', () => {
  const midFlight = classifyOutboxLines(
    [
      JSON.stringify({ content: 'chunk 1', more: true }),
      'garbage trailing line',
    ],
    [],
  );
  assert.equal(midFlight.endsWithMore, true);

  const complete = classifyOutboxLines(
    [
      JSON.stringify({ content: 'chunk 1', more: true }),
      JSON.stringify({ content: 'chunk 2' }),
    ],
    [],
  );
  assert.equal(complete.endsWithMore, false);
  assert.equal(complete.deliveries.length, 2);
});

// ─── idleWatchTick (fs-backed, stubbed delivery) ─────────────────────

interface Captured {
  key: string;
  threadId: string;
  deliveries: readonly OutboxDelivery[];
}

let captured: Captured[] = [];
let sessionDir = '';
let outboxPath = '';

function stubDelivery(): void {
  __setIdleDeliveryForTests(async (key, threadId, deliveries) => {
    captured.push({ key, threadId, deliveries });
  });
}

function freshLane() {
  __resetLaneStateForTests();
  stubDelivery();
  rmSync(sessionDir, { recursive: true, force: true });
  mkdirSync(join(sessionDir, 'io'), { recursive: true });
  captured = [];
  // Bind BEFORE any outbox writes so the lane's initial consumedOffset is 0.
  return __bindLaneForTests(KEY, THREAD);
}

function appendOutbox(line: Record<string, unknown>): void {
  appendFileSync(outboxPath, JSON.stringify(line) + '\n', 'utf8');
}

before(() => {
  const session = getHeartbeatSession(KEY);
  sessionDir = session.dir;
  outboxPath = session.outboxPath;
});

after(() => {
  __resetLaneStateForTests();
  shutdownAllHeartbeats();
  rmSync(sessionDir, { recursive: true, force: true });
});

beforeEach(() => {
  freshLane();
});

test('watcher delivers an out-of-turn line exactly once — no re-delivery on later ticks', async () => {
  const state = __getLaneStateForTests(KEY)!;
  appendOutbox({ turn_id: 'done-turn', content: 'background findings' });

  idleWatchTick();
  await state.idleDelivery;
  assert.equal(captured.length, 1);
  assert.equal(captured[0].threadId, THREAD);
  assert.equal(captured[0].deliveries.length, 1);
  assert.equal(captured[0].deliveries[0].kind, 'proactive');
  assert.equal(captured[0].deliveries[0].content, 'background findings');

  // The offset moved with the delivery — later ticks (and a later turn-start
  // sweep, which reads from the same consumedOffset) see nothing.
  idleWatchTick();
  idleWatchTick();
  assert.equal(captured.length, 1);
});

test('watcher stands down while a turn is active, resumes after', async () => {
  const state = __getLaneStateForTests(KEY)!;
  appendOutbox({ content: 'written mid-turn-window' });

  state.turnActive = true;
  idleWatchTick();
  assert.equal(captured.length, 0);
  assert.equal(state.idleDelivery, null);

  state.turnActive = false;
  idleWatchTick();
  await state.idleDelivery;
  assert.equal(captured.length, 1);
});

test('watcher never starts a second read while a delivery is in flight', async () => {
  const state = __getLaneStateForTests(KEY)!;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const batches: (readonly OutboxDelivery[])[] = [];
  __setIdleDeliveryForTests(async (_key, _threadId, deliveries) => {
    batches.push(deliveries);
    await gate; // delivery hangs until we say so
  });

  appendOutbox({ content: 'first batch' });
  idleWatchTick();
  assert.equal(batches.length, 1);
  assert.notEqual(state.idleDelivery, null);

  // New bytes land while delivery is still in flight — the tick must skip
  // the lane entirely (in-flight guard), not read ahead.
  appendOutbox({ content: 'second batch' });
  idleWatchTick();
  assert.equal(batches.length, 1);

  release();
  await state.idleDelivery;
  assert.equal(state.idleDelivery, null);

  // Once drained, the next tick picks up exactly the unread bytes.
  idleWatchTick();
  await state.idleDelivery;
  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, 1);
  assert.equal(batches[1][0].content, 'second batch');
});

test('chunked reply mid-flight is held, then delivered whole as one batch', async () => {
  const state = __getLaneStateForTests(KEY)!;
  appendOutbox({ turn_id: 'x', content: 'part one', more: true });

  idleWatchTick();
  assert.equal(captured.length, 0, 'holding for the final chunk');
  assert.notEqual(state.idleHoldSince, null);

  appendOutbox({ turn_id: 'x', content: 'part two' });
  idleWatchTick();
  await state.idleDelivery;
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].deliveries.map((d) => d.content), ['part one', 'part two']);
  assert.equal(state.idleHoldSince, null);
});

test('chunk hold gives up after the grace window and delivers the partial reply', async () => {
  const state = __getLaneStateForTests(KEY)!;
  appendOutbox({ content: 'ack, still working…', more: true });

  idleWatchTick();
  assert.equal(captured.length, 0);

  // Simulate the grace window expiring.
  state.idleHoldSince = Date.now() - IDLE_MORE_GRACE_MS - 1;
  idleWatchTick();
  await state.idleDelivery;
  assert.equal(captured.length, 1);
  assert.equal(captured[0].deliveries[0].content, 'ack, still working…');
});

test('truncated outbox clamps the offset instead of reading garbage', () => {
  const state = __getLaneStateForTests(KEY)!;
  appendOutbox({ content: 'about to vanish' });
  state.consumedOffset = 10_000; // stale offset far past the real file
  writeFileSync(outboxPath, '', 'utf8');

  idleWatchTick();
  assert.equal(captured.length, 0);
  assert.equal(state.consumedOffset, 0);
});

test('late replies to timed-out turns deliver from idle too, resolving the ledger', async () => {
  const state = __getLaneStateForTests(KEY)!;
  state.unresolved = ['timed-out-turn'];
  appendOutbox({ turn_id: 'timed-out-turn', content: 'sorry, took a while', thinking: 'ran long' });

  idleWatchTick();
  await state.idleDelivery;
  assert.equal(captured.length, 1);
  assert.equal(captured[0].deliveries[0].kind, 'late');
  assert.equal(captured[0].deliveries[0].thinking, 'ran long');
  assert.deepEqual(state.unresolved, []);
});

test('unbound lane (no turn ever routed) is skipped', () => {
  const state = __getLaneStateForTests(KEY)!;
  state.boundThreadId = null;
  appendOutbox({ content: 'nowhere to go' });

  idleWatchTick();
  assert.equal(captured.length, 0);
});
