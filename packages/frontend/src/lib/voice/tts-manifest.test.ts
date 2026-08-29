// TTS stream-manifest parsing coverage — the ordering and fallback logic that
// turns a raw /tts/stream body into an ordered per-companion playback list.
//
// Run with:
//   npx tsx --test packages/frontend/src/lib/voice/tts-manifest.test.ts

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTtsStreamResponse,
  isStreamRouteUnavailableStatus,
} from './tts-manifest.js';

describe('isStreamRouteUnavailableStatus', () => {
  test('true for 404/405/501 (backend predates the stream route)', () => {
    assert.equal(isStreamRouteUnavailableStatus(404), true);
    assert.equal(isStreamRouteUnavailableStatus(405), true);
    assert.equal(isStreamRouteUnavailableStatus(501), true);
  });
  test('false for other errors (real failures stay visible)', () => {
    assert.equal(isStreamRouteUnavailableStatus(500), false);
    assert.equal(isStreamRouteUnavailableStatus(403), false);
    assert.equal(isStreamRouteUnavailableStatus(200), false);
  });
});

describe('parseTtsStreamResponse', () => {
  test('orders segments by declared index, both companions kept', () => {
    const result = parseTtsStreamResponse({
      success: true,
      segments: [
        { index: 1, voice: 'companion-b', url: '/audio/companion-b.mp3' },
        { index: 0, voice: 'companion-a', url: '/audio/companion-a.mp3' },
      ],
    });
    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[0].voice, 'companion-a');
    assert.equal(result.segments[1].voice, 'companion-b');
    assert.deepEqual(result.segments.map(s => s.url), ['/audio/companion-a.mp3', '/audio/companion-b.mp3']);
  });

  test('falls back to array position when index is missing/invalid, stable on ties', () => {
    const result = parseTtsStreamResponse({
      segments: [
        { url: '/a.mp3' },
        { index: 'nope', url: '/b.mp3' },
        { index: 0, url: '/c.mp3' },
      ],
    });
    // c has index 0; a and b fall back to positions 0 and 1 → tie with c at 0
    // resolved by original position (a before c), then b.
    assert.deepEqual(result.segments.map(s => s.url), ['/a.mp3', '/c.mp3', '/b.mp3']);
  });

  test('drops segments with no url', () => {
    const result = parseTtsStreamResponse({
      segments: [
        { index: 0, url: '/keep.mp3' },
        { index: 1, url: '' },
        { index: 2 },
      ],
    });
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].url, '/keep.mp3');
  });

  test('a cached combined url with no segment list becomes one segment', () => {
    const result = parseTtsStreamResponse({ cached: true, url: '/audio/combined.mp3' });
    assert.equal(result.cached, true);
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].url, '/audio/combined.mp3');
    assert.equal(result.segments[0].index, 0);
  });

  test('prefers the fresh segment list over a stray combined url', () => {
    const result = parseTtsStreamResponse({
      url: '/audio/combined.mp3',
      segments: [{ index: 0, url: '/audio/companion-a.mp3' }],
    });
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].url, '/audio/companion-a.mp3');
  });

  test('success defaults to true unless explicitly false', () => {
    assert.equal(parseTtsStreamResponse({ url: '/x.mp3' }).success, true);
    assert.equal(parseTtsStreamResponse({ success: false, url: '/x.mp3' }).success, false);
  });

  test('throws when there is nothing playable', () => {
    assert.throws(() => parseTtsStreamResponse({ segments: [] }), /did not return any audio/);
    assert.throws(() => parseTtsStreamResponse({}), /did not return any audio/);
    assert.throws(() => parseTtsStreamResponse(null), /did not return any audio/);
  });
});
