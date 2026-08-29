import Database from 'better-sqlite3';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  Thread,
  Message,
  Canvas,
  SessionRecord,
  WebSession,
  UsageEvent,
  UsageBucket,
  UsageToolRow,
} from '@bytelight/shared';
import { getBytelightConfig } from '../config.js';
import { embed, vectorToBuffer } from './embeddings.js';
import { AUTO_EMBED_CONFIG_KEY, shouldAutomaticallyEmbed } from './embedding-policy.js';
import { cacheEmbedding } from './vector-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  // Busy timeout prevents SQLITE_BUSY errors under concurrent async access
  db.pragma('busy_timeout = 5000');

  // Run migrations
  const migrationPath = join(__dirname, '../../migrations/001_init.sql');
  const migrationSQL = readFileSync(migrationPath, 'utf-8');
  db.exec(migrationSQL);

  const ccMigrationPath = join(__dirname, '../../migrations/002_command_center.sql');
  if (existsSync(ccMigrationPath)) {
    const ccMigrationSQL = readFileSync(ccMigrationPath, 'utf-8');
    db.exec(ccMigrationSQL);
  }

  // Stickers migration
  const stickersMigrationPath = join(__dirname, '../../migrations/003_stickers.sql');
  if (existsSync(stickersMigrationPath)) {
    const stickersMigrationSQL = readFileSync(stickersMigrationPath, 'utf-8');
    db.exec(stickersMigrationSQL);
  }

  // Usage events migration
  const usageMigrationPath = join(__dirname, '../../migrations/004_usage_events.sql');
  if (existsSync(usageMigrationPath)) {
    const usageMigrationSQL = readFileSync(usageMigrationPath, 'utf-8');
    db.exec(usageMigrationSQL);
  }

  // Per-(thread, runtime, provider, model_ref) session sidecar migration
  const providerSessionsMigrationPath = join(__dirname, '../../migrations/005_thread_provider_sessions.sql');
  if (existsSync(providerSessionsMigrationPath)) {
    const providerSessionsMigrationSQL = readFileSync(providerSessionsMigrationPath, 'utf-8');
    db.exec(providerSessionsMigrationSQL);
  }

  // Per-message TTS cache (read-aloud audio sidecar)
  const messageTtsMigrationPath = join(__dirname, '../../migrations/006_message_tts.sql');
  if (existsSync(messageTtsMigrationPath)) {
    const messageTtsMigrationSQL = readFileSync(messageTtsMigrationPath, 'utf-8');
    db.exec(messageTtsMigrationSQL);
  }

  // Starred messages (favorites) — generic multi-actor stars.
  // Adapted for byte-light under Apache 2.0.
  const starredMigrationPath = join(__dirname, '../../migrations/007_starred_messages.sql');
  if (existsSync(starredMigrationPath)) {
    const starredMigrationSQL = readFileSync(starredMigrationPath, 'utf-8');
    db.exec(starredMigrationSQL);
  }

  // DB-managed MCP server registry.
  // Ported from the reference implementation, Apache 2.0 — adapted for byte-light.
  const mcpServersMigrationPath = join(__dirname, '../../migrations/008_mcp_servers.sql');
  if (existsSync(mcpServersMigrationPath)) {
    const mcpServersMigrationSQL = readFileSync(mcpServersMigrationPath, 'utf-8');
    db.exec(mcpServersMigrationSQL);
  }

  // ── Slice 3a resurrection: June runtime organs (tag stable-pre-rollback-
  // 2026-06-20). Tag migrations 007/008/009/011 renumbered onto main's
  // ledger as 009/010/011/012 (main's 007/008 slots were taken by
  // starred_messages / mcp_servers post-rollback). Loader blocks copied
  // from the tag's db.ts verbatim, paths + warn labels renumbered. ──

  // Companion settings — per (companion, tier, scope[, thread]) overrides
  // for (provider, model, thinking_effort). See migrations/009 for design.
  const companionSettingsMigrationPath = join(__dirname, '../../migrations/009_companion_settings.sql');
  if (existsSync(companionSettingsMigrationPath)) {
    const companionSettingsMigrationSQL = readFileSync(companionSettingsMigrationPath, 'utf-8');
    db.exec(companionSettingsMigrationSQL);
  }

  // Usage events companion attribution — additive ALTER TABLE. SQLite
  // lacks `ADD COLUMN IF NOT EXISTS`, so wrap in try/catch to keep the
  // migration idempotent across restarts (matches the inline-ALTER
  // pattern used for messages.platform / threads.pinned_at / canvases.tags
  // further down).
  const usageCompanionMigrationPath = join(__dirname, '../../migrations/010_usage_events_companion_id.sql');
  if (existsSync(usageCompanionMigrationPath)) {
    const usageCompanionMigrationSQL = readFileSync(usageCompanionMigrationPath, 'utf-8');
    try {
      db.exec(usageCompanionMigrationSQL);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        console.warn('Migration warning (010):', msg);
      }
      // Index creation uses IF NOT EXISTS so it's safe to re-run on its own.
      // If only the ALTER threw, try the index separately so the column-add
      // failure doesn't leave the index unbuilt on a fresh DB recovery.
      try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_companion_id ON usage_events(companion_id);');
      } catch {
        // Best effort — the column might not exist yet on first-run failure.
      }
    }
  }

  // Seed system-scope defaults for pulse + memory tiers. Idempotent across
  // boots: the uq_companion_settings_scope_key unique index from 009 makes
  // a second INSERT fail with UNIQUE constraint, which we swallow here.
  const seedDefaultsMigrationPath = join(__dirname, '../../migrations/011_seed_companion_defaults.sql');
  if (existsSync(seedDefaultsMigrationPath)) {
    const seedDefaultsSQL = readFileSync(seedDefaultsMigrationPath, 'utf-8');
    try {
      db.exec(seedDefaultsSQL);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('UNIQUE constraint failed')) {
        console.warn('Migration warning (011):', msg);
      }
    }
  }

  // Phase 2 Step 3 — multi-provider usage attribution. Three additive
  // ALTER TABLE columns + two indexes. The bundled .sql executes all five
  // statements; SQLite stops at the first ALTER if a column already
  // exists (duplicate column error), which leaves the later ALTERs +
  // indexes unrun. We catch + retry column-by-column with idempotent
  // ALTERs so partial state on a re-run heals fully. Mirrors the 010
  // multi-column-safe pattern.
  const usageProviderMigrationPath = join(__dirname, '../../migrations/012_usage_events_provider.sql');
  if (existsSync(usageProviderMigrationPath)) {
    const usageProviderMigrationSQL = readFileSync(usageProviderMigrationPath, 'utf-8');
    try {
      db.exec(usageProviderMigrationSQL);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        console.warn('Migration warning (012):', msg);
      }
      // Heal partial application: each column is its own try/catch so a
      // duplicate on one doesn't block the others.
      for (const col of ['provider', 'runtime', 'model_ref']) {
        try {
          db.exec(`ALTER TABLE usage_events ADD COLUMN ${col} TEXT`);
        } catch { /* duplicate column — fine */ }
      }
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider);'); } catch { /* best effort */ }
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_runtime ON usage_events(runtime);'); } catch { /* best effort */ }
    }
  }

  // Memory blocks — Letta-style in-place memory editing (Slice 1).
  // Ported from the reference implementation fork, Apache 2.0 — adapted for byte-light.
  // Plain CREATE TABLE IF NOT EXISTS migration; safe to re-run on every boot.
  const memoryMigrationPath = join(__dirname, '../../migrations/013_memory.sql');
  if (existsSync(memoryMigrationPath)) {
    const memoryMigrationSQL = readFileSync(memoryMigrationPath, 'utf-8');
    db.exec(memoryMigrationSQL);
  }

  // Companions + per-thread roster (Arc C rooms, Slice 1 — schema only).
  // Schema shape ported from NESTstack rooms-worker (cindiekinzz-coder, MIT);
  // see migrations/014 for the full attribution + id convention. The .sql
  // mixes idempotent CREATE TABLE IF NOT EXISTS with two bare ALTER TABLE ADD
  // COLUMN (threads.default_companion_id, messages.companion_id). SQLite lacks
  // `ADD COLUMN IF NOT EXISTS`, so on a re-boot the whole-file exec throws
  // "duplicate column" and stops before the seed. Catch + heal column-by-column
  // and re-run the idempotent tail, mirroring the 010/012 multi-statement
  // pattern.
  const companionsMigrationPath = join(__dirname, '../../migrations/014_companions.sql');
  if (existsSync(companionsMigrationPath)) {
    const companionsMigrationSQL = readFileSync(companionsMigrationPath, 'utf-8');
    try {
      db.exec(companionsMigrationSQL);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        console.warn('Migration warning (014):', msg);
      }
      // Heal partial application: each ALTER is its own try/catch so a duplicate
      // on one doesn't block the others or the seed below.
      try { db.exec('ALTER TABLE threads ADD COLUMN default_companion_id TEXT'); } catch { /* duplicate column — fine */ }
      try { db.exec('ALTER TABLE messages ADD COLUMN companion_id TEXT'); } catch { /* duplicate column — fine */ }
      // Seed is INSERT OR IGNORE (idempotent); re-run so a mid-file throw on the
      // first boot still lands the roster rows.
      try {
        db.exec(
          "INSERT OR IGNORE INTO companions (id, display_name, avatar, brain, model, sort_order, created_at) VALUES " +
          "('companion-a', 'Companion A', NULL, 'companion-a-b', NULL, 0, datetime('now')), " +
          "('companion-b', 'Companion B', NULL, 'companion-a-b', NULL, 1, datetime('now')), " +
          "('companion-c',  'Companion C',  NULL, 'companion-c', NULL, 2, datetime('now'));"
        );
      } catch { /* best effort — table may not exist on a first-run failure */ }
    }
  }

  // Generic roster backfill. Depends on 014 above. The .sql is pure INSERT OR
  // IGNORE and creates no fixed rooms or deployment-specific identifiers. A
  // straight re-exec is idempotent. Guard for a first-run race where 014 did
  // not create the tables (best-effort warn, don't crash boot).
  const roomsSeedMigrationPath = join(__dirname, '../../migrations/015_rooms_seed.sql');
  if (existsSync(roomsSeedMigrationPath)) {
    const roomsSeedMigrationSQL = readFileSync(roomsSeedMigrationPath, 'utf-8');
    try {
      db.exec(roomsSeedMigrationSQL);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('Migration warning (015):', msg);
    }

    // Home roster seed: the Arc A pinned routing thread ('app.routingThreadId')
    // gets the resident pair. Its id lives in the config table, not known at
    // migration-authoring time, so it is seeded here rather than in the .sql.
    // If the key is unset (fresh DB, no Home pinned yet) skip gracefully — the
    // backfill above already seated every EXISTING thread, and the resolver
    // seats a new Home the moment one is pinned via the picker (Slice 3).
    // INSERT OR IGNORE against the composite PK keeps this idempotent.
    try {
      const homeId = db.prepare("SELECT value FROM config WHERE key = 'app.routingThreadId'").get() as { value?: string } | undefined;
      const rid = homeId?.value;
      if (rid) {
        // Only seed if the routing thread actually exists (a stale config
        // pointer must not create orphan roster rows — the FK would reject it
        // anyway, but skip cleanly rather than throw).
        const exists = db.prepare('SELECT 1 FROM threads WHERE id = ?').get(rid);
        if (exists) {
          const seatHome = db.prepare('INSERT OR IGNORE INTO thread_companions (thread_id, companion_id) VALUES (?, ?)');
          seatHome.run(rid, 'companion-a');
          seatHome.run(rid, 'companion-b');
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('Migration warning (015 Home roster seed):', msg);
    }
  }

  // PORT ADAPTATION (reference implementation usage meters): reference implementation reads Codex transcripts
  // on demand. byte-light already receives the same signal live, so persist
  // the latest standing per lane/window in a bounded, idempotent table.
  const subscriptionUsageMigrationPath = join(__dirname, '../../migrations/016_subscription_usage_windows.sql');
  if (existsSync(subscriptionUsageMigrationPath)) {
    db.exec(readFileSync(subscriptionUsageMigrationPath, 'utf-8'));
  }

  // Memory ledger — a receipt row per core-memory write (see memory-ledger.ts).
  // Ported from an reference implementation, Apache 2.0. Pure CREATE TABLE / CREATE INDEX
  // IF NOT EXISTS, so a straight re-exec on every boot is idempotent — no
  // duplicate-column healing needed, unlike 014.
  const memoryLedgerMigrationPath = join(__dirname, '../../migrations/017_memory_ledger.sql');
  if (existsSync(memoryLedgerMigrationPath)) {
    db.exec(readFileSync(memoryLedgerMigrationPath, 'utf-8'));
  }

  // Memory proposals — the Archivist's holding area (see memory-proposals.ts).
  // Ported from an reference implementation, Apache 2.0. Same idempotent shape as 017.
  // The table stays EMPTY unless `memext.mode` is flipped to 'propose'; the
  // default is 'write', so creating it changes no behaviour.
  const memoryProposalsMigrationPath = join(__dirname, '../../migrations/018_memory_proposals.sql');
  if (existsSync(memoryProposalsMigrationPath)) {
    db.exec(readFileSync(memoryProposalsMigrationPath, 'utf-8'));
  }

  // Canonical ids + open aliases for core-memory blocks. The migration is
  // non-destructive: historical ghost rows stay untouched, but their welded
  // labels resolve to the real block on every future write.
  const memoryAliasesMigrationPath = join(__dirname, '../../migrations/019_memory_block_aliases.sql');
  if (existsSync(memoryAliasesMigrationPath)) {
    db.exec(readFileSync(memoryAliasesMigrationPath, 'utf-8'));
  }

  // Lossless cold home for text removed by the gentle core-memory diet loop.
  const memoryArchiveMigrationPath = join(__dirname, '../../migrations/020_memory_blocks_archive.sql');
  if (existsSync(memoryArchiveMigrationPath)) {
    db.exec(readFileSync(memoryArchiveMigrationPath, 'utf-8'));
  }

  // Durable sender receipts. Older databases need the additive column first;
  // fresh installs already receive it from 001_init.sql.
  try {
    db.exec('ALTER TABLE messages ADD COLUMN client_id TEXT');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('duplicate column name')) throw err;
  }
  const messageDeliveryMigrationPath = join(__dirname, '../../migrations/021_message_delivery.sql');
  if (existsSync(messageDeliveryMigrationPath)) {
    db.exec(readFileSync(messageDeliveryMigrationPath, 'utf-8'));
  }

  // Insert default config if not exists
  const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  stmt.run('dnd_start', '23:00');
  stmt.run('dnd_end', '07:00');

  // Timers table (created inline, no migration needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      context TEXT,
      fire_at TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      fired_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);

  // Triggers table (impulse queue + event watchers)
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      conditions TEXT NOT NULL,
      prompt TEXT,
      thread_id TEXT,
      cooldown_minutes INTEGER DEFAULT 120,
      status TEXT NOT NULL DEFAULT 'pending',
      last_fired_at TEXT,
      fire_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      fired_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);

  // Discord integration migration — platform column + pairing table
  // Safe to run multiple times (uses IF NOT EXISTS / catches already-exists)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN platform TEXT DEFAULT 'web'`);
  } catch {
    // Column already exists — fine
  }

  // Thread pinning migration
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN pinned_at TEXT DEFAULT NULL`);
  } catch {
    // Column already exists — fine
  }

  // Canvas tags migration
  try {
    db.exec(`ALTER TABLE canvases ADD COLUMN tags TEXT DEFAULT '[]'`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.warn('Migration warning:', msg);
    }
  }

  // Canvas tags migration
  try {
    db.exec(`ALTER TABLE canvases ADD COLUMN tags TEXT DEFAULT '[]'`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      console.warn('Migration warning:', msg);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_pairings (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      channel_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      approved_by TEXT
    )
  `);

  // Semantic embeddings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_embeddings (
      message_id TEXT PRIMARY KEY,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    )
  `);

  // Session history migration — add UNIQUE on session_id + 'resumed' end_reason
  // Inspect the table schema directly instead of probing with a test INSERT/DELETE,
  // which previously dirtied the table and could surface false-positive warnings.
  const shCount = (db.prepare('SELECT COUNT(*) as c FROM session_history').get() as { c: number }).c;
  if (shCount === 0) {
    const sessionHistorySchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_history'"
    ).get() as { sql?: string } | undefined;
    const sessionHistorySql = sessionHistorySchema?.sql ?? '';
    const needsRecreate =
      !sessionHistorySql.includes('session_id TEXT NOT NULL UNIQUE') ||
      !sessionHistorySql.includes("'resumed'");

    if (needsRecreate) {
      db.exec('DROP TABLE session_history');
      db.exec(`
        CREATE TABLE session_history (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          session_type TEXT NOT NULL CHECK(session_type IN ('v1', 'v2')),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          end_reason TEXT CHECK(end_reason IN ('compaction', 'reaper', 'daily_rotation', 'error', 'manual', 'resumed')),
          tokens_used INTEGER,
          cost_usd REAL,
          peak_memory_mb INTEGER,
          FOREIGN KEY (thread_id) REFERENCES threads(id)
        )
      `);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_history_thread_id ON session_history(thread_id)');

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

// Thread operations
/**
 * Default roster seated into EVERY newly created thread (Arc C, Slice 3).
 *
 * This is the ONE place default seating lives. Every thread-creation path in
 * the app funnels through createThread() below — the web picker (chat-routes),
 * Discord/Telegram/wake/API-created threads (ws.ts, commands.ts), and the
 * routing-thread resolver (resolveRoutingThread) — so seating here means no
 * thread is ever roster-less from the moment it exists. The web picker may
 * OVERRIDE this default by passing an explicit companionIds; everything else
 * gets the resident pair automatically.
 *
 * These are individual companion slugs from the companions registry
 * (migrations/014_companions.sql), matching the profiles-store keys. Kept as a
 * literal (not a DB read) because the resident pair is the fixed everyday
 * default; the picker is the surface for anything else.
 */
export const DEFAULT_THREAD_ROSTER = ['companion-a', 'companion-b'] as const;

export function createThread(params: {
  id: string;
  name: string;
  type: 'daily' | 'named';
  createdAt: string;
  sessionType?: 'v1' | 'v2';
  /**
   * Optional explicit roster (from the web thread-creation picker). When
   * omitted or empty, the thread is seated with DEFAULT_THREAD_ROSTER, so a
   * thread is never left roster-less. Ids that don't exist in the companions
   * registry are silently skipped by the guarded INSERT (FK-safe); the route
   * layer validates ids before calling.
   */
  companionIds?: readonly string[];
}): Thread {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO threads (id, name, type, created_at, session_type, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Seat the roster in the same transaction as the thread insert so a thread
  // is never observed existing without its roster. The guarded INSERT only
  // seats companions that exist in the registry (FK-safe).
  const ins = database.prepare(
    `INSERT OR IGNORE INTO thread_companions (thread_id, companion_id)
       SELECT ?, ? WHERE EXISTS (SELECT 1 FROM companions WHERE id = ?)`
  );
  const seat = database.transaction(() => {
    stmt.run(
      params.id,
      params.name,
      params.type,
      params.createdAt,
      params.sessionType || 'v2',
      params.createdAt
    );
    const roster =
      params.companionIds && params.companionIds.length > 0
        ? params.companionIds
        : DEFAULT_THREAD_ROSTER;
    for (const cid of new Set(roster)) ins.run(params.id, cid, cid);
  });
  seat();

  return getThread(params.id)!;
}

export function getThread(id: string): Thread | null {
  const stmt = getDb().prepare('SELECT * FROM threads WHERE id = ?');
  const row = stmt.get(id);
  return row ? (row as unknown as Thread) : null;
}

export function getTodayThread(): Thread | null {
  // Compute today's date in configured timezone
  const config = getBytelightConfig();
  const timezone = config.identity.timezone;
  const now = new Date();
  const localDate = now.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD

  // Compute UTC offset in minutes for the configured timezone
  // Using total-minutes approach to correctly handle UTC- zones when UTC crosses midnight
  const localHour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));
  const localMinute = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, minute: '2-digit' }));
  const localTotalMinutes = localHour * 60 + localMinute;
  const utcTotalMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let offsetMinutes = localTotalMinutes - utcTotalMinutes;
  // Clamp to ±720 minutes to handle UTC crossing midnight
  if (offsetMinutes > 12 * 60) offsetMinutes -= 24 * 60;
  if (offsetMinutes < -12 * 60) offsetMinutes += 24 * 60;

  // Query with offset applied to created_at so SQLite compares in local time
  // ORDER BY + LIMIT 1 ensures deterministic result if multiple daily threads exist
  const modifier = `${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} minutes`;
  const stmt = getDb().prepare(`
    SELECT * FROM threads
    WHERE type = 'daily'
    AND date(created_at, ?) = ?
    AND archived_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const row = stmt.get(modifier, localDate);
  return row ? (row as unknown as Thread) : null;
}

