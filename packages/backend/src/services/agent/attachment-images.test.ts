import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { NormalizedMessage } from '../runtimes/types.js';
import { attachImagesToLatestUserMessage } from './attachment-images.js';

const images = [
  { base64: 'Zmlyc3Q=', mimeType: 'image/png' },
  { base64: 'c2Vjb25k', mimeType: 'image/jpeg' },
];

describe('foreign-runtime attachment seam', () => {
  test('puts a batch, in order, only on the latest user message', () => {
    const input: NormalizedMessage[] = [
      { role: 'user', content: 'old', createdAt: '1' },
      { role: 'assistant', content: 'reply', createdAt: '2' },
      { role: 'user', content: 'current prompt', createdAt: '3' },
    ];

    const result = attachImagesToLatestUserMessage(input, images, 'current prompt');

    assert.equal(result[0].images, undefined);
    assert.equal(result[1].images, undefined);
    assert.deepEqual(result[2].images, images);
    assert.equal(result[2].content, 'current prompt');
    assert.equal(input[2].images, undefined, 'does not mutate history');
  });

  test('appends the mixed current prompt instead of decorating a persisted attachment row', () => {
    const input: NormalizedMessage[] = [
      { role: 'user', content: 'caption', createdAt: '1' },
      { role: 'user', content: '/files/image-id', createdAt: '2' },
    ];
    const content = 'image path fallback\nTheir message: caption';
    const result = attachImagesToLatestUserMessage(input, [images[0]], content, () => 'now');

    assert.equal(result[1].images, undefined);
    assert.deepEqual(result[2], {
      role: 'user', content, createdAt: 'now', images: [images[0]],
    });
  });

  test('creates the current user entry when history has no user message', () => {
    const result = attachImagesToLatestUserMessage(
      [{ role: 'system', content: 'context', createdAt: '1' }],
      [images[0]],
      'mixed text and image',
      () => 'now',
    );
    assert.deepEqual(result[1], {
      role: 'user', content: 'mixed text and image', createdAt: 'now', images: [images[0]],
    });
  });

  test('does not add image fields for an empty/invalid attachment set', () => {
    const input: NormalizedMessage[] = [{ role: 'user', content: 'fallback', createdAt: '1' }];
    const result = attachImagesToLatestUserMessage(input, [], 'fallback');
    assert.equal(result[0].images, undefined);
  });

  test('preserves the dispatched attachment warning when preprocessing yields no image', () => {
    const input: NormalizedMessage[] = [
      { role: 'user', content: '/files/broken-image', createdAt: '1' },
    ];
    const warningPrompt = 'the operator sent an image (broken.png).\n[Vision warning: model cannot see this image.]';
    const result = attachImagesToLatestUserMessage(input, [], warningPrompt, () => 'now');

    assert.deepEqual(result[1], {
      role: 'user', content: warningPrompt, createdAt: 'now',
    });
    assert.equal(result[1].images, undefined);
  });

  test('keeps images on an already rewritten Codex skill prompt', () => {
    const rewritten = '$imagegen make this cinematic';
    const input: NormalizedMessage[] = [
      { role: 'user', content: rewritten, createdAt: '1' },
    ];
    const result = attachImagesToLatestUserMessage(input, [images[0]], rewritten);
    assert.equal(result.length, 1);
    assert.equal(result[0].content, rewritten);
    assert.deepEqual(result[0].images, [images[0]]);
  });
});
