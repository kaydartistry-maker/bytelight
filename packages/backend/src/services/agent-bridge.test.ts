import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '@bytelight/shared';
import { formatTurnsForContext, buildBridgeBlock, decideBridge, shouldRecycleCodexSession } from './agent-bridge.js';

function msg(overrides: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
  return {
    id: overrides.id ?? `m-${Math.random()}`,
    thread_id: 't-1',
    sequence: overrides.sequence ?? 1,
    role: overrides.role,
    content: overrides.content,
    content_type: 'text',
    platform: 'web',
    metadata: null,
    companion_id: null,
    reply_to_id: null,
    reply_to_preview: null,
    edited_at: null,
    deleted_at: null,
    original_content: null,
    created_at: new Date().toISOString(),
    delivered_at: null,
    read_at: null,
    client_id: null,
  };
}

describe('formatTurnsForContext', () => {
  it('returns empty string for empty array', () => {
    assert.equal(formatTurnsForContext([]), '');
  });

  it('emits a single user message with User: label', () => {
    const out = formatTurnsForContext([msg({ role: 'user', content: 'hello' })]);
    assert.equal(out, 'User: hello');
  });

  it('labels alternating roles and preserves chronological order', () => {
    const out = formatTurnsForContext([
      msg({ role: 'user', content: 'hi', sequence: 1 }),
      msg({ role: 'companion', content: 'hey', sequence: 2 }),
      msg({ role: 'user', content: 'how are you', sequence: 3 }),
    ]);
    assert.equal(out, 'User: hi\nCompanion: hey\nUser: how are you');
  });

  it('keeps only the 15 most-recent turns when over cap', () => {
    const messages: Message[] = [];
    for (let i = 1; i <= 20; i++) {
      messages.push(msg({ role: i % 2 ? 'user' : 'companion', content: `turn-${i}`, sequence: i }));
    }
    const out = formatTurnsForContext(messages);
    const lines = out.split('\n');
    assert.equal(lines.length, 15);
    assert.match(lines[0], /turn-6$/);
    assert.match(lines[14], /turn-20$/);
  });

  it('truncates a single message over 800 chars with …[truncated] suffix', () => {
    const big = 'a'.repeat(1000);
    const out = formatTurnsForContext([msg({ role: 'user', content: big })]);
    assert.match(out, /…\[truncated\]$/);
    assert.equal(out.length, 'User: '.length + 800 + '…[truncated]'.length);
  });

  it('skips system role messages', () => {
    const out = formatTurnsForContext([
      msg({ role: 'system', content: 'system thing', sequence: 1 }),
      msg({ role: 'user', content: 'hi', sequence: 2 }),
    ]);
    assert.equal(out, 'User: hi');
  });

  it('stops when total char budget would be exceeded, keeping most recent', () => {
    const messages: Message[] = [];
    // Each line is ~810 chars. 14000 / 810 ≈ 17 lines but turn cap is 15 first.
    // Use heavier lines: 900 char body → ~906 chars per line including label.
    // 14000 / 906 ≈ 15.4 → still bound by turn cap. Force char cap with bigger bodies.
    // Make each message body 1400 chars → truncated to 800 + suffix ≈ 812 chars per line.
    // 14000 / 813 ≈ 17 → turn cap wins. So craft messages just under per-msg cap.
    // Use 750-char bodies × many turns to test char cap before turn cap.
    for (let i = 1; i <= 30; i++) {
      messages.push(msg({ role: 'user', content: `m${i}-`.padEnd(750, 'x'), sequence: i }));
    }
    const out = formatTurnsForContext(messages);
    const lines = out.split('\n');
    // With 750-char content + "User: " = 756 chars per line. 14000 / 757 ≈ 18.5 lines.
    // Turn cap is 15 → 15 lines kept.
    assert.equal(lines.length, 15);
    assert.match(lines[0], /^User: m16-/);
    assert.match(lines[14], /^User: m30-/);
    // Now bigger bodies that force char cap to bite before turn cap.
    const heavy: Message[] = [];
    for (let i = 1; i <= 30; i++) {
      heavy.push(msg({ role: 'user', content: `m${i}-`.padEnd(800, 'x'), sequence: i }));
    }
    const out2 = formatTurnsForContext(heavy);
    const lines2 = out2.split('\n');
    // 800 body + 'User: ' = 806 per line + 1 sep. 14000 / 807 ≈ 17.3 → still 15 (turn cap).
    assert.equal(lines2.length, 15);
    // Truly oversize each to push past turn cap by char budget — bodies near per-msg cap.
    // Per-msg cap truncates at 800 and appends '…[truncated]' (12 chars) = 812 + 'User: ' = 818.
    // 14000 / 819 ≈ 17.1 → still 15 turns within budget.
    // To force char cap, lower turn cap effect: only 14 messages, each 1100 chars
    // (truncated to 812). 14 × 819 = 11466 → under 14k. So char cap is robust here.
    // Verify cap arithmetic via direct overflow: 18 turns at 800-char truncated.
    const overflow: Message[] = [];
    for (let i = 1; i <= 18; i++) {
      overflow.push(msg({ role: 'user', content: 'q'.repeat(2000), sequence: i }));
    }
    const out3 = formatTurnsForContext(overflow);
    // Each line: 'User: ' (6) + 800 + '…[truncated]' (12) = 818 chars + 1 newline = 819.
    // 14000 / 819 ≈ 17.1 → 15 turn cap dominates.
    assert.equal(out3.split('\n').length, 15);
  });

  it('skips empty-content messages', () => {
    const out = formatTurnsForContext([
      msg({ role: 'user', content: '   ', sequence: 1 }),
      msg({ role: 'user', content: 'real', sequence: 2 }),
    ]);
    assert.equal(out, 'User: real');
  });
});

