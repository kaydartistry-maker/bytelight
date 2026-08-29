-- Canonical identities and open aliases for core-memory blocks.
--
-- This migration is intentionally non-destructive: memory_blocks rows are
-- neither updated nor deleted. Existing ``label — description`` ghost rows
-- are registered as aliases of the matching real block, so future writes land
-- on the canonical label while the owner decides how to handle old rows.

CREATE TABLE IF NOT EXISTS memory_block_identities (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  canonical_label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope, canonical_label)
);

CREATE TABLE IF NOT EXISTS memory_block_aliases (
  scope TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  alias TEXT NOT NULL,
  block_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(scope, alias_key),
  FOREIGN KEY(block_id) REFERENCES memory_block_identities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_block_aliases_block_id
  ON memory_block_aliases(block_id);

-- Give every non-ghost block one stable identity. A ghost is recognized by
-- structure, not by a fixed list: its label exactly equals a sibling block's
-- label plus the old lossy renderer's separator and description.
INSERT OR IGNORE INTO memory_block_identities (id, scope, canonical_label)
SELECT 'mb-' || lower(hex(randomblob(16))), b.scope, b.label
FROM memory_blocks b
WHERE NOT EXISTS (
  SELECT 1
  FROM memory_blocks canonical
  WHERE canonical.scope = b.scope
    AND canonical.description IS NOT NULL
    AND canonical.description <> ''
    AND b.label = canonical.label || ' — ' || canonical.description
);

-- Every canonical label is its own first alias. SQL can mirror the runtime's
-- whitespace/case/escaped-ampersand normalization for the historical data
-- involved here; richer Unicode normalization is applied to new writes by the
-- service.
INSERT OR IGNORE INTO memory_block_aliases (scope, alias_key, alias, block_id)
SELECT i.scope,
       lower(trim(replace(replace(replace(i.canonical_label, '&amp;', '&'), '&#38;', '&'), '&#x26;', '&'))),
       i.canonical_label,
       i.id
FROM memory_block_identities i;

-- Redirect every structurally recognized ghost spelling to the real block.
INSERT OR REPLACE INTO memory_block_aliases (scope, alias_key, alias, block_id)
SELECT ghost.scope,
       lower(trim(replace(replace(replace(ghost.label, '&amp;', '&'), '&#38;', '&'), '&#x26;', '&'))),
       ghost.label,
       identity.id
FROM memory_blocks ghost
JOIN memory_blocks canonical
  ON canonical.scope = ghost.scope
 AND canonical.description IS NOT NULL
 AND canonical.description <> ''
 AND ghost.label = canonical.label || ' — ' || canonical.description
JOIN memory_block_identities identity
  ON identity.scope = canonical.scope
 AND identity.canonical_label = canonical.label;
