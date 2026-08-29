-- Memory blocks — Letta-style in-place memory editing.
-- Ported from the reference implementation fork, Apache 2.0 — adapted for byte-light.
-- Scope = 'shared' (visible to every companion) or a companion slug
-- ('companion-a', 'companion-b'). DDL ownership lives here (byte-light's canonical
-- numbered-migration pattern); the service treats CREATE as belt-and-braces.
CREATE TABLE IF NOT EXISTS memory_blocks (
  scope TEXT NOT NULL DEFAULT 'shared',
  label TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  description TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (scope, label)
);
