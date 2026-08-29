import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import sharp from 'sharp';
import { prepareVisionImage } from './vision-image-preprocessor.js';

describe('vision image preprocessing', () => {
  test('passes an under-limit supported image through byte-for-byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vision-pass-'));
    const path = join(dir, 'small.png');
    const source = await sharp({
      create: { width: 16, height: 16, channels: 4, background: '#7b2cff' },
    }).png().toBuffer();
    writeFileSync(path, source);

    const result = await prepareVisionImage(path, 'small.png', source.length + 1);
    assert.equal(result.resized, false);
    assert.equal(result.warning, undefined);
    assert.equal(result.image?.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(result.image!.base64, 'base64'), source);
  });

  test('shrinks an oversized image without changing the original upload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vision-resize-'));
    const path = join(dir, 'large.png');
    const pixels = Buffer.allocUnsafe(512 * 512 * 3);
    randomFillSync(pixels);
    const source = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
    writeFileSync(path, source);
    const originalOnDisk = readFileSync(path);

    const result = await prepareVisionImage(path, 'large.png', 250 * 1024);
    assert.equal(result.resized, true);
    assert.equal(result.warning, undefined);
    assert.equal(result.image?.mimeType, 'image/webp');
    assert.ok(Buffer.from(result.image!.base64, 'base64').length <= 250 * 1024);
    assert.deepEqual(readFileSync(path), originalOnDisk);
  });

  test('normalizes a highly compressed image whose dimensions exceed the model bound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vision-dimensions-'));
    const path = join(dir, 'wide.png');
    const source = await sharp({
      create: { width: 5000, height: 8, channels: 3, background: '#222222' },
    }).png().toBuffer();
    writeFileSync(path, source);
    assert.ok(source.length < 5 * 1024 * 1024, 'fixture should be small in bytes');

    const result = await prepareVisionImage(path, 'wide.png');
    const output = Buffer.from(result.image!.base64, 'base64');
    const metadata = await sharp(output).metadata();
    assert.equal(result.resized, true);
    assert.ok((metadata.width ?? Infinity) <= 4096);
  });

  test('labels first-frame-only model copies of oversized animations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vision-animation-'));
    const path = join(dir, 'animated.gif');
    const animated = Buffer.from(
      'R0lGODlhAgACAPEAAExpcf8AAAAA/wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAAAgACAAACAoxTACH5BAUKAAAALAAAAAACAAIAAAIClFUAOw==',
      'base64',
    );
    writeFileSync(path, animated);

    const result = await prepareVisionImage(path, 'animated.gif', 64);
    assert.equal(result.resized, true);
    assert.match(result.contextNote || '', /first frame only/);
    assert.match(result.contextNote || '', /original animation remains preserved/);
  });

  test('returns a visible warning instead of silently dropping corrupt data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vision-bad-'));
    const path = join(dir, 'broken.png');
    writeFileSync(path, Buffer.alloc(128, 7));

    const result = await prepareVisionImage(path, 'broken.png', 64);
    assert.equal(result.image, undefined);
    assert.match(result.warning || '', /Vision warning: broken\.png/);
    assert.match(result.warning || '', /model cannot see this image/);
  });
});
