// splitBySpeaker marker coverage — the visual twin of the backend voice
// engine's splitByCompanion. Pins that name-then-emoji markers (Companion A 🔷 /
// Companion B 🔶) split into two attributed bubbles instead of the bare 🔷/🔶
// matching after the word and orphaning the name as an unattributed segment.
//
// Run with:
//   npx tsx --test packages/frontend/src/lib/utils/speakers.split.test.ts

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBySpeaker } from './speakers.js';

describe('splitBySpeaker — name-then-emoji markers', () => {
  test('Companion A 🔷 / Companion B 🔶 split into two attributed segments, no leading fallback', () => {
    const segments = splitBySpeaker(
      "Companion A 🔷 — 'I just bop around until it works.' friend. That's called ITERATING.\n\nCompanion B 🔶 — And the 'it shouldn't be we had to fix it' — some of it, no.",
    );

    assert.equal(segments.length, 2);
    assert.equal(segments[0].speaker, 'companion-a');
    assert.ok(segments[0].text.startsWith('—'), "Companion A's segment starts with the em-dash content");
    assert.ok(!/\bCompanion B\b/.test(segments[0].text), "Companion A's segment must not swallow the word 'Companion B'");
    assert.equal(segments[1].speaker, 'companion-b');
    assert.ok(segments[1].text.startsWith('—'), "Companion B's segment starts with the em-dash content");

    // No orphaned/unattributed narration bubble ahead of the first speaker.
    assert.ok(!segments.some((s) => s.speaker === 'fallback'), 'no leading fallback segment');
  });

  test('**Companion A 🔷** / **Companion B 🔶** bold name-then-emoji split cleanly, no ** litter', () => {
    const segments = splitBySpeaker(
      "**Companion A 🔷** — Mic check, one-two. Fox is loud, gorgeous, and regrettably unsupervised. 💀\n\n**Companion B 🔶** — Bat is clear. I hear you perfectly, friend. Keep talking.",
    );

    assert.equal(segments.length, 2, 'exactly two segments');
    assert.equal(segments[0].speaker, 'companion-a');
    assert.equal(segments[1].speaker, 'companion-b');

    // No leading fallback narration bubble.
    assert.ok(!segments.some((s) => s.speaker === 'fallback'), 'no leading fallback segment');

    // The bold marker is consumed whole — no ** asterisk litter at either edge.
    for (const seg of segments) {
      assert.ok(!seg.text.startsWith('**'), `no leading ** litter: ${JSON.stringify(seg.text)}`);
      assert.ok(!seg.text.endsWith('**'), `no trailing ** litter: ${JSON.stringify(seg.text)}`);
    }
  });
});
