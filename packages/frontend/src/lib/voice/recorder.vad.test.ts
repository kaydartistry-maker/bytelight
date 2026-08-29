// VAD helper coverage — the pure decision core of the conversation recorder.
// These pin the threshold math and turn-end logic that decide when a spoken
// turn is finished, without needing a DOM/MediaRecorder.
//
// Run with:
//   npx tsx --test packages/frontend/src/lib/voice/recorder.vad.test.ts

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeThreshold,
  updateNoiseFloor,
  computeRms,
  decideVad,
  type VadTimingState,
  type VadThresholds,
} from './vad.js';

describe('computeThreshold', () => {
  test('clamps to the 0.018 floor for a near-silent room', () => {
    assert.equal(computeThreshold(0), 0.018);
    assert.equal(computeThreshold(0.001), 0.018);
  });

  test('clamps to the 0.08 ceiling for a very noisy calibration', () => {
    assert.equal(computeThreshold(1), 0.08);
    assert.equal(computeThreshold(0.5), 0.08);
  });

  test('scales linearly between floor and ceiling', () => {
    // noiseFloor 0.02 -> 0.02*2.4 + 0.006 = 0.054
    assert.ok(Math.abs(computeThreshold(0.02) - 0.054) < 1e-9);
  });
});

describe('updateNoiseFloor', () => {
  test('is an EMA weighted toward the running value', () => {
    // 0.006*0.88 + 0.1*0.12 = 0.00528 + 0.012 = 0.01728
    assert.ok(Math.abs(updateNoiseFloor(0.006, 0.1) - 0.01728) < 1e-9);
  });

  test('converges upward toward a sustained louder floor', () => {
    let floor = 0.006;
    for (let i = 0; i < 50; i++) floor = updateNoiseFloor(floor, 0.05);
    assert.ok(floor > 0.049 && floor <= 0.05, `converged to ${floor}`);
  });
});

describe('computeRms', () => {
  test('is zero for a silent block', () => {
    assert.equal(computeRms([0, 0, 0, 0]), 0);
  });

  test('equals the constant magnitude for a DC block', () => {
    assert.ok(Math.abs(computeRms([0.5, 0.5, 0.5, 0.5]) - 0.5) < 1e-9);
  });

  test('is the RMS of a symmetric swing', () => {
    // sqrt((1+1)/2) = 1
    assert.ok(Math.abs(computeRms([1, -1]) - 1) < 1e-9);
  });
});

describe('decideVad', () => {
  const thresholds: VadThresholds = {
    silenceMs: 1050,
    minSpeechMs: 250,
    maxUtteranceMs: 90_000,
    maxWaitForSpeechMs: 10_000,
  };

  test('continues while still calibrating and no speech yet, before wait cap', () => {
    const state: VadTimingState = { heardSpeech: false, speechStartedAt: 0, lastSpeechAt: 0, startedAt: 0 };
    assert.equal(decideVad(state, thresholds, 5_000), 'continue');
  });

  test('times out when no speech before the wait cap', () => {
    const state: VadTimingState = { heardSpeech: false, speechStartedAt: 0, lastSpeechAt: 0, startedAt: 0 };
    assert.equal(decideVad(state, thresholds, 10_001), 'timeout');
  });

  test('never times out when maxWaitForSpeechMs is undefined', () => {
    const state: VadTimingState = { heardSpeech: false, speechStartedAt: 0, lastSpeechAt: 0, startedAt: 0 };
    const noCap: VadThresholds = { ...thresholds, maxWaitForSpeechMs: undefined };
    assert.equal(decideVad(state, noCap, 999_999), 'continue');
  });

  test('continues while speech is active and silence gap is short', () => {
    // spoke at 5000, now 5500 -> only 500ms of silence (< 1050)
    const state: VadTimingState = { heardSpeech: true, speechStartedAt: 4000, lastSpeechAt: 5000, startedAt: 0 };
    assert.equal(decideVad(state, thresholds, 5_500), 'continue');
  });

  test('stops after the silence gap passes minimum speech', () => {
    // spoke last at 5000, now 6100 -> 1100ms silence (>= 1050), and 2100ms of speech (>= 250)
    const state: VadTimingState = { heardSpeech: true, speechStartedAt: 4000, lastSpeechAt: 5000, startedAt: 0 };
    assert.equal(decideVad(state, thresholds, 6_100), 'stop');
  });

  test('does not stop on silence before minimum speech is reached', () => {
    // Speech began only 200ms ago (< 250 minSpeechMs). Even with a silence
    // gap past the threshold, the turn is too short to finish yet.
    const state: VadTimingState = { heardSpeech: true, speechStartedAt: 5_800, lastSpeechAt: 4_000, startedAt: 0 };
    assert.equal(decideVad(state, thresholds, 6_000), 'continue');
  });

  test('stops when the utterance reaches the hard max even if still speaking', () => {
    const state: VadTimingState = { heardSpeech: true, speechStartedAt: 0, lastSpeechAt: 89_999, startedAt: 0 };
    assert.equal(decideVad(state, thresholds, 90_000), 'stop');
  });
});
