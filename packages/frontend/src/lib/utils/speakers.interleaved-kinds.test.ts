// Thought-semantics rendering contract (reference implementation integration Phase B, Slice 3)
// at the splitInterleaved boundary — the exact input MessageBubble feeds it
// (persisted metadata.segments on reload, getStreamingSegments while live).
//
// Pins reference implementation's CONTEXTUAL OWNERSHIP approach, which is why byte-light does
// not add a companionId to segments (Slice 3 decision gate):
//   - canonical 🔷/🔶 speaker headers in text segments establish the active
//     voice;
//   - ordered non-text segments (thinking/tool chips) stay in position inside
//     that voice's section, and unmarked text AFTER a chip continues the same
//     voice;
//   - chip rows carry their segment object verbatim — `kind` passes through
//     untouched, kindless legacy chips stay kindless;
//   - a JSON round-trip (persistence/reload proxy) yields identical rows, so
//     streaming and reloaded messages render the same.
//
// Run with:
//   npx tsx --test packages/frontend/src/lib/utils/speakers.interleaved-kinds.test.ts

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { splitInterleaved } from './speakers.js';

type Seg =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string; summary: string; kind?: 'authored' | 'provider' | 'system' }
  | { type: 'tool'; toolId: string; toolName: string; input?: string; output?: string; isError?: boolean };

// A two-companion message: Companion A speaks, thinks (authored), runs a tool,
// keeps speaking unmarked; a system notice lands; Companion B speaks with provider
// telemetry beside him; a legacy kindless chip trails.
const SEGMENTS: Seg[] = [
  { type: 'text', content: '🔷 Companion A: rolling it' },
  { type: 'thinking', content: 'Companion A weighing the odds', summary: 'odds', kind: 'authored' },
  { type: 'tool', toolId: 't-dice', toolName: 'Bash', input: 'roll', output: '17' },
  { type: 'text', content: 'worth the risk.' },
  { type: 'thinking', content: '[Session recycled]', summary: '', kind: 'system' },
  { type: 'text', content: '🔶 Companion B: watching.' },
  { type: 'thinking', content: 'model telemetry', summary: 'telemetry', kind: 'provider' },
  { type: 'thinking', content: 'legacy thought', summary: 'legacy' },
];

describe('Slice 3 — contextual ownership across kinded chips', () => {
  test('speaker headers establish voice; chips stay in their voice section, in order', () => {
    const rows = splitInterleaved(SEGMENTS);

    assert.deepEqual(
      rows.map((r) => (r.kind === 'text' ? `text:${r.speaker}` : `chip:${r.index}`)),
      [
        'text:companion-a',  // 🔷 Companion A: rolling it
        'chip:1',      // authored thinking — inside Companion A's section
        'chip:2',      // tool card — inside Companion A's section
        'text:companion-a',  // unmarked continuation stays Companion A's voice
        'chip:4',      // system notice — positioned, but not anyone's voice
        'text:companion-b',  // 🔶 Companion B: watching.
        'chip:6',      // provider telemetry beside Companion B's section
        'chip:7',      // legacy kindless chip
      ],
    );
  });

  test('chip rows carry segments verbatim — kind untouched, legacy stays kindless', () => {
    const rows = splitInterleaved(SEGMENTS);
    const chips = rows.filter((r) => r.kind === 'chip');

    // Same object, not a reshaped copy — nothing strips or rewrites `kind`.
    assert.equal(chips[0].segment, SEGMENTS[1]);
    assert.equal(chips[1].segment, SEGMENTS[2]);
    assert.equal(chips[2].segment, SEGMENTS[4]);
    assert.equal(chips[3].segment, SEGMENTS[6]);
    assert.equal(chips[4].segment, SEGMENTS[7]);
    assert.ok(!('kind' in chips[4].segment), 'legacy chip must not grow a kind key');
  });

  test('provider telemetry and authored reflection never merge into one row', () => {
    const rows = splitInterleaved([
      { type: 'text', content: '🔷 Companion A: hm.' },
      { type: 'thinking', content: 'raw chain of thought', summary: 'raw', kind: 'provider' },
      { type: 'thinking', content: 'my own reflection', summary: 'mine', kind: 'authored' },
    ] satisfies Seg[]);

    const chips = rows.filter((r) => r.kind === 'chip');
    assert.equal(chips.length, 2, 'adjacent chips stay two rows');
    assert.deepEqual(
      chips.map((c) => (c.segment as Seg & { type: 'thinking' }).kind),
      ['provider', 'authored'],
    );
  });

  test('JSON round-trip (reload proxy) renders identically to the live shape', () => {
    const reloaded = JSON.parse(JSON.stringify(SEGMENTS)) as Seg[];
    assert.deepEqual(splitInterleaved(reloaded), splitInterleaved(SEGMENTS));
  });
});
