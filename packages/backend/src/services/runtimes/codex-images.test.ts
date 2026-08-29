/**
 * Tests for the Codex image / vision helpers (6B-B Slice 3).
 *
 * Run with:
 *   npx tsx --test packages/backend/src/services/runtimes/codex-images.test.ts
 *
 * Sentinels are asserted absent from the helper's outputs in failure
 * modes. The base64 sentinel is itself a valid base64 string (the
 * literal "TEST_IMAGE_BASE64_DO_NOT_LEAK_000" encoded) so the
 * base64-detection paths can be exercised with a payload that has the
 * right shape AND is recognizably ours.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildToolResultImageFollowup,
  extractFromArray,
  parseToolResultContent,
  redactedImageMarker,
  splitToolResultForCodex,
  type ToolResultContentBlock,
} from './codex-images.js';

// ─── Sentinels ──────────────────────────────────────────────────────────
//
// SENTINEL_IMAGE_B64 is the base64-encoding of
// 'TEST_IMAGE_BASE64_DO_NOT_LEAK_000'. Buffer.from(SENTINEL, 'utf8')
// .toString('base64') === 'VEVTVF9JTUFHRV9CQVNFNjRfRE9fTk9UX0xFQUtfMDAw'.
// Padded to >= 256 chars for the MIN_BASE64_LEN threshold.
const TOKEN_ACCESS = 'TEST_CODEX_ACCESS_TOKEN_DO_NOT_LEAK_123';
const TOKEN_REFRESH = 'TEST_CODEX_REFRESH_TOKEN_DO_NOT_LEAK_456';
const TOKEN_TOOL = 'TEST_CODEX_TOOL_SECRET_DO_NOT_LEAK_789';
const SENTINEL_IMAGE_B64 = 'TUVTVF9JTUFHRV9CQVNFNjRfRE9fTk9UX0xFQUtfMDAw';

/** Pad a base64 sentinel to >= 256 chars so it passes the image
 *  detection threshold. Repetition of valid base64 chars stays valid
 *  base64 (the alphabet is closed under concatenation up to padding). */
function padBase64Image(): string {
  // 256+ char base64 payload built from the sentinel. Concatenation of
  // valid base64 chars is itself valid; we strip any '=' padding so
  // repeat-concat doesn't produce mid-string '=' which is invalid.
  const seed = SENTINEL_IMAGE_B64.replace(/=+$/, '');
  let payload = '';
  while (payload.length < 300) payload += seed;
  return payload;
}

const IMAGE_DATA_FULL = padBase64Image();

// ─── parseToolResultContent ─────────────────────────────────────────────