export function listThreads(params: {
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}): Thread[] {
  const { includeArchived = false, limit = 50, offset = 0 } = params;

  let sql = 'SELECT * FROM threads';
  if (!includeArchived) {
    sql += ' WHERE archived_at IS NULL';
  }
  sql += ' ORDER BY last_activity_at DESC LIMIT ? OFFSET ?';

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(limit, offset);
  return rows as unknown as Thread[];
}

export function getMostRecentActiveThread(): Thread | null {
  // Returns the most recently active non-archived thread with a session
  // Used to route user's messages into their active conversation
  const stmt = getDb().prepare(`
    SELECT * FROM threads
    WHERE archived_at IS NULL
    AND current_session_id IS NOT NULL
    ORDER BY last_activity_at DESC
    LIMIT 1
  `);
  const row = stmt.get();
  return row ? (row as unknown as Thread) : null;
}

export function updateThreadSession(threadId: string, sessionId: string | null): void {
  const stmt = getDb().prepare('UPDATE threads SET current_session_id = ? WHERE id = ?');
  stmt.run(sessionId, threadId);
}

// ---------------------------------------------------------------------------
// Per-(thread, runtime, provider, model_ref) session sidecar
// Ported from reference implementation/main 1c82243 (reference implementation PR C), hardened: no legacy
// threads.current_session_id fallback on read. Sidecar miss = fresh session.
// ---------------------------------------------------------------------------

