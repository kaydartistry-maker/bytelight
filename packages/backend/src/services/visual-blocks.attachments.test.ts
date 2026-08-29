import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { attachmentPathsToImageBlocks, capImageBlocks, normalizedImagesToImageBlocks } from './visual-blocks.js';

describe('attachment path image loading', () => {
  test('loads single and batched supported images in path order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attachment-images-'));
    const png = join(dir, 'one.png');
    const jpeg = join(dir, 'two.jpg');
    writeFileSync(png, Buffer.from('png bytes'));
    writeFileSync(jpeg, Buffer.from('jpeg bytes'));

    const blocks = attachmentPathsToImageBlocks([png, jpeg]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].source.media_type, 'image/png');
    assert.equal(blocks[0].source.data, Buffer.from('png bytes').toString('base64'));
    assert.equal(blocks[1].source.media_type, 'image/jpeg');
  });

  test('skips missing, unsupported, and unreadable/corrupt paths safely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attachment-images-bad-'));
    const unsupported = join(dir, 'notes.txt');
    const unreadableImage = join(dir, 'directory.png');
    writeFileSync(unsupported, 'not an image attachment');
    mkdirSync(unreadableImage);

    assert.deepEqual(attachmentPathsToImageBlocks([
      join(dir, 'missing.png'), unsupported, unreadableImage,
    ]), []);
  });

  test('applies the existing per-turn image-count cap to batches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attachment-images-cap-'));
    const paths = Array.from({ length: 10 }, (_, index) => {
      const path = join(dir, `${index}.webp`);
      writeFileSync(path, Buffer.from([index]));
      return path;
    });
    const result = capImageBlocks(attachmentPathsToImageBlocks(paths));
    assert.equal(result.kept.length, 8);
    assert.equal(result.dropped, 2);
  });

  test('keeps five exact-5MiB images at the exact 25MiB total boundary', () => {
    const data = Buffer.alloc(5 * 1024 * 1024).toString('base64');
    const blocks = Array.from({ length: 5 }, () => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data },
    }));
    const result = capImageBlocks(blocks);
    assert.equal(result.kept.length, 5);
    assert.equal(result.dropped, 0);
  });
});

describe('Claude SDK normalized attachment translation', () => {
  test('preserves supported image order and bytes', () => {
    const blocks = normalizedImagesToImageBlocks([
      { base64: 'cG5n', mimeType: 'image/png' },
      { base64: 'anBlZw==', mimeType: 'image/jpeg' },
    ]);
    assert.deepEqual(blocks.map((block) => [block.source.media_type, block.source.data]), [
      ['image/png', 'cG5n'],
      ['image/jpeg', 'anBlZw=='],
    ]);
  });

  test('drops empty and unsupported normalized images safely', () => {
    const blocks = normalizedImagesToImageBlocks([
      { base64: '', mimeType: 'image/png' },
      { base64: 'c3Zn', mimeType: 'image/svg+xml' },
      { base64: 'd2VicA==', mimeType: 'image/webp' },
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].source.media_type, 'image/webp');
  });

  test('keeps exactly 5MB and drops images one byte over the per-image limit', () => {
    const atLimit = Buffer.alloc(5 * 1024 * 1024).toString('base64');
    const overLimit = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    assert.equal(normalizedImagesToImageBlocks([
      { base64: atLimit, mimeType: 'image/png' },
    ]).length, 1);
    assert.equal(normalizedImagesToImageBlocks([
      { base64: overLimit, mimeType: 'image/png' },
    ]).length, 0);
  });
});
