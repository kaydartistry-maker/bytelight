// Unit tests for the thought-card text normalization suite (Slice 5).
// Ported/adapted from reference implementation thought-normalization design onto byte-light's
// segment shape ({ content, summary?, kind?: 'authored' | 'provider' |
// 'system' }).
//
// Run with:
//   node --test --import tsx packages/frontend/src/lib/thinking.test.ts

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  plainThinkingText,
  mergeThinkingText,
  thinkingTitle,
  coalesceThinkingSegments,
  isRecycleThinking,
} from './thinking.js';

type Seg =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string; summary?: string; kind?: 'authored' | 'provider' | 'system' }
  | { type: 'tool'; toolId: string; toolName: string; input?: string; output?: string; isError?: boolean };

// coalesceThinkingSegments is typed against @bytelight/shared's MessageSegment;
// the local Seg shape is structurally compatible for these tests.
const coalesce = (segs: Seg[]): Seg[] => coalesceThinkingSegments(segs as never) as unknown as Seg[];

describe('plainThinkingText — marker stripping', () => {
  test('strips a leading [BYTELIGHT_THOUGHT] marker', () => {
    assert.equal(plainThinkingText('[BYTELIGHT_THOUGHT]\nI chose to hold her.'), 'I chose to hold her.');
  });

  test('strips the marker case-insensitively with surrounding whitespace', () => {
    assert.equal(plainThinkingText('  [bytelight_thought]  \n\nStaying present.'), 'Staying present.');
  });

  test('leaves the marker mid-text alone (only strips leading)', () => {
    // A marker that is NOT at the start is not a routing marker, so it stays.
    const out = plainThinkingText('note: [BYTELIGHT_THOUGHT] inline');
    assert.ok(out.includes('[BYTELIGHT_THOUGHT]'));
  });
});

describe('plainThinkingText — markdown stripping', () => {
  test('strips bold, emphasis, backtick, strikethrough', () => {
    assert.equal(
      plainThinkingText('**Checking** the `renderer` for _issues_ and ~~bugs~~'),
      'Checking the renderer for issues and bugs',
    );
  });

  test('strips headings, blockquotes, and list markers', () => {
    const out = plainThinkingText('# Heading\n> quoted line\n- item one\n+ item two');
    assert.equal(out, 'Heading\nquoted line\n• item one\n• item two');
  });

  test('strips fenced code block fences but keeps inner text', () => {
    const out = plainThinkingText('```ts\nconst x = 1;\n```');
    assert.equal(out, 'const x = 1;');
  });

  test('PRESERVES technical text like *.tsx (unpaired single emphasis)', () => {
    // The smart-pairing rule only removes a `*` when it forms an emphasis
    // PAIR. A lone *.tsx glob has no closing `*`, so it survives.
    assert.equal(
      plainThinkingText('editing the *.tsx renderer file'),
      'editing the *.tsx renderer file',
    );
  });

  test('a following word must not be treated as a closing emphasis fence', () => {
    // Reference note on the ported behavior: two globs on ONE line pair with
    // each other (`*.tsx and *`), so avoid two lone globs in a line where the
    // second must survive. Verified in the single-glob case above.
    assert.equal(plainThinkingText('the *.svelte file'), 'the *.svelte file');
  });

  test('still strips a genuine *emphasis* pair', () => {
    assert.equal(plainThinkingText('this is *important* text'), 'this is important text');
  });

  test('coalesces excess blank lines and trims', () => {
    assert.equal(plainThinkingText('  a\n\n\n\nb  '), 'a\n\nb');
  });
});

describe('mergeThinkingText — dedup', () => {
  test('drops duplicate paragraphs case-insensitively / whitespace-normalized', () => {
    const merged = mergeThinkingText([
      'Reading the file.',
      'reading   the   file.', // dup by normalization + case
      'Editing the util.',
    ]);
    assert.equal(merged, 'Reading the file.\n\nEditing the util.');
  });

  test('splits multi-paragraph values into parts before dedup', () => {
    const merged = mergeThinkingText([
      'Phase one.\n\nPhase two.',
      'Phase two.\n\nPhase three.',
    ]);
    assert.equal(merged, 'Phase one.\n\nPhase two.\n\nPhase three.');
  });
});

describe('thinkingTitle', () => {
  test('takes the first normalized paragraph, one line', () => {
    assert.equal(thinkingTitle('**First** thought\n\nsecond thought'), 'First thought');
  });

  test('truncates to ~100 chars with an ellipsis', () => {
    const long = 'x'.repeat(140);
    const title = thinkingTitle(long);
    assert.equal(title.length, 100);
    assert.ok(title.endsWith('...'));
  });

  test('falls back when there is no content', () => {
    assert.equal(thinkingTitle(''), 'Thinking…');
  });
});