export interface ProviderSession {
  thread_id: string;
  runtime_id: string;
  provider: string;
  model_ref: string;
  session_id: string;
  last_used_at: string;
  metadata_json: string | null;
}

export interface ProviderSessionKey {
  threadId: string;
  runtimeId: string;
  provider: string;
  modelRef: string;
}

export function getProviderSession(key: ProviderSessionKey): ProviderSession | null {
  const stmt = getDb().prepare(`
    SELECT thread_id, runtime_id, provider, model_ref, session_id, last_used_at, metadata_json
    FROM thread_provider_sessions
    WHERE thread_id = ? AND runtime_id = ? AND provider = ? AND model_ref = ?
  `);
  const row = stmt.get(key.threadId, key.runtimeId, key.provider, key.modelRef);
  return row ? (row as unknown as ProviderSession) : null;
}

export function setProviderSession(params: {
  threadId: string;
  runtimeId: string;
  provider: string;
  modelRef: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
}): void {
  const now = new Date().toISOString();
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;
  const stmt = getDb().prepare(`
    INSERT INTO thread_provider_sessions
      (thread_id, runtime_id, provider, model_ref, session_id, last_used_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id, runtime_id, provider, model_ref) DO UPDATE SET
      session_id = excluded.session_id,
      last_used_at = excluded.last_used_at,
      metadata_json = excluded.metadata_json
  `);
  stmt.run(
    params.threadId,
    params.runtimeId,
    params.provider,
    params.modelRef,
    params.sessionId,
    now,
    metadataJson,
  );
}

export function clearProviderSessionsForThread(threadId: string): number {
  const stmt = getDb().prepare('DELETE FROM thread_provider_sessions WHERE thread_id = ?');
  const result = stmt.run(threadId);
  return result.changes;
}

// Nuke every active session (legacy current_session_id + provider sidecar) so
// the next message starts on a fresh SDK session. Used by the MCP toggle flow
// to force the SDK to fully reconnect MCP servers after a re-enable. Cross-model
// continuity is preserved by agent-bridge.ts (history injection on fresh session).
export function clearAllThreadSessions(): void {
  const db = getDb();
  db.prepare('UPDATE threads SET current_session_id = NULL').run();
  db.prepare('DELETE FROM thread_provider_sessions').run();
}

