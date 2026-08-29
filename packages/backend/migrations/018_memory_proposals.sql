-- Memory proposals — the Archivist's holding area.
-- Ported from an reference implementation, Apache 2.0 — adapted for byte-light.
-- The source declared this inline in its service module; byte-light owns DDL in
-- numbered migrations, so the table lives here. Pure CREATE ... IF NOT EXISTS:
-- idempotent, safe to re-exec on every boot, no ALTER to trip a duplicate.
--
-- This table stays EMPTY until `memext.mode` is set to 'propose'. The default
-- is 'write' (the Archivist's existing straight-to-block behaviour), so the
-- migration landing changes nothing on its own.
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
);

CREATE INDEX IF NOT EXISTS idx_memory_proposals_status ON memory_proposals(status, created_at);
