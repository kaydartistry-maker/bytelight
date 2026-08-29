-- Adapted for byte-light under Apache 2.0 (generic multi-actor).
-- starred_by is generic TEXT (no CHECK cage): 'user' (human default), 'companion-a', 'companion-b', 'companion-c',
-- and any future companion slug — no migration required to add actors.
CREATE TABLE IF NOT EXISTS starred_messages (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  starred_by TEXT NOT NULL,
  starred_at TEXT NOT NULL,
  note TEXT,
  FOREIGN KEY (message_id) REFERENCES messages(id),
  UNIQUE(message_id, starred_by)
);

CREATE INDEX IF NOT EXISTS idx_starred_by_at ON starred_messages(starred_by, starred_at DESC);
CREATE INDEX IF NOT EXISTS idx_starred_message ON starred_messages(message_id);