// Used to distinguish pristine threads from model-switched threads at
// the sidecar-miss boundary in agent.ts. Cross-model continuity bridge
// fires only when this returns true.
export function hasAnyProviderSessionForThread(threadId: string): boolean {
  const stmt = getDb().prepare('SELECT 1 FROM thread_provider_sessions WHERE thread_id = ? LIMIT 1');
  return stmt.get(threadId) !== undefined;
}

// Recency signal for the return-to-model bridge (Slice 1.5). The newest
// sidecar row tells us which (runtime, provider, model) triple carried the
// thread most recently; agent.ts compares it against the current turn's hit
// row to detect "returning to a previously-used model" and bridge the gap.
export function getMostRecentProviderSession(threadId: string): ProviderSession | null {
  const stmt = getDb().prepare(`
    SELECT thread_id, runtime_id, provider, model_ref, session_id, last_used_at, metadata_json
    FROM thread_provider_sessions
    WHERE thread_id = ?
    ORDER BY last_used_at DESC
    LIMIT 1
  `);
  const row = stmt.get(threadId);
  return row ? (row as unknown as ProviderSession) : null;
}

export function updateThreadActivity(threadId: string, timestamp: string, incrementUnread = false): void {
  let sql = 'UPDATE threads SET last_activity_at = ?';
  if (incrementUnread) {
    sql += ', unread_count = unread_count + 1';
  }
  sql += ' WHERE id = ?';

  const stmt = getDb().prepare(sql);
  stmt.run(timestamp, threadId);
}

export function archiveThread(threadId: string, archivedAt: string | null): void {
  const stmt = getDb().prepare('UPDATE threads SET archived_at = ? WHERE id = ?');
  stmt.run(archivedAt, threadId);
}

export function deleteThread(threadId: string): string[] {
  const db = getDb();

  // Collect fileIds from message metadata before deleting
  const fileIds: string[] = [];
  const msgs = db.prepare('SELECT metadata FROM messages WHERE thread_id = ? AND metadata IS NOT NULL').all(threadId) as Array<{ metadata: string }>;
  for (const row of msgs) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.fileId) fileIds.push(meta.fileId);
    } catch { /* skip unparseable */ }
  }

  // Cascading delete in a transaction
  const deleteAll = db.transaction(() => {
    db.prepare('DELETE FROM triggers WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM timers WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM canvases WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM outbound_queue WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM audit_log WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM session_history WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)').run(threadId);
    db.prepare('DELETE FROM starred_messages WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)').run(threadId);
    db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  });
  deleteAll();

  return fileIds;
}

// Async embedding helper — fire-and-forget from createMessage
async function embedMessageAsync(messageId: string, content: string, meta: {
  threadId: string; threadName: string; role: string; createdAt: string;
}): Promise<void> {
  try {
    const vector = await embed(content);
    saveEmbedding(messageId, vectorToBuffer(vector));
    cacheEmbedding(messageId, vector, meta);
  } catch (err) {
    console.error(`[embeddings] Failed to embed message ${messageId}:`, err);
  }
}

// Message operations
export function getNextSequence(threadId: string): number {
  const stmt = getDb().prepare('SELECT MAX(sequence) as max_seq FROM messages WHERE thread_id = ?');
  const row = stmt.get(threadId) as { max_seq: number | null };
  return (row.max_seq || 0) + 1;
}

