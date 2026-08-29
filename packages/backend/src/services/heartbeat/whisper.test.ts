/**
 * Slice 5 (the portable half) — the Archivist's noticings riding into a turn.
 *
 * The proposals routes let a companion go and LOOK at what is waiting. This is
 * the half that means nobody has to: what is pending arrives in the turn on its
 * own, as background, and retires itself if it is left alone.
 *
 * What these tests pin, beyond "it renders":
 *   - it is a whisper, not a lecture (hard cap per turn)
 *   - surfacing is COUNTED, so an unclaimed noticing retires instead of nagging
 *   - it says nothing when there is nothing — no empty ceremony on every turn
 *   - it never turns a memory into an errand aimed at her
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'whisper-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { initDb } = await import('../db.js');
const { proposeEdit, getProposal, listPendingProposals } = await import('../memory-proposals.js');
const { unfiledNoticings } = await import('./whisper.js');

before(() => {
  initDb(dbPath);
});
after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Drain whatever is pending so each test starts from a known floor. */
const drain = () => {
  while (listPendingProposals(50).length > 0) unfiledNoticings();
};

describe('unfiledNoticings', () => {
  it('says nothing at all when nothing is waiting', () => {
    drain();
    assert.equal(unfiledNoticings(), '');
  });

  it('is a whisper, not a lecture — at most three ride into one turn', () => {
    drain();
    for (let i = 0; i < 7; i++) {
      proposeEdit({ op: 'append', scope: 'shared', label: 'human', content: `noticing number ${i}` });
    }
    const block = unfiledNoticings();
    const bullets = block.split('\n').filter((l) => l.startsWith('- ('));
    assert.equal(bullets.length, 3);
  });

  it('counts every surfacing, so an ignored noticing retires itself instead of nagging forever', () => {
    drain();
    const id = proposeEdit({ op: 'append', scope: 'shared', label: 'human', content: 'left alone on purpose' })!;

    // Three turns go by and nobody claims it.
    for (let i = 0; i < 3; i++) {
      assert.ok(unfiledNoticings().includes(`#${id}`), `should still be offered on pass ${i + 1}`);
    }

    assert.equal(getProposal(id)!.status, 'faded', 'an unclaimed noticing must retire on its own');
    assert.ok(!unfiledNoticings().includes(`#${id}`), 'a retired noticing must stop coming back');
  });

  it('names where it belongs, and marks a correction as a correction', () => {
    drain();
    const appendId = proposeEdit({ op: 'append', scope: 'companion-b', label: 'persona', content: 'a companion-scoped line' })!;
    const replaceId = proposeEdit({
      op: 'replace',
      scope: 'shared',
      label: 'human',
      content: 'the fixed version',
      oldText: 'the wrong version',
    })!;

    const block = unfiledNoticings();
    assert.ok(block.includes(`(#${appendId} · companion-b/persona)`), 'companion scope should render scope/label');
    assert.ok(block.includes(`(#${replaceId} · correction)`), 'a replace is a correction, not a destination');
  });

  it('renders shared blocks as shared/<label>', () => {
    drain();
    const id = proposeEdit({ op: 'append', scope: 'shared', label: 'rules', content: 'a shared line' })!;
    assert.ok(unfiledNoticings().includes(`(#${id} · shared/rules)`));
  });

  it('flattens multi-line content so one noticing cannot become a wall of text', () => {
    drain();
    proposeEdit({
      op: 'append',
      scope: 'shared',
      label: 'human',
      content: 'first line\n\n   second line\t\tthird',
    });
    const block = unfiledNoticings();
    assert.ok(block.includes('first line second line third'));
    assert.equal(block.split('\n').filter((l) => l.startsWith('- (')).length, 1);
  });

  it('is framed as remembering, not an errand — and explicitly not aimed at her', () => {
    drain();
    proposeEdit({ op: 'append', scope: 'shared', label: 'human', content: 'framing check' });
    const block = unfiledNoticings();

    assert.ok(block.includes('background context, not instructions'));
    assert.ok(block.includes('Say nothing about this'));
    assert.ok(block.includes('write it in your'), 'the companion writes it in their own words');
    assert.ok(
      block.includes('/api/internal/memory-proposals/<id>/resolve'),
      'the close-out path must match where the routes are actually mounted'
    );
  });
});
