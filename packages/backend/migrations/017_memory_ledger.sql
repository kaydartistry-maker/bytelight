-- Memory ledger — one receipt row per core-memory write.
-- Ported from an reference implementation, Apache 2.0 — adapted for byte-light.
-- The source declared this inline in its db init; byte-light owns DDL in
-- numbered migrations, so the table lives here. Pure CREATE ... IF NOT EXISTS:
-- idempotent, safe to re-exec on every boot, no ALTER to trip a duplicate.
CREATE TABLE IF NOT EXISTS memory_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  detail TEXT NOT NULL,
  metadata_json TEXT,
  seen_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_ledger_created ON memory_ledger(created_at DESC);