export function createMessage(params: {
  id: string;
  threadId: string;
  role: 'companion' | 'user' | 'system';
  content: string;
  contentType?: 'text' | 'image' | 'audio' | 'file';
  platform?: 'web' | 'discord' | 'telegram' | 'api';
  metadata?: Record<string, unknown>;
  replyToId?: string;
  createdAt: string;
  /** Authoring companion registry id (e.g. 'companion-a-b', 'companion-c'). Omit for
   *  user/system rows — the column stays NULL. */
  companionId?: string;
  /** Stable id supplied by a client. Only user sends should set this. */
  clientId?: string;
}): Message {
  const sequence = getNextSequence(params.threadId);

  const stmt = getDb().prepare(`
    INSERT INTO messages (
      id, thread_id, sequence, role, content, content_type, platform, metadata, reply_to_id, created_at, companion_id, client_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    params.id,
    params.threadId,
    sequence,
    params.role,
    params.content,
    params.contentType || 'text',
    params.platform || 'web',
    params.metadata ? JSON.stringify(params.metadata) : null,
    params.replyToId || null,
    params.createdAt,
    params.companionId || null,
    params.clientId || null
  );

  // Automatic local embeddings are opt-in. Explicit semantic search/backfill
  // can still load the model, but routine messages and wakes never should.
  const shouldAutoEmbed = shouldAutomaticallyEmbed({
    setting: getConfig(AUTO_EMBED_CONFIG_KEY),
    role: params.role,
    contentType: params.contentType,
    contentLength: params.content.length,
  });
  if (shouldAutoEmbed) {
    const thread = getThread(params.threadId);
    embedMessageAsync(params.id, params.content, {
      threadId: params.threadId,
      threadName: thread?.name || '',
      role: params.role,
      createdAt: params.createdAt,
    }).catch(() => {});
  }

  return getMessage(params.id)!;
}

export function getMessageByClientId(clientId: string): Message | null {
  const row = getDb().prepare('SELECT * FROM messages WHERE client_id = ?').get(clientId);
  if (!row) return null;
  const message = row as unknown as Message;
  if (message.metadata && typeof message.metadata === 'string') {
    message.metadata = JSON.parse(message.metadata);
  }
  return message;
}

export function getMessage(id: string): Message | null {
  const stmt = getDb().prepare('SELECT * FROM messages WHERE id = ?');
  const row = stmt.get(id);
  if (!row) return null;

  const message = row as unknown as Message;
  if (message.metadata && typeof message.metadata === 'string') {
    message.metadata = JSON.parse(message.metadata);
  }
  return message;
}

export function getMessages(params: {
  threadId: string;
  before?: string;
  limit?: number;
  /** Only messages created strictly after this ISO timestamp (recency bridge). */
  since?: string;
}): Message[] {
  const { threadId, before, limit = 50, since } = params;

  let sql = 'SELECT * FROM messages WHERE thread_id = ? AND deleted_at IS NULL';
  const sqlParams: unknown[] = [threadId];

  if (before) {
    sql += ' AND sequence < (SELECT sequence FROM messages WHERE id = ?)';
    sqlParams.push(before);
  }

  if (since) {
    sql += ' AND created_at > ?';
    sqlParams.push(since);
  }

  sql += ' ORDER BY sequence DESC LIMIT ?';
  sqlParams.push(limit);

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(...sqlParams);

  const messages = (rows as unknown as Message[]).map(msg => {
    if (msg.metadata && typeof msg.metadata === 'string') {
      msg.metadata = JSON.parse(msg.metadata);
    }
    return msg;
  });

  return messages.reverse(); // Return in chronological order
}

/** Get messages surrounding a specific message (N before + the message + N after). */
export function getMessageContext(messageId: string, windowSize: number = 2): Message[] {
  const target = getDb().prepare('SELECT thread_id, sequence FROM messages WHERE id = ?').get(messageId) as { thread_id: string; sequence: number } | undefined;
  if (!target) return [];

  const rows = getDb().prepare(`
    SELECT * FROM messages
    WHERE thread_id = ? AND deleted_at IS NULL
      AND sequence BETWEEN ? AND ?
    ORDER BY sequence ASC
  `).all(target.thread_id, target.sequence - windowSize, target.sequence + windowSize);

  return (rows as unknown as Message[]).map(msg => {
    if (msg.metadata && typeof msg.metadata === 'string') {
      msg.metadata = JSON.parse(msg.metadata);
    }
    return msg;
  });
}

export function editMessage(id: string, newContent: string, editedAt: string): void {
  const stmt = getDb().prepare(`
    UPDATE messages
    SET content = ?, edited_at = ?, original_content = COALESCE(original_content, content)
    WHERE id = ?
  `);
  stmt.run(newContent, editedAt, id);
}

export function softDeleteMessage(id: string, deletedAt: string): void {
  const stmt = getDb().prepare('UPDATE messages SET deleted_at = ? WHERE id = ?');
  stmt.run(deletedAt, id);
}

// Soft-delete every message in `threadId` whose sequence is strictly greater
// than `afterSequence`. Used by Edit & Rerun and Regenerate to drop the tail
// of the conversation before re-prompting. Returns the IDs of rows that
// flipped from non-deleted to deleted (so we can broadcast them).
export function softDeleteAfterSequence(
  threadId: string,
  afterSequence: number,
  deletedAt: string,
): string[] {
  const idsStmt = getDb().prepare(
    'SELECT id FROM messages WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL'
  );
  const ids = (idsStmt.all(threadId, afterSequence) as { id: string }[]).map(r => r.id);
  if (ids.length === 0) return [];
  const updateStmt = getDb().prepare(
    'UPDATE messages SET deleted_at = ? WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL'
  );
  updateStmt.run(deletedAt, threadId, afterSequence);
  return ids;
}

export function markMessagesRead(threadId: string, beforeId: string, readAt: string): void {
  const stmt = getDb().prepare(`
    UPDATE messages
    SET read_at = ?
    WHERE thread_id = ?
    AND sequence <= (SELECT sequence FROM messages WHERE id = ?)
    AND read_at IS NULL
  `);
  stmt.run(readAt, threadId, beforeId);

  // Reset unread count
  const resetStmt = getDb().prepare('UPDATE threads SET unread_count = 0 WHERE id = ?');
  resetStmt.run(threadId);
}

// Per-message TTS cache — one rendered audio file per source message.
export interface MessageTts {
  message_id: string;
  file_id: string;
  voice_used: string | null;
  created_at: string;
}

export function getMessageTts(messageId: string): MessageTts | null {
  const stmt = getDb().prepare('SELECT * FROM message_tts WHERE message_id = ?');
  return (stmt.get(messageId) as MessageTts | undefined) || null;
}

export function setMessageTts(params: {
  messageId: string;
  fileId: string;
  voiceUsed?: string | null;
  createdAt: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO message_tts (message_id, file_id, voice_used, created_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(params.messageId, params.fileId, params.voiceUsed ?? null, params.createdAt);
}

// Reaction operations
export function addReaction(messageId: string, emoji: string, user: 'companion' | 'user'): void {
  const msg = getMessage(messageId);
  if (!msg) return;

  const metadata = (msg.metadata && typeof msg.metadata === 'object') ? { ...msg.metadata } : {};
  const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(metadata.reactions) ? [...metadata.reactions] : [];

  // Deduplicate: same user + same emoji = no-op
  if (reactions.some(r => r.emoji === emoji && r.user === user)) return;

  reactions.push({ emoji, user, created_at: new Date().toISOString() });
  metadata.reactions = reactions;

  const stmt = getDb().prepare('UPDATE messages SET metadata = ? WHERE id = ?');
  stmt.run(JSON.stringify(metadata), messageId);
}

export function removeReaction(messageId: string, emoji: string, user: 'companion' | 'user'): void {
  const msg = getMessage(messageId);
  if (!msg) return;

  const metadata = (msg.metadata && typeof msg.metadata === 'object') ? { ...msg.metadata } : {};
  const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(metadata.reactions) ? [...metadata.reactions] : [];

  const filtered = reactions.filter(r => !(r.emoji === emoji && r.user === user));
  if (filtered.length === reactions.length) return; // Nothing to remove

  metadata.reactions = filtered;

  const stmt = getDb().prepare('UPDATE messages SET metadata = ? WHERE id = ?');
  stmt.run(JSON.stringify(metadata), messageId);
}

// Pin operations
export function pinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = ? WHERE id = ?');
  stmt.run(new Date().toISOString(), threadId);
}

export function unpinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = NULL WHERE id = ?');
  stmt.run(threadId);
}

// ── Active routing thread ("Home") ──────────────────────────────────────
// Ported from reference implementation (packages/backend/src/services/db/threads.ts).
// One global routing thread is the catch-all target for ambient activity.
// Per-source overrides (Discord, Telegram, wakes) let each lane aim at a
// different thread — useful for keeping Discord chatter out of a journal
// thread, or sending night wakes somewhere quiet. A source-specific key
// wins when set; the global key is the fallback.

const ROUTING_CONFIG_KEY = 'app.routingThreadId';

/** Valid routing sources — each can have its own routing thread, falling back
 *  to the global setting when unset. The web/WS lane stays on the global,
 *  since it's the "main" active thread shown in the chat UI. */
export type RoutingSource = 'discord' | 'telegram' | 'wake';

function sourceKey(source: RoutingSource): string {
  return `app.routingThreadId.${source}`;
}

export function getRoutingThreadId(): string | null {
  return getConfig(ROUTING_CONFIG_KEY);
}

export function setRoutingThreadId(threadId: string): void {
  setConfig(ROUTING_CONFIG_KEY, threadId);
}

/** Source-specific routing thread id, or null if the source falls back to
 *  the global setting. */
export function getRoutingThreadIdForSource(source: RoutingSource): string | null {
  return getConfig(sourceKey(source));
}

/** Set a source-specific routing thread. Pass `null` to clear the override
 *  and fall back to the global. */
export function setRoutingThreadIdForSource(source: RoutingSource, threadId: string | null): void {
  if (threadId === null) {
    deleteConfig(sourceKey(source));
  } else {
    setConfig(sourceKey(source), threadId);
  }
}

export function getRoutingThread(): Thread | null {
  const id = getRoutingThreadId();
  if (!id) return null;
  const t = getThread(id);
  if (!t || t.archived_at) return null;
  return t;
}

/** Resolve a source-specific routing thread, with fallback to the global one.
 *  Returns null if neither the source override nor the global resolves to a
 *  live thread — callers should fall through to `resolveRoutingThread()`. */
function getRoutingThreadFor(source: RoutingSource): Thread | null {
  const id = getRoutingThreadIdForSource(source);
  if (!id) return null;
  const t = getThread(id);
  // byte-light deletes threads hard (rows removed), so getThread returning a
  // row means the thread exists; we only need to skip archived ones.
  if (!t || t.archived_at) return null;
  return t;
}

/** Resolve the thread that ambient activity should land in.
 *  - If `source` is provided and a per-source override is set + valid, return it.
 *  - Else if the global routing thread is set and valid, return it.
 *  - Otherwise fall back to the most recent live thread and pin it.
 *  - If no threads exist at all, create a starter "Home" thread.
 *  The `source` parameter is optional so existing callers (web/WS) keep
 *  working unchanged on the global routing thread. */
export function resolveRoutingThread(
  registryOrSource?: { broadcast: (msg: any) => void } | RoutingSource,
  maybeRegistry?: { broadcast: (msg: any) => void },
): Thread {
  // Overload: either resolveRoutingThread(registry) — legacy — or
  // resolveRoutingThread(source, registry) — new per-source form.
  let source: RoutingSource | undefined;
  let registry: { broadcast: (msg: any) => void } | undefined;
  if (typeof registryOrSource === 'string') {
    source = registryOrSource;
    registry = maybeRegistry;
  } else {
    registry = registryOrSource;
  }

  if (source) {
    const sourceThread = getRoutingThreadFor(source);
    if (sourceThread) return sourceThread;
  }

  const current = getRoutingThread();
  if (current) return current;

  const stmt = getDb().prepare(
    'SELECT * FROM threads WHERE archived_at IS NULL ORDER BY last_activity_at DESC LIMIT 1'
  );
  const row = stmt.get() as Thread | undefined;
  if (row) {
    setRoutingThreadId(row.id);
    if (registry) registry.broadcast({ type: 'routing_thread_changed', threadId: row.id });
    return row;
  }

  // No threads at all — bootstrap a starter
  const created = createThread({
    id: crypto.randomUUID(),
    name: 'Home',
    type: 'named',
    createdAt: new Date().toISOString(),
    sessionType: 'v2',
  });
  setRoutingThreadId(created.id);
  if (registry) {
    registry.broadcast({ type: 'thread_created', thread: created });
    registry.broadcast({ type: 'routing_thread_changed', threadId: created.id });
  }
  return created;
}

// Search operations
export function searchMessages(params: {
  query: string;
  threadId?: string;
  limit?: number;
  offset?: number;
}): { messages: Array<{ id: string; thread_id: string; role: string; content: string; content_type: string; created_at: string; thread_name: string }>; total: number } {
  const { query, threadId, limit = 50, offset = 0 } = params;
  const escapedQuery = query.replace(/[%_]/g, '\\$&');
  const searchPattern = `%${escapedQuery}%`;

  let whereClause = "WHERE m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\'";
  const countParams: unknown[] = [searchPattern];
  const selectParams: unknown[] = [searchPattern];

  if (threadId) {
    whereClause += ' AND m.thread_id = ?';
    countParams.push(threadId);
    selectParams.push(threadId);
  }

  const countStmt = getDb().prepare(`SELECT COUNT(*) as total FROM messages m ${whereClause}`);
  const { total } = countStmt.get(...countParams) as { total: number };

  const selectStmt = getDb().prepare(`
    SELECT m.id, m.thread_id, m.role, m.content, m.content_type, m.created_at, t.name as thread_name
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    ${whereClause}
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `);
  selectParams.push(limit, offset);

  const rows = selectStmt.all(...selectParams) as Array<{
    id: string; thread_id: string; role: string; content: string;
    content_type: string; created_at: string; thread_name: string;
  }>;

  return { messages: rows, total };
}

// Embedding operations
export function saveEmbedding(messageId: string, vector: Buffer): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO message_embeddings (message_id, vector, created_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(messageId, vector, new Date().toISOString());
}

export function getAllEmbeddings(threadId?: string): Array<{
  message_id: string; vector: Buffer; thread_id: string;
  role: string; content: string; created_at: string; thread_name: string;
}> {
  let query = `
    SELECT e.message_id, e.vector, m.thread_id, m.role, m.content, m.created_at, t.name as thread_name
    FROM message_embeddings e
    JOIN messages m ON m.id = e.message_id
    JOIN threads t ON t.id = m.thread_id
    WHERE m.deleted_at IS NULL
  `;
  const params: unknown[] = [];
  if (threadId) {
    query += ' AND m.thread_id = ?';
    params.push(threadId);
  }
  return getDb().prepare(query).all(...params) as Array<{
    message_id: string; vector: Buffer; thread_id: string;
    role: string; content: string; created_at: string; thread_name: string;
  }>;
}

export function getUnembeddedMessages(limit: number = 50): Array<{
  id: string; content: string; role: string; content_type: string;
}> {
  return getDb().prepare(`
    SELECT m.id, m.content, m.role, m.content_type
    FROM messages m
    LEFT JOIN message_embeddings e ON e.message_id = m.id
    WHERE e.message_id IS NULL
      AND m.deleted_at IS NULL
      AND m.role != 'system'
      AND m.content_type = 'text'
      AND length(m.content) > 10
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string; content: string; role: string; content_type: string;
  }>;
}

