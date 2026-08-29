import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Disk-backed DB so initDb (opens by path) can attach. Same bootstrap shape as
// db.message-context.test.ts. Stubs RESONANT_HOME before importing db.js.
const tmpRoot = mkdtempSync(join(tmpdir(), 'digest-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const dbMod = await import('./db.js');
const { initDb } = dbMod;
const digestMod = await import('./digest.js');
const { selectDigestCandidates, setDigestCursor, clampDigestBacklog } = digestMod;

// Home-thread world: named, non-archived threads only. We build four:
//   t-hot     — 6 fresh text messages past cursor 0   → digested
//   t-quiet   — 3 fresh text messages past cursor 0   → below MIN_MESSAGES, skipped
//   t-archived— 6 fresh text messages but archived    → skipped
//   t-deep    — 160 fresh text messages, no cursor    → backlog clamped to last 150
// Plus a soft-deleted / non-text message in t-hot to prove the eligible filter.
before(() => {
  initDb(dbPath);
  const raw = new Database(dbPath);
  const now = new Date().toISOString();

  const insThread = raw.prepare(`
    INSERT INTO threads (id, name, type, archived_at, created_at, last_activity_at, unread_count, current_session_id)
    VALUES (?, ?, 'named', ?, ?, ?, 0, NULL)
  `);
  insThread.run('t-hot', 'Home', null, now, now);
  insThread.run('t-quiet', 'Quiet Corner', null, now, now);
  insThread.run('t-archived', 'Old Thread', '2026-07-01T00:00:00.000Z', now, now);

  const ins = raw.prepare(`
    INSERT INTO messages (id, thread_id, sequence, role, content, content_type, created_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const mk = (id: string, thread: string, seq: number, opts: { deleted?: boolean; type?: string } = {}) => {
    // One minute per sequence keeps timestamps valid at any depth (seq > 59).
    const t = new Date(Date.parse('2026-07-02T10:00:00.000Z') + seq * 60_000).toISOString();
    const role = seq % 2 === 0 ? 'companion' : 'user';
    ins.run(id, thread, seq, role, `body ${id}`, opts.type ?? 'text', t, opts.deleted ? t : null);
  };

  // t-hot: 6 eligible text messages (seq 1..6), plus a soft-deleted (7) and an
  // image (8) that must NOT count toward the eligible total.
  for (let i = 1; i <= 6; i++) mk(`hot-${i}`, 't-hot', i);
  mk('hot-7', 't-hot', 7, { deleted: true });
  mk('hot-8', 't-hot', 8, { type: 'image' });

  // t-quiet: only 3 eligible messages — under MIN_MESSAGES.
  for (let i = 1; i <= 3; i++) mk(`quiet-${i}`, 't-quiet', i);

  // t-archived: plenty of messages, but the thread is archived.
  for (let i = 1; i <= 6; i++) mk(`arch-${i}`, 't-archived', i);

  // t-deep: 160 eligible messages and no cursor row — the first-run backlog
  // case (live threads sat at 1,000+ messages before the Home-thread Scribe).
  insThread.run('t-deep', 'OG Backlog', null, now, now);
  for (let i = 1; i <= 160; i++) mk(`deep-${i}`, 't-deep', i);

  raw.close();
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('selectDigestCandidates (Home-thread world thread selection)', () => {
  it('picks a non-archived thread with >= MIN_MESSAGES new eligible messages', () => {
    const c = selectDigestCandidates();
    const hot = c.find(t => t.id === 't-hot');
    assert.ok(hot, 't-hot is a candidate');
    // Eligible = text AND not deleted → seq 1..6 counted; deleted-7 and image-8 excluded.
    assert.equal(hot!.newCount, 6, 'only the 6 eligible messages counted');
    assert.equal(hot!.maxSeq, 6, 'maxSeq is the last eligible sequence (not the image at 8)');
    assert.equal(hot!.lastSeq, 0, 'cursor starts at 0');
    assert.equal(hot!.name, 'Home', 'thread name carried through for the header');
  });

  it('skips a thread with fewer than MIN_MESSAGES new messages', () => {
    const c = selectDigestCandidates();
    assert.ok(!c.some(t => t.id === 't-quiet'), 't-quiet (3 messages) excluded');
  });

  it('skips an archived thread even when it has enough messages', () => {
    const c = selectDigestCandidates();
    assert.ok(!c.some(t => t.id === 't-archived'), 'archived thread excluded');
  });

  it('clamps a deep first-run backlog to the most recent MAX_BACKLOG_PER_RUN window', () => {
    const c = selectDigestCandidates();
    const deep = c.find(t => t.id === 't-deep');
    assert.ok(deep, 't-deep is a candidate');
    assert.equal(deep!.lastSeq, 0, 'no cursor row → cursor 0');
    assert.equal(deep!.maxSeq, 160, 'full backlog visible to selection');

    // The clamp moves the effective cursor so only the last 150 sequences run.
    const { effectiveLastSeq, skipped } = clampDigestBacklog(deep!.lastSeq, deep!.maxSeq);
    assert.equal(effectiveLastSeq, 10, 'effective window starts at maxSeq - 150');
    assert.equal(skipped, 10, 'the 10 oldest sequences are skipped (loudly)');

    // The read window past the clamped cursor holds exactly the recent 150
    // eligible messages here (all-text fixture; with deleted/non-text rows the
    // window may legitimately hold fewer).
    const rows = dbMod.getDb().prepare(
      `SELECT sequence FROM messages WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL AND content_type = 'text' ORDER BY sequence ASC`
    ).all('t-deep', effectiveLastSeq) as Array<{ sequence: number }>;
    assert.equal(rows.length, 150, 'window holds the most recent 150 messages');
    assert.equal(rows[0].sequence, 11, 'oldest message in window is seq 11');
    assert.equal(rows[rows.length - 1].sequence, 160, 'newest is seq 160');
  });

  it('leaves a shallow backlog unclamped', () => {
    const { effectiveLastSeq, skipped } = clampDigestBacklog(0, 6);
    assert.equal(effectiveLastSeq, 0, 'cursor untouched under the threshold');
    assert.equal(skipped, 0, 'nothing skipped');
  });

  it('advancing the cursor past the messages drops the thread on the next pass', () => {
    // Simulate a successful digest: advance t-hot's cursor to its maxSeq.
    setDigestCursor('t-hot', 6);
    const c = selectDigestCandidates();
    assert.ok(!c.some(t => t.id === 't-hot'), 't-hot no longer a candidate once caught up');
    // Restore so test ordering can't leak state.
    setDigestCursor('t-hot', 0);
  });
});
