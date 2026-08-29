-- Phase 2 Step 3 — multi-provider usage attribution.
--
-- Adds provider/runtime/model_ref columns to usage_events so per-turn
-- billing can attribute back to (ProviderId, RuntimeId, canonical ModelRef)
-- once non-Claude runtimes start firing the recordUsageEvent path.
--
-- All columns are nullable and additive — existing rows backfill as NULL.
-- companion_id was added in migration 008 (Phase 2 P0 foundation patch).
--
-- byte-light's migration runner (services/db.ts) wraps ALTER TABLE in
-- try/catch around "duplicate column" errors so this stays idempotent
-- across restarts, matching the pattern used for 008.
--
-- Column meanings:
--   provider   — ProviderId from @bytelight/shared/model-manifest
--                ('claude' | 'openai-codex' | 'openrouter' | 'ollama').
--   runtime    — RuntimeId from @bytelight/shared/model-manifest
--                ('claude-sdk' | 'codex' | 'openai-compat' | 'ollama-native').
--   model_ref  — Canonical provider-qualified ref, e.g. 'claude/claude-sonnet-4-6'
--                or 'ollama/gpt-oss:120b'. Distinct from the existing `model`
--                column (which keeps raw provider-native id for back-compat
--                with cost-attribution scripts that don't yet parse refs).

ALTER TABLE usage_events ADD COLUMN provider TEXT;
ALTER TABLE usage_events ADD COLUMN runtime TEXT;
ALTER TABLE usage_events ADD COLUMN model_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider);
CREATE INDEX IF NOT EXISTS idx_usage_events_runtime ON usage_events(runtime);
