-- Add companion_id to usage_events for per-companion cost attribution.
--
-- Nullable so existing rows stay valid. Call sites populate where context
-- knows the companion (autonomous wakes, pulse paths). Interactive paths
-- may pass NULL for now — the column lives on the row so we can backfill
-- without another migration. See services/companion-resolver.ts for the
-- forward path that will surface companion_id more reliably once wired.
--
-- byte-light's migration runner (services/db.ts) wraps individual ALTER
-- TABLE attempts in try/catch around "duplicate column" errors so the
-- migration is idempotent across restarts. Mirroring that pattern with
-- inline DDL here would require teaching the runner this file is OK to
-- skip on duplicates; instead, the runner block for this file uses the
-- same try/catch shape (see services/db.ts).

ALTER TABLE usage_events ADD COLUMN companion_id TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_events_companion_id ON usage_events(companion_id);
