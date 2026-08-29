import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same bootstrap shape as digest.test.ts: stub RESONANT_HOME before importing
// anything that can touch config. The helpers under test are parameterized
// (explicit dir) so no DB is needed.
const tmpRoot = mkdtempSync(join(tmpdir(), 'digest-weekly-test-'));
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const digestMod = await import('./digest.js');
const { isoWeekLabel, weeklyDigestFileName, findLatestWeeklyDigest, WEEKLY_DIGEST_EXCERPT_MAX } = digestMod;

describe('isoWeekLabel / weeklyDigestFileName', () => {
  it('computes ISO week labels (Sunday belongs to the preceding ISO week)', () => {
    // 2026-08-09 is a Sunday; ISO weeks run Mon–Sun, so it closes week 32.
    assert.equal(isoWeekLabel(new Date(2026, 7, 9)), '2026-W32');
    // Monday opens the next week.
    assert.equal(isoWeekLabel(new Date(2026, 7, 10)), '2026-W33');
  });

  it('uses the ISO year at year boundaries', () => {
    // 2027-01-01 is a Friday inside ISO week 2026-W53.
    assert.equal(isoWeekLabel(new Date(2027, 0, 1)), '2026-W53');
    // 2024-12-30 is a Monday inside ISO week 2025-W01.
    assert.equal(isoWeekLabel(new Date(2024, 11, 30)), '2025-W01');
  });

  it('zero-pads the week number in the file name', () => {
    // 2026-01-07 is a Wednesday in week 2.
    assert.equal(weeklyDigestFileName(new Date(2026, 0, 7)), 'digest-2026-W02.md');
  });
});

describe('findLatestWeeklyDigest', () => {
  const dir = join(tmpRoot, 'digests');

  before(() => {
    mkdirSync(dir, { recursive: true });
    // Daily Scribe digests and stray files must be ignored.
    writeFileSync(join(dir, '2026-08-08.md'), '# Daily Digest — 2026-08-08\n');
    writeFileSync(join(dir, 'digest-notaweek.md'), 'nope');
    // Two weekly digests — lexical sort must pick the later week.
    writeFileSync(join(dir, 'digest-2026-W31.md'), 'older week');
    writeFileSync(join(dir, 'digest-2026-W32.md'), '# Weekly Digest — 2026-W32\n\nWhat shipped: things.');
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the most recent weekly digest with path and excerpt', () => {
    const latest = findLatestWeeklyDigest(dir);
    assert.ok(latest);
    assert.equal(latest.path, join(dir, 'digest-2026-W32.md'));
    assert.match(latest.excerpt, /What shipped: things\./);
  });

  it('clamps the excerpt to the orientation budget', () => {
    writeFileSync(join(dir, 'digest-2026-W33.md'), 'x'.repeat(WEEKLY_DIGEST_EXCERPT_MAX + 500));
    const latest = findLatestWeeklyDigest(dir);
    assert.ok(latest);
    assert.ok(latest.excerpt.length <= WEEKLY_DIGEST_EXCERPT_MAX + 100); // clamp + truncation marker
    assert.match(latest.excerpt, /truncated/);
    rmSync(join(dir, 'digest-2026-W33.md'));
  });

  it('returns null when the dir is missing or holds no weekly digests', () => {
    assert.equal(findLatestWeeklyDigest(join(tmpRoot, 'nope')), null);
    const empty = join(tmpRoot, 'empty');
    mkdirSync(empty);
    assert.equal(findLatestWeeklyDigest(empty), null);
  });
});
