-- Usage events tracking for API cost monitoring
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  thread_id TEXT,
  message_id TEXT,
  platform TEXT,
  mode TEXT NOT NULL,
  wake_type TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls TEXT,
  cost_usd REAL,
  duration_ms INTEGER,
  context_window INTEGER,
  context_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_thread_id ON usage_events(thread_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);
