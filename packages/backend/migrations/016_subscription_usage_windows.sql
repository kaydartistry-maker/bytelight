-- Latest persisted subscription/rate-limit standing for each provider lane.
-- One row per (lane, window) keeps routine Codex token-count telemetry bounded
-- while retaining the freshest state across backend restarts.
CREATE TABLE IF NOT EXISTS subscription_usage_windows (
  lane TEXT NOT NULL,
  window_key TEXT NOT NULL,
  used_percent REAL NOT NULL,
  window_minutes INTEGER,
  resets_at TEXT,
  captured_at TEXT NOT NULL,
  metadata TEXT,
  PRIMARY KEY (lane, window_key)
);

CREATE INDEX IF NOT EXISTS idx_subscription_usage_windows_captured_at
  ON subscription_usage_windows(captured_at);

