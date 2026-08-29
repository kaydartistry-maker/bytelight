import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Disk-backed DB so initDb (opens by path) can attach. Same bootstrap shape as
// db.bridge.test.ts. Stubs RESONANT_HOME before importing db.js.
const tmpRoot = mkdtempSync(join(tmpdir(), 'msgctx-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const dbMod = await import('./db.js');
const { initDb, getMessageContext } = dbMod;

// Ten messages, sequence 1..10. m5 is the mid-thread target. m4 is soft-deleted
// so we can prove the window skips deleted rows.
const MID = 'm5';

before(() => {
  initDb(dbPath);
  const raw = new Database(dbPath);
  const now = new Date().toISOString();
  raw.prepare(`
    INSERT INTO threads (id, name, type, archived_at, created_at, last_activity_at, unread_count, current_session_id)
    VALUES ('t-ctx', 'ctx', 'named', NULL, ?, ?, 0, NULL)
  `).run(now, now);

  const ins = raw.prepare(`
    INSERT INTO messages (id, thread_id, sequence, role, content, created_at, deleted_at)
    VALUES (?, 't-ctx', ?, ?, ?, ?, ?)
  `);
  for (let i = 1; i <= 10; i++) {
    const t = `2026-07-02T10:0${i}:00.000Z`;
    const role = i % 2 === 0 ? 'companion' : 'user';
    // m4 soft-deleted
    const deletedAt = i === 4 ? '2026-07-02T12:00:00.000Z' : null;
    ins.run(`m${i}`, i, role, `body ${i}`, t, deletedAt);
  }
  raw.close();
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getMessageContext (around-message window, powers ?around= endpoint)', () => {
  it('returns a window centered on the target with both neighbors present', () => {
    // windowSize 2 → sequence 3..7, minus soft-deleted m4.
    const win = getMessageContext(MID, 2);
    const ids = win.map(m => m.id);
    // target present
    assert.ok(ids.includes('m5'), 'target message present');
    // immediate neighbors on each side present
    assert.ok(ids.includes('m6'), 'right neighbor present');
    assert.ok(ids.includes('m3'), 'left neighbor present (skipping deleted m4)');
  });

  it('emits the window in chronological (ascending sequence) order', () => {
    const win = getMessageContext(MID, 2);
    const ids = win.map(m => m.id);
    // m4 excluded (soft-deleted), so 3,5,6,7 in order
    assert.deepEqual(ids, ['m3', 'm5', 'm6', 'm7']);
  });

  it('respects deleted_at — soft-deleted rows never appear in the window', () => {
    const win = getMessageContext(MID, 2);
    assert.ok(!win.map(m => m.id).includes('m4'), 'soft-deleted m4 excluded');
  });

  it('a larger window pulls more surrounding context, still deleted-aware', () => {
    // windowSize 5 → sequence 0..10 → all rows except deleted m4.
    const win = getMessageContext(MID, 5);
    assert.deepEqual(
      win.map(m => m.id),
      ['m1', 'm2', 'm3', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'],
    );
  });

  it('clamps at thread edges — window near the last message is truncated, not padded', () => {
    const win = getMessageContext('m10', 2);
    // sequence 8..12 → only 8,9,10 exist.
    assert.deepEqual(win.map(m => m.id), ['m8', 'm9', 'm10']);
  });

  it('returns an empty window for an unknown message id', () => {
    assert.deepEqual(getMessageContext('does-not-exist', 2), []);
  });
});
