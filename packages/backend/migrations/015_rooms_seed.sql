-- Generic roster backfill. Depends on 014_companions.sql.
--
-- Existing threads receive the two local companions. New threads are seated by
-- the roster endpoint at creation time. The public seed deliberately creates no
-- fixed rooms or deployment-specific UUIDs.

INSERT OR IGNORE INTO thread_companions (thread_id, companion_id)
  SELECT id, 'companion-a' FROM threads;

INSERT OR IGNORE INTO thread_companions (thread_id, companion_id)
  SELECT id, 'companion-b' FROM threads;