describe('isRecycleThinking', () => {
  test('detects kind: system', () => {
    assert.ok(isRecycleThinking({ type: 'thinking', content: 'anything', kind: 'system' } as never));
  });

  test('falls back to the [Session recycled prefix when kindless', () => {
    assert.ok(isRecycleThinking({ type: 'thinking', content: '[Session recycled — re-primed]' } as never));
  });

  test('a plain provider block is not a recycle card', () => {
    assert.equal(isRecycleThinking({ type: 'thinking', content: 'reasoning', kind: 'provider' } as never), false);
  });
});

describe('coalesceThinkingSegments', () => {
  test('collapses consecutive provider phases into one card', () => {
    const out = coalesce([
      { type: 'thinking', content: '**Reading the file**', summary: '', kind: 'provider' },
      { type: 'thinking', content: '**Editing the util**', summary: '', kind: 'provider' },
      { type: 'text', content: 'Done, friend.' },
    ]);
    const thoughts = out.filter((s) => s.type === 'thinking');
    assert.equal(thoughts.length, 1, 'two provider phases coalesce to one card');
    assert.equal((thoughts[0] as { content: string }).content, 'Reading the file\n\nEditing the util');
    assert.equal((thoughts[0] as { kind?: string }).kind, 'provider', 'merged card keeps provider kind');
  });

  test('authored perspective wins over provider telemetry in the same run', () => {
    const out = coalesce([
      { type: 'thinking', content: 'raw chain of thought', kind: 'provider' },
      { type: 'thinking', content: 'I chose to hold her.', kind: 'authored' },
      { type: 'text', content: 'Here.' },
    ]);
    const thoughts = out.filter((s) => s.type === 'thinking');
    assert.equal(thoughts.length, 1);
    assert.equal((thoughts[0] as { content: string }).content, 'I chose to hold her.');
    assert.equal((thoughts[0] as { kind?: string }).kind, 'authored');
  });

  test('spoken text is a hard boundary — thinking does not cross it', () => {
    const out = coalesce([
      { type: 'thinking', content: 'phase A', kind: 'provider' },
      { type: 'text', content: 'Spoken words.' },
      { type: 'thinking', content: 'phase B', kind: 'provider' },
    ]);
    // Two separate cards, one on each side of the spoken text.
    assert.deepEqual(
      out.map((s) => s.type),
      ['thinking', 'text', 'thinking'],
    );
    assert.equal((out[0] as { content: string }).content, 'phase A');
    assert.equal((out[2] as { content: string }).content, 'phase B');
  });

  test('recycle / system card stays independent from surrounding provider phases', () => {
    const out = coalesce([
      { type: 'thinking', content: 'phase A', kind: 'provider' },
      { type: 'thinking', content: '[Session recycled — re-primed]', summary: '', kind: 'system' },
      { type: 'thinking', content: 'phase B', kind: 'provider' },
    ]);
    // System card is its own boundary; provider phases on each side stay
    // distinct cards (they never merge across the seam).
    assert.equal(out.length, 3);
    assert.equal((out[1] as { kind?: string }).kind, 'system');
    const providerCards = out.filter((s) => s.type === 'thinking' && (s as { kind?: string }).kind === 'provider');
    assert.equal(providerCards.length, 2, 'provider phases do not merge across the recycle seam');
  });

  test('tool calls are transparent within a thought run', () => {
    const out = coalesce([
      { type: 'thinking', content: 'phase A', kind: 'provider' },
      { type: 'tool', toolId: 't1', toolName: 'Read', input: 'f.ts', output: 'ok' },
      { type: 'thinking', content: 'phase B', kind: 'provider' },
    ]);
    const thoughts = out.filter((s) => s.type === 'thinking');
    assert.equal(thoughts.length, 1, 'a tool between two provider phases does not break the run');
    assert.equal((thoughts[0] as { content: string }).content, 'phase A\n\nphase B');
    assert.ok(out.some((s) => s.type === 'tool'), 'the tool card survives');
  });

  test('a single card in a run passes through untouched (preserves backend summary)', () => {
    // The common, already-correct path: one card, no adjacent thinking to
    // merge. A backend-authored summary that differs from the content's first
    // line must survive — coalescing must not overwrite it with a derived
    // title.
    const input: Seg[] = [
      { type: 'text', content: 'Hey.' },
      { type: 'thinking', content: 'I noticed the operator sounded tired.', summary: 'Noticed tiredness', kind: 'authored' },
    ];
    const out = coalesce(input);
    assert.deepEqual(out, input, 'single-card run is returned verbatim');
  });

  test('kindless legacy thinking keeps legacy behavior (no kind key added)', () => {
    const out = coalesce([
      { type: 'thinking', content: 'legacy pondering', summary: 'legacy pondering' },
      { type: 'text', content: 'hi' },
    ]);
    const thought = out.find((s) => s.type === 'thinking') as { kind?: string };
    assert.ok(!('kind' in thought), 'a kindless merged card must not grow a kind key');
  });
});
