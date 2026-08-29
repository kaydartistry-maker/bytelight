import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mirror the prod migration bootstrap from db.ts initDb(). We need a real
// disk-backed DB so initDb (which opens by path) can attach to it, AND we
// need a stable config dir for getBytelightConfig() if anything pulls it.
const tmpRoot = mkdtempSync(join(tmpdir(), 'bridge-test-'));
const dbPath = join(tmpRoot, 'test.db');

// Stub RESONANT_HOME so config loader (if invoked) has somewhere safe.
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

// Dynamic import AFTER env stub.
const dbMod = await import('./db.js');
const { initDb, setProviderSession, getProviderSession, clearProviderSessionsForThread, hasAnyProviderSessionForThread, getMostRecentProviderSession, getMessages } = dbMod;
const { decideBridge, buildBridgeBlock } = await import('./agent-bridge.js');

before(() => {
  initDb(dbPath);
  // Insert thread row to satisfy FK (thread_provider_sessions.thread_id REFERENCES threads.id).
  const raw = new Database(dbPath);
  raw.prepare(`
    INSERT INTO threads (id, name, type, archived_at, created_at, last_activity_at, unread_count, current_session_id)
    VALUES ('t-alpha', 'alpha', 'named', NULL, ?, ?, 0, NULL),
           ('t-beta',  'beta',  'named', NULL, ?, ?, 0, NULL),
           ('t-gamma', 'gamma', 'named', NULL, ?, ?, 0, NULL),
           ('t-delta', 'delta', 'named', NULL, ?, ?, 0, NULL)
  `).run(...Array.from({ length: 8 }, () => new Date().toISOString()));
  raw.close();
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('hasAnyProviderSessionForThread', () => {
  it('returns false for unknown thread id', () => {
    assert.equal(hasAnyProviderSessionForThread('does-not-exist'), false);
  });

  it('returns false for a thread with no sidecar rows', () => {
    assert.equal(hasAnyProviderSessionForThread('t-alpha'), false);
  });

  it('returns true after setProviderSession writes any row', () => {
    setProviderSession({
      threadId: 't-alpha',
      runtimeId: 'claude-sdk',
      provider: 'anthropic',
      modelRef: 'claude-sonnet-4-6',
      sessionId: 'sess-1',
    });
    assert.equal(hasAnyProviderSessionForThread('t-alpha'), true);
  });

  it('still returns true with multiple model_ref rows for the thread', () => {
    setProviderSession({
      threadId: 't-alpha',
      runtimeId: 'claude-sdk',
      provider: 'anthropic',
      modelRef: 'claude-opus-4-7',
      sessionId: 'sess-2',
    });
    assert.equal(hasAnyProviderSessionForThread('t-alpha'), true);
  });

  it('returns false after clearProviderSessionsForThread wipes the thread', () => {
    const cleared = clearProviderSessionsForThread('t-alpha');
    assert.ok(cleared >= 2);
    assert.equal(hasAnyProviderSessionForThread('t-alpha'), false);
  });

  it('returns true regardless of which model_ref was written (not keyed on model)', () => {
    setProviderSession({
      threadId: 't-beta',
      runtimeId: 'claude-sdk',
      provider: 'anthropic',
      modelRef: 'some-future-model-id',
      sessionId: 'sess-x',
    });
    assert.equal(hasAnyProviderSessionForThread('t-beta'), true);
    clearProviderSessionsForThread('t-beta');
    setProviderSession({
      threadId: 't-beta',
      runtimeId: 'claude-sdk',
      provider: 'anthropic',
      modelRef: 'another-different-model',
      sessionId: 'sess-y',
    });
    assert.equal(hasAnyProviderSessionForThread('t-beta'), true);
  });
});

describe('getProviderSession descriptor parity', () => {
  // The sidecar key is the full (runtimeId, provider, modelRef) triple.
  // agent.ts resolves ONE runtime descriptor per turn and threads it to
  // both the read and the write — these cases prove the DB honors that
  // key exactly: hit only under the same triple, miss if ANY leg differs.
  // Non-Claude ids below follow the e600a13 vocabulary ('ollama-native',
  // 'openai-compat', provider 'ollama') — flagged OFF, not live here.
  const key = {
    threadId: 't-gamma',
    runtimeId: 'claude-sdk',
    provider: 'anthropic',
    modelRef: 'claude-sonnet-4-6',
  };

  it('hits under the exact (runtimeId, provider, modelRef) triple it was written under', () => {
    setProviderSession({ ...key, sessionId: 'sess-parity-1' });
    const row = getProviderSession(key);
    assert.ok(row);
    assert.equal(row.session_id, 'sess-parity-1');
  });

  it('misses under a different runtimeId (same provider + modelRef)', () => {
    assert.equal(getProviderSession({ ...key, runtimeId: 'ollama-native' }), null);
  });

  it('misses under a different provider (same runtimeId + modelRef)', () => {
    assert.equal(getProviderSession({ ...key, provider: 'ollama' }), null);
  });

  it('misses under a different modelRef (same runtimeId + provider)', () => {
    assert.equal(getProviderSession({ ...key, modelRef: 'claude-opus-4-7' }), null);
  });

  it('files two descriptors independently — no cross-contamination', () => {
    const otherKey = {
      threadId: 't-gamma',
      runtimeId: 'openai-compat',
      provider: 'ollama',
      modelRef: 'llama3',
    };
    setProviderSession({ ...otherKey, sessionId: 'sess-parity-2' });
    assert.equal(getProviderSession(key)?.session_id, 'sess-parity-1');
    assert.equal(getProviderSession(otherKey)?.session_id, 'sess-parity-2');
  });
});

describe('decideBridge decision table (recency-aware, Slice 1.5)', () => {
  it('retry always wins: pristine even with a hit and a newer foreign row', () => {
    assert.equal(decideBridge({
      retry: true,
      sidecarHitForCurrentModel: true,
      anyPriorSidecarRow: true,
      newerForeignSessionExists: true,
    }), 'pristine');
  });

  it('hit with nothing newer under a foreign triple → plain resume (pre-1.5 behavior)', () => {
    assert.equal(decideBridge({
      retry: false,
      sidecarHitForCurrentModel: true,
      anyPriorSidecarRow: true,
      newerForeignSessionExists: false,
    }), 'resume');
  });

  it('hit with a strictly newer foreign row → resume+bridge (return-to-model amnesia fix)', () => {
    assert.equal(decideBridge({
      retry: false,
      sidecarHitForCurrentModel: true,
      anyPriorSidecarRow: true,
      newerForeignSessionExists: true,
    }), 'resume+bridge');
  });

  it('miss with any prior sidecar row → bridge (recency flag irrelevant on miss)', () => {
    assert.equal(decideBridge({
      retry: false,
      sidecarHitForCurrentModel: false,
      anyPriorSidecarRow: true,
      newerForeignSessionExists: true,
    }), 'bridge');
  });

  it('miss on a pristine thread → pristine', () => {
    assert.equal(decideBridge({
      retry: false,
      sidecarHitForCurrentModel: false,
      anyPriorSidecarRow: false,
      newerForeignSessionExists: false,
    }), 'pristine');
  });
});

describe('getMostRecentProviderSession', () => {
  // Fixed timestamps so recency is deterministic (setProviderSession stamps
  // "now" internally; we pin last_used_at with a raw UPDATE afterwards).
  const T_OLD = '2026-07-01T00:00:00.000Z';
  const T_NEW = '2026-07-03T00:00:00.000Z';

  it('returns null for a thread with no sidecar rows', () => {
    assert.equal(getMostRecentProviderSession('t-delta'), null);
  });

  it('returns the row with the newest last_used_at across triples', () => {
    setProviderSession({
      threadId: 't-delta',
      runtimeId: 'claude-sdk',
      provider: 'anthropic',
      modelRef: 'claude-opus-4-7',
      sessionId: 'sess-old-era',
    });
    setProviderSession({
      threadId: 't-delta',
      runtimeId: 'claude-sdk',
      provider: 'anthropic',
      modelRef: 'claude-sonnet-4-6',
      sessionId: 'sess-new-era',
    });
    const raw = new Database(dbPath);
    raw.prepare('UPDATE thread_provider_sessions SET last_used_at = ? WHERE thread_id = ? AND model_ref = ?')
      .run(T_OLD, 't-delta', 'claude-opus-4-7');
    raw.prepare('UPDATE thread_provider_sessions SET last_used_at = ? WHERE thread_id = ? AND model_ref = ?')
      .run(T_NEW, 't-delta', 'claude-sonnet-4-6');
    raw.close();

    const newest = getMostRecentProviderSession('t-delta');
    assert.ok(newest);
    assert.equal(newest.model_ref, 'claude-sonnet-4-6');
    assert.equal(newest.session_id, 'sess-new-era');
    assert.equal(newest.last_used_at, T_NEW);
  });

  it('models the amnesia repro: hit row is stale, newest row is a different triple', () => {
    // Operator returns to Opus: sidecar HITS on the opus triple, but the
    // sonnet triple carried the thread more recently → agent.ts computes
    // newerForeignSessionExists=true → decideBridge says resume+bridge.
    const hit = getProviderSession({
      threadId: 't-delta',
      runtimeId: 'claude-sdk',
      provider: 'anthropic',
      modelRef: 'claude-opus-4-7',
    });
    const newest = getMostRecentProviderSession('t-delta');
    assert.ok(hit);
    assert.ok(newest);
    assert.ok(newest.last_used_at > hit.last_used_at);
    assert.notEqual(newest.model_ref, hit.model_ref);
    assert.equal(decideBridge({
      retry: false,
      sidecarHitForCurrentModel: true,
      anyPriorSidecarRow: true,
      newerForeignSessionExists: newest.last_used_at > hit.last_used_at
        && (newest.runtime_id !== hit.runtime_id
          || newest.provider !== hit.provider
          || newest.model_ref !== hit.model_ref),
    }), 'resume+bridge');
  });
});

describe('getMessages since filter (recency bridge window)', () => {
  const T1 = '2026-07-02T10:00:00.000Z';
  const T2 = '2026-07-02T11:00:00.000Z';
  const T3 = '2026-07-02T12:00:00.000Z';
  const T4 = '2026-07-02T13:00:00.000Z';

  it('returns only messages created strictly after `since`, in chronological order', () => {
    const raw = new Database(dbPath);
    const ins = raw.prepare(`
      INSERT INTO messages (id, thread_id, sequence, role, content, created_at)
      VALUES (?, 't-delta', ?, ?, ?, ?)
    `);
    ins.run('m1', 1, 'user', 'first — old era', T1);
    ins.run('m2', 2, 'companion', 'second — old era', T2);
    ins.run('m3', 3, 'user', 'third — new era', T3);
    ins.run('m4', 4, 'companion', 'fourth — new era', T4);
    raw.close();

    const sinceT2 = getMessages({ threadId: 't-delta', since: T2 });
    assert.deepEqual(sinceT2.map(m => m.id), ['m3', 'm4']); // strict: m2 excluded
  });

  it('without since, returns all messages chronologically (oldest first)', () => {
    const all = getMessages({ threadId: 't-delta' });
    assert.deepEqual(all.map(m => m.id), ['m1', 'm2', 'm3', 'm4']);
  });

  it('limit keeps the NEWEST rows, still emitted oldest-first', () => {
    const last2 = getMessages({ threadId: 't-delta', limit: 2 });
    assert.deepEqual(last2.map(m => m.id), ['m3', 'm4']);
    const since1limit2 = getMessages({ threadId: 't-delta', since: T1, limit: 2 });
    assert.deepEqual(since1limit2.map(m => m.id), ['m3', 'm4']);
  });
});

describe('bridge block chronology (named landmine: getMessages ordering)', () => {
  it('renders the transcript oldest-first when given chronological input', () => {
    // getMessages hands buildBridgeBlock chronological input (DESC SQL +
    // .reverse() in db.ts). This pins the pairing: transcript must read
    // top-to-bottom in the order the conversation happened.
    const msgs = getMessages({ threadId: 't-delta' });
    const block = buildBridgeBlock(msgs);
    const iFirst = block.indexOf('first — old era');
    const iSecond = block.indexOf('second — old era');
    const iThird = block.indexOf('third — new era');
    const iFourth = block.indexOf('fourth — new era');
    assert.ok(iFirst >= 0 && iSecond > iFirst && iThird > iSecond && iFourth > iThird);
    assert.ok(block.indexOf('User: first') < block.indexOf('Companion: second'));
  });
});
