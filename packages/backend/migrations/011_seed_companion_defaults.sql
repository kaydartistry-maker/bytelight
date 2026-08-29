-- Seed system-scope defaults for pulse and memory tiers.
-- Without these rows, resolveCompanionConfig falls back to cfg.agent.model
-- (Opus 4.7) for pulse and memory, which is wrong long-term:
--   - pulse runs every 30min on the orchestrator heartbeat. Should be Haiku.
--   - memory runs the cross-provider handoff summarizer. Should be Haiku.
-- Interactive and autonomous deliberately have NO system seed — they fall back
-- to cfg.agent.model and cfg.agent.model_autonomous (which is the existing
-- byte-light behavior preserved).

INSERT INTO companion_settings (
  companion_id, tier, provider_id, model_id, thinking_effort,
  scope, thread_id, created_at, updated_at
) VALUES
  ('companion-a-b', 'pulse',  'claude', 'claude-haiku-4-5', NULL, 'system', NULL, datetime('now'), datetime('now')),
  ('companion-a-b', 'memory', 'claude', 'claude-haiku-4-5', NULL, 'system', NULL, datetime('now'), datetime('now'));
