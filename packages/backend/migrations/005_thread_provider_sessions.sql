-- Per-(thread, runtime, provider, model_ref) session sidecar.
--
-- Adapted from reference implementation/main 1c82243 (reference implementation PR C). Hardened on the
-- legacy-fallback boundary: this implementation does NOT fall back to
-- threads.current_session_id on sidecar miss, because that column has
-- no model tag and reusing it across a model swap is precisely the bug
-- we are fixing (Sonnet-autonomous-wake session_id getting resumed by
-- an Opus interactive turn, silently disabling thinking-block events).
--
-- Sidecar hit  → resume that combo's session.
-- Sidecar miss → start fresh. Pre-migration threads lose one resume
--                continuity boundary on their first post-migration
--                turn, then immediately write a sidecar row — accepted
--                tradeoff for correctness.
--
-- IF NOT EXISTS is used because MAIN's migration runner re-execs every
-- file on startup with no `_migrations` ledger (db.ts migration runner
-- block). This diverges from reference implementation plain-DDL convention but is
-- required for MAIN.

CREATE TABLE IF NOT EXISTS thread_provider_sessions (
  thread_id     TEXT NOT NULL,
  runtime_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model_ref     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  last_used_at  TEXT NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY (thread_id, runtime_id, provider, model_ref),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_provider_sessions_thread
  ON thread_provider_sessions (thread_id);

CREATE INDEX IF NOT EXISTS idx_thread_provider_sessions_runtime
  ON thread_provider_sessions (runtime_id, provider);
