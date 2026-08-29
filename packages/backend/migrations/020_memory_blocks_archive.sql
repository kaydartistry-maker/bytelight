-- Lossless cold home for core-memory text moved out of always-carried blocks.
CREATE TABLE IF NOT EXISTS memory_blocks_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  ledger_receipt_id INTEGER NOT NULL,
  archived_at TEXT NOT NULL,
  FOREIGN KEY (ledger_receipt_id) REFERENCES memory_ledger(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_blocks_archive_block
  ON memory_blocks_archive(scope, label, archived_at DESC);