describe('parseToolResultContent — JSON shapes', () => {
  test('single image object → one image block', () => {
    const raw = JSON.stringify({
      type: 'image',
      data: IMAGE_DATA_FULL,
      mimeType: 'image/png',
    });
    const blocks = parseToolResultContent(raw);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'image');
    if (blocks[0].type === 'image') {
      assert.equal(blocks[0].mimeType, 'image/png');
      assert.equal(blocks[0].data, IMAGE_DATA_FULL);
    }
  });

  test('snake_case mime_type fallback is honored', () => {
    const raw = JSON.stringify({
      type: 'image',
      data: IMAGE_DATA_FULL,
      mime_type: 'image/jpeg',
    });
    const blocks = parseToolResultContent(raw);
    assert.equal(blocks.length, 1);
    if (blocks[0].type === 'image') {
      assert.equal(blocks[0].mimeType, 'image/jpeg');
    }
  });

  test('Anthropic-style source.media_type fallback is honored', () => {
    const raw = JSON.stringify({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: IMAGE_DATA_FULL },
    });
    const blocks = parseToolResultContent(raw);
    assert.equal(blocks.length, 1);
    if (blocks[0].type === 'image') {
      assert.equal(blocks[0].mimeType, 'image/webp');
      assert.equal(blocks[0].data, IMAGE_DATA_FULL);
    }
  });

  test('MCP array of content blocks (text + image) preserves order', () => {
    const raw = JSON.stringify([
      { type: 'text', text: 'Before image.' },
      { type: 'image', data: IMAGE_DATA_FULL, mimeType: 'image/png' },
      { type: 'text', text: 'After image.' },
    ]);
    const blocks = parseToolResultContent(raw);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[1].type, 'image');
    assert.equal(blocks[2].type, 'text');
  });

  test('MCP wrapper { content: [...] } extracts inner blocks when images present', () => {
    const raw = JSON.stringify({
      isError: false,
      content: [
        { type: 'text', text: 'Screenshot ready' },
        { type: 'image', data: IMAGE_DATA_FULL, mimeType: 'image/png' },
      ],
    });
    const blocks = parseToolResultContent(raw);
    // Expect a meta breadcrumb (the wrapper's other fields) + the inner blocks.
    const imageBlock = blocks.find((b) => b.type === 'image');
    assert.ok(imageBlock, 'expected at least one image block');
    if (imageBlock && imageBlock.type === 'image') {
      assert.equal(imageBlock.data, IMAGE_DATA_FULL);
    }
    // Useful text summary preserved.
    const textBlock = blocks.find(
      (b): b is { type: 'text'; text: string } => b.type === 'text' && b.text === 'Screenshot ready',
    );
    assert.ok(textBlock, 'expected the inner text summary to be preserved');
  });

  test('MCP wrapper without images returns plain text block (no rewrap)', () => {
    const raw = JSON.stringify({
      isError: false,
      content: [{ type: 'text', text: 'just text.' }],
    });
    const blocks = parseToolResultContent(raw);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
  });

  test('multiple images in array preserve order', () => {
    const a = IMAGE_DATA_FULL + 'AAAA';
    const b = IMAGE_DATA_FULL + 'BBBB';
    const c = IMAGE_DATA_FULL + 'CCCC';
    const raw = JSON.stringify([
      { type: 'image', data: a, mimeType: 'image/png' },
      { type: 'image', data: b, mimeType: 'image/png' },
      { type: 'image', data: c, mimeType: 'image/png' },
    ]);
    const blocks = parseToolResultContent(raw);
    const datas = blocks
      .filter((bb): bb is Extract<ToolResultContentBlock, { type: 'image' }> => bb.type === 'image')
      .map((bb) => bb.data);
    assert.deepEqual(datas, [a, b, c]);
  });

  test('image with empty data string degrades to text (no zero-byte image)', () => {
    const raw = JSON.stringify({ type: 'image', data: '', mimeType: 'image/png' });
    const blocks = parseToolResultContent(raw);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
  });

  test('image with too-short data degrades to text (no junk image)', () => {
    const raw = JSON.stringify({ type: 'image', data: 'short', mimeType: 'image/png' });
    const blocks = parseToolResultContent(raw);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
  });

  test('omitted mimeType falls back to image/png', () => {
    const raw = JSON.stringify({ type: 'image', data: IMAGE_DATA_FULL });
    const blocks = parseToolResultContent(raw);
    assert.equal(blocks.length, 1);
    if (blocks[0].type === 'image') {
      assert.equal(blocks[0].mimeType, 'image/png');
    }
  });
});

describe('parseToolResultContent — data URI regex stage', () => {
  test('data URI in plain text is recognized as image input', () => {
    const raw = `Here is a screenshot: data:image/png;base64,${IMAGE_DATA_FULL} and that is all.`;
    const blocks = parseToolResultContent(raw);
    const imageBlock = blocks.find((b) => b.type === 'image');
    assert.ok(imageBlock, 'expected an image block from data URI');
    if (imageBlock && imageBlock.type === 'image') {
      assert.equal(imageBlock.mimeType, 'image/png');
      assert.equal(imageBlock.data, IMAGE_DATA_FULL);
    }
    // Surrounding text preserved in order.
    const texts = blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);
    assert.ok(texts[0].includes('screenshot'));
  });

  test('multiple data URIs in plain text preserve order', () => {
    const a = IMAGE_DATA_FULL + 'AAAA';
    const b = IMAGE_DATA_FULL + 'BBBB';
    const raw = `one: data:image/png;base64,${a} two: data:image/jpeg;base64,${b}`;
    const blocks = parseToolResultContent(raw);
    const images = blocks.filter(
      (bb): bb is Extract<ToolResultContentBlock, { type: 'image' }> => bb.type === 'image',
    );
    assert.equal(images.length, 2);
    assert.equal(images[0].mimeType, 'image/png');
    assert.equal(images[1].mimeType, 'image/jpeg');
  });

  test('no image in plain text → single text block (raw preserved)', () => {
    const raw = 'just some plain text, nothing to see here.';
    const blocks = parseToolResultContent(raw);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
    if (blocks[0].type === 'text') assert.equal(blocks[0].text, raw);
  });

  test('binary-looking non-base64 garbage is treated as plain text', () => {
    // Random binary-shaped bytes (not base64-shaped) — should NOT be
    // misidentified as image data. Must be valid UTF-8 so the JSON
    // parser path doesn't crash on its way through.
    const raw = '\\x00\\xff\\x7f garbage \\u0001 \\u0002';
    const blocks = parseToolResultContent(raw);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
  });

  test('short base64-shaped string (< 256 chars) is NOT extracted', () => {
    // A 50-char base64-looking string is not image-shaped enough to
    // extract — keeps random ids / JWTs / hashes from triggering.
    const raw = `id=AAAA1234567890AAAA1234567890AAAA1234567890AA== more text.`;
    const blocks = parseToolResultContent(raw);
    const images = blocks.filter((b) => b.type === 'image');
    assert.equal(images.length, 0);
  });
});

