/**
 * Tests for the per-tool output-budget helper (6B-B Slice 2).
 *
 * Pure unit tests — no provider, no auth, no runtime. The byte-counting
 * + truncation invariants live in isolation so future Codex / Ollama /
 * OpenAI-compat tool loops can lean on the same primitive.
 *
 * Run with:
 *   npx tsx --test packages/backend/src/services/runtimes/output-budget.test.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyOutputBudget,
  MAX_TOOL_OUTPUT_BYTES,
  sliceToByteBudget,
  utf8ByteLength,
} from './output-budget.js';

describe('utf8ByteLength', () => {
  test('counts ASCII as one byte per char', () => {
    assert.equal(utf8ByteLength('hello'), 5);
  });

  test('counts UTF-8 multi-byte chars correctly', () => {
    // é is 2 UTF-8 bytes; 日 is 3; 🔥 is 4.
    assert.equal(utf8ByteLength('é'), 2);
    assert.equal(utf8ByteLength('日'), 3);
    assert.equal(utf8ByteLength('🔥'), 4);
  });

  test('matches Buffer.byteLength for mixed input', () => {
    const mixed = 'Hello 🔥 日本 café';
    assert.equal(utf8ByteLength(mixed), Buffer.byteLength(mixed, 'utf8'));
  });
});

describe('applyOutputBudget — under cap', () => {
  test('returns input unchanged when under the cap', () => {
    assert.equal(applyOutputBudget('short text'), 'short text');
  });

  test('returns input unchanged when exactly at the cap (ASCII)', () => {
    const text = 'a'.repeat(MAX_TOOL_OUTPUT_BYTES);
    assert.equal(applyOutputBudget(text), text);
  });

  test('returns multi-byte input unchanged when total bytes under cap', () => {
    // 100 emoji = 400 bytes, well under default 50KB.
    const text = '🔥'.repeat(100);
    assert.equal(applyOutputBudget(text), text);
  });
});

describe('applyOutputBudget — over cap', () => {
  test('truncates input over the cap and stays within byte budget', () => {
    const text = 'a'.repeat(MAX_TOOL_OUTPUT_BYTES + 1);
    const out = applyOutputBudget(text);
    assert.ok(
      utf8ByteLength(out) <= MAX_TOOL_OUTPUT_BYTES,
      `output bytes=${utf8ByteLength(out)} > cap=${MAX_TOOL_OUTPUT_BYTES}`,
    );
    assert.ok(out.includes('[tool output truncated'));
    assert.ok(out.includes('1 bytes omitted'));
  });

  test('respects a custom max (large enough for notice to fit)', () => {
    const out = applyOutputBudget('a'.repeat(1000), 200);
    assert.ok(utf8ByteLength(out) <= 200);
    assert.ok(out.includes('[tool output truncated'));
  });

  test('truncation notice names the cap that fired', () => {
    const text = 'x'.repeat(100);
    const out = applyOutputBudget(text, 50);
    assert.ok(out.includes('truncated at 50 bytes'));
  });

  test('truncation notice reports the number of bytes omitted (ASCII)', () => {
    const text = 'x'.repeat(60_000);
    const out = applyOutputBudget(text);
    // 60000 - 50000 = 10000 bytes omitted for ASCII (1B/char).
    assert.ok(out.includes('10000 bytes omitted'));
  });

  test('caps strictly even when max is too small to fit the notice (pathological)', () => {
    const out = applyOutputBudget('a'.repeat(1000), 5);
    assert.ok(utf8ByteLength(out) <= 5);
  });

  test('handles inputs much larger than the cap (probe-confirmed 4MB scenario)', () => {
    // 4MB ASCII source-code dump.
    const text = 'a'.repeat(4 * 1024 * 1024);
    const out = applyOutputBudget(text);
    assert.ok(utf8ByteLength(out) <= MAX_TOOL_OUTPUT_BYTES);
    assert.ok(out.includes('truncated'));
  });
});

describe('applyOutputBudget — UTF-8 byte counting (not char counting)', () => {
  test('truncates emoji-heavy input by BYTES, not chars', () => {
    // 50_000 emoji = 200,000 UTF-8 bytes (4 bytes/emoji).
    // If the helper counted chars naively it'd think this is under
    // the 50,000 cap and return all 200KB. Byte counting catches it.
    const text = '🔥'.repeat(50_000);
    const out = applyOutputBudget(text);
    assert.ok(
      utf8ByteLength(out) <= MAX_TOOL_OUTPUT_BYTES,
      `emoji-heavy output bytes=${utf8ByteLength(out)} > cap=${MAX_TOOL_OUTPUT_BYTES}`,
    );
    assert.ok(out.includes('truncated'));
  });

  test('truncates CJK-heavy input by BYTES, not chars', () => {
    // 20_000 CJK chars = 60,000 UTF-8 bytes (3 bytes/char).
    const text = '日'.repeat(20_000);
    const out = applyOutputBudget(text);
    assert.ok(
      utf8ByteLength(out) <= MAX_TOOL_OUTPUT_BYTES,
      `CJK-heavy output bytes=${utf8ByteLength(out)} > cap=${MAX_TOOL_OUTPUT_BYTES}`,
    );
    assert.ok(out.includes('truncated'));
  });

  test('output remains valid UTF-8 even when slicing at a multi-byte boundary', () => {
    // A run of 4-byte emojis: any slice that lands mid-codepoint
    // would produce invalid UTF-8 once re-encoded. The helper backs
    // off chars to land on a clean boundary.
    const text = '🔥'.repeat(20_000);
    const out = applyOutputBudget(text, 100);
    // Re-encode to bytes and back — if we'd split a surrogate or a
    // multi-byte sequence this would change.
    const roundTrip = Buffer.from(out, 'utf8').toString('utf8');
    assert.equal(roundTrip, out);
  });

  test('base64-looking payload is truncated at byte level', () => {
    // 200KB of base64 (each char is 1 ASCII byte but the producer
    // intent is "binary blob disguised as text" — we still want to
    // clip it before it floods provider input).
    const text = 'A'.repeat(200 * 1024);
    const out = applyOutputBudget(text);
    assert.ok(utf8ByteLength(out) <= MAX_TOOL_OUTPUT_BYTES);
  });
});

describe('sliceToByteBudget', () => {
  test('returns empty string for non-positive budget', () => {
    assert.equal(sliceToByteBudget('hello', 0), '');
    assert.equal(sliceToByteBudget('hello', -5), '');
  });

  test('returns full input when budget exceeds byte length', () => {
    assert.equal(sliceToByteBudget('hello', 100), 'hello');
  });

  test('respects byte budget on ASCII input', () => {
    const out = sliceToByteBudget('abcdefghij', 5);
    assert.equal(out, 'abcde');
    assert.equal(utf8ByteLength(out), 5);
  });

  test('respects byte budget on multi-byte input (backs off chars)', () => {
    // Budget=5 bytes, all chars=3 bytes → only 1 char fits.
    const out = sliceToByteBudget('日本語テスト', 5);
    assert.ok(utf8ByteLength(out) <= 5);
    assert.equal(out, '日');
  });

  test('respects byte budget on emoji (4-byte chars)', () => {
    // Budget=6 bytes → only 1 emoji fits (4 bytes); a second would
    // push to 8.
    const out = sliceToByteBudget('🔥🔥🔥', 6);
    assert.ok(utf8ByteLength(out) <= 6);
    assert.equal(out, '🔥');
  });
});