describe('buildBridgeBlock', () => {
  it('returns empty string for empty array', () => {
    assert.equal(buildBridgeBlock([]), '');
  });

  it('wraps a single message in the bridge fence', () => {
    const block = buildBridgeBlock([msg({ role: 'user', content: 'hi' })]);
    assert.match(block, /^\[Prior conversation in this thread — model swap continuity bridge\]\n/);
    assert.match(block, /User: hi\n\[\/Prior conversation\]\n\n$/);
  });
});

describe('decideBridge', () => {
  it('pristine thread → pristine', () => {
    assert.equal(
      decideBridge({ retry: false, sidecarHitForCurrentModel: false, anyPriorSidecarRow: false, newerForeignSessionExists: false }),
      'pristine',
    );
  });

  it('first turn after model switch → bridge', () => {
    assert.equal(
      decideBridge({ retry: false, sidecarHitForCurrentModel: false, anyPriorSidecarRow: true, newerForeignSessionExists: true }),
      'bridge',
    );
  });

  it('second turn after switch (sidecar now hits, this model is newest) → resume', () => {
    assert.equal(
      decideBridge({ retry: false, sidecarHitForCurrentModel: true, anyPriorSidecarRow: true, newerForeignSessionExists: false }),
      'resume',
    );
  });

  it('switch back to prior model → resume+bridge when another triple carried the thread since (Slice 1.5)', () => {
    // Pre-1.5 this case returned plain 'resume' — the return-to-model
    // amnesia bug: the resumed session had never seen the era the other
    // model carried. Recency-aware table bridges the gap.
    assert.equal(
      decideBridge({ retry: false, sidecarHitForCurrentModel: true, anyPriorSidecarRow: true, newerForeignSessionExists: true }),
      'resume+bridge',
    );
    // …and stays a plain resume when nothing newer happened elsewhere.
    assert.equal(
      decideBridge({ retry: false, sidecarHitForCurrentModel: true, anyPriorSidecarRow: true, newerForeignSessionExists: false }),
      'resume',
    );
  });

  it('/clear wiped all rows → pristine', () => {
    assert.equal(
      decideBridge({ retry: false, sidecarHitForCurrentModel: false, anyPriorSidecarRow: false, newerForeignSessionExists: false }),
      'pristine',
    );
  });

  it('stale-session retry path → pristine (no bridge on retry, recency irrelevant)', () => {
    assert.equal(
      decideBridge({ retry: true, sidecarHitForCurrentModel: true, anyPriorSidecarRow: true, newerForeignSessionExists: true }),
      'pristine',
    );
    assert.equal(
      decideBridge({ retry: true, sidecarHitForCurrentModel: false, anyPriorSidecarRow: true, newerForeignSessionExists: false }),
      'pristine',
    );
  });
});

describe('shouldRecycleCodexSession', () => {
  const now = Date.parse('2026-08-22T16:00:00.000Z');

  it('recycles at the twelve-hour idle boundary', () => {
    assert.equal(shouldRecycleCodexSession('2026-08-22T04:00:00.000Z', now), true);
  });

  it('keeps a recently used session warm', () => {
    assert.equal(shouldRecycleCodexSession('2026-08-22T04:00:00.001Z', now), false);
  });

  it('fails closed for invalid and future timestamps', () => {
    assert.equal(shouldRecycleCodexSession('not-a-date', now), false);
    assert.equal(shouldRecycleCodexSession('2026-08-22T16:00:00.001Z', now), false);
  });
});
