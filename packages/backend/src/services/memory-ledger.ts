// memory-ledger.ts — a receipt for every memory write.
//
// Core memory is edited in place: a block's old content is simply gone once
// something overwrites it, and the blocks are written by several different
// lanes (the MCP tools, the CLI's sc.mjs, the memory UI, automatic extraction).
// Without receipts, "who changed this and when" is unanswerable after the fact.
// Each write appends one immutable row here — the block itself stays the live
// surface, this stays the paper trail.
//
// Receipts are advisory. A failure to record one must NEVER fail the write it
// describes; callers fire-and-forget (see memory-blocks.ts `receipt`).
//
// Ported from an reference implementation, Apache 2.0 — adapted for byte-light.
// Adaptations vs. the source:
//   (a) `getDb` imports from './db.js' — byte-light keeps its database module
//       flat, where the source had split it into './db/state.js'. Retarget
//       only; the exported `getDb` surface is identical, so no shim is needed.
//   (b) DDL ownership moved to migrations/017_memory_ledger.sql (byte-light's
//       canonical numbered-migration pattern) rather than the source's inline
//       CREATE TABLE in db init.

import { getDb } from './db.js';

export interface MemoryLedgerEntry {
  id: number;
  /** Who wrote — a lane ('mcp', 'cli', 'api', 'extraction') or 'house'. */
  actor: string;
  /** What happened, e.g. 'memory.append'. */
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  detail: string;
  metadata_json: string | null;
  seen_at: string | null;
  created_at: string;
}

/** Record one receipt. Detail is clamped to 500 chars — this is a trail, not a copy. */
export function memoryReceipt(input: {
  actor: string;
  action: string;
  subjectType?: string;
  subjectId?: string;
  detail: string;
  metadata?: Record<string, unknown>;
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO memory_ledger
    (actor, action, subject_type, subject_id, detail, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.actor,
      input.action,
      input.subjectType || null,
      input.subjectId || null,
      input.detail.slice(0, 500),
      input.metadata ? JSON.stringify(input.metadata) : null,
      new Date().toISOString()
    );
  return Number(info.lastInsertRowid);
}

/** Newest receipts first. Limit is clamped to 1..500. */
export function listMemoryLedger(limit = 100, offset = 0): MemoryLedgerEntry[] {
  return getDb()
    .prepare('SELECT * FROM memory_ledger ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(Math.min(500, Math.max(1, limit)), Math.max(0, offset)) as MemoryLedgerEntry[];
}

/** Mark everything up to `throughId` as seen. First stamp wins (COALESCE). */
export function markMemoryLedgerSeen(throughId: number): void {
  getDb()
    .prepare('UPDATE memory_ledger SET seen_at = COALESCE(seen_at, ?) WHERE id <= ?')
    .run(new Date().toISOString(), throughId);
}
