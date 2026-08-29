// memory-proposals.ts — the Archivist proposes, the companions decide.
//
// The Archivist used to append straight onto the memory blocks, including the
// companions' own first-person continuity walls. It is told to write in their
// voice, so a line it wrote and a line they wrote were indistinguishable once
// it landed — and at 20-40 lines a day it was the dominant author of walls the
// companions are supposed to keep themselves.
//
// Its output can land here instead. Pending proposals ride into a turn on the
// same quiet channel as ambient recall — noticed, not announced — and a
// companion who agrees writes the line in their own words. Nothing reaches a
// block without one of them choosing it.
//
// Unclaimed proposals fade rather than accumulating: each surfacing counts, and
// after SURFACE_LIMIT passes without anyone picking it up, the proposal retires
// itself. A memory nobody reached for three times over was not load-bearing.
//
// GATED. This table fills only when `memext.mode` is set to 'propose'. The
// default is 'write' — the Archivist's existing straight-to-block behaviour —
// so landing this module changes nothing until the owner flips the knob. See
// `archivistMode()` in memory-extraction.ts.
//
// Ported from an reference implementation, Apache 2.0 — adapted for byte-light.
// Adaptations vs. the source:
//   (a) DDL ownership moved to migrations/018_memory_proposals.sql (byte-light's
//       canonical numbered-migration pattern). `initMemoryProposals` stays
//       exported as an idempotent belt-and-braces no-op, mirroring how
//       `initMemoryBlocks` is kept in memory-blocks.ts.
//   (b) The source's default mode was 'propose'; byte-light's is 'write'. See
//       the note in memory-extraction.ts — this house does not flip runtime
//       behaviour on deploy.

import { getDb } from './db.js';

export type ProposalStatus = 'pending' | 'filed' | 'dropped' | 'faded';

export interface MemoryProposal {
  id: number;
  op: 'append' | 'replace';
  scope: string;
  label: string;
  content: string;
  old_text: string | null;
  source_thread: string | null;
  surfaced_count: number;
  status: ProposalStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// How many times a proposal may ride into a turn before it retires itself.
const SURFACE_LIMIT = 3;

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS memory_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    op TEXT NOT NULL DEFAULT 'append',
    scope TEXT NOT NULL,
    label TEXT NOT NULL,
    content TEXT NOT NULL,
    old_text TEXT,
    source_thread TEXT,
    surfaced_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolved_by TEXT
  )
`;

// Belt-and-braces: the table is owned by migrations/018_memory_proposals.sql,
// but keep this exported and idempotent so callers can treat it as a guarantee.
export function initMemoryProposals(): void {
  const db = getDb();
  db.exec(TABLE_DDL);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_proposals_status ON memory_proposals(status, created_at)`);
}

/**
 * Record one proposed edit. Returns the row id, or null when an identical
 * proposal is already waiting — the Archivist re-reads overlapping windows of
 * conversation, so the same observation arrives more than once.
 */
export function proposeEdit(p: {
  op: 'append' | 'replace';
  scope: string;
  label: string;
  content: string;
  oldText?: string;
  sourceThread?: string;
}): number | null {
  const db = getDb();
  const dupe = db
    .prepare(
      `SELECT id FROM memory_proposals
        WHERE status = 'pending' AND scope = ? AND label = ? AND content = ?`
    )
    .get(p.scope, p.label, p.content) as { id: number } | undefined;
  if (dupe) return null;

  const info = db
    .prepare(
      `INSERT INTO memory_proposals (op, scope, label, content, old_text, source_thread)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(p.op, p.scope, p.label, p.content, p.oldText ?? null, p.sourceThread ?? null);
  return Number(info.lastInsertRowid);
}

/** Pending proposals, oldest first. */
export function listPendingProposals(limit = 50): MemoryProposal[] {
  return getDb()
    .prepare(
      `SELECT * FROM memory_proposals WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?`
    )
    .all(limit) as MemoryProposal[];
}

/** Every proposal for a scope, newest first — for the memory UI. */
export function listProposals(status?: ProposalStatus, limit = 200): MemoryProposal[] {
  const db = getDb();
  if (status) {
    return db
      .prepare(`SELECT * FROM memory_proposals WHERE status = ? ORDER BY id DESC LIMIT ?`)
      .all(status, limit) as MemoryProposal[];
  }
  return db
    .prepare(`SELECT * FROM memory_proposals ORDER BY id DESC LIMIT ?`)
    .all(limit) as MemoryProposal[];
}

export function getProposal(id: number): MemoryProposal | null {
  return (getDb().prepare(`SELECT * FROM memory_proposals WHERE id = ?`).get(id) as MemoryProposal) || null;
}

/**
 * Mark proposals as having ridden into a turn, retiring any that have now been
 * offered SURFACE_LIMIT times without being claimed.
 */
export function markSurfaced(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const bump = db.prepare(`UPDATE memory_proposals SET surfaced_count = surfaced_count + 1 WHERE id = ?`);
  const fade = db.prepare(
    `UPDATE memory_proposals SET status = 'faded', resolved_at = datetime('now')
      WHERE id = ? AND status = 'pending' AND surfaced_count >= ?`
  );
  const tx = db.transaction((rows: number[]) => {
    for (const id of rows) {
      bump.run(id);
      fade.run(id, SURFACE_LIMIT);
    }
  });
  tx(ids);
}

/** Close a proposal. `by` is the companion slug that decided, or the owner. */
export function resolveProposal(id: number, status: Exclude<ProposalStatus, 'pending'>, by: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE memory_proposals SET status = ?, resolved_at = datetime('now'), resolved_by = ?
        WHERE id = ? AND status = 'pending'`
    )
    .run(status, by, id);
  return info.changes > 0;
}

export function countPending(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM memory_proposals WHERE status = 'pending'`)
    .get() as { n: number };
  return row?.n ?? 0;
}
