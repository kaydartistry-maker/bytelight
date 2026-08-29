-- Ported from the reference implementation, Apache 2.0 — schema from source services/db/init.ts:282-292.
-- DB-managed MCP server registry: name/url/api_key + discovered-tools cache.
-- IF NOT EXISTS guard REQUIRED — byte-light's migration runner re-execs every .sql
-- on every startup with no applied-migrations ledger.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  api_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  tools_cache TEXT,
  last_discovered TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
