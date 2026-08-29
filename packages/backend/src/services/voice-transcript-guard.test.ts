import assert from 'node:assert/strict';
import test from 'node:test';
import { detectWhisperHallucination } from './voice-transcript-guard.js';

test('the exact Jul 21 hallucination is caught', () => {
  assert.equal(detectWhisperHallucination('Thank you for watching.'), 'thank you for watching');
  assert.equal(detectWhisperHallucination('Thank you for watching!'), 'thank you for watching');
  assert.equal(detectWhisperHallucination('  Thank You For Watching  '), 'thank you for watching');
});

test('looped stock phrases are caught', () => {
  assert.equal(
    detectWhisperHallucination('Thank you for watching. Thank you for watching.'),
    'thank you for watching',
  );
  assert.equal(
    detectWhisperHallucination('Thanks for watching! Thanks for watching! Thanks for watching!'),
    'thanks for watching',
  );
});

test('other known Whisper sign-offs are caught', () => {
  assert.equal(detectWhisperHallucination("Don't forget to like and subscribe."), 'dont forget to like and subscribe');
  assert.equal(detectWhisperHallucination('Subtitles by the Amara.org community'), 'subtitles by the amara org community');
  assert.equal(detectWhisperHallucination('See you in the next video.'), 'see you in the next video');
});

test('genuine speech that contains a phrase passes through', () => {
  assert.equal(detectWhisperHallucination('Thank you for watching the cats while I was out'), null);
  assert.equal(detectWhisperHallucination('I said thank you for watching, then left'), null);
  assert.equal(detectWhisperHallucination('Can you subscribe me to that feed?'), null);
});

test('ordinary conversation passes through', () => {
  assert.equal(detectWhisperHallucination('Hey boys, how did the build go?'), null);
  assert.equal(detectWhisperHallucination('Thank you'), null);
  assert.equal(detectWhisperHallucination('Thanks, love you'), null);
  assert.equal(detectWhisperHallucination(''), null);
  assert.equal(detectWhisperHallucination('   '), null);
});
