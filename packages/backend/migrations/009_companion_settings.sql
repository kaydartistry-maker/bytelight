-- Companion settings — per (companion, tier, scope[, thread]) overrides
-- for (provider, model, thinking_effort).
--
-- byte-light-specific design (NOT from reference implementation fork). companion_id is a
-- string identifier validated at the service layer; byte-light has NO
-- `companions` table today and creating one is out of scope for P0.
-- Companion A/Companion B identity currently lives in CLAUDE.md + voice routing
-- (see services/voice.ts which already partitions by 'companion-a'/'companion-b').
--
-- Scope semantics:
--   'system'    — global default for (companion, tier). thread_id MUST be NULL.
--   'companion' — companion-wide override (currently same shape as system in
--                 the schema, but reserved for a future split where 'system'
--                 means "whole instance" and 'companion' means "this Companion A or
--                 Companion B but across all threads"). thread_id MUST be NULL.
--   'thread'    — per-thread override. thread_id MUST be NOT NULL.
--
-- Resolver priority (implemented in services/companion-resolver.ts):
--   thread > companion > system > existing agent config fallback
--
-- IF NOT EXISTS used because byte-light's migration runner re-execs every
-- file on startup (see services/db.ts ~ line 32-69). Matches the convention
-- established by 005_thread_provider_sessions.sql.

CREATE TABLE IF NOT EXISTS companion_settings (
  companion_id     TEXT NOT NULL,
  tier             TEXT NOT NULL,
  provider_id      TEXT NOT NULL,
  model_id         TEXT NOT NULL,
  thinking_effort  TEXT,
  is_default       INTEGER NOT NULL DEFAULT 0,
  scope            TEXT NOT NULL,
  thread_id        TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (scope IN ('system','companion','thread')),
  CHECK (tier IN ('interactive','autonomous','pulse','memory')),
  CHECK (
    (scope = 'thread' AND thread_id IS NOT NULL)
    OR (scope != 'thread' AND thread_id IS NULL)
  ),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

-- Lookup index for (companion, tier) scans across scopes.
CREATE INDEX IF NOT EXISTS idx_companion_settings_companion_tier_scope
  ON companion_settings (companion_id, tier, scope);

-- Lookup index for thread-scope rows. Partial would be ideal but SQLite
-- partial indexes aren't necessary at this scale; plain (scope, thread_id)
-- is fine.
CREATE INDEX IF NOT EXISTS idx_companion_settings_scope_thread
  ON companion_settings (scope, thread_id);

-- Uniqueness: no two overlapping rows for the same scope key. COALESCE on
-- thread_id collapses the NULL-thread cases (system/companion) so a single
-- index covers all three scope variants without admitting duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_companion_settings_scope_key
  ON companion_settings (companion_id, tier, scope, COALESCE(thread_id, ''));