describe('parseToolResultContent — failure modes', () => {
  test('malformed JSON is NOT thrown; falls through to text', () => {
    const raw = '{ "type": "image", "data": "incomplete';
    const blocks = parseToolResultContent(raw);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
  });

  test('empty string returns a single empty text block (never empty array)', () => {
    const blocks = parseToolResultContent('');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
  });

  test('null/array/number JSON values fall through to text or extractor cleanly', () => {
    // null
    assert.equal(parseToolResultContent('null').length, 1);
    // number
    assert.equal(parseToolResultContent('42').length, 1);
    // array of primitives
    const blocks = parseToolResultContent('[1, 2, 3]');
    assert.ok(blocks.length >= 1);
    for (const b of blocks) assert.equal(b.type, 'text');
  });
});

// ─── extractFromArray (direct) ──────────────────────────────────────────

describe('extractFromArray — direct', () => {
  test('mixed text + image preserves order', () => {
    const blocks = extractFromArray([
      { type: 'text', text: 'A' },
      { type: 'image', data: IMAGE_DATA_FULL, mimeType: 'image/png' },
      { type: 'text', text: 'B' },
    ]);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[1].type, 'image');
    assert.equal(blocks[2].type, 'text');
  });

  test('unknown block type is serialized as text (no drop)', () => {
    const blocks = extractFromArray([
      { type: 'video', url: 'https://example.test/x.mp4' },
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
    if (blocks[0].type === 'text') {
      assert.ok(blocks[0].text.includes('video'));
    }
  });

  test('primitive entries are stringified as text', () => {
    const blocks = extractFromArray(['a string', 42, null]);
    assert.equal(blocks.length, 3);
    for (const b of blocks) assert.equal(b.type, 'text');
  });
});

// ─── splitToolResultForCodex ─────────────────────────────────────────────

describe('splitToolResultForCodex', () => {
  test('text + image input → text in toolResultText, image in images', () => {
    const raw = JSON.stringify([
      { type: 'text', text: 'Caption.' },
      { type: 'image', data: IMAGE_DATA_FULL, mimeType: 'image/png' },
    ]);
    const split = splitToolResultForCodex(raw);
    assert.equal(split.toolResultText, 'Caption.');
    assert.equal(split.images.length, 1);
    assert.equal(split.images[0].data, IMAGE_DATA_FULL);
    assert.equal(split.images[0].mimeType, 'image/png');
  });

  test('image-only input → placeholder text + image in images', () => {
    const raw = JSON.stringify({
      type: 'image',
      data: IMAGE_DATA_FULL,
      mimeType: 'image/png',
    });
    const split = splitToolResultForCodex(raw);
    assert.match(split.toolResultText, /image|attached/i);
    assert.equal(split.images.length, 1);
  });

  test('text-only input → text in toolResultText, empty images', () => {
    const split = splitToolResultForCodex('just text.');
    assert.equal(split.toolResultText, 'just text.');
    assert.deepEqual(split.images, []);
  });

  test('toolResultText is ALWAYS a string and NEVER contains the raw base64 sentinel', () => {
    const raw = JSON.stringify({
      type: 'image',
      data: IMAGE_DATA_FULL,
      mimeType: 'image/png',
    });
    const split = splitToolResultForCodex(raw);
    assert.equal(typeof split.toolResultText, 'string');
    assert.ok(
      !split.toolResultText.includes(SENTINEL_IMAGE_B64),
      'toolResultText must not include the raw base64 sentinel',
    );
    assert.ok(
      !split.toolResultText.includes(IMAGE_DATA_FULL),
      'toolResultText must not include the raw image payload',
    );
  });

  test('multiple images preserve order in split.images', () => {
    const a = IMAGE_DATA_FULL + 'AAAA';
    const b = IMAGE_DATA_FULL + 'BBBB';
    const raw = JSON.stringify([
      { type: 'image', data: a, mimeType: 'image/png' },
      { type: 'image', data: b, mimeType: 'image/jpeg' },
    ]);
    const split = splitToolResultForCodex(raw);
    assert.equal(split.images.length, 2);
    assert.equal(split.images[0].data, a);
    assert.equal(split.images[1].data, b);
  });
});

// ─── buildToolResultImageFollowup ────────────────────────────────────────

describe('buildToolResultImageFollowup', () => {
  test('emits banner text first, then images in order', () => {
    const images = [
      { type: 'image' as const, data: IMAGE_DATA_FULL + 'A', mimeType: 'image/png' },
      { type: 'image' as const, data: IMAGE_DATA_FULL + 'B', mimeType: 'image/jpeg' },
    ];
    const content = buildToolResultImageFollowup(images);
    assert.equal(content[0].type, 'text');
    assert.equal(content.length, 3);
    if (content[1].type === 'image') {
      assert.equal(content[1].data, IMAGE_DATA_FULL + 'A');
    }
    if (content[2].type === 'image') {
      assert.equal(content[2].mimeType, 'image/jpeg');
    }
  });
});

// ─── redactedImageMarker ─────────────────────────────────────────────────

describe('redactedImageMarker', () => {
  test('formats mime + byte length, no raw payload', () => {
    const marker = redactedImageMarker('image/png', 12345);
    assert.equal(marker, '[image omitted: image/png, 12345 bytes]');
    assert.ok(!marker.includes(SENTINEL_IMAGE_B64));
  });
});

// ─── No-sentinel-leak guards across all parser outputs ───────────────────

describe('codex-images — auth & tool token sentinels never leak through any code path', () => {
  test('parseToolResultContent does not echo access/refresh/tool tokens into outputs', () => {
    // Tokens are not the parser's input here — but the parser's
    // outputs should never CONJURE them either. This is a paranoia
    // assert against future regressions where someone hard-codes a
    // sentinel into a placeholder string.
    const cases = [
      'plain text',
      JSON.stringify({ type: 'image', data: IMAGE_DATA_FULL, mimeType: 'image/png' }),
      JSON.stringify([{ type: 'text', text: 'hi' }]),
      '',
    ];
    for (const raw of cases) {
      const blocks = parseToolResultContent(raw);
      const serialized = JSON.stringify(blocks);
      assert.ok(!serialized.includes(TOKEN_ACCESS));
      assert.ok(!serialized.includes(TOKEN_REFRESH));
      assert.ok(!serialized.includes(TOKEN_TOOL));
    }
  });

  test('splitToolResultForCodex placeholder text never contains the image base64 sentinel', () => {
    // The image-only branch generates a placeholder text. That text
    // is fixed and short — assert it cannot ever contain the
    // sentinel even when the sentinel IS the image data.
    const raw = JSON.stringify({
      type: 'image',
      data: IMAGE_DATA_FULL,
      mimeType: 'image/png',
    });
    const split = splitToolResultForCodex(raw);
    assert.ok(!split.toolResultText.includes(SENTINEL_IMAGE_B64));
  });

  test('redactedImageMarker never contains base64 sentinel for any byte count or mime', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      for (const bytes of [0, 1024, 1024 * 1024]) {
        const m = redactedImageMarker(mime, bytes);
        assert.ok(!m.includes(SENTINEL_IMAGE_B64));
      }
    }
  });
});

// ─── Out-of-scope guard (Slice 3) ────────────────────────────────────────

describe('out-of-scope guard (Slice 3)', () => {
  test('codex-images.ts does not import agent.ts, tools-bridge, frontend, sensitive-paths, or auth', async () => {
    const { readFile } = await import('fs/promises');
    const source = await readFile(
      new URL('./codex-images.ts', import.meta.url),
      'utf8',
    );
    assert.ok(
      !/from\s+['"][^'"]*agent\.js['"]/.test(source),
      'codex-images.ts must not import from agent.ts',
    );
    assert.ok(
      !/from\s+['"][^'"]*tools-bridge\.js['"]/.test(source),
      'codex-images.ts must not import from tools-bridge.ts',
    );
    assert.ok(
      !/from\s+['"][^'"]*sensitive-paths\.js['"]/.test(source),
      'codex-images.ts must not import from sensitive-paths.ts',
    );
    assert.ok(
      !/from\s+['"][^'"]*frontend[^'"]*['"]/.test(source),
      'codex-images.ts must not import from frontend',
    );
    assert.ok(
      !/from\s+['"][^'"]*auth\/codex-oauth\.js['"]/.test(source),
      'codex-images.ts must not import codex-oauth.ts',
    );
  });
});
