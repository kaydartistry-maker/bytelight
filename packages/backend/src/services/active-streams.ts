/**
 * Active-stream registry — reconnect catch-up for in-flight agent turns.
 *
 * Problem (live-repro'd 2026-07-22): the Codex lane buffers its final text
 * to turn-end by contract, so a turn's visible life is stream_start + tool
 * chips + thinking events. `stream_start` is broadcast exactly once, and the
 * frontend store gates ALL streaming events on having seen it. A mobile
 * websocket that reconnects mid-turn (Android churn) therefore silently
 * drops every subsequent event — the operator watches a dead screen while
 * the turn works.
 *
 * Fix: the agent turn loop registers its in-flight stream here the moment
 * `stream_start` is broadcast, and unregisters in its `finally`. The ws
 * connection handler replays the current snapshot to every NEWLY connected
 * socket (single-client send, not broadcast) using the exact same message
 * shapes the live loop broadcasts — the frontend rebuilds state with no
 * protocol changes.
 *
 * Single-user sovereign system: a module-scoped Map keyed by threadId is
 * the whole registry. No TTLs, no eviction machinery — lifecycle is owned
 * by the turn's try/finally in agent.ts.
 */

import type { ThoughtKind } from '@bytelight/shared';

// Structural mirrors of ToolInsertion (hooks.ts:38) and ThinkingInsertion
// (agent.ts:495). Declared structurally here so this module has no import
// edge back into agent.ts/hooks.ts (agent.ts imports us; keep the graph
// acyclic). Only @bytelight/shared is imported — same direction as agent.ts.
export interface ActiveToolInsertion {
  textOffset: number;
  toolId: string;
  toolName: string;
  input?: string;
  output?: string;
  isError?: boolean;
}

export interface ActiveThinkingInsertion {
  textOffset: number;
  content: string;
  summary: string;
  kind?: ThoughtKind;
}

export interface ActiveStreamSnapshot {
  messageId: string;
  threadId: string;
  /** Cumulative response text so far (empty until turn-end on the Codex lane). */
  fullResponse: string;
  toolInsertions: ActiveToolInsertion[];
  thinkingBlocks: ActiveThinkingInsertion[];
}

const activeStreams = new Map<string, () => ActiveStreamSnapshot>();

/**
 * Register an in-flight turn. `getSnapshot` is a closure over the turn
 * loop's live locals (fullResponse, toolInsertions, thinkingBlocks) so
 * every read reflects the current state — including the compaction reset
 * path that truncates those arrays in place.
 */
export function registerActiveStream(threadId: string, getSnapshot: () => ActiveStreamSnapshot): void {
  activeStreams.set(threadId, getSnapshot);
}

/** Unregister on turn end (call from the turn's `finally`). */
export function unregisterActiveStream(threadId: string): void {
  activeStreams.delete(threadId);
}

/** Snapshot every in-flight stream (for replay to a new connection). */
export function getActiveStreamSnapshots(): ActiveStreamSnapshot[] {
  const snapshots: ActiveStreamSnapshot[] = [];
  for (const getSnapshot of activeStreams.values()) {
    try {
      snapshots.push(getSnapshot());
    } catch (err) {
      // A throwing snapshot must never break the connection handshake.
      console.warn('[ActiveStreams] snapshot failed:', (err as Error).message);
    }
  }
  return snapshots;
}

/** Test/introspection helper. */
export function hasActiveStream(threadId: string): boolean {
  return activeStreams.has(threadId);
}