export function getEmbeddingCount(): { embedded: number; total: number } {
  const embedded = (getDb().prepare('SELECT COUNT(*) as c FROM message_embeddings').get() as { c: number }).c;
  const total = (getDb().prepare(
    "SELECT COUNT(*) as c FROM messages WHERE deleted_at IS NULL AND role != 'system' AND content_type = 'text' AND length(content) > 10"
  ).get() as { c: number }).c;
  return { embedded, total };
}

// Session operations
export function createSessionRecord(params: {
  id: string;
  threadId: string;
  sessionId: string;
  sessionType: 'v1' | 'v2';
  startedAt: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO session_history (id, thread_id, session_id, session_type, started_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(params.id, params.threadId, params.sessionId, params.sessionType, params.startedAt);
}

export function endSessionRecord(params: {
  sessionId: string;
  endedAt: string;
  endReason: 'compaction' | 'reaper' | 'daily_rotation' | 'error' | 'manual' | 'resumed';
}): void {
  const stmt = getDb().prepare(`
    UPDATE session_history
    SET ended_at = ?, end_reason = ?
    WHERE session_id = ?
  `);
  stmt.run(params.endedAt, params.endReason, params.sessionId);
}

export function updateSessionMemory(sessionId: string, peakMemoryMb: number): void {
  const stmt = getDb().prepare(`
    UPDATE session_history
    SET peak_memory_mb = ?
    WHERE session_id = ?
  `);
  stmt.run(peakMemoryMb, sessionId);
}

// Session lifecycle log: real session_history rows joined to their thread name
// and the thread's channel (latest message platform). Newest-first.
// Cost/tokens live in usage_events (Usage tab), not here.
export function listSessionHistory(
  limit = 50,
): (SessionRecord & { thread_name: string | null; platform: string | null })[] {
  const stmt = getDb().prepare(`
    SELECT
      sh.*,
      t.name AS thread_name,
      (SELECT m.platform FROM messages m
       WHERE m.thread_id = sh.thread_id
       ORDER BY m.created_at DESC LIMIT 1) AS platform
    FROM session_history sh
    LEFT JOIN threads t ON t.id = sh.thread_id
    ORDER BY sh.started_at DESC
    LIMIT ?
  `);
  return stmt.all(limit) as (SessionRecord & {
    thread_name: string | null;
    platform: string | null;
  })[];
}

// Auth operations
export function createWebSession(params: {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}): WebSession {
  const stmt = getDb().prepare(`
    INSERT INTO web_sessions (id, token, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(params.id, params.token, params.createdAt, params.expiresAt);

  return {
    id: params.id,
    token: params.token,
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
}

export function getWebSession(token: string): WebSession | null {
  const stmt = getDb().prepare('SELECT * FROM web_sessions WHERE token = ?');
  const row = stmt.get(token);
  return row ? (row as unknown as WebSession) : null;
}

export function deleteExpiredSessions(): void {
  const stmt = getDb().prepare('DELETE FROM web_sessions WHERE expires_at < ?');
  stmt.run(new Date().toISOString());
}

// Config operations
export function getConfig(key: string): string | null {
  const stmt = getDb().prepare('SELECT value FROM config WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setConfig(key: string, value: string): void {
  const stmt = getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  stmt.run(key, value);
}

export function deleteConfig(key: string): void {
  const stmt = getDb().prepare('DELETE FROM config WHERE key = ?');
  stmt.run(key);
}

export function getConfigBool(key: string, defaultValue: boolean): boolean {
  const val = getConfig(key);
  if (val === null) return defaultValue;
  return val === 'true' || val === '1';
}

export function getConfigNumber(key: string, defaultValue: number): number {
  const val = getConfig(key);
  if (val === null) return defaultValue;
  const num = parseFloat(val);
  return isNaN(num) ? defaultValue : num;
}

export function getAllConfig(): Record<string, string> {
  const stmt = getDb().prepare('SELECT key, value FROM config');
  const rows = stmt.all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// Push subscription operations
export interface PushSubscription {
  id: string;
  type: 'web_push' | 'apns';
  endpoint: string | null;
  keys_p256dh: string | null;
  keys_auth: string | null;
  device_token: string | null;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

export function addPushSubscription(params: {
  id: string;
  endpoint: string;
  keysP256dh: string;
  keysAuth: string;
  deviceName?: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO push_subscriptions (id, type, endpoint, keys_p256dh, keys_auth, device_name, created_at, last_used_at)
    VALUES (?, 'web_push', ?, ?, ?, ?, ?, NULL)
  `);
  stmt.run(params.id, params.endpoint, params.keysP256dh, params.keysAuth, params.deviceName || null, new Date().toISOString());
}

export function removePushSubscription(endpoint: string): boolean {
  const stmt = getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const result = stmt.run(endpoint);
  return result.changes > 0;
}

export function listPushSubscriptions(): PushSubscription[] {
  const stmt = getDb().prepare("SELECT * FROM push_subscriptions WHERE type = 'web_push' ORDER BY created_at DESC");
  return stmt.all() as unknown as PushSubscription[];
}

export function touchPushSubscription(endpoint: string): void {
  const stmt = getDb().prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?');
  stmt.run(new Date().toISOString(), endpoint);
}

// Canvas operations
// Parse tags JSON from DB row, always returns string[]
function parseTags(row: any): string[] {
  if (!row?.tags) return [];
  try { return JSON.parse(row.tags); } catch { return []; }
}

// Convert DB row to Canvas with parsed tags
function rowToCanvas(row: any): Canvas {
  return { ...row, tags: parseTags(row) } as Canvas;
}

export function createCanvas(params: {
  id: string;
  threadId?: string;
  title: string;
  content?: string;
  contentType: 'markdown' | 'code' | 'text' | 'html';
  language?: string;
  tags?: string[];
  createdBy: 'companion' | 'user';
  createdAt: string;
}): Canvas {
  const stmt = getDb().prepare(`
    INSERT INTO canvases (id, thread_id, title, content, content_type, language, tags, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.id,
    params.threadId || null,
    params.title,
    params.content || '',
    params.contentType,
    params.language || null,
    JSON.stringify(params.tags || []),
    params.createdBy,
    params.createdAt,
    params.createdAt,
  );
  return getCanvas(params.id)!;
}

export function getCanvas(id: string): Canvas | null {
  const stmt = getDb().prepare('SELECT * FROM canvases WHERE id = ?');
  const row = stmt.get(id);
  return row ? rowToCanvas(row) : null;
}

export function listCanvases(opts?: { search?: string; tag?: string }): Canvas[] {
  let sql = 'SELECT * FROM canvases';
  const conditions: string[] = [];
  const params: string[] = [];

  if (opts?.search) {
    conditions.push('(title LIKE ? OR content LIKE ?)');
    const q = `%${opts.search}%`;
    params.push(q, q);
  }
  if (opts?.tag) {
    conditions.push('tags LIKE ?');
    params.push(`%"${opts.tag}"%`);
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY updated_at DESC';

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(...params);
  return rows.map(rowToCanvas);
}

export function getAllCanvasTags(): string[] {
  const rows = getDb().prepare('SELECT tags FROM canvases WHERE tags != \'[]\' AND tags IS NOT NULL').all() as Array<{ tags: string }>;
  const tagSet = new Set<string>();
  for (const row of rows) {
    for (const tag of parseTags(row)) tagSet.add(tag);
  }
  return [...tagSet].sort();
}

export function updateCanvasContent(id: string, content: string, updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET content = ?, updated_at = ? WHERE id = ?');
  stmt.run(content, updatedAt, id);
}

export function updateCanvasTitle(id: string, title: string, updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?');
  stmt.run(title, updatedAt, id);
}

export function updateCanvasTags(id: string, tags: string[], updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET tags = ?, updated_at = ? WHERE id = ?');
  stmt.run(JSON.stringify(tags), updatedAt, id);
}

export function deleteCanvas(id: string): boolean {
  const stmt = getDb().prepare('DELETE FROM canvases WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// Timer operations
export interface Timer {
  id: string;
  label: string;
  context: string | null;
  fire_at: string;
  thread_id: string;
  prompt: string | null;
  status: 'pending' | 'fired' | 'cancelled';
  created_at: string;
  fired_at: string | null;
}

export function createTimer(params: {
  id: string;
  label: string;
  context?: string;
  fireAt: string;
  threadId: string;
  prompt?: string;
  createdAt: string;
}): Timer {
  const stmt = getDb().prepare(`
    INSERT INTO timers (id, label, context, fire_at, thread_id, prompt, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(
    params.id,
    params.label,
    params.context || null,
    params.fireAt,
    params.threadId,
    params.prompt || null,
    params.createdAt,
  );
  return getDb().prepare('SELECT * FROM timers WHERE id = ?').get(params.id) as unknown as Timer;
}

export function listPendingTimers(): Timer[] {
  const stmt = getDb().prepare("SELECT * FROM timers WHERE status = 'pending' ORDER BY fire_at ASC");
  return stmt.all() as unknown as Timer[];
}

export function getDueTimers(now: string): Timer[] {
  const stmt = getDb().prepare("SELECT * FROM timers WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC");
  return stmt.all(now) as unknown as Timer[];
}

export function markTimerFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE timers SET status = 'fired', fired_at = ? WHERE id = ?");
  stmt.run(firedAt, id);
}

export function cancelTimer(id: string): boolean {
  const stmt = getDb().prepare("UPDATE timers SET status = 'cancelled' WHERE id = ? AND status = 'pending'");
  const result = stmt.run(id);
  return result.changes > 0;
}

// Trigger types
export type TriggerCondition =
  | { type: 'presence_state'; state: 'active' | 'idle' | 'offline' }
  | { type: 'presence_transition'; from: string; to: string }
  | { type: 'agent_free' }
  | { type: 'time_window'; after: string; before?: string }
  | { type: 'routine_missing'; routine: string; after_hour: number };

export interface Trigger {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: string; // JSON array of TriggerCondition
  prompt: string | null;
  thread_id: string | null;
  cooldown_minutes: number;
  status: 'pending' | 'waiting' | 'fired' | 'cancelled';
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  fired_at: string | null;
}

// Trigger operations
export function createTrigger(params: {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: TriggerCondition[];
  prompt?: string;
  threadId?: string;
  cooldownMinutes?: number;
  createdAt: string;
}): Trigger {
  const stmt = getDb().prepare(`
    INSERT INTO triggers (id, kind, label, conditions, prompt, thread_id, cooldown_minutes, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(
    params.id,
    params.kind,
    params.label,
    JSON.stringify(params.conditions),
    params.prompt || null,
    params.threadId || null,
    params.cooldownMinutes ?? 120,
    params.createdAt,
  );
  return getDb().prepare('SELECT * FROM triggers WHERE id = ?').get(params.id) as unknown as Trigger;
}

export function getActiveTriggers(): Trigger[] {
  const stmt = getDb().prepare("SELECT * FROM triggers WHERE status IN ('pending', 'waiting') ORDER BY created_at ASC");
  return stmt.all() as unknown as Trigger[];
}

export function markTriggerWaiting(id: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'waiting' WHERE id = ?");
  stmt.run(id);
}

export function markTriggerFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'fired', fired_at = ?, fire_count = fire_count + 1 WHERE id = ?");
  stmt.run(firedAt, id);
}

export function markWatcherFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'pending', last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?");
  stmt.run(firedAt, id);
}

export function cancelTrigger(id: string): boolean {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'waiting')");
  const result = stmt.run(id);
  return result.changes > 0;
}

export function listTriggers(kind?: 'impulse' | 'watcher'): Trigger[] {
  if (kind) {
    const stmt = getDb().prepare("SELECT * FROM triggers WHERE kind = ? AND status != 'cancelled' ORDER BY created_at DESC");
    return stmt.all(kind) as unknown as Trigger[];
  }
  const stmt = getDb().prepare("SELECT * FROM triggers WHERE status != 'cancelled' ORDER BY created_at DESC");
  return stmt.all() as unknown as Trigger[];
}

// Usage tracking operations
export function recordUsageEvent(params: {
  id: string;
  createdAt: string;
  threadId?: string | null;
  messageId?: string | null;
  platform?: string | null;
  mode: 'interactive' | 'autonomous';
  wakeType?: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  toolCalls?: Array<{ name: string; count: number }>;
  costUsd?: number | null;
  contextWindow?: number | null;
  contextTokens?: number | null;
  durationMs?: number | null;
  /** Companion identifier for per-companion cost attribution. NULL when
   *  the calling context can't determine which companion ran the turn.
   *  See migrations/010_usage_events_companion_id.sql. */
  companionId?: string | null;
  /** ProviderId namespace this turn was billed against. NULL on pre-Step-3
   *  rows; populated from `modelRef.provider` going forward. */
  provider?: string | null;
  /** RuntimeId that produced the events for this turn. NULL on pre-Step-3
   *  rows; populated from `modelRef.runtime`. */
  runtime?: string | null;
  /** Canonical provider-qualified ModelRef string (`<provider>/<model>`).
   *  Distinct from `model` which keeps the raw provider-native id for
   *  back-compat with cost-attribution scripts. */
  modelRef?: string | null;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO usage_events (
      id, created_at, thread_id, message_id, platform, mode, wake_type,
      model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      tool_calls, cost_usd, duration_ms, context_window, context_tokens, companion_id,
      provider, runtime, model_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.id,
    params.createdAt,
    params.threadId ?? null,
    params.messageId ?? null,
    params.platform ?? null,
    params.mode,
    params.wakeType ?? null,
    params.model,
    params.inputTokens,
    params.outputTokens,
    params.cacheReadTokens ?? 0,
    params.cacheCreationTokens ?? 0,
    params.toolCalls ? JSON.stringify(params.toolCalls) : null,
    params.costUsd ?? null,
    params.durationMs ?? null,
    params.contextWindow ?? null,
    params.contextTokens ?? null,
    params.companionId ?? null,
    params.provider ?? null,
    params.runtime ?? null,
    params.modelRef ?? null
  );
}

export function listUsageEvents(params: {
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
  threadId?: string;
  platform?: string;
  mode?: 'interactive' | 'autonomous';
  model?: string;
}): UsageEvent[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (params.since) { clauses.push('u.created_at >= ?'); args.push(params.since); }
  if (params.until) { clauses.push('u.created_at <= ?'); args.push(params.until); }
  if (params.threadId) { clauses.push('u.thread_id = ?'); args.push(params.threadId); }
  if (params.platform) { clauses.push('u.platform = ?'); args.push(params.platform); }
  if (params.mode) { clauses.push('u.mode = ?'); args.push(params.mode); }
  if (params.model) { clauses.push('u.model = ?'); args.push(params.model); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;
  const stmt = getDb().prepare(`
    SELECT u.*, t.name AS thread_name
    FROM usage_events u
    LEFT JOIN threads t ON t.id = u.thread_id
    ${where}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `);
  return stmt.all(...args, limit, offset) as unknown as UsageEvent[];
}

export function getUsageEventByMessageId(messageId: string): UsageEvent | null {
  const stmt = getDb().prepare('SELECT * FROM usage_events WHERE message_id = ? LIMIT 1');
  const row = stmt.get(messageId);
  return row ? (row as unknown as UsageEvent) : null;
}

export function getUsageAggregate(params: {
  since?: string;
  until?: string;
  groupBy?: 'model' | 'platform' | 'mode' | 'wake_type' | 'thread_id' | 'day';
}): UsageBucket[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (params.since) { clauses.push('created_at >= ?'); args.push(params.since); }
  if (params.until) { clauses.push('created_at <= ?'); args.push(params.until); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  let groupExpr = "'all'";
  if (params.groupBy === 'model') groupExpr = 'model';
  else if (params.groupBy === 'platform') groupExpr = 'platform';
  else if (params.groupBy === 'mode') groupExpr = 'mode';
  else if (params.groupBy === 'wake_type') groupExpr = 'wake_type';
  else if (params.groupBy === 'thread_id') groupExpr = 'thread_id';
  else if (params.groupBy === 'day') groupExpr = "substr(created_at, 1, 10)";

  const stmt = getDb().prepare(`
    SELECT ${groupExpr} as bucket,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd,
      COUNT(*) as request_count
    FROM usage_events
    ${where}
    GROUP BY bucket
    ORDER BY bucket
  `);
  return stmt.all(...args) as UsageBucket[];
}

export function getToolCallAggregate(params: {
  since?: string;
  until?: string;
}): UsageToolRow[] {
  const clauses: string[] = ['tool_calls IS NOT NULL'];
  const args: unknown[] = [];
  if (params.since) { clauses.push('created_at >= ?'); args.push(params.since); }
  if (params.until) { clauses.push('created_at <= ?'); args.push(params.until); }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const stmt = getDb().prepare(`SELECT tool_calls FROM usage_events ${where}`);
  const rows = stmt.all(...args) as Array<{ tool_calls: string }>;

  const counts = new Map<string, { count: number; requests: number }>();
  for (const row of rows) {
    try {
      const tools = JSON.parse(row.tool_calls) as Array<{ name: string; count: number }>;
      for (const t of tools) {
        const existing = counts.get(t.name) || { count: 0, requests: 0 };
        existing.count += t.count;
        existing.requests += 1;
        counts.set(t.name, existing);
      }
    } catch {}
  }
  return Array.from(counts.entries())
    .map(([name, v]) => ({ name, count: v.count, request_count: v.requests }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Starred messages (favorites)
// Adapted for byte-light under Apache 2.0
// (generic multi-actor). `starred_by` is an arbitrary actor slug: 'user' (human
// default), 'companion-a', 'companion-b', 'companion-c', or any future companion — no cage.
// ---------------------------------------------------------------------------

/** Arbitrary actor slug — human ('user') or any companion. Intentionally generic. */
export type StarredBy = string;

export interface StarredRow {
  id: string;
  message_id: string;
  starred_by: StarredBy;
  starred_at: string;
  note: string | null;
}

export interface StarredWithContext extends StarredRow {
  thread_id: string;
  thread_title: string | null;
  message_role: 'companion' | 'user' | 'system';
  message_content: string;
  message_content_type: string;
  message_created_at: string;
  message_deleted_at: string | null;
}

export function addStar(params: {
  id: string;
  messageId: string;
  starredBy: StarredBy;
  starredAt: string;
  note?: string | null;
}): StarredRow | null {
  const stmt = getDb().prepare(
    `INSERT INTO starred_messages (id, message_id, starred_by, starred_at, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(message_id, starred_by) DO NOTHING`
  );
  stmt.run(params.id, params.messageId, params.starredBy, params.starredAt, params.note ?? null);
  return getStar(params.messageId, params.starredBy);
}

export function removeStar(messageId: string, starredBy: StarredBy): boolean {
  const res = getDb()
    .prepare('DELETE FROM starred_messages WHERE message_id = ? AND starred_by = ?')
    .run(messageId, starredBy);
  return res.changes > 0;
}

export function getStar(messageId: string, starredBy: StarredBy): StarredRow | null {
  const row = getDb()
    .prepare('SELECT * FROM starred_messages WHERE message_id = ? AND starred_by = ?')
    .get(messageId, starredBy) as StarredRow | undefined;
  return row ?? null;
}

export function getStarsForMessage(messageId: string): StarredRow[] {
  return getDb()
    .prepare('SELECT * FROM starred_messages WHERE message_id = ? ORDER BY starred_at DESC')
    .all(messageId) as StarredRow[];
}

export function listStarred(filter: {
  starredBy?: StarredBy | 'all';
  limit?: number;
  offset?: number;
}): StarredWithContext[] {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.starredBy && filter.starredBy !== 'all') {
    where.push('s.starred_by = ?');
    params.push(filter.starredBy);
  }
  const sql = `
    SELECT
      s.id           AS id,
      s.message_id   AS message_id,
      s.starred_by   AS starred_by,
      s.starred_at   AS starred_at,
      s.note         AS note,
      m.thread_id    AS thread_id,
      m.role         AS message_role,
      m.content      AS message_content,
      m.content_type AS message_content_type,
      m.created_at   AS message_created_at,
      m.deleted_at   AS message_deleted_at,
      t.name         AS thread_title
    FROM starred_messages s
    JOIN messages m ON m.id = s.message_id
    LEFT JOIN threads t ON t.id = m.thread_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.starred_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);
  return getDb().prepare(sql).all(...params) as StarredWithContext[];
}

/** Count of stars grouped by actor slug — generic, whatever actors exist in the table. */
export function countStarredByActor(): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT starred_by, COUNT(*) AS c FROM starred_messages GROUP BY starred_by')
    .all() as { starred_by: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.starred_by] = r.c;
  return out;
}

// ─── Managed MCP servers ────────────────────────────────────────
// Ported from the reference implementation's services/db/mcp-servers.ts, Apache 2.0 —
// adapted to byte-light's monolithic db.ts (NAMED ADAPTATION #3).

export interface McpServerRow {
  id: number;
  name: string;
  url: string;
  api_key: string | null;
  enabled: number;
  tools_cache: string | null;
  last_discovered: string | null;
  created_at: string;
}

export function listMcpServers(): McpServerRow[] {
  return getDb().prepare('SELECT * FROM mcp_servers ORDER BY created_at').all() as McpServerRow[];
}

export function getMcpServer(id: number): McpServerRow | null {
  return (getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined) ?? null;
}

export function addMcpServer(name: string, url: string, apiKey?: string): McpServerRow {
  const stmt = getDb().prepare('INSERT INTO mcp_servers (name, url, api_key) VALUES (?, ?, ?)');
  const result = stmt.run(name, url, apiKey ?? null);
  return getMcpServer(result.lastInsertRowid as number)!;
}

export function deleteMcpServer(id: number): boolean {
  const result = getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  return result.changes > 0;
}

export function setMcpServerEnabled(id: number, enabled: boolean): boolean {
  const result = getDb().prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return result.changes > 0;
}

export function updateMcpServerToolsCache(id: number, toolsJson: string, discoveredAt: string): void {
  getDb().prepare('UPDATE mcp_servers SET tools_cache = ?, last_discovered = ? WHERE id = ?').run(toolsJson, discoveredAt, id);
}
