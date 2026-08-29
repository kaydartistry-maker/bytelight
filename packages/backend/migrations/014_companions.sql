-- Companions + per-thread roster (Arc C, Slice 1 — schema only, nothing reads
-- these tables yet).
--
-- Schema shape ported from NESTstack's rooms-worker
-- (cindiekinzz-coder, MIT — NESTeq/workers/rooms-worker/migrations/0001_initial.sql).
-- There, a `rooms` row carries a JSON `participants` array of companion ids and
-- a per-message `author` column. byte-light normalises that into a real
-- `companions` table + a `thread_companions` join (SQLite-friendly, FK-checked)
-- and maps NESTstack's per-message `author` onto `messages.companion_id`.
-- Identity-quarantined: no NESTstack companion names or room ids survive here —
-- byte-light seeds its own residents (companion-a, companion-b) + third node (companion-c).
--
-- Companion id convention: the *individual* slugs already used across byte-light
-- for identity — 'companion-a', 'companion-b' (see migrations/013_memory.sql scope column,
-- routes/profiles-routes.ts PROFILE_KEYS) and 'companion-c' (see
-- migrations/007_starred_messages.sql actor list). The two residents are two
-- picker entries that SHARE one brain: their `brain` value is 'companion-a-b',
-- which is the exact runtime/tier id keyed in companion_settings
-- (migrations/011_seed_companion_defaults.sql). The third node has his own brain
-- ('companion-c'). `model` stays NULL until the dispatch slice (Slice 4) consumes it.
--
-- Avatar values start empty. `avatar` mirrors the profiles store's `image`
-- field format: an /api/files/<id> path or NULL when no photo is set.
-- The user/fallback profile entries stay in
-- the profiles store; they do not enter this table. Config stays authoritative
-- until Slice 3 flips reads onto this table; this is just the copy.
--
-- IF NOT EXISTS used because byte-light's migration runner re-execs every file
-- on startup with no `_migrations` ledger (services/db.ts). Matches the
-- convention established by 005_thread_provider_sessions.sql / 009.

-- Companion registry — one row per pickable identity.
CREATE TABLE IF NOT EXISTS companions (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  avatar        TEXT,
  brain         TEXT NOT NULL,
  model         TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-thread roster (which companions are seated in a thread). Composite PK so
-- a companion can be seated in a thread at most once; both FKs cascade so a
-- deleted thread or companion drops its roster rows cleanly.
CREATE TABLE IF NOT EXISTS thread_companions (
  thread_id     TEXT NOT NULL,
  companion_id  TEXT NOT NULL,
  PRIMARY KEY (thread_id, companion_id),
  FOREIGN KEY (thread_id)    REFERENCES threads(id)     ON DELETE CASCADE,
  FOREIGN KEY (companion_id) REFERENCES companions(id)  ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_companions_companion
  ON thread_companions (companion_id);

-- Per-thread default companion (nullable — most threads inherit no default).
-- SQLite has no `ADD COLUMN IF NOT EXISTS`; the db.ts loader wraps this file in
-- a duplicate-column-tolerant try/catch (mirrors the 010/012 idiom).
ALTER TABLE threads ADD COLUMN default_companion_id TEXT;

-- Per-message speaking companion (nullable). NESTstack's per-message `author`,
-- normalised. Additive nullable ADD COLUMN is metadata-only in SQLite (no table
-- rewrite) even though `messages` is byte-light's largest table.
ALTER TABLE messages ADD COLUMN companion_id TEXT;

-- Seed the roster registry. Two residents (two picker entries, one shared brain
-- 'companion-a-b') + the third node (his own brain 'companion-c'). Avatars copied from
-- empty public defaults. INSERT OR IGNORE keeps this idempotent across the
-- runner's every-boot re-exec.
INSERT OR IGNORE INTO companions (id, display_name, avatar, brain, model, sort_order, created_at) VALUES
  ('companion-a', 'Companion A', NULL, 'companion-a-b', NULL, 0, datetime('now')),
  ('companion-b', 'Companion B', NULL, 'companion-a-b', NULL, 1, datetime('now')),
  ('companion-c',  'Companion C',  NULL,                                              'companion-c',        NULL, 2, datetime('now'));
