/**
 * Active-stream registry contract tests (Codex lane visibility slice).
 *
 * Pins the reconnect catch-up registry's lifecycle and snapshot semantics:
 *
 *   1. register → hasActiveStream true; unregister → false (the agent
 *      turn's finally owns the unregister).
 *   2. Snapshots are LIVE: the getSnapshot closure reads the turn loop's
 *      locals at call time, so tool insertions / thinking blocks / text
 *      that land AFTER registration show up in later snapshots — including
 *      completion fields (output/isError) mutated onto an existing
 *      insertion, and the compaction reset that truncates in place.
 *   3. Multiple concurrent threads each replay their own stream.
 *   4. A throwing snapshot is skipped, never thrown to the caller (the ws
 *      handshake must survive a bad snapshot).
 *
 * The ws-level replay wiring (ws.ts connection handler) is exercised by
 * hand on the smoke card — createWebSocketServer needs a full HTTP/auth
 * bootstrap that the unit harness doesn't carry.
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerActiveStream,
  unregisterActiveStream,
  getActiveStreamSnapshots,
  hasActiveStream,
  type ActiveStreamSnapshot,
  type ActiveToolInsertion,
  type ActiveThinkingInsertion,
} from './active-streams.js';

const THREAD_A = 'thread-a';
const THREAD_B = 'thread-b';

afterEach(() => {
  // Module-scoped Map — always leave it clean for the next test.
  unregisterActiveStream(THREAD_A);
  unregisterActiveStream(THREAD_B);
});

describe('active-streams registry', () => {
  test('registers on turn start and unregisters on finalize', () => {
    assert.equal(hasActiveStream(THREAD_A), false);
    registerActiveStream(THREAD_A, () => ({
      messageId: 'msg-1',
      threadId: THREAD_A,
      fullResponse: '',
      toolInsertions: [],
      thinkingBlocks: [],
    }));
    assert.equal(hasActiveStream(THREAD_A), true);
    assert.equal(getActiveStreamSnapshots().length, 1);

    unregisterActiveStream(THREAD_A);
    assert.equal(hasActiveStream(THREAD_A), false);
    assert.equal(getActiveStreamSnapshots().length, 0);
  });

  test('snapshot is live — carries tool insertions and text added after registration', () => {
    // Mirrors the agent turn loop: locals mutate, closure reads them fresh.
    let fullResponse = '';
    const toolInsertions: ActiveToolInsertion[] = [];
    const thinkingBlocks: ActiveThinkingInsertion[] = [];
    registerActiveStream(THREAD_A, () => ({
      messageId: 'msg-2',
      threadId: THREAD_A,
      fullResponse,
      toolInsertions,
      thinkingBlocks,
    }));

    // Snapshot before any activity: empty.
    let [snap] = getActiveStreamSnapshots();
    assert.equal(snap.toolInsertions.length, 0);
    assert.equal(snap.fullResponse, '');

    // Turn does work: tool starts, then completes; thinking lands; text lands.
    toolInsertions.push({ textOffset: 0, toolId: 't1', toolName: 'Bash', input: 'ls' });
    thinkingBlocks.push({ textOffset: 0, content: 'pondering', summary: 'pondering' });
    [snap] = getActiveStreamSnapshots();
    assert.equal(snap.toolInsertions.length, 1);
    assert.equal(snap.toolInsertions[0].output, undefined, 'tool not yet complete');
    assert.equal(snap.thinkingBlocks.length, 1);

    toolInsertions[0].output = 'file.txt';
    toolInsertions[0].isError = false;
    fullResponse = 'Here is what I found';
    [snap] = getActiveStreamSnapshots();
    assert.equal(snap.toolInsertions[0].output, 'file.txt', 'completion mutates through');
    assert.equal(snap.toolInsertions[0].isError, false);
    assert.equal(snap.fullResponse, 'Here is what I found');

    // Compaction reset truncates in place — snapshot follows.
    toolInsertions.length = 0;
    thinkingBlocks.length = 0;
    fullResponse = '';
    [snap] = getActiveStreamSnapshots();
    assert.equal(snap.toolInsertions.length, 0);
    assert.equal(snap.fullResponse, '');
  });

  test('concurrent threads snapshot independently', () => {
    registerActiveStream(THREAD_A, () => ({
      messageId: 'msg-a', threadId: THREAD_A, fullResponse: 'a',
      toolInsertions: [], thinkingBlocks: [],
    }));
    registerActiveStream(THREAD_B, () => ({
      messageId: 'msg-b', threadId: THREAD_B, fullResponse: 'b',
      toolInsertions: [], thinkingBlocks: [],
    }));
    const snaps = getActiveStreamSnapshots();
    assert.equal(snaps.length, 2);
    const byThread = new Map(snaps.map((s: ActiveStreamSnapshot) => [s.threadId, s]));
    assert.equal(byThread.get(THREAD_A)?.messageId, 'msg-a');
    assert.equal(byThread.get(THREAD_B)?.messageId, 'msg-b');
  });

  test('re-registering a thread replaces its snapshot (stale-session retry path)', () => {
    registerActiveStream(THREAD_A, () => ({
      messageId: 'msg-old', threadId: THREAD_A, fullResponse: '',
      toolInsertions: [], thinkingBlocks: [],
    }));
    registerActiveStream(THREAD_A, () => ({
      messageId: 'msg-new', threadId: THREAD_A, fullResponse: '',
      toolInsertions: [], thinkingBlocks: [],
    }));
    const snaps = getActiveStreamSnapshots();
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].messageId, 'msg-new');
  });

  test('a throwing snapshot is skipped, not thrown', () => {
    registerActiveStream(THREAD_A, () => { throw new Error('boom'); });
    registerActiveStream(THREAD_B, () => ({
      messageId: 'msg-ok', threadId: THREAD_B, fullResponse: '',
      toolInsertions: [], thinkingBlocks: [],
    }));
    const snaps = getActiveStreamSnapshots();
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].messageId, 'msg-ok');
  });
});
